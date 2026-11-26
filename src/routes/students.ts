import { Router } from "express";
import { z } from "zod";
import { asSystem, asUser } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount } from "../lib/route.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { fileField, jsonField, upload } from "../lib/upload.js";
import { putFile, safeFileName, signedUrl, validateUpload } from "../lib/storage.js";
import { provisionAccount, sendInvitation } from "../auth/provision.js";
import { renderAdmissionWelcomeEmail, sendEmail } from "../email/index.js";

export const studentsRouter = Router();
const admin = requireRole("admin");
const staffOrFamily = requireRole("admin", "teacher", "student", "parent");
const optStr = z.string().trim().nullish().transform((v) => v || null);

// ---------- Performance & Progress Reporting ----------
studentsRouter.get(
  "/:id/performance",
  staffOrFamily,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const ok = await db.one<{ allowed: boolean }>(
      `select public.can_view_student($1) as allowed`,
      [id],
    );
    if (!ok?.allowed) throw forbidden("You are not authorized to view this student's performance.");

    const s = await db.one<{
      id: string;
      full_name: string;
      admission_no: string;
      status: string;
      class_id: string | null;
      class_name: string | null;
      photo_path: string | null;
      institute_name: string;
      batches: Array<{ id: string; name: string }>;
    }>(
      `select s.id, s.full_name, s.admission_no, s.status, s.class_id, s.photo_path,
              c.name as class_name,
              (select i.name from public.institutes i where i.id = s.institute_id) as institute_name,
              coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name))
                          from public.student_batches sb join public.batches b on b.id = sb.batch_id
                         where sb.student_id = s.id and sb.status = 'active'), '[]') as batches
         from public.students s
         left join public.classes c on c.id = s.class_id
        where s.id = $1 and s.institute_id = $2`,
      [id, inst],
    );
    if (!s) throw notFound("Student not found.");

    // Published results chronologically
    type ExamRow = {
      id: string;
      examination_id: string;
      total_obtained: string | number;
      total_max: string | number;
      percentage: string | number;
      grade: string | null;
      is_pass: boolean;
      rank: number | null;
      subject_breakdown: Array<{
        subject_id?: string;
        subject?: string;
        max?: number;
        passing?: number;
        obtained?: number | null;
        pass?: boolean;
        is_pass?: boolean;
        absent?: boolean;
        is_absent?: boolean;
      }>;
      published_at: string;
      exam_name: string;
      exam_type: string;
      start_date: string;
      end_date: string;
      batch_id: string | null;
      batch_average: string | number | null;
      batch_highest: string | number | null;
      total_students_in_exam: number;
    };

    const rawResults = await db.q<ExamRow>(
      `select r.id, r.examination_id, r.total_obtained, r.total_max, r.percentage, r.grade, r.is_pass, r.rank,
              r.subject_breakdown, r.published_at,
              e.name as exam_name, e.exam_type, e.start_date, e.end_date, e.batch_id,
              (select round(avg(pr.percentage)::numeric, 1) from public.published_results pr where pr.examination_id = r.examination_id) as batch_average,
              (select max(pr.percentage) from public.published_results pr where pr.examination_id = r.examination_id) as batch_highest,
              (select count(*) from public.published_results pr where pr.examination_id = r.examination_id) as total_students_in_exam
         from public.published_results r
         join public.examinations e on e.id = r.examination_id
        where r.student_id = $1 and r.institute_id = $2
        order by e.start_date asc, r.published_at asc`,
      [id, inst],
    );

    // Attendance summary & monthly history
    const attSummary = await db.one<{
      total_sessions: number;
      attended: number;
      absent: number;
      late: number;
      excused: number;
      percentage: number | null;
    }>(
      `with a as (
         select status from public.attendance where student_id = $1
       ), c as (
         select count(*) filter (where status = 'present')::int as attended,
                count(*) filter (where status = 'absent')::int as absent,
                count(*) filter (where status = 'late')::int as late,
                count(*) filter (where status = 'excused')::int as excused,
                count(*)::int as total_sessions
           from a
       )
       select total_sessions, attended, absent, late, excused,
              round(100.0 * (attended + late) / nullif(total_sessions - excused, 0), 1) as percentage
         from c`,
      [id],
    );

    const monthlyAttendance = await db.q<{
      month: string;
      attended: number;
      total: number;
      pct: number | null;
    }>(
      `select to_char(session_date, 'YYYY-MM') as month,
              count(*) filter (where status in ('present', 'late')) as attended,
              count(*) filter (where status != 'excused') as total,
              round(100.0 * count(*) filter (where status in ('present', 'late')) / nullif(count(*) filter (where status != 'excused'), 0), 1) as pct
         from public.attendance
        where student_id = $1
        group by to_char(session_date, 'YYYY-MM')
        order by month asc`,
      [id],
    );

    // Per-session attendance, to attribute attendance to the period leading up to each exam.
    const sessions = await db.q<{ session_date: string; status: string }>(
      `select session_date::text as session_date, status::text as status
         from public.attendance where student_id = $1 order by session_date`,
      [id],
    );
    const attendanceBetween = (after: string | null, upTo: string) => {
      let attended = 0;
      let counted = 0;
      for (const a of sessions) {
        if ((after !== null && a.session_date <= after) || a.session_date > upTo) continue;
        if (a.status === "excused") continue;
        counted++;
        if (a.status === "present" || a.status === "late") attended++;
      }
      return counted > 0 ? { pct: Math.round((1000 * attended) / counted) / 10, sessions: counted } : null;
    };

    // Compute progression & deltas
    const timeline = rawResults.map((r, i) => {
      const prev = i > 0 ? rawResults[i - 1] : null;
      const att = attendanceBetween(prev ? String(prev.start_date).slice(0, 10) : null, String(r.start_date).slice(0, 10));
      const currentPct = Number(r.percentage);
      const prevPct = prev ? Number(prev.percentage) : null;
      const currentObt = Number(r.total_obtained);
      const prevObt = prev ? Number(prev.total_obtained) : null;
      const pctDelta = prevPct !== null ? Math.round((currentPct - prevPct) * 100) / 100 : null;
      const marksDelta = prevObt !== null ? Math.round((currentObt - prevObt) * 100) / 100 : null;
      const rankDelta = (prev?.rank && r.rank) ? (Number(prev.rank) - Number(r.rank)) : null;
      const batchAvg = r.batch_average !== null ? Number(r.batch_average) : null;
      const batchDiff = batchAvg !== null ? Math.round((currentPct - batchAvg) * 100) / 100 : null;

      const rawSubjects = Array.isArray(r.subject_breakdown) ? r.subject_breakdown : [];
      const subjects = rawSubjects.map((sb) => {
        const max = Number(sb.max ?? 100);
        const obt = sb.obtained !== null && sb.obtained !== undefined ? Number(sb.obtained) : null;
        const pass = Boolean(sb.pass ?? sb.is_pass ?? false);
        const absent = Boolean(sb.absent ?? sb.is_absent ?? false);
        const pct = (obt !== null && max > 0) ? Math.round((obt / max) * 1000) / 10 : 0;
        return {
          subject_id: sb.subject_id ?? "",
          subject: sb.subject ?? "Subject",
          max,
          passing: Number(sb.passing ?? 0),
          obtained: obt,
          percentage: pct,
          is_pass: pass,
          is_absent: absent,
        };
      });

      return {
        id: r.id,
        examination_id: r.examination_id,
        exam_name: r.exam_name,
        exam_type: r.exam_type,
        start_date: r.start_date,
        end_date: r.end_date,
        total_obtained: currentObt,
        total_max: Number(r.total_max),
        percentage: currentPct,
        grade: r.grade,
        rank: r.rank ? Number(r.rank) : null,
        is_pass: r.is_pass,
        percentage_delta: pctDelta,
        marks_delta: marksDelta,
        rank_delta: rankDelta,
        batch_average: batchAvg,
        batch_highest: r.batch_highest !== null ? Number(r.batch_highest) : null,
        batch_difference: batchDiff,
        total_students_in_exam: Number(r.total_students_in_exam ?? 0),
        attendance_pct: att?.pct ?? null,
        attendance_sessions: att?.sessions ?? 0,
        subjects,
      };
    });

    // Subject trends over time
    const subjectMap = new Map<string, {
      subject_id: string;
      subject_name: string;
      history: Array<{ exam_name: string; date: string; percentage: number; obtained: number | null; max: number; is_pass: boolean }>;
    }>();

    for (const t of timeline) {
      for (const sub of t.subjects) {
        if (!sub.is_absent && sub.obtained !== null) {
          const key = sub.subject_id || sub.subject;
          if (!subjectMap.has(key)) {
            subjectMap.set(key, {
              subject_id: sub.subject_id,
              subject_name: sub.subject,
              history: [],
            });
          }
          const entry = subjectMap.get(key)!;
          entry.subject_name = sub.subject; // timeline is chronological: keep the latest name
          entry.history.push({
            exam_name: t.exam_name,
            date: t.start_date,
            percentage: sub.percentage,
            obtained: sub.obtained,
            max: sub.max,
            is_pass: sub.is_pass,
          });
        }
      }
    }

    const subjectTrends = Array.from(subjectMap.values()).map((entry) => {
      const h = entry.history;
      const count = h.length;
      const currentPct = count > 0 ? h[count - 1].percentage : 0;
      const prevPct = count > 1 ? h[count - 2].percentage : null;
      const delta = prevPct !== null ? Math.round((currentPct - prevPct) * 10) / 10 : null;
      const avgPct = count > 0 ? Math.round((h.reduce((sum, item) => sum + item.percentage, 0) / count) * 10) / 10 : 0;
      const hasFailed = h.some((item) => !item.is_pass);

      let status: "strength" | "neutral" | "needs_attention" = "neutral";
      if (currentPct >= 80 || (avgPct >= 75 && (delta ?? 0) >= 0)) {
        status = "strength";
      } else if (currentPct < 45 || hasFailed || (delta !== null && delta <= -8)) {
        status = "needs_attention";
      }

      return {
        subject_id: entry.subject_id,
        subject_name: entry.subject_name,
        history: h,
        current_percentage: currentPct,
        average_percentage: avgPct,
        delta,
        status,
        first_percentage: count > 0 ? h[0].percentage : 0,
        best_percentage: count > 0 ? Math.max(...h.map((x) => x.percentage)) : 0,
        change_since_first: count > 1 ? Math.round((currentPct - h[0].percentage) * 10) / 10 : null,
      };
    });

    // Sort subjects: needs_attention first, then strength, then neutral
    subjectTrends.sort((a, b) => {
      const order = { needs_attention: 0, strength: 1, neutral: 2 };
      return order[a.status] - order[b.status];
    });

    // Summary calculation
    const totalExams = timeline.length;
    const latest = totalExams > 0 ? timeline[totalExams - 1] : null;
    const first = totalExams > 0 ? timeline[0] : null;
    const prev = totalExams > 1 ? timeline[totalExams - 2] : null;
    const percentages = timeline.map((t) => t.percentage);
    const avgPercentage = totalExams > 0
      ? Math.round((percentages.reduce((a, b) => a + b, 0) / totalExams) * 10) / 10
      : 0;
    const highestPercentage = totalExams > 0 ? Math.max(...percentages) : 0;
    const lowestPercentage = totalExams > 0 ? Math.min(...percentages) : 0;
    const latestDelta = latest?.percentage_delta ?? null;
    const netImprovement = (latest && first)
      ? Math.round((latest.percentage - first.percentage) * 100) / 100
      : 0;

    // Trend over a rolling window, so one off-day doesn't flip the verdict:
    // average of the last k exams vs the k before (k = up to 3).
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const trendWindow = Math.min(3, Math.floor(totalExams / 2));
    const recentAverage = trendWindow > 0 ? round1(mean(percentages.slice(-trendWindow))) : null;
    const priorAverage = trendWindow > 0 ? round1(mean(percentages.slice(-2 * trendWindow, -trendWindow))) : null;
    const trendDelta = recentAverage !== null && priorAverage !== null ? round1(recentAverage - priorAverage) : null;

    let overallTrend: "improving" | "declining" | "steady" = "steady";
    if (trendDelta !== null) {
      if (trendDelta >= 2) overallTrend = "improving";
      else if (trendDelta <= -2) overallTrend = "declining";
    }
    // A notable drop in the latest exam that the longer trend doesn't (yet) confirm.
    const latestDip = latestDelta !== null && latestDelta <= -3 && overallTrend !== "declining";

    const bestIdx = totalExams > 0 ? percentages.indexOf(highestPercentage) : -1;

    const passedExams = timeline.filter((t) => t.is_pass).length;
    const passRate = totalExams > 0 ? Math.round((passedExams / totalExams) * 1000) / 10 : 0;

    const summary = {
      total_exams: totalExams,
      passed_exams: passedExams,
      pass_rate: passRate,
      current_percentage: latest?.percentage ?? 0,
      previous_percentage: prev?.percentage ?? null,
      average_percentage: avgPercentage,
      highest_percentage: highestPercentage,
      lowest_percentage: lowestPercentage,
      latest_delta: latestDelta,
      net_improvement: netImprovement,
      trend: overallTrend,
      trend_delta: trendDelta,
      trend_window: trendWindow,
      recent_average: recentAverage,
      prior_average: priorAverage,
      latest_dip: latestDip,
      first_percentage: first?.percentage ?? null,
      first_exam_name: first?.exam_name ?? null,
      best_exam_name: bestIdx >= 0 ? timeline[bestIdx].exam_name : null,
      latest_exam_name: latest?.exam_name ?? null,
      current_rank_out_of: latest?.total_students_in_exam ?? null,
      current_rank: latest?.rank ?? null,
      rank_delta: latest?.rank_delta ?? null,
      attendance_percentage: attSummary?.percentage ?? null,
      attended_sessions: attSummary?.attended ?? 0,
      total_sessions: attSummary?.total_sessions ?? 0,
    };

    return {
      student: {
        id: s.id,
        full_name: s.full_name,
        admission_no: s.admission_no,
        status: s.status,
        class_name: s.class_name,
        institute_name: s.institute_name,
        batches: s.batches,
        photo_url: s.photo_path ? signedUrl(s.photo_path) : null,
      },
      summary,
      timeline,
      subject_trends: subjectTrends,
      attendance_history: monthlyAttendance,
    };
  }),
);

