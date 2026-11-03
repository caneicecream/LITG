import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Secrets, SourceConfig } from "./config.ts";
import { evaluate, type Verdict } from "./evaluate.ts";
import type { PoliteFetcher } from "./http.ts";
import { formatCents } from "./money.ts";
import type { Alert, Notifier } from "./notify/ntfy.ts";
import { checkBestBuy } from "./sources/bestBuy.ts";
import { checkDealFeed } from "./sources/dealFeed.ts";
import { checkProductPage } from "./sources/productPage.ts";
import { alertReason, loadState, pruneState, recordListing, saveState, type State } from "./state.ts";
import type { Listing, SourceResult } from "./types.ts";

export interface WatchContext {
  config: Config;
  secrets: Secrets;
  fetcher: PoliteFetcher;
  notifier: Notifier;
  now?: () => Date;
  log?: (line: string) => void;
  /** Evaluate and report, but send no alerts and save nothing. */
  dryRun?: boolean;
}

export interface SourceSummary {
  id: string;
  kind: SourceConfig["kind"];
  ok: boolean;
  listings: number;
  note?: string;
  error?: string;
  consecutiveFailures: number;
}

export interface CycleReport {
  startedAt: string;
  finishedAt: string;
  sources: SourceSummary[];
  /** Every listing that is a PS5 Pro console, with its verdict. */
  consoles: { listing: Listing; verdict: Verdict; alerted: string | null }[];
  alertsSent: number;
  alertsFailed: number;
}

export const paths = (config: Config) => ({
  state: join(config.dataDir, "state.json"),
  status: join(config.dataDir, "status.json"),
  observations: join(config.dataDir, "observations.jsonl"),
});

async function runSource(source: SourceConfig, ctx: WatchContext, now: Date): Promise<SourceResult> {
  const { config } = ctx;
  try {
    switch (source.kind) {
      case "bestbuy_api":
        return await checkBestBuy(source, ctx.fetcher, now, ctx.secrets.bestBuyApiKey);
      case "product_page":
        return await checkProductPage(source, ctx.fetcher, now);
      case "deal_feed":
        return await checkDealFeed(source, ctx.fetcher, now, {
          maxDealAgeHours: config.maxDealAgeHours,
          minPlausibleCents: Math.round((config.msrpCents * config.minPlausiblePercent) / 100),
        });
    }
  } catch (e) {
    return { sourceId: source.id, ok: false, kind: "parse", error: `unexpected error: ${(e as Error).message}` };
  }
}

const AVAILABILITY_TEXT = {
  in_stock: "In stock",
  preorder: "Available to pre-order / backorder",
  out_of_stock: "Out of stock",
  unknown: "Stock not confirmed",
} as const;

export function buildAlert(listing: Listing, verdict: Verdict, reason: string, config: Config, now: Date): Alert {
  const price = listing.priceCents!;
  const diff = price - config.msrpCents;
  const headline =
    diff < 0 ? `${formatCents(-diff)} under MSRP` : diff === 0 ? "at MSRP" : `${formatCents(diff)} over MSRP`;
  const stock =
    listing.sourceKind === "deal_feed" ? "Deal post: stock not confirmed, check quickly" : AVAILABILITY_TEXT[listing.availability];
  const lines = [
    `${stock} · ${headline} (MSRP ${formatCents(config.msrpCents)})`,
    listing.title.length > 160 ? `${listing.title.slice(0, 157)}…` : listing.title,
  ];
  if (listing.seller && listing.seller.toLowerCase() !== listing.retailer.toLowerCase()) {
    lines.push(`Sold by ${listing.seller}: make sure it's not a marketplace reseller.`);
  }
  if (reason !== "new") lines.push(`Why again: ${reason}.`);
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  lines.push(`Checked ${time}. Confirm price, seller and condition before buying.`);
  return {
    title: `PS5 Pro ${formatCents(price)} at ${listing.retailer}`,
    message: lines.join("\n"),
    priority: verdict.priority,
    tags: verdict.priority >= 5 ? ["rotating_light", "video_game"] : ["video_game"],
    click: listing.url,
  };
}

