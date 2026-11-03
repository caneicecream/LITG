import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig, secretsFromEnv, configWarnings, type Config } from "../src/config.ts";
import { evaluate } from "../src/evaluate.ts";
import { NtfyNotifier, type Alert, type Notifier } from "../src/notify/ntfy.ts";
import { alertReason, emptyState, recordListing } from "../src/state.ts";
import type { Listing } from "../src/types.ts";
import { cycleWithState, formatReport, runCycle } from "../src/watcher.ts";
import { fakeFetch, productPage, rss, testFetcher } from "./helpers.ts";

const base = parseConfig({});
const listing = (over: Partial<Listing> = {}): Listing => ({
  key: "page:shop",
  sourceId: "shop",
  sourceKind: "product_page",
  retailer: "Shop",
  title: "PlayStation 5 Pro Console",
  url: "https://shop.example/p",
  priceCents: 89999,
  availability: "in_stock",
  condition: "new",
  observedAt: "2026-11-03T18:00:00.000Z",
  ...over,
});

test("config defaults: MSRP $899.99, 5% near-MSRP band, polite floors", () => {
  assert.equal(base.msrpCents, 89999);
  assert.equal(base.nearMsrpPercent, 5);
  assert.throws(() => parseConfig({ intervalSeconds: 10 }), /intervalSeconds/);
  assert.throws(() => parseConfig({ perHostMinSeconds: 1 }), /perHostMinSeconds/);
  assert.throws(() => parseConfig({ sources: [{ id: "a", kind: "product_page", retailer: "x", url: "http://insecure.example" }] }));
  assert.throws(
    () => parseConfig({ sources: [1, 2].map(() => ({ id: "dup", kind: "deal_feed", name: "d", url: "https://d.example" })) }),
    /duplicate/,
  );
  const warnings = configWarnings(parseConfig({ sources: [{ id: "bb", kind: "bestbuy_api" }] }), secretsFromEnv({ NTFY_TOPIC: "ps5" }));
  assert.equal(warnings.length, 2, "short public topic and missing Best Buy key");
});

test("tiers: at/under MSRP is urgent, a small premium is normal, more is ignored", () => {
  assert.deepEqual(
    [89999, 84999, 92999, 94498, 94499].map((p) => {
      const v = evaluate(listing({ priceCents: p }), base);
      return [v.tier, v.priority];
    }),
    [
      ["at_or_below_msrp", 5],
      ["at_or_below_msrp", 5],
      ["near_msrp", 3],
      ["near_msrp", 3],
      ["above_ceiling", 0],
    ],
  );
  assert.equal(evaluate(listing({ availability: "unknown" }), base).priority, 4);
  assert.equal(evaluate(listing({ availability: "out_of_stock" }), base).tier, "out_of_stock");
  assert.equal(evaluate(listing({ priceCents: 29999 }), base).tier, "implausible_price");
  assert.equal(evaluate(listing({ title: "PS5 Pro Console (Renewed)", condition: "unknown" }), base).tier, "condition_excluded");
  assert.equal(evaluate(listing({ title: "PS5 Pro Console (Renewed)" }), { ...base, allowRefurbished: true }).alertable, true);
  assert.equal(evaluate(listing({ title: "Cooling fan for PS5 Pro", priceCents: 89999 }), base).tier, "not_console");
  assert.equal(evaluate(listing({ priceCents: null }), base).tier, "no_price");
  assert.equal(evaluate(listing({ priceCents: 92999 }), { ...base, nearMsrpPercent: 0 }).alertable, false);
});

test("alert de-duplication: new, quiet, price drop, restock, reminder", () => {
  const t0 = new Date("2026-11-03T18:00:00Z");
  const at = (mins: number) => new Date(t0.getTime() + mins * 60_000);
  const l = listing();
  const v = evaluate(l, base);
  assert.equal(alertReason(undefined, l, v, t0, 12), "new");
  const alerted = { ...recordListing(undefined, l, v), lastAlert: { at: t0.toISOString(), priceCents: 89999, tier: v.tier } };
  assert.equal(alertReason(alerted, l, v, at(5), 12), null, "same listing next cycle: quiet");
  const cheaper = listing({ priceCents: 87999 });
  assert.equal(alertReason(alerted, cheaper, evaluate(cheaper, base), at(5), 12), "price dropped");
  const wasOut = { ...alerted, alertable: false, availability: "out_of_stock" as const };
  assert.equal(alertReason(wasOut, l, v, at(10), 12), null, "flap guard");
  assert.equal(alertReason(wasOut, l, v, at(45), 12), "back in stock");
  assert.equal(alertReason(alerted, l, v, at(12 * 60), 12), "still available");
  const deal = listing({ sourceKind: "deal_feed", availability: "unknown" });
  assert.equal(alertReason(alerted, deal, evaluate(deal, base), at(24 * 60), 12), null, "deal posts are never repeated");
});

class Recorder implements Notifier {
  readonly description = "recorder";
  alerts: Alert[] = [];
  fail = false;
  async send(alert: Alert) {
    if (this.fail) return false;
    this.alerts.push(alert);
    return true;
  }
}

async function setup(pages: Record<string, () => string | { status: number }>) {
  const dataDir = await mkdtemp(join(tmpdir(), "ps5watch-"));
  const config: Config = parseConfig({
    dataDir,
    failureAlertAfter: 2,
    sources: [
      { id: "shop", kind: "product_page", retailer: "Shop", url: "https://shop.example/p/ps5-pro" },
      { id: "deals", kind: "deal_feed", name: "Deals", url: "https://deals.example/rss" },
    ],
  });
  const routes = Object.fromEntries(Object.entries(pages).map(([k, f]) => [k, () => f()]));
  const { impl } = fakeFetch({ "https://shop.example/robots.txt": "User-agent: *\nAllow: /", ...routes });
  const { fetcher, clock } = testFetcher(impl);
  const notifier = new Recorder();
  const ctx = { config, secrets: secretsFromEnv({}), fetcher, notifier, now: () => new Date(clock.now), log: () => {} };
  return { ctx, clock, notifier, dataDir };
}