// ---------- Lists & detail ----------
studentsRouter.get(
  "/",
  admin,
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const batch = qs(req, "batch") ?? null;
    const rows = await db.q<{ total_count: number }>(
      `select s.id, s.full_name, s.admission_no, s.phone, s.status, s.admission_date,
              case when c.id is null then null else json_build_object('name', c.name) end as classes,
              coalesce((select json_agg(json_build_object('is_primary', ps.is_primary, 'guardians', json_build_object('full_name', g.full_name, 'phone', g.phone)))
                          from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = s.id), '[]') as parent_students,
              coalesce((select json_agg(json_build_object('status', sb.status, 'batch_id', sb.batch_id, 'batches', json_build_object('name', b.name)))
                          from public.student_batches sb join public.batches b on b.id = sb.batch_id
                         where sb.student_id = s.id and ($5::uuid is null or (sb.batch_id = $5 and sb.status = 'active'))), '[]') as student_batches,
              count(*) over() as total_count
         from public.students s left join public.classes c on c.id = s.class_id
        where s.institute_id = $1
          and ($2::text is null or s.full_name ilike $2 or s.admission_no ilike $2 or s.phone ilike $2)
          and ($3::uuid is null or s.class_id = $3) and ($4::text is null or s.status::text = $4)
          and ($5::uuid is null or exists (select 1 from public.student_batches sb where sb.student_id = s.id and sb.batch_id = $5 and sb.status = 'active'))
        order by s.created_at desc limit $6 offset $7`,
      [inst, q ? like(q) : null, qs(req, "class") ?? null, qs(req, "status") ?? null, batch, limit, offset],
    );
    const classes = await db.q(`select id, name from public.classes where institute_id = $1 order by sort_order, name`, [inst]);
    const batches = await db.q(`select id, name from public.batches where institute_id = $1 and status = 'active' order by name`, [inst]);
    return { ...withCount(rows), classes, batches };
  }),
);

