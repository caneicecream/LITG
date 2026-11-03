export type Availability = "in_stock" | "preorder" | "out_of_stock" | "unknown";
export type Condition = "new" | "refurbished" | "used" | "unknown";
export type SourceKind = "bestbuy_api" | "product_page" | "deal_feed";

/** One thing seen for sale (or posted as a deal) during a check. */
export interface Listing {
  /** Stable identity used for de-duplicating alerts. */
  key: string;
  sourceId: string;
  sourceKind: SourceKind;
  retailer: string;
  title: string;
  url: string;
  /** Integer cents, USD. null when the source gave no usable price. */
  priceCents: number | null;
  availability: Availability;
  condition: Condition;
  seller?: string;
  /** When the source published it (deal posts), if known. */
  publishedAt?: string;
  observedAt: string;
}

export type FailureKind =
  | "robots" // robots.txt disallows this URL, so it is never fetched
  | "blocked" // HTTP 401/403: the site refused us (often bot protection); we do not try to get around it
  | "rate_limited" // HTTP 429/503, or we are still backing off from one
  | "http" // any other non-2xx
  | "network"
  | "parse"
  | "config";

export type SourceResult =
  | { sourceId: string; ok: true; listings: Listing[]; note?: string }
  | { sourceId: string; ok: false; kind: FailureKind; error: string };
