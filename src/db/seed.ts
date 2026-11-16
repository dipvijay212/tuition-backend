/**
 * Demo data: a realistic coaching institute in Ahmedabad for the 2026-27 academic year.
 * Uses the same SQL business functions as the app (admit_student, record_payment,
 * submit_attendance, publish_examination), so balances, receipts and results are consistent.
 *
 *   npm run db:seed            (refuses if an institute already exists)
 *
 * All demo emails use @example.com (reserved domain), so no real person is ever emailed.
 */
import { asSystem, asUser, pool, type Db } from "./pool.js";
import { createAuthUser } from "../auth/provision.js";
import { putFile } from "../lib/storage.js";

const ADMIN = { name: "Dipvijay Rathod", email: "admin@example.com", phone: "9825012345", password: "Admin@1234" };
const DEMO_PASSWORD = "Demo@1234";
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- deterministic randomness ----------
let seed = 20261116;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const addDays = (d: string, n: number) => {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const minDate = (a: string, b: string) => (a < b ? a : b);

// ---------- people ----------
const BOYS = ["Aarav", "Vivaan", "Dhruv", "Krish", "Yash", "Harsh", "Parth", "Jay", "Kunal", "Rudra", "Aditya", "Om", "Dev", "Meet", "Nisarg", "Tirth", "Rohan", "Smit", "Jainil", "Het", "Manan", "Darshil"];
const GIRLS = ["Diya", "Aanya", "Krisha", "Riya", "Khushi", "Isha", "Jiya", "Nidhi", "Mahi", "Pooja", "Hetvi", "Vidhi", "Kavya", "Ananya", "Prachi", "Shreya", "Dhruvi", "Tanvi", "Saloni", "Janvi"];
const SURNAMES = ["Patel", "Shah", "Mehta", "Desai", "Joshi", "Trivedi", "Pandya", "Bhatt", "Parikh", "Modi", "Thakkar", "Vyas", "Chauhan", "Solanki", "Rathod", "Dave", "Gandhi", "Amin", "Raval", "Kothari"];
const FATHERS = ["Mehul", "Rakesh", "Hitesh", "Jignesh", "Nilesh", "Bhavesh", "Paresh", "Kalpesh", "Sanjay", "Dharmesh", "Ketan", "Vipul", "Alpesh", "Chirag", "Manish", "Tushar"];
const MOTHERS = ["Hetal", "Nisha", "Jagruti", "Bhavna", "Rupal", "Komal", "Falguni", "Mittal", "Payal", "Sejal", "Dimple", "Krupa"];
const AREAS = ["Satellite", "Vastrapur", "Bodakdev", "Prahlad Nagar", "Navrangpura", "Paldi", "Maninagar", "Thaltej", "Gota", "Naranpura", "Ambawadi", "Bopal"];
const SOCIETIES = ["Shivam Residency", "Sundaram Apartments", "Shyamal Row Houses", "Parishram Society", "Gokuldham Flats", "Sarthak Heights", "Vrundavan Bungalows", "Shreeji Tenements", "Aakash Towers", "Nilkanth Park"];
const SCHOOLS = ["Udgam School for Children", "Delhi Public School, Bopal", "St. Xavier's High School", "Anand Niketan, Satellite", "Nirma Vidyavihar", "Divine Child High School", "Zydus School for Excellence", "Shanti Asiatic School", "Mount Carmel High School", "Tripada International School"];
const BLOOD = ["A+", "B+", "O+", "AB+", "B+", "O+", "A-", "O-"];
let phoneSeq = 0;
const phone = () => `${pick(["98", "97", "99", "94", "90", "88", "70", "63"])}${String(25000000 + phoneSeq++ * 7919 + between(0, 50)).slice(0, 8)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z]+/g, ".");

// ---------- structure ----------
type ClassDef = { key: string; name: string; sort: number; subjects: [string, string][]; fee: number; feeType: "monthly" | "quarterly"; inst: number; dob: number };
const CLASSES: ClassDef[] = [
  { key: "8", name: "Std 8", sort: 1, subjects: [["Mathematics", "MAT8"], ["Science", "SCI8"], ["English", "ENG8"], ["Social Science", "SS8"]], fee: 18000, feeType: "monthly", inst: 10, dob: 2013 },
  { key: "9", name: "Std 9", sort: 2, subjects: [["Mathematics", "MAT9"], ["Science", "SCI9"], ["English", "ENG9"], ["Social Science", "SS9"], ["Gujarati", "GUJ9"]], fee: 24000, feeType: "monthly", inst: 10, dob: 2012 },
  { key: "10", name: "Std 10 (SSC)", sort: 3, subjects: [["Mathematics", "MAT10"], ["Science", "SCI10"], ["English", "ENG10"], ["Social Science", "SS10"], ["Gujarati", "GUJ10"]], fee: 32000, feeType: "monthly", inst: 10, dob: 2011 },
  { key: "11", name: "Std 11 Science", sort: 4, subjects: [["Physics", "PHY11"], ["Chemistry", "CHE11"], ["Biology", "BIO11"], ["Mathematics", "MAT11"]], fee: 48000, feeType: "quarterly", inst: 4, dob: 2010 },
  { key: "12", name: "Std 12 Science", sort: 5, subjects: [["Physics", "PHY12"], ["Chemistry", "CHE12"], ["Mathematics", "MAT12"]], fee: 54000, feeType: "quarterly", inst: 4, dob: 2009 },
];

const TEACHERS = [
  { name: "Rajesh Patel", qual: "M.Sc. Mathematics, B.Ed.", spec: "Mathematics", subjects: ["Mathematics"], salary: 45000, login: true, joined: "2019-06-10" },
  { name: "Hetal Joshi", qual: "M.Sc. Physics, B.Ed.", spec: "Science", subjects: ["Science"], salary: 38000, login: true, joined: "2021-04-05" },
  { name: "Nirav Shah", qual: "M.Sc. Physics (IIT Bombay)", spec: "Physics – JEE/NEET", subjects: ["Physics"], salary: 60000, login: false, joined: "2020-05-18" },
  { name: "Kavita Desai", qual: "M.Sc. Organic Chemistry", spec: "Chemistry", subjects: ["Chemistry"], salary: 55000, login: false, joined: "2022-06-01" },
  { name: "Priya Mehta", qual: "M.A. English, M.Sc. Zoology", spec: "English & Biology", subjects: ["English", "Biology"], salary: 36000, login: false, joined: "2023-06-12" },
  { name: "Amit Trivedi", qual: "M.A. History, B.Ed.", spec: "Social Science & Gujarati", subjects: ["Social Science", "Gujarati"], salary: 32000, login: false, joined: "2018-07-02" },
];

type BatchDef = { cls: string; name: string; days: number[]; start: string; end: string; room: string; capacity: number; students: number };
const BATCHES: BatchDef[] = [
  { cls: "8", name: "Std 8 – Foundation", days: [1, 3, 5], start: "16:00", end: "17:30", room: "Room 1", capacity: 25, students: 7 },
  { cls: "9", name: "Std 9 – Evening", days: [1, 2, 3, 4, 5], start: "17:30", end: "19:00", room: "Room 2", capacity: 30, students: 8 },
  { cls: "10", name: "Std 10 – Morning (A)", days: [1, 2, 3, 4, 5, 6], start: "07:00", end: "08:30", room: "Room 3", capacity: 30, students: 10 },
  { cls: "10", name: "Std 10 – Evening (B)", days: [1, 2, 3, 4, 5, 6], start: "19:00", end: "20:30", room: "Room 1", capacity: 30, students: 9 },
  { cls: "11", name: "Std 11 Science – NEET", days: [2, 4, 6], start: "15:30", end: "17:30", room: "Room 4", capacity: 20, students: 6 },
  { cls: "12", name: "Std 12 Science – JEE", days: [1, 3, 5], start: "14:30", end: "16:30", room: "Room 4", capacity: 20, students: 6 },
];

async function savepoint<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  await db.q("savepoint sp");
  try {
    const r = await fn();
    await db.q("release savepoint sp");
    return r;
  } catch {
    await db.q("rollback to savepoint sp");
    return null;
  }
}

/** Creates a login, links its profile to the institute and grants a role. */
async function makeLogin(db: Db, inst: string, p: { email: string; name: string; phone: string; role: string; password: string }) {
  const id = await createAuthUser(db, { email: p.email, password: p.password, fullName: p.name, phone: p.phone, confirmed: true });
  await db.q(`update public.profiles set institute_id = $2, full_name = $3, email = $4, phone = $5, status = 'active' where id = $1`, [id, inst, p.name, p.email, p.phone]);
  await db.q(`insert into public.user_roles (user_id, institute_id, role) values ($1, $2, $3)`, [id, inst, p.role]);
  return id;
}

/** A tiny valid one-page PDF with a title and a few lines of text. */
function pdf(title: string, lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const text = [`BT /F1 20 Tf 60 760 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 12 Tf 60 ${720 - i * 22} Td (${esc(l)}) Tj ET`)].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

/** Demo logins for two teachers, three parents and two students. */
async function createLogins(inst: string, teacherId: Record<string, string>) {
  return asSystem(async (db) => {
    const out: { role: string; name: string; email: string }[] = [];
    for (const t of TEACHERS.filter((x) => x.login)) {
      const row = (await db.one<{ phone: string; email: string }>(`select phone, email from public.teachers where id = $1`, [teacherId[t.name]]))!;
      const uid = await makeLogin(db, inst, { email: row.email, name: t.name, phone: row.phone, role: "teacher", password: DEMO_PASSWORD });
      await db.q(`update public.teachers set profile_id = $2 where id = $1`, [teacherId[t.name], uid]);
      out.push({ role: "Teacher", name: t.name, email: row.email });
    }
    // Parents: the families with two children first, then two more.
    const parents = await db.q<{ id: string; full_name: string; phone: string; email: string; kids: number }>(
      `select g.id, g.full_name, g.phone, g.email, count(*)::int as kids from public.guardians g join public.parent_students ps on ps.guardian_id = g.id
        where g.institute_id = $1 and g.email is not null group by g.id order by count(*) desc, g.full_name limit 3`,
      [inst],
    );
    for (const g of parents) {
      const uid = await makeLogin(db, inst, { email: g.email, name: g.full_name, phone: g.phone, role: "parent", password: DEMO_PASSWORD });
      await db.q(`update public.guardians set profile_id = $2 where id = $1`, [g.id, uid]);
      out.push({ role: g.kids > 1 ? "Parent (2 children)" : "Parent", name: g.full_name, email: g.email });
    }
    const students = await db.q<{ id: string; full_name: string; email: string; phone: string | null }>(
      `select id, full_name, email, phone from public.students where institute_id = $1 and email is not null and status = 'active' order by admission_no limit 2`,
      [inst],
    );
    for (const s of students) {
      const uid = await makeLogin(db, inst, { email: s.email, name: s.full_name, phone: s.phone ?? "", role: "student", password: DEMO_PASSWORD });
      await db.q(`update public.profiles set phone = nullif(phone, '') where id = $1`, [uid]);
      await db.q(`update public.students set profile_id = $2 where id = $1`, [s.id, uid]);
      out.push({ role: "Student", name: s.full_name, email: s.email });
    }
    return out;
  });
}

async function main() {
  if (process.argv.includes("--reset")) {
    // DEMO DATABASES ONLY: wipes every app table and all logins, then re-seeds.
    const { rows } = await pool.query<{ t: string }>(
      `select format('%I.%I', schemaname, tablename) as t from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
    );
    await pool.query(`truncate ${rows.map((r) => r.t).join(", ")}, auth.users, auth.sessions, auth.one_time_tokens restart identity cascade`);
    console.log("Reset: all data removed.");
  }
  if ((await pool.query("select 1 from public.institutes limit 1")).rowCount) {
    console.error("An institute already exists. The seed only runs on an empty database (use --reset on a demo database).");
    process.exit(1);
  }
  console.log("Seeding demo data…");

  // ---------- Institute, admin, staff logins (system) ----------
  const { inst, adminId } = await asSystem(async (db) => {
    const inst = (await db.one<{ id: string }>(
      `insert into public.institutes (name, address, phone, email, website)
       values ('Shree Vidya Coaching Classes', '2nd Floor, Shivalik Plaza, Near IIM Road, Ambawadi, Ahmedabad, Gujarat 380015', '07926301234', 'info@example.com', 'www.example.com') returning id`,
    ))!.id;
    await db.q(`select public.seed_institute_defaults($1)`, [inst]);
    await db.q(
      `update public.institute_settings set receipt_footer = 'Fees once paid are not refundable. Thank you for choosing Shree Vidya Coaching Classes.',
              late_fee_enabled = true, late_fee_type = 'fixed', late_fee_value = 100, late_fee_grace_days = 5 where institute_id = $1`,
      [inst],
    );
    const adminId = await makeLogin(db, inst, { email: ADMIN.email, name: ADMIN.name, phone: ADMIN.phone, role: "admin", password: ADMIN.password });
    return { inst, adminId };
  });

  // ---------- Structure, staff and admissions as the admin (auth.uid() = admin) ----------
  const setup = await asUser(adminId, async (db) => {
    const year = (await db.one<{ id: string }>(
      `insert into public.academic_years (institute_id, name, start_date, end_date, is_current) values ($1, '2026-27', '2026-06-01', '2027-03-31', true) returning id`,
      [inst],
    ))!.id;
    await db.q(`insert into public.academic_years (institute_id, name, start_date, end_date) values ($1, '2025-26', '2025-06-01', '2026-03-31')`, [inst]);
    await db.q(`update public.institute_settings set current_academic_year_id = $2 where institute_id = $1`, [inst, year]);

    // Classes, subjects, fee structures
    const classId: Record<string, string> = {};
    const subjectId: Record<string, Record<string, string>> = {};
    const structId: Record<string, string> = {};
    for (const c of CLASSES) {
      classId[c.key] = (await db.one<{ id: string }>(
        `insert into public.classes (institute_id, name, academic_year_id, sort_order, description) values ($1, $2, $3, $4, $5) returning id`,
        [inst, c.name, year, c.sort, `${c.name} – GSEB board, English medium`],
      ))!.id;
      subjectId[c.key] = {};
      for (const [name, code] of c.subjects) {
        subjectId[c.key][name] = (await db.one<{ id: string }>(`insert into public.subjects (institute_id, class_id, name, code) values ($1, $2, $3, $4) returning id`, [inst, classId[c.key], name, code]))!.id;
      }
      structId[c.key] = (await db.one<{ id: string }>(
        `insert into public.fee_structures (institute_id, class_id, name, fee_type, category, total_amount, installments, default_due_day, discount_eligible, late_fee_applicable, description)
         values ($1, $2, $3, $4, 'tuition', $5, $6, 10, true, true, $7) returning id`,
        [inst, classId[c.key], `${c.name} – Annual Tuition 2026-27`, c.feeType, c.fee, c.inst, `₹${c.fee.toLocaleString("en-IN")} per year, paid ${c.feeType === "monthly" ? "monthly (June–March)" : "quarterly"}`],
      ))!.id;
    }
    const admissionStruct = (await db.one<{ id: string }>(
      `insert into public.fee_structures (institute_id, name, fee_type, category, total_amount, installments, default_due_day, discount_eligible, late_fee_applicable, description)
       values ($1, 'Admission & Registration Fee', 'course', 'admission', 1500, 1, 10, false, false, 'One-time, payable at admission') returning id`,
      [inst],
    ))!.id;
    const sibling = (await db.one<{ id: string }>(`insert into public.discounts (institute_id, name, discount_type, value, description) values ($1, 'Sibling Discount', 'percent', 10, '10% off tuition for the second child') returning id`, [inst]))!.id;
    const merit = (await db.one<{ id: string }>(`insert into public.discounts (institute_id, name, discount_type, value, is_scholarship, description) values ($1, 'Merit Scholarship', 'fixed', 5000, true, 'For students scoring 90%+ in the previous board/annual exam') returning id`, [inst]))!.id;

    // Teachers (+ logins for two of them)
    const teacherId: Record<string, string> = {};
    let tPhone = 0;
    for (const t of TEACHERS) {
      const email = `${slug(t.name)}@example.com`;
      const ph = `98790${String(41001 + tPhone++ * 37)}`;
      const subjIds = CLASSES.flatMap((c) => t.subjects.map((s) => subjectId[c.key][s]).filter(Boolean));
      teacherId[t.name] = (await db.one<{ id: string }>(
        `insert into public.teachers (institute_id, full_name, phone, email, address, qualification, specialization, subject_ids, joining_date, employment_status, monthly_salary)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10) returning id`,
        [inst, t.name, ph, email, `${pick(SOCIETIES)}, ${pick(AREAS)}, Ahmedabad`, t.qual, t.spec, subjIds, t.joined, t.salary],
      ))!.id;
    }
    // Teacher → subject lookup for timetable
    const teacherFor = (subject: string) => TEACHERS.find((t) => t.subjects.includes(subject))!.name;

    // Batches, assignments, timetable
    const batchIds: { def: BatchDef; id: string }[] = [];
    for (const b of BATCHES) {
      const c = CLASSES.find((x) => x.key === b.cls)!;
      const id = (await db.one<{ id: string }>(
        `insert into public.batches (institute_id, class_id, academic_year_id, name, start_date, end_date, class_days, start_time, end_time, capacity, room)
         values ($1, $2, $3, $4, '2026-06-08', '2027-03-15', $5, $6, $7, $8, $9) returning id`,
        [inst, classId[b.cls], year, b.name, b.days, b.start, b.end, b.capacity, b.room],
      ))!.id;
      batchIds.push({ def: b, id });
      const subjects = c.subjects.map(([s]) => s);
      for (const s of subjects) await db.q(`insert into public.batch_subjects (institute_id, batch_id, subject_id) values ($1, $2, $3)`, [inst, id, subjectId[b.cls][s]]);
      for (const tn of [...new Set(subjects.map(teacherFor))]) {
        await db.q(`insert into public.teacher_batches (institute_id, teacher_id, batch_id, start_date) values ($1, $2, $3, '2026-06-08')`, [inst, teacherId[tn], id]);
      }
      // One subject per class day, rotating; skip any slot that would double-book a teacher or room.
      for (const [i, day] of b.days.entries()) {
        for (let k = 0; k < subjects.length; k++) {
          const s = subjects[(i + k) % subjects.length];
          const ok = await savepoint(db, () =>
            db.q(
              `insert into public.timetable (institute_id, academic_year_id, batch_id, subject_id, teacher_id, day_of_week, start_time, end_time, room, effective_from)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-06-08')`,
              [inst, year, id, subjectId[b.cls][s], teacherId[teacherFor(s)], day, b.start, b.end, b.room],
            ),
          );
          if (ok) break;
        }
      }
    }

    // Students via admit_student (guardians, batch enrolment, fees)
    type Admitted = { id: string; name: string; batch: string; cls: string; admission: string };
    const admitted: Admitted[] = [];
    const families: { father: string; phone: string; email: string; surname: string; area: string; society: string }[] = [];
    const usedNames = new Set<string>();
    let n = 0;
    for (const { def, id: batchId } of batchIds) {
      const c = CLASSES.find((x) => x.key === def.cls)!;
      for (let i = 0; i < def.students; i++, n++) {
        // Two sibling pairs share a family (and get the sibling discount).
        const siblingOf = (n === 12 || n === 31) && families.length > 3 ? families[n === 12 ? 1 : 5] : null;
        const fam = siblingOf ?? (() => {
          const surname = pick(SURNAMES);
          const father = pick(FATHERS);
          const f = { father: `${father} ${surname}`, phone: phone(), email: `${slug(father)}.${slug(surname)}${between(1, 99)}@example.com`, surname, area: pick(AREAS), society: pick(SOCIETIES) };
          families.push(f);
          return f;
        })();
        const girl = rand() < 0.48;
        let first = pick(girl ? GIRLS : BOYS);
        while (usedNames.has(`${first} ${fam.surname}`)) first = pick(girl ? GIRLS : BOYS);
        const fullName = `${first} ${fam.surname}`;
        usedNames.add(fullName);
        const admission = rand() < 0.8 ? addDays("2026-06-01", between(0, 28)) : addDays("2026-07-01", between(0, 40));
        const dob = `${c.dob}-${String(between(1, 12)).padStart(2, "0")}-${String(between(1, 28)).padStart(2, "0")}`;
        const mother = `${pick(MOTHERS)} ${fam.surname}`;
        const discount = siblingOf ? sibling : n % 13 === 4 ? merit : null;
        const r = await db.one<{ r: { student_id: string; admission_no: string } }>(`select public.admit_student($1) as r`, [
          JSON.stringify({
            student: {
              full_name: fullName, date_of_birth: dob, gender: girl ? "female" : "male", blood_group: pick(BLOOD),
              address: `${between(1, 120)}, ${fam.society}, ${fam.area}`, city: "Ahmedabad", state: "Gujarat", pin_code: `3800${between(10, 61)}`,
              phone: Number(c.key) >= 10 && rand() < 0.6 ? phone() : null,
              email: Number(c.key) >= 11 ? `${slug(first)}.${slug(fam.surname)}${between(10, 99)}@example.com` : null,
              school_name: pick(SCHOOLS), class_id: classId[def.cls], academic_year_id: year,
              subject_ids: c.subjects.map(([s]) => subjectId[def.cls][s]), admission_date: admission,
              previous_academics: `Scored ${between(68, 96)}% in Std ${Number(c.key) - 1}`,
            },
            guardians: [
              { full_name: fam.father, phone: fam.phone, email: fam.email, relationship: "father", is_primary: true, is_emergency_contact: true },
              { full_name: mother, phone: phone(), relationship: "mother", is_primary: false, is_emergency_contact: false },
            ],
            batch_ids: [batchId],
            fees: [
              { fee_structure_id: structId[def.cls], start_date: "2026-06-01", due_day: 10, ...(discount ? { discount_id: discount, discount_reason: discount === sibling ? "Sibling studying in the institute" : "Merit scholarship – previous year result" } : {}) },
              { fee_structure_id: admissionStruct, start_date: admission },
            ],
          }),
        ]);
        admitted.push({ id: r!.r.student_id, name: fullName, batch: batchId, cls: def.cls, admission });
      }
    }

    // A discontinued student and one on hold (history looks real).
    await db.q(`select public.change_student_status($1, 'discontinued', 'Family relocated to Surat')`, [admitted[admitted.length - 1].id]);
    await db.q(`select public.change_student_status($1, 'on_hold', 'Medical leave – will resume after Diwali')`, [admitted[5].id]);

    return { year, classId, subjectId, batchIds, admitted, teacherId };
  });

  // Logins first, so payment/attendance/result notifications reach real accounts.
  const logins = await createLogins(inst, setup.teacherId);

  // ---------- Day-to-day activity as the admin ----------
  const summary = await asUser(adminId, async (db) => {
    const { year, classId, subjectId, batchIds, admitted, teacherId } = setup;

    // ---------- Payments ----------
    const methods = ["upi", "upi", "upi", "cash", "cash", "bank_transfer", "cheque"] as const;
    let payments = 0;
    for (const [i, s] of admitted.entries()) {
      // Most families are up to date; some are 1–2 installments behind; a few paid part.
      const behind = i % 7 === 3 ? 2 : i % 5 === 1 ? 1 : 0;
      const obls = await db.q<{ id: string; due_date: string; balance: number }>(
        `select id, due_date, (net_amount - amount_paid) as balance from public.fee_obligations where student_id = $1 and status in ('unpaid', 'partially_paid') and due_date <= $2 order by due_date`,
        [s.id, TODAY],
      );
      const toPay = obls.slice(0, Math.max(0, obls.length - behind));
      for (const [k, o] of toPay.entries()) {
        const method = pick([...methods]);
        const partial = i % 11 === 6 && k === toPay.length - 1;
        const amount = partial ? Math.round(Number(o.balance) / 2) : Number(o.balance);
        const date = minDate(TODAY, addDays(o.due_date < s.admission ? s.admission : o.due_date, between(-6, 4)));
        const ref = method === "upi" ? `UPI${between(400000000, 499999999)}${between(100, 999)}` : method === "bank_transfer" ? `NEFT${between(10000000, 99999999)}` : method === "cheque" ? `CHQ ${between(100000, 999999)} (HDFC Bank)` : "";
        await db.q(`select public.record_payment($1, $2, $3, $4, $5, $6, $7, $8)`, [s.id, amount, date, method, ref, "", [o.id], `seed-${s.id}-${k}`]);
        payments++;
      }
    }

    // ---------- Class sessions & attendance (last 5 weeks) ----------
    const from = addDays(TODAY, -35);
    await db.q(`select public.generate_class_sessions($1, $2)`, [from, addDays(TODAY, 14)]);
    // Diwali break: cancel sessions in that window.
    await db.q(`update public.class_sessions set status = 'cancelled', cancel_reason = 'Diwali vacation' where institute_id = $1 and session_date between '2026-11-07' and '2026-11-11'`, [inst]);
    const sessions = await db.q<{ id: string; batch_id: string; session_date: string }>(
      `select id, batch_id, session_date from public.class_sessions where institute_id = $1 and status <> 'cancelled' and session_date < $2 order by session_date`,
      [inst, TODAY],
    );
    const regulars = new Map<string, number>(); // per-student attendance tendency
    for (const s of admitted) regulars.set(s.id, 0.8 + rand() * 0.18);
    let marked = 0;
    for (const sess of sessions) {
      const roster = await db.q<{ student_id: string }>(
        `select sb.student_id from public.student_batches sb join public.students st on st.id = sb.student_id
          where sb.batch_id = $1 and sb.status = 'active' and sb.start_date <= $2 and st.status = 'active'`,
        [sess.batch_id, sess.session_date],
      );
      if (!roster.length) continue;
      const records = roster.map((r) => {
        const p = rand();
        const reg = regulars.get(r.student_id) ?? 0.9;
        const status = p < reg ? "present" : p < reg + 0.04 ? "late" : p < reg + 0.07 ? "excused" : "absent";
        return { student_id: r.student_id, status, remarks: status === "excused" ? pick(["Fever", "Family function", "School exam"]) : null };
      });
      await db.q(`select public.submit_attendance($1, $2, null)`, [sess.id, JSON.stringify(records)]);
      marked++;
    }

    // ---------- Examinations ----------
    const exams: { batch: string; cls: string; name: string; type: string; date: string; subjects: string[]; max: number; publish: boolean }[] = [];
    for (const { def, id } of batchIds) {
      const subs = CLASSES.find((c) => c.key === def.cls)!.subjects.map(([s]) => s);
      exams.push({ batch: id, cls: def.cls, name: "Unit Test 1", type: "unit_test", date: "2026-08-24", subjects: subs.slice(0, 3), max: 25, publish: true });
      exams.push({ batch: id, cls: def.cls, name: "Unit Test 2", type: "unit_test", date: "2026-10-12", subjects: subs.slice(0, 3), max: 50, publish: true });
      exams.push({ batch: id, cls: def.cls, name: "Half-Yearly Examination", type: "half_yearly", date: "2026-12-07", subjects: subs, max: 80, publish: false });
    }
    let published = 0;
    for (const e of exams) {
      const examId = (await db.one<{ id: string }>(
        `insert into public.examinations (institute_id, name, batch_id, class_id, academic_year_id, exam_type, start_date, end_date, result_publish_date, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [inst, e.name, e.batch, classId[e.cls], year, e.type, e.date, addDays(e.date, e.publish ? 1 : 5), addDays(e.date, e.publish ? 7 : 14), e.publish ? "marks_entry" : "scheduled", adminId],
      ))!.id;
      for (const [k, s] of e.subjects.entries()) {
        const esId = (await db.one<{ id: string }>(
          `insert into public.examination_subjects (institute_id, examination_id, subject_id, exam_date, max_marks, passing_marks) values ($1, $2, $3, $4, $5, $6) returning id`,
          [inst, examId, subjectId[e.cls][s], addDays(e.date, e.publish ? 0 : k), e.max, Math.round(e.max * 0.35)],
        ))!.id;
        if (!e.publish) continue;
        const roster = await db.q<{ student_id: string }>(`select student_id from public.student_batches where batch_id = $1 and status = 'active'`, [e.batch]);
        for (const r of roster) {
          const ability = regulars.get(r.student_id) ?? 0.85;
          const absent = rand() < 0.03;
          const pct = Math.min(1, Math.max(0.2, ability - 0.1 + (rand() - 0.5) * 0.35));
          await db.q(
            `insert into public.marks (institute_id, examination_subject_id, student_id, obtained_marks, is_absent, entered_by) values ($1, $2, $3, $4, $5, $6)`,
            [inst, esId, r.student_id, absent ? null : Math.round(pct * e.max * 2) / 2, absent, adminId],
          );
        }
      }
      if (e.publish) {
        await db.q(`select public.publish_examination($1, null)`, [examId]);
        published++;
      }
    }

    // ---------- Homework ----------
    const HW: Record<string, [string, string][]> = {
      Mathematics: [["Exercise 3.2 – Pair of Linear Equations", "Solve Q1–Q12 in your notebook. Show all steps."], ["Trigonometry worksheet", "Complete the worksheet shared in class (identities, Q1–20)."]],
      Science: [["Chapter 6 – Life Processes: question bank", "Answer the textbook back exercise and draw the labelled diagram of the human heart."], ["Acids, Bases and Salts – activity report", "Write up the litmus activity done in class."]],
      English: [["Letter writing – complaint letter", "Write a formal letter to the Municipal Commissioner about waterlogging in your area (150 words)."]],
      "Social Science": [["Map work – Indian rivers", "Mark the major rivers and dams on the outline map."]],
      Physics: [["Kinematics – DPP 4", "Daily practice problems 1–15. Bring doubts to Thursday's class."]],
      Chemistry: [["Mole concept – numericals", "Solve the 20 numericals from the module (Level 1 and 2)."]],
      Biology: [["Cell: the unit of life – diagrams", "Practise the labelled diagrams of plant and animal cells."]],
      Gujarati: [["નિબંધ લેખન – મારો પ્રિય તહેવાર", "250 શબ્દોમાં નિબંધ લખો."]],
    };
    let hwCount = 0;
    for (const { def, id } of batchIds) {
      const subs = CLASSES.find((c) => c.key === def.cls)!.subjects.map(([s]) => s);
      const roster = await db.q<{ student_id: string }>(`select student_id from public.student_batches where batch_id = $1 and status = 'active'`, [id]);
      for (const [k, s] of subs.slice(0, 3).entries()) {
        for (const [j, [title, desc]] of (HW[s] ?? []).entries()) {
          const assigned = addDays(TODAY, -(18 - k * 5 - j * 3));
          const due = addDays(assigned, 4);
          const hw = (await db.one<{ id: string }>(
            `insert into public.homework (institute_id, batch_id, subject_id, title, description, assigned_date, due_at, is_published, submission_enabled, created_by)
             values ($1, $2, $3, $4, $5, $6, ($7::date + time '23:59:59') at time zone 'Asia/Kolkata', true, false, $8) returning id`,
            [inst, id, subjectId[def.cls][s], title, desc, assigned, due, adminId],
          ))!.id;
          hwCount++;
          if (due < TODAY) {
            for (const r of roster) {
              const p = rand();
              const status = p < 0.78 ? "reviewed" : p < 0.9 ? "resubmission_required" : "pending";
              await db.q(
                `insert into public.homework_submissions (institute_id, homework_id, student_id, status, feedback, reviewed_by, reviewed_at) values ($1, $2, $3, $4, $5, $6, now())`,
                [inst, hw, r.student_id, status, status === "resubmission_required" ? "Incomplete – please finish the remaining questions" : status === "pending" ? "Not submitted" : pick([null, "Good work", "Neat presentation", null]), adminId],
              );
            }
          }
        }
      }
    }

    // ---------- Study materials (small PDFs) ----------
    const MATERIALS: [string, string, string, string[]][] = [
      ["10", "Mathematics", "Trigonometry – Formula Sheet", ["sin^2 A + cos^2 A = 1", "1 + tan^2 A = sec^2 A", "1 + cot^2 A = cosec^2 A", "sin(90 - A) = cos A,  cos(90 - A) = sin A"]],
      ["10", "Science", "Chemical Reactions – Chapter Notes", ["Types: combination, decomposition, displacement, double displacement", "Oxidation = gain of oxygen / loss of hydrogen", "Reduction = loss of oxygen / gain of hydrogen", "Corrosion and rancidity – causes and prevention"]],
      ["10", "English", "Board Exam Writing Formats", ["Formal letter: sender, date, receiver, subject, salutation, body, closing", "Notice: name of institution, NOTICE, date, heading, body, name & designation", "Report writing: headline, byline, place & date, body"]],
      ["12", "Physics", "Electrostatics – Important Derivations", ["Electric field due to a dipole (axial and equatorial)", "Gauss's law – infinite line charge, plane sheet, spherical shell", "Capacitance of a parallel plate capacitor with dielectric"]],
      ["12", "Chemistry", "Solutions – Numericals Practice Set", ["Molarity, molality and mole fraction – 10 problems", "Raoult's law and relative lowering of vapour pressure", "Elevation of boiling point and depression of freezing point"]],
      ["11", "Biology", "Cell Structure – Revision Notes", ["Prokaryotic vs eukaryotic cells", "Cell organelles and their functions", "Cell membrane: fluid mosaic model"]],
      ["9", "Mathematics", "Number Systems – Practice Worksheet", ["Rational and irrational numbers", "Representing real numbers on the number line", "Laws of exponents for real numbers"]],
      ["8", "Science", "Force and Pressure – Quick Notes", ["Force: push or pull; effects of force", "Contact and non-contact forces", "Pressure = Force / Area; atmospheric pressure"]],
    ];
    for (const [cls, s, title, lines] of MATERIALS) {
      const path = `${inst}/materials/${Date.now()}-${slug(title).replace(/\./g, "-")}.pdf`;
      const buf = pdf(title, ["Shree Vidya Coaching Classes", "", ...lines]);
      await putFile("files", path, buf);
      await db.q(
        `insert into public.study_materials (institute_id, title, description, class_id, subject_id, file_path, mime_type, size_bytes, visibility, uploaded_by, is_active, created_at)
         values ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, 'class', $8, true, now() - make_interval(days => $9))`,
        [inst, title, `${s} · ${CLASSES.find((c) => c.key === cls)!.name}`, classId[cls], subjectId[cls][s], path, buf.length, adminId, between(1, 40)],
      );
    }

    // ---------- Announcements ----------
    await db.q(
      `insert into public.announcements (institute_id, title, body, audience, is_important, created_by, created_at) values
       ($1, 'Half-Yearly Examination timetable', 'Half-yearly exams for all batches begin on 7 December. The detailed timetable is on the notice board and in the app.', 'all', true, $2, now() - interval '3 days'),
       ($1, 'Diwali vacation', 'The institute will remain closed from 7 to 11 November for Diwali. Classes resume on 12 November. Happy Diwali!', 'all', false, $2, now() - interval '15 days'),
       ($1, 'Parent–teacher meeting', 'PTM for Std 10 and Std 12 parents on Sunday 23 November, 10:00 AM to 1:00 PM.', 'students_parents', true, $2, now() - interval '1 day'),
       ($1, 'Staff meeting', 'All faculty: syllabus completion review on Saturday at 1:30 PM in Room 2.', 'staff', false, $2, now() - interval '2 days')`,
      [inst, adminId],
    );

    // ---------- Expenses, other income, teacher attendance ----------
    const cat = async (name: string) => (await db.one<{ id: string }>(`select id from public.expense_categories where institute_id = $1 and name = $2`, [inst, name]))!.id;
    const incCat = (await db.one<{ id: string }>(`select id from public.income_categories where institute_id = $1 and name = 'Study Material Charges'`, [inst]))!.id;
    for (const m of ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]) {
      const d = `${m}-05`;
      if (d > TODAY) break;
      await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, $3, 42000, $4, 'bank_transfer', 'Shivalik Plaza Owners Association', $5)`, [inst, await cat("Rent"), `Office rent – ${m}`, d, adminId]);
      await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, $3, $4, $5, 'upi', 'Torrent Power', $6)`, [inst, await cat("Electricity"), `Electricity bill – ${m}`, between(5200, 8900), addDays(d, 10), adminId]);
      await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, $3, 1499, $4, 'upi', 'JioFiber', $5)`, [inst, await cat("Internet"), `Internet – ${m}`, addDays(d, 2), adminId]);
      if (`${m}-01` < TODAY.slice(0, 7) + "-01") {
        for (const t of TEACHERS) {
          await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, $3, $4, $5, 'bank_transfer', $6, $7)`, [inst, await cat("Teacher Salary"), `Salary – ${m}`, t.salary, addDays(`${m}-01`, 31 + 1), t.name, adminId]);
        }
      }
    }
    await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, 'Whiteboards and markers', 8600, '2026-06-03', 'cash', 'Navneet Stationers', $3)`, [inst, await cat("Stationery"), adminId]);
    await db.q(`insert into public.expenses (institute_id, category_id, title, amount, payment_date, method, paid_to, recorded_by) values ($1, $2, 'Admission season pamphlets & Instagram ads', 15000, '2026-05-25', 'upi', 'PrintHub Ahmedabad', $3)`, [inst, await cat("Marketing"), adminId]);
    await db.q(`insert into public.income_entries (institute_id, category_id, title, amount, received_date, method, recorded_by) values ($1, $2, 'Std 10 practice paper booklets (35 sets)', 10500, '2026-09-15', 'cash', $3)`, [inst, incCat, adminId]);
    for (let d = addDays(TODAY, -14); d < TODAY; d = addDays(d, 1)) {
      if (new Date(d + "T00:00:00Z").getUTCDay() === 0 || (d >= "2026-11-07" && d <= "2026-11-11")) continue;
      for (const t of TEACHERS) {
        const p = rand();
        await db.q(`insert into public.teacher_attendance (institute_id, teacher_id, attendance_date, status, remarks, marked_by) values ($1, $2, $3, $4, $5, $6)`, [
          inst, teacherId[t.name], d, p < 0.9 ? "present" : p < 0.95 ? "late" : "leave", p >= 0.95 ? "Casual leave" : null, adminId,
        ]);
      }
    }

    return { admitted, payments, marked, published, hwCount };
  });


  console.log(`\nDone: ${summary.admitted.length} students, ${TEACHERS.length} teachers, ${BATCHES.length} batches, ${summary.payments} payments,`);
  console.log(`      ${summary.marked} attendance sessions, ${summary.published} published exams, ${summary.hwCount} homework.\n`);
  console.log("Logins:");
  console.log(`  Admin                 ${ADMIN.email.padEnd(40)} ${ADMIN.password}`);
  for (const l of logins) console.log(`  ${l.role.padEnd(21)} ${l.email.padEnd(40)} ${DEMO_PASSWORD}   (${l.name})`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
