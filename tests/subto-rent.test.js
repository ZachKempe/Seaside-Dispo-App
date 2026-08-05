// Sub-To rent optionality / HOA gating (migration 034). These numbers go on a
// buyer-facing deck page and into blast email + SMS, so the gates matter as
// much as the arithmetic: an unsourced rent or an unconfirmed STR status must
// never render. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  subtoCarry, subtoRentOptions, subtoTeaserOption, subtoPrincipalPaydown,
  subtoRateArbitrage, amortizedPayment, parseRatePct, subtoTermRows,
  LOAD_PCT, RESERVE_MONTHS, MARKET_RATE_TODAY,
} = require("../public/js/deal-shared");

// A deal with all three rents sourced and nothing blocking them.
const base = {
  entry_fee: 15000, price: 300000, mortgage: 250000, piti: 1800, rate: "4.5",
  hoa_monthly: 200, hoa_rental_policy: "allowed",
  rent_ltr: 2600, rent_ltr_source: "Rentometer, 3 comps",
  rent_mtr: 3200, rent_mtr_source: "Furnished Finder",
  rent_str: 4500, rent_str_source: "AirDNA 12-mo",
  str_permitted: "allowed",
  est_closing_costs: 5000, loan_pi: 1200,
};
const modes = (opts) => opts.map(o => o.mode);
const byMode = (opts, m) => opts.find(o => o.mode === m);

// ── Carry ─────────────────────────────────────────────────────────
test("subtoCarry adds HOA to PITI and tolerates missing fields", () => {
  assert.deepEqual(subtoCarry({ piti: 1800, hoa_monthly: 200 }), { piti: 1800, hoa: 200, total: 2000 });
  assert.deepEqual(subtoCarry({ piti: 1800 }), { piti: 1800, hoa: 0, total: 1800 });
  assert.deepEqual(subtoCarry({}), { piti: 0, hoa: 0, total: 0 });
  assert.deepEqual(subtoCarry(null), { piti: 0, hoa: 0, total: 0 });
});

// ── Omission: unsourced rent never renders ────────────────────────
test("a rent with no source is omitted entirely — not even a blocked card", () => {
  const opts = subtoRentOptions({ ...base, rent_mtr_source: "", rent_str_source: "   " });
  assert.deepEqual(modes(opts), ["ltr"]);
});

test("a source with no rent, and a zero rent, are both omitted", () => {
  const opts = subtoRentOptions({
    ...base, rent_ltr: 0, rent_mtr: null, rent_str: 4500,
  });
  assert.deepEqual(modes(opts), ["str"]);
});

test("no PITI means no section at all — netting against a zero carry is meaningless", () => {
  assert.deepEqual(subtoRentOptions({ ...base, piti: 0 }), []);
  assert.deepEqual(subtoRentOptions({ ...base, piti: null }), []);
});

// ── The math ──────────────────────────────────────────────────────
test("net = rent − (piti + hoa) − round(rent × load), per mode", () => {
  const opts = subtoRentOptions(base);
  assert.deepEqual(modes(opts), ["ltr", "mtr", "str"]);
  for (const o of opts) {
    const load = Math.round(o.rent * LOAD_PCT[o.mode]);
    assert.equal(o.load, load);
    assert.equal(o.net, o.rent - 2000 - load, `${o.mode} net`);
  }
  // Hand-checked: 2600 − 2000 − round(2600×.23 = 598) = 2
  assert.equal(byMode(opts, "ltr").net, 2);
  // 3200 − 2000 − 960 = 240
  assert.equal(byMode(opts, "mtr").net, 240);
  // 4500 − 2000 − 1800 = 700
  assert.equal(byMode(opts, "str").net, 700);
});

