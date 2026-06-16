// On-demand "Request buy-box" function — triggered from the Buyer Dashboard.
// Sends newly-imported/scraped buyers a short email asking what they're buying,
// linking to the public buyer intake form. Their answers flow back into the CRM
// via sync-buyers.js, enriching states / price / strategy so future blasts only
// hit real matches.
//
// Safety: never sends to a buyer twice (onboarded_at gate), skips opted-out and
// emailless buyers, and supports a test mode that sends only to the caller.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || "";
const GMAIL_FROM_NAME = process.env.GMAIL_FROM_NAME || "Seaside Horizon";
const GMAIL_REPLY_TO = process.env.GMAIL_REPLY_TO || GMAIL_FROM_ADDRESS;

const FORM_URL = process.env.BUYER_FORM_URL || "https://nimble-scone-f6b3c4.netlify.app/";
const LOGO_URL = "https://seaside-dispo-app.netlify.app/img/logo.png";
const BRAND_NAVY = "#1B3A6B";
const BRAND_NAVY_DARK = "#112950";
const CONTACT_NAME = process.env.MARKETING_CONTACT_NAME || "Zach — Seaside Horizon";
const EMAIL_CONCURRENCY = 25;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/json", ...(opts.headers || {}),
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

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function firstName(name) {
  const n = (name || "").trim().split(/\s+/)[0];
  return n && !/@/.test(n) ? n : "there";
}

function buildEmail(buyer) {
  const hi = escapeHtml(firstName(buyer.name));
  return `
  <div style="max-width:540px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#2D3748">
    <div style="background:${BRAND_NAVY_DARK};padding:18px 24px;border-radius:10px 10px 0 0">
      <img src="${LOGO_URL}" alt="Seaside Horizon" height="34" style="display:block">
    </div>
    <div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hey ${hi},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">
        You're on Seaside Horizon's cash-buyer list — we move creative-finance and
        discounted deals across the country. So we only send you deals you'd actually
        close on, give us your buy box. Takes about 60 seconds:
      </p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escapeHtml(FORM_URL)}" style="background:${BRAND_NAVY};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:8px;display:inline-block">Tell us what you're buying →</a>
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 14px;color:#4A5568">
        States, price range, property types, cash vs. creative — whatever fits your
        criteria. Or just reply to this email and tell me directly.
      </p>
      <p style="font-size:15px;line-height:1.6;margin:18px 0 0">— ${escapeHtml(CONTACT_NAME)}</p>
    </div>
  </div>`;
}

async function sendViaResend(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
}

async function gmailAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}
async function sendViaGmail(token, to, subject, html) {
  const headers = [
    `From: ${GMAIL_FROM_NAME} <${GMAIL_FROM_ADDRESS}>`, `To: ${to}`,
    `Reply-To: ${GMAIL_REPLY_TO}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    `MIME-Version: 1.0`, `Content-Type: text/html; charset="UTF-8"`,
  ];
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${html}`, "utf-8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send -> ${r.status}: ${await r.text()}`);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
  if (!user) return { statusCode: 401, body: "Unauthorized" };

  const useResend = !!(RESEND_API_KEY && RESEND_FROM);
  if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN)) {
    return { statusCode: 500, body: JSON.stringify({ error: "No email provider configured" }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const isTest = !!body.test;
  const subject = "Quick question — what are you buying right now?";

  try {
    // TEST: one email to the caller, no DB writes.
    if (isTest) {
      const to = (body.test_email || user.email || "").trim();
      if (!to) return { statusCode: 400, body: JSON.stringify({ error: "No test address" }) };
      const html = buildEmail({ name: "" });
      if (useResend) await sendViaResend(to, `[TEST] ${subject}`, html);
      else await sendViaGmail(await gmailAccessToken(), to, `[TEST] ${subject}`, html);
      return { statusCode: 200, body: JSON.stringify({ test: true, to }) };
    }

    // LIVE: target buyers with an email, not opted out, never onboarded.
    // Optional restriction: explicit ids, or a source tag (e.g. "batchleads").
    let filter = "?select=id,name,email&email=neq.&onboarded_at=is.null&email_opt_out=is.not.true";
    if (Array.isArray(body.buyer_ids) && body.buyer_ids.length) {
      filter += `&id=in.(${body.buyer_ids.map(Number).filter(Boolean).join(",")})`;
    } else if (body.source) {
      filter += `&list_source=eq.${encodeURIComponent(body.source)}`;
    }
    const targets = (await sb(`/buyers${filter}`, { method: "GET" }) || [])
      .filter(b => b.email && /@/.test(b.email));

    if (!targets.length) return { statusCode: 200, body: JSON.stringify({ sent: 0, failed: 0, note: "No new buyers to onboard." }) };

    let sent = 0, failed = 0;
    const token = useResend ? null : await gmailAccessToken();
    const onboardedIds = [];
    for (let i = 0; i < targets.length; i += EMAIL_CONCURRENCY) {
      const chunk = targets.slice(i, i + EMAIL_CONCURRENCY);
      await Promise.all(chunk.map(async (b) => {
        try {
          const html = buildEmail(b);
          if (useResend) await sendViaResend(b.email, subject, html);
          else await sendViaGmail(token, b.email, subject, html);
          sent++; onboardedIds.push(b.id);
        } catch (e) { failed++; console.error("onboard send failed:", b.email, e.message); }
      }));
    }
    // Mark only successfully-emailed buyers, so failures get retried next run.
    if (onboardedIds.length) {
      const now = new Date().toISOString();
      await sb(`/buyers?id=in.(${onboardedIds.join(",")})`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ onboarded_at: now }),
      });
    }
    return { statusCode: 200, body: JSON.stringify({ sent, failed, esp: useResend ? "resend" : "gmail" }) };
  } catch (err) {
    console.error("onboard-buyers error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
