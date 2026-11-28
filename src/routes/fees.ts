import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asSystem, asUser } from "../db/pool.js";
import { ctxOf, requireRole } from "../middleware.js";
import { h, paging, qs, withCount } from "../lib/route.js";
import { badRequest, notFound } from "../lib/errors.js";
import { renderFeeReceiptEmail, sendEmail } from "../email/index.js";

export const feesRouter = Router();
feesRouter.use(requireRole("admin"));
const optStr = z.string().trim().nullish().transform((v) => v || null);
const STUDENT_JSON = `json_build_object('id', s.id, 'full_name', s.full_name, 'admission_no', s.admission_no, 'phone', s.phone,
  'classes', case when c.id is null then null else json_build_object('name', c.name) end) as students`;

feesRouter.get(
  "/overview",
  h(async ({ db, inst }) => {
    const structures = await db.q(
      `select f.id, f.name, f.fee_type, f.category, f.total_amount, f.installments, f.default_due_day, f.discount_eligible, f.status,
              case when c.id is null then null else json_build_object('name', c.name) end as classes
         from public.fee_structures f left join public.classes c on c.id = f.class_id
        where f.institute_id = $1 order by f.name`,
      [inst],
    );
    const classes = await db.q(`select id, name from public.classes where institute_id = $1 order by name`, [inst]);
    const obligations = await db.q(
      `select o.student_id, o.net_amount, o.amount_paid, o.status, ${STUDENT_JSON}
         from public.fee_obligations o join public.students s on s.id = o.student_id left join public.classes c on c.id = s.class_id
        where o.institute_id = $1`,
      [inst],
    );
    return { structures, classes, obligations };
  }),
);

feesRouter.get(
  "/payments",
  h(async ({ req, db, inst }) => {
    const { limit, offset } = paging(req);
    const rows = await db.q<{ total_count: number }>(
      `select p.id, p.amount, p.payment_date, p.method, p.reference, p.remarks, p.status, ${STUDENT_JSON},
              (select json_build_object('receipt_no', r.receipt_no, 'snapshot', r.snapshot) from public.receipts r where r.payment_id = p.id limit 1) as receipts,
              count(*) over() as total_count
         from public.payments p join public.students s on s.id = p.student_id left join public.classes c on c.id = s.class_id
        where p.institute_id = $1 and ($2::text is null or p.method::text = $2)
        order by p.payment_date desc, p.created_at desc limit $3 offset $4`,
      [inst, qs(req, "method") ?? null, limit, offset],
    );
    const unpaid = await db.q(
      `select o.student_id, o.net_amount, o.amount_paid, ${STUDENT_JSON}
         from public.fee_obligations o join public.students s on s.id = o.student_id left join public.classes c on c.id = s.class_id
        where o.institute_id = $1 and o.status in ('unpaid', 'partially_paid')`,
      [inst],
    );
    return { ...withCount(rows), unpaid };
  }),
);

