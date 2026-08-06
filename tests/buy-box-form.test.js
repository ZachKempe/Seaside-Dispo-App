// Tests for lib/buy-box-form.js — the tokenized buy-box form linked from the
// interest receipt (C2).
//
// The load-bearing one is the completeness invariant: the form's "that's
// everything" screen and matchesDeal's idea of a real buy box are two
// different code paths, and if they ever disagree we tell an investor they're
// done while still treating them as a wildcard who gets every deal.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  STRATEGY_PILLS, missingParts, buyBoxPatch, applyPatch,
  checkedPillValues, buyBoxUrlFor, shouldAskBuyBox,
} = require("../netlify/functions/lib/buy-box-form");
const { buyBoxCompleteness } = require("../public/js/deal-shared");
const { verifyDeckToken } = require("../netlify/functions/lib/deck-token");
const { parseStrategy } = require("../netlify/functions/lib/buyer-intake");

// ── The invariant ────────────────────────────────────────────────────
// missingParts() empty  <=>  buyBoxCompleteness() === "full", for every
// combination of the three things that decide it.
test("missingParts is empty for exactly the buyers buyBoxCompleteness calls full", () => {
  const statesOpts = ["", "FL", "FL,GA"];
  const strategyOpts = ["", "all", "subto", "subto,cash"];
  const moneyOpts = [
    { max_price: 0, max_piti: 0 },
    { max_price: 350000, max_piti: 0 },
    { max_price: 0, max_piti: 2200 },
    { max_price: 350000, max_piti: 2200 },
  ];
  let full = 0;
  for (const states of statesOpts) {
    for (const strategy of strategyOpts) {
      for (const money of moneyOpts) {
        const b = { states, strategy, ...money };
        const isFull = buyBoxCompleteness(b) === "full";
        if (isFull) full++;
        assert.strictEqual(
          missingParts(b).length === 0, isFull,
          `disagreement on ${JSON.stringify(b)}: missing=${JSON.stringify(missingParts(b))} completeness=${buyBoxCompleteness(b)}`
        );
      }
    }
  }
  assert.ok(full > 0, "the matrix must actually contain some full buy boxes");
});

test("missingParts names each thing that is still blank", () => {
  assert.deepStrictEqual(missingParts({}).length, 3);
  assert.deepStrictEqual(missingParts({ states: "FL", strategy: "subto", max_price: 300000 }), []);
  // "all" is the wildcard by another name — it must not count as an answer.
  assert.ok(missingParts({ states: "FL", strategy: "all", max_price: 300000 }).length === 1);
});

// ── The pill contract ────────────────────────────────────────────────
// Pill values are display text run through the same parser as the public
// questionnaire. Relabeling one silently changes who matches which deals, so
// each value is pinned to the key it must produce.
test("every strategy pill parses to its intended matchesDeal key", () => {
  const expected = {
    "Subject-To": "subto",
    "Seller Finance": "owner_finance",
    "Stack Method": "morby",
    "Cash": "cash",
  };
  assert.strictEqual(STRATEGY_PILLS.length, Object.keys(expected).length);
  for (const pill of STRATEGY_PILLS) {
    assert.strictEqual(parseStrategy(pill.value), expected[pill.value],
      `pill "${pill.value}" no longer parses to ${expected[pill.value]}`);
  }
});

test("multi-select pills survive as a comma list matchesDeal understands", () => {
  const patch = buyBoxPatch({ strategy: "Subject-To,Cash" });
  assert.strictEqual(patch.strategy, "subto,cash");
});

test("checkedPillValues re-ticks exactly what was stored", () => {
  assert.deepStrictEqual([...checkedPillValues("subto,cash")].sort(), ["Cash", "Subject-To"]);
  assert.deepStrictEqual([...checkedPillValues("")], []);
  // A wildcard is not a set of choices — nothing gets pre-ticked.
  assert.deepStrictEqual([...checkedPillValues("all")], []);
});

test("a stored strategy round-trips through the form unchanged", () => {
  for (const stored of ["subto", "cash", "morby,owner_finance", "subto,cash"]) {
    const resubmitted = [...checkedPillValues(stored)].join(",");
    assert.strictEqual(buyBoxPatch({ strategy: resubmitted }).strategy, stored,
      `re-submitting the prefilled form changed "${stored}"`);
  }
});

// ── The write rules ──────────────────────────────────────────────────
test("a blank field never overwrites what we already know", () => {
  const patch = buyBoxPatch({ states: "", strategy: "", max_price: "", max_piti: "", min_beds: "" });
  assert.deepStrictEqual(patch, {});
});

