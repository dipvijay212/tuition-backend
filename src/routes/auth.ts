import { Router, type Request } from "express";
import { z } from "zod";
import { asSystem, sys } from "../db/pool.js";
import { badRequest, forbidden, HttpError } from "../lib/errors.js";
import { normalizePhone, passwordSchema, phoneSchema, requiredText } from "../lib/validation.js";
import { authenticate, bearer, ctxOf, SUSPENDED_MESSAGE } from "../middleware.js";
import { healUserRoles, membershipOf, ROLE_HOME, ROLE_PRIORITY, type AppRole } from "../auth/context.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { createSession, forgetUser, revokeSession, sessionTtl, setSessionInstitute } from "../auth/sessions.js";
import { consumeEmailLink, createAuthUser, sendPasswordReset } from "../auth/provision.js";
import { loginThrottle } from "../lib/throttle.js";

export const authRouter = Router();

const GENERIC = "Incorrect mobile number/email or password.";
const STATUS_MESSAGES: Record<string, string> = {
  inactive: "Your account is inactive. Please contact the institute.",
  suspended: "Your account has been suspended. Please contact the institute.",
  pending_activation: "Your account has not been activated yet. Please contact the institute.",
  no_role: "Your account has no access assigned yet. Please contact the institute.",
  not_member: "You don't have an account at this institute. Check the institute code or contact the institute.",
};

const codeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^[A-Z0-9]{4,12}$/, "Institute code is 4–12 letters or numbers."));

type Institute = { id: string; name: string; code: string; status: string; logo_path: string | null };
const findInstitute = (code: string) =>
  sys.one<Institute>(`select id, name, code, status, logo_path from public.institutes where code = $1`, [code]);

async function instituteForLogin(rawCode: string) {
  const parsed = codeSchema.safeParse(rawCode);
  if (!parsed.success) throw badRequest("Enter your institute code.");
  const inst = await findInstitute(parsed.data);
  if (!inst) throw badRequest("Institute code not found. Please check the code given by your institute.");
  if (inst.status !== "active") throw badRequest(SUSPENDED_MESSAGE);
  return inst;
}

/** Resolve a 10-digit phone to a login email WITHIN one institute. Never exposed to the browser. */
async function emailForPhone(phone: string, instituteId: string): Promise<string | null> {
  const sources = [
    `select distinct lower(coalesce(u.email, p.email)) as email
       from public.memberships m join public.profiles p on p.id = m.user_id join auth.users u on u.id = p.id
      where m.institute_id = $2 and p.phone = $1 and coalesce(u.email, p.email) is not null`,
    `select distinct lower(email) as email from public.guardians where institute_id = $2 and phone = $1 and email is not null`,
    `select distinct lower(email) as email from public.students where institute_id = $2 and phone = $1 and email is not null`,
    `select distinct lower(email) as email from public.teachers where institute_id = $2 and phone = $1 and email is not null`,
  ];
  for (const sql of sources) {
    const rows = await sys.q<{ email: string }>(sql, [phone, instituteId]);
    if (rows.length === 1) return rows[0].email.trim();
    if (rows.length > 1) return null; // ambiguous
  }
  return null;
}

const meta = (body: { userAgent?: string; ip?: string }) => ({ userAgent: body.userAgent, ip: body.ip });
const homeFor = (roles: AppRole[]) => ROLE_HOME[ROLE_PRIORITY.find((r) => roles.includes(r)) ?? "student"];

async function verifyLogin(email: string, password: string) {
  const user = await sys.one<{ id: string; encrypted_password: string | null; banned_until: Date | null }>(
    `select id, encrypted_password, banned_until from auth.users where lower(email) = $1`,
    [email],
  );
  if (!user || !(await verifyPassword(password, user.encrypted_password))) return null;
  if (user.banned_until && user.banned_until > new Date()) throw badRequest(STATUS_MESSAGES.suspended);
  return user;
}

