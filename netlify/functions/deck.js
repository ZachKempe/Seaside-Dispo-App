// /deck/<slug>            -> rendered interactive deal page (logs a view)
// /deck/<slug>.pdf        -> 302 to the Storage PDF (back-compat with sent links)
// /deck/<slug>?format=pdf -> same 302
// Public by design; ?b=<token> attributes the view/interest to a buyer.
const { verifyDeckToken } = require("./lib/deck-token");
const { fmtMoney, buyerCashAtClose, subtoSummaryRows, morbyTermRows } = require("./lib/deck-content");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app";
const REQUIRE_TOKEN = String(process.env.DECK_REQUIRE_TOKEN || "false") === "true";
const LOGO_URL = "https://seaside-dispo-app.netlify.app/img/logo.png";
const NAVY = "#1B3A6B", NAVY_DARK = "#112950", GOLD = "#D4A03E", BG = "#F0F4F8", INK = "#2D3748", MUTED = "#718096";

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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
 :root{--navy:${NAVY};--navyd:${NAVY_DARK};--gold:${GOLD};--bg:${BG};--ink:${INK};--muted:${MUTED}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
 .wrap{max-width:560px;margin:0 auto;padding:0 0 96px}
 .hdr{background:linear-gradient(135deg,var(--navyd),var(--navy));color:#fff;padding:18px 20px;display:flex;align-items:center;gap:12px}
 .hdr img{width:40px;height:40px;border-radius:8px;background:#fff;padding:4px}
 .brand{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--gold);font-weight:700}
 .addr{font-size:18px;font-weight:700}
 .rule{height:4px;background:var(--gold)}
 .badge{margin-left:auto;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.5px}
 .b-avail{background:#DEF7EC;color:#03543F}.b-pend{background:#FDF6B2;color:#723B13}.b-sold{background:#E5E7EB;color:#374151}
 .card{background:#fff;margin:16px;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden}
 .hero{background:#F0FFF4;border:2px solid #48BB78;border-radius:14px;margin:16px;padding:22px;text-align:center}
 .hero .lbl{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#276749;font-weight:700}
 .hero .val{font-size:44px;font-weight:800;color:#22543D;line-height:1.05;margin-top:4px}
 .hero .sub{font-size:12px;color:#2F855A;margin-top:6px;font-weight:600}
 .heroS{background:var(--navy);color:#fff;border-radius:14px;margin:16px;padding:22px;text-align:center}
 .heroS .lbl{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold);font-weight:700}
 .heroS .val{font-size:34px;font-weight:800;margin-top:4px}
 .gallery{display:grid;grid-template-columns:1fr 1fr;gap:2px}
 .gallery img{width:100%;height:150px;object-fit:cover;display:block}
 table{width:100%;border-collapse:collapse}
 td{padding:10px 16px;font-size:14px;border-bottom:1px solid #EDF2F7}
 td.k{color:var(--muted)}td.v{font-weight:600;text-align:right}
 .sec{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700;padding:14px 16px 4px}
 .foot{color:var(--muted);font-size:12px;text-align:center;padding:24px 20px}
 .bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid #E2E8F0;padding:12px 16px;display:flex;gap:10px;justify-content:center}
 .bar .inner{max-width:560px;width:100%;display:flex;gap:10px}
 button,.btn{font:600 15px Inter,sans-serif;border-radius:10px;padding:14px 18px;border:1px solid var(--gold);cursor:pointer}
 .primary{background:var(--navy);color:#fff;flex:1}
 .ghost{background:#fff;color:var(--navy)}
 .done{background:#DEF7EC;color:#03543F;border-color:#9AE6B4;flex:1;text-align:center;font-weight:700;padding:14px}
 dialog{border:none;border-radius:14px;padding:20px;max-width:400px;width:92%}
 dialog input{width:100%;padding:12px;margin:6px 0;border:1px solid #CBD5E0;border-radius:8px;font-size:15px}
 @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>${body}</body></html>`;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  // Slug normally arrives as ?slug=<splat> from the /deck/* rewrite. But a
  // status=200 rewrite forwards the ORIGINAL path/query to the function, so the
  // destination's ?slug= is not reliably surfaced — fall back to parsing the
  // request path (/deck/<slug>[.pdf]) from event.path or event.rawUrl.
  let slug = (q.slug || "").trim();
  if (!slug) {
    const m = String(event.path || event.rawUrl || "").match(/\/deck\/([^/?#]+)/i);
    if (m) slug = decodeURIComponent(m[1]).trim();
  }
  const wantsPdf = q.format === "pdf" || /\.pdf$/i.test(slug);
  slug = slug.replace(/\.pdf$/i, "");
  const cleanSlug = slug.replace(/[^a-zA-Z0-9_-]/g, "");

  // Back-compat: raw PDF link.
  if (wantsPdf) {
    if (!cleanSlug || !SB_URL) return { statusCode: 404, body: "Not found" };
    const url = `${SB_URL}/storage/v1/object/public/property-photos/deal-decks/${cleanSlug}.pdf`;
    return { statusCode: 302, headers: { Location: url }, body: "" };
  }
  if (!cleanSlug) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="foot">Deal not found.</div>`) };

  try {
    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=*&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, headers: { "Content-Type": "text/html" }, body: page("Not found", `<div class="foot">This deal is no longer available.</div>`) };

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

    // Resolve buyer from token (for view attribution + greeting).
    const buyerId = verifyDeckToken(q.b);
    let buyer = null;
    if (buyerId) {
      const b = await sb(`/buyers?id=eq.${buyerId}&select=id,name&limit=1`);
      buyer = b && b[0];
    }
    if (REQUIRE_TOKEN && !buyerId) {
      return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: page(address, `<div class="foot">Please use the link from your email or text to view this deal.</div>`) };
    }

    // Log the view (fire-and-forget; never block render).
    sb(`/deck_views`, { method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ card_id: cardId, buyer_id: buyerId || null, user_agent: (event.headers["user-agent"] || "").slice(0, 300) }) })
      .catch(e => console.warn("deck_view log failed:", e.message));

    // ---- Build page ----
    const badge = status === "active"
      ? `<span class="badge b-avail">Available</span>`
      : (["pending","under_contract"].includes(status) ? `<span class="badge b-pend">Pending</span>` : `<span class="badge b-sold">Sold</span>`);
    const canInterest = status === "active";

    const photos = Array.isArray(prop.fb_photos) ? prop.fb_photos.filter(p => p && p.url).slice(0, 6) : [];
    const gallery = photos.length
      ? `<div class="card"><div class="gallery">${photos.map(p => `<img src="${esc(p.url)}" alt="${esc(p.name || address)}" loading="lazy">`).join("")}</div></div>`
      : (cover ? `<div class="card"><img src="${esc(cover)}" alt="${esc(address)}" style="width:100%;height:220px;object-fit:cover;display:block"></div>` : "");

    let hero;
    if (isMorby) {
      const cash = buyerCashAtClose(morby);
      hero = cash > 0
        ? `<div class="hero"><div class="lbl">Cash to you at close</div><div class="val">~$${Math.round(cash).toLocaleString()}</div><div class="sub">Estimated cash you receive at closing on this deal.</div></div>`
        : `<div class="heroS"><div class="lbl">Stack Method Deal</div><div class="val">${esc(address)}</div></div>`;
    } else {
      const fee = Number(terms.entry_fee) || 0;
      hero = `<div class="heroS"><div class="lbl">Sub-To Deal · Entry Fee</div><div class="val">${fee ? "$" + fee.toLocaleString() : "Ask"}</div></div>`;
    }

    const rows = isMorby ? morbyTermRows(morby) : subtoSummaryRows(terms);
    const table = `<div class="card"><div class="sec">Deal terms</div><table>${
      rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join("")
    }</table></div>`;

    const driveBtn = prop.drive_link ? `<a class="btn ghost" href="${esc(prop.drive_link)}" target="_blank" rel="noopener">View all photos</a>` : "";
    const pdfBtn = `<a class="btn ghost" href="${SITE_URL}/deck/${esc(cleanSlug)}.pdf" target="_blank" rel="noopener">Download PDF</a>`;

    const greeting = buyer && buyer.name ? `<p style="margin:0 16px;color:${INK}">Hi ${esc(String(buyer.name).split(/\s+/)[0])}, here's the full deal.</p>` : "";

    const actionBar = canInterest
      ? `<div class="bar"><div class="inner">
           <button class="primary" id="interestBtn">I'm interested</button>
           ${pdfBtn}
         </div></div>`
      : `<div class="bar"><div class="inner"><div class="done">This deal is ${status === "sold" || status === "closed" ? "sold" : "pending"}</div>${pdfBtn}</div></div>`;

    const dialog = `
      <dialog id="dlg">
        <div style="font-weight:700;margin-bottom:6px">Great — how should we reach you?</div>
        <input id="dlgName" placeholder="Your name" autocomplete="name">
        <input id="dlgContact" placeholder="Phone or email" autocomplete="tel">
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="ghost" id="dlgCancel" style="flex:1">Cancel</button>
          <button class="primary" id="dlgSend" style="flex:1">Send</button>
        </div>
      </dialog>`;

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
          const bar=document.querySelector(".bar .inner");
          if(bar) bar.innerHTML='<div class="done">✓ Got it — we\\'ll be in touch</div>';
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
        <div class="hdr"><img src="${LOGO_URL}" alt="Seaside Horizon">
          <div><div class="brand">Seaside Horizon</div><div class="addr">${esc(address)}</div></div>
          ${badge}
        </div>
        <div class="rule"></div>
        ${greeting}
        ${hero}
        ${gallery}
        ${table}
        <div style="padding:0 16px">${driveBtn}</div>
        <div class="foot">${esc(process.env.MARKETING_CONTACT_NAME || "Seaside Horizon")}${process.env.MARKETING_CONTACT_PHONE ? " · " + esc(process.env.MARKETING_CONTACT_PHONE) : ""}</div>
      </div>
      ${actionBar}
      ${dialog}
      ${script}`;

    return { statusCode: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" }, body: page(address, body) };
  } catch (err) {
    console.error("deck render error:", err.message);
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: page("Error", `<div class="foot">Something went wrong loading this deal. Text us and we'll send it over.</div>`) };
  }
};
