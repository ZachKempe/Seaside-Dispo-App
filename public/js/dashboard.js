const FB_GROUPS = [
  { name: "SubTo/Creative Finance", url: "https://www.facebook.com/groups/4250744751826258" },
  { name: "Seller Financing Homes", url: "https://www.facebook.com/groups/sellerfinancinghomes" },
  { name: "Owner Finance Academy", url: "https://www.facebook.com/groups/OWNERFINANCEACADEMY" },
  { name: "Creative Finance Group", url: "https://www.facebook.com/groups/2364407587034125" },
  { name: "SubTo Investors", url: "https://www.facebook.com/groups/498176250361246" },
];

let session;
const dealCache = {}; // card_id -> { prop, terms, matched: [...buyers] }
const activeTabByCard = {}; // card_id -> "posting" | "dealinfo" — preserved across re-renders
let allBuyers = []; // every active buyer — used by the blast modal's "by method" filter

// ── Deal triage (scalability): cards render as compact one-line rows by
// default and expand on click; the triage bar searches/filters/sorts them.
// State lives here so it survives loadAll re-renders within the session.
const expandedDealCards = new Set(); // card_ids currently shown as full cards
const dealView = { query: "", filter: "all", sort: "attention" }; // triage bar state
let boardData = null;      // last loadAll fetch — lets renderBoard re-render without refetching
let dealSearchTimer = null; // debounce for the triage search box

// Shared with send-blast.js and the deck page (see /js/deal-shared.js) so
// the blast preview, the live send, and the emails can never disagree.
const { fmtMoney, matchesDeal, dscrMonthlyPayment } = DealShared;

// escapeHtml comes from /js/ui-shared.js

const ZACH_PHONE = "630-488-5311";

// ── Deck-page links (the buyer-facing /deck/<slug> page) ──
// Slugs are minted eagerly at intake now; legacy cards that predate that (and
// were never blasted) get theirs backfilled on demand via deck-link.js.
function deckUrlFor(p) {
  return p && p.deck_slug ? `${location.origin}/deck/${p.deck_slug}` : "";
}
// Server resolve: backfills a missing slug, and (with buyerId) returns the
// per-buyer tokenized link so a manually DM'd buyer still attributes views.
async function fetchDeckLink(cardId, buyerId = null) {
  const { data: { session: s } } = await supa.auth.getSession();
  const res = await fetch("/.netlify/functions/deck-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
    body: JSON.stringify(buyerId ? { card_id: cardId, buyer_id: buyerId } : { card_id: cardId }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Couldn't resolve deck link");
  const cached = dealCache[cardId];
  if (cached && cached.prop && !cached.prop.deck_slug) cached.prop.deck_slug = result.slug;
  return result.url;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) { prompt("Copy the link:", text); return false; }
}

// ── Feature 2: "Copy Deal Info" — pre-formatted text for pasting into texts/DMs ──
function buildDealCopyText(p, t) {
  const beds = t.beds || "—";
  const baths = t.baths || "—";
  const sqft = t.sqft ? Number(t.sqft).toLocaleString() : "—";
  const year = t.year_built || "—";
  const entryFee = Number(t.entry_fee) || 0;
  const price = Number(t.price) || 0;
  const loanBalance = Number(t.mortgage) || 0;
  const piti = Number(t.piti) || 0;
  const rate = t.rate || "—";
  // Address strings look like "123 Main St, Ocala, FL 34479" — pull the
  // city (2nd comma-segment) for a clean "City, State" market line,
  // falling back to the full address if it doesn't parse that way.
  const addrParts = (p.name || "").split(",").map(s => s.trim()).filter(Boolean);
  const city = addrParts.length >= 2 ? addrParts[1] : "";
  const market = city ? [city, p.state].filter(Boolean).join(", ") : [p.name, p.state].filter(Boolean).join(", ");

  return `🏠 ${p.name || ""}
${beds} bd / ${baths} ba • ${sqft} sqft • ${year}

💰 DEAL TERMS:
Entry Fee: $${entryFee.toLocaleString()} + TC + CC
Purchase Price: $${price.toLocaleString()}
Existing Loan Balance: $${loanBalance.toLocaleString()}
PITI: $${piti.toLocaleString()}/mo
Rate: ${rate}%

📍 Market: ${market}
🏷️ Strategy: Sub-To
${deckUrlFor(p) ? `\n🔗 Full deal page: ${deckUrlFor(p)}\n` : ""}
Interested? Reply here or call/text ${ZACH_PHONE}`;
}

// ── Feature 3: Data Consistency Validation ──
// Read-only check: parses numbers out of the marketing copy and flags any
// that contradict the structured deal_terms fields. Never auto-fixes —
// user resolves manually (the copy/terms edit flows).
function parseMoney(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function findCopyMismatches(t, variations) {
  const mismatches = [];
  const seen = new Set();
  const add = (label, copyVal, dealVal, fmt) => {
    const key = `${label}:${copyVal}:${dealVal}`;
    if (seen.has(key)) return;
    seen.add(key);
    mismatches.push(`${label} in copy (${fmt(copyVal)}) doesn't match deal terms (${fmt(dealVal)})`);
  };
  const fmtDollar = n => `$${Number(n).toLocaleString()}`;
  const fmtPlain = n => `${n}`;

  for (const v of (variations || [])) {
    const body = (v && v.body) || "";
    if (!body.trim()) continue;

    // Entry Fee — "entry fee ... $X"
    let m = body.match(/entry\s*fee[^$\n]{0,30}\$\s*([\d,]+(?:\.\d+)?)/i);
    if (m) {
      const copyVal = parseMoney(m[1]);
      const dealVal = Number(t.entry_fee) || 0;
      if (copyVal != null && dealVal > 0 && copyVal !== dealVal) add("Entry Fee", copyVal, dealVal, fmtDollar);
    }

    // Purchase Price — "purchase price" or standalone "price ... $X"
    m = body.match(/(?:purchase\s*price|list\s*price|asking\s*price|price)[^$\n]{0,30}\$\s*([\d,]+(?:\.\d+)?)/i);
    if (m) {
      const copyVal = parseMoney(m[1]);
      const dealVal = Number(t.price) || 0;
      if (copyVal != null && dealVal > 0 && copyVal !== dealVal) add("Price", copyVal, dealVal, fmtDollar);
    }

    // Beds — "X bd" / "X bed(s)" / "X-bedroom"
    m = body.match(/(\d+(?:\.\d+)?)\s*[-]?\s*(?:bd|beds?|bedrooms?)\b/i);
    if (m) {
      const copyVal = parseMoney(m[1]);
      const dealVal = Number(t.beds) || 0;
      if (copyVal != null && dealVal > 0 && copyVal !== dealVal) add("Beds", copyVal, dealVal, fmtPlain);
    }

    // Baths — "X ba" / "X bath(s)"
    m = body.match(/(\d+(?:\.\d+)?)\s*[-]?\s*(?:ba|baths?|bathrooms?)\b/i);
    if (m) {
      const copyVal = parseMoney(m[1]);
      const dealVal = parseMoney(t.baths);
      if (copyVal != null && dealVal != null && dealVal > 0 && copyVal !== dealVal) add("Baths", copyVal, dealVal, fmtPlain);
    }
  }

  return mismatches;
}

// ── "Call today" list: who to call right now, from live engagement ──
// Priority 1: interested / offer-stage leads (last 14 days) — hottest.
// Priority 2: leads who replied (stage 'responded').
// Priority 3: buyers who opened a deck page in the last 72h but didn't tap.
// One entry per person, highest priority + most recent wins.
function timeAgoShort(iso) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
function buildCallList(props, leads, deckViews, buyers, activities) {
  const buyerById = Object.fromEntries((buyers || []).map(b => [b.id, b]));
  const dealOf = Object.fromEntries((props || []).map(p => [p.card_id, (p.address_override || p.name || "").split(",")[0]]));
  const now = Date.now();
  // Latest manual touch per buyer (✓ Done / tapped Call on the dashboard, or a
  // touch logged on the Buyers page). A touch newer than the entry's trigger
  // clears the tile — the list only shows people you haven't acted on yet.
  const touchedAt = {};
  for (const a of (activities || [])) {
    if (a.channel !== "manual" || a.buyer_id == null) continue;
    const k = Number(a.buyer_id), t = new Date(a.created_at).getTime();
    if (!touchedAt[k] || t > touchedAt[k]) touchedAt[k] = t;
  }
  const best = {};
  const add = (key, e) => {
    const cur = best[key];
    if (!cur || e.priority < cur.priority || (e.priority === cur.priority && new Date(e.at) > new Date(cur.at))) best[key] = e;
  };
  for (const l of (leads || [])) {
    const at = l.updated_at || l.created_at;
    if ((now - new Date(at)) / 86400000 > 14) continue;
    const deal = dealOf[l.card_id] || (l.address || "").split(",")[0] || "a deal";
    const b = l.buyer_id ? buyerById[l.buyer_id] : null;
    const contact = l.contact || "";
    const entry = {
      name: b ? b.name : l.name,
      phone: b ? b.phone : (!contact.includes("@") ? contact : ""),
      email: b ? b.email : (contact.includes("@") ? contact : ""),
      at,
      buyerId: l.buyer_id ? Number(l.buyer_id) : null,
      cardId: l.card_id || "",
    };
    const key = l.buyer_id ? `b${l.buyer_id}` : `l${l.id}`;
    if (l.stage === "interested") add(key, { ...entry, priority: 1, reason: `${l.source === "deck_page" ? "🔥 Tapped Interested" : "🔥 Interested"} — ${deal}` });
    else if (l.stage === "offer") add(key, { ...entry, priority: 1, reason: `💰 Offer stage — ${deal}` });
    else if (l.stage === "responded") add(key, { ...entry, priority: 2, reason: `💬 Replied — ${deal}` });
  }
  for (const v of (deckViews || [])) {
    if (!v.buyer_id) continue;
    if ((now - new Date(v.viewed_at)) / 3600000 > 72) continue;
    const b = buyerById[v.buyer_id];
    if (!b) continue;
    add(`b${v.buyer_id}`, { name: b.name, phone: b.phone, email: b.email, at: v.viewed_at, buyerId: Number(v.buyer_id), cardId: v.card_id || "", priority: 3, reason: `👀 Viewed ${dealOf[v.card_id] || "a deck"}` });
  }
  return Object.values(best)
    .filter(e => !(e.buyerId && touchedAt[e.buyerId] && touchedAt[e.buyerId] > new Date(e.at).getTime()))
    .sort((a, b) => a.priority - b.priority || new Date(b.at) - new Date(a.at))
    .slice(0, 8);
}
function renderCallList(callList) {
  if (!callList.length) return "";
  const P_COLOR = { 1: "#DD6B20", 2: "#3182CE", 3: "#718096" };
  return `
  <div class="card" style="margin-bottom:18px;border-left:4px solid #DD6B20">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <b style="color:var(--navy-dark)">📞 Call today</b>
      <span class="muted" style="font-size:0.82rem">${callList.length} buyer${callList.length === 1 ? "" : "s"} showing live interest</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px">
      ${callList.map(c => {
        const tel = (c.phone || "").replace(/[^\d+]/g, "");
        const dataAttrs = c.buyerId ? `data-buyer-id="${c.buyerId}" data-card-id="${escapeHtml(c.cardId || "")}"` : "";
        const contactLink = (href, label, kind, primary) =>
          `<a class="btn ${primary ? "btn-primary" : "btn-ghost"} btn-sm call-contact-link" style="font-size:0.74rem;padding:3px 10px" href="${escapeHtml(href)}" ${dataAttrs} data-kind="${kind}">${label}</a>`;
        return `
        <div style="border:1px solid var(--border);border-left:3px solid ${P_COLOR[c.priority]};border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:baseline;gap:8px"><b style="font-size:0.92rem;color:var(--navy-dark)">${escapeHtml(c.name || "Unknown")}</b><span class="muted" style="font-size:0.72rem;margin-left:auto">${timeAgoShort(c.at)}</span></div>
          <div style="font-size:0.8rem;color:var(--text-2)">${escapeHtml(c.reason)}</div>
          <div style="display:flex;gap:6px;margin-top:2px;align-items:center">
            ${tel ? `${contactLink(`tel:${tel}`, "📞 Call", "Called", true)}${contactLink(`sms:${tel}`, "💬 Text", "Texted", false)}` : ""}
            ${!tel && c.email ? contactLink(`mailto:${c.email}`, "✉️ Email", "Emailed", false) : ""}
            ${!tel && !c.email ? `<span class="muted" style="font-size:0.74rem">No contact info</span>` : ""}
            ${c.buyerId ? `<button type="button" class="btn btn-ghost btn-sm call-done-btn" ${dataAttrs} style="font-size:0.74rem;padding:3px 10px;margin-left:auto" title="Mark handled — logs a touch on this buyer and clears the tile">✓ Done</button>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

// ── Call-today actions: ✓ Done logs a manual touch (buyer_activity) and
// clears the tile immediately; tapping Call/Text/Email logs the touch too but
// leaves the tile up until the next re-render, so a call that doesn't connect
// doesn't lose the contact. Suppression itself happens in buildCallList. ──
async function logBuyerTouch(buyerId, cardId, detail) {
  const row = { buyer_id: buyerId, card_id: cardId || "", channel: "manual", detail };
  const { error } = await supa.from("buyer_activity").insert(row);
  if (!error) (boardData.activities ||= []).unshift({ ...row, created_at: new Date().toISOString() });
  return { error };
}
function wireCallList() {
  document.querySelectorAll(".call-done-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await logBuyerTouch(Number(btn.dataset.buyerId), btn.dataset.cardId, "✓ Handled from dashboard Call today");
      if (error) { toast(`Couldn't log the touch: ${error.message}`, { type: "error" }); btn.disabled = false; return; }
      renderBoard();
    });
  });
  document.querySelectorAll(".call-contact-link").forEach(a => {
    a.addEventListener("click", () => {
      const buyerId = Number(a.dataset.buyerId);
      if (buyerId) logBuyerTouch(buyerId, a.dataset.cardId, `${a.dataset.kind || "Contacted"} from dashboard Call today`);
    });
  });
}

// ── Sync health: latest heartbeat per scheduled function (sync_runs rows
// written by lib/heartbeat.js). Fails soft — before the 025 migration runs
// the query errors and the indicator simply stays hidden. ──
// Trello was retired (July 2026) — deals are created by contract/LOI upload
// now, so only the buyer-form and reply-capture syncs heartbeat here.
const SYNC_FN_LABELS = { "sync-buyers": "Buyer form", "capture-replies": "Reply capture" };
async function loadSyncHealth() {
  const el = document.getElementById("sync-health");
  if (!el) return;
  // Scoped to the scheduled syncs: send-blast-background also heartbeats into
  // sync_runs (for blast-progress polling), and those rows must not make the
  // strip look fresher than the syncs actually are.
  const { data, error } = await supa.from("sync_runs")
    .select("fn,status,ran_at,detail").in("fn", Object.keys(SYNC_FN_LABELS))
    .order("ran_at", { ascending: false }).limit(30);
  if (error || !data || !data.length) { el.textContent = ""; return; }
  const latest = {};
  for (const r of data) if (!latest[r.fn]) latest[r.fn] = r;
  const failing = Object.values(latest).filter(r => r.status === "error");
  const newestMs = Math.max(...Object.values(latest).map(r => new Date(r.ran_at).getTime()));
  const mins = Math.round((Date.now() - newestMs) / 60000);
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  if (failing.length) {
    el.innerHTML = failing.map(r =>
      `<span style="color:var(--red,#C53030);font-weight:700" title="${escapeHtml(r.detail || "")}">⚠ ${escapeHtml(SYNC_FN_LABELS[r.fn] || r.fn)} sync failing</span>`
    ).join(" · ");
  } else if (mins > 30) {
    // All heartbeats old — the functions themselves may have stopped running.
    el.innerHTML = `<span style="color:#B7791F;font-weight:700">⚠ no sync heartbeat in ${ago.replace(" ago", "")}</span>`;
  } else {
    el.innerHTML = `<span style="color:#2F855A" title="Buyer-form / reply-capture syncs healthy">✓ synced ${ago}</span>`;
  }

  // F9 — Resend webhook liveness. resend-events.js has no heartbeat of its own,
  // so a broken webhook is invisible until you notice engagement data stopped.
  // Tell: an email blast went out but no email_events came back after it. We
  // only flag once the blast has had time to generate events (≥1h) so a
  // just-sent blast doesn't false-alarm.
  const warn = await webhookStaleWarning();
  if (warn) el.innerHTML += ` <span style="color:#B7791F">·</span> ${warn}`;
}

// Returns a warning span if the Resend webhook looks dead (a recent email blast
// produced no email_events), else "". Fails soft — any query error yields "".
async function webhookStaleWarning() {
  try {
    const [{ data: blast }, { data: evt }] = await Promise.all([
      supa.from("blast_recipients").select("blasted_at")
        .eq("channel", "email").order("blasted_at", { ascending: false }).limit(1),
      supa.from("email_events").select("created_at")
        .order("created_at", { ascending: false }).limit(1),
    ]);
    const lastBlast = blast && blast[0] && new Date(blast[0].blasted_at).getTime();
    if (!lastBlast) return ""; // never email-blasted — nothing to expect
    const ageH = (Date.now() - lastBlast) / 3600000;
    if (ageH < 1) return ""; // too soon; give Resend time to deliver + report
    const lastEvt = evt && evt[0] && new Date(evt[0].created_at).getTime();
    if (!lastEvt || lastEvt < lastBlast) {
      return `<span style="color:#B7791F;font-weight:700" title="No email opens/clicks/bounces recorded since the last blast — the Resend webhook (resend-events) may be misconfigured.">⚠ Resend webhook may be down</span>`;
    }
    return "";
  } catch (_) {
    return "";
  }
}

