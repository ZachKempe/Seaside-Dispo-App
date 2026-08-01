"use strict";

// Guards the int0 fix from commit 6c4306e: stripping formatting used to drop
// the decimal point too, so cents-bearing figures (PITI, loan balance) were
// stored 100x too big ("$1,543.21" -> 154321). These pin the rounding
// behavior and the fail-safe-to-0 for anything ambiguous.

const { test } = require("node:test");
const assert = require("node:assert");

const { int0 } = require("../netlify/functions/lib/num");

test("keeps the decimal point: '$1,543.21' -> 1543, not 154321", () => {
  assert.equal(int0("$1,543.21"), 1543);
});

test("rounds a plain decimal string: '1234.56' -> 1235", () => {
  assert.equal(int0("1234.56"), 1235);
});

test("comma thousands separator: '1,200' -> 1200", () => {
  assert.equal(int0("1,200"), 1200);
});

test("empty string -> 0", () => {
  assert.equal(int0(""), 0);
});

test("null -> 0", () => {
  assert.equal(int0(null), 0);
});

test("non-numeric text -> 0", () => {
  assert.equal(int0("abc"), 0);
});

test("multi-dot string fails safe to 0", () => {
  // "1.543.21" (European-style separators) is ambiguous — is it 1543.21 or
  // 1.54321? Number() can't parse the multi-dot remainder, so int0 returns 0,
  // which downstream renders as missing/"Ask". Deliberate: a blank term is
  // recoverable in the dashboard; a figure 100x or 1000x off gets blasted to
  // buyers.
  assert.equal(int0("1.543.21"), 0);
});
