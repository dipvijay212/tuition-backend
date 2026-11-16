import { Router } from "express";
import { z } from "zod";
import { asSystem, sys } from "../db/pool.js";
import { badRequest, HttpError } from "../lib/errors.js";
import { normalizePhone, passwordSchema, phoneSchema, requiredText } from "../lib/validation.js";
import { authenticate, ctxOf } from "../middleware.js";
import { healUserRoles, loadSessionContext, ROLE_HOME, ROLE_PRIORITY, type AppRole } from "../auth/context.js";
import { hashPassword, verifyPassword } from "../auth/crypto.js";
import { createSession, revokeAllSessions, revokeSession } from "../auth/sessions.js";
import { consumeEmailLink, createAuthUser, sendPasswordReset } from "../auth/provision.js";

export const authRouter = Router();

const GENERIC = "Incorrect mobile number/email or password.";
const STATUS_MESSAGES: Record<string, string> = {
  inactive: "Your account is inactive. Please contact the institute.",
  suspended: "Your account has been suspended. Please contact the institute.",
  pending_activation: "Your account has not been activated yet. Please contact the institute.",
  no_role: "Your account has no access assigned yet. Please contact the institute.",
};

/** Resolve a 10-digit phone to a login email (profiles, then guardians, then students). Never exposed to the browser. */
async function emailForPhone(phone: string): Promise<string | null> {
  for (const t of ["profiles", "guardians", "students"]) {
    const rows = await sys.q<{ email: string }>(`select email from public.${t} where phone = $1 and email is not null limit 2`, [phone]);
    if (rows.length === 1) return rows[0].email.trim().toLowerCase();
    if (rows.length > 1) return null; // ambiguous
  }
  return null;
}

const meta = (body: { userAgent?: string; ip?: string }) => ({ userAgent: body.userAgent, ip: body.ip });

// ---------- Login ----------
authRouter.post("/login", async (req, res) => {
  const body = z
    .object({ identifier: z.string().trim(), password: z.string(), remember: z.boolean().default(true), userAgent: z.string().optional(), ip: z.string().optional() })
    .parse(req.body);
  if (!body.identifier || !body.password) throw badRequest("Enter your mobile number or email and password.");

  let email = body.identifier.toLowerCase();
  let phone: string | null = null;
  if (!body.identifier.includes("@")) {
    phone = normalizePhone(body.identifier);
    if (!/^\d{10}$/.test(phone)) throw badRequest(GENERIC);
    const resolved = await emailForPhone(phone);
    if (!resolved) throw badRequest(GENERIC);
    email = resolved;
  }

  const user = await sys.one<{ id: string; encrypted_password: string | null; banned_until: Date | null }>(
    `select id, encrypted_password, banned_until from auth.users where lower(email) = $1`,
    [email],
  );
  if (!user || !(await verifyPassword(body.password, user.encrypted_password))) throw badRequest(GENERIC);
  if (user.banned_until && user.banned_until > new Date()) throw badRequest(STATUS_MESSAGES.suspended);

  // Make sure a profile exists (older accounts), then heal role links if needed.
  await sys.q(`insert into public.profiles (id, email, phone, status) values ($1, $2, $3, 'active') on conflict (id) do nothing`, [user.id, email, phone]);
  let ctx = await loadSessionContext(user.id);
  if (ctx && ctx.roles.length === 0) {
    await healUserRoles(user.id, email, phone ?? ctx.profile.phone);
    ctx = await loadSessionContext(user.id);
  }
  if (!ctx || ctx.profile.status !== "active") throw badRequest(STATUS_MESSAGES[ctx?.profile.status ?? "pending_activation"]);
  if (ctx.roles.length === 0) throw badRequest(STATUS_MESSAGES.no_role);

  const session = await createSession(user.id, body.remember, meta(body));
  await sys.q(`update public.profiles set last_login_at = now() where id = $1`, [user.id]);
  if (ctx.profile.institute_id) {
    await sys.q(`insert into public.audit_logs (institute_id, user_id, action, entity, entity_id) values ($1, $2::uuid, 'login', 'auth', $2::text)`, [ctx.profile.institute_id, user.id]);
  }
  res.json({ ...session, roles: ctx.roles, home: ROLE_HOME[ctx.roles[0]] });
});

