// Webhook receiver for Resend email events (opened / clicked / delivered /
// bounced / complained). send-blast.js tags every email with buyer_id +
// card_id, so each event lands in email_events attributed to a (buyer, deal)
// pair — feeding the buyer engagement score and activity timeline.
//
// Setup: Resend dashboard → Webhooks → add
//   https://<site>/.netlify/functions/resend-events
// with the five email.* events above, then put the signing secret (whsec_…)
// in the RESEND_WEBHOOK_SECRET env var. Unsigned/misconfigured requests are
// rejected — we never ingest events we can't verify.

const crypto = require("crypto");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Resend signs webhooks with Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>"
// keyed with the base64 part of the whsec_ secret; signature header carries
// space-separated "v1,<base64sig>" candidates.
function verifySignature(headers, rawBody) {
  const id = headers["svix-id"];
  const ts = headers["svix-timestamp"];
  const sigHeader = headers["svix-signature"];
  if (!id || !ts || !sigHeader || !WEBHOOK_SECRET) return false;

  // Reject stale timestamps (replay window: 5 minutes).
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  return sigHeader.split(/\s+/).some(part => {
    const sig = part.split(",")[1] || "";
    try {
      return sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  });
}

// Tags arrive either as [{name,value}] or {name: value} depending on payload
// version — normalize to a plain object.
function tagMap(tags) {
  if (!tags) return {};
  if (Array.isArray(tags)) return Object.fromEntries(tags.map(t => [t.name, t.value]));
  return tags;
}

const EVENT_MAP = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  if (!verifySignature(headers, rawBody)) return { statusCode: 401, body: "invalid signature" };

  try {
    const payload = JSON.parse(rawBody);
    const kind = EVENT_MAP[payload.type];
    if (!kind) return { statusCode: 200, body: "ignored" }; // e.g. email.sent

    const data = payload.data || {};
    const tags = tagMap(data.tags);
    const buyerId = Number(tags.buyer_id) || null;
    const cardId = tags.card_id || "";
    const email = Array.isArray(data.to) ? data.to[0] || "" : String(data.to || "");

    await sb(`/email_events`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        event: kind,
        buyer_id: buyerId,
        card_id: cardId,
        email,
        link_url: (data.click && data.click.link) || "",
        resend_id: data.email_id || "",
      }),
    });

    // Spam complaint = clear opt-out signal; stop emailing them immediately.
    if (kind === "complained" && buyerId) {
      await sb(`/buyers?id=eq.${buyerId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ email_opt_out: true }),
      });
    }

    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("resend-events error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
