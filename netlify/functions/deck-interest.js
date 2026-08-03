// POST { slug, token?, name?, contact? } — records buyer interest from the deck
// page. Tokenized => attributed to the buyer; otherwise an external lead.
//
// Two emails go out on every hand-raise: the 🔥 alert to NOTIFY_EMAIL (you),
// and an instant receipt to the investor (H4) carrying the deck link, the PDF
// and a booking link. Neither can fail the interest capture — both swallow.
const { verifyDeckToken, deckToken } = require("./lib/deck-token");
const { emailish, firstNameOf, receiptSubject, buildReceiptHtml } = require("./lib/interest-receipt");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";
const SITE_URL = (process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app").replace(/\/+$/, "");
// Passed through raw — lib/interest-receipt.js resolves blank/malformed values
// to a working default, so the booking button survives a missing env var.
const CALENDLY_URL = process.env.CALENDLY_URL || "";

const CONTACT_NAME = process.env.MARKETING_CONTACT_NAME || "Seaside Horizon";
const CONTACT_PHONE = process.env.MARKETING_CONTACT_PHONE || "";

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const ADVANCEABLE = new Set(["new", "responded"]);              // plain interest never downgrades offer/UC/closed
const OFFER_ADVANCEABLE = new Set(["new", "responded", "interested"]); // a real offer beats mere interest

async function notify(address, who, offer) {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) return;
  try {
    const what = offer ? `Offer ~$${offer.toLocaleString()}` : "Interested";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM, to: [NOTIFY_EMAIL],
        subject: `🔥 ${what}: ${who} — ${address}`,
        html: `<p><b>${esc(who)}</b> ${offer ? `made an offer of <b>~$${offer.toLocaleString()}</b> on` : "tapped Interested on"} <b>${esc(address)}</b> via the deck page. Call them now.</p>`,
      }),
    });
  } catch (e) { console.warn("notify failed:", e.message); }
}

// ── H4: instant receipt to the investor ──────────────────────────────
// Content lives in lib/interest-receipt.js (pure, pinned by tests); this half
// is the network work — probing for the PDF and handing Resend the payload.

