/**
 * File storage on local disk (STORAGE_DIR/<bucket>/<path>).
 * Buckets: "files" (private, served via short-lived signed URLs) and "branding" (public logos).
 * The browser never talks to this API: URLs point at the Next.js route /api/files/..., which proxies here.
 * To move to S3/R2 later, only this module changes.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { badRequest } from "./errors.js";

export type Bucket = "files" | "branding";
const root = path.resolve(env.storageDir);

function resolvePath(bucket: Bucket, p: string) {
  if (!p || p.includes("\0") || p.split("/").some((s) => s === ".." || s === "")) throw badRequest("Invalid file path.");
  const full = path.resolve(root, bucket, p);
  if (!full.startsWith(path.join(root, bucket) + path.sep)) throw badRequest("Invalid file path.");
  return full;
}

export async function putFile(bucket: Bucket, p: string, data: Buffer, upsert = false) {
  const full = resolvePath(bucket, p);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data, { flag: upsert ? "w" : "wx" });
}

export async function removeFiles(bucket: Bucket, paths: string[]) {
  await Promise.all(paths.filter(Boolean).map((p) => rm(resolvePath(bucket, p), { force: true })));
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
