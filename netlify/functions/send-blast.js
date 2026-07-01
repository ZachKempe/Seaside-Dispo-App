// On-demand "Send Blast" function — triggered by the Posting Dashboard.
// Emails (via Resend ESP, falling back to Gmail) and texts (GHL) matched buyers
// about a deal, with:
//   R2 — strategy-aware matching (cash buyers don't get Sub-To deals)
//   R3 — per-recipient logging (blast_recipients) + recipient-level idempotency
//        (resumes after a timeout, retries only failures)
//   D1 — real ESP with per-recipient unsubscribe + List-Unsubscribe header
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const crypto = require("crypto");

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ── Email: Resend (preferred) with Gmail fallback ──
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || ""; // e.g. "Seaside Horizon <deals@seasidehorizon.com>"

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || "";
const GMAIL_FROM_NAME = process.env.GMAIL_FROM_NAME || "Seaside Horizon";
const GMAIL_REPLY_TO = process.env.GMAIL_REPLY_TO || GMAIL_FROM_ADDRESS;

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_FROM_NUMBER = process.env.GHL_FROM_NUMBER;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

const SITE_URL = process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app";
const UNSUB_SECRET = process.env.UNSUB_SECRET || SB_SERVICE_KEY || "seaside-unsub";

const CONTACT_NAME = process.env.MARKETING_CONTACT_NAME || "Seaside Horizon";
const CONTACT_PHONE = process.env.MARKETING_CONTACT_PHONE || "";
const LOGO_URL = "https://seaside-dispo-app.netlify.app/img/logo.png";
const BRAND_NAVY = "#1B3A6B";
const BRAND_NAVY_DARK = "#112950";
const BRAND_GOLD = "#D4A03E";

const EMAIL_CONCURRENCY = 25; // parallel sends per chunk (Resend path)

// ── Supabase helper ──────────────────────────────────────────────
async function sb(path, opts = {}, key = SB_SERVICE_KEY) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// ── R2: buyer matching now respects strategy ─────────────────────
// A buyer matches a deal if their strategy is "all" or equals the deal's
// strategy (subto / morby). State/price/PITI/beds filters unchanged.
function matches(buyer, dealStrategy, state, price, piti, beds) {
  const strat = (buyer.strategy || "all").toLowerCase();
  if (strat !== "all" && dealStrategy && strat !== dealStrategy) return false;
  const states = (buyer.states || "").trim();
  if (states && state && !states.split(",").map(s => s.trim().toUpperCase()).includes(state.toUpperCase())) return false;
  if (buyer.max_price > 0 && price > 0 && price > buyer.max_price) return false;
  if (buyer.max_piti > 0 && piti > 0 && piti > buyer.max_piti) return false;
  if (buyer.min_beds > 0 && beds > 0 && beds < buyer.min_beds) return false;
  return true;
}

