const test = require("node:test");
const assert = require("node:assert");
const { fetchAllRows, PAGE_SIZE } = require("../netlify/functions/lib/fetch-all");

// Fake PostgREST: serves `total` rows, honoring limit/offset, capped per page
// like Supabase's max-rows setting.
function fakeSb(total) {
  const calls = [];
  const sbGet = async (path) => {
    calls.push(path);
    const limit = Number(path.match(/limit=(\d+)/)[1]);
    const offset = Number(path.match(/offset=(\d+)/)[1]);
    return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => ({ id: offset + i + 1 }));
  };
  return { sbGet, calls };
}

test("returns all rows past the 1,000-row page size", async () => {
  const { sbGet, calls } = fakeSb(2345);
  const rows = await fetchAllRows(sbGet, "/buyers?active=eq.true&select=*");
  assert.strictEqual(rows.length, 2345);
  assert.strictEqual(rows[0].id, 1);
  assert.strictEqual(rows[2344].id, 2345);
  assert.strictEqual(calls.length, 3);
});

test("single short page needs exactly one request", async () => {
  const { sbGet, calls } = fakeSb(42);
  const rows = await fetchAllRows(sbGet, "/buyers?select=phone,email");
  assert.strictEqual(rows.length, 42);
  assert.strictEqual(calls.length, 1);
});

test("row count exactly on a page boundary terminates", async () => {
  const { sbGet, calls } = fakeSb(PAGE_SIZE * 2);
  const rows = await fetchAllRows(sbGet, "/buyers?select=*");
  assert.strictEqual(rows.length, PAGE_SIZE * 2);
  assert.strictEqual(calls.length, 3); // last page is empty
});

test("zero rows returns empty array", async () => {
  const { sbGet } = fakeSb(0);
  assert.deepStrictEqual(await fetchAllRows(sbGet, "/buyers?select=*"), []);
});

test("appends a deterministic order (default id, overridable)", async () => {
  const { sbGet, calls } = fakeSb(1);
  await fetchAllRows(sbGet, "/buyers?select=*");
  assert.ok(calls[0].includes("order=id.asc"));

  const { sbGet: sbGet2, calls: calls2 } = fakeSb(1);
  await fetchAllRows(sbGet2, "/properties?select=card_id", { order: "card_id" });
  assert.ok(calls2[0].includes("order=card_id.asc"));

  // caller-supplied order wins
  const { sbGet: sbGet3, calls: calls3 } = fakeSb(1);
  await fetchAllRows(sbGet3, "/buyers?select=*&order=name.desc");
  assert.ok(!calls3[0].includes("order=id.asc"));
});

test("handles a path with no query string", async () => {
  const { sbGet, calls } = fakeSb(1);
  await fetchAllRows(sbGet, "/buyers");
  assert.ok(calls[0].startsWith("/buyers?limit="));
});
