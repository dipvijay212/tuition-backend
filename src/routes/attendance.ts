import { Router } from "express";
import { z } from "zod";
import { asSystem, asUser } from "../db/pool.js";
import type { Db } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount, type Ctx } from "../lib/route.js";
import { forbidden, notFound } from "../lib/errors.js";
import { renderAbsenceAlertEmail, sendEmail } from "../email/index.js";

export const attendanceRouter = Router();
const admin = requireRole("admin");
const staff = requireRole("admin", "teacher");

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter valid date");
const optUuid = z.string().nullish().transform((v) => v || null).pipe(z.uuid().nullable());
const optStr = z.string().trim().nullish().transform((v) => v || null);
const isAdmin = (ctx: Ctx) => ctx.roles.includes("admin");
const todaySql = `(now() at time zone $TZ)::date`;

/** Admin: any batch in the institute. Teacher: only assigned batches. */
async function assertBatchAccess(db: Db, ctx: Ctx, batchId: string) {
  const ok = isAdmin(ctx)
    ? await db.one(`select 1 from public.batches where id = $1 and institute_id = $2`, [batchId, ctx.institute.id])
    : await db.one(`select 1 where $1::uuid in (select public.my_batch_ids())`, [batchId]);
  if (!ok) throw forbidden();
}

const SESSION_SELECT = `s.id, s.batch_id, s.session_date, s.subject_id, s.teacher_id, s.attendance_submitted_at,
  b.name as batch_name, sj.name as subject_name, t.full_name as teacher_name`;
const SESSION_FROM = `public.class_sessions s join public.batches b on b.id = s.batch_id
  left join public.subjects sj on sj.id = s.subject_id left join public.teachers t on t.id = s.teacher_id`;
type SessionRow = { id: string; batch_id: string; session_date: string; attendance_submitted_at: string | null; batch_name: string; subject_name: string | null; teacher_name: string | null };

/** Session + roster of students active in the batch on that date, with any saved marks. */
async function roster(db: Db, s: SessionRow) {
  const students = await db.q<{ id: string; full_name: string; admission_no: string; status: string | null; remarks: string | null }>(
    `select st.id, st.full_name, st.admission_no, a.status, a.remarks
       from public.student_batches sb join public.students st on st.id = sb.student_id
       left join public.attendance a on a.session_id = $3 and a.student_id = st.id
      where sb.batch_id = $1 and sb.status = 'active' and sb.start_date <= $2 and (sb.end_date is null or sb.end_date >= $2) and st.status = 'active'
      order by st.full_name`,
    [s.batch_id, s.session_date, s.id],
  );
  const marked = await db.one<{ n: number }>(`select count(*)::int as n from public.attendance where session_id = $1`, [s.id]);
  return {
    sessionId: s.id,
    batchId: s.batch_id,
    batchName: s.batch_name ?? "Batch",
    sessionDate: s.session_date,
    subjectName: s.subject_name,
    teacherName: s.teacher_name,
    isAlreadyMarked: !!s.attendance_submitted_at || (marked?.n ?? 0) > 0,
    students: students.map((st) => ({ id: st.id, full_name: st.full_name, admission_no: st.admission_no, status: st.status ?? "present", remarks: st.remarks ?? "" })),
  };
}

// ---------- Sessions & marking ----------
attendanceRouter.post(
  "/prepare",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const v = z.object({ batch_id: z.uuid("Select a batch"), session_date: DATE, subject_id: optUuid }).parse(req.body);
    await assertBatchAccess(db, ctx, v.batch_id);
    let s = await db.one<SessionRow>(
      `select ${SESSION_SELECT} from ${SESSION_FROM}
        where s.institute_id = $1 and s.batch_id = $2 and s.session_date = $3 and s.status <> 'cancelled' and ($4::uuid is null or s.subject_id = $4)
        order by s.created_at desc limit 1`,
      [inst, v.batch_id, v.session_date, v.subject_id],
    );
    if (!s) {
      // Create the session from the batch defaults (time, room, assigned teacher).
      const created = await db.one<{ id: string }>(
        `insert into public.class_sessions (institute_id, batch_id, subject_id, teacher_id, session_date, start_time, end_time, room, status)
         select $1, b.id, $3, (select tb.teacher_id from public.teacher_batches tb where tb.batch_id = b.id and tb.is_active limit 1), $4,
                coalesce(b.start_time, '09:00'), coalesce(b.end_time, case when coalesce(b.start_time, '09:00') < '23:00' then '10:00'::time else '23:59'::time end), b.room, 'scheduled'
           from public.batches b where b.id = $2 returning id`,
        [inst, v.batch_id, v.subject_id, v.session_date],
      );
      s = await db.one<SessionRow>(`select ${SESSION_SELECT} from ${SESSION_FROM} where s.id = $1`, [created!.id]);
    }
    return roster(db, s!);
  }),
);