// ---------- Public: institute lookup for the sign-in page ----------
authRouter.get("/institute/:code", async (req, res) => {
  const parsed = codeSchema.safeParse(req.params.code);
  const inst = parsed.success ? await findInstitute(parsed.data) : null;
  if (!inst || inst.status !== "active") throw new HttpError(404, "Institute code not found.");
  res.json({ name: inst.name, code: inst.code, logo_path: inst.logo_path });
});

// ---------- Login (auto-detect institute or explicit institute code) ----------
authRouter.post("/login", async (req, res) => {
  const body = z
    .object({
      institute_code: z.string().default(""),
      identifier: z.string().trim(),
      password: z.string(),
      remember: z.boolean().default(true),
      userAgent: z.string().optional(),
      ip: z.string().optional(),
    })
    .parse(req.body);
  if (!body.identifier || !body.password) throw badRequest("Enter your mobile number or email and password.");
  const throttleKey = `${body.ip ?? "?"}|${body.identifier.toLowerCase()}`;
  loginThrottle.check(throttleKey);

  const rawCode = body.institute_code.trim();
  let inst: Institute | null = null;
  let email = body.identifier.toLowerCase();
  let phone: string | null = null;
  let user: { id: string; encrypted_password: string | null; banned_until: Date | null } | null = null;

  if (rawCode) {
    // 1. Explicit institute code provided (from URL or manual selection)
    inst = await instituteForLogin(rawCode);

    if (!body.identifier.includes("@")) {
      phone = normalizePhone(body.identifier);
      if (!/^\d{10}$/.test(phone)) throw badRequest(GENERIC);
      const resolved = await emailForPhone(phone, inst.id);
      if (!resolved) {
        loginThrottle.fail(throttleKey);
        throw badRequest(GENERIC);
      }
      email = resolved;
    }

    user = await verifyLogin(email, body.password);
    if (!user) {
      loginThrottle.fail(throttleKey);
      throw badRequest(GENERIC);
    }
    loginThrottle.reset(throttleKey);
  } else {
    // 2. Auto-detect institute by Email or Phone (Slack / Notion style)
    if (body.identifier.includes("@")) {
      user = await verifyLogin(email, body.password);
      if (!user) {
        loginThrottle.fail(throttleKey);
        throw badRequest(GENERIC);
      }
      loginThrottle.reset(throttleKey);

      const institutes = await sys.q<Institute>(
        `select distinct i.id, i.name, i.code, i.status, i.logo_path
           from public.institutes i
          where i.status = 'active'
            and (
              exists (select 1 from public.memberships m where m.institute_id = i.id and m.user_id = $1)
              or exists (select 1 from public.user_roles ur where ur.institute_id = i.id and ur.user_id = $1)
              or exists (select 1 from public.guardians g where g.institute_id = i.id and (g.profile_id = $1 or lower(g.email) = $2))
              or exists (select 1 from public.students s where s.institute_id = i.id and (s.profile_id = $1 or lower(s.email) = $2))
              or exists (select 1 from public.teachers t where t.institute_id = i.id and (t.profile_id = $1 or lower(t.email) = $2))
            )
          order by i.name asc`,
        [user.id, email],
      );

      if (institutes.length === 0) {
        const isPlatform = await sys.one<{ user_id: string }>(
          `select user_id from public.platform_admins where user_id = $1`,
          [user.id],
        );
        if (isPlatform) {
          throw badRequest("This is a Platform Super Admin account. Please sign in at /platform/login.");
        }
        throw badRequest("No active institute found for this account. Please check your credentials or contact your institute.");
      }

      if (institutes.length > 1) {
        return res.json({
          requires_institute_selection: true,
          institutes: institutes.map((i) => ({ id: i.id, name: i.name, code: i.code, logo_path: i.logo_path })),
        });
      }

      inst = institutes[0];
    } else {
      phone = normalizePhone(body.identifier);
      if (!/^\d{10}$/.test(phone)) throw badRequest(GENERIC);

      const matchingInstitutes = await sys.q<Institute>(
        `select distinct i.id, i.name, i.code, i.status, i.logo_path
           from public.institutes i
          where i.status = 'active'
            and (
              exists (select 1 from public.profiles p join public.memberships m on m.user_id = p.id where m.institute_id = i.id and p.phone = $1)
              or exists (select 1 from public.guardians g where g.institute_id = i.id and g.phone = $1)
              or exists (select 1 from public.students s where s.institute_id = i.id and s.phone = $1)
              or exists (select 1 from public.teachers t where t.institute_id = i.id and t.phone = $1)
            )
          order by i.name asc`,
        [phone],
      );

      if (matchingInstitutes.length === 0) {
        loginThrottle.fail(throttleKey);
        throw badRequest(GENERIC);
      }

      if (matchingInstitutes.length > 1) {
        return res.json({
          requires_institute_selection: true,
          institutes: matchingInstitutes.map((i) => ({ id: i.id, name: i.name, code: i.code, logo_path: i.logo_path })),
        });
      }

      inst = matchingInstitutes[0];
      const resolved = await emailForPhone(phone, inst.id);
      if (!resolved) {
        loginThrottle.fail(throttleKey);
        throw badRequest(GENERIC);
      }
      email = resolved;

      user = await verifyLogin(email, body.password);
      if (!user) {
        loginThrottle.fail(throttleKey);
        throw badRequest(GENERIC);
      }
      loginThrottle.reset(throttleKey);
    }
  }

  if (!inst || !user) {
    throw badRequest(GENERIC);
  }

  // Make sure a profile exists (older accounts), then link people records of THIS institute if needed.
  await sys.q(`insert into public.profiles (id, email, phone, status) values ($1, $2, $3, 'active') on conflict (id) do nothing`, [user.id, email, phone]);
  let m = await membershipOf(user.id, inst.id);
  if (!m || !m.roles?.length) {
    await healUserRoles(user.id, inst.id, email, phone);
    m = await membershipOf(user.id, inst.id);
  }
  if (!m) throw badRequest(STATUS_MESSAGES.not_member);
  if (m.status !== "active") throw badRequest(STATUS_MESSAGES[m.status] ?? STATUS_MESSAGES.pending_activation);
  if (!m.roles?.length) throw badRequest(STATUS_MESSAGES.no_role);

  const session = await createSession(user.id, body.remember, meta(body), { instituteId: inst.id });
  await sys.q(
    `update public.profiles set last_login_at = now(), institute_id = $2 where id = $1`,
    [user.id, inst.id],
  );
  await sys.q(`update public.memberships set last_login_at = now() where user_id = $1 and institute_id = $2`, [user.id, inst.id]);
  await sys.q(`insert into public.audit_logs (institute_id, user_id, action, entity, entity_id) values ($1, $2::uuid, 'login', 'auth', $2::text)`, [inst.id, user.id]);
  const roles = ROLE_PRIORITY.filter((r) => m!.roles!.includes(r));
  res.json({ ...session, roles, home: homeFor(roles), institute: { name: inst.name, code: inst.code } });
});

