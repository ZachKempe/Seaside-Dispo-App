// POST { slug, token?, name?, contact? } — records buyer interest from the deck
// page. Tokenized => attributed to the buyer; otherwise an external lead.
const { verifyDeckToken } = require("./lib/deck-token");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const ADVANCEABLE = new Set(["new", "responded"]); // don't downgrade offer/UC/closed

async function notify(address, who) {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM, to: [NOTIFY_EMAIL],
        subject: `🔥 Interested: ${who} — ${address}`,
        html: `<p><b>${who}</b> tapped Interested on <b>${address}</b> via the deck page. Call them now.</p>`,
      }),
    });
  } catch (e) { console.warn("notify failed:", e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { slug, token, name, contact } = JSON.parse(event.body || "{}");
    const cleanSlug = String(slug || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!cleanSlug) return { statusCode: 400, body: "slug required" };

    // NOTE: properties has no address_override column (it lives on morby_deals);
    // select only real columns so PostgREST doesn't 400. address falls back to name.
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=card_id,name&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, body: "deal not found" };
    const cardId = prop.card_id;
    const address = prop.address_override || prop.name || cardId;

    const buyerId = verifyDeckToken(token);

    if (buyerId) {
      const b = await sb(`/buyers?id=eq.${buyerId}&select=id,name,email,phone&limit=1`);
      const buyer = b && b[0];
      if (!buyer) return { statusCode: 404, body: "buyer not found" };

      // Upsert deal_leads (dedupe on card_id+buyer_id).
      const existing = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&buyer_id=eq.${buyerId}&select=id,stage&limit=1`);
      if (existing && existing[0]) {
        if (ADVANCEABLE.has(existing[0].stage)) {
          await sb(`/deal_leads?id=eq.${existing[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ stage: "interested", notes: "Tapped Interested on deck page" }) });
        }
      } else {
        await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ card_id: cardId, address, buyer_id: buyerId, name: buyer.name || "Buyer",
            contact: buyer.email || buyer.phone || "", source: "deck_page", channel: "deck",
            stage: "interested", notes: "Tapped Interested on deck page" }) });
      }
      // Activity touch (works with existing buyer_activity table).
      await sb(`/buyer_activity`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_id: buyerId, card_id: cardId, address, channel: "deck", detail: "Interested via deck page" }) });

      await notify(address, buyer.name || `Buyer #${buyerId}`);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: true }) };
    }

    // Anonymous / forwarded link: external lead, deduped on card_id+contact.
    const nm = String(name || "").trim().slice(0, 120);
    const ct = String(contact || "").trim().slice(0, 200);
    if (!nm || !ct) return { statusCode: 400, body: "name and contact required for untokenized interest" };

    const dupe = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&contact=eq.${encodeURIComponent(ct)}&select=id&limit=1`);
    if (!(dupe && dupe[0])) {
      await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ card_id: cardId, address, buyer_id: null, name: nm, contact: ct,
          source: "deck_page", channel: "deck", stage: "interested", notes: "Interested via deck page (untokenized)" }) });
    }
    await notify(address, `${nm} (${ct})`);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: false }) };
  } catch (err) {
    console.error("deck-interest error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
