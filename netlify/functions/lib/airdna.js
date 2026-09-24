// AirDNA Rentalizer — the short-term-rental estimate for a single-family deal.
//
// The ONE place that decides which deals get an estimate, talks to AirDNA, and
// writes the result. Called by str-estimate.js (the dashboard's ↻ button and
// the fire-after-intake call) and str-estimates-sync.js (the scheduled sweep
// that guarantees every single-family deal gets one even if the browser call
// never happened, and re-pulls monthly so the number is tracked over time).
//
// Deliberately NOT called from parse-loi / parse-cash / parse-subto: those
// already spend most of a synchronous function's budget waiting on Claude,
// and an AirDNA stall must never cost us the deal intake.
//
// Env: AIRDNA_API_KEY (Bearer token from AirDNA sales). Optional overrides
// AIRDNA_API_BASE / AIRDNA_RENTALIZER_PATH exist because AirDNA's reference
// docs aren't public — if the account manager's docs name a different path,
// that's an env edit, not a deploy.
"use strict";

const { dealAddress } = require("./deal-address");

const DEFAULT_BASE = "https://api.airdna.co/api/enterprise/v2";
const DEFAULT_PATH = "/rentalizer/estimate";
const TIMEOUT_MS = 15000; // under the scheduled-function 30s cap, with room to write

// Structure tables keyed by properties.deal_type. Sub-To is the fallback
// structure (see CLAUDE.md) and keeps its rent columns on deal_terms.
const STRUCT_TABLE = { morby: "morby_deals", cash: "cash_deals" };

function structTableFor(prop) {
  return STRUCT_TABLE[(prop || {}).deal_type] || "deal_terms";
}

// Is this deal a single-family deal we should price as an STR?
// Morby / cash carry an explicit property_type; commercial is out (it's
// underwritten on NOI, not rent). Sub-To deals are assumed-mortgage houses and
// have no commercial variant. An address with no street number (the
// "New Cash Deal" placeholder when extraction found none) can't be priced.
function strEligibility(prop, structRow) {
  const p = prop || {};
  if (p.archived) return { ok: false, reason: "archived" };
  const table = structTableFor(p);
  if (table !== "deal_terms" && (structRow || {}).property_type === "commercial") {
    return { ok: false, reason: "commercial" };
  }
  const address = rentalizerAddress(p, structRow);
  if (!/\d/.test(address)) return { ok: false, reason: "no street address" };
  return { ok: true, address };
}

// The corrected Deal Deck Address when there is one — AirDNA should price the
// house we're actually selling. deal_terms has no override column, so Sub-To
// falls through to the card name, exactly as dealAddress intends.
function rentalizerAddress(prop, structRow) {
  const table = structTableFor(prop);
  return String(dealAddress(prop, table === "deal_terms" ? null : structRow) || "").trim();
}

function buildRequest(prop, structRow) {
  const s = structRow || {};
  const body = { address: rentalizerAddress(prop, s), currency: "usd" };
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
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* reported below */ }
    if (!r.ok) {
      const msg = (json && json.status && json.status.message) || text.slice(0, 300);
      const hint = r.status === 401 || r.status === 403 ? " (check AIRDNA_API_KEY and that Rentalizer is on the plan)" : "";
      throw new Error(`AirDNA ${r.status}: ${msg}${hint}`);
    }
    if (!json) throw new Error("AirDNA returned a non-JSON response");
    if (json.status && String(json.status.type || "").toLowerCase() === "error") {
      throw new Error(`AirDNA: ${json.status.message || "error"}`);
    }
    return json;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`AirDNA timed out after ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Write the estimate into the deal's STR rent box.
//   overwrite:true  — a contract/LOI was just uploaded, or ↻ was clicked. Zach's
//                     rule (Sept 23 2026): after a PSA upload the box IS the
//                     AirDNA number, replacing whatever the LOI extraction
//                     guessed. Both are deliberate, one-deal actions.
//   overwrite:false — the scheduled sweep (first pull + 30-day refresh). Only
//                     fills a blank, so a number typed by hand after the upload
//                     is never silently replaced by a background job.
// Sub-To also gets rent_str_source, because deal-shared hides any rent with no
// source; its STR column still stays hidden until str_permitted is confirmed,
// which AirDNA can't know.
async function fillStrRent(sb, prop, structRow, monthly, overwrite) {
  if (!monthly || !structRow) return null;
  const table = structTableFor(prop);
  const id = encodeURIComponent(prop.card_id);
  if (table === "deal_terms") {
    if (structRow.rent_str && (!overwrite || Number(structRow.rent_str) === monthly)) return null;
    const patch = { rent_str: monthly };
    if (overwrite || !String(structRow.rent_str_source || "").trim()) patch.rent_str_source = "AirDNA Rentalizer (12-mo projection)";
    await sb(`/deal_terms?card_id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    return patch;
  }
  if (structRow.str_monthly_rent && (!overwrite || Number(structRow.str_monthly_rent) === monthly)) return null;
  const patch = { str_monthly_rent: monthly };
  await sb(`/${table}?card_id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  return patch;
}

async function loadStructRow(sb, prop) {
  const table = structTableFor(prop);
  const rows = await sb(`/${table}?card_id=eq.${encodeURIComponent(prop.card_id)}&select=*&limit=1`);
  return (rows || [])[0] || null;
}

// Pull one deal. Always records an attempt (ok or error) so the sweep's
// retry spacing works and the dashboard can say why there's no number.
// Returns { skipped } for ineligible deals without writing anything.
async function pullStrEstimate(sb, prop, { overwrite = false, env = process.env } = {}) {
  const structRow = await loadStructRow(sb, prop);
  const elig = strEligibility(prop, structRow);
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
    try { filled = await fillStrRent(sb, prop, structRow, monthlyFromAnnual(row.annual_revenue), overwrite); }
    catch (e) { console.error("airdna fill rent:", e.message); }
  }
  return { estimate: (saved && saved[0]) || row, filled };
}

module.exports = {
  strEligibility, buildRequest, parseRentalizer, monthlyFromAnnual,
  callRentalizer, pullStrEstimate, structTableFor,
};