async function loadAll() {
  const content = document.getElementById("content");
  loadSyncHealth(); // fire-and-forget; never blocks the board

  // fetchAllRows (F3) pages past PostgREST's silent 1,000-row cap; the
  // secondary .order("card_id") keeps pages deterministic.
  let { data: props, error: pErr } = await fetchAllRows(() =>
    supa.from("properties").select("*").eq("archived", false).order("synced_at", { ascending: false }).order("card_id"));
  if (pErr) {
    // `archived` column doesn't exist yet (017 migration not run) — fall
    // back to unfiltered so the dashboard still loads; archiving just
    // won't take visual effect until the migration runs.
    ({ data: props, error: pErr } = await fetchAllRows(() =>
      supa.from("properties").select("*").order("synced_at", { ascending: false }).order("card_id")));
  }

  // Scope every card-keyed query to just the deals we're about to render.
  // deal_blasts / blast_recipients / deal_leads grow forever (one row per
  // blast × buyer), so pulling whole tables gets slow at scale — we only
  // ever need rows for the active cards on screen.
  const cardIds = (props || []).map(p => p.card_id);
  const [{ data: terms }, { data: statuses }, { data: fbPosts }, { data: buyers }, { data: leads }, { data: blasts }, { data: acq }, { data: morby }, { data: recips }, { data: deckViews }, { data: emailEvents }, { data: tasks }, { data: activities }] = await Promise.all([
    supa.from("deal_terms").select("*").in("card_id", cardIds),
    supa.from("property_status").select("*").in("card_id", cardIds),
    supa.from("facebook_posts").select("*").in("card_id", cardIds),
    // Paged (F3): this is the blast-preview audience — must be complete, or
    // the preview understates who a live send reaches past 1,000 buyers.
    fetchAllRows(() => supa.from("buyers").select("id,name,email,phone,tier,states,strategy,sms_opt_in,max_price,max_piti,min_beds,email_opt_out").eq("active", true).order("id")),
    supa.from("deal_leads").select("*").in("card_id", cardIds).order("updated_at", { ascending: false }),
    supa.from("deal_blasts").select("card_id,channel,status,detail,variation_index,variation_title,blasted_at").in("card_id", cardIds),
    supa.from("deal_acquisition").select("*").in("card_id", cardIds),
    supa.from("morby_deals").select("*").in("card_id", cardIds),
    // Paged (F3): one blast writes a recipient row per buyer, and deck views /
    // email opens multiply per blast — all three blow past 1,000 rows first.
    fetchAllRows(() => supa.from("blast_recipients").select("card_id,channel,status,buyer_id").in("card_id", cardIds).order("id")),
    fetchAllRows(() => supa.from("deck_views").select("card_id,buyer_id,viewed_at").in("card_id", cardIds).order("id")),
    fetchAllRows(() => supa.from("email_events").select("card_id,buyer_id,event").in("card_id", cardIds).order("id")),
    // Pipeline-page data the dashboard folds in (fails soft pre-027): next
    // actions drive the "task overdue" attention signal + the card's Next line.
    supa.from("deal_tasks").select("*").in("card_id", cardIds).order("due_date", { ascending: true }),
    // Recent manual touches — clears "Call today" tiles you've already acted on.
    supa.from("buyer_activity").select("buyer_id,card_id,channel,created_at")
      .gte("created_at", new Date(Date.now() - 14 * 86400000).toISOString())
      .order("created_at", { ascending: false }),
    // Stage labels/colors for the dispo-stage chips (dispo.js falls back to
    // the default six if the table is missing).
    loadDispoStages(),
  ]);

  if (pErr) {
    content.innerHTML = `<div class="empty">Couldn't load properties: ${escapeHtml(pErr.message)}</div>`;
    return;
  }

  const termsByCard = Object.fromEntries((terms || []).map(t => [t.card_id, t]));
  const statusByCard = Object.fromEntries((statuses || []).map(s => [s.card_id, s]));
  const fbByCard = {};
  for (const p of (fbPosts || [])) (fbByCard[p.card_id] ||= []).push(p);
  const leadsByCard = {};
  for (const l of (leads || [])) (leadsByCard[l.card_id] ||= []).push(l);
  const blastsByCard = {};
  for (const b of (blasts || [])) (blastsByCard[b.card_id] ||= []).push(b);
  const recipsByCard = {};
  for (const r of (recips || [])) (recipsByCard[r.card_id] ||= []).push(r);
  const viewsByCard = {};
  for (const v of (deckViews || [])) (viewsByCard[v.card_id] ||= []).push(v);
  const eventsByCard = {}; // email opens/clicks; empty until 026 migration runs
  for (const e of (emailEvents || [])) (eventsByCard[e.card_id] ||= []).push(e);
  const acqByCard = Object.fromEntries((acq || []).map(a => [a.card_id, a]));
  const morbyByCard = Object.fromEntries((morby || []).map(m => [m.card_id, m]));
  const tasksByCard = {}; // empty until 027 migration runs
  for (const t of (tasks || [])) (tasksByCard[t.card_id] ||= []).push(t);

  allBuyers = buyers || [];

  // Stash everything the renderer needs so the triage bar (search / filter /
  // sort / expand) can re-render instantly without refetching Supabase.
  boardData = {
    props: props || [], buyers: buyers || [], leads: leads || [], deckViews: deckViews || [],
    activities: activities || [],
    termsByCard, statusByCard, fbByCard, leadsByCard, blastsByCard, recipsByCard,
    viewsByCard, eventsByCard, acqByCard, morbyByCard, tasksByCard,
  };
  renderBoard();
}

// ── Board renderer — everything below the page header. Split out of loadAll
// so triage-bar interactions re-render from boardData without a refetch. ──
function renderBoard() {
  if (!boardData) return;
  const content = document.getElementById("content");
  const { props, buyers, leads, deckViews, activities, termsByCard, statusByCard, fbByCard, leadsByCard,
          blastsByCard, recipsByCard, viewsByCard, eventsByCard, acqByCard, morbyByCard, tasksByCard } = boardData;

  document.getElementById("prop-count").textContent =
    `${props.length} active under-contract propert${props.length === 1 ? "y" : "ies"}`;

  // Attention score per deal — drives the default sort and the ⚠ filter.
  const attByCard = {};
  for (const p of props) {
    attByCard[p.card_id] = dealAttention(
      p, termsByCard[p.card_id] || {}, leadsByCard[p.card_id] || [],
      blastsByCard[p.card_id] || [], recipsByCard[p.card_id] || [],
      viewsByCard[p.card_id] || [], eventsByCard[p.card_id] || [],
      (tasksByCard && tasksByCard[p.card_id]) || []);
  }

  const q = dealView.query.trim().toLowerCase();
  const matchesView = (p) => {
    if (q && !`${p.name || ""} ${p.state || ""}`.toLowerCase().includes(q)) return false;
    const a = attByCard[p.card_id];
    if (dealView.filter === "attention") return a.score >= 20;
    if (dealView.filter === "never") return a.neverBlasted;
    if (dealView.filter === "hot") return a.hot > 0;
    return true;
  };
  const SORTERS = {
    attention: (x, y) => attByCard[y.card_id].score - attByCard[x.card_id].score
      || new Date(y.synced_at || 0) - new Date(x.synced_at || 0),
    newest: (x, y) => new Date(y.synced_at || 0) - new Date(x.synced_at || 0),
    az: (x, y) => String(x.name || "").localeCompare(String(y.name || "")),
  };
  const applyView = (list) => list.filter(matchesView).sort(SORTERS[dealView.sort] || SORTERS.attention);

  const renderArgs = (p) => renderCard(p, termsByCard, statusByCard, fbByCard, buyers || [], leadsByCard, blastsByCard, acqByCard, morbyByCard, recipsByCard, viewsByCard, eventsByCard, attByCard[p.card_id]);
  const allSubto = props.filter(p => (p.deal_type || "subto") !== "morby");
  const allMorby = props.filter(p => p.deal_type === "morby");
  const subtoProps = applyView(allSubto);
  const morbyProps = applyView(allMorby);
  const filtered = !!q || dealView.filter !== "all";
  const attentionCount = props.filter(p => attByCard[p.card_id].score >= 20).length;

  // Rebuilding innerHTML drops focus — remember if the user was mid-search
  // so we can put the caret back after the re-render.
  const searchWasFocused = document.activeElement && document.activeElement.id === "deal-search";

  const chip = (key, label, title) =>
    `<button type="button" class="btn btn-sm deal-filter-chip ${dealView.filter === key ? "btn-primary" : "btn-ghost"}" data-filter="${key}" title="${escapeHtml(title)}">${label}</button>`;
  const groupCount = (shown, total) =>
    filtered && shown.length !== total.length ? `(${shown.length} of ${total.length})` : `(${total.length})`;
  const noMatch = `<div class="empty">No deals match the current search/filter — <a href="#" class="deal-clear-filters">clear filters</a>.</div>`;
  const stack = (cards) => `<div style="display:flex;flex-direction:column;gap:12px">${cards.map(renderArgs).join("")}</div>`;

  content.innerHTML = `
    ${renderCallList(buildCallList(props, leads, deckViews, buyers, activities))}
    <div class="card" id="deal-triage" style="padding:10px 14px;margin-bottom:14px;display:flex;gap:8px;row-gap:8px;flex-wrap:wrap;align-items:center">
      <input type="search" id="deal-search" placeholder="Search address or state…" value="${escapeHtml(dealView.query)}" style="flex:1 1 200px;max-width:320px;padding:6px 10px;border:1px solid var(--border,#CBD5E0);border-radius:8px;font-size:0.85rem">
      ${chip("all", "All", "Show every deal")}
      ${chip("attention", `⚠ Attention${attentionCount ? ` (${attentionCount})` : ""}`, "Deals with a blocked send, hot leads, no blast yet, an overdue task, or a follow-up due")}
      ${chip("never", "📣 Never blasted", "Deals that haven't had a successful blast yet")}
      ${chip("hot", "🔥 Hot leads", "Deals with interested / offer / under-contract leads")}
      <select id="deal-sort" class="btn btn-ghost btn-sm" title="Sort order" style="padding:4px 8px">
        <option value="attention" ${dealView.sort === "attention" ? "selected" : ""}>Needs attention first</option>
        <option value="newest" ${dealView.sort === "newest" ? "selected" : ""}>Newest first</option>
        <option value="az" ${dealView.sort === "az" ? "selected" : ""}>Address A–Z</option>
      </select>
      <button type="button" class="btn btn-ghost btn-sm" id="deal-expand-toggle">${expandedDealCards.size ? "▴ Collapse all" : "▾ Expand all"}</button>
    </div>
    <div class="deal-type-group">
      <div class="deal-type-group-header flex-between">
        <span>🏠 Sub-To Deals <span class="muted">${groupCount(subtoProps, allSubto)}</span></span>
        <button type="button" class="btn btn-primary btn-sm" id="add-subto-btn">+ Add Sub-To Deal</button>
      </div>
      <div id="add-subto-panel" class="card hidden" style="margin-bottom:16px">
        <h3 style="margin-top:0">New Sub-To Deal — Upload Contract</h3>
        <p class="muted" style="font-size:0.85rem">Upload the purchase contract and the seller's mortgage statement — PDF or image (JPG/PNG). Claude extracts the deal terms, creates the card, and writes 3 marketing copy variations, all ready to review and blast. No Trello needed.</p>
        <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
          <label style="font-size:0.8rem">Contract (required)<br><input type="file" id="add-subto-contract" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:260px"></label>
          <label style="font-size:0.8rem">Mortgage statement (required)<br><input type="file" id="add-subto-statement" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:260px"></label>
        </div>
        <div class="flex gap-8 mt-8" style="flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-primary btn-sm" id="add-subto-submit">📤 Extract &amp; Create</button>
          <button type="button" class="btn btn-ghost btn-sm" id="add-subto-cancel">Cancel</button>
          <span id="add-subto-status" class="muted" style="font-size:0.82rem"></span>
        </div>
      </div>
      ${subtoProps.length ? stack(subtoProps) : (allSubto.length ? noMatch : `<div class="empty">No Sub-To deals yet — click "+ Add Sub-To Deal" and upload the contract to create one.</div>`)}
    </div>
    <div class="deal-type-group">
      <div class="deal-type-group-header flex-between">
        <span>🤝 Morby Deals <span class="muted">${groupCount(morbyProps, allMorby)}</span></span>
        <button type="button" class="btn btn-primary btn-sm" id="add-morby-btn">+ Add Morby Deal</button>
      </div>
      <div id="add-morby-panel" class="card hidden" style="margin-bottom:16px">
        <h3 style="margin-top:0">New Morby Deal — Upload LOI</h3>
        <p class="muted" style="font-size:0.85rem">Upload the signed LOI (PDF) — Claude will read it and create a new Morby deal card pre-filled with the deal terms, ready for review and Deal Deck generation.</p>
        <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
          <input type="file" id="add-morby-file" accept="application/pdf" style="max-width:280px">
          <button type="button" class="btn btn-primary btn-sm" id="add-morby-submit">📤 Extract &amp; Create</button>
          <button type="button" class="btn btn-ghost btn-sm" id="add-morby-cancel">Cancel</button>
          <span id="add-morby-status" class="muted" style="font-size:0.82rem"></span>
        </div>
      </div>
      ${morbyProps.length ? stack(morbyProps) : (allMorby.length ? noMatch : `<div class="empty">No Morby deals yet — click "+ Add Morby Deal" and upload an LOI to create one.</div>`)}
    </div>`;
  wireCardEvents();
  wireAddMorbyPanel();
  wireAddSubtoPanel();
  wireTriageBar();
  wireCallList();

  if (searchWasFocused) {
    const el = document.getElementById("deal-search");
    if (el) {
      el.focus();
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch (_) { /* not all input types support it */ }
    }
  }
}

// ── Triage bar wiring. Search is debounced so each keystroke doesn't rebuild
// the DOM mid-word; everything re-renders from boardData (no refetch). ──
function wireTriageBar() {
  const search = document.getElementById("deal-search");
  if (search) search.addEventListener("input", () => {
    clearTimeout(dealSearchTimer);
    dealSearchTimer = setTimeout(() => { dealView.query = search.value; renderBoard(); }, 160);
  });
  document.querySelectorAll(".deal-filter-chip").forEach(b =>
    b.addEventListener("click", () => { dealView.filter = b.dataset.filter; renderBoard(); }));
  const sort = document.getElementById("deal-sort");
  if (sort) sort.addEventListener("change", () => { dealView.sort = sort.value; renderBoard(); });
  const tog = document.getElementById("deal-expand-toggle");
  if (tog) tog.addEventListener("click", () => {
    if (expandedDealCards.size) expandedDealCards.clear();
    else for (const p of boardData.props) expandedDealCards.add(p.card_id);
    renderBoard();
  });
  document.querySelectorAll(".deal-clear-filters").forEach(a =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      dealView.query = "";
      dealView.filter = "all";
      renderBoard();
    }));
}

// Buyer↔deal matching is matchesDeal from /js/deal-shared.js — the exact
// function send-blast.js runs, so the preview list IS the send list.

// Scores a buyer's fit for a deal (0-100ish) with human-readable reasons,
// plus a list of missing contact fields that would block reaching them.
function scoreBuyerForDeal(b, state, price, piti, beds) {
  let score = 0;
  const reasons = [];
  const missing = [];

  const states = (b.states || "").trim();
  if (states) {
    if (state && states.split(",").map(s => s.trim().toUpperCase()).includes(state.toUpperCase())) {
      score += 30; reasons.push(`Buys in ${state}`);
    }
  } else {
    score += 12; reasons.push("Open to all markets");
  }

  if (b.max_price > 0) {
    if (price > 0 && price <= b.max_price) { score += 20; reasons.push(`Within price cap ($${Number(b.max_price).toLocaleString()})`); }
  } else { score += 8; }

  if (b.max_piti > 0) {
    if (piti > 0 && piti <= b.max_piti) { score += 15; reasons.push(`Within PITI cap ($${Number(b.max_piti).toLocaleString()}/mo)`); }
  } else { score += 5; }

  if (b.min_beds > 0) {
    if (beds > 0 && beds >= b.min_beds) { score += 10; reasons.push(`Meets ${b.min_beds}+ bed requirement`); }
  } else { score += 4; }

  if (b.tier === "A") { score += 20; reasons.push("Tier A — hot buyer"); }
  else if (b.tier === "B") { score += 10; reasons.push("Tier B — warm buyer"); }

  if (!b.email) missing.push("email");
  if (!b.phone) missing.push("phone");
  if (b.sms_opt_in && b.phone) { score += 5; reasons.push("Opted into SMS"); }

  return { score, reasons, missing };
}

function matchedBuyersForDeal(p, t, buyers) {
  const state = p.state, price = Number(t.price) || 0, piti = Number(t.piti) || 0, beds = Number(t.beds) || 0;
  const dealStrategy = p.deal_type === "morby" ? "morby" : "subto";
  return buyers
    .filter(b => matchesDeal(b, dealStrategy, state, price, piti, beds))
    .map(b => {
      const { score, reasons, missing } = scoreBuyerForDeal(b, state, price, piti, beds);
      return { ...b, _score: score, _reasons: reasons, _missing: missing };
    })
    .sort((a, b) => b._score - a._score);
}

// Buyer "method" = their strategy field. Used to group the blast modal's
// "Choose specific buyers" list so you can pick any method to send to.
const METHOD_LABELS = { subto: "Sub-To", morby: "Stack Method", owner_finance: "Seller Finance", cash: "Cash", all: "Open to all" };
const METHOD_ORDER = ["subto", "morby", "owner_finance", "cash", "all"];

const STAGES = [
  { key: "new",            label: "New",             color: "#A0AEC0" },
  { key: "responded",      label: "Responded",       color: "#3182CE" },
  { key: "interested",     label: "Interested",      color: "#6B46C1" },
  { key: "offer",          label: "Offer made",      color: "#D69E2E" },
  { key: "under_contract", label: "Under contract",  color: "#DD6B20" },
  { key: "closed",         label: "Closed 🎉",       color: "#2F855A" },
  { key: "dead",           label: "Dead / passed",   color: "#C53030" },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s, i) => [s.key, { ...s, rank: i }]));
const SOURCE_LABELS = {
  buyer_blast: "Buyer list", investorlift: "InvestorLift", creativelisting: "CreativeListing",
  fb_group: "FB group", referral: "Referral", other: "Other", deck_page: "Deck page",
};

// ── Follow-up nudge: who got the blast 48h+ ago and never engaged ──
// "Engaged" = opened/clicked the email, viewed the deck page, or already
// sits in the pipeline. One follow-up per deal (marked by [follow-up] in
// deal_blasts.detail); a human always pulls the trigger.
const FOLLOWUP_HOURS = 48;
function followUpInfo(blasts, recips, views, leads, events) {
  const emailBlasts = (blasts || []).filter(b => b.channel === "email" && b.status === "sent");
  if (!emailBlasts.length) return null;
  if (emailBlasts.some(b => (b.detail || "").includes("[follow-up]"))) return null;
  const lastAt = Math.max(...emailBlasts.map(b => new Date(b.blasted_at).getTime()));
  const hours = (Date.now() - lastAt) / 3600e3;
  if (hours < FOLLOWUP_HOURS) return null;
  const sentTo = new Set((recips || []).filter(r => r.channel === "email" && r.status === "sent" && r.buyer_id != null).map(r => Number(r.buyer_id)));
  if (!sentTo.size) return null;
  const engaged = new Set();
  for (const e of (events || [])) if (e.buyer_id != null && (e.event === "opened" || e.event === "clicked")) engaged.add(Number(e.buyer_id));
  for (const v of (views || [])) if (v.buyer_id != null) engaged.add(Number(v.buyer_id));
  for (const l of (leads || [])) if (l.buyer_id != null) engaged.add(Number(l.buyer_id));
  const cold = [...sentTo].filter(id => !engaged.has(id));
  if (!cold.length) return null;
  return { ids: cold, total: sentTo.size, days: Math.max(2, Math.floor(hours / 24)) };
}

// ── Deal Info (acquisition data) — completeness + auto-flags ──
const ACQ_CORE_FIELDS = [
  "hoa", "roof_age", "hvac_age", "water_heater_age", "condition",
  "lender_name", "loan_type", "loan_current",
  "video_url", "photos_count", "seller_motivation", "occupied",
];
function acqCompleteness(acq) {
  const a = acq || {};
  let n = 0;
  for (const f of ACQ_CORE_FIELDS) {
    const v = a[f];
    if (v !== null && v !== undefined && v !== "") n++;
  }
  return { filled: n, total: ACQ_CORE_FIELDS.length };
}
function acqFlags(acq) {
  const a = acq || {};
  const flags = [];
  if (a.hoa_rental_restriction === true) flags.push({ icon: "🚫", label: "No Rentals", cls: "red" });
  if (a.hoa_age_restricted === true) flags.push({ icon: "", label: "55+ Only", cls: "orange" });
  if (a.hvac_age != null && Number(a.hvac_age) > 15) flags.push({ icon: "⚠️", label: "Old HVAC", cls: "yellow" });
  if (a.roof_age != null && Number(a.roof_age) > 20) flags.push({ icon: "⚠️", label: "Old Roof", cls: "yellow" });
  if (a.loan_current === false) flags.push({ icon: "⚠️", label: "Behind on Payments", cls: "red" });
  if (!a.mortgage_statement_url) flags.push({ icon: "📄", label: "Missing Statement", cls: "red" });
  if (a.photos_count == null || Number(a.photos_count) < 10) flags.push({ icon: "📷", label: "Need More Photos", cls: "red" });
  if (!a.video_url) flags.push({ icon: "🎥", label: "No Video", cls: "red" });
  return flags;
}
// Hard gates that block a live Send Blast — returns list of blocking reasons.

// ── Deal attention score — powers the triage bar's default sort, the ⚠
// filter, and the badges on compact rows. Dashboard-only presentation logic
// (business math stays in deal-shared.js); every signal is derived from data
// loadAll already fetches, and each reason maps to an action Zach can take. ──
const ATTENTION_BADGE_COLORS = { red: "#C53030", orange: "#DD6B20", yellow: "#B7791F", blue: "#2B6CB0", gray: "#718096" };

// Pipeline-page task helpers (deal_tasks rows ride along in boardData).
function isOverdueTask(t) {
  return !t.done && t.due_date && new Date(t.due_date + "T23:59:59") < new Date();
}
function nextOpenTaskFor(cardId) {
  return ((boardData && boardData.tasksByCard && boardData.tasksByCard[cardId]) || []).find(t => !t.done) || null;
}

