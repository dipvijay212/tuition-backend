import { Router, type Request } from "express";
import { z } from "zod";
import { asSystem, sys } from "../db/pool.js";
import { badRequest, HttpError, notFound } from "../lib/errors.js";
import { requirePlatform } from "../middleware.js";
import { like, paging, qs, withCount } from "../lib/route.js";
import { forgetInstitute } from "../auth/sessions.js";
import { FEATURES } from "../auth/context.js";

/**
 * Platform (super admin) API: institutes, subscriptions (manual billing) and plans.
 * Runs as the owner (sees every institute), so every route is behind requirePlatform.
 */
export const platformRouter = Router();
platformRouter.use(requirePlatform);

const actor = (req: Request) => req.ctx!.userId;
const id = (req: Request) => z.uuid("Invalid id").parse(req.params.id);

async function event(instituteId: string, userId: string, ev: string, details: Record<string, unknown>, amount: number | null = null) {
  await sys.q(`insert into public.subscription_events (institute_id, event, amount, details, actor_id) values ($1, $2, $3, $4, $5)`, [
    instituteId,
    ev,
    amount,
    JSON.stringify(details),
    userId,
  ]);
}

// ---------- Overview ----------
platformRouter.get("/overview", async (_req, res) => {
  const r = await sys.one(
    `select
       (select count(*)::int from public.institutes) as institutes,
       (select coalesce(jsonb_object_agg(access, n), '{}'::jsonb) from (select access, count(*)::int as n from public.institute_access group by access) x) as by_access,
       (select count(*)::int from public.institutes where created_at > now() - interval '30 days') as signups_30d,
       (select count(*)::int from public.students where status = 'active') as active_students,
       (select coalesce(sum(case when a.billing_cycle = 'yearly' then pl.price_yearly / 12 else pl.price_monthly end), 0)
          from public.institute_access a join public.plans pl on pl.id = a.plan_id
         where a.access in ('active', 'grace') and a.sub_status = 'active') as mrr,
       (select coalesce(jsonb_agg(x order by x.ends_at), '[]'::jsonb) from (
          select a.institute_id as id, i.name, i.code, a.access, a.plan_name, a.ends_at
            from public.institute_access a join public.institutes i on i.id = a.institute_id
           where a.access in ('trial', 'active', 'grace') and a.ends_at is not null and a.ends_at < now() + interval '7 days'
           order by a.ends_at limit 10) x) as ending_soon,
       (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
          select i.id, i.name, i.code, i.created_at, a.access, a.plan_name
            from public.institutes i join public.institute_access a on a.institute_id = i.id
           order by i.created_at desc limit 8) x) as recent`,
  );
  res.json(r);
});

// ---------- Institutes ----------
platformRouter.get("/institutes", async (req, res) => {
  const { limit, offset } = paging(req);
  const q = qs(req, "q");
  const rows = await sys.q<{ total_count: number }>(
    `select i.id, i.name, i.code, i.status, i.created_at, i.phone, i.email,
            a.access, a.sub_status, a.plan_code, a.plan_name, a.billing_cycle, a.ends_at,
            (select count(*)::int from public.students s where s.institute_id = i.id and s.status = 'active') as students,
            (select count(*)::int from public.teachers t where t.institute_id = i.id and t.employment_status in ('active', 'on_leave')) as teachers,
            (select json_build_object('name', p.full_name, 'email', p.email, 'phone', p.phone)
               from public.user_roles r join public.profiles p on p.id = r.user_id
              where r.institute_id = i.id and r.role = 'admin' order by r.created_at limit 1) as owner,
            count(*) over() as total_count
       from public.institutes i
       join public.institute_access a on a.institute_id = i.id
      where ($1::text is null or i.name ilike $1 or i.code ilike $1 or i.email ilike $1 or i.phone ilike $1)
        and ($2::text is null or a.access = $2)
        and ($3::text is null or a.plan_code = $3)
      order by i.created_at desc
      limit $4 offset $5`,
    [q ? like(q) : null, qs(req, "access") ?? null, qs(req, "plan") ?? null, limit, offset],
  );
  res.json(withCount(rows));
});

