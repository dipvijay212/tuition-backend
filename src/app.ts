import express from "express";
import { errorHandler, notFound } from "./lib/errors.js";
import { authenticate, requireInternalKey } from "./middleware.js";
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { notificationsRouter } from "./routes/notifications.js";
import { academicsRouter } from "./routes/academics.js";
import { batchesRouter } from "./routes/batches.js";
import { teachersRouter } from "./routes/teachers.js";
import { studentsRouter } from "./routes/students.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(requireInternalKey);
  app.use("/auth", authRouter);
  app.use("/files", filesRouter); // signed URLs; no session needed

  // Everything below requires a signed-in user.
  app.use(authenticate);
  app.use("/notifications", notificationsRouter);
  app.use("/academics", academicsRouter);
  app.use("/batches", batchesRouter);
  app.use("/teachers", teachersRouter);
  app.use("/students", studentsRouter);

  app.use((_req, _res, next) => next(notFound("Unknown API route.")));
  app.use(errorHandler);
  return app;
}
