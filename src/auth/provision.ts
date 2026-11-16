import { asSystem, sys, type Db } from "../db/pool.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { renderInvitationEmail, renderPasswordResetEmail, sendEmail } from "../email/index.js";
import type { AppRole, SessionContext } from "./context.js";
import { hashPassword, hashToken, newToken } from "./crypto.js";

const LINK_TTL = { invite: 7 * 24 * 60 * 60 * 1000, recovery: 60 * 60 * 1000 } as const;
export type LinkType = keyof typeof LINK_TTL;

/** Single-use email link. The page at /auth/callback exchanges it for a session. */
export async function createEmailLink(userId: string, type: LinkType, db: Db = sys) {
  const token = newToken();
  await db.q(`insert into auth.one_time_tokens (user_id, token_type, token_hash, expires_at) values ($1, $2, $3, $4)`, [
    userId,
    type,
    hashToken(token),
    new Date(Date.now() + LINK_TTL[type]),
  ]);
  return `${env.siteUrl}/auth/callback?token=${encodeURIComponent(token)}&type=${type}`;
}

/** Consumes a link token. Returns the user and link type, or null when invalid/expired/used. */
export async function consumeEmailLink(token: string) {
  const row = await sys.one<{ user_id: string; token_type: LinkType }>(
    `update auth.one_time_tokens set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning user_id, token_type`,
    [hashToken(token)],
  );
  if (!row) return null;
  // An opened link proves the email address.
  await sys.q(`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1`, [row.user_id]);
  return { userId: row.user_id, type: row.token_type };
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
  const actionLink = await createEmailLink(userId, "invite");
  const tpl = renderInvitationEmail({ instituteName: ctx.institute?.name, recipientName: fullName, recipientEmail: email, role, actionLink });
  await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: ctx.institute?.id });
}

export async function sendPasswordReset(userId: string, email: string) {
  const info = await sys.one<{ full_name: string | null; inst: string | null }>(
    `select p.full_name, i.name as inst from public.profiles p left join public.institutes i on i.id = p.institute_id where p.id = $1`,
    [userId],
  );
  const actionLink = await createEmailLink(userId, "recovery");
  const tpl = renderPasswordResetEmail({
    instituteName: info?.inst ?? "Tuition Management",
    recipientName: info?.full_name ?? undefined,
    recipientEmail: email,
    actionLink,
  });
  await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
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
 * - Reuses an existing user with the same email (no duplicate accounts).
 * - Refuses to touch users that belong to a different institute.
 * Caller MUST have verified the admin role first.
 */
export async function provisionAccount(ctx: SessionContext, input: ProvisionInput): Promise<{ userId: string; created: boolean; invited: boolean }> {
  const institute = ctx.institute!.id;
  const email = input.email.trim().toLowerCase();

  const result = await asSystem(async (db) => {
    const existing = await db.one<{ id: string; institute_id: string | null }>(
      `select p.id, p.institute_id from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = $1 or lower(p.email) = $1 limit 1`,
      [email],
    );
    if (existing) {
      if (existing.institute_id && existing.institute_id !== institute) throw badRequest("This email is registered with another institute.");
      await db.q(`update public.profiles set institute_id = $2, phone = coalesce($3, phone) where id = $1`, [existing.id, institute, input.phone ?? null]);
      await db.q(
        `insert into public.user_roles (user_id, institute_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, institute_id, role) do nothing`,
        [existing.id, institute, input.role, ctx.userId],
      );
      await audit(db, ctx, "role_granted", existing.id, { role: input.role, email });
      return { userId: existing.id, created: false, invited: input.mode === "invite" };
    }

    if (input.phone) {
      const owner = await db.one(`select id from public.profiles where institute_id = $1 and phone = $2`, [institute, input.phone]);
      if (owner) throw badRequest("This mobile number is already used by another login. Use that person's email to link the account.");
    }
    if (input.mode === "password" && !input.password) throw badRequest("Password is required.");

    const userId = await createAuthUser(db, { email, password: input.mode === "password" ? input.password : undefined, fullName: input.fullName, phone: input.phone, confirmed: input.mode === "password" });
    await db.q(
      `update public.profiles set institute_id = $2, full_name = $3, email = $4, phone = $5, status = $6 where id = $1`,
      [userId, institute, input.fullName, email, input.phone ?? null, input.mode === "password" ? "active" : "pending_activation"],
    );
    await db.q(
      `insert into public.user_roles (user_id, institute_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, institute_id, role) do nothing`,
      [userId, institute, input.role, ctx.userId],
    );
    await audit(db, ctx, "account_created", userId, { role: input.role, email, mode: input.mode });
    return { userId, created: true, invited: input.mode === "invite" };
  }, ctx.userId);

  // Email is sent after the transaction commits.
  if (result.invited) await sendInvitation(ctx, result.userId, email, input.fullName, input.role);
  return result;
}
