import multer from "multer";
import type { Request } from "express";
import { badRequest } from "./errors.js";
import type { UploadedFile } from "./storage.js";

/** Multipart parser (memory). Next server actions forward files as multipart with a JSON "data" field. */
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 10 } });

export function jsonField(req: Request): unknown {
  const raw = (req.body as { data?: string })?.data;
  if (raw === undefined) return req.body;
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("Invalid request.");
  }
}

export const fileField = (req: Request, name: string): UploadedFile | undefined => {
  const files = req.files as Record<string, Express.Multer.File[]> | Express.Multer.File[] | undefined;
  if (!files) return (req.file?.fieldname === name ? req.file : undefined) as UploadedFile | undefined;
  if (Array.isArray(files)) return files.find((f) => f.fieldname === name);
  return files[name]?.[0];
};
export const filesField = (req: Request, name: string): UploadedFile[] => {
  const files = req.files as Express.Multer.File[] | undefined;
  return Array.isArray(files) ? files.filter((f) => f.fieldname === name) : [];
};
