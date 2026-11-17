import dns from "node:dns";

const publicResolver = new dns.promises.Resolver();
publicResolver.setServers(["8.8.8.8", "1.1.1.1"]);

const origLookup = dns.lookup;

type LookupOptions = dns.LookupOptions;
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * Custom DNS lookup fallback:
 * Many mobile hotspots and ISPs (e.g. Jio/Airtel in India) refuse to resolve `.tech` domains
 * such as Neon Postgres hosts (`*.neon.tech`), returning ENOTFOUND.
 * When the system resolver fails with ENOTFOUND/EAI_AGAIN/EREFUSED, fall back to Google (8.8.8.8)
 * and Cloudflare (1.1.1.1) public DNS.
 */
export function setupDnsFallback(): void {
  if ((dns.lookup as unknown as { __fallbackInstalled?: boolean }).__fallbackInstalled) {
    return;
  }

  const customLookup = ((
    hostname: string,
    optionsOrCallback?: LookupOptions | LookupCallback | number,
    maybeCallback?: LookupCallback,
  ) => {
    let options: LookupOptions = {};
    let callback: LookupCallback;

    if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback;
    } else if (typeof maybeCallback === "function") {
      callback = maybeCallback;
      if (typeof optionsOrCallback === "object" && optionsOrCallback !== null) {
        options = optionsOrCallback;
      } else if (typeof optionsOrCallback === "number") {
        options = { family: optionsOrCallback };
      }
    } else {
      callback = () => {};
    }

    origLookup(hostname, options, (err, address, family) => {
      if (err && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN" || err.code === "EREFUSED")) {
        const familyPref = typeof options.family === "number" ? options.family : 4;

        const resolvePromise =
          familyPref === 6
            ? publicResolver.resolve6(hostname).catch(() => publicResolver.resolve4(hostname))
            : publicResolver.resolve4(hostname).catch(() => publicResolver.resolve6(hostname));

        resolvePromise
          .then((ips) => {
            if (!ips || !ips.length) {
              return callback(err, address as any, family);
            }
            if (options.all) {
              const allResults = ips.map((ip) => ({
                address: ip,
                family: ip.includes(":") ? 6 : 4,
              }));
              callback(null, allResults as any);
            } else {
              const ip = ips[0];
              callback(null, ip, ip.includes(":") ? 6 : 4);
            }
          })
          .catch(() => callback(err, address as any, family));
        return;
      }
      callback(err, address as any, family);
    });
  }) as typeof dns.lookup;

  (customLookup as unknown as { __fallbackInstalled?: boolean }).__fallbackInstalled = true;
  dns.lookup = customLookup;
}

setupDnsFallback();
