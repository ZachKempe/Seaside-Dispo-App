// Tests for the shared deal logic (public/js/deal-shared.js) — the numbers
// that go into buyer emails/SMS/deck pages, and the matcher that decides who
// receives a blast. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  fmtMoney, fmtPct, matchesDeal, buyerCashAtClose,
  dscrMonthlyPayment, subtoSummaryRows, morbyTermRows,
  engagementScore, engagementLevel,
  buyBoxCompleteness, buyBoxSplit, nearMissDeal,
} = require("../public/js/deal-shared");

// ── Formatting ────────────────────────────────────────────────────
test("fmtMoney formats and dashes out empties", () => {
  assert.equal(fmtMoney(1234567), "$1,234,567");
  assert.equal(fmtMoney("5000"), "$5,000");
  assert.equal(fmtMoney(0), "—");
  assert.equal(fmtMoney(null), "—");
  assert.equal(fmtMoney("not a number"), "—");
});

test("fmtPct formats to two decimals and dashes out empties", () => {
  assert.equal(fmtPct(7.5), "7.50%");
  assert.equal(fmtPct("3"), "3.00%");
  assert.equal(fmtPct(0), "—");
  assert.equal(fmtPct(null), "—");
});

// ── Buyer matching (who receives a blast) ─────────────────────────
const buyer = (over = {}) => ({
  strategy: "", states: "", max_price: 0, max_piti: 0, min_beds: 0, ...over,
});

test("strategy: buyer must hold the deal's strategy (or all/empty)", () => {
  assert.equal(matchesDeal(buyer({ strategy: "subto" }), "subto", "", 0, 0, 0), true);
  assert.equal(matchesDeal(buyer({ strategy: "subto" }), "morby", "", 0, 0, 0), false);
  assert.equal(matchesDeal(buyer({ strategy: "subto,morby" }), "morby", "", 0, 0, 0), true);
  assert.equal(matchesDeal(buyer({ strategy: "all" }), "morby", "", 0, 0, 0), true);
  assert.equal(matchesDeal(buyer({ strategy: "" }), "morby", "", 0, 0, 0), true);
  // case/whitespace tolerant ("SubTo, Morby" as stored by imports)
  assert.equal(matchesDeal(buyer({ strategy: "SubTo, Morby" }), "morby", "", 0, 0, 0), true);
});

test("states: filter only applies when both buyer and deal have one", () => {
  assert.equal(matchesDeal(buyer({ states: "FL,TX" }), "subto", "FL", 0, 0, 0), true);
  assert.equal(matchesDeal(buyer({ states: "FL,TX" }), "subto", "MN", 0, 0, 0), false);
  assert.equal(matchesDeal(buyer({ states: "fl, tx" }), "subto", "FL", 0, 0, 0), true); // case/space
  assert.equal(matchesDeal(buyer({ states: "" }), "subto", "MN", 0, 0, 0), true);       // open to all
  assert.equal(matchesDeal(buyer({ states: "FL" }), "subto", "", 0, 0, 0), true);       // deal state unknown
});

test("price / PITI / beds caps only apply when both sides have a value", () => {
  assert.equal(matchesDeal(buyer({ max_price: 300000 }), "subto", "", 350000, 0, 0), false);
  assert.equal(matchesDeal(buyer({ max_price: 300000 }), "subto", "", 250000, 0, 0), true);
  assert.equal(matchesDeal(buyer({ max_price: 300000 }), "subto", "", 0, 0, 0), true); // price unknown
  assert.equal(matchesDeal(buyer({ max_piti: 2000 }), "subto", "", 0, 2400, 0), false);
  assert.equal(matchesDeal(buyer({ max_piti: 2000 }), "subto", "", 0, 1800, 0), true);
  assert.equal(matchesDeal(buyer({ min_beds: 3 }), "subto", "", 0, 0, 2), false);
  assert.equal(matchesDeal(buyer({ min_beds: 3 }), "subto", "", 0, 0, 4), true);
  assert.equal(matchesDeal(buyer({ min_beds: 3 }), "subto", "", 0, 0, 0), true); // beds unknown
});