feesRouter.post(
  "/structures",
  h(async ({ req, db, inst }) => {
    const v = z
      .object({
        id: z.string().nullish().transform((x) => x || null),
        name: z.string().trim().min(1).max(100),
        class_id: z.string().nullish().transform((x) => x || null),
        fee_type: z.enum(["monthly", "quarterly", "half_yearly", "yearly", "course", "custom"]),
        category: z.enum(["tuition", "admission", "registration", "study_material", "other"]).default("tuition"),
        total_amount: z.number().nonnegative(),
        installments: z.number().int().min(1).max(60).default(1),
        default_due_day: z.number().int().min(1).max(28).default(5),
        discount_eligible: z.boolean().default(false),
        late_fee_applicable: z.boolean().default(false),
        description: optStr,
      })
      .parse(req.body);
    const vals = [inst, v.name, v.class_id, v.fee_type, v.category, v.total_amount, v.installments, v.default_due_day, v.discount_eligible, v.late_fee_applicable, v.description];
    if (v.id) {
      const r = await db.q(
        `update public.fee_structures set name = $2, class_id = $3, fee_type = $4, category = $5, total_amount = $6, installments = $7,
                default_due_day = $8, discount_eligible = $9, late_fee_applicable = $10, description = $11
          where id = $12 and institute_id = $1 returning id`,
        [...vals, v.id],
      );
      if (!r.length) throw notFound("Fee structure not found.");
    } else {
      await db.q(
        `insert into public.fee_structures (institute_id, name, class_id, fee_type, category, total_amount, installments, default_due_day, discount_eligible, late_fee_applicable, description)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        vals,
      );
    }
    return { message: "Fee structure saved" };
  }),
);

type Snapshot = {
  institute?: { name?: string };
  student?: { name?: string; admission_no?: string };
  payment_date?: string;
  amount?: number;
  method?: string;
  reference?: string;
  remaining_balance?: number;
  items?: Array<{ description: string; amount: number }>;
};

feesRouter.post("/payments", async (req, res) => {
  const ctx = ctxOf(req);
  const v = z
    .object({
      student_id: z.uuid("Select a student"),
      amount: z.number().positive("Amount must be greater than zero"),
      payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      method: z.enum(["cash", "upi", "bank_transfer", "cheque", "online", "other"]),
      reference: optStr,
      remarks: optStr,
      obligation_ids: z.array(z.uuid()).default([]),
      idempotency_key: z.string().min(8).max(100).optional(),
    })
    .parse(req.body);
  if (["upi", "bank_transfer", "cheque", "online"].includes(v.method) && !v.reference) throw badRequest("Transaction reference is required for electronic payments");

  // record_payment checks admin rights, allocates oldest-first and issues the receipt.
  const result = await asUser(ctx, async (db) => {
    const r = await db.one<{ r: { payment_id: string; receipt_no: string; duplicate?: boolean } }>(
      `select public.record_payment($1, $2, $3, $4, $5, $6, $7, $8) as r`,
      [v.student_id, v.amount, v.payment_date, v.method, v.reference ?? "", v.remarks ?? "", v.obligation_ids.length ? v.obligation_ids : null, v.idempotency_key ?? randomUUID()],
    );
    return r!.r;
  });
  res.json({ message: `Payment of ₹${v.amount} recorded! Receipt: ${result.receipt_no ?? ""}`, ...result });

  // Receipt email (best effort, after responding).
  if (!result.duplicate) {
    void (async () => {
      const info = await asSystem((db) =>
        db.one<{ snapshot: Snapshot; institute_id: string; emails: string[] | null }>(
          `select r.snapshot, r.institute_id,
                  (select array_agg(distinct e) from (
                     select s.email as e from public.students s where s.id = $2 and s.email is not null
                     union select g.email from public.parent_students ps join public.guardians g on g.id = ps.guardian_id where ps.student_id = $2 and g.email is not null) x) as emails
             from public.receipts r where r.payment_id = $1`,
          [result.payment_id, v.student_id],
        ),
      );
      if (!info?.emails?.length) return;
      const snap = info.snapshot ?? {};
      const tpl = renderFeeReceiptEmail({
        instituteName: snap.institute?.name,
        studentName: snap.student?.name ?? "Student",
        admissionNo: snap.student?.admission_no ?? "",
        receiptNo: result.receipt_no,
        paymentDate: snap.payment_date ?? v.payment_date,
        amount: snap.amount ?? v.amount,
        paymentMethod: snap.method ?? v.method,
        reference: snap.reference ?? v.reference ?? undefined,
        remainingBalance: snap.remaining_balance,
        items: snap.items,
      });
      await sendEmail({ to: info.emails, subject: tpl.subject, html: tpl.html, text: tpl.text, instituteId: info.institute_id });
    })().catch((e) => console.error("[fees] receipt email failed", e));
  }
});
