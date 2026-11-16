import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public fieldErrors?: Record<string, string[]>) {
    super(message);
  }
}
export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "Your session has expired. Please sign in again.") => new HttpError(401, m);
export const forbidden = (m = "You do not have permission to do this.") => new HttpError(403, m);
export const notFound = (m = "Not found.") => new HttpError(404, m);

type PgError = { code?: string; message?: string; detail?: string; constraint?: string };

/** Turn Postgres errors into messages a person can act on (ported from the Next app). */
export function friendlyPgError(e: PgError): { status: number; message: string } | null {
  if (!e?.code || typeof e.code !== "string" || e.code.length !== 5) return null;
  const msg = (e.message ?? "") + " " + (e.detail ?? "") + " " + (e.constraint ?? "");
  switch (e.code) {
    case "23505":
      if (/admission_no/.test(msg)) return { status: 409, message: "This admission number is already in use." };
      if (/phone/.test(msg)) return { status: 409, message: "This mobile number is already registered." };
      if (/student_batches_active_unique/.test(msg)) return { status: 409, message: "The student is already in this batch." };
      if (/attendance/.test(msg)) return { status: 409, message: "Attendance for this student and session already exists." };
      if (/marks/.test(msg)) return { status: 409, message: "Marks for this student and subject already exist." };
      if (/email/.test(msg)) return { status: 409, message: "This email address is already registered." };
      return { status: 409, message: "A record with these details already exists." };
    case "23503":
      return { status: 409, message: "This record is linked to other data and cannot be changed this way." };
    case "23514":
      return { status: 400, message: "Some values are not allowed. Please check amounts, dates and required fields." };
    case "23P01":
      return { status: 409, message: (e.message ?? "").replace(/^ERROR:\s*/, "") || "This conflicts with an existing record." };
    case "42501":
      return { status: 403, message: "You do not have permission to do this." };
    case "22P02":
      return { status: 400, message: "One of the values has an invalid format." };
    case "P0001": // our own RAISE EXCEPTION messages are written for people already
      return { status: 400, message: (e.message ?? "").replace(/^ERROR:\s*/, "") };
    default:
      return null;
  }
}

export function zodFieldErrors(err: ZodError) {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) (out[issue.path.join(".") || "_"] ??= []).push(issue.message);
  return out;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  void _next;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, fieldErrors: err.fieldErrors });
    return;
  }
  if (err instanceof ZodError) {
    res.status(422).json({ error: err.issues[0]?.message ?? "Invalid input.", fieldErrors: zodFieldErrors(err) });
    return;
  }
  const pg = friendlyPgError(err as PgError);
  if (pg) {
    res.status(pg.status).json({ error: pg.message });
    return;
  }
  if ((err as { type?: string }).type === "entity.too.large") {
    res.status(413).json({ error: "The request is too large." });
    return;
  }
  console.error("[api] unhandled error", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
};
