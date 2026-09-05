"use strict";

// Per-buyer conversation panel (buyer-messages.js). The normalizers decide
// which side of the thread a message renders on and what text survives, so
// they're pinned from both providers' real payload shapes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const C = require("../netlify/functions/lib/conversation");

const b64url = (s) => Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── GoHighLevel ──────────────────────────────────────────────────
test("GHL: inbound/outbound SMS normalize; emails, calls and blanks are dropped", () => {
  const rows = [
    { id: "m1", direction: "inbound", body: "Is 123 Main still available?", dateAdded: "2026-09-01T14:00:00.000Z", messageType: "TYPE_SMS", status: "delivered", conversationId: "c1" },
    { id: "m2", direction: "outbound", body: "Yes — want the deck?", dateAdded: "2026-09-01T14:05:00.000Z", messageType: "TYPE_SMS", status: "sent" },
    { id: "m3", direction: "outbound", body: "<p>an email</p>", dateAdded: "2026-09-01T15:00:00.000Z", messageType: "TYPE_EMAIL" },
    { id: "m4", direction: "inbound", body: "", dateAdded: "2026-09-01T16:00:00.000Z", messageType: "TYPE_CALL" },
    { id: "m5", direction: "inbound", body: "   ", dateAdded: "2026-09-01T16:00:00.000Z", messageType: "TYPE_SMS" },
    { id: "m6", direction: "inbound", body: "legacy row, numeric type", dateAdded: "2026-09-01T17:00:00.000Z", type: 1 },
  ];
  const out = rows.map(C.normalizeGhlMessage).filter(Boolean);
  assert.deepEqual(out.map((m) => m.id), ["ghl:m1", "ghl:m2", "ghl:m6"]);
  assert.equal(out[0].direction, "in");
  assert.equal(out[1].direction, "out");
  assert.equal(out[0].channel, "sms");
  assert.equal(out[0].thread_id, "c1");
  assert.equal(out[0].at, "2026-09-01T14:00:00.000Z");
});

// ── Gmail ────────────────────────────────────────────────────────
function gmailMsg({ id, from, to, subject, labels = [], parts, body, internalDate = "1756735200000", threadId = "t1", msgId = "<abc@mail>" }) {
  const headers = [
    { name: "From", value: from }, { name: "To", value: to },
    { name: "Subject", value: subject }, { name: "Message-ID", value: msgId },
  ];
  const payload = parts
    ? { mimeType: "multipart/mixed", headers, parts }
    : { mimeType: "text/plain", headers, body: { data: b64url(body || "") } };
  return { id, threadId, labelIds: labels, internalDate, snippet: "snippet", payload };
}

test("Gmail: SENT label or our From address means outbound; a buyer's mail is inbound", () => {
  const ours = ["Seaside Horizon <zach@seasidehorizon.com>", "deals@seasidehorizon.com"];
  const sent = C.normalizeGmailMessage(gmailMsg({ id: "1", from: "Zach <zach@seasidehorizon.com>", to: "buyer@x.com", subject: "Hi", labels: ["SENT"], body: "hello" }), ours);
  const viaResend = C.normalizeGmailMessage(gmailMsg({ id: "2", from: "Seaside Horizon <deals@seasidehorizon.com>", to: "buyer@x.com", subject: "Deal", labels: ["INBOX"], body: "deck" }), ours);
  const reply = C.normalizeGmailMessage(gmailMsg({ id: "3", from: "Buyer <buyer@x.com>", to: "zach@seasidehorizon.com", subject: "Re: Hi", labels: ["INBOX", "UNREAD"], body: "interested" }), ours);
  assert.equal(sent.direction, "out");
  assert.equal(viaResend.direction, "out");
  assert.equal(reply.direction, "in");
  assert.equal(reply.channel, "email");
  assert.equal(reply.subject, "Re: Hi");
  assert.equal(reply.thread_id, "t1");
  assert.equal(reply.message_id, "<abc@mail>");
  assert.equal(reply.at, new Date(1756735200000).toISOString());
  assert.equal(reply.id, "gmail:3");
});

