# Seaside Dispo — Interactive Deal Deck Page: Build Spec

**For:** Claude Code, executing against the `seaside-dispo-app` repo.
**Goal:** Turn the `/deck/<slug>` route from a redirect-to-PDF into a rendered, mobile-first deal page that (a) captures buyer interest inline into `deal_leads`, and (b) logs per-buyer page views. Close the loop so interest comes back to us attributed, instead of relying on reply-parsing.

Execute the steps in the order given in §14. Do not skip the acceptance criteria (§10) or the test plan (§11). Where an edit touches a working function, make the smallest change that satisfies the spec — this is a live production system for a real business.

---

## 0. Definition of done

- A buyer who receives a blast can tap a link, land on a branded page showing the deal (photos, terms, and — for Morby deals — the estimated cash-to-buyer-at-close as the hero), and tap **"I'm interested."**
- That tap writes a `deal_leads` row with `source='deck_page'`, `stage='interested'`, correctly attributed to the buyer and the deal — with **no subject parsing and no dependence on `capture-replies.js`**.
- Every page load logs a `deck_views` row (buyer-attributed when the link was tokenized, anonymous otherwise).
- The dashboard shows, per open deal, a view count and which pipeline leads came from the deck page.
- The old raw-PDF link keeps working (backward compatibility) via a `.pdf` suffix.
- Deals that are sold/pending show a status badge and hide the Interested button.

Non-goals for v1 (see §13): dwell-time tracking, A/B testing on the page, a full two-way inbox.

---

## 1. Architecture (the loop)

```
send-blast ──emits──▶  /deck/<slug>?b=<buyerToken>   (email CTA + SMS link, per-recipient)
                              │
                    buyer taps│
                              ▼
                    deck.js (GET) ── logs deck_views ──▶ renders page
                              │
                 buyer taps "Interested"
                              ▼
              deck-interest.js (POST) ── upserts deal_leads (source=deck_page)
                              │                └─ logs buyer_activity touch
                              │                └─ (optional) notifies operator
                              ▼
              dashboard.html ── reads deal_leads + deck_views ──▶ ranked call list
```

**Attribution model:** the branded slug in the path identifies the *deal*; the `?b=<token>` HMAC identifies the *buyer*. Together they attribute a view/interest to a (buyer, deal) pair. Untokenized visits (forwarded links) still render and log as anonymous, and the Interested button then collects name + contact and writes an external lead (`buyer_id = null`), exactly like the existing external-lead path in `deal_leads`.

---

## 2. Prerequisites & assumptions

- Repo layout matches current: static files at repo root served from `public/` per `netlify.toml`, functions in `netlify/functions/`, shared modules in `netlify/functions/lib/` (this is where `capture.js` already lives — confirm the path; the capture functions `require("./lib/capture")`).
- Supabase migrations live as numbered `.sql` files; the next number is **020**.
- These env vars already exist and are reused: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `PUBLIC_SITE_URL`, `UNSUB_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`, `GMAIL_FROM_ADDRESS`, `MARKETING_CONTACT_NAME`, `MARKETING_CONTACT_PHONE`.
- `send-blast.js` already contains: `sb(path, opts, key)` (defaults to service key), `SITE_URL`, `crypto`, `unsubUrlFor(buyerId)`, `deckSlug(prop)` (used today for the PDF filename), `uploadDealDeckPdf(...)`, `buildHtmlEmail`, `buildMorbyEmail`, `buildDealCopyText`, `buildMorbySms`, `buyerCashAtClose`, and the property/terms/morby fetch in the handler. Reuse them; do not re-implement.

New env vars to add (all optional — see §8): `DECK_TOKEN_SECRET`, `NOTIFY_EMAIL`, `DECK_REQUIRE_TOKEN`.

---

## 3. Data model — migration `020_deck_pages.sql`

