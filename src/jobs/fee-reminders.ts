/**
 * Daily fee job (safe to run as often as you like; every step is idempotent):
 *  1. apply_late_fees(): adds the late fee to overdue fees, only for institutes that turned late fees on.
 *  2. claim_fee_reminders(): picks the reminders due now (per each institute's reminder days, after the send hour
 *     in its timezone), records them so they are never sent twice, and creates the in-app notifications.
 *  3. Emails: one email per student listing all of that student's reminders, to the student and linked parents,
 *     when the institute has email enabled and the person hasn't turned off fee-reminder emails.
 */
import { env } from "../env.js";
import { sys } from "../db/pool.js";
import { renderFeeReminderEmail, sendEmail, type FeeReminderItem } from "../email/index.js";

type Claimed = {
  institute_id: string;
  student_id: string;
  obligation_id: string;
  kind: FeeReminderItem["kind"];
  description: string;
  due_date: string;
  balance: number;
  reminder_date: string;
};
type StudentInfo = {
  full_name: string;
  admission_no: string | null;
  institute_name: string;
  institute_code: string;
  institute_phone: string | null;
  email_enabled: boolean;
  emails: string[] | null;
};

export type FeeJobResult = { lateFees: number; reminders: number; students: number; emailsSent: number; emailsFailed: number };

const sendHour = () => {
  const h = Number(process.env.FEE_REMINDER_HOUR ?? 9);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
};

let running: Promise<FeeJobResult> | null = null;

/** Runs the job; concurrent calls in this process share one run. */
export function runFeeJob(): Promise<FeeJobResult> {
  running ??= doRun().finally(() => {
    running = null;
  });
  return running;
}

async function doRun(): Promise<FeeJobResult> {
  const late = await sys.one<{ n: number }>(`select public.apply_late_fees(null) as n`);
  const rows = await sys.q<Claimed>(`select * from public.claim_fee_reminders($1)`, [sendHour()]);

  const byStudent = new Map<string, Claimed[]>();
  for (const r of rows) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);

  let emailsSent = 0;
  let emailsFailed = 0;
  for (const [studentId, items] of byStudent) {
    try {
      const info = await sys.one<StudentInfo>(
        `select s.full_name, s.admission_no, i.name as institute_name, i.code as institute_code, i.phone as institute_phone, st.email_enabled,
                (select array_agg(distinct lower(x.email)) from (
                   select s2.email, s2.profile_id from public.students s2 where s2.id = s.id and s2.email is not null
                   union
                   select g.email, g.profile_id from public.parent_students ps join public.guardians g on g.id = ps.guardian_id
                    where ps.student_id = s.id and g.email is not null) x
                  where not exists (select 1 from public.notification_preferences np
                                     where np.user_id = x.profile_id and np.type = 'fee_reminder' and not np.email)) as emails
           from public.students s
           join public.institutes i on i.id = s.institute_id
           join public.institute_settings st on st.institute_id = s.institute_id
          where s.id = $1`,
        [studentId],
      );
      if (!info?.email_enabled || !info.emails?.length) continue;
      const tpl = renderFeeReminderEmail({
        instituteName: info.institute_name,
        institutePhone: info.institute_phone,
        studentName: info.full_name,
        admissionNo: info.admission_no,
        items: items
          .sort((a, b) => a.due_date.localeCompare(b.due_date))
          .map((i) => ({ description: i.description, dueDate: i.due_date, balance: Number(i.balance), kind: i.kind })),
        portalLink: `${env.siteUrl}/login?code=${encodeURIComponent(info.institute_code)}`,
      });
      const r = await sendEmail({ to: info.emails, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: items[0].institute_id });
      if (r.ok) emailsSent++;
      else emailsFailed++;
    } catch (e) {
      emailsFailed++;
      console.error("[fees] reminder email failed", studentId, e);
    }
  }
  const result = { lateFees: late?.n ?? 0, reminders: rows.length, students: byStudent.size, emailsSent, emailsFailed };
  if (result.lateFees || result.reminders) console.log("[fees] daily job", result);
  return result;
}

/** Starts the in-process schedule (every 30 minutes, first run shortly after start). Disable with JOBS_DISABLED=true. */
export function scheduleFeeJob() {
  if (process.env.JOBS_DISABLED === "true") return;
  const tick = () => void runFeeJob().catch((e) => console.error("[fees] daily job failed", e));
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}
