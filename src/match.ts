import type { Condition } from "./types.ts";

export interface TitleCheck {
  isConsole: boolean;
  /** Why it was rejected, for the log. */
  reason?: string;
  condition: Condition;
}

const PRO = /\b(ps5|ps 5|playstation 5|playstation5)\s*pro\b/;
// Words that mean "this is the console itself". A bundle counts.
const CONSOLE_WORDS = /\b(console|system|bundle|2\s?tb|digital edition)\b/;
// Accessories, games and services that mention the PS5 Pro.
const NON_CONSOLE = new RegExp(
  "\\b(" +
    [
      "case", "cover", "skins?", "decals?", "faceplates?", "shell", "plates?",
      "stand", "mount", "dock", "charging", "charger", "cooling", "fan", "dust", "screen protector",
      "controller", "dualsense", "headset", "earbuds", "remote", "portal", "camera", "vr2",
      "disc drive", "drive only", "ssd", "hard drive", "cable", "hdmi", "adapter", "bag", "carrying",
      "enhanced", "game", "games", "gift card", "subscription", "repair", "replacement",
      "parts?", "warranty", "protection plan", "giveaway", "sweepstakes", "rental", "box only", "empty box",
    ].join("|") +
    ")\\b",
);
const FOR_THE_PRO =
  /\b(for|compatible with|fits|designed for)\s+(the\s+)?(sony\s+)?(ps5|ps 5|playstation 5|playstation5)\s*pro\b/;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/[‐-―]/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function conditionOf(title: string): Condition {
  const t = normalizeTitle(title);
  if (/\b(refurbished|renewed|remanufactured|refurb)\b/.test(t)) return "refurbished";
  if (/\b(pre-owned|preowned|used|open box|open-box)\b/.test(t)) return "used";
  return "unknown";
}

/**
 * Decides whether a listing title is a PS5 Pro console (bundles included),
 * as opposed to an accessory, a game or anything else that mentions it.
 * It leans conservative on accessories: missing an odd listing is better
 * than an urgent alert for a $30 stand.
 */
export function checkTitle(title: string): TitleCheck {
  const t = normalizeTitle(title);
  const condition = conditionOf(title);
  if (!PRO.test(t)) return { isConsole: false, reason: "does not mention the PS5 Pro", condition };
  if (FOR_THE_PRO.test(t)) return { isConsole: false, reason: "accessory for the PS5 Pro", condition };
  // A real console listing can mention a controller ("console with DualSense") or
  // a game ("bundle with Call of Duty"), so accessory words only reject a title
  // that has no console word.
  const nonConsole = NON_CONSOLE.exec(t);
  if (nonConsole && !CONSOLE_WORDS.test(t)) {
    return { isConsole: false, reason: `looks like an accessory or game ("${nonConsole[1]}")`, condition };
  }
  return { isConsole: true, condition };
}
