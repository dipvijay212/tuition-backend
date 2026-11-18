import { Router } from "express";
import { z } from "zod";
import { asUser } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h } from "../lib/route.js";
import { badRequest } from "../lib/errors.js";
import { fileField, jsonField, upload } from "../lib/upload.js";
import { publicBrandingUrl, putFile, safeFileName } from "../lib/storage.js";
import { getSmtpConfig, renderTestEmail, sendEmail, smtpStatus, verifySmtpConnection } from "../email/index.js";

export const settingsRouter = Router();
settingsRouter.use(requireRole("admin"));
const optStr = z.string().trim().nullish().transform((v) => v || null);

settingsRouter.get(
  "/",
  h(async ({ db, inst }) => {
    const r = await db.one<{ institute: { logo_path: string | null } }>(
      `select (select to_jsonb(i.*) from public.institutes i where i.id = $1) as institute,
              (select to_jsonb(s.*) from public.institute_settings s where s.institute_id = $1) as settings,
              coalesce((select json_agg(to_jsonb(y.*) order by y.start_date desc) from public.academic_years y where y.institute_id = $1), '[]') as years,
              coalesce((select json_agg(to_jsonb(g.*) order by g.sort_order) from public.grading_rules g where g.institute_id = $1), '[]') as grades`,
      [inst],
    );
    // SMTP status never includes the password.
    return { ...r, logoUrl: publicBrandingUrl(r?.institute?.logo_path ?? null), smtp: smtpStatus() };
  }),
);

settingsRouter.post("/profile", upload.any(), async (req, res) => {
  const ctx = ctxOf(req);
  const v = z
    .object({
      name: z.string().trim().min(1).max(120),
      address: optStr,
      phone: optStr,
      email: optStr,
      website: optStr,
      timezone: z.string().trim().min(1).max(60),
      working_days: z.array(z.coerce.number().int().min(1).max(7)).min(1),
    })
    .parse(jsonField(req));
  try {
    new Intl.DateTimeFormat("en", { timeZone: v.timezone });
  } catch {
    throw badRequest("Unknown timezone");
  }
  const logo = fileField(req, "logo");
  let logoPath: string | null = null;
  if (logo) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(logo.mimetype)) throw badRequest("Logo must be PNG, JPG or WebP.");
    if (logo.size > 2 * 1024 * 1024) throw badRequest("Logo must be smaller than 2 MB.");
    logoPath = `${ctx.institute.id}/${safeFileName(logo.originalname)}`;
    await putFile("branding", logoPath, logo.buffer);
  }
  await asUser(ctx, async (db) => {
    await db.q(
      `update public.institutes set name = $2, address = $3, phone = $4, email = $5, website = $6, logo_path = coalesce($7, logo_path) where id = $1`,
      [ctx.institute.id, v.name, v.address, v.phone, v.email, v.website, logoPath],
    );
    await db.q(`update public.institute_settings set timezone = $2, working_days = $3 where institute_id = $1`, [ctx.institute.id, v.timezone, v.working_days]);
  });
  res.json({ message: "Institute profile saved" });
});

const POLICY_FIELDS = [
  "admission_prefix", "receipt_prefix", "default_due_day", "late_fee_enabled", "late_fee_type", "late_fee_value", "late_fee_grace_days", "receipt_footer",
  "excused_attendance_policy", "late_counts_as_present", "attendance_correction_hours", "notify_parent_on_absence", "results_require_approval",
  "allow_late_submission", "max_upload_mb", "fee_reminder_days_before", "fee_reminder_on_due", "fee_reminder_days_after", "email_enabled",
  "min_password_length", "show_birthdays",
] as const;

const policySchema = z
  .object({
    admission_prefix: z.string().regex(/^[A-Z0-9]{1,10}$/i, "Letters and numbers only").transform((s) => s.toUpperCase()),
    receipt_prefix: z.string().regex(/^[A-Z0-9]{1,10}$/i, "Letters and numbers only").transform((s) => s.toUpperCase()),
    default_due_day: z.number().int().min(1).max(28),
    late_fee_enabled: z.boolean(),
    late_fee_type: z.enum(["fixed", "percent"]),
    late_fee_value: z.number().min(0),
    late_fee_grace_days: z.number().int().min(0).max(60),
    receipt_footer: optStr,
    excused_attendance_policy: z.enum(["exclude", "count_present", "count_absent"]),
    late_counts_as_present: z.boolean(),
    attendance_correction_hours: z.number().int().min(0).max(720),
    notify_parent_on_absence: z.boolean(),
    results_require_approval: z.boolean(),
    allow_late_submission: z.boolean(),
    max_upload_mb: z.number().int().min(1).max(25),
    fee_reminder_days_before: z.array(z.number().int().min(0).max(90)),
    fee_reminder_on_due: z.boolean(),
    fee_reminder_days_after: z.array(z.number().int().min(0).max(90)),
    email_enabled: z.boolean(),
    min_password_length: z.number().int().min(8).max(64),
    show_birthdays: z.boolean(),
  })
  .partial();

