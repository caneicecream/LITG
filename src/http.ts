import { isAllowed, parseRobots, type RobotsRules } from "./robots.ts";
import type { FailureKind } from "./types.ts";

export class FetchError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Hides credentials that travel in query strings (e.g. Best Buy's apiKey). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api_?key|key|token|access_token)=)[^&#]*/gi, "$1REDACTED");
}

export interface FetcherOptions {
  userAgent: string;
  perHostMinMs: number;
  timeoutMs: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchResult {
  status: number;
  text: string;
}

type RobotsEntry = { rules: RobotsRules | "allow_all" | "disallow_all"; expiresAt: number; why?: string };

const HOUR = 3_600_000;

/**
 * The only way this project talks to websites. It identifies itself honestly,
 * spaces out requests to each host, obeys robots.txt for pages, and backs off
 * on 403/429/503. It never retries a refusal with a different identity and
 * never tries to solve or avoid bot challenges.
 */
export class PoliteFetcher {
  readonly #opts: Required<FetcherOptions>;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #lastRequest = new Map<string, number>();
  readonly #backoff = new Map<string, { until: number; failures: number; reason: string }>();
  readonly #robots = new Map<string, RobotsEntry>();

  constructor(opts: FetcherOptions) {
    this.#opts = {
      maxBytes: 5_000_000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  /** Fetches a URL as text. Throws FetchError for anything but a 2xx response. */
  get(url: string, options: { accept?: string; checkRobots: boolean }): Promise<FetchResult> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.reject(new FetchError("config", `not a valid URL: ${redactUrl(url)}`));
    }
    const host = u.host;
    const run = async (): Promise<FetchResult> => {
      const backoff = this.#backoff.get(host);
      if (backoff && backoff.until > this.#opts.now()) {
        const mins = Math.ceil((backoff.until - this.#opts.now()) / 60_000);
        throw new FetchError(
          backoff.reason === "blocked" ? "blocked" : "rate_limited",
          `${host}: waiting ${mins} more min after ${backoff.reason === "blocked" ? "being refused" : "being rate limited"}`,
        );
      }
      if (options.checkRobots) {
        const verdict = await this.#robotsAllow(u);
        if (verdict !== true) throw new FetchError("robots", `${host}: ${verdict}`);
      }
      const res = await this.#request(u, options.accept ?? "text/html,application/xhtml+xml,*/*;q=0.8", this.#opts.maxBytes);
      this.#handleStatus(host, res.status, res.retryAfter);
      return { status: res.status, text: res.text };
    };
    const previous = this.#queues.get(host) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#queues.set(host, next.catch(() => undefined));
    return next;
  }

  #handleStatus(host: string, status: number, retryAfter: string | null): void {
    const now = this.#opts.now();
    const prior = this.#backoff.get(host);
    const failures = (prior?.failures ?? 0) + 1;
    if (status === 401 || status === 403) {
      this.#backoff.set(host, { until: now + HOUR, failures, reason: "blocked" });
      throw new FetchError("blocked", `${host} refused the request (HTTP ${status}). Often bot protection; not retried for an hour.`);
    }
    if (status === 429 || status === 503) {
      const waitMs = Math.min(parseRetryAfter(retryAfter, now) ?? 60_000 * 2 ** (failures - 1), HOUR);
      this.#backoff.set(host, { until: now + waitMs, failures, reason: "rate_limited" });
      throw new FetchError("rate_limited", `${host} asked us to slow down (HTTP ${status}); waiting ${Math.ceil(waitMs / 60_000)} min.`);
    }
    if (status < 200 || status >= 300) throw new FetchError("http", `${host} returned HTTP ${status}`);
    this.#backoff.delete(host);
  }

  /** true, or the reason the URL may not be fetched. */
  async #robotsAllow(u: URL): Promise<true | string> {
    const now = this.#opts.now();
    let entry = this.#robots.get(u.origin);
    if (!entry || entry.expiresAt <= now) {
      entry = await this.#loadRobots(u);
      this.#robots.set(u.origin, entry);
    }
    if (entry.rules === "allow_all") return true;
    if (entry.rules === "disallow_all") return `${entry.why}; skipping its pages until it can be read`;
    return isAllowed(entry.rules, u.pathname + u.search) || `robots.txt does not allow ${u.pathname}`;
  }

  async #loadRobots(u: URL): Promise<RobotsEntry> {
    const now = this.#opts.now();
    try {
      const res = await this.#request(new URL("/robots.txt", u.origin), "text/plain", 500_000);
      if (res.status >= 200 && res.status < 300) {
        return { rules: parseRobots(res.text, this.#opts.userAgent), expiresAt: now + 12 * HOUR };
      }
      // RFC 9309: a missing robots.txt (4xx) allows everything; a server error means assume nothing is allowed.
      if (res.status >= 400 && res.status < 500) return { rules: "allow_all", expiresAt: now + 12 * HOUR };
      return { rules: "disallow_all", expiresAt: now + HOUR / 4, why: `robots.txt returned HTTP ${res.status}` };
    } catch (e) {
      return { rules: "disallow_all", expiresAt: now + HOUR / 4, why: `could not download robots.txt (${(e as Error).message.replace(/^.*: /, "")})` };
    }
  }

  async #request(u: URL, accept: string, maxBytes: number): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const host = u.host;
    const last = this.#lastRequest.get(host);
    if (last !== undefined) {
      const wait = last + this.#opts.perHostMinMs - this.#opts.now();
      if (wait > 0) await this.#opts.sleep(wait);
    }
    this.#lastRequest.set(host, this.#opts.now());
    let res: Response;
    try {
      res = await this.#opts.fetchImpl(u, {
        headers: { "User-Agent": this.#opts.userAgent, Accept: accept, "Accept-Language": "en-US,en;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const what = err.name === "TimeoutError" ? "timed out" : `failed (${err.message})`;
      throw new FetchError("network", `${redactUrl(u.toString())}: request ${what}`);
    }
    const text = await readLimited(res, maxBytes, u);
    return { status: res.status, text, retryAfter: res.headers.get("retry-after") };
  }
}

async function readLimited(res: Response, maxBytes: number, u: URL): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError("parse", `${redactUrl(u.toString())}: response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
