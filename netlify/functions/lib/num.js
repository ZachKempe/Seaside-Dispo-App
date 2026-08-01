// Loose number parsing for the AI-extraction intakes (parse-subto.js). Kept
// pure — no I/O, no env — so tests/num.test.js can import it, like subjects.js
// and deal-shared.js.
"use strict";

// Integer-or-zero from a possibly formatted money/number value ("$1,543.21",
// 1234.56, "1,200"). Keeps the decimal point when stripping formatting —
// "$1,543.21" must become 1543 (rounded), never 154321 — then rounds to the
// nearest integer. Anything that doesn't parse to one number returns 0: a
// multi-dot string like "1.543.21" (European-style separators) is ambiguous
// about magnitude, and 0 (rendered downstream as missing/"Ask") is safer than
// a figure 100x or 1000x off.
const int0 = (v) => {
  const n = Math.round(Number(String(v ?? "").replace(/[^\d.-]/g, "")));
  return Number.isFinite(n) ? n : 0;
};

module.exports = { int0 };
