import "../dns.js";
import pg from "pg";
import { env } from "../env.js";

// Return DATE columns as 'YYYY-MM-DD' strings and NUMERIC as numbers,
// matching what the Next app received from Supabase/PostgREST.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 (counts, identity ids)

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
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

/**
 * Run fn in a transaction as the signed-in user:
 *  - role app_api (cannot write money/history tables directly)
 *  - app.user_id set, so auth.uid() and the SQL business functions know the caller.
 * Begin + role + user are sent in one round trip (the DB is remote).
 */
export async function asUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("Invalid user id");
  const client = await pool.connect();
  try {
    await client.query(`begin; set local role app_api; select set_config('app.user_id', '${userId}', true);`);
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

/** Trusted system work (auth, provisioning, cron). Runs as the owner. Use only after authorization checks. */
export async function asSystem<T>(fn: (db: Db) => Promise<T>, actingUserId?: string): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      actingUserId && UUID.test(actingUserId)
        ? `begin; select set_config('app.user_id', '${actingUserId}', true);`
        : "begin",
    );
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