attendanceRouter.get(
  "/sessions/:id/roster",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const s = await db.one<SessionRow>(`select ${SESSION_SELECT} from ${SESSION_FROM} where s.id = $1 and s.institute_id = $2`, [id, inst]);
    if (!s) throw notFound("Class session not found");
    await assertBatchAccess(db, ctx, s.batch_id);
    return roster(db, s);
  }),
);

attendanceRouter.post(
  "/sessions",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const v = z
      .object({ batch_id: z.uuid("Select a batch"), subject_id: optUuid, teacher_id: optUuid, session_date: DATE, start_time: z.string().regex(/^\d{2}:\d{2}/), end_time: z.string().regex(/^\d{2}:\d{2}/), room: optStr })
      .parse(req.body);
    await assertBatchAccess(db, ctx, v.batch_id);
    const r = await db.one<{ id: string }>(
      `insert into public.class_sessions (institute_id, batch_id, subject_id, teacher_id, session_date, start_time, end_time, room, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'scheduled') returning id`,
      [inst, v.batch_id, v.subject_id, v.teacher_id, v.session_date, v.start_time, v.end_time, v.room],
    );
    return { message: "Class session created", sessionId: r!.id };
  }),
);

attendanceRouter.post("/sessions/:id/submit", staff, async (req, res, next) => {
  try {
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({ reason: optStr, records: z.array(z.object({ student_id: z.uuid(), status: z.enum(["present", "absent", "late", "excused"]), remarks: z.string().nullish() })) })
      .parse(req.body);
    // submit_attendance enforces teacher assignment, timing and correction rules.
    const ctx = ctxOf(req);
    await asUser(ctx, (db) => db.q(`select public.submit_attendance($1, $2, $3)`, [id, JSON.stringify(v.records), v.reason]));
    const saved = await asSystem((db) => db.one<{ n: number }>(`select count(*)::int as n from public.attendance where session_id = $1`, [id]));
    res.json({ message: `Attendance saved for ${saved?.n ?? v.records.length} students!` });
    // Absence emails (best effort, after responding).
    const absent = v.records.filter((r) => r.status === "absent").map((r) => r.student_id);
    if (absent.length) void sendAbsenceEmails(id, absent).catch((e) => console.error("[attendance] absence email failed", e));
  } catch (e) {
    next(e);
  }
});

async function sendAbsenceEmails(sessionId: string, studentIds: string[]) {
  const info = await asSystem((db) =>
    db.one<{ institute_id: string; session_date: string; batch: string | null; subject: string | null; inst_name: string | null; inst_phone: string | null; notify: boolean; email_enabled: boolean }>(
      `select s.institute_id, s.session_date, b.name as batch, sj.name as subject, i.name as inst_name, i.phone as inst_phone,
              st.notify_parent_on_absence as notify, st.email_enabled
         from public.class_sessions s join public.batches b on b.id = s.batch_id left join public.subjects sj on sj.id = s.subject_id
         join public.institutes i on i.id = s.institute_id join public.institute_settings st on st.institute_id = s.institute_id
        where s.id = $1`,
      [sessionId],
    ),
  );
  if (!info?.notify || !info.email_enabled) return;
  const students = await asSystem((db) =>
    db.q<{ full_name: string; emails: string[] | null }>(
      `select s.full_name, (select array_agg(distinct g.email) from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = s.id and g.email is not null) as emails
         from public.students s where s.id = any($1::uuid[])`,
      [studentIds],
    ),
  );
  for (const st of students) {
    if (!st.emails?.length) continue;
    const tpl = renderAbsenceAlertEmail({ instituteName: info.inst_name ?? undefined, institutePhone: info.inst_phone ?? undefined, studentName: st.full_name, batchName: info.batch ?? "Batch", subjectName: info.subject, date: info.session_date });
    await sendEmail({ to: st.emails, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: info.institute_id });
  }
}

// ---------- Admin attendance overview ----------
attendanceRouter.get(
  "/admin/classes",
  admin,
  h(async ({ req, db, inst }) => {
    const q = qs(req, "q");
    return db.q(
      `select c.id, c.name, c.description, c.sort_order, c.status,
              case when y.id is null then null else json_build_object('name', y.name) end as academic_years,
              coalesce((select json_agg(json_build_object('id', b.id, 'status', b.status)) from public.batches b where b.class_id = c.id), '[]') as batches,
              coalesce((select json_agg(json_build_object('id', s.id, 'status', s.status)) from public.students s where s.class_id = c.id), '[]') as students
         from public.classes c left join public.academic_years y on y.id = c.academic_year_id
        where c.institute_id = $1 and c.status = 'active' and ($2::text is null or c.name ilike $2)
        order by c.sort_order, c.name`,
      [inst, q ? like(q) : null],
    );
  }),
);

const ATT_JSON = `coalesce((select json_agg(json_build_object('status', a.status)) from public.attendance a where a.session_id = s.id), '[]') as attendance`;

