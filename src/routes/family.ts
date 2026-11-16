import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h } from "../lib/route.js";
import { notFound } from "../lib/errors.js";
import { signedUrl } from "../lib/storage.js";

/**
 * Parent & student portal reads. Everything is scoped with my_student_ids() /
 * my_student_batch_ids(): the students the caller is (student) or is linked to (parent).
 */
export const familyRouter = Router();
familyRouter.use(requireRole("parent", "student"));

const MINE = `(select public.my_student_ids())`;
const MY_BATCHES = `(select public.my_student_batch_ids())`;

familyRouter.get(
  "/children",
  h(async ({ db }) =>
    db.q(
      `select s.id, s.full_name, s.admission_no, s.status, s.class_id,
              case when c.id is null then null else json_build_object('name', c.name) end as classes,
              coalesce((select json_agg(json_build_object('batch_id', sb.batch_id, 'status', sb.status)) from public.student_batches sb where sb.student_id = s.id), '[]') as student_batches
         from public.students s left join public.classes c on c.id = s.class_id
        where s.id in ${MINE} order by s.full_name`,
    ),
  ),
);

/** The student record linked to the signed-in student login. */
familyRouter.get(
  "/me",
  h(async ({ db, ctx }) =>
    db.one(
      `select s.id, s.class_id,
              coalesce((select json_agg(json_build_object('batch_id', sb.batch_id, 'status', sb.status)) from public.student_batches sb where sb.student_id = s.id), '[]') as student_batches
         from public.students s where s.profile_id = $1 and s.institute_id = $2 limit 1`,
      [ctx.userId, ctx.institute.id],
    ),
  ),
);

async function assertCanView(db: { one: (s: string, p: unknown[]) => Promise<unknown> }, id: string) {
  if (!(await db.one(`select 1 where $1::uuid in ${MINE}`, [id]))) throw notFound("Student not found.");
}

