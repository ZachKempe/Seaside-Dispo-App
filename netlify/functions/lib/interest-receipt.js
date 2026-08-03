// H4 — the instant receipt an investor gets the moment they raise their hand
// on a deck page. Pure content only (no network, no env reads) so it can be
// pinned by tests; deck-interest.js owns the Resend call and the PDF probe.
//
// Why it exists: the hand-raise is the peak-motivation moment. If the callback
// lands six hours later, the investor has cooled with nothing in their inbox to
// remember the deal by. This puts the deck, the PDF and a booking link in their
// hands immediately.

// Brand palette — same values deck.js renders the page with, so the receipt
// looks like the page the investor just came from.
const NAVY = "#1B3A6B", GOLD = "#D4A03E", INK = "#20304D", PAPER = "#FBFAF6", LINE = "#EAE4D7", MUTED = "#8A94A6";

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// The untokenized deck form takes a free-text contact — very often a phone
// number. Only something that actually looks like an address gets a receipt;
// everything else must no-op rather than hand Resend garbage.
const emailish = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());

function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  if (!first || first.includes("@")) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function receiptSubject({ address, offer }) {
  return offer ? `Got your offer — ${address}` : `${address} — here is everything you need`;
}

// The live booking link, hardcoded as the fallback on purpose. It is a public
// URL, not a secret, and the same pattern blast-core uses for the contact phone
// (`CONTACT_PHONE || "630-488-5311"`).
//
// This exists because relying on the env var alone already failed once in
// production: CALENDLY_URL was set in Netlify AFTER the deploy that shipped
// this feature, and Netlify only injects env vars into functions at deploy
// time — so live receipts went out with no booking button and no error
// anywhere. A booking link that silently vanishes is worse than one that is
// slightly harder to change. CALENDLY_URL still overrides this when present.
const DEFAULT_CALENDLY_URL = "https://calendly.com/zach-seasidehorizon/30min";

// Resolve to something we can actually put in an email. Anything blank, or
// malformed (a bare "calendly.com/x" with no scheme would render as a broken
// relative link), falls back to the known-good default rather than to nothing.
function resolveCalendlyUrl(raw) {
  const s = String(raw || "").trim();
  return /^https:\/\/\S+$/i.test(s) ? s : DEFAULT_CALENDLY_URL;
}

function button(href, label, bg, color, border) {
  return `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 10px 0;background:${bg};color:${color};text-decoration:none;padding:13px 22px;border-radius:10px;font:700 14px Inter,Helvetica,Arial,sans-serif;border:1px solid ${border}">${esc(label)}</a>`;
}

// The deck link and the booking button ALWAYS render — the booking URL resolves
// to a working default, so it cannot go missing. Only the PDF is conditional:
// it exists solely once a blast has uploaded one, and a dead download link in a
// buyer's inbox is worse than no link.
function buildReceiptHtml({ firstName, address, deckUrl, pdfUrl, offer, calendlyUrl, contactName, contactPhone }) {
  const booking = resolveCalendlyUrl(calendlyUrl);
  const intro = offer
    ? `Thanks — I have your offer of about <b>$${Number(offer).toLocaleString()}</b> on <b>${esc(address)}</b>. I will look it over and come back to you personally. In the meantime, here is everything on the deal:`
    : `Thanks for raising your hand on <b>${esc(address)}</b>. Here is everything on the deal in one place:`;

  const buttons = [
    button(deckUrl, "View the deal", NAVY, "#ffffff", NAVY),
    pdfUrl ? button(pdfUrl, "Download the PDF", "#ffffff", NAVY, LINE) : "",
    button(booking, "Book a call", GOLD, INK, GOLD),
  ].join("");

  const closing = "Want to walk through the numbers? Grab a time above that suits you — or just reply to this email, it comes straight to me.";

  return `<div style="background:${PAPER};padding:24px 12px;font-family:Inter,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:14px">
    <tr><td style="height:5px;background:${GOLD};border-radius:13px 13px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:28px 30px 4px">
      <p style="margin:0 0 14px;font-size:16px;color:${INK}">Hi ${esc(firstName)},</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${INK}">${intro}</p>
    </td></tr>
    <tr><td style="padding:0 30px">${buttons}</td></tr>
    <tr><td style="padding:12px 30px 26px">
      <p style="margin:0;font-size:14px;line-height:1.6;color:${INK}">${closing}</p>
      <p style="margin:18px 0 0;font-size:14px;color:${INK}">— <b>${esc(contactName || "Seaside Horizon")}</b></p>
      ${contactPhone ? `<p style="margin:2px 0 0;font-size:14px;font-weight:600;color:${GOLD}">${esc(contactPhone)}</p>` : ""}
    </td></tr>
    <tr><td style="padding:0 30px 22px">
      <p style="margin:0;font-size:11px;line-height:1.5;color:${MUTED}">You are receiving this because you asked for details on ${esc(address)} from the Seaside Horizon deal page.</p>
    </td></tr>
  </table>
</div>`;
}

module.exports = { emailish, firstNameOf, receiptSubject, buildReceiptHtml,
                   resolveCalendlyUrl, DEFAULT_CALENDLY_URL };