// ── Buy-box completeness (B4.1) ───────────────────────────────────
test("completeness: a buyer with nothing on file is a wildcard", () => {
  assert.equal(buyBoxCompleteness(buyer()), "wildcard");
  assert.equal(buyBoxCompleteness({}), "wildcard");
  assert.equal(buyBoxCompleteness(null), "wildcard");
  // "all" is not a strategy — it is the absence of one
  assert.equal(buyBoxCompleteness(buyer({ strategy: "all" })), "wildcard");
  assert.equal(buyBoxCompleteness(buyer({ strategy: " All " })), "wildcard");
});

test("completeness: any single real constraint lifts a buyer out of wildcard", () => {
  assert.equal(buyBoxCompleteness(buyer({ states: "FL" })), "partial");
  assert.equal(buyBoxCompleteness(buyer({ strategy: "subto" })), "partial");
  assert.equal(buyBoxCompleteness(buyer({ max_price: 300000 })), "partial");
  assert.equal(buyBoxCompleteness(buyer({ max_piti: 2000 })), "partial");
  // a bed floor filters real deals, so it is not "matches everything" either
  assert.equal(buyBoxCompleteness(buyer({ min_beds: 3 })), "partial");
});

test("completeness: full needs a market AND a strategy AND a money cap", () => {
  assert.equal(buyBoxCompleteness(buyer({ states: "FL", strategy: "subto", max_price: 300000 })), "full");
  assert.equal(buyBoxCompleteness(buyer({ states: "FL", strategy: "subto", max_piti: 2000 })), "full");
  assert.equal(buyBoxCompleteness(buyer({ states: "FL", strategy: "subto" })), "partial");
  assert.equal(buyBoxCompleteness(buyer({ states: "FL", strategy: "all", max_price: 300000 })), "partial");
});

test("completeness split counts an audience", () => {
  const split = buyBoxSplit([
    buyer(),
    buyer({ strategy: "all" }),
    buyer({ states: "FL" }),
    buyer({ states: "FL", strategy: "subto", max_price: 300000 }),
  ]);
  assert.deepEqual(split, { full: 1, partial: 1, wildcard: 2, total: 4 });
  assert.deepEqual(buyBoxSplit([]), { full: 0, partial: 0, wildcard: 0, total: 0 });
});

// ── Tolerance bands / near misses (B4.4) ──────────────────────────
test("near miss: an actual match is never a near miss", () => {
  assert.equal(nearMissDeal(buyer({ max_price: 400000 }), "subto", "FL", 350000, 0, 0), null);
});

test("near miss: just over a money cap, but not far over", () => {
  // $330k against a $300k cap = 10% over → inside the band
  const hit = nearMissDeal(buyer({ max_price: 300000 }), "subto", "", 330000, 0, 0);
  assert.ok(hit);
  assert.match(hit.reasons[0], /10% over their \$300,000 price cap/);
  // $340k = 13% over → outside
  assert.equal(nearMissDeal(buyer({ max_price: 300000 }), "subto", "", 340000, 0, 0), null);
  // PITI band works the same way
  assert.ok(nearMissDeal(buyer({ max_piti: 2000 }), "subto", "", 0, 2100, 0));
  assert.equal(nearMissDeal(buyer({ max_piti: 2000 }), "subto", "", 0, 2500, 0), null);
});

test("near miss: one bedroom short counts, two does not", () => {
  assert.ok(nearMissDeal(buyer({ min_beds: 3 }), "subto", "", 0, 0, 2));
  assert.equal(nearMissDeal(buyer({ min_beds: 3 }), "subto", "", 0, 0, 1), null);
});

test("near miss: wrong state or wrong strategy is never close", () => {
  // out of market, money fine
  assert.equal(nearMissDeal(buyer({ states: "FL" }), "subto", "TX", 0, 0, 0), null);
  // wrong strategy, money fine
  assert.equal(nearMissDeal(buyer({ strategy: "cash" }), "subto", "", 0, 0, 0), null);
  // out of market AND barely over budget — still not a near miss
  assert.equal(nearMissDeal(buyer({ states: "FL", max_price: 300000 }), "subto", "TX", 310000, 0, 0), null);
});

