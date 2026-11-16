# Tuition API (Express + Neon Postgres)

Backend for `../tuition-management` (Next.js). Only the Next.js server calls this API.

## Run
```bash
npm install
npm run db:migrate   # apply db/migrations/*.sql to Neon (DIRECT_URL)
npm run db:test      # SQL business-rule tests (rolls back)
npm run db:seed      # demo data (empty DB only); add -- --reset to wipe and re-seed a DEMO database
npm run dev          # http://localhost:4000
```

Demo logins after seeding: `admin@example.com` / `Admin@1234`; teachers, parents and students use `Demo@1234`
(the seed prints the list).

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
