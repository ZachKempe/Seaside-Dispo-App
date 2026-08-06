// GET  /buy-box?t=<deckToken>  -> the buyer's own buy-box form, prefilled
// POST /buy-box                -> saves it, renders what's saved / still missing
//
// C2 — the ask that finishes the loop C1 opened. A deck hand-raise now creates
// a buyer (deck-interest.js), but it creates a BLANK one, and matchesDeal
// treats blank as a wildcard: they receive every deal we ever send, which is
// exactly how a list gets trained to ignore us. This is where that buyer tells
// us what they actually buy, linked from the interest receipt they get seconds
// after tapping — the moment they are most willing to answer.
//
// Deliberately a plain <form method="POST">: no fetch, no client JS, no build
// step. It is opened from an email on a phone by someone who has never used
// our software, and the most robust thing that can happen is a form submit.
//
// Auth is the same per-buyer HMAC as a deck link (lib/deck-token.js) — not a
// secret, just unforgeable. The investor never has to identify themselves
// again, which is most of why this converts at all.
//
// Parsing, the write rules and the link itself live in lib/buy-box-form.js.
"use strict";

const { verifyDeckToken } = require("./lib/deck-token");
const {
  STRATEGY_PILLS, missingParts, buyBoxPatch, applyPatch, checkedPillValues,
} = require("./lib/buy-box-form");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = (process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app").replace(/\/+$/, "");
const LOGO_URL = `${SITE_URL}/img/logo.png`;
// The public questionnaire, for anyone who lands here without a usable token
// (a forwarded receipt, a mangled link). Same default as onboard-buyers.js.
const FORM_URL = process.env.BUYER_FORM_URL || "https://seaside-buyer-questionnaire.netlify.app/";
const CONTACT_NAME = process.env.MARKETING_CONTACT_NAME || "Zach — Seaside Horizon";

// Same palette deck.js renders the deal page with, so this reads as the next
// step of the page they came from rather than a different product.
const NAVY = "#1B3A6B", NAVY_DARK = "#112950", GOLD = "#D4A03E", GOLD_LT = "#E8C878";
const PAPER = "#FBFAF6", INK = "#20304D", MUTED = "#8A94A6", LINE = "#EAE4D7", GREEN = "#1F7A54";

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const html = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  body,
});

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="${esc(LOGO_URL)}">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
 *{box-sizing:border-box}
 body{margin:0;background:${PAPER};font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${INK};-webkit-text-size-adjust:100%}
 .wrap{max-width:560px;margin:0 auto;padding:0 0 calc(40px + env(safe-area-inset-bottom))}
 .topbar{display:flex;align-items:center;gap:12px;padding:16px 22px;background:#fff;border-bottom:1px solid #ECE7DC}
 .rule{height:3px;background:linear-gradient(90deg,${GOLD} 0%,${GOLD_LT} 50%,${GOLD} 100%)}
 .card{margin:22px 20px 0;background:#fff;border:1px solid ${LINE};border-radius:18px;padding:24px 22px;box-shadow:0 18px 40px -26px rgba(17,41,80,.4)}
 h1{margin:0 0 8px;font-size:24px;line-height:1.25;letter-spacing:-.02em}
 .sub{margin:0 0 22px;font-size:14.5px;line-height:1.55;color:#718096}
 label.f{display:block;margin:0 0 7px;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${NAVY}}
 .hint{margin:6px 0 0;font-size:12px;line-height:1.45;color:${MUTED}}
 .field{margin:0 0 20px}
 input[type=text]{width:100%;padding:14px 15px;border:1px solid #D8CFB8;border-radius:11px;font-size:16px;font-family:inherit;background:#fff;color:${INK}}
 input[type=text]:focus{border-color:${GOLD};outline:none;box-shadow:0 0 0 3px rgba(212,160,62,.18)}
 .pills{display:grid;grid-template-columns:1fr 1fr;gap:9px}
 @media(max-width:420px){.pills{grid-template-columns:1fr}}
 .pill input{position:absolute;opacity:0;pointer-events:none}
 .pill span{display:block;padding:12px 13px;border:1px solid #D8CFB8;border-radius:12px;background:#fff;cursor:pointer;font-size:14px;font-weight:700;line-height:1.25}
 .pill span small{display:block;margin-top:3px;font-size:11.5px;font-weight:500;color:${MUTED}}
 .pill input:checked+span{border-color:${NAVY};background:#F4F1E8;box-shadow:0 0 0 2px rgba(27,58,107,.16)}
 .pill input:focus-visible+span{box-shadow:0 0 0 3px rgba(212,160,62,.35)}
 .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
 @media(max-width:420px){.two{grid-template-columns:1fr}}
 button{width:100%;font:800 16px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border:none;border-radius:13px;padding:16px;cursor:pointer;box-shadow:0 8px 20px -8px rgba(212,160,62,.7)}
 .note{margin:16px 20px 0;padding:13px 15px;border-radius:12px;font-size:13.5px;line-height:1.5;font-weight:600}
 .note.ok{background:#E4F4EC;border:1px solid #B7E3CC;color:${GREEN}}
 .note.warn{background:#FaF3DC;border:1px solid #EAD9A0;color:#8A6D1F}
 .foot{text-align:center;padding:26px 24px 10px;color:#A6AEBC;font-size:11.5px;line-height:1.6}
 a{color:${NAVY}}
</style></head><body><div class="wrap">
 <div class="topbar">
  <img src="${esc(LOGO_URL)}" alt="Seaside Horizon" style="width:38px;height:38px;object-fit:contain">
  <span style="font-size:13px;font-weight:800;letter-spacing:.14em;color:${NAVY};text-transform:uppercase">Seaside Horizon</span>
 </div>
 <div class="rule"></div>
 ${inner}
 <div class="foot">Seaside Horizon · we only use this to decide which deals to send you.</div>
</div></body></html>`;
}

// ── The form ──────────────────────────────────────────────────────────
// `note` is the banner above it (saved / nothing-to-save). `buyer` supplies
// the prefill, so a second visit shows what they already told us rather than
// an empty form that looks like it lost their answers.
function formPage({ token, buyer, note, firstName }) {
  const b = buyer || {};
  const checked = checkedPillValues(b.strategy);
  const val = (n) => (Number(n) > 0 ? String(n) : "");

  const pills = STRATEGY_PILLS.map((p) => `
    <label class="pill">
      <input type="checkbox" name="strategy" value="${esc(p.value)}"${checked.has(p.value) ? " checked" : ""}>
      <span>${esc(p.label)}<small>${esc(p.hint)}</small></span>
    </label>`).join("");

  return page("What are you buying?", `
 ${note || ""}
 <div class="card">
  <h1>${firstName ? `${esc(firstName)}, what are you buying?` : "What are you buying?"}</h1>
  <p class="sub">Right now we send you everything we contract. Tell us your box and we'll only send the ones that fit — about 60 seconds, and you can change it any time.</p>
  <form method="POST" action="/buy-box">
   <input type="hidden" name="t" value="${esc(token)}">

   <div class="field">
    <label class="f" for="states">Which states do you buy in?</label>
    <input type="text" id="states" name="states" value="${esc(b.states || "")}" placeholder="FL, GA, TX" autocomplete="off" autocapitalize="characters">
    <p class="hint">Names or abbreviations, comma separated.</p>
   </div>

   <div class="field">
    <label class="f">Which structures do you take?</label>
    <div class="pills">${pills}</div>
    <p class="hint">Pick every one that works for you — we'll send all of them.</p>
   </div>

   <div class="field">
    <div class="two">
     <div>
      <label class="f" for="max_price">Max purchase price</label>
      <input type="text" id="max_price" name="max_price" inputmode="numeric" value="${esc(val(b.max_price))}" placeholder="350000">
     </div>
     <div>
      <label class="f" for="max_piti">Max monthly payment</label>
      <input type="text" id="max_piti" name="max_piti" inputmode="numeric" value="${esc(val(b.max_piti))}" placeholder="2200">
     </div>
    </div>
    <p class="hint">Either one is enough. The monthly cap is the useful one on Subject-To, where you take over an existing payment.</p>
   </div>

   <div class="field">
    <label class="f" for="min_beds">Minimum bedrooms <span style="font-weight:500;text-transform:none;letter-spacing:0;color:${MUTED}">— optional</span></label>
    <input type="text" id="min_beds" name="min_beds" inputmode="numeric" value="${esc(val(b.min_beds))}" placeholder="3">
   </div>

   <button type="submit">Save my buy box</button>
  </form>
 </div>`);
}

function donePage({ firstName, missing, token, buyer }) {
  if (missing.length) {
    // Partial: say what's saved, say what's still open, and put the form right
    // back underneath. onboard-buyers.js keeps a partial buyer in the sequence
    // on purpose — half a buy box still misroutes deals — so finishing it here
    // is the cheapest possible fix for both of us.
    const note = `<div class="note warn">Saved — thanks. One thing still open: ${esc(missing.join(", "))}. Add it below and we can stop guessing.</div>`;
    return formPage({ token, buyer, note, firstName });
  }
  return page("Buy box saved", `
 <div class="card">
  <h1>That's everything${firstName ? `, ${esc(firstName)}` : ""}.</h1>
  <p class="sub">You'll only hear from us on deals that fit what you just told us — and you'll hear about those first. If your box changes, just open this link again.</p>
  <div class="note ok" style="margin:0">Saved: ${esc(String(buyer.states || "").replace(/,/g, ", "))}${buyer.max_price > 0 ? ` · up to $${Number(buyer.max_price).toLocaleString()}` : ""}${buyer.max_piti > 0 ? ` · up to $${Number(buyer.max_piti).toLocaleString()}/mo` : ""}${buyer.min_beds > 0 ? ` · ${buyer.min_beds}+ bd` : ""}</div>
  <p class="sub" style="margin:20px 0 0">Anything I should know that a form can't capture? Just reply to the email that brought you here — it comes straight to me.</p>
  <p class="sub" style="margin:14px 0 0">— <b>${esc(CONTACT_NAME)}</b></p>
 </div>`);
}

// Anyone without a usable token: a forwarded receipt, a truncated link. Send
// them to the public questionnaire rather than showing an error — they are
// volunteering information and we should take it however it arrives.
function noTokenPage() {
  return page("Tell us what you're buying", `
 <div class="card">
  <h1>Tell us what you're buying</h1>
  <p class="sub">This link is missing the part that tells us who you are — it may have been forwarded, or cut short by an email client. Our short questionnaire does the same job:</p>
  <p style="margin:0"><a href="${esc(FORM_URL)}" style="display:block;text-align:center;font:800 16px Inter,sans-serif;color:${NAVY_DARK};background:linear-gradient(180deg,${GOLD_LT},${GOLD});border-radius:13px;padding:16px;text-decoration:none">Open the questionnaire</a></p>
 </div>`);
}

// Netlify hands POST bodies through base64 when the client says binary.
function readForm(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf-8")
    : (event.body || "");
  const p = new URLSearchParams(raw);
  return {
    t: p.get("t") || "",
    states: p.get("states") || "",
    // Multi-select: every ticked pill arrives under the same name, and
    // parseStrategy reads exactly this comma list.
    strategy: p.getAll("strategy").join(","),
    max_price: p.get("max_price") || "",
    max_piti: p.get("max_piti") || "",
    min_beds: p.get("min_beds") || "",
  };
}

const BUYER_COLS = "id,name,states,strategy,max_price,max_piti,min_beds";

async function loadBuyer(buyerId) {
  const rows = await sb(`/buyers?id=eq.${buyerId}&select=${BUYER_COLS}&limit=1`);
  return (rows && rows[0]) || null;
}

function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  if (!first || first.includes("@")) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== "GET" && method !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const q = event.queryStringParameters || {};
    const form = method === "POST" ? readForm(event) : null;
    const buyerId = verifyDeckToken(method === "POST" ? form.t : q.t);
    if (!buyerId) return html(200, noTokenPage());

    const buyer = await loadBuyer(buyerId);
    // A soft-deleted or purged buyer: same treatment as a bad token. Never
    // resurrect a row from a link.
    if (!buyer) return html(200, noTokenPage());
    const firstName = firstNameOf(buyer.name);

    if (method === "GET") {
      return html(200, formPage({ token: q.t, buyer, firstName }));
    }

    const patch = buyBoxPatch(form);
    if (!Object.keys(patch).length) {
      return html(200, formPage({
        token: form.t, buyer, firstName,
        note: `<div class="note warn">Nothing came through on that one — add at least a state, a structure or a budget and we'll save it.</div>`,
      }));
    }

    await sb(`/buyers?id=eq.${buyerId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });

    // Timeline entry so the buyers page shows WHEN they told us, next to the
    // deck view and the hand-raise that led here. Best-effort: the answer is
    // already saved and must not be lost to a logging failure.
    try {
      await sb(`/buyer_activity`, {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          buyer_id: buyerId, channel: "form",
          detail: `Filled in their buy box: ${Object.keys(patch).join(", ")}`,
        }),
      });
    } catch (e) { console.warn("buy-box activity log failed:", e.message); }

    const updated = applyPatch(buyer, patch);
    // Nothing to do to stop the onboarding emails: dueTouch() reads
    // buyBoxCompleteness, so a box that just went "full" ends the sequence by
    // itself. That is why this writes buyer columns and not a flag.
    return html(200, donePage({
      firstName, missing: missingParts(updated), token: form.t, buyer: updated,
    }));
  } catch (err) {
    console.error("buy-box error:", err.message);
    return html(500, page("Something went wrong", `
 <div class="card">
  <h1>That didn't save</h1>
  <p class="sub">Something broke on our end — nothing you did. Try the link again in a minute, or just reply to the email and tell me what you're buying.</p>
 </div>`));
  }
};
