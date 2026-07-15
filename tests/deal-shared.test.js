// Tests for the shared deal logic (public/js/deal-shared.js) — the numbers
// that go into buyer emails/SMS/deck pages, and the matcher that decides who
// receives a blast. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  fmtMoney, fmtPct, matchesDeal, buyerCashAtClose,
  dscrMonthlyPayment, subtoSummaryRows, morbyTermRows,
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
