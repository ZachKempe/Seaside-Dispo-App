// "Send Blast" — LIVE entry point (F4). The "-background" suffix makes
// Netlify run this as a background function: the caller gets a 202
// immediately and the send gets a 15-minute budget instead of ~10 s, so
// large blasts no longer die mid-send.
//
// A background invocation can't return a result body, so the dashboard
// watches progress in blast_recipients (blast-core flushes rows
// incrementally) and detects completion via the sync_runs heartbeat row
// written here (detail is tagged with card=<card_id> so the poll can match
// its own blast). A failed blast also rides heartbeat's existing
// two-consecutive-failures email alert.
//
// NOTE: background invocation payloads cap at ~256 KB — Morby deck sends
// must pass deal_deck_path (a property-photos Storage path staged by the
// dashboard), never inline deal_deck_pdf base64.

const { runBlast, verifyUser } = require("./lib/blast-core");
const { logSyncRun } = require("./lib/heartbeat");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return;
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch (_) { /* caught as missing card_id below */ }
  // client_ref is echoed into the heartbeat detail so the dashboard can match
  // THIS blast's completion row exactly (no clock comparison, no collision
  // with an earlier blast of the same card).
  const cardTag = `card=${payload.card_id || "?"}${payload.client_ref ? ` ref=${payload.client_ref}` : ""}`;
  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) throw new Error("Unauthorized");
    if (payload.test) throw new Error("test mode must use the synchronous send-blast function");
    const result = await runBlast(payload, user);
    const fmt = (r) => r ? `sent=${r.sent ?? 0} failed=${r.failed ?? 0}${r.note ? ` (${r.note})` : ""}${r.error ? ` err=${r.error}` : ""}` : "—";
    // A run that reached nobody but hit errors/failures is an error, not an
    // "ok" — runBlast only throws on hard faults, so per-recipient wipeouts
    // (expired API key, unconfigured provider) surface here.
    const sentTotal = ((result.email && result.email.sent) || 0) + ((result.sms && result.sms.sent) || 0);
    const hadTrouble = !!((result.email && (result.email.error || result.email.failed)) ||
                          (result.sms && (result.sms.error || result.sms.failed)));
    const status = sentTotal === 0 && hadTrouble ? "error" : "ok";
    await logSyncRun("send-blast", status, `${cardTag} email: ${fmt(result.email)} · sms: ${fmt(result.sms)}`);
    console.log("send-blast-background done:", JSON.stringify(result));
  } catch (err) {
    console.error("send-blast-background error:", err.message);
    await logSyncRun("send-blast", "error", `${cardTag} ${err.message}`.slice(0, 480));
  }
};
