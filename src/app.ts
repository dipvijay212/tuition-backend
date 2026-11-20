import express from "express";
import { errorHandler, notFound } from "./lib/errors.js";
import { authenticate, requireInternalKey, requireTenant } from "./middleware.js";
import { platformRouter } from "./routes/platform.js";
import { subscriptionRouter } from "./routes/subscription.js";
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { notificationsRouter } from "./routes/notifications.js";
import { academicsRouter } from "./routes/academics.js";
import { batchesRouter } from "./routes/batches.js";
import { teachersRouter } from "./routes/teachers.js";
import { studentsRouter } from "./routes/students.js";
import { familyRouter } from "./routes/family.js";
import { attendanceRouter } from "./routes/attendance.js";
import { timetableRouter } from "./routes/timetable.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { usersRouter } from "./routes/users.js";
import { settingsRouter } from "./routes/settings.js";
import { feesRouter } from "./routes/fees.js";
import { examsRouter } from "./routes/exams.js";
import { learningRouter } from "./routes/learning.js";
import { cronRouter } from "./routes/cron.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Scheduled jobs (external cron); protected by CRON_SECRET, not the internal key.
  app.use("/cron", cronRouter);

  app.use(requireInternalKey);
  app.use("/auth", authRouter);
  app.use("/files", filesRouter); // signed URLs; no session needed

  // Everything below requires a signed-in user.
  app.use(authenticate);
  app.use("/platform", platformRouter); // platform staff only

  // Institute (tenant) API: suspended institutes are blocked, expired subscriptions are read-only,
  // and plan features gate their route groups. Data isolation is also enforced by Postgres RLS.
  app.use(requireTenant);
  app.use("/subscription", subscriptionRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/academics", academicsRouter);
  app.use("/batches", batchesRouter);
  app.use("/teachers", teachersRouter);
  app.use("/students", studentsRouter);
  app.use("/family", familyRouter);
  app.use("/attendance", attendanceRouter);
  app.use("/timetable", timetableRouter);
  app.use("/dashboard", dashboardRouter);
  app.use("/users", usersRouter);
  app.use("/settings", settingsRouter);
  app.use("/fees", feesRouter);
  app.use("/exams", examsRouter);
  app.use("/learning", learningRouter);

  app.use((_req, _res, next) => next(notFound("Unknown API route.")));
  app.use(errorHandler);
  return app;
}
