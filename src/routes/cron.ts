import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { env } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { runFeeJob } from "../jobs/fee-reminders.js";

/** Endpoints for an external scheduler (e.g. a daily cron). Send the CRON_SECRET as `x-cron-secret` or `Authorization: Bearer`. */
export const cronRouter = Router();

function assertCron(req: Request) {
  const given = Buffer.from(req.get("x-cron-secret") ?? req.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "");
  const expected = Buffer.from(env.cronSecret);
  if (!env.cronSecret || env.cronSecret === "change-me" || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, "Unauthorized.");
  }
}

cronRouter.all("/fee-reminders", async (req, res) => {
  assertCron(req);
  res.json(await runFeeJob());
});
