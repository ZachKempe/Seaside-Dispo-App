// Per-deal photo gallery, stored in the public `property-photos` bucket under
// gallery/<card_id>/<name>. One convention, three writers/readers:
//   - dashboard.js uploads/deletes directly from the browser (authed RLS)
//   - import-photos.js writes server-side (Drive / listing-page imports)
//   - deck.js lists the folder to render the buyer-facing gallery
// Names sort chronologically (each file is prefixed with a timestamp), so
// "order by name asc" is display order everywhere.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = "property-photos";

// card_ids are Trello hashes or our "subto-…"/"morby-…" ids — always URL-safe.
// Reject anything else rather than escaping, so client + server paths match.
function safeCardId(cardId) {
  const id = String(cardId || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid card_id");
  return id;
}

function galleryPrefix(cardId) {
  return `gallery/${safeCardId(cardId)}`;
}

function publicUrl(path) {
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

// List the deal's gallery as [{url, name}], oldest-first. Fails soft to [] —
// the deck page must render even if Storage hiccups.
async function listGalleryPhotos(cardId) {
  try {
    const prefix = galleryPrefix(cardId);
    const r = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 200, sortBy: { column: "name", order: "asc" } }),
    });
    if (!r.ok) return [];
    const files = await r.json();
    return (Array.isArray(files) ? files : [])
      .filter(f => f && f.name && !f.name.startsWith("."))
      .map(f => ({ url: publicUrl(`${prefix}/${f.name}`), name: f.name }));
  } catch (e) {
    console.warn("gallery list failed:", e.message);
    return [];
  }
}

// Server-side upload of one image buffer into the gallery. Throws on failure.
async function uploadGalleryImage(cardId, filename, buf, contentType) {
  const path = `${galleryPrefix(cardId)}/${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": contentType || "image/jpeg",
      "x-upsert": "true",
    },
    body: buf,
  });
  if (!r.ok) throw new Error(`upload ${path} -> ${r.status}: ${await r.text()}`);
  return publicUrl(path);
}

// Keep deal_acquisition.photos_count in step with the real gallery size (it
// powers the "Need More Photos" flag + acq completeness on the dashboard).
async function syncPhotosCount(cardId) {
  const photos = await listGalleryPhotos(cardId);
  try {
    await fetch(`${SB_URL}/rest/v1/deal_acquisition?on_conflict=card_id`, {
      method: "POST",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ card_id: safeCardId(cardId), photos_count: photos.length }),
    });
  } catch (e) {
    console.warn("photos_count sync failed:", e.message);
  }
  return photos.length;
}

module.exports = { listGalleryPhotos, uploadGalleryImage, syncPhotosCount, galleryPrefix };
