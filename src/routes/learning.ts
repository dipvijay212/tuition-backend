import { Router } from "express";
import { z } from "zod";
import { asSystem, asUser, type Db } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount, type Ctx } from "../lib/route.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { fileField, jsonField, upload } from "../lib/upload.js";
import { ALLOWED_UPLOADS, putFile, removeFiles, safeFileName, signedUrl, validateUpload } from "../lib/storage.js";
import { renderHomeworkAlertEmail, sendEmail } from "../email/index.js";

/** Homework and study materials (admin + teacher), plus file links for everyone. */
export const learningRouter = Router();
const staff = requireRole("admin", "teacher");
const isAdmin = (ctx: Ctx) => ctx.roles.includes("admin");
const NAMED = (alias: string) => `case when ${alias}.id is null then null else json_build_object('id', ${alias}.id, 'name', ${alias}.name) end`;

async function assertBatch(db: Db, ctx: Ctx, batchId: string) {
  const ok = isAdmin(ctx)
    ? await db.one(`select 1 from public.batches where id = $1 and institute_id = $2`, [batchId, ctx.institute.id])
    : await db.one(`select 1 where $1::uuid in (select public.my_batch_ids())`, [batchId]);
  if (!ok) throw forbidden("Choose one of your batches.");
}

/** Teacher's assigned active batches with class and subjects (for filters and dialogs). */
const MY_BATCHES_SQL = `
  select b.id, b.name, b.class_id,
         case when c.id is null then null else json_build_object('id', c.id, 'name', c.name) end as classes,
         coalesce((select json_agg(json_build_object('subjects', json_build_object('id', s.id, 'name', s.name)))
                     from public.batch_subjects bs join public.subjects s on s.id = bs.subject_id where bs.batch_id = b.id), '[]') as batch_subjects
    from public.batches b left join public.classes c on c.id = b.class_id
   where b.status = 'active' and b.id in (select public.my_batch_ids()) order by b.name`;

// ---------- Homework ----------
learningRouter.get(
  "/homework",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const admin = isAdmin(ctx);
    const rows = await db.q<{ total_count: number }>(
      `select h.id, h.title, h.description, h.assigned_date, h.due_at, h.batch_id, h.subject_id,
              json_build_object('id', b.id, 'name', b.name, 'classes', case when c.id is null then null else json_build_object('name', c.name) end) as batches,
              ${NAMED("sj")} as subjects,
              coalesce((select json_agg(json_build_object('status', hs.status)) from public.homework_submissions hs where hs.homework_id = h.id), '[]') as homework_submissions,
              count(*) over() as total_count
         from public.homework h join public.batches b on b.id = h.batch_id left join public.classes c on c.id = b.class_id left join public.subjects sj on sj.id = h.subject_id
        where h.institute_id = $1 and ($2::boolean or h.batch_id in (select public.my_batch_ids()))
          and ($3::text is null or h.title ilike $3) and ($4::uuid is null or h.batch_id = $4) and ($5::uuid is null or h.subject_id = $5)
        order by h.due_at desc limit $6 offset $7`,
      [inst, admin, q ? like(q) : null, qs(req, "batch") ?? null, qs(req, "subject") ?? null, limit, offset],
    );
    const batches = admin ? await db.q(`select id, name from public.batches where institute_id = $1 and status = 'active' order by name`, [inst]) : await db.q(MY_BATCHES_SQL);
    const subjects = admin ? await db.q(`select id, name from public.subjects where institute_id = $1 order by name`, [inst]) : [];
    return { ...withCount(rows), batches, subjects };
  }),
);

learningRouter.post("/homework", staff, async (req, res) => {
  const ctx = ctxOf(req);
  const v = z
    .object({
      batch_id: z.uuid("Please select a batch."),
      subject_id: z.string().nullish().transform((x) => x || null),
      title: z.string().trim().min(1, "Please enter a homework title."),
      description: z.string().trim().nullish().transform((x) => x || null),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Please choose a due date."),
    })
    .parse(req.body);
  await asUser(ctx, async (db) => {
    await assertBatch(db, ctx, v.batch_id);
    await db.q(
      `insert into public.homework (institute_id, batch_id, subject_id, title, description, assigned_date, due_at, is_published, submission_enabled, created_by)
       values ($1, $2, $3, $4, $5, (now() at time zone $6)::date, ($7::date + time '23:59:59') at time zone $6, true, false, $8)`,
      [ctx.institute.id, v.batch_id, v.subject_id, v.title, v.description, ctx.timezone, v.due_date, ctx.userId],
    );
  });
  res.json({ message: "Homework assigned successfully!" });

  // Assignment email to students and parents of the batch (best effort).
  void (async () => {
    const info = await asSystem((db) =>
      db.one<{ email_enabled: boolean; batch: string; subject: string | null; emails: string[] | null }>(
        `select st.email_enabled, b.name as batch, (select name from public.subjects where id = $3) as subject,
                (select array_agg(distinct e) from (
                   select s.email as e from public.student_batches sb join public.students s on s.id = sb.student_id where sb.batch_id = $2 and sb.status = 'active' and s.email is not null
                   union select g.email from public.student_batches sb join public.parent_students ps on ps.student_id = sb.student_id join public.guardians g on g.id = ps.guardian_id
                    where sb.batch_id = $2 and sb.status = 'active' and g.email is not null) x) as emails
           from public.institute_settings st, public.batches b where st.institute_id = $1 and b.id = $2`,
        [ctx.institute.id, v.batch_id, v.subject_id],
      ),
    );
    if (!info?.email_enabled || !info.emails?.length) return;
    const tpl = renderHomeworkAlertEmail({ instituteName: ctx.institute.name, batchName: info.batch, subjectName: info.subject, title: v.title, dueDate: v.due_date, description: v.description });
    await sendEmail({ to: info.emails, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: ctx.institute.id });
  })().catch((e) => console.error("[homework] email failed", e));
});

