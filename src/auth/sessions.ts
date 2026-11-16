import { sys } from "../db/pool.js";
import { hashToken, newToken } from "./crypto.js";

const DAY = 24 * 60 * 60 * 1000;
/** Persistent ("remember me") sessions last 30 days, sliding. Browser-session ones 1 day. */
export const sessionTtl = (persistent: boolean) => (persistent ? 30 * DAY : DAY);

export async function createSession(userId: string, persistent: boolean, meta: { userAgent?: string; ip?: string } = {}) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + sessionTtl(persistent));
  await sys.q(
    `insert into auth.sessions (user_id, token_hash, persistent, expires_at, user_agent, ip) values ($1, $2, $3, $4, $5, $6)`,
    [userId, hashToken(token), persistent, expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  await sys.q(`update auth.users set last_sign_in_at = now() where id = $1`, [userId]);
  return { token, expiresAt, persistent };
}

/** Returns the session's user id, sliding the expiry at most once an hour. */
export async function validateSession(token: string): Promise<{ sessionId: string; userId: string } | null> {
  if (!token || token.length > 200) return null;
  const row = await sys.one<{ id: string; user_id: string; persistent: boolean; last_seen_at: Date }>(
    `select s.id, s.user_id, s.persistent, s.last_seen_at
       from auth.sessions s join auth.users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and (u.banned_until is null or u.banned_until < now())`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 60 * 60 * 1000) {
    await sys.q(`update auth.sessions set last_seen_at = now(), expires_at = $2 where id = $1`, [
      row.id,
      new Date(Date.now() + sessionTtl(row.persistent)),
    ]);
  }
  return { sessionId: row.id, userId: row.user_id };
}

export const revokeSession = (sessionId: string) => sys.q(`delete from auth.sessions where id = $1`, [sessionId]);
export const revokeAllSessions = (userId: string) => sys.q(`delete from auth.sessions where user_id = $1`, [userId]);
export const purgeExpiredSessions = () =>
  sys.q(`delete from auth.sessions where expires_at < now(); delete from auth.one_time_tokens where expires_at < now() - interval '7 days';`);
