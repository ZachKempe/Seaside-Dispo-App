// Deck-page slug generation — ONE implementation shared by blast-core (lazy
// backfill on first blast), the intake functions (eager creation so the deck
// link exists before any blast), and deck-link.js (dashboard "Copy link").
// Drift here would mint two different slugs for the same deal, so nobody
// re-implements it locally.

// Deliberately does NOT consult address_override. That column lives on the
// structure table, so this read was always undefined (see lib/deal-address.js)
// — and wiring it up now would change the slug minted for every future deal.
// A slug is an opaque published identifier, not a display string: the deck page
// renders the override, and the URL keeps whatever it was minted with.
function deckSlug(prop) {
  const base = (prop.name || "deal").toLowerCase();
  return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "deal";
}

// Populate properties.deck_slug if it isn't set yet, using the caller's
// service-role `sb` fetch helper. Handles the rare unique-index collision by
// suffixing with a short card-id fragment and retrying.
async function ensureDeckSlug(sb, prop) {
  if (prop.deck_slug) return prop.deck_slug;
  const base = deckSlug(prop);
  let slug = base;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sb(`/properties?card_id=eq.${encodeURIComponent(prop.card_id)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ deck_slug: slug }),
      });
      prop.deck_slug = slug;
      return slug;
    } catch (e) {
      // unique collision -> disambiguate with a short card-id suffix and retry
      slug = `${base}-${String(prop.card_id).slice(-4)}${attempt || ""}`;
    }
  }
  prop.deck_slug = slug;
  return slug;
}

module.exports = { deckSlug, ensureDeckSlug };
