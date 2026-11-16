import nodemailer, { type Transporter } from "nodemailer";
import { sys } from "../db/pool.js";

export type SendEmailOptions = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  instituteId?: string | null;
  notificationId?: string | null;
};

export function getSmtpConfig() {
  const host = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const user = (process.env.SMTP_USER || "").trim();
  // Strip quotes and spaces (Google App passwords are 16 chars without spaces)
  const pass = (process.env.SMTP_PASS || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
  const fromName = (process.env.SMTP_FROM_NAME || "Tuition Management").replace(/^["']|["']$/g, "").trim();
  const fromEmail = (process.env.SMTP_FROM_EMAIL || user || "noreply@tuition.local").trim();
  return { configured: !!(user && pass), host, port, secure, user, pass, fromName, fromEmail };
}

/** SMTP status without the password (safe to send to the frontend). */
export function smtpStatus() {
  const { pass: _p, ...rest } = getSmtpConfig();
  void _p;
  return rest;
}

let cached: Transporter | null = null;
function transporter(): Transporter | null {
  const cfg = getSmtpConfig();
  if (!cfg.configured) return null;
  cached ??= nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: process.env.NODE_ENV === "production" },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return cached;
}

async function logDelivery(recipient: string, status: "sent" | "failed" | "skipped", o: SendEmailOptions, error?: string) {
  try {
    await sys.q(
      `insert into public.notification_delivery_logs (institute_id, notification_id, channel, recipient, status, error)
       values ($1, $2, 'email', $3, $4, $5)`,
      [o.instituteId ?? null, o.notificationId ?? null, recipient, status, error ?? null],
    );
  } catch (e) {
    console.error("[email] delivery log error", e);
  }
}

export async function verifySmtpConnection(): Promise<{ ok: boolean; message: string; error?: string }> {
  const cfg = getSmtpConfig();
  if (!cfg.configured) return { ok: false, message: "SMTP is not configured. Please set SMTP_USER and SMTP_PASS in environment variables.", error: "Missing credentials" };
  try {
    await transporter()!.verify();
    return { ok: true, message: `SMTP connected successfully to ${cfg.host}:${cfg.port}!` };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Failed to connect to SMTP server: ${m}`, error: m };
  }
}

/** Send an email. Never throws. */
export async function sendEmail(o: SendEmailOptions): Promise<{ ok: boolean; messageId?: string; mocked?: boolean; error?: string }> {
  const to = (Array.isArray(o.to) ? o.to : [o.to]).filter(Boolean).join(", ");
  if (!to) return { ok: false, error: "No recipient email provided" };
  const cfg = getSmtpConfig();
  const t = transporter();
  if (!cfg.configured || !t) {
    console.log(`[email:dev] to=${to} subject=${o.subject}`);
    await logDelivery(to, "skipped", o, "SMTP credentials not configured in environment");
    return { ok: true, mocked: true, messageId: `mock-${Date.now()}` };
  }
  try {
    const info = await t.sendMail({ from: `"${cfg.fromName}" <${cfg.fromEmail}>`, to, subject: o.subject, html: o.html, text: o.text });
    await logDelivery(to, "sent", o);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[email] send failed to=${to}: ${m}`);
    await logDelivery(to, "failed", o, m);
    return { ok: false, error: m };
  }
}
