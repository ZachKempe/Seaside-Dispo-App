// "Reach out to new leads" — triggered from the Leads view.
// Sends scraped hot-buyer leads a short, personal qualifying email ("saw you
// showed interest — what are you specifically looking for?") BEFORE they ever
// join the buyer list. Marks them contacted so they're asked only once; their
// reply (captured by capture-replies.js) flips them to "responded" for you to
// review and promote.
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

function buildEmail(lead) {
  const hi = escapeHtml(firstName(lead.name));
  // If we know the deal/area they were hot on, reference it; else stay general.
  const area = (lead.deal_address || "").trim();
  const areaLine = area
    ? `I saw you showed some interest in <strong>${escapeHtml(area)}</strong>.`
    : `I saw you've shown interest in deals in a few of the markets we work.`;
  return `
  <div style="max-width:540px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#2D3748">
    <div style="background:${BRAND_NAVY_DARK};padding:18px 24px;border-radius:10px 10px 0 0">
      <img src="${LOGO_URL}" alt="Seaside Horizon" height="34" style="display:block">
    </div>
    <div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hey ${hi},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">
        I'm Zach with Seaside Horizon — we move creative-finance and discounted
        deals across the country. ${areaLine}
      </p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">
        What are you specifically looking for right now? If you tell me your
        <strong>states, price range, and property types</strong>, I'll only send
        you deals that actually fit — nothing else.
      </p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Just reply here and let me know.</p>
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
    if (isTest) {
      const to = (body.test_email || user.email || "").trim();
      if (!to) return { statusCode: 400, body: JSON.stringify({ error: "No test address" }) };
      const html = buildEmail({ name: "", deal_address: body.sample_deal || "" });
      if (useResend) await sendViaResend(to, `[TEST] ${subject}`, html);
      else await sendViaGmail(await gmailAccessToken(), to, `[TEST] ${subject}`, html);
      return { statusCode: 200, body: JSON.stringify({ test: true, to }) };
    }

    // LIVE: target NEW leads with an email. Optional explicit ids.
    let filter = "?select=id,name,email,deal_address&email=neq.&status=eq.new";
    if (Array.isArray(body.lead_ids) && body.lead_ids.length) {
      filter = `?select=id,name,email,deal_address&id=in.(${body.lead_ids.map(Number).filter(Boolean).join(",")})`;
    }
    const targets = (await sb(`/leads${filter}`, { method: "GET" }) || [])
      .filter(l => l.email && /@/.test(l.email));
    if (!targets.length) return { statusCode: 200, body: JSON.stringify({ sent: 0, failed: 0, note: "No new leads to contact." }) };

    let sent = 0, failed = 0;
    const token = useResend ? null : await gmailAccessToken();
    const okIds = [];
    for (let i = 0; i < targets.length; i += EMAIL_CONCURRENCY) {
      const chunk = targets.slice(i, i + EMAIL_CONCURRENCY);
      await Promise.all(chunk.map(async (l) => {
        try {
          const html = buildEmail(l);
          if (useResend) await sendViaResend(l.email, subject, html);
          else await sendViaGmail(token, l.email, subject, html);
          sent++; okIds.push(l.id);
        } catch (e) { failed++; console.error("lead contact failed:", l.email, e.message); }
      }));
    }
    if (okIds.length) {
      await sb(`/leads?id=in.(${okIds.join(",")})`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "contacted", contacted_at: new Date().toISOString() }),
      });
    }
    return { statusCode: 200, body: JSON.stringify({ sent, failed, esp: useResend ? "resend" : "gmail" }) };
  } catch (err) {
    console.error("contact-leads error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
