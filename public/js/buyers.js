let allBuyers = [];
let lastContactByBuyer = {};

// ── Master–detail + matcher state (client-side only) ──
let selectedId = null;
let matchActive = false;
let deal = { state: "", price: "", strategy: "" };
// Buy-box completeness filter (B4.1): "" = everyone, or one of the
// DealShared.buyBoxCompleteness buckets. View-only — it narrows the list on
// screen and nothing else. Blast audiences are unaffected.
let boxFilter = "";
const MATCH_THRESHOLD = 70;   // "strong match" cutoff
// Do the structured buy-box columns (migration 024) exist yet? Detected
// from the loaded rows; until then close speed/status/asset are parsed
// out of the notes text.
let hasBuyboxCols = false;

const TIER_INFO = {
  A: { label: "Hot",  cls: "tier-hot"  },
  B: { label: "Warm", cls: "tier-warm" },
  C: { label: "Cold", cls: "tier-cold" },
};
const TIER_CYCLE = { A: "B", B: "C", C: "A" };
function tierInfo(t) { return TIER_INFO[t] || { label: t || "Untiered", cls: "tier-cold" }; }

// escapeHtml + fmtDate come from /js/ui-shared.js
function fmtMoney(n) { n = Number(n) || 0; return n ? `$${n.toLocaleString()}` : ""; }
function buyerStates(b) {
  return (b.states || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}
function missingInfo(b) {
  return !buyerStates(b).length || (!b.phone && !b.email);
}
function phoneHref(b) { return (b.phone || "").replace(/[^\d+]/g, ""); }

// A buyer's strategies are stored comma-separated in the `strategy` column
// (e.g. "subto,morby"). Empty or "all" means "matches every strategy".
const STRATEGY_LABELS = { subto: "Subject To", owner_finance: "Owner Finance", cash: "Cash", morby: "Morby/Stack", all: "All" };
function buyerStrategies(s) {
  return String(s || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
}

// Structured buy-box, with a notes-parsing fallback for the fields that
// may not be columns yet ("Close speed: Fast (7 days) | Status: Ready now").
function buyBox(b) {
  const fromNotes = (label) => {
    const m = (b.notes || "").match(new RegExp(label + "\\s*:\\s*([^|\\n]+)", "i"));
    return m ? m[1].trim() : "";
  };
  let budget = "";
  if (Number(b.max_price)) budget = `≤ ${fmtMoney(b.max_price)} entry`;
  else if (Number(b.max_piti)) budget = `≤ ${fmtMoney(b.max_piti)}/mo PITI`;
  return {
    budget,
    closeSpeed: (b.close_speed || "").trim() || fromNotes("close speed"),
    status:     (b.status || "").trim()      || fromNotes("status"),
    asset:      (b.asset_type || "").trim()  || fromNotes("asset"),
  };
}

// ── Engagement (score + per-buyer timeline), from /js/deal-shared.js ──
// engByBuyer[id] = { score, counts, lastTouchAt, events: [{icon,label,at}] }
let engByBuyer = {};
const INTEREST_STAGES = new Set(["interested", "offer", "under_contract", "closed"]);

function buildEngagement(activity, dViews, dLeads, eEvents, propNames, buyers) {
  const nameByCard = Object.fromEntries((propNames || []).map(p => [p.card_id, p.name]));
  const dealName = (cardId, fallback) => {
    const n = nameByCard[cardId] || fallback || "";
    return n ? ` — ${n.split(",")[0]}` : "";
  };
  engByBuyer = {};
  const ensure = (id) => (engByBuyer[id] ||= { counts: {}, lastTouchAt: null, events: [] });
  const bump = (id, key) => { const e = ensure(id); e.counts[key] = (e.counts[key] || 0) + 1; };
  const touch = (id, at) => {
    const e = ensure(id);
    if (at && (!e.lastTouchAt || new Date(at) > new Date(e.lastTouchAt))) e.lastTouchAt = at;
  };
  const log = (id, icon, label, at) => ensure(id).events.push({ icon, label, at });

  // deck_views.source (migration 030) records which channel the link came
  // from — SMS and email links were always tokenized alike, so both have
  // always been attributed; this is what tells them apart. Rows written
  // before 030 (and forwarded/copied links) have no source.
  const SOURCE_LABELS = { sms: "SMS", email: "email", dm: "DM" };
  const via = (v) => SOURCE_LABELS[v.source] ? ` via ${SOURCE_LABELS[v.source]}` : "";
  for (const v of dViews) {
    if (v.kind === "pdf") { bump(v.buyer_id, "pdf"); log(v.buyer_id, "📄", `Downloaded deck PDF${dealName(v.card_id)}${via(v)}`, v.viewed_at); }
    else {
      bump(v.buyer_id, "view");
      if (v.source) bump(v.buyer_id, `view_${v.source}`); // per-channel counts
      if ((v.dwell_seconds || 0) >= 60) bump(v.buyer_id, "longDwell");
      const e = ensure(v.buyer_id);
      e.dwellTotal = (e.dwellTotal || 0) + (Number(v.dwell_seconds) || 0);
      const dwell = (v.dwell_seconds || 0) >= 60 ? ` (${Math.round(v.dwell_seconds / 60)}m on page)` : "";
      log(v.buyer_id, "👀", `Viewed deck${dealName(v.card_id)}${via(v)}${dwell}`, v.viewed_at);
    }
    touch(v.buyer_id, v.viewed_at);
  }
  for (const ev of eEvents) {
    if (ev.event === "opened") { bump(ev.buyer_id, "open"); log(ev.buyer_id, "✉️", `Opened email${dealName(ev.card_id)}`, ev.created_at); touch(ev.buyer_id, ev.created_at); }
    else if (ev.event === "clicked") { bump(ev.buyer_id, "click"); log(ev.buyer_id, "🔗", `Clicked email link${dealName(ev.card_id)}`, ev.created_at); touch(ev.buyer_id, ev.created_at); }
    else if (ev.event === "bounced") log(ev.buyer_id, "⚠️", "Email bounced", ev.created_at);
    else if (ev.event === "complained") {
      // Scored (negatively) — see ENGAGEMENT_PENALTIES. Deliberately no
      // touch(): a complaint is not a sign of life to sort them up by.
      bump(ev.buyer_id, "complaint");
      log(ev.buyer_id, "🚫", "Marked email as spam (opted out)", ev.created_at);
    }
  }
  // The bounce penalty keys off email_bounced_at (031), not the bounced
  // event rows: only PERMANENT bounces set that column, and a mailbox that
  // was full for a day shouldn't cost anyone points.
  for (const b of (buyers || [])) if (b.email_bounced_at) bump(b.id, "bounce");
  for (const a of activity) {
    if (!a.buyer_id) continue;
    if (a.channel === "email" || a.channel === "sms") {
      bump(a.buyer_id, "reply"); touch(a.buyer_id, a.created_at);
      log(a.buyer_id, "💬", `Replied by ${a.channel}${dealName(a.card_id, a.address)}${a.detail ? ` — “${a.detail.slice(0, 80)}”` : ""}`, a.created_at);
    } else {
      // manual/note = our outbound touch; shown in the timeline, not scored
      log(a.buyer_id, "📝", a.detail ? a.detail.slice(0, 100) : "Activity logged", a.created_at);
    }
  }
  for (const l of dLeads) {
    if (INTEREST_STAGES.has(l.stage)) bump(l.buyer_id, "interest");
    touch(l.buyer_id, l.updated_at || l.created_at);
    const via = l.source === "deck_page" ? " via deck page" : "";
    log(l.buyer_id, "⭐", `Pipeline: ${l.stage.replace(/_/g, " ")}${via}${dealName(l.card_id, l.address)}`, l.updated_at || l.created_at);
  }

  for (const id in engByBuyer) {
    const e = engByBuyer[id];
    e.events.sort((a, b) => new Date(b.at) - new Date(a.at));
    e.score = DealShared.engagementScore(e.counts, e.lastTouchAt);
  }
}

function engInfo(id) { return engByBuyer[id] || { score: 0, counts: {}, lastTouchAt: null, events: [] }; }
const ENG_BADGE = {
  hot:   { bg: "#FEEBC8", fg: "#C05621", icon: "🔥" },
  warm:  { bg: "#FEFCBF", fg: "#975A16", icon: "⚡" },
  quiet: { bg: "#EDF2F7", fg: "#718096", icon: "·" },
};
function engBadgeHtml(id) {
  const { score } = engInfo(id);
  const level = DealShared.engagementLevel(score);
  if (level === "none") return "";
  const s = ENG_BADGE[level];
  return `<span title="Engagement ${score}/100 — deck views, opens, clicks, replies, recency; spam complaints and hard bounces subtract" style="display:inline-flex;align-items:center;gap:4px;background:${s.bg};color:${s.fg};font-size:0.72rem;font-weight:800;border-radius:999px;padding:2px 9px">${s.icon} ${score}</span>`;
}

// ── Match scoring (0–100, clamped) ──
// State: +50 in-market / −40 out. Strategy: +30 match, +15 if no deal
// strategy set. Price: +20 within (or no) budget, −60 over.
function matchInfo(b) {
  let score = 0;
  const reasons = [];
  if (deal.state) {
    if (buyerStates(b).includes(deal.state)) { score += 50; reasons.push({ t: deal.state, ok: true }); }
    else { score -= 40; reasons.push({ t: deal.state, ok: false }); }
  }
  if (deal.strategy) {
    const strats = buyerStrategies(b.strategy);
    const label = STRATEGY_LABELS[deal.strategy] || deal.strategy;
    if (!strats.length || strats.includes("all") || strats.includes(deal.strategy)) { score += 30; reasons.push({ t: label, ok: true }); }
    else { reasons.push({ t: label, ok: false }); }
  } else score += 15;
  if (deal.price) {
    const p = Number(deal.price);
    if (!Number(b.max_price) || Number(b.max_price) >= p) { score += 20; reasons.push({ t: `≤ ${fmtMoney(p)}`, ok: true }); }
    else { score -= 60; reasons.push({ t: "over budget", ok: false }); }
  } else score += 20;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

async function loadBuyers() {
  // Engagement sources are fetched alongside the buyers. Each is scoped to
  // attributed rows (buyer_id set) and capped newest-first — plenty for
  // scoring/timelines without pulling unbounded history. email_events may
  // not exist yet (026 migration); its error fails soft to an empty list.
  // All fetches go through fetchAllRows (F3): PostgREST silently truncates at
  // 1,000 rows per request, so the old .limit(4000) calls actually got 1,000
  // and the buyer list itself would drop everyone past row 1,000. The
  // secondary .order("id") makes paging deterministic across requests.
  const [{ data, error }, { data: activity }, { data: dViews }, { data: dLeads }, { data: eEvents }, { data: propNames }] = await Promise.all([
    fetchAllRows(() => supa.from("buyers").select("*").eq("active", true).order("date_added", { ascending: false }).order("id")),
    fetchAllRows(() => supa.from("buyer_activity").select("buyer_id,channel,detail,card_id,address,created_at").order("created_at", { ascending: false }).order("id"), { maxRows: 4000 }),
    // `source` (030) tells SMS views from email views. Falls back to the
    // pre-030 column set so the page still loads before the migration runs.
    fetchAllRows(() => supa.from("deck_views").select("buyer_id,card_id,kind,source,dwell_seconds,viewed_at").not("buyer_id", "is", null).order("viewed_at", { ascending: false }).order("id"), { maxRows: 4000 })
      .then(r => r.error ? fetchAllRows(() => supa.from("deck_views").select("buyer_id,card_id,kind,dwell_seconds,viewed_at").not("buyer_id", "is", null).order("viewed_at", { ascending: false }).order("id"), { maxRows: 4000 }) : r),
    fetchAllRows(() => supa.from("deal_leads").select("buyer_id,card_id,address,stage,source,created_at,updated_at").not("buyer_id", "is", null).order("updated_at", { ascending: false }).order("id"), { maxRows: 4000 }),
    fetchAllRows(() => supa.from("email_events").select("buyer_id,card_id,event,link_url,created_at").not("buyer_id", "is", null).order("created_at", { ascending: false }).order("id"), { maxRows: 4000 }),
    fetchAllRows(() => supa.from("properties").select("card_id,name").order("card_id")),
  ]);
  const loading = document.getElementById("loading");
  if (error) { loading.innerHTML = `<div class="empty">Couldn't load buyers: ${escapeHtml(error.message)}</div>`; return; }
  allBuyers = data || [];
  lastContactByBuyer = {};
  for (const a of (activity || [])) {
    const cur = lastContactByBuyer[a.buyer_id];
    if (!cur || new Date(a.created_at) > new Date(cur)) lastContactByBuyer[a.buyer_id] = a.created_at;
  }
  buildEngagement(activity || [], dViews || [], dLeads || [], eEvents || [], propNames || [], allBuyers);
  hasBuyboxCols = allBuyers.length > 0 && Object.prototype.hasOwnProperty.call(allBuyers[0], "close_speed");
  document.querySelectorAll(".buybox-col-field").forEach(el => el.classList.toggle("hidden", !hasBuyboxCols));
  document.getElementById("buybox-note").classList.toggle("hidden", hasBuyboxCols);
  populateMatchStates();
  loading.classList.add("hidden");
  document.getElementById("main-ui").classList.remove("hidden");
  renderAll();
  checkNewBuyers(allBuyers);
}

function checkNewBuyers(buyers) {
  const STORAGE_KEY = 'seaside_buyers_last_visit';
  const lastVisit = localStorage.getItem(STORAGE_KEY);
  const now = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, now);
  if (!lastVisit) return;
  const newOnes = buyers.filter(b => b.list_source === 'investor' && b.date_added && new Date(b.date_added) > new Date(lastVisit));
  if (!newOnes.length) return;
  const names = newOnes.slice(0, 3).map(b => b.name).join(', ');
  const extra = newOnes.length > 3 ? ` + ${newOnes.length - 3} more` : '';
  document.getElementById('new-buyers-text').textContent = `${newOnes.length} new buyer${newOnes.length > 1 ? 's' : ''} from the form: ${names}${extra}`;
  document.getElementById('new-buyers-banner').style.display = 'flex';
}

function dismissNewBuyersBanner() {
  document.getElementById('new-buyers-banner').style.display = 'none';
}

function populateMatchStates() {
  const sel = document.getElementById("match-state");
  const keep = sel.value;
  const states = new Set();
  allBuyers.forEach(b => buyerStates(b).forEach(s => states.add(s)));
  sel.innerHTML = `<option value="">Any state</option>` +
    [...states].sort().map(s => `<option value="${s}">${s}</option>`).join("");
  sel.value = keep && states.has(keep) ? keep : "";
}

// ── List + detail rendering ──

// Buyers visible in the left list: search-filtered, then sorted by match
// score (when a match is active) or alphabetically.
function visibleBuyers() {
  const q = document.getElementById("list-search").value.trim().toLowerCase();
  let list = allBuyers;
  if (q) list = list.filter(b => `${b.name} ${b.email} ${b.phone}`.toLowerCase().includes(q));
  if (boxFilter) list = list.filter(b => DealShared.buyBoxCompleteness(b) === boxFilter);
  const scored = list.map(b => ({ b, info: matchActive ? matchInfo(b) : null }));
  const sortMode = document.getElementById("list-sort").value;
  if (matchActive) scored.sort((x, y) => (y.info.score - x.info.score) || (x.b.name || "").localeCompare(y.b.name || ""));
  else if (sortMode === "engagement") scored.sort((x, y) => (engInfo(y.b.id).score - engInfo(x.b.id).score) || (x.b.name || "").localeCompare(y.b.name || ""));
  else if (sortMode === "newest") scored.sort((x, y) => new Date(y.b.date_added || 0) - new Date(x.b.date_added || 0));
  else scored.sort((x, y) => (x.b.name || "").localeCompare(y.b.name || ""));
  return scored;
}

function matchBadgeCls(score) {
  if (score >= MATCH_THRESHOLD) return "match-green";
  if (score > 0) return "match-amber";
  return "match-red";
}

// Cap how many rows go in the DOM at once — search narrows the rest.
const RENDER_CAP = 300;

function renderAll() {
  const scored = visibleBuyers();

  // Header count line. The completeness split (B4.1) is the number that says
  // how much of the list is real targeting versus blanks that match every
  // deal — clicking a bucket filters the list to exactly those buyers.
  const ready = allBuyers.filter(b => buyBox(b).status).length;
  const split = DealShared.buyBoxSplit(allBuyers);
  const bucket = (key, count, label, title) => {
    const on = boxFilter === key;
    return `<button type="button" class="box-filter-btn" data-key="${key}" title="${escapeHtml(title)}"
      style="background:${on ? "var(--navy, #1B3A6B)" : "none"};color:${on ? "#fff" : "inherit"};border:none;border-radius:999px;padding:0 7px;cursor:pointer;font:inherit;text-decoration:${on ? "none" : "underline dotted"}">${count} ${label}${on ? " ✕" : ""}</button>`;
  };
  document.getElementById("buyer-count").innerHTML =
    `${allBuyers.length} buyer${allBuyers.length === 1 ? "" : "s"} · ` +
    bucket("full", split.full, "full buy box", "Market, strategy and a budget on file — click to show only these") + ` · ` +
    bucket("wildcard", split.wildcard, "wildcard", "No market, strategy or budget on file — these buyers match every deal you send. Click to show only these") +
    ` · ${ready} ready to buy now`;
  document.querySelectorAll("#buyer-count .box-filter-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      boxFilter = boxFilter === btn.dataset.key ? "" : btn.dataset.key;
      renderAll();
    }));
  document.getElementById("list-count").textContent =
    scored.length === allBuyers.length ? `${scored.length}` : `${scored.length}/${allBuyers.length}`;

  // Matcher status
  document.getElementById("match-clear").classList.toggle("hidden", !matchActive);
  const status = document.getElementById("match-status");
  status.classList.toggle("hidden", !matchActive);
  if (matchActive) {
    const strong = scored.filter(x => x.info.score >= MATCH_THRESHOLD).length;
    status.textContent = `✓ ${strong} strong match${strong === 1 ? "" : "es"} · list sorted by fit`;
  }

  // Keep the selection valid: default to the first visible buyer.
  if (!scored.some(x => x.b.id === selectedId)) selectedId = scored.length ? scored[0].b.id : null;

  renderRows(scored);
  renderDetail();
}

