// Rent estimates for one deal — short-term from AirDNA (lib/airdna.js) and
// long-term from RentCast (lib/rentcast.js). The dashboard calls this right
// after a contract/LOI upload, and from the card's ↻ buttons.
//
// POST { card_id, kind?: "str" | "ltr" | "both" (default), overwrite? }
// (auth'd with the caller's Supabase access token)
//   → { str?: { estimate, filled } | { skipped } | { error },
//       ltr?: …same shape }
// overwrite:true (after an upload, or ↻) replaces the rent box; without it an
// estimate only fills a blank box. A provider whose key isn't set reports
// { skipped }, so either integration can be switched on without the other.

const { sb } = require("./lib/capture");
const { verifyUser } = require("./lib/blast-core");
const { pullStrEstimate } = require("./lib/airdna");
const { pullLtrEstimate } = require("./lib/rentcast");

const PULL = { str: pullStrEstimate, ltr: pullLtrEstimate };
const MIGRATION = { str: "039_str_estimates.sql", ltr: "040_ltr_estimates.sql" };

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    const { card_id, kind = "both", overwrite } = JSON.parse(event.body || "{}");
    if (!card_id) return json(400, { error: "card_id required" });
    const kinds = kind === "both" ? ["str", "ltr"] : [kind].filter(k => PULL[k]);
    if (!kinds.length) return json(400, { error: "kind must be str, ltr or both" });

    const props = await sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`);
    const prop = (props || [])[0];
    if (!prop) return json(404, { error: "deal not found" });

    // Independent: one provider failing (or its table missing) never blocks the other.
    const out = {};
    await Promise.all(kinds.map(async (k) => {
      try {
        out[k] = await PULL[k](sb, prop, { overwrite: overwrite === true });
      } catch (e) {
        const table = k === "str" ? "str_estimates" : "ltr_estimates";
        const premigration = e.message.includes(table) && /404|PGRST205|does not exist/.test(e.message);
        out[k] = { error: premigration ? `Run sql/${MIGRATION[k]} in Supabase first.` : e.message };
      }
    }));
    return json(200, out);
  } catch (err) {
    console.error("rent-estimate error:", err.message);
    return json(500, { error: err.message });
  }
};
