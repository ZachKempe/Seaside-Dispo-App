// AirDNA Rentalizer — the short-term-rental (STR) estimate for a single-family
// deal. Eligibility, the address, the rent-box write and the sweep spacing are
// shared with RentCast's long-term estimate in lib/rent-estimate.js.
//
// Env: AIRDNA_API_KEY (Bearer token from AirDNA sales). Optional overrides
// AIRDNA_API_BASE / AIRDNA_RENTALIZER_PATH exist because the token AirDNA
// issues may be for their Enterprise v2 API or the older v1 client API — if
// the account manager's docs name a different path, that's an env edit, not a
// deploy.
"use strict";

const { rentEligibility, estimateAddress, loadStructRow, fillRentBox, fetchJson } = require("./rent-estimate");

const DEFAULT_BASE = "https://api.airdna.co/api/enterprise/v2";
const DEFAULT_PATH = "/rentalizer/estimate";

function buildRequest(prop, structRow) {
  const s = structRow || {};
  const body = { address: estimateAddress(prop, s), currency: "usd" };
  const beds = parseInt(s.beds, 10);
  const baths = parseFloat(s.baths);
  // Only Sub-To captures beds/baths today. Omitted fields let AirDNA use its
  // own property record for the address instead of our guess.
  if (beds > 0) body.bedrooms = beds;
  if (baths > 0) body.bathrooms = baths;
  if (beds > 0) body.accommodates = beds * 2;
  return body;
}

// ── Response parsing ──
// AirDNA wraps everything as { payload, status }. The payload's field names
// aren't in any public schema, so rather than hard-code one guess we look for
// the metric by name anywhere in the payload, preferring a trailing-12-month
// ("ltm") value when the metric is an object of periods. The raw payload is
// stored beside the parsed numbers so a misread is fixable after the fact.
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metricValue(v) {
  if (typeof v !== "object" || v === null) return num(v);
  for (const k of ["ltm", "value", "annual", "avg", "mean", "estimate"]) {
    if (k in v) { const n = metricValue(v[k]); if (n !== null) return n; }
  }
  return null;
}

// Breadth-first so a top-level summary wins over a comp's own numbers; comps
// arrays are skipped entirely for the same reason.
function findMetric(root, keyRe) {
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    for (const [k, v] of Object.entries(node)) {
      if (keyRe.test(k)) { const n = metricValue(v); if (n !== null) return n; }
    }
    for (const [k, v] of Object.entries(node)) {
      if (/comp/i.test(k)) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v);
    }
  }
  return null;
}

function findComps(root) {
  if (root && Number.isFinite(Number((root.property_stats || {}).total_comps))) return Number(root.property_stats.total_comps);
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node)) {
      if (/comp/i.test(k) && Array.isArray(v)) return v.length;
      if (v && typeof v === "object" && !Array.isArray(v)) queue.push(v);
    }
  }
  return null;
}

function parseRentalizer(json) {
  const payload = (json && (json.payload || json.data)) || json || {};
  let annual = findMetric(payload, /^(annual_)?revenue(_ltm)?$|^projected_revenue$/i);
  let adr = findMetric(payload, /^(adr|average_daily_rate|daily_rate)(_ltm)?$/i);
  let occ = findMetric(payload, /^(occupancy|occupancy_rate)(_ltm)?$/i);
  // Occupancy arrives either as a fraction (0.62) or a percent (62).
  if (occ !== null && occ > 1) occ = occ / 100;
  if (occ !== null && (occ < 0 || occ > 1)) occ = null;
  // Derive revenue when only ADR × occupancy was given.
  if (annual === null && adr !== null && occ !== null) annual = Math.round(adr * occ * 365);
  if (annual !== null && annual <= 0) annual = null;
  const details = payload.details || payload.property_details || payload.property || {};
  return {
    annual_revenue: annual,
    adr,
    occupancy: occ,
    comps_count: findComps(payload),
    bedrooms: num(details.bedrooms),
    bathrooms: num(details.bathrooms),
    accommodates: num(details.accommodates),
  };
}

function monthlyFromAnnual(annual) {
  return annual > 0 ? Math.round(annual / 12) : null;
}

// ── I/O ──
async function callRentalizer(body, env = process.env) {
  const key = env.AIRDNA_API_KEY;
  if (!key) throw new Error("AIRDNA_API_KEY is not configured");
  const url = (env.AIRDNA_API_BASE || DEFAULT_BASE).replace(/\/$/, "") + (env.AIRDNA_RENTALIZER_PATH || DEFAULT_PATH);
  const r = await fetchJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  }, { label: "AirDNA" });
  if (!r.ok) {
    const msg = (r.json && r.json.status && r.json.status.message) || r.text.slice(0, 300);
    const hint = r.status === 401 || r.status === 403 ? " (check AIRDNA_API_KEY and that Rentalizer is on the plan)" : "";
    throw new Error(`AirDNA ${r.status}: ${msg}${hint}`);
  }
  const json = r.json;
  if (!json) throw new Error("AirDNA returned a non-JSON response");
  if (json.status && String(json.status.type || "").toLowerCase() === "error") {
    throw new Error(`AirDNA: ${json.status.message || "error"}`);
  }
  return json;
}

// Pull one deal. Always records an attempt (ok or error) so the sweep's
// retry spacing works and the dashboard can say why there's no number.
// Returns { skipped } for ineligible deals without writing anything.
async function pullStrEstimate(sb, prop, { overwrite = false, env = process.env } = {}) {
  if (!env.AIRDNA_API_KEY) return { skipped: "AIRDNA_API_KEY not set" };
  const structRow = await loadStructRow(sb, prop);
  const elig = rentEligibility(prop, structRow);
  if (!elig.ok) return { skipped: elig.reason };

  const req = buildRequest(prop, structRow);
  const row = { card_id: prop.card_id, provider: "airdna", address: req.address,
    bedrooms: req.bedrooms || null, bathrooms: req.bathrooms || null, accommodates: req.accommodates || null };
  let filled = null;
  try {
    const json = await callRentalizer(req, env);
    const parsed = parseRentalizer(json);
    Object.assign(row, {
      status: parsed.annual_revenue ? "ok" : "error",
      error: parsed.annual_revenue ? "" : "AirDNA responded but no revenue figure was found (raw payload saved)",
      annual_revenue: parsed.annual_revenue, adr: parsed.adr, occupancy: parsed.occupancy,
      comps_count: parsed.comps_count, raw: json,
      bedrooms: row.bedrooms || parsed.bedrooms, bathrooms: row.bathrooms || parsed.bathrooms,
      accommodates: row.accommodates || parsed.accommodates,
    });
  } catch (e) {
    Object.assign(row, { status: "error", error: String(e.message || e).slice(0, 500) });
  }

  const saved = await sb(`/str_estimates`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (row.status === "ok") {
    // Sub-To's STR column still stays hidden until str_permitted is confirmed,
    // which AirDNA can't know.
    try {
      filled = await fillRentBox(sb, prop, structRow, { mode: "str", monthly: monthlyFromAnnual(row.annual_revenue),
        overwrite, source: "AirDNA Rentalizer (12-mo projection)" });
    }
    catch (e) { console.error("airdna fill rent:", e.message); }
  }
  return { estimate: (saved && saved[0]) || row, filled };
}

module.exports = { buildRequest, parseRentalizer, monthlyFromAnnual, callRentalizer, pullStrEstimate };
