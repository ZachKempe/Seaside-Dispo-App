// Guards the Morby → Cash move.
//
// The move copies a hand-listed set of columns from morby_deals into
// cash_deals. A hand-listed set is a copy of the schema that nothing keeps in
// sync, and the failure mode is loud and live: PostgREST answers an unknown
// column with a 400, so the very first click of "→ Move to Cash" would fail
// with a raw error toast. This reads the real column list out of
// sql/035_cash_deals.sql and requires every copied field to exist.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const dashboard = fs.readFileSync(path.join(ROOT, "public", "js", "dashboard.js"), "utf8");
const cashSql = fs.readFileSync(path.join(ROOT, "sql", "035_cash_deals.sql"), "utf8");

// dashboard.js is a plain browser script, not a module, so the lists are read
// the same way properties-select.test.js reads its selects: out of the source.
function fieldList(name) {
  const m = dashboard.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} not found in dashboard.js`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

// Column names from the `create table if not exists cash_deals ( ... );` block.
function cashDealsColumns() {
  const body = cashSql.slice(cashSql.indexOf("create table if not exists cash_deals"));
  const cols = new Set();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}([a-z_]+)\s+(text|numeric|integer|boolean|timestamptz)\b/);
    if (m) cols.add(m[1]);
  }
  assert.ok(cols.size > 15, "failed to parse cash_deals columns");
  return cols;
}

const CARRIED = fieldList("MORBY_TO_CASH_FIELDS");
const DROPPED = fieldList("MORBY_ONLY_FIELDS");
const COLUMNS = cashDealsColumns();

test("every field the move copies is a real cash_deals column", () => {
  const missing = CARRIED.filter((f) => !COLUMNS.has(f));
  assert.deepEqual(missing, [], `MORBY_TO_CASH_FIELDS names columns cash_deals doesn't have: ${missing.join(", ")}`);
});

test("no seller-financing field is copied into cash_deals", () => {
  // Both directions: they must not be in the carry list, and they must not be
  // columns on cash_deals either — a cash deal has no seller note, so one
  // showing up in the schema would mean the structures had blurred together.
  const leaked = DROPPED.filter((f) => CARRIED.includes(f));
  assert.deepEqual(leaked, [], `seller-financing fields in the carry list: ${leaked.join(", ")}`);
  const inSchema = DROPPED.filter((f) => COLUMNS.has(f));
  assert.deepEqual(inSchema, [], `seller-financing columns on cash_deals: ${inSchema.join(", ")}`);
});

test("the price stack is never auto-filled by the move", () => {
  // original_price and amount_forgiven describe a concession that a Morby deal
  // does not have. Copying either would put a number nobody chose onto the
  // deck's headline. They're offered as a suggestion in the panel instead.
  for (const f of ["original_price", "amount_forgiven"]) {
    assert.ok(COLUMNS.has(f), `${f} should be a cash_deals column`);
    assert.ok(!CARRIED.includes(f), `${f} must not be carried over by the move`);
  }
});

test("the move carries the things that cost real work to re-enter", () => {
  // Not exhaustive — a regression check that the useful payload didn't get
  // trimmed to nothing. These are the fields Zach types by hand per deal.
  for (const f of ["purchase_price", "address_override", "dscr_rate", "dscr_ltv",
                   "ltr_monthly_rent", "str_monthly_rent", "monthly_taxes",
                   "monthly_insurance", "inspection_period_days", "property_type"]) {
    assert.ok(CARRIED.includes(f), `the move should carry ${f}`);
  }
});
