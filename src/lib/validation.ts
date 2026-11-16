import { z } from "zod";

/** Normalise Indian mobile numbers to 10 digits. */
export function normalizePhone(v: string) {
  let d = (v ?? "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}
export const phoneSchema = z.string().trim().transform(normalizePhone).refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number");
export const requiredText = (label: string, max = 200) => z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);
export function passwordSchema(min = 8) {
  return z
    .string()
    .min(min, `Password must be at least ${min} characters`)
    .max(72, "Password is too long")
    .regex(/[A-Za-z]/, "Password must contain a letter")
    .regex(/\d/, "Password must contain a number");
}
export const uuid = z.uuid("Invalid selection");