// The deck PDF only exists once a blast has uploaded one (blast-core's
// uploadDealDeckPdf). deck.js 302s to Storage without checking, so probe first
// — a dead download button in a buyer's inbox is worse than no button. Returns
// the branded /deck/<slug>.pdf URL so the download still logs a deck_views row.
async function deckPdfUrl(slug, buyerId) {
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/public/property-photos/deal-decks/${slug}.pdf`, { method: "HEAD" });
    if (!r.ok) return "";
  } catch (_) { return ""; }
  return `${SITE_URL}/deck/${slug}.pdf${buyerId ? `?b=${deckToken(buyerId)}` : ""}`;
}

// Returns true only if a receipt actually went out (drives the confirmation
// copy on the deck page). Never throws — the lead is already recorded by now.
async function sendInterestReceipt({ to, slug, buyerId, name, address, offer }) {
  if (!RESEND_API_KEY || !RESEND_FROM || !emailish(to)) return false;
  try {
    const tok = buyerId ? `?b=${deckToken(buyerId)}&s=email` : "";
    const body = {
      from: RESEND_FROM,
      to: [String(to).trim()],
      subject: receiptSubject({ address, offer }),
      html: buildReceiptHtml({
        firstName: firstNameOf(name),
        address,
        deckUrl: `${SITE_URL}/deck/${slug}${tok}`,
        pdfUrl: await deckPdfUrl(slug, buyerId),
        offer,
        calendlyUrl: CALENDLY_URL,
        contactName: CONTACT_NAME,
        contactPhone: CONTACT_PHONE,
      }),
    };
    // Replies land in your inbox, not on the no-reply sending domain.
    if (NOTIFY_EMAIL) body.reply_to = NOTIFY_EMAIL;
    // buyer_id ONLY — deliberately no card_id. A spam complaint or hard bounce
    // on the receipt still suppresses the buyer via resend-events, but the
    // event stays out of every per-deal open/click rollup (those key on
    // card_id): a receipt open is not blast performance and must not inflate it.
    if (buyerId) body.tags = [{ name: "buyer_id", value: String(buyerId) }];

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
    return true;
  } catch (e) {
    console.warn("interest receipt failed:", e.message);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { slug, token, name, contact, offer_amount } = JSON.parse(event.body || "{}");
    const cleanSlug = String(slug || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!cleanSlug) return { statusCode: 400, body: "slug required" };

    // Optional soft offer. Sanity-banded so junk input degrades to plain interest.
    const offer = Math.round(Number(offer_amount) || 0);
    const hasOffer = offer >= 1000 && offer <= 100000000;
    const stage = hasOffer ? "offer" : "interested";
    const noteFor = (suffix) => hasOffer
      ? `Offered ~$${offer.toLocaleString()} via deck page${suffix}`
      : `Tapped Interested on deck page${suffix}`;
    const canAdvance = hasOffer ? OFFER_ADVANCEABLE : ADVANCEABLE;

    // NOTE: properties has no address_override column (it lives on morby_deals);
    // select only real columns so PostgREST doesn't 400. address falls back to name.
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=card_id,name&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, body: "deal not found" };
    const cardId = prop.card_id;
    const address = prop.address_override || prop.name || cardId;

    const buyerId = verifyDeckToken(token);

    if (buyerId) {
      // email_bounced_at (031) gates the receipt. Falls back to the pre-031
      // column set so interest capture still works before that migration runs.
      let b;
      try {
        b = await sb(`/buyers?id=eq.${buyerId}&select=id,name,email,phone,email_bounced_at&limit=1`);
      } catch (_) {
        b = await sb(`/buyers?id=eq.${buyerId}&select=id,name,email,phone&limit=1`);
      }
      const buyer = b && b[0];
      if (!buyer) return { statusCode: 404, body: "buyer not found" };

      // Upsert deal_leads (dedupe on card_id+buyer_id).
      const existing = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&buyer_id=eq.${buyerId}&select=id,stage&limit=1`);
      if (existing && existing[0]) {
        if (canAdvance.has(existing[0].stage)) {
          await sb(`/deal_leads?id=eq.${existing[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ stage, notes: noteFor("") }) });
        }
      } else {
        await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ card_id: cardId, address, buyer_id: buyerId, name: buyer.name || "Buyer",
            contact: buyer.email || buyer.phone || "", source: "deck_page", channel: "deck",
            stage, notes: noteFor("") }) });
      }
      // Activity touch (works with existing buyer_activity table).
      await sb(`/buyer_activity`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_id: buyerId, card_id: cardId, address, channel: "deck",
          detail: hasOffer ? `Offered ~$${offer.toLocaleString()} via deck page` : "Interested via deck page" }) });

      // Receipt to the investor + alert to you, in parallel — neither throws.
      // A hard-bounced address is skipped: re-sending to it only burns domain
      // reputation, and they will never see it anyway.
      const [receipt] = await Promise.all([
        buyer.email_bounced_at
          ? Promise.resolve(false)
          : sendInterestReceipt({ to: buyer.email, slug: cleanSlug, buyerId, name: buyer.name,
              address, offer: hasOffer ? offer : 0 }),
        notify(address, buyer.name || `Buyer #${buyerId}`, hasOffer ? offer : 0),
      ]);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: true, receipt }) };
    }

    // Anonymous / forwarded link: external lead, deduped on card_id+contact.
    const nm = String(name || "").trim().slice(0, 120);
    const ct = String(contact || "").trim().slice(0, 200);
    if (!nm || !ct) return { statusCode: 400, body: "name and contact required for untokenized interest" };

    const dupe = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&contact=eq.${encodeURIComponent(ct)}&select=id,stage&limit=1`);
    if (dupe && dupe[0]) {
      if (canAdvance.has(dupe[0].stage)) {
        await sb(`/deal_leads?id=eq.${dupe[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ stage, notes: noteFor(" (untokenized)") }) });
      }
    } else {
      await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ card_id: cardId, address, buyer_id: null, name: nm, contact: ct,
          source: "deck_page", channel: "deck", stage, notes: noteFor(" (untokenized)") }) });
    }
    // No buyer record to attribute to, so the deck link goes out untokenized.
    // `ct` is often a phone number — sendInterestReceipt no-ops on those.
    const [receipt] = await Promise.all([
      sendInterestReceipt({ to: ct, slug: cleanSlug, buyerId: null, name: nm,
        address, offer: hasOffer ? offer : 0 }),
      notify(address, `${nm} (${ct})`, hasOffer ? offer : 0),
    ]);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: false, receipt }) };
  } catch (err) {
    console.error("deck-interest error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
