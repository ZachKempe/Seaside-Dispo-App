// C2 — the tokenized buy-box form linked from the interest receipt.
//
// Why here and not on the deck page: the one-tap hand-raise is the best
// converting thing on that page, and a form between the tap and the submit
// risks the conversion we already have. The receipt goes out within seconds of
// the tap, the investor has already converted, and the ask costs nothing at
// that point — so we bank the conversion first and ask second.
//
// Why it matters at all: matchesDeal treats every blank buyer field as a
// wildcard, so a buyer we know nothing about receives every deal we ever send
// — which is what trains people to ignore us. C1 made the deck page create
// buyers from forwarded links, and every one of those lands blank. This is the
// path that fills them in, at the one moment the investor is actually paying
// attention.
//
// Nothing here needs wiring into onboard-buyers.js: dueTouch() already stops
// asking anyone whose buyBoxCompleteness is "full", so an answered form ends
// the email sequence by itself.
//
// This file owns BOTH the parsing and the link the email carries, the same way
// lib/unsub.js owns minting and verifying its token — the two must agree or a
// live link in a sent email breaks.
"use strict";

const { parseStates, parseStrategy, parseInt0 } = require("./buyer-intake");
const { deckToken } = require("./deck-token");
const { buyBoxCompleteness } = require("../../../public/js/deal-shared");

// The form's strategy pills. Values are the literal text parseStrategy reads,
// NOT the canonical keys — going through the same parser as the public
// questionnaire is what keeps one buyer's answer meaning the same thing
// wherever they gave it. tests/buy-box-form.test.js pins each value to the key
// it must produce, so relabeling a pill can't silently change who matches.
const STRATEGY_PILLS = [
  { value: "Subject-To", label: "Subject-To", hint: "take over the existing loan" },
  { value: "Seller Finance", label: "Seller finance", hint: "owner carries the paper" },
  { value: "Stack Method", label: "Stack Method", hint: "Morby-style seller finance + DSCR" },
  { value: "Cash", label: "Cash", hint: "straight discounted purchase" },
];

// The three things buyBoxCompleteness needs to call a box "full", in the words
// we say them to an investor. Kept as predicates that MIRROR that classifier
// exactly — a test asserts missingParts() is empty for precisely the buyers it
// calls "full", so this can never tell someone they're done when the matcher
// still treats them as a wildcard.
const BUY_BOX_PARTS = [
  {
    key: "states",
    label: "which states you buy in",
    has: (b) => !!String(b.states || "").trim(),
  },
  {
    key: "strategy",
    label: "which deal structures you take",
    // "all" is an answer, but it is not a buy box — it is the wildcard by
    // another name, and buyBoxCompleteness counts it as unanswered.
    has: (b) => {
      const s = String(b.strategy || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
      return s.length > 0 && !s.includes("all");
    },
  },
  {
    key: "money",
    label: "your budget",
    has: (b) => Number(b.max_price) > 0 || Number(b.max_piti) > 0,
  },
];

function missingParts(buyer) {
  const b = buyer || {};
  return BUY_BOX_PARTS.filter((p) => !p.has(b)).map((p) => p.label);
}

// Which columns a submission should actually write.
//
// A blank answer NEVER overwrites something we already know. Someone who fills
// in states today and comes back for the price next week must not have the
// states wiped on the second pass — and an unparseable entry ("Flarida")
// yields "" from parseStates, which under any other rule would blank a real
// answer. The confirmation screen tells them what is still missing, so a value
// that didn't take is visible rather than silent.
//
// Returns {} when nothing usable was submitted; the caller re-renders the form
// rather than issuing an empty PATCH.
//
// Every number is sanity-banded before it is written, the same way
// deck-interest.js bands a soft offer. This is not defensive noise: a cap is a
// filter, so a junk-but-positive value like max_piti = 5 doesn't degrade to
// "no answer" — it silently excludes that buyer from every deal we will ever
// send, which is the exact opposite of what they opened the form to do. (It is
// also reachable by accident: the shared parseInt0 strips a minus sign, so
// "-5" arrives as 5.) Out-of-band values are dropped and reported back as
// still-missing rather than saved.
const MONEY_BANDS = {
  max_price: [1000, 100000000],  // a purchase cap under $1k is a typo, not a box
  max_piti: [100, 1000000],      // ditto a monthly payment cap
  min_beds: [1, 20],
};

function bandedInt(raw, band) {
  const n = parseInt0(raw);
  return n >= band[0] && n <= band[1] ? n : 0;
}

function buyBoxPatch(form) {
  const f = form || {};
  const out = {};

  const states = parseStates(f.states);
  if (states) out.states = states;

  // Guarded on the raw value: parseStrategy falls back to "all" for anything
  // it doesn't recognize, and writing "all" for someone who simply ticked no
  // box would record a wildcard as though they had chosen one.
  const rawStrategy = String(f.strategy || "").trim();
  if (rawStrategy) out.strategy = parseStrategy(rawStrategy);

  // max_price is a PURCHASE price cap and max_piti a MONTHLY payment cap —
  // matchesDeal compares them against different figures, so they are two
  // fields and never one. (The public questionnaire got this wrong once by
  // routing a down-payment cap into max_price.)
  const price = bandedInt(f.max_price, MONEY_BANDS.max_price);
  if (price > 0) out.max_price = price;

  const piti = bandedInt(f.max_piti, MONEY_BANDS.max_piti);
  if (piti > 0) out.max_piti = piti;

  const beds = bandedInt(f.min_beds, MONEY_BANDS.min_beds);
  if (beds > 0) out.min_beds = beds;

  return out;
}

// The buyer as they'll be once the patch lands — what the confirmation screen
// reports on, so it describes the saved state and not the submitted form.
function applyPatch(buyer, patch) {
  return { ...(buyer || {}), ...(patch || {}) };
}

// Which pills to pre-tick for someone who has answered before. Each pill value
// goes through the same parser the submit uses, so a stored "subto,cash"
// re-ticks exactly the boxes that produced it — and a buyer who returns to add
// their price can't lose their structures to an unticked form.
function checkedPillValues(storedStrategy) {
  const stored = String(storedStrategy || "").toLowerCase()
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!stored.length || stored.includes("all")) return new Set();
  const out = new Set();
  for (const p of STRATEGY_PILLS) {
    if (stored.includes(parseStrategy(p.value))) out.add(p.value);
  }
  return out;
}

// The link the receipt carries. Tokenized with the SAME HMAC as a per-buyer
// deck link (lib/deck-token.js): not a secret, just unforgeable, and it means
// the investor never has to identify themselves again.
function buyBoxUrlFor(siteUrl, buyerId) {
  if (!buyerId) return "";
  return `${String(siteUrl || "").replace(/\/+$/, "")}/buy-box?t=${deckToken(buyerId)}`;
}

// Ask only people who haven't answered. A buyer whose box is already full has
// told us; putting the button in their receipt anyway reads as not listening.
function shouldAskBuyBox(buyer) {
  return buyBoxCompleteness(buyer || {}) !== "full";
}

module.exports = {
  STRATEGY_PILLS, BUY_BOX_PARTS, MONEY_BANDS, missingParts, buyBoxPatch,
  applyPatch, checkedPillValues, buyBoxUrlFor, shouldAskBuyBox,
};
