// C1 — Scheduled (every 15 min). Polls Gmail for replies to deal blasts and
// captures the sender as a buyer + pipeline lead. Only looks at messages whose
// subject carries the blast marker ("New SubTo Deal"), so unrelated inbox mail
// is never touched. Idempotent via the inbound_messages ledger.

const { sb, markSeen, captureResponder } = require("./lib/capture");

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM_ADDRESS = (process.env.GMAIL_FROM_ADDRESS || "").toLowerCase();

// Matches the blast subject built in send-blast.js: "🏡 New SubTo Deal — <name> | …"
const DEAL_QUERY = 'in:inbox newer_than:7d -from:me subject:"New SubTo Deal"';

async function gmailAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function gmailList(token, q) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail list -> ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.messages || [];
}

async function gmailGet(token, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Gmail get -> ${r.status}: ${await r.text()}`);
  return r.json();
}

function header(msg, name) {
  const h = (msg.payload && msg.payload.headers) || [];
  const hit = h.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.value : "";
}

function parseFrom(from) {
  // "John Doe <john@x.com>" or "john@x.com"
  const m = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  if (!m) return { name: "", email: "" };
  return { name: (m[1] || "").trim(), email: (m[2] || "").trim().toLowerCase() };
}

// Subject: "Re: 🏡 New SubTo Deal — 123 Main St, Ocala, FL 34479 | $5,000 Entry Fee"
// Pull the street part (before the first comma) so the property lookup avoids
// commas that would confuse the PostgREST filter.
function dealNameFromSubject(subject) {
  const m = subject.match(/New SubTo Deal\s*[—–-]\s*([^|]+)/i);
  if (!m) return "";
  return m[1].split(",")[0].trim();
}

async function findProperty(namePart) {
  if (!namePart) return null;
  const pat = encodeURIComponent(`%${namePart}%`);
  const rows = await sb(
    `/properties?name=ilike.${pat}&select=card_id,name&order=synced_at.desc&limit=1`,
    { method: "GET" }
  );
  return (rows && rows[0]) || null;
}

exports.handler = async () => {
  if (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN) {
    return { statusCode: 200, body: "Gmail not configured — skipping" };
  }
  try {
    const token = await gmailAccessToken();
    const messages = await gmailList(token, DEAL_QUERY);

    let captured = 0, newBuyers = 0, leads = 0, skipped = 0;
    for (const { id } of messages) {
      const msg = await gmailGet(token, id);
      const subject = header(msg, "Subject");
      const { name, email } = parseFrom(header(msg, "From"));

      // Guard against self/system senders.
      if (!email || email === GMAIL_FROM_ADDRESS || /no-?reply|mailer-daemon|postmaster|notifications?@/i.test(email)) {
        skipped++;
        continue;
      }
      // Only act the first time we see this message.
      const fresh = await markSeen(id, "email");
      if (!fresh) { skipped++; continue; }

      const prop = await findProperty(dealNameFromSubject(subject));
      const res = await captureResponder({
        channel: "email",
        name, email,
        cardId: prop ? prop.card_id : null,
        address: prop ? prop.name : "",
        snippet: msg.snippet || "",
      });
      if (res.ok) {
        captured++;
        if (res.isNewBuyer) newBuyers++;
        if (res.leadCreated || res.leadBumped) leads++;
      }
    }

    const summary = `capture-replies: ${captured} captured (${newBuyers} new buyers, ${leads} pipeline leads), ${skipped} skipped of ${messages.length} matched`;
    console.log(summary);
    return { statusCode: 200, body: summary };
  } catch (err) {
    console.error("capture-replies error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