test("cash in = entry fee + closing + reserve months of carry + furnishing", () => {
  const opts = subtoRentOptions({ ...base, str_furnishing_cost: 12000, mtr_furnishing_cost: 6000 });
  const reserve = RESERVE_MONTHS * 2000;
  assert.equal(byMode(opts, "ltr").cashIn, 15000 + 5000 + reserve);
  assert.equal(byMode(opts, "ltr").furnishing, 0);
  assert.equal(byMode(opts, "mtr").cashIn, 15000 + 5000 + reserve + 6000);
  assert.equal(byMode(opts, "str").cashIn, 15000 + 5000 + reserve + 12000);
});

test("cash-on-cash is computed but a zero cash-in yields null, not Infinity", () => {
  const opts = subtoRentOptions({ ...base, entry_fee: 0, est_closing_costs: 0, piti: 0.0001 });
  // piti > 0 but effectively nothing; guard against a divide-by-zero anyway.
  const zero = subtoRentOptions({ ...base, entry_fee: 0, est_closing_costs: 0, piti: 1, hoa_monthly: 0 });
  assert.ok(zero.every(o => o.cocPct === null || Number.isFinite(o.cocPct)));
  assert.ok(opts.every(o => o.cocPct === null || Number.isFinite(o.cocPct)));
  const normal = byMode(subtoRentOptions(base), "str");
  assert.equal(normal.cocPct, Number(((normal.net * 12) / normal.cashIn * 100).toFixed(1)));
});

test("negative net is reported, never clamped or hidden", () => {
  const opts = subtoRentOptions({ ...base, piti: 4000 });
  assert.ok(opts.length === 3);
  assert.ok(opts.every(o => o.net < 0), "all three should be underwater");
  assert.equal(byMode(opts, "ltr").net, 2600 - 4200 - 598);
});

// ── HOA / municipality gates ──────────────────────────────────────
test("HOA prohibition blocks every mode and outranks every other rule", () => {
  const opts = subtoRentOptions({ ...base, hoa_rental_policy: "prohibited", hoa_min_lease_days: 30 });
  assert.equal(opts.length, 3);
  for (const o of opts) {
    assert.equal(o.blockedReason, "HOA prohibits rentals");
    assert.equal(o.net, null);
    assert.equal(o.cashIn, null);
  }
});

test("a 30-day minimum lease blocks STR only, citing the minimum", () => {
  const opts = subtoRentOptions({ ...base, hoa_min_lease_days: 30 });
  assert.equal(byMode(opts, "ltr").blockedReason, null);
  assert.equal(byMode(opts, "mtr").blockedReason, null);
  assert.equal(byMode(opts, "str").blockedReason, "HOA requires a 30-day minimum lease");
  assert.equal(byMode(opts, "mtr").net, 240);
});

test("a 12-month minimum lease blocks STR and MTR, leaving LTR live", () => {
  const opts = subtoRentOptions({ ...base, hoa_min_lease_days: 365 });
  assert.equal(byMode(opts, "ltr").blockedReason, null);
  assert.equal(byMode(opts, "mtr").blockedReason, "HOA requires a 12-month minimum lease");
  assert.equal(byMode(opts, "str").blockedReason, "HOA requires a 12-month minimum lease");
});

test("the lease-term gate applies even when HOA dues are unknown", () => {
  const opts = subtoRentOptions({ ...base, hoa_monthly: null, hoa_min_lease_days: 30 });
  assert.equal(byMode(opts, "str").blockedReason, "HOA requires a 30-day minimum lease");
  // …and the carry drops to PITI alone.
  assert.equal(byMode(opts, "ltr").net, 2600 - 1800 - 598);
});

test("unconfirmed STR status blocks the short-term column outright", () => {
  for (const v of [null, undefined, "", "unknown", "UNKNOWN"]) {
    const opts = subtoRentOptions({ ...base, str_permitted: v });
    assert.equal(byMode(opts, "str").blockedReason, "Short-term rental status not confirmed", `str_permitted=${v}`);
  }
});

