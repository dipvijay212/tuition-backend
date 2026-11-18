import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "./env.js";
import { forbidden, HttpError, unauthorized } from "./lib/errors.js";
import type { AppRole, Feature, SessionContext } from "./auth/context.js";
import { resolveSession } from "./auth/sessions.js";

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

/** Loads the signed-in user (session token -> context) in a single query (cached for a few seconds). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const s = await resolveSession(bearer(req));
  if (!s) return next(unauthorized());
  req.ctx = s.ctx;
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

/** Platform staff (super admin) only. */
export function requirePlatform(req: Request, _res: Response, next: NextFunction) {
  if (!req.ctx) return next(unauthorized());
  if (!req.ctx.platform) return next(forbidden());
  next();
}

// Plan features gate whole route groups. Paths are as seen by the app (full path).
const FEATURE_ROUTES: [prefix: string, feature: Feature][] = [
  ["/exams", "exams"],
  ["/family/results", "exams"],
  ["/learning/homework", "homework"],
  ["/family/homework", "homework"],
  ["/learning/materials", "materials"],
  ["/family/materials", "materials"],
];
// Writes still allowed while the subscription is expired (read-only mode).
const READ_ONLY_ALLOWED = ["/notifications"];
const startsWith = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");

export const SUSPENDED_MESSAGE = "This institute's account has been suspended. Please contact support.";
export const EXPIRED_MESSAGE = "Your subscription has expired, so the account is read-only. Please renew your plan to make changes.";

/**
 * Institute sessions only, with subscription rules:
 *  - suspended institute: blocked
 *  - expired subscription: read-only (GET only)
 *  - features not in the plan: blocked
 * Everything here is in memory (the context already holds the subscription), so it costs nothing per request.
 */
export function requireTenant(req: Request, _res: Response, next: NextFunction) {
  const c = req.ctx;
  if (!c) return next(unauthorized());
  if (c.platform) return next(forbidden("Platform accounts cannot use institute pages."));
  const sub = c.subscription;
  if (!c.institute || !sub) return next(forbidden());
  if (sub.access === "suspended") return next(new HttpError(403, SUSPENDED_MESSAGE));
  const path = req.path;
  const feature = FEATURE_ROUTES.find(([p]) => startsWith(path, p))?.[1];
  if (feature && !sub.features.includes(feature)) {
    return next(new HttpError(403, `This feature (${feature}) is not included in your plan. Please upgrade to use it.`));
  }
  if (sub.readOnly && req.method !== "GET" && req.method !== "HEAD" && !READ_ONLY_ALLOWED.some((p) => startsWith(path, p))) {
    return next(new HttpError(402, EXPIRED_MESSAGE));
  }
  next();
}

export function ctxOf(req: Request): SessionContext & { institute: NonNullable<SessionContext["institute"]> } {
  const c = req.ctx;
  if (!c) throw unauthorized();
  if (!c.institute) throw forbidden();
  return c as SessionContext & { institute: NonNullable<SessionContext["institute"]> };
}
