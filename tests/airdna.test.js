// lib/airdna.js — which deals get an AirDNA estimate, what we send, how we
// read the answer, and the sweep's retry spacing. AirDNA's response schema
// isn't public, so the parser is tested against the shapes it must tolerate.
const test = require("node:test");
const assert = require("node:assert/strict");
const { strEligibility, buildRequest, parseRentalizer, monthlyFromAnnual } = require("../netlify/functions/lib/airdna");
const { isDue } = require("../netlify/functions/str-estimates-sync");

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
async function runPull(structRow, overwrite) {
  const { pullStrEstimate } = require("../netlify/functions/lib/airdna");
  const writes = [];
  const sb = async (path, opts = {}) => {
    if (!opts.method) return [structRow];
    writes.push({ path, method: opts.method, body: JSON.parse(opts.body) });
    return [JSON.parse(opts.body)];
  };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ payload: { revenue: { ltm: 51000 } }, status: { type: "success" } }) });
  try {
    await pullStrEstimate(sb, { card_id: "morby-x", deal_type: "morby", name: "1 A St, Ocala, FL" }, { overwrite, env: { AIRDNA_API_KEY: "k" } });
  } finally { global.fetch = realFetch; }
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