function renderRows(scored) {
  const rowsEl = document.getElementById("buyer-rows");
  if (!scored.length) {
    rowsEl.innerHTML = `<div class="empty" style="padding:36px 16px">No buyers${allBuyers.length ? " match your search" : " yet — add or import some"}.</div>`;
    return;
  }
  const shown = scored.slice(0, RENDER_CAP);
  const capNotice = scored.length > RENDER_CAP
    ? `<div class="muted" style="padding:12px 16px;text-align:center;font-size:0.8rem">Showing the first ${RENDER_CAP} of ${scored.length}. Use search to narrow down.</div>`
    : "";
  rowsEl.innerHTML = shown.map(({ b, info }) => {
    const tier = tierInfo(b.tier);
    const tint = matchActive && info.score >= MATCH_THRESHOLD ? "tint-green"
               : matchActive && info.score > 0 ? "tint-amber" : "";
    const chips = [
      ...buyerStates(b).map(s => `<span class="chip-market">${escapeHtml(s)}</span>`),
      ...buyerStrategies(b.strategy).map(s => `<span class="chip-strat">${escapeHtml(STRATEGY_LABELS[s] || s.replace(/_/g, " "))}</span>`),
    ].join("");
    return `
      <div class="buyer-row ${tint} ${b.id === selectedId ? "selected" : ""}" data-id="${b.id}">
        <div style="flex:1;min-width:0">
          <div class="flex" style="gap:7px;flex-wrap:wrap">
            <strong style="color:var(--navy-dark);font-size:0.92rem">${escapeHtml(b.name)}</strong>
            <span class="tier-pill-sm ${tier.cls}">${escapeHtml(tier.label)}</span>
            ${missingInfo(b) ? `<span title="Missing info" style="font-size:0.72rem">⚠️</span>` : ""}
          </div>
          ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>` : ""}
        </div>
        <div style="align-self:center;display:flex;gap:6px;align-items:center">
          ${matchActive ? `<span class="match-badge ${matchBadgeCls(info.score)}">${info.score}%</span>` : engBadgeHtml(b.id)}
        </div>
      </div>`;
  }).join("") + capNotice;
}

function renderDetail() {
  const el = document.getElementById("buyer-detail");
  const b = allBuyers.find(x => x.id === selectedId);
  if (!b) {
    el.innerHTML = `<div class="empty">Select a buyer on the left${allBuyers.length ? "" : ", or add your first buyer"}.</div>`;
    return;
  }
  const tier = tierInfo(b.tier);
  const box = buyBox(b);
  const completeness = DealShared.buyBoxCompleteness(b);
  const info = matchActive ? matchInfo(b) : null;
  const eng = engInfo(b.id);
  const lastContact = fmtDate(lastContactByBuyer[b.id]);
  const tel = phoneHref(b);
  const markets = buyerStates(b);
  const strats = buyerStrategies(b.strategy);

  // Engagement summary: score + which signals produced it.
  const engLevel = DealShared.engagementLevel(eng.score);
  // Deck views split by the channel the link came from (030). Only channels
  // with views appear, so pre-030 history just shows the plain view count.
  const viewSplit = [
    eng.counts.view_sms && `${eng.counts.view_sms} SMS`,
    eng.counts.view_email && `${eng.counts.view_email} email`,
    eng.counts.view_dm && `${eng.counts.view_dm} DM`,
  ].filter(Boolean).join(" · ");
  const dwellMins = Math.round((eng.dwellTotal || 0) / 60);
  const countChips = [
    eng.counts.interest && `⭐ ${eng.counts.interest} interested`,
    eng.counts.reply && `💬 ${eng.counts.reply} repl${eng.counts.reply === 1 ? "y" : "ies"}`,
    eng.counts.view && `👀 ${eng.counts.view} deck view${eng.counts.view === 1 ? "" : "s"}${viewSplit ? ` (${viewSplit})` : ""}`,
    (eng.dwellTotal || 0) >= 60 && `⏱ ${dwellMins}m on deck`,
    eng.counts.pdf && `📄 ${eng.counts.pdf} PDF${eng.counts.pdf === 1 ? "" : "s"}`,
    eng.counts.click && `🔗 ${eng.counts.click} click${eng.counts.click === 1 ? "" : "s"}`,
    eng.counts.open && `✉️ ${eng.counts.open} open${eng.counts.open === 1 ? "" : "s"}`,
  ].filter(Boolean);
  // Negative signals, shown apart from the positives so a docked score is
  // explainable rather than mysterious.
  const penaltyChips = [
    eng.counts.complaint && `🚫 marked spam — score zeroed`,
    eng.counts.bounce && `⚠️ email hard-bounced — address dead`,
  ].filter(Boolean);
  const engColor = engLevel === "hot" ? "#C05621" : engLevel === "warm" ? "#975A16" : "var(--text-3)";
  const engagementHtml = `
    <div style="margin-top:16px;background:#F7FAFC;border:1px solid var(--border);border-radius:10px;padding:12px 14px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-3)">Engagement</span>
        <span style="font-size:1.05rem;font-weight:800;color:${engColor}">${eng.score ? `${engLevel === "hot" ? "🔥" : engLevel === "warm" ? "⚡" : ""} ${eng.score}/100` : "—"}</span>
        <div style="flex:1;min-width:120px;height:6px;background:#E2E8F0;border-radius:999px;overflow:hidden"><div style="width:${eng.score}%;height:100%;background:${engLevel === "hot" ? "#DD6B20" : engLevel === "warm" ? "#D69E2E" : "#A0AEC0"};border-radius:999px"></div></div>
      </div>
      ${countChips.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:9px">${countChips.map(c => `<span style="font-size:0.76rem;color:var(--text-2);background:#fff;border:1px solid var(--border);border-radius:999px;padding:3px 10px">${c}</span>`).join("")}</div>`
        : `<div class="muted" style="font-size:0.8rem;margin-top:8px">No engagement recorded yet — no deck views, opens, or replies from this buyer.</div>`}
      ${penaltyChips.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${penaltyChips.map(c => `<span style="font-size:0.76rem;color:#C53030;background:#FFF5F5;border:1px solid #FEB2B2;border-radius:999px;padding:3px 10px">${c}</span>`).join("")}</div>`
        : ""}
    </div>`;

  // Activity timeline: newest first, capped for readability.
  const timelineHtml = eng.events.length ? `
    <div style="margin-top:22px">
      <div class="bd-seclabel" style="margin-bottom:8px">Recent activity</div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;background:#fff">
        ${eng.events.slice(0, 25).map(ev => `
          <div style="display:flex;gap:10px;align-items:baseline;padding:8px 14px;border-bottom:1px solid #F1F5F9;font-size:0.84rem">
            <span style="flex-shrink:0">${ev.icon}</span>
            <span style="flex:1;color:var(--text-1)">${escapeHtml(ev.label)}</span>
            <span class="muted" style="flex-shrink:0;font-size:0.72rem">${fmtDate(ev.at) || ""}</span>
          </div>`).join("")}
      </div>
    </div>` : "";

  const reasonsHtml = (info && info.reasons.length) ? `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#F7FAFC;border:1px solid var(--border);border-radius:10px;padding:11px 14px;margin-top:16px">
      <span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-3)">Why this matched</span>
      ${info.reasons.map(r => `<span class="reason-chip ${r.ok ? "reason-ok" : "reason-no"}">${r.ok ? "✓" : "✗"} ${escapeHtml(r.t)}</span>`).join("")}
    </div>` : "";

  el.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding-bottom:16px;border-bottom:1px solid #EDF1F6">
      <div>
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <span style="font-size:1.4rem;font-weight:700;color:var(--navy-dark)">${escapeHtml(b.name)}</span>
          <button type="button" class="tier-pill ${tier.cls}" id="detail-tier" style="font-size:0.74rem;padding:2px 12px" title="Click to change tier (Hot → Warm → Cold)">${escapeHtml(tier.label)}</button>
          ${b.list_source ? `<span style="font-size:0.76rem;color:var(--text-3)">from ${escapeHtml(b.list_source)}</span>` : ""}
        </div>
        <div style="margin-top:8px;font-size:0.88rem;color:var(--text-2);display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">
          ${b.phone ? `<a href="tel:${escapeHtml(tel)}" style="color:var(--navy);text-decoration:none">📞 ${escapeHtml(b.phone)}</a>` : ""}
          ${b.email ? `<span>✉️ ${escapeHtml(b.email)}</span>` : ""}
          ${!b.phone && !b.email ? `<span class="muted">No contact info on file</span>` : ""}
          ${b.sms_opt_in ? `<span style="font-size:0.74rem;color:var(--text-3)">📱 SMS opt-in</span>` : ""}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        ${b.phone ? `<a class="btn btn-primary btn-sm" href="tel:${escapeHtml(tel)}">📞 Call</a>` : ""}
        ${b.phone ? `<a class="btn btn-ghost btn-sm" href="sms:${escapeHtml(tel)}">📱 Text</a>` : ""}
        <button class="btn btn-ghost btn-sm" id="detail-edit">Edit</button>
      </div>
    </div>

    ${reasonsHtml}
    ${engagementHtml}

    <div style="margin-top:18px">
      <div class="bd-seclabel" style="margin-bottom:12px;display:flex;align-items:center;gap:8px">Buy-box ${
        completeness === "wildcard"
          ? `<span title="No market, strategy or budget on file — this buyer matches every deal you send" style="background:#FFF5F5;color:#C53030;border:1px solid #FEB2B2;border-radius:999px;padding:2px 9px;font-size:0.68rem;font-weight:700;text-transform:none;letter-spacing:0">⚠ Wildcard — matches every deal</span>`
          : completeness === "partial"
            ? `<span title="Some criteria on file, but not a market + strategy + budget" style="background:#FFFAF0;color:#B7791F;border:1px solid #FBD38D;border-radius:999px;padding:2px 9px;font-size:0.68rem;font-weight:700;text-transform:none;letter-spacing:0">Partial box</span>`
            : `<span title="Market, strategy and budget on file" style="background:#F0FFF4;color:#2F855A;border:1px solid #9AE6B4;border-radius:999px;padding:2px 9px;font-size:0.68rem;font-weight:700;text-transform:none;letter-spacing:0">✓ Full box</span>`
      }</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px 20px">
        <div style="grid-column:1/-1">
          <div class="bd-sublabel">Markets</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${markets.length
              ? markets.map(s => `<span class="bd-chip-market">${escapeHtml(s)}</span>`).join("")
              : `<span style="color:#B7791F;font-size:0.82rem;font-weight:600">⚠ No markets set — add to enable matching</span>`}
          </div>
        </div>
        <div>
          <div class="bd-sublabel">Strategy</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${strats.length
              ? strats.map(s => `<span class="bd-chip-strat">${escapeHtml(STRATEGY_LABELS[s] || s.replace(/_/g, " "))}</span>`).join("")
              : `<span class="bd-chip-strat">All</span>`}
          </div>
        </div>
        <div>
          <div class="bd-sublabel">Budget</div>
          <div style="font-size:0.9rem;color:var(--text-1);font-weight:600">${box.budget ? escapeHtml(box.budget) : `<span class="muted">—</span>`}</div>
        </div>
        <div>
          <div class="bd-sublabel">Close speed</div>
          <div style="font-size:0.9rem;color:var(--text-1);font-weight:600">${box.closeSpeed ? escapeHtml(box.closeSpeed) : `<span class="muted">—</span>`}</div>
        </div>
        <div>
          <div class="bd-sublabel">Status</div>
          ${box.status
            ? `<span style="display:inline-block;background:#C6F6D5;color:var(--green);font-size:0.76rem;font-weight:700;border-radius:999px;padding:3px 11px">${escapeHtml(box.status)}</span>`
            : `<span class="muted" style="font-size:0.88rem">—</span>`}
        </div>
        ${box.asset ? `
        <div>
          <div class="bd-sublabel">Asset</div>
          <div style="font-size:0.9rem;color:var(--text-1);font-weight:600">${escapeHtml(box.asset)}</div>
        </div>` : ""}
      </div>
    </div>

    <div style="margin-top:22px">
      <div class="bd-seclabel" style="margin-bottom:8px">Notes</div>
      ${b.notes
        ? `<div style="font-size:0.9rem;color:var(--text-1);line-height:1.65;background:#F7FAFC;border:1px solid var(--border);border-radius:10px;padding:14px 16px;white-space:pre-wrap">${escapeHtml(b.notes)}</div>`
        : `<div style="font-size:0.88rem;color:var(--text-3);font-style:italic;background:#F7FAFC;border:1px dashed var(--border);border-radius:10px;padding:14px 16px">No free-text notes yet — add context about this buyer here.</div>`}
    </div>
    ${timelineHtml}

    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #EDF1F6;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="width:8px;height:8px;border-radius:50%;background:${lastContact ? "var(--green)" : "#CBD5E0"};display:inline-block"></span>
      <span style="font-size:0.86rem;color:var(--text-2);font-weight:500">${lastContact ? `Last contacted ${lastContact}` : "Not yet contacted"}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="detail-log">+ Log activity</button>
        <button class="btn btn-danger btn-sm" id="detail-remove">Remove</button>
      </div>
    </div>`;

  document.getElementById("detail-edit").addEventListener("click", () => openModal(b));
  document.getElementById("detail-log").addEventListener("click", () => logActivity(b));
  document.getElementById("detail-remove").addEventListener("click", () => removeBuyer(b));
  document.getElementById("detail-tier").addEventListener("click", async () => {
    const next = TIER_CYCLE[b.tier] || "A";
    const { error } = await supa.from("buyers").update({ tier: next }).eq("id", b.id);
    if (error) { toast(`Couldn't update tier: ${error.message}`, { type: "error" }); return; }
    b.tier = next;
    renderAll();
  });
}

