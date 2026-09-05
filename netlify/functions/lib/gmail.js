// Gmail API for the per-buyer conversation view (buyer-messages.js): read the
// back-and-forth with one address and send a threaded reply from the same
// mailbox that receives the buyer's replies. Same OAuth client as
// capture-replies.js (scopes gmail.readonly + gmail.send).
//
// Env is read at call time so a function that never touches Gmail doesn't
// care whether it's configured.
"use strict";

const gmailEnv = () => ({
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  refreshToken: process.env.GMAIL_REFRESH_TOKEN,
  fromAddress: process.env.GMAIL_FROM_ADDRESS || "",
  fromName: process.env.GMAIL_FROM_NAME || "Seaside Horizon",
  replyTo: process.env.GMAIL_REPLY_TO || process.env.GMAIL_FROM_ADDRESS || "",
});

function gmailConfigured() {
  const { clientId, clientSecret, refreshToken, fromAddress } = gmailEnv();
  return !!(clientId && clientSecret && refreshToken && fromAddress);
}

async function gmailAccessToken() {
  const { clientId, clientSecret, refreshToken } = gmailEnv();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function gmailApi(token, path, opts = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Gmail ${path.split("?")[0]} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

// Messages exchanged with `address`, capped. Quota is the constraint here
// (Gmail bills ~5 units per call against a per-minute, per-user budget that
// the first live-only version of the panel exhausted in an hour), so:
//   • `q` comes from lib/conversation.js gmailQuery — incremental once the
//     buyer has saved history, so the list call is the only regular cost;
//   • `skipIds` (already in buyer_messages) are never fetched again;
//   • the remaining gets run in small parallel chunks.
async function fetchMessagesWith(token, address, { max = 40, q, skipIds } = {}) {
  q = q || `{from:${address} to:${address}} -in:chats newer_than:2y`;
  const list = await gmailApi(token, `/messages?q=${encodeURIComponent(q)}&maxResults=${max}`);
  const skip = skipIds || new Set();
  const ids = (list.messages || []).map((m) => m.id).filter((id) => !skip.has(id));
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = await Promise.all(ids.slice(i, i + 10).map((id) =>
      gmailApi(token, `/messages/${id}?format=full`).catch((e) => {
        console.warn("gmail get failed:", id, e.message);
        return null;
      })));
    out.push(...chunk.filter(Boolean));
  }
  return out;
}

// `raw` is the base64url-encoded RFC 2822 message (lib/conversation.js
// buildMime + base64Url). threadId keeps the reply inside the existing
// Gmail thread. Returns Gmail's { id, threadId, labelIds }.
async function sendRaw(token, raw, threadId) {
  const body = { raw };
  if (threadId) body.threadId = threadId;
  return gmailApi(token, "/messages/send", { method: "POST", body: JSON.stringify(body) });
}

module.exports = { gmailEnv, gmailConfigured, gmailAccessToken, gmailApi, fetchMessagesWith, sendRaw };
