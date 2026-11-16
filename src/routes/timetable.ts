import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h } from "../lib/route.js";
import { badRequest, notFound } from "../lib/errors.js";

export const timetableRouter = Router();
const admin = requireRole("admin");
const optUuid = z.string().nullish().transform((v) => v || null).pipe(z.uuid().nullable());
const optStr = z.string().trim().nullish().transform((v) => v || null);

timetableRouter.post(
  "/",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const v = z
      .object({
        id: optUuid, batch_id: z.uuid("Select a batch"), subject_id: optUuid, teacher_id: optUuid,
        day_of_week: z.coerce.number().int().min(1).max(7), start_time: z.string().regex(/^\d{2}:\d{2}/), end_time: z.string().regex(/^\d{2}:\d{2}/),
        room: optStr, effective_from: optStr, effective_to: optStr, override_reason: optStr,
      })
      .parse(req.body);
    if (v.end_time <= v.start_time) throw badRequest("End time must be after start time");
    if (!(await db.one(`select 1 from public.batches where id = $1 and institute_id = $2`, [v.batch_id, inst]))) throw notFound("Batch not found.");
    const vals = [inst, v.batch_id, v.subject_id, v.teacher_id, v.day_of_week, v.start_time, v.end_time, v.room, v.effective_from, v.effective_to, v.override_reason, ctx.userId, ctx.timezone];
    if (v.id) {
      const r = await db.q(
        `update public.timetable set batch_id = $2, subject_id = $3, teacher_id = $4, day_of_week = $5, start_time = $6, end_time = $7, room = $8,
                effective_from = coalesce($9::date, (now() at time zone $13)::date), effective_to = $10, override_reason = $11, created_by = $12, is_active = true
          where id = $14 and institute_id = $1 returning id`,
        [...vals, v.id],
      );
      if (!r.length) throw notFound("Slot not found.");
    } else {
      await db.q(
        `insert into public.timetable (institute_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room, effective_from, effective_to, override_reason, created_by, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, (now() at time zone $13)::date), $10, $11, $12, true)`,
        vals,
      );
    }
    return { message: "Timetable slot saved" };
  }),
);

timetableRouter.post(
  "/:id/deactivate",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const r = await db.q(`update public.timetable set is_active = false where id = $1 and institute_id = $2 returning id`, [id, inst]);
    if (!r.length) throw notFound("Slot not found.");
    return { message: "Slot deactivated" };
  }),
);

timetableRouter.post(
  "/generate-sessions",
  admin,
  h(async ({ req, db }) => {
    const v = z.object({ from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.body);
    const r = await db.one<{ n: number }>(`select public.generate_class_sessions($1, $2) as n`, [v.from_date, v.to_date]);
    return { message: `Successfully generated ${r?.n ?? 0} class sessions` };
  }),
);

/** Teacher's weekly timetable (assigned batches or slots they teach). */
timetableRouter.get(
  "/mine",
  requireRole("teacher"),
  h(async ({ db }) =>
    db.q(
      `select t.id, t.day_of_week, t.start_time, t.end_time, t.room, json_build_object('name', b.name) as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects
         from public.timetable t join public.batches b on b.id = t.batch_id left join public.subjects sj on sj.id = t.subject_id
        where t.is_active and (t.batch_id in (select public.my_batch_ids()) or t.teacher_id = public.my_teacher_id())
        order by t.day_of_week, t.start_time`,
    ),
  ),
);