// Dispo-stage chip: the deal's position on the Pipeline board, linked to it.
// Labels/colors come from /js/dispo.js (DB-backed, falls back to defaults).
function dispoStageChip(p) {
  const key = p.dispo_stage || (DISPO_STAGES[0] && DISPO_STAGES[0].key) || "prep";
  // Deleted/renamed stage keys display as the first stage, same as the board.
  const s = DISPO_BY_KEY[key] || DISPO_BY_KEY[(DISPO_STAGES[0] || {}).key] || { label: key, color: "#A0AEC0" };
  return `<a href="/pipeline.html#deal=${encodeURIComponent(p.card_id)}" class="pill" title="Dispo stage — click to open this deal on the Pipeline board" style="background:${s.color}22;color:${s.color};font-weight:700;text-decoration:none;white-space:nowrap">${escapeHtml(s.label)}</a>`;
}

function dealAttention(p, t, leads, blasts, recips, views, events, tasks) {
  let score = 0;
  const badges = [];

  // Highest urgency: numbers in the copy contradict deal_terms — the live
  // Send Blast button is disabled until this is fixed.
  if (findCopyMismatches(t, p.variations || []).length) {
    score += 50;
    badges.push({ icon: "⛔", label: "Send blocked", cls: "red", title: "Marketing copy contradicts the deal terms — live sends are blocked until it's fixed" });
  }

  // Hot pipeline: buyers at interested or beyond need a call, not a blast.
  const hot = (leads || []).filter(l => ["interested", "offer", "under_contract"].includes(l.stage)).length;
  if (hot) {
    score += 30 + Math.min(hot - 1, 4) * 5;
    badges.push({ icon: "🔥", label: `${hot} hot lead${hot === 1 ? "" : "s"}`, cls: "orange", title: "Leads at interested / offer / under-contract — call them" });
  }

  // Never marketed: a deal sitting unblasted is pure carrying cost.
  const sentBlasts = (blasts || []).filter(b => b.status === "sent");
  const neverBlasted = !sentBlasts.length;
  if (neverBlasted) {
    score += 25;
    badges.push({ icon: "📣", label: "Never blasted", cls: "blue", title: "No successful blast yet — buyers haven't seen this deal" });
  }

  // Overdue next-action: a scheduled task (Pipeline board) past its due date —
  // attention that was explicitly planned and is now late.
  const late = (tasks || []).filter(isOverdueTask);
  if (late.length) {
    score += 22;
    badges.push({ icon: "⏳", label: "Task overdue", cls: "red",
      title: `${late.length === 1 ? `"${late[0].title}"` : `${late.length} tasks`} past due — open this deal on the Pipeline board` });
  }

  // Follow-up window open: recipients went cold 48h+ after the last send.
  const fu = followUpInfo(blasts, recips, views, leads, events);
  if (fu) {
    score += 20;
    badges.push({ icon: "⏰", label: `Follow-up due`, cls: "yellow", title: `${fu.ids.length} of ${fu.total} recipients haven't engaged after ${fu.days} day${fu.days === 1 ? "" : "s"}` });
  }

  // Gone quiet: nothing has happened in 30+ days on a deal that old — a
  // nudge toward re-marketing or archiving (🗑) so the board stays honest.
  const DAY = 86400000;
  const lastActivity = Math.max(0,
    ...sentBlasts.map(b => new Date(b.blasted_at).getTime()),
    ...(views || []).map(v => new Date(v.viewed_at).getTime()),
    ...(leads || []).map(l => new Date(l.updated_at || l.created_at).getTime()));
  const born = new Date(p.synced_at || 0).getTime();
  if (born && Date.now() - born > 30 * DAY && (!lastActivity || Date.now() - lastActivity > 30 * DAY)) {
    score += 8;
    badges.push({ icon: "🕸", label: "Quiet 30d+", cls: "gray", title: "No blast, deck view, or lead activity in over 30 days — re-market or archive" });
  }

  return { score, badges, hot, neverBlasted };
}

function attentionBadges(att) {
  return ((att && att.badges) || []).map(b =>
    `<span style="font-size:0.7rem;font-weight:700;color:#fff;background:${ATTENTION_BADGE_COLORS[b.cls] || ATTENTION_BADGE_COLORS.gray};padding:2px 8px;border-radius:999px;white-space:nowrap" title="${escapeHtml(b.title || b.label)}">${b.icon} ${escapeHtml(b.label)}</span>`
  ).join(" ");
}

// Compact one-line row — the collapsed default every card renders as until
// expanded. Address + the numbers that matter + why it needs attention.
function renderCompactCard(p, t, morby, matchCount, leads, blasts, views, att, dealType) {
  const sent = (blasts || []).filter(b => b.status === "sent").length;
  const bits = [];
  if (dealType === "morby") {
    if (morby && morby.purchase_price) bits.push(fmtMoney(morby.purchase_price));
  } else {
    if (t.price) bits.push(fmtMoney(t.price));
    if (t.entry_fee) bits.push(`${fmtMoney(t.entry_fee)} entry`);
    bits.push(`👥 ${matchCount}`);
  }
  bits.push(`📣 ${sent}`);
  if ((views || []).length) bits.push(`👁 ${views.length}`);
  const openLeads = (leads || []).filter(l => !["dead", "closed"].includes(l.stage)).length;
  if (openLeads) bits.push(`🧲 ${openLeads}`);
  return `
    <div class="card prop-card compact-deal" data-card-id="${escapeHtml(p.card_id)}" role="button" tabindex="0" title="Click to expand this deal" style="cursor:pointer;padding:10px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted">▸</span>
      <span style="font-weight:700;flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</span>
      ${p.state ? `<span class="pill pill-state">${escapeHtml(p.state)}</span>` : ""}
      ${dispoStageChip(p)}
      <span class="muted" style="font-size:0.78rem;white-space:nowrap">${bits.map(escapeHtml).join(" · ")}</span>
      ${attentionBadges(att)}
    </div>`;
}

