// Single source of truth for blast email SUBJECT lines — shared by the sender
// (send-blast.js) and the reply capturer (capture-replies.js) so a change to
// one can never silently break the other.
//
// Why this file exists: send-blast once moved the Sub-To subject to
// "New Sub-To Deal: …" while capture-replies kept searching Gmail for the old
// "New SubTo Deal" and parsing an "— <addr>" separator that no longer existed.
// Gmail tokenizes "Sub-To" as two words, so the query matched nothing and
// email replies (the hottest buyer signal) silently stopped being captured —
// while the heartbeat still reported "ok" because zero matches is a clean run.
//
// Rule: the subject BUILDERS and the reply PARSER live here together. Any change
// to a builder must keep tests/subjects.test.js (a build→parse round-trip) green.
// Keep this file free of I/O, DOM, and env vars, like deal-shared.js.

"use strict";

function fmtEntryFee(entryFee) {
  const n = Number(entryFee) || 0;
  return n ? "$" + n.toLocaleString() : "Ask";
}

// Sub-To blast email subject. `headline` is the deal's headline location
// (send-blast passes prop.name, e.g. "123 Main St, Ocala, FL 34479").
function subtoSubject(headline, entryFee) {
  return `New Sub-To Deal: ${headline} | ${fmtEntryFee(entryFee)} Entry Fee`;
}

// Morby / Stack Method blast email subject.
function morbySubject(address) {
  return `Stack Method Deal: ${address}`;
}

// Cash / wholesale blast email subject. The forgiven amount is this
// structure's whole hook, so it rides in the subject the way the entry fee
// does for Sub-To. Same "<prefix>: <name> | <hook>" shape, which is what
// propertyNameFromSubject already knows how to take apart.
function cashSubject(address, amountForgiven) {
  const n = Number(amountForgiven) || 0;
  return `Cash Deal: ${address}` + (n ? ` | $${n.toLocaleString()} Forgiven` : "");
}

// Subjects the reply capturer searches Gmail for. Includes both current
// formats plus the legacy Sub-To phrasing, so replies to any blast still in
// the 7-day capture window are matched during/after a wording change.
const REPLY_SEARCH_SUBJECTS = [
  "New Sub-To Deal",   // current Sub-To
  "Stack Method Deal", // current Morby / Stack
  "Cash Deal",         // current cash / wholesale
  "New SubTo Deal",    // legacy Sub-To — safe to drop once no blasts with this wording remain in the 7d window
];

// Gmail search matching any of the blast subjects. Gmail splits on
// non-alphanumerics, so quoting each whole phrase keeps its words adjacent.
function replyGmailQuery() {
  const ors = REPLY_SEARCH_SUBJECTS.map((s) => `subject:"${s}"`).join(" OR ");
  return `in:inbox newer_than:7d -from:me (${ors})`;
}

// Pull the property's headline/street part out of a (possibly "Re:"-prefixed)
// blast-reply subject, for BOTH deal types. Returns "" when the subject isn't
// one of our blasts. Splitting on the first comma drops the city/state/zip so
// the downstream property lookup can ilike-match on the street.
//   "Re: New Sub-To Deal: 123 Main St, Ocala, FL 34479 | $5,000 Entry Fee" -> "123 Main St"
//   "Re: Stack Method Deal: 456 Oak Ave, Dallas, TX"                       -> "456 Oak Ave"
//   "Re: Cash Deal: 3014 N Tampa St, Tampa, FL | $285,000 Forgiven"        -> "3014 N Tampa St"
//   "Re: New SubTo Deal — 789 Pine Rd, Austin, TX | $3,000 Entry Fee"      -> "789 Pine Rd" (legacy)
function propertyNameFromSubject(subject) {
  const s = String(subject || "");
  // Current formats share "<prefix>: <name>[ | ...]".
  let m = s.match(/(?:New Sub-To Deal|Stack Method Deal|Cash Deal)\s*:\s*([^|]+)/i);
  // Legacy Sub-To used an em/en/hyphen dash instead of a colon.
  if (!m) m = s.match(/New SubTo Deal\s*[—–-]\s*([^|]+)/i);
  if (!m) return "";
  return m[1].split(",")[0].trim();
}

module.exports = {
  subtoSubject,
  morbySubject,
  cashSubject,
  replyGmailQuery,
  propertyNameFromSubject,
  REPLY_SEARCH_SUBJECTS,
};
