// Tests for the unsubscribe token (netlify/functions/lib/unsub.js). Minting
// and verifying were two hand-copied implementations until B4; these pin the
// format so a future edit can't silently invalidate every unsubscribe link
// already sitting in a buyer's inbox.
const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.UNSUB_SECRET = "test-secret";
const { unsubToken, unsubUrlFor, verifyToken } = require("../netlify/functions/lib/unsub");

test("token is <id>.<16 hex chars> and round-trips", () => {
  const t = unsubToken(42);
  assert.match(t, /^42\.[0-9a-f]{16}$/);
  assert.equal(verifyToken(t), 42);
});

test("pinned value — changing the formula would break live links", () => {
  // First 16 hex of HMAC-SHA256("42", "test-secret"). If this assertion has to
  // change, every unsubscribe link already sent has stopped working.
  assert.equal(unsubToken(42), "42.0c448d9ba9697edc");
  assert.equal(unsubToken("42"), unsubToken(42)); // string/number ids agree
});

test("forged, empty and malformed tokens are rejected", () => {
  assert.equal(verifyToken("42.deadbeefdeadbeef"), null);
  assert.equal(verifyToken("42"), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(undefined), null);
  // Another buyer's signature doesn't work on this id.
  const other = unsubToken(43).split(".")[1];
  assert.equal(verifyToken(`42.${other}`), null);
});

test("the URL carries the token on the b param", () => {
  const url = unsubUrlFor(42);
  assert.ok(url.includes("/.netlify/functions/unsubscribe?b="));
  assert.equal(verifyToken(decodeURIComponent(url.split("b=")[1])), 42);
});
