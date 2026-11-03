import { readFile } from "node:fs/promises";
import { z } from "zod";

const sourceBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
  enabled: z.boolean().default(true),
};

const bestBuySource = z.object({
  ...sourceBase,
  kind: z.literal("bestbuy_api"),
  /** Keyword searches; each is one API request. Results are merged by SKU. */
  searches: z.array(z.string().min(2)).default(["ps5 pro", "playstation 5 pro"]),
  /** Specific SKUs to always check, in addition to the searches. */
  skus: z.array(z.string().regex(/^\d+$/)).default([]),
});

const productPageSource = z.object({
  ...sourceBase,
  kind: z.literal("product_page"),
  url: z.url({ protocol: /^https$/ }),
  retailer: z.string().min(1),
});

const dealFeedSource = z.object({
  ...sourceBase,
  kind: z.literal("deal_feed"),
  url: z.url({ protocol: /^https?$/ }),
  name: z.string().min(1),
  /**
   * RSS readers conventionally don't consult robots.txt for a feed a site
   * publishes. Set this to true to check it anyway.
   */
  respectRobots: z.boolean().default(false),
});

export const sourceSchema = z.discriminatedUnion("kind", [bestBuySource, productPageSource, dealFeedSource]);
export type SourceConfig = z.infer<typeof sourceSchema>;

export const configSchema = z
  .object({
    /** The manufacturer's suggested retail price, in cents. */
    msrpCents: z.number().int().positive().default(89999),
    msrpNote: z.string().default("US list price $899.99, PlayStation Blog, effective 2026-04-02"),
    /** Also alert (at normal priority) up to this many percent over MSRP. 0 = only at or under MSRP. */
    nearMsrpPercent: z.number().min(0).max(50).default(5),
    /** Prices under this share of MSRP are treated as mistakes, accessories or scams, not consoles. */
    minPlausiblePercent: z.number().min(10).max(95).default(50),
    allowRefurbished: z.boolean().default(false),
    allowUsed: z.boolean().default(false),
    /** Seconds between check cycles. The floor keeps the watcher polite. */
    intervalSeconds: z.number().int().min(60).default(300),
    jitterPercent: z.number().min(0).max(50).default(20),
    /** Minimum spacing between two requests to the same host. */
    perHostMinSeconds: z.number().min(5).default(15),
    /** Remind about a still-qualifying listing after this many hours. */
    realertHours: z.number().min(1).default(12),
    /** Ignore deal posts older than this (stops a first run from alerting on old posts). */
    maxDealAgeHours: z.number().min(1).default(48),
    /** Send one low-priority alert when a source has failed this many cycles in a row. 0 = never. */
    failureAlertAfter: z.number().int().min(0).default(6),
    userAgent: z.string().min(3).default("ps5-pro-deal-watch/0.1 (personal stock checker)"),
    timeoutSeconds: z.number().min(3).max(120).default(20),
    dataDir: z.string().default("data"),
    sources: z.array(sourceSchema).default([]),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.sources.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["sources", i, "id"], message: `duplicate id "${s.id}"` });
      seen.add(s.id);
    });
  });

export type Config = z.infer<typeof configSchema>;

/** Secrets come only from the environment, never from config.json. */
export interface Secrets {
  ntfyServer: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  bestBuyApiKey?: string;
}

export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): Secrets {
  const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  return {
    ntfyServer: (blank(env.NTFY_SERVER) ?? "https://ntfy.sh").replace(/\/+$/, ""),
    ntfyTopic: blank(env.NTFY_TOPIC),
    ntfyToken: blank(env.NTFY_TOKEN),
    bestBuyApiKey: blank(env.BESTBUY_API_KEY),
  };
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid config:\n${lines.join("\n")}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No config file at ${path}. Copy config.example.json to config.json and edit it.`);
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

/** Problems that don't make the config invalid but mean something won't work. */
export function configWarnings(config: Config, secrets: Secrets): string[] {
  const warnings: string[] = [];
  const enabled = config.sources.filter((s) => s.enabled);
  if (enabled.length === 0) warnings.push("No sources are enabled, so nothing will be checked.");
  if (!secrets.ntfyTopic) warnings.push("NTFY_TOPIC is not set: alerts will only be printed to the console.");
  else if (secrets.ntfyServer === "https://ntfy.sh" && secrets.ntfyTopic.length < 12) {
    warnings.push("Topics on ntfy.sh are public to anyone who guesses the name. Use a long, random topic.");
  }
  if (enabled.some((s) => s.kind === "bestbuy_api") && !secrets.bestBuyApiKey) {
    warnings.push("A Best Buy source is enabled but BESTBUY_API_KEY is not set; it will be skipped.");
  }
  return warnings;
}