function renderCard(p, termsByCard, statusByCard, fbByCard, buyers, leadsByCard, blastsByCard, acqByCard, morbyByCard, recipsByCard, viewsByCard, eventsByCard, attention) {
  const t = termsByCard[p.card_id] || {};
  const status = (statusByCard[p.card_id] || {}).status || "active";
  const posts = fbByCard[p.card_id] || [];
  const matched = matchedBuyersForDeal(p, t, buyers);
  const matchCount = matched.length;
  const leads = leadsByCard[p.card_id] || [];
  const blasts = blastsByCard[p.card_id] || [];
  const recips = (recipsByCard && recipsByCard[p.card_id]) || [];
  const acq = acqByCard[p.card_id] || {};
  const morby = (morbyByCard && morbyByCard[p.card_id]) || {};
  const dealType = p.deal_type || "subto";
  dealCache[p.card_id] = { prop: p, terms: t, matched, leads, acq, morby };

  // ── Triage: collapsed (compact) mode is the default. One row per deal;
  // click to expand into the full working card. ──
  if (!expandedDealCards.has(p.card_id)) {
    return renderCompactCard(p, t, morby, matchCount, leads, blasts,
      (viewsByCard && viewsByCard[p.card_id]) || [], attention, dealType);
  }

  // ── Morby deals are a separate, stripped-down workflow: created
  // directly from an LOI upload, no marketing/posting/pipeline tools. ──
  if (dealType === "morby") {
    return `
    <div class="card prop-card morby-card" data-card-id="${escapeHtml(p.card_id)}">
      <div class="flex-between">
        <div>
          <p class="prop-title">${escapeHtml(p.name)}</p>
          <div class="prop-meta">
            ${p.state ? `<span class="pill pill-state">${escapeHtml(p.state)}</span>` : ""}
            ${dispoStageChip(p)}
            ${p.deck_slug ? `<a href="${escapeHtml(deckUrlFor(p))}" target="_blank" rel="noopener">Deck page ↗</a>` : ""}
            <button type="button" class="btn btn-ghost btn-sm deck-copy-btn" data-card-id="${escapeHtml(p.card_id)}" style="font-size:0.72rem;padding:1px 8px" title="Copy the public deck-page link for DMs / FB groups">🔗 Copy link</button>
          </div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-primary btn-sm morby-send-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Generate Deal Deck PDF and email it to all Stack Method buyers">📣 Send Deal Deck</button>
          <button class="btn btn-ghost btn-sm morby-delete-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Remove this Morby deal">🗑 Remove</button>
          <button class="btn btn-ghost btn-sm collapse-deal-btn" data-card-id="${escapeHtml(p.card_id)}" title="Collapse to one line">▴</button>
        </div>
      </div>
      ${renderMorbyPanel(p, morby, t, acq)}
    </div>`;
  }

  const variations = p.variations || [];
  const acqDone = acqCompleteness(acq);
  const acqBadgeComplete = acqDone.filled >= 10;
  const flags = acqFlags(acq);

  // ── Pipeline: sorted by stage progression (closest-to-closing first) ──
  // Deck engagement (§7): views for this deal + a buyer_id -> view-count map.
  const views = (viewsByCard && viewsByCard[p.card_id]) || [];
  const totalViews = views.length;
  const viewsByBuyer = new Map();
  for (const v of views) if (v.buyer_id != null) viewsByBuyer.set(Number(v.buyer_id), (viewsByBuyer.get(Number(v.buyer_id)) || 0) + 1);
  const interestedCount = leads.filter(l => ["interested", "offer", "under_contract"].includes(l.stage)).length;
  // Surface deck-page "interested" leads (the call-now list) to the top, then by stage rank.
  const isCallNow = (l) => l.source === "deck_page" && l.stage === "interested";
  const sortedLeads = [...leads].sort((a, b) =>
    (Number(isCallNow(b)) - Number(isCallNow(a))) ||
    ((STAGE_BY_KEY[b.stage]?.rank ?? 0) - (STAGE_BY_KEY[a.stage]?.rank ?? 0)));
  const stageCounts = {};
  for (const l of leads) stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1;

  // ── Analytics: which copy variation has been sent, and the deal's funnel ──
  const emailBlasts = blasts.filter(b => b.channel === "email" && b.status === "sent");
  const variationStats = {};
  for (const b of emailBlasts) {
    const key = b.variation_title || (b.variation_index != null ? `Variation ${b.variation_index + 1}` : "(no variation tracked)");
    variationStats[key] = (variationStats[key] || 0) + 1;
  }
  const respondedPlus = leads.filter(l => (STAGE_BY_KEY[l.stage]?.rank ?? 0) >= STAGE_BY_KEY.responded.rank).length;

  // R3: per-recipient delivery — distinct buyers delivered vs. failed (and
  // not since delivered) per channel, so we can offer a "retry failed".
  const delivered = { email: new Set(), sms: new Set() };
  for (const r of recips) if (r.status === "sent" && delivered[r.channel]) delivered[r.channel].add(r.buyer_id);
  const failedOnly = { email: new Set(), sms: new Set() };
  for (const r of recips) if (r.status === "failed" && failedOnly[r.channel] && !delivered[r.channel].has(r.buyer_id)) failedOnly[r.channel].add(r.buyer_id);
  const emailDelivered = delivered.email.size, emailFailed = failedOnly.email.size;
  const smsDelivered = delivered.sms.size, smsFailed = failedOnly.sms.size;
  const totalFailed = emailFailed + smsFailed;

  // ── Feature 3: Data Consistency Validation (read-only; blocks live Send Blast) ──
  const mismatches = findCopyMismatches(t, variations);
  const blockSend = mismatches.length > 0;
  const blockTitle = blockSend ? "Resolve the copy mismatch below before sending a live blast" : "";

  return `
    <div class="card prop-card" data-card-id="${escapeHtml(p.card_id)}">
      <div class="flex-between">
        <div>
          <p class="prop-title">${escapeHtml(p.name)}</p>
          <div class="prop-meta">
            ${p.state ? `<span class="pill pill-state">${escapeHtml(p.state)}</span>` : ""}
            ${dispoStageChip(p)}
            ${p.trello_url ? `<a href="${escapeHtml(p.trello_url)}" target="_blank" rel="noopener">Trello ↗</a>` : ""}
            ${p.drive_link ? `${p.trello_url ? " · " : ""}<a href="${escapeHtml(p.drive_link)}" target="_blank" rel="noopener">Photos (Drive) ↗</a>` : ""}
            ${p.deck_slug ? `${(p.trello_url || p.drive_link) ? " · " : ""}<a href="${escapeHtml(deckUrlFor(p))}" target="_blank" rel="noopener" title="The buyer-facing deal page">Deck page ↗</a>` : ""}
            <button type="button" class="btn btn-ghost btn-sm deck-copy-btn" data-card-id="${escapeHtml(p.card_id)}" style="font-size:0.72rem;padding:1px 8px" title="Copy the public deck-page link for DMs / FB groups">🔗 Copy link</button>
            ${respondedPlus ? ` <span class="pill responded-pill" data-card-id="${escapeHtml(p.card_id)}" style="background:#ff5a1f22;color:#ff5a1f;font-weight:700;cursor:pointer" title="Buyers who replied to a blast on this deal — click to view">🔥 ${respondedPlus} responded</span>` : ""}
          </div>
          ${(() => {
            const nt = nextOpenTaskFor(p.card_id);
            if (!nt) return "";
            const late = isOverdueTask(nt);
            return `<div class="prop-meta" style="${late ? "color:#C53030;font-weight:600" : ""}">⏳ Next: ${escapeHtml(nt.title)}${nt.due_date ? ` · ${late ? "overdue since" : "due"} ${escapeHtml(nt.due_date)}` : ""} <a href="/pipeline.html#deal=${encodeURIComponent(p.card_id)}" style="font-size:0.78rem">manage ↗</a></div>`;
          })()}
          ${flags.length ? `<div class="health-badges" style="justify-content:flex-start">${flags.map(f => `<span class="health-badge ${f.cls}" title="${escapeHtml(f.label)}">${f.icon} ${escapeHtml(f.label)}</span>`).join("")}</div>` : ""}
        </div>
        <div class="flex gap-8" style="flex-direction:column;align-items:flex-end">
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-sm copy-deal-btn" data-card-id="${escapeHtml(p.card_id)}" title="Copy a pre-formatted deal summary to your clipboard">📋 Copy Deal Info</button>
            <button class="btn btn-ghost btn-sm test-blast-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Send a preview to yourself only — does not reach buyers">🧪 Test Blast</button>
            <button class="btn btn-primary btn-sm send-blast-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" ${blockSend ? `disabled title="${escapeHtml(blockTitle)}"` : ""} style="${blockSend ? "opacity:.5;cursor:not-allowed" : ""}">📣 Send Blast</button>
            <button class="btn btn-ghost btn-sm morby-delete-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Remove this deal (archives it — undo available)">🗑</button>
            <button class="btn btn-ghost btn-sm collapse-deal-btn" data-card-id="${escapeHtml(p.card_id)}" title="Collapse to one line">▴</button>
          </div>
          <span class="blast-status muted" style="font-size:0.74rem;text-align:right;max-width:220px"></span>
        </div>
      </div>

      ${(() => {
        const fu = followUpInfo(blasts, recips, views, leads, (eventsByCard && eventsByCard[p.card_id]) || []);
        if (!fu || blockSend) return "";
        return `
      <div class="followup-nudge" style="margin:10px 0 0;padding:9px 13px;background:#FFFAF0;border:1px solid #F6C468;border-radius:9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:0.82rem;color:#7B5A16">
        ⏰ <b>${fu.ids.length} of ${fu.total}</b> recipients haven't opened, clicked, or viewed after ${fu.days} day${fu.days === 1 ? "" : "s"}.
        <button type="button" class="btn btn-primary btn-sm followup-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" data-buyer-ids="${fu.ids.join(",")}" style="font-size:0.74rem;padding:3px 12px;margin-left:auto">📨 Send follow-up</button>
      </div>`;
      })()}

      ${(() => {
        const activeTab = activeTabByCard[p.card_id] || "posting";
        return `
      <div class="card-tabs">
        <button type="button" class="card-tab ${activeTab === "posting" ? "active" : ""}" data-tab="posting">📋 Posting</button>
        <button type="button" class="card-tab ${activeTab === "dealinfo" ? "active" : ""}" data-tab="dealinfo">🏠 Deal Info <span class="acq-badge ${acqBadgeComplete ? "complete" : ""}">${acqDone.filled}/${acqDone.total}</span></button>
      </div>

      <div class="tab-panel tab-posting ${activeTab === "posting" ? "" : "hidden"}" data-tab-panel="posting">`;
      })()}
      <div class="terms-block" data-card-id="${escapeHtml(p.card_id)}">
        <div class="terms-view">
          <div class="terms-row">
            ${t.price ? `<span class="term-chip">Price <b>${fmtMoney(t.price)}</b></span>` : ""}
            ${t.entry_fee ? `<span class="term-chip">Entry Fee <b>${fmtMoney(t.entry_fee)}</b></span>` : ""}
            ${t.mortgage ? `<span class="term-chip">Loan Bal. <b>${fmtMoney(t.mortgage)}</b></span>` : ""}
            ${t.piti ? `<span class="term-chip">PITI <b>${fmtMoney(t.piti)}/mo</b></span>` : ""}
            ${t.rate ? `<span class="term-chip">Rate <b>${escapeHtml(t.rate)}%</b></span>` : ""}
            ${t.beds ? `<span class="term-chip"><b>${t.beds}</b> bd / <b>${t.baths || "—"}</b> ba</span>` : ""}
            ${t.sqft ? `<span class="term-chip"><b>${t.sqft.toLocaleString()}</b> sqft</span>` : ""}
            ${t.year_built ? `<span class="term-chip">Built <b>${t.year_built}</b></span>` : ""}
            <span class="term-chip">👥 <b>${matchCount}</b> matching buyer${matchCount === 1 ? "" : "s"}</span>
            <button type="button" class="btn btn-ghost btn-sm terms-edit-btn">✎ Edit Terms</button>
          </div>
        </div>
        <div class="terms-edit hidden mt-8">
          <div class="terms-edit-grid">
            <div><label>Purchase Price</label><input type="number" class="te-price" value="${t.price || ""}"></div>
            <div><label>Entry Fee</label><input type="number" class="te-entry_fee" value="${t.entry_fee || ""}"></div>
            <div><label>Loan Balance</label><input type="number" class="te-mortgage" value="${t.mortgage || ""}"></div>
            <div><label>PITI / mo</label><input type="number" class="te-piti" value="${t.piti || ""}"></div>
            <div><label>Rate (%)</label><input type="text" class="te-rate" value="${escapeHtml(t.rate || "")}"></div>
            <div><label>Beds</label><input type="number" class="te-beds" value="${t.beds || ""}"></div>
            <div><label>Baths</label><input type="text" class="te-baths" value="${escapeHtml(t.baths || "")}"></div>
            <div><label>Sqft</label><input type="number" class="te-sqft" value="${t.sqft || ""}"></div>
            <div><label>Year Built</label><input type="number" class="te-year_built" value="${t.year_built || ""}"></div>
          </div>
          <div class="flex gap-8 mt-8">
            <button type="button" class="btn btn-ghost btn-sm terms-cancel-btn">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm terms-save-btn">Save</button>
            <span class="muted terms-save-status" style="font-size:0.78rem"></span>
          </div>
        </div>
      </div>

      ${p.agent ? `<div class="prop-meta">${escapeHtml(p.agent)}</div>` : ""}

      ${variations.length ? `
        <div class="mt-16">
          <label>Marketing Copy (${variations.length} variation${variations.length === 1 ? "" : "s"}) <span class="muted" style="font-weight:400">— generated on intake; edits here are saved and become the source of truth</span></label>
          ${variations.map((v, i) => {
            const body = (v && typeof v === "object") ? (v.body || "") : String(v || "");
            return `
            <div class="copy-block" data-card-id="${escapeHtml(p.card_id)}" data-idx="${i}">
              <div class="copy-view">
                <div class="variation">${escapeHtml(body)}</div>
                <button type="button" class="btn btn-ghost btn-sm copy-edit-btn mt-8">✎ Edit copy</button>
              </div>
              <div class="copy-edit hidden">
                <textarea class="copy-edit-textarea" rows="7" style="width:100%;font-size:0.83rem;font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</textarea>
                <div class="flex gap-8 mt-8">
                  <button type="button" class="btn btn-ghost btn-sm copy-cancel-btn">Cancel</button>
                  <button type="button" class="btn btn-primary btn-sm copy-save-btn">Save</button>
                  <span class="muted copy-save-status" style="font-size:0.78rem"></span>
                </div>
              </div>
            </div>`;
          }).join("")}
        </div>` : `<p class="muted mt-16">No copy generated yet.</p>`}

      ${mismatches.length ? `
        <div class="mismatch-banner">
          ${mismatches.map(m => `⚠️ Copy mismatch detected: ${escapeHtml(m)}. Fix before blasting.`).join("<br>")}
        </div>` : ""}

      <div class="mt-16">
        <div class="flex-between">
          <label style="margin:0">Facebook Groups Posted (${posts.length})</label>
          <select class="fb-group-select" style="width:auto;max-width:220px">
            <option value="">+ Log a post…</option>
            ${FB_GROUPS.map(g => `<option value="${escapeHtml(g.name)}">${escapeHtml(g.name)}</option>`).join("")}
          </select>
        </div>
        <div class="fb-groups">
          ${posts.map(post => `
            <span class="pill pill-tier-B" style="display:inline-flex;align-items:center;gap:6px">
              ${escapeHtml(post.group_name)}
              <button class="fb-delete" data-post-id="${post.id}" style="border:none;background:none;color:var(--red);cursor:pointer;font-size:0.9rem;line-height:1">×</button>
            </span>
          `).join("") || `<span class="muted" style="font-size:0.82rem">Not posted to any groups yet.</span>`}
        </div>
        <div class="fb-quicklinks">
          ${FB_GROUPS.map(g => {
            const isPosted = posts.some(post => post.group_name === g.name);
            return `<a href="${escapeHtml(g.url)}" target="_blank" rel="noopener"
                      class="fb-quicklink fb-quicklink-go ${isPosted ? "posted" : ""}"
                      data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}"
                      data-group-name="${escapeHtml(g.name)}" data-posted="${isPosted ? "1" : "0"}"
                      title="${isPosted ? "Already logged as posted — click to open the group again" : "Open this group and log the post"}">
                      ${isPosted ? "✓" : "🔗"} ${escapeHtml(g.name)}
                    </a>`;
          }).join("")}
        </div>
      </div>

      <div class="mt-16">
        <div class="flex-between">
          <label style="margin:0">Pipeline (${leads.length})</label>
          <button type="button" class="btn btn-ghost btn-sm add-lead-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}">+ Add Lead</button>
        </div>
        <div class="muted" style="font-size:0.76rem;margin:2px 0 4px">👁 ${totalViews} view${totalViews === 1 ? "" : "s"} · ${interestedCount} interested</div>
        ${leads.length ? `
          <div class="flex gap-8" style="flex-wrap:wrap;margin:6px 0 8px">
            ${STAGES.filter(s => stageCounts[s.key]).map(s => `<span class="pill" style="background:${s.color}22;color:${s.color};font-size:0.7rem;font-weight:700">${s.label} · ${stageCounts[s.key]}</span>`).join("")}
          </div>
          <div style="max-height:220px;overflow-y:auto">
            ${sortedLeads.map(l => {
              const st = STAGE_BY_KEY[l.stage] || STAGE_BY_KEY.new;
              const chIcon = { email: "📧", sms: "💬", call: "📞", dm: "✉️", in_person: "🤝" }[l.channel] || "";
              return `
              <div class="lead-row" data-lead-id="${l.id}" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border, #eee);cursor:pointer;font-size:0.84rem">
                <span class="pill" style="background:${st.color}22;color:${st.color};font-size:0.66rem;font-weight:700;white-space:nowrap">${st.label}</span>
                ${chIcon ? `<span title="Responded via ${escapeHtml(l.channel)}">${chIcon}</span>` : ""}
                <strong style="white-space:nowrap">${escapeHtml(l.name)}</strong>
                ${l.source === "deck_page" ? `<span class="pill" style="background:#D4A03E22;color:#8a6d1f;font-size:0.66rem;font-weight:700;white-space:nowrap">deck</span>` : ""}
                <span class="muted" style="font-size:0.76rem;white-space:nowrap">${escapeHtml(SOURCE_LABELS[l.source] || l.source)}</span>
                ${(l.buyer_id != null && viewsByBuyer.get(Number(l.buyer_id))) ? `<span class="muted" style="font-size:0.72rem;white-space:nowrap">· viewed ${viewsByBuyer.get(Number(l.buyer_id))}×</span>` : ""}
                <span class="muted" style="font-size:0.76rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escapeHtml(l.contact || "")}${l.notes ? ` — ${escapeHtml(l.notes)}` : ""}</span>
              </div>`;
            }).join("")}
          </div>
        ` : `<p class="muted" style="font-size:0.82rem;margin-top:6px">No leads logged yet for this deal — add buyers who respond, or leads from InvestorLift, CreativeListing, FB groups, etc.</p>`}
      </div>

      ${(emailBlasts.length || leads.length || recips.length) ? `
      <div class="mt-16">
        <label>Analytics</label>
        <div style="font-size:0.8rem;color:var(--text-2);line-height:1.7">
          ${recips.length ? `<div><b>Delivery:</b> 📧 ${emailDelivered} delivered${emailFailed ? `, <span style="color:var(--red)">${emailFailed} failed</span>` : ""}${(smsDelivered || smsFailed) ? ` · 💬 ${smsDelivered} delivered${smsFailed ? `, <span style="color:var(--red)">${smsFailed} failed</span>` : ""}` : ""}${totalFailed ? ` <button type="button" class="btn btn-ghost btn-sm retry-failed-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" style="font-size:0.7rem;padding:2px 8px;color:var(--red)">↻ Retry failed (${totalFailed})</button>` : ""}</div>` : ""}
          ${emailBlasts.length ? `<div><b>Copy variations sent:</b> ${Object.entries(variationStats).map(([title, n]) => `${escapeHtml(title)} (${n}×)`).join(" · ")}</div>` : ""}
          ${leads.length ? `<div><b>Pipeline funnel:</b> ${STAGES.map(s => `${s.label} ${stageCounts[s.key] || 0}`).join(" → ")}</div>
          <div><b>Responded or further:</b> ${respondedPlus} of ${leads.length} logged lead${leads.length === 1 ? "" : "s"} (${leads.length ? Math.round(respondedPlus / leads.length * 100) : 0}%)</div>` : ""}
        </div>
      </div>` : ""}
      </div>

      <div class="tab-panel tab-dealinfo ${(activeTabByCard[p.card_id] || "posting") === "dealinfo" ? "" : "hidden"}" data-tab-panel="dealinfo">
        ${renderAcqPanel(p, acq, t)}
      </div>
    </div>`;
}

// ── Deal Info tab content (acquisition / due-diligence form) ──
function yn(v) { return v === true ? "yes" : v === false ? "no" : ""; }
function ynu(v) { return v === true ? "yes" : v === false ? "no" : "unknown"; }
function acqToggle(field, value, opts) {
  // opts: array of {key, label} — defaults to Yes/No
  const options = opts || [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }];
  return `<div class="acq-toggle" data-field="${field}">
    ${options.map(o => `<button type="button" class="acq-toggle-btn ${value === o.key ? `active-${o.key === "yes" ? "yes" : o.key === "no" ? "no" : "unknown"}` : ""}" data-field="${field}" data-value="${o.key}">${escapeHtml(o.label)}</button>`).join("")}
  </div>`;
}
function renderAcqPanel(p, acq, terms) {
  const a = acq || {};
  const cardId = escapeHtml(p.card_id);
  const num = (v) => (v === null || v === undefined) ? "" : v;
  const txt = (v) => escapeHtml(v == null ? "" : String(v));

  return `
  <div class="acq-panel" data-card-id="${cardId}">
    <span class="acq-saved-flash">Saved ✓</span>

    <!-- Section 1: Property & Condition -->
    <div class="acq-section">
      <h4>🏚️ Property &amp; Condition</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>HOA?</label>${acqToggle("hoa", yn(a.hoa))}</div>
        <div class="acq-field"><label>Roof age (yrs)</label><input type="number" class="acq-input" data-field="roof_age" value="${num(a.roof_age)}"></div>
        <div class="acq-field"><label>Roof type</label>
          <select class="acq-input" data-field="roof_type">
            <option value="">—</option>
            ${["Shingle","Metal","Tile","Flat"].map(o => `<option value="${o}" ${a.roof_type === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div class="acq-field"><label>HVAC age (yrs)</label><input type="number" class="acq-input" data-field="hvac_age" value="${num(a.hvac_age)}"></div>
        <div class="acq-field"><label>Water heater age (yrs)</label><input type="number" class="acq-input" data-field="water_heater_age" value="${num(a.water_heater_age)}"></div>
        <div class="acq-field"><label>Condition</label>
          <select class="acq-input" data-field="condition">
            <option value="">—</option>
            ${["Excellent","Good","Fair","Needs Work"].map(o => `<option value="${o}" ${a.condition === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div class="acq-field"><label>Est. repair budget</label><input type="number" class="acq-input" data-field="repair_budget" value="${num(a.repair_budget)}"></div>
        <div class="acq-field" style="grid-column:1/-1"><label>Known issues</label><textarea class="acq-input" data-field="known_issues" rows="2">${txt(a.known_issues)}</textarea></div>
        ${a.hoa === true ? `
        <div class="acq-conditional">
          <div class="acq-grid">
            <div class="acq-field"><label>HOA monthly amount</label><input type="number" class="acq-input" data-field="hoa_amount" value="${num(a.hoa_amount)}"></div>
            <div class="acq-field"><label>Rental restrictions?</label>${acqToggle("hoa_rental_restriction", yn(a.hoa_rental_restriction))}
              ${a.hoa_rental_restriction === true ? `<span class="acq-info-badge red">⚠️ Investor Risk</span>` : ""}
            </div>
            <div class="acq-field"><label>STR allowed?</label>${acqToggle("hoa_str_allowed", yn(a.hoa_str_allowed))}</div>
            <div class="acq-field"><label>Age restricted 55+?</label>${acqToggle("hoa_age_restricted", yn(a.hoa_age_restricted))}</div>
          </div>
        </div>` : ""}
      </div>
    </div>

    <!-- Section 2: Loan Details -->
    <div class="acq-section">
      <h4>🏦 Loan Details</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Lender name</label><input type="text" class="acq-input" data-field="lender_name" value="${txt(a.lender_name)}"></div>
        <div class="acq-field"><label>Loan type</label>
          <select class="acq-input" data-field="loan_type">
            <option value="">—</option>
            ${["Conventional","FHA","VA","USDA"].map(o => `<option value="${o}" ${a.loan_type === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
          ${(a.loan_type === "FHA" || a.loan_type === "VA") ? `<span class="acq-info-badge blue">Assumable — confirm with lender</span>` : ""}
        </div>
        <div class="acq-field"><label>Interest rate (%)</label><input type="number" step="0.01" class="acq-input" data-field="loan_rate" value="${num(a.loan_rate != null ? a.loan_rate : terms.rate)}"></div>
        <div class="acq-field"><label>Remaining term</label>
          <div class="flex gap-8">
            <input type="number" class="acq-input" data-field="loan_term_value" value="${num(a.loan_term_value)}" style="flex:1">
            <select class="acq-input" data-field="loan_term_unit" style="flex:1">
              <option value="">—</option>
              <option value="months" ${a.loan_term_unit === "months" ? "selected" : ""}>Months</option>
              <option value="years" ${a.loan_term_unit === "years" ? "selected" : ""}>Years</option>
            </select>
          </div>
        </div>
        <div class="acq-field"><label>Loan current?</label>${acqToggle("loan_current", yn(a.loan_current))}</div>
        <div class="acq-field"><label>Prepayment penalty?</label>${acqToggle("prepayment_penalty", a.prepayment_penalty || "", [{key:"Yes",label:"Yes"},{key:"No",label:"No"},{key:"Unknown",label:"Unknown"}])}</div>
        ${a.loan_current === false ? `
        <div class="acq-conditional">
          <div class="acq-grid">
            <div class="acq-field"><label>Months behind</label><input type="number" class="acq-input" data-field="months_behind" value="${num(a.months_behind)}"></div>
            <div class="acq-field"><label>Total arrears ($)</label><input type="number" class="acq-input" data-field="arrears_amount" value="${num(a.arrears_amount)}"></div>
          </div>
        </div>` : ""}
      </div>
    </div>

    <!-- Section 3: Media Checklist -->
    <div class="acq-section">
      <h4>🎬 Media Checklist</h4>
      <div class="acq-media-row">
        <span class="acq-media-icon">${a.cover_image_url ? "✅" : "❌"}</span>
        <span class="acq-media-label">Cover photo (email + deck link)</span>
        <input type="text" class="acq-input" data-field="cover_image_url" placeholder="Paste direct image URL, or upload →" value="${txt(a.cover_image_url)}">
        <button type="button" class="btn btn-ghost btn-sm cover-photo-upload-btn" data-card-id="${cardId}">📤 Upload photo</button>
        <input type="file" accept="image/*" class="cover-photo-file hidden" data-card-id="${cardId}">
        ${!a.cover_image_url ? `<span class="acq-media-status bad">No banner on deck link</span>` : `<span class="acq-media-status ok">Set — shows on deck</span>`}
        ${a.cover_image_url ? `<img src="${escapeHtml(a.cover_image_url)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px;margin-left:6px">` : ""}
      </div>
      <div class="acq-media-row">
        <span class="acq-media-icon">${a.video_url ? "✅" : "❌"}</span>
        <span class="acq-media-label">Video walkthrough</span>
        <input type="text" class="acq-input" data-field="video_url" placeholder="Paste video URL…" value="${txt(a.video_url)}">
        ${!a.video_url ? `<span class="acq-media-status bad">Not uploaded</span>` : `<span class="acq-media-status ok">Uploaded</span>`}
      </div>
      <div class="acq-media-row">
        <span class="acq-media-icon">${a.photos_count != null && Number(a.photos_count) >= 10 ? "✅" : "❌"}</span>
        <span class="acq-media-label">Photos</span>
        <input type="number" class="acq-input" data-field="photos_count" placeholder="# of photos" value="${num(a.photos_count)}">
        <span class="acq-media-status ${a.photos_count != null && Number(a.photos_count) >= 10 ? "ok" : "bad"}">${a.photos_count != null ? `${a.photos_count} photos` : "0 photos"}${(a.photos_count == null || Number(a.photos_count) < 10) ? " — need 10+" : ""}</span>
      </div>
      <div class="acq-media-row">
        <span class="acq-media-icon">${a.mortgage_statement_url ? "✅" : "❌"}</span>
        <span class="acq-media-label">Mortgage statement</span>
        <input type="text" class="acq-input" data-field="mortgage_statement_url" placeholder="Paste document URL…" value="${txt(a.mortgage_statement_url)}">
        ${!a.mortgage_statement_url ? `<span class="acq-media-status bad">Not uploaded</span>` : `<span class="acq-media-status ok">Uploaded</span>`}
      </div>
      <div class="acq-media-row">
        <span class="acq-media-icon">${(a.hoa_docs_url || a.hoa_docs_na) ? "✅" : "❌"}</span>
        <span class="acq-media-label">HOA docs</span>
        <input type="text" class="acq-input" data-field="hoa_docs_url" placeholder="Paste document URL…" value="${txt(a.hoa_docs_url)}" ${a.hoa_docs_na ? "disabled" : ""}>
        <label class="flex gap-8" style="font-size:0.76rem;font-weight:500;color:var(--text-2)"><input type="checkbox" class="acq-checkbox" data-field="hoa_docs_na" ${a.hoa_docs_na ? "checked" : ""} style="width:auto"> N/A</label>
      </div>
      <div class="acq-media-row">
        <span class="acq-media-icon">${(a.inspection_report_url || a.inspection_na) ? "✅" : "❌"}</span>
        <span class="acq-media-label">Inspection report</span>
        <input type="text" class="acq-input" data-field="inspection_report_url" placeholder="Paste document URL…" value="${txt(a.inspection_report_url)}" ${a.inspection_na ? "disabled" : ""}>
        <label class="flex gap-8" style="font-size:0.76rem;font-weight:500;color:var(--text-2)"><input type="checkbox" class="acq-checkbox" data-field="inspection_na" ${a.inspection_na ? "checked" : ""} style="width:auto"> N/A</label>
      </div>
    </div>

    <!-- Section 4: Seller & Occupancy -->
    <div class="acq-section">
      <h4>🧑‍💼 Seller &amp; Occupancy</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Seller motivation</label>
          <select class="acq-input" data-field="seller_motivation">
            <option value="">—</option>
            ${["Foreclosure","Divorce","Relocation","Inherited","Tired Landlord","Financial Hardship","Other"].map(o => `<option value="${o}" ${a.seller_motivation === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div class="acq-field"><label>Timeline to close</label>
          <select class="acq-input" data-field="timeline_to_close">
            <option value="">—</option>
            ${["ASAP","30 days","60 days","Flexible"].map(o => `<option value="${o}" ${a.timeline_to_close === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div class="acq-field"><label>Currently occupied?</label>${acqToggle("occupied", yn(a.occupied))}</div>
        <div class="acq-field"><label>Open liens beyond mortgage?</label>${acqToggle("open_liens", yn(a.open_liens))}</div>
        <div class="acq-field"><label>In probate?</label>${acqToggle("in_probate", yn(a.in_probate))}</div>
        ${a.occupied === true ? `
        <div class="acq-conditional">
          <div class="acq-grid">
            <div class="acq-field"><label>Monthly rent</label><input type="number" class="acq-input" data-field="monthly_rent" value="${num(a.monthly_rent)}"></div>
            <div class="acq-field"><label>Lease end date</label><input type="date" class="acq-input" data-field="lease_end_date" value="${txt(a.lease_end_date)}"></div>
            <div class="acq-field"><label>Tenant paying on time?</label>${acqToggle("tenant_paying_on_time", yn(a.tenant_paying_on_time))}</div>
          </div>
        </div>` : ""}
        ${a.occupied === false ? `
        <div class="acq-conditional">
          <div class="acq-grid">
            <div class="acq-field"><label>Months vacant</label><input type="number" class="acq-input" data-field="months_vacant" value="${num(a.months_vacant)}"></div>
          </div>
        </div>` : ""}
        ${a.open_liens === true ? `
        <div class="acq-conditional">
          <div class="acq-field"><label>Lien notes</label><textarea class="acq-input" data-field="liens_notes" rows="2">${txt(a.liens_notes)}</textarea></div>
        </div>` : ""}
      </div>
    </div>
  </div>`;
}

// ── Morby Deal tab content (LOI terms + Deal Deck inputs) ──
const MORBY_DSCR_DEFAULTS = {
  single_family: { rate: 7.75, ltv: 75, credit: 800 },
  commercial:    { rate: 8.5,  ltv: 70, credit: 800 },
};

// (dscrMonthlyPayment comes from /js/deal-shared.js)

function renderMorbyPanel(p, morby, terms, acq) {
  const m = morby || {};
  const ac = acq || {};
  const cardId = escapeHtml(p.card_id);
  const num = (v) => (v === null || v === undefined) ? "" : v;
  const txt = (v) => escapeHtml(v == null ? "" : String(v));
  const propertyType = m.property_type || "single_family";
  const defaults = MORBY_DSCR_DEFAULTS[propertyType] || MORBY_DSCR_DEFAULTS.single_family;
  const dscrRate = m.dscr_rate != null ? m.dscr_rate : defaults.rate;
  const dscrLtv = m.dscr_ltv != null ? m.dscr_ltv : defaults.ltv;
  const dscrCredit = m.dscr_credit_score != null ? m.dscr_credit_score : defaults.credit;

  return `
  <div class="morby-panel" data-card-id="${cardId}">
    <span class="acq-saved-flash">Saved ✓</span>

    <!-- Section: Deal Deck Address -->
    <div class="acq-section">
      <h4>📍 Deal Deck Address</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Used as the property address on the Deal Deck PDF. Defaults to the Trello card name — correct it here if that's wrong, without renaming the card.</p>
      <div class="acq-field">
        <input type="text" class="acq-input" data-field="address_override" placeholder="${escapeHtml(p.name || "")}" value="${txt(m.address_override)}">
      </div>
    </div>

    <!-- Section: Deal Deck Photo -->
    <div class="acq-section">
      <h4>🖼️ Deal Deck Photo</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Paste a direct image URL (or upload) — this photo becomes the banner on the SMS/email deck link. Leave blank for the styled navy banner.</p>
      <div class="acq-media-row">
        <span class="acq-media-icon">${ac.cover_image_url ? "✅" : "❌"}</span>
        <input type="text" class="acq-input morby-cover-input" data-field="cover_image_url" placeholder="Paste direct image URL, or upload →" value="${txt(ac.cover_image_url)}">
        <button type="button" class="btn btn-ghost btn-sm morby-cover-upload-btn" data-card-id="${cardId}">📤 Upload photo</button>
        <input type="file" accept="image/*" class="morby-cover-file hidden" data-card-id="${cardId}">
        ${!ac.cover_image_url ? `<span class="acq-media-status bad">No banner on deck link</span>` : `<span class="acq-media-status ok">Set — shows on deck</span>`}
        ${ac.cover_image_url ? `<img src="${escapeHtml(ac.cover_image_url)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:6px;margin-left:6px">` : ""}
      </div>
    </div>

    <!-- Section: Upload LOI -->
    <div class="acq-section">
      <h4>📤 Upload LOI</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Upload the signed LOI (PDF) and the form below will be auto-filled — review and adjust before generating the Deal Deck.</p>
      <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
        <input type="file" class="morby-loi-input" accept="application/pdf" style="max-width:280px">
        <button type="button" class="btn btn-ghost btn-sm morby-loi-btn" data-card-id="${cardId}">📤 Extract from LOI</button>
        <span class="morby-loi-status muted" style="font-size:0.78rem"></span>
      </div>
    </div>

    <!-- Section: Property Type -->
    <div class="acq-section">
      <h4>🏷️ Deal Deck Type</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Property type</label>
          ${acqToggle("property_type", propertyType, [{ key: "single_family", label: "Single Family" }, { key: "commercial", label: "Commercial" }])}
          <p class="muted" style="font-size:0.74rem;margin-top:4px">Controls which Deal Deck template + DSCR defaults are used.</p>
        </div>
      </div>
    </div>

    <!-- Section: LOI / Financial Terms -->
    <div class="acq-section">
      <h4>📝 LOI / Financial Terms</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Purchase price</label><input type="number" class="acq-input" data-field="purchase_price" value="${num(m.purchase_price)}"></div>
        <div class="acq-field"><label>Down payment / EMD</label><input type="number" class="acq-input" data-field="down_payment" value="${num(m.down_payment)}"></div>
        <div class="acq-field"><label>Earnest money amount</label><input type="number" class="acq-input" data-field="earnest_money_amount" value="${num(m.earnest_money_amount)}"></div>
        <div class="acq-field"><label>Closing costs</label><input type="text" class="acq-input" data-field="closing_costs_note" value="${txt(m.closing_costs_note != null ? m.closing_costs_note : "Buyer pays all closing costs")}"></div>
        <div class="acq-field"><label>Broker commission</label><input type="text" class="acq-input" data-field="broker_commission" value="${txt(m.broker_commission != null ? m.broker_commission : "None")}"></div>
        <div class="acq-field"><label>Listing agent commission (%)</label><input type="number" step="0.01" class="acq-input" data-field="additional_broker_pct" value="${num(m.additional_broker_pct)}"><p class="muted" style="font-size:0.74rem;margin-top:4px">A % of purchase price. Reduces Cash at Close.</p></div>
      </div>
    </div>

    <!-- Section: Seller Financing (Deferred Interest) -->
    <div class="acq-section">
      <h4>🏦 Seller Financing (Deferred Interest)</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Seller carry balance</label><input type="number" class="acq-input" data-field="seller_carry_balance" value="${num(m.seller_carry_balance)}"></div>
        <div class="acq-field"><label>Interest structure</label>
          <select class="acq-input" data-field="interest_type">
            <option value="deferred" ${(m.interest_type || "deferred") === "deferred" ? "selected" : ""}>Deferred (compounds; full balance + accrued interest due at balloon)</option>
            <option value="interest_only" ${m.interest_type === "interest_only" ? "selected" : ""}>Interest Only (no compounding; balloon payoff = principal)</option>
          </select>
        </div>
        <div class="acq-field"><label>Interest rate (%)</label><input type="number" step="0.01" class="acq-input" data-field="deferred_interest_rate" value="${num(m.deferred_interest_rate)}"></div>
        <div class="acq-field"><label>Monthly payment during deferral</label><input type="number" class="acq-input" data-field="monthly_payment" value="${num(m.monthly_payment != null ? m.monthly_payment : 0)}"></div>
        <div class="acq-field"><label>Balloon (months)</label><input type="number" class="acq-input" data-field="balloon_months" value="${num(m.balloon_months)}"></div>
      </div>
    </div>

    <!-- Section: Timeline & Contingencies -->
    <div class="acq-section">
      <h4>📅 Timeline &amp; Contingencies</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Inspection period (days)</label><input type="number" class="acq-input" data-field="inspection_period_days" value="${num(m.inspection_period_days != null ? m.inspection_period_days : 15)}"></div>
        <div class="acq-field"><label>Close of escrow (days)</label><input type="number" class="acq-input" data-field="close_of_escrow_days" value="${num(m.close_of_escrow_days != null ? m.close_of_escrow_days : 30)}"></div>
        <div class="acq-field"><label>Financing contingency?</label>${acqToggle("financing_contingency", yn(m.financing_contingency != null ? m.financing_contingency : true))}</div>
      </div>
    </div>

    <!-- Section: Property Details -->
    <div class="acq-section">
      <h4>🏚️ Property Details</h4>
      <div class="acq-grid">
        <div class="acq-field" style="grid-column:1/-1"><label>Tenancy description</label><textarea class="acq-input" data-field="tenancy_description" rows="2">${txt(m.tenancy_description)}</textarea></div>
        <div class="acq-field" style="grid-column:1/-1"><label>Property description</label><textarea class="acq-input" data-field="property_description" rows="3">${txt(m.property_description)}</textarea></div>
      </div>
    </div>

    <!-- Section: Income & Expense Projections -->
    <div class="acq-section">
      <h4>💵 Income &amp; Expense Projections</h4>
      <div class="acq-grid">
        ${propertyType === "commercial" ? `
          <div class="acq-field"><label>Annual NOI</label><input type="number" class="acq-input" data-field="annual_noi" value="${num(m.annual_noi)}"></div>
          <div class="acq-field"><label>Monthly NOI</label><input type="number" class="acq-input" data-field="monthly_noi" value="${num(m.monthly_noi)}"></div>
        ` : `
          <div class="acq-field"><label>Long-Term Rent (monthly)</label><input type="number" class="acq-input" data-field="ltr_monthly_rent" value="${num(m.ltr_monthly_rent)}"></div>
          <div class="acq-field"><label>Short-Term Rent (monthly)</label><input type="number" class="acq-input" data-field="str_monthly_rent" value="${num(m.str_monthly_rent)}"></div>
        `}
        <div class="acq-field">
          <label>Property Taxes (monthly)
            <button type="button" class="btn btn-ghost btn-sm estimate-ti-btn" data-card-id="${cardId}"
              style="font-size:0.7rem;padding:1px 6px;margin-left:6px" title="Estimate from purchase price + state">💡 Estimate</button>
          </label>
          <input type="number" class="acq-input" data-field="monthly_taxes" value="${num(m.monthly_taxes)}" placeholder="0">
        </div>
        <div class="acq-field"><label>Insurance (monthly)</label><input type="number" class="acq-input" data-field="monthly_insurance" value="${num(m.monthly_insurance)}" placeholder="0"></div>
      </div>
    </div>

    <!-- Section: DSCR Debt Service Assumptions -->
    <div class="acq-section">
      <h4>📊 DSCR Debt Service Assumptions</h4>
      <p class="muted" style="font-size:0.76rem;margin-top:-4px">Defaults based on property type (Single Family: 7.75% / 75% LTV / 800 credit · Commercial: 8.5% / 70% LTV / 800 credit) — edit per deal as needed.</p>
      <div class="acq-grid">
        <div class="acq-field"><label>DSCR rate (%)</label><input type="number" step="0.01" class="acq-input" data-field="dscr_rate" value="${dscrRate}"></div>
        <div class="acq-field"><label>DSCR LTV (%)</label><input type="number" step="0.01" class="acq-input" data-field="dscr_ltv" value="${dscrLtv}"></div>
        <div class="acq-field"><label>DSCR credit score</label><input type="number" class="acq-input" data-field="dscr_credit_score" value="${dscrCredit}"></div>
      </div>
    </div>

    <!-- Section: Seller Flexibility Notes -->
    <div class="acq-section">
      <h4>🤝 Seller Flexibility Notes</h4>
      <div class="acq-grid">
        <div class="acq-field" style="grid-column:1/-1"><textarea class="acq-input" data-field="seller_flexibility_notes" rows="3" placeholder="e.g. Seller willing to finance $X after balloon...">${txt(m.seller_flexibility_notes)}</textarea></div>
      </div>
    </div>

    <div class="flex gap-8 mt-8">
      <button type="button" class="btn btn-primary btn-sm morby-deck-btn" data-card-id="${cardId}">📄 Download Deal Deck (PDF)</button>
    </div>
  </div>`;
}

function wireCardEvents() {
  // ── Triage: expand a compact row / collapse a full card. State lives in
  // expandedDealCards so it survives re-renders within the session. ──
  document.querySelectorAll(".compact-deal").forEach(row => {
    const open = () => { expandedDealCards.add(row.dataset.cardId); renderBoard(); };
    // Links inside the row (the dispo-stage chip) navigate; don't also expand.
    row.addEventListener("click", (e) => { if (!e.target.closest("a")) open(); });
    row.addEventListener("keydown", (e) => {
      if (e.target.closest("a")) return; // Enter on the stage chip navigates
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  document.querySelectorAll(".collapse-deal-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      expandedDealCards.delete(btn.dataset.cardId);
      renderBoard();
    });
  });

  document.querySelectorAll(".fb-group-select").forEach(sel => {
    sel.addEventListener("change", async (e) => {
      const groupName = e.target.value;
      if (!groupName) return;
      const cardEl = e.target.closest(".prop-card");
      const cardId = cardEl.dataset.cardId;
      const cardName = cardEl.querySelector(".prop-title").textContent;
      await supa.from("facebook_posts").insert({ card_id: cardId, card_name: cardName, group_name: groupName });
      e.target.value = "";
      loadAll();
    });
  });
  document.querySelectorAll(".fb-delete").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const { error } = await supa.from("facebook_posts").delete().eq("id", e.target.dataset.postId);
      if (error) { toast(`Couldn't remove post: ${error.message}`, { type: "error" }); return; }
      loadAll();
    });
  });
  // ── Feature 1: Facebook Group Quick-Links ──
  // Clicking opens the group in a new tab (default <a> behavior). If it
  // hasn't been logged as posted yet, also prompt to log it.
  document.querySelectorAll(".fb-quicklink-go").forEach(link => {
    link.addEventListener("click", (e) => {
      const { cardId, address, groupName, posted } = link.dataset;
      if (posted === "1") return; // already logged — just open the link
      setTimeout(() => {
        if (confirm(`Log "${groupName}" as posted for ${address}?`)) {
          supa.from("facebook_posts").insert({ card_id: cardId, card_name: address, group_name: groupName }).then(() => loadAll());
        }
      }, 0);
    });
  });
  // ── Editable deal terms (price, entry fee, PITI, etc.) ──
  document.querySelectorAll(".terms-block").forEach(block => {
    const cardId = block.dataset.cardId;
    const viewEl = block.querySelector(".terms-view");
    const editEl = block.querySelector(".terms-edit");
    const editBtn = block.querySelector(".terms-edit-btn");
    const cancelBtn = block.querySelector(".terms-cancel-btn");
    const saveBtn = block.querySelector(".terms-save-btn");
    const statusEl = block.querySelector(".terms-save-status");

    editBtn.addEventListener("click", () => {
      viewEl.classList.add("hidden");
      editEl.classList.remove("hidden");
    });
    cancelBtn.addEventListener("click", () => {
      editEl.classList.add("hidden");
      viewEl.classList.remove("hidden");
      statusEl.textContent = "";
    });
    saveBtn.addEventListener("click", async () => {
      const num = (sel) => {
        const v = block.querySelector(sel).value.trim();
        return v === "" ? 0 : Number(v);
      };
      const txt = (sel) => block.querySelector(sel).value.trim();
      const row = {
        card_id: cardId,
        price: num(".te-price"),
        entry_fee: num(".te-entry_fee"),
        mortgage: num(".te-mortgage"),
        piti: num(".te-piti"),
        rate: txt(".te-rate"),
        beds: num(".te-beds"),
        baths: txt(".te-baths"),
        sqft: num(".te-sqft"),
        year_built: num(".te-year_built"),
      };
      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      try {
        const { error } = await supa.from("deal_terms").upsert(row, { onConflict: "card_id" });
        if (error) throw error;
        await loadAll();
      } catch (e) {
        statusEl.textContent = `Couldn't save: ${e.message}`;
        saveBtn.disabled = false;
      }
    });
  });
  // ── Marketing copy editing (dashboard becomes source of truth post-creation) ──
  document.querySelectorAll(".copy-block").forEach(block => {
    const viewEl = block.querySelector(".copy-view");
    const editEl = block.querySelector(".copy-edit");
    const editBtn = block.querySelector(".copy-edit-btn");
    const cancelBtn = block.querySelector(".copy-cancel-btn");
    const saveBtn = block.querySelector(".copy-save-btn");
    const textarea = block.querySelector(".copy-edit-textarea");
    const statusEl = block.querySelector(".copy-save-status");

    editBtn.addEventListener("click", () => {
      viewEl.classList.add("hidden");
      editEl.classList.remove("hidden");
      textarea.focus();
    });
    cancelBtn.addEventListener("click", () => {
      editEl.classList.add("hidden");
      viewEl.classList.remove("hidden");
      statusEl.textContent = "";
    });
    saveBtn.addEventListener("click", async () => {
      const cardId = block.dataset.cardId;
      const idx = Number(block.dataset.idx);
      const deal = dealCache[cardId];
      if (!deal) return;
      const variations = [...((deal.prop && deal.prop.variations) || [])];
      const existing = variations[idx];
      const title = (existing && typeof existing === "object") ? (existing.title || "") : "";
      variations[idx] = { title, body: textarea.value };

      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      try {
        const { error } = await supa.from("properties").update({ variations }).eq("card_id", cardId);
        if (error) throw error;
        // Update local cache so re-renders (and the blast modal) reflect the edit
        // immediately without a full reload, then refresh the card in place.
        deal.prop.variations = variations;
        await loadAll();
      } catch (e) {
        statusEl.textContent = `Couldn't save: ${e.message}`;
        saveBtn.disabled = false;
      }
    });
  });
  // ── Feature 2: "Copy Deal Info" ──
  document.querySelectorAll(".copy-deal-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const deal = dealCache[cardId];
      if (!deal) return;
      const text = buildDealCopyText(deal.prop, deal.terms || {});
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = "✓ Copied!";
        btn.disabled = true;
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2000);
      } catch (err) {
        alert("Couldn't copy to clipboard: " + err.message);
      }
    });
  });
  // ── Deck-page link: copy to clipboard (resolving/backfilling the slug via
  // deck-link.js for legacy cards that don't have one yet). ──
  document.querySelectorAll(".deck-copy-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const deal = dealCache[cardId];
      const label = btn.textContent;
      try {
        let url = deal && deal.prop ? deckUrlFor(deal.prop) : "";
        if (!url) { btn.disabled = true; btn.textContent = "…"; url = await fetchDeckLink(cardId); }
        await copyText(url);
        btn.textContent = "✓ Copied";
      } catch (err) {
        toast(`Couldn't get the deck link: ${err.message}`, { type: "error" });
        btn.textContent = label; btn.disabled = false;
        return;
      }
      btn.disabled = false;
      setTimeout(() => { btn.textContent = label; }, 2000);
    });
  });
  document.querySelectorAll(".send-blast-btn, .test-blast-btn").forEach(btn => {
    btn.addEventListener("click", () => openBlastModal(btn));
  });
  document.querySelectorAll(".followup-btn").forEach(btn => {
    btn.addEventListener("click", () => openBlastModal(btn, {
      followUpIds: (btn.dataset.buyerIds || "").split(",").map(Number).filter(Boolean),
    }));
  });
  document.querySelectorAll(".retry-failed-btn").forEach(btn => {
    btn.addEventListener("click", () => retryFailed(btn));
  });
  document.querySelectorAll(".add-lead-btn").forEach(btn => {
    btn.addEventListener("click", () => openLeadModal({ cardId: btn.dataset.cardId, address: btn.dataset.address }));
  });
  document.querySelectorAll(".lead-row").forEach(row => {
    row.addEventListener("click", () => {
      const deal = dealCache[row.dataset.cardId];
      const lead = (deal && deal.leads || []).find(l => String(l.id) === row.dataset.leadId);
      if (lead) openLeadModal({ cardId: row.dataset.cardId, address: row.dataset.address, lead });
    });
  });

  // ── "🔥 N responded" header pill → jump to that deal's Posting tab + pipeline ──
  document.querySelectorAll(".responded-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      const cardId = pill.dataset.cardId;
      const card = document.querySelector(`.prop-card[data-card-id="${CSS.escape(cardId)}"]`);
      if (!card) return;
      activeTabByCard[cardId] = "posting";
      card.querySelectorAll(".card-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === "posting"));
      card.querySelectorAll(".tab-panel").forEach(panel => panel.classList.toggle("hidden", panel.dataset.tabPanel !== "posting"));
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ── Deal card tabs (Posting / Deal Info) ──
  document.querySelectorAll(".prop-card").forEach(card => {
    const cardId = card.dataset.cardId;
    const tabs = card.querySelectorAll(".card-tab");
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        activeTabByCard[cardId] = target;
        tabs.forEach(t => t.classList.toggle("active", t === tab));
        card.querySelectorAll(".tab-panel").forEach(panel => {
          panel.classList.toggle("hidden", panel.dataset.tabPanel !== target);
        });
      });
    });
  });

  // ── Deal type selector (Sub-To / Morby) ──
  document.querySelectorAll(".deal-type-select").forEach(sel => {
    sel.addEventListener("change", async (e) => {
      const cardId = e.target.dataset.cardId;
      const dealType = e.target.value;
      const { error } = await supa.from("properties").update({ deal_type: dealType }).eq("card_id", cardId);
      if (error) { alert(`Couldn't update deal type: ${error.message}`); return; }
      activeTabByCard[cardId] = "posting";
      await loadAll();
    });
  });

  wireAcqPanels();
  wireMorbyPanel();
}


