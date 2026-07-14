// /deck/<slug>            -> rendered interactive deal page (logs a view)
// /deck/<slug>.pdf        -> 302 to the Storage PDF (back-compat with sent links)
// /deck/<slug>?format=pdf -> same 302
// Public by design; ?b=<token> attributes the view/interest to a buyer.
//
// REDESIGN NOTE: presentation was rebuilt (premium navy/gold template, money-forward
// hero, banner photo w/ Street View fallback, property-details section, sticky CTA).
// All data queries, token handling, view logging and interest posting are UNCHANGED.
// New dependency: ./lib/deck-photo.js  +  env GOOGLE_MAPS_API_KEY (optional).
const { verifyDeckToken } = require("./lib/deck-token");
const { fmtMoney, buyerCashAtClose, subtoSummaryRows, morbyTermRows } = require("./lib/deck-content");
const { resolveDealPhotos } = require("./lib/deck-photo");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app";
const REQUIRE_TOKEN = String(process.env.DECK_REQUIRE_TOKEN || "false") === "true";
const LOGO_URL = "https://seaside-dispo-app.netlify.app/img/logo.png";

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
function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
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
 dialog{border:none;background:transparent;padding:0;max-width:600px;width:100%;margin:auto auto 0}
 dialog::backdrop{background:rgba(17,41,80,.5);backdrop-filter:blur(3px)}
 .sheet{background:${PAPER};border-radius:22px 22px 0 0;padding:26px 24px calc(26px + env(safe-area-inset-bottom));box-shadow:0 -20px 60px rgba(17,41,80,.4);animation:rise .18s ease}
 .sheet input{width:100%;padding:14px 15px;margin-bottom:10px;border:1px solid #D8CFB8;border-radius:11px;font-size:15px;font-family:Inter,sans-serif;background:#fff}
 .sheet input:focus{border-color:${GOLD};outline:none}
 @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
 /* ---- Desktop (≥1100px): full-screen split layout — photo fills the left half,
    content on the right. Everything below 1100px is untouched (mobile design). ---- */
 @media(min-width:1100px){
  .wrap{max-width:none;display:grid;grid-template-columns:46% 54%;align-content:start;overflow:visible;box-shadow:none;padding-bottom:200px}
  .wrap>*{grid-column:2}
  .wrap>.banner{position:fixed!important;top:0;left:0;width:46%;height:100vh!important;box-shadow:34px 0 70px -34px rgba(17,41,80,.45)}
  .banner h1{font-size:clamp(36px,3.2vw,50px)!important}
  .banner-inner{padding:42px 48px!important;gap:13px!important}
  .topbar{padding:20px 44px!important}
  .greeting{padding:24px 0 0!important;margin:0 auto!important;width:calc(100% - 96px);max-width:700px}
  .hero-card{margin:30px auto 0!important;width:calc(100% - 96px);max-width:700px;padding:40px 36px 34px!important}
  .money{font-size:76px!important}
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
</style></head><body>${body}</body></html>`;
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
    const url = `${SB_URL}/storage/v1/object/public/property-photos/deal-decks/${cleanSlug}.pdf`;
    return { statusCode: 302, headers: { Location: url }, body: "" };
  }
  if (!cleanSlug) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">Deal not found.</div></div>`) };

  try {
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=*&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">This deal is no longer available.</div></div>`) };

    const cardId = prop.card_id;
    const [termsRows, morbyRows, acqRows, statusRows] = await Promise.all([
      sb(`/deal_terms?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`),
      sb(`/morby_deals?card_id=eq.${encodeURIComponent(cardId)}&select=*&limit=1`),
      sb(`/deal_acquisition?card_id=eq.${encodeURIComponent(cardId)}&select=cover_image_url&limit=1`),
      sb(`/property_status?card_id=eq.${encodeURIComponent(cardId)}&select=status&limit=1`),
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

    // View log (fire-and-forget)
    sb(`/deck_views`, { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ card_id: cardId, buyer_id: buyerId || null, user_agent: (event.headers["user-agent"] || "").slice(0, 300) }) })
      .catch(e => console.warn("deck_view log failed:", e.message));

    // ---- Photo (listing -> cover -> Street View -> none) ----
    const { hero: heroPhoto, source: photoSource } = await resolveDealPhotos(prop, cover, address);

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
        ${heroPhoto ? `<img src="${esc(heroPhoto)}" alt="${esc(address)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` : ""}
        ${!heroPhoto ? `<div style="position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent 0,transparent 33px,rgba(255,255,255,.04) 33px,rgba(255,255,255,.04) 34px),repeating-linear-gradient(90deg,transparent 0,transparent 33px,rgba(255,255,255,.04) 33px,rgba(255,255,255,.04) 34px)"></div>` : ""}
        ${photoSource === "streetview" ? `<span style="position:absolute;top:12px;right:12px;font-size:10px;font-weight:600;color:#fff;background:rgba(17,41,80,.6);border:1px solid rgba(255,255,255,.25);padding:4px 9px;border-radius:6px">Street View · Google</span>` : ""}
        <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(17,41,80,.15) 0%,rgba(17,41,80,.35) 55%,rgba(17,41,80,.88) 100%)"></div>
        <div class="banner-inner" style="position:absolute;left:0;right:0;bottom:0;padding:22px 24px;display:flex;flex-direction:column;gap:9px">
          <span style="align-self:flex-start;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY_DARK};background:${GOLD_LT};padding:4px 10px;border-radius:4px">${esc(dealTypeLabel)}</span>
          <h1 style="margin:0;font-family:'Source Serif 4',Georgia,serif;font-weight:600;font-size:29px;line-height:1.1;color:#fff;letter-spacing:-.01em;text-shadow:0 2px 18px rgba(0,0,0,.35)">${esc(street)}</h1>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            ${cityLine ? `<div style="display:flex;align-items:center;gap:7px;color:#D9E2F0;font-size:14px;font-weight:500"><span style="width:5px;height:5px;border-radius:50%;background:${GOLD};box-shadow:0 0 0 3px rgba(212,160,62,.25)"></span>${esc(cityLine)}</div>` : ""}
            <a href="${esc(mapHref)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:#fff;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);padding:6px 12px;border-radius:999px">📍 View on map</a>
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

    // Deal terms grid
    const rows = isMorby ? morbyTermRows(morby) : subtoSummaryRows(terms);
    const termsSec = rows.length ? `
      <div class="terms-sec" style="margin:24px 20px 0">
        <div style="display:flex;align-items:center;gap:10px;margin:0 4px 12px"><span style="font-size:11.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:${NAVY}">Deal Terms</span><span style="flex:1;height:1px;background:linear-gradient(90deg,#E0D9C9,transparent)"></span></div>
        <div style="background:#fff;border:1px solid ${LINE};border-radius:16px;overflow:hidden;display:grid;grid-template-columns:1fr 1fr">
          ${rows.map(([k, v]) => `<div class="term-cell" style="padding:15px 18px;border-bottom:1px solid #F0EBDF;border-right:1px solid #F0EBDF"><div style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#94A0B2;margin-bottom:5px">${esc(k)}</div><div class="term-v" style="font-size:17px;font-weight:700;color:${INK};letter-spacing:-.01em;font-variant-numeric:tabular-nums">${esc(v)}</div></div>`).join("")}
        </div>
      </div>` : "";

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

    const pdfBtn = `<a href="${SITE_URL}/deck/${esc(cleanSlug)}.pdf" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:${NAVY};background:#fff;border:1px solid #D8CFB8;border-radius:13px;padding:0 18px;white-space:nowrap">PDF</a>`;
    const callBtn = cPhone ? `<a href="${esc(telHref)}" style="display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;background:${NAVY};border-radius:13px;padding:0 20px;white-space:nowrap">Call</a>` : "";

    const actionBar = canInterest
      ? `<div class="action-bar" style="position:fixed;left:0;right:0;bottom:0;background:rgba(251,250,246,.9);backdrop-filter:blur(12px);border-top:1px solid #E7E1D3;padding:13px 20px calc(13px + env(safe-area-inset-bottom));box-shadow:0 -12px 30px -18px rgba(17,41,80,.3)">
           <div style="max-width:600px;margin:0 auto">
             <div class="inner" style="display:flex;gap:11px;align-items:stretch">
               <button class="primary" id="interestBtn" style="flex:1;font:800 16px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border:none;border-radius:13px;padding:16px;cursor:pointer;box-shadow:0 8px 20px -8px rgba(212,160,62,.7)">I'm interested</button>
               ${callBtn}${pdfBtn}
             </div>
             <div style="text-align:center;font-size:11px;color:#A6AEBC;margin-top:9px">No obligation — this just tells us to send you the full details.</div>
           </div>
         </div>`
      : `<div class="action-bar" style="position:fixed;left:0;right:0;bottom:0;background:rgba(251,250,246,.9);backdrop-filter:blur(12px);border-top:1px solid #E7E1D3;padding:13px 20px calc(13px + env(safe-area-inset-bottom))">
           <div style="max-width:600px;margin:0 auto;display:flex;gap:11px"><div style="flex:1;text-align:center;font:700 14px Inter,sans-serif;color:#8A6D1F;background:#FaF3DC;border:1px solid #EAD9A0;border-radius:13px;padding:15px">This deal is ${status === "sold" || status === "closed" ? "sold" : "pending"}</div>${callBtn}${pdfBtn}</div>
         </div>`;

    const dialog = `
      <dialog id="dlg"><div class="sheet">
        <div style="width:40px;height:4px;border-radius:2px;background:#DDD5C4;margin:0 auto 18px"></div>
        <div style="font-family:'Source Serif 4',serif;font-size:21px;font-weight:600;color:${INK};margin-bottom:4px">Great — how should we reach you?</div>
        <div style="font-size:13.5px;color:${MUTED};margin-bottom:16px">We'll text you the full details on ${esc(street)}.</div>
        <input id="dlgName" placeholder="Your name" autocomplete="name">
        <input id="dlgContact" placeholder="Phone or email" autocomplete="tel" style="margin-bottom:16px">
        <div style="display:flex;gap:10px">
          <button class="ghost" id="dlgCancel" style="flex:1;font:700 15px Inter,sans-serif;color:${NAVY};background:#fff;border:1px solid #D8CFB8;border-radius:12px;padding:14px;cursor:pointer">Cancel</button>
          <button class="primary" id="dlgSend" style="flex:1.4;font:800 15px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border:none;border-radius:12px;padding:14px;cursor:pointer">Send it over</button>
        </div>
      </div></dialog>`;

    const script = `
      <script>
        const HAS_BUYER = ${buyerId ? "true" : "false"};
        const SLUG = ${JSON.stringify(cleanSlug)};
        const TOKEN = ${JSON.stringify(q.b || "")};
        async function post(payload){
          const r = await fetch("/.netlify/functions/deck-interest",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
          return r.ok;
        }
        function markDone(){
          const bar=document.querySelector(".inner");
          if(bar) bar.innerHTML='<div style="flex:1;text-align:center;font:800 15px Inter,sans-serif;color:#1F7A54;background:#E4F4EC;border:1px solid #B7E3CC;border-radius:13px;padding:15px">✓ Got it — we\\'ll be in touch shortly</div>';
        }
        const btn=document.getElementById("interestBtn");
        if(btn){
          btn.addEventListener("click", async ()=>{
            if(HAS_BUYER){ btn.disabled=true; btn.textContent="Sending…";
              const ok=await post({slug:SLUG,token:TOKEN}); ok?markDone():(btn.disabled=false,btn.textContent="Try again");
            } else { document.getElementById("dlg").showModal(); }
          });
        }
        const dlg=document.getElementById("dlg");
        if(dlg){
          document.getElementById("dlgCancel").onclick=()=>dlg.close();
          document.getElementById("dlgSend").onclick=async()=>{
            const name=document.getElementById("dlgName").value.trim();
            const contact=document.getElementById("dlgContact").value.trim();
            if(!name||!contact) return;
            const ok=await post({slug:SLUG,name,contact}); dlg.close(); if(ok) markDone();
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
        ${termsSec}
        ${contactSec}
        <div class="foot" style="text-align:center;padding:26px 24px 10px;color:#A6AEBC;font-size:11.5px;line-height:1.6">
          Seaside Horizon${cPhone ? " · " + esc(cPhone) : ""}<br>Figures are estimates for evaluation and not a guarantee of returns.
        </div>
      </div>
      ${actionBar}
      ${dialog}
      ${script}`;

    return { statusCode: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" }, body: page(address, body) };
  } catch (err) {
    console.error("deck render error:", err.message);
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: page("Error", `<div class="wrap"><div style="padding:60px 24px;text-align:center;color:${MUTED}">Something went wrong loading this deal. Text us and we'll send it over.</div></div>`) };
  }
};
