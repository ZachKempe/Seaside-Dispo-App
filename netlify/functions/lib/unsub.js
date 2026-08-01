// D1 — per-buyer unsubscribe tokens. Minting (blast-core, onboard-buyers) and
// verifying (unsubscribe.js) have to agree exactly: the token is
// `<buyerId>.<first 16 hex of HMAC-SHA256(buyerId, UNSUB_SECRET)>`. They used
// to be two hand-copied implementations, which is one careless edit away from
// invalidating every unsubscribe link already sitting in someone's inbox.
"use strict";

const crypto = require("crypto");

const secret = () =>
  process.env.UNSUB_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "seaside-unsub";
const siteUrl = () => process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app";

function unsubToken(buyerId) {
  const h = crypto.createHmac("sha256", secret()).update(String(buyerId)).digest("hex").slice(0, 16);
  return `${buyerId}.${h}`;
}

function unsubUrlFor(buyerId) {
  return `${siteUrl()}/.netlify/functions/unsubscribe?b=${encodeURIComponent(unsubToken(buyerId))}`;
}

// Returns the buyer id, or null when the token is missing/forged.
function verifyToken(token) {
  const [id, h] = String(token || "").split(".");
  if (!id || !h) return null;
  const good = crypto.createHmac("sha256", secret()).update(String(id)).digest("hex").slice(0, 16);
  return h === good ? Number(id) : null;
}

module.exports = { unsubToken, unsubUrlFor, verifyToken };
