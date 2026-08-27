// POST { slug, token?, name?, contact? } — records buyer interest from the deck
// page. Tokenized => attributed to the buyer; otherwise an external lead.
//
// C1: an UNtokenized hand-raise (a forwarded link — someone who was never on
// the list) also becomes a buyers row. That is the growth channel; before this
// it wrote a buyer_id-less lead and the person was never heard from again.
// Buyer resolution is strictly best-effort — the lead and the investor's
// success screen never depend on it.
//
// Two emails go out on every hand-raise: the 🔥 alert to NOTIFY_EMAIL (you),
// and an instant receipt to the investor (H4) carrying the deck link, the PDF
// and a booking link. Neither can fail the interest capture — both swallow.
const { verifyDeckToken, deckToken } = require("./lib/deck-token");
const { emailish, firstNameOf, receiptSubject, buildReceiptHtml } = require("./lib/interest-receipt");
const { parseContact } = require("./lib/contact");
const { findOrCreateBuyer } = require("./lib/capture");
const { deckPdfExists } = require("./lib/deck-pdf");
const { fetchDealAddress } = require("./lib/deal-address");
const { buyBoxUrlFor, shouldAskBuyBox } = require("./lib/buy-box-form");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";
const SITE_URL = (process.env.PUBLIC_SITE_URL || "https://deals.seasidehorizon.com").replace(/\/+$/, "");
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

// `listNote` reports what C1 did to the buyer list (added / restored someone
// you had removed). A restore must never be silent.
async function notify(address, who, offer, listNote) {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) return;
  try {
    const what = offer ? `Offer ~$${offer.toLocaleString()}` : "Interested";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM, to: [NOTIFY_EMAIL],
        subject: `🔥 ${what}: ${who} — ${address}`,
        html: `<p><b>${esc(who)}</b> ${offer ? `made an offer of <b>~$${offer.toLocaleString()}</b> on` : "tapped Interested on"} <b>${esc(address)}</b> via the deck page. Call them now.</p>`
          + (listNote ? `<p style="color:#2F855A"><b>${esc(listNote)}</b></p>` : ""),
      }),
    });
  } catch (e) { console.warn("notify failed:", e.message); }
}

// ── H4: instant receipt to the investor ──────────────────────────────
// Content lives in lib/interest-receipt.js (pure, pinned by tests); this half
// is the network work — probing for the PDF and handing Resend the payload.

// The deck PDF only exists once a blast has uploaded one (blast-core's
// uploadDealDeckPdf) — a dead download button in a buyer's inbox is worse than
// no button. The probe now lives in lib/deck-pdf.js because H3 gave deck.js the
// same gate on its own PDF button; the email and the page must never disagree
// about whether a PDF exists. Returns the branded /deck/<slug>.pdf URL so the
// download still logs a deck_views row.
async function deckPdfUrl(slug, buyerId) {
  if (!(await deckPdfExists(slug))) return "";
  return `${SITE_URL}/deck/${slug}.pdf${buyerId ? `?b=${deckToken(buyerId)}` : ""}`;
}

// C2 — the buy-box link the receipt carries, or "" when we shouldn't ask.
//
// We ask only someone we can identify (no buyer id, no token, no link) and
// only someone whose box isn't already complete. The buy-box columns aren't on
// every code path that gets us here — the untokenized branch's buyer can come
// back from a phone-keyed lookup that selects a narrower column set — so this
// re-reads them rather than trusting whatever shape it was handed.
//
// Fails soft to ASKING. Getting it wrong in that direction shows a form to
// someone who already answered; getting it wrong the other way silently drops
// the one ask that fixes a wildcard, which is the whole point of the feature.
async function buyBoxAskUrl(buyerId) {
  if (!buyerId) return "";
  try {
    const rows = await sb(`/buyers?id=eq.${buyerId}&select=states,strategy,max_price,max_piti,min_beds&limit=1`);
    const b = rows && rows[0];
    if (b && !shouldAskBuyBox(b)) return "";
  } catch (e) {
    console.warn("buy-box completeness lookup failed (asking anyway):", e.message);
  }
  return buyBoxUrlFor(SITE_URL, buyerId);
}

