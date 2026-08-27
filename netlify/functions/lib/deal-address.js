// The ONE answer to "what address does this deal show a buyer?".
//
// `address_override` lives on the STRUCTURE table — morby_deals (migration 012)
// and cash_deals (035) — and has never existed on `properties`. Four separate
// callers read it off the properties row anyway, where it is permanently
// `undefined`, so the Deal Deck Address the dashboard invites you to correct
// applied to the generated PDF and to nothing else: the deck page, the blast
// email, the blast SMS and the emailed PDF's filename all kept showing the raw
// card name. Nothing errored — `undefined || prop.name` is a perfectly good
// fallback — which is why it survived since migration 012.
//
// Keep this file free of I/O (except the explicit fetch helper), DOM and env,
// like deal-shared.js and subjects.js.
"use strict";

// Which table holds the override, by properties.deal_type. Sub-To has none —
// its deck reads deal_terms, which has no address column.
const OVERRIDE_TABLE = { morby: "morby_deals", cash: "cash_deals" };

// prop: a `properties` row. structRow: the matching morby_deals / cash_deals
// row, or null/undefined when the deal has no structure table (Sub-To).
function dealAddress(prop, structRow) {
  const p = prop || {};
  const override = String((structRow || {}).address_override || "").trim();
  return override || p.name || p.card_id || "";
}

// For the callers that don't already hold the structure row (deck-interest).
// Best-effort by design: any failure — including the table not existing before
// its migration runs — degrades to the card name rather than taking down a
// lead capture. `prop` must carry `deal_type` and `card_id`.
async function fetchDealAddress(sb, prop) {
  const table = OVERRIDE_TABLE[(prop || {}).deal_type];
  if (!table || !prop.card_id) return dealAddress(prop, null);
  try {
    const rows = await sb(`/${table}?card_id=eq.${encodeURIComponent(prop.card_id)}&select=address_override&limit=1`);
    return dealAddress(prop, (rows || [])[0]);
  } catch (e) {
    return dealAddress(prop, null);
  }
}

module.exports = { dealAddress, fetchDealAddress, OVERRIDE_TABLE };
