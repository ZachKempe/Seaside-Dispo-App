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
