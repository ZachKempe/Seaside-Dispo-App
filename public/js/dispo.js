// Dispo-stage list (table `dispo_stages`), used by the Posting dashboard's
// Morby PSA-SIGNED gate (morbyOnDashboard / stampPsaSigned in dashboard.js).
// The Pipeline board that edited stages was removed Sept 27 2026; the table
// and properties.dispo_stage are kept. Load after supa.js and call
// `await loadDispoStages()` once before rendering.

// Fallback used only if the table is empty/unreachable (e.g. migration 022 not
// run yet) — keeps the PSA gate working with the original six stages.
const DEFAULT_DISPO_STAGES = [
  { key: "prep",      label: "Prep / Not Live", color: "#A0AEC0", is_terminal: false },
  { key: "live",      label: "Live / Marketing", color: "#3182CE", is_terminal: false },
  { key: "interest",  label: "Interest",         color: "#6B46C1", is_terminal: false },
  { key: "committed", label: "Committed",        color: "#DD6B20", is_terminal: false },
  { key: "closed",    label: "Closed 🎉",        color: "#2F855A", is_terminal: true },
  { key: "dead",      label: "Dead",             color: "#C53030", is_terminal: true },
];

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
