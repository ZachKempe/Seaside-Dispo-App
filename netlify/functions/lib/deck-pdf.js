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

module.exports = { deckPdfExists, deckPdfStorageUrl, cleanSlug };
