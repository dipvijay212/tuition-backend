import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware.js";
import { h, like, qs } from "../lib/route.js";
import { notFound } from "../lib/errors.js";

export const academicsRouter = Router();
academicsRouter.use(requireRole("admin"));

const optText = z.string().trim().nullish().transform((v) => v || null);
const optUuid = z.string().nullish().transform((v) => v || null).pipe(z.uuid().nullable());
const status = z.enum(["active", "inactive"]).default("active");

academicsRouter.get(
  "/classes",
  h(async ({ req, db, inst }) => {
    const q = qs(req, "q");
    const rows = await db.q(
      `select c.id, c.name, c.description, c.academic_year_id, c.sort_order, c.status,
              case when y.id is null then null else json_build_object('name', y.name) end as academic_years,
              json_build_array(json_build_object('count', (select count(*) from public.batches b where b.class_id = c.id))) as batches,
              json_build_array(json_build_object('count', (select count(*) from public.subjects s where s.class_id = c.id))) as subjects,
              json_build_array(json_build_object('count', (select count(*) from public.students s where s.class_id = c.id))) as students
         from public.classes c left join public.academic_years y on y.id = c.academic_year_id
        where c.institute_id = $1 and ($2::text is null or c.name ilike $2) and ($3::text is null or c.status::text = $3)
        order by c.sort_order, c.name`,
      [inst, q ? like(q) : null, qs(req, "status") ?? null],
    );
    const years = await db.q(`select id, name from public.academic_years where institute_id = $1 order by start_date desc`, [inst]);
    return { rows, years };
  }),
);

academicsRouter.post(
  "/classes",
  h(async ({ req, db, inst }) => {
    const v = z
      .object({ id: optUuid, name: z.string().trim().min(1).max(60), description: optText, academic_year_id: optUuid, sort_order: z.coerce.number().int().default(0), status })
      .parse(req.body);
    if (v.id) {
      const r = await db.q(
        `update public.classes set name = $3, description = $4, academic_year_id = $5, sort_order = $6, status = $7 where id = $1 and institute_id = $2 returning id`,
        [v.id, inst, v.name, v.description, v.academic_year_id, v.sort_order, v.status],
      );
      if (!r.length) throw notFound("Class not found.");
    } else {
      await db.q(`insert into public.classes (institute_id, name, description, academic_year_id, sort_order, status) values ($1, $2, $3, $4, $5, $6)`, [
        inst, v.name, v.description, v.academic_year_id, v.sort_order, v.status,
      ]);
    }
    return { message: v.id ? "Class updated" : "Class created" };
  }),
);

academicsRouter.get(
  "/subjects",
  h(async ({ req, db, inst }) => {
    const q = qs(req, "q");
    const rows = await db.q(
      `select s.id, s.name, s.code, s.class_id, s.description, s.status,
              case when c.id is null then null else json_build_object('name', c.name) end as classes
         from public.subjects s left join public.classes c on c.id = s.class_id
        where s.institute_id = $1 and ($2::text is null or s.name ilike $2 or s.code ilike $2)
          and ($3::uuid is null or s.class_id = $3) and ($4::text is null or s.status::text = $4)
        order by s.name`,
      [inst, q ? like(q) : null, qs(req, "class") ?? null, qs(req, "status") ?? null],
    );
    const classes = await db.q(`select id, name from public.classes where institute_id = $1 order by sort_order, name`, [inst]);
    return { rows, classes };
  }),
);

academicsRouter.post(
  "/subjects",
  h(async ({ req, db, inst }) => {
    const v = z
      .object({ id: optUuid, name: z.string().trim().min(1).max(60), code: z.string().trim().max(20).nullish().transform((x) => (x ? x.toUpperCase() : null)), class_id: optUuid, description: optText, status })
      .parse(req.body);
    if (v.id) {
      const r = await db.q(
        `update public.subjects set name = $3, code = $4, class_id = $5, description = $6, status = $7 where id = $1 and institute_id = $2 returning id`,
        [v.id, inst, v.name, v.code, v.class_id, v.description, v.status],
      );
      if (!r.length) throw notFound("Subject not found.");
    } else {
      await db.q(`insert into public.subjects (institute_id, name, code, class_id, description, status) values ($1, $2, $3, $4, $5, $6)`, [
        inst, v.name, v.code, v.class_id, v.description, v.status,
      ]);
    }
    return { message: v.id ? "Subject updated" : "Subject created" };
  }),
);