test("near miss: tolerance is caller-overridable and collects every reason", () => {
  const wide = nearMissDeal(buyer({ max_price: 300000 }), "subto", "", 340000, 0, 0, 0.25);
  assert.ok(wide);
  const both = nearMissDeal(buyer({ max_price: 300000, min_beds: 3 }), "subto", "", 310000, 0, 2);
  assert.equal(both.reasons.length, 2);
  // a zero tolerance band leaves nothing near
  assert.equal(nearMissDeal(buyer({ max_price: 300000 }), "subto", "", 310000, 0, 0, 0), null);
});

// ── buyerCashAtClose (the headline number in Morby emails/SMS/deck) ──
test("cash at close: loan proceeds − down − 5% closing, halved", () => {
  // 400k × 75% LTV = 300k; − 40k down − 20k closing = 240k; ÷2 = 120k
  assert.equal(buyerCashAtClose({ purchase_price: 400000, down_payment: 40000, dscr_ltv: 75 }), 120000);
});

test("cash at close: LTV defaults — 75% SFH, 70% commercial", () => {
  // SFH default: 400k×75% − 20k closing = 280k; ÷2 = 140k
  assert.equal(buyerCashAtClose({ purchase_price: 400000 }), 140000);
  // Commercial default: 400k×70% − 20k closing = 260k; ÷2 = 130k
  assert.equal(buyerCashAtClose({ purchase_price: 400000, property_type: "commercial" }), 130000);
  // Explicit dscr_ltv wins over the default
  assert.equal(buyerCashAtClose({ purchase_price: 400000, dscr_ltv: 80 }), 150000);
});

test("cash at close: additional broker fee comes off the top", () => {
  // 400k×75% = 300k; − 40k − 20k − 8k (2%) = 232k; ÷2 = 116k
  assert.equal(
    buyerCashAtClose({ purchase_price: 400000, down_payment: 40000, dscr_ltv: 75, additional_broker_pct: 2 }),
    116000
  );
});

test("cash at close: never negative, zero without a price", () => {
  // 100k×75% = 75k; − 80k down − 5k closing = −10k → clamp to 0
  assert.equal(buyerCashAtClose({ purchase_price: 100000, down_payment: 80000 }), 0);
  assert.equal(buyerCashAtClose({}), 0);
  assert.equal(buyerCashAtClose({ purchase_price: null }), 0);
});

// ── dscrMonthlyPayment ────────────────────────────────────────────
test("DSCR payment matches standard 30-yr amortization", () => {
  // $400k × 75% = $300k principal @ 7.75%/30yr → $2,149.24/mo
  // (pinned regression value; agrees with standard mortgage tables)
  assert.equal(dscrMonthlyPayment(400000, 7.75, 75).toFixed(2), "2149.24");
  // Commercial defaults case: $400k × 70% = $280k @ 8.5%/30yr → $2,152.96/mo
  assert.equal(dscrMonthlyPayment(400000, 8.5, 70).toFixed(2), "2152.96");
});

test("DSCR payment is 0 when price or rate is missing", () => {
  assert.equal(dscrMonthlyPayment(0, 7.75, 75), 0);
  assert.equal(dscrMonthlyPayment(400000, 0, 75), 0);
  assert.equal(dscrMonthlyPayment(400000, 7.75, 0), 0);
});