// ── Deal Info (acquisition data) — inline auto-save on blur/change ──
function wireAcqPanels() {
  document.querySelectorAll(".acq-panel").forEach(panel => {
    const cardId = panel.dataset.cardId;
    const flash = panel.querySelector(".acq-saved-flash");
    let flashTimer = null;
    const showSaved = () => {
      flash.classList.add("show");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove("show"), 1600);
    };

    async function saveField(field, value) {
      const row = { card_id: cardId, [field]: value, updated_at: new Date().toISOString() };
      const { error } = await supa.from("deal_acquisition").upsert(row, { onConflict: "card_id" });
      if (error) { alert(`Couldn't save: ${error.message}`); return; }
      // Update local cache so re-renders / badges reflect the edit immediately.
      const deal = dealCache[cardId];
      if (deal) deal.acq = { ...(deal.acq || {}), [field]: value };
      showSaved();
    }

    // Cover photo upload → Supabase Storage (property-photos bucket) → public URL
    panel.querySelectorAll(".cover-photo-upload-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        panel.querySelector(".cover-photo-file").click();
      });
    });
    panel.querySelectorAll(".cover-photo-file").forEach(input => {
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${cardId}/cover-${Date.now()}.${ext}`;
        const { error: upErr } = await supa.storage.from("property-photos").upload(path, file, { upsert: true });
        if (upErr) { alert(`Upload failed: ${upErr.message}`); return; }
        const { data } = supa.storage.from("property-photos").getPublicUrl(path);
        const url = data.publicUrl;
        const textInput = panel.querySelector('.acq-input[data-field="cover_image_url"]');
        if (textInput) textInput.value = url;
        await saveField("cover_image_url", url);
        await loadAll();
      });
    });

    // Text / number / select / textarea / date inputs — save on blur (text-ish) or change (select/date)
    panel.querySelectorAll(".acq-input").forEach(input => {
      const field = input.dataset.field;
      const isNumeric = input.type === "number";
      const isSelectOrDate = input.tagName === "SELECT" || input.type === "date";
      const handler = async () => {
        let v = input.value;
        if (v === "") v = null;
        else if (isNumeric) v = Number(v);
        await saveField(field, v);
        if (isSelectOrDate) await loadAll(); // re-render to show/hide conditional sections + badges
      };
      input.addEventListener(isSelectOrDate ? "change" : "blur", handler);
      if (isSelectOrDate) return;
      // Also commit on Enter for single-line inputs
      if (input.tagName === "INPUT") {
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      }
    });

    // Yes/No (and Yes/No/Unknown) toggle buttons
    panel.querySelectorAll(".acq-toggle-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const field = btn.dataset.field;
        const raw = btn.dataset.value;
        let value;
        if (raw === "yes") value = true;
        else if (raw === "no") value = false;
        else value = raw; // e.g. "Yes"/"No"/"Unknown" for prepayment_penalty
        await saveField(field, value);
        await loadAll(); // re-render so conditional sub-sections / badges / completeness update
      });
    });

    // N/A checkboxes for HOA docs / inspection report
    panel.querySelectorAll(".acq-checkbox").forEach(cb => {
      cb.addEventListener("change", async () => {
        const field = cb.dataset.field;
        await saveField(field, cb.checked);
        await loadAll();
      });
    });
  });
}

// ── Morby Deal tab — inline auto-save on blur/change ──
function wireMorbyPanel() {
  document.querySelectorAll(".morby-panel").forEach(panel => {
    const cardId = panel.dataset.cardId;
    const flash = panel.querySelector(".acq-saved-flash");
    let flashTimer = null;
    const showSaved = () => {
      flash.classList.add("show");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove("show"), 1600);
    };

    async function saveField(field, value) {
      const row = { card_id: cardId, [field]: value, updated_at: new Date().toISOString() };
      const { error } = await supa.from("morby_deals").upsert(row, { onConflict: "card_id" });
      if (error) { alert(`Couldn't save: ${error.message}`); return; }
      const deal = dealCache[cardId];
      if (deal) deal.morby = { ...(deal.morby || {}), [field]: value };
      showSaved();
    }

    // Deal Deck Photo saves to deal_acquisition (not morby_deals) — that's the
    // table the deck page reads cover_image_url from.
    async function saveCoverToAcq(value) {
      const row = { card_id: cardId, cover_image_url: value, updated_at: new Date().toISOString() };
      const { error } = await supa.from("deal_acquisition").upsert(row, { onConflict: "card_id" });
      if (error) { alert(`Couldn't save photo: ${error.message}`); return; }
      const deal = dealCache[cardId];
      if (deal) deal.acq = { ...(deal.acq || {}), cover_image_url: value };
      showSaved();
    }
    panel.querySelectorAll(".morby-cover-input").forEach(input => {
      const handler = async () => { await saveCoverToAcq(input.value === "" ? null : input.value); };
      input.addEventListener("blur", handler);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    });
    panel.querySelectorAll(".morby-cover-upload-btn").forEach(btn => {
      btn.addEventListener("click", () => panel.querySelector(".morby-cover-file").click());
    });
    panel.querySelectorAll(".morby-cover-file").forEach(input => {
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        const path = `${cardId}/cover-${Date.now()}.${ext}`;
        const { error: upErr } = await supa.storage.from("property-photos").upload(path, file, { upsert: true });
        if (upErr) { alert(`Upload failed: ${upErr.message}`); return; }
        const { data } = supa.storage.from("property-photos").getPublicUrl(path);
        const url = data.publicUrl;
        const textInput = panel.querySelector(".morby-cover-input");
        if (textInput) textInput.value = url;
        await saveCoverToAcq(url);
        await loadAll();
      });
    });

    panel.querySelectorAll(".acq-input:not(.morby-cover-input)").forEach(input => {
      const field = input.dataset.field;
      const isNumeric = input.type === "number";
      const isSelectOrDate = input.tagName === "SELECT" || input.type === "date";
      const handler = async () => {
        let v = input.value;
        if (v === "") v = null;
        else if (isNumeric) v = Number(v);
        await saveField(field, v);
        if (isSelectOrDate) await loadAll();
      };
      input.addEventListener(isSelectOrDate ? "change" : "blur", handler);
      if (isSelectOrDate) return;
      if (input.tagName === "INPUT") {
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      }
    });

    panel.querySelectorAll(".acq-toggle-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const field = btn.dataset.field;
        const raw = btn.dataset.value;
        let value;
        if (raw === "yes") value = true;
        else if (raw === "no") value = false;
        else value = raw; // e.g. "single_family"/"commercial" for property_type
        await saveField(field, value);
        await loadAll(); // re-render so property-type-dependent fields + DSCR defaults update
      });
    });
  });

  // ── Estimate taxes & insurance from purchase price + state ──
  // State effective property tax rates (% of assessed value, 2024 averages).
  const STATE_TAX_RATES = {
    AL:0.41,AK:1.04,AZ:0.62,AR:0.62,CA:0.75,CO:0.51,CT:1.79,DE:0.57,FL:0.89,
    GA:0.92,HI:0.28,ID:0.69,IL:2.23,IN:0.85,IA:1.57,KS:1.41,KY:0.83,LA:0.55,
    ME:1.09,MD:1.07,MA:1.12,MI:1.54,MN:1.12,MS:0.65,MO:0.97,MT:0.84,NE:1.73,
    NV:0.60,NH:1.89,NJ:2.47,NM:0.80,NY:1.72,NC:0.78,ND:0.98,OH:1.53,OK:0.87,
    OR:0.91,PA:1.49,RI:1.53,SC:0.57,SD:1.08,TN:0.66,TX:1.80,UT:0.57,VT:1.83,
    VA:0.82,WA:0.93,WV:0.59,WI:1.85,WY:0.61,DC:0.56
  };
  document.querySelectorAll(".estimate-ti-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const panel = document.querySelector(`.morby-panel[data-card-id="${cardId}"]`);
      const deal  = dealCache[cardId];
      if (!panel || !deal) return;

      // Read live purchase price from form.
      const priceInput = panel.querySelector('.acq-input[data-field="purchase_price"]');
      const price = Number(priceInput?.value) || Number(deal.morby?.purchase_price) || 0;
      if (!price) { alert("Enter a Purchase Price first."); return; }

      // State from the property record.
      const state = (deal.prop?.state || "").toUpperCase().trim();
      const taxRate = STATE_TAX_RATES[state] || 1.0; // fallback 1%

      const monthlyTax = Math.round(price * (taxRate / 100) / 12);
      const monthlyIns = Math.round(price * 0.007 / 12); // 0.7%/yr standard estimate

      // Fill the inputs.
      const taxInput = panel.querySelector('.acq-input[data-field="monthly_taxes"]');
      const insInput = panel.querySelector('.acq-input[data-field="monthly_insurance"]');
      if (taxInput) { taxInput.value = monthlyTax; taxInput.dispatchEvent(new Event("blur")); }
      if (insInput) { insInput.value = monthlyIns; insInput.dispatchEvent(new Event("blur")); }

      btn.textContent = "✓ Estimated";
      setTimeout(() => btn.textContent = "💡 Estimate", 2000);
    });
  });

  // ── Deal Deck PDF generation ──
  document.querySelectorAll(".morby-deck-btn").forEach(btn => {
    btn.addEventListener("click", () => generateDealDeck(btn.dataset.cardId, btn));
  });

  // ── Send Deal Deck to Stack Method buyers ──
  document.querySelectorAll(".morby-send-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const address = btn.dataset.address;
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Generating PDF…";
      try {
        await loadJsPdf();
        const pdfBase64 = await generateDealDeck(cardId, null, { returnBase64: true });
        btn.textContent = original;
        btn.disabled = false;
        openBlastModal(btn, { isMorbyDeck: true, dealDeckPdf: pdfBase64 });
      } catch (e) {
        alert(`Couldn't generate Deal Deck: ${e.message}`);
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  });

  // ── Upload LOI → AI extraction ──
  document.querySelectorAll(".morby-loi-btn").forEach(btn => {
    btn.addEventListener("click", () => extractLoi(btn));
  });

  // ── Remove a deal card. With the Trello sync retired (July 2026) this is
  // the only lifecycle control — every card (uploaded or legacy Trello-era)
  // is archived from here when it's done. ──
  document.querySelectorAll(".morby-delete-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const address = btn.dataset.address;
      if (!confirm(`Remove the deal "${address}"?`)) return;
      btn.disabled = true;
      // Soft delete: archive it (hidden from the dashboard) instead of a
      // permanent delete, so it can be undone. Nothing re-creates archived
      // cards — no sync owns deal lifecycle anymore.
      const { error } = await supa.from("properties")
        .update({ archived: true, archived_at: new Date().toISOString() })
        .eq("card_id", cardId);
      if (error) { toast(`Couldn't remove: ${error.message}`, { type: "error" }); btn.disabled = false; return; }
      toast(`Removed "${address}".`, { type: "success", actionLabel: "Undo", onAction: async () => {
        const { error: e2 } = await supa.from("properties")
          .update({ archived: false, archived_at: null }).eq("card_id", cardId);
        if (e2) { toast(`Undo failed: ${e2.message}`, { type: "error" }); return; }
        await loadAll();
      }});
      await loadAll();
    });
  });
}

