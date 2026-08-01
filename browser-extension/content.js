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

// ── "Only send what I actually looked at" ──────────────────────────────────
// A photo counts as viewed once it has been at least half on-screen at a
// usable size — scrolling the media wall, arrowing through the full-screen
// carousel, and the lightbox all qualify. Polling (rather than
// IntersectionObserver) is deliberate: Zillow reuses the same <img> element
// and swaps its src as you page through the carousel, which an observer
// wouldn't re-fire for.
//
// Detection must be rendering-agnostic. Zillow's full-screen photo viewer
// mounts inside a SHADOW DOM and some photos are painted as CSS
// background-images, not <img> tags — so a plain `document.images` scan (the
// old approach) only ever caught the first hero image and missed everything
// you paged through. We now: (1) collect <img> across the light DOM AND every
// open shadow root, and (2) sample what's actually under the centre of the
// screen with elementsFromPoint (piercing shadow roots), reading both <img>
// src and computed background-image. Whatever is filling your viewport counts.
const viewedHashes = new Set();
const seenBest = {}; // hash -> {w, url}: largest variant actually rendered
let onViewedChange = () => {};

function photoHash(u) {
  const m = String(u || "").match(/\/fp\/([a-f0-9]{12,})/);
  return m ? m[1] : "";
}

// Every document/shadow-root in the tree (light DOM + all open shadow roots).
function allRoots() {
  const roots = [];
  const stack = [document];
  while (stack.length) {
    const root = stack.pop();
    roots.push(root);
    let all;
    try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
    for (const el of all) if (el.shadowRoot) stack.push(el.shadowRoot);
  }
  return roots;
}

// The zillowstatic photo URL an element represents, whether it's an <img> or
// carries a background-image — else "".
function photoUrlOf(el) {
  if (!el || el.nodeType !== 1) return "";
  if (el.tagName === "IMG") {
    const s = el.currentSrc || el.src || "";
    if (s.includes("photos.zillowstatic.com")) return s;
  }
  let bg;
  try { bg = getComputedStyle(el).backgroundImage; } catch (e) { return ""; }
  const m = (bg || "").match(/https:\/\/photos\.zillowstatic\.com\/[^"')]+/);
  return m ? m[0] : "";
}

// elementsFromPoint, but descending into open shadow roots at that point.
function deepElementsFromPoint(x, y) {
  const out = [];
  const seen = new Set();
  const roots = [document];
  while (roots.length) {
    const root = roots.pop();
    let els = [];
    try { els = root.elementsFromPoint(x, y); } catch (e) { els = []; }
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return out;
}

function markViewed(url, w) {
  const h = photoHash(url);
  if (!h) return false;
  const prev = seenBest[h];
  if (!prev || w > prev.w) seenBest[h] = { w: w || (prev ? prev.w : 0), url };
  if (viewedHashes.has(h)) return false;
  viewedHashes.add(h);
  return true;
}

function sampleVisiblePhotos() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let changed = false;

  // 1) <img> across light + shadow DOM, at least half on-screen and usable size.
  for (const root of allRoots()) {
    let imgs;
    try { imgs = root.querySelectorAll("img"); } catch (e) { continue; }
    for (const img of imgs) {
      const src = img.currentSrc || img.src || "";
      if (!src.includes("photos.zillowstatic.com")) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 90) continue; // thumbnails/icons aren't "viewed"
      const visW = Math.min(r.right, vw) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visW <= 0 || visH <= 0) continue;
      if (visW * visH < 0.5 * r.width * r.height) continue;
      if (markViewed(src, r.width)) changed = true;
    }
  }

  // 2) Whatever is under the centre of the screen — catches the full-screen
  // viewer's photo whether it's an <img>, a background-image, or nested in a
  // shadow root the walk above didn't reach.
  const pts = [[0.5, 0.45], [0.4, 0.45], [0.6, 0.45], [0.5, 0.3], [0.5, 0.62]];
  for (const [fx, fy] of pts) {
    for (const el of deepElementsFromPoint(Math.round(vw * fx), Math.round(vh * fy))) {
      const url = photoUrlOf(el);
      if (!url) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue; // the centred element is the main photo
      if (markViewed(url, r.width)) changed = true;
    }
  }
  return changed;
}

// The listing's full photo set, cached (the walk isn't free) and refreshed
// until the page has hydrated.
let canonicalCache = null;
function canonicalPhotos({ refresh = false } = {}) {
  if (refresh || !canonicalCache || !canonicalCache.urls.length) canonicalCache = grabPhotoUrls();
  return canonicalCache;
}

