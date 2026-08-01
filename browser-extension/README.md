# Seaside Photo Grabber (Chrome extension)

Sends every hi-res photo from a Zillow listing straight into a deal's photo
gallery — one click, no downloading, no folders, no copy/paste.

## Why it works this way

Zillow refuses automated requests to its listing pages, so the app can't fetch
a listing server-side. Your browser, on a listing you opened normally, already
has every photo loaded — and Zillow's photo CDN serves those image URLs to
anyone. This extension reads the URLs off the page you're looking at and hands
them to the dashboard, which downloads them into the gallery.

## Install (one time, ~30 seconds)

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and pick this `browser-extension` folder.
4. Done. It only runs on Zillow listing pages.

## Use

1. Open the Zillow listing for the property (the detail page, not search results).
2. Open the photo gallery and scroll through it once — Zillow lazy-loads
   photos, and this grabs whatever the page has loaded.
3. Click the gold **📸 Send photos to Seaside** button (bottom-right).
4. A dashboard tab opens with the deal preselected by address — confirm, and
   the photos import into that deal's gallery.

## Notes

- Zero permissions: no host access, no storage, no background worker. It reads
  the page you're on and opens a tab.
- If the site ever moves, edit `APP_ORIGIN` at the top of `content.js`.
- No-install fallback: each deal's Photo Gallery section on the dashboard has a
  drag-to-bookmarks **🧲 Grab Zillow Photos** bookmarklet that copies the same
  URLs to your clipboard for pasting into the import box.
- Listing photos are generally the listing agent's/photographer's property.
  Reusing them in your own marketing is a call to make per deal.
