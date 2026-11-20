import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount } from "../lib/route.js";
import { badRequest, notFound } from "../lib/errors.js";
import { fileField, jsonField, upload } from "../lib/upload.js";
import { putFile, signedUrl } from "../lib/storage.js";
import { provisionAccount } from "../auth/provision.js";
import { passwordSchema } from "../lib/validation.js";
import { asSystem, asUser } from "../db/pool.js";
import { revokeInstituteSessions } from "../auth/sessions.js";
import { ctxOf } from "../middleware.js";

export const teachersRouter = Router();
const admin = requireRole("admin");

const optStr = z.string().trim().nullish().transform((v) => v || null);

teachersRouter.get(
  "/",
  admin,
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const rows = await db.q<{ total_count: number }>(
      `select t.id, t.full_name, t.phone, t.email, t.specialization, t.employment_status, t.profile_id,
              json_build_array(json_build_object('count', (select count(*) from public.teacher_batches tb where tb.teacher_id = t.id))) as teacher_batches,
              count(*) over() as total_count
         from public.teachers t
        where t.institute_id = $1 and ($2::text is null or t.full_name ilike $2 or t.phone ilike $2 or t.email ilike $2)
          and ($3::text is null or t.employment_status::text = $3)
        order by t.full_name limit $4 offset $5`,
      [inst, q ? like(q) : null, qs(req, "status") ?? null, limit, offset],
    );
    return withCount(rows);
  }),
);

teachersRouter.get(
  "/subject-options",
  requireRole("admin", "teacher"),
  h(async ({ req, db, inst }) =>
    db.q(
      `select id, name, code from public.subjects where institute_id = $1 and ($2::boolean is false or status = 'active') order by name`,
      [inst, qs(req, "all") !== "1"],
    ),
  ),
);

/** The signed-in teacher's own record. */
teachersRouter.get(
  "/me",
  requireRole("teacher"),
  h(async ({ db, inst, ctx }) =>
    db.one(
      `select full_name, phone, email, qualification, specialization, joining_date, subject_ids from public.teachers where profile_id = $1 and institute_id = $2`,
      [ctx.userId, inst],
    ),
  ),
);

teachersRouter.get(
  "/:id",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const t = await db.one<{ photo_path: string | null; subject_ids: string[] }>(`select * from public.teachers where id = $1 and institute_id = $2`, [id, inst]);
    if (!t) return { teacher: null };
    // Sequential: one connection per transaction (parallel queries on one pg client are deprecated and break in pg@9).
    const subjects = await db.q(`select id, name from public.subjects where id = any($1::uuid[]) and institute_id = $2`, [t.subject_ids ?? [], inst]);
    const batches = await db.q(
        `select tb.id, tb.start_date, tb.is_active,
                json_build_object('id', b.id, 'name', b.name, 'start_time', b.start_time, 'end_time', b.end_time, 'class_days', b.class_days,
                  'classes', case when c.id is null then null else json_build_object('name', c.name) end,
                  'student_batches', json_build_array(json_build_object('count', (select count(*) from public.student_batches sb where sb.batch_id = b.id)))) as batches
           from public.teacher_batches tb join public.batches b on b.id = tb.batch_id left join public.classes c on c.id = b.class_id
          where tb.teacher_id = $1 order by tb.is_active desc`,
        [id],
    );
    const attendance = await db.q(`select attendance_date, status, remarks from public.teacher_attendance where teacher_id = $1 order by attendance_date desc limit 10`, [id]);
    return { teacher: t, subjects, batches, attendance, photoUrl: t.photo_path ? signedUrl(t.photo_path) : null };
  }),
);

const teacherSchema = z
  .object({
    id: z.uuid().nullish(),
    full_name: z.string().trim().min(1).max(100),
    phone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
    email: z.email().nullish().transform((v) => v?.toLowerCase() || null),
    address: optStr,
    qualification: optStr,
    specialization: optStr,
    subject_ids: z.array(z.uuid()).default([]),
    joining_date: optStr,
    employment_status: z.enum(["active", "on_leave", "resigned", "terminated"]).default("active"),
    monthly_salary: z.number().nonnegative().nullable().default(null),
    account_mode: z.enum(["none", "invite", "password"]).default("none"),
    password: z.string().nullish(),
  })
  .superRefine((v, c) => {
    if (v.account_mode !== "none" && !v.email) c.addIssue({ code: "custom", path: ["email"], message: "Email is required to create a login" });
    if (v.account_mode === "password") {
      const r = passwordSchema(8).safeParse(v.password ?? "");
      if (!r.success) c.addIssue({ code: "custom", path: ["password"], message: r.error.issues[0].message });
    }
  });

