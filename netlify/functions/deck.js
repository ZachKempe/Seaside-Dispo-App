// /deck/<slug>            -> rendered interactive deal page (logs a view)
// /deck/<slug>.pdf        -> 302 to the Storage PDF (back-compat with sent links)
// /deck/<slug>?format=pdf -> same 302
// Public by design; ?b=<token> attributes the view/interest to a buyer.
//
// REDESIGN NOTE: presentation was rebuilt (premium navy/gold template, money-forward
// hero, banner photo w/ Street View fallback, property-details section, sticky CTA).
// All data queries, token handling, view logging and interest posting are UNCHANGED.
// New dependency: ./lib/deck-photo.js  +  env GOOGLE_MAPS_API_KEY (optional).
const { verifyDeckToken, viewToken } = require("./lib/deck-token");
const {
  fmtMoney, buyerCashAtClose, subtoTermRows, morbyTermRows,
  subtoCarry, subtoRentOptions, subtoPrincipalPaydown, RESERVE_MONTHS,
} = require("../../public/js/deal-shared");
const { resolveDealPhotos } = require("./lib/deck-photo");
const { listGalleryPhotos } = require("./lib/gallery");
const { isBot } = require("./lib/bot-ua");
const { deckPdfExists, deckPdfStorageUrl } = require("./lib/deck-pdf");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://deals.seasidehorizon.com";
const REQUIRE_TOKEN = String(process.env.DECK_REQUIRE_TOKEN || "false") === "true";
// M11: same host as every link on the page — see the note in lib/blast-core.js.
const LOGO_URL = `${SITE_URL}/img/logo.png`;

