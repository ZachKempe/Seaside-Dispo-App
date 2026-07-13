// Shared dispo-stage state + helpers, used by the Pipeline board.
// Stages are DB-backed (table `dispo_stages`) and editable from the Pipeline
// "Manage stages" modal. Loaded after supa.js on pages that need it; call
// `await loadDispoStages()` once before rendering.

const STALE_DAYS = 7;

// Fallback used only if the table is empty/unreachable (e.g. migration 022 not
// run yet) — keeps the board working with the original six stages.
const DEFAULT_DISPO_STAGES = [
  { key: "prep",      label: "Prep / Not Live", color: "#A0AEC0", is_terminal: false },
  { key: "live",      label: "Live / Marketing", color: "#3182CE", is_terminal: false },
  { key: "interest",  label: "Interest",         color: "#6B46C1", is_terminal: false },
  { key: "committed", label: "Committed",        color: "#DD6B20", is_terminal: false },
  { key: "closed",    label: "Closed 🎉",        color: "#2F855A", is_terminal: true },
  { key: "dead",      label: "Dead",             color: "#C53030", is_terminal: true },
];

// deal_leads stage → the DEFAULT dispo stage it implies (dead leads ignored).
// If the operator has renamed/removed those default stages, the corresponding
// suggestion simply stops firing (impliedDispoStage guards for missing keys).
const LEAD_TO_DISPO = {
  new: "live", responded: "live",
  interested: "interest", offer: "interest",
  under_contract: "committed", closed: "closed",
};

// Populated by loadDispoStages(); ordered by `position`.
let DISPO_STAGES = DEFAULT_DISPO_STAGES.slice();
let DISPO_BY_KEY = {};
let DISPO_TERMINAL = new Set();

function applyDispoStages(rows) {
  DISPO_STAGES = rows.map(r => ({ key: r.key, label: r.label, color: r.color || "#A0AEC0", is_terminal: !!r.is_terminal }));
  DISPO_BY_KEY = Object.fromEntries(DISPO_STAGES.map((s, i) => [s.key, { ...s, rank: i }]));
  DISPO_TERMINAL = new Set(DISPO_STAGES.filter(s => s.is_terminal).map(s => s.key));
}
applyDispoStages(DEFAULT_DISPO_STAGES); // sensible defaults until loaded

// Fetch the operator's stage list from Supabase. Falls back to defaults.
async function loadDispoStages() {
  let rows = null;
  try {
    const { data, error } = await supa.from("dispo_stages").select("*").order("position", { ascending: true });
    if (!error && data && data.length) rows = data;
  } catch (e) { /* table missing → fall back */ }
  applyDispoStages(rows && rows.length ? rows : DEFAULT_DISPO_STAGES);
}

// Highest dispo stage the deal's OWN signals imply — used only to *suggest*,
// never to move. "Marketed" (any sent blast/deck) implies at least `live`.
function impliedDispoStage(leads, blasts, recips) {
  let bestRank = -1;
  const marketed = (blasts || []).some(b => b.status === "sent")
                || (recips || []).some(r => r.status === "sent");
  if (marketed && DISPO_BY_KEY.live) bestRank = Math.max(bestRank, DISPO_BY_KEY.live.rank);
  for (const l of (leads || [])) {
    if (l.stage === "dead") continue;
    const implied = LEAD_TO_DISPO[l.stage];
    if (implied && DISPO_BY_KEY[implied]) bestRank = Math.max(bestRank, DISPO_BY_KEY[implied].rank);
  }
  return bestRank >= 0 ? DISPO_STAGES[bestRank].key : null;
}

// True when a non-terminal deal hasn't been touched in STALE_DAYS.
function isStaleDeal(p) {
  const stage = p.dispo_stage || (DISPO_STAGES[0] && DISPO_STAGES[0].key) || "prep";
  if (DISPO_TERMINAL.has(stage)) return false;
  const clock = p.stage_moved_at || p.synced_at;
  if (!clock) return false;
  const days = (Date.now() - new Date(clock).getTime()) / 86400000;
  return days >= STALE_DAYS;
}
