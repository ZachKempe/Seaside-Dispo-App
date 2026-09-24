// Scheduled (every 15 min, netlify.toml): make sure every single-family deal
// has an AirDNA STR estimate, and keep it tracked.
//
// The dashboard pulls one the moment a deal is created, but that call lives
// in a browser tab that can close. This sweep is the guarantee:
//   - no estimate yet            → pull now
//   - last pull errored          → retry after 24h (a bad key or an address
//                                  AirDNA can't match shouldn't re-bill hourly)
//   - last good pull > 30 days   → pull again, as a new row (history = tracking)
// At most MAX_PER_RUN deals per run, in parallel, to stay inside the 30s
// scheduled-function budget; the rest are picked up 15 minutes later.

const { sb } = require("./lib/capture");
const { fetchAllRows } = require("./lib/fetch-all");
const { logSyncRun } = require("./lib/heartbeat");
const { pullStrEstimate } = require("./lib/airdna");

const FN = "str-estimates-sync";
const MAX_PER_RUN = 5;
const RETRY_ERROR_MS = 24 * 3600 * 1000;
const REFRESH_OK_MS = 30 * 24 * 3600 * 1000;

function isDue(latest, now = Date.now()) {
  if (!latest) return true;
  const age = now - new Date(latest.fetched_at).getTime();
  return latest.status === "ok" ? age > REFRESH_OK_MS : age > RETRY_ERROR_MS;
}

exports.isDue = isDue;

exports.handler = async () => {
  if (!process.env.AIRDNA_API_KEY) {
    // Not an error: the integration just isn't switched on yet.
    await logSyncRun(FN, "ok", "AIRDNA_API_KEY not set — skipped");
    return { statusCode: 200 };
  }
  try {
    const get = (path) => sb(path, { method: "GET" });
    const props = await fetchAllRows(get, `/properties?archived=eq.false&select=*`, { order: "card_id" });
    const cardIds = (props || []).map(p => p.card_id);
    if (!cardIds.length) { await logSyncRun(FN, "ok", "no active deals"); return { statusCode: 200 }; }

    // Newest estimate per card (rows come back newest-first, so first wins).
    const rows = await fetchAllRows(get, `/str_estimates?select=card_id,status,fetched_at&order=fetched_at.desc,id.desc`);
    const latest = {};
    for (const r of rows || []) if (!latest[r.card_id]) latest[r.card_id] = r;

    const due = (props || []).filter(p => isDue(latest[p.card_id])).slice(0, MAX_PER_RUN);
    const results = await Promise.all(due.map(p =>
      pullStrEstimate(sb, p).catch(e => ({ estimate: { status: "error", error: e.message } }))));

    const ok = results.filter(r => r.estimate && r.estimate.status === "ok").length;
    const failed = results.filter(r => r.estimate && r.estimate.status === "error");
    const skipped = results.filter(r => r.skipped).length;
    const summary = `pulled=${ok} failed=${failed.length} skipped=${skipped}` +
      (failed.length ? ` — ${failed[0].estimate.error}` : "");
    // Only a run where EVERY attempt failed is an error — that's the dead-key /
    // wrong-path case worth the two-strikes alert; one unmatched address isn't.
    const status = ok === 0 && failed.length > 0 ? "error" : "ok";
    await logSyncRun(FN, status, summary);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`${FN} error:`, err.message);
    await logSyncRun(FN, "error", err.message);
    return { statusCode: 500 };
  }
};
