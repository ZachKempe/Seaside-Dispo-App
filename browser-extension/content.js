// Seaside Photo Grabber — content script for Zillow listing pages.
//
// Why this exists: Zillow refuses automated server requests to its pages, so
// the app can't fetch a listing itself. But YOUR browser, on a listing you
// opened normally, already has every photo loaded — and Zillow's photo CDN
// serves those image URLs to anyone. This button harvests the URLs from the
// page you're looking at and hands them to the dashboard, which imports them
// into the deal's gallery. No downloading, no folders, no copy/paste.
//
// Deliberately zero-permission: no host_permissions, no storage, no
// background worker. It reads the current page and opens a tab.

const APP_ORIGIN = "https://seaside-dispo-app.netlify.app"; // change if the site moves

// A listing page embeds photos for MUCH more than the listing itself —
// "similar homes", "nearby homes", "recently viewed", ads. A blind sweep of
// the page HTML returns hundreds of other people's houses, so we identify THIS
// listing's own photo set, in order of precision:
//   1. __NEXT_DATA__ → the property object matching the URL's zpid → its
//      responsivePhotos array (exact: the carousel, nothing else).
//   2. The gallery/media DOM container's <img> tags (scoped, still this deal).
//   3. Whole-page CDN scan — last resort, capped, and the caller warns that it
//      may include neighboring listings.
const MAX_PHOTOS = 60; // no residential listing legitimately exceeds this

function zpidFromUrl() {
  const m = location.pathname.match(/\/(\d+)_zpid/);
  return m ? m[1] : "";
}

// A responsivePhotos entry carries every size; take the widest jpeg.
function largestFromPhotoEntry(p) {
  const sets = (p && p.mixedSources) || {};
  const list = [].concat(sets.jpeg || [], sets.webp || []);
  let best = null;
  for (const s of list) {
    if (s && s.url && (!best || (s.width || 0) > (best.width || 0))) best = s;
  }
  if (best) return best.url;
  return (p && (p.url || p.hiResImageLink || p.imageSrc)) || "";
}

