import type { Request, RequestHandler } from "express";
import { asUser, type Db } from "../db/pool.js";
import { ctxOf } from "../middleware.js";
import type { SessionContext } from "../auth/context.js";

export type Ctx = SessionContext & { institute: NonNullable<SessionContext["institute"]> };
export type Handler<T> = (x: { req: Request; ctx: Ctx; db: Db; inst: string }) => Promise<T>;

/** Run a handler in a transaction as the signed-in user and send its result as JSON. */
export function h<T>(fn: Handler<T>): RequestHandler {
  return async (req, res) => {
    const ctx = ctxOf(req);
    const out = await asUser(ctx.userId, (db) => fn({ req, ctx, db, inst: ctx.institute.id }));
    res.json(out === undefined ? { ok: true } : out);
  };
}

/** Query-string helpers. */
export const qs = (req: Request, k: string): string | undefined => {
  const v = req.query[k];
  return typeof v === "string" && v !== "" ? v : undefined;
};
export const qsList = (req: Request, k: string): string[] => {
  const v = req.query[k];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string" && x !== "");
};
export function paging(req: Request, defaultSize = 20) {
  const page = Math.max(1, Number(qs(req, "page")) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(qs(req, "pageSize")) || defaultSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
/** Escape user search text for ILIKE. */
export const like = (s: string) => `%${s.replace(/[%_\\]/g, (c) => "\\" + c)}%`;

/** Split rows produced with `count(*) over() as total_count` into { rows, count }. */
export function withCount<T extends { total_count?: number }>(rows: T[]) {
  const count = rows[0]?.total_count ?? 0;
  return { rows: rows.map(({ total_count: _t, ...r }) => (void _t, r)) as Omit<T, "total_count">[], count: Number(count) };
}
