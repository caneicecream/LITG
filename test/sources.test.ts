import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { bestBuyUrl, checkBestBuy, searchFilter } from "../src/sources/bestBuy.ts";
import { checkDealFeed, parseFeed, priceFromTitle, retailerFrom } from "../src/sources/dealFeed.ts";
import { checkProductPage, extractOffer } from "../src/sources/productPage.ts";
import { fakeFetch, productPage, rss, testFetcher } from "./helpers.ts";

const now = new Date("2026-11-03T18:00:00Z");

test("reads a schema.org Product with a single Offer", () => {
  const offer = extractOffer(
    productPage({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "PlayStation&reg;5 Pro Console",
      offers: { "@type": "Offer", price: "899.99", priceCurrency: "USD", availability: "https://schema.org/InStock", itemCondition: "https://schema.org/NewCondition", seller: { name: "GameStop" } },
    }),
  );
  assert.deepEqual(offer, {
    title: "PlayStation®5 Pro Console",
    priceCents: 89999,
    availability: "in_stock",
    condition: "new",
    seller: "GameStop",
    basis: "json-ld",
  });
});

test("picks the cheapest available USD offer, inside @graph and alongside other products", () => {
  const html = productPage({
    "@graph": [
      { "@type": "Product", name: "DualSense Controller", offers: { "@type": "Offer", price: 74.99, availability: "InStock" } },
      {
        "@type": ["Product"],
        name: "Sony PlayStation 5 Pro Console",
        offers: [
          { "@type": "Offer", price: 849.0, priceCurrency: "USD", availability: "OutOfStock" },
          { "@type": "Offer", price: 879.0, priceCurrency: "USD", availability: "InStock" },
          { "@type": "Offer", price: 700.0, priceCurrency: "CAD", availability: "InStock" },
        ],
      },
    ],
  });
  const offer = extractOffer(html)!;
  assert.equal(offer.title, "Sony PlayStation 5 Pro Console");
  assert.equal(offer.priceCents, 87900);
  assert.equal(offer.availability, "in_stock");
});

test("handles AggregateOffer, broken JSON-LD blocks and the meta-tag fallback", () => {
  const agg = productPage({ "@type": "Product", name: "PS5 Pro Console", offers: { "@type": "AggregateOffer", lowPrice: "889.00", availability: "https://schema.org/PreOrder" } });
  assert.equal(extractOffer(`<script type="application/ld+json">{oops</script>${agg}`)!.priceCents, 88900);
  assert.equal(extractOffer(agg)!.availability, "preorder");

  const meta = `<meta property="og:title" content="PlayStation 5 Pro Console &amp; More"><meta content="899.99" property="product:price:amount"><meta property="product:price:currency" content="USD"><meta property="product:availability" content="out of stock">`;
  assert.deepEqual(extractOffer(meta), {
    title: "PlayStation 5 Pro Console & More",
    priceCents: 89999,
    availability: "out_of_stock",
    condition: "unknown",
    basis: "meta",
  });
  assert.equal(extractOffer("<html><body>Loading…</body></html>"), null);
});

test("a product page with no structured data is reported, not guessed", async () => {
  const { impl } = fakeFetch({
    "https://shop.example/robots.txt": "User-agent: *\nDisallow: /cart",
    "https://shop.example/p/ps5-pro": "<html><div id=root></div></html>",
  });
  const { fetcher } = testFetcher(impl);
  const result = await checkProductPage({ id: "shop", kind: "product_page", enabled: true, retailer: "Shop", url: "https://shop.example/p/ps5-pro" }, fetcher, now);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.kind, "parse");
});

test("picks the sale price out of deal titles", () => {
  const min = 45000;
  assert.equal(priceFromTitle("PS5 Pro Console $849.99 (Reg. $899.99) at Target", min), 84999);
  assert.equal(priceFromTitle("$50 off PS5 Pro, now $849.99", min), 84999);
  assert.equal(priceFromTitle("PS5 Pro $899.99 + $100 Gift Card at Walmart", min), 89999);
  assert.equal(priceFromTitle("PS5 Pro $1,049.99 bundle", min), 104999);
  assert.equal(priceFromTitle("Was $899.99 PS5 Pro $799", min), 79900);
  assert.equal(priceFromTitle("PS5 Pro restock tonight", min), null);
  assert.equal(retailerFrom("PS5 Pro $849 @ Best Buy", "https://slickdeals.net/f/1"), "Best Buy");
  assert.equal(retailerFrom("PS5 Pro console", "https://www.walmart.com/ip/1"), "Walmart");
});