attendanceRouter.get(
  "/admin/classes/:id",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const classId = z.uuid().parse(req.params.id);
    const { limit, offset } = paging(req);
    const today = todaySql.replace("$TZ", "$2");
    const batches = await db.q(
      `select b.id, b.class_id, b.name, b.capacity, b.room, b.status, b.class_days, b.start_time, b.end_time,
              coalesce((select json_agg(json_build_object('is_active', tb.is_active, 'teachers', json_build_object('id', t.id, 'full_name', t.full_name)))
                          from public.teacher_batches tb join public.teachers t on t.id = tb.teacher_id where tb.batch_id = b.id), '[]') as teacher_batches,
              coalesce((select json_agg(json_build_object('id', sb.id, 'status', sb.status, 'student_id', sb.student_id)) from public.student_batches sb where sb.batch_id = b.id), '[]') as student_batches
         from public.batches b where b.class_id = $1 and b.institute_id = $3 and b.status = 'active' and $2::text is not null order by b.name`,
      [classId, ctx.timezone, inst],
    );
    const subjects = await db.q(`select id, name, class_id from public.subjects where institute_id = $2 and (class_id = $1 or class_id is null) order by name`, [classId, inst]);
    const todaySessions = await db.q(
      `select s.id, s.batch_id, s.session_date, s.attendance_submitted_at, s.status, ${ATT_JSON}
         from public.class_sessions s join public.batches b on b.id = s.batch_id
        where b.class_id = $1 and b.status = 'active' and s.institute_id = $3 and s.session_date = ${today}`,
      [classId, ctx.timezone, inst],
    );
    const history = await db.q<{ total_count: number }>(
      `select s.id, s.batch_id, s.session_date, s.start_time, s.end_time, s.room, s.status, s.attendance_submitted_at,
              json_build_object('id', b.id, 'name', b.name) as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects,
              case when t.id is null then null else json_build_object('full_name', t.full_name) end as teachers,
              ${ATT_JSON}, count(*) over() as total_count
         from public.class_sessions s join public.batches b on b.id = s.batch_id
         left join public.subjects sj on sj.id = s.subject_id left join public.teachers t on t.id = s.teacher_id
        where b.class_id = $1 and b.status = 'active' and s.institute_id = $3 and s.session_date <= ${today}
          and ($4::uuid is null or s.batch_id = $4) and ($5::date is null or s.session_date = $5)
        order by s.session_date desc limit $6 offset $7`,
      [classId, ctx.timezone, inst, qs(req, "batch") ?? null, qs(req, "date") ?? null, limit, offset],
    );
    return { batches, subjects, todaySessions, history: withCount(history) };
  }),
);

// ---------- Teacher attendance overview ----------
attendanceRouter.get(
  "/teacher",
  requireRole("teacher"),
  h(async ({ req, db, ctx }) => {
    const { limit, offset } = paging(req);
    const today = todaySql.replace("$TZ", "$1");
    const batches = await db.q(
      `select b.id, b.name, b.room, b.status, b.class_days, b.start_time, b.end_time, b.capacity,
              case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end as classes,
              coalesce((select json_agg(json_build_object('status', sb.status)) from public.student_batches sb where sb.batch_id = b.id), '[]') as student_batches,
              coalesce((select json_agg(json_build_object('subjects', json_build_object('id', sj.id, 'name', sj.name))) from public.batch_subjects bs join public.subjects sj on sj.id = bs.subject_id where bs.batch_id = b.id), '[]') as batch_subjects
         from public.batches b left join public.classes c on c.id = b.class_id
        where b.status = 'active' and b.id in (select public.my_batch_ids()) and $1::text is not null order by b.name`,
      [ctx.timezone],
    );
    const todaySessions = await db.q(
      `select s.id, s.batch_id, s.session_date, s.attendance_submitted_at, s.status, ${ATT_JSON}
         from public.class_sessions s where s.batch_id in (select public.my_batch_ids()) and s.session_date = ${today}`,
      [ctx.timezone],
    );
    const history = await db.q<{ total_count: number }>(
      `select s.id, s.batch_id, s.session_date, s.start_time, s.end_time, s.room, s.status, s.attendance_submitted_at,
              json_build_object('id', b.id, 'name', b.name) as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects,
              ${ATT_JSON}, count(*) over() as total_count
         from public.class_sessions s join public.batches b on b.id = s.batch_id left join public.subjects sj on sj.id = s.subject_id
        where s.batch_id in (select public.my_batch_ids()) and s.session_date <= ${today}
          and ($2::uuid is null or s.batch_id = $2) and ($3::date is null or s.session_date = $3)
        order by s.session_date desc limit $4 offset $5`,
      [ctx.timezone, qs(req, "batch") ?? null, qs(req, "date") ?? null, limit, offset],
    );
    return { batches, todaySessions, history: withCount(history) };
  }),
);
