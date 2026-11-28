import "../dns.js";
import pg from "pg";
import { env } from "../env.js";

// Return DATE columns as 'YYYY-MM-DD' strings and NUMERIC as numbers,
// matching what the Next app received from Supabase/PostgREST.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 (counts, identity ids)

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 20), idleTimeoutMillis: 30_000 });
pool.on("error", (e) => console.error("[db] idle client error", e));

export type Db = {
  /** All rows. */
  q<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** First row or null. */
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
};

function wrap(client: pg.PoolClient | pg.Pool): Db {
  return {
    async q<T>(sql: string, params?: unknown[]) {
      return (await client.query(sql, params)).rows as T[];
    },
    async one<T>(sql: string, params?: unknown[]) {
      return ((await client.query(sql, params)).rows[0] as T | undefined) ?? null;
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a request runs as: the user and the institute their session is bound to. */
export type Actor = { userId: string; institute?: { id: string } | null; instituteId?: string | null };
const actorInstitute = (a: Actor) => a.institute?.id ?? a.instituteId ?? null;

/** begin + settings in one statement (the DB is remote, so round trips matter). Values are validated UUIDs. */
function beginSql(userId: string | null, instituteId: string | null, role?: "app_api") {
  if (userId && !UUID.test(userId)) throw new Error("Invalid user id");
  if (instituteId && !UUID.test(instituteId)) throw new Error("Invalid institute id");
  let sql = "begin;";
  if (role) sql += ` set local role ${role};`;
  if (userId) sql += ` select set_config('app.user_id', '${userId}', true);`;
  if (instituteId) sql += ` select set_config('app.institute_id', '${instituteId}', true);`;
  return sql;
}

/**
 * Run fn in a transaction as the signed-in user:
 *  - role app_api (cannot write money/history tables directly; Row Level Security limits it to one institute)
 *  - app.user_id and app.institute_id set, so auth.uid() / auth_institute_id() and the SQL business functions know the caller.
 * Begin + role + settings are sent in one round trip.
 */
export async function asUser<T>(actor: Actor, fn: (db: Db) => Promise<T>): Promise<T> {
  const sql = beginSql(actor.userId, actorInstitute(actor), "app_api");
  const client = await pool.connect();
  try {
    await client.query(sql);
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Trusted system work (auth, provisioning, cron, platform admin). Runs as the owner (bypasses RLS).
 * Use only after authorization checks. Pass the acting user (and institute) so audit triggers know who did it.
 */
export async function asSystem<T>(fn: (db: Db) => Promise<T>, acting?: string | Actor): Promise<T> {
  const a: Actor | null = typeof acting === "string" ? { userId: acting } : (acting ?? null);
  const sql = beginSql(a?.userId ?? null, a ? actorInstitute(a) : null);
  const client = await pool.connect();
  try {
    await client.query(sql);
    const result = await fn(wrap(client));
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Single statement outside a transaction (owner). */
export const sys = wrap(pool);
