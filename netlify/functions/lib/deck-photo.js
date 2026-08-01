// Resolve the best available photo for a deal, in priority order:
//   1. cover_image_url     — the URL Zach pastes on the posting dashboard (explicit choice: always wins)
//   2. fb_photos[0]        — photos already attached to the property (legacy scraper field)
//   3. Google Street View  — automatic street-level photo of the exact address (universal fallback)
//   4. null                — caller renders the styled navy banner
//
// Street View needs GOOGLE_MAPS_API_KEY in the environment. Before returning a
// Street View URL we hit the (free) metadata endpoint so we NEVER show Google's
// gray "no imagery available" placeholder — if there's no pano we fall through
// to null and the page uses its designed fallback.
//
// Usage in deck.js:
//   const { resolveDealPhotos } = require("./lib/deck-photo");
//   const { photos, hero } = await resolveDealPhotos(prop, cover, address);

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Returns a Street View image URL for `address`, or "" if no imagery exists.
async function streetViewFor(address, { w = 640, h = 400 } = {}) {
  if (!GOOGLE_KEY || !address) return "";
  const loc = encodeURIComponent(address);
  try {
    const meta = await fetch(
      `https://maps.googleapis.com/maps/api/streetview/metadata?location=${loc}&source=outdoor&key=${GOOGLE_KEY}`
    ).then(r => r.json());
    if (!meta || meta.status !== "OK") return ""; // ZERO_RESULTS / NOT_FOUND / OVER_QUERY_LIMIT
    // Use the resolved pano_id (stable) rather than re-geocoding the address.
    const anchor = meta.pano_id ? `pano=${encodeURIComponent(meta.pano_id)}` : `location=${loc}`;
    return `https://maps.googleapis.com/maps/api/streetview?size=${w}x${h}&${anchor}&fov=80&pitch=8&source=outdoor&key=${GOOGLE_KEY}`;
  } catch (e) {
    console.warn("streetview lookup failed:", e.message);
    return "";
  }
}

// Zero-touch exterior mini-gallery: Street View front shot + close aerial +
// neighborhood aerial, all from GOOGLE_MAPS_API_KEY. Gated on Street View
// metadata (same guard streetViewFor uses) so a bad/unmapped address yields []
// instead of Google's gray placeholder tiles. Used when a deal has no real
// photos yet — every deck gets *some* visual story with zero uploads.
async function autoExteriorShots(address, { w = 640, h = 420 } = {}) {
  const sv = await streetViewFor(address, { w, h });
  if (!sv) return [];
  const loc = encodeURIComponent(address);
  return [
    { url: sv, name: "Street view" },
    { url: `https://maps.googleapis.com/maps/api/staticmap?center=${loc}&zoom=19&size=${w}x${h}&maptype=satellite&key=${GOOGLE_KEY}`, name: "Aerial view" },
    { url: `https://maps.googleapis.com/maps/api/staticmap?center=${loc}&zoom=16&size=${w}x${h}&maptype=hybrid&markers=color:0xD4A03E%7C${loc}&key=${GOOGLE_KEY}`, name: "Neighborhood" },
  ];
}

// Given the property row, its cover image, address, and uploaded gallery
// (lib/gallery.js), return the photo set to render. `photos` is an array of
// {url,name} (may be empty); `hero` is a single best URL for a full-bleed
// banner (may be ""). Priority: real gallery (cover leads it) → cover alone →
// legacy listing photos → auto Street View/aerial set → none.
async function resolveDealPhotos(prop, cover, address, gallery = []) {
  const g = (gallery || []).filter(p => p && p.url);
  if (g.length) {
    const photos = cover && !g.some(p => p.url === cover)
      ? [{ url: cover, name: address }, ...g]
      : g;
    return { photos, hero: (cover || photos[0].url), source: "gallery" };
  }
  if (cover) return { photos: [{ url: cover, name: address }], hero: cover, source: "cover" };
  const fb = Array.isArray(prop.fb_photos) ? prop.fb_photos.filter(p => p && p.url).slice(0, 6) : [];
  if (fb.length) return { photos: fb, hero: fb[0].url, source: "listing" };

  const auto = await autoExteriorShots(address);
  if (auto.length) return { photos: auto, hero: auto[0].url, source: "streetview" };

  return { photos: [], hero: "", source: "none" };
}

module.exports = { resolveDealPhotos, streetViewFor, autoExteriorShots };
