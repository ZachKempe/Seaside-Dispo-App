// Tests for the buy-box onboarding sequence's scheduling
// (netlify/functions/lib/onboard-sequence.js). This is the logic that decides
// whether a real buyer gets another message, so the failure mode it exists to
// prevent — the same follow-up going out twice — is what most of these check.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { dueTouch, touchesOf, ONBOARD_TOUCHES, TOUCH_GAP_DAYS } =
  require("../netlify/functions/lib/onboard-sequence");

const NOW = Date.parse("2026-08-01T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
// A buyer with no buy box at all — the whole point of the sequence.
const wildcard = (over = {}) => ({
  states: "", strategy: "", max_price: 0, max_piti: 0, min_beds: 0, ...over,
});

test("never asked → due for touch 1", () => {
  assert.equal(dueTouch(wildcard(), NOW), 1);
  assert.equal(touchesOf(wildcard()), 0);
});

test("legacy rows (onboarded_at, no counter) count as one touch", () => {
  const legacy = wildcard({ onboarded_at: daysAgo(30) });
  assert.equal(touchesOf(legacy), 1);
  assert.equal(dueTouch(legacy, NOW), 2);
});

test("touches are spaced — a second click the same day sends nothing", () => {
  const justAsked = wildcard({ onboard_touches: 1, onboard_last_at: daysAgo(0) });
  assert.equal(dueTouch(justAsked, NOW), 0);
  assert.equal(dueTouch(wildcard({ onboard_touches: 1, onboard_last_at: daysAgo(TOUCH_GAP_DAYS - 1) }), NOW), 0);
  assert.equal(dueTouch(wildcard({ onboard_touches: 1, onboard_last_at: daysAgo(TOUCH_GAP_DAYS) }), NOW), 2);
});

test("the sequence ends at ONBOARD_TOUCHES", () => {
  assert.equal(dueTouch(wildcard({ onboard_touches: 2, onboard_last_at: daysAgo(90) }), NOW), 3);
  assert.equal(dueTouch(wildcard({ onboard_touches: ONBOARD_TOUCHES, onboard_last_at: daysAgo(90) }), NOW), 0);
  assert.equal(dueTouch(wildcard({ onboard_touches: 9, onboard_last_at: daysAgo(90) }), NOW), 0);
});

test("a completed buy box stops the sequence at any point", () => {
  const answered = { states: "FL", strategy: "subto", max_price: 300000, onboard_touches: 1, onboard_last_at: daysAgo(60) };
  assert.equal(dueTouch(answered, NOW), 0);
  // A partial answer does NOT stop it — half a box still misroutes deals.
  assert.equal(dueTouch({ states: "FL", onboard_touches: 1, onboard_last_at: daysAgo(60) }, NOW), 2);
});

test("maxTouches=1 (migration 033 not run) allows the first ask and no follow-ups", () => {
  assert.equal(dueTouch(wildcard(), NOW, 1), 1);
  assert.equal(dueTouch(wildcard({ onboarded_at: daysAgo(60) }), NOW, 1), 0);
});

test("an already-touched buyer with no timestamp is never re-sent", () => {
  // Can't tell when they were asked, so don't guess.
  assert.equal(dueTouch(wildcard({ onboard_touches: 1 }), NOW), 0);
  assert.equal(dueTouch(wildcard({ onboard_touches: 1, onboard_last_at: "not a date" }), NOW), 0);
});
