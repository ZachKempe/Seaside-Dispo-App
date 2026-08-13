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

const APP_ORIGIN = "https://deals.seasidehorizon.com"; // change if the site moves

const MAX_PHOTOS = 80; // MLS galleries top out around here

// ── The photo registry ─────────────────────────────────────────────────────
// One accumulating map of every photo of THIS listing we have seen, from any
// source, keyed by the CDN hash (`/fp/<hash>-<variant>.<ext>` — the hash is
// the photo, the variant is the size). Sources only ever ADD to it; nothing
// replaces it. This is the load-bearing design decision: on OFF-MARKET pages
// (i.e. every wholesaling deal) Zillow embeds just ONE photo on the property
// node (`responsivePhotos`), parks the full set under
// `property.lastSoldListing.photos`, and lazy-renders the gallery as you
// scroll — so any single-source, first-match-wins grab sees "1 photo" while
// the carousel says "41". The old version did exactly that, and then filtered
// your viewed photos against the broken 1-photo set, which is how it showed
// "0 of 1" after you paged through the whole gallery.
//
// Sources, all unioned:
//   1. Embedded page data (__NEXT_DATA__): FULL walk, no early exit,
//      harvesting every photo array on or under the property whose zpid
//      matches the URL — responsivePhotos, photos, originalPhotos,
//      lastSoldListing.photos, all of them. Gives hi-res 1536px URLs.
//   2. The DOM, polled: every gallery-sized listing photo that ever renders
//      (media wall, fullscreen carousel, hero) is captured as you scroll.
//      Other listings' photos can't leak in — see isSubjectPhoto().
//   3. Raw-HTML scan — last resort at send time only, flagged approximate.

const registry = new Map(); // hash -> { url, w, seq }
let regSeq = 0;             // first-seen order for photos page data didn't list
let canonicalOrder = [];    // hashes in the listing's own order, from page data
let currentZpid = zpidFromUrl();
const viewedHashes = new Set();
let onViewedChange = () => {};

function zpidFromUrl() {
  const m = location.pathname.match(/\/(\d+)_zpid/);
  return m ? m[1] : "";
}

const CDN_RE = /https:\/\/photos\.zillowstatic\.com\/fp\/([a-f0-9]{12,})-([A-Za-z0-9_]+?)\.(?:jpe?g|webp|png)/;

function parsePhoto(u) {
  const m = CDN_RE.exec(String(u || ""));
  if (!m) return null;
  // cc_ft_960 → 960, uncropped_scaled_within_1536_1152 → 1536, p_e/h_l → 0
  const wm = m[2].match(/(\d{2,4})/);
  return { url: m[0], hash: m[1], variant: m[2], variantW: wm ? Number(wm[1]) : 0 };
}

// Gallery-size gate: the subject listing's photos always render from sized
// variants (cc_ft_768, cc_ft_960, …1536). Nearby-home cards, map collages and
// filmstrip thumbs use unsized variants (p_e, p_c, h_l) — those are how the
// old whole-page scan pulled in other people's houses, so they never enter
// the registry from the DOM. (Page data is exempt: its URLs are sized anyway
// and it's already scoped to the subject property.)
function isSubjectPhoto(parsed, el) {
  if (!parsed || parsed.variantW < 300) return false;
  // Belt and braces: anything inside a link to a DIFFERENT listing isn't ours.
  if (el && el.closest) {
    const a = el.closest('a[href*="_zpid"]');
    if (a && currentZpid && !a.href.includes(`/${currentZpid}_zpid`)) return false;
  }
  return true;
}

function register(parsed, w) {
  if (!parsed) return false;
  const prev = registry.get(parsed.hash);
  const width = Math.max(w || 0, parsed.variantW);
  if (!prev) {
    registry.set(parsed.hash, { url: parsed.url, w: width, seq: regSeq++ });
    return true;
  }
  if (width > prev.w) { prev.url = parsed.url; prev.w = width; }
  return false;
}

// ── Source 1: embedded page data ───────────────────────────────────────────

// A photo entry carries every size; take the widest (jpeg preferred — the
// import pipeline and deck gallery both want jpeg when available).
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

