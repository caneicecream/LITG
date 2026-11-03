import { configWarnings, loadConfig, secretsFromEnv, type Config } from "./config.ts";
import { PoliteFetcher } from "./http.ts";
import { formatCents } from "./money.ts";
import { notifierFor } from "./notify/ntfy.ts";
import { ceilingCents } from "./evaluate.ts";
import { cycleWithState, formatReport, watch, type WatchContext } from "./watcher.ts";

const USAGE = `Usage: node src/cli.ts <command> [--config config.json] [--dry-run]

Commands:
  watch          Check every source on a schedule and send alerts (Ctrl+C to stop)
  once           Run one check, print what was found, then exit
  test-alert     Send a sample alert to make sure your phone receives it
  check-config   Validate config.json and show what will be watched`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function describe(config: Config): string {
  const lines = [
    `MSRP ${formatCents(config.msrpCents)} (${config.msrpNote})`,
    config.nearMsrpPercent > 0
      ? `Alerts: urgent at or under MSRP; normal priority up to ${formatCents(ceilingCents(config))} (+${config.nearMsrpPercent}%)`
      : "Alerts: only at or under MSRP",
    `Conditions: new${config.allowRefurbished ? ", refurbished" : ""}${config.allowUsed ? ", used/open-box" : ""}`,
    `Every ${config.intervalSeconds}s ±${config.jitterPercent}%, at least ${config.perHostMinSeconds}s between requests to one site`,
    "Sources:",
    ...config.sources.map((s) => {
      const what = s.kind === "bestbuy_api" ? `Best Buy API: ${[...s.searches.map((q) => `"${q}"`), ...s.skus.map((k) => `SKU ${k}`)].join(", ")}` : s.kind === "deal_feed" ? `deal feed ${s.name}` : `${s.retailer} product page`;
      return `  ${s.enabled ? "●" : "○"} ${s.id}: ${what}${s.enabled ? "" : " (disabled)"}`;
    }),
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const config = await loadConfig(arg("--config") ?? "config.json");
  const secrets = secretsFromEnv();
  const notifier = notifierFor(secrets);
  const warnings = configWarnings(config, secrets);

  if (command === "check-config") {
    console.log(describe(config));
    console.log(`Alerts go to: ${notifier.description}`);
    warnings.forEach((w) => console.log(`! ${w}`));
    return 0;
  }

  if (command === "test-alert") {
    const ok = await notifier.send({
      title: "PS5 Pro watcher test",
      message: `Alerts are working. Watching for PS5 Pro at or under ${formatCents(config.msrpCents)}.`,
      priority: 3,
      tags: ["white_check_mark", "video_game"],
    });
    console.log(ok ? `Sent via ${notifier.description}.` : "Sending failed; see the error above.");
    return ok ? 0 : 1;
  }

  const fetcher = new PoliteFetcher({
    userAgent: config.userAgent,
    perHostMinMs: config.perHostMinSeconds * 1000,
    timeoutMs: config.timeoutSeconds * 1000,
  });
  const ctx: WatchContext = { config, secrets, fetcher, notifier, dryRun: process.argv.includes("--dry-run") };
  warnings.forEach((w) => console.error(`! ${w}`));

  if (command === "once") {
    console.log(formatReport(await cycleWithState(ctx), config));
    return 0;
  }
  if (command === "watch") {
    console.log(describe(config));
    console.log(`Alerts go to: ${notifier.description}. Press Ctrl+C to stop.\n`);
    const controller = new AbortController();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => {
        console.log("\nStopping after the current check…");
        controller.abort();
      });
    }
    await watch(ctx, controller.signal);
    return 0;
  }
  console.error(`Unknown command "${command}".\n\n${USAGE}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
