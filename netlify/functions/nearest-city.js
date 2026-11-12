// Dashboard-side lookup behind the Deal Deck PDF's "doesn't cash flow" callout.
// POST { address } (auth'd with the caller's Supabase access token) →
// { nearest: { city, state, miles, text } | null }. Read-only; the deck PAGE
// calls lib/nearest-city directly. Never errors on a lookup miss — null just
// means the PDF omits the location line.
const { nearestCityFor, describeNearestCity } = require("./lib/nearest-city");

const SB_URL = process.env.SUPABASE_URL;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  return r.ok ? r.json() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    const { address } = JSON.parse(event.body || "{}");
    const n = await nearestCityFor(String(address || "").slice(0, 300));
    return { statusCode: 200, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nearest: n ? { ...n, text: describeNearestCity(n) } : null }) };
  } catch (e) {
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nearest: null }) };
  }
};
