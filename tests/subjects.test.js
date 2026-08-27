"use strict";

// Guards the sender↔capturer contract: every subject the blast builds must
// parse back to the property's street part, and the Gmail query must actually
// contain the phrases we build. If a subject builder changes and these break,
// that's the drift that once silently killed email reply capture.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  subtoSubject,
  morbySubject,
  replyGmailQuery,
  propertyNameFromSubject,
  REPLY_SEARCH_SUBJECTS,
} = require("../netlify/functions/lib/subjects");

test("subtoSubject → propertyNameFromSubject round-trips the street", () => {
  const subj = subtoSubject("123 Main St, Ocala, FL 34479", 5000);
  assert.equal(subj, "New Sub-To Deal: 123 Main St, Ocala, FL 34479 | $5,000 Entry Fee");
  assert.equal(propertyNameFromSubject(subj), "123 Main St");
});

test("subtoSubject with no entry fee shows 'Ask' and still round-trips", () => {
  const subj = subtoSubject("77 Bay Rd, Tampa, FL", 0);
  assert.equal(subj, "New Sub-To Deal: 77 Bay Rd, Tampa, FL | Ask Entry Fee");
  assert.equal(propertyNameFromSubject(subj), "77 Bay Rd");
});

test("morbySubject → propertyNameFromSubject round-trips the street", () => {
  const subj = morbySubject("456 Oak Ave, Dallas, TX 75201");
  assert.equal(subj, "Stack Method Deal: 456 Oak Ave, Dallas, TX 75201");
  assert.equal(propertyNameFromSubject(subj), "456 Oak Ave");
});

test("parses subjects with a 'Re:' reply prefix", () => {
  assert.equal(
    propertyNameFromSubject("Re: New Sub-To Deal: 900 Elm St, Austin, TX | $3,000 Entry Fee"),
    "900 Elm St"
  );
  assert.equal(
    propertyNameFromSubject("Re: Stack Method Deal: 12 Pine Ct, Reno, NV"),
    "12 Pine Ct"
  );
});

test("still parses the legacy 'New SubTo Deal — <addr>' format (7d window)", () => {
  assert.equal(
    propertyNameFromSubject("Re: New SubTo Deal — 789 Pine Rd, Austin, TX | $3,000 Entry Fee"),
    "789 Pine Rd"
  );
});

test("non-blast subjects return empty (never touched)", () => {
  assert.equal(propertyNameFromSubject("Re: your invoice is ready"), "");
  assert.equal(propertyNameFromSubject(""), "");
  assert.equal(propertyNameFromSubject(null), "");
});

test("replyGmailQuery contains every phrase we build for", () => {
  const q = replyGmailQuery();
  for (const phrase of REPLY_SEARCH_SUBJECTS) {
    assert.ok(q.includes(`subject:"${phrase}"`), `query missing ${phrase}`);
  }
  // Both live builders' prefixes must be searchable.
  assert.ok(q.includes('subject:"New Sub-To Deal"'));
  assert.ok(q.includes('subject:"Stack Method Deal"'));
});

test("cashSubject → propertyNameFromSubject round-trips the street", () => {
  const { cashSubject } = require("../netlify/functions/lib/subjects");
  const subj = cashSubject("3014 N Tampa St, Tampa, FL 33603", 285000);
  assert.equal(subj, "Cash Deal: 3014 N Tampa St, Tampa, FL 33603 | $285,000 Forgiven");
  assert.equal(propertyNameFromSubject(subj), "3014 N Tampa St");
});

test("cashSubject with no forgiven amount drops the hook and still round-trips", () => {
  const { cashSubject } = require("../netlify/functions/lib/subjects");
  const subj = cashSubject("77 Bay Rd, Tampa, FL", 0);
  assert.equal(subj, "Cash Deal: 77 Bay Rd, Tampa, FL");
  assert.equal(propertyNameFromSubject(subj), "77 Bay Rd");
  assert.equal(propertyNameFromSubject("Re: " + subj), "77 Bay Rd");
});

test("the reply capturer searches for the cash subject too", () => {
  // A structure missing from REPLY_SEARCH_SUBJECTS silently stops its replies
  // — the exact failure this file exists to prevent.
  assert.ok(REPLY_SEARCH_SUBJECTS.includes("Cash Deal"));
  assert.ok(replyGmailQuery().includes('subject:"Cash Deal"'));
});
