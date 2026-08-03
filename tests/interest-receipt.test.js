const test = require("node:test");
const assert = require("node:assert");
const { emailish, firstNameOf, receiptSubject, buildReceiptHtml } =
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

test("the booking button only renders when a Calendly URL is configured", () => {
  assert.ok(!buildReceiptHtml(base).includes("Book a call"));
  const withCal = buildReceiptHtml({ ...base, calendlyUrl: "https://calendly.com/zach/15min" });
  assert.ok(withCal.includes("Book a call"));
  assert.ok(withCal.includes("https://calendly.com/zach/15min"));
});

test("the closing line points at the booking link only when there is one", () => {
  assert.match(buildReceiptHtml(base), /Just reply to this email/);
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