// ── R3: per-recipient logging + recipient-level idempotency ──────
async function buyerIdsByStatus(cardId, channel, status) {
  const rows = await sb(
    `/blast_recipients?card_id=eq.${encodeURIComponent(cardId)}&channel=eq.${channel}&status=eq.${status}&select=buyer_id`,
    { method: "GET" }
  );
  return new Set((rows || []).map(r => Number(r.buyer_id)).filter(Boolean));
}
async function logRecipientsBulk(rows) {
  if (!rows.length) return;
  await sb(`/blast_recipients`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
}
function recipientRow(cardId, buyer, address, channel, recipient, status, variation, detail = "") {
  const row = { card_id: cardId, buyer_id: buyer ? buyer.id : null, address, channel, recipient, status, detail };
  if (variation) {
    if (variation.index !== null && variation.index !== undefined) row.variation_index = variation.index;
    if (variation.title) row.variation_title = variation.title;
  }
  return row;
}

// ── deal_blasts aggregate logging (kept for the dashboard summary) ──
async function logBlast(cardId, address, channel, status, detail, variation) {
  const row = { card_id: cardId, address, channel, status, detail };
  if (variation) {
    if (variation.index !== null && variation.index !== undefined) row.variation_index = variation.index;
    if (variation.title) row.variation_title = variation.title;
  }
  await sb(`/deal_blasts`, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

// ── D1: per-buyer unsubscribe token ──────────────────────────────
function unsubToken(buyerId) {
  const h = crypto.createHmac("sha256", UNSUB_SECRET).update(String(buyerId)).digest("hex").slice(0, 16);
  return `${buyerId}.${h}`;
}
function unsubUrlFor(buyerId) {
  return `${SITE_URL}/.netlify/functions/unsubscribe?b=${encodeURIComponent(unsubToken(buyerId))}`;
}

// ── Email content ─────────────────────────────────────────────────
function fmtMoney(n) { n = Number(n) || 0; return n ? `$${n.toLocaleString()}` : "—"; }

function buildDealCopyText(prop, terms) {
  const beds = terms.beds || "—";
  const baths = terms.baths || "—";
  const sqft = terms.sqft ? Number(terms.sqft).toLocaleString() : "—";
  const year = terms.year_built || "—";
  const entryFee = Number(terms.entry_fee) || 0;
  const price = Number(terms.price) || 0;
  const loanBalance = Number(terms.mortgage) || 0;
  const piti = Number(terms.piti) || 0;
  const rate = terms.rate || "—";
  const phone = CONTACT_PHONE || "630-488-5311";

  const addrParts = (prop.name || "").split(",").map(s => s.trim()).filter(Boolean);
  const city = addrParts.length >= 2 ? addrParts[1] : "";
  const market = city ? [city, prop.state].filter(Boolean).join(", ") : [prop.name, prop.state].filter(Boolean).join(", ");

  let text = `🏠 ${prop.name || ""}
${beds} bd / ${baths} ba • ${sqft} sqft • ${year}

💰 DEAL TERMS:
Entry Fee: $${entryFee.toLocaleString()} + TC + CC
Purchase Price: $${price.toLocaleString()}
Existing Loan Balance: $${loanBalance.toLocaleString()}
PITI: $${piti.toLocaleString()}/mo
Rate: ${rate}%

📍 Market: ${market}
🏷️ Strategy: Sub-To`;

  if (prop.drive_link) text += `\n📸 Photos: ${prop.drive_link}`;
  text += `\n\nInterested? Reply here or call/text Zach @ ${phone}`;
  return text;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildHtmlEmail(prop, terms, unsubUrl, coverImageUrl) {
  const city = prop.name || "";
  const entryFee = Number(terms.entry_fee) || 0;
  const subject = `🏡 New SubTo Deal — ${city} | ${entryFee ? "$" + entryFee.toLocaleString() : "Ask"} Entry Fee`;
  const dealCopy = buildDealCopyText(prop, terms);
  const coverImageTag = coverImageUrl
    ? `<img src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(city)}" width="140" style="display:block;float:right;width:140px;height:140px;object-fit:cover;border-radius:8px;margin:0 0 10px 14px">`
    : "";
  const dealCopyBlock = `<tr><td style="padding:20px 32px 0">
         <div style="background:#F7FAFC;border-left:3px solid #1B3A6B;border-radius:6px;padding:14px 18px;font-size:13.5px;line-height:1.6;color:#2D3748">${coverImageTag}<div style="white-space:pre-wrap">${escapeHtml(dealCopy)}</div></div>
       </td></tr>`;

  const unsubFooter = unsubUrl
    ? `<tr><td style="padding:6px 32px 16px;font-size:11px;color:#A0AEC0;background:#fff">You're receiving this because you're on Seaside Horizon's buyer list. <a href="${escapeHtml(unsubUrl)}" style="color:#A0AEC0;text-decoration:underline">Unsubscribe</a>.</td></tr>`
    : "";

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F8;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0">
        <tr><td style="background:linear-gradient(135deg, ${BRAND_NAVY_DARK} 0%, ${BRAND_NAVY} 100%);background-color:${BRAND_NAVY_DARK};padding:24px 32px;color:#fff">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;padding-right:14px"><img src="${LOGO_URL}" alt="Seaside Horizon" width="44" height="44" style="display:block;border-radius:8px;background:#fff;padding:4px"></td>
            <td style="vertical-align:middle">
              <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700">Seaside Horizon</div>
              <div style="font-size:21px;font-weight:700;margin-top:3px;color:#fff">${escapeHtml(city)}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${BRAND_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="background:#F7FAFC;padding:16px 32px;color:${BRAND_NAVY};font-size:14px;font-weight:600;border-bottom:1px solid #E2E8F0">
          ${terms.beds ? `${terms.beds} bd / ${terms.baths || "—"} ba` : ""} ${terms.sqft ? ` · ${Number(terms.sqft).toLocaleString()} sqft` : ""}
        </td></tr>
        ${dealCopyBlock}
        <tr><td style="padding:8px 32px 24px">
          ${prop.drive_link ? `<div style="margin-top:10px"><a href="${escapeHtml(prop.drive_link)}" style="display:inline-block;background:${BRAND_NAVY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid ${BRAND_GOLD}">📸 View Photos (Google Drive)</a></div>` : ""}
        </td></tr>
        <tr><td style="background:${BRAND_NAVY_DARK};padding:22px 32px;color:#fff;border-top:3px solid ${BRAND_GOLD}">
          <div style="font-size:14px;font-weight:700;color:#fff">${escapeHtml(CONTACT_NAME)}</div>
          ${CONTACT_PHONE ? `<div style="font-size:13px;color:${BRAND_GOLD};margin-top:2px;font-weight:600">${escapeHtml(CONTACT_PHONE)}</div>` : ""}
        </td></tr>
        ${unsubFooter}
      </table>
    </td></tr>
  </table>`;
  return { subject, html };
}

// ── ESP send: Resend (preferred) ─────────────────────────────────
async function sendViaResend(to, subject, html, unsubUrl, attachments) {
  const body = {
    from: RESEND_FROM,
    to: [to],
    subject,
    html,
    headers: unsubUrl ? {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    } : undefined,
  };
  if (attachments && attachments.length) body.attachments = attachments;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
}

// ── Morby / Stack Method Deal Deck email ─────────────────────────
function buildMorbyEmail(prop, morby, unsubUrl) {
  const address = prop.address_override || prop.name || "";
  const subject = `📊 Stack Method Deal — ${address}`;
  const fmtM = (n) => n ? `$${Number(n).toLocaleString()}` : "—";
  const fmtPct = (n) => n ? `${Number(n).toFixed(2)}%` : "—";

  const rows = [
    ["Purchase Price",    fmtM(morby.purchase_price)],
    ["Down Payment",      fmtM(morby.down_payment)],
    ["Seller Carry",      fmtM(morby.seller_carry_balance)],
    ["Monthly Payment",   fmtM(morby.monthly_payment)],
    ["Deferred Rate",     fmtPct(morby.deferred_interest_rate)],
    ["Balloon",           morby.balloon_months ? `${morby.balloon_months} months` : "—"],
    ["Inspection Period", morby.inspection_period_days ? `${morby.inspection_period_days} days` : "—"],
    ["Close of Escrow",   morby.close_of_escrow_days ? `${morby.close_of_escrow_days} days` : "—"],
  ].filter(([, v]) => v && v !== "—");

  const termRows = rows.map(([label, val]) =>
    `<tr><td style="padding:6px 12px;color:#718096;font-size:13px;border-bottom:1px solid #EDF2F7">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 12px;font-weight:600;font-size:13px;color:#1A202C;border-bottom:1px solid #EDF2F7">${escapeHtml(val)}</td></tr>`
  ).join("");

  const unsubFooter = unsubUrl
    ? `<tr><td colspan="2" style="padding:6px 32px 16px;font-size:11px;color:#A0AEC0;background:#fff">You're receiving this because you're on Seaside Horizon's buyer list. <a href="${escapeHtml(unsubUrl)}" style="color:#A0AEC0;text-decoration:underline">Unsubscribe</a>.</td></tr>`
    : "";

  const html = `
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0F4F8;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E2E8F0">
        <tr><td style="background:linear-gradient(135deg,${BRAND_NAVY_DARK} 0%,${BRAND_NAVY} 100%);padding:24px 32px;color:#fff">
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;padding-right:14px"><img src="${LOGO_URL}" alt="Seaside Horizon" width="44" height="44" style="display:block;border-radius:8px;background:#fff;padding:4px"></td>
            <td style="vertical-align:middle">
              <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700">Seaside Horizon · Stack Method</div>
              <div style="font-size:21px;font-weight:700;margin-top:3px;color:#fff">${escapeHtml(address)}</div>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="height:4px;background:${BRAND_GOLD};font-size:0;line-height:0">&nbsp;</td></tr>
        <tr><td style="padding:20px 32px 8px;color:${BRAND_NAVY};font-size:14px">
          <p style="margin:0 0 16px">Hi — I have a new Stack Method deal I wanted to share with you. The full Deal Deck is attached as a PDF with all the financials.</p>
          <p style="margin:0 0 12px;font-weight:700;color:${BRAND_NAVY}">Deal Snapshot:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:8px;overflow:hidden">
            ${termRows}
          </table>
        </td></tr>
        <tr><td style="padding:16px 32px 20px">
          <p style="margin:0;font-size:13px;color:#4A5568">📎 <strong>Full Deal Deck attached</strong> — review the complete financial analysis, DSCR breakdown, and property details.</p>
          ${CONTACT_PHONE ? `<p style="margin:8px 0 0;font-size:13px;color:#4A5568">Interested? Reply to this email or call/text <strong>${escapeHtml(CONTACT_NAME)}</strong> at <strong>${escapeHtml(CONTACT_PHONE)}</strong>.</p>` : ""}
        </td></tr>
        <tr><td style="background:${BRAND_NAVY_DARK};padding:16px 32px;color:#fff">
          <div style="font-size:14px;font-weight:700">${escapeHtml(CONTACT_NAME)}</div>
          ${CONTACT_PHONE ? `<div style="font-size:13px;color:${BRAND_GOLD};margin-top:2px;font-weight:600">${escapeHtml(CONTACT_PHONE)}</div>` : ""}
        </td></tr>
        ${unsubFooter}
      </table>
    </td></tr>
  </table>`;

  return { subject, html };
}

// ── Gmail fallback ────────────────────────────────────────────────
async function gmailAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
function buildRawMessage({ to, subject, html, unsubUrl }) {
  const headers = [
    `From: ${GMAIL_FROM_NAME} <${GMAIL_FROM_ADDRESS}>`,
    `To: ${to}`,
    `Reply-To: ${GMAIL_REPLY_TO}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
  ];
  if (unsubUrl) {
    headers.push(`List-Unsubscribe: <${unsubUrl}>`);
    headers.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`);
  }
  const raw = `${headers.join("\r\n")}\r\n\r\n${html}`;
  return Buffer.from(raw, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sendViaGmail(accessToken, to, subject, html, unsubUrl) {
  const raw = buildRawMessage({ to, subject, html, unsubUrl });
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send -> ${r.status}: ${await r.text()}`);
}

// ── GHL SMS ───────────────────────────────────────────────────────
function normalizePhone(phone) {
  let p = (phone || "").replace(/[\s\-().]/g, "");
  if (!p) return "";
  if (!p.startsWith("+")) p = p.length === 10 ? `+1${p}` : `+${p}`;
  return p;
}
async function ghlContactId(phone) {
  const headers = { Authorization: `Bearer ${GHL_API_KEY}`, "Content-Type": "application/json", Version: "2021-04-15" };
  let r = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate?phone=${encodeURIComponent(phone)}`, { headers });
  if (r.ok) {
    const data = await r.json();
    if (data && data.contact && data.contact.id) return data.contact.id;
  }
  r = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
    method: "POST", headers, body: JSON.stringify({ phone, locationId: GHL_LOCATION_ID }),
  });
  if (!r.ok) throw new Error(`GHL create contact -> ${r.status}: ${await r.text()}`);
  const data = await r.json();
  if (!data || !data.contact || !data.contact.id) throw new Error("GHL: no contact id returned");
  return data.contact.id;
}
async function sendSms(phone, message) {
  const e164 = normalizePhone(phone);
  if (!e164) throw new Error("no phone");
  const contactId = await ghlContactId(e164);
  const r = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, "Content-Type": "application/json", Version: "2021-04-15" },
    body: JSON.stringify({ type: "SMS", contactId, fromNumber: GHL_FROM_NUMBER, message }),
  });
  if (!r.ok) throw new Error(`GHL send SMS -> ${r.status}: ${await r.text()}`);
}

