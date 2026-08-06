const test = require("node:test");
const assert = require("node:assert");
const { emailish, firstNameOf, receiptSubject, buildReceiptHtml,
        resolveCalendlyUrl, DEFAULT_CALENDLY_URL } =
  require("../netlify/functions/lib/interest-receipt");

const base = {
  firstName: "Dana",
  address: "3014 N Tampa St",
  deckUrl: "https://x.test/deck/3014-n-tampa-st",
  pdfUrl: "",
  offer: 0,
  calendlyUrl: "",
  contactName: "Seaside Horizon",
  contactPhone: "",
};

// ── emailish ────────────────────────────────────────────────────────
// The untokenized deck form takes free-text contact. Letting a phone number
// through would hand Resend a garbage recipient on every anonymous hand-raise.
test("emailish accepts real addresses", () => {
  for (const s of ["a@b.co", "dana.smith@example.com", "  dana@example.com  "]) {
    assert.equal(emailish(s), true, s);
  }
});

test("emailish rejects phone numbers and junk — the anonymous-path guard", () => {
  for (const s of ["6304885311", "630-488-5311", "(630) 488-5311", "+1 630 488 5311",
                   "", null, undefined, "dana", "dana@", "@example.com", "dana@example",
                   "two words@example.com"]) {
    assert.equal(emailish(s), false, JSON.stringify(s));
  }
});

// ── firstNameOf ─────────────────────────────────────────────────────
test("firstNameOf takes and capitalizes the first token", () => {
  assert.equal(firstNameOf("dana smith"), "Dana");
  assert.equal(firstNameOf("  Dana  Smith "), "Dana");
});

test("firstNameOf falls back to 'there' when the name is missing or an email", () => {
  assert.equal(firstNameOf(""), "there");
  assert.equal(firstNameOf(null), "there");
  assert.equal(firstNameOf("dana@example.com"), "there");
});

// ── subject ─────────────────────────────────────────────────────────
test("an offer gets its own subject line", () => {
  assert.match(receiptSubject({ address: "3014 N Tampa St", offer: 250000 }), /^Got your offer — 3014 N Tampa St$/);
  assert.match(receiptSubject({ address: "3014 N Tampa St", offer: 0 }), /^3014 N Tampa St — /);
});

// ── buildReceiptHtml ────────────────────────────────────────────────
test("the deck link is always present", () => {
  assert.ok(buildReceiptHtml(base).includes(base.deckUrl));
});

// A button we cannot honor must never render: the PDF only exists once a blast
// has uploaded one, and the booking link only once CALENDLY_URL is set.
test("the PDF button only renders when a PDF URL is supplied", () => {
  assert.ok(!buildReceiptHtml(base).includes("Download the PDF"));
  const withPdf = buildReceiptHtml({ ...base, pdfUrl: "https://x.test/deck/s.pdf" });
  assert.ok(withPdf.includes("Download the PDF"));
  assert.ok(withPdf.includes("https://x.test/deck/s.pdf"));
});

// ── the booking button ──────────────────────────────────────────────
// REGRESSION: this shipped relying on CALENDLY_URL alone. The env var was set
// in Netlify after the deploy, Netlify only injects env into functions at
// deploy time, and live receipts went out with no booking button and no error
// anywhere. The button must now be unconditional.
test("the booking button renders even with NO calendly URL supplied at all", () => {
  for (const missing of [{}, { calendlyUrl: "" }, { calendlyUrl: null }, { calendlyUrl: undefined }]) {
    const html = buildReceiptHtml({ ...base, ...missing });
    assert.ok(html.includes("Book a call"), JSON.stringify(missing));
    assert.ok(html.includes(DEFAULT_CALENDLY_URL), JSON.stringify(missing));
  }
});

test("a configured Calendly URL overrides the default", () => {
  const html = buildReceiptHtml({ ...base, calendlyUrl: "https://calendly.com/other/15min" });
  assert.ok(html.includes("https://calendly.com/other/15min"));
  assert.ok(!html.includes(DEFAULT_CALENDLY_URL));
});

// A bare "calendly.com/x" with no scheme would render as a relative link and
// 404 inside the email client. Fall back rather than ship a broken button.
test("a malformed Calendly URL falls back to the default, never to nothing", () => {
  for (const bad of ["calendly.com/zach", "http://calendly.com/zach", "not a url", "   ", "javascript:alert(1)"]) {
    assert.equal(resolveCalendlyUrl(bad), DEFAULT_CALENDLY_URL, bad);
  }
});

test("resolveCalendlyUrl trims surrounding whitespace off a good URL", () => {
  assert.equal(resolveCalendlyUrl("  https://calendly.com/zach/30min  "), "https://calendly.com/zach/30min");
});

test("the default is a well-formed https Calendly URL", () => {
  assert.match(DEFAULT_CALENDLY_URL, /^https:\/\/calendly\.com\/[\w-]+\/[\w-]+$/);
});

test("the closing line always points at the booking link", () => {
  assert.match(buildReceiptHtml(base), /Grab a time above/);
  assert.match(buildReceiptHtml({ ...base, calendlyUrl: "https://c.test/z" }), /Grab a time above/);
});

test("an offer is acknowledged with its formatted amount", () => {
  const html = buildReceiptHtml({ ...base, offer: 250000 });
  assert.ok(html.includes("$250,000"));
  assert.match(html, /I have your offer/);
});

test("the phone line only renders when a contact phone is configured", () => {
  assert.ok(!buildReceiptHtml(base).includes("630-488-5311"));
  assert.ok(buildReceiptHtml({ ...base, contactPhone: "630-488-5311" }).includes("630-488-5311"));
});

// Buyer names and addresses are attacker-supplied on the untokenized path —
// they land in Zach's HTML email, so they must not be able to inject markup.
test("names and addresses are escaped into the HTML", () => {
  const html = buildReceiptHtml({
    ...base,
    firstName: '<script>alert(1)</script>',
    address: 'O"Neil & Sons <b>',
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("&quot;"));
});

// ── C2: the buy-box ask ─────────────────────────────────────────────
// Rendered only when deck-interest.js hands over a URL, which it does only for
// a buyer we can identify whose box isn't already complete.
test("the buy-box block renders only when a URL is supplied", () => {
  assert.ok(!buildReceiptHtml(base).includes("Tell us what you buy"));
  const html = buildReceiptHtml({ ...base, buyBoxUrl: "https://x.test/buy-box?t=42.abc" });
  assert.match(html, /Tell us what you buy/);
  assert.ok(html.includes("https://x.test/buy-box?t=42.abc"));
});

test("the buy-box ask sits below the deal buttons, never among them", () => {
  const html = buildReceiptHtml({
    ...base, pdfUrl: "https://x.test/deck/a.pdf", buyBoxUrl: "https://x.test/buy-box?t=1.a",
  });
  // "View the deal" is what they came for — the ask must not outrank it.
  assert.ok(html.indexOf("View the deal") < html.indexOf("Tell us what you buy"));
  assert.ok(html.indexOf("Book a call") < html.indexOf("Tell us what you buy"));
});

test("the buy-box URL is escaped into the href", () => {
  const html = buildReceiptHtml({ ...base, buyBoxUrl: 'https://x.test/buy-box?t=1"><script>' });
  assert.ok(!html.includes('"><script>'));
  assert.ok(html.includes("&quot;"));
});

test("an offer receipt still carries the ask — an offer is not a buy box", () => {
  const html = buildReceiptHtml({ ...base, offer: 250000, buyBoxUrl: "https://x.test/buy-box?t=1.a" });
  assert.match(html, /Tell us what you buy/);
});
