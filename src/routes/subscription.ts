import { Router } from "express";
import { sys } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { storageUsed } from "../lib/storage.js";

/** Institute admin: current plan, usage against limits, available plans and renewal history. */
export const subscriptionRouter = Router();
subscriptionRouter.use(requireRole("admin"));

subscriptionRouter.get("/", async (req, res) => {
  const ctx = ctxOf(req);
  const inst = ctx.institute.id;
  const [r, storage] = await Promise.all([
    sys.one(
      `select jsonb_build_object(
                'students', (select count(*) from public.students where institute_id = $1 and status = 'active'),
                'teachers', (select count(*) from public.teachers where institute_id = $1 and employment_status in ('active', 'on_leave')),
                'batches', (select count(*) from public.batches where institute_id = $1 and status = 'active')) as usage,
              coalesce((select jsonb_agg(to_jsonb(pl.*) - 'is_trial_default' - 'created_at' - 'updated_at' order by pl.sort_order, pl.price_monthly)
                 from public.plans pl where pl.is_active and pl.is_public), '[]'::jsonb) as plans,
              coalesce((select jsonb_agg(x order by x.created_at desc) from (
                 select e.event, e.amount, e.created_at,
                        jsonb_build_object('plan', e.details->>'plan', 'from', e.details->>'from', 'to', e.details->>'to',
                                           'billing_cycle', e.details->>'billing_cycle', 'status', e.details->>'status') as details
                   from public.subscription_events e
                  where e.institute_id = $1 and e.event in ('created', 'renewed') order by e.created_at desc limit 20) x), '[]'::jsonb) as history`,
      [inst],
    ),
    storageUsed(inst),
  ]);
  res.json({ subscription: ctx.subscription, ...(r as object), storageBytes: storage });
});