Create `020_deck_pages.sql` alongside the other migrations. No backfill: `deck_slug` is populated lazily by `send-blast` the first time a deal is blasted (that's exactly the set of deals that need a page), and the page 404s gracefully for any slug not yet minted.

```sql
-- 020 — Interactive Deal Deck pages.
-- Adds a stable per-property slug for the branded /deck/<slug> page URL, and a
-- deck_views engagement log (who opened a deal page, when). Interest itself is
-- captured into the existing deal_leads table with source='deck_page' — no new
-- table is needed for that.

-- Stable slug for the branded page URL. Populated lazily by send-blast.js the
-- first time a deal is blasted, using the same deckSlug() value already used for
-- the PDF filename, so the page and the PDF share one slug.
alter table properties add column if not exists deck_slug text;
create unique index if not exists properties_deck_slug_uniq
  on properties (deck_slug) where deck_slug is not null;

-- One row per page view. buyer_id null = anonymous / untokenized (forwarded link).
create table if not exists deck_views (
  id            bigint generated always as identity primary key,
  card_id       text   not null,
  buyer_id      bigint references buyers(id) on delete set null,
  viewed_at     timestamptz default now(),
  dwell_seconds integer,          -- reserved for v2; nullable for now
  user_agent    text default ''
);
create index if not exists idx_deck_views_card  on deck_views (card_id);
create index if not exists idx_deck_views_buyer on deck_views (buyer_id);

alter table deck_views enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deck_views'
      and policyname = 'authenticated_full_access_deck_views'
  ) then
    execute 'create policy "authenticated_full_access_deck_views" on deck_views
               for all using (auth.role() = ''authenticated'')
               with check (auth.role() = ''authenticated'')';
  end if;
end $$;
```

---

## 4. New shared libraries

### 4.1 `netlify/functions/lib/deck-token.js` (new — full file)

Mirrors the unsubscribe-token pattern already in `send-blast.js`/`unsubscribe.js`. A short signed buyer id, forge-proof, URL-safe.

```js
// Shared HMAC token for per-buyer deck links. Same construction as the
// unsubscribe token: `${buyerId}.${hmac16}`. Binds a buyer to their deck link
// so a view/tap is attributed. Not a secret — just unforgeable.
const crypto = require("crypto");

const SECRET =
  process.env.DECK_TOKEN_SECRET ||
  process.env.UNSUB_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "seaside-deck";

function sign(id) {
  return crypto.createHmac("sha256", SECRET).update(String(id)).digest("hex").slice(0, 16);
}
function deckToken(buyerId) {
  return `${buyerId}.${sign(buyerId)}`;
}
function verifyDeckToken(token) {
  const [id, h] = String(token || "").split(".");
  if (!id || !h) return null;
  return h === sign(id) ? Number(id) : null;
}
module.exports = { deckToken, verifyDeckToken };
```

### 4.2 `netlify/functions/lib/deck-content.js` (new — full file)

Pure formatting helpers so the **page and the emails render terms from one source of truth.** This is deliberate: the reply-capture bug in this codebase came from two representations of the same thing drifting apart. Put the shared math here.

> After this file exists and the page works, do the optional dedupe in §6.5: make `send-blast.js` `require` `buyerCashAtClose`, `fmtMoney`, `subtoSummaryRows`, and `morbyTermRows` from here and delete its local copies. If you defer that, keep the two copies byte-identical.

```js
// Shared, pure deal-formatting helpers used by both the blast emails and the
// interactive deck page. Keep these free of I/O so both can import them.

function fmtMoney(n) {
  n = Number(n) || 0;
  return n ? `$${n.toLocaleString()}` : "—";
}
function fmtPct(n) {
  return n ? `${Number(n).toFixed(2)}%` : "—";
}

// Estimated cash the buyer receives at close = their 50% share of the
// assignment. Mirrors send-blast.js buyerCashAtClose EXACTLY. If you dedupe,
// delete the copy in send-blast and import this one.
function buyerCashAtClose(morby) {
  const price = Number(morby.purchase_price) || 0;
  if (!price) return 0;
  const defaultLtv = morby.property_type === "commercial" ? 70 : 75;
  const ltv = morby.dscr_ltv != null ? Number(morby.dscr_ltv) : defaultLtv;
  const loanProceeds = price * (ltv / 100);
  const downPayment = Number(morby.down_payment) || 0;
  const closingCosts = price * 0.05;
  const addlBrokerFee = price * ((Number(morby.additional_broker_pct) || 0) / 100);
  const buyerShare = (loanProceeds - downPayment - closingCosts - addlBrokerFee) / 2;
  return buyerShare > 0 ? buyerShare : 0;
}

// Sub-To term rows for the deck page. [label, value] pairs, dashes filtered out.
function subtoSummaryRows(terms) {
  const rows = [
    ["Entry Fee", terms.entry_fee ? `${fmtMoney(terms.entry_fee)} + TC + CC` : "—"],
    ["Purchase Price", fmtMoney(terms.price)],
    ["Existing Loan Balance", fmtMoney(terms.mortgage)],
    ["PITI", terms.piti ? `${fmtMoney(terms.piti)}/mo` : "—"],
    ["Rate", terms.rate ? `${terms.rate}%` : "—"],
    ["Beds / Baths", terms.beds ? `${terms.beds} bd / ${terms.baths || "N/A"} ba` : "—"],
    ["Sqft", terms.sqft ? Number(terms.sqft).toLocaleString() : "—"],
    ["Year Built", terms.year_built || "—"],
  ];
  return rows.filter(([, v]) => v && v !== "—");
}

// Morby term rows for the deck page. Same set the Morby email builds.
function morbyTermRows(morby) {
  const rows = [
    ["Purchase Price", fmtMoney(morby.purchase_price)],
    ["Down Payment", fmtMoney(morby.down_payment)],
    ["Seller Carry", fmtMoney(morby.seller_carry_balance)],
    ["Monthly Payment", fmtMoney(morby.monthly_payment)],
    ["Deferred Rate", fmtPct(morby.deferred_interest_rate)],
    ["Balloon", morby.balloon_months ? `${morby.balloon_months} months` : "—"],
    ["Inspection Period", morby.inspection_period_days ? `${morby.inspection_period_days} days` : "—"],
    ["Close of Escrow", morby.close_of_escrow_days ? `${morby.close_of_escrow_days} days` : "—"],
  ];
  return rows.filter(([, v]) => v && v !== "—");
}

module.exports = { fmtMoney, fmtPct, buyerCashAtClose, subtoSummaryRows, morbyTermRows };
```

---

## 5. New / rewritten functions

### 5.1 `netlify/functions/deck.js` (REWRITE — full file)

Replaces the current redirect. Behavior:

- `/deck/<slug>.pdf` **or** `?format=pdf` → 302 to the existing Storage PDF (preserves every link already sent).
- `/deck/<slug>` → resolve property by `deck_slug`, fetch terms/morby/acquisition/status, verify `?b=<token>` → buyer, **log a `deck_views` row**, render the page.
- Slug not found → branded 404.
- If `DECK_REQUIRE_TOKEN === "true"` and no valid token → render a minimal teaser with no financials (default is open, matching today's public PDF behavior).

**Design direction for the rendered page** (consult the `frontend-design` skill when building, and reuse the existing brand tokens — do not invent a new palette):
- Tokens (already the brand): navy `#1B3A6B`, navy-dark `#112950`, gold `#D4A03E`, page bg `#F0F4F8`, ink `#2D3748`, muted `#718096`. Body font Inter (already loaded elsewhere via Google Fonts).
- **Hero = the deal's thesis, not a template big-number.** Morby: the estimated **"Cash to you at close ~$X"** band (green, like the email) is the hero. Sub-To: the **Entry Fee** headline with the address. This is justified by the subject — it's the number a buyer decides on.
- Mobile-first single column, ~560px max content width, generous vertical rhythm. Gold hairline under the header (matches the email). One accent (gold); keep everything else quiet.
- Signature element: a sticky bottom action bar on mobile holding the **I'm interested** button so it's always reachable while scrolling the gallery. That's the page's one memorable, purposeful flourish.
- Status badge top-right: Available (green) / Pending (amber) / Sold (grey). Hide the Interested button unless Available.
- Photo gallery from `properties.fb_photos` (`[{url,name}]`); fall back to `deal_acquisition.cover_image_url`; then `drive_link` as a "View all photos" button. **Note:** if `cover_image_url` points at Supabase Storage, heavy views draw against the 5 GB free-tier egress — fine for v1, revisit with a CDN if a deal goes viral.
- Copy rules (from the design skill): buttons say what happens ("I'm interested", not "Submit"). Empty/again states speak plainly. No apologies in errors.

```js
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
  let slug = (q.slug || "").trim();
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
```

### 5.2 `netlify/functions/deck-interest.js` (new — full file)

POST target for the Interested button. Tokenized taps attribute to the buyer; anonymous taps create an external lead. Dedupe mirrors `capture.js` (don't downgrade a lead that's already past `interested`). Optional operator notification for speed-to-lead.

```js
// POST { slug, token?, name?, contact? } — records buyer interest from the deck
// page. Tokenized => attributed to the buyer; otherwise an external lead.
const { verifyDeckToken } = require("./lib/deck-token");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const ADVANCEABLE = new Set(["new", "responded"]); // don't downgrade offer/UC/closed

async function notify(address, who) {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: RESEND_FROM, to: [NOTIFY_EMAIL],
        subject: `🔥 Interested: ${who} — ${address}`,
        html: `<p><b>${who}</b> tapped Interested on <b>${address}</b> via the deck page. Call them now.</p>`,
      }),
    });
  } catch (e) { console.warn("notify failed:", e.message); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { slug, token, name, contact } = JSON.parse(event.body || "{}");
    const cleanSlug = String(slug || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!cleanSlug) return { statusCode: 400, body: "slug required" };

    const props = await sb(`/properties?deck_slug=eq.${encodeURIComponent(cleanSlug)}&select=card_id,name,address_override&limit=1`);
    const prop = props && props[0];
    if (!prop) return { statusCode: 404, body: "deal not found" };
    const cardId = prop.card_id;
    const address = prop.address_override || prop.name || cardId;

    const buyerId = verifyDeckToken(token);

    if (buyerId) {
      const b = await sb(`/buyers?id=eq.${buyerId}&select=id,name,email,phone&limit=1`);
      const buyer = b && b[0];
      if (!buyer) return { statusCode: 404, body: "buyer not found" };

      // Upsert deal_leads (dedupe on card_id+buyer_id).
      const existing = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&buyer_id=eq.${buyerId}&select=id,stage&limit=1`);
      if (existing && existing[0]) {
        if (ADVANCEABLE.has(existing[0].stage)) {
          await sb(`/deal_leads?id=eq.${existing[0].id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ stage: "interested", notes: "Tapped Interested on deck page" }) });
        }
      } else {
        await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ card_id: cardId, address, buyer_id: buyerId, name: buyer.name || "Buyer",
            contact: buyer.email || buyer.phone || "", source: "deck_page", channel: "deck",
            stage: "interested", notes: "Tapped Interested on deck page" }) });
      }
      // Activity touch (works with existing buyer_activity table).
      await sb(`/buyer_activity`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ buyer_id: buyerId, card_id: cardId, address, channel: "deck", detail: "Interested via deck page" }) });

      await notify(address, buyer.name || `Buyer #${buyerId}`);
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: true }) };
    }

    // Anonymous / forwarded link: external lead, deduped on card_id+contact.
    const nm = String(name || "").trim().slice(0, 120);
    const ct = String(contact || "").trim().slice(0, 200);
    if (!nm || !ct) return { statusCode: 400, body: "name and contact required for untokenized interest" };

    const dupe = await sb(`/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&contact=eq.${encodeURIComponent(ct)}&select=id&limit=1`);
    if (!(dupe && dupe[0])) {
      await sb(`/deal_leads`, { method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ card_id: cardId, address, buyer_id: null, name: nm, contact: ct,
          source: "deck_page", channel: "deck", stage: "interested", notes: "Interested via deck page (untokenized)" }) });
    }
    await notify(address, `${nm} (${ct})`);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true, attributed: false }) };
  } catch (err) {
    console.error("deck-interest error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
```

---

## 6. Edits to `send-blast.js`

Surgical. Reuse everything already there.

### 6.1 Imports (top of file, near the other requires)
```js
const { deckToken } = require("./lib/deck-token");
```

### 6.2 Add `ensureDeckSlug` helper (place near `unsubUrlFor`)
Populates `properties.deck_slug` lazily using the **existing** `deckSlug(prop)` (same value as the PDF filename), handling the rare unique collision.
```js
async function ensureDeckSlug(prop) {
  if (prop.deck_slug) return prop.deck_slug;
  let base = deckSlug(prop);            // reuse existing PDF-slug generator
  let slug = base;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await sb(`/properties?card_id=eq.${encodeURIComponent(prop.card_id)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ deck_slug: slug }),
      });
      prop.deck_slug = slug;
      return slug;
    } catch (e) {
      // unique collision -> disambiguate with a short card-id suffix and retry
      slug = `${base}-${String(prop.card_id).slice(-4)}${attempt || ""}`;
    }
  }
  prop.deck_slug = slug;
  return slug;
}
```

### 6.3 In the handler, after `const prop = (props || [])[0];` is confirmed (right after the 404 guard)
```js
const deckSlugVal = await ensureDeckSlug(prop);
const deckPageUrl = (buyerId) => `${SITE_URL}/deck/${deckSlugVal}?b=${deckToken(buyerId)}`;
```

### 6.4 Thread the per-buyer page URL into email + SMS

**Email builder closure** — extend the signature:
```js
const buildEmail = (unsubUrl, buyer, deckUrlForBuyer) => isMorbyDeck
  ? buildMorbyEmail(prop, morbyTerms, unsubUrl, buyer, deckUrlForBuyer)
  : buildHtmlEmail(prop, terms, unsubUrl, coverImageUrl, buyer, deckUrlForBuyer);
```
- In the **live email loop**, change `buildEmail(unsubUrl, b)` → `buildEmail(unsubUrl, b, deckPageUrl(b.id))`.
- In **test mode**, pass a sample: `buildEmail(unsubUrlFor("preview"), null, `${SITE_URL}/deck/${deckSlugVal}?b=preview`)`.

**In `buildHtmlEmail` and `buildMorbyEmail`** — add the new param and render a **primary CTA button** (place it above the existing "View Photos" / drive button, using the same button styling already in those templates). Button text: **"View deal & respond"**, href = `deckUrlForBuyer`. This becomes the main call to action; keep the photos button as secondary. For Morby, keep the PDF attachment as-is.

**SMS** — the deck page link must be per-recipient. In the SMS loop, build the message inside the loop so each buyer gets their token:
```js
for (const b of smsBuyers) {
  const perMsg = message + `\n\nView deal & respond: ${deckPageUrl(b.id)}`;
  try { await sendSms(b.phone, perMsg); sent++; recipientRows.push(...); }
  catch (e) { ... }
}
```
(Leave the existing `buildMorbySms` PDF `deckUrl` line alone; the page link is additive and is the preferred CTA.)

### 6.5 (Recommended, optional) Dedupe formatting
Replace `send-blast.js`'s local `buyerCashAtClose` and money formatting with imports from `./lib/deck-content` so the email and the page can never drift. If you do this, verify the Morby email still renders identically before and after.

---

## 7. Edits to `dashboard.html`

The dashboard already reads `deal_leads` in several places. Add deck engagement without restructuring the page.

**7.1** When a deal (card) is opened in the posting dashboard, fetch its views:
```js
const { data: views } = await supa
  .from("deck_views")
  .select("buyer_id, viewed_at")
  .eq("card_id", cardId);
```
Compute: `totalViews = views.length`, and a `Map(buyer_id -> count)`.

**7.2** In the existing per-deal pipeline / leads render (find the block that maps over `deal_leads` rows for the open card):
- Show a deal-level summary line: **"👁 {totalViews} views · {interestedCount} interested"** where `interestedCount` counts leads with `stage` in `interested/offer/under_contract`.
- For each lead row, if `source === 'deck_page'`, render a small gold pill **"deck"**.
- For each lead with a matching `buyer_id` in the views map, append **"· viewed {n}×"**.
- Sort so `source==='deck_page'` and `stage==='interested'` leads surface at the top (these are the call-now list).

**7.3** (Optional) On the main dashboard deal list, add a tiny **"{n}👁"** counter per card from a grouped `deck_views` count, so the operator sees which deals are getting attention at a glance.

Acceptance for this section is visual: opening a deal that has views shows the counts and the deck pills; a fresh deal shows "0 views" cleanly (empty state reads as an invitation, not an error).

---

## 8. Environment variables

| Var | Required | Purpose | Default |
|---|---|---|---|
| `DECK_TOKEN_SECRET` | no | HMAC secret for deck links | falls back to `UNSUB_SECRET`, then service key |
| `NOTIFY_EMAIL` | no | where "🔥 Interested" alerts go | falls back to `GMAIL_FROM_ADDRESS` |
| `DECK_REQUIRE_TOKEN` | no | if `"true"`, hide financials from untokenized visitors | `"false"` (public, matches today) |

All others already exist. If `NOTIFY_EMAIL` and Resend are unset, interest alerts are simply skipped — nothing breaks.

---

## 9. `netlify.toml`

The existing rewrite already routes `/deck/*` → the function and passes `:splat` as `slug`, preserving the original `?b=` query. **No change needed.** Confirm it still reads:
```toml
[[redirects]]
  from = "/deck/*"
  to = "/.netlify/functions/deck?slug=:splat"
  status = 200
```
`deck-interest` is called directly at `/.netlify/functions/deck-interest` — no redirect required. Leave the scheduled-function blocks untouched.

---

## 10. Acceptance criteria (must all pass)

1. Running migration 020 adds `properties.deck_slug` (unique, nullable) and `deck_views` with RLS; re-running is a no-op.
2. A live blast on a fresh deal populates `properties.deck_slug` exactly once and emits per-recipient links `…/deck/<slug>?b=<id>.<hmac>` in both email CTA and SMS.
3. `GET /deck/<slug>?b=<validToken>` returns 200 HTML, greets the buyer by first name, shows the correct hero (Morby cash-at-close / Sub-To entry fee), terms, gallery, and inserts one `deck_views` row with the right `buyer_id`.
4. Tapping **I'm interested** (tokenized) inserts/advances exactly one `deal_leads` row with `source='deck_page'`, `channel='deck'`, `stage='interested'`, and logs a `buyer_activity` touch. Tapping again does not create duplicates and does not downgrade a lead already at `offer`/`under_contract`/`closed`.
5. `GET /deck/<slug>` with **no** token still renders; tapping Interested opens the name/contact dialog and creates an external `deal_leads` row (`buyer_id null`), deduped on `card_id+contact`.
6. `GET /deck/<slug>.pdf` and `?format=pdf` still 302 to the Storage PDF (old links unbroken).
7. A deal whose `property_status.status` is `sold`/`pending` shows the badge and no Interested button.
8. Dashboard: opening a deal with views shows the view count, deck pills on deck-sourced leads, and per-buyer "viewed n×".
9. Unknown slug → branded 404, not a stack trace. Supabase/Resend outage → the page still renders (view logging and notify are non-fatal).
10. No secret is ever placed in a URL beyond the `id.hmac` token; the token cannot be forged (tampering the id fails `verifyDeckToken`).

---

## 11. Test plan

**Local (`netlify dev`):**
1. Run migration 020 against the dev database.
2. Manually set a `deck_slug` on one test property, or trigger a test blast.
3. Mint a token in a node REPL: `require('./netlify/functions/lib/deck-token').deckToken(<realBuyerId>)`.
4. Open `http://localhost:8888/deck/<slug>?b=<token>` — verify render + a new `deck_views` row.
5. Tap Interested — verify `deal_leads` + `buyer_activity` rows; tap again — verify no dupe.
6. Open `…/deck/<slug>` (no token) → tap Interested → fill dialog → verify external lead.
7. `curl` the interest endpoint directly:
```bash
curl -X POST http://localhost:8888/.netlify/functions/deck-interest \
  -H 'Content-Type: application/json' \
  -d '{"slug":"<slug>","token":"<token>"}'
```
8. Hit `…/deck/<slug>.pdf` → expect 302 to Storage.

**Prod smoke (after deploy):** send a **test-mode** blast to yourself, tap the real link on a phone, confirm the row lands and the dashboard reflects it. Only then send a live blast.

---

## 12. Rollout & rollback

**Rollout:** (1) run migration 020, (2) deploy the two new libs + `deck-interest.js` + rewritten `deck.js`, (3) deploy the `send-blast.js` edits, (4) deploy the dashboard edits. Links start appearing on the next blast; nothing changes for already-sent PDF links.

**Rollback:** revert the `send-blast.js` link injection (blasts stop emitting page links) and, if needed, restore the old one-line `deck.js` redirect. The `.pdf` route in the new `deck.js` already reproduces the old behavior, so reverting `deck.js` is usually unnecessary. `deck_views` and `deal_leads` rows are harmless if left. The migration is additive — no destructive rollback required.

---

## 13. Out of scope for v1 (v2 backlog)

- **Dwell time:** `navigator.sendBeacon` on `visibilitychange` → update `deck_views.dwell_seconds` (column already reserved). Add a `?ping=1` branch to `deck-interest` or a tiny `deck-ping` function.
- **Per-variation deck pages** to A/B test copy on the page itself (you already log `variation_index` on blasts).
- **Two-way inbox** so the operator replies from the dashboard (pairs with the `ghl-inbound` webhook).
- **Bounce/complaint webhooks** (Resend) → flip `email_opt_out` — separate hardening item from the earlier audit; do this soon regardless.

---

## 14. Build order for Claude Code

1. Write migration `020_deck_pages.sql`; run it against dev.
2. Add `lib/deck-token.js` and `lib/deck-content.js`.
3. Add `deck-interest.js`.
4. Rewrite `deck.js` (consult the `frontend-design` skill for the page; reuse the brand tokens in §5.1).
5. Edit `send-blast.js` per §6 (imports → `ensureDeckSlug` → thread `deckPageUrl` into email + SMS). Optional §6.5 dedupe.
6. Edit `dashboard.html` per §7.
7. Run the full §11 test plan locally; fix until every §10 criterion passes.
8. Deploy per §12; verify with a test-mode blast before going live.

**Guardrails:** don't touch the scheduled functions, the RLS pattern, or the auth flow. Keep every new template pulling terms from `lib/deck-content.js` so the page and emails can't drift. Every DB write from the public functions goes through the service key; never expose it to the page. If any step requires a schema change beyond §3, stop and surface it rather than improvising.
