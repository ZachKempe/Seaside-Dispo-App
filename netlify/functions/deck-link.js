// Deck-link resolver for the dashboard. POST { card_id, buyer_id? } (auth'd
// with the caller's Supabase access token) → { url, slug }.
//
// - No buyer_id → the plain deck URL, for FB group posts / Copy Deal Info.
// - With buyer_id → a per-buyer tokenized URL (?b=<token>) so a manually
//   DM'd/texted buyer's deck views and interest taps attribute to them,
//   exactly like a blast link would.
//
// Also backfills properties.deck_slug for legacy cards created before intake
// started setting it eagerly (the token secret and slug generator are shared
// with blast-core, so links minted here are identical to blasted ones).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app";

const { deckToken } = require("./lib/deck-token");
const { ensureDeckSlug } = require("./lib/deck-slug");

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

    const { card_id, buyer_id } = JSON.parse(event.body || "{}");
    if (!card_id) return { statusCode: 400, body: JSON.stringify({ error: "card_id required" }) };

    const rows = await sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=card_id,name,address_override,deck_slug&limit=1`);
    const prop = rows && rows[0];
    if (!prop) return { statusCode: 404, body: JSON.stringify({ error: "Deal not found" }) };

    const slug = await ensureDeckSlug(sb, prop);
    // s=dm marks a link copied for a manual text/DM, so its views are told
    // apart from blast-driven SMS and email views (migration 030).
    const url = buyer_id
      ? `${SITE_URL}/deck/${slug}?b=${encodeURIComponent(deckToken(buyer_id))}&s=dm`
      : `${SITE_URL}/deck/${slug}`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, slug }),
    };
  } catch (err) {
    console.error("deck-link error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