test("Gmail: text/plain wins inside nested multipart; html-only falls back to stripped text", () => {
  const nested = gmailMsg({
    id: "n", from: "b@x.com", to: "z@y.com", subject: "s",
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", body: { data: b64url("plain wins") } },
        { mimeType: "text/html", body: { data: b64url("<b>html loses</b>") } },
      ] },
      { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "a1", size: 100 } },
    ],
  });
  assert.equal(C.extractBody(nested.payload), "plain wins");

  const htmlOnly = gmailMsg({
    id: "h", from: "b@x.com", to: "z@y.com", subject: "s",
    parts: [{ mimeType: "text/html", body: { data: b64url("<div>Line one<br>Line &amp; two</div><p>Para</p><style>.x{}</style>") } }],
  });
  assert.equal(C.extractBody(htmlOnly.payload), "Line one\nLine & two\nPara");

  const indented = gmailMsg({
    id: "i", from: "b@x.com", to: "z@y.com", subject: "s",
    parts: [{ mimeType: "text/html", body: { data: b64url("<table><tr><td>\n        Was this email useful?\n      </td></tr>\n\n\n<tr><td>   Useful   </td></tr></table>") } }],
  });
  assert.equal(C.extractBody(indented.payload), "Was this email useful?\nUseful", "source indentation doesn't leak into the bubble");
});

test("Gmail: only mail exchanged WITH the buyer belongs in their thread", () => {
  const ours = ["zach@seasidehorizon.com"];
  const buyer = "buyer@x.com";
  const fromBuyer = gmailMsg({ id: "1", from: "Buyer <buyer@x.com>", to: "zach@seasidehorizon.com", subject: "hi", body: "a" });
  const toBuyer = gmailMsg({ id: "2", from: "zach@seasidehorizon.com", to: "Someone <else@y.com>, buyer@x.com", subject: "hi", labels: ["SENT"], body: "b" });
  const newsletter = gmailMsg({ id: "3", from: "OpenAI <noreply@openai.com>", to: "zach@seasidehorizon.com", subject: "4 new image styles", body: "c" });
  const toSomeoneElse = gmailMsg({ id: "4", from: "zach@seasidehorizon.com", to: "else@y.com", subject: "hi", labels: ["SENT"], body: "d" });
  assert.ok(C.normalizeGmailMessage(fromBuyer, ours, buyer));
  assert.ok(C.normalizeGmailMessage(toBuyer, ours, buyer));
  assert.equal(C.normalizeGmailMessage(newsletter, ours, buyer), null);
  assert.equal(C.normalizeGmailMessage(toSomeoneElse, ours, buyer), null);
  // The seed buyer IS our mailbox: the inbox's newsletters must still stay out.
  assert.equal(C.normalizeGmailMessage(newsletter, ours, "zach@seasidehorizon.com"), null);
  // No buyer email given → no gate (back-compat for callers that pre-filter).
  assert.ok(C.normalizeGmailMessage(newsletter, ours));
});

test("Gmail: a long blast body is capped in the thread", () => {
  const long = gmailMsg({ id: "L", from: "b@x.com", to: "z@y.com", subject: "s", body: "x".repeat(5000) });
  const m = C.normalizeGmailMessage(long, [], "b@x.com");
  assert.ok(m.body.length < 1600 && m.body.endsWith("…"));
});

test("quoted history is stripped, but a quote-only message keeps its first line", () => {
  assert.equal(C.stripQuotedReply("Yes, still available.\n\nOn Mon, Sep 1, 2026 at 2:00 PM Zach <z@y.com> wrote:\n> Is it available?"), "Yes, still available.");
  assert.equal(C.stripQuotedReply("Sounds good\n> earlier\n> lines"), "Sounds good");
  assert.equal(C.stripQuotedReply("Works for me.\r\n\r\n-----Original Message-----\r\nFrom: Zach"), "Works for me.");
  assert.equal(C.stripQuotedReply("Sure\n\nSent from my iPhone"), "Sure");
  assert.equal(C.stripQuotedReply("> only a quote\n> second"), "only a quote");
  assert.equal(C.stripQuotedReply("Don't stop sending these! On the other hand..."), "Don't stop sending these! On the other hand...");
});

// ── Merge / reply targeting ──────────────────────────────────────
test("mergeThread interleaves channels oldest-first and drops duplicate ids", () => {
  const sms = [{ id: "ghl:2", channel: "sms", at: "2026-09-02T10:00:00Z" }, { id: "ghl:1", channel: "sms", at: "2026-09-01T10:00:00Z" }];
  const email = [{ id: "gmail:a", channel: "email", at: "2026-09-01T12:00:00Z" }, { id: "ghl:1", channel: "sms", at: "2026-09-01T10:00:00Z" }];
  const merged = C.mergeThread(sms, email);
  assert.deepEqual(merged.map((m) => m.id), ["ghl:1", "gmail:a", "ghl:2"]);
});