// ---------- Platform (super admin) login ----------
authRouter.post("/platform-login", async (req, res) => {
  const body = z
    .object({ email: z.string().trim().toLowerCase(), password: z.string(), userAgent: z.string().optional(), ip: z.string().optional() })
    .parse(req.body);
  const throttleKey = `platform|${body.ip ?? "?"}|${body.email}`;
  loginThrottle.check(throttleKey);
  const user = body.email && body.password ? await verifyLogin(body.email, body.password) : null;
  const isAdmin = user ? await sys.one(`select 1 from public.platform_admins where user_id = $1`, [user.id]) : null;
  if (!user || !isAdmin) {
    loginThrottle.fail(throttleKey);
    throw badRequest("Incorrect email or password.");
  }
  loginThrottle.reset(throttleKey);
  // Platform sessions are short (1 day) and never bound to an institute.
  const session = await createSession(user.id, false, meta(body), { platform: true });
  res.json({ ...session, home: "/platform" });
});

// ---------- Session / refresh / logout ----------
authRouter.get("/session", authenticate, (req, res) => {
  res.json(req.ctx);
});

authRouter.post("/refresh", authenticate, async (req, res) => {
  const token = bearer(req);
  const c = req.ctx!;
  const s = await sys.one<{ id: string; persistent: boolean }>(
    `select id, persistent from auth.sessions where id = $1 and expires_at > now()`,
    [req.sessionId!],
  );
  if (!s) throw forbidden("Session expired or invalid.");

  const newExpiresAt = new Date(Date.now() + sessionTtl(true));
  await sys.q(
    `update auth.sessions set last_seen_at = now(), expires_at = $2, persistent = true where id = $1`,
    [req.sessionId!, newExpiresAt],
  );

  res.json({
    ok: true,
    token,
    expiresAt: newExpiresAt.toISOString(),
    persistent: true,
    roles: c.roles,
    home: c.platform ? "/platform" : homeFor(c.roles),
  });
});

