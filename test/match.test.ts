import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTitle } from "../src/match.ts";
import { toCents, formatCents } from "../src/money.ts";

const consoles = [
  "Sony - PlayStation 5 Pro Console – Digital Edition - White",
  "PlayStation®5 Pro Console",
  "PS5 Pro $849.99 at Walmart",
  "Sony PlayStation 5 Pro 2TB Console with DualSense Wireless Controller",
  "PS5 Pro Console Call of Duty Black Ops Bundle",
  "PlayStation 5 Pro Console + Disc Drive Bundle",
  "[Target] PlayStation5 Pro - $899.99 with free shipping",
];
const notConsoles = [
  "Vertical Stand for PS5 Pro with Cooling Fan",
  "DualSense Edge Wireless Controller",
  "Skin Decal compatible with PS5 Pro",
  "Gran Turismo 7 - PS5 Pro Enhanced",
  "PlayStation 5 Slim Console",
  "Carrying Case Bag for PlayStation 5 Pro",
  "PS5 Pro Faceplates Cover Plates - Black",
  "Disc Drive for PS5 Pro",
];

test("recognizes PS5 Pro consoles and bundles", () => {
  for (const t of consoles) assert.equal(checkTitle(t).isConsole, true, t);
});

test("rejects accessories, games and other models", () => {
  for (const t of notConsoles) assert.equal(checkTitle(t).isConsole, false, t);
});

test("detects refurbished and used listings", () => {
  assert.equal(checkTitle("Sony PlayStation 5 Pro Console (Renewed)").condition, "refurbished");
  assert.equal(checkTitle("Pre-Owned PS5 Pro Console").condition, "used");
  assert.equal(checkTitle("Open Box: PlayStation 5 Pro Console").condition, "used");
  assert.equal(checkTitle("PlayStation 5 Pro Console").condition, "unknown");
});

test("parses and formats money as integer cents", () => {
  assert.equal(toCents("899.99"), 89999);
  assert.equal(toCents("$1,049.99"), 104999);
  assert.equal(toCents(749), 74900);
  assert.equal(toCents("call for price"), null);
  assert.equal(toCents(-5), null);
  assert.equal(formatCents(104999), "$1,049.99");
});
