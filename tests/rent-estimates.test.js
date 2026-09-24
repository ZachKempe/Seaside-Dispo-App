// Rent estimates — lib/rent-estimate.js (which deals, which box, sweep
// spacing), lib/airdna.js (short-term) and lib/rentcast.js (long-term).
const test = require("node:test");
const assert = require("node:assert/strict");
const { rentEligibility: strEligibility, isDue } = require("../netlify/functions/lib/rent-estimate");
const { buildRequest, parseRentalizer, monthlyFromAnnual } = require("../netlify/functions/lib/airdna");
const { buildQuery, parseRentcast, pullLtrEstimate } = require("../netlify/functions/lib/rentcast");

test("single-family Morby / cash and every Sub-To are eligible; commercial is not", () => {
  const addr = "123 Main St, Ocala, FL 34479";
  assert.equal(strEligibility({ deal_type: "morby", name: addr }, { property_type: "single_family" }).ok, true);
  assert.equal(strEligibility({ deal_type: "cash", name: addr }, {}).ok, true); // column default is single_family
  assert.equal(strEligibility({ deal_type: "subto", name: addr }, { beds: 3 }).ok, true);
  assert.equal(strEligibility({ deal_type: "", name: addr }, null).ok, true); // Sub-To is the fallback
  assert.deepEqual(strEligibility({ deal_type: "cash", name: addr }, { property_type: "commercial" }), { ok: false, reason: "commercial" });
  assert.equal(strEligibility({ deal_type: "morby", name: addr, archived: true }, {}).ok, false);
});

test("a placeholder card name with no street number is never sent to AirDNA", () => {
  assert.equal(strEligibility({ deal_type: "cash", name: "New Cash Deal" }, {}).ok, false);
});

test("the Deal Deck Address override on the structure table is what gets priced", () => {
  const req = buildRequest({ deal_type: "morby", name: "New Morby Deal" }, { address_override: "3014 N Tampa St, Tampa, FL" });
  assert.equal(req.address, "3014 N Tampa St, Tampa, FL");
});

test("beds/baths are sent only when known", () => {
  const sub = buildRequest({ deal_type: "subto", name: "1 A St" }, { beds: 3, baths: "2.5" });
  assert.equal(sub.bedrooms, 3);
  assert.equal(sub.bathrooms, 2.5);
  assert.equal(sub.accommodates, 6);
  const morby = buildRequest({ deal_type: "morby", name: "1 A St" }, {});
  assert.equal("bedrooms" in morby, false);
  assert.equal("bathrooms" in morby, false);
});

test("parses nested ltm metrics and ignores comps' own numbers", () => {
  const out = parseRentalizer({
    payload: {
      details: { bedrooms: 3, bathrooms: 2, accommodates: 8 },
      property_statistics: { revenue: { ltm: 51000 }, adr: { ltm: 212.5 }, occupancy: { ltm: 0.66 } },
      comps: [{ revenue: { ltm: 999999 } }, { revenue: { ltm: 1 } }],
    },
    status: { type: "success" },
  });
  assert.equal(out.annual_revenue, 51000);
  assert.equal(out.adr, 212.5);
  assert.equal(out.occupancy, 0.66);
  assert.equal(out.comps_count, 2);
  assert.equal(out.bedrooms, 3);
});

test("percent occupancy is normalized, and revenue is derived from ADR × occupancy when absent", () => {
  const out = parseRentalizer({ payload: { adr: 200, occupancy: 50 } });
  assert.equal(out.occupancy, 0.5);
  assert.equal(out.annual_revenue, 36500);
});

test("no revenue figure → null, never 0 (a 0 would fill a rent field with nothing)", () => {
  assert.equal(parseRentalizer({ payload: { details: {} } }).annual_revenue, null);
  assert.equal(parseRentalizer({ payload: { revenue: 0 } }).annual_revenue, null);
  assert.equal(monthlyFromAnnual(null), null);
  assert.equal(monthlyFromAnnual(51000), 4250);
});

test("sweep: new deals now, errors after 24h, good estimates re-pulled after 30 days", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const ago = (h) => new Date(now - h * 3600 * 1000).toISOString();
  assert.equal(isDue(undefined, now), true);
  assert.equal(isDue({ status: "error", fetched_at: ago(2) }, now), false);
  assert.equal(isDue({ status: "error", fetched_at: ago(25) }, now), true);
  assert.equal(isDue({ status: "ok", fetched_at: ago(24 * 29) }, now), false);
  assert.equal(isDue({ status: "ok", fetched_at: ago(24 * 31) }, now), true);
});

// The STR rent box rule: a PSA/LOI upload (overwrite) replaces whatever the
// LOI extraction put there; the background sweep only ever fills a blank.
async function runPull(structRow, overwrite, { pull, payload, env, prop } = {}) {
  const { pullStrEstimate } = require("../netlify/functions/lib/airdna");
  pull = pull || pullStrEstimate;
  payload = payload || { payload: { revenue: { ltm: 51000 } }, status: { type: "success" } };
  const writes = [];
  const sb = async (path, opts = {}) => {
    if (!opts.method) return [structRow];
    writes.push({ path, method: opts.method, body: JSON.parse(opts.body) });
    return [JSON.parse(opts.body)];
  };
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => JSON.stringify(payload) }; };
  try {
    await pull(sb, prop || { card_id: "morby-x", deal_type: "morby", name: "1 A St, Ocala, FL" },
      { overwrite, env: env || { AIRDNA_API_KEY: "k", RENTCAST_API_KEY: "k" } });
  } finally { global.fetch = realFetch; }
  runPull.lastCalls = calls;
  return writes.filter(w => w.method === "PATCH");
}

