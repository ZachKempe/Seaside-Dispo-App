// Tests for lib/deck-pdf.js — the shared "does this deal have a PDF?" probe
// (H3). deck.js gates its PDF button on it and deck-interest.js gates the
// receipt's download button on it; if the two ever disagreed, one of them
// would be offering a file that isn't there.
//
// fetch is stubbed rather than mocked through a library — this file makes
// exactly one HEAD request and the interesting behavior is all in how it
// treats the response.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

// deck-pdf.js reads SUPABASE_URL at module load (like every other function
// lib), so this has to be set BEFORE the require or the probe short-circuits
// on its no-config guard.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://sb.test";

const { deckPdfExists, deckPdfStorageUrl, cleanSlug } =
  require("../netlify/functions/lib/deck-pdf");

function withFetch(impl, fn) {
  const real = global.fetch;
  global.fetch = impl;
  return Promise.resolve(fn()).finally(() => { global.fetch = real; });
}

test("the storage path matches the one blast-core uploads to", () => {
  // blast-core writes `deal-decks/${slug}.pdf` in the property-photos bucket.
  // A drift here means every deck silently loses its PDF button.
  assert.ok(deckPdfStorageUrl("3014-n-tampa-st")
    .endsWith("/storage/v1/object/public/property-photos/deal-decks/3014-n-tampa-st.pdf"));
});

test("a present object means the button shows", async () => {
  let calls = 0;
  await withFetch(async (url, opts) => {
    calls++;
    assert.strictEqual(opts.method, "HEAD");
    assert.ok(String(url).endsWith("deal-decks/abc.pdf"));
    return { ok: true };
  }, async () => {
    assert.strictEqual(await deckPdfExists("abc"), true);
  });
  assert.strictEqual(calls, 1);
});

test("a missing object means no button — this is the H3 case", async () => {
  await withFetch(async () => ({ ok: false, status: 404 }), async () => {
    assert.strictEqual(await deckPdfExists("sub-to-deal-with-no-pdf"), false);
  });
});

test("a failed probe hides the button rather than offering a broken link", async () => {
  await withFetch(async () => { throw new Error("network down"); }, async () => {
    assert.strictEqual(await deckPdfExists("abc"), false);
  });
});

test("an empty or junk slug never reaches the network", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true }; }, async () => {
    for (const s of ["", null, undefined, "///", "!!!"]) {
      assert.strictEqual(await deckPdfExists(s), false, JSON.stringify(s));
    }
  });
  assert.strictEqual(calls, 0);
});

test("slugs are sanitized to the alphabet deck-slug.js mints", () => {
  assert.strictEqual(cleanSlug("3014-n-tampa_st"), "3014-n-tampa_st");
  assert.strictEqual(cleanSlug("../../etc/passwd"), "etcpasswd");
  assert.strictEqual(cleanSlug("a b?c=1"), "abc1");
});

test("no Supabase config hides the button instead of guessing", async () => {
  // Deploy previews and local runs can be missing env entirely. Offering a
  // download we cannot resolve is the failure mode H3 existed to remove.
  const saved = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  try {
    delete require.cache[require.resolve("../netlify/functions/lib/deck-pdf")];
    const fresh = require("../netlify/functions/lib/deck-pdf");
    await withFetch(async () => ({ ok: true }), async () => {
      assert.strictEqual(await fresh.deckPdfExists("abc"), false);
    });
  } finally {
    process.env.SUPABASE_URL = saved;
    delete require.cache[require.resolve("../netlify/functions/lib/deck-pdf")];
  }
});
