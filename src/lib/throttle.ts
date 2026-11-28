import { HttpError } from "./errors.js";

/**
 * Small in-memory brute-force guard (per process): after `max` failures for a key within
 * `windowMs`, further attempts are refused until the window passes.
 */
export function createThrottle(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  };
  setInterval(sweep, windowMs).unref();
  return {
    check(key: string) {
      const h = hits.get(key);
      if (h && h.until > Date.now() && h.n >= max) {
        const mins = Math.ceil((h.until - Date.now()) / 60000);
        throw new HttpError(429, `Too many attempts. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
      }
    },
    fail(key: string) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.until < now) hits.set(key, { n: 1, until: now + windowMs });
      else h.n++;
      if (hits.size > 50_000) sweep();
    },
    reset(key: string) {
      hits.delete(key);
    },
  };
}

/** 8 failed sign-ins per IP + identifier per 15 minutes. */
export const loginThrottle = createThrottle(8, 15 * 60 * 1000);