studentsRouter.get(
  "/admission-options",
  admin,
  h(async ({ db, inst, ctx }) =>
    db.one(
      `select
        coalesce((select json_agg(json_build_object('id', id, 'name', name) order by sort_order, name) from public.classes where institute_id = $1 and status = 'active'), '[]') as classes,
        coalesce((select json_agg(json_build_object('id', id, 'name', name) order by start_date desc) from public.academic_years where institute_id = $1), '[]') as years,
        coalesce((select json_agg(json_build_object('id', id, 'name', name, 'class_id', class_id) order by name) from public.subjects where institute_id = $1 and status = 'active'), '[]') as subjects,
        coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'class_id', b.class_id, 'capacity', b.capacity,
                   'student_batches', coalesce((select json_agg(json_build_object('status', sb.status)) from public.student_batches sb where sb.batch_id = b.id), '[]')) order by b.name)
                   from public.batches b where b.institute_id = $1 and b.status = 'active'), '[]') as batches,
        coalesce((select json_agg(json_build_object('id', id, 'name', name, 'class_id', class_id, 'fee_type', fee_type, 'category', category, 'total_amount', total_amount,
                   'installments', installments, 'default_due_day', default_due_day, 'discount_eligible', discount_eligible) order by name)
                   from public.fee_structures where institute_id = $1 and status = 'active'), '[]') as structures,
        coalesce((select json_agg(json_build_object('id', id, 'name', name, 'discount_type', discount_type, 'value', value) order by name) from public.discounts where institute_id = $1 and status = 'active'), '[]') as discounts,
        (select json_build_object('default_due_day', default_due_day, 'current_academic_year_id', current_academic_year_id) from public.institute_settings where institute_id = $1) as settings,
        (now() at time zone $2)::date::text as today`,
      [inst, ctx.timezone],
    ),
  ),
);