async function pdfFileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function extractLoi(btn) {
  const cardId = btn.dataset.cardId;
  const panel = btn.closest(".morby-panel");
  const fileInput = panel.querySelector(".morby-loi-input");
  const statusEl = panel.querySelector(".morby-loi-status");
  const file = fileInput.files && fileInput.files[0];
  if (!file) { statusEl.textContent = "Choose a PDF first."; return; }
  if (file.type !== "application/pdf") { statusEl.textContent = "Please upload a PDF."; return; }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading PDF…";
  statusEl.textContent = "";
  try {
    const base64 = await pdfFileToBase64(file);

    btn.textContent = "Extracting with AI…";
    const { data: { session: s } } = await supa.auth.getSession();
    const res = await fetch("/.netlify/functions/parse-loi", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ card_id: cardId, pdf_base64: base64 }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Extraction failed");

    statusEl.textContent = "✓ Extracted — review the fields below.";
    await loadAll();
  } catch (e) {
    statusEl.textContent = `Couldn't extract: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── "+ Add Morby Deal" — create a brand-new card directly from an LOI upload ──
function wireAddMorbyPanel() {
  const addBtn = document.getElementById("add-morby-btn");
  const panel = document.getElementById("add-morby-panel");
  const cancelBtn = document.getElementById("add-morby-cancel");
  const submitBtn = document.getElementById("add-morby-submit");
  const fileInput = document.getElementById("add-morby-file");
  const statusEl = document.getElementById("add-morby-status");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => panel.classList.toggle("hidden"));
  cancelBtn.addEventListener("click", () => {
    panel.classList.add("hidden");
    fileInput.value = "";
    statusEl.textContent = "";
  });

  submitBtn.addEventListener("click", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { statusEl.textContent = "Choose a PDF first."; return; }
    if (file.type !== "application/pdf") { statusEl.textContent = "Please upload a PDF."; return; }

    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Reading PDF…";
    statusEl.textContent = "";
    try {
      const base64 = await pdfFileToBase64(file);
      submitBtn.textContent = "Extracting with AI…";
      const { data: { session: s } } = await supa.auth.getSession();
      const res = await fetch("/.netlify/functions/parse-loi", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ pdf_base64: base64 }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Extraction failed");
      // Open the new card in full so the extracted terms are reviewed, not
      // buried as a collapsed row.
      if (result.card_id) expandedDealCards.add(result.card_id);

      statusEl.textContent = "✓ Created — review the new card below.";
      panel.classList.add("hidden");
      fileInput.value = "";
      await loadAll();
    } catch (e) {
      statusEl.textContent = `Couldn't create deal: ${e.message}`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}

// ── "+ Add Sub-To Deal" (F5) — create a card directly from the contract +
// mortgage statement, no Trello involved. Two server calls: parse-subto
// (extract terms, create the card) then generate-copy (write the 3 marketing
// variations from the saved terms). If copy generation fails the card still
// exists — the copy can be added by hand, so that failure is only a warning.
function wireAddSubtoPanel() {
  const addBtn = document.getElementById("add-subto-btn");
  const panel = document.getElementById("add-subto-panel");
  const cancelBtn = document.getElementById("add-subto-cancel");
  const submitBtn = document.getElementById("add-subto-submit");
  const contractInput = document.getElementById("add-subto-contract");
  const statementInput = document.getElementById("add-subto-statement");
  const statusEl = document.getElementById("add-subto-status");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => panel.classList.toggle("hidden"));
  cancelBtn.addEventListener("click", () => {
    panel.classList.add("hidden");
    contractInput.value = "";
    statementInput.value = "";
    statusEl.textContent = "";
  });

  // PDF or the image types Claude accepts. HEIC (default iPhone photo format)
  // is deliberately excluded — Claude's API rejects it — so we steer the user
  // to convert rather than fail server-side with a cryptic message.
  const SUBTO_ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];

  submitBtn.addEventListener("click", async () => {
    const contract = contractInput.files && contractInput.files[0];
    const statement = statementInput.files && statementInput.files[0];
    if (!contract) { statusEl.textContent = "Choose the contract file first."; return; }
    if (!statement) { statusEl.textContent = "Choose the mortgage statement file — it's required."; return; }
    if (!SUBTO_ALLOWED.includes(contract.type) || !SUBTO_ALLOWED.includes(statement.type)) {
      statusEl.textContent = "Files must be PDF, JPG, PNG, GIF, or WebP. (iPhone HEIC photos: convert to JPG first.)";
      return;
    }
    // Base64 inflates ~4/3 and the whole payload must fit one function call.
    if (contract.size + statement.size > 4 * 1024 * 1024) {
      statusEl.textContent = "Files too large — keep the combined size under 4 MB (compress/re-save, or screenshot a smaller region).";
      return;
    }

    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Reading files…";
    statusEl.textContent = "";
    try {
      // Send each file with its media type so the server can pick the right
      // Claude content block (document for PDF, image for JPG/PNG/etc.).
      const filePayload = async (f) => ({ media_type: f.type, data: await pdfFileToBase64(f) });
      const body = {
        contract: await filePayload(contract),
        statement: await filePayload(statement),
      };

      submitBtn.textContent = "Extracting terms with AI…";
      const { data: { session: s } } = await supa.auth.getSession();
      const res = await fetch("/.netlify/functions/parse-subto", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Extraction failed");
      // Open the new card in full so the extracted terms are reviewed, not
      // buried as a collapsed row.
      if (result.card_id) expandedDealCards.add(result.card_id);

      submitBtn.textContent = "Writing marketing copy…";
      let copyError = null;
      try {
        const copyRes = await fetch("/.netlify/functions/generate-copy", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
          body: JSON.stringify({ card_id: result.card_id }),
        });
        const copyResult = await copyRes.json();
        if (!copyRes.ok) throw new Error(copyResult.error || "copy generation failed");
      } catch (copyErr) {
        // The card exists; only the copy is missing. Don't fail the whole flow.
        copyError = copyErr.message;
      }

      panel.classList.add("hidden");
      contractInput.value = "";
      statementInput.value = "";
      await loadAll(); // re-renders #content, so report via toast (survives the re-render)
      if (copyError) {
        toast(`Deal created, but copy generation failed (${copyError}) — add copy manually.`, { type: "error" });
      } else {
        toast("✓ Sub-To deal created with terms + marketing copy — review the card.", { type: "success" });
      }
    } catch (e) {
      statusEl.textContent = `Couldn't create deal: ${e.message}`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}

async function generateDealDeck(cardId, btn, { returnBase64 = false } = {}) {
  const deal = dealCache[cardId];
  if (!deal) return;
  const p = deal.prop, t = deal.terms || {};
  // Use live values straight from the form, so an edited field that
  // hasn't blurred (and therefore hasn't saved to morby_deals yet) is
  // still reflected in the generated deck.
  const m = { ...(deal.morby || {}) };
  const morbyPanel = document.querySelector(`.morby-panel[data-card-id="${cardId}"]`);
  if (morbyPanel) {
    morbyPanel.querySelectorAll(".acq-input[data-field]").forEach(input => {
      const field = input.dataset.field;
      if (input.value === "") { m[field] = null; return; }
      m[field] = input.type === "number" ? Number(input.value) : input.value;
    });
  }
  const dealAddress = (m.address_override || "").trim() || p.name || "";
  const propertyType = m.property_type || "single_family";
  const defaults = MORBY_DSCR_DEFAULTS[propertyType] || MORBY_DSCR_DEFAULTS.single_family;
  const dscrRate = m.dscr_rate != null ? Number(m.dscr_rate) : defaults.rate;
  const dscrLtv = m.dscr_ltv != null ? Number(m.dscr_ltv) : defaults.ltv;
  const dscrCredit = m.dscr_credit_score != null ? m.dscr_credit_score : defaults.credit;
  const price = Number(m.purchase_price) || 0;
  const loanAmount = price * (dscrLtv / 100);
  const monthlyDebtService = dscrMonthlyPayment(price, dscrRate, dscrLtv);

  // Cash the buyer receives at close (same formula as the Stack Method email):
  //   loan proceeds − down payment − 5% closing costs − additional broker
  //   commission, split in half. Shown as a headline figure only when positive.
  const addlBrokerPct = Number(m.additional_broker_pct) || 0;
  const addlBrokerFee = price * (addlBrokerPct / 100);
  const cashToBuyerAtClose = (loanAmount - (Number(m.down_payment) || 0) - price * 0.05 - addlBrokerFee) / 2;

  const fmt = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
  const fmtPct = (n) => `${Number(n) || 0}%`;

  const balloonYears = m.balloon_months ? (Number(m.balloon_months) / 12).toFixed(1).replace(/\.0$/, "") : "—";

  // Plain key/value rows for each section — laid out manually with jsPDF
  // (no html2canvas / off-screen DOM rendering, which was producing blank pages).
  const loiRows = [
    ["Purchase Price", fmt(m.purchase_price), true],
    ["Down Payment / EMD", fmt(m.down_payment)],
    ["Earnest Money", fmt(m.earnest_money_amount)],
    ["Closing Costs", m.closing_costs_note || "Buyer pays all closing costs"],
    ["Broker Commission", m.broker_commission || "None"],
  ];
  if (addlBrokerPct > 0) {
    loiRows.push(["Listing Agent Commission", `${addlBrokerPct}% (${fmt(addlBrokerFee)})`]);
  }
  // Seller-financed balance can accrue under two structures:
  //  - "deferred": interest compounds with no payments — the full
  //    principal PLUS all accrued interest is due at balloon, so the
  //    payoff grows over the term.
  //  - "interest_only": no compounding growth — the balloon payoff
  //    equals the original carry balance.
  const interestType = m.interest_type || "deferred";
  const carryBalance = Number(m.seller_carry_balance) || 0;
  const balloonYearsNum = m.balloon_months ? Number(m.balloon_months) / 12 : 0;
  const balloonPayoff = (interestType === "deferred" && m.deferred_interest_rate && balloonYearsNum)
    ? carryBalance * Math.pow(1 + (Number(m.deferred_interest_rate) / 100), balloonYearsNum)
    : carryBalance;
  const sellerFinancingTitle = interestType === "interest_only"
    ? "Seller Financing (Interest Only)"
    : "Seller Financing (Deferred Interest)";

  const financingRows = [
    ["Seller Carry Balance", fmt(m.seller_carry_balance), true],
    [interestType === "interest_only" ? "Interest Rate (Interest Only)" : "Deferred Interest Rate", fmtPct(m.deferred_interest_rate)],
    ["Monthly Payment During Deferral", fmt(m.monthly_payment || 0)],
    ["Balloon", m.balloon_months ? `${m.balloon_months} months (${balloonYears} yrs)` : "—"],
  ];
  // For deferred-interest deals where interest compounds, show the actual
  // payoff amount due at balloon (principal + all accrued interest) if
  // it's materially larger than the original carry balance.
  if (interestType === "deferred" && balloonPayoff > carryBalance + 0.5) {
    financingRows.push(["Balloon Payoff Amount", fmt(balloonPayoff), true]);
  }
  const timelineRows = [
    ["Inspection Period", `${m.inspection_period_days != null ? m.inspection_period_days : 15} days`],
    ["Close of Escrow", `${m.close_of_escrow_days != null ? m.close_of_escrow_days : 30} days`],
    ["Financing Contingency", m.financing_contingency === false ? "No" : "Yes"],
  ];
  const fmtExpense = (n) => `(${fmt(n)})`;
  const dscrRows = [
    ["DSCR Assumptions", `${fmtPct(dscrRate)} / ${fmtPct(dscrLtv)} LTV / ${dscrCredit} credit`],
    ["Loan Amount", fmt(loanAmount)],
    ["DSCR Loan Payment", fmt(monthlyDebtService)],
  ];

  // Cash Flow Analysis is laid out as a simple P&L: income, less debt
  // service (DSCR loan + seller financing), equals net cash flow.
  const sellerPmt  = Number(m.monthly_payment)   || 0;
  const taxes      = Number(m.monthly_taxes)      || 0;
  const insurance  = Number(m.monthly_insurance)  || 0;
  let cashFlowLeftRows, cashFlowRightRows;
  let cashFlowHeadlineLtr, cashFlowHeadlineStr, cashFlowLabelLtr, cashFlowLabelStr;
  if (propertyType === "commercial") {
    const noi = m.monthly_noi != null ? Number(m.monthly_noi) : (Number(m.annual_noi) || 0) / 12;
    const netCashFlow = noi - monthlyDebtService - sellerPmt - taxes - insurance;
    cashFlowLeftRows = [
      ["Net Operating Income",   fmt(noi)],
      ["DSCR Loan Payment",      fmtExpense(monthlyDebtService)],
      ["Seller Financing Pmt",   fmtExpense(sellerPmt)],
      ...(taxes     ? [["Property Taxes",   fmtExpense(taxes)]]     : []),
      ...(insurance ? [["Insurance",         fmtExpense(insurance)]] : []),
      ["Net Cash Flow",          fmt(netCashFlow), true],
    ];
    cashFlowRightRows = [];
    cashFlowHeadlineLtr = fmt(netCashFlow);
    cashFlowHeadlineStr = fmt(netCashFlow);
    cashFlowLabelLtr = "Net Cash Flow";
    cashFlowLabelStr = "Net Cash Flow";
  } else {
    const ltr = Number(m.ltr_monthly_rent) || 0;
    const str = Number(m.str_monthly_rent) || 0;
    const ltrNet = ltr - monthlyDebtService - sellerPmt - taxes - insurance;
    const strNet = str - monthlyDebtService - sellerPmt - taxes - insurance;
    cashFlowLeftRows = [
      ["Rental Income (LTR)",  fmt(ltr)],
      ["DSCR Loan Payment",    fmtExpense(monthlyDebtService)],
      ["Seller Financing Pmt", fmtExpense(sellerPmt)],
      ...(taxes     ? [["Property Taxes",  fmtExpense(taxes)]]     : []),
      ...(insurance ? [["Insurance",        fmtExpense(insurance)]] : []),
      ["Net Cash Flow",        fmt(ltrNet), true],
    ];
    cashFlowRightRows = [
      ["Rental Income (STR)",  fmt(str)],
      ["DSCR Loan Payment",    fmtExpense(monthlyDebtService)],
      ["Seller Financing Pmt", fmtExpense(sellerPmt)],
      ...(taxes     ? [["Property Taxes",  fmtExpense(taxes)]]     : []),
      ...(insurance ? [["Insurance",        fmtExpense(insurance)]] : []),
      ["Net Cash Flow",        fmt(strNet), true],
    ];
    cashFlowHeadlineLtr = fmt(ltrNet);
    cashFlowHeadlineStr = fmt(strNet);
    cashFlowLabelLtr = "Net Cash Flow (LTR)";
    cashFlowLabelStr = "Net Cash Flow (STR)";
  }

  // Brand colors from seasidehorizon.com
  const NAVY = [0, 45, 114];
  const NAVY_DARK = [0, 32, 84];
  const GOLD = [217, 164, 65];
  const GREY = [102, 102, 102];

  const original = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "Generating…"; btn.disabled = true; }
  try {
    await loadJsPdf();
    const logoDataUrl = await loadLogoDataUrl();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginX = 48;
    const colW = pageW - marginX * 2;
    let y = 0;

    const ensureSpace = (needed) => {
      if (y + needed > pageH - 48) { doc.addPage(); y = 48; }
    };

    // ── Header ──
    doc.setFillColor(...GOLD);
    doc.rect(0, 0, pageW, 6, "F");
    y = 34;
    const logoSize = 30;
    let textX = marginX;
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, "PNG", marginX, y - 22, logoSize, logoSize);
        textX = marginX + logoSize + 10;
      } catch (e) { /* ignore logo failures, fall back to text-only header */ }
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...NAVY);
    doc.text("Seaside Horizon", textX, y);
    y += 18;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(2);
    doc.line(marginX, y, pageW - marginX, y);
    y += 22;

    // ── Title ──
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...NAVY_DARK);
    doc.text(`Deal Info — ${dealAddress}`, marginX, y);
    y += 14;
    y += 8;

    // ── Deal Summary highlight box ──
    const summaryBoxH = 64;
    ensureSpace(summaryBoxH + 16);
    doc.setFillColor(...NAVY);
    doc.roundedRect(marginX, y, colW, summaryBoxH, 6, 6, "F");
    // Commercial deals are NOI-based (a single cash flow number), so the
    // LTR/STR side-by-side split only applies to single-family.
    // Cash at Close is the buyer's headline number — surface it as a
    // summary column (only when positive) instead of a separate band, so
    // the deck stays one page.
    const cashStat = cashToBuyerAtClose > 0 ? [["Cash at Close", fmt(cashToBuyerAtClose)]] : [];
    const summaryStats = propertyType === "commercial"
      ? [
          ["Purchase Price", fmt(m.purchase_price)],
          ...cashStat,
          ["Seller Carry Balance", fmt(m.seller_carry_balance)],
          [cashFlowLabelLtr, cashFlowHeadlineLtr],
          ["Balloon", m.balloon_months ? `${balloonYears} yrs` : "—"],
        ]
      : [
          ["Purchase Price", fmt(m.purchase_price)],
          ...cashStat,
          ["Seller Carry Balance", fmt(m.seller_carry_balance)],
          [cashFlowLabelLtr, cashFlowHeadlineLtr],
          [cashFlowLabelStr, cashFlowHeadlineStr],
          ["Balloon", m.balloon_months ? `${balloonYears} yrs` : "—"],
        ];
    const cellW = colW / summaryStats.length;
    summaryStats.forEach(([label, value], i) => {
      const cx = marginX + cellW * i + cellW / 2;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(255, 255, 255);
      const labelW = doc.getTextWidth(label.toUpperCase());
      doc.text(label.toUpperCase(), cx - labelW / 2, y + 22);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...GOLD);
      const valW = doc.getTextWidth(value);
      doc.text(value, cx - valW / 2, y + 42);
      if (i > 0) {
        doc.setDrawColor(60, 90, 140);
        doc.setLineWidth(0.5);
        doc.line(marginX + cellW * i, y + 12, marginX + cellW * i, y + summaryBoxH - 12);
      }
    });
    y += summaryBoxH + 18;

    let rowIndex = 0;
    const sectionHeader = (title) => {
      ensureSpace(28);
      doc.setFillColor(245, 247, 250);
      doc.rect(marginX - 6, y - 13, colW + 12, 21, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...NAVY);
      doc.text(title, marginX, y);
      y += 5;
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.5);
      doc.line(marginX, y, pageW - marginX, y);
      y += 15;
      rowIndex = 0;
    };

    const row = (label, value, bold) => {
      ensureSpace(17);
      if (rowIndex % 2 === 0) {
        doc.setFillColor(250, 250, 252);
        doc.rect(marginX - 6, y - 11, colW + 12, 15, "F");
      }
      rowIndex++;
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 30, 46);
      if (bold) {
        doc.setDrawColor(...NAVY);
        doc.setLineWidth(1);
        doc.line(marginX, y - 9, pageW - marginX, y - 9);
      }
      doc.text(String(label), marginX, y);
      const valText = String(value);
      const valW = doc.getTextWidth(valText);
      doc.text(valText, marginX + colW - valW, y);
      y += 15;
    };

    const paragraph = (text) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(30, 30, 46);
      const lines = doc.splitTextToSize(text, colW);
      for (const line of lines) {
        ensureSpace(12);
        doc.text(line, marginX, y);
        y += 11.5;
      }
      y += 4;
    };

    // Bulleted list — used for the Investment Highlights summary.
    const bulletParagraph = (text) => {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 30, 46);
      const lines = doc.splitTextToSize(text, colW - 14);
      lines.forEach((line, idx) => {
        ensureSpace(13);
        if (idx === 0) {
          doc.setTextColor(...GOLD);
          doc.text("•", marginX, y);
          doc.setTextColor(30, 30, 46);
        }
        doc.text(line, marginX + 12, y);
        y += 12.5;
      });
      y += 2;
    };

    // A single label/value row drawn within an arbitrary column (x, width) —
    // used by twoColumnSection() to lay out two side-by-side mini-sections.
    const rowAt = (x, w, label, value, bold, idx) => {
      if (idx % 2 === 0) {
        doc.setFillColor(250, 250, 252);
        doc.rect(x - 6, y - 11, w + 12, 15, "F");
      }
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 30, 46);
      if (bold) {
        doc.setDrawColor(...NAVY);
        doc.setLineWidth(1);
        doc.line(x, y - 9, x + w, y - 9);
      }
      doc.text(String(label), x, y);
      const valText = String(value);
      const valW = doc.getTextWidth(valText);
      doc.text(valText, x + w - valW, y);
    };

    // Two side-by-side mini-sections sharing a single row of headers —
    // used to pack Timeline & Contingencies next to DSCR Loan.
    const twoColumnSection = (leftTitle, leftRows, rightTitle, rightRows) => {
      const gap = 20;
      const halfW = (colW - gap) / 2;
      const maxRows = Math.max(leftRows.length, rightRows.length);
      ensureSpace(20 + maxRows * 15 + 5);
      doc.setFillColor(245, 247, 250);
      doc.rect(marginX - 6, y - 13, halfW + 12, 21, "F");
      doc.rect(marginX + halfW + gap - 6, y - 13, halfW + 12, 21, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10.5);
      doc.setTextColor(...NAVY);
      doc.text(leftTitle, marginX, y);
      doc.text(rightTitle, marginX + halfW + gap, y);
      y += 5;
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.5);
      doc.line(marginX, y, marginX + halfW, y);
      doc.line(marginX + halfW + gap, y, marginX + halfW + gap + halfW, y);
      y += 15;
      for (let i = 0; i < maxRows; i++) {
        if (leftRows[i]) rowAt(marginX, halfW, leftRows[i][0], leftRows[i][1], leftRows[i][2], i);
        if (rightRows[i]) rowAt(marginX + halfW + gap, halfW, rightRows[i][0], rightRows[i][1], rightRows[i][2], i);
        y += 15;
      }
    };

    // ── Investment Highlights ──
    const highlights = [];
    if (m.seller_carry_balance) {
      const paymentPart = m.monthly_payment
        ? `payments of ${fmt(m.monthly_payment)}/mo`
        : "no monthly payments";
      const balloonPart = m.balloon_months
        ? `, with the balance due at a ${balloonYears}-year balloon`
        : "";
      const interestPart = interestType === "interest_only"
        ? "an interest-only basis"
        : `${fmtPct(m.deferred_interest_rate)} deferred interest`;
      highlights.push(`Seller carries ${fmt(m.seller_carry_balance)} on ${interestPart} with ${paymentPart}${balloonPart}.`);
    }
    if (propertyType === "commercial") {
      const noi = m.monthly_noi != null ? Number(m.monthly_noi) : (Number(m.annual_noi) || 0) / 12;
      highlights.push(`Projected monthly cash flow of ${cashFlowHeadlineLtr} based on ${fmt(noi)}/mo NOI at ${fmtPct(dscrLtv)} LTV / ${fmtPct(dscrRate)} DSCR terms.`);
    } else {
      highlights.push(`Projected cash flow of ${cashFlowHeadlineLtr}/mo (long-term rental) or ${cashFlowHeadlineStr}/mo (short-term rental) at ${fmtPct(dscrLtv)} LTV / ${fmtPct(dscrRate)} DSCR terms.`);
    }
    if (m.purchase_price) {
      const dpPart = m.down_payment ? ` with ${fmt(m.down_payment)} down` : "";
      highlights.push(`Total purchase price of ${fmt(m.purchase_price)}${dpPart}.`);
    }
    if (highlights.length) {
      sectionHeader("Investment Highlights");
      highlights.forEach(bulletParagraph);
      y += 3;
    }

    sectionHeader("LOI / Financial Terms");
    loiRows.forEach(([l, v, b]) => row(l, v, b));
    y += 5;

    sectionHeader(sellerFinancingTitle);
    financingRows.forEach(([l, v, b]) => row(l, v, b));
    y += 5;

    twoColumnSection("Timeline & Contingencies", timelineRows, "DSCR Loan", dscrRows);
    y += 5;

    if (cashFlowRightRows.length) {
      twoColumnSection("Net Cash Flow (LTR)", cashFlowLeftRows, "Net Cash Flow (STR)", cashFlowRightRows);
    } else {
      sectionHeader("Cash Flow Analysis");
      cashFlowLeftRows.forEach(([l, v, b]) => row(l, v, b));
    }
    y += 5;

    if (m.seller_flexibility_notes) {
      sectionHeader("Seller Flexibility");
      paragraph(m.seller_flexibility_notes);
      y += 5;
    }

    // Property Details goes last — supporting context after the numbers.
    if (m.tenancy_description || m.property_description) {
      sectionHeader("Property Details");
      if (m.tenancy_description) paragraph(`Tenancy: ${m.tenancy_description}`);
      if (m.property_description) paragraph(m.property_description);
    }

    // ── Footer on every page ──
    const preparedOn = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setDrawColor(...GOLD);
      doc.setLineWidth(1.5);
      doc.line(marginX, pageH - 40, pageW - marginX, pageH - 40);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 160);
      const footer = "Seaside Horizon · Confidential — for review purposes only";
      const fw = doc.getTextWidth(footer);
      doc.text(footer, (pageW - fw) / 2, pageH - 26);
      doc.text(`Prepared ${preparedOn}`, marginX, pageH - 26);
      const pageLabel = `Page ${i} of ${pageCount}`;
      const pw = doc.getTextWidth(pageLabel);
      doc.text(pageLabel, pageW - marginX - pw, pageH - 26);
    }

    const filename = `Deal Deck - ${(dealAddress || cardId).replace(/[\\/:*?"<>|]/g, "")}.pdf`;
    if (returnBase64) return doc.output("datauristring");
    doc.save(filename);
  } catch (e) {
    if (returnBase64) throw e;
    alert(`Couldn't generate PDF: ${e.message}`);
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

let _logoDataUrlPromise = null;
function loadLogoDataUrl() {
  if (_logoDataUrlPromise) return _logoDataUrlPromise;
  _logoDataUrlPromise = fetch("/img/logo.png")
    .then((r) => r.blob())
    .then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }))
    .catch(() => null);
  return _logoDataUrlPromise;
}

