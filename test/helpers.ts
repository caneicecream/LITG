import { PoliteFetcher } from "../src/http.ts";

export type Route = string | { status?: number; body?: string; headers?: Record<string, string> } | Error;

/** A fetch stand-in that serves canned responses by exact URL (or URL prefix ending in "*"). */
export function fakeFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    const key = Object.keys(routes).find((k) => (k.endsWith("*") ? url.startsWith(k.slice(0, -1)) : k === url));
    if (!key) return new Response("not found", { status: 404 });
    const entry = routes[key]!;
    const r = typeof entry === "function" ? entry() : entry;
    if (r instanceof Error) throw r;
    if (typeof r === "string") return new Response(r, { status: 200 });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { impl, calls };
}

/** A fetcher on a fake clock: sleeping advances time instantly. */
export function testFetcher(fetchImpl: typeof fetch, start = Date.parse("2026-11-03T18:00:00Z")) {
  const clock = { now: start, slept: 0 };
  const fetcher = new PoliteFetcher({
    userAgent: "ps5-pro-deal-watch/0.1 (test)",
    perHostMinMs: 15_000,
    timeoutMs: 5_000,
    maxBytes: 200_000,
    fetchImpl,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      clock.slept += ms;
    },
  });
  return { fetcher, clock };
}

export function productPage(product: object): string {
  return `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify(product)}</script></head><body></body></html>`;
}

export function rss(items: { title: string; link: string; pubDate?: string; guid?: string }[]): string {
  const body = items
    .map(
      (i) =>
        `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link>${i.guid ? `<guid>${i.guid}</guid>` : ""}${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}</item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Deals</title>${body}</channel></rss>`;
}