studentsRouter.get(
  "/:id",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const s = await db.one<{ photo_path: string | null; subject_ids: string[] }>(
      `select to_jsonb(s.*) || jsonb_build_object(
                'classes', case when c.id is null then null else json_build_object('name', c.name) end,
                'academic_years', case when y.id is null then null else json_build_object('name', y.name) end) as s
         from public.students s left join public.classes c on c.id = s.class_id left join public.academic_years y on y.id = s.academic_year_id
        where s.id = $1 and s.institute_id = $2`,
      [id, inst],
    ).then((r) => (r as { s: { photo_path: string | null; subject_ids: string[] } } | null)?.s ?? null);
    if (!s) return { student: null };
    const r = await db.one<Record<string, unknown>>(
      `select
        coalesce((select json_agg(json_build_object('id', ps.id, 'relationship', ps.relationship, 'is_primary', ps.is_primary, 'is_emergency_contact', ps.is_emergency_contact,
                   'guardians', json_build_object('id', g.id, 'full_name', g.full_name, 'phone', g.phone, 'alt_phone', g.alt_phone, 'email', g.email, 'profile_id', g.profile_id)))
                   from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = $1), '[]') as parents,
        coalesce((select json_agg(json_build_object('id', sb.id, 'start_date', sb.start_date, 'end_date', sb.end_date, 'status', sb.status, 'end_reason', sb.end_reason,
                   'batches', json_build_object('id', b.id, 'name', b.name, 'classes', case when c.id is null then null else json_build_object('name', c.name) end)) order by sb.start_date desc)
                   from public.student_batches sb join public.batches b on b.id = sb.batch_id left join public.classes c on c.id = b.class_id where sb.student_id = $1), '[]') as enrolments,
        coalesce((select json_agg(json_build_object('id', o.id, 'description', o.description, 'due_date', o.due_date, 'net_amount', o.net_amount, 'amount_paid', o.amount_paid,
                   'balance', o.balance, 'effective_status', o.effective_status, 'discount_amount', o.discount_amount, 'gross_amount', o.gross_amount, 'late_fee_amount', o.late_fee_amount) order by o.due_date)
                   from public.fee_obligation_balances o where o.student_id = $1), '[]') as obligations,
        coalesce((select json_agg(x order by x.payment_date desc) from (select p.id, p.amount, p.payment_date, p.method, p.reference, p.status,
                   (select json_build_object('receipt_no', rc.receipt_no) from public.receipts rc where rc.payment_id = p.id limit 1) as receipts
                   from public.payments p where p.student_id = $1 order by p.payment_date desc limit 20) x), '[]') as payments,
        coalesce((select json_agg(a) from public.attendance_summary($1) a), '[]') as summary,
        coalesce((select json_agg(x) from (select a.id, a.session_date, a.status, json_build_object('name', b.name) as batches
                   from public.attendance a left join public.batches b on b.id = a.batch_id where a.student_id = $1 order by a.session_date desc limit 15) x), '[]') as "recentAtt",
        coalesce((select json_agg(json_build_object('id', r.id, 'percentage', r.percentage, 'grade', r.grade, 'is_pass', r.is_pass, 'rank', r.rank, 'total_obtained', r.total_obtained,
                   'total_max', r.total_max, 'subject_breakdown', r.subject_breakdown, 'examinations', json_build_object('name', e.name, 'start_date', e.start_date)) order by r.published_at desc)
                   from public.published_results r join public.examinations e on e.id = r.examination_id where r.student_id = $1), '[]') as results,
        coalesce((select json_agg(json_build_object('id', d.id, 'title', d.title, 'file_path', d.file_path, 'created_at', d.created_at, 'size_bytes', d.size_bytes) order by d.created_at desc)
                   from public.student_documents d where d.student_id = $1), '[]') as docs,
        coalesce((select json_agg(json_build_object('id', hh.id, 'from_status', hh.from_status, 'to_status', hh.to_status, 'reason', hh.reason, 'changed_at', hh.changed_at) order by hh.changed_at desc)
                   from public.student_status_history hh where hh.student_id = $1), '[]') as history,
        coalesce((select json_agg(json_build_object('id', sj.id, 'name', sj.name)) from public.subjects sj where sj.id = any($3::uuid[])), '[]') as subjects,
        coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'capacity', b.capacity,
                   'student_batches', coalesce((select json_agg(json_build_object('status', sb.status)) from public.student_batches sb where sb.batch_id = b.id), '[]')) order by b.name)
                   from public.batches b where b.institute_id = $2 and b.status = 'active'), '[]') as "allBatches",
        coalesce((select json_agg(x) from (select al.id, al.action, al.created_at, al.reason from public.audit_logs al
                   where al.entity_id = $1::text and al.institute_id = $2 order by al.created_at desc limit 20) x), '[]') as audit`,
      [id, inst, s.subject_ids ?? []],
    );
    const docs = (r?.docs as { file_path: string }[]) ?? [];
    const urls: Record<string, string> = {};
    for (const p of [...(s.photo_path ? [s.photo_path] : []), ...docs.map((d) => d.file_path)]) urls[p] = signedUrl(p);
    return { student: s, ...r, urls };
  }),
);

