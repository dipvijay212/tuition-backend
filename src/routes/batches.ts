import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount } from "../lib/route.js";
import { badRequest, friendlyPgError, notFound } from "../lib/errors.js";

export const batchesRouter = Router();
const admin = requireRole("admin");
const teacher = requireRole("teacher");

const optUuid = z.string().nullish().transform((v) => v || null).pipe(z.uuid().nullable());
const optStr = z.string().trim().nullish().transform((v) => v || null);

// Reusable JSON fragments (shapes match what the Next pages used to get from Supabase).
const CLASS_JSON = `case when c.id is null then null else json_build_object('name', c.name) end`;

// ---------- Admin ----------
batchesRouter.get(
  "/",
  admin,
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const rows = await db.q<{ total_count: number }>(
      `select b.id, b.name, b.capacity, b.room, b.status, b.class_days, b.start_time, b.end_time,
              ${CLASS_JSON} as classes,
              coalesce((select json_agg(json_build_object('is_active', tb.is_active, 'teachers', json_build_object('full_name', t.full_name)))
                          from public.teacher_batches tb join public.teachers t on t.id = tb.teacher_id where tb.batch_id = b.id), '[]') as teacher_batches,
              coalesce((select json_agg(json_build_object('status', sb.status)) from public.student_batches sb where sb.batch_id = b.id), '[]') as student_batches,
              count(*) over() as total_count
         from public.batches b left join public.classes c on c.id = b.class_id
        where b.institute_id = $1 and ($2::text is null or b.name ilike $2) and ($3::uuid is null or b.class_id = $3) and ($4::text is null or b.status::text = $4)
        order by b.name limit $5 offset $6`,
      [inst, q ? like(q) : null, qs(req, "class") ?? null, qs(req, "status") ?? null, limit, offset],
    );
    const classes = await db.q(`select id, name from public.classes where institute_id = $1 order by sort_order, name`, [inst]);
    return { ...withCount(rows), classes };
  }),
);

batchesRouter.get(
  "/form-options",
  admin,
  h(async ({ db, inst }) => {
    const r = await db.one(
      `select
        coalesce((select json_agg(json_build_object('id', id, 'name', name) order by sort_order, name) from public.classes where institute_id = $1 and status = 'active'), '[]') as classes,
        coalesce((select json_agg(json_build_object('id', id, 'name', name) order by start_date desc) from public.academic_years where institute_id = $1), '[]') as years,
        coalesce((select json_agg(json_build_object('id', id, 'name', full_name) order by full_name) from public.teachers where institute_id = $1 and employment_status = 'active'), '[]') as teachers,
        coalesce((select json_agg(json_build_object('id', id, 'name', name, 'class_id', class_id) order by name) from public.subjects where institute_id = $1 and status = 'active'), '[]') as subjects,
        (select current_academic_year_id from public.institute_settings where institute_id = $1) as "defaultYear"`,
      [inst],
    );
    return r;
  }),
);

batchesRouter.get(
  "/:id",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const b = await db.one(
      `select to_jsonb(b.*) || jsonb_build_object(
                'classes', ${CLASS_JSON},
                'academic_years', case when y.id is null then null else json_build_object('name', y.name) end,
                'teacher_batches', coalesce((select json_agg(json_build_object('id', tb.id, 'teacher_id', tb.teacher_id, 'is_active', tb.is_active, 'teachers', json_build_object('id', t.id, 'full_name', t.full_name)))
                                               from public.teacher_batches tb join public.teachers t on t.id = tb.teacher_id where tb.batch_id = b.id), '[]'),
                'batch_subjects', coalesce((select json_agg(json_build_object('id', bs.id, 'subject_id', bs.subject_id, 'subjects', json_build_object('name', s.name)))
                                              from public.batch_subjects bs join public.subjects s on s.id = bs.subject_id where bs.batch_id = b.id), '[]')) as batch
         from public.batches b left join public.classes c on c.id = b.class_id left join public.academic_years y on y.id = b.academic_year_id
        where b.id = $1 and b.institute_id = $2`,
      [id, inst],
    );
    if (!b) return { batch: null, enrolments: [] };
    const enrolments = await db.q(
      `select sb.id, sb.start_date, sb.end_date, sb.status, sb.end_reason, sb.capacity_override_reason,
              json_build_object('id', s.id, 'full_name', s.full_name, 'admission_no', s.admission_no, 'status', s.status) as students
         from public.student_batches sb join public.students s on s.id = sb.student_id
        where sb.batch_id = $1 and sb.institute_id = $2
        order by sb.status, sb.start_date desc`,
      [id, inst],
    );
    return { batch: (b as { batch: unknown }).batch, enrolments };
  }),
);

