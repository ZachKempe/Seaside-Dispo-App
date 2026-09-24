// Scheduled (every 15 min, netlify.toml): make sure every single-family deal
// has a short-term (AirDNA) and a long-term (RentCast) rent estimate, and keep
// both tracked.
//
// The dashboard pulls both the moment a contract/LOI is uploaded, but that
// call lives in a browser tab that can close. This sweep is the guarantee, on
// the spacing in lib/rent-estimate.js (isDue): missing → now, errored → after
// 24h, good → re-pulled after 30 days as a new row. It only ever FILLS a blank
// rent box — a number typed by hand is never replaced in the background.
//
// At most MAX_PER_RUN deals per provider per run, in parallel, to stay inside
// the 30s scheduled-function budget; the rest are picked up 15 minutes later.
// A provider whose key isn't set is skipped entirely.

const { sb } = require("./lib/capture");
const { fetchAllRows } = require("./lib/fetch-all");
const { logSyncRun } = require("./lib/heartbeat");
const { isDue } = require("./lib/rent-estimate");
const { pullStrEstimate } = require("./lib/airdna");
const { pullLtrEstimate } = require("./lib/rentcast");

const FN = "rent-estimates-sync";
const MAX_PER_RUN = 5;
const PROVIDERS = [
  { kind: "str", label: "AirDNA", envKey: "AIRDNA_API_KEY", table: "str_estimates", pull: pullStrEstimate },
  { kind: "ltr", label: "RentCast", envKey: "RENTCAST_API_KEY", table: "ltr_estimates", pull: pullLtrEstimate },
];

async function sweepProvider(p, props, get) {
  if (!process.env[p.envKey]) return { label: p.label, off: true };
  const rows = await fetchAllRows(get, `/${p.table}?select=card_id,status,fetched_at&order=fetched_at.desc,id.desc`);
  const latest = {};
  for (const r of rows || []) if (!latest[r.card_id]) latest[r.card_id] = r;

  const due = props.filter(pr => isDue(latest[pr.card_id])).slice(0, MAX_PER_RUN);
  const results = await Promise.all(due.map(pr =>
    p.pull(sb, pr).catch(e => ({ estimate: { status: "error", error: e.message } }))));
  const ok = results.filter(r => r.estimate && r.estimate.status === "ok").length;
  const failed = results.filter(r => r.estimate && r.estimate.status === "error");
  return { label: p.label, ok, failed: failed.length, firstError: failed[0] && failed[0].estimate.error };
}

exports.handler = async () => {
  try {
    const get = (path) => sb(path, { method: "GET" });
    const props = await fetchAllRows(get, `/properties?archived=eq.false&select=*`, { order: "card_id" });

    // Independent: a missing table or dead key on one provider doesn't stop the other.
    const results = await Promise.all(PROVIDERS.map(p =>
      sweepProvider(p, props || [], get).catch(e => ({ label: p.label, ok: 0, failed: 1, firstError: e.message }))));

    const summary = results.map(r => r.off ? `${r.label}: key not set`
      : `${r.label}: pulled=${r.ok} failed=${r.failed}${r.firstError ? ` (${r.firstError})` : ""}`).join(" · ");
    // An error only when a provider that's switched on failed EVERY attempt —
    // the dead-key / wrong-path / missing-migration case worth the two-strikes
    // alert. One address a provider can't match isn't.
    const broken = results.some(r => !r.off && r.ok === 0 && r.failed > 0);
    await logSyncRun(FN, broken ? "error" : "ok", summary);
    return { statusCode: 200 };
  } catch (err) {
    console.error(`${FN} error:`, err.message);
    await logSyncRun(FN, "error", err.message);
    return { statusCode: 500 };
  }
};