studentsRouter.get(
  "/:id/edit-data",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    return db.one(
      `select (select to_jsonb(s.*) from public.students s where s.id = $1 and s.institute_id = $2) as student,
        coalesce((select json_agg(json_build_object('id', id, 'name', name) order by sort_order, name) from public.classes where institute_id = $2), '[]') as classes,
        coalesce((select json_agg(json_build_object('id', id, 'name', name, 'class_id', class_id) order by name) from public.subjects where institute_id = $2 and status = 'active'), '[]') as subjects,
        coalesce((select json_agg(json_build_object('id', g.id, 'full_name', g.full_name, 'phone', g.phone, 'alt_phone', g.alt_phone, 'email', g.email))
                   from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = $1 and ps.institute_id = $2), '[]') as guardians`,
      [id, inst],
    );
  }),
);

// ---------- Admission ----------
studentsRouter.post("/admit", admin, async (req, res) => {
  const ctx = ctxOf(req);
  const v = z
    .object({
      student: z.record(z.string(), z.unknown()),
      guardians: z.array(z.object({ full_name: z.string(), phone: z.string(), email: z.string().nullish(), is_primary: z.boolean().optional() }).passthrough()).min(1),
      batch_ids: z.array(z.uuid()).default([]),
      capacity_override_reason: z.string().nullish(),
      fees: z.array(z.record(z.string(), z.unknown())).default([]),
      create_parent_login: z.boolean().default(false),
      create_student_login: z.boolean().default(false),
    })
    .parse(req.body);
  const { create_parent_login, create_student_login, ...payload } = v;
  const result = await asUser(ctx, async (db) => {
    const r = await db.one<{ r: { student_id: string; admission_no: string; obligations_created: number } }>(`select public.admit_student($1) as r`, [JSON.stringify(payload)]);
    return r!.r;
  });

  // Account invitations (after the admission committed; failures don't undo the admission).
  const notes: string[] = [];
  if (result.obligations_created) notes.push(`${result.obligations_created} fee installment(s) created`);
  const primary = v.guardians.find((g) => g.is_primary) ?? v.guardians[0];
  const studentEmail = (v.student.email as string | null) || null;
  if (create_parent_login) {
    if (!primary.email) notes.push("Parent login not created: primary parent has no email");
    else {
      try {
        const acc = await provisionAccount(ctx, { email: primary.email, phone: primary.phone, fullName: primary.full_name, role: "parent", mode: "invite" });
        await asSystem((db) => db.q(`update public.guardians set profile_id = $3 where institute_id = $1 and phone = $2`, [ctx.institute.id, primary.phone, acc.userId]));
        notes.push(acc.invited ? "Parent invitation emailed" : "Linked to the parent's existing login");
      } catch (e) {
        notes.push(`Parent login not created: ${(e as Error).message}`);
      }
    }
  }
  if (create_student_login) {
    if (!studentEmail) notes.push("Student login not created: student has no email");
    else {
      try {
        const acc = await provisionAccount(ctx, { email: studentEmail, phone: (v.student.phone as string | null) ?? null, fullName: String(v.student.full_name), role: "student", mode: "invite" });
        await asSystem((db) => db.q(`update public.students set profile_id = $2 where id = $1`, [result.student_id, acc.userId]));
        notes.push(acc.invited ? "Student invitation emailed" : "Linked to the student's existing login");
      } catch (e) {
        notes.push(`Student login not created: ${(e as Error).message}`);
      }
    }
  }

  // Admission confirmation email (best effort).
  try {
    const to = [...new Set([studentEmail, primary.email ?? null].filter((x): x is string => !!x))];
    if (to.length) {
      const info = await asSystem((db) =>
        db.one<{ email_enabled: boolean; phone: string | null; email: string | null; class_name: string | null; batch_names: string[] | null }>(
          `select st.email_enabled, i.phone, i.email,
                  (select name from public.classes where id = $2) as class_name,
                  (select array_agg(name) from public.batches where id = any($3::uuid[])) as batch_names
             from public.institutes i join public.institute_settings st on st.institute_id = i.id where i.id = $1`,
          [ctx.institute.id, (v.student.class_id as string) || null, v.batch_ids],
        ),
      );
      if (info?.email_enabled) {
        const tpl = renderAdmissionWelcomeEmail({
          instituteName: ctx.institute.name,
          institutePhone: info.phone,
          instituteEmail: info.email,
          studentName: String(v.student.full_name),
          admissionNo: result.admission_no,
          className: info.class_name,
          batchNames: info.batch_names ?? [],
        });
        await sendEmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: ctx.institute.id });
      }
    }
  } catch (e) {
    console.error("[admission] welcome email failed", e);
  }
  res.json({ message: `Admitted with number ${result.admission_no}`, id: result.student_id, admission_no: result.admission_no, notes });
});