/** Partial update of institute settings (policies or email preferences). Column names come from a fixed list. */
settingsRouter.patch(
  "/policies",
  h(async ({ req, db, inst }) => {
    const v = policySchema.parse(req.body);
    if (v.late_fee_type === "percent" && (v.late_fee_value ?? 0) > 100) throw badRequest("Percentage cannot exceed 100");
    const keys = POLICY_FIELDS.filter((k) => k in v);
    if (!keys.length) return { message: "Nothing to save" };
    const sets = keys.map((k, i) => k + " = $" + (i + 2)).join(", ");
    await db.q("update public.institute_settings set " + sets + " where institute_id = $1", [inst, ...keys.map((k) => v[k])]);
    return { message: "Settings saved" };
  }),
);

settingsRouter.post(
  "/academic-years",
  h(async ({ req, db, inst }) => {
    const v = z
      .object({
        id: z.string().nullish().transform((x) => x || null),
        name: z.string().trim().min(1).max(20),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        is_current: z.boolean(),
      })
      .parse(req.body);
    if (v.end_date <= v.start_date) throw badRequest("End date must be after start date");
    if (v.is_current) await db.q(`update public.academic_years set is_current = false where institute_id = $1 and is_current`, [inst]);
    const saved = v.id
      ? await db.one<{ id: string }>(
          `update public.academic_years set name = $3, start_date = $4, end_date = $5, is_current = $6 where id = $1 and institute_id = $2 returning id`,
          [v.id, inst, v.name, v.start_date, v.end_date, v.is_current],
        )
      : await db.one<{ id: string }>(
          `insert into public.academic_years (institute_id, name, start_date, end_date, is_current) values ($1, $2, $3, $4, $5) returning id`,
          [inst, v.name, v.start_date, v.end_date, v.is_current],
        );
    if (!saved) throw badRequest("Academic year not found.");
    if (v.is_current) await db.q(`update public.institute_settings set current_academic_year_id = $2 where institute_id = $1`, [inst, saved.id]);
    return { message: "Academic year saved" };
  }),
);

settingsRouter.put(
  "/grading-rules",
  h(async ({ req, db, inst }) => {
    const rows = z
      .array(z.object({ grade: z.string().trim().min(1).max(5), min: z.number().min(0).max(100), max: z.number().min(0).max(100), is_pass: z.boolean() }))
      .min(1, "Add at least one grade")
      .parse(req.body);
    const sorted = [...rows].sort((a, b) => b.min - a.min);
    for (const r of sorted) if (r.max < r.min) throw badRequest(`Grade ${r.grade}: max must be ≥ min`);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].max >= sorted[i - 1].min) throw badRequest(`Grades ${sorted[i - 1].grade} and ${sorted[i].grade} overlap`);
    if (new Set(sorted.map((r) => r.grade.toUpperCase())).size !== sorted.length) throw badRequest("Grade names must be unique");
    await db.q(`delete from public.grading_rules where institute_id = $1`, [inst]);
    await db.q(
      `insert into public.grading_rules (institute_id, grade, min_percentage, max_percentage, is_pass, sort_order)
       select $1, x.grade, x.min, x.max, x.is_pass, x.ord from jsonb_to_recordset($2::jsonb) as x(grade text, min numeric, max numeric, is_pass boolean, ord int)`,
      [inst, JSON.stringify(sorted.map((r, i) => ({ ...r, ord: i + 1 })))],
    );
    await db.q(`select public.write_audit('grading_rules_updated', 'grading_rules', $1, null, $2)`, [inst, JSON.stringify(sorted)]);
    return { message: "Grading rules saved" };
  }),
);

settingsRouter.post("/test-email", async (req, res) => {
  const ctx = ctxOf(req);
  const { email } = z.object({ email: z.email("Enter a valid email address") }).parse(req.body);
  const cfg = getSmtpConfig();
  if (!cfg.configured) throw badRequest(`SMTP is not configured in .env yet. Please configure SMTP_USER and SMTP_PASS (Host: ${cfg.host}, Port: ${cfg.port}).`);
  const conn = await verifySmtpConnection();
  if (!conn.ok) throw badRequest(`SMTP Connection test failed: ${conn.error || conn.message}`);
  const tpl = renderTestEmail({ recipientEmail: email, instituteName: ctx.institute.name });
  const r = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: ctx.institute.id });
  if (!r.ok) throw badRequest(`Failed to dispatch test email: ${r.error || "Unknown error"}`);
  res.json({ message: `Test email sent successfully to ${email}!` });
});

settingsRouter.get("/smtp", (_req, res) => {
  const s = smtpStatus();
  res.json({ ...s, user: s.user ? `${s.user.substring(0, 3)}***@${s.user.split("@")[1] || ""}` : "" });
});