test("latestEmail + replySubject pick what a reply threads onto", () => {
  const thread = C.mergeThread([
    { id: "gmail:1", channel: "email", at: "2026-09-01T10:00:00Z", thread_id: "t1", message_id: "<1@m>", subject: "Deal on Main St" },
    { id: "ghl:9", channel: "sms", at: "2026-09-03T10:00:00Z" },
    { id: "gmail:2", channel: "email", at: "2026-09-02T10:00:00Z", thread_id: "t1", message_id: "<2@m>", subject: "Re: Deal on Main St" },
  ]);
  const last = C.latestEmail(thread);
  assert.equal(last.message_id, "<2@m>");
  assert.equal(C.replySubject(last.subject), "Re: Deal on Main St");
  assert.equal(C.replySubject("Deal on Main St"), "Re: Deal on Main St");
  assert.equal(C.replySubject(""), "");
  assert.equal(C.latestEmail([{ id: "ghl:1", channel: "sms" }]), null);
});

// ── Outbound MIME ────────────────────────────────────────────────
test("buildMime threads onto the prior message and carries both text and html", () => {
  const raw = C.buildMime({
    fromName: "Zach", fromAddress: "zach@seasidehorizon.com", to: "buyer@x.com", replyTo: "zach@seasidehorizon.com",
    subject: "Re: Deal — Main St", text: "Hi there,\n\nStill available: https://deals.seasidehorizon.com/deck/x\n<3",
    inReplyTo: "<2@m>", references: "<1@m>",
  });
  assert.match(raw, /^From: Zach <zach@seasidehorizon.com>\r\n/);
  assert.match(raw, /\r\nTo: buyer@x\.com\r\n/);
  assert.match(raw, /\r\nIn-Reply-To: <2@m>\r\n/);
  assert.match(raw, /\r\nReferences: <1@m> <2@m>\r\n/);
  assert.match(raw, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/, "non-ASCII subject is RFC 2047 encoded");
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="[^"]+"/);
  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
  assert.match(raw, /Content-Type: text\/html; charset="UTF-8"/);
  assert.ok(raw.includes("Still available: https://deals.seasidehorizon.com/deck/x"), "plain part keeps the text");
  assert.ok(raw.includes('<a href="https://deals.seasidehorizon.com/deck/x">'), "html part links the URL");
  const htmlPart = raw.slice(raw.indexOf('Content-Type: text/html'));
  assert.ok(htmlPart.includes("&lt;3"), "html part escapes user text");
  assert.ok(!htmlPart.includes("<3"), "raw angle bracket never reaches the html part");
});

test("buildMime without a prior message has no threading headers and a plain ASCII subject", () => {
  const raw = C.buildMime({ fromName: "", fromAddress: "z@y.com", to: "b@x.com", subject: "Hello", text: "hi" });
  assert.match(raw, /^From: z@y\.com\r\n/);
  assert.match(raw, /\r\nSubject: Hello\r\n/);
  assert.ok(!/In-Reply-To|References/.test(raw));
  assert.ok(!/Reply-To/.test(raw));
});

test("textToHtml escapes, paragraphs on blank lines, <br> within", () => {
  const html = C.textToHtml("a <b>\nb\n\nc");
  assert.equal((html.match(/<p /g) || []).length, 2);
  assert.ok(html.includes("a &lt;b&gt;<br>b"));
});

// ── The function's contract with the rest of the app ─────────────
const FN = fs.readFileSync(path.join(__dirname, "..", "netlify", "functions", "buyer-messages.js"), "utf8");

test("outbound sends log a MANUAL touch — never an email/sms buyer_activity row", () => {
  // buildEngagement (buyers.js) scores channel "email"/"sms" rows as REPLIES
  // (+12 each). Our own outreach logged under those channels would make every
  // buyer we text look engaged. The panel's touches must stay "manual".
  const logs = [...FN.matchAll(/buyer_activity[\s\S]{0,400}?channel:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(logs.length >= 1, "expected at least one buyer_activity insert");
  assert.deepEqual([...new Set(logs)], ["manual"]);
});

test("the send path checks the STOP list and refuses hard-bounced addresses", () => {
  assert.ok(FN.includes("sms_suppressions"), "SMS send must consult sms_suppressions");
  assert.ok(/email_bounced_at\)\s*throw/.test(FN), "email send must refuse when email_bounced_at is set");
  assert.ok(!FN.includes("/contacts?"), "contacts are not buyers — nothing here may read them");
});

test("the page's timeline treats 📤 touches as sends, not notes", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "js", "buyers.js"), "utf8");
  assert.ok(page.includes('"📤"'), "buyers.js should render 📤 touches with their own icon");
  assert.ok(FN.includes("📤 Texted:") && FN.includes("📤 Emailed:"), "function and page must agree on the 📤 prefix");
});
