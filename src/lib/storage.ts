/**
 * File storage on local disk (STORAGE_DIR/<bucket>/<path>).
 * Buckets: "files" (private, served via short-lived signed URLs) and "branding" (public logos).
 * The browser never talks to this API: URLs point at the Next.js route /api/files/..., which proxies here.
 * To move to S3/R2 later, only this module changes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { badRequest, HttpError } from "./errors.js";
import { sys } from "../db/pool.js";

export type Bucket = "files" | "branding";
const root = path.resolve(env.storageDir);

function resolvePath(bucket: Bucket, p: string) {
  if (!p || p.includes("\0") || p.split("/").some((s) => s === ".." || s === "")) throw badRequest("Invalid file path.");
  const full = path.resolve(root, bucket, p);
  if (!full.startsWith(path.join(root, bucket) + path.sep)) throw badRequest("Invalid file path.");
  return full;
}

// ---------- Per-institute storage quota ----------
// Every stored path starts with "<institute_id>/", so usage can be tracked per institute here,
// in one place, for all uploads (materials, homework, documents, photos, logos).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instituteOf = (p: string) => {
  const first = p.split("/")[0];
  return UUID.test(first) ? first : null;
};

async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await stat(full).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** Bytes stored for an institute. Computed from disk once, then kept up to date incrementally. */
export async function storageUsed(instituteId: string): Promise<number> {
  const row = await sys.one<{ storage_bytes: number }>(`select storage_bytes from public.institute_usage where institute_id = $1`, [instituteId]);
  if (row) return Number(row.storage_bytes);
  const bytes = (await dirSize(path.join(root, "files", instituteId))) + (await dirSize(path.join(root, "branding", instituteId)));
  await sys.q(
    `insert into public.institute_usage (institute_id, storage_bytes) values ($1, $2) on conflict (institute_id) do update set storage_bytes = excluded.storage_bytes, computed_at = now()`,
    [instituteId, bytes],
  );
  return bytes;
}

async function addUsage(instituteId: string, delta: number) {
  if (!delta) return;
  await storageUsed(instituteId); // make sure the row exists
  await sys.q(`update public.institute_usage set storage_bytes = greatest(0, storage_bytes + $2) where institute_id = $1`, [instituteId, delta]);
}

async function assertQuota(instituteId: string, extra: number) {
  const plan = await sys.one<{ storage_mb: number | null }>(`select storage_mb from public.institute_access where institute_id = $1`, [instituteId]);
  if (plan?.storage_mb == null) return;
  const used = await storageUsed(instituteId);
  if (used + extra > plan.storage_mb * 1024 * 1024) {
    const size = plan.storage_mb >= 1024 ? `${(plan.storage_mb / 1024).toFixed(plan.storage_mb % 1024 ? 1 : 0)} GB` : `${plan.storage_mb} MB`;
    throw new HttpError(402, `Your plan's storage limit (${size}) is full. Delete old files or upgrade your plan.`);
  }
}

export async function putFile(bucket: Bucket, p: string, data: Buffer, upsert = false) {
  const full = resolvePath(bucket, p);
  const inst = instituteOf(p);
  const previous = upsert ? ((await stat(full).catch(() => null))?.size ?? 0) : 0;
  if (inst) await assertQuota(inst, data.length - previous);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data, { flag: upsert ? "w" : "wx" });
  if (inst) await addUsage(inst, data.length - previous).catch((e) => console.error("[storage] usage update failed", e));
}

export async function removeFiles(bucket: Bucket, paths: string[]) {
  await Promise.all(
    paths.filter(Boolean).map(async (p) => {
      const full = resolvePath(bucket, p);
      const size = (await stat(full).catch(() => null))?.size ?? 0;
      await rm(full, { force: true });
      const inst = instituteOf(p);
      if (inst && size) await addUsage(inst, -size).catch((e) => console.error("[storage] usage update failed", e));
    }),
  );
}

export async function openFile(bucket: Bucket, p: string) {
  const full = resolvePath(bucket, p);
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) return null;
  return { size: s.size, stream: createReadStream(full) };
}

const sign = (p: string, exp: number) => createHmac("sha256", env.internalKey).update(`files/${p}:${exp}`).digest("base64url");
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Short-lived URL for a private file. Caller MUST have checked read access first. */
export function signedUrl(p: string, expiresIn = 600) {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  return `/api/files/files/${encodePath(p)}?exp=${exp}&sig=${sign(p, exp)}`;
}
export function verifySignature(p: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sign(p, exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const publicBrandingUrl = (p: string | null) => (p ? `/api/files/branding/${encodePath(p)}` : null);

export const ALLOWED_UPLOADS: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "text/plain": ["txt"],
};
export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries({ ...ALLOWED_UPLOADS, "image/svg+xml": ["svg"], "image/gif": ["gif"] }).flatMap(([m, exts]) => exts.map((e) => [e, m])),
);

export type UploadedFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

/** Validate MIME type, extension and size. Returns an error message or null. */
export function validateUpload(file: UploadedFile | undefined, maxMb: number, allowedMimes = Object.keys(ALLOWED_UPLOADS)): string | null {
  if (!file || file.size === 0) return "Please choose a file.";
  if (file.size > maxMb * 1024 * 1024) return `File is too large (max ${maxMb} MB).`;
  const ext = file.originalname.split(".").pop()?.toLowerCase() ?? "";
  if (!allowedMimes.includes(file.mimetype) || !(ALLOWED_UPLOADS[file.mimetype] ?? (file.mimetype === "image/svg+xml" ? ["svg"] : []))?.includes(ext)) {
    return "This file type is not allowed.";
  }
  return null;
}

export function safeFileName(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "bin";
  const base = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "file";
  return `${Date.now()}-${base}.${ext}`;
}