test("after a PSA upload, AirDNA replaces the LOI's STR rent", async () => {
  const patches = await runPull({ property_type: "single_family", str_monthly_rent: 3000 }, true);
  assert.deepEqual(patches.map(p => p.body), [{ str_monthly_rent: 4250 }]);
  assert.match(patches[0].path, /^\/morby_deals\?card_id=eq\.morby-x$/);
});

test("the background sweep never replaces a number that's already in the box", async () => {
  assert.deepEqual(await runPull({ property_type: "single_family", str_monthly_rent: 3000 }, false), []);
  const blank = await runPull({ property_type: "single_family", str_monthly_rent: null }, false);
  assert.deepEqual(blank.map(p => p.body), [{ str_monthly_rent: 4250 }]);
});

test("the AirDNA v1 documented shape parses (property_stats.*.ltm, total_comps)", () => {
  const out = parseRentalizer({
    property_details: { bedrooms: 3, bathrooms: 2, accommodates: 6 },
    property_stats: { adr: { ltm: 283 }, occupancy: { ltm: 0.58 }, revenue: { ltm: 60153 }, total_comps: 9 },
    permission: "full",
  });
  assert.deepEqual([out.annual_revenue, out.adr, out.occupancy, out.comps_count, out.bedrooms], [60153, 283, 0.58, 9, 3]);
});

// ── RentCast (long-term) ──
test("RentCast query: override address, Single Family, Sub-To beds/baths/sqft only when known", () => {
  const q = buildQuery({ deal_type: "morby", name: "New Morby Deal" }, { address_override: "3014 N Tampa St, Tampa, FL" });
  assert.deepEqual(q, { address: "3014 N Tampa St, Tampa, FL", propertyType: "Single Family" });
  const sub = buildQuery({ deal_type: "subto", name: "1 A St, Ocala, FL" }, { beds: 3, baths: "2", sqft: 1450 });
  assert.equal(sub.bedrooms, 3);
  assert.equal(sub.bathrooms, 2);
  assert.equal(sub.squareFootage, 1450);
});

test("RentCast response parses; no rent → null", () => {
  const out = parseRentcast({ rent: 1620.4, rentRangeLow: 1550, rentRangeHigh: 1690,
    subjectProperty: { bedrooms: 3, bathrooms: 2, squareFootage: 1400 }, comparables: [{}, {}, {}] });
  assert.deepEqual([out.rent, out.rent_low, out.rent_high, out.comps_count, out.square_feet], [1620, 1550, 1690, 3, 1400]);
  assert.equal(parseRentcast({ rent: 0 }).rent, null);
  assert.equal(parseRentcast({}).rent, null);
});

test("RentCast is called by GET with the X-Api-Key header, never with the key in the URL", async () => {
  await runPull({ property_type: "single_family" }, true,
    { pull: pullLtrEstimate, payload: { rent: 2150, comparables: [] }, env: { RENTCAST_API_KEY: "secret" } });
  const [call] = runPull.lastCalls;
  assert.match(call.url, /^https:\/\/api\.rentcast\.io\/v1\/avm\/rent\/long-term\?/);
  assert.equal(call.opts.headers["X-Api-Key"], "secret");
  assert.equal(call.url.includes("secret"), false);
});

test("after a PSA upload, RentCast replaces the LOI's long-term rent; the sweep only fills a blank", async () => {
  const opts = { pull: pullLtrEstimate, payload: { rent: 2150, comparables: [{}, {}] } };
  assert.deepEqual((await runPull({ property_type: "single_family", ltr_monthly_rent: 4100 }, true, opts)).map(p => p.body),
    [{ ltr_monthly_rent: 2150 }]);
  assert.deepEqual(await runPull({ property_type: "single_family", ltr_monthly_rent: 4100 }, false, opts), []);
});

test("Sub-To long-term rent gets a source, or deal-shared would hide it", async () => {
  const patches = await runPull({ rent_ltr: null, rent_ltr_source: "" }, false, {
    pull: pullLtrEstimate, payload: { rent: 1800, comparables: [{}, {}, {}] },
    prop: { card_id: "subto-x", deal_type: "subto", name: "1 A St, Ocala, FL" },
  });
  assert.deepEqual(patches.map(p => p.body), [{ rent_ltr: 1800, rent_ltr_source: "RentCast AVM, 3 comps" }]);
  assert.match(patches[0].path, /^\/deal_terms\?/);
});

test("no key → skipped, no call, nothing written", async () => {
  const patches = await runPull({ property_type: "single_family" }, true, { pull: pullLtrEstimate, env: {} });
  assert.deepEqual(patches, []);
  assert.equal(runPull.lastCalls.length, 0);
});
