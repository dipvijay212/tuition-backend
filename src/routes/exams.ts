import { Router } from "express";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import { requireRole } from "../middleware.js";
import { h, paging, qs, withCount, type Ctx } from "../lib/route.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

export const examsRouter = Router();
const admin = requireRole("admin");
const staff = requireRole("admin", "teacher");
const isAdmin = (ctx: Ctx) => ctx.roles.includes("admin");
const optUuid = z.string().nullish().transform((v) => v || null).pipe(z.uuid().nullable());
const optStr = z.string().trim().nullish().transform((v) => v || null);
const STATUSES = ["draft", "scheduled", "marks_entry", "pending_approval", "published", "cancelled"] as const;
const TEACHER_STATUSES = ["draft", "scheduled", "marks_entry", "pending_approval"];
const NAMED = (alias: string, col = "name") => `case when ${alias}.id is null then null else json_build_object('${col}', ${alias}.${col}) end`;

/** Exam the caller may manage: admin -> any in institute; teacher -> exams of assigned batches. */
async function examFor(db: Db, ctx: Ctx, id: string) {
  const e = await db.one<{ id: string; status: string; batch_id: string | null; class_id: string | null }>(
    `select id, status, batch_id, class_id from public.examinations
      where id = $1 and institute_id = $2 and ($3::boolean or batch_id in (select public.my_batch_ids()))`,
    [id, ctx.institute.id, isAdmin(ctx)],
  );
  if (!e) throw notFound("Examination not found.");
  return e;
}

// ---------- Reads ----------
examsRouter.get(
  "/",
  admin,
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const rows = await db.q<{ total_count: number }>(
      `select e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status, ${NAMED("c")} as classes, ${NAMED("b")} as batches, count(*) over() as total_count
         from public.examinations e left join public.classes c on c.id = e.class_id left join public.batches b on b.id = e.batch_id
        where e.institute_id = $1 and ($2::text is null or e.status::text = $2)
        order by e.start_date desc limit $3 offset $4`,
      [inst, qs(req, "status") ?? null, limit, offset],
    );
    const classes = await db.q(`select id, name from public.classes where institute_id = $1 order by name`, [inst]);
    const batches = await db.q(`select id, name from public.batches where institute_id = $1 and status = 'active' order by name`, [inst]);
    return { ...withCount(rows), classes, batches };
  }),
);

examsRouter.get(
  "/mine",
  requireRole("teacher"),
  h(async ({ db }) =>
    db.q(
      `select e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status, ${NAMED("b")} as batches
         from public.examinations e left join public.batches b on b.id = e.batch_id
        where e.batch_id in (select public.my_batch_ids()) order by e.start_date desc`,
    ),
  ),
);

examsRouter.get(
  "/results",
  staff,
  h(async ({ req, db, inst, ctx }) => {
    const { limit, offset } = paging(req, isAdmin(ctx) ? 20 : 500);
    const rows = await db.q<{ total_count: number }>(
      `select r.id, r.total_obtained, r.total_max, r.percentage, r.grade, r.is_pass, r.rank,
              json_build_object('id', e.id, 'name', e.name) as examinations,
              json_build_object('id', s.id, 'full_name', s.full_name, 'admission_no', s.admission_no) as students,
              count(*) over() as total_count
         from public.published_results r join public.examinations e on e.id = r.examination_id join public.students s on s.id = r.student_id
        where r.institute_id = $1 and ($2::uuid is null or r.examination_id = $2)
          and ($3::boolean or public.teacher_can_access_student(r.student_id))
        order by r.rank asc nulls last, r.percentage desc limit $4 offset $5`,
      [inst, qs(req, "exam") ?? null, isAdmin(ctx), limit, offset],
    );
    const exams = isAdmin(ctx) ? await db.q(`select id, name from public.examinations where institute_id = $1 order by name`, [inst]) : [];
    return { ...withCount(rows), exams };
  }),
);

examsRouter.get(
  "/:id",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const ok = await db.one(`select 1 from public.examinations where id = $1 and institute_id = $2 and ($3::boolean or batch_id in (select public.my_batch_ids()))`, [id, inst, isAdmin(ctx)]);
    if (!ok) return { exam: null };
    const exam = await db.one<{ batch_id: string | null; class_id: string | null }>(
      `select e.id, e.name, e.exam_type, e.start_date, e.end_date, e.status, e.result_publish_date, e.class_id, e.batch_id, ${NAMED("c")} as classes, ${NAMED("b")} as batches
         from public.examinations e left join public.classes c on c.id = e.class_id left join public.batches b on b.id = e.batch_id where e.id = $1`,
      [id],
    );
    const examSubjects = await db.q(
      `select es.id, es.subject_id, es.exam_date, es.max_marks, es.passing_marks, json_build_object('id', s.id, 'name', s.name) as subjects
         from public.examination_subjects es join public.subjects s on s.id = es.subject_id where es.examination_id = $1`,
      [id],
    );
    const allSubjects = await db.q(`select id, name from public.subjects where institute_id = $1 order by name`, [inst]);
    const marks = await db.q(
      `select m.examination_subject_id, m.student_id, m.obtained_marks, m.is_absent, m.remarks
         from public.marks m join public.examination_subjects es on es.id = m.examination_subject_id where es.examination_id = $1`,
      [id],
    );
    // Eligible students: active enrolments in the exam's batch, else active students of its class.
    const students = exam!.batch_id
      ? await db.q(
          `select distinct s.id, s.full_name, s.admission_no from public.student_batches sb join public.students s on s.id = sb.student_id
            where sb.batch_id = $1 and sb.status = 'active' and s.status = 'active' order by s.full_name`,
          [exam!.batch_id],
        )
      : exam!.class_id
        ? await db.q(`select id, full_name, admission_no from public.students where institute_id = $1 and status = 'active' and class_id = $2 order by full_name`, [inst, exam!.class_id])
        : [];
    return { exam, examSubjects, allSubjects, marks, students };
  }),
);