authRouter.post("/logout", authenticate, async (req, res) => {
  await revokeSession(req.sessionId!);
  res.json({ ok: true });
});

/** Institutes the signed-in user can switch to. */
authRouter.get("/institutes", authenticate, async (req, res) => {
  const rows = await sys.q<{ id: string; name: string; code: string; logo_path: string | null; roles: AppRole[] }>(
    `select i.id, i.name, i.code, i.logo_path, array_agg(r.role::text order by r.role) as roles
       from public.memberships m
       join public.institutes i on i.id = m.institute_id and i.status = 'active'
       join public.user_roles r on r.user_id = m.user_id and r.institute_id = m.institute_id
      where m.user_id = $1 and m.status = 'active'
      group by i.id order by i.name`,
    [req.ctx!.userId],
  );
  res.json(rows.map((r) => ({ ...r, current: r.id === req.ctx!.profile.institute_id })));
});

authRouter.post("/switch", authenticate, async (req, res) => {
  const { institute_id } = z.object({ institute_id: z.uuid() }).parse(req.body);
  const c = req.ctx!;
  if (c.platform) throw badRequest("Platform sessions cannot switch to an institute.");
  const inst = await sys.one<{ status: string }>(`select status from public.institutes where id = $1`, [institute_id]);
  const m = inst ? await membershipOf(c.userId, institute_id) : null;
  if (!inst || !m) throw badRequest(STATUS_MESSAGES.not_member);
  if (inst.status !== "active") throw badRequest(SUSPENDED_MESSAGE);
  if (m.status !== "active") throw badRequest(STATUS_MESSAGES[m.status] ?? STATUS_MESSAGES.pending_activation);
  if (!m.roles?.length) throw badRequest(STATUS_MESSAGES.no_role);
  await setSessionInstitute(req.sessionId!, institute_id);
  await sys.q(`update public.profiles set institute_id = $2 where id = $1`, [c.userId, institute_id]);
  res.json({ home: homeFor(m.roles) });
});

// ---------- Password recovery ----------
authRouter.post("/forgot-password", async (req, res) => {
  const { identifier, institute_code } = z
    .object({ identifier: z.string().trim().min(1, "Enter your email or mobile number."), institute_code: z.string().default("") })
    .parse(req.body);
  const code = codeSchema.safeParse(institute_code);
  const inst = code.success ? await findInstitute(code.data) : null;
  if (!identifier.includes("@") && !inst) throw badRequest("Enter your institute code to reset the password with a mobile number.");
  const email = identifier.includes("@") ? identifier.toLowerCase() : await emailForPhone(normalizePhone(identifier), inst!.id);
  if (email) {
    const user = await sys.one<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email]);
    if (user) await sendPasswordReset(user.id, email, inst?.id);
  }
  // Same response whether or not the account exists (no account enumeration).
  res.json({ message: "If an account exists, a password reset link has been sent to its email address." });
});

