// H3 — does this deal actually HAVE a hosted Deal Deck PDF?
//
// The file only exists once a blast has uploaded one (blast-core's
// uploadDealDeckPdf, which runs for Morby/Stack deals only), so on a Sub-To
// deck there is usually nothing at deal-decks/<slug>.pdf at all.
//
// deck.js used to render the PDF button on every deck and 302 straight to
// Storage without checking, which cost two things:
//   • an investor on the highest-intent page we own got a raw Storage 404
//   • the redirect logged a kind='pdf' deck_views row BEFORE resolving
//     anything, so a broken click scored +5 engagement on that buyer (feeding
//     the dashboard's "call today" strip) and incremented the "N PDF
//     downloads" chip the deck shows buyers as social proof. The dead link
//     was corrupting the number used to decide who to call about it.
//
// deck-interest.js has probed this exact path since H4 ("a dead download
// button in a buyer's inbox is worse than no button"). This is that probe,
// lifted into lib so the page and the email can never disagree about whether
// a PDF exists — the same reason matching and money math live in one module.
"use strict";

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Deck slugs are minted [a-z0-9-] by lib/deck-slug.js, so sanitizing to the
// same alphabet both matches blast-core's upload path byte for byte and makes
// the value safe to interpolate without encoding.
const cleanSlug = (slug) => String(slug || "").replace(/[^a-zA-Z0-9_-]/g, "");

function deckPdfStorageUrl(slug) {
  return `${SB_URL}/storage/v1/object/public/property-photos/deal-decks/${cleanSlug(slug)}.pdf`;
}

// Fails soft to false: a probe that errors must hide the button, never offer a
// download we can't stand behind.
async function deckPdfExists(slug) {
  if (!cleanSlug(slug) || !SB_URL) return false;
  try {
    const r = await fetch(deckPdfStorageUrl(slug), { method: "HEAD" });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// Write the generated Deal Deck PDF to the public property-photos bucket so
// email, SMS and the deck page can all LINK it rather than carry a copy (M12).
// One stable file per deal (x-upsert), so a re-send or a re-copied link
// overwrites rather than piling up.
//
// `slug` must be the slug stored on the property — deck.js resolves
// /deck/<slug>.pdf by looking the stored slug up, so a collision-suffixed or
// legacy slug would otherwise put the file somewhere nothing serves.
//
// Lives here rather than in blast-core because two callers now write this
// path: the blast (at send time) and deck-link.js (when Copy PDF link is
// clicked on a deal that was never blasted). Two copies of the path
// convention is exactly how deckPdfExists and the uploader would drift.
async function uploadDeckPdf(slug, cleanBase64) {
  const path = `deal-decks/${cleanSlug(slug)}.pdf`;
  const r = await fetch(`${SB_URL}/storage/v1/object/property-photos/${path}`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: Buffer.from(cleanBase64, "base64"),
  });
  if (!r.ok) throw new Error(`deck upload -> ${r.status}: ${await r.text()}`);
}

module.exports = { deckPdfExists, deckPdfStorageUrl, cleanSlug, uploadDeckPdf };
