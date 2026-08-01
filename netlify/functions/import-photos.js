// "Import from link" — pulls a deal's photos into its gallery automatically so
// nobody downloads/re-uploads by hand. POST { card_id, url } (auth'd with the
// caller's Supabase access token) → downloads every usable image and stores it
// under property-photos/gallery/<card_id>/ (lib/gallery.js convention), then
// syncs deal_acquisition.photos_count.
//
// Three source shapes, auto-detected:
//   1. Google Drive folder link — lists the folder via the Drive API and pulls
//      every image. Needs the folder shared "anyone with link", and the Drive
//      API enabled for GOOGLE_API_KEY (falls back to GOOGLE_MAPS_API_KEY,
//      which lives in the same Google Cloud project).
//   2. Direct image URL(s) — one or more image links (newline/comma/space
//      separated) are fetched as-is.
//   3. Any other web page (agent photo link, simple listing page) — the HTML
//      is scanned for og:image / <img> / srcset / JSON-LD images; big real
//      photos are kept, logos and icons skipped. Sites with bot walls
//      (notably Zillow) will refuse; the error says so and suggests 1/2.
//
// Sync function budget is ~10s, so downloads run concurrently, are capped at
// MAX_PHOTOS per run, and stop starting new work near the deadline — the
// response reports found/imported/skipped so a partial run is visible.

const SB_URL = process.env.SUPABASE_URL;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "";

const { listGalleryPhotos, uploadGalleryImage, syncPhotosCount } = require("./lib/gallery");

const MAX_PHOTOS = 16;              // per import run — rerun to pull more
const MIN_BYTES = 25 * 1024;        // below this it's a logo/thumbnail, not a photo
const MAX_BYTES = 12 * 1024 * 1024;
const CONCURRENCY = 5;
const TIME_BUDGET_MS = 8000;        // stop starting downloads after this
const OK_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

function driveFolderId(url) {
  const m = String(url).match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|folderview\?[^#]*\bid=)([\w-]{10,})/i)
        || String(url).match(/drive\.google\.com\/[^#]*[?&]id=([\w-]{10,})/i);
  return m ? m[1] : null;
}

// Google Drive folder → [{url, name}] download descriptors.
async function driveCandidates(folderId) {
  if (!GOOGLE_KEY) throw new Error("No Google API key configured (GOOGLE_API_KEY / GOOGLE_MAPS_API_KEY).");
  const q = encodeURIComponent(`'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=100&fields=files(id,name,mimeType)&key=${GOOGLE_KEY}`);
  if (r.status === 403) throw new Error("Google Drive said no (403) — enable the Drive API for the Google API key, and make sure the folder is shared \"Anyone with the link\".");
  if (r.status === 404) throw new Error("Drive folder not found — is it shared \"Anyone with the link\"?");
  if (!r.ok) throw new Error(`Drive API error ${r.status}`);
  const { files } = await r.json();
  if (!files || !files.length) throw new Error("The Drive folder has no images (or they aren't link-shared).");
  return files.map(f => ({ url: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${GOOGLE_KEY}`, name: f.name }));
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)(\?|#|$)/i;

// Generic page → likely photo URLs, in page order, junk filtered out.
async function scrapePageCandidates(pageUrl) {
  const r = await fetch(pageUrl, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(`The page returned HTTP ${r.status} — it likely blocks automated access (Zillow and most MLS portals do). Use the Google Drive folder or direct image links instead.`);
  const html = await r.text();
  const seen = new Set();
  const out = [];
  const push = (u) => {
    if (!u) return;
    try {
      const abs = new URL(u, pageUrl).href;
      if (seen.has(abs)) return;
      seen.add(abs);
      if (/\.svg(\?|#|$)|logo|icon|sprite|avatar|badge|placeholder|pixel|tracking/i.test(abs)) return;
      out.push({ url: abs, name: "" });
    } catch (_) { /* bad URL — skip */ }
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/"image"\s*:\s*(\[[^\]]{0,4000}?\]|"https?:[^"]+")/g)) {
    try {
      const v = JSON.parse(m[1]);
      (Array.isArray(v) ? v : [v]).forEach(x => { if (typeof x === "string") push(x); else if (x && x.url) push(x.url); });
    } catch (_) { /* not valid JSON — skip */ }
  }
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src|data-lazy-src|data-original)=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi)) {
    const last = m[1].split(",").pop();
    if (last) push(last.trim().split(/\s+/)[0]);
  }
  if (!out.length) throw new Error("No photos found on that page. Paste a Drive folder link or direct image URLs instead.");
  return out;
}

function extFrom(contentType, url) {
  if (OK_TYPES[contentType]) return OK_TYPES[contentType];
  const m = String(url).match(/\.(jpe?g|png|webp)(\?|#|$)/i);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const started = Date.now();
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    const { card_id, url } = JSON.parse(event.body || "{}");
    if (!card_id || !url) return { statusCode: 400, body: JSON.stringify({ error: "card_id and url are required" }) };

    // ── Collect candidates by source shape ──
    const tokens = String(url).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    let candidates;
    const folderId = driveFolderId(tokens[0]);
    if (folderId) {
      candidates = await driveCandidates(folderId);
    } else if (tokens.every(t => /^https?:\/\//i.test(t) && IMAGE_EXT_RE.test(t))) {
      candidates = tokens.map(t => ({ url: t, name: "" }));
    } else if (/^https?:\/\//i.test(tokens[0])) {
      candidates = await scrapePageCandidates(tokens[0]);
    } else {
      return { statusCode: 400, body: JSON.stringify({ error: "Paste a full http(s) link — a Drive folder, a listing page, or direct image URLs." }) };
    }

    const existing = await listGalleryPhotos(card_id);
    const found = candidates.length;
    candidates = candidates.slice(0, 40); // don't even attempt a 300-image page

    // ── Download + filter + upload, concurrently, inside the time budget ──
    const stamp = Date.now();
    let imported = 0, skipped = 0, seq = 0;
    const errors = [];
    let next = 0;
    async function worker() {
      while (next < candidates.length && imported < MAX_PHOTOS) {
        if (Date.now() - started > TIME_BUDGET_MS) return;
        const c = candidates[next++];
        try {
          const r = await fetch(c.url, {
            headers: { "User-Agent": BROWSER_UA, Accept: "image/*,*/*" },
            redirect: "follow",
            signal: AbortSignal.timeout(6000),
          });
          if (!r.ok) { skipped++; continue; }
          const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const ext = extFrom(type, c.url);
          if (!ext) { skipped++; continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) { skipped++; continue; }
          if (imported >= MAX_PHOTOS) return;
          const mySeq = seq++;
          await uploadGalleryImage(card_id, `${stamp}-${String(mySeq).padStart(2, "0")}-import.${ext}`, buf, type.startsWith("image/") ? type : "image/jpeg");
          imported++;
        } catch (e) {
          skipped++;
          if (errors.length < 3) errors.push(e.message);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const total = await syncPhotosCount(card_id);
    if (!imported) {
      const hint = errors.length ? ` (${errors[0]})` : "";
      return { statusCode: 422, body: JSON.stringify({ error: `Found ${found} image link${found === 1 ? "" : "s"} but none were importable${hint}. The site may block downloads — try the Drive folder or direct image links.`, found, skipped }) };
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imported, found, skipped, total,
        partial: imported >= MAX_PHOTOS || Date.now() - started > TIME_BUDGET_MS,
        already_had: existing.length,
      }),
    };
  } catch (err) {
    console.error("import-photos error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