/** Exchange an email link (invite / recovery) for a session in the link's institute. */
authRouter.post("/verify-link", async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200), userAgent: z.string().optional(), ip: z.string().optional() }).parse(req.body);
  const link = await consumeEmailLink(body.token);
  if (!link) throw new HttpError(400, "This link has expired or was already used. Ask the institute to send a new one, or use 'Forgot password'.");
  const instituteId =
    link.instituteId ?? (await sys.one<{ institute_id: string | null }>(`select institute_id from public.profiles where id = $1`, [link.userId]))?.institute_id ?? null;
  const session = await createSession(link.userId, false, meta(body), { instituteId });
  res.json({ ...session, type: link.type });
});

/** Set a new password for the signed-in user (after an invite/recovery link). */
authRouter.post("/reset-password", authenticate, async (req, res) => {
  const { password } = z.object({ password: passwordSchema(8) }).parse(req.body);
  const c = req.ctx!;
  await sys.q(`update auth.users set encrypted_password = $2, email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1`, [
    c.userId,
    await hashPassword(password),
  ]);
  // Sign out every other device; an invited user who sets a password becomes active in every institute that invited them.
  await sys.q(`delete from auth.sessions where user_id = $1 and id <> $2`, [c.userId, req.sessionId]);
  await sys.q(`update public.profiles set status = 'active' where id = $1 and status = 'pending_activation'`, [c.userId]);
  await sys.q(`update public.memberships set status = 'active' where user_id = $1 and status = 'pending_activation'`, [c.userId]);
  if (c.profile.institute_id) await healUserRoles(c.userId, c.profile.institute_id, c.email);
  forgetUser(c.userId);
  const m = c.profile.institute_id ? await membershipOf(c.userId, c.profile.institute_id) : null;
  res.json({ ok: true, home: m?.roles?.length ? homeFor(m.roles) : c.platform ? "/platform" : "/" });
});

/** Change password while signed in (re-verifies the current one). */
authRouter.post("/change-password", authenticate, async (req, res) => {
  const v = z
    .object({ current: z.string().min(1, "Enter your current password"), password: passwordSchema(8) })
    .parse(req.body);
  const c = req.ctx!;
  const u = await sys.one<{ encrypted_password: string | null }>(`select encrypted_password from auth.users where id = $1`, [c.userId]);
  if (!(await verifyPassword(v.current, u?.encrypted_password ?? null))) {
    throw new HttpError(400, "Current password is incorrect.", { current: ["Current password is incorrect"] });
  }
  await sys.q(`update auth.users set encrypted_password = $2, updated_at = now() where id = $1`, [c.userId, await hashPassword(v.password)]);
  await sys.q(`delete from auth.sessions where user_id = $1 and id <> $2`, [c.userId, req.sessionId]);
  res.json({ message: "Password changed" });
});

authRouter.patch("/profile", authenticate, async (req, res) => {
  const v = z.object({ full_name: requiredText("Name", 100) }).parse(req.body);
  const c = ctxOf(req);
  await sys.q(`update public.profiles set full_name = $2 where id = $1`, [c.userId, v.full_name]);
  forgetUser(c.userId);
  res.json({ message: "Profile updated" });
});

// ---------- Institute registration (self-serve signup, starts a free trial) ----------
authRouter.get("/setup-status", (_req, res) => {
  // Multi-institute platform: the sign-in page is always available.
  res.json({ complete: true });
});

authRouter.get("/code-available/:code", async (req, res) => {
  const parsed = codeSchema.safeParse(req.params.code);
  if (!parsed.success) return res.json({ available: false, reason: parsed.error.issues[0].message });
  res.json({ available: !(await findInstitute(parsed.data)), code: parsed.data });
});