// 1. Exact: the listing's own photo array out of the embedded page data.
function fromNextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return [];
  let root;
  try { root = JSON.parse(el.textContent); } catch (_) { return []; }

  const zpid = zpidFromUrl();
  const seen = new WeakSet();
  let exact = null;   // photo array on the object whose zpid matches the URL
  let fallback = null; // first plausible carousel array, if no zpid match

  const walk = (node, depth) => {
    if (exact || depth > 14 || !node) return;
    if (typeof node === "string") {
      // Zillow nests JSON-as-string (gdpClientCache, apollo caches).
      if (node.length > 200 && (node[0] === "{" || node[0] === "[")) {
        try { walk(JSON.parse(node), depth + 1); } catch (_) { /* not JSON */ }
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    const photos = node.responsivePhotos || node.photos;
    if (Array.isArray(photos) && photos.length && photos.some(p => p && p.mixedSources)) {
      const urls = photos.map(largestFromPhotoEntry).filter(Boolean);
      if (urls.length) {
        if (zpid && String(node.zpid || "") === zpid) { exact = urls; return; }
        if (!fallback) fallback = urls;
      }
    }
    for (const k in node) walk(node[k], depth + 1);
  };
  walk(root, 0);
  return exact || fallback || [];
}

// Widest candidate in an <img>'s srcset, else its src.
function bestFromImg(img) {
  const set = img.getAttribute("srcset") || "";
  let best = { w: 0, url: img.currentSrc || img.src || "" };
  for (const part of set.split(",")) {
    const [url, w] = part.trim().split(/\s+/);
    const width = Number((w || "").replace("w", "")) || 0;
    if (url && width > best.w) best = { w: width, url };
  }
  return best.url;
}

// 2. Scoped DOM: only images inside the listing's media/gallery container.
function fromGalleryDom() {
  const selectors = [
    '[data-testid="hollywood-vertical-media-wall"] img',
    '[data-testid="media-stream"] img',
    'ul.photo-tile-list img',
    '[class*="media-wall"] img',
    '[class*="photo-tile"] img',
  ];
  for (const sel of selectors) {
    const urls = [...document.querySelectorAll(sel)]
      .map(bestFromImg)
      .filter(u => u && u.includes("photos.zillowstatic.com"));
    if (urls.length >= 3) return urls;
  }
  return [];
}

// 3. Last resort: every CDN photo on the page (largest variant per photo,
// UI thumbnails dropped). Imprecise — may include neighboring listings.
function fromWholePageScan() {
  const re = /https:\/\/photos\.zillowstatic\.com\/fp\/([a-f0-9]{12,})-[a-zA-Z_]*?(\d{2,4})[0-9_]*\.(?:jpe?g|webp)/g;
  const html = document.documentElement.innerHTML;
  const best = {};
  const order = [];
  let m;
  while ((m = re.exec(html))) {
    const id = m[1], w = Number(m[2]);
    if (!best[id]) { best[id] = { w: 0, url: "" }; order.push(id); }
    if (w > best[id].w) best[id] = { w, url: m[0] };
  }
  return order.filter(id => best[id].w >= 300).map(id => best[id].url);
}

function dedupe(urls) {
  const out = [], seen = new Set();
  for (const u of urls) {
    // Same photo at different sizes shares the /fp/<hash> segment.
    const key = (u.match(/\/fp\/([a-f0-9]{12,})/) || [, u])[1];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

// Returns { urls, precise } — precise=false means the caller should warn that
// photos from other listings on the page may be mixed in.
function grabPhotoUrls() {
  let urls = fromNextData();
  let precise = urls.length > 0;
  if (!urls.length) { urls = fromGalleryDom(); precise = urls.length > 0; }
  if (!urls.length) { urls = fromWholePageScan(); precise = false; }
  return { urls: dedupe(urls).slice(0, MAX_PHOTOS), precise };
}

// The listing address — lets the dashboard preselect the matching deal.
function listingAddress() {
  const meta = document.querySelector('meta[property="og:title"]');
  if (meta && meta.content) return meta.content.split("|")[0].trim();
  const h1 = document.querySelector("h1");
  return h1 ? h1.textContent.trim() : "";
}

function mountButton() {
  if (document.getElementById("seaside-grab-btn")) return;
  const btn = document.createElement("button");
  btn.id = "seaside-grab-btn";
  btn.type = "button";
  btn.textContent = "📸 Send photos to Seaside";
  btn.style.cssText = [
    "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
    "font:700 14px Inter,system-ui,sans-serif", "color:#112950",
    "background:linear-gradient(180deg,#E8C878,#D4A03E)", "border:none",
    "border-radius:12px", "padding:13px 18px", "cursor:pointer",
    "box-shadow:0 10px 26px -10px rgba(17,41,80,.65)",
  ].join(";");

  btn.addEventListener("click", () => {
    const { urls, precise } = grabPhotoUrls();
    if (!urls.length) {
      btn.textContent = "No photos found on this page";
      setTimeout(() => { btn.textContent = "📸 Send photos to Seaside"; }, 2500);
      return;
    }
    btn.textContent = `Sending ${urls.length} photos…`;
    const hash = `#import-photos=${encodeURIComponent(urls.join("\n"))}`
      + `&addr=${encodeURIComponent(listingAddress())}`
      + (precise ? "" : "&approx=1");
    window.open(`${APP_ORIGIN}/dashboard.html${hash}`, "_blank", "noopener");
    setTimeout(() => { btn.textContent = `✓ Sent ${urls.length} — pick the deal in the new tab`; }, 400);
    setTimeout(() => { btn.textContent = "📸 Send photos to Seaside"; }, 6000);
  });

  document.body.appendChild(btn);
}

mountButton();
// Zillow is a SPA — re-mount if it swaps the page body out.
new MutationObserver(() => mountButton()).observe(document.documentElement, { childList: true, subtree: true });
