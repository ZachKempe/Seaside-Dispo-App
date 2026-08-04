// Tests for lib/buyer-intake.js — how a submitted buy-box questionnaire turns
// into buyer columns. These pin the two C2 fixes: a cash buyer's max price
// actually lands, and a buyer who picks several deal structures keeps all of
// them. Both feed matchesDeal and buyBoxCompleteness, so getting them wrong
// either mis-targets blasts or keeps asking someone for a box they already
// gave. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseStates, parseStrategy, parseInt0, parseMaxPrice } =
  require("../netlify/functions/lib/buyer-intake");
const { buyBoxCompleteness } = require("../public/js/deal-shared");

// ── States ────────────────────────────────────────────────────────
test("parseStates accepts names and abbreviations, dedupes, uppercases", () => {
  assert.equal(parseStates("Florida, GA"), "FL,GA");
  assert.equal(parseStates("texas;Texas,TX"), "TX");
  assert.equal(parseStates("fl , ga , al"), "FL,GA,AL");
  assert.equal(parseStates("Narnia"), "");
  assert.equal(parseStates(""), "");
  assert.equal(parseStates(null), "");
});

// ── Strategy: the multi-select fix ────────────────────────────────
test("parseStrategy keeps EVERY structure the buyer picked", () => {
  assert.equal(parseStrategy("Subject-To,Cash"), "subto,cash");
  assert.equal(parseStrategy("Subject-To,Stack Method,Seller Finance,Cash"),
    "morby,subto,owner_finance,cash");
});

test("parseStrategy emits a canonical order, not tap order", () => {
  assert.equal(parseStrategy("Cash,Subject-To"), "subto,cash");
  assert.equal(parseStrategy("Subject-To,Cash"), parseStrategy("Cash,Subject-To"));
});

test("parseStrategy still resolves each structure on its own", () => {
  assert.equal(parseStrategy("Subject-To"), "subto");
  assert.equal(parseStrategy("Stack Method"), "morby");
  assert.equal(parseStrategy("Seller Finance"), "owner_finance");
  assert.equal(parseStrategy("Cash"), "cash");
});

test('parseStrategy treats "all of the above" as an explicit all', () => {
  assert.equal(parseStrategy("All Strategies"), "all");
  assert.equal(parseStrategy("✦ All of the above"), "all");
  assert.equal(parseStrategy("Cash,All Strategies"), "all");
});

test("parseStrategy falls back to all on blank or unrecognized input", () => {
  assert.equal(parseStrategy(""), "all");
  assert.equal(parseStrategy(null), "all");
  assert.equal(parseStrategy("whatever you've got"), "all");
});

// ── Money ─────────────────────────────────────────────────────────
test("parseInt0 strips formatting and floors to an integer", () => {
  assert.equal(parseInt0("$350,000"), 350000);
  assert.equal(parseInt0("2500"), 2500);
  assert.equal(parseInt0(""), 0);
  assert.equal(parseInt0(null), 0);
  assert.equal(parseInt0("none"), 0);
});

test("parseMaxPrice reads the cash buyer's purchase cap", () => {
  assert.equal(parseMaxPrice({ cash_max_price: "300000" }), 300000);
  assert.equal(parseMaxPrice({ cash_max_price: "$300,000" }), 300000);
  assert.equal(parseMaxPrice({ max_price: "250000" }), 250000);
  assert.equal(parseMaxPrice({}), 0);
  assert.equal(parseMaxPrice(null), 0);
});

test("parseMaxPrice ignores sf_max_down — a down payment is not a price cap", () => {
  // Mapping it to max_price would exclude buyers who can easily afford the
  // deal: matchesDeal compares max_price against the deal's asking price.
  assert.equal(parseMaxPrice({ sf_max_down: "20000" }), 0);
});

// ── The loop actually closing ─────────────────────────────────────
test("a completed cash questionnaire now classifies as a full buy box", () => {
  const submission = { states: "Florida, GA", strategy: "Cash", cash_max_price: "300000" };
  const buyer = {
    states: parseStates(submission.states),
    strategy: parseStrategy(submission.strategy),
    max_price: parseMaxPrice(submission),
    max_piti: 0,
    min_beds: 0,
  };
  assert.equal(buyer.max_price, 300000);
  // This is the whole point: `full` is what stops onboard-buyers.js asking.
  assert.equal(buyBoxCompleteness(buyer), "full");
});

test("the same submission was only `partial` under the old mapping", () => {
  // Regression guard — max_price hardcoded to 0 left a fully-answered cash
  // buyer in the onboarding sequence forever.
  const oldWay = { states: "FL,GA", strategy: "cash", max_price: 0, max_piti: 0, min_beds: 0 };
  assert.equal(buyBoxCompleteness(oldWay), "partial");
});

test("a multi-structure buyer matches every structure they picked", () => {
  const { matchesDeal } = require("../public/js/deal-shared");
  const buyer = { strategy: parseStrategy("Subject-To,Cash"), states: "FL", max_price: 0, max_piti: 0, min_beds: 0 };
  assert.equal(matchesDeal(buyer, "subto", "FL", 0, 0, 0), true);
  assert.equal(matchesDeal(buyer, "cash", "FL", 0, 0, 0), true);
  // Still excluded from what they did NOT pick.
  assert.equal(matchesDeal(buyer, "morby", "FL", 0, 0, 0), false);
});
