import { XMLParser } from "fast-xml-parser";
import type { SourceConfig } from "../config.ts";
import { FetchError, type PoliteFetcher } from "../http.ts";
import { normalizeTitle } from "../match.ts";
import type { Listing, SourceResult } from "../types.ts";
import { decodeEntities } from "./productPage.ts";

type DealFeedSource = Extract<SourceConfig, { kind: "deal_feed" }>;

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  publishedAt?: string;
}

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o["#text"] ?? o["@_href"] ?? "");
  }
  return String(v).trim();
};
const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. Throws on anything else. */
export function parseFeed(xml: string): FeedItem[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: true });
  const doc = parser.parse(xml) as Record<string, any>;
  const rssItems = doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item;
  if (rssItems !== undefined || doc.rss || doc["rdf:RDF"]) {
    return list(rssItems as Record<string, unknown>[]).map((it) => {
      const link = text(it.link);
      return {
        id: text(it.guid) || link,
        title: decodeEntities(text(it.title)),
        link,
        publishedAt: toIso(text(it.pubDate) || text(it["dc:date"])),
      };
    });
  }
  if (doc.feed) {
    return list(doc.feed.entry as Record<string, unknown>[]).map((e) => {
      const links = list(e.link as Record<string, unknown>[]);
      const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
      const link = text(alt?.["@_href"] ?? alt);
      return {
        id: text(e.id) || link,
        title: decodeEntities(text(e.title)),
        link,
        publishedAt: toIso(text(e.published) || text(e.updated)),
      };
    });
  }
  throw new Error("not an RSS or Atom feed");
}

function toIso(s: string): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Picks the sale price out of a deal title such as
 * "PS5 Pro Console $849.99 (Reg. $899.99) + $50 Gift Card at Target".
 * Skips "was/reg/list" prices, "$X off" amounts, gift cards and credits,
 * and anything under `minCents`.
 */
export function priceFromTitle(title: string, minCents: number): number | null {
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/g;
  for (const m of title.matchAll(re)) {
    const before = title.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    const after = title.slice(m.index + m[0].length, m.index + m[0].length + 16).toLowerCase();
    if (/(reg\.?|was|list|orig\.?|msrp|retail|save|extra)\s*:?\s*$/.test(before)) continue;
    if (/^\s*(off|gift|in\s+(?:gift|store|reward)|credit|back|reward|egift|promo)/.test(after)) continue;
    const cents = Math.round(Number(m[1]!.replace(/,/g, "") + (m[2] ?? "")) * 100);
    if (cents >= minCents) return cents;
  }
  return null;
}

const RETAILERS: [RegExp, string][] = [
  [/\bwalmart\b/, "Walmart"],
  [/\btarget\b/, "Target"],
  [/\bamazon\b|\bwoot\b/, "Amazon"],
  [/\bbest ?buy\b/, "Best Buy"],
  [/\bgamestop\b/, "GameStop"],
  [/\bcostco\b/, "Costco"],
  [/\bsam'?s club\b/, "Sam's Club"],
  [/\bplaystation direct\b|direct\.playstation/, "PlayStation Direct"],
  [/\bnewegg\b/, "Newegg"],
  [/\bebay\b/, "eBay"],
  [/\bkohl'?s\b/, "Kohl's"],
  [/\bmicro ?center\b/, "Micro Center"],
  [/\bbj'?s\b/, "BJ's"],
  [/\bdell\b/, "Dell"],
  [/\bantonline\b/, "Antonline"],
  [/\bpc ?richard\b/, "P.C. Richard"],
];

export function retailerFrom(title: string, link: string): string | undefined {
  const t = normalizeTitle(title);
  for (const [re, name] of RETAILERS) if (re.test(t)) return name;
  try {
    const host = new URL(link).hostname.replace(/^www\./, "");
    for (const [re, name] of RETAILERS) if (re.test(host)) return name;
  } catch {
    // ignore
  }
  return undefined;
}

export async function checkDealFeed(
  source: DealFeedSource,
  fetcher: PoliteFetcher,
  now: Date,
  opts: { maxDealAgeHours: number; minPlausibleCents: number },
): Promise<SourceResult> {
  let xml: string;
  try {
    xml = (await fetcher.get(source.url, {
      checkRobots: source.respectRobots,
      accept: "application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5",
    })).text;
  } catch (e) {
    if (e instanceof FetchError) return { sourceId: source.id, ok: false, kind: e.kind, error: e.message };
    throw e;
  }
  let items: FeedItem[];
  try {
    items = parseFeed(xml);
  } catch (e) {
    return { sourceId: source.id, ok: false, kind: "parse", error: `could not read the feed: ${(e as Error).message}` };
  }
  const oldest = now.getTime() - opts.maxDealAgeHours * 3_600_000;
  const fresh = items.filter((it) => !it.publishedAt || Date.parse(it.publishedAt) >= oldest);
  const listings: Listing[] = fresh
    .filter((it) => it.title && it.link)
    .map((it) => ({
      key: `deal:${source.id}:${it.id}`,
      sourceId: source.id,
      sourceKind: "deal_feed",
      retailer: retailerFrom(it.title, it.link) ?? `via ${source.name}`,
      title: it.title,
      url: it.link,
      priceCents: priceFromTitle(it.title, opts.minPlausibleCents),
      // A deal post says someone saw it; it doesn't confirm current stock.
      availability: "unknown",
      condition: "unknown",
      publishedAt: it.publishedAt,
      observedAt: now.toISOString(),
    }));
  return { sourceId: source.id, ok: true, listings, note: `${items.length} posts, ${fresh.length} recent` };
}
