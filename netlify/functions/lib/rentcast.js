// RentCast rent AVM — the long-term-rental (LTR) estimate for a single-family
// deal. Eligibility, the address, the rent-box write and the sweep spacing are
// shared with AirDNA's short-term estimate in lib/rent-estimate.js.
//
//   GET https://api.rentcast.io/v1/avm/rent/long-term   (X-Api-Key header)
//   → { rent, rentRangeLow, rentRangeHigh, subjectProperty, comparables: [...] }
//
// Every call is billed against the plan (free Developer tier: 50/month), which
// is why the sweep re-pulls a deal only every 30 days.
//
// Env: RENTCAST_API_KEY (self-serve at app.rentcast.io → API).
"use strict";

const { rentEligibility, estimateAddress, loadStructRow, fillRentBox, fetchJson } = require("./rent-estimate");

const RENTCAST_URL = "https://api.rentcast.io/v1/avm/rent/long-term";

// Only Sub-To captures beds/baths/sqft today. Anything omitted, RentCast looks
// up from its own property record for the address (lookupSubjectAttributes
// defaults to true), which beats sending a guess.
function buildQuery(prop, structRow) {
  const s = structRow || {};
  const q = { address: estimateAddress(prop, s), propertyType: "Single Family" };
  const beds = parseInt(s.beds, 10);
  const baths = parseFloat(s.baths);
  const sqft = parseInt(s.sqft, 10);
  if (beds > 0) q.bedrooms = beds;
  if (baths > 0) q.bathrooms = baths;
  if (sqft > 0) q.squareFootage = sqft;
  return q;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRentcast(json) {
  const j = json || {};
  const rent = num(j.rent);
  const subject = j.subjectProperty || {};
  return {
    rent: rent && rent > 0 ? Math.round(rent) : null,
    rent_low: num(j.rentRangeLow),
    rent_high: num(j.rentRangeHigh),
    comps_count: Array.isArray(j.comparables) ? j.comparables.length : null,
    bedrooms: num(subject.bedrooms),
    bathrooms: num(subject.bathrooms),
    square_feet: num(subject.squareFootage),
  };
}

async function callRentcast(query, env = process.env) {
  const key = env.RENTCAST_API_KEY;
  if (!key) throw new Error("RENTCAST_API_KEY is not configured");
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const r = await fetchJson(`${RENTCAST_URL}?${qs}`, {
    method: "GET",
    headers: { "X-Api-Key": key, Accept: "application/json" },
  }, { label: "RentCast" });
  if (!r.ok) {
    const msg = (r.json && (r.json.message || r.json.error)) || r.text.slice(0, 300);
    const hint = r.status === 401 ? " (check RENTCAST_API_KEY)"
      : r.status === 429 ? " (rate/plan limit — the free tier is 50 calls/month)" : "";
    throw new Error(`RentCast ${r.status}: ${msg}${hint}`);
  }
  if (!r.json) throw new Error("RentCast returned a non-JSON response");
  return r.json;
}

// Pull one deal. Always records an attempt (ok or error) so the sweep's retry
// spacing works and the dashboard can say why there's no number. Returns
// { skipped } without writing anything for ineligible deals or no key.
async function pullLtrEstimate(sb, prop, { overwrite = false, env = process.env } = {}) {
  if (!env.RENTCAST_API_KEY) return { skipped: "RENTCAST_API_KEY not set" };
  const structRow = await loadStructRow(sb, prop);
  const elig = rentEligibility(prop, structRow);
  if (!elig.ok) return { skipped: elig.reason };

  const query = buildQuery(prop, structRow);
  const row = { card_id: prop.card_id, provider: "rentcast", address: query.address,
    bedrooms: query.bedrooms || null, bathrooms: query.bathrooms || null, square_feet: query.squareFootage || null };
  try {
    const json = await callRentcast(query, env);
    const parsed = parseRentcast(json);
    Object.assign(row, {
      status: parsed.rent ? "ok" : "error",
      error: parsed.rent ? "" : "RentCast responded but returned no rent estimate (raw payload saved)",
      rent: parsed.rent, rent_low: parsed.rent_low, rent_high: parsed.rent_high,
      comps_count: parsed.comps_count, raw: json,
      bedrooms: row.bedrooms || parsed.bedrooms, bathrooms: row.bathrooms || parsed.bathrooms,
      square_feet: row.square_feet || parsed.square_feet,
    });
  } catch (e) {
    Object.assign(row, { status: "error", error: String(e.message || e).slice(0, 500) });
  }

  const saved = await sb(`/ltr_estimates`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  let filled = null;
  if (row.status === "ok") {
    try {
      filled = await fillRentBox(sb, prop, structRow, { mode: "ltr", monthly: row.rent, overwrite,
        source: `RentCast AVM${row.comps_count ? `, ${row.comps_count} comps` : ""}` });
    } catch (e) { console.error("rentcast fill rent:", e.message); }
  }
  return { estimate: (saved && saved[0]) || row, filled };
}

module.exports = { buildQuery, parseRentcast, callRentcast, pullLtrEstimate };
