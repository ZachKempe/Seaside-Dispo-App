// What the two rent-estimate providers share: which deals get priced, what
// address is sent, which box on the deal an estimate lands in, and when the
// scheduled sweep pulls again.
//
//   lib/airdna.js   — short-term (STR) revenue → str_estimates  (039)
//   lib/rentcast.js — long-term (LTR) rent     → ltr_estimates  (040)
//
// Both are driven by rent-estimate.js (dashboard: after a contract/LOI upload
// and the card's ↻ buttons) and rent-estimates-sync.js (the 15-min sweep).
// Deliberately never called from the parse-* intake functions: those already
// spend most of a synchronous function's budget on Claude, and a provider
// stall must never cost us a deal intake.
"use strict";

const { dealAddress } = require("./deal-address");

// Structure tables keyed by properties.deal_type. Sub-To is the fallback
// structure (see CLAUDE.md) and keeps its rent columns on deal_terms.
const STRUCT_TABLE = { morby: "morby_deals", cash: "cash_deals" };

function structTableFor(prop) {
  return STRUCT_TABLE[(prop || {}).deal_type] || "deal_terms";
}

// The corrected Deal Deck Address when there is one — the providers should
// price the house we're actually selling. deal_terms has no override column,
// so Sub-To falls through to the card name, exactly as dealAddress intends.
function estimateAddress(prop, structRow) {
  const table = structTableFor(prop);
  return String(dealAddress(prop, table === "deal_terms" ? null : structRow) || "").trim();
}

// Is this a single-family deal we should price as a rental?
// Morby / cash carry an explicit property_type; commercial is out (it's
// underwritten on NOI, not rent). Sub-To deals are assumed-mortgage houses and
// have no commercial variant. An address with no street number (the
// "New Cash Deal" placeholder when extraction found none) can't be priced.
function rentEligibility(prop, structRow) {
  const p = prop || {};
  if (p.archived) return { ok: false, reason: "archived" };
  const table = structTableFor(p);
  if (table !== "deal_terms" && (structRow || {}).property_type === "commercial") {
    return { ok: false, reason: "commercial" };
  }
  const address = estimateAddress(p, structRow);
  if (!/\d/.test(address)) return { ok: false, reason: "no street address" };
  return { ok: true, address };
}

async function loadStructRow(sb, prop) {
  const table = structTableFor(prop);
  const rows = await sb(`/${table}?card_id=eq.${encodeURIComponent(prop.card_id)}&select=*&limit=1`);
  return (rows || [])[0] || null;
}

// The box each mode fills. Structure panels have one monthly column per mode;
// Sub-To has the rent plus a source, because deal-shared hides any Sub-To rent
// that has no source.
const RENT_BOX = {
  str: { struct: "str_monthly_rent", subto: "rent_str", source: "rent_str_source" },
  ltr: { struct: "ltr_monthly_rent", subto: "rent_ltr", source: "rent_ltr_source" },
};

// Write an estimate into the deal's rent box.
//   overwrite:true  — a contract/LOI was just uploaded, or ↻ was clicked. Zach's
//                     rule (Sept 23 2026): after a PSA upload the boxes ARE the
//                     provider numbers, replacing whatever the LOI extraction
//                     guessed. Both are deliberate, one-deal actions.
//   overwrite:false — the scheduled sweep (first pull + 30-day refresh). Only
//                     fills a blank, so a number typed by hand after the upload
//                     is never silently replaced by a background job.
async function fillRentBox(sb, prop, structRow, { mode, monthly, overwrite, source }) {
  if (!monthly || !structRow) return null;
  const box = RENT_BOX[mode];
  const table = structTableFor(prop);
  const col = table === "deal_terms" ? box.subto : box.struct;
  const current = structRow[col];
  if (current && (!overwrite || Number(current) === monthly)) return null;
  const patch = { [col]: monthly };
  if (table === "deal_terms" && (overwrite || !String(structRow[box.source] || "").trim())) patch[box.source] = source;
  await sb(`/${table}?card_id=eq.${encodeURIComponent(prop.card_id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  return patch;
}

// Sweep spacing, shared by both providers:
//   no estimate yet            → pull now
//   last pull errored          → retry after 24h (a bad key or an address the
//                                provider can't match shouldn't re-bill hourly)
//   last good pull > 30 days   → pull again, as a new row (history = tracking)
const RETRY_ERROR_MS = 24 * 3600 * 1000;
const REFRESH_OK_MS = 30 * 24 * 3600 * 1000;

function isDue(latest, now = Date.now()) {
  if (!latest) return true;
  const age = now - new Date(latest.fetched_at).getTime();
  return latest.status === "ok" ? age > REFRESH_OK_MS : age > RETRY_ERROR_MS;
}

// fetch with a hard timeout — under the scheduled-function 30s cap, with room
// to write the result. Returns { status, json, text }.
async function fetchJson(url, opts, { timeoutMs = 15000, label = "provider" } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* caller reports */ }
    return { status: r.status, ok: r.ok, json, text };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  structTableFor, estimateAddress, rentEligibility, loadStructRow,
  fillRentBox, isDue, fetchJson,
};