platformRouter.get("/institutes/:id", async (req, res) => {
  const instId = id(req);
  const r = await sys.one<{ institute: unknown }>(
    `select to_jsonb(i.*) as institute,
            to_jsonb(a.*) as access,
            to_jsonb(s.*) as subscription,
            jsonb_build_object(
              'students', (select count(*) from public.students where institute_id = i.id and status = 'active'),
              'students_total', (select count(*) from public.students where institute_id = i.id),
              'teachers', (select count(*) from public.teachers where institute_id = i.id and employment_status in ('active', 'on_leave')),
              'batches', (select count(*) from public.batches where institute_id = i.id and status = 'active'),
              'users', (select count(*) from public.memberships where institute_id = i.id and status = 'active'),
              'storage_bytes', (select storage_bytes from public.institute_usage where institute_id = i.id),
              'last_login_at', (select max(last_login_at) from public.memberships where institute_id = i.id)
            ) as usage,
            coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email, 'phone', p.phone, 'status', m.status, 'last_login_at', m.last_login_at) order by p.full_name)
               from public.user_roles r join public.profiles p on p.id = r.user_id
               join public.memberships m on m.user_id = r.user_id and m.institute_id = r.institute_id
              where r.institute_id = i.id and r.role = 'admin'), '[]'::jsonb) as admins,
            coalesce((select jsonb_agg(x order by x.created_at desc) from (
               select e.id, e.event, e.amount, e.details, e.created_at, p.full_name as actor
                 from public.subscription_events e left join public.profiles p on p.id = e.actor_id
                where e.institute_id = i.id order by e.created_at desc limit 50) x), '[]'::jsonb) as events
       from public.institutes i
       left join public.institute_access a on a.institute_id = i.id
       left join public.subscriptions s on s.institute_id = i.id
      where i.id = $1`,
    [instId],
  );
  if (!r) throw notFound("Institute not found.");
  res.json(r);
});

const codeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4,12}$/, "Institute code is 4–12 letters or numbers."));

platformRouter.patch("/institutes/:id", async (req, res) => {
  const instId = id(req);
  const v = z.object({ name: z.string().trim().min(1).max(120), code: codeSchema }).parse(req.body);
  const clash = await sys.one(`select 1 from public.institutes where code = $1 and id <> $2`, [v.code, instId]);
  if (clash) throw new HttpError(409, "This institute code is already taken.", { code: ["Already taken"] });
  const old = await sys.one<{ name: string; code: string }>(`update public.institutes i set name = $2, code = $3 from (select name, code from public.institutes where id = $1) o where i.id = $1 returning o.name, o.code`, [instId, v.name, v.code]);
  if (!old) throw notFound("Institute not found.");
  if (old.code !== v.code || old.name !== v.name) await event(instId, actor(req), "profile_changed", { from: old, to: v });
  forgetInstitute(instId);
  res.json({ message: "Institute updated" });
});

platformRouter.post("/institutes/:id/status", async (req, res) => {
  const instId = id(req);
  const v = z.object({ status: z.enum(["active", "suspended"]), reason: z.string().trim().min(3, "Please give a reason") }).parse(req.body);
  const r = await sys.one(`update public.institutes set status = $2 where id = $1 returning id`, [instId, v.status]);
  if (!r) throw notFound("Institute not found.");
  await event(instId, actor(req), v.status === "suspended" ? "suspended" : "reactivated", { reason: v.reason });
  forgetInstitute(instId);
  res.json({ message: v.status === "suspended" ? "Institute suspended" : "Institute reactivated" });
});

const dateOrNull = z
  .string()
  .nullish()
  .transform((s) => s || null)
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable());

