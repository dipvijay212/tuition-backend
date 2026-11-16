import { Router } from "express";
import { z } from "zod";
import { asSystem } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount } from "../lib/route.js";
import { badRequest, notFound } from "../lib/errors.js";
import { revokeAllSessions } from "../auth/sessions.js";
import { provisionAccount, sendPasswordReset } from "../auth/provision.js";
import { passwordSchema, phoneSchema } from "../lib/validation.js";

/** Admin: user accounts and audit log. */
export const usersRouter = Router();
usersRouter.use(requireRole("admin"));

usersRouter.get(
  "/",
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const role = qs(req, "role") ?? null;
    const rows = await db.q<{ total_count: number }>(
      `select p.id, p.full_name, p.email, p.phone, p.status, p.last_login_at,
              coalesce((select json_agg(json_build_object('role', r.role)) from public.user_roles r
                         where r.user_id = p.id and r.institute_id = $1 and ($4::text is null or r.role::text = $4)), '[]') as user_roles,
              count(*) over() as total_count
         from public.profiles p
        where p.institute_id = $1
          and ($2::text is null or p.full_name ilike $2 or p.email ilike $2 or p.phone ilike $2)
          and ($3::text is null or p.status::text = $3)
          and ($4::text is null or exists (select 1 from public.user_roles r where r.user_id = p.id and r.institute_id = $1 and r.role::text = $4))
        order by p.full_name limit $5 offset $6`,
      [inst, q ? like(q) : null, qs(req, "status") ?? null, role, limit, offset],
    );
    return withCount(rows);
  }),
);

usersRouter.get(
  "/audit-logs",
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const rows = await db.q<{ total_count: number }>(
      `select a.id, a.action, a.entity, a.entity_id, a.old_values, a.new_values, a.reason, a.created_at,
              case when p.id is null then null else json_build_object('full_name', p.full_name) end as profiles,
              count(*) over() as total_count
         from public.audit_logs a left join public.profiles p on p.id = a.user_id
        where a.institute_id = $1 and ($2::text is null or a.action ilike $2) and ($3::text is null or a.entity = $3)
          and ($4::date is null or a.created_at >= ($4::date::timestamp at time zone 'Asia/Kolkata'))
          and ($5::date is null or a.created_at < (($5::date + 1)::timestamp at time zone 'Asia/Kolkata'))
        order by a.created_at desc limit $6 offset $7`,
      [inst, q ? like(q) : null, qs(req, "entity") ?? null, qs(req, "from") ?? null, qs(req, "to") ?? null, limit, offset],
    );
    return withCount(rows);
  }),
);

async function audit(inst: string, userId: string, action: string, entityId: string, oldV: unknown, newV: unknown, reason?: string) {
  await asSystem((db) =>
    db.q(
      `insert into public.audit_logs (institute_id, user_id, action, entity, entity_id, old_values, new_values, reason) values ($1, $2, $3, 'user_accounts', $4, $5, $6, $7)`,
      [inst, userId, action, entityId, oldV === null ? null : JSON.stringify(oldV), newV === null ? null : JSON.stringify(newV), reason ?? null],
    ),
  );
}

const memberOf = (inst: string, userId: string) =>
  asSystem((db) => db.one<{ status: string; full_name: string; email: string | null }>(`select status, full_name, email from public.profiles where id = $1 and institute_id = $2`, [userId, inst]));

usersRouter.post("/:id/status", async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const v = z.object({ status: z.enum(["active", "inactive", "suspended"]), reason: z.string().trim() }).parse(req.body);
  if (id === ctx.userId) throw badRequest("You cannot change your own account status.");
  if (v.reason.length < 5) throw badRequest("Please give a reason.");
  const p = await memberOf(ctx.institute.id, id);
  if (!p) throw notFound("User not found.");
  await asSystem((db) => db.q(`update public.profiles set status = $2 where id = $1`, [id, v.status]), ctx.userId);
  if (v.status !== "active") await revokeAllSessions(id); // sign out blocked users everywhere
  await audit(ctx.institute.id, ctx.userId, "account_status_changed", id, { status: p.status }, { status: v.status }, v.reason);
  res.json({ message: `Account ${v.status}` });
});

usersRouter.post("/:id/roles", async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const v = z.object({ role: z.enum(["admin", "teacher", "student", "parent"]), grant: z.boolean() }).parse(req.body);
  if (id === ctx.userId && v.role === "admin" && !v.grant) throw badRequest("You cannot remove your own admin access.");
  if (!(await memberOf(ctx.institute.id, id))) throw notFound("User not found.");
  await asSystem(async (db) => {
    if (v.grant) {
      await db.q(`insert into public.user_roles (user_id, institute_id, role, created_by) values ($1, $2, $3, $4) on conflict (user_id, institute_id, role) do nothing`, [id, ctx.institute.id, v.role, ctx.userId]);
    } else {
      if (v.role === "admin") {
        const n = await db.one<{ n: number }>(`select count(*)::int as n from public.user_roles where institute_id = $1 and role = 'admin'`, [ctx.institute.id]);
        if ((n?.n ?? 0) <= 1) throw badRequest("At least one admin must remain.");
      }
      await db.q(`delete from public.user_roles where user_id = $1 and institute_id = $2 and role = $3`, [id, ctx.institute.id, v.role]);
    }
  }, ctx.userId);
  await audit(ctx.institute.id, ctx.userId, v.grant ? "role_granted" : "role_revoked", id, null, { role: v.role });
  res.json({ message: v.grant ? `${v.role} access granted` : `${v.role} access removed` });
});

usersRouter.post("/:id/password-reset", async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const u = await asSystem((db) =>
    db.one<{ email: string | null }>(`select coalesce(u.email, p.email) as email from public.profiles p join auth.users u on u.id = p.id where p.id = $1 and p.institute_id = $2`, [id, ctx.institute.id]),
  );
  if (!u?.email) throw badRequest("This user has no email address.");
  await sendPasswordReset(id, u.email);
  await audit(ctx.institute.id, ctx.userId, "password_reset_sent", id, null, null);
  res.json({ message: `Reset link sent to ${u.email}` });
});

usersRouter.post("/admins", async (req, res) => {
  const ctx = ctxOf(req);
  const v = z.object({ full_name: z.string().trim().min(1).max(100), email: z.email(), phone: phoneSchema, password: passwordSchema(8) }).parse(req.body);
  await provisionAccount(ctx, { email: v.email, phone: v.phone, fullName: v.full_name, role: "admin", mode: "password", password: v.password });
  res.json({ message: "Admin account created" });
});