async function homeworkFor(db: Db, ctx: Ctx, id: string) {
  const hw = await db.one<{ id: string; title: string; batch_id: string; due_at: Date; batch_name: string }>(
    `select h.id, h.title, h.batch_id, h.due_at, b.name as batch_name from public.homework h join public.batches b on b.id = h.batch_id
      where h.id = $1 and h.institute_id = $2 and ($3::boolean or h.batch_id in (select public.my_batch_ids()))`,
    [id, ctx.institute.id, isAdmin(ctx)],
  );
  if (!hw) throw notFound("Homework record not found.");
  return hw;
}

learningRouter.delete(
  "/homework/:id",
  staff,
  h(async ({ req, db, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    await homeworkFor(db, ctx, id);
    await db.q(`delete from public.homework_submissions where homework_id = $1`, [id]);
    await db.q(`delete from public.homework where id = $1`, [id]);
    return { message: "Homework deleted." };
  }),
);

learningRouter.get(
  "/homework/:id/check",
  staff,
  h(async ({ req, db, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    const hw = await homeworkFor(db, ctx, id);
    const students = await db.q<{ id: string; full_name: string; admission_no: string; sub_status: string | null; feedback: string | null }>(
      `select s.id, s.full_name, s.admission_no, hs.status as sub_status, hs.feedback
         from public.student_batches sb join public.students s on s.id = sb.student_id
         left join public.homework_submissions hs on hs.homework_id = $2 and hs.student_id = s.id
        where sb.batch_id = $1 and sb.status = 'active' and s.status = 'active' order by s.full_name`,
      [hw.batch_id, id],
    );
    return {
      homeworkId: hw.id,
      title: hw.title,
      batchId: hw.batch_id,
      batchName: hw.batch_name ?? "Batch",
      dueDate: new Date(hw.due_at).toISOString().slice(0, 10),
      students: students.map((s) => ({
        id: s.id,
        full_name: s.full_name,
        admission_no: s.admission_no,
        status: s.sub_status === "resubmission_required" ? "incomplete" : s.sub_status === "pending" ? "not_done" : "complete",
        remarks: s.feedback ?? "",
      })),
    };
  }),
);

learningRouter.post(
  "/homework/:id/check",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const records = z.array(z.object({ student_id: z.uuid(), status: z.enum(["complete", "incomplete", "not_done"]), remarks: z.string().nullish() })).parse(req.body.records);
    const hw = await homeworkFor(db, ctx, id);
    const rows = records.map((r) => ({
      student_id: r.student_id,
      status: r.status === "incomplete" ? "resubmission_required" : r.status === "not_done" ? "pending" : "reviewed",
      feedback: r.remarks?.trim() || null,
    }));
    await db.q(
      `insert into public.homework_submissions (institute_id, homework_id, student_id, status, feedback, reviewed_by, reviewed_at)
       select $1, $2, x.student_id, x.status::public.submission_status, x.feedback, $3, now()
         from jsonb_to_recordset($4::jsonb) as x(student_id uuid, status text, feedback text)
        where exists (select 1 from public.student_batches sb where sb.batch_id = $5 and sb.student_id = x.student_id)
       on conflict (homework_id, student_id) do update set status = excluded.status, feedback = excluded.feedback, reviewed_by = excluded.reviewed_by, reviewed_at = excluded.reviewed_at`,
      [inst, id, ctx.userId, JSON.stringify(rows), hw.batch_id],
    );
    return { message: `Homework check saved for ${records.length} students!` };
  }),
);