let _jsPdfPromise = null;
function loadJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
  if (_jsPdfPromise) return _jsPdfPromise;
  _jsPdfPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Failed to load PDF library"));
    document.head.appendChild(script);
  });
  return _jsPdfPromise;
}

let activeLead = null; // { cardId, address, lead | null, buyerId | null }

function openLeadModal({ cardId, address, lead = null, prefill = null }) {
  activeLead = { cardId, address, lead };
  document.getElementById("lead-modal-title").textContent = lead ? "Update Lead" : "Add Lead";
  document.getElementById("lead-modal-sub").textContent = address || "";
  document.getElementById("lead-name").value = (lead && lead.name) || (prefill && prefill.name) || "";
  document.getElementById("lead-contact").value = (lead && lead.contact) || (prefill && prefill.contact) || "";
  document.getElementById("lead-source").value = (lead && lead.source) || (prefill && prefill.source) || "buyer_blast";
  document.getElementById("lead-channel").value = (lead && lead.channel) || (prefill && prefill.channel) || "";
  document.getElementById("lead-stage").value = (lead && lead.stage) || (prefill && prefill.stage) || "new";
  document.getElementById("lead-notes").value = (lead && lead.notes) || "";
  document.getElementById("lead-modal-delete").style.display = lead ? "inline-flex" : "none";
  // If we're logging an outcome for a known buyer, lock name/contact/source/buyer linkage
  activeLead.buyerId = (prefill && prefill.buyerId) || (lead && lead.buyer_id) || null;
  document.getElementById("lead-modal-backdrop").classList.remove("hidden");
}
function closeLeadModal() {
  document.getElementById("lead-modal-backdrop").classList.add("hidden");
  activeLead = null;
}
async function saveLead() {
  if (!activeLead) return;
  const name = document.getElementById("lead-name").value.trim();
  if (!name) { alert("Enter a name for this lead."); return; }
  const row = {
    card_id: activeLead.cardId,
    address: activeLead.address,
    buyer_id: activeLead.buyerId || null,
    name,
    contact: document.getElementById("lead-contact").value.trim(),
    source: document.getElementById("lead-source").value,
    channel: document.getElementById("lead-channel").value,
    stage: document.getElementById("lead-stage").value,
    notes: document.getElementById("lead-notes").value.trim(),
  };
  const saveBtn = document.getElementById("lead-modal-save");
  saveBtn.disabled = true;
  try {
    if (activeLead.lead) {
      await supa.from("deal_leads").update(row).eq("id", activeLead.lead.id);
    } else {
      await supa.from("deal_leads").insert(row);
    }
    closeLeadModal();
    loadAll();
  } catch (e) {
    alert("Couldn't save lead: " + e.message);
  } finally {
    saveBtn.disabled = false;
  }
}
async function deleteLead() {
  if (!activeLead || !activeLead.lead) return;
  if (!confirm(`Remove "${activeLead.lead.name}" from this deal's pipeline?`)) return;
  const { error } = await supa.from("deal_leads").delete().eq("id", activeLead.lead.id);
  if (error) { toast(`Couldn't remove lead: ${error.message}`, { type: "error" }); return; }
  closeLeadModal();
  loadAll();
}

let activeBlast = null; // { cardId, address, statusEl, matched, isMorbyDeck?, dealDeckPdf? }

function openBlastModal(btn, { isMorbyDeck = false, dealDeckPdf = null, followUpIds = null } = {}) {
  const cardId = btn.dataset.cardId;
  const address = btn.dataset.address;
  // Morby cards don't have a .blast-status el in the same .flex-between — use card header
  const statusEl = btn.closest(".flex-between")?.querySelector(".blast-status") || btn.closest(".card")?.querySelector(".blast-status") || btn;
  const deal = dealCache[cardId];
  const matched = (deal && deal.matched) || [];
  const variations = isMorbyDeck ? [] : ((deal && deal.prop && deal.prop.variations) || []);
  // Deal params let us score any buyer (even ones not auto-matched) when the
  // user filters the "Choose specific buyers" list by method.
  const dealParams = deal
    ? { state: deal.prop.state, price: Number(deal.terms?.price) || 0, piti: Number(deal.terms?.piti) || 0, beds: Number(deal.terms?.beds) || 0 }
    : { state: "", price: 0, piti: 0, beds: 0 };
  activeBlast = { cardId, address, statusEl, matched, variations, isMorbyDeck, dealDeckPdf, dealParams, selectedIds: new Set() };

  const varSel = document.getElementById("blast-variation-select");
  const varField = document.getElementById("blast-variation-field");
  const varPreview = document.getElementById("blast-variation-preview");
  if (variations.length) {
    varField.classList.remove("hidden");
    varSel.innerHTML = variations.map((v, i) => `<option value="${i}">${escapeHtml(v.title || `Variation ${i + 1}`)}</option>`).join("");
    const updatePreview = () => {
      const v = variations[Number(varSel.value)] || {};
      varPreview.textContent = (v.body || "").slice(0, 240) + ((v.body || "").length > 240 ? "…" : "");
    };
    varSel.onchange = updatePreview;
    varSel.value = "0";
    updatePreview();
  } else {
    varField.classList.add("hidden");
    varSel.innerHTML = "";
    varPreview.textContent = "";
  }

  document.getElementById("blast-modal-title").textContent = isMorbyDeck ? `Send Deal Deck — ${address}` : `Send Blast — ${address}`;
  document.getElementById("blast-modal-sub").textContent = isMorbyDeck
    ? `Deal Deck PDF will be emailed to ${matched.length} Stack Method buyer${matched.length === 1 ? "" : "s"}.`
    : `${matched.length} buyer${matched.length === 1 ? "" : "s"} match this deal's state${matched.some(b=>b.max_price||b.max_piti||b.min_beds) ? " & criteria" : ""}.`;
  document.getElementById("blast-mode-all").checked = true;
  document.getElementById("blast-buyer-list").classList.add("hidden");
  document.getElementById("blast-all-count").textContent = `(${matched.length})`;
  document.getElementById("blast-ch-email").checked = true;
  document.getElementById("blast-ch-sms").checked = true;

  // Pre-select every deal-matched buyer (prior default). Selection is a Set
  // so it survives switching between method groups.
  activeBlast.selectedIds = new Set(matched.map(b => b.id));
  renderMethodChips();
  selectMethodGroup("__matched");

  // Follow-up mode: target exactly the non-engaged recipients, email-only
  // by default, and lead with a different copy variation for the 2nd touch.
  if (followUpIds && followUpIds.length) {
    activeBlast.followUp = true;
    activeBlast.selectedIds = new Set(followUpIds);
    document.getElementById("blast-mode-select").checked = true;
    document.getElementById("blast-buyer-list").classList.remove("hidden");
    document.getElementById("blast-ch-sms").checked = false;
    document.getElementById("blast-modal-title").textContent = `Follow-up — ${address}`;
    document.getElementById("blast-modal-sub").textContent =
      `${followUpIds.length} recipient${followUpIds.length === 1 ? "" : "s"} never opened, clicked, or viewed the first blast. Only they will get this.`;
    if (variations.length > 1) { varSel.value = "1"; varSel.onchange && varSel.onchange(); }
    selectMethodGroup("__matched");
  }

  document.getElementById("blast-modal-backdrop").classList.remove("hidden");
}

