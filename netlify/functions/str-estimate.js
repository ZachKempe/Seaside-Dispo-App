// AirDNA STR estimate for one deal — the dashboard's "↻ AirDNA" button, and
// the call the dashboard fires right after a new deal is created from a
// contract/LOI upload. POST { card_id } (auth'd with the caller's Supabase
// access token, overwrite?) → { estimate, filled } | { skipped }.
// overwrite:true (after a PSA/LOI upload, or ↻) replaces the STR rent box;
// without it the estimate only fills a blank box.
//
// All the logic (who's eligible, the AirDNA call, the blank-only rent fill) is
// lib/airdna.js, shared with the scheduled str-estimates-sync sweep.

const { sb } = require("./lib/capture");
const { verifyUser } = require("./lib/blast-core");
const { pullStrEstimate } = require("./lib/airdna");

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };
    if (!process.env.AIRDNA_API_KEY) return json(503, { error: "AIRDNA_API_KEY isn't set in Netlify yet — add it, then redeploy." });

    const { card_id, overwrite } = JSON.parse(event.body || "{}");
    if (!card_id) return json(400, { error: "card_id required" });
    const props = await sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`);
    const prop = (props || [])[0];
    if (!prop) return json(404, { error: "deal not found" });

    return json(200, await pullStrEstimate(sb, prop, { overwrite: overwrite === true }));
  } catch (err) {
    console.error("str-estimate error:", err.message);
    // Before 039 runs the insert 404s — name the file, like the pages do.
    const pre039 = /str_estimates/.test(err.message) && /404|PGRST205|does not exist/.test(err.message);
    return json(500, { error: pre039 ? "Run sql/039_str_estimates.sql in Supabase first." : err.message });
  }
};
