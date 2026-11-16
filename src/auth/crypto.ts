import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const hashPassword = (p: string) => bcrypt.hash(p, 12);
/** Works with hashes exported from Supabase Auth too (bcrypt $2a$/$2b$). */
export const verifyPassword = (p: string, hash: string | null) => (hash ? bcrypt.compare(p, hash) : Promise.resolve(false));
