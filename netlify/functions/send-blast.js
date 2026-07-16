// "Send Blast" — SYNCHRONOUS entry point (kept thin; logic in lib/blast-core).
// Used for:
//   • 🧪 test mode — a single preview to the caller that must return its
//     result inline, so the dashboard's preview UX is unchanged
//   • retry-failed re-sends — small by construction (only prior failures)
// Live full blasts go through send-blast-background.js instead: a
// synchronous Netlify function gets ~10 s, which dies mid-send around ~600
// emails or ~10 texts.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const { runBlast, verifyUser } = require("./lib/blast-core");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };
    const result = await runBlast(JSON.parse(event.body || "{}"), user);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(result) };
  } catch (err) {
    console.error("send-blast error:", err.message);
    return { statusCode: err.status || 500, body: err.message };
  }
};
