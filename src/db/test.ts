/** Runs db/tests/*.sql against DIRECT_URL. Each file must begin; ... rollback; itself. */
import "../dns.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/tests");
const client = new pg.Client({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL });
client.on("notice", (n) => console.log(n.message));
await client.connect();
let failed = false;
for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
  console.log(`\n== ${file}`);
  try {
    await client.query(await readFile(path.join(dir, file), "utf8"));
    console.log(`== ${file}: ALL PASSED`);
  } catch (e) {
    failed = true;
    console.error(`== ${file}: ${(e as Error).message}`);
    await client.query("rollback").catch(() => {});
  }
}
await client.end();
process.exit(failed ? 1 : 0);
