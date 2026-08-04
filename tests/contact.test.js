// Tests for lib/contact.js — the parser that decides whether the deck page's
// single free-text contact field is an email, a phone, or neither. Getting
// this wrong either drops a real lead's contact info into the wrong column or
// creates a half-broken buyer row, so the garbage cases matter as much as the
// happy path. Run with: npm test
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseContact, usPhoneDigits } = require("../netlify/functions/lib/contact");

// ── Email ─────────────────────────────────────────────────────────
test("parseContact recognizes a plain email and lower-cases it", () => {
  assert.deepEqual(parseContact("Bob@Acme.com"), { email: "bob@acme.com", phone: "" });
  assert.deepEqual(parseContact("  investor@example.co.uk  "), { email: "investor@example.co.uk", phone: "" });
});

test("parseContact finds an email embedded in a sentence", () => {
  assert.deepEqual(parseContact("email me at bob@acme.com"), { email: "bob@acme.com", phone: "" });
  assert.deepEqual(parseContact("Bob Smith <bob@acme.com>"), { email: "bob@acme.com", phone: "" });
});

test("parseContact prefers the email when the text carries both", () => {
  assert.deepEqual(parseContact("bob@acme.com or 555-123-4567"), { email: "bob@acme.com", phone: "" });
});

// ── Phone ─────────────────────────────────────────────────────────
test("parseContact accepts US phones in any format", () => {
  assert.deepEqual(parseContact("5551234567"), { email: "", phone: "5551234567" });
  assert.deepEqual(parseContact("(555) 123-4567"), { email: "", phone: "5551234567" });
  assert.deepEqual(parseContact("555.123.4567"), { email: "", phone: "5551234567" });
});

test("parseContact strips a leading country code, matching phone_norm (029)", () => {
  assert.deepEqual(parseContact("+1 (555) 123-4567"), { email: "", phone: "5551234567" });
  assert.deepEqual(parseContact("15551234567"), { email: "", phone: "5551234567" });
});

test("parseContact digs a phone out of surrounding words", () => {
  assert.deepEqual(parseContact("call me at 555-123-4567"), { email: "", phone: "5551234567" });
});

// ── Neither — the case that must NOT create a buyer ───────────────
test("parseContact returns both blank for garbage", () => {
  assert.deepEqual(parseContact("asdf"), { email: "", phone: "" });
  assert.deepEqual(parseContact(""), { email: "", phone: "" });
  assert.deepEqual(parseContact(null), { email: "", phone: "" });
  assert.deepEqual(parseContact(undefined), { email: "", phone: "" });
  assert.deepEqual(parseContact("   "), { email: "", phone: "" });
});

test("parseContact rejects number-ish text that isn't a US phone", () => {
  assert.deepEqual(parseContact("555-1234"), { email: "", phone: "" });        // 7 digits
  assert.deepEqual(parseContact("$250,000"), { email: "", phone: "" });        // an offer, not a contact
  assert.deepEqual(parseContact("+44 20 7946 0958"), { email: "", phone: "" }); // non-US, can't blast it
});

test("parseContact rejects malformed emails rather than storing them", () => {
  assert.deepEqual(parseContact("bob@acme"), { email: "", phone: "" });
  assert.deepEqual(parseContact("@acme.com"), { email: "", phone: "" });
});

// ── The digit normalizer on its own ───────────────────────────────
test("usPhoneDigits only strips a leading 1 from an 11-digit number", () => {
  assert.equal(usPhoneDigits("1234567890"), "1234567890"); // 10 digits starting with 1 — keep it whole
  assert.equal(usPhoneDigits("11234567890"), "1234567890");
  assert.equal(usPhoneDigits("25551234567"), "");          // 11 digits not starting with 1
});
