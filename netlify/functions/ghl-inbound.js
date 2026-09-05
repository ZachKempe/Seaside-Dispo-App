// C1 (SMS side) — Webhook receiver for inbound texts from GoHighLevel.
// GHL has no reliable polling API for inbound conversations, so it pushes them
// here. To activate: in GHL, add a workflow trigger "Customer Replied / Inbound
// Message" with a Webhook action POSTing to:
//     https://deals.seasidehorizon.com/.netlify/functions/ghl-inbound?token=YOUR_SECRET
// where YOUR_SECRET matches the CAPTURE_WEBHOOK_SECRET env var. Until that's set
// up no SMS is captured, but email replies still flow via capture-replies.js.
//
// Inbound SMS has no deal subject line, so we attribute it by recency: the
// deal we most recently texted this phone number about (7-day window, via
// blast_recipients). Falls back to a deal-less capture when there's no match.

const { sb, markSeen, captureResponder, findBuyer, digitsOnly } = require("./lib/capture");
const { OPT_OUT_RE, recordSmsSuppression } = require("./lib/sms-optout");

// Honor an SMS opt-out: record the number in sms_suppressions (durable even
// when no buyer row matches — an unknown number that texts STOP must never be
// texted again), then flip the matching buyer's sms_opt_in off and log the
// touch. blast-core's audience filter checks both. GHL applies its own DND
// too, but our filter must not depend on it.
async function handleOptOut(phone, text) {
  let suppressed = false;
  try { suppressed = await recordSmsSuppression(sb, phone); }
  catch (e) { console.warn("sms_suppressions insert failed (migration 032 not run?):", e.message); }

  const buyer = await findBuyer("", phone);
  if (!buyer) return { ok: true, optedOut: suppressed, suppressed, note: "no matching buyer — suppressed by phone" };
  await sb(`/buyers?id=eq.${buyer.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ sms_opt_in: false }),
  });
  await sb(`/buyer_activity`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      buyer_id: buyer.id, card_id: "", address: "",
      channel: "sms", detail: `SMS opt-out ("${text.trim().slice(0, 40)}") — sms_opt_in turned off`,
    }),
  });
  return { ok: true, optedOut: true, suppressed, buyerId: buyer.id };
}

// Most recent SMS blast sent to this phone in the last 7 days -> its deal.
// Phones are stored in varied formats, so match on digits in code.
async function dealRecentlyTexted(phone) {
  const pd = digitsOnly(phone);
  if (!pd) return null;
  try {
    const since = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
    const rows = await sb(
      `/blast_recipients?channel=eq.sms&status=eq.sent&blasted_at=gte.${encodeURIComponent(since)}` +
      `&select=card_id,address,recipient,blasted_at&order=blasted_at.desc&limit=300`,
      { method: "GET" }
    );
    return (rows || []).find(r => digitsOnly(r.recipient) === pd) || null;
  } catch (e) {
    console.warn("dealRecentlyTexted lookup failed:", e.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const secret = process.env.CAPTURE_WEBHOOK_SECRET;
  const provided = (event.queryStringParameters || {}).token;
  if (!secret || provided !== secret) return { statusCode: 401, body: "unauthorized" };

  try {
    const b = JSON.parse(event.body || "{}");
    const contact = b.contact || {};
    const phone = b.phone || b.from || contact.phone || "";
    const name =
      b.full_name || b.name || contact.name ||
      `${contact.firstName || ""} ${contact.lastName || ""}`.trim();
    const text = b.message || b.body || b.sms || b.text || "";

    if (!phone) return { statusCode: 200, body: "no phone — ignored" };

    const messageId = b.messageId || b.message_id || b.id || `ghl-${phone}-${text}`.slice(0, 180);
    const fresh = await markSeen(messageId, "sms");
    if (!fresh) return { statusCode: 200, body: "duplicate — ignored" };

    // STOP etc. is a compliance action, not a lead — never capture it as one.
    if (OPT_OUT_RE.test(text)) {
      const res = await handleOptOut(phone, text);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(res) };
    }

    const recent = await dealRecentlyTexted(phone);
    const res = await captureResponder({
      channel: "sms", name, phone, snippet: text,
      cardId: recent ? recent.card_id : null,
      address: recent ? recent.address : "",
    });
    // Save the text itself for the buyer's conversation panel (migration 037),
    // so the thread is complete even when GHL's read API is unavailable. Best
    // effort: the lead is already captured, and before 037 this just warns.
    if (res.ok && res.buyerId && text.trim()) {
      try {
        await sb(`/buyer_messages?on_conflict=provider,provider_id`, {
          method: "POST",
          headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify({
            buyer_id: res.buyerId, channel: "sms", direction: "in",
            provider: "webhook", provider_id: String(messageId).slice(0, 200),
            body: text.trim().slice(0, 8000), status: "received", from_addr: String(phone).slice(0, 40),
            sent_at: new Date().toISOString(),
          }),
        });
      } catch (e) {
        console.warn("buyer_messages insert failed (migration 037 not run?):", e.message);
      }
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(res) };
  } catch (err) {
    console.error("ghl-inbound error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
