// C1 (SMS side) — Webhook receiver for inbound texts from GoHighLevel.
// GHL has no reliable polling API for inbound conversations, so it pushes them
// here. To activate: in GHL, add a workflow trigger "Customer Replied / Inbound
// Message" with a Webhook action POSTing to:
//     https://seaside-dispo-app.netlify.app/.netlify/functions/ghl-inbound?token=YOUR_SECRET
// where YOUR_SECRET matches the CAPTURE_WEBHOOK_SECRET env var. Until that's set
// up no SMS is captured, but email replies still flow via capture-replies.js.
//
// Inbound SMS has no deal subject line, so we capture the buyer + activity touch
// (future-blastable) but don't attach a pipeline lead to a specific deal.

const { markSeen, captureResponder } = require("./lib/capture");

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

    const res = await captureResponder({ channel: "sms", name, phone, snippet: text });
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(res) };
  } catch (err) {
    console.error("ghl-inbound error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