/** Set the subscription directly (plan, status, dates). */
platformRouter.put("/institutes/:id/subscription", async (req, res) => {
  const instId = id(req);
  const v = z
    .object({
      plan_id: z.uuid("Choose a plan"),
      status: z.enum(["trialing", "active", "cancelled"]),
      billing_cycle: z.enum(["monthly", "yearly"]),
      trial_ends_at: dateOrNull,
      current_period_end: dateOrNull,
      grace_days: z.number().int().min(0).max(60),
      notes: z.string().trim().max(1000).nullish().transform((s) => s || null),
    })
    .parse(req.body);
  if (v.status === "trialing" && !v.trial_ends_at) throw badRequest("Set the trial end date.");
  const plan = await sys.one<{ code: string }>(`select code from public.plans where id = $1`, [v.plan_id]);
  if (!plan) throw badRequest("Plan not found.");
  await asSystem(async (db) => {
    const before = await db.one(`select to_jsonb(s.*) as s from public.subscriptions s where institute_id = $1`, [instId]);
    await db.q(
      `insert into public.subscriptions (institute_id, plan_id, status, billing_cycle, trial_ends_at, current_period_end, grace_days, notes, updated_by)
       values ($1, $2, $3, $4, ($5::date + 1)::timestamptz, $6, $7, $8, $9)
       on conflict (institute_id) do update set plan_id = excluded.plan_id, status = excluded.status, billing_cycle = excluded.billing_cycle,
         trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end, grace_days = excluded.grace_days,
         notes = excluded.notes, updated_by = excluded.updated_by`,
      [instId, v.plan_id, v.status, v.billing_cycle, v.trial_ends_at, v.current_period_end, v.grace_days, v.notes, actor(req)],
    );
    await db.q(`insert into public.subscription_events (institute_id, event, details, actor_id) values ($1, 'subscription_updated', $2, $3)`, [
      instId,
      JSON.stringify({ plan: plan.code, ...v, before: (before as { s?: unknown } | null)?.s ?? null }),
      actor(req),
    ]);
  });
  forgetInstitute(instId);
  res.json({ message: "Subscription updated" });
});

/** Record an offline payment and extend the paid period (no payment gateway yet). */
platformRouter.post("/institutes/:id/renew", async (req, res) => {
  const instId = id(req);
  const v = z
    .object({
      plan_id: z.uuid().optional(),
      billing_cycle: z.enum(["monthly", "yearly"]),
      periods: z.number().int().min(1).max(36),
      amount: z.number().min(0).nullish().transform((n) => n ?? null),
      method: z.string().trim().max(40).nullish().transform((s) => s || null),
      reference: z.string().trim().max(120).nullish().transform((s) => s || null),
      note: z.string().trim().max(500).nullish().transform((s) => s || null),
    })
    .parse(req.body);
  const r = await asSystem(async (db) => {
    const cur = await db.one<{ plan_id: string; current_period_end: string | null; status: string }>(
      `select plan_id, current_period_end, status from public.subscriptions where institute_id = $1 for update`,
      [instId],
    );
    const planId = v.plan_id ?? cur?.plan_id;
    if (!planId) throw badRequest("Choose a plan.");
    const plan = await db.one<{ code: string }>(`select code from public.plans where id = $1`, [planId]);
    if (!plan) throw badRequest("Plan not found.");
    // Extend from the current end date when still running, otherwise from today.
    const out = await db.one<{ start: string; period_end: string }>(
      `select greatest(coalesce($1::date, current_date - 1) + 1, current_date)::text as start,
              (greatest(coalesce($1::date, current_date - 1) + 1, current_date)
                 + make_interval(months => case when $2 = 'yearly' then 12 * $3 else $3 end) - interval '1 day')::date::text as period_end`,
      [cur?.status === "active" ? cur.current_period_end : null, v.billing_cycle, v.periods],
    );
    await db.q(
      `insert into public.subscriptions (institute_id, plan_id, status, billing_cycle, current_period_end, updated_by)
       values ($1, $2, 'active', $3, $4, $5)
       on conflict (institute_id) do update set plan_id = excluded.plan_id, status = 'active', billing_cycle = excluded.billing_cycle,
         current_period_end = excluded.current_period_end, trial_ends_at = null, updated_by = excluded.updated_by`,
      [instId, planId, v.billing_cycle, out!.period_end, actor(req)],
    );
    await db.q(`insert into public.subscription_events (institute_id, event, amount, details, actor_id) values ($1, 'renewed', $2, $3, $4)`, [
      instId,
      v.amount,
      JSON.stringify({ plan: plan.code, billing_cycle: v.billing_cycle, periods: v.periods, from: out!.start, to: out!.period_end, method: v.method, reference: v.reference, note: v.note }),
      actor(req),
    ]);
    return out!;
  });
  forgetInstitute(instId);
  res.json({ message: `Renewed until ${r.period_end}`, ...r });
});