test("end to end: alerts once, stays quiet, alerts again on a price drop, records history", async () => {
  let price = "899.99";
  let stock = "InStock";
  const { ctx, clock, notifier, dataDir } = await setup({
    "https://shop.example/p/ps5-pro": () => productPage({ "@type": "Product", name: "PlayStation 5 Pro Console", offers: { "@type": "Offer", price, priceCurrency: "USD", availability: stock } }),
    "https://deals.example/rss": () =>
      rss([
        { title: "PS5 Pro $849.99 at Walmart", link: "https://deals.example/1", pubDate: "Tue, 03 Nov 2026 17:30:00 GMT" },
        { title: "PS5 Pro stand $19.99", link: "https://deals.example/2", pubDate: "Tue, 03 Nov 2026 17:30:00 GMT" },
      ]),
  });

  const first = await cycleWithState(ctx);
  assert.deepEqual(notifier.alerts.map((a) => [a.title, a.priority]), [
    ["PS5 Pro $899.99 at Shop", 5],
    ["PS5 Pro $849.99 at Walmart", 4],
  ]);
  assert.match(notifier.alerts[0]!.message, /In stock · at MSRP/);
  assert.match(notifier.alerts[1]!.message, /stock not confirmed/);
  assert.equal(notifier.alerts[0]!.click, "https://shop.example/p/ps5-pro");
  assert.match(formatReport(first, ctx.config), /ALERT \(new\)/);

  clock.now += 5 * 60_000;
  await cycleWithState(ctx);
  assert.equal(notifier.alerts.length, 2, "nothing new");

  clock.now += 5 * 60_000;
  price = "859.99";
  await cycleWithState(ctx);
  assert.equal(notifier.alerts.length, 3);
  assert.match(notifier.alerts[2]!.message, /\$40\.00 under MSRP[\s\S]*price dropped/);

  clock.now += 5 * 60_000;
  stock = "OutOfStock";
  await cycleWithState(ctx);
  clock.now += 40 * 60_000;
  stock = "InStock";
  await cycleWithState(ctx);
  assert.equal(notifier.alerts.length, 4);
  assert.match(notifier.alerts[3]!.message, /back in stock/);

  const history = (await readFile(join(dataDir, "observations.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(history.filter((h) => h.source === "shop").length, 5);
  const status = JSON.parse(await readFile(join(dataDir, "status.json"), "utf8"));
  assert.equal(status.sources.length, 2);
});

test("a failed delivery is retried next cycle; a failing source alerts once", async () => {
  const { ctx, clock, notifier } = await setup({
    "https://shop.example/p/ps5-pro": () => productPage({ "@type": "Product", name: "PS5 Pro Console", offers: { "@type": "Offer", price: 879, availability: "InStock" } }),
    "https://deals.example/rss": () => ({ status: 500 }),
  });
  const state = emptyState();
  notifier.fail = true;
  const r1 = await runCycle({ ...ctx, dryRun: false }, state);
  assert.equal(r1.alertsFailed, 1);
  assert.equal(state.listings["page:shop"]!.lastAlert, undefined);

  notifier.fail = false;
  clock.now += 5 * 60_000;
  await runCycle(ctx, state);
  const titles = notifier.alerts.map((a) => a.title);
  assert.ok(titles.includes("PS5 Pro $879.00 at Shop"), "retried");
  assert.ok(titles.includes("Watcher: deals isn't working"), "second failure crosses the threshold");

  clock.now += 5 * 60_000;
  await runCycle(ctx, state);
  assert.equal(notifier.alerts.filter((a) => a.title.startsWith("Watcher")).length, 1, "only once");
  assert.equal(state.sources.deals!.consecutiveFailures, 3);
});

test("dry run sends nothing and writes nothing", async () => {
  const { ctx, notifier, dataDir } = await setup({
    "https://shop.example/p/ps5-pro": () => productPage({ "@type": "Product", name: "PS5 Pro Console", offers: { "@type": "Offer", price: 879, availability: "InStock" } }),
    "https://deals.example/rss": () => rss([]),
  });
  const report = await cycleWithState({ ...ctx, dryRun: true });
  assert.equal(report.consoles.length, 1);
  assert.equal(notifier.alerts.length, 0);
  await assert.rejects(readFile(join(dataDir, "state.json")));
});

test("ntfy: JSON publish with token, topic kept out of the description", async () => {
  const { impl, calls } = fakeFetch({ "https://ntfy.example/": { status: 200, body: "{}" } });
  const n = new NtfyNotifier({ ntfyServer: "https://ntfy.example", ntfyTopic: "ps5-secret-topic", ntfyToken: "tk_abc" }, impl, () => {});
  assert.equal(await n.send({ title: "PS5 Pro $849.99 at Walmart — €", message: "m", priority: 5, tags: ["video_game"], click: "https://w.example" }), true);
  const body = JSON.parse(calls[0]!.body!);
  assert.equal(body.topic, "ps5-secret-topic");
  assert.equal(body.priority, 5);
  assert.equal(body.click, "https://w.example");
  assert.equal(calls[0]!.headers.Authorization, "Bearer tk_abc");
  assert.ok(!n.description.includes("secret"));
  const down = new NtfyNotifier({ ntfyServer: "https://down.example", ntfyTopic: "t" }, fakeFetch({}).impl, () => {});
  assert.equal(await down.send({ title: "t", message: "m", priority: 3, tags: [] }), false);
});