// Full walk of __NEXT_DATA__ (including Zillow's JSON-nested-in-strings
// caches). NO early exit: the property node's own responsivePhotos can be a
// 1-photo stub while the real set sits beside it under lastSoldListing —
// stopping at the first zpid hit is precisely the bug this rewrite fixes.
// Collects every photo array, tagged with whether it sits on/under the node
// whose zpid matches the URL.
function harvestNextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return;
  let root;
  try { root = JSON.parse(el.textContent); } catch (_) { return; }

  const zpid = currentZpid;
  const seen = new WeakSet();
  const arrays = []; // { urls, subject }

  const walk = (node, depth, subject) => {
    if (depth > 16 || !node) return;
    if (typeof node === "string") {
      if (node.length > 200 && (node[0] === "{" || node[0] === "[")) {
        try { walk(JSON.parse(node), depth + 1, subject); } catch (_) { /* not JSON */ }
      }
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      const looksLikePhotos = node.length && node.some(p => p && typeof p === "object" && p.mixedSources);
      if (looksLikePhotos) {
        const urls = node.map(largestFromPhotoEntry).filter(Boolean);
        if (urls.length) arrays.push({ urls, subject });
      }
      for (const v of node) walk(v, depth + 1, subject);
      return;
    }
    if (zpid && String(node.zpid || "") === zpid) subject = true;
    for (const k in node) walk(node[k], depth + 1, subject);
  };
  walk(root, 0, false);

  const subjectArrays = arrays.filter(a => a.subject);
  // No zpid match (bare /homes/ URLs) → longest array is the best guess.
  const pool = subjectArrays.length
    ? subjectArrays
    : (arrays.length ? [arrays.reduce((a, b) => (b.urls.length > a.urls.length ? b : a))] : []);
  if (!pool.length) return;

  // Listing order: the longest array is the gallery; the others (the 1-photo
  // hero stub, originalPhotos, …) union in behind it.
  pool.sort((a, b) => b.urls.length - a.urls.length);
  const order = [];
  const inOrder = new Set();
  for (const arr of pool) {
    for (const u of arr.urls) {
      const parsed = parsePhoto(u);
      if (!parsed) continue;
      register(parsed, parsed.variantW);
      if (!inOrder.has(parsed.hash)) { inOrder.add(parsed.hash); order.push(parsed.hash); }
    }
  }
  if (order.length >= canonicalOrder.length) canonicalOrder = order;
}

// ── Source 2: the DOM, as it renders ───────────────────────────────────────

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

// Every document/shadow-root in the tree (light DOM + all open shadow roots —
// Zillow's fullscreen viewer has mounted inside a shadow root before).
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
    const s = bestFromImg(el);
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

function markViewed(parsed) {
  if (viewedHashes.has(parsed.hash)) return false;
  viewedHashes.add(parsed.hash);
  return true;
}

