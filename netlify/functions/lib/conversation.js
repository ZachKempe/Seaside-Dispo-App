// Pure helpers for the per-buyer conversation view (buyer-messages.js): turn a
// GoHighLevel conversation and a Gmail thread into one normalized, merged
// message list, and build the MIME for a threaded reply. No env, no fetch, no
// Supabase — everything here is exercised by tests/conversation.test.js.
//
// Normalized message shape (what the buyers page renders):
//   { id, channel: "sms"|"email", direction: "in"|"out", body, subject,
//     at (ISO), status, from, thread_id, message_id }
"use strict";

// ── GoHighLevel ──────────────────────────────────────────────────
// GET /conversations/{id}/messages returns rows like
//   { id, direction: "inbound"|"outbound", status, body, dateAdded,
//     messageType: "TYPE_SMS", type: 1, contactId, conversationId }
// A conversation can also hold emails, calls and activities; only SMS rows
// belong in the text thread. Older rows sometimes carry only the numeric
// `type` (1 = SMS), so both spellings count.
function isGhlSms(m) {
  if (!m) return false;
  const mt = String(m.messageType || "").toUpperCase();
  if (mt) return mt.includes("SMS");
  return m.type === 1 || m.type === undefined;
}

function normalizeGhlMessage(m) {
  if (!isGhlSms(m)) return null;
  const body = String(m.body || "").trim();
  if (!body) return null;
  return {
    id: `ghl:${m.id || `${m.dateAdded}-${body.slice(0, 20)}`}`,
    channel: "sms",
    direction: String(m.direction || "").toLowerCase() === "inbound" ? "in" : "out",
    body,
    subject: "",
    at: toIso(m.dateAdded),
    status: String(m.status || "").toLowerCase(),
    from: "",
    thread_id: m.conversationId || "",
    message_id: m.id || "",
  };
}

// ── Gmail ────────────────────────────────────────────────────────
function header(msg, name) {
  const h = (msg && msg.payload && msg.payload.headers) || [];
  const hit = h.find((x) => String(x.name || "").toLowerCase() === name.toLowerCase());
  return hit ? String(hit.value || "") : "";
}

function decodeBase64Url(s) {
  if (!s) return "";
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(b64, "base64").toString("utf-8"); } catch (_) { return ""; }
}

// Walk the MIME tree for the first text/plain part; fall back to text/html
// with the tags stripped. Attachments and nested alternatives are handled by
// the recursion — Gmail nests multipart/alternative inside multipart/mixed
// whenever there's an attachment.
function extractBody(payload) {
  if (!payload) return "";
  const parts = [];
  (function walk(p) {
    if (!p) return;
    if (p.parts && p.parts.length) p.parts.forEach(walk);
    else parts.push(p);
  })(payload);
  const plain = parts.find((p) => /^text\/plain/i.test(p.mimeType || "") && p.body && p.body.data);
  if (plain) return decodeBase64Url(plain.body.data);
  const html = parts.find((p) => /^text\/html/i.test(p.mimeType || "") && p.body && p.body.data);
  if (html) return htmlToText(decodeBase64Url(html.body.data));
  return "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Drop the quoted history a mail client appends below a reply, so the thread
// shows each message once. Cuts at the first quote marker; a message that is
// nothing but a quote keeps its first line rather than going blank.
const QUOTE_MARKERS = [
  /^On .{5,200}wrote:\s*$/m,          // Gmail / Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/mi,
  /^From:\s.+\n(Sent|Date):\s/m,      // Outlook header block
  /^_{10,}\s*$/m,                     // Outlook divider
  /^>/m,                              // quoted lines
  /^Sent from my /m,
];
function stripQuotedReply(text) {
  let t = String(text || "").replace(/\r/g, "");
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  const head = t.slice(0, cut).trim();
  if (head) return head;
  const firstLine = t.split("\n").map((l) => l.replace(/^>+\s?/, "").trim()).find(Boolean) || "";
  return firstLine;
}

function addressOf(headerValue) {
  const m = String(headerValue || "").match(/<([^<>]+)>/);
  const addr = (m ? m[1] : String(headerValue || "")).trim().toLowerCase();
  return addr.includes("@") ? addr : "";
}

// `ours` is the set of addresses we send from (Gmail from, Resend from,
// reply-to). The SENT label is the primary signal — a Resend send never gets
// that label, so the From header is the fallback that still classifies it.
function normalizeGmailMessage(msg, ours) {
  if (!msg) return null;
  const ourSet = new Set([...(ours || [])].map((a) => addressOf(a) || String(a || "").toLowerCase()).filter(Boolean));
  const fromAddr = addressOf(header(msg, "From"));
  const labels = msg.labelIds || [];
  const direction = labels.includes("SENT") || ourSet.has(fromAddr) ? "out" : "in";
  const raw = extractBody(msg.payload);
  const body = stripQuotedReply(raw) || String(msg.snippet || "").trim();
  const at = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : toIso(header(msg, "Date"));
  return {
    id: `gmail:${msg.id}`,
    channel: "email",
    direction,
    body,
    subject: header(msg, "Subject"),
    at,
    status: "",
    from: header(msg, "From"),
    thread_id: msg.threadId || "",
    message_id: header(msg, "Message-ID") || header(msg, "Message-Id"),
  };
}

// ── Merge ────────────────────────────────────────────────────────
// One chronological list across channels, oldest first, de-duplicated by id.
function mergeThread(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const m of list || []) {
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  out.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return out;
}

// The newest email in the thread decides what a reply threads onto: its Gmail
// threadId, its Message-ID (In-Reply-To) and the subject to "Re:".
function latestEmail(messages) {
  const emails = (messages || []).filter((m) => m.channel === "email" && m.thread_id);
  return emails.length ? emails[emails.length - 1] : null;
}

function replySubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// ── Outbound MIME ────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Plain typed text → simple HTML: escaped, paragraphs on blank lines, <br>
// within. Bare URLs become links so a deck link is tappable on a phone.
function textToHtml(text) {
  const paras = String(text || "").replace(/\r/g, "").trim().split(/\n{2,}/);
  return paras.map((p) => {
    const html = escapeHtml(p)
      .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}">${u}</a>`)
      .replace(/\n/g, "<br>");
    return `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${html}</p>`;
  }).join("");
}

function encodeSubject(subject) {
  const s = String(subject || "");
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

// RFC 2822 message: multipart/alternative (text + html), threaded onto an
// existing conversation when inReplyTo/references are given. Returns the raw
// string; the caller base64url-encodes it for Gmail.
function buildMime({ fromName, fromAddress, to, replyTo, subject, text, inReplyTo, references }) {
  const boundary = `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const headers = [
    `From: ${fromName ? `${fromName} <${fromAddress}>` : fromAddress}`,
    `To: ${to}`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`Subject: ${encodeSubject(subject)}`);
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${[references, inReplyTo].filter(Boolean).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const plain = String(text || "").replace(/\r?\n/g, "\r\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2D3748">${textToHtml(text)}</div>`;
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    plain,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function base64Url(s) {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toIso(d) {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t.getTime()) ? "" : t.toISOString();
}

module.exports = {
  isGhlSms, normalizeGhlMessage,
  normalizeGmailMessage, extractBody, stripQuotedReply, htmlToText, addressOf,
  mergeThread, latestEmail, replySubject,
  textToHtml, buildMime, base64Url,
};
