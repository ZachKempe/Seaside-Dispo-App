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

// Same extraction as import-photos.js / the bookmarklet: group every CDN photo
// by its hash, keep the largest variant, drop UI thumbnails (<300px).
function grabPhotoUrls() {
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
    const urls = grabPhotoUrls();
    if (!urls.length) {
      btn.textContent = "No photos found on this page";
      setTimeout(() => { btn.textContent = "📸 Send photos to Seaside"; }, 2500);
      return;
    }
    // Scroll the carousel first for the full set: Zillow lazy-loads some
    // photos, so tell the user what we got and let them re-click after
    // opening the gallery if they expected more.
    btn.textContent = `Sending ${urls.length} photos…`;
    const hash = `#import-photos=${encodeURIComponent(urls.join("\n"))}&addr=${encodeURIComponent(listingAddress())}`;
    window.open(`${APP_ORIGIN}/dashboard.html${hash}`, "_blank", "noopener");
    setTimeout(() => { btn.textContent = `✓ Sent ${urls.length} — pick the deal in the new tab`; }, 400);
    setTimeout(() => { btn.textContent = "📸 Send photos to Seaside"; }, 6000);
  });

  document.body.appendChild(btn);
}

mountButton();
// Zillow is a SPA — re-mount if it swaps the page body out.
new MutationObserver(() => mountButton()).observe(document.documentElement, { childList: true, subtree: true });
