// Per-buyer messaging for the Buyer Dashboard: the 💬 Text / ✉️ Email buttons
// on a buyer's card open a conversation panel backed by this function.
//
//   GET  ?buyer_id=N            → the buyer's whole thread, both channels merged
//   POST { buyer_id, channel, body, subject? }  → send one text or one email
//
// History is read LIVE from the providers, not from a ledger of our own:
//   • SMS   — GoHighLevel's conversation for the buyer's number (so texts sent
//             from the GHL app show up too, and inbound texts appear whether or
//             not the ghl-inbound webhook is wired).
//   • Email — Gmail, every message to/from the buyer's address, sent from and
//             received by the same mailbox capture-replies.js polls.
// Sends go through the same libs the blasts use (lib/ghl-sms.js, Gmail with a
// Resend fallback), and each one logs a `buyer_activity` touch — channel
// "manual", so the engagement score doesn't count our own outreach as a reply
// — which is what keeps "Last contacted" and the timeline honest.
//
// Compliance is the send path's job, not the UI's: a number on the STOP list
// (sms_suppressions) is refused outright, and so is a hard-bounced address.
// A buyer WITHOUT sms_opt_in can still be texted here — this is a human
// replying one-to-one, not a campaign — but the panel says so, and blasts
// still skip them. Auth is the caller's Supabase session (verifyUser).

const { sb, digitsOnly } = require("./lib/capture");
const { verifyUser } = require("./lib/blast-core");
const { sendSms, fetchSmsThread, smsConfigured } = require("./lib/ghl-sms");
const gmail = require("./lib/gmail");
const {
  normalizeGhlMessage, normalizeGmailMessage, mergeThread, latestEmail,
  replySubject, buildMime, base64Url, textToHtml,
} = require("./lib/conversation");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";

const SMS_MAX = 1000;     // ~7 segments; anything longer is an email
const EMAIL_MAX = 20000;

const json = (statusCode, body) => ({
  statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

// Addresses that mean "us" when classifying an email's direction.
function ourAddresses() {
  const { fromAddress, replyTo } = gmail.gmailEnv();
  return [fromAddress, replyTo, RESEND_FROM, NOTIFY_EMAIL].filter(Boolean);
}

async function loadBuyer(id) {
  const rows = await sb(
    `/buyers?id=eq.${Number(id)}&select=id,name,email,phone,sms_opt_in,email_opt_out,email_bounced_at,active&limit=1`,
    { method: "GET" });
  return rows && rows[0] ? rows[0] : null;
}

// Fails soft before migration 032 (no table → not suppressed).
async function isSuppressed(phone) {
  const pd = digitsOnly(phone);
  if (!pd) return false;
  try {
    const rows = await sb(`/sms_suppressions?phone_digits=eq.${encodeURIComponent(pd)}&select=phone_digits&limit=1`, { method: "GET" });
    return !!(rows && rows.length);
  } catch (e) {
    console.warn("sms_suppressions lookup failed (032 not run?):", e.message);
    return false;
  }
}

async function logTouch(buyerId, detail) {
  try {
    await sb(`/buyer_activity`, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ buyer_id: buyerId, card_id: "", address: "", channel: "manual", detail: detail.slice(0, 500) }),
    });
  } catch (e) {
    console.warn("buyer_activity log failed:", e.message);
  }
}

// ── GET: the thread ───────────────────────────────────────────────
async function getThread(buyer) {
  const sms = { configured: smsConfigured(), ok: false, error: "", contact_id: null };
  const email = { configured: gmail.gmailConfigured(), ok: false, error: "", thread_id: null, in_reply_to: null, references: null, subject: "" };

  const [smsMsgs, emailMsgs] = await Promise.all([
    (async () => {
      if (!sms.configured) { sms.error = "SMS isn't configured (GHL_API_KEY / GHL_FROM_NUMBER)."; return []; }
      if (!buyer.phone) { sms.ok = true; return []; }
      try {
        const t = await fetchSmsThread(buyer.phone);
        sms.ok = true;
        sms.contact_id = t.contactId;
        return t.messages.map(normalizeGhlMessage).filter(Boolean);
      } catch (e) {
        sms.error = /-> 40[13]/.test(e.message)
          ? "GoHighLevel refused to read conversations — the API token needs the Conversations read scopes (GHL → Settings → Private Integrations)."
          : `Couldn't load texts from GoHighLevel: ${e.message.slice(0, 200)}`;
        console.warn("sms thread:", e.message);
        return [];
      }
    })(),
    (async () => {
      if (!email.configured) { email.error = "Email history needs the Gmail connection (GMAIL_* env vars)."; return []; }
      if (!buyer.email) { email.ok = true; return []; }
      try {
        const token = await gmail.gmailAccessToken();
        const raw = await gmail.fetchMessagesWith(token, buyer.email.trim().toLowerCase());
        email.ok = true;
        const ours = ourAddresses();
        return raw.map((m) => normalizeGmailMessage(m, ours)).filter(Boolean);
      } catch (e) {
        email.error = `Couldn't load email history from Gmail: ${e.message.slice(0, 200)}`;
        console.warn("email thread:", e.message);
        return [];
      }
    })(),
  ]);

  const messages = mergeThread(smsMsgs, emailMsgs);
  const last = latestEmail(messages);
  if (last) {
    email.thread_id = last.thread_id;
    email.in_reply_to = last.message_id || null;
    email.subject = replySubject(last.subject);
  }
  return { buyer: publicBuyer(buyer, await isSuppressed(buyer.phone)), sms, email, messages };
}

