// SMS opt-out compliance, shared by the inbound webhook (ghl-inbound.js) and
// the send path (blast-core.js). The regex is pure so tests/sms-optout.test.js
// can exercise it; the DB helpers take the caller's `sb` function (same
// pattern as deck-slug.js) so this file stays free of env/config.
"use strict";

const { digitsOnly } = require("./capture");
const { fetchAllRows } = require("./fetch-all");

// TCPA opt-out keywords (incl. the FCC's 2025 revocation list). Only matches
// when the message IS the keyword (trailing punctuation ok) — "please don't
// stop sending these" must not opt anyone out. The ^...$ anchors are
// deliberate; do not loosen them.
const OPT_OUT_RE = /^\s*(stop|stop\s?all|unsubscribe|cancel|end|quit|revoke|opt\s?out)[\s.!]*$/i;

// Durably record an opt-out keyed by normalized digits (sms_suppressions,
// migration 032). This is what makes STOP stick even when the number matches
// no buyer row — buyers.sms_opt_in can't cover a phone we don't have.
// Idempotent (repeat STOPs hit the primary key and are ignored). Returns
// false when the phone has no digits to key on.
async function recordSmsSuppression(sb, phone, reason = "stop_reply") {
  const pd = digitsOnly(phone);
  if (!pd) return false;
  await sb(`/sms_suppressions?on_conflict=phone_digits`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ phone_digits: pd, raw_phone: String(phone || "").slice(0, 40), reason }),
  });
  return true;
}

// The full suppressed set for the send path's audience filter, as normalized
// digit strings (compare via digitsOnly, like every other phone match).
// Fails soft to an empty set until migration 032 runs.
async function suppressedPhoneDigits(sb) {
  try {
    const rows = await fetchAllRows(
      (p) => sb(p, { method: "GET" }),
      `/sms_suppressions?select=phone_digits`
    );
    return new Set((rows || []).map((r) => r.phone_digits).filter(Boolean));
  } catch (e) {
    console.warn("sms_suppressions lookup failed (migration 032 not run?):", e.message);
    return new Set();
  }
}

module.exports = { OPT_OUT_RE, recordSmsSuppression, suppressedPhoneDigits };
