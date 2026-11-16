import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h, like, paging, qs, withCount } from "../lib/route.js";

export const dashboardRouter = Router();

dashboardRouter.get(
  "/admin",
  requireRole("admin"),
  h(async ({ req, db }) => {
    const v = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    return (await db.one<{ d: unknown }>(`select public.admin_dashboard($1, $2) as d`, [v.from, v.to]))?.d;
  }),
);

dashboardRouter.get(
  "/teacher",
  requireRole("teacher"),
  h(async ({ db }) => {
    const linked = await db.one(`select public.my_teacher_id() as id`).then((r) => (r as { id: string | null } | null)?.id);
    if (!linked) return { linked: false, dashboard: null, announcements: [] };
    const d = await db.one<{ d: unknown }>(`select public.teacher_dashboard() as d`);
    const announcements = await db.q(
      `select id, title, body, created_at from public.announcements
        where institute_id = public.auth_institute_id() and (audience in ('all', 'staff') or (audience = 'batch' and batch_id in (select public.my_batch_ids())))
        order by created_at desc limit 4`,
    );
    return { linked: true, dashboard: d?.d, announcements };
  }),
);

/** Students actively enrolled in the teacher's batches. */
dashboardRouter.get(
  "/teacher/students",
  requireRole("teacher"),
  h(async ({ req, db }) => {
    const { limit, offset } = paging(req);
    const q = qs(req, "q");
    const rows = await db.q<{ total_count: number }>(
      `select s.id, s.full_name, s.admission_no, case when c.id is null then null else json_build_object('name', c.name) end as classes,
              coalesce((select json_agg(json_build_object('status', sb.status, 'batches', json_build_object('name', b.name)))
                          from public.student_batches sb join public.batches b on b.id = sb.batch_id
                         where sb.student_id = s.id and sb.batch_id in (select public.my_batch_ids())), '[]') as student_batches,
              count(*) over() as total_count
         from public.students s left join public.classes c on c.id = s.class_id
        where s.status = 'active' and public.teacher_can_access_student(s.id)
          and ($1::text is null or s.full_name ilike $1 or s.admission_no ilike $1)
        order by s.full_name limit $2 offset $3`,
      [q ? like(q) : null, limit, offset],
    );
    return withCount(rows);
  }),
);