/** One pass over every enabled source. Mutates `state`; the caller saves it. */
export async function runCycle(ctx: WatchContext, state: State): Promise<CycleReport> {
  const now = ctx.now?.() ?? new Date();
  const { config } = ctx;
  const log = ctx.log ?? console.log;
  const enabled = config.sources.filter((s) => s.enabled);
  const results = await Promise.all(enabled.map((s) => runSource(s, ctx, now)));

  const report: CycleReport = {
    startedAt: now.toISOString(),
    finishedAt: "",
    sources: [],
    consoles: [],
    alertsSent: 0,
    alertsFailed: 0,
  };
  const send = async (alert: Alert): Promise<boolean> => {
    if (ctx.dryRun) return true;
    const ok = await ctx.notifier.send(alert);
    if (ok) report.alertsSent++;
    else report.alertsFailed++;
    return ok;
  };

  for (const [i, result] of results.entries()) {
    const source = enabled[i]!;
    const health = (state.sources[source.id] ??= { consecutiveFailures: 0 });
    if (result.ok) {
      if (health.failureAlerted) log(`Source ${source.id} recovered.`);
      health.consecutiveFailures = 0;
      health.lastOkAt = now.toISOString();
      health.lastError = undefined;
      health.failureAlerted = false;
    } else {
      health.consecutiveFailures++;
      health.lastError = `${result.kind}: ${result.error}`;
      if (config.failureAlertAfter > 0 && health.consecutiveFailures >= config.failureAlertAfter && !health.failureAlerted) {
        const sent = await send({
          title: `Watcher: ${source.id} isn't working`,
          message: `It has failed ${health.consecutiveFailures} checks in a row.\nLast error: ${result.error}\nOther sources are still being checked.`,
          priority: 2,
          tags: ["warning"],
        });
        if (sent) health.failureAlerted = true;
      }
    }
    report.sources.push({
      id: source.id,
      kind: source.kind,
      ok: result.ok,
      listings: result.ok ? result.listings.length : 0,
      note: result.ok ? result.note : undefined,
      error: result.ok ? undefined : `${result.kind}: ${result.error}`,
      consecutiveFailures: health.consecutiveFailures,
    });
  }

  const observations: string[] = [];
  const listings = results.flatMap((r) => (r.ok ? r.listings : []));
  // Best first, so the most important alert arrives first.
  const judged = listings
    .map((listing) => ({ listing, verdict: evaluate(listing, config) }))
    .sort((a, b) => b.verdict.priority - a.verdict.priority || (a.listing.priceCents ?? 1e12) - (b.listing.priceCents ?? 1e12));

  for (const { listing, verdict } of judged) {
    if (verdict.tier === "not_console") continue;
    const prev = state.listings[listing.key];
    const reason = alertReason(prev, listing, verdict, now, config.realertHours);
    const next = recordListing(prev, listing, verdict);
    let alerted: string | null = null;
    if (reason) {
      const delivered = await send(buildAlert(listing, verdict, reason, config, now));
      if (delivered) {
        next.lastAlert = { at: now.toISOString(), priceCents: listing.priceCents!, tier: verdict.tier };
        alerted = reason;
      } else {
        // Leave it un-alerted so the next cycle tries again.
        next.alertable = false;
      }
    }
    state.listings[listing.key] = next;
    report.consoles.push({ listing, verdict, alerted });
    if (listing.priceCents !== null) {
      observations.push(
        JSON.stringify({
          at: listing.observedAt,
          source: listing.sourceId,
          retailer: listing.retailer,
          title: listing.title,
          url: listing.url,
          priceCents: listing.priceCents,
          availability: listing.availability,
          tier: verdict.tier,
        }),
      );
    }
  }

  pruneState(state, now);
  report.finishedAt = (ctx.now?.() ?? new Date()).toISOString();

  if (!ctx.dryRun) {
    const p = paths(config);
    await mkdir(config.dataDir, { recursive: true });
    if (observations.length) await appendFile(p.observations, observations.join("\n") + "\n");
    await writeFile(p.status, JSON.stringify(report, null, 2));
  }
  return report;
}

export function formatReport(report: CycleReport, config: Config): string {
  const out: string[] = [`Check at ${new Date(report.startedAt).toLocaleString("en-US")}`];
  for (const s of report.sources) {
    out.push(
      s.ok
        ? `  ✓ ${s.id}: ${s.listings} listing(s)${s.note ? ` (${s.note})` : ""}`
        : `  ✗ ${s.id}: ${s.error}${s.consecutiveFailures > 1 ? ` [${s.consecutiveFailures} in a row]` : ""}`,
    );
  }
  if (!report.consoles.length) out.push("  No PS5 Pro console listings found this time.");
  for (const { listing, verdict, alerted } of report.consoles) {
    const price = listing.priceCents === null ? "no price" : formatCents(listing.priceCents);
    const flag = verdict.alertable ? (alerted ? `ALERT (${alerted})` : "qualifies (already alerted)") : verdict.reason;
    out.push(`  • ${listing.retailer}: ${price}, ${listing.availability.replace("_", " ")}: ${flag}`);
  }
  out.push(
    `  MSRP ${formatCents(config.msrpCents)}; alerts sent ${report.alertsSent}${report.alertsFailed ? `, failed ${report.alertsFailed}` : ""}`,
  );
  return out.join("\n");
}

export async function cycleWithState(ctx: WatchContext): Promise<CycleReport> {
  const p = paths(ctx.config);
  const state = await loadState(p.state);
  const report = await runCycle(ctx, state);
  if (!ctx.dryRun) await saveState(p.state, state);
  return report;
}

/** Runs cycles until the signal aborts, spacing them by the interval plus jitter. */
export async function watch(ctx: WatchContext, signal: AbortSignal): Promise<void> {
  const log = ctx.log ?? console.log;
  const { intervalSeconds, jitterPercent } = ctx.config;
  while (!signal.aborted) {
    try {
      log(formatReport(await cycleWithState(ctx), ctx.config));
    } catch (e) {
      log(`Check failed: ${(e as Error).message}`);
    }
    const jitter = 1 + ((Math.random() * 2 - 1) * jitterPercent) / 100;
    const delay = Math.round(intervalSeconds * 1000 * jitter);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