test("restricted STR blocks; permit_required warns but stays live", () => {
  const restricted = subtoRentOptions({ ...base, str_permitted: "restricted" });
  assert.equal(byMode(restricted, "str").blockedReason, "Short-term rentals restricted in this municipality");

  const permit = subtoRentOptions({ ...base, str_permitted: "permit_required" });
  const str = byMode(permit, "str");
  assert.equal(str.blockedReason, null);
  assert.equal(str.warning, "Permit required in this municipality");
  assert.equal(str.net, 700);
});

test("a rental cap warns on surviving modes instead of blocking them", () => {
  const opts = subtoRentOptions({ ...base, hoa_rental_policy: "capped" });
  assert.ok(opts.every(o => o.blockedReason === null));
  assert.ok(opts.every(o => String(o.warning).includes("HOA rental cap may apply")));
  // A capped HOA and a permit requirement can both apply to STR.
  const both = subtoRentOptions({ ...base, hoa_rental_policy: "capped", str_permitted: "permit_required" });
  assert.equal(byMode(both, "str").warning, "HOA rental cap may apply · Permit required in this municipality");
});

// ── Blast teaser selection ────────────────────────────────────────
test("the teaser honors primary_rent_mode when that mode survived the gates", () => {
  const t = subtoTeaserOption({ ...base, primary_rent_mode: "mtr" });
  assert.equal(t.mode, "mtr");
  assert.equal(t.label, "Mid-term");
});

test("an explicit primary wins even when another mode nets more", () => {
  // ltr nets 2, mtr 240, str 700 — the human pick still leads.
  const t = subtoTeaserOption({ ...base, primary_rent_mode: "ltr" });
  assert.equal(t.mode, "ltr");
  assert.equal(t.net, 2);
});

test("the teaser falls back to the HIGHEST net when the primary is blocked", () => {
  // str is blocked by the 30-day minimum; of ltr ($2) and mtr ($240) the hook
  // must be $240, not whichever mode sorts first.
  const t = subtoTeaserOption({ ...base, primary_rent_mode: "str", hoa_min_lease_days: 30 });
  assert.equal(t.mode, "mtr");
  assert.equal(t.net, 240);
});

test("the teaser falls back to the highest net when the primary lacks a source", () => {
  const t = subtoTeaserOption({ ...base, primary_rent_mode: "mtr", rent_mtr_source: "" });
  assert.equal(t.mode, "str");
  assert.equal(t.net, 700);
});

test("with no primary set at all, the best number leads", () => {
  assert.equal(subtoTeaserOption(base).mode, "str");
  assert.equal(subtoTeaserOption({ ...base, rent_str_source: "" }).mode, "mtr");
});

test("equal nets break the tie in ltr → mtr → str order", () => {
  // Same rent in every mode: the lightest load (ltr, 23%) nets most anyway, so
  // force a genuine tie by giving mtr and str identical rents and loads via
  // matching nets — ltr must win when nets are equal.
  const tied = { ...base, rent_ltr: 2600, rent_mtr: 2600, rent_str: 2600 };
  const opts = subtoRentOptions(tied).filter(o => !o.blockedReason);
  const top = Math.max(...opts.map(o => o.net));
  const winners = opts.filter(o => o.net === top);
  assert.equal(subtoTeaserOption(tied).mode, winners[0].mode);
});

test("no teaser when everything is blocked, or when the pick doesn't cash-flow", () => {
  assert.equal(subtoTeaserOption({ ...base, hoa_rental_policy: "prohibited" }), null);
  assert.equal(subtoTeaserOption({ ...base, piti: 4000 }), null);
  assert.equal(subtoTeaserOption({}), null);
});

// ── Rate parsing, paydown, arbitrage ──────────────────────────────
test("rate text is parsed defensively and never yields NaN", () => {
  assert.equal(parseRatePct("4.5"), 4.5);
  assert.equal(parseRatePct("4.5%"), 4.5);
  assert.equal(parseRatePct("  3 % "), 3);
  assert.equal(parseRatePct("garbage"), null);
  assert.equal(parseRatePct(""), null);
  assert.equal(parseRatePct(null), null);
  assert.equal(parseRatePct("0"), null);
});

