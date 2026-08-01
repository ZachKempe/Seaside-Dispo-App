"use strict";

// SMS opt-out compliance (commit 6c4306e + the unmatched-STOP suppression fix).
// The OPT_OUT_RE whole-message anchor is deliberate — "stop sending these" is
// conversation, not a TCPA revocation — so these tests pin it from both sides.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  OPT_OUT_RE,
  recordSmsSuppression,
  suppressedPhoneDigits,
} = require("../netlify/functions/lib/sms-optout");

test("opt-out keywords match, whatever the case or padding", () => {
  for (const msg of ["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "cancel", "opt out"]) {
    assert.ok(OPT_OUT_RE.test(msg), `should match: ${JSON.stringify(msg)}`);
  }
});

test("keyword inside a longer message does NOT opt out", () => {
  for (const msg of ["stop sending these", "please stop texting me", "don't stop"]) {
    assert.ok(!OPT_OUT_RE.test(msg), `should NOT match: ${JSON.stringify(msg)}`);
  }
});

// Fake sb capturing PostgREST calls, so the DB helpers can be exercised
// without Supabase (same approach as fetch-all.test.js).
function fakeSb(rows = []) {
  const calls = [];
  const sb = async (path, opts = {}) => {
    calls.push({ path, opts });
    return rows;
  };
  return { sb, calls };
}

test("recordSmsSuppression keys on normalized digits, keeps the raw phone", async () => {
  const { sb, calls } = fakeSb();
  assert.equal(await recordSmsSuppression(sb, "+1 (555) 123-4567"), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].path.includes("/sms_suppressions"), "writes sms_suppressions");
  const body = JSON.parse(calls[0].opts.body);
  // digitsOnly convention: non-digits stripped, leading US "1" dropped — the
  // same key "(555) 123-4567" would produce, so formats collide as intended.
  assert.equal(body.phone_digits, "5551234567");
  assert.equal(body.raw_phone, "+1 (555) 123-4567");
  assert.equal(body.reason, "stop_reply");
});

test("recordSmsSuppression refuses a phone with no digits", async () => {
  const { sb, calls } = fakeSb();
  assert.equal(await recordSmsSuppression(sb, ""), false);
  assert.equal(await recordSmsSuppression(sb, "not a number"), false);
  assert.equal(calls.length, 0, "no insert attempted");
});

test("suppressedPhoneDigits returns the set of stored digits", async () => {
  const { sb } = fakeSb([{ phone_digits: "5551234567" }, { phone_digits: "3125550000" }]);
  const set = await suppressedPhoneDigits(sb);
  assert.ok(set.has("5551234567"));
  assert.ok(set.has("3125550000"));
  assert.equal(set.size, 2);
});

test("suppressedPhoneDigits fails soft to an empty set (migration 032 not run)", async () => {
  const sb = async () => { throw new Error("Supabase /sms_suppressions -> 404: relation does not exist"); };
  const set = await suppressedPhoneDigits(sb);
  assert.equal(set.size, 0);
});