// ---------- Session / logout ----------
authRouter.get("/session", authenticate, (req, res) => {
  res.json(req.ctx);
});

authRouter.post("/logout", authenticate, async (req, res) => {
  await revokeSession(req.sessionId!);
  res.json({ ok: true });
});

// ---------- Password recovery ----------
authRouter.post("/forgot-password", async (req, res) => {
  const { identifier } = z.object({ identifier: z.string().trim().min(1, "Enter your email or mobile number.") }).parse(req.body);
  const email = identifier.includes("@") ? identifier.toLowerCase() : await emailForPhone(normalizePhone(identifier));
  if (email) {
    const user = await sys.one<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email]);
    if (user) await sendPasswordReset(user.id, email);
  }
  // Same response whether or not the account exists (no account enumeration).
  res.json({ message: "If an account exists, a password reset link has been sent to its email address." });
});

/** Exchange an email link (invite / recovery) for a session. */
authRouter.post("/verify-link", async (req, res) => {
  const body = z.object({ token: z.string().min(10).max(200), userAgent: z.string().optional(), ip: z.string().optional() }).parse(req.body);
  const link = await consumeEmailLink(body.token);
  if (!link) throw new HttpError(400, "This link has expired or was already used. Ask the institute to send a new one, or use 'Forgot password'.");
  const session = await createSession(link.userId, false, meta(body));
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
  // Sign out every other device; an invited user who sets a password becomes active.
  await sys.q(`delete from auth.sessions where user_id = $1 and id <> $2`, [c.userId, req.sessionId]);
  await sys.q(`update public.profiles set status = 'active' where id = $1 and status = 'pending_activation'`, [c.userId]);
  await healUserRoles(c.userId, c.email);
  const ctx = await loadSessionContext(c.userId);
  const role = ROLE_PRIORITY.find((r) => ctx?.roles.includes(r));
  res.json({ ok: true, home: role ? ROLE_HOME[role] : "/" });
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
  await sys.q(`update public.profiles set full_name = $2 where id = $1`, [ctxOf(req).userId, v.full_name]);
  res.json({ message: "Profile updated" });
});

// ---------- First-run setup (only while no institute exists) ----------
const isSetupComplete = async () => !!(await sys.one(`select 1 from public.institutes limit 1`));

authRouter.get("/setup-status", async (_req, res) => {
  res.json({ complete: await isSetupComplete() });
});

authRouter.post("/setup", async (req, res) => {
  if (await isSetupComplete()) throw badRequest("Setup has already been completed. Please sign in.");
  const v = z
    .object({
      institute_name: requiredText("Institute name", 120),
      full_name: requiredText("Your name", 100),
      email: z.email("Enter a valid email address"),
      phone: phoneSchema,
      password: passwordSchema(8),
      userAgent: z.string().optional(),
      ip: z.string().optional(),
    })
    .parse(req.body);
  const email = v.email.toLowerCase();

  const userId = await asSystem(async (db) => {
    // Lock so two concurrent setups can't both succeed.
    await db.q(`lock table public.institutes in exclusive mode`);
    if (await db.one(`select 1 from public.institutes limit 1`)) throw badRequest("Setup has already been completed. Please sign in.");
    const inst = await db.one<{ id: string }>(`insert into public.institutes (name, phone, email) values ($1, $2, $3) returning id`, [v.institute_name, v.phone, email]);
    await db.q(`select public.seed_institute_defaults($1)`, [inst!.id]);
    const uid = await createAuthUser(db, { email, password: v.password, fullName: v.full_name, phone: v.phone, confirmed: true });
    await db.q(`update public.profiles set institute_id = $2, full_name = $3, phone = $4, email = $5, status = 'active' where id = $1`, [uid, inst!.id, v.full_name, v.phone, email]);
    await db.q(`insert into public.user_roles (user_id, institute_id, role) values ($1, $2, 'admin')`, [uid, inst!.id]);
    return uid;
  });
  const session = await createSession(userId, true, meta(v));
  res.json({ ...session, home: "/admin/settings?welcome=1" });
});

/** Admin helper used by user management: force sign-out everywhere. */
export async function signOutEverywhere(userId: string) {
  await revokeAllSessions(userId);
}

export type { AppRole };