familyRouter.get(
  "/students/:id/dashboard",
  h(async ({ req, db, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    await assertCanView(db, id);
    const d = await db.one<{ d: unknown }>(`select public.family_dashboard($1) as d`, [id]);
    const notes = await db.q(`select id, title, body, created_at from public.notifications where user_id = $1 order by created_at desc limit 5`, [ctx.userId]);
    return { dashboard: d?.d, notes };
  }),
);

familyRouter.get(
  "/students/:id/details",
  h(async ({ req, db }) => {
    const id = z.uuid().parse(req.params.id);
    await assertCanView(db, id);
    return db.one(
      `select (select json_build_object('full_name', s.full_name, 'admission_no', s.admission_no, 'date_of_birth', s.date_of_birth, 'gender', s.gender, 'blood_group', s.blood_group,
                 'school_name', s.school_name, 'admission_date', s.admission_date, 'address', s.address, 'city', s.city, 'status', s.status,
                 'classes', (select json_build_object('name', c.name) from public.classes c where c.id = s.class_id),
                 'academic_years', (select json_build_object('name', y.name) from public.academic_years y where y.id = s.academic_year_id))
                 from public.students s where s.id = $1) as s,
              coalesce((select json_agg(json_build_object('id', sb.id, 'start_date', sb.start_date, 'status', sb.status, 'batches', json_build_object('name', b.name)))
                 from public.student_batches sb join public.batches b on b.id = sb.batch_id where sb.student_id = $1 and sb.status = 'active'), '[]') as batches,
              coalesce((select json_agg(json_build_object('id', ps.id, 'relationship', ps.relationship, 'guardians', json_build_object('full_name', g.full_name, 'phone', g.phone)))
                 from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = $1), '[]') as parents`,
      [id],
    );
  }),
);

familyRouter.get(
  "/attendance",
  h(async ({ db }) =>
    db.q(
      `select a.id, a.session_date, a.status, a.remarks, json_build_object('full_name', s.full_name) as students,
              case when b.id is null then null else json_build_object('name', b.name) end as batches
         from public.attendance a join public.students s on s.id = a.student_id left join public.batches b on b.id = a.batch_id
        where a.student_id in ${MINE} order by a.session_date desc`,
    ),
  ),
);

familyRouter.get(
  "/fees",
  h(async ({ db }) => {
    const obligations = await db.q(
      `select o.id, o.installment_no, o.category, o.description, o.due_date, o.gross_amount, o.discount_amount, o.net_amount, o.amount_paid, o.status,
              json_build_object('full_name', s.full_name) as students
         from public.fee_obligations o join public.students s on s.id = o.student_id
        where o.student_id in ${MINE} order by o.due_date`,
    );
    const payments = await db.q(
      `select p.id, p.amount, p.payment_date, p.method, p.reference, p.status,
              json_build_object('full_name', s.full_name, 'admission_no', s.admission_no) as students,
              (select json_build_object('receipt_no', r.receipt_no) from public.receipts r where r.payment_id = p.id limit 1) as receipts
         from public.payments p join public.students s on s.id = p.student_id
        where p.student_id in ${MINE} order by p.payment_date desc`,
    );
    return { obligations, payments };
  }),
);

familyRouter.get(
  "/results",
  h(async ({ db }) =>
    db.q(
      `select r.id, r.total_obtained, r.total_max, r.percentage, r.grade, r.is_pass, r.rank, r.subject_breakdown, r.published_at,
              json_build_object('name', e.name, 'start_date', e.start_date, 'end_date', e.end_date) as examinations,
              json_build_object('full_name', s.full_name) as students
         from public.published_results r join public.examinations e on e.id = r.examination_id join public.students s on s.id = r.student_id
        where r.student_id in ${MINE} order by r.published_at desc`,
    ),
  ),
);

familyRouter.get(
  "/timetable",
  h(async ({ db }) =>
    db.q(
      `select t.id, t.day_of_week, t.start_time, t.end_time, t.room,
              json_build_object('name', b.name) as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects,
              case when te.id is null then null else json_build_object('full_name', te.full_name) end as teachers
         from public.timetable t join public.batches b on b.id = t.batch_id
         left join public.subjects sj on sj.id = t.subject_id left join public.teachers te on te.id = t.teacher_id
        where t.is_active and t.batch_id in ${MY_BATCHES} order by t.day_of_week, t.start_time`,
    ),
  ),
);

familyRouter.get(
  "/homework",
  h(async ({ db }) =>
    db.q(
      `select h.id, h.title, h.description, h.assigned_date, h.due_at, h.batch_id,
              json_build_object('name', b.name) as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects,
              coalesce((select json_agg(json_build_object('student_id', hs.student_id, 'status', hs.status, 'feedback', hs.feedback))
                          from public.homework_submissions hs where hs.homework_id = h.id and hs.student_id in ${MINE}), '[]') as homework_submissions
         from public.homework h join public.batches b on b.id = h.batch_id left join public.subjects sj on sj.id = h.subject_id
        where h.is_published and h.batch_id in ${MY_BATCHES} order by h.due_at desc`,
    ),
  ),
);

/** Study materials visible to the family (same rules as the old family_select policy). */
familyRouter.get(
  "/materials",
  h(async ({ db }) => {
    const rows = await db.q<{ file_path: string }>(
      `select m.id, m.title, m.description, m.file_path, m.mime_type, m.size_bytes, m.created_at,
              case when c.id is null then null else json_build_object('name', c.name) end as classes,
              case when b.id is null then null else json_build_object('name', b.name) end as batches,
              case when sj.id is null then null else json_build_object('name', sj.name) end as subjects
         from public.study_materials m
         left join public.classes c on c.id = m.class_id left join public.batches b on b.id = m.batch_id left join public.subjects sj on sj.id = m.subject_id
        where m.is_active and m.visibility <> 'staff' and (
              m.batch_id in ${MY_BATCHES}
              or (m.visibility = 'class' and m.batch_id is null and m.class_id in (select s.class_id from public.students s where s.id in ${MINE})))
        order by m.created_at desc`,
    );
    return rows.map((r) => ({ ...r, url: r.file_path ? signedUrl(r.file_path) : null }));
  }),
);