// ---------- Writes ----------
examsRouter.post(
  "/",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const v = z
      .object({
        id: optUuid, name: z.string().trim().min(1).max(120),
        exam_type: z.enum(["unit_test", "weekly_test", "monthly_test", "half_yearly", "final", "practice"]),
        class_id: optUuid, batch_id: optUuid,
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        result_publish_date: optStr, status: z.enum(STATUSES).default("scheduled"),
      })
      .parse(req.body);
    if (v.end_date < v.start_date) throw badRequest("End date must be on or after start date");
    if (!v.class_id && !v.batch_id) throw badRequest("Select either a class or a batch");
    if (!isAdmin(ctx)) {
      // Teachers: own batches only, and they cannot publish.
      if (!v.batch_id || !(await db.one(`select 1 where $1::uuid in (select public.my_batch_ids())`, [v.batch_id]))) throw forbidden("Choose one of your batches.");
      if (!["draft", "scheduled"].includes(v.status)) throw forbidden();
      if (v.id) await examFor(db, ctx, v.id);
    }
    if (v.status === "published") throw badRequest("Use Publish to publish results.");
    const vals = [inst, v.name, v.exam_type, v.class_id, v.batch_id, v.start_date, v.end_date, v.result_publish_date, v.status, ctx.userId];
    const saved = v.id
      ? await db.one<{ id: string }>(
          `update public.examinations set name = $2, exam_type = $3, class_id = $4, batch_id = $5, start_date = $6, end_date = $7, result_publish_date = $8, status = $9
            where id = $11 and institute_id = $1 and status <> 'published' and $10::uuid is not null returning id`,
          [...vals, v.id],
        )
      : await db.one<{ id: string }>(
          `insert into public.examinations (institute_id, name, exam_type, class_id, batch_id, start_date, end_date, result_publish_date, status, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          vals,
        );
    if (!saved) throw notFound("Examination not found or already published.");
    return { message: "Examination saved", id: saved.id };
  }),
);

examsRouter.post(
  "/:id/subjects",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z.object({ subject_id: z.uuid(), exam_date: optStr, max_marks: z.number().positive(), passing_marks: z.number().min(0) }).parse(req.body);
    if (v.passing_marks > v.max_marks) throw badRequest("Passing marks cannot exceed maximum marks");
    const e = await examFor(db, ctx, id);
    if (e.status === "published") throw badRequest("This examination is already published.");
    await db.q(
      `insert into public.examination_subjects (institute_id, examination_id, subject_id, exam_date, max_marks, passing_marks)
       select $1, $2, s.id, $4, $5, $6 from public.subjects s where s.id = $3 and s.institute_id = $1
       on conflict (examination_id, subject_id) do update set exam_date = excluded.exam_date, max_marks = excluded.max_marks, passing_marks = excluded.passing_marks`,
      [inst, id, v.subject_id, v.exam_date, v.max_marks, v.passing_marks],
    );
    return { message: "Subject added to examination" };
  }),
);

examsRouter.post(
  "/:id/marks",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({
        examination_subject_id: z.uuid(),
        entries: z.array(z.object({ student_id: z.uuid(), obtained_marks: z.number().nullish(), is_absent: z.boolean(), remarks: z.string().nullish() })),
      })
      .parse(req.body);
    await examFor(db, ctx, id);
    if (!(await db.one(`select 1 from public.examination_subjects where id = $1 and examination_id = $2`, [v.examination_subject_id, id]))) throw notFound("Subject not found.");
    if (!isAdmin(ctx)) {
      const bad = await db.one(`select 1 from unnest($1::uuid[]) x where not public.teacher_can_access_student(x) limit 1`, [v.entries.map((e) => e.student_id)]);
      if (bad) throw forbidden("You can only enter marks for students in your batches.");
    }
    // Triggers validate max marks and block edits once results are published.
    await db.q(
      `insert into public.marks (institute_id, examination_subject_id, student_id, obtained_marks, is_absent, remarks, entered_by)
       select $1, $2, x.student_id, case when x.is_absent then null else coalesce(x.obtained_marks, 0) end, x.is_absent, nullif(x.remarks, ''), $3
         from jsonb_to_recordset($4::jsonb) as x(student_id uuid, obtained_marks numeric, is_absent boolean, remarks text)
       on conflict (examination_subject_id, student_id) do update
         set obtained_marks = excluded.obtained_marks, is_absent = excluded.is_absent, remarks = excluded.remarks, entered_by = excluded.entered_by`,
      [inst, v.examination_subject_id, ctx.userId, JSON.stringify(v.entries)],
    );
    return { message: "Marks saved successfully" };
  }),
);

examsRouter.post(
  "/:id/status",
  staff,
  h(async ({ req, db, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
    const e = await examFor(db, ctx, id);
    if (status === "published") throw badRequest("Use Publish to publish results.");
    if (!isAdmin(ctx) && (!TEACHER_STATUSES.includes(status) || e.status === "published")) throw forbidden();
    await db.q(`update public.examinations set status = $2 where id = $1`, [id, status]);
    return { message: `Exam status changed to ${status}` };
  }),
);

examsRouter.post(
  "/:id/publish",
  admin,
  h(async ({ req, db }) => {
    const id = z.uuid().parse(req.params.id);
    const { reason } = z.object({ reason: optStr }).parse(req.body);
    const r = await db.one<{ n: number }>(`select public.publish_examination($1, $2) as n`, [id, reason]);
    return { message: `Exam published! ${r?.n ?? 0} results computed.` };
  }),
);