const handleRegister = async (req: Request, res: import("express").Response) => {
  const v = z
    .object({
      institute_name: requiredText("Institute name", 120),
      institute_code: z.string().trim().default(""),
      full_name: requiredText("Your name", 100),
      email: z.email("Enter a valid email address"),
      phone: phoneSchema,
      password: z.string().min(1, "Enter a password"),
      userAgent: z.string().optional(),
      ip: z.string().optional(),
    })
    .parse(req.body);
  const email = v.email.toLowerCase();
  loginThrottle.check(`register|${v.ip ?? "?"}`);

  let code: string | null = null;
  if (v.institute_code) {
    const parsed = codeSchema.safeParse(v.institute_code);
    if (!parsed.success) throw new HttpError(422, parsed.error.issues[0].message, { institute_code: [parsed.error.issues[0].message] });
    code = parsed.data;
    if (await findInstitute(code)) throw new HttpError(409, "This institute code is already taken. Try another one.", { institute_code: ["Already taken"] });
  }

  // One login per email: an existing user must prove it is theirs to add a new institute.
  const existing = await sys.one<{ id: string; encrypted_password: string | null }>(`select id, encrypted_password from auth.users where lower(email) = $1`, [email]);
  if (existing) {
    if (!(await verifyPassword(v.password, existing.encrypted_password))) {
      loginThrottle.fail(`register|${v.ip ?? "?"}`);
      throw badRequest("An account with this email already exists. Enter that account's current password to add a new institute to it, or use a different email.");
    }
  } else {
    passwordSchema(8).parse(v.password);
  }

  const out = await asSystem(async (db) => {
    const inst = (await db.one<{ id: string; code: string }>(
      `insert into public.institutes (name, phone, email, code) values ($1, $2, $3, $4) returning id, code`,
      [v.institute_name, v.phone, email, code],
    ))!;
    await db.q(`select public.seed_institute_defaults($1)`, [inst.id]);
    const plan = await db.one<{ id: string; code: string; trial_days: number }>(
      `select id, code, trial_days from public.plans where is_active order by is_trial_default desc, sort_order limit 1`,
    );
    if (plan) {
      await db.q(
        `insert into public.subscriptions (institute_id, plan_id, status, trial_ends_at) values ($1, $2, 'trialing', now() + make_interval(days => $3))`,
        [inst.id, plan.id, plan.trial_days],
      );
      await db.q(`insert into public.subscription_events (institute_id, event, details) values ($1, 'created', $2)`, [
        inst.id,
        JSON.stringify({ plan: plan.code, status: "trialing", trial_days: plan.trial_days, source: "self_signup" }),
      ]);
    }
    const uid = existing?.id ?? (await createAuthUser(db, { email, password: v.password, fullName: v.full_name, phone: v.phone, confirmed: true }));
    await db.q(`insert into public.profiles (id, email, phone, full_name, status) values ($1, $2, $3, $4, 'active') on conflict (id) do nothing`, [uid, email, v.phone, v.full_name]);
    await db.q(
      `update public.profiles set institute_id = $2, full_name = coalesce(nullif(full_name, ''), $3), phone = coalesce(phone, $4), email = coalesce(email, $5), status = 'active' where id = $1`,
      [uid, inst.id, v.full_name, v.phone, email],
    );
    await db.q(`insert into public.memberships (user_id, institute_id, status) values ($1, $2, 'active') on conflict (user_id, institute_id) do update set status = 'active'`, [uid, inst.id]);
    await db.q(`insert into public.user_roles (user_id, institute_id, role) values ($1, $2, 'admin')`, [uid, inst.id]);
    return { uid, inst };
  });
  const session = await createSession(out.uid, true, meta(v), { instituteId: out.inst.id });
  res.json({ ...session, home: "/admin/settings?welcome=1", institute_code: out.inst.code });
};

authRouter.post("/register", handleRegister);
authRouter.post("/setup", handleRegister);

export type { AppRole };
