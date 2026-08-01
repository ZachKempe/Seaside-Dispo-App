// Blast core — the shared engine behind BOTH send entry points (F4):
//   • send-blast.js            — synchronous: 🧪 test mode + retry-failed
//   • send-blast-background.js — live blasts (Netlify background fn, 15-min budget)
// Emails (via Resend ESP, falling back to Gmail) and texts (GHL) matched buyers
// about a deal, with:
//   R2 — strategy-aware matching (cash buyers don't get Sub-To deals)
//   R3 — per-recipient logging (blast_recipients) + recipient-level idempotency
//        (resumes after a crash, retries only failures); rows are flushed
//        incrementally so the dashboard can poll live progress
//   D1 — real ESP with per-recipient unsubscribe + List-Unsubscribe header
//
// Lives in lib/ so Netlify doesn't deploy it as its own function. Callers
// verify auth (verifyUser) and map thrown errors' `.status` to HTTP codes.

const crypto = require("crypto");
const { deckToken } = require("./deck-token");
const { deckSlug, ensureDeckSlug } = require("./deck-slug");
const { subtoSubject, morbySubject } = require("./subjects");
const { fetchAllRows } = require("./fetch-all");
const { suppressedPhoneDigits } = require("./sms-optout");
const { digitsOnly } = require("./capture");
const { matchesDeal, buyerCashAtClose, morbyTermRows } = require("../../../public/js/deal-shared");

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
// CAN-SPAM requires a valid physical postal address in marketing email.
// Set MARKETING_POSTAL_ADDRESS in Netlify env (e.g. "123 Main St, Ste 4, Naperville, IL 60540").
const CONTACT_ADDRESS = process.env.MARKETING_POSTAL_ADDRESS || "";
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

// ── R2: buyer matching (strategy-aware) lives in lib — matchesDeal from
// public/js/deal-shared.js, the same function the dashboard preview runs. ──