// One poll tick: sweep every rendered listing photo into the registry, and
// mark the on-screen ones viewed. Polling (rather than IntersectionObserver)
// is deliberate: Zillow reuses the same <img> element and swaps its src as
// you page through the carousel, which an observer wouldn't re-fire for.
function samplePage() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let changed = false;

  // 1) <img> across light + shadow DOM. Everything gallery-sized registers
  //    (that's how lazy-rendered photos accumulate as you scroll); the ones
  //    at least half on-screen at a usable size also count as viewed.
  for (const root of allRoots()) {
    let imgs;
    try { imgs = root.querySelectorAll("img"); } catch (e) { continue; }
    for (const img of imgs) {
      const parsed = parsePhoto(bestFromImg(img));
      if (!isSubjectPhoto(parsed, img)) continue;
      const r = img.getBoundingClientRect();
      if (register(parsed, Math.round(r.width))) changed = true;
      if (r.width < 120 || r.height < 90) continue; // rendered too small to be "viewed"
      const visW = Math.min(r.right, vw) - Math.max(r.left, 0);
      const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      if (visW <= 0 || visH <= 0) continue;
      if (visW * visH < 0.5 * r.width * r.height) continue;
      if (markViewed(parsed)) changed = true;
    }
  }

  // 2) Whatever is under the centre of the screen — catches the fullscreen
  //    viewer's photo whether it's an <img>, a background-image, or nested in
  //    a shadow root the walk above didn't reach.
  const pts = [[0.5, 0.45], [0.4, 0.45], [0.6, 0.45], [0.5, 0.3], [0.5, 0.62]];
  for (const [fx, fy] of pts) {
    for (const el of deepElementsFromPoint(Math.round(vw * fx), Math.round(vh * fy))) {
      const parsed = parsePhoto(photoUrlOf(el));
      if (!isSubjectPhoto(parsed, el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue; // the centred element is the main photo
      if (register(parsed, Math.round(r.width))) changed = true;
      if (markViewed(parsed)) changed = true;
    }
  }
  return changed;
}

// ── Source 3: raw-HTML scan (send-time last resort, approximate) ───────────
function rawHtmlScan() {
  const re = new RegExp(CDN_RE.source, "g");
  const html = document.documentElement.innerHTML;
  let m;
  while ((m = re.exec(html))) {
    const parsed = parsePhoto(m[0]);
    if (parsed && parsed.variantW >= 300) register(parsed, parsed.variantW);
  }
}

// ── Selection ──────────────────────────────────────────────────────────────

// Registry hashes in presentation order: the listing's own order first, then
// everything else by first-seen.
function orderedHashes() {
  const out = [];
  const used = new Set();
  for (const h of canonicalOrder) {
    if (registry.has(h) && !used.has(h)) { used.add(h); out.push(h); }
  }
  const rest = [...registry.keys()].filter(h => !used.has(h))
    .sort((a, b) => registry.get(a).seq - registry.get(b).seq);
  return out.concat(rest);
}

function selection(viewedOnly) {
  let hashes = orderedHashes();
  let precise = true;
  if (!hashes.length) { rawHtmlScan(); hashes = orderedHashes(); precise = false; }
  if (viewedOnly) hashes = hashes.filter(h => viewedHashes.has(h));
  return { urls: hashes.slice(0, MAX_PHOTOS).map(h => registry.get(h).url), precise };
}

// How many photos Zillow says the listing has — so the panel can tell you
// when there's more to capture than we've seen ("See all 41 photos").
function claimedPhotoCount() {
  const m = document.body.innerText.match(/See all (\d+) photos|(\d+)\s+photos\b/i);
  return m ? Number(m[1] || m[2]) : 0;
}

// The listing address — lets the dashboard preselect the matching deal.
function listingAddress() {
  const meta = document.querySelector('meta[property="og:title"]');
  if (meta && meta.content) return meta.content.split("|")[0].trim();
  const h1 = document.querySelector("h1");
  return h1 ? h1.textContent.trim() : "";
}

// Zillow is a SPA: clicking a nearby home swaps the listing without a page
// load. Everything keyed to the old listing must reset or its photos bleed
// into the new one's send.
function resetIfListingChanged() {
  const zpid = zpidFromUrl();
  if (zpid === currentZpid) return;
  currentZpid = zpid;
  registry.clear();
  canonicalOrder = [];
  viewedHashes.clear();
  regSeq = 0;
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
    const total = orderedHashes().length;
    const viewed = selection(true).urls.length;
    const claimed = claimedPhotoCount();
    count.innerHTML = `👁 <b>${viewed}</b> of ${total || "?"} photo${total === 1 ? "" : "s"} viewed`;
    sendViewed.textContent = viewed ? `📸 Send ${viewed} viewed` : "📸 Send viewed photos";
    sendViewed.style.opacity = viewed ? "1" : ".55";
    sendAll.textContent = total ? `Send all ${total} instead` : "";
    sendAll.style.display = total && total !== viewed ? "block" : "none";
    if (claimed > total) {
      status.textContent = `Zillow lists ${claimed} photos — open the gallery and scroll to capture the other ${claimed - total}.`;
    } else if (!viewed) {
      status.textContent = "Scroll the photos you want — only those get sent.";
    } else if (/^(Zillow lists|Scroll)/.test(status.textContent)) {
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
harvestNextData();
// Sweep the DOM for rendered photos + what's on screen; refresh the panel
// when anything new lands.
setInterval(() => {
  resetIfListingChanged();
  if (samplePage()) onViewedChange();
}, 600);
// Re-harvest page data until hydration settles (and after SPA navigations).
setInterval(() => { harvestNextData(); onViewedChange(); }, 4000);
// Re-mount if Zillow swaps the page body out.
new MutationObserver(() => mountPanel()).observe(document.documentElement, { childList: true, subtree: true });
