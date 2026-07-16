// Syntax-check the small inline <script> blocks that still live in
// index.html and reset.html (every other page loads external files that
// `node --check` covers). Extract each inline block and parse it with
// new Function(...) — a syntax error throws and fails CI.

const fs = require("fs");
const path = require("path");

const PAGES = ["public/index.html", "public/reset.html"];

let checked = 0;
let failed = 0;

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(__dirname, "..", page), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [i, m] of scripts.entries()) {
    const body = m[1].trim();
    if (!body) continue;
    checked++;
    try {
      new Function(body);
    } catch (e) {
      failed++;
      console.error(`✗ ${page} inline script #${i + 1}: ${e.message}`);
    }
  }
}

if (failed) {
  console.error(`${failed} of ${checked} inline script(s) failed to parse`);
  process.exit(1);
}
console.log(`✓ ${checked} inline script(s) parsed cleanly`);
