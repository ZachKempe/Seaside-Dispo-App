// Pins the shape of PostgREST `select=` lists against the actual schema.
//
// deck-link.js asked properties for `address_override`, a column that lives on
// morby_deals (migration 012) and has never existed on properties. PostgREST
// answers a bad column with a 400, so the resolver failed 100% of the time —
// not intermittently, not for some deals. It stayed hidden for months because
// the dashboard short-circuits to a client-built URL whenever a card already
// has a slug, so the only callers were legacy cards; 📄 Copy PDF link, which
// always goes through the resolver, hit it on the first click.
//
// A hand-listed column set is a copy of the schema that nothing keeps in sync,
// so the check here reads the real column list out of sql/ and requires every
// named column to exist. Narrowing a select is fine; inventing a column isn't.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const FUNCTIONS_DIR = path.join(__dirname, "..", "netlify", "functions");
const ROOT = path.join(__dirname, "..");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

// Columns that live on morby_deals, not properties. Reading one off a
// properties row yields undefined (silent wrong output); naming one in a
// properties select= yields a 400 (loud, total failure).
const MORBY_ONLY_COLUMNS = ["address_override"];

// Every `/properties?...select=<list>` in the codebase.
function propertiesSelects() {
  const found = [];
  for (const f of jsFiles(FUNCTIONS_DIR)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\/properties\?[^`"']*?select=([^&`"'\s]+)/g)) {
      found.push({ file: path.relative(ROOT, f), select: m[1] });
    }
  }
  return found;
}

test("no properties query selects a morby_deals-only column", () => {
  const bad = propertiesSelects().filter((q) =>
    MORBY_ONLY_COLUMNS.some((c) => q.select.split(",").includes(c)),
  );
  assert.deepEqual(
    bad.map((q) => `${q.file}: select=${q.select}`), [],
    "these columns live on morby_deals — PostgREST 400s the whole request",
  );
});

// The properties columns sql/ actually creates: the create-table body plus
// every `alter table properties add column`.
function propertiesColumns() {
  const sqlDir = path.join(ROOT, "sql");
  const cols = new Set();
  for (const f of fs.readdirSync(sqlDir).filter((n) => n.endsWith(".sql"))) {
    const src = fs.readFileSync(path.join(sqlDir, f), "utf8");
    const create = src.match(/create table if not exists properties\s*\(([\s\S]*?)\n\);/i);
    if (create) {
      for (const line of create[1].split("\n")) {
        const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+/i);
        // Skip table-level constraint lines, which start with a keyword.
        if (m && !/^(primary|foreign|unique|check|constraint)$/i.test(m[1])) cols.add(m[1]);
      }
    }
    for (const m of src.matchAll(/alter table (?:public\.)?properties\s+add column(?:\s+if not exists)?\s+([a-z_][a-z0-9_]*)/gi)) {
      cols.add(m[1]);
    }
  }
  return cols;
}

test("every column named in a properties select actually exists on properties", () => {
  const known = propertiesColumns();
  assert.ok(known.has("card_id") && known.has("deck_slug"), "couldn't parse the properties schema out of sql/");
  const bad = [];
  for (const q of propertiesSelects()) {
    if (q.select === "*") continue;
    for (const col of q.select.split(",")) {
      if (col && col !== "*" && !known.has(col)) bad.push(`${q.file}: select=${q.select} — no properties.${col}`);
    }
  }
  assert.deepEqual(bad, [], "PostgREST 400s the entire request on an unknown column");
});

test("deck-link resolves the slug from the same row shape as a blast", () => {
  // ensureDeckSlug derives the slug from the row it's handed, so if these two
  // fetch different columns they can mint different slugs for one deal — and
  // the deck URL in an email would stop matching the one Copy link produces.
  const deckLink = fs.readFileSync(path.join(FUNCTIONS_DIR, "deck-link.js"), "utf8");
  const blastCore = fs.readFileSync(path.join(FUNCTIONS_DIR, "lib", "blast-core.js"), "utf8");
  for (const [name, src] of [["deck-link.js", deckLink], ["blast-core.js", blastCore]]) {
    assert.match(src, /\/properties\?card_id=eq\.\$\{encodeURIComponent\(card_id\)\}&select=\*/, `${name} should fetch the whole properties row`);
    assert.match(src, /ensureDeckSlug\(sb, prop\)/, `${name} should mint slugs through the shared ensureDeckSlug`);
  }
});
