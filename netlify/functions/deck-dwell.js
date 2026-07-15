// POST { v: <viewToken>, s: <seconds> } — records how long a visitor kept a
// deck page open, sent via navigator.sendBeacon when they leave. The token is
// the HMAC-signed deck_views row id minted by deck.js at render time, so only
// the page that logged the view can report its dwell. Only ever increases the
// stored value (beacons can fire more than once per visit).
const { verifyViewToken } = require("./lib/deck-token");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const { v, s } = JSON.parse(event.body || "{}");
    const viewId = verifyViewToken(v);
    if (!viewId) return { statusCode: 401, body: "bad token" };
    const seconds = Math.min(1800, Math.max(1, Math.round(Number(s) || 0)));

    const r = await fetch(
      `${SB_URL}/rest/v1/deck_views?id=eq.${viewId}&or=(dwell_seconds.is.null,dwell_seconds.lt.${seconds})`,
      {
        method: "PATCH",
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ dwell_seconds: seconds }),
      }
    );
    if (!r.ok) throw new Error(`deck_views patch -> ${r.status}: ${await r.text()}`);
    return { statusCode: 204, body: "" };
  } catch (err) {
    console.error("deck-dwell error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