async function logActivity(b) {
  const detail = prompt(`Log activity for ${b.name} — what happened?`, "");
  if (detail === null) return;
  const { error } = await supa.from("buyer_activity").insert({ buyer_id: b.id, channel: "manual", detail: detail.trim() });
  if (error) { toast(`Couldn't log activity: ${error.message}`, { type: "error" }); return; }
  lastContactByBuyer[b.id] = new Date().toISOString();
  toast("Activity logged.", { type: "success" });
  renderDetail();
}

// Soft delete: deactivate (hidden from the list + all blasts/matching) with
// an Undo. The record is preserved, so nothing is ever truly lost.
async function removeBuyer(b) {
  if (!confirm(`Remove ${b.name} from your buyer list?`)) return;
  const { error } = await supa.from("buyers").update({ active: false }).eq("id", b.id);
  if (error) { toast(`Couldn't remove ${b.name}: ${error.message}`, { type: "error" }); return; }
  toast(`Removed ${b.name}.`, { type: "success", actionLabel: "Undo", onAction: async () => {
    const { error: e2 } = await supa.from("buyers").update({ active: true }).eq("id", b.id);
    if (e2) { toast(`Undo failed: ${e2.message}`, { type: "error" }); return; }
    await loadBuyers();
  }});
  if (selectedId === b.id) selectedId = null;
  await loadBuyers();
}