// ---------- Study materials ----------
learningRouter.get(
  "/materials",
  staff,
  h(async ({ req, db, ctx, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const admin = isAdmin(ctx);
    const rows = await db.q<{ total_count: number }>(
      `select m.id, m.title, m.description, m.file_path, m.mime_type, m.size_bytes, m.visibility, m.is_active, m.created_at,
              ${NAMED("c")} as classes, ${NAMED("b")} as batches, ${NAMED("sj")} as subjects,
              case when p.id is null then null else json_build_object('full_name', p.full_name) end as profiles,
              count(*) over() as total_count
         from public.study_materials m
         left join public.classes c on c.id = m.class_id left join public.batches b on b.id = m.batch_id
         left join public.subjects sj on sj.id = m.subject_id left join public.profiles p on p.id = m.uploaded_by
        where m.institute_id = $1 and m.is_active
          and ($2::boolean or m.uploaded_by = $3 or m.batch_id in (select public.my_batch_ids()) or m.visibility in ('class', 'staff'))
          and ($4::text is null or m.title ilike $4) and ($5::uuid is null or m.class_id = $5) and ($6::uuid is null or m.batch_id = $6) and ($7::uuid is null or m.subject_id = $7)
        order by m.created_at desc limit $8 offset $9`,
      [inst, admin, ctx.userId, q ? like(q) : null, qs(req, "class") ?? null, qs(req, "batch") ?? null, qs(req, "subject") ?? null, limit, offset],
    );
    if (!admin) return { ...withCount(rows), batches: await db.q(MY_BATCHES_SQL) };
    return {
      ...withCount(rows),
      classes: await db.q(`select id, name from public.classes where institute_id = $1 and status = 'active' order by name`, [inst]),
      batches: await db.q(`select id, name, class_id from public.batches where institute_id = $1 and status = 'active' order by name`, [inst]),
      subjects: await db.q(`select id, name, class_id from public.subjects where institute_id = $1 order by name`, [inst]),
    };
  }),
);

learningRouter.post("/materials", staff, upload.any(), async (req, res) => {
  const ctx = ctxOf(req);
  const v = z
    .object({
      title: z.string().trim().min(1, "Please enter a material title."),
      description: z.string().trim().nullish().transform((x) => x || null),
      class_id: z.string().nullish().transform((x) => x || null),
      batch_id: z.string().nullish().transform((x) => x || null),
      subject_id: z.string().nullish().transform((x) => x || null),
    })
    .parse(jsonField(req));
  if (!v.class_id && !v.batch_id) throw badRequest("Please select a class or batch.");
  const file = fileField(req, "file");
  const err = validateUpload(file, 25, Object.keys(ALLOWED_UPLOADS));
  if (err) throw badRequest(err);
  const path = `${ctx.institute.id}/materials/${safeFileName(file!.originalname)}`;
  // Check access, write the file outside any transaction (putFile uses its own connection), then record it.
  await asUser(ctx, async (db) => {
    if (v.batch_id) await assertBatch(db, ctx, v.batch_id);
    else if (!isAdmin(ctx) && !(await db.one(`select 1 from public.batches where class_id = $1 and id in (select public.my_batch_ids())`, [v.class_id]))) {
      throw forbidden("Choose one of your classes.");
    }
  });
  await putFile("files", path, file!.buffer);
  await asUser(ctx, async (db) => {
    await db.q(
      `insert into public.study_materials (institute_id, title, description, class_id, batch_id, subject_id, file_path, mime_type, size_bytes, visibility, uploaded_by, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
      [ctx.institute.id, v.title, v.description, v.class_id, v.batch_id, v.subject_id, path, file!.mimetype, file!.size, v.batch_id ? "batch" : "class", ctx.userId],
    );
  });
  res.json({ message: "Study material uploaded successfully!" });
});

learningRouter.delete("/materials/:id", staff, async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const item = await asUser(ctx, async (db) => {
    const m = await db.one<{ file_path: string | null }>(
      `update public.study_materials set is_active = false
        where id = $1 and institute_id = $2 and ($3::boolean or uploaded_by = $4) returning file_path`,
      [id, ctx.institute.id, isAdmin(ctx), ctx.userId],
    );
    if (!m) throw notFound("Material not found.");
    return m;
  });
  if (item.file_path) await removeFiles("files", [item.file_path]).catch(() => {});
  res.json({ message: "Material deleted." });
});

/** Download link for a private file, after checking the caller may read it. */
learningRouter.get(
  "/files/url",
  requireRole("admin", "teacher", "student", "parent"),
  h(async ({ req, db }) => {
    const path = z.string().min(3).max(500).parse(req.query.path);
    const ok = await db.one<{ ok: boolean }>(
      `select case when split_part($1, '/', 2) = 'materials' then public.can_read_material_file($1) else public.can_read_file($1) end as ok`,
      [path],
    );
    if (!ok?.ok) throw forbidden("Unable to generate file download URL.");
    return { url: signedUrl(path, 3600) };
  }),
);
