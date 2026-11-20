import "./dns.js";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { scheduleFeeJob } from "./jobs/fee-reminders.js";

const app = createApp();
app.listen(env.port, () => console.log(`[api] listening on http://localhost:${env.port}`));

// Housekeeping: drop expired sessions/link tokens every 6 hours.
setInterval(() => purgeExpiredSessions().catch((e) => console.error("[api] purge failed", e)), 6 * 60 * 60 * 1000).unref();

// Fee reminders + late fees (idempotent; also callable via POST /cron/fee-reminders).
scheduleFeeJob();