// What to send: the listing's photos filtered to the ones you viewed, in
// listing order. If we couldn't isolate the listing's own set, fall back to
// the viewed photos as rendered and flag the result imprecise.
function selection(viewedOnly) {
  const { urls, precise } = canonicalPhotos();
  if (!viewedOnly) return { urls, precise };
  if (precise && urls.length) {
    const picked = urls.filter(u => viewedHashes.has(photoHash(u)));
    return { urls: picked, precise: true };
  }
  const picked = [...viewedHashes].map(h => seenBest[h] && seenBest[h].url).filter(Boolean);
  return { urls: picked.slice(0, MAX_PHOTOS), precise: false };
}

// The listing address — lets the dashboard preselect the matching deal.
function listingAddress() {
  const meta = document.querySelector('meta[property="og:title"]');
  if (meta && meta.content) return meta.content.split("|")[0].trim();
  const h1 = document.querySelector("h1");
  return h1 ? h1.textContent.trim() : "";
}

function send(viewedOnly, statusEl) {
  const { urls, precise } = selection(viewedOnly);
  if (!urls.length) {
    statusEl.textContent = viewedOnly
      ? "Open the photos and scroll through the ones you want."
      : "No photos found on this page.";
    return;
  }
  const hash = `#import-photos=${encodeURIComponent(urls.join("\n"))}`
    + `&addr=${encodeURIComponent(listingAddress())}`
    + (precise ? "" : "&approx=1");
  window.open(`${APP_ORIGIN}/dashboard.html${hash}`, "_blank", "noopener");
  statusEl.textContent = `✓ Sent ${urls.length} — pick the deal in the new tab`;
  setTimeout(() => { statusEl.textContent = ""; }, 6000);
}

function mountPanel() {
  if (document.getElementById("seaside-grab-panel")) return;

  const panel = document.createElement("div");
  panel.id = "seaside-grab-panel";
  panel.style.cssText = [
    "position:fixed", "right:18px", "bottom:18px", "z-index:2147483647",
    "font:500 13px Inter,system-ui,sans-serif", "color:#20304D",
    "background:#FBFAF6", "border:1px solid #E7E1D3", "border-radius:14px",
    "padding:12px 14px", "box-shadow:0 14px 34px -14px rgba(17,41,80,.6)",
    "display:flex", "flex-direction:column", "gap:8px", "max-width:250px",
  ].join(";");

  const count = document.createElement("div");
  count.id = "seaside-grab-count";

  const sendViewed = document.createElement("button");
  sendViewed.type = "button";
  sendViewed.style.cssText = [
    "font:700 14px Inter,system-ui,sans-serif", "color:#112950",
    "background:linear-gradient(180deg,#E8C878,#D4A03E)", "border:none",
    "border-radius:11px", "padding:11px 14px", "cursor:pointer",
  ].join(";");

  const sendAll = document.createElement("button");
  sendAll.type = "button";
  sendAll.style.cssText = [
    "font:600 12px Inter,system-ui,sans-serif", "color:#1B3A6B",
    "background:none", "border:none", "padding:0", "cursor:pointer",
    "text-decoration:underline", "align-self:flex-start",
  ].join(";");

  const status = document.createElement("div");
  status.style.cssText = "font-size:11.5px;color:#8A94A6;line-height:1.4";

  function update() {
    const total = canonicalPhotos().urls.length;
    const viewed = selection(true).urls.length;
    count.innerHTML = `👁 <b>${viewed}</b> of ${total || "?"} photo${total === 1 ? "" : "s"} viewed`;
    sendViewed.textContent = viewed ? `📸 Send ${viewed} viewed` : "📸 Send viewed photos";
    sendViewed.style.opacity = viewed ? "1" : ".55";
    sendAll.textContent = total ? `Send all ${total} instead` : "";
    sendAll.style.display = total && total !== viewed ? "block" : "none";
    if (!viewed && !status.textContent) {
      status.textContent = "Scroll the photos you want — only those get sent.";
    } else if (viewed && status.textContent.startsWith("Scroll")) {
      status.textContent = "";
    }
  }
  onViewedChange = update;

  sendViewed.addEventListener("click", () => send(true, status));
  sendAll.addEventListener("click", () => send(false, status));

  panel.append(count, sendViewed, sendAll, status);
  document.body.appendChild(panel);
  update();
}

mountPanel();
// Poll for what's on screen (catches carousel src swaps the observer misses)
// and refresh the panel when the viewed set grows.
setInterval(() => { if (sampleVisiblePhotos()) onViewedChange(); }, 600);
// Keep the listing's photo set fresh while the page hydrates.
setInterval(() => { canonicalPhotos({ refresh: true }); onViewedChange(); }, 4000);
// Zillow is a SPA — re-mount if it swaps the page body out.
new MutationObserver(() => mountPanel()).observe(document.documentElement, { childList: true, subtree: true });