// Score any buyer against the active deal (matched buyers arrive pre-scored).
function decorateBuyer(b) {
  if (b._score !== undefined) return b;
  const { state, price, piti, beds } = activeBlast.dealParams;
  const { score, reasons, missing } = scoreBuyerForDeal(b, state, price, piti, beds);
  return { ...b, _score: score, _reasons: reasons, _missing: missing };
}

// Method-filter chips: "Matched to this deal" plus one per buyer method that
// has buyers. Picking a method shows ALL active buyers of that method.
function renderMethodChips() {
  const wrap = document.getElementById("blast-method-filter");
  const groups = {};
  for (const b of allBuyers) {
    const methods = String(b.strategy || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
    for (const m of (methods.length ? methods : ["all"])) (groups[m] ||= []).push(b);
  }
  activeBlast.methodGroups = groups;
  const chips = [{ key: "__matched", label: "Matched to this deal", count: activeBlast.matched.length }];
  for (const key of METHOD_ORDER) if (groups[key] && groups[key].length) chips.push({ key, label: METHOD_LABELS[key], count: groups[key].length });
  wrap.innerHTML = chips.map(c =>
    `<button type="button" class="btn btn-ghost btn-sm blast-method-chip" data-key="${c.key}" style="font-size:0.74rem">${escapeHtml(c.label)} <span class="muted">(${c.count})</span></button>`
  ).join("");
  wrap.querySelectorAll(".blast-method-chip").forEach(chip =>
    chip.addEventListener("click", () => selectMethodGroup(chip.dataset.key)));
}

function selectMethodGroup(key) {
  activeBlast.activeMethod = key;
  document.querySelectorAll(".blast-method-chip").forEach(chip => {
    const on = chip.dataset.key === key;
    chip.style.background = on ? "var(--navy, #1B3A6B)" : "";
    chip.style.color = on ? "#fff" : "";
  });
  const list = key === "__matched"
    ? activeBlast.matched
    : (activeBlast.methodGroups[key] || []).map(decorateBuyer).sort((a, b) => b._score - a._score);
  renderBlastCheckboxes(list);
}

function updateSelectedCount() {
  const el = document.getElementById("blast-selected-count");
  if (el) el.textContent = `${activeBlast.selectedIds.size} selected total`;
}

function renderBlastCheckboxes(list) {
  const box = document.getElementById("blast-buyer-checkboxes");
  const sel = activeBlast.selectedIds;
  box.innerHTML = list.map(raw => {
    const b = decorateBuyer(raw);
    const score = b._score ?? 0;
    const reasons = b._reasons || [];
    const missing = b._missing || [];
    const scoreColor = score >= 70 ? "#2F855A" : score >= 45 ? "#B7791F" : "#A0AEC0";
    const checked = sel.has(b.id) ? "checked" : "";
    return `
    <label style="display:flex;flex-direction:column;gap:2px;padding:6px 0;font-weight:400;color:var(--text-1);font-size:0.86rem;border-bottom:1px solid var(--border, #eee)">
      <span style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" class="blast-buyer-cb" value="${b.id}" ${checked} style="width:auto">
        <span class="pill pill-tier-${b.tier}" style="font-size:0.66rem">${escapeHtml(b.tier || "B")}</span>
        <span style="font-size:0.7rem;font-weight:700;color:${scoreColor}" title="Match score">${score}</span>
        <strong>${escapeHtml(b.name)}</strong>
        <span class="muted">${escapeHtml(b.email || b.phone || "")}</span>
        ${b.sms_opt_in ? '<span class="muted" style="font-size:0.7rem">📱</span>' : ""}
        ${missing.length ? `<span style="font-size:0.66rem;color:#C53030;font-weight:600" title="Missing ${missing.join(', ')}">⚠ no ${missing.join("/")}</span>` : ""}
        <button type="button" class="btn btn-ghost btn-sm buyer-link-btn" data-buyer-id="${b.id}" style="margin-left:auto;font-size:0.7rem;padding:2px 8px" title="Copy this buyer's personal tracked deck link — views and Interested taps from it attribute to them, same as a blast">🔗</button>
        <button type="button" class="btn btn-ghost btn-sm log-outcome-btn" data-buyer-id="${b.id}" data-name="${escapeHtml(b.name)}" data-contact="${escapeHtml(b.email || b.phone || "")}" style="font-size:0.7rem;padding:2px 8px" title="Log this buyer's response in the deal pipeline">📋 Log</button>
      </span>
      ${reasons.length ? `<span class="muted" style="font-size:0.72rem;padding-left:26px">${reasons.map(escapeHtml).join(" · ")}</span>` : ""}
    </label>`;
  }).join("") || `<span class="muted" style="font-size:0.84rem">No buyers in this group.</span>`;

  box.querySelectorAll(".blast-buyer-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      const id = Number(cb.value);
      if (cb.checked) sel.add(id); else sel.delete(id);
      updateSelectedCount();
    });
  });
  // Per-buyer tokenized deck link — for manual DMs/texts outside a blast.
  box.querySelectorAll(".buyer-link-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      try {
        const url = await fetchDeckLink(activeBlast.cardId, Number(btn.dataset.buyerId));
        await copyText(url);
        btn.textContent = "✓";
      } catch (err) {
        alert(`Couldn't get the link: ${err.message}`);
        btn.textContent = label; btn.disabled = false;
        return;
      }
      btn.disabled = false;
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
  });
  box.querySelectorAll(".log-outcome-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { cardId, address } = activeBlast;
      const existing = (dealCache[cardId]?.leads || []).find(l => String(l.buyer_id) === btn.dataset.buyerId);
      if (existing) {
        openLeadModal({ cardId, address, lead: existing });
      } else {
        openLeadModal({ cardId, address, prefill: { name: btn.dataset.name, contact: btn.dataset.contact, source: "buyer_blast", channel: "email", stage: "responded", buyerId: Number(btn.dataset.buyerId) } });
      }
    });
  });
  updateSelectedCount();
}
function closeBlastModal() {
  document.getElementById("blast-modal-backdrop").classList.add("hidden");
  activeBlast = null;
}

function selectedBuyerIds() {
  const mode = document.querySelector('input[name="blast-recipients-mode"]:checked').value;
  if (mode === "all") return null; // null = let the server use its own "all matching" logic
  // Selection is tracked in a Set that persists across method groups, so
  // read it directly rather than only the currently-visible checkboxes.
  return activeBlast && activeBlast.selectedIds ? [...activeBlast.selectedIds] : [];
}

async function runBlast({ test }) {
  if (!activeBlast) return;
  const { cardId, address, statusEl } = activeBlast;
  const buyerIds = selectedBuyerIds();
  const targetCount = buyerIds ? buyerIds.length : activeBlast.matched.length;

  if (buyerIds && !buyerIds.length) { alert("Select at least one buyer, or choose \"All matching buyers\"."); return; }

  const channels = [];
  if (document.getElementById("blast-ch-email").checked) channels.push("email");
  if (document.getElementById("blast-ch-sms").checked) channels.push("sms");
  if (!channels.length) { alert("Pick at least one channel — Email or SMS."); return; }
  const chLabel = channels.map(c => c === "email" ? "email" : "text").join(" + ");

  if (test) {
    if (!confirm(`Send a TEST preview (${chLabel}) for "${address}" to your own email/phone only? This will NOT reach any buyers.`)) return;
  } else {
    // Resend's free tier hard-caps sending at 100 emails/day: past the cap
    // the rest of the blast fails (rows land as 'failed' in the ledger, so
    // "↻ Retry failed" can finish the job tomorrow — or upgrade the plan).
    const RESEND_FREE_DAILY_LIMIT = 100;
    const idSet = buyerIds ? new Set(buyerIds) : null;
    const emailAudience = channels.includes("email")
      ? activeBlast.matched.filter(b => (!idSet || idSet.has(Number(b.id))) && b.email && !b.email_opt_out).length
      : 0;
    const budgetWarning = emailAudience > RESEND_FREE_DAILY_LIMIT
      ? `\n\n⚠️ Resend free tier: only ~${RESEND_FREE_DAILY_LIMIT} of these ${emailAudience} emails can send today — the rest will log as failed. Use "↻ Retry failed" tomorrow to finish, or upgrade Resend.`
      : "";
    if (!confirm(`⚠️ LIVE SEND: ${chLabel} the deal alert for "${address}" to ${targetCount} buyer${targetCount === 1 ? "" : "s"}? This cannot be undone.${budgetWarning}`)) return;
    if (!confirm(`Are you absolutely sure? This sends real messages to real buyers right now.`)) return;
  }

  const sendBtn = document.getElementById("blast-modal-send");
  const testBtn = document.getElementById("blast-modal-test");
  sendBtn.disabled = true; testBtn.disabled = true;
  const busyBtn = test ? testBtn : sendBtn;
  const busyLabel = busyBtn.textContent;
  busyBtn.textContent = test ? "Sending test…" : "Sending…";
  statusEl.textContent = "";
  statusEl.style.color = "";

  try {
    const { data: { session: s } } = await supa.auth.getSession();
    const body = { card_id: cardId, test: !!test };
    if (test) {
      const testEmail = document.getElementById("blast-test-email").value.trim();
      if (testEmail) body.test_email = testEmail;
      const testPhone = document.getElementById("blast-test-phone").value.trim();
      if (testPhone) body.test_phone = testPhone;
    }
    if (buyerIds) body.buyer_ids = buyerIds;
    if (activeBlast.followUp) body.follow_up = true;
    body.channels = channels;
    if (activeBlast.isMorbyDeck) {
      // Email carries the PDF; SMS (if selected) sends the key numbers as text.
      body.deal_deck_pdf = activeBlast.dealDeckPdf;
    } else if (activeBlast.variations && activeBlast.variations.length) {
      const idx = Number(document.getElementById("blast-variation-select").value) || 0;
      const v = activeBlast.variations[idx] || {};
      body.variation_index = idx;
      body.variation_title = v.title || `Variation ${idx + 1}`;
      body.variation_body = v.body || "";
    }
    if (test) {
      // Test mode stays synchronous — a single preview whose result comes
      // back inline, exactly as before.
      const res = await fetch("/.netlify/functions/send-blast", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || result || "Blast failed");
      const parts = [];
      if (result.email) parts.push(result.email.error ? `Email test failed: ${result.email.error}` : `Email test → ${result.email.to} (would reach ${result.email.would_reach ?? "?"} ${buyerIds ? "selected" : "matching"} buyer(s) live)`);
      if (result.sms) parts.push(result.sms.error ? `SMS test failed: ${result.sms.error}` : result.sms.note ? `SMS test: ${result.sms.note}` : `SMS test → ${result.sms.to} (would reach ${result.sms.would_reach ?? "?"} ${buyerIds ? "selected" : "matching"} buyer(s) live)`);
      statusEl.textContent = "🧪 TEST — " + parts.join(" · ");
      return;
    }

    // LIVE (F4): goes to the background function — 202 immediately, up to a
    // 15-minute send budget — then we watch progress via blast_recipients.
    if (activeBlast.isMorbyDeck) {
      // A background invocation's payload caps at ~256 KB, far too small for
      // an inline base64 PDF — stage it in Storage and pass the path.
      const b64 = (body.deal_deck_pdf || "").split("base64,").pop();
      delete body.deal_deck_pdf;
      const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      const path = `deal-decks/staged-${cardId}.pdf`;
      const { error: upErr } = await supa.storage.from("property-photos")
        .upload(path, new Blob([bytes], { type: "application/pdf" }), { upsert: true, contentType: "application/pdf" });
      if (upErr) throw new Error(`Couldn't stage the deck PDF: ${upErr.message}`);
      body.deal_deck_path = path;
    }
    // Completion is matched on this ref (echoed back in the heartbeat row's
    // detail), so detecting the end never depends on the browser clock. The
    // startIso slack only scopes the cosmetic in-flight counts.
    body.client_ref = blastRef();
    const startIso = new Date(Date.now() - 30000).toISOString();
    const res = await fetch("/.netlify/functions/send-blast-background", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify(body),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`Blast failed to start (HTTP ${res.status})`);
    const outcome = await watchBlastProgress({ cardId, ref: body.client_ref, startIso, statusEl, expected: targetCount });
    if (outcome && outcome.run) {
      const summary = blastRunSummary(outcome.run, cardId);
      if (outcome.run.status === "ok") {
        // Close on success like the old sync flow did — leaving the modal
        // open with a live Send button invites an accidental duplicate send.
        toast(`✅ Blast finished — ${summary}`, { type: "success", duration: 8000 });
        closeBlastModal();
      } else {
        statusEl.textContent = `❌ Blast error: ${summary}`;
        statusEl.style.color = "var(--red)";
      }
    }
    await loadAll();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = "var(--red)";
  } finally {
    sendBtn.disabled = false; testBtn.disabled = false;
    busyBtn.textContent = busyLabel;
  }
}

// F4: a live blast returns 202 before anything sends. Progress comes from
// blast_recipients head-counts (blast-core flushes rows incrementally);
// completion is the sync_runs row send-blast-background writes at the end,
// matched by the client-generated ref echoed into its detail — immune to
// client/server clock skew and to a stale heartbeat from an earlier blast of
// the same card. Returns { run, sent, failed } on completion, null on
// timeout or when the modal closes (the send keeps running server-side).
function blastRef() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function blastRunSummary(run, cardId) {
  return (run.detail || "").replace(/\s*ref=\S+/, "").replace(`card=${cardId}`, "").trim();
}
async function watchBlastProgress({ cardId, ref, startIso, statusEl, expected }) {
  const deadline = Date.now() + 16 * 60 * 1000;
  statusEl.style.color = "";
  statusEl.textContent = `Blast started — sending in the background to ~${expected} buyer(s)…`;
  const countRows = (status) => supa.from("blast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("card_id", cardId).eq("status", status).gte("blasted_at", startIso);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000));
    if (!activeBlast || activeBlast.cardId !== cardId) return null;
    const [{ count: sent }, { count: failed }, { data: runs }] = await Promise.all([
      countRows("sent"), countRows("failed"),
      supa.from("sync_runs").select("status,detail").eq("fn", "send-blast").order("ran_at", { ascending: false }).limit(10),
    ]);
    const run = (runs || []).find(r => (r.detail || "").includes(`ref=${ref}`));
    if (run) return { run, sent: sent || 0, failed: failed || 0 };
    // Counts are per message (a buyer on email+SMS is two rows), so no
    // percentage — the ref-matched heartbeat above is the real finish line.
    statusEl.textContent = `Sending in background… ${sent || 0} message${sent === 1 ? "" : "s"} sent${failed ? `, ${failed} failed` : ""} (audience ~${expected} buyer${expected === 1 ? "" : "s"})`;
  }
  statusEl.textContent = "Still sending in the background — stopped watching after 16 min; check the deal's blast status shortly.";
  return null;
}

document.getElementById("blast-mode-all").addEventListener("change", () => document.getElementById("blast-buyer-list").classList.add("hidden"));
document.getElementById("blast-mode-select").addEventListener("change", () => document.getElementById("blast-buyer-list").classList.remove("hidden"));
document.getElementById("blast-select-all").addEventListener("click", () => {
  if (!activeBlast) return;
  document.querySelectorAll(".blast-buyer-cb").forEach(cb => { cb.checked = true; activeBlast.selectedIds.add(Number(cb.value)); });
  updateSelectedCount();
});
document.getElementById("blast-select-none").addEventListener("click", () => {
  if (!activeBlast) return;
  document.querySelectorAll(".blast-buyer-cb").forEach(cb => { cb.checked = false; activeBlast.selectedIds.delete(Number(cb.value)); });
  updateSelectedCount();
});
document.getElementById("blast-modal-cancel").addEventListener("click", closeBlastModal);
document.getElementById("blast-modal-backdrop").addEventListener("click", e => { if (e.target.id === "blast-modal-backdrop") closeBlastModal(); });
document.getElementById("blast-modal-test").addEventListener("click", () => runBlast({ test: true }));
document.getElementById("blast-modal-send").addEventListener("click", () => runBlast({ test: false }));

// R3 — re-send only the recipients whose last attempt failed.
async function retryFailed(btn) {
  const cardId = btn.dataset.cardId, address = btn.dataset.address;
  if (!confirm(`Retry the failed sends for "${address}"? This only re-attempts recipients that previously failed.`)) return;
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Retrying…";
  try {
    const { data: { session: s } } = await supa.auth.getSession();
    // Retries ride the background function too (F4): a mostly-failed large
    // blast makes the retry set just as big as the original send.
    const ref = blastRef();
    const res = await fetch("/.netlify/functions/send-blast-background", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ card_id: cardId, retry_failed: true, client_ref: ref }),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`Retry failed to start (HTTP ${res.status})`);
    const deadline = Date.now() + 16 * 60 * 1000;
    let run = null;
    while (!run && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const { data: runs } = await supa.from("sync_runs").select("status,detail").eq("fn", "send-blast").order("ran_at", { ascending: false }).limit(10);
      run = (runs || []).find(x => (x.detail || "").includes(`ref=${ref}`));
    }
    if (run) {
      toast(`Retry ${run.status === "ok" ? "complete" : "error"} — ${blastRunSummary(run, cardId)}`,
        { type: run.status === "ok" ? "success" : "error", duration: 8000 });
    } else {
      toast("Retry is still running in the background — refresh in a few minutes.", { type: "info" });
    }
    await loadAll();
  } catch (err) {
    alert("Retry error: " + err.message);
    btn.disabled = false; btn.textContent = label;
  }
}

document.getElementById("lead-modal-cancel").addEventListener("click", closeLeadModal);
document.getElementById("lead-modal-backdrop").addEventListener("click", e => { if (e.target.id === "lead-modal-backdrop") closeLeadModal(); });
document.getElementById("lead-modal-save").addEventListener("click", saveLead);
document.getElementById("lead-modal-delete").addEventListener("click", deleteLead);

(async () => {
  session = await requireAuth();
  if (!session) return;
  wireLogout(document.getElementById("logout-btn"));
  document.getElementById("refresh-btn").addEventListener("click", loadAll);
  await loadAll();

  // #deal=<card_id> deep link (Pipeline board → this deal's full card).
  const m = location.hash.match(/^#deal=(.+)$/);
  if (m && boardData) {
    const cardId = decodeURIComponent(m[1]);
    if (boardData.props.some(p => p.card_id === cardId)) {
      expandedDealCards.add(cardId);
      renderBoard();
      const card = document.querySelector(`.prop-card[data-card-id="${CSS.escape(cardId)}"]`);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
})();