function publicBuyer(b, smsSuppressed) {
  return {
    id: b.id, name: b.name, email: b.email || "", phone: b.phone || "",
    sms_opt_in: !!b.sms_opt_in, sms_suppressed: !!smsSuppressed,
    email_opt_out: !!b.email_opt_out, email_bounced: !!b.email_bounced_at,
  };
}

// ── POST: send one message ────────────────────────────────────────
async function sendText(buyer, body) {
  if (!buyer.phone) throw http(400, "This buyer has no phone number on file.");
  if (!smsConfigured()) throw http(503, "SMS isn't configured (GHL_API_KEY / GHL_FROM_NUMBER).");
  if (await isSuppressed(buyer.phone)) {
    throw http(409, "This number replied STOP — it's on the suppression list and can't be texted from here.");
  }
  const res = await sendSms(buyer.phone, body);
  await logTouch(buyer.id, `📤 Texted: “${body.replace(/\s+/g, " ").slice(0, 140)}”`);
  return {
    id: `ghl:${(res && res.messageId) || `sent-${Date.now()}`}`,
    channel: "sms", direction: "out", body, subject: "", at: new Date().toISOString(),
    status: "sent", from: "", thread_id: (res && res.conversationId) || "", message_id: (res && res.messageId) || "",
    provider: "ghl",
  };
}

async function sendEmail(buyer, { body, subject, thread_id, in_reply_to, references }) {
  const to = String(buyer.email || "").trim().toLowerCase();
  if (!to) throw http(400, "This buyer has no email address on file.");
  if (buyer.email_bounced_at) throw http(409, "This address hard-bounced — it's dead, so the email would fail. Update their email first.");
  subject = String(subject || "").trim() || `Following up — ${(gmail.gmailEnv().fromName || "Seaside Horizon")}`;

  let provider = "", id = "", threadId = thread_id || "";
  if (gmail.gmailConfigured()) {
    const env = gmail.gmailEnv();
    const token = await gmail.gmailAccessToken();
    const raw = base64Url(buildMime({
      fromName: env.fromName, fromAddress: env.fromAddress, to, replyTo: env.replyTo,
      subject, text: body, inReplyTo: in_reply_to || "", references: references || "",
    }));
    const r = await gmail.sendRaw(token, raw, thread_id || undefined);
    provider = "gmail"; id = `gmail:${r.id}`; threadId = r.threadId || threadId;
  } else if (RESEND_API_KEY && RESEND_FROM) {
    // No Gmail → Resend. Replies still land in NOTIFY_EMAIL's inbox via
    // reply_to; the buyer_id tag means a complaint still suppresses them.
    const payload = {
      from: RESEND_FROM, to: [to], subject, text: body,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#2D3748">${textToHtml(body)}</div>`,
      tags: [{ name: "buyer_id", value: String(buyer.id) }],
    };
    if (NOTIFY_EMAIL) payload.reply_to = NOTIFY_EMAIL;
    if (in_reply_to) payload.headers = { "In-Reply-To": in_reply_to, References: [references, in_reply_to].filter(Boolean).join(" ") };
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
    const j = await r.json().catch(() => ({}));
    provider = "resend"; id = `resend:${j.id || Date.now()}`;
  } else {
    throw http(503, "No email sender is configured (GMAIL_* or RESEND_API_KEY + RESEND_FROM).");
  }

  await logTouch(buyer.id, `📤 Emailed: “${subject.slice(0, 120)}”`);
  return {
    id, channel: "email", direction: "out", body, subject, at: new Date().toISOString(),
    status: "sent", from: "", thread_id: threadId, message_id: "", provider,
  };
}

const http = (status, message) => Object.assign(new Error(message), { status });

exports.handler = async (event) => {
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return json(401, { error: "unauthorized" });

    if (event.httpMethod === "GET") {
      const id = Number((event.queryStringParameters || {}).buyer_id);
      if (!id) return json(400, { error: "buyer_id required" });
      const buyer = await loadBuyer(id);
      if (!buyer) return json(404, { error: "buyer not found" });
      return json(200, await getThread(buyer));
    }

    if (event.httpMethod === "POST") {
      const p = JSON.parse(event.body || "{}");
      const buyer = await loadBuyer(p.buyer_id);
      if (!buyer) return json(404, { error: "buyer not found" });
      const body = String(p.body || "").replace(/\r/g, "").trim();
      if (!body) return json(400, { error: "Nothing to send — the message is empty." });

      if (p.channel === "sms") {
        if (body.length > SMS_MAX) return json(400, { error: `That text is ${body.length} characters — keep texts under ${SMS_MAX}, or send it as an email.` });
        return json(200, { ok: true, message: await sendText(buyer, body) });
      }
      if (p.channel === "email") {
        if (body.length > EMAIL_MAX) return json(400, { error: "That email is too long." });
        return json(200, { ok: true, message: await sendEmail(buyer, p) });
      }
      return json(400, { error: "channel must be sms or email" });
    }

    return { statusCode: 405, body: "Method not allowed" };
  } catch (err) {
    console.error("buyer-messages error:", err.message);
    return json(err.status || 500, { error: err.message });
  }
};