// ── Engagement score ──────────────────────────────────────────────
const NOW = Date.parse("2026-07-15T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

test("engagement: zero signals is 0, interest tap is the strongest signal", () => {
  assert.equal(engagementScore({}, null, NOW), 0);
  assert.equal(engagementScore({ interest: 1 }, daysAgo(1), NOW), 30);
  // an interested buyer outranks any pile of opens (opens cap at 10)
  assert.ok(engagementScore({ interest: 1 }, daysAgo(1), NOW) >
            engagementScore({ open: 50 }, daysAgo(1), NOW));
});

test("engagement: per-signal caps prevent volume gaming", () => {
  // 100 opens score the same as 5 opens (cap 10 pts)
  assert.equal(engagementScore({ open: 100 }, daysAgo(1), NOW),
               engagementScore({ open: 5 }, daysAgo(1), NOW));
  // views cap at 3 (24 pts)
  assert.equal(engagementScore({ view: 3 }, daysAgo(1), NOW),
               engagementScore({ view: 30 }, daysAgo(1), NOW));
});

test("engagement: recency decay — same signals fade over time", () => {
  const counts = { view: 2, open: 3 };
  const fresh = engagementScore(counts, daysAgo(2), NOW);
  const monthOld = engagementScore(counts, daysAgo(20), NOW);
  const stale = engagementScore(counts, daysAgo(120), NOW);
  assert.ok(fresh > monthOld && monthOld > stale && stale >= 1);
  assert.equal(fresh, 22);          // 2×8 + 3×2 = 22, no decay inside 7d
  assert.equal(monthOld, 13);       // 22 × 0.6
});

test("engagement: clamps to 100 and levels band correctly", () => {
  const max = engagementScore(
    { interest: 5, reply: 5, view: 5, longDwell: 5, pdf: 5, click: 5, open: 5 },
    daysAgo(0), NOW
  );
  assert.equal(max, 100);
  assert.equal(engagementLevel(100), "hot");
  assert.equal(engagementLevel(60), "hot");
  assert.equal(engagementLevel(45), "warm");
  assert.equal(engagementLevel(10), "quiet");
  assert.equal(engagementLevel(0), "none");
});

test("engagement: a spam complaint outweighs any positive history", () => {
  const busy = { interest: 5, reply: 5, view: 5, click: 5, open: 5 };
  assert.equal(engagementScore(busy, daysAgo(0), NOW), 100);
  assert.equal(engagementScore({ ...busy, complaint: 1 }, daysAgo(0), NOW), 0);
  assert.equal(engagementLevel(engagementScore({ ...busy, complaint: 1 }, daysAgo(0), NOW)), "none");
});

test("engagement: hard bounces dock the score without erasing it", () => {
  const counts = { view: 3, open: 5 };
  const clean = engagementScore(counts, daysAgo(1), NOW);          // 24 + 10 = 34
  const bounced = engagementScore({ ...counts, bounce: 1 }, daysAgo(1), NOW);
  assert.equal(clean, 34);
  assert.equal(bounced, 19);                                       // 34 − 15
  // the bounce penalty is capped, so a bounce loop can't drive it far negative
  assert.equal(engagementScore({ ...counts, bounce: 9 }, daysAgo(1), NOW), 4); // 34 − 30
});

test("engagement: penalties don't fade with recency the way signals do", () => {
  // Positives decay (×0.35 past 30 days), the complaint does not.
  assert.equal(engagementScore({ view: 3, open: 5 }, daysAgo(60), NOW), 12);
  assert.equal(engagementScore({ view: 3, open: 5, complaint: 1 }, daysAgo(60), NOW), 0);
});

test("engagement: a penalty alone still scores 0, never negative", () => {
  assert.equal(engagementScore({ complaint: 1 }, daysAgo(1), NOW), 0);
  assert.equal(engagementScore({ bounce: 2 }, daysAgo(1), NOW), 0);
});

// ── Term rows (what the deck page + Morby email tables show) ──────
test("subtoSummaryRows renders present fields and drops missing ones", () => {
  const rows = subtoSummaryRows({ entry_fee: 45000, price: 320000, piti: 2100, beds: 3, baths: 2 });
  const byLabel = Object.fromEntries(rows);
  assert.equal(byLabel["Entry Fee"], "$45,000 + TC + CC");
  assert.equal(byLabel["Purchase Price"], "$320,000");
  assert.equal(byLabel["PITI"], "$2,100/mo");
  assert.equal(byLabel["Beds / Baths"], "3 bd / 2 ba");
  assert.ok(!("Sqft" in byLabel));
  assert.ok(!("Rate" in byLabel));
  assert.equal(subtoSummaryRows({}).length, 0);
});

test("morbyTermRows renders present fields and drops missing ones", () => {
  const rows = morbyTermRows({
    purchase_price: 400000, down_payment: 40000, deferred_interest_rate: 3,
    balloon_months: 60, inspection_period_days: 14,
  });
  const byLabel = Object.fromEntries(rows);
  assert.equal(byLabel["Purchase Price"], "$400,000");
  assert.equal(byLabel["Down Payment"], "$40,000");
  assert.equal(byLabel["Deferred Rate"], "3.00%");
  assert.equal(byLabel["Balloon"], "60 months");
  assert.equal(byLabel["Inspection Period"], "14 days");
  assert.ok(!("Seller Carry" in byLabel));
  assert.ok(!("Monthly Payment" in byLabel));
  assert.equal(morbyTermRows({}).length, 0);
});
