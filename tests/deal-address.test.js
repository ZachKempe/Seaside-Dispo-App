// The Deal Deck Address override, and the static guard that keeps it working.
//
// `address_override` lives on morby_deals (migration 012) and cash_deals (035)
// — never on `properties`. Reading it off a properties row doesn't throw and
// doesn't 400 on a select the way deck-link.js once did; it just evaluates to
// undefined and falls through to the card name. That silence is why every
// Morby deck page, blast email, blast SMS and PDF filename ignored the address
// Zach had corrected, for as long as the column has existed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { dealAddress, OVERRIDE_TABLE } = require("../netlify/functions/lib/deal-address");

const ROOT = path.join(__dirname, "..");
const FUNCTIONS_DIR = path.join(ROOT, "netlify", "functions");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

test("the override wins over the card name", () => {
  assert.equal(
    dealAddress({ name: "New Morby Deal" }, { address_override: "3014 N Tampa St, Tampa, FL" }),
    "3014 N Tampa St, Tampa, FL",
  );
});

test("a blank or whitespace override falls back to the card name", () => {
  assert.equal(dealAddress({ name: "123 Main St" }, { address_override: "" }), "123 Main St");
  assert.equal(dealAddress({ name: "123 Main St" }, { address_override: "   " }), "123 Main St");
  assert.equal(dealAddress({ name: "123 Main St" }, { address_override: null }), "123 Main St");
});

test("no structure row (Sub-To) is the card name, and never a crash", () => {
  assert.equal(dealAddress({ name: "123 Main St" }, null), "123 Main St");
  assert.equal(dealAddress({ name: "123 Main St" }, undefined), "123 Main St");
  assert.equal(dealAddress(null, null), "");
});

test("card_id is the last resort, so the address is never empty for a real deal", () => {
  assert.equal(dealAddress({ card_id: "cash-abc" }, {}), "cash-abc");
});

test("every structure that can hold an override is mapped", () => {
  // A structure missing here means fetchDealAddress silently returns the card
  // name for it — the exact failure this file documents.
  assert.deepEqual(Object.keys(OVERRIDE_TABLE).sort(), ["cash", "morby"]);
  assert.equal(OVERRIDE_TABLE.morby, "morby_deals");
  assert.equal(OVERRIDE_TABLE.cash, "cash_deals");
});

test("no function reads address_override off a properties row", () => {
  // The regression guard. `prop`/`p` are the conventional names for a
  // properties row across these functions; the override must come from the
  // structure row (or lib/deal-address.js), never from one of these.
  const offenders = [];
  for (const f of jsFiles(FUNCTIONS_DIR)) {
    const src = fs.readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => {
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      if (/\b(prop|p|property)\.address_override\b/.test(line)) {
        offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `address_override read off a properties row:\n${offenders.join("\n")}`);
});
