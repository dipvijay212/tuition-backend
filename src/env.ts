function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  /** Direct (non-pooled) URL for migrations. Falls back to DATABASE_URL. */
  directUrl: process.env.DIRECT_URL ?? required("DATABASE_URL"),
  /** Shared secret: only the Next.js server may call this API. */
  internalKey: required("API_INTERNAL_KEY"),
  siteUrl: (process.env.SITE_URL ?? "http://localhost:3100").replace(/\/$/, ""),
  cronSecret: process.env.CRON_SECRET ?? "",
  storageDir: process.env.STORAGE_DIR ?? "./uploads",
  isProd: process.env.NODE_ENV === "production",
};