// ── Handler ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    const { card_id, channels, test, test_email, test_phone, buyer_ids, retry_failed,
            variation_index, variation_title, variation_body,
            deal_deck_pdf } = JSON.parse(event.body || "{}");
    if (!card_id) return { statusCode: 400, body: "card_id required" };

    const variation = (variation_body || variation_title)
      ? { index: Number.isInteger(variation_index) ? variation_index : null, title: variation_title || "", body: variation_body || "" }
      : null;
    const variationTag = variation ? ` [variation: ${variation.title || `#${variation.index}`}]` : "";
    const wantEmail = !channels || channels.includes("email");
    const wantSms = !channels || channels.includes("sms");
    const isTest = !!test;
    const retryMode = !!retry_failed;
    const targeted = Array.isArray(buyer_ids) && buyer_ids.length > 0;
    const targetIdSet = targeted ? new Set(buyer_ids.map(Number)) : null;
    const useResend = !!(RESEND_API_KEY && RESEND_FROM);

    const [props, termsRows, acqRows, buyers, morbyRows] = await Promise.all([
      sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`, { method: "GET" }),
      sb(`/deal_terms?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`, { method: "GET" }),
      sb(`/deal_acquisition?card_id=eq.${encodeURIComponent(card_id)}&select=cover_image_url&limit=1`, { method: "GET" }),
      sb(`/buyers?active=eq.true&select=*`, { method: "GET" }),
      sb(`/morby_deals?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`, { method: "GET" }),
    ]);
    const prop = (props || [])[0];
    if (!prop) return { statusCode: 404, body: "property not found" };
    const terms = (termsRows || [])[0] || {};
    const morbyTerms = (morbyRows || [])[0] || {};
    const coverImageUrl = ((acqRows || [])[0] || {}).cover_image_url || "";
    const address = prop.name || prop.card_id;
    const dealStrategy = prop.deal_type === "morby" ? "morby" : "subto";
    const price = Number(terms.price) || 0;
    const piti = Number(terms.piti) || 0;
    const beds = Number(terms.beds) || 0;

    const matched = targeted
      ? (buyers || []).filter(b => targetIdSet.has(Number(b.id)))
      : (buyers || []).filter(b => matches(b, dealStrategy, prop.state, price, piti, beds));

    const result = { email: null, sms: null, test: isTest, targeted, retry: retryMode, esp: useResend ? "resend" : "gmail" };
    const recipientRows = [];

    // Morby/Stack deals email the Deal Deck PDF as an attachment. Strip the
    // data URI prefix if present so Resend gets a plain base64 content string.
    const isMorbyDeck = !!(deal_deck_pdf && dealStrategy === "morby");
    // jsPDF's datauristring prefix is "data:application/pdf;filename=generated.pdf;base64,"
    // — split on "base64," and take the tail to get clean base64 for Resend,
    // robust to whatever params the data-URI carries.
    const pdfAttachments = isMorbyDeck ? [{
      filename: `Deal Deck - ${(prop.address_override || prop.name || card_id).replace(/[\\/:*?"<>|]/g, "")}.pdf`,
      content: deal_deck_pdf.split("base64,").pop(),
    }] : null;

    // Helper: build email content, swapping to the Morby template when needed.
    const buildEmail = (unsubUrl) => isMorbyDeck
      ? buildMorbyEmail(prop, morbyTerms, unsubUrl)
      : buildHtmlEmail(prop, terms, unsubUrl, coverImageUrl);

    // ── TEST MODE: single preview to the caller; no real buyers, no logging ──
    if (isTest) {
      if (wantEmail) {
        const to = test_email || user.email;
        const { subject, html } = buildEmail(unsubUrlFor("preview"));
        const testSubject = `[TEST] ${subject}`;
        const banner = `<div style="background:#FEEBC8;color:#7B341E;padding:10px 16px;font:600 13px Arial;border-radius:8px 8px 0 0">⚠️ TEST SEND — preview only, sent to ${escapeHtml(to)}, would normally go to ${matched.filter(b => b.email && !b.email_opt_out).length} matching buyer(s)</div>`;
        if (!to) {
          result.email = { sent: 0, failed: 1, error: "no test email address available" };
        } else if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN)) {
          result.email = { sent: 0, failed: 0, error: "No email provider configured (set RESEND_API_KEY+RESEND_FROM or Gmail creds)" };
        } else {
          try {
            if (useResend) await sendViaResend(to, testSubject, banner + html, null, pdfAttachments);
            else await sendViaGmail(await gmailAccessToken(), to, testSubject, banner + html, null);
            result.email = { sent: 1, failed: 0, to, would_reach: matched.filter(b => b.email && !b.email_opt_out).length };
          } catch (e) { result.email = { sent: 0, failed: 1, error: e.message }; }
        }
      }
      if (wantSms) {
        const to = test_phone || CONTACT_PHONE;
        if (!GHL_API_KEY || !GHL_FROM_NUMBER) result.sms = { sent: 0, failed: 0, note: "GHL SMS not configured" };
        else if (!to) result.sms = { sent: 0, failed: 1, error: "no test phone number available" };
        else {
          try {
            await sendSms(to, `[TEST]\n${buildDealCopyText(prop, terms)}`);
            const smsWouldReach = targeted
              ? matched.filter(b => b.sms_opt_in && b.phone).length
              : matched.filter(b => b.tier === "A" && b.sms_opt_in && b.phone).length;
            result.sms = { sent: 1, failed: 0, to, would_reach: smsWouldReach };
          } catch (e) { result.sms = { sent: 0, failed: 1, error: e.message }; }
        }
      }
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
    }

    // ── LIVE MODE ──
    const tag = (targeted ? ` [targeted: ${matched.length}]` : "") + (retryMode ? " [retry-failed]" : "") + variationTag;

    // ── EMAIL ──
    if (wantEmail) {
      if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN)) {
        result.email = { sent: 0, failed: 0, error: "No email provider configured" };
      } else {
        let emailBuyers = matched.filter(b => b.email && !b.email_opt_out);
        // R3: recipient-level idempotency. A normal full blast skips anyone
        // already 'sent'; retry mode targets only prior failures.
        if (retryMode) {
          const failed = await buyerIdsByStatus(card_id, "email", "failed");
          const sent = await buyerIdsByStatus(card_id, "email", "sent");
          emailBuyers = emailBuyers.filter(b => failed.has(Number(b.id)) && !sent.has(Number(b.id)));
        } else if (!targeted) {
          const sent = await buyerIdsByStatus(card_id, "email", "sent");
          emailBuyers = emailBuyers.filter(b => !sent.has(Number(b.id)));
        }

        if (!emailBuyers.length) {
          result.email = { sent: 0, failed: 0, note: retryMode ? "no failed recipients to retry" : "no new matching buyers" };
        } else {
          let token = null;
          if (!useResend) token = await gmailAccessToken();
          let sent = 0, failed = 0;
          for (let i = 0; i < emailBuyers.length; i += EMAIL_CONCURRENCY) {
            const chunk = emailBuyers.slice(i, i + EMAIL_CONCURRENCY);
            await Promise.all(chunk.map(async (b) => {
              const unsubUrl = unsubUrlFor(b.id);
              const { subject, html } = buildEmail(unsubUrl);
              try {
                if (useResend) await sendViaResend(b.email, subject, html, unsubUrl, pdfAttachments);
                else await sendViaGmail(token, b.email, subject, html, unsubUrl);
                sent++;
                recipientRows.push(recipientRow(card_id, b, address, "email", b.email, "sent", variation));
              } catch (e) {
                failed++;
                recipientRows.push(recipientRow(card_id, b, address, "email", b.email, "failed", variation, e.message.slice(0, 200)));
              }
            }));
          }
          await logBlast(card_id, address, "email", sent ? "sent" : "failed", `sent=${sent} failed=${failed}${tag}`, variation);
          result.email = { sent, failed };
        }
      }
    }

    // ── SMS ──
    if (wantSms) {
      if (!GHL_API_KEY || !GHL_FROM_NUMBER) {
        result.sms = { sent: 0, failed: 0, note: "GHL SMS not configured" };
      } else {
        // Full auto blast: A-tier opted-in only (matches the old behavior).
        // Targeted: honor picks but still require opt-in + phone.
        let smsBuyers = targeted
          ? matched.filter(b => b.sms_opt_in && b.phone)
          : matched.filter(b => b.tier === "A" && b.sms_opt_in && b.phone);
        if (retryMode) {
          const failed = await buyerIdsByStatus(card_id, "sms", "failed");
          const sent = await buyerIdsByStatus(card_id, "sms", "sent");
          smsBuyers = smsBuyers.filter(b => failed.has(Number(b.id)) && !sent.has(Number(b.id)));
        } else if (!targeted) {
          const sent = await buyerIdsByStatus(card_id, "sms", "sent");
          smsBuyers = smsBuyers.filter(b => !sent.has(Number(b.id)));
        }

        if (!smsBuyers.length) {
          result.sms = { sent: 0, failed: 0, note: retryMode ? "no failed texts to retry" : "no new opted-in buyers with a phone" };
        } else {
          let sent = 0, failed = 0;
          const message = buildDealCopyText(prop, terms);
          for (const b of smsBuyers) {
            try {
              await sendSms(b.phone, message); sent++;
              recipientRows.push(recipientRow(card_id, b, address, "sms", b.phone, "sent", variation));
            } catch (e) {
              failed++;
              recipientRows.push(recipientRow(card_id, b, address, "sms", b.phone, "failed", variation, e.message.slice(0, 200)));
            }
          }
          await logBlast(card_id, address, "sms", sent ? "sent" : "failed", `sent=${sent} failed=${failed}${tag}`, variation);
          result.sms = { sent, failed };
        }
      }
    }

    await logRecipientsBulk(recipientRows);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("send-blast error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