// ---------- Updates ----------
studentsRouter.patch(
  "/:id",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z
      .object({
        full_name: z.string().trim().min(1).max(100), date_of_birth: optStr, gender: z.enum(["", "male", "female", "other"]).nullish().transform((x) => x || null),
        blood_group: optStr, phone: optStr, email: optStr, address: optStr, city: optStr, state: optStr, pin_code: optStr, school_name: optStr,
        class_id: z.string().nullish().transform((x) => x || null), subject_ids: z.array(z.uuid()).default([]), previous_academics: optStr,
      })
      .parse(req.body);
    const r = await db.q(
      `update public.students set full_name = $3, date_of_birth = $4, gender = $5, blood_group = $6, phone = $7, email = $8, address = $9, city = $10,
              state = $11, pin_code = $12, school_name = $13, class_id = $14, subject_ids = $15, previous_academics = $16
        where id = $1 and institute_id = $2 returning id`,
      [id, inst, v.full_name, v.date_of_birth, v.gender, v.blood_group, v.phone, v.email, v.address, v.city, v.state, v.pin_code, v.school_name, v.class_id, v.subject_ids, v.previous_academics],
    );
    if (!r.length) throw notFound("Student not found.");
    return { message: "Student updated" };
  }),
);

studentsRouter.post(
  "/:id/status",
  admin,
  h(async ({ req, db }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z.object({ status: z.enum(["active", "inactive", "on_hold", "discontinued", "completed"]), reason: z.string().default("") }).parse(req.body);
    await db.q(`select public.change_student_status($1, $2, $3)`, [id, v.status, v.reason]);
    return { message: "Status updated" };
  }),
);