// Brand palette
const NAVY = "#1B3A6B", NAVY_DARK = "#112950", GOLD = "#D4A03E", GOLD_LT = "#E8C878";
const PAPER = "#FBFAF6", INK = "#20304D", MUTED = "#8A94A6", LINE = "#EAE4D7";

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
// Exact row count via PostgREST HEAD + content-range. Fails soft to 0 so the
// activity strip simply hides if the query errors (e.g. migration not run yet).
async function sbCount(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1${path}`, {
      method: "HEAD",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact" },
    });
    const n = Number((r.headers.get("content-range") || "").split("/")[1]);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}
// Which channel this visit's link came from (?s=…). Whitelisted so a stray or
// crafted value can't pollute the rollups; anything unknown logs as "" and
// reads as "direct" (a copied/forwarded link).
const VIEW_SOURCES = new Set(["sms", "email", "dm"]);
function viewSource(s) {
  const v = String(s || "").toLowerCase();
  return VIEW_SOURCES.has(v) ? v : "";
}
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Only an absolute http(s) URL can be an og:image — a scraper has no page
// context to resolve a relative path against, and a broken image renders worse
// than no card at all.
function absUrl(u) {
  return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
}
// The Open Graph / Twitter card a forwarded deck link unfurls into. Returns ""
// when `meta` is null, so the 404, error and token-gated pages stay card-less
// rather than advertising a deal that isn't there.
function shareTags(meta) {
  if (!meta) return "";
  const title = meta.title || "";
  const desc = String(meta.description || "");
  const img = absUrl(meta.image);
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Seaside Horizon">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    // summary_large_image only earns the big card when there IS an image;
    // claiming it without one renders as an empty box in several clients.
    `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">`,
  ];
  if (desc) tags.push(
    `<meta name="description" content="${esc(desc)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
  );
  if (meta.url) tags.push(`<meta property="og:url" content="${esc(meta.url)}">`);
  if (img) tags.push(
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta property="og:image:alt" content="${esc(title)}">`,
    `<meta name="twitter:image" content="${esc(img)}">`,
  );
  return tags.join("\n") + "\n";
}
// `extraCss` is appended inside the same <style>. It exists so a rule only one
// deal type needs (the sub-to rent section) isn't emitted on pages that have no
// such element — which is what keeps Morby/Stack pages byte-identical.
//
// `meta` drives the link-preview card. Forwarding is a real distribution channel
// here — an untokenized hand-raise on a forwarded link becomes a buyer row in
// deck-interest.js — so a deck link that unfurls as a naked URL costs list
// growth. Only the rendered deal page passes it.
function page(title, body, extraCss = "", meta = null) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="${esc(LOGO_URL)}">
${shareTags(meta)}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&display=swap" rel="stylesheet">
<style>
 *{box-sizing:border-box}
 html,body{margin:0;padding:0}
 body{background:#E4DED2;color:${INK};font-family:Inter,system-ui,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;
   background-image:radial-gradient(circle at 50% 0%, #F1ECE2 0%, #E4DED2 60%, #DAD3C5 100%)}
 .wrap{max-width:600px;margin:0 auto;background:${PAPER};min-height:100vh;position:relative;overflow:hidden;
   box-shadow:0 30px 80px -30px rgba(17,41,80,.35);padding-bottom:150px}
 a{color:${NAVY};text-decoration:none}
 ::selection{background:${GOLD};color:${NAVY_DARK}}
 @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
 @keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(31,122,84,.45)}50%{box-shadow:0 0 0 5px rgba(31,122,84,0)}}
 dialog{border:none;background:transparent;padding:0;max-width:600px;width:100%;margin:auto auto 0}
 dialog::backdrop{background:rgba(17,41,80,.5);backdrop-filter:blur(3px)}
 .sheet{background:${PAPER};border-radius:22px 22px 0 0;padding:26px 24px calc(26px + env(safe-area-inset-bottom));box-shadow:0 -20px 60px rgba(17,41,80,.4);animation:rise .18s ease}
 .sheet input{width:100%;padding:14px 15px;margin-bottom:10px;border:1px solid #D8CFB8;border-radius:11px;font-size:15px;font-family:Inter,sans-serif;background:#fff}
 .sheet input:focus{border-color:${GOLD};outline:none}
 @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
 .banner-blur{display:none}
 /* ---- Desktop (≥1100px): full-screen split layout — photo fills the left half,
    content on the right. Everything below 1100px is untouched (mobile design). ---- */
 @media(min-width:1100px){
  .wrap{max-width:none;display:grid;grid-template-columns:46% 54%;align-content:start;overflow:visible;box-shadow:none;padding-bottom:200px}
  .wrap>*{grid-column:2}
  .wrap>.banner{position:fixed!important;top:0;left:0;width:46%;height:100vh!important;box-shadow:34px 0 70px -34px rgba(17,41,80,.45)}
  .banner-blur{display:block;position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scale(1.12);filter:blur(26px) saturate(1.15) brightness(.82)}
  .banner-img{object-fit:contain!important}
  .banner h1{font-size:clamp(36px,3.2vw,50px)!important}
  .banner-inner{padding:42px 48px!important;gap:13px!important}
  .topbar{padding:20px 44px!important}
  .greeting{padding:24px 0 0!important;margin:0 auto!important;width:calc(100% - 96px);max-width:700px}
  .hero-card{margin:30px auto 0!important;width:calc(100% - 96px);max-width:700px;padding:40px 36px 34px!important}
  .money{font-size:76px!important}
  .activity{margin:16px auto 0!important;width:calc(100% - 96px);max-width:700px}
  .photos-sec{margin:26px auto 0!important;width:calc(100% - 96px);max-width:700px}
  .terms-sec{margin:26px auto 0!important;width:calc(100% - 96px);max-width:700px}
  .term-cell{padding:17px 22px!important}
  .term-cell .term-v{font-size:19px!important}
  .term-cell:last-child:nth-child(odd){grid-column:1/-1}
  .contact-sec{margin:24px auto 0!important;width:calc(100% - 96px);max-width:700px}
  .foot{max-width:700px;margin:0 auto}
  .action-bar{left:46%!important;padding-left:48px!important;padding-right:48px!important}
  .action-bar>div{max-width:700px!important}
  dialog{margin:auto}
  .sheet{border-radius:22px}
 }
${extraCss}</style></head><body>${body}</body></html>`;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let slug = (q.slug || "").trim();
  if (!slug) {
    const m = String(event.path || event.rawUrl || "").match(/\/deck\/([^/?#]+)/i);
    if (m) slug = decodeURIComponent(m[1]).trim();
  }
  const wantsPdf = q.format === "pdf" || /\.pdf$/i.test(slug);
  slug = slug.replace(/\.pdf$/i, "");
  const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "");

  if (wantsPdf) {
    if (!cleanSlug || !SB_URL) return { statusCode: 404, body: "Not found" };
    // H3 — resolve the object BEFORE doing anything else. This route is linked
    // from already-sent email, so a missing PDF must not dead-end: fall through
    // to the deal page instead, carrying ?b= and ?s= so the visit still
    // attributes to the buyer and the channel it came from.
    //
    // Nothing is logged on that path. A kind='pdf' row is supposed to mean
    // "an investor downloaded the deck" — it feeds engagementScore (+5, and
    // the "call today" strip) and the page's own "N PDF downloads" chip. Both
    // used to be inflated by clicks that downloaded nothing at all.
    //
    // Relative on purpose: SITE_URL is one fixed host, but a visitor can arrive
    // on any of them (deals.seasidehorizon.com, the netlify.app subdomain that
    // still serves old links, a preview). A relative Location keeps them
    // wherever they already are instead of bouncing them across domains
    // mid-click (same instinct as M11).
    if (!(await deckPdfExists(cleanSlug))) {
      const carry = [q.b ? `b=${encodeURIComponent(q.b)}` : "", q.s ? `s=${encodeURIComponent(q.s)}` : ""]
        .filter(Boolean).join("&");
      return { statusCode: 302, headers: { Location: `/deck/${cleanSlug}${carry ? `?${carry}` : ""}` }, body: "" };
    }
    // Log the download (fail-soft) so the deal page can show a real PDF-download
    // count. Scrapers still get the redirect, they just don't count as downloads.
    const pdfUa = (event.headers["user-agent"] || "").slice(0, 300);
    if (!isBot(pdfUa)) {
      try {
        const p = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=card_id&limit=1`);
        if (p && p[0]) {
          const row = { card_id: p[0].card_id, buyer_id: verifyDeckToken(q.b) || null, kind: "pdf", user_agent: pdfUa };
          const logPdf = (r) => sb(`/deck_views`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(r) });
          // Retry without `source` if migration 030 hasn't run yet.
          try { await logPdf({ ...row, source: viewSource(q.s) }); }
          catch (e) { await logPdf(row); }
        }
      } catch (e) { console.warn("pdf download log failed:", e.message); }
    }
    return { statusCode: 302, headers: { Location: deckPdfStorageUrl(cleanSlug) }, body: "" };
  }
  if (!cleanSlug) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">Deal not found.</div></div>`) };

  try {
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=*&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">This deal is no longer available.</div></div>`) };

    const cardId = prop.card_id;
    const encCard = encodeURIComponent(cardId);
    const iso = (ms) => encodeURIComponent(new Date(Date.now() - ms).toISOString());
    // Counts run BEFORE this visitor's own view is logged, so they only reflect others.
    const [termsRows, morbyRows, acqRows, statusRows, views24, views7d, pdfCount, gallery, hasPdf] = await Promise.all([
      sb(`/deal_terms?card_id=eq.${encCard}&select=*&limit=1`),
      sb(`/morby_deals?card_id=eq.${encCard}&select=*&limit=1`),
      sb(`/deal_acquisition?card_id=eq.${encCard}&select=cover_image_url&limit=1`),
      sb(`/property_status?card_id=eq.${encCard}&select=status&limit=1`),
      sbCount(`/deck_views?card_id=eq.${encCard}&kind=eq.view&viewed_at=gte.${iso(24 * 3600e3)}`),
      sbCount(`/deck_views?card_id=eq.${encCard}&kind=eq.view&viewed_at=gte.${iso(7 * 24 * 3600e3)}`),
      sbCount(`/deck_views?card_id=eq.${encCard}&kind=eq.pdf`),
      listGalleryPhotos(cardId), // fails soft to []
      // H3 — is there actually a PDF to offer? Rides along in this batch so the
      // gate costs no extra round-trip on the render path.
      deckPdfExists(cleanSlug),
    ]);
    const terms = (termsRows || [])[0] || {};
    const morby = (morbyRows || [])[0] || {};
    const cover = ((acqRows || [])[0] || {}).cover_image_url || "";
    const status = (((statusRows || [])[0] || {}).status || "active").toLowerCase();
    const isMorby = prop.deal_type === "morby";
    const address = prop.address_override || prop.name || "Deal";
    const street = address.split(",")[0].trim();
    const cityLine = address.split(",").slice(1).join(",").trim();

    // Buyer / token
    const buyerId = verifyDeckToken(q.b);
    let buyer = null;
    if (buyerId) {
      const b = await sb(`/buyers?id=eq.${buyerId}&select=id,name&limit=1`);
      buyer = b && b[0];
    }
    if (REQUIRE_TOKEN && !buyerId) {
      return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: page(address, `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">Please use the link from your email or text to view this deal.</div></div>`) };
    }

    // View log. We wait for the row id so the page can report dwell time to
    // deck-dwell.js on exit; if the insert fails the page still renders, just
    // without dwell tracking.
    //
    // Bots are skipped: every forwarded link gets fetched by a preview scraper
    // before a human ever opens it, and those fetches would land in the same
    // counts the page shows buyers as social proof. A skipped log leaves viewId
    // null, which the dwell script already treats as "no tracking" — and bots
    // don't run it anyway.
    let viewId = null;
    if (!isBot(event.headers["user-agent"])) {
      const base = { card_id: cardId, buyer_id: buyerId || null, user_agent: (event.headers["user-agent"] || "").slice(0, 300) };
      const logView = async (row) => {
        const vRows = await sb(`/deck_views`, { method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify(row) });
        return vRows && vRows[0] && vRows[0].id;
      };
      try {
        viewId = await logView({ ...base, source: viewSource(q.s) });
      } catch (e) {
        // `source` column missing (030 not run yet) — log without it.
        try { viewId = await logView(base); }
        catch (e2) { console.warn("deck_view log failed:", e2.message); }
      }
    }

    // ---- Photos (gallery -> cover -> listing -> auto Street View/aerial -> none) ----
    const { photos, hero: heroPhoto, source: photoSource } = await resolveDealPhotos(prop, cover, address, gallery);
    const hasGallery = photos.length > 1;
    // Downloads are offered only for real uploaded photos in our own Storage:
    // those URLs support `?download=` (Content-Disposition, which is what makes
    // a cross-origin save work) and send CORS headers so the page can zip them.
    // Google's auto Street View/aerial imagery does neither, and isn't the
    // property's own photography to hand out.
    const canDownload = photoSource === "gallery"
      && photos.every(p => p.url.includes("/storage/v1/object/public/"));

    // ---- Presentation ----
    const canInterest = status === "active";
    const statusLabel = status === "active" ? "Available" : (["pending", "under_contract"].includes(status) ? "Pending" : "Sold");
    const badge = status === "active"
      ? `<span style="display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#1F7A54;background:#E4F4EC;border:1px solid #B7E3CC;padding:5px 11px;border-radius:999px"><span style="width:6px;height:6px;border-radius:50%;background:#1F7A54;box-shadow:0 0 0 3px rgba(31,122,84,.18)"></span>${statusLabel}</span>`
      : `<span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8A6D1F;background:#FaF3DC;border:1px solid #EAD9A0;padding:5px 11px;border-radius:999px">${statusLabel}</span>`;

    const dealTypeLabel = isMorby ? "Seller Finance · Stack Method" : "Subject-To Deal";
    const mapHref = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(address);

    const bannerBg = heroPhoto ? `` : `background:linear-gradient(150deg,${NAVY_DARK} 0%,${NAVY} 45%,#20406f 100%);`;
    const banner = `
      <div class="banner" style="position:relative;height:230px;overflow:hidden;${bannerBg}">
        ${heroPhoto ? `<img class="banner-blur" src="${esc(heroPhoto)}" alt="" aria-hidden="true"><img class="banner-img" src="${esc(heroPhoto)}" alt="${esc(address)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ""}
        ${!heroPhoto ? `<div style="position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent 0,transparent 33px,rgba(255,255,255,.04) 33px,rgba(255,255,255,.04) 34px),repeating-linear-gradient(90deg,transparent 0,transparent 33px,rgba(255,255,255,.04) 33px,rgba(255,255,255,.04) 34px)"></div>` : ""}
        ${photoSource === "streetview" ? `<span style="position:absolute;top:12px;right:12px;font-size:10px;font-weight:600;color:#fff;background:rgba(17,41,80,.6);border:1px solid rgba(255,255,255,.25);padding:4px 9px;border-radius:6px">Street View · Google</span>` : ""}
        <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(17,41,80,.15) 0%,rgba(17,41,80,.35) 55%,rgba(17,41,80,.88) 100%)"></div>
        <div class="banner-inner" style="position:absolute;left:0;right:0;bottom:0;padding:22px 24px;display:flex;flex-direction:column;gap:9px">
          <span style="align-self:flex-start;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY_DARK};background:${GOLD_LT};padding:4px 10px;border-radius:4px">${esc(dealTypeLabel)}</span>
          <h1 style="margin:0;font-family:'Source Serif 4',Georgia,serif;font-weight:600;font-size:29px;line-height:1.1;color:#fff;letter-spacing:-.01em;text-shadow:0 2px 18px rgba(0,0,0,.35)">${esc(street)}</h1>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            ${cityLine ? `<div style="display:flex;align-items:center;gap:7px;color:#D9E2F0;font-size:14px;font-weight:500"><span style="width:5px;height:5px;border-radius:50%;background:${GOLD};box-shadow:0 0 0 3px rgba(212,160,62,.25)"></span>${esc(cityLine)}</div>` : ""}
            <a href="${esc(mapHref)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);padding:6px 12px;border-radius:999px">📍 View on map</a>
            ${hasGallery ? `<button type="button" id="galleryBtn" style="display:inline-flex;align-items:center;gap:6px;font:700 12.5px Inter,sans-serif;color:${NAVY_DARK};background:${GOLD_LT};border:none;padding:7px 13px;border-radius:999px;cursor:pointer">📸 ${photos.length} photos</button>` : ""}
          </div>
        </div>
      </div>`;

    // Money hero
    let heroLabel, heroValue, heroSub;
    if (isMorby) {
      const cash = buyerCashAtClose(morby);
      heroLabel = "Estimated Cash to You at Close";
      heroValue = cash > 0 ? "~$" + Math.round(cash).toLocaleString() : "—";
      heroSub = "This is the cash you're estimated to receive at the closing table — before a dollar of your own goes in.";
    } else {
      const fee = Number(terms.entry_fee) || 0;
      heroLabel = "Entry Fee to Take Over";
      heroValue = fee ? "$" + fee.toLocaleString() : "Ask";
      heroSub = "What it takes to step into this position, plus transaction and closing costs.";
    }
    const heroCard = `
      <div class="hero-card" style="margin:22px 20px 0;background:#fff;border:1px solid ${LINE};border-radius:18px;padding:30px 26px 26px;text-align:center;position:relative;overflow:hidden;box-shadow:0 18px 40px -26px rgba(17,41,80,.4)">
        <div style="position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,${GOLD},${GOLD_LT},${GOLD})"></div>
        <div style="font-size:11.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${MUTED}">${esc(heroLabel)}</div>
        <div class="money" style="margin:10px 0 0;font-weight:800;font-size:60px;line-height:.95;color:${NAVY};letter-spacing:-.03em;font-variant-numeric:tabular-nums">${esc(heroValue)}</div>
        <p style="margin:16px 4px 0;font-size:13.5px;line-height:1.5;color:#718096">${esc(heroSub)}</p>
      </div>`;

    // Activity strip — real engagement counts only (no fabricated numbers).
    // Hides entirely when a deal is too quiet to be persuasive.
    const chipStyle = `display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#5A6B85;background:#fff;border:1px solid ${LINE};padding:7px 13px;border-radius:999px;box-shadow:0 6px 16px -12px rgba(17,41,80,.4)`;
    const pulseDot = `<span style="width:7px;height:7px;border-radius:50%;background:#1F7A54;animation:glow 1.8s ease-in-out infinite"></span>`;
    const chips = [];
    if (views24 >= 2) chips.push(`<span style="${chipStyle}">${pulseDot}<b style="color:${INK};font-weight:800">${views24}</b>&nbsp;views in the last 24 hours</span>`);
    else if (views7d >= 3) chips.push(`<span style="${chipStyle}">${pulseDot}<b style="color:${INK};font-weight:800">${views7d}</b>&nbsp;views this week</span>`);
    // Gated on the file existing, not just on the count: before H3 every click
    // of the always-on PDF button logged a download even when there was no PDF
    // to download, so on a Sub-To deck this chip counted nothing but dead-link
    // taps. Honest social proof is the point of this strip — a count we can no
    // longer stand behind doesn't get shown.
    if (hasPdf && pdfCount >= 2) chips.push(`<span style="${chipStyle}">📄&nbsp;<b style="color:${INK};font-weight:800">${pdfCount}</b>&nbsp;PDF downloads</span>`);
    const activity = chips.length ? `
      <div class="activity" style="margin:14px 20px 0;display:flex;justify-content:center;align-items:center;gap:9px;flex-wrap:wrap">${chips.join("")}</div>` : "";

    // Photo strip — tap any thumb (or the banner 📸 pill) for the full-screen
    // gallery. Auto Street View/aerial imagery is labeled as such.
    const photosSec = hasGallery ? `
      <div class="photos-sec" style="margin:24px 20px 0">
        <div style="display:flex;align-items:center;gap:10px;margin:0 4px 12px">
          <span style="font-size:11.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY}">Photos</span>
          <span style="flex:1;height:1px;background:linear-gradient(90deg,#E0D9C9,transparent)"></span>
          ${photoSource === "streetview" ? `<span style="font-size:10.5px;font-weight:600;color:${MUTED}">Street View &amp; aerial · Google</span>` : `<span style="font-size:11px;font-weight:700;color:${NAVY}">${photos.length} photos</span>`}
          ${canDownload ? `<button type="button" id="dlAllBtn" style="font:700 11.5px Inter,sans-serif;color:${NAVY};background:#fff;border:1px solid #D8CFB8;border-radius:9px;padding:6px 11px;cursor:pointer;white-space:nowrap">⬇ Download all</button>` : ""}
        </div>
        <div style="display:grid;grid-auto-flow:column;grid-auto-columns:132px;gap:9px;overflow-x:auto;padding:2px 2px 8px;-webkit-overflow-scrolling:touch;scrollbar-width:thin">
          ${photos.map((p, i) => `<img class="gph" data-idx="${i}" src="${esc(p.url)}" alt="${esc(p.name || address)}" loading="lazy" style="width:132px;height:96px;object-fit:cover;border-radius:11px;border:1px solid ${LINE};cursor:pointer;box-shadow:0 8px 18px -14px rgba(17,41,80,.5)">`).join("")}
        </div>
      </div>` : "";

    // Deal terms grid
    const rows = isMorby ? morbyTermRows(morby) : subtoTermRows(terms);
    const termsSec = rows.length ? `
      <div class="terms-sec" style="margin:24px 20px 0">
        <div style="display:flex;align-items:center;gap:10px;margin:0 4px 12px"><span style="font-size:11.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY}">Deal Terms</span><span style="flex:1;height:1px;background:linear-gradient(90deg,#E0D9C9,transparent)"></span></div>
        <div style="background:#fff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;display:grid;grid-template-columns:1fr 1fr">
          ${rows.map(([k, v]) => `<div class="term-cell" style="padding:15px 18px;border-bottom:1px solid #F0EBDF;border-right:1px solid #F0EBDF"><div style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#94A0B2;margin-bottom:5px">${esc(k)}</div><div class="term-v" style="font-size:17px;font-weight:700;color:${INK};letter-spacing:-.01em;font-variant-numeric:tabular-nums">${esc(v)}</div></div>`).join("")}
        </div>
      </div>` : "";

    // ── "How you can rent it" — sub-to only ──────────────────────────
    // The strategies that actually work at this property, each netted against
    // the same carry. Blocked strategies render too (greyed, with the reason):
    // they are content, not omissions — proof the CC&Rs were read. Rents with
    // no source never appear in any form.
    //
    // Wrapped whole: nothing in here may take down a deal page. On any throw we
    // log and drop the section, and the page renders exactly as it did before.
    let rentSec = "";
    if (!isMorby) {
      try {
        const rentOpts = subtoRentOptions(terms);
        if (rentOpts.length) {
          const carry = subtoCarry(terms);
          const live = rentOpts.filter(o => !o.blockedReason);
          const blocked = rentOpts.filter(o => o.blockedReason);
          const carryTxt = `${fmtMoney(carry.total)}/mo`;
          // A real minus sign, and never a hidden negative.
          const money = (n) => (n < 0 ? `−$${Math.abs(n).toLocaleString()}` : `$${Number(n).toLocaleString()}`);
          const GREEN = "#1F7A54", RED = "#B4541F", AMBER = "#8A6D1F";

          const subhead = !live.length
            ? "Rental use is restricted here — this is exactly what the HOA and the municipality allow."
            : live.length === 1
              ? `1 strategy works at this property. Nets against the ${carryTxt} carry.`
              : `${live.length} strategies work at this property. Each nets against the same ${carryTxt} carry.`;

          const warnLine = (o) => o.warning
            ? `<div style="margin-top:7px;font-size:11px;font-weight:600;color:${AMBER}">⚠ ${esc(o.warning)}</div>` : "";
          const cashLine = (o) =>
            `<div style="margin-top:4px;font-size:11.5px;color:#5A6B85">Cash in ~$${o.cashIn.toLocaleString()}${o.furnishing > 0 ? " incl. furnishing" : ""}</div>`;
          // Two-line clamp on the source: long citations shrink on screen, the
          // stored text is never truncated.
          const sourceLine = (o) =>
            `<div style="margin-top:4px;font-size:11px;line-height:1.4;color:${MUTED};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(o.source)}</div>`;

          const liveCard = (o) => `
            <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:14px 15px;box-shadow:0 10px 24px -20px rgba(17,41,80,.45)">
              <div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${NAVY}">${esc(o.label)}</div>
              <div style="margin-top:7px;font-weight:800;font-size:25px;line-height:1;color:${INK};letter-spacing:-.02em;font-variant-numeric:tabular-nums">$${o.rent.toLocaleString()}<span style="font-size:12.5px;font-weight:600;color:${MUTED}">/mo</span></div>
              ${sourceLine(o)}
              <div style="margin-top:4px;font-size:11px;color:${MUTED}">Less carry and ${o.loadPct}% load</div>
              <div style="height:1px;background:#F0EBDF;margin:11px 0 9px"></div>
              <div style="font-size:15px;font-weight:800;color:${o.net >= 0 ? GREEN : RED};font-variant-numeric:tabular-nums">Net ${money(o.net)}<span style="font-size:11.5px;font-weight:600;color:${MUTED}">/mo</span></div>
              ${cashLine(o)}
              ${warnLine(o)}
            </div>`;

          const blockedCard = (o) => `
            <div style="background:#FCFAF5;border:1px dashed #DFD6C2;border-radius:14px;padding:14px 15px;opacity:.75">
              <div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${MUTED}">${esc(o.label)}</div>
              <div style="margin-top:7px;font-weight:700;font-size:16px;line-height:1.2;color:${MUTED}">Not available</div>
              <div style="margin-top:8px;font-size:11.5px;font-weight:600;line-height:1.45;color:${AMBER}">🔒 ${esc(o.blockedReason)}</div>
            </div>`;

          // One live option and nothing blocked reads as a lone card marooned
          // in a grid — render it as a full-width row instead.
          const soleRow = (o) => `
            <div style="background:#fff;border:1px solid ${LINE};border-radius:14px;padding:15px 17px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;box-shadow:0 10px 24px -20px rgba(17,41,80,.45)">
              <div style="flex:1;min-width:150px">
                <div style="font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${NAVY}">${esc(o.label)}</div>
                <div style="margin-top:6px;font-weight:800;font-size:25px;line-height:1;color:${INK};letter-spacing:-.02em;font-variant-numeric:tabular-nums">$${o.rent.toLocaleString()}<span style="font-size:12.5px;font-weight:600;color:${MUTED}">/mo</span></div>
                ${sourceLine(o)}
                <div style="margin-top:4px;font-size:11px;color:${MUTED}">Less carry and ${o.loadPct}% load</div>
              </div>
              <div style="text-align:right;min-width:130px">
                <div style="font-size:19px;font-weight:800;color:${o.net >= 0 ? GREEN : RED};font-variant-numeric:tabular-nums">Net ${money(o.net)}<span style="font-size:12px;font-weight:600;color:${MUTED}">/mo</span></div>
                ${cashLine(o)}
              </div>
              ${o.warning ? `<div style="flex-basis:100%;font-size:11px;font-weight:600;color:${AMBER}">⚠ ${esc(o.warning)}</div>` : ""}
            </div>`;

          const grid = (live.length === 1 && !blocked.length)
            ? soleRow(live[0])
            : `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px">
                 ${live.map(liveCard).join("")}${blocked.map(blockedCard).join("")}
               </div>`;

          // Bands. Every-net-negative replaces the paydown band outright: a
          // deal that doesn't cash-flow should say so in its own words rather
          // than lead with equity.
          const allNegative = live.length > 0 && live.every(o => o.net < 0);
          const paydown = subtoPrincipalPaydown(terms);
          let band = "";
          if (allNegative) {
            band = `<div style="margin-top:12px;background:#FaF3DC;border:1px solid #EAD9A0;border-radius:12px;padding:12px 14px;font-size:12.5px;line-height:1.5;color:${AMBER};font-weight:600">This is a negative-carry deal — the case here is equity capture and the assumed rate, not monthly cash flow.</div>`;
          } else if (paydown && live.length) {
            const subj = live.length === 1 ? "This strategy" : live.length === 2 ? "Either strategy" : "Every strategy";
            band = `<div style="margin-top:12px;background:#E4F4EC;border:1px solid #B7E3CC;border-radius:12px;padding:12px 14px;font-size:12.5px;line-height:1.5;color:${GREEN};font-weight:600">${subj} also builds ~$${paydown.toLocaleString()}/mo in principal paydown on the assumed loan.</div>`;
          }

          const loadNote = rentOpts.map(o => `${o.label.toLowerCase()} ${o.loadPct}%`).join(", ");
          // The furnishing clauses only make sense when a furnished strategy is
          // actually on the page — on an LTR-only deal they're noise.
          const hasFurnished = rentOpts.some(o => o.mode !== "ltr");
          const foot = `<div style="margin-top:10px;font-size:11px;line-height:1.55;color:#A6AEBC">
              Load covers vacancy, maintenance, capex and management (${esc(loadNote)} of rent)${hasFurnished ? "; furnished stays also carry turnover and utilities" : ""}.
              Cash in assumes the entry fee, closing costs, ${RESERVE_MONTHS} months of carry${rentOpts.some(o => o.furnishing > 0) ? " and furnishing" : ""}.
              All figures are estimates for evaluation and should be independently verified.
            </div>`;

          rentSec = `
            <div class="rent-sec" style="margin:24px 20px 0">
              <div style="display:flex;align-items:center;gap:10px;margin:0 4px 6px"><span style="font-size:11.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY}">How you can rent it</span><span style="flex:1;height:1px;background:linear-gradient(90deg,#E0D9C9,transparent)"></span></div>
              <div style="margin:0 4px 12px;font-size:12.5px;line-height:1.5;color:#718096">${esc(subhead)}</div>
              ${grid}
              ${band}
              ${foot}
            </div>`;
        }
      } catch (e) {
        console.warn("rent section skipped:", e.message);
        rentSec = "";
      }
    }

    // Contact
    const cName = process.env.MARKETING_CONTACT_NAME || "Seaside Horizon";
    const cPhone = process.env.MARKETING_CONTACT_PHONE || "";
    const telHref = "tel:" + cPhone.replace(/[^0-9+]/g, "");
    const contactSec = `
      <div class="contact-sec" style="margin:22px 20px 0;display:flex;align-items:center;gap:14px;padding:16px 18px;background:#F4F1E8;border:1px solid ${LINE};border-radius:14px">
        <div style="width:42px;height:42px;border-radius:50%;background:${NAVY};color:${GOLD_LT};display:flex;align-items:center;justify-content:center;font-family:'Source Serif 4',serif;font-weight:600;font-size:18px;flex-shrink:0">${esc((cName.trim()[0] || "S").toUpperCase())}</div>
        <div style="line-height:1.35"><div style="font-size:14px;font-weight:700;color:${INK}">${esc(cName)}</div><div style="font-size:12.5px;color:${MUTED}">Your Seaside acquisitions contact</div></div>
        ${cPhone ? `<a href="${esc(telHref)}" style="margin-left:auto;font-size:13px;font-weight:700;color:${NAVY};border:1px solid #D8CFB8;background:#fff;padding:9px 14px;border-radius:10px;white-space:nowrap">${esc(cPhone)}</a>` : ""}
      </div>`;

    const greeting = buyer && buyer.name
      ? `<p class="greeting" style="margin:0;padding:18px 24px 0;font-size:15px;color:#4A5568">Hi ${esc(String(buyer.name).split(/\s+/)[0])}, here's the full deal.</p>`
      : "";

    // H3 — only offered when the file is really there. Sub-To decks have no
    // generated PDF (only a Morby/Stack blast uploads one), so this button used
    // to send those investors to a raw Storage 404. Linked through our own
    // /deck/<slug>.pdf route, not straight to Storage, so the download still
    // logs a deck_views row and stays attributed.
    const pdfBtn = hasPdf
      ? `<a href="${SITE_URL}/deck/${esc(cleanSlug)}.pdf" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:${NAVY};background:#fff;border:1px solid #D8CFB8;border-radius:13px;padding:0 18px;white-space:nowrap">PDF</a>`
      : "";
    const callBtn = cPhone ? `<a href="${esc(telHref)}" style="display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;background:${NAVY};border-radius:13px;padding:0 20px;white-space:nowrap">Call</a>` : "";

    const actionBar = canInterest
      ? `<div class="action-bar" style="position:fixed;left:0;right:0;bottom:0;background:rgba(251,250,246,.9);backdrop-filter:blur(12px);border-top:1px solid #E7E1D3;padding:13px 20px calc(13px + env(safe-area-inset-bottom));box-shadow:0 -12px 30px -18px rgba(17,41,80,.3)">
           <div style="max-width:600px;margin:0 auto">
             <div class="inner" style="display:flex;gap:11px;align-items:stretch">
               <button class="primary" id="interestBtn" style="flex:1;font:800 16px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border:none;border-radius:13px;padding:16px;cursor:pointer;box-shadow:0 8px 20px -8px rgba(212,160,62,.7)">I'm interested</button>
               ${callBtn}${pdfBtn}
             </div>
             <div style="text-align:center;font-size:11px;color:#A6AEBC;margin-top:9px">No obligation — this just tells us to send you the full details. · <a href="#" id="offerLink" style="color:${NAVY};font-weight:700;text-decoration:underline">Have a number? Make an offer</a></div>
           </div>
         </div>`
      : `<div class="action-bar" style="position:fixed;left:0;right:0;bottom:0;background:rgba(251,250,246,.9);backdrop-filter:blur(12px);border-top:1px solid #E7E1D3;padding:13px 20px calc(13px + env(safe-area-inset-bottom))">
           <div style="max-width:600px;margin:0 auto;display:flex;gap:11px"><div style="flex:1;text-align:center;font:700 14px Inter,sans-serif;color:#8A6D1F;background:#FaF3DC;border:1px solid #EAD9A0;border-radius:13px;padding:15px">This deal is ${status === "sold" || status === "closed" ? "sold" : "pending"}</div>${callBtn}${pdfBtn}</div>
         </div>`;

    const dialog = `
      <dialog id="dlg"><div class="sheet">
        <div style="width:40px;height:4px;border-radius:2px;background:#DDD5C4;margin:0 auto 18px"></div>
        <div id="dlgTitle" style="font-family:'Source Serif 4',serif;font-size:21px;font-weight:600;color:${INK};margin-bottom:4px">Great — how should we reach you?</div>
        <div id="dlgSub" style="font-size:13.5px;color:${MUTED};margin-bottom:16px">We'll text you the full details on ${esc(street)}.</div>
        <input id="dlgAmount" inputmode="numeric" placeholder="Your offer — e.g. 250000" style="display:none">
        <input id="dlgName" placeholder="Your name" autocomplete="name">
        <input id="dlgContact" placeholder="Phone or email" autocomplete="tel" style="margin-bottom:16px">
        <div style="display:flex;gap:10px">
          <button class="ghost" id="dlgCancel" style="flex:1;font:700 15px Inter,sans-serif;color:${NAVY};background:#fff;border:1px solid #D8CFB8;border-radius:12px;padding:14px;cursor:pointer">Cancel</button>
          <button class="primary" id="dlgSend" style="flex:1.4;font:800 15px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border:none;border-radius:12px;padding:14px;cursor:pointer">Send it over</button>
        </div>
      </div></dialog>`;

    // Full-screen swipeable lightbox (vanilla, like everything else here).
    const galleryDialog = hasGallery ? `
      <dialog id="gdlg" style="max-width:100vw;width:100vw;height:100vh;max-height:100vh;margin:0;padding:0;background:transparent">
        <div style="position:fixed;inset:0;background:rgba(10,18,35,.96);display:flex;flex-direction:column">
          <div style="display:flex;align-items:center;padding:14px 18px">
            <span id="gcount" style="font:600 13px Inter,sans-serif;color:#C9D4E6"></span>
            ${canDownload ? `<a id="gdl" href="#" download style="margin-left:auto;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:10px;padding:8px 14px;font:700 14px Inter,sans-serif;cursor:pointer;text-decoration:none">⬇ Save photo</a>` : ""}
            <button type="button" id="gclose" style="${canDownload ? "margin-left:10px" : "margin-left:auto"};background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:10px;padding:8px 14px;font:700 14px Inter,sans-serif;cursor:pointer">✕ Close</button>
          </div>
          <div id="gmain" style="flex:1;display:flex;align-items:center;justify-content:center;min-height:0;position:relative;padding:0 4px">
            <button type="button" id="gprev" style="position:absolute;left:10px;top:50%;transform:translateY(-50%);z-index:2;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(17,41,80,.55);color:#fff;font-size:22px;line-height:1;cursor:pointer">‹</button>
            <img id="gimg" src="" alt="" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px">
            <button type="button" id="gnext" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);z-index:2;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:rgba(17,41,80,.55);color:#fff;font-size:22px;line-height:1;cursor:pointer">›</button>
          </div>
          <div id="gname" style="text-align:center;padding:12px 18px calc(14px + env(safe-area-inset-bottom));font:500 12.5px Inter,sans-serif;color:#8FA0BC"></div>
        </div>
      </dialog>` : "";

    const galleryScript = hasGallery ? `
        const PHOTOS = ${JSON.stringify(photos.map(p => ({ u: p.url, n: p.name || "" })))};
        let gIdx = 0;
        function gShow(i){
          gIdx = (i + PHOTOS.length) % PHOTOS.length;
          document.getElementById("gimg").src = PHOTOS[gIdx].u;
          document.getElementById("gcount").textContent = (gIdx + 1) + " / " + PHOTOS.length;
          document.getElementById("gname").textContent = PHOTOS[gIdx].n;
          var dl = document.getElementById("gdl");
          if (dl){ dl.href = dlUrl(gIdx); dl.setAttribute("download", dlName(gIdx)); }
        }
        function gOpen(i){ gShow(i); document.getElementById("gdlg").showModal(); }
        // Storage URLs honour ?download=<name> (Content-Disposition: attachment),
        // which is what makes a save work cross-origin — the HTML download
        // attribute alone is ignored for another origin and would just open it.
        function dlName(i){
          var ext = (PHOTOS[i].u.split("?")[0].match(/\\.(jpe?g|png|webp)$/i) || [".jpg"])[0];
          return SLUG + "-" + String(i + 1).padStart(2, "0") + ext;
        }
        function dlUrl(i){
          return PHOTOS[i].u + (PHOTOS[i].u.indexOf("?") >= 0 ? "&" : "?") + "download=" + encodeURIComponent(dlName(i));
        }
        document.querySelectorAll(".gph").forEach(el => el.addEventListener("click", () => gOpen(Number(el.dataset.idx) || 0)));
        const gBtn = document.getElementById("galleryBtn");
        if (gBtn) gBtn.addEventListener("click", () => gOpen(0));
        const bannerImg = document.querySelector(".banner-img");
        if (bannerImg){ bannerImg.style.cursor = "pointer"; bannerImg.addEventListener("click", () => gOpen(0)); }
        document.getElementById("gclose").addEventListener("click", () => document.getElementById("gdlg").close());
        document.getElementById("gprev").addEventListener("click", () => gShow(gIdx - 1));
        document.getElementById("gnext").addEventListener("click", () => gShow(gIdx + 1));
        document.getElementById("gdlg").addEventListener("keydown", (e) => {
          if (e.key === "ArrowLeft") gShow(gIdx - 1);
          if (e.key === "ArrowRight") gShow(gIdx + 1);
        });
        let gTouchX = null;
        const gMain = document.getElementById("gmain");
        gMain.addEventListener("touchstart", (e) => { gTouchX = e.changedTouches[0].clientX; }, { passive: true });
        gMain.addEventListener("touchend", (e) => {
          if (gTouchX == null) return;
          const dx = e.changedTouches[0].clientX - gTouchX;
          gTouchX = null;
          if (Math.abs(dx) > 40) gShow(gIdx + (dx < 0 ? 1 : -1));
        }, { passive: true });

        // ── Download all → one .zip ──────────────────────────────────────
        // Storage sends Access-Control-Allow-Origin:*, so the page can fetch
        // each photo and pack them itself. STORE (no compression) because
        // JPEGs are already compressed — that keeps this to a few dozen lines
        // instead of pulling in a zip library. Falls back to saving photos
        // individually if anything here fails.
        function crc32(u8){
          var c, n, k, T = crc32.T;
          if (!T){
            T = crc32.T = [];
            for (n = 0; n < 256; n++){
              c = n;
              for (k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
              T[n] = c >>> 0;
            }
          }
          c = 0xFFFFFFFF;
          for (n = 0; n < u8.length; n++) c = T[(c ^ u8[n]) & 0xFF] ^ (c >>> 8);
          return (c ^ 0xFFFFFFFF) >>> 0;
        }
        function zipStore(files){
          var enc = new TextEncoder(), parts = [], central = [], offset = 0;
          var w2 = function(a, v){ a.push(v & 255, (v >>> 8) & 255); };
          var w4 = function(a, v){ a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
          for (var i = 0; i < files.length; i++){
            var name = enc.encode(files[i].name), data = files[i].data, crc = crc32(data);
            var lh = [];
            w4(lh, 0x04034b50); w2(lh, 20); w2(lh, 0x0800); w2(lh, 0); w2(lh, 0); w2(lh, 0);
            w4(lh, crc); w4(lh, data.length); w4(lh, data.length); w2(lh, name.length); w2(lh, 0);
            var lhu = new Uint8Array(lh);
            parts.push(lhu, name, data);
            var ch = [];
            w4(ch, 0x02014b50); w2(ch, 20); w2(ch, 20); w2(ch, 0x0800); w2(ch, 0); w2(ch, 0); w2(ch, 0);
            w4(ch, crc); w4(ch, data.length); w4(ch, data.length);
            w2(ch, name.length); w2(ch, 0); w2(ch, 0); w2(ch, 0); w2(ch, 0); w4(ch, 0); w4(ch, offset);
            central.push(new Uint8Array(ch), name);
            offset += lhu.length + name.length + data.length;
          }
          var cdSize = 0;
          for (var j = 0; j < central.length; j++) cdSize += central[j].length;
          var eo = [];
          w4(eo, 0x06054b50); w2(eo, 0); w2(eo, 0); w2(eo, files.length); w2(eo, files.length);
          w4(eo, cdSize); w4(eo, offset); w2(eo, 0);
          return new Blob(parts.concat(central, [new Uint8Array(eo)]), { type: "application/zip" });
        }
        function saveBlob(blob, filename){
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
        }
        // Last resort: let the browser save them one by one (Storage's
        // ?download= makes each a real save rather than a navigation).
        function saveIndividually(){
          PHOTOS.forEach(function(_, i){
            setTimeout(function(){
              var a = document.createElement("a");
              a.href = dlUrl(i); a.download = dlName(i);
              document.body.appendChild(a); a.click(); a.remove();
            }, i * 350);
          });
        }
        var dlAll = document.getElementById("dlAllBtn");
        if (dlAll) dlAll.addEventListener("click", async function(){
          var label = dlAll.textContent;
          dlAll.disabled = true;
          try {
            var files = [];
            for (var i = 0; i < PHOTOS.length; i++){
              dlAll.textContent = "Preparing " + (i + 1) + "/" + PHOTOS.length + "…";
              var res = await fetch(PHOTOS[i].u, { mode: "cors" });
              if (!res.ok) throw new Error("fetch " + res.status);
              files.push({ name: dlName(i), data: new Uint8Array(await res.arrayBuffer()) });
            }
            dlAll.textContent = "Zipping…";
            saveBlob(zipStore(files), SLUG + "-photos.zip");
            dlAll.textContent = "✓ Downloaded";
          } catch (e) {
            dlAll.textContent = "Saving photos…";
            saveIndividually();
          }
          setTimeout(function(){ dlAll.textContent = label; dlAll.disabled = false; }, 3500);
        });` : "";

    const script = `
      <script>
        ${galleryScript}
        const HAS_BUYER = ${buyerId ? "true" : "false"};
        const SLUG = ${JSON.stringify(cleanSlug)};
        const TOKEN = ${JSON.stringify(q.b || "")};
        // ── Dwell tracking: accumulate visible time, beacon it out on exit ──
        const VIEW_TOKEN = ${JSON.stringify(viewId ? viewToken(viewId) : "")};
        let dwellStart = Date.now(), dwellAcc = 0, dwellSent = 0; // dwellStart null = paused
        function flushDwell(){
          if(dwellStart){ dwellAcc += Date.now() - dwellStart; dwellStart = null; }
          if(!VIEW_TOKEN || !navigator.sendBeacon) return;
          const secs = Math.min(1800, Math.round(dwellAcc / 1000));
          if(secs > dwellSent && secs >= 3){
            dwellSent = secs;
            navigator.sendBeacon("/.netlify/functions/deck-dwell", JSON.stringify({ v: VIEW_TOKEN, s: secs }));
          }
        }
        document.addEventListener("visibilitychange", () => {
          if(document.visibilityState === "hidden") flushDwell();
          else if(!dwellStart) dwellStart = Date.now();
        });
        window.addEventListener("pagehide", flushDwell);
        async function post(payload){
          const r = await fetch("/.netlify/functions/deck-interest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
          if(!r.ok) return null;
          try { return await r.json(); } catch(_) { return {}; }
        }
        // Only promise an email when one actually went out (res.receipt).
        function doneMsg(res,isOffer){
          if(isOffer) return res.receipt?"✓ Offer sent — the deal details are in your inbox":"✓ Offer sent — we\\'ll be in touch shortly";
          return res.receipt?"✓ Got it — the deal details are in your inbox":null;
        }
        function markDone(msg){
          const bar=document.querySelector(".inner");
          if(bar) bar.innerHTML='<div style="flex:1;text-align:center;font:800 15px Inter,sans-serif;color:#1F7A54;background:#E4F4EC;border:1px solid #B7E3CC;border-radius:13px;padding:15px">'+(msg||"✓ Got it — we\\'ll be in touch shortly")+'</div>';
        }
        let offerMode=false;
        function openDialog(asOffer){
          offerMode=asOffer;
          const amt=document.getElementById("dlgAmount");
          amt.style.display=asOffer?"block":"none";
          document.getElementById("dlgTitle").textContent=asOffer?"Make an offer":"Great — how should we reach you?";
          document.getElementById("dlgSub").textContent=asOffer
            ? "A soft number is fine — it just starts the conversation."
            : "We'll text you the full details on "+${JSON.stringify(street)}+".";
          // Tokenized buyers are already identified; only ask for the number.
          document.getElementById("dlgName").style.display=HAS_BUYER&&asOffer?"none":"block";
          document.getElementById("dlgContact").style.display=HAS_BUYER&&asOffer?"none":"block";
          document.getElementById("dlgSend").textContent=asOffer?"Send offer":"Send it over";
          document.getElementById("dlg").showModal();
        }
        const btn=document.getElementById("interestBtn");
        if(btn){
          btn.addEventListener("click", async ()=>{
            if(HAS_BUYER){ btn.disabled=true; btn.textContent="Sending…";
              const res=await post({slug:SLUG,token:TOKEN}); res?markDone(doneMsg(res,false)):(btn.disabled=false,btn.textContent="Try again");
            } else { openDialog(false); }
          });
        }
        const offerLink=document.getElementById("offerLink");
        if(offerLink) offerLink.addEventListener("click",(e)=>{ e.preventDefault(); openDialog(true); });
        const dlg=document.getElementById("dlg");
        if(dlg){
          document.getElementById("dlgCancel").onclick=()=>dlg.close();
          document.getElementById("dlgSend").onclick=async()=>{
            const name=document.getElementById("dlgName").value.trim();
            const contact=document.getElementById("dlgContact").value.trim();
            const amount=Number((document.getElementById("dlgAmount").value||"").replace(/[^0-9]/g,""));
            const payload={slug:SLUG};
            if(offerMode){ if(!amount) return; payload.offer_amount=amount; }
            if(HAS_BUYER){ payload.token=TOKEN; }
            else { if(!name||!contact) return; payload.name=name; payload.contact=contact; }
            const res=await post(payload); dlg.close();
            if(res) markDone(doneMsg(res,offerMode));
          };
        }
      </script>`;

    const body = `
      <div class="wrap">
        <div class="topbar" style="display:flex;align-items:center;gap:12px;padding:16px 22px;background:#fff;border-bottom:1px solid #ECE7DC">
          <img src="${LOGO_URL}" alt="Seaside Horizon" style="width:38px;height:38px;object-fit:contain">
          <span style="font-size:13px;font-weight:800;letter-spacing:.14em;color:${NAVY};text-transform:uppercase">Seaside Horizon</span>
          <span style="margin-left:auto">${badge}</span>
        </div>
        <div style="height:3px;background:linear-gradient(90deg,${GOLD} 0%,${GOLD_LT} 50%,${GOLD} 100%)"></div>
        ${banner}
        ${greeting}
        ${heroCard}
        ${activity}
        ${photosSec}
        ${termsSec}${rentSec}
        ${contactSec}
        <div class="foot" style="text-align:center;padding:26px 24px 10px;color:#A6AEBC;font-size:11.5px;line-height:1.6">
          Seaside Horizon${cPhone ? " · " + esc(cPhone) : ""}<br>Figures are estimates for evaluation and not a guarantee of returns.
        </div>
      </div>
      ${actionBar}
      ${dialog}
      ${galleryDialog}
      ${script}`;

    // Desktop rule for the rent section only — emitted only when that section
    // exists, so a Morby page is byte-for-byte what it was before this feature.
    const rentCss = rentSec
      ? `\n @media(min-width:1100px){.rent-sec{margin:26px auto 0!important;width:calc(100% - 96px);max-width:700px}}`
      : "";

    // Link-preview card. Every value is one the page itself already renders, so
    // the card can't drift from the deal — the hero money line is the same
    // heroLabel/heroValue pair shown above, and the image is the same resolved
    // hero photo (gallery → cover → listing → auto Street View). og:url is the
    // clean canonical deck URL, never this request's ?b= link, so a per-buyer
    // token is never copied into Facebook's or Apple's preview caches.
    const bedBath = terms.beds
      ? (terms.baths ? `${terms.beds} bd / ${terms.baths} ba` : `${terms.beds} bd`)
      : "";
    const shareMeta = {
      title: street || address,
      description: [
        heroValue && heroValue !== "—" ? `${heroLabel}: ${heroValue}` : "",
        bedBath,
        cityLine,
      ].filter(Boolean).join(" · "),
      image: heroPhoto,
      url: `${SITE_URL}/deck/${cleanSlug}`,
    };
    return { statusCode: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" }, body: page(address, body, rentCss, shareMeta) };
  } catch (err) {
    console.error("deck render error:", err.message);
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: page("Error", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">Something went wrong loading this deal. Text us and we'll send it over.</div></div>`) };
  }
};