test("parses RSS and Atom feeds", () => {
  const items = parseFeed(rss([{ title: "PS5 Pro &amp; bundle $849", link: "https://d.example/1", guid: "g1", pubDate: "Tue, 03 Nov 2026 17:00:00 GMT" }]));
  assert.deepEqual(items, [{ id: "g1", title: "PS5 Pro & bundle $849", link: "https://d.example/1", publishedAt: "2026-11-03T17:00:00.000Z" }]);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>e1</id><title>PS5 Pro $899</title><link rel="alternate" href="https://d.example/2"/><updated>2026-11-03T16:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom), [{ id: "e1", title: "PS5 Pro $899", link: "https://d.example/2", publishedAt: "2026-11-03T16:00:00.000Z" }]);
  assert.throws(() => parseFeed("<html><body>hi</body></html>"));
});

test("deal feeds skip old posts and never claim stock", async () => {
  const { impl } = fakeFetch({
    "https://deals.example/rss": rss([
      { title: "PS5 Pro $849.99 at Walmart", link: "https://deals.example/a", pubDate: "Tue, 03 Nov 2026 17:00:00 GMT" },
      { title: "PS5 Pro $699 at Target", link: "https://deals.example/old", pubDate: "Sat, 24 Oct 2026 17:00:00 GMT" },
    ]),
  });
  const { fetcher } = testFetcher(impl);
  const result = await checkDealFeed(
    { id: "deals", kind: "deal_feed", enabled: true, name: "Deals", url: "https://deals.example/rss", respectRobots: false },
    fetcher,
    now,
    { maxDealAgeHours: 48, minPlausibleCents: 45000 },
  );
  assert.ok(result.ok);
  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0]!.retailer, "Walmart");
  assert.equal(result.listings[0]!.priceCents, 84999);
  assert.equal(result.listings[0]!.availability, "unknown");
});

test("Best Buy: builds official API requests, merges by SKU and maps availability", async () => {
  assert.equal(searchFilter("PS5 Pro"), "search=ps5&search=pro");
  assert.match(bestBuyUrl("search=ps5", "KEY"), /^https:\/\/api\.bestbuy\.com\/v1\/products\(search=ps5\)\?apiKey=KEY&format=json/);
  const products = [
    { sku: 6604999, name: "Sony - PlayStation 5 Pro Console - White", salePrice: 899.99, regularPrice: 899.99, onlineAvailability: true, orderable: "Available", condition: "New", url: "https://www.bestbuy.com/site/6604999.p" },
    { sku: 1111111, name: "Sony - PlayStation 5 Pro Console - Refurbished", salePrice: 699.99, onlineAvailability: false, orderable: "SoldOut", condition: "Refurbished", url: null },
  ];
  const { impl, calls } = fakeFetch({ "https://api.bestbuy.com/v1/products*": JSON.stringify({ products }) });
  const { fetcher } = testFetcher(impl);
  const source = parseConfig({ sources: [{ id: "bb", kind: "bestbuy_api" }] }).sources[0]!;
  assert.equal(source.kind, "bestbuy_api");
  const result = await checkBestBuy(source as Extract<typeof source, { kind: "bestbuy_api" }>, fetcher, now, "SECRET");
  assert.ok(result.ok);
  assert.equal(calls.length, 2, "one request per search phrase, no robots.txt for an API");
  assert.equal(result.listings.length, 2);
  const [first, second] = result.listings;
  assert.deepEqual([first!.priceCents, first!.availability, first!.condition], [89999, "in_stock", "new"]);
  assert.deepEqual([second!.availability, second!.condition], ["out_of_stock", "refurbished"]);
});

test("Best Buy: a refused key is reported without leaking it", async () => {
  const { impl } = fakeFetch({ "https://api.bestbuy.com/v1/products*": { status: 403, body: "<h1>Over quota</h1>" } });
  const { fetcher } = testFetcher(impl);
  const source = { id: "bb", kind: "bestbuy_api" as const, enabled: true, searches: ["ps5 pro"], skus: [] };
  const result = await checkBestBuy(source, fetcher, now, "SECRET-KEY");
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "blocked" && !result.error.includes("SECRET"));
  const missing = await checkBestBuy(source, fetcher, now, undefined);
  assert.ok(!missing.ok && missing.kind === "config");
});