teachersRouter.post("/", admin, upload.any(), async (req, res) => {
  const v = teacherSchema.parse(jsonField(req));
  const photo = fileField(req, "photo");
  if (photo && (!["image/png", "image/jpeg", "image/webp"].includes(photo.mimetype) || photo.size > 2 * 1024 * 1024)) {
    throw badRequest("Photo must be a PNG/JPG/WebP image under 2 MB.");
  }
  const ctx = ctxOf(req);
  const inst = ctx.institute.id;

  const saved = await asUser(ctx, async (db) => {
    const vals = [inst, v.full_name, v.phone, v.email, v.address, v.qualification, v.specialization, v.subject_ids, v.joining_date, v.employment_status, v.monthly_salary];
    const row = v.id
      ? await db.one<{ id: string; profile_id: string | null }>(
          `update public.teachers set full_name = $2, phone = $3, email = $4, address = $5, qualification = $6, specialization = $7,
                  subject_ids = $8, joining_date = $9, employment_status = $10, monthly_salary = $11
            where id = $12 and institute_id = $1 returning id, profile_id`,
          [...vals, v.id],
        )
      : await db.one<{ id: string; profile_id: string | null }>(
          `insert into public.teachers (institute_id, full_name, phone, email, address, qualification, specialization, subject_ids, joining_date, employment_status, monthly_salary)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id, profile_id`,
          vals,
        );
    if (!row) throw notFound("Teacher not found.");
    return row;
  });
  // Files are written outside the transaction: putFile uses its own connection for quota bookkeeping,
  // and holding one connection while waiting for another can exhaust the pool under load.
  if (photo) {
    const path = `${inst}/teachers/${saved.id}/photo-${Date.now()}.${photo.mimetype.split("/")[1]}`;
    await putFile("files", path, photo.buffer);
    await asUser(ctx, (db) => db.q(`update public.teachers set photo_path = $2 where id = $1 and institute_id = $3`, [saved.id, path, inst]));
  }

  let message = v.id ? "Teacher updated" : "Teacher added";
  if (v.account_mode !== "none" && !saved.profile_id) {
    const acc = await provisionAccount(ctx, { email: v.email!, phone: v.phone, fullName: v.full_name, role: "teacher", mode: v.account_mode, password: v.password ?? undefined });
    await asSystem((db) => db.q(`update public.teachers set profile_id = $2 where id = $1`, [saved.id, acc.userId]));
    message += acc.invited ? ". Invitation email sent." : acc.created ? ". Login created." : ". Linked to existing login.";
  }
  // Deactivating staff: suspend login too (history is kept).
  if (saved.profile_id && ["resigned", "terminated"].includes(v.employment_status)) {
    await asSystem((db) => db.q(`update public.memberships set status = 'inactive' where user_id = $1 and institute_id = $2`, [saved.profile_id, ctx.institute.id]));
    await revokeInstituteSessions(saved.profile_id, ctx.institute.id);
  }
  res.json({ message, id: saved.id });
});

teachersRouter.post(
  "/:id/attendance",
  admin,
  h(async ({ req, db, inst, ctx }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({ attendance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(["present", "absent", "late", "leave"]), remarks: optStr })
      .parse(req.body);
    const r = await db.q(
      `insert into public.teacher_attendance (institute_id, teacher_id, attendance_date, status, remarks, marked_by)
       select $1, t.id, $3, $4, $5, $6 from public.teachers t where t.id = $2 and t.institute_id = $1
       on conflict (teacher_id, attendance_date) do update set status = excluded.status, remarks = excluded.remarks, marked_by = excluded.marked_by
       returning id`,
      [inst, id, v.attendance_date, v.status, v.remarks, ctx.userId],
    );
    if (!r.length) throw notFound("Teacher not found.");
    return { message: "Attendance saved" };
  }),
);