studentsRouter.post(
  "/enrolments/:id/transfer",
  admin,
  h(async ({ req, db }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z.object({ to_batch: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string(), override: optStr }).parse(req.body);
    await db.q(`select public.transfer_student_batch($1, $2, $3, $4, $5)`, [id, v.to_batch, v.date, v.reason, v.override]);
    return { message: "Student transferred" };
  }),
);

studentsRouter.post("/:id/documents", admin, upload.any(), async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const title = String((jsonField(req) as { title?: string }).title ?? "").trim();
  const file = fileField(req, "file");
  if (!title) throw badRequest("Enter a document title.");
  // Check first, write the file outside any transaction (putFile uses its own connection), then record it.
  const st = await asUser(ctx, (db) =>
    db.one<{ max_upload_mb: number }>(
      `select st.max_upload_mb from public.institute_settings st where st.institute_id = $1 and exists (select 1 from public.students s where s.id = $2 and s.institute_id = $1)`,
      [ctx.institute.id, id],
    ),
  );
  if (!st) throw notFound("Student not found.");
  const err = validateUpload(file, st.max_upload_mb ?? 10, ["application/pdf", "image/png", "image/jpeg", "image/webp"]);
  if (err) throw badRequest(err);
  const path = `${ctx.institute.id}/students/${id}/${safeFileName(file!.originalname)}`;
  await putFile("files", path, file!.buffer);
  await asUser(ctx, (db) =>
    db.q(
      `insert into public.student_documents (institute_id, student_id, title, file_path, mime_type, size_bytes, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.institute.id, id, title, path, file!.mimetype, file!.size, ctx.userId],
    ),
  );
  res.json({ message: "Document uploaded" });
});

studentsRouter.post("/:id/photo", admin, upload.any(), async (req, res) => {
  const ctx = ctxOf(req);
  const id = z.uuid().parse(req.params.id);
  const file = fileField(req, "file");
  const err = validateUpload(file, 2, ["image/png", "image/jpeg", "image/webp"]);
  if (err) throw badRequest(err);
  const exists = await asUser(ctx, (db) => db.one(`select 1 from public.students where id = $1 and institute_id = $2`, [id, ctx.institute.id]));
  if (!exists) throw notFound("Student not found.");
  const path = `${ctx.institute.id}/students/${id}/photo-${safeFileName(file!.originalname)}`;
  await putFile("files", path, file!.buffer);
  await asUser(ctx, (db) => db.q(`update public.students set photo_path = $3 where id = $1 and institute_id = $2`, [id, ctx.institute.id, path]));
  res.json({ message: "Photo updated" });
});

/** Create (or resend) a student/parent login invitation. */
studentsRouter.post("/family-login", admin, async (req, res) => {
  const ctx = ctxOf(req);
  const v = z.object({ kind: z.enum(["student", "parent"]), id: z.uuid() }).parse(req.body);
  const table = v.kind === "student" ? "students" : "guardians";
  const p = await asUser(ctx, (db) =>
    db.one<{ id: string; full_name: string; email: string | null; phone: string | null; profile_id: string | null }>(
      `select id, full_name, email, phone, profile_id from public.${table} where id = $1 and institute_id = $2`,
      [v.id, ctx.institute.id],
    ),
  );
  if (!p) throw notFound(v.kind === "student" ? "Student not found." : "Parent not found.");
  if (!p.email) throw badRequest(v.kind === "student" ? "Add the student's email first." : "Add the parent's email first.");
  if (!p.profile_id) {
    const acc = await provisionAccount(ctx, { email: p.email, phone: p.phone, fullName: p.full_name, role: v.kind, mode: "invite" });
    await asSystem((db) => db.q(`update public.${table} set profile_id = $2 where id = $1`, [v.id, acc.userId]));
    res.json({ message: `Invitation sent to ${p.email}!` });
    return;
  }
  await sendInvitation(ctx, p.profile_id, p.email, p.full_name, v.kind);
  res.json({ message: `Invitation emailed to ${p.email}!` });
});

studentsRouter.patch(
  "/guardians/:id",
  admin,
  h(async ({ req, db, inst }) => {
    const id = z.uuid().parse(req.params.id);
    const v = z.object({ full_name: z.string().trim().min(1).max(100), alt_phone: optStr, email: optStr }).parse(req.body);
    const r = await db.q(`update public.guardians set full_name = $3, alt_phone = $4, email = $5 where id = $1 and institute_id = $2 returning id`, [id, inst, v.full_name, v.alt_phone, v.email]);
    if (!r.length) throw notFound("Parent not found.");
    return { message: "Parent details updated" };
  }),
);
