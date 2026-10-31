/**
 * Browser smoke test against a running server (Playwright must be installed).
 *   BASE_URL=http://localhost:3000 npm run e2e
 * Checks: no horizontal overflow at phone width on every main page; the
 * itinerary workflow (demo → plan → compare → save → new version); planning the
 * park days from a saved trip and the trip-change warning; an assistant
 * itinerary proposal; cross-site write protection. Uses fictional data only.
 */
const { chromium } = require("playwright");
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const failures = [];
const check = (ok, msg) => (ok ? console.log(`ok   ${msg}`) : (failures.push(msg), console.log(`FAIL ${msg}`)));

async function api(path, method, body) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", origin: BASE }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    p.on("pageerror", (e) => errors.push(String(e)));
    for (const path of ["/", "/prices", "/trips", "/assistant", "/monitoring", "/notifications", "/itinerary"]) {
      await p.goto(BASE + path, { waitUntil: "networkidle" });
      const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(o <= 0, `${w}px ${path}: no horizontal overflow (${o})`);
    }
    await p.close();
  }

  // Itinerary workflow (phone width).
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
  m.on("pageerror", (e) => errors.push(String(e)));
  await m.goto(BASE + "/itinerary", { waitUntil: "networkidle" });
  await m.evaluate(() => localStorage.clear());
  await m.goto(BASE + "/itinerary", { waitUntil: "networkidle" });
  await m.getByRole("button", { name: "Try the demo" }).click();
  await m.getByRole("button", { name: "Plan my days" }).click();
  await m.getByText("Fit with your priorities").first().waitFor({ timeout: 20000 });
  for (const d of await m.locator("details").all()) await d.evaluate((x) => (x.open = true));
  check((await m.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, "390px itinerary with every section open: no overflow");
  await m.getByRole("button", { name: "Compare relaxed vs ride-focused" }).click();
  await m.getByTestId("comparison").waitFor({ timeout: 20000 });
  check(await m.getByText("Breaks").first().isVisible(), "comparison shows breaks and other trade-off rows");
  await m.getByRole("button", { name: "Use these preferences" }).first().click();
  await m.getByRole("button", { name: /Plan again/ }).click();
  await m.getByText("Fit with your priorities").first().waitFor({ timeout: 20000 });
  await m.getByRole("button", { name: "Save itinerary" }).click();
  await m.waitForURL(/\/itinerary\/itin-/, { timeout: 20000 });
  await m.getByLabel("Packed").check();
  await m.getByRole("button", { name: /Plan again/ }).click();
  await m.getByText("Fit with your priorities").first().waitFor({ timeout: 20000 });
  await m.getByRole("button", { name: "Save as new version" }).click();
  await m.getByText("2 versions saved").waitFor({ timeout: 20000 });
  check(true, "itinerary saved and a second version appended");

  // Plan the park days from a saved trip; change the trip; reopen → warning.
  const draft = await m.evaluate(() => fetch("/api/itinerary/context?demo=1").then((r) => r.json()));
  const req = {
    party: { adults: 2, children: 0, infants: 0 },
    dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 },
    preferred: { arrival: "2027-02-01", nights: 4, resortId: "pop-century", roomTypeId: "standard", ticketOption: "base", bookingMethod: "separate", dining: "out_of_pocket" },
    resorts: { allowedResortIds: ["pop-century"], requireOnProperty: true, preferredResortIds: [] },
    tickets: { parkDays: 3, allowedOptions: ["base"], parkOnArrivalDay: false, parkOnDepartureDay: false, allowThirdParty: true },
    dining: { policy: "exclude", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
    transport: { mode: "no_car", rentalPerDayCents: 0 }, budget: {}, otherExpenses: [],
    eligibility: { florida_resident: "unknown", annual_passholder: "unknown", military: "unknown" },
    objective: "lowest_cost", weights: { price: 50, resort: 15, convenience: 10, ticket: 10, dining: 5, dates: 10 },
    data: { includeIllustrative: true, staleAfterDays: 14 },
  };
  check(!!draft.demo, "demo input available");
  const trip = (await api("/api/trips", "POST", { name: "E2E trip (fictional)", request: req })).body.trip;
  const d = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await d.goto(`${BASE}/itinerary?trip=${trip.id}`, { waitUntil: "networkidle" });
  await d.getByRole("heading", { name: "Your trip" }).waitFor({ timeout: 20000 });
  // Paste park hours from a calendar (fictional), review, add.
  await d.locator("#known-info").evaluate((x) => (x.open = true));
  await d.getByText("Paste hours from the park calendar").click();
  await d.getByLabel("Pasted hours").fill("Tue, Feb 2\nMagic Kingdom 9:00 AM – 10:00 PM\nEPCOT 9am-9pm\nWed, Feb 3\nHollywood Studios 8:30 AM – 9:00 PM\nAnimal Kingdom 8am-7pm\nThu, Feb 4\nMagic Kingdom 9am-10pm\nEPCOT 9am-9pm");
  await d.getByRole("button", { name: "Review" }).click();
  await d.getByRole("button", { name: /Add 6 park-hour entries/ }).click();
  check(await d.getByText(/Added 6 days of park hours/).isVisible(), "pasted park hours reviewed and added");
  await d.getByRole("button", { name: "Plan my days" }).click();
  await d.getByText("Fit with your priorities").first().waitFor({ timeout: 20000 });
  check((await d.getByText(/Park hours 9:00 AM–10:00 PM|Park hours 8:30 AM–9:00 PM|Park hours 8:00 AM–7:00 PM|Park hours 9:00 AM–9:00 PM/).count()) >= 3, "plan uses the pasted park hours");
  await d.getByRole("button", { name: "Save itinerary" }).click();
  await d.waitForURL(/\/itinerary\/itin-/, { timeout: 20000 });
  const url = d.url();
  await api("/api/trips", "POST", { id: trip.id, name: trip.name, request: { ...req, preferred: { ...req.preferred, arrival: "2027-02-02" }, dates: { ...req.dates, latestDeparture: "2027-02-06" } } });
  await d.goto(url, { waitUntil: "networkidle" });
  await d.getByTestId("trip-drift").waitFor({ timeout: 20000 });
  check(/Dates: 2027-02-01 → 2027-02-05 is now 2027-02-02 → 2027-02-06/.test(await d.getByTestId("trip-drift").innerText()), "changed trip dates are flagged on the saved itinerary");

  // Assistant itinerary proposal (basic mode).
  await d.getByRole("button", { name: "Plan with the assistant" }).click();
  await d.waitForURL(/\/assistant\?c=/, { timeout: 20000 });
  await d.getByLabel("Message").fill("Keep our afternoons flexible.");
  await d.getByRole("button", { name: "Send" }).click();
  await d.getByTestId("itinerary-proposal").waitFor({ timeout: 20000 });
  await d.getByRole("button", { name: "Apply & plan" }).click();
  await d.getByTestId("itinerary-result").waitFor({ timeout: 20000 });
  check(true, "assistant itinerary proposal applied");

  // Cross-site write protection.
  const evil = await fetch(BASE + "/api/prices", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  check(evil.status === 403, `cross-site write rejected (${evil.status})`);
  const form = await fetch(BASE + "/api/prices", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  check(form.status === 415, `form-encoded write rejected (${form.status})`);

  await api(`/api/trips?id=${trip.id}`, "DELETE");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
  await browser.close();
  console.log(failures.length ? `\n${failures.length} failure(s)` : "\nAll checks passed");
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