// ---------- Plans ----------
const planSchema = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,30}$/, "Use lowercase letters, numbers, - or _"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullish().transform((s) => s || null),
  price_monthly: z.number().min(0),
  price_yearly: z.number().min(0),
  max_students: z.number().int().min(0).nullable(),
  max_teachers: z.number().int().min(0).nullable(),
  max_batches: z.number().int().min(0).nullable(),
  storage_mb: z.number().int().min(0).nullable(),
  features: z.array(z.enum(FEATURES)).default([]),
  trial_days: z.number().int().min(0).max(365),
  is_trial_default: z.boolean(),
  is_public: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int().min(0).max(1000).default(0),
});

platformRouter.get("/plans", async (_req, res) => {
  res.json(
    await sys.q(
      `select pl.*, (select count(*)::int from public.subscriptions s where s.plan_id = pl.id) as institutes
         from public.plans pl order by pl.sort_order, pl.price_monthly`,
    ),
  );
});

async function savePlan(planId: string | null, v: z.infer<typeof planSchema>) {
  return asSystem(async (db) => {
    if (v.is_trial_default) await db.q(`update public.plans set is_trial_default = false where is_trial_default and id is distinct from $1`, [planId]);
    const cols = [v.code, v.name, v.description, v.price_monthly, v.price_yearly, v.max_students, v.max_teachers, v.max_batches, v.storage_mb, v.features, v.trial_days, v.is_trial_default, v.is_public, v.is_active, v.sort_order];
    if (planId) {
      const r = await db.one(
        `update public.plans set code = $1, name = $2, description = $3, price_monthly = $4, price_yearly = $5, max_students = $6, max_teachers = $7,
                max_batches = $8, storage_mb = $9, features = $10, trial_days = $11, is_trial_default = $12, is_public = $13, is_active = $14, sort_order = $15
          where id = $16 returning id`,
        [...cols, planId],
      );
      if (!r) throw notFound("Plan not found.");
      return planId;
    }
    const r = await db.one<{ id: string }>(
      `insert into public.plans (code, name, description, price_monthly, price_yearly, max_students, max_teachers, max_batches, storage_mb, features, trial_days, is_trial_default, is_public, is_active, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      cols,
    );
    return r!.id;
  });
}

platformRouter.post("/plans", async (req, res) => {
  const planId = await savePlan(null, planSchema.parse(req.body));
  res.json({ message: "Plan created", id: planId });
});

platformRouter.put("/plans/:id", async (req, res) => {
  const planId = id(req);
  await savePlan(planId, planSchema.parse(req.body));
  // Limits/features changed for every institute on this plan.
  const insts = await sys.q<{ institute_id: string }>(`select institute_id from public.subscriptions where plan_id = $1`, [planId]);
  insts.forEach((i) => forgetInstitute(i.institute_id));
  res.json({ message: "Plan saved" });
});
