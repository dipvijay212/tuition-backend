/**
 * Create or promote a platform (super admin) account.
 *
 *   npm run platform:admin -- --email you@company.com --name "Your Name" --password 'Strong@123'
 *
 * An existing login with that email is promoted (its password is only changed when --password is given).
 * Platform admins sign in at /platform/login.
 */
import { asSystem, pool } from "./pool.js";
import { createAuthUser } from "../auth/provision.js";
import { hashPassword } from "../auth/crypto.js";

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim() || "Platform Admin";
  const password = arg("password");
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Pass --email you@company.com");
  if (password && password.length < 8) throw new Error("Password must be at least 8 characters.");

  const result = await asSystem(async (db) => {
    const existing = await db.one<{ id: string }>(`select id from auth.users where lower(email) = $1`, [email]);
    let id = existing?.id;
    if (!id) {
      if (!password) throw new Error("New account: pass --password too.");
      id = await createAuthUser(db, { email, password, fullName: name, confirmed: true });
      await db.q(`update public.profiles set full_name = $2, email = $3, status = 'active' where id = $1`, [id, name, email]);
    } else if (password) {
      await db.q(`update auth.users set encrypted_password = $2, updated_at = now() where id = $1`, [id, await hashPassword(password)]);
    }
    await db.q(`insert into public.platform_admins (user_id) values ($1) on conflict do nothing`, [id]);
    return { id, created: !existing };
  });
  console.log(`${result.created ? "Created" : "Promoted"} platform admin ${email}. Sign in at /platform/login.`);
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
