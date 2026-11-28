# Tuition API (Express + Neon Postgres)

Backend for `../tuition-management` (Next.js). Only the Next.js server calls this API.

## Run
```bash
npm install
npm run db:migrate   # apply db/migrations/*.sql to Neon (DIRECT_URL)
npm run db:test      # SQL business-rule tests (rolls back)
npm run db:seed      # demo data (empty DB only); add -- --reset to wipe and re-seed a DEMO database
npm run dev          # http://localhost:4000
npm run platform:admin -- --email you@company.com --name "Your Name" --password 'Strong@123'   # super admin
```

Demo logins after seeding: institute code **`DEMO2026`**, `admin@example.com` / `Admin@1234`; teachers, parents and
students use `Demo@1234` (the seed prints the list).

## Env (`.env`)
`DATABASE_URL` (pooled), `DIRECT_URL` (direct, migrations), `API_INTERNAL_KEY` (same value in the Next app's `.env`),
`SITE_URL` (frontend URL used in email links), `SMTP_*`, `STORAGE_DIR`, `PORT`. See `.env.example`.

## How it works
- **Auth**: own `auth.users` (bcrypt), opaque revocable sessions in `auth.sessions`, single-use email links in `auth.one_time_tokens`.
  Next.js keeps the session token in an httpOnly cookie and forwards it as `Authorization: Bearer`.
- **Authorization**: done in Express route handlers (`requireRole` + query filters).
- **Database safety net**: user requests run as role `app_api` with `app.user_id` set, so `auth.uid()` works in the
  SQL business functions, and money/history tables can only be written by those functions.
- **Files**: stored on local disk under `STORAGE_DIR` (`src/lib/storage.ts`). Private files are served through short-lived
  signed URLs proxied by the Next.js route `/api/files/...`. Swap that one module to move to S3/R2.
- **Routes**: one router per feature in `src/routes/` (auth, academics, batches, teachers, students, family, attendance,
  timetable, exams, fees, learning, notifications, settings, users, dashboard, files).

## Multi-institute SaaS (migration `0013_saas.sql`)
- **Institutes** each have a unique **code** (4–12 letters/digits). People sign in with *institute code + mobile/email +
  password*. Phone numbers are only resolved inside that institute.
- **One login, many institutes**: `auth.users` is global (one email = one person). `memberships (user_id, institute_id,
  status)` holds access per institute; roles stay in `user_roles`. Suspending someone in one institute never affects another.
  `teachers/students/guardians.profile_id` are unique per institute, so the same parent can be linked at two tuitions.
- **Sessions are bound to one institute** (`auth.sessions.institute_id`). `POST /auth/switch` moves a session to another
  institute the user belongs to. `asUser(ctx, …)` sets `app.institute_id`; `auth_institute_id()` returns it only for an
  active member of an active institute.
- **Row Level Security** on every table with `institute_id` (role `app_api`): even a query with a missing `WHERE institute_id`
  cannot see or write another institute's rows. Owner/system work (`asSystem`, SQL business functions) bypasses RLS.
  Tests: `db/tests/tenant_isolation.sql`.
- **Plans and subscriptions** (`plans`, `subscriptions`, `subscription_events`, view `institute_access`). There's no payment gateway:
  platform admins record payments and extend periods by hand. Access: `trial` / `active` / `grace` = full;
  `expired` = **read-only** (API returns 402 for writes); `suspended` = blocked. Plan **limits** (students, teachers,
  batches) are enforced by DB triggers; **storage** quota by `src/lib/storage.ts`; **features** (`exams`, `homework`,
  `materials`) gate route groups in `requireTenant` (`src/middleware.ts`).
- **Self-serve signup**: `POST /auth/register` creates the institute, its admin and a trial on the plan marked
  `is_trial_default`. An existing user can register another institute with the same email by proving their password.
- **Platform admin** (super admin): `platform_admins` table, `POST /auth/platform-login`, API under `/platform`
  (overview, institutes, subscription, renew, suspend, plans). UI at `/platform` in the Next app.
- **Speed**: each request resolves session, profile, membership, roles, institute and subscription in **one query**,
  cached in-process for 10 s (cleared on logout, role/status/plan changes). `asUser` sends begin + role + settings in one
  round trip. RLS policies evaluate the caller's institute once per statement.

## Data integrity (migration `0015_integrity.sql`)
- Every reference between institute tables (batch → class, student → class, timetable → teacher, …) is checked by a
  trigger to point at a row of the **same institute**; `students/teachers.subject_ids` too. Foreign keys and RLS alone
  don't catch an id copied from another institute.
- Attendance can't be recorded for a future date (also for admins), so parents never get false "absent" alerts.
- Uploaded files are written **outside** database transactions (`putFile` uses its own connection for quota bookkeeping).

## Fee reminders & late fees (migration `0016_fee_reminders.sql`, `src/jobs/fee-reminders.ts`)
- Runs inside the API every 30 minutes; sends after `FEE_REMINDER_HOUR` (default 9) in each institute's timezone.
  Per-institute settings decide the days: *days before due*, *on the due date*, *days after due*.
- For each student: in-app notification to the student and linked parents, plus **one email** listing all their due fees
  (only when the institute has email enabled; people who turned off fee-reminder emails are skipped).
- `fee_reminder_log` guarantees each fee gets each reminder **at most once**, even with many runs or several servers.
- Late fees (`apply_late_fees`) are added first, only for institutes that enabled them and fee structures marked late-fee applicable.
- Suspended/expired institutes and inactive students are skipped. Paid fees are never reminded.
- Hosts that sleep: call `POST /cron/fee-reminders` daily with `x-cron-secret: $CRON_SECRET` (or `Authorization: Bearer`).
  `JOBS_DISABLED=true` turns off the in-process schedule.
