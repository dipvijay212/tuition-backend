import { Router } from "express";
import path from "node:path";
import { MIME_BY_EXT, openFile, verifySignature, type Bucket } from "../lib/storage.js";
import { notFound, forbidden } from "../lib/errors.js";

/** Streams stored files. Private files need a valid signature (issued after an access check). */
export const filesRouter = Router();

filesRouter.get("/:bucket/*path", async (req, res) => {
  const bucket = req.params.bucket as Bucket;
  if (bucket !== "files" && bucket !== "branding") throw notFound();
  const p = ([] as string[]).concat((req.params as unknown as { path: string[] }).path).join("/");
  if (bucket === "files" && !verifySignature(p, Number(req.query.exp), String(req.query.sig ?? ""))) throw forbidden("This file link has expired.");
  const f = await openFile(bucket, p);
  if (!f) throw notFound("File not found.");
  const ext = path.extname(p).slice(1).toLowerCase();
  res.setHeader("content-type", MIME_BY_EXT[ext] ?? "application/octet-stream");
  res.setHeader("content-length", String(f.size));
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", bucket === "branding" ? "public, max-age=300" : "private, max-age=300");
  if (ext === "svg") res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  f.stream.pipe(res);
});