// ── B4.3 Manual-add dedupe ──
// The CSV importer has always deduped by phone/email (classifyImport); the
// Add Buyer form never did, so re-typing someone already on the list created
// a second active record — and every blast then hit them twice. Same keys as
// the importer: digits-only phone, lower-cased email.
function findDuplicateBuyer(payload, excludeId) {
  const pd = digitsOnly(payload.phone);
  const em = (payload.email || "").trim().toLowerCase();
  if (!pd && !em) return null;
  return allBuyers.find(b =>
    Number(b.id) !== Number(excludeId) &&
    ((pd && digitsOnly(b.phone) === pd) || (em && (b.email || "").toLowerCase() === em))
  ) || null;
}

// Removed buyers are soft-deleted (active=false) and so aren't in allBuyers —
// the local check can't see them, and re-adding one would leave two rows for
// the same person. Ask the DB directly. Fails soft: a lookup error just means
// we fall through to the normal insert rather than blocking a save.
async function findRemovedBuyer(payload) {
  const em = (payload.email || "").trim().toLowerCase();
  const phone = (payload.phone || "").trim();
  const parts = [];
  if (em && !/[,()]/.test(em)) parts.push(`email.ilike.${em}`);
  if (phone && !/[,()]/.test(phone)) parts.push(`phone.eq.${phone}`);
  if (!parts.length) return null;
  const { data, error } = await supa.from("buyers")
    .select("id,name,email,phone").eq("active", false).or(parts.join(",")).limit(1);
  if (error) { console.warn("removed-buyer dedupe check failed:", error.message); return null; }
  return (data && data[0]) || null;
}

