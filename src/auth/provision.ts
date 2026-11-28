import { asSystem, sys, type Db } from "../db/pool.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { renderInvitationEmail, renderPasswordResetEmail, sendEmail } from "../email/index.js";
import type { AppRole, SessionContext } from "./context.js";
import { hashPassword, hashToken, newToken } from "./crypto.js";
import { forgetUser } from "./sessions.js";

const LINK_TTL = { invite: 7 * 24 * 60 * 60 * 1000, recovery: 60 * 60 * 1000 } as const;
export type LinkType = keyof typeof LINK_TTL;

/** Single-use email link, bound to an institute. The page at /auth/callback exchanges it for a session. */
export async function createEmailLink(userId: string, type: LinkType, instituteId: string | null, db: Db = sys) {
  const token = newToken();
  await db.q(`insert into auth.one_time_tokens (user_id, token_type, token_hash, expires_at, institute_id) values ($1, $2, $3, $4, $5)`, [
    userId,
    type,
    hashToken(token),
    new Date(Date.now() + LINK_TTL[type]),
    instituteId,
  ]);
  return `${env.siteUrl}/auth/callback?token=${encodeURIComponent(token)}&type=${type}`;
}

/** Consumes a link token. Returns the user, link type and institute, or null when invalid/expired/used. */
export async function consumeEmailLink(token: string) {
  const row = await sys.one<{ user_id: string; token_type: LinkType; institute_id: string | null }>(
    `update auth.one_time_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning user_id, token_type, institute_id`,
    [hashToken(token)],
  );
  if (!row) return null;
  // An opened link proves the email address.
  await sys.q(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1`, [row.user_id]);
  return { userId: row.user_id, type: row.token_type, instituteId: row.institute_id };
}

/** Creates a login (auth.users row; the profile row is created by trigger). */
export async function createAuthUser(db: Db, input: { email: string; password?: string; fullName: string; phone?: string | null; confirmed: boolean }) {
  const row = await db.one<{ id: string }>(
    `insert into auth.users (email, phone, encrypted_password, email_confirmed_at, raw_user_meta_data)
     values ($1, $2, $3, case when $4 then now() end, jsonb_build_object('full_name', $5::text))
     returning id`,
    [input.email.toLowerCase(), input.phone ?? null, input.password ? await hashPassword(input.password) : null, input.confirmed, input.fullName],
  );
  return row!.id;
}

export async function sendInvitation(ctx: SessionContext, userId: string, email: string, fullName: string, role: AppRole) {
  const actionLink = await createEmailLink(userId, "invite", ctx.institute?.id ?? null);
  const tpl = renderInvitationEmail({
    instituteName: ctx.institute?.name,
    instituteCode: ctx.institute?.code,
    recipientName: fullName,
    recipientEmail: email,
    role,
    actionLink,
  });
  await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: ctx.institute?.id });
}

/** Password reset link. The link signs the user into `instituteId` (or their last-used institute). */
export async function sendPasswordReset(userId: string, email: string, instituteId?: string | null) {
  const info = await sys.one<{ full_name: string | null; inst_id: string | null; inst: string | null }>(
    `select p.full_name, i.id as inst_id, i.name as inst
       from public.profiles p
       left join public.institutes i on i.id = coalesce($2::uuid, p.institute_id)
      where p.id = $1`,
    [userId, instituteId ?? null],
  );
  const actionLink = await createEmailLink(userId, "recovery", info?.inst_id ?? null);
  const tpl = renderPasswordResetEmail({
    instituteName: info?.inst ?? "Tuition Management",
    recipientName: info?.full_name ?? undefined,
    recipientEmail: email,
    actionLink,
  });
  await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: info?.inst_id ?? undefined });
}

export type ProvisionInput = {
  email: string;
  phone?: string | null;
  fullName: string;
  role: AppRole;
  mode: "invite" | "password";
  password?: string;
};

async function audit(db: Db, ctx: SessionContext, action: string, entityId: string, values: Record<string, unknown>) {
  await db.q(
    `insert into public.audit_logs (institute_id, user_id, action, entity, entity_id, new_values) values ($1, $2, $3, 'user_accounts', $4, $5)`,
    [ctx.institute!.id, ctx.userId, action, entityId, JSON.stringify(values)],
  );
}

/**
 * Create (or reuse) a login for a person and grant a role in the admin's institute.
 * - One login per email across the platform: an existing user (even from another institute)
 *   is added to this institute as a new membership. Their password and other institutes are untouched.
 * Caller MUST have verified the admin role first.
 */
export async function provisionAccount(ctx: SessionContext, input: ProvisionInput): Promise<{ userId: string; created: boolean; invited: boolean }> {
  const institute = ctx.institute!.id;
  const email = input.email.trim().toLowerCase();

  const result = await asSystem(async (db) => {
    if (input.phone) {
      const owner = await db.one<{ id: string }>(
        `select p.id from public.memberships m join public.profiles p on p.id = m.user_id
          where m.institute_id = $1 and p.phone = $2 and lower(coalesce(p.email, '')) <> $3 limit 1`,
        [institute, input.phone, email],
      );
      if (owner) throw badRequest("This mobile number is already used by another login in your institute. Use that person's email to link the account.");
    }

    const existing = await db.one<{ id: string; has_password: boolean }>(
      `select u.id, u.encrypted_password is not null as has_password from auth.users u where lower(u.email) = $1 limit 1`,
      [email],
    );
    if (existing) {
      await db.q(`insert into public.profiles (id, email, phone, full_name, status) values ($1, $2, $3, $4, 'active') on conflict (id) do nothing`, [
        existing.id, email, input.phone ?? null, input.fullName,
      ]);
      await db.q(`update public.profiles set phone = coalesce(phone, $2), full_name = coalesce(nullif(full_name, ''), $3) where id = $1`, [existing.id, input.phone ?? null, input.fullName]);
      // Keep an existing membership's status (an admin may have suspended it); new ones start active if the person can already sign in.
      await db.q(
        `insert into public.memberships (user_id, institute_id, status) values ($1, $2, $3) on conflict (user_id, institute_id) do nothing`,
        [existing.id, institute, existing.has_password ? "active" : "pending_activation"],
      );
      await db.q(
        `insert into public.user_roles (user_id, institute_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, institute_id, role) do nothing`,
        [existing.id, institute, input.role, ctx.userId],
      );
      await audit(db, ctx, "role_granted", existing.id, { role: input.role, email });
      return { userId: existing.id, created: false, invited: input.mode === "invite" };
    }

    if (input.mode === "password" && !input.password) throw badRequest("Password is required.");
    const status = input.mode === "password" ? "active" : "pending_activation";
    const userId = await createAuthUser(db, { email, password: input.mode === "password" ? input.password : undefined, fullName: input.fullName, phone: input.phone, confirmed: input.mode === "password" });
    await db.q(
      `update public.profiles set institute_id = $2, full_name = $3, email = $4, phone = $5, status = $6 where id = $1`,
      [userId, institute, input.fullName, email, input.phone ?? null, status],
    );
    await db.q(`insert into public.memberships (user_id, institute_id, status) values ($1, $2, $3) on conflict (user_id, institute_id) do nothing`, [userId, institute, status]);
    await db.q(
      `insert into public.user_roles (user_id, institute_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, institute_id, role) do nothing`,
      [userId, institute, input.role, ctx.userId],
    );
    await audit(db, ctx, "account_created", userId, { role: input.role, email, mode: input.mode });
    return { userId, created: true, invited: input.mode === "invite" };
  }, ctx);

  forgetUser(result.userId);
  // Email is sent after the transaction commits.
  if (result.invited) await sendInvitation(ctx, result.userId, email, input.fullName, input.role);
  return result;
}
