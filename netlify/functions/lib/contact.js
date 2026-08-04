// C1 — the deck page collects ONE free-text contact field ("Phone or email",
// deck.js), so before an untokenized hand-raise can become a buyers row we have
// to decide which column that text belongs in. Pure (no I/O, no env) so
// tests/contact.test.js can import it, like num.js and onboard-sequence.js.
"use strict";

const { emailish } = require("./interest-receipt");

// Email anywhere in the string, so "email me at bob@acme.com" still resolves.
// The shape test itself stays emailish() — a second email regex is exactly the
// kind of drift CLAUDE.md warns about.
const EMAIL_IN_TEXT = /[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}/;

// Phones are stored as bare digits so migration 029's generated phone_norm
// column ("strip non-digits, then one leading 1") normalizes them identically
// to digitsOnly() in capture.js. Anything that isn't a US 10-digit number is
// rejected rather than guessed at: a half-broken buyer row is worse than none,
// and we can't blast an unusable number anyway.
function usPhoneDigits(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return d.length === 10 ? d : "";
}

// { email, phone } — at most one is set, email wins. Both blank means the text
// was neither, and the caller must record the lead WITHOUT creating a buyer.
function parseContact(raw) {
  const s = String(raw || "").trim();
  if (!s) return { email: "", phone: "" };

  if (emailish(s)) return { email: s.toLowerCase(), phone: "" };
  const m = s.match(EMAIL_IN_TEXT);
  if (m && emailish(m[0])) return { email: m[0].toLowerCase(), phone: "" };

  return { email: "", phone: usPhoneDigits(s) };
}

module.exports = { parseContact, usPhoneDigits };