const time = z.string().nullish().transform((v) => v || null).pipe(z.string().regex(/^\d{2}:\d{2}/, "Enter a valid time").nullable());
const batchSchema = z
  .object({
    id: optUuid,
    name: z.string().trim().min(1, "Batch name is required").max(80),
    class_id: z.uuid("Select a class"),
    academic_year_id: optUuid,
    start_date: optStr,
    end_date: optStr,
    class_days: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Select at least one day"),
    start_time: time,
    end_time: time,
    capacity: z.number().int().positive().nullable(),
    room: optStr,
    status: z.enum(["active", "inactive"]).default("active"),
    teacher_ids: z.array(z.uuid()),
    subject_ids: z.array(z.uuid()),
  })
  .superRefine((v, c) => {
    if (v.start_time && v.end_time && v.end_time <= v.start_time) c.addIssue({ code: "custom", path: ["end_time"], message: "End time must be after start time" });
    if (v.start_date && v.end_date && v.end_date < v.start_date) c.addIssue({ code: "custom", path: ["end_date"], message: "End date must be on or after start date" });
  });

batchesRouter.post(
  "/",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const v = batchSchema.parse(req.body);
    const vals = [inst, v.name, v.class_id, v.academic_year_id, v.start_date, v.end_date, v.class_days, v.start_time, v.end_time, v.capacity, v.room, v.status];
    const saved = v.id
      ? await db.one<{ id: string }>(
          `update public.batches set name = $2, class_id = $3, academic_year_id = $4, start_date = $5, end_date = $6, class_days = $7,
                  start_time = $8, end_time = $9, capacity = $10, room = $11, status = $12
            where id = $13 and institute_id = $1 returning id`,
          [...vals, v.id],
        )
      : await db.one<{ id: string }>(
          `insert into public.batches (institute_id, name, class_id, academic_year_id, start_date, end_date, class_days, start_time, end_time, capacity, room, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          vals,
        );
    if (!saved) throw notFound("Batch not found.");
    const batchId = saved.id;

    // Teachers/subjects must belong to this institute.
    const bad = await db.one<{ n: number }>(
      `select (select count(*) from unnest($2::uuid[]) x where not exists (select 1 from public.teachers t where t.id = x and t.institute_id = $1))
            + (select count(*) from unnest($3::uuid[]) x where not exists (select 1 from public.subjects s where s.id = x and s.institute_id = $1)) as n`,
      [inst, v.teacher_ids, v.subject_ids],
    );
    if (Number(bad?.n)) throw badRequest("Invalid teacher or subject selection.");

    // Sync teachers (history kept: removed assignments are deactivated, not deleted).
    await db.q(
      `update public.teacher_batches set is_active = false, end_date = (now() at time zone $3)::date
        where batch_id = $1 and is_active and not (teacher_id = any($2::uuid[]))`,
      [batchId, v.teacher_ids, ctx.timezone],
    );
    await db.q(
      `insert into public.teacher_batches (institute_id, teacher_id, batch_id)
       select $1, t, $2 from unnest($3::uuid[]) t
        where not exists (select 1 from public.teacher_batches tb where tb.batch_id = $2 and tb.teacher_id = t and tb.is_active)`,
      [inst, batchId, v.teacher_ids],
    );
    // Sync subjects.
    await db.q(`delete from public.batch_subjects where batch_id = $1 and not (subject_id = any($2::uuid[]))`, [batchId, v.subject_ids]);
    await db.q(
      `insert into public.batch_subjects (institute_id, batch_id, subject_id)
       select $1, $2, s from unnest($3::uuid[]) s where not exists (select 1 from public.batch_subjects bs where bs.batch_id = $2 and bs.subject_id = s)`,
      [inst, batchId, v.subject_ids],
    );
    const { id: _id, ...audit } = v;
    void _id;
    await db.q(`select public.write_audit($1, 'batches', $2, null, $3)`, [v.id ? "batch_updated" : "batch_created", batchId, JSON.stringify(audit)]);
    return { message: v.id ? "Batch updated" : "Batch created", id: batchId };
  }),
);

batchesRouter.get(
  "/:id/enrollable",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const q = (qs(req, "q") ?? "").trim();
    return db.q(
      `select s.id, s.full_name as name, s.admission_no, c.name as class
         from public.students s left join public.classes c on c.id = s.class_id
        where s.institute_id = $1 and s.status = 'active'
          and ($3::text is null or s.full_name ilike $3 or s.admission_no ilike $3)
          and not exists (select 1 from public.student_batches sb where sb.batch_id = $2 and sb.student_id = s.id and sb.status = 'active')
        order by s.full_name limit 20`,
      [inst, id, q ? like(q) : null],
    );
  }),
);

/** Enrols one student per savepoint so the capacity trigger counts correctly and errors are specific. */
batchesRouter.post(
  "/:id/enrol",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({ student_ids: z.array(z.uuid()).min(1, "Select at least one student."), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid start date."), override_reason: optStr })
      .parse(req.body);
    if (!(await db.one(`select 1 from public.batches where id = $1 and institute_id = $2`, [id, inst]))) throw notFound("Batch not found.");
    let count = 0;
    for (const sid of v.student_ids) {
      await db.q("savepoint enrol");
      try {
        await db.q(
          `insert into public.student_batches (institute_id, student_id, batch_id, start_date, capacity_override_reason, created_by)
           select $1, s.id, $3, $4, $5, $6 from public.students s where s.id = $2 and s.institute_id = $1`,
          [inst, sid, id, v.start_date, v.override_reason, ctx.userId],
        );
        await db.q("release savepoint enrol");
        count++;
      } catch (e) {
        await db.q("rollback to savepoint enrol");
        return { ok: false, count, error: `${count} enrolled. Stopped: ${friendlyPgError(e as never)?.message ?? "Something went wrong."}` };
      }
    }
    return { ok: true, count, message: `${count} student(s) enrolled` };
  }),
);

batchesRouter.post(
  "/enrolments/:id/end",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    const { reason } = z.object({ reason: z.string().trim().min(5, "Please give a reason (at least 5 characters).") }).parse(req.body);
    const r = await db.one<{ batch_id: string }>(
      `update public.student_batches
          set status = 'ended', end_date = greatest(start_date, (now() at time zone $3)::date), end_reason = $4
        where id = $1 and institute_id = $2 and status = 'active' returning batch_id`,
      [id, inst, ctx.timezone, reason],
    );
    if (!r) throw notFound("Active enrolment not found.");
    return { message: "Student removed from batch (history kept)", batch_id: r.batch_id };
  }),
);

// ---------- Teacher ----------
batchesRouter.get(
  "/mine/list",
  teacher,
  h(async ({ db }) =>
    db.q(
      `select b.id, b.name, b.room, b.status, b.class_days, b.start_time, b.end_time, b.capacity, ${CLASS_JSON} as classes,
              coalesce((select json_agg(json_build_object('status', sb.status)) from public.student_batches sb where sb.batch_id = b.id), '[]') as student_batches,
              coalesce((select json_agg(json_build_object('subjects', json_build_object('name', s.name))) from public.batch_subjects bs join public.subjects s on s.id = bs.subject_id where bs.batch_id = b.id), '[]') as batch_subjects
         from public.batches b left join public.classes c on c.id = b.class_id
        where b.id in (select public.my_batch_ids())
        order by b.name`,
    ),
  ),
);

batchesRouter.get(
  "/mine/:id",
  teacher,
  h(async ({ req, db }) => {
    const id = z.uuid().parse(req.params.id);
    const ok = await db.one(`select 1 where $1::uuid in (select public.my_batch_ids())`, [id]);
    if (!ok) return { batch: null, rows: [] };
    const batch = await db.one(
      `select b.name, b.class_days, b.start_time, b.end_time, b.room, ${CLASS_JSON} as classes from public.batches b left join public.classes c on c.id = b.class_id where b.id = $1`,
      [id],
    );
    const rows = await db.q(
      `select sb.id, sb.start_date, json_build_object('id', s.id, 'full_name', s.full_name, 'admission_no', s.admission_no, 'phone', s.phone) as students
         from public.student_batches sb join public.students s on s.id = sb.student_id
        where sb.batch_id = $1 and sb.status = 'active' order by sb.start_date`,
      [id],
    );
    return { batch, rows };
  }),
);
