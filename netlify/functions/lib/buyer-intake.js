// C2 — parsing for the public buy-box questionnaire, shared by sync-buyers.js.
// Pure (no I/O, no env) so tests/buyer-intake.test.js can import it, like
// num.js and deal-shared.js.
//
// ⚠ A near-identical copy lives in the buyer-form repo
// (~/seaside-buyer-form/netlify/functions/submit-buyer.js), which inserts
// directly and is a separate, drag-and-drop-deployed Netlify site — it cannot
// require this file. The two must be changed together, or an answered form
// lands differently depending on which writer won the race.
//
// What these fix: the form asks cash buyers for a max purchase price and lets
// everyone select SEVERAL deal structures. The old versions dropped both
// (max_price was hardcoded 0; parseStrategy returned one value, first match
// wins), so a buyer could answer the questionnaire in full and still be
// classified `partial` by buyBoxCompleteness — which meant onboard-buyers.js
// kept asking them for a buy box they had already given.
"use strict";

const NAME_TO_ABBR = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",
  illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",
  maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",
  pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA",
  "west virginia":"WV",wisconsin:"WI",wyoming:"WY",
};
const VALID_ABBR = new Set(Object.values(NAME_TO_ABBR));

function parseStates(raw) {
  const out = [];
  for (let part of (raw || "").replace(/;/g, ",").split(",")) {
    part = part.trim();
    if (!part) continue;
    if (VALID_ABBR.has(part.toUpperCase())) out.push(part.toUpperCase());
    else if (NAME_TO_ABBR[part.toLowerCase()]) out.push(NAME_TO_ABBR[part.toLowerCase()]);
  }
  return [...new Set(out)].join(",");
}

// The form's strategy pills are multi-select and arrive comma-joined
// ("Subject-To,Cash"). matchesDeal already understands a comma list
// (deal-shared.js), so keep EVERY structure the buyer picked — collapsing to
// one silently stopped them receiving the other deal types they asked for.
// Order is the canonical one below, not the order they happened to tap.
const STRATEGY_MATCHERS = [
  ["morby", (s) => s.includes("morby") || s.includes("stack")],
  ["subto", (s) => s.includes("subject") || s.includes("sub-to") || s.includes("sub to")],
  ["owner_finance", (s) => s.includes("seller") || s.includes("owner") || s.includes("finance")],
  ["cash", (s) => s.includes("cash")],
];

function parseStrategy(raw) {
  const r = (raw || "").toLowerCase().trim();
  // "All strategies" is an explicit answer, and it outranks any pill that may
  // also be set — it means "send me everything".
  if (/\ball\b/.test(r)) return "all";

  const picked = [];
  for (const part of r.split(",")) {
    const p = part.trim();
    if (!p) continue;
    for (const [key, test] of STRATEGY_MATCHERS) {
      if (test(p) && !picked.includes(key)) picked.push(key);
    }
  }
  if (picked.length) {
    return STRATEGY_MATCHERS.map(([k]) => k).filter((k) => picked.includes(k)).join(",");
  }
  // Unrecognized input still falls back to "all": they keep receiving every
  // deal, which is the safe direction to be wrong in.
  return "all";
}

function parseInt0(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

// The purchase-price cap for matchesDeal. Only cash_max_price belongs here:
// sf_max_down is a DOWN PAYMENT cap, and matching it against a deal's asking
// price would exclude buyers who can easily afford the deal.
function parseMaxPrice(data) {
  return parseInt0((data && (data.cash_max_price || data.max_price)) || 0);
}

module.exports = { parseStates, parseStrategy, parseInt0, parseMaxPrice, NAME_TO_ABBR };
