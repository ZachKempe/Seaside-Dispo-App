// Pins the public host for every investor-facing link.
//
// Deck links, PDF links, the buy-box form link, the unsubscribe footer and the
// email logo are all composed at send time from one `SITE_URL` constant per
// function — nothing stores an absolute deck URL, so what these constants say
// is exactly what lands in an investor's inbox. Two ways that used to be able
// to break quietly, both pinned here:
//
//   1. A fallback still pointing at the netlify.app subdomain. If
//      PUBLIC_SITE_URL is ever unset, renamed or typo'd in Netlify, the || arm
//      is what ships — silently, on the next deploy, with no error anywhere.
//   2. A new link built from a hardcoded host instead of SITE_URL.
//
// If you genuinely move the domain, change PUBLIC_SITE_URL in Netlify AND the
// constant below — the point is that the two can't drift apart unnoticed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_HOST = "https://deals.seasidehorizon.com";
const OLD_HOST = "https://seaside-dispo-app.netlify.app";
const FUNCTIONS_DIR = path.join(__dirname, "..", "netlify", "functions");

// Every .js under netlify/functions, including lib/.
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.name.endsWith(".js") ? [full] : [];
  });
}

const files = jsFiles(FUNCTIONS_DIR);

test("no function references the old netlify.app host", () => {
  const offenders = files
    .filter((f) => fs.readFileSync(f, "utf8").includes(OLD_HOST))
    .map((f) => path.relative(path.join(__dirname, ".."), f));
  assert.deepEqual(
    offenders, [],
    `these still point at ${OLD_HOST} — use PUBLIC_SITE_URL with a ${PUBLIC_HOST} fallback:\n  ${offenders.join("\n  ")}`,
  );
});

test("every PUBLIC_SITE_URL fallback is the public host", () => {
  // Matches: process.env.PUBLIC_SITE_URL || "<something>"
  const re = /process\.env\.PUBLIC_SITE_URL\s*\|\|\s*"([^"]*)"/g;
  const bad = [];
  let found = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      found++;
      if (m[1] !== PUBLIC_HOST) bad.push(`${path.relative(path.join(__dirname, ".."), f)} -> ${m[1]}`);
    }
  }
  assert.ok(found > 0, "found no PUBLIC_SITE_URL fallbacks at all — did the constant get renamed?");
  assert.deepEqual(bad, [], `wrong fallback host:\n  ${bad.join("\n  ")}`);
});

test("the buyer-facing link builders all read SITE_URL", () => {
  // Each entry: file, and a snippet of the link it must build from SITE_URL.
  // A hardcoded host in any of these is what an investor would actually see.
  const builders = [
    ["lib/blast-core.js", "${SITE_URL}/deck/"],      // deck link in email + SMS
    ["lib/blast-core.js", "${SITE_URL}/img/logo.png"], // email logo (M11)
    ["deck-link.js", "${SITE_URL}/deck/"],           // 🔗 Copy link buttons
    ["deck-interest.js", "${SITE_URL}/deck/"],       // interest receipt
    ["lib/unsub.js", "siteUrl()"],                   // unsubscribe footer
  ];
  for (const [rel, snippet] of builders) {
    const src = fs.readFileSync(path.join(FUNCTIONS_DIR, rel), "utf8");
    assert.ok(src.includes(snippet), `${rel} no longer builds its link with ${snippet}`);
  }
});