// Returns true only if a receipt actually went out (drives the confirmation
// copy on the deck page). Never throws — the lead is already recorded by now.
async function sendInterestReceipt({ to, slug, buyerId, name, address, offer }) {
  if (!RESEND_API_KEY || !RESEND_FROM || !emailish(to)) return false;
  try {
    const tok = buyerId ? `?b=${deckToken(buyerId)}&s=email` : "";
    // Two independent reads (Storage HEAD, buyer lookup) — in parallel, so the
    // receipt an investor is waiting on doesn't queue them.
    const [pdfUrl, buyBoxUrl] = await Promise.all([
      deckPdfUrl(slug, buyerId),
      buyBoxAskUrl(buyerId),
    ]);
    const body = {
      from: RESEND_FROM,
      to: [String(to).trim()],
      subject: receiptSubject({ address, offer }),
      html: buildReceiptHtml({
        firstName: firstNameOf(name),
        address,
        deckUrl: `${SITE_URL}/deck/${slug}${tok}`,
        pdfUrl,
        buyBoxUrl,
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

    // `address_override` is NOT a properties column (it lives on the structure
    // table — see lib/deal-address.js), so naming it in this select would 400.
    // deal_type is what tells fetchDealAddress which table to look in; that
    // lookup is best-effort and falls back to the card name, so the 🔥 alert
    // and the investor receipt now say what the deck page says.
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=card_id,name,deal_type&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, body: "deal not found" };
    const cardId = prop.card_id;
    const address = await fetchDealAddress(sb, prop);

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

    // ── Anonymous / forwarded link ──────────────────────────────────
    const nm = String(name || "").trim().slice(0, 120);
    const ct = String(contact || "").trim().slice(0, 200);
    if (!nm || !ct) return { statusCode: 400, body: "name and contact required for untokenized interest" };

    // C1: turn the hand-raise into a buyer. The contact field is free text, so
    // parseContact decides which column it belongs in; when it's neither a
    // phone nor an email we record the lead and create NO buyer rather than a
    // half-broken row. Dedupe is capture.js's — never a second implementation.
    //
    // Wrapped end to end: if anything here fails we fall back to exactly the
    // old buyer-less behavior. Losing the lead to gain a buyer is never a
    // trade worth making.
    const { email: ctEmail, phone: ctPhone } = parseContact(ct);
    let deckBuyer = null, listNote = "";
    if (ctEmail || ctPhone) {
      try {
        const res = await findOrCreateBuyer({
          name: nm, email: ctEmail, phone: ctPhone,
          listSource: "deck_page",
          notes: `Raised hand on ${address} via deck page`,
          restoreRemoved: true,
        });
        deckBuyer = res.buyer;
        listNote = res.restored ? "Removed buyer restored — they raised their hand again."
                 : res.isNew   ? "New buyer added to your list from a forwarded deck link."
                 : "";
      } catch (e) {
        console.warn("deck buyer upsert failed (lead still recorded):", e.message);
      }
    }
    const deckBuyerId = deckBuyer ? deckBuyer.id : null;

    // Prefer the buyer-keyed dedupe the tokenized branch uses, so one person
    // can't become two leads by arriving untokenized and later tokenized.
    let lead = null;
    if (deckBuyerId) {
      const byBuyer = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&buyer_id=eq.${deckBuyerId}&select=id,stage,buyer_id&limit=1`);
      lead = byBuyer && byBuyer[0];
    }
    if (!lead) {
      const byContact = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&contact=eq.${encodeURIComponent(ct)}&select=id,stage,buyer_id&limit=1`);
      lead = byContact && byContact[0];
    }

    if (lead) {
      const patch = {};
      if (canAdvance.has(lead.stage)) { patch.stage = stage; patch.notes = noteFor(" (untokenized)"); }
      // Backfill the link on a lead captured before this deal had a buyer.
      if (deckBuyerId && !lead.buyer_id) patch.buyer_id = deckBuyerId;
      if (Object.keys(patch).length) {
        await sb(`/deal_leads?id=eq.${lead.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify(patch) });
      }
    } else {
      await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ card_id: cardId, address, buyer_id: deckBuyerId, name: nm, contact: ct,
          source: "deck_page", channel: "deck", stage, notes: noteFor(" (untokenized)") }) });
    }

    // Activity touch, same as the tokenized branch — the buyers-page timeline
    // and engagementScore both read buyer_activity.
    if (deckBuyerId) {
      await sb(`/buyer_activity`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_id: deckBuyerId, card_id: cardId, address, channel: "deck",
          detail: hasOffer ? `Offered ~$${offer.toLocaleString()} via deck page (forwarded link)`
                           : "Interested via deck page (forwarded link)" }) });
    }

    // Now that they're a buyer, the receipt's deck + PDF links can be tokenized
    // — their next view attributes to them instead of landing as anonymous
    // traffic. `ct` is often a phone; sendInterestReceipt no-ops on those.
    const [receipt] = await Promise.all([
      deckBuyer && deckBuyer.email_bounced_at
        ? Promise.resolve(false)
        : sendInterestReceipt({ to: ct, slug: cleanSlug, buyerId: deckBuyerId, name: nm,
            address, offer: hasOffer ? offer : 0 }),
      notify(address, `${nm} (${ct})`, hasOffer ? offer : 0, listNote),
    ]);
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, attributed: false, buyer_id: deckBuyerId, receipt }) };
  } catch (err) {
    console.error("deck-interest error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
