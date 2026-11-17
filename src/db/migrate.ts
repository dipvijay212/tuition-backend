/**
 * Applies db/migrations/*.sql in name order, each in its own transaction.
 * Already-applied files are recorded in public.schema_migrations.
 */
import "../dns.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_URL or DATABASE_URL is required");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query<{ name: string }>("select name from public.schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    process.stdout.write(`Applying ${file} ... `);
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into public.schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log("ok");
    } catch (e) {
      await client.query("rollback");
      console.log("FAILED");
      throw e;
    }
  }
  console.log("Database is up to date.");
} finally {
  await client.end();
}
