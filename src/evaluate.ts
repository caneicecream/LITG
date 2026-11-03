import type { Config } from "./config.ts";
import { checkTitle } from "./match.ts";
import type { Listing } from "./types.ts";

export type Tier =
  | "at_or_below_msrp"
  | "near_msrp"
  | "above_ceiling"
  | "out_of_stock"
  | "no_price"
  | "implausible_price"
  | "condition_excluded"
  | "not_console";

export interface Verdict {
  tier: Tier;
  alertable: boolean;
  /** ntfy priority 1–5 (5 = urgent). */
  priority: number;
  reason: string;
}

type Rules = Pick<Config, "msrpCents" | "nearMsrpPercent" | "minPlausiblePercent" | "allowRefurbished" | "allowUsed">;

export function ceilingCents(rules: Pick<Config, "msrpCents" | "nearMsrpPercent">): number {
  return Math.floor(rules.msrpCents * (1 + rules.nearMsrpPercent / 100));
}

export function evaluate(listing: Listing, rules: Rules): Verdict {
  const no = (tier: Tier, reason: string): Verdict => ({ tier, alertable: false, priority: 0, reason });

  const title = checkTitle(listing.title);
  if (!title.isConsole) return no("not_console", title.reason ?? "not a console");

  const condition = listing.condition !== "unknown" ? listing.condition : title.condition;
  if (condition === "refurbished" && !rules.allowRefurbished) return no("condition_excluded", "refurbished");
  if (condition === "used" && !rules.allowUsed) return no("condition_excluded", "used or open-box");

  if (listing.priceCents === null) return no("no_price", "no price found");
  const minPlausible = Math.round((rules.msrpCents * rules.minPlausiblePercent) / 100);
  if (listing.priceCents < minPlausible) {
    return no("implausible_price", "price is too low to be a real console listing (accessory, typo or scam)");
  }
  if (listing.availability === "out_of_stock") return no("out_of_stock", "out of stock");

  const confirmed = listing.availability === "in_stock" || listing.availability === "preorder";
  if (listing.priceCents <= rules.msrpCents) {
    return {
      tier: "at_or_below_msrp",
      alertable: true,
      priority: confirmed ? 5 : 4,
      reason: confirmed ? "at or under MSRP and available" : "at or under MSRP (stock not confirmed)",
    };
  }
  if (listing.priceCents <= ceilingCents(rules)) {
    return { tier: "near_msrp", alertable: true, priority: 3, reason: `within ${rules.nearMsrpPercent}% of MSRP` };
  }
  return no("above_ceiling", "above your price ceiling");
}