test("unparseable input is dropped rather than blanking a real answer", () => {
  // "Flarida" yields "" from parseStates; writing that would erase FL,GA.
  const patch = buyBoxPatch({ states: "Flarida" });
  assert.ok(!("states" in patch));
});

test("an empty strategy does not get recorded as the wildcard 'all'", () => {
  // parseStrategy falls back to "all" for anything it doesn't recognize, so an
  // unguarded write would record "ticked nothing" as "send me everything".
  assert.ok(!("strategy" in buyBoxPatch({ strategy: "" })));
  assert.ok(!("strategy" in buyBoxPatch({ strategy: "   " })));
});

test("price and monthly payment stay in their own columns", () => {
  const patch = buyBoxPatch({ max_price: "$350,000", max_piti: "2,200" });
  assert.strictEqual(patch.max_price, 350000);
  assert.strictEqual(patch.max_piti, 2200);
});

test("zero is treated as unanswered", () => {
  assert.deepStrictEqual(buyBoxPatch({ max_price: "0", max_piti: "0", min_beds: "0" }), {});
});

test("a junk cap is dropped, not saved as a filter that excludes everything", () => {
  // A cap is a filter: max_piti = 5 doesn't degrade to "no answer", it stops
  // this buyer matching any deal at all. Nothing out of band gets written.
  // "-5" is a live case, not a hypothetical — the shared parseInt0 strips the
  // minus sign, so it reaches us as a positive 5.
  assert.deepStrictEqual(buyBoxPatch({ max_piti: "-5" }), {});
  assert.deepStrictEqual(buyBoxPatch({ max_price: "12" }), {});
  assert.deepStrictEqual(buyBoxPatch({ min_beds: "99" }), {});
  // Real answers on the same fields still land.
  assert.deepStrictEqual(buyBoxPatch({ max_price: "350000", max_piti: "2200", min_beds: "3" }),
    { max_price: 350000, max_piti: 2200, min_beds: 3 });
});

test("a dropped junk cap still reads as missing, so the form asks again", () => {
  const after = applyPatch({ states: "FL", strategy: "subto" }, buyBoxPatch({ max_piti: "5" }));
  assert.deepStrictEqual(missingParts(after), ["your budget"]);
});

test("a partial answer completes a buy box across two visits", () => {
  const buyer = { states: "", strategy: "", max_price: 0, max_piti: 0 };
  const first = applyPatch(buyer, buyBoxPatch({ states: "FL,GA", strategy: "Subject-To" }));
  assert.strictEqual(buyBoxCompleteness(first), "partial");
  assert.strictEqual(missingParts(first).length, 1);

  const second = applyPatch(first, buyBoxPatch({ max_piti: "2200" }));
  assert.strictEqual(buyBoxCompleteness(second), "full");
  assert.deepStrictEqual(missingParts(second), []);
  // The second visit must not have cost them the first visit's answers.
  assert.strictEqual(second.states, "FL,GA");
  assert.strictEqual(second.strategy, "subto");
});

// ── Who gets asked ───────────────────────────────────────────────────
test("we stop asking a buyer whose box is already full", () => {
  assert.strictEqual(shouldAskBuyBox({ states: "FL", strategy: "subto", max_price: 300000 }), false);
  assert.strictEqual(shouldAskBuyBox({}), true);
  assert.strictEqual(shouldAskBuyBox({ states: "FL" }), true);
});

// ── The link ─────────────────────────────────────────────────────────
test("the receipt link carries a verifiable per-buyer token", () => {
  const url = buyBoxUrlFor("https://example.com", 42);
  const token = new URL(url).searchParams.get("t");
  assert.strictEqual(verifyDeckToken(token), 42);
});

test("a tampered token resolves to no buyer", () => {
  assert.strictEqual(verifyDeckToken("42.deadbeefdeadbeef"), null);
  assert.strictEqual(verifyDeckToken("43." + new URL(buyBoxUrlFor("https://x.co", 42)).searchParams.get("t").split(".")[1]), null);
});

test("no buyer id means no link at all", () => {
  assert.strictEqual(buyBoxUrlFor("https://example.com", null), "");
  assert.strictEqual(buyBoxUrlFor("https://example.com", 0), "");
});

test("a trailing slash on the site URL doesn't double up", () => {
  assert.ok(buyBoxUrlFor("https://example.com/", 7).startsWith("https://example.com/buy-box?t="));
});