// ── R3: per-recipient logging + recipient-level idempotency ──────
// Paged (F3): one blast to >1,000 buyers writes >1,000 ledger rows, and a
// truncated "sent" set here would re-send to everyone past row 1,000.
async function buyerIdsByStatus(cardId, channel, status) {
  const rows = await fetchAllRows(
    p => sb(p, { method: "GET" }),
    `/blast_recipients?card_id=eq.${encodeURIComponent(cardId)}&channel=eq.${channel}&status=eq.${status}&select=buyer_id`
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

// Slug creation lives in lib/deck-slug.js (shared with the intake functions
// and deck-link.js). This wrapper just binds our service-role sb helper.
function ensureDeckSlugLocal(prop) {
  return ensureDeckSlug(sb, prop);
}

// ── Email content ─────────────────────────────────────────────────
function buildDealCopyText(prop, terms) {
  const beds = terms.beds || "N/A";
  const baths = terms.baths || "N/A";
  const sqft = terms.sqft ? Number(terms.sqft).toLocaleString() : "N/A";
  const year = terms.year_built || "N/A";
  const entryFee = Number(terms.entry_fee) || 0;
  const price = Number(terms.price) || 0;
  const loanBalance = Number(terms.mortgage) || 0;
  const piti = Number(terms.piti) || 0;
  const rate = terms.rate || "N/A";
  const phone = CONTACT_PHONE || "630-488-5311";

  const addrParts = (prop.name || "").split(",").map(s => s.trim()).filter(Boolean);
  const city = addrParts.length >= 2 ? addrParts[1] : "";
  const market = city ? [city, prop.state].filter(Boolean).join(", ") : [prop.name, prop.state].filter(Boolean).join(", ");

  let text = `${prop.name || ""}
${beds} bd / ${baths} ba • ${sqft} sqft • ${year}

DEAL TERMS:
Entry Fee: $${entryFee.toLocaleString()} + TC + CC
Purchase Price: $${price.toLocaleString()}
Existing Loan Balance: $${loanBalance.toLocaleString()}
PITI: $${piti.toLocaleString()}/mo
Rate: ${rate}%

Market: ${market}
Strategy: Sub-To`;

  if (prop.drive_link) text += `\nPhotos: ${prop.drive_link}`;
  text += `\n\nInterested? Reply here or call/text ${CONTACT_NAME} at ${phone}`;
  return text;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildHtmlEmail(prop, terms, unsubUrl, coverImageUrl, buyer, deckUrlForBuyer) {
  const city = prop.name || "";
  const entryFee = Number(terms.entry_fee) || 0;
  const subject = subtoSubject(city, entryFee);
  const greeting = `Hi ${firstNameOf(buyer)},`;
  const dealCopy = buildDealCopyText(prop, terms);
  const coverImageTag = coverImageUrl
    ? `<img src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(city)}" width="140" style="display:block;float:right;width:140px;height:140px;object-fit:cover;border-radius:8px;margin:0 0 10px 14px">`
    : "";
  const dealCopyBlock = `<tr><td style="padding:20px 32px 0">
         <div style="background:#F7FAFC;border-left:3px solid #1B3A6B;border-radius:6px;padding:14px 18px;font-size:13.5px;line-height:1.6;color:#2D3748">${coverImageTag}<div style="white-space:pre-wrap">${escapeHtml(dealCopy)}</div></div>
       </td></tr>`;

  const addressLine = CONTACT_ADDRESS ? `<br>Seaside Horizon · ${escapeHtml(CONTACT_ADDRESS)}` : "";
  const unsubFooter = unsubUrl
    ? `<tr><td style="padding:6px 32px 16px;font-size:11px;color:#A0AEC0;background:#fff">You're receiving this because you're on Seaside Horizon's buyer list. <a href="${escapeHtml(unsubUrl)}" style="color:#A0AEC0;text-decoration:underline">Unsubscribe</a>.${addressLine}</td></tr>`
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
        <tr><td style="padding:18px 32px 0;color:${BRAND_NAVY};font-size:14px">
          <p style="margin:0">${escapeHtml(greeting)} here's a new Sub-To deal that fits your buy box:</p>
        </td></tr>
        <tr><td style="background:#F7FAFC;padding:16px 32px;color:${BRAND_NAVY};font-size:14px;font-weight:600;border-bottom:1px solid #E2E8F0">
          ${terms.beds ? `${terms.beds} bd / ${terms.baths || "N/A"} ba` : ""} ${terms.sqft ? ` · ${Number(terms.sqft).toLocaleString()} sqft` : ""}
        </td></tr>
        ${dealCopyBlock}
        <tr><td style="padding:8px 32px 24px">
          ${deckUrlForBuyer ? `<div><a href="${escapeHtml(deckUrlForBuyer)}" style="display:inline-block;background:${BRAND_NAVY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid ${BRAND_GOLD}">View deal &amp; respond</a></div>` : ""}
          ${prop.drive_link ? `<div style="margin-top:10px"><a href="${escapeHtml(prop.drive_link)}" style="display:inline-block;background:#fff;color:${BRAND_NAVY};text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid ${BRAND_NAVY}">View Photos (Google Drive)</a></div>` : ""}
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
// `tags` ({ buyer_id, card_id }) come back on Resend webhook events, letting
// resend-events.js attribute opens/clicks to a (buyer, deal) pair.
async function sendViaResend(to, subject, html, unsubUrl, attachments, tags) {
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
  if (tags) {
    // Resend allows only ASCII letters/digits/underscores/dashes in tag values.
    body.tags = Object.entries(tags)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([name, v]) => ({ name, value: String(v).replace(/[^a-zA-Z0-9_-]/g, "") }));
    if (!body.tags.length) delete body.tags;
  }
  if (attachments && attachments.length) body.attachments = attachments;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
}

// First name for a personalized greeting. Falls back to "there" when the
// buyer's name is missing or looks like an email address.
function firstNameOf(buyer) {
  const raw = (buyer && buyer.name || "").trim();
  const first = raw.split(/\s+/)[0];
  if (!first || first.includes("@")) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ── Morby / Stack Method Deal Deck email ─────────────────────────
// (buyerCashAtClose + the snapshot term rows come from lib/deal-shared, the
// same source the deck page renders from, so email and page can't drift.)
function buildMorbyEmail(prop, morby, unsubUrl, buyer, deckUrlForBuyer) {
  const address = prop.address_override || prop.name || "";
  const subject = morbySubject(address);
  const greeting = `Hi ${firstNameOf(buyer)},`;

  // Headline hook: estimated cash to the buyer at close (their assignment share).
  const cashAtClose = buyerCashAtClose(morby);
  const cashAtCloseBand = cashAtClose > 0 ? `
        <tr><td style="padding:18px 32px 0">
          <div style="background:#F0FFF4;border:2px solid #48BB78;border-radius:10px;padding:20px 22px;text-align:center">
            <div style="font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:#276749;font-weight:700">Cash to You at Close</div>
            <div style="font-size:40px;font-weight:800;color:#22543D;margin-top:4px;line-height:1.1">~$${Math.round(cashAtClose).toLocaleString()}</div>
            <div style="font-size:12px;color:#2F855A;margin-top:6px;font-weight:600">Estimated cash you receive at closing on this deal.</div>
          </div>
        </td></tr>` : "";

  const rows = morbyTermRows(morby);

  const termRows = rows.map(([label, val]) =>
    `<tr><td style="padding:6px 12px;color:#718096;font-size:13px;border-bottom:1px solid #EDF2F7">${escapeHtml(label)}</td>` +
    `<td style="padding:6px 12px;font-weight:600;font-size:13px;color:#1A202C;border-bottom:1px solid #EDF2F7">${escapeHtml(val)}</td></tr>`
  ).join("");

  const addressLine = CONTACT_ADDRESS ? `<br>Seaside Horizon · ${escapeHtml(CONTACT_ADDRESS)}` : "";
  const unsubFooter = unsubUrl
    ? `<tr><td colspan="2" style="padding:6px 32px 16px;font-size:11px;color:#A0AEC0;background:#fff">You're receiving this because you're on Seaside Horizon's buyer list. <a href="${escapeHtml(unsubUrl)}" style="color:#A0AEC0;text-decoration:underline">Unsubscribe</a>.${addressLine}</td></tr>`
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
        <tr><td style="padding:20px 32px 0;color:${BRAND_NAVY};font-size:14px">
          <p style="margin:0">${escapeHtml(greeting)} I have a new Stack Method deal I wanted to share with you. The full Deal Deck is attached as a PDF with all the financials.</p>
        </td></tr>
        ${cashAtCloseBand}
        <tr><td style="padding:16px 32px 8px;color:${BRAND_NAVY};font-size:14px">
          <p style="margin:0 0 12px;font-weight:700;color:${BRAND_NAVY}">Deal Snapshot:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E2E8F0;border-radius:8px;overflow:hidden">
            ${termRows}
          </table>
        </td></tr>
        <tr><td style="padding:16px 32px 20px">
          ${deckUrlForBuyer ? `<div style="margin:0 0 14px"><a href="${escapeHtml(deckUrlForBuyer)}" style="display:inline-block;background:${BRAND_NAVY};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;font-size:14px;border:1px solid ${BRAND_GOLD}">View deal &amp; respond</a></div>` : ""}
          <p style="margin:0;font-size:13px;color:#4A5568"><strong>Full Deal Deck attached.</strong> Review the complete financial analysis, DSCR breakdown, and property details.</p>
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

// Upload the generated Deal Deck PDF to the public property-photos bucket
// (deal-decks/ prefix) so it can be linked in an SMS. One stable file per
// deal (x-upsert), so re-sends overwrite rather than pile up. Returns a SHORT
// branded link (/deck/<slug>) that redirects to the PDF — not the long
// Storage URL.
async function uploadDealDeckPdf(slug, cleanBase64) {
  const path = `deal-decks/${slug}.pdf`;
  const bytes = Buffer.from(cleanBase64, "base64");
  const r = await fetch(`${SB_URL}/storage/v1/object/property-photos/${path}`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) throw new Error(`deck upload -> ${r.status}: ${await r.text()}`);
  return `${SITE_URL}/deck/${slug}`;
}

// Plain-text SMS for a Stack Method deal — leads with the headline numbers
// (Cash at Close first), links the hosted Deal Deck PDF when available.
function buildMorbySms(prop, morby, deckUrl, alsoEmailed) {
  const address = prop.address_override || prop.name || "";
  const fmt = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
  const cash = buyerCashAtClose(morby);
  const lines = [`Stack Method Deal: ${address}`];
  if (cash > 0) lines.push(`Cash to you at close: ~${fmt(cash)}`);
  if (morby.purchase_price) lines.push(`Purchase price: ${fmt(morby.purchase_price)}`);
  if (morby.down_payment) lines.push(`Down payment: ${fmt(morby.down_payment)}`);
  if (morby.seller_carry_balance) {
    const rate = morby.deferred_interest_rate ? ` at ${Number(morby.deferred_interest_rate)}% deferred` : "";
    lines.push(`Seller carry: ${fmt(morby.seller_carry_balance)}${rate}`);
  }
  if (morby.balloon_months) lines.push(`Balloon: ${morby.balloon_months} months`);
  if (deckUrl) lines.push(`Deal deck: ${deckUrl}`);
  else lines.push(`Reply for the full deal deck PDF.`);
  lines.push(`Interested? Reply here${CONTACT_PHONE ? ` or call/text ${CONTACT_NAME} at ${CONTACT_PHONE}` : ""}.`);
  if (alsoEmailed) lines.push(`We also emailed you this deal — check your spam folder if you don't see it.`);
  lines.push(`Reply STOP to opt out.`);
  return lines.join("\n");
}

// Sub-To SMS body: the shared deal copy plus the opt-out line SMS marketing
// requires. Kept out of buildDealCopyText itself because that text is also
// the email body, where "Reply STOP" makes no sense.
function buildSubtoSms(prop, terms) {
  return buildDealCopyText(prop, terms) + `\nReply STOP to opt out.`;
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
  const headers = { Authorization: `Bearer ${GHL_API_KEY}`, "Content-Type": "application/json", Version: "2021-07-28" };
  // v2 duplicate search needs locationId + number (not "phone"). Find the
  // existing contact first so we don't try to re-create it.
  const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&number=${encodeURIComponent(phone)}`;
  let r = await fetch(searchUrl, { headers });
  if (r.ok) {
    const data = await r.json();
    if (data && data.contact && data.contact.id) return data.contact.id;
  }
  // Otherwise create. If GHL rejects it as a duplicate, it returns the existing
  // contact's id in meta — reuse that rather than failing.
  r = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
    method: "POST", headers, body: JSON.stringify({ phone, locationId: GHL_LOCATION_ID }),
  });
  const bodyText = await r.text();
  if (!r.ok) {
    try {
      const err = JSON.parse(bodyText);
      if (err && err.meta && err.meta.contactId) return err.meta.contactId;
    } catch (_) { /* fall through to throw */ }
    throw new Error(`GHL create contact -> ${r.status}: ${bodyText}`);
  }
  const data = JSON.parse(bodyText);
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

// ── Core runner ───────────────────────────────────────────────────
// Returns the result summary object; throws Error with a `.status` for
// caller-mapped HTTP codes (default 500).
async function runBlast(payload, user) {
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  try {
    const { card_id, channels, test, test_email, test_phone, buyer_ids, retry_failed, follow_up,
            variation_index, variation_title, variation_body,
            deal_deck_pdf, deal_deck_path } = payload || {};
    if (!card_id) throw httpError(400, "card_id required");

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
      // Paged (F3): this is the blast audience — a truncated fetch silently
      // drops every buyer past row 1,000 from the send.
      fetchAllRows(p => sb(p, { method: "GET" }), `/buyers?active=eq.true&select=*`),
      sb(`/morby_deals?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`, { method: "GET" }),
    ]);
    const prop = (props || [])[0];
    if (!prop) throw httpError(404, "property not found");
    const deckSlugVal = await ensureDeckSlugLocal(prop);
    // `s` tags which channel the link went out on, so deck_views can report
    // whether a buyer opened the deal from the text or the email (migration
    // 030). SMS links were always tokenized like email links — this is what
    // finally lets the two be told apart.
    const deckPageUrl = (buyerId, source) =>
      `${SITE_URL}/deck/${deckSlugVal}?b=${deckToken(buyerId)}${source ? `&s=${source}` : ""}`;
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
      : (buyers || []).filter(b => matchesDeal(b, dealStrategy, prop.state, price, piti, beds));

    // Email audience gate: has an address, hasn't opted out, and hasn't hard-
    // bounced (email_bounced_at, migration 031 — undefined before it runs,
    // which keeps the filter a no-op). Dashboard preview applies the same
    // three conditions.
    const emailable = (b) => b.email && !b.email_opt_out && !b.email_bounced_at;

    const result = { email: null, sms: null, test: isTest, targeted, retry: retryMode, esp: useResend ? "resend" : "gmail" };

    // R3 ledger rows are flushed incrementally (per email chunk / every few
    // texts) so the dashboard's progress poll sees a live count and a crash
    // mid-send loses at most one batch of ledger rows, not all of them. A
    // failed non-final flush re-queues and retries on the next one.
    const pendingRecipients = [];
    const flushRecipients = async (final = false) => {
      if (!pendingRecipients.length) return;
      const batch = pendingRecipients.splice(0);
      try { await logRecipientsBulk(batch); }
      catch (e) {
        if (final) throw e;
        pendingRecipients.unshift(...batch);
        console.warn("blast: recipient-ledger flush failed, will retry:", e.message);
      }
    };

    // Morby/Stack deals email the Deal Deck PDF as an attachment. It arrives
    // one of two ways:
    //   • deal_deck_pdf — inline base64 (sync test sends). jsPDF's
    //     datauristring prefix is "data:application/pdf;...;base64," — split
    //     on "base64," and take the tail, robust to whatever params it carries.
    //   • deal_deck_path — a property-photos Storage path (live sends: a
    //     Netlify background invocation's payload caps at ~256 KB, far too
    //     small for an inline PDF, so the dashboard stages it in Storage).
    let pdfBase64 = deal_deck_pdf ? deal_deck_pdf.split("base64,").pop() : null;
    if (!pdfBase64 && deal_deck_path && dealStrategy === "morby") {
      const r = await fetch(`${SB_URL}/storage/v1/object/property-photos/${deal_deck_path}`, {
        headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
      });
      if (!r.ok) throw httpError(400, `deal deck download (${deal_deck_path}) -> ${r.status}`);
      pdfBase64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      // The staged copy is a transfer artifact — remove it now that the bytes
      // are in memory (the SMS link re-uploads to the canonical
      // deal-decks/<slug>.pdf), so the public bucket doesn't accumulate one
      // orphaned PDF per Morby blast.
      if (deal_deck_path.startsWith("deal-decks/staged-")) {
        try {
          await fetch(`${SB_URL}/storage/v1/object/property-photos/${deal_deck_path}`, {
            method: "DELETE",
            headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` },
          });
        } catch (e) { console.warn("staged deck cleanup failed:", e.message); }
      }
    }
    const isMorbyDeck = !!(pdfBase64 && dealStrategy === "morby");
    const pdfAttachments = isMorbyDeck ? [{
      filename: `Deal Deck - ${(prop.address_override || prop.name || card_id).replace(/[\\/:*?"<>|]/g, "")}.pdf`,
      content: pdfBase64,
    }] : null;

    // Helper: build email content, swapping to the Morby template when needed.
    // Passes the buyer so the Morby email can greet them by first name.
    const buildEmail = (unsubUrl, buyer, deckUrlForBuyer) => isMorbyDeck
      ? buildMorbyEmail(prop, morbyTerms, unsubUrl, buyer, deckUrlForBuyer)
      : buildHtmlEmail(prop, terms, unsubUrl, coverImageUrl, buyer, deckUrlForBuyer);

    // If we're texting a Stack Method deck, host the PDF once so the SMS can
    // link it. Non-fatal: if the upload fails the text just omits the link.
    let deckUrl = null;
    if (isMorbyDeck && wantSms) {
      try { deckUrl = await uploadDealDeckPdf(deckSlug(prop), pdfBase64); }
      catch (e) { console.warn("deck PDF upload failed (SMS will omit link):", e.message); }
    }

    // SMS audience gate: opted in, has a phone, and the number isn't in
    // sms_suppressions (migration 032 — STOP replies that matched no buyer
    // row land only there, so sms_opt_in alone can't cover them; fails soft
    // to an empty set until the migration runs). Compared on normalized
    // digits like every other phone match.
    const suppressedSms = wantSms ? await suppressedPhoneDigits(sb) : new Set();
    const smsAllowed = (b) => !!(b.sms_opt_in && b.phone && !suppressedSms.has(digitsOnly(b.phone)));

    // ── TEST MODE: single preview to the caller; no real buyers, no logging ──
    if (isTest) {
      if (wantEmail) {
        const to = test_email || user.email;
        const { subject, html } = buildEmail(unsubUrlFor("preview"), null, `${SITE_URL}/deck/${deckSlugVal}?b=preview`);
        const testSubject = `[TEST] ${subject}`;
        const banner = `<div style="background:#FEEBC8;color:#7B341E;padding:10px 16px;font:600 13px Arial;border-radius:8px 8px 0 0">⚠️ TEST SEND — preview only, sent to ${escapeHtml(to)}, would normally go to ${matched.filter(emailable).length} matching buyer(s)</div>`;
        if (!to) {
          result.email = { sent: 0, failed: 1, error: "no test email address available" };
        } else if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN)) {
          result.email = { sent: 0, failed: 0, error: "No email provider configured (set RESEND_API_KEY+RESEND_FROM or Gmail creds)" };
        } else {
          try {
            if (useResend) await sendViaResend(to, testSubject, banner + html, null, pdfAttachments);
            else await sendViaGmail(await gmailAccessToken(), to, testSubject, banner + html, null);
            result.email = { sent: 1, failed: 0, to, would_reach: matched.filter(emailable).length };
          } catch (e) { result.email = { sent: 0, failed: 1, error: e.message }; }
        }
      }
      if (wantSms) {
        const to = test_phone || CONTACT_PHONE;
        if (!GHL_API_KEY || !GHL_FROM_NUMBER) result.sms = { sent: 0, failed: 0, note: "GHL SMS not configured" };
        else if (!to) result.sms = { sent: 0, failed: 1, error: "no test phone number available" };
        else {
          try {
            await sendSms(to, `[TEST]\n${dealStrategy === "morby" ? buildMorbySms(prop, morbyTerms, deckUrl, wantEmail) : buildSubtoSms(prop, terms)}`);
            const smsWouldReach = targeted
              ? matched.filter(smsAllowed).length
              : matched.filter(b => b.tier === "A" && smsAllowed(b)).length;
            result.sms = { sent: 1, failed: 0, to, would_reach: smsWouldReach };
          } catch (e) { result.sms = { sent: 0, failed: 1, error: e.message }; }
        }
      }
      return result;
    }

    // ── LIVE MODE ──
    // [follow-up] in the deal_blasts detail is what the dashboard's nudge
    // checks to offer at most one follow-up per deal.
    const tag = (targeted ? ` [targeted: ${matched.length}]` : "") + (retryMode ? " [retry-failed]" : "") + (follow_up ? " [follow-up]" : "") + variationTag;

    // ── EMAIL ──
    if (wantEmail) {
      if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN)) {
        result.email = { sent: 0, failed: 0, error: "No email provider configured" };
      } else {
        let emailBuyers = matched.filter(emailable);
        // R3: recipient-level idempotency. A normal full blast skips anyone
        // already 'sent'; retry mode targets only prior failures.
        if (retryMode) {
          const [failed, sent] = await Promise.all([
            buyerIdsByStatus(card_id, "email", "failed"),
            buyerIdsByStatus(card_id, "email", "sent"),
          ]);
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
              const { subject, html } = buildEmail(unsubUrl, b, deckPageUrl(b.id, "email"));
              try {
                if (useResend) await sendViaResend(b.email, subject, html, unsubUrl, pdfAttachments, { buyer_id: b.id, card_id });
                else await sendViaGmail(token, b.email, subject, html, unsubUrl);
                sent++;
                pendingRecipients.push(recipientRow(card_id, b, address, "email", b.email, "sent", variation));
              } catch (e) {
                failed++;
                pendingRecipients.push(recipientRow(card_id, b, address, "email", b.email, "failed", variation, e.message.slice(0, 200)));
              }
            }));
            await flushRecipients();
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
          ? matched.filter(smsAllowed)
          : matched.filter(b => b.tier === "A" && smsAllowed(b));
        if (retryMode) {
          const [failed, sent] = await Promise.all([
            buyerIdsByStatus(card_id, "sms", "failed"),
            buyerIdsByStatus(card_id, "sms", "sent"),
          ]);
          smsBuyers = smsBuyers.filter(b => failed.has(Number(b.id)) && !sent.has(Number(b.id)));
        } else if (!targeted) {
          const sent = await buyerIdsByStatus(card_id, "sms", "sent");
          smsBuyers = smsBuyers.filter(b => !sent.has(Number(b.id)));
        }

        if (!smsBuyers.length) {
          result.sms = { sent: 0, failed: 0, note: retryMode ? "no failed texts to retry" : "no new opted-in buyers with a phone" };
        } else {
          let sent = 0, failed = 0;
          const message = dealStrategy === "morby" ? buildMorbySms(prop, morbyTerms, deckUrl, wantEmail) : buildSubtoSms(prop, terms);
          for (const b of smsBuyers) {
            const perMsg = message + `\n\nView deal & respond: ${deckPageUrl(b.id, "sms")}`;
            try {
              await sendSms(b.phone, perMsg); sent++;
              pendingRecipients.push(recipientRow(card_id, b, address, "sms", b.phone, "sent", variation));
            } catch (e) {
              failed++;
              pendingRecipients.push(recipientRow(card_id, b, address, "sms", b.phone, "failed", variation, e.message.slice(0, 200)));
            }
            if (pendingRecipients.length >= 10) await flushRecipients();
          }
          await logBlast(card_id, address, "sms", sent ? "sent" : "failed", `sent=${sent} failed=${failed}${tag}`, variation);
          result.sms = { sent, failed };
        }
      }
    }

    await flushRecipients(true);
    return result;
  } catch (err) {
    console.error("blast error:", err.message);
    throw err;
  }
}

module.exports = { runBlast, verifyUser };
