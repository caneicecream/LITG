import assert from "node:assert/strict";
import { test } from "node:test";
import { FetchError, parseRetryAfter, redactUrl } from "../src/http.ts";
import { isAllowed, parseRobots } from "../src/robots.ts";
import { fakeFetch, testFetcher } from "./helpers.ts";

const UA = "ps5-pro-deal-watch/0.1 (test)";

test("robots.txt: groups, wildcards, longest match and Allow ties", () => {
  const rules = parseRobots(
    ["User-agent: Googlebot", "Disallow: /", "", "User-agent: *", "Disallow: /search", "Disallow: /*?sort=", "Allow: /search/ps5$", "Disallow: /p/*.json$"].join("\n"),
    UA,
  );
  assert.equal(isAllowed(rules, "/p/playstation-5-pro"), true);
  assert.equal(isAllowed(rules, "/search?q=ps5"), false);
  assert.equal(isAllowed(rules, "/search/ps5"), true);
  assert.equal(isAllowed(rules, "/c/consoles?sort=price"), false);
  assert.equal(isAllowed(rules, "/p/item.json"), false);
  assert.equal(isAllowed(rules, "/p/item.json?x=1"), true);

  const ours = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: ps5-pro-deal-watch\nDisallow: /", UA);
  assert.equal(isAllowed(ours, "/anything"), false, "a group naming us takes precedence");
});

test("never fetches a page that robots.txt disallows", async () => {
  const { impl, calls } = fakeFetch({
    "https://shop.example/robots.txt": "User-agent: *\nDisallow: /p/",
    "https://shop.example/p/ps5-pro": "<html></html>",
  });
  const { fetcher } = testFetcher(impl);
  await assert.rejects(fetcher.get("https://shop.example/p/ps5-pro", { checkRobots: true }), (e: FetchError) => e.kind === "robots");
  assert.deepEqual(calls.map((c) => c.url), ["https://shop.example/robots.txt"]);
  assert.equal(calls[0]!.headers["User-Agent"], UA, "identifies itself honestly");
});

test("robots.txt: missing (404) allows; server error disallows", async () => {
  const a = fakeFetch({ "https://a.example/robots.txt": { status: 404 }, "https://a.example/x": "ok" });
  assert.equal((await testFetcher(a.impl).fetcher.get("https://a.example/x", { checkRobots: true })).text, "ok");
  const b = fakeFetch({ "https://b.example/robots.txt": { status: 500 }, "https://b.example/x": "ok" });
  await assert.rejects(testFetcher(b.impl).fetcher.get("https://b.example/x", { checkRobots: true }), (e: FetchError) => e.kind === "robots");
});

test("spaces requests to the same host and caches robots.txt", async () => {
  const { impl, calls } = fakeFetch({ "https://s.example/robots.txt": "", "https://s.example/*": "ok" });
  const { fetcher, clock } = testFetcher(impl);
  await Promise.all(["/1", "/2", "/3"].map((p) => fetcher.get(`https://s.example${p}`, { checkRobots: true })));
  assert.equal(calls.filter((c) => c.url.endsWith("robots.txt")).length, 1);
  assert.equal(calls.length, 4);
  assert.equal(clock.slept, 3 * 15_000, "15 s between each of the 4 requests");
});

test("403 is reported as blocked and the host is left alone for an hour", async () => {
  const { impl, calls } = fakeFetch({ "https://w.example/p": { status: 403, body: "Access denied" } });
  const { fetcher, clock } = testFetcher(impl);
  await assert.rejects(fetcher.get("https://w.example/p", { checkRobots: false }), (e: FetchError) => e.kind === "blocked");
  await assert.rejects(fetcher.get("https://w.example/p", { checkRobots: false }), (e: FetchError) => e.kind === "blocked");
  assert.equal(calls.length, 1, "no retry while backing off");
  clock.now += 61 * 60_000;
  await assert.rejects(fetcher.get("https://w.example/p", { checkRobots: false }));
  assert.equal(calls.length, 2);
});

test("429 honours Retry-After", async () => {
  const { impl, calls } = fakeFetch({ "https://r.example/p": { status: 429, headers: { "Retry-After": "120" } } });
  const { fetcher, clock } = testFetcher(impl);
  await assert.rejects(fetcher.get("https://r.example/p", { checkRobots: false }), (e: FetchError) => e.kind === "rate_limited");
  clock.now += 60_000;
  await assert.rejects(fetcher.get("https://r.example/p", { checkRobots: false }), (e: FetchError) => /waiting/.test(e.message));
  assert.equal(calls.length, 1);
  assert.equal(parseRetryAfter("Wed, 04 Nov 2026 00:00:30 GMT", Date.parse("2026-11-04T00:00:00Z")), 30_000);
});

test("network errors and oversized responses are contained, and keys are redacted", async () => {
  const { impl } = fakeFetch({
    "https://n.example/p?apiKey=SECRET": new TypeError("fetch failed"),
    "https://big.example/p": "x".repeat(300_000),
  });
  const { fetcher } = testFetcher(impl);
  await assert.rejects(fetcher.get("https://n.example/p?apiKey=SECRET", { checkRobots: false }), (e: FetchError) => e.kind === "network" && !e.message.includes("SECRET"));
  await assert.rejects(fetcher.get("https://big.example/p", { checkRobots: false }), (e: FetchError) => e.kind === "parse");
  assert.equal(redactUrl("https://x/y?a=1&apiKey=abc&token=t"), "https://x/y?a=1&apiKey=REDACTED&token=REDACTED");
});
