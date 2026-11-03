# PS5 Pro Deal Watch

A small personal watcher that checks retailers and deal feeds for the PS5 Pro on a schedule. It sends a push alert to your phone (via [ntfy](https://ntfy.sh)) when one is available **at or under MSRP**, or within a small margin above it if you allow that.

- **MSRP default:** $899.99. This is the US list price Sony announced on the PlayStation Blog, effective April 2, 2026. If Sony changes it, update `msrpCents` in `config.json`.
- **Urgent alert (priority 5):** confirmed in stock or orderable at or under MSRP.
- **High alert (priority 4):** at or under MSRP, but stock not confirmed (for example, a deal post).
- **Normal alert (priority 3):** up to `nearMsrpPercent` over MSRP (default 5%, so up to $944.98). Set it to `0` for MSRP-only alerts.
- **Ignored:** accessories, games, refurbished/used/open-box listings (unless you allow them), and implausibly low prices (under 50% of MSRP, usually accessories, typos or scams).
- **Alerts are de-duplicated.** You hear about a listing once. You hear again only when:
  - the price drops;
  - it comes back in stock;
  - it moves from "near MSRP" to "at/under MSRP";
  - or, after 12 hours, as a reminder if it is still available.

It never buys anything. It only tells you where to look.

## Setup (about 10 minutes)

You need Node.js 22.18 or newer. There is no build step.

```bash
npm install
cp config.example.json config.json
cp .env.example .env
```

1. **Phone alerts.** Install the ntfy app (iOS or Android) and subscribe to a topic with a long, random name. On public ntfy.sh, anyone who knows the topic name can read it. Generate a name with `node -e "console.log('ps5-' + crypto.randomUUID())"` and put it in `.env` as `NTFY_TOPIC`.
2. **Best Buy (recommended).** Get a free key at [developer.bestbuy.com](https://developer.bestbuy.com) and set `BESTBUY_API_KEY` in `.env`. This uses Best Buy's official Products API, which is the most reliable source here.
3. **Check it:**
   ```bash
   npm run check-config   # what will be watched, plus any warnings
   npm run test-alert     # your phone should buzz
   npm run once -- --dry-run   # one real check; prints results, sends and saves nothing
   ```
4. **Run it:** `npm start`. It checks every 5 minutes (±20% jitter) until you press Ctrl+C.

It has to keep running to keep watching. Use a computer that stays on, a Raspberry Pi, or a small VPS. To keep it alive across logouts and reboots, use a process manager such as `pm2 start npm --name ps5-watch -- start`, or a systemd service.

## Sources

| Kind | What it checks | Reliability |
| --- | --- | --- |
| `bestbuy_api` | Best Buy's official Products API: price, online availability, condition | Good: a documented API meant for this. Needs a free key |
| `deal_feed` | RSS/Atom deal feeds (default: a Slickdeals search for "ps5 pro") | Good for tips. Posts are leads, not confirmed stock, so they're never "urgent" |
| `product_page` | A specific retailer product page, read from the schema.org price data the page publishes | Varies by site (see below) |

**Product pages** are checked politely:
- The watcher identifies itself with an honest User-Agent and obeys the site's `robots.txt`.
- It waits at least 15 seconds between requests to the same site.
- It backs off on `429`/`503` (honouring `Retry-After`), and stops for an hour after a `403`.
- It does **not** try to get around bot protection: no browser impersonation, no CAPTCHA solving, no rotating proxies.

Many big retailers block automated requests or load prices with JavaScript. When that happens the source shows as failing in the check output, and you get one low-priority alert after 6 failed checks in a row. Remove or replace that source. Use whatever works for you.

The example config has product pages for Target, GameStop and P.C. Richard. These URLs came from search results; open them in a browser to confirm they're the right product, and run `npm run once -- --dry-run` to see which ones the watcher can actually read.

To add a retailer, paste its PS5 Pro product page URL into `config.json`:

```json
{ "id": "walmart", "kind": "product_page", "retailer": "Walmart", "url": "https://www.walmart.com/ip/..." }
```

To add a deal feed, use any RSS/Atom URL:

```json
{ "id": "my-feed", "kind": "deal_feed", "name": "My feed", "url": "https://example.com/deals.rss" }
```

## Configuration

Every field in `config.json` is optional except `sources`. Defaults are shown here.

| Field | Default | Meaning |
| --- | --- | --- |
| `msrpCents` | `89999` | MSRP in cents |
| `nearMsrpPercent` | `5` | Also alert up to this % over MSRP (normal priority) |
| `allowRefurbished` / `allowUsed` | `false` | Include refurbished / used and open-box listings |
| `intervalSeconds` | `300` | Time between checks (minimum 60) |
| `jitterPercent` | `20` | Randomizes the interval so checks don't land on a fixed beat |
| `perHostMinSeconds` | `15` | Minimum gap between requests to one site (minimum 5) |
| `realertHours` | `12` | Reminder for a listing that is still available |
| `maxDealAgeHours` | `48` | Ignore older deal posts |
| `failureAlertAfter` | `6` | Warn once when a source fails this many checks in a row (`0` = never) |
| `minPlausiblePercent` | `50` | Ignore prices under this % of MSRP |

Secrets live only in `.env` and the environment, never in `config.json`: `NTFY_TOPIC`, `NTFY_SERVER`, `NTFY_TOKEN`, `BESTBUY_API_KEY`. API keys are redacted from error messages.

## Files it writes (`data/`, git-ignored)

- `state.json`: what has been seen and alerted. It drives de-duplication. Delete it to start fresh.
- `status.json`: the last check's per-source results.
- `observations.jsonl`: one line for every PS5 Pro console price seen, so you can look at the price history.

## Development

```bash
npm test          # node:test, no network needed (all HTTP is faked)
npm run typecheck
```

The code is in `src/`:

| Path | Role |
| --- | --- |
| `match.ts` | Console vs accessory detection |
| `evaluate.ts` | Price tiers |
| `state.ts` | De-duplication rules |
| `http.ts` | Polite fetcher (robots.txt, spacing, backoff) |
| `sources/` | One file per source kind |
| `notify/ntfy.ts` | Push alerts |
| `watcher.ts` | Check cycle and loop |

**Not yet verified against live sites.** The project was built in a sandbox that blocks retail websites. Field names and page formats follow each source's documentation or schema.org, and are tested against fixtures. Your first `npm run once -- --dry-run` is the real test.
