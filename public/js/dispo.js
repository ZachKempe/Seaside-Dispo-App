// Shared dispo-stage constants + helpers, used by the Pipeline board (and any
// other page that needs to reason about a deal's manual dispo stage).
// Loaded after supa.js on pages that need it.

// ── Dispo stages (property-level, manual) ──────────────────────────────
const DISPO_STAGES = [
  { key: "prep",      label: "Prep / Not Live", color: "#A0AEC0" },
  { key: "live",      label: "Live / Marketing", color: "#3182CE" },
  { key: "interest",  label: "Interest",         color: "#6B46C1" },
  { key: "committed", label: "Committed",        color: "#DD6B20" },
  { key: "closed",    label: "Closed 🎉",        color: "#2F855A" },
  { key: "dead",      label: "Dead",             color: "#C53030" },
];
const DISPO_BY_KEY   = Object.fromEntries(DISPO_STAGES.map((s, i) => [s.key, { ...s, rank: i }]));
const DISPO_TERMINAL = new Set(["closed", "dead"]);
const STALE_DAYS     = 7;

// deal_leads stage → the dispo stage it implies (dead leads are ignored).
const LEAD_TO_DISPO = {
  new: "live", responded: "live",
  interested: "interest", offer: "interest",
  under_contract: "committed", closed: "closed",
};

// Highest dispo stage the deal's OWN signals imply — used only to *suggest*,
// never to move. "Marketed" (any sent blast/deck) implies at least `live`;
// this covers both subto blasts and Morby deck-sends (same send-blast path).
function impliedDispoStage(leads, blasts, recips) {
  let bestRank = -1;
  const marketed = (blasts || []).some(b => b.status === "sent")
                || (recips || []).some(r => r.status === "sent");
  if (marketed) bestRank = Math.max(bestRank, DISPO_BY_KEY.live.rank);
  for (const l of (leads || [])) {
    if (l.stage === "dead") continue;
    const implied = LEAD_TO_DISPO[l.stage];
    if (implied) bestRank = Math.max(bestRank, DISPO_BY_KEY[implied].rank);
  }
  return bestRank >= 0 ? DISPO_STAGES[bestRank].key : null;
}

// True when a non-terminal deal hasn't been touched in STALE_DAYS.
function isStaleDeal(p) {
  const stage = p.dispo_stage || "prep";
  if (DISPO_TERMINAL.has(stage)) return false;
  const clock = p.stage_moved_at || p.synced_at;
  if (!clock) return false;
  const days = (Date.now() - new Date(clock).getTime()) / 86400000;
  return days >= STALE_DAYS;
}