function openModal(b) {
  document.getElementById("modal-title").textContent = b ? "Edit Buyer" : "Add Buyer";
  document.getElementById("b-id").value = b ? b.id : "";
  document.getElementById("b-name").value = b ? b.name : "";
  document.getElementById("b-tier").value = b ? b.tier : "B";
  document.getElementById("b-email").value = b ? (b.email || "") : "";
  document.getElementById("b-phone").value = b ? (b.phone || "") : "";
  document.getElementById("b-states").value = b ? (b.states || "") : "";
  const stratSet = new Set(buyerStrategies(b ? b.strategy : ""));
  document.querySelectorAll(".b-strat-cb").forEach(cb => { cb.checked = stratSet.has(cb.value); });
  document.getElementById("b-maxprice").value = b ? (b.max_price || "") : "";
  document.getElementById("b-piti").value = b ? (b.max_piti || "") : "";
  document.getElementById("b-beds").value = b ? (b.min_beds || "") : "";
  if (hasBuyboxCols) {
    document.getElementById("b-close").value = b ? (b.close_speed || "") : "";
    document.getElementById("b-status").value = b ? (b.status || "") : "";
    document.getElementById("b-asset").value = b ? (b.asset_type || "") : "";
  }
  document.getElementById("b-notes").value = b ? (b.notes || "") : "";
  document.getElementById("b-sms").checked = b ? !!b.sms_opt_in : false;
  document.getElementById("modal-backdrop").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal-backdrop").classList.add("hidden"); }

function exportCsv() {
  const headers = ["First Name","Last Name","Email","Phone","Tier","States","Strategy","Max PITI","Min Beds","Source","Notes"];
  const rows = allBuyers.map(b => {
    const parts = (b.name || "").split(" ");
    return [
      parts[0] || "", parts.slice(1).join(" "), b.email || "", b.phone || "",
      b.tier || "", b.states || "", b.strategy || "", b.max_piti || 0, b.min_beds || 0,
      b.list_source || "", (b.notes || "").replace(/\n/g, " "),
    ];
  });
  const csv = [headers, ...rows].map(r =>
    r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "seaside_buyers_ghl.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────
// Buyer Inflow Engine — universal CSV import
// Turns any buyer list (BatchLeads, InvestorLift, Facebook, PropStream…)
// into deduped CRM buyers. Auto-detects columns, dedupes by phone/email
// against the existing list AND within the file, then bulk-inserts.
// ─────────────────────────────────────────────────────────────────────

// parseCsv / detectMapping / normalizeState / digitsOnly / validEmail live in
// /js/csv-import.js — shared with the contact importer.

// Parsed state held between "choose file" and "confirm import".
let importState = null;

function renderImportConfig() {
  const { headers, rows } = importState.raw;
  const mapping = importState.mapping;
  const fields = [
    ["name", "Name"], ["first", "First name"], ["last", "Last name"],
    ["email", "Email"], ["phone", "Phone"], ["company", "Company"],
    ["state", "State(s)"], ["notes", "Notes"],
  ];
  const opts = (sel) => `<option value="">— none —</option>` +
    headers.map((h, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${escapeHtml(h || `Column ${i + 1}`)}</option>`).join("");
  document.getElementById("import-mapping").innerHTML = fields.map(([f, label]) =>
    `<div class="field"><label style="font-size:0.78rem">${label}</label><select class="map-sel" data-field="${f}">${opts(mapping[f])}</select></div>`
  ).join("");
  document.getElementById("import-mapping").querySelectorAll(".map-sel").forEach(sel => {
    sel.addEventListener("change", () => {
      const f = sel.dataset.field;
      mapping[f] = sel.value === "" ? null : Number(sel.value);
      recomputeImport();
    });
  });
  document.getElementById("import-config").classList.remove("hidden");
  recomputeImport();
}

function recomputeImport() {
  const { rows } = importState.raw;
  const parsed = buildRowsFromCsv(rows, importState.mapping);
  const { fresh, dupes, invalid } = classifyImport(parsed, allBuyers);
  importState.fresh = fresh;
  const withPhone = fresh.filter(r => digitsOnly(r.phone)).length;
  const withEmail = fresh.filter(r => r.email).length;
  document.getElementById("import-summary").innerHTML = `
    <div class="flex gap-16" style="flex-wrap:wrap">
      <div><strong style="color:var(--navy-dark);font-size:1.1rem">${fresh.length}</strong> new to add</div>
      <div class="muted">${dupes.length} duplicate${dupes.length === 1 ? "" : "s"} skipped</div>
      <div class="muted">${invalid.length} unusable (no name/contact)</div>
    </div>
    <div class="muted" style="font-size:0.8rem;margin-top:6px">Of the new: ${withPhone} have a phone, ${withEmail} have an email.</div>`;
  const preview = fresh.slice(0, 8);
  document.getElementById("import-preview").innerHTML = preview.length ? `
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left;color:var(--text-2)">
        <th style="padding:4px 6px">Name</th><th style="padding:4px 6px">Phone</th><th style="padding:4px 6px">Email</th><th style="padding:4px 6px">States</th>
      </tr></thead>
      <tbody>${preview.map(r => `<tr style="border-top:1px solid var(--border)">
        <td style="padding:4px 6px">${escapeHtml(r.name)}</td>
        <td style="padding:4px 6px">${escapeHtml(r.phone)}</td>
        <td style="padding:4px 6px">${escapeHtml(r.email)}</td>
        <td style="padding:4px 6px">${escapeHtml(r.states)}</td></tr>`).join("")}</tbody>
    </table>
    ${fresh.length > 8 ? `<div class="muted" style="padding:6px">…and ${fresh.length - 8} more</div>` : ""}` : "";
  const btn = document.getElementById("import-confirm");
  btn.textContent = `Import ${fresh.length} buyer${fresh.length === 1 ? "" : "s"}`;
  btn.classList.toggle("hidden", fresh.length === 0);
  btn.disabled = fresh.length === 0;
}

function handleImportFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") { alert("Please choose a .csv file."); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const all = parseCsv(reader.result);
    if (all.length < 2) { alert("That CSV has no data rows."); return; }
    const headers = all[0];
    const rows = all.slice(1);
    importState = { raw: { headers, rows }, mapping: detectMapping(headers), fresh: [] };
    renderImportConfig();
  };
  reader.readAsText(file);
}

async function runImport() {
  const fresh = importState.fresh || [];
  if (!fresh.length) return;
  const btn = document.getElementById("import-confirm");
  btn.disabled = true;
  const source = document.getElementById("import-source").value;
  const tier = document.getElementById("import-tier").value;
  const strategy = document.getElementById("import-strategy").value;
  const records = fresh.map(r => {
    const noteParts = [];
    if (r.company) noteParts.push(`Company: ${r.company}`);
    if (r.notes) noteParts.push(r.notes);
    noteParts.push(`Imported from ${source} ${new Date().toLocaleDateString()}`);
    return {
      name: r.name, email: r.email, phone: r.phone, states: r.states,
      max_price: 0, max_piti: 0, min_beds: 0,
      strategy, tier, list_source: source, active: true, sms_opt_in: false,
      notes: noteParts.join(" | "),
    };
  });
  let added = 0, failed = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    btn.textContent = `Importing… ${i}/${records.length}`;
    const { error } = await supa.from("buyers").insert(chunk);
    if (error) { failed += chunk.length; console.error("import chunk failed:", error.message); }
    else added += chunk.length;
  }
  closeImport();
  await loadBuyers();
  alert(`Imported ${added} new buyer${added === 1 ? "" : "s"}.` + (failed ? ` ${failed} failed — check console.` : ""));
}

// ── Onboarding buy-box request ──
async function callOnboard(payload) {
  const { data: { session } } = await supa.auth.getSession();
  if (!session) { alert("Not signed in."); return null; }
  const r = await fetch("/.netlify/functions/onboard-buyers", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(payload),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) { alert(`Failed: ${out.error || r.status}`); return null; }
  return out;
}
// B4.2 — the ask is a short sequence now (up to 3 touches, spaced, last one
// by text), so the button asks the function what's actually due instead of
// guessing from onboarded_at. Preview sends nothing.
async function onboardBuyers() {
  const plan = await callOnboard({ preview: true });
  if (!plan) return;
  const p = plan.plan || {};
  if (!plan.due) {
    const s = plan.skipped || {};
    alert(`Nobody is due for a buy-box request right now.\n\n`
      + `${s.box_complete || 0} already gave us a full buy box\n`
      + `${s.not_due || 0} were asked recently (each touch is spaced out)\n`
      + `${s.sequence_finished || 0} have had every touch in the sequence\n`
      + `${s.unreachable || 0} have no reachable email or textable phone`
      + (plan.note ? `\n\n⚠ ${plan.note}` : ""));
    return;
  }
  const lines = [
    `${plan.due} buyer${plan.due === 1 ? "" : "s"} are due for a buy-box request:`,
    ``,
    `${p.touch1 || 0} first ask · ${p.touch2 || 0} follow-up · ${p.touch3 || 0} final`,
    `${p.email || 0} by email · ${p.sms || 0} by text`,
  ];
  if (plan.note) lines.push(``, `⚠ ${plan.note}`);

  if (confirm(`${lines.join("\n")}\n\nSend a TEST to yourself first? (Recommended)`)) {
    const t = await callOnboard({ test: true });
    if (!t) return;
    alert(`Test email sent to ${t.to}. Check your inbox.`);
    if ((p.sms || 0) > 0) {
      const phone = prompt(`${p.sms} of these go out as a TEXT. Send a test text to which number?\n\n(Leave blank to skip.)`, "");
      if (phone && phone.trim()) {
        const ts = await callOnboard({ test: true, channel: "sms", test_phone: phone.trim() });
        if (ts) alert(`Test text sent to ${ts.to}.`);
      }
    }
  }
  if (!confirm(`${lines.join("\n")}\n\nSend for real now? This messages real buyers.`)) return;
  const res = await callOnboard({});
  if (res) {
    const by = res.by_channel || {};
    alert(`Sent ${res.sent} buy-box request${res.sent === 1 ? "" : "s"}`
      + ` (${by.email || 0} email · ${by.sms || 0} text).`
      + (res.failed ? `\n${res.failed} failed — check the function log.` : ""));
    await loadBuyers();
  }
}

function openImport() {
  importState = null;
  document.getElementById("import-config").classList.add("hidden");
  document.getElementById("import-confirm").classList.add("hidden");
  document.getElementById("import-file").value = "";
  document.getElementById("import-backdrop").classList.remove("hidden");
}
function closeImport() { document.getElementById("import-backdrop").classList.add("hidden"); }

(async () => {
  const session = await requireAuth();
  if (!session) return;
  wireLogout(document.getElementById("logout-btn"));

  // ── Tools dropdown ──
  const toolsBtn = document.getElementById("tools-btn");
  const toolsMenu = document.getElementById("tools-menu");
  const closeTools = () => toolsMenu.classList.add("hidden");
  toolsBtn.addEventListener("click", (e) => { e.stopPropagation(); toolsMenu.classList.toggle("hidden"); });
  document.addEventListener("click", (e) => { if (!toolsMenu.contains(e.target)) closeTools(); });

  document.getElementById("add-btn").addEventListener("click", () => openModal(null));
  document.getElementById("copy-form-btn").addEventListener("click", () => {
    navigator.clipboard.writeText("https://seaside-buyer-questionnaire.netlify.app/");
    toast("Form link copied.", { type: "success" });
    closeTools();
  });
  document.getElementById("export-btn").addEventListener("click", () => { exportCsv(); closeTools(); });
  document.getElementById("import-btn").addEventListener("click", () => { openImport(); closeTools(); });
  document.getElementById("onboard-btn").addEventListener("click", () => { closeTools(); onboardBuyers(); });

  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", e => { if (e.target.id === "modal-backdrop") closeModal(); });

  // ── Deal matcher ──
  document.getElementById("match-go").addEventListener("click", () => {
    deal = {
      state: document.getElementById("match-state").value,
      price: document.getElementById("match-price").value.trim(),
      strategy: document.getElementById("match-strategy").value,
    };
    matchActive = true;
    renderAll();
  });
  document.getElementById("match-clear").addEventListener("click", () => {
    document.getElementById("match-state").value = "";
    document.getElementById("match-price").value = "";
    document.getElementById("match-strategy").value = "";
    deal = { state: "", price: "", strategy: "" };
    matchActive = false;
    renderAll();
  });
  document.getElementById("match-price").addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("match-go").click();
  });

  // ── List: search (debounced) + sort + row selection ──
  let renderTimer = null;
  document.getElementById("list-search").addEventListener("input", () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 180);
  });
  document.getElementById("list-sort").addEventListener("change", renderAll);
  document.getElementById("buyer-rows").addEventListener("click", (e) => {
    const row = e.target.closest(".buyer-row");
    if (!row) return;
    selectedId = Number(row.dataset.id);
    document.querySelectorAll("#buyer-rows .buyer-row").forEach(r =>
      r.classList.toggle("selected", Number(r.dataset.id) === selectedId));
    renderDetail();
  });

  // ── Import engine wiring ──
  const importDrop = document.getElementById("import-drop");
  const importFile = document.getElementById("import-file");
  document.getElementById("import-cancel").addEventListener("click", closeImport);
  document.getElementById("import-confirm").addEventListener("click", runImport);
  document.getElementById("import-backdrop").addEventListener("click", e => { if (e.target.id === "import-backdrop") closeImport(); });
  importDrop.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", () => handleImportFile(importFile.files[0]));
  ["dragover","dragenter"].forEach(ev => importDrop.addEventListener(ev, e => { e.preventDefault(); importDrop.style.borderColor = "var(--navy)"; }));
  ["dragleave","drop"].forEach(ev => importDrop.addEventListener(ev, e => { e.preventDefault(); importDrop.style.borderColor = "var(--border)"; }));
  importDrop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handleImportFile(f); });

  document.getElementById("buyer-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("b-id").value;
    const payload = {
      name: document.getElementById("b-name").value.trim(),
      tier: document.getElementById("b-tier").value,
      email: document.getElementById("b-email").value.trim(),
      phone: document.getElementById("b-phone").value.trim(),
      states: document.getElementById("b-states").value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).join(","),
      strategy: [...document.querySelectorAll(".b-strat-cb:checked")].map(cb => cb.value).join(",") || "all",
      max_price: Number(document.getElementById("b-maxprice").value) || 0,
      max_piti: Number(document.getElementById("b-piti").value) || 0,
      min_beds: Number(document.getElementById("b-beds").value) || 0,
      notes: document.getElementById("b-notes").value.trim(),
      sms_opt_in: document.getElementById("b-sms").checked,
    };
    // Structured buy-box fields only exist after migration 024.
    if (hasBuyboxCols) {
      payload.close_speed = document.getElementById("b-close").value;
      payload.status = document.getElementById("b-status").value;
      payload.asset_type = document.getElementById("b-asset").value.trim();
    }
    // Dedupe before writing. On an edit this only fires when the new contact
    // details collide with a DIFFERENT buyer.
    const dupe = findDuplicateBuyer(payload, id);
    if (dupe) {
      const how = digitsOnly(payload.phone) && digitsOnly(dupe.phone) === digitsOnly(payload.phone) ? "phone number" : "email address";
      if (id) {
        if (!confirm(`${dupe.name} already has that ${how}.\n\nSaving will leave two buyers sharing it, and both will receive every blast. Save anyway?`)) return;
      } else {
        if (confirm(`${dupe.name} is already on your list with that ${how}.\n\nOpen their record instead of adding a duplicate?`)) {
          closeModal();
          selectedId = dupe.id;
          boxFilter = "";
          document.getElementById("list-search").value = "";
          renderAll();
        } else {
          toast(`Not added — ${dupe.name} already has that ${how}.`, { type: "error" });
        }
        return;
      }
    }
    // Not in the visible list, but possibly removed earlier: restore rather
    // than create a second row for the same person.
    let restoreId = null;
    if (!id) {
      const removed = await findRemovedBuyer(payload);
      if (removed) {
        if (confirm(`${removed.name} was removed from your list but still has that contact info.\n\nRestore them with these details? (Cancel adds a separate new buyer.)`)) {
          restoreId = removed.id;
        }
      }
    }

    const { error } = id
      ? await supa.from("buyers").update(payload).eq("id", id)
      : restoreId
        ? await supa.from("buyers").update({ ...payload, active: true }).eq("id", restoreId)
        : await supa.from("buyers").insert({ ...payload, list_source: "direct", active: true });
    if (error) { toast(`Couldn't save buyer: ${error.message}`, { type: "error" }); return; }
    closeModal();
    toast(id ? "Buyer saved." : restoreId ? "Buyer restored." : "Buyer added.", { type: "success" });
    if (restoreId) selectedId = restoreId;
    await loadBuyers();
  });

  await loadBuyers();
})();
