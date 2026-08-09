// Deck-link resolver for the dashboard. POST { card_id, buyer_id?, kind?,
// pdf_base64? } (auth'd with the caller's Supabase access token) → { url, slug }.
//
// - No buyer_id → the plain deck URL, for FB group posts / Copy Deal Info.
// - With buyer_id → a per-buyer tokenized URL (?b=<token>) so a manually
//   DM'd/texted buyer's deck views and interest taps attribute to them,
//   exactly like a blast link would.
// - kind:"pdf" → the hosted Deal Deck PDF link, /deck/<slug>.pdf.
//
// The PDF only exists once something has uploaded it, and before this that was
// only ever a blast — so Copy PDF link on a deal you haven't blasted yet would
// hand out a link that 302s back to the deck page (H3). Instead the resolver
// reports { needs_pdf: true } and the dashboard generates the PDF in the
// browser (the same jsPDF path as Download Deal Deck) and posts it back as
// pdf_base64 to be hosted. Same storage path and same short link as the blast
// uses — lib/deck-pdf.js owns both — so a copied link and a blasted one are
// byte-identical and attribute the same way.
//
// Also backfills properties.deck_slug for legacy cards created before intake
// started setting it eagerly (the token secret and slug generator are shared
// with blast-core, so links minted here are identical to blasted ones).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://deals.seasidehorizon.com";

const { deckToken } = require("./lib/deck-token");
const { ensureDeckSlug } = require("./lib/deck-slug");
const { deckPdfExists, uploadDeckPdf } = require("./lib/deck-pdf");

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    const { card_id, buyer_id, kind, pdf_base64 } = JSON.parse(event.body || "{}");
    if (!card_id) return { statusCode: 400, body: JSON.stringify({ error: "card_id required" }) };

    // select=* like blast-core, deliberately. The hand-listed column set this
    // replaces named `address_override`, which lives on morby_deals and has
    // never existed on properties (migration 012) — so every call 400'd with
    // "column properties.address_override does not exist". It went unnoticed
    // because the dashboard only reached this resolver for cards with no slug
    // yet; Copy PDF link, which always calls it, is what surfaced it. `*` also
    // means ensureDeckSlug sees exactly the object blast-core hands it, so a
    // slug minted here can't diverge from a blasted one.
    const rows = await sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`);
    const prop = rows && rows[0];
    if (!prop) return { statusCode: 404, body: JSON.stringify({ error: "Deal not found" }) };

    const slug = await ensureDeckSlug(sb, prop);
    const json = (body, statusCode = 200) => ({
      statusCode,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (kind === "pdf") {
      // Host the freshly generated PDF when the dashboard sends one — always
      // overwriting, so Copy PDF link after a terms edit republishes rather
      // than handing out a stale deck.
      if (pdf_base64) {
        await uploadDeckPdf(slug, String(pdf_base64).replace(/^data:[^,]*,/, ""));
      } else if (!(await deckPdfExists(slug))) {
        // Nothing hosted and nothing to host: tell the dashboard to generate.
        return json({ needs_pdf: true, slug });
      }
      // Tokenizing works on the .pdf route too (deck.js reads b/s there), so a
      // PDF DM'd to one buyer attributes exactly like a blasted download.
      return json({
        url: buyer_id
          ? `${SITE_URL}/deck/${slug}.pdf?b=${encodeURIComponent(deckToken(buyer_id))}&s=dm`
          : `${SITE_URL}/deck/${slug}.pdf`,
        slug,
      });
    }

    // s=dm marks a link copied for a manual text/DM, so its views are told
    // apart from blast-driven SMS and email views (migration 030).
    const url = buyer_id
      ? `${SITE_URL}/deck/${slug}?b=${encodeURIComponent(deckToken(buyer_id))}&s=dm`
      : `${SITE_URL}/deck/${slug}`;

    return json({ url, slug });
  } catch (err) {
    console.error("deck-link error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
