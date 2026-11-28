import { sys } from "../db/pool.js";
import { hashToken, newToken } from "./crypto.js";
import { buildContext, CONTEXT_SQL, type ContextRow, type SessionContext } from "./context.js";

const DAY = 24 * 60 * 60 * 1000;
/** Persistent ("remember me") sessions last 30 days, sliding. Browser-session ones 1 day. */
export const sessionTtl = (persistent: boolean) => (persistent ? 30 * DAY : DAY);

export async function createSession(
  userId: string,
  persistent: boolean,
  meta: { userAgent?: string; ip?: string } = {},
  scope: { instituteId?: string | null; platform?: boolean } = {},
) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + sessionTtl(persistent));
  await sys.q(
    `insert into auth.sessions (user_id, token_hash, persistent, expires_at, user_agent, ip, institute_id, platform) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, hashToken(token), persistent, expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null, scope.instituteId ?? null, !!scope.platform],
  );
  await sys.q(`update auth.users set last_sign_in_at = now() where id = $1`, [userId]);
  return { token, expiresAt, persistent };
}

// ---------- Short-lived in-process cache ----------
// Every API call authenticates; caching the resolved context for a few seconds removes a DB round trip
// from most requests. Revocations in this process clear it immediately; other processes see changes
// within CACHE_TTL_MS.
const CACHE_TTL_MS = 10_000;
const CACHE_MAX = 10_000;
type Cached = { sessionId: string; ctx: SessionContext; at: number };
const cache = new Map<string, Cached>();

function remember(hash: string, v: Cached) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(hash, v);
}
/** Drop cached contexts for a user (status/role/password changes). */
export function forgetUser(userId: string) {
  for (const [k, v] of cache) if (v.ctx.userId === userId) cache.delete(k);
}
/** Drop cached contexts for everyone in an institute (plan/subscription/suspension changes). */
export function forgetInstitute(instituteId: string) {
  for (const [k, v] of cache) if (v.ctx.institute?.id === instituteId || v.ctx.profile.institute_id === instituteId) cache.delete(k);
}
const forgetSession = (sessionId: string) => {
  for (const [k, v] of cache) if (v.sessionId === sessionId) cache.delete(k);
};

/**
 * Validates a session token and loads the full request context in ONE query
 * (session + user + profile + membership + roles + institute + subscription).
 * Slides the expiry at most once an hour.
 */
export async function resolveSession(token: string): Promise<{ sessionId: string; ctx: SessionContext } | null> {
  if (!token || token.length > 200) return null;
  const hash = hashToken(token);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { sessionId: hit.sessionId, ctx: hit.ctx };

  const row = await sys.one<ContextRow>(CONTEXT_SQL, [hash]);
  if (!row) {
    cache.delete(hash);
    return null;
  }
  if (Date.now() - new Date(row.last_seen_at).getTime() > 60 * 60 * 1000) {
    await sys.q(`update auth.sessions set last_seen_at = now(), expires_at = $2 where id = $1`, [row.session_id, new Date(Date.now() + sessionTtl(row.persistent))]);
  }
  const ctx = buildContext(row);
  remember(hash, { sessionId: row.session_id, ctx, at: Date.now() });
  return { sessionId: row.session_id, ctx };
}

/** Re-point a session at another institute (institute switcher). */
export async function setSessionInstitute(sessionId: string, instituteId: string) {
  await sys.q(`update auth.sessions set institute_id = $2 where id = $1`, [sessionId, instituteId]);
  forgetSession(sessionId);
}

export async function revokeSession(sessionId: string) {
  forgetSession(sessionId);
  await sys.q(`delete from auth.sessions where id = $1`, [sessionId]);
}
export async function revokeAllSessions(userId: string) {
  forgetUser(userId);
  await sys.q(`delete from auth.sessions where user_id = $1`, [userId]);
}
/** Sign a user out of one institute only (their sessions in other institutes keep working). */
export async function revokeInstituteSessions(userId: string, instituteId: string) {
  forgetUser(userId);
  await sys.q(`delete from auth.sessions where user_id = $1 and institute_id = $2`, [userId, instituteId]);
}
export const purgeExpiredSessions = () =>
  sys.q(`delete from auth.sessions where expires_at < now(); delete from auth.one_time_tokens where expires_at < now() - interval '7 days';`);