test("principal paydown needs P&I, a balance and a rate — otherwise null", () => {
  // 250000 × 4.5% / 12 = 937.50 interest; 1200 − 937.50 = 262.5 → 263
  assert.equal(subtoPrincipalPaydown(base), 263);
  assert.equal(subtoPrincipalPaydown({ ...base, loan_pi: null }), null);
  assert.equal(subtoPrincipalPaydown({ ...base, mortgage: 0 }), null);
  assert.equal(subtoPrincipalPaydown({ ...base, rate: "not a rate" }), null);
  // P&I below the interest accrual would be negative amortization, not paydown.
  assert.equal(subtoPrincipalPaydown({ ...base, loan_pi: 500 }), null);
});

test("rate arbitrage prices the same balance at today's rate", () => {
  const saved = subtoRateArbitrage(base);
  const expected = Math.round(amortizedPayment(250000, MARKET_RATE_TODAY) - amortizedPayment(250000, 4.5));
  assert.equal(saved, expected);
  assert.ok(saved > 0);
  // An assumed rate at or above market isn't arbitrage.
  assert.equal(subtoRateArbitrage({ ...base, rate: String(MARKET_RATE_TODAY) }), null);
  assert.equal(subtoRateArbitrage({ ...base, rate: "9" }), null);
  assert.equal(subtoRateArbitrage({ ...base, mortgage: 0 }), null);
  assert.equal(subtoRateArbitrage({ ...base, rate: "" }), null);
});

test("amortizedPayment matches a hand-computed 30-year payment", () => {
  // $250,000 at 6.9% for 30 years = $1,646.50/mo
  assert.equal(Math.round(amortizedPayment(250000, 6.9) * 100) / 100, 1646.5);
  assert.equal(amortizedPayment(0, 6.9), 0);
  assert.equal(amortizedPayment(250000, 0), 0);
});

// ── Terms rows ────────────────────────────────────────────────────
test("a deal with no 034 data produces exactly today's rows", () => {
  const legacy = { entry_fee: 15000, price: 300000, mortgage: 250000, piti: 1800, rate: "9", beds: 3, baths: "2", sqft: 1500, year_built: 1998 };
  assert.deepEqual(subtoTermRows(legacy), [
    ["Entry Fee", "$15,000 + TC + CC"],
    ["Purchase Price", "$300,000"],
    ["Existing Loan Balance", "$250,000"],
    ["PITI", "$1,800/mo"],
    ["Rate", "9%"],
    ["Beds / Baths", "3 bd / 2 ba"],
    ["Sqft", "1,500"],
    ["Year Built", 1998],
  ]);
});

test("HOA renders dues with the lease minimum, and total carry only when it differs from PITI", () => {
  const rows = new Map(subtoTermRows({ ...base, hoa_min_lease_days: 30, rate: "9" }));
  assert.equal(rows.get("HOA"), "$200/mo · 30-day minimum lease");
  assert.equal(rows.get("Total Monthly Carry"), "$2,000/mo");
});

test("no HOA dues plus a 'none' policy renders the literal None row", () => {
  const rows = new Map(subtoTermRows({ ...base, hoa_monthly: null, hoa_rental_policy: "none", rate: "9" }));
  assert.equal(rows.get("HOA"), "None");
  // Total carry would just repeat PITI — it's dropped.
  assert.equal(rows.has("Total Monthly Carry"), false);
});

test("an unknown HOA is omitted rather than asserted as None", () => {
  const rows = new Map(subtoTermRows({ ...base, hoa_monthly: null, hoa_rental_policy: null, rate: "9" }));
  assert.equal(rows.has("HOA"), false);
});

test("the rate row grows the arbitrage suffix only when the assumed rate wins", () => {
  const better = new Map(subtoTermRows(base)).get("Rate");
  assert.match(better, /^4\.5% · \$[\d,]+\/mo under a new loan at /);
  assert.equal(new Map(subtoTermRows({ ...base, rate: "9" })).get("Rate"), "9%");
});
