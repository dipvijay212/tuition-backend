import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "./env.js";
import { forbidden, HttpError, unauthorized } from "./lib/errors.js";
import { loadSessionContext, type AppRole, type SessionContext } from "./auth/context.js";
import { validateSession } from "./auth/sessions.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: SessionContext;
      sessionId?: string;
    }
  }
}

/** Only the Next.js server (which holds API_INTERNAL_KEY) may call the API. */
export function requireInternalKey(req: Request, _res: Response, next: NextFunction) {
  const given = Buffer.from(req.get("x-internal-key") ?? "");
  const expected = Buffer.from(env.internalKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return next(new HttpError(401, "Unauthorized client."));
  next();
}

export const bearer = (req: Request) => req.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";

/** Loads the signed-in user (session token -> context). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const s = await validateSession(bearer(req));
  if (!s) return next(unauthorized());
  const ctx = await loadSessionContext(s.userId);
  if (!ctx) return next(unauthorized());
  req.ctx = ctx;
  req.sessionId = s.sessionId;
  next();
}

/** Active account with one of the roles (and an institute). */
export function requireRole(...allowed: AppRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const c = req.ctx;
    if (!c) return next(unauthorized());
    if (c.profile.status !== "active" || !c.institute || !c.roles.some((r) => allowed.includes(r))) return next(forbidden());
    next();
  };
}

export function ctxOf(req: Request): SessionContext & { institute: NonNullable<SessionContext["institute"]> } {
  const c = req.ctx;
  if (!c) throw unauthorized();
  if (!c.institute) throw forbidden();
  return c as SessionContext & { institute: NonNullable<SessionContext["institute"]> };
}
