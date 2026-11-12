// dealCashFlow — the one P&L behind the PDF deck and the deck page's
// "doesn't cash flow" callout — and the nearest-city distance it pairs with.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const DS = require("../public/js/deal-shared");
const { nearestCity, describeNearestCity } = require("../netlify/functions/lib/nearest-city");

test("rent below debt service → flows === false", () => {
  // $200k @ 7.75% / 75% LTV ≈ $1,075/mo debt service vs $1,000 rent
  const cf = DS.dealCashFlow({ purchase_price: 200000, ltr_monthly_rent: 1000 });
  assert.ok(cf.debtService > 1000);
  assert.strictEqual(cf.flows, false);
  assert.ok(cf.ltrNet < 0);
});

test("positive on either strategy counts as cash flowing", () => {
  const cf = DS.dealCashFlow({ purchase_price: 200000, ltr_monthly_rent: 1000, str_monthly_rent: 4000 });
  assert.strictEqual(cf.flows, true);
});

test("no rent on file is unknown, never 'doesn't cash flow'", () => {
  assert.strictEqual(DS.dealCashFlow({ purchase_price: 200000 }).flows, null);
  assert.strictEqual(DS.dealCashFlow({ purchase_price: 200000, property_type: "commercial" }).flows, null);
});

test("an STR rent of 0 is not counted as a losing strategy", () => {
  const cf = DS.dealCashFlow({ purchase_price: 100000, ltr_monthly_rent: 2500 });
  assert.strictEqual(cf.flows, true);
});

test("seller note payment counts against Morby but a cash deal has none", () => {
  const base = { ltr_monthly_rent: 2000, monthly_payment: 5000 };
  assert.strictEqual(DS.dealCashFlow({ ...base, purchase_price: 100000 }).flows, false);
  const cash = DS.dealCashFlow({ ...base, purchase_price: 100000 }, { isCash: true });
  assert.strictEqual(cash.sellerPmt, 0);
  assert.strictEqual(cash.flows, true);
});

test("cash deal sizes the loan off the derived purchase price", () => {
  const cf = DS.dealCashFlow({ original_price: 300000, amount_forgiven: 100000, ltr_monthly_rent: 1 }, { isCash: true });
  assert.strictEqual(cf.price, 200000);
});

test("commercial uses NOI (monthly or annual/12)", () => {
  const a = DS.dealCashFlow({ property_type: "commercial", purchase_price: 1000000, annual_noi: 60000 });
  assert.strictEqual(a.noi, 5000);
  assert.strictEqual(a.flows, false); // ~$5.2k debt service at 8.5% / 70%
  assert.strictEqual(DS.dealCashFlow({ property_type: "commercial", purchase_price: 1000000, monthly_noi: 9000 }).flows, true);
});

test("nearestCity finds the closest bundled city", () => {
  const n = nearestCity(27.95, -82.46);
  assert.strictEqual(n.city, "Tampa");
  assert.strictEqual(nearestCity("x", 1), null);
});

test("describeNearestCity copy", () => {
  assert.strictEqual(describeNearestCity({ city: "Memphis", state: "TN", miles: 66 }), "~66 mi from Memphis, TN");
  assert.strictEqual(describeNearestCity({ city: "Tampa", state: "FL", miles: 1 }), "Minutes from Tampa, FL");
  assert.strictEqual(describeNearestCity(null), "");
});
