// B4.2 — when is a buyer due for their next buy-box ask? Pure scheduling
// logic, split out of onboard-buyers.js so tests/onboard-sequence.test.js can
// exercise the part that must never double-send.
//
// The state it reads:
//   onboard_touches   how many asks have gone out (migration 033)
//   onboard_last_at   when the last one did
//   onboarded_at      legacy: set by the pre-033 one-email-ever version
"use strict";

const { buyBoxCompleteness } = require("../../../public/js/deal-shared");

const ONBOARD_TOUCHES = 3;  // hard cap per buyer, ever
const TOUCH_GAP_DAYS = 5;   // minimum spacing between a buyer's own touches

// Touches already delivered. A legacy row carries onboarded_at and nothing
// else — that's exactly one.
function touchesOf(b) {
  return Number(b.onboard_touches) || (b.onboarded_at ? 1 : 0);
}
function lastTouchAt(b) {
  return b.onboard_last_at || b.onboarded_at || null;
}

// The touch number this buyer is due for right now, or 0 for "not due".
// maxTouches is passed in because the caller drops it to 1 when migration 033
// hasn't run: a follow-up it cannot record is a follow-up that repeats.
function dueTouch(b, now = Date.now(), maxTouches = ONBOARD_TOUCHES) {
  b = b || {};
  // Answered — stop asking. "partial" deliberately stays in the sequence:
  // half a buy box still misroutes deals.
  if (buyBoxCompleteness(b) === "full") return 0;
  const touches = touchesOf(b);
  if (touches >= maxTouches) return 0;
  if (touches > 0) {
    const last = lastTouchAt(b);
    // Touched at an unknown time: don't guess, don't re-send.
    if (!last) return 0;
    const days = (now - new Date(last).getTime()) / 86400000;
    if (!(days >= TOUCH_GAP_DAYS)) return 0; // NaN-safe: an unparseable date never sends
  }
  return touches + 1;
}

module.exports = { dueTouch, touchesOf, lastTouchAt, ONBOARD_TOUCHES, TOUCH_GAP_DAYS };
