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

// ── Terms-editor field helpers (migration 034 fields) ──
// These columns are nullable-with-no-default on purpose: null means "not
// entered" and every deck-page gate reads it that way. `|| ""` would render a
// real 0 as blank, so the null check has to be explicit both directions.
function numOrBlank(v) {
  return (v === null || v === undefined || v === "") ? "" : String(v);
}
function selectOpts(current, pairs) {
  const cur = String(current == null ? "" : current);
  return [["", "—"]].concat(pairs)
    .map(([v, label]) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(label)}</option>`)
    .join("");
}

// ── Deck-page links (the buyer-facing /deck/<slug> page) ──
// Slugs are minted eagerly at intake now; legacy cards that predate that (and
// were never blasted) get theirs backfilled on demand via deck-link.js.
// PUBLIC_SITE_ORIGIN, not location.origin (ui-shared.js): the dashboard is
// still reachable at seaside-dispo-app.netlify.app, and building from the
// origin meant 🔗 Copy link handed investors whichever host the tab happened
// to be on — the one place a buyer-facing link wasn't derived from the
// canonical host.
function deckUrlFor(p) {
  return p && p.deck_slug ? `${PUBLIC_SITE_ORIGIN}/deck/${p.deck_slug}` : "";
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
// The hosted-PDF twin of fetchDeckLink. Without pdfDataUri it reports whether
// a PDF is already hosted ({ needs_pdf: true } if not); with one it hosts that
// PDF and returns the link. Returns the whole payload, not just the url, since
// the caller has to branch on needs_pdf.
async function fetchDeckPdfLink(cardId, pdfDataUri = null) {
  const { data: { session: s } } = await supa.auth.getSession();
  const res = await fetch("/.netlify/functions/deck-link", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
    body: JSON.stringify({ card_id: cardId, kind: "pdf", ...(pdfDataUri ? { pdf_base64: pdfDataUri } : {}) }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Couldn't resolve the PDF link");
  const cached = dealCache[cardId];
  if (cached && cached.prop && !cached.prop.deck_slug && result.slug) cached.prop.deck_slug = result.slug;
  return result;
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
// ── Deck-view channel reporting (deck_views.source, migration 030) ──
// SMS and email deck links have always been tokenized the same way, so both
// were attributed to the buyer; `source` is what lets them be told apart.
// Rows written before 030 (and copied/forwarded links) have no source and
// read as "direct".
const VIEW_SOURCE_LABELS = { sms: "SMS", email: "email", dm: "DM", "": "direct" };
function sourceLabel(s) { return VIEW_SOURCE_LABELS[s || ""] || "direct"; }

// How a set of views arrived: "SMS", "SMS + email", "SMS + email + direct".
// There are only four possible sources and the labels are short, so naming
// them all beats a vague "+2 others" — most-used channel first.
function channelSummary(views) {
  const counts = {};
  for (const v of (views || [])) {
    const k = v.source || "";
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .map(sourceLabel)
    .join(" + ");
}

// Total time on the deck across views — the "combined time viewed".
function totalDwell(views) {
  return (views || []).reduce((n, v) => n + (Number(v.dwell_seconds) || 0), 0);
}
function fmtDuration(secs) {
  secs = Math.round(secs || 0);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function timeAgoShort(iso) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}
function buildCallList(props, leads, deckViews, buyers, activities) {
  const buyerById = Object.fromEntries((buyers || []).map(b => [b.id, b]));
  // p.address_override was always undefined here — properties has no such
  // column (lib/deal-address.js). The structure rows aren't threaded into the
  // call list, so this reads the card name, which is what it already showed.
  const dealOf = Object.fromEntries((props || []).map(p => [p.card_id, (p.name || "").split(",")[0]]));
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
  // Group each buyer's recent views per deal so the tile can report the
  // channel(s) they came in on and their combined time on the page.
  const recentViews = {};
  for (const v of (deckViews || [])) {
    if (!v.buyer_id) continue;
    if ((now - new Date(v.viewed_at)) / 3600000 > 72) continue;
    if (v.kind === "pdf") continue; // PDF taps aren't page views
    (recentViews[`${v.buyer_id}|${v.card_id}`] ||= []).push(v);
  }
  for (const [key, group] of Object.entries(recentViews)) {
    const buyerId = Number(key.split("|")[0]);
    const b = buyerById[buyerId];
    if (!b) continue;
    const latest = group.reduce((a, v) => new Date(v.viewed_at) > new Date(a.viewed_at) ? v : a);
    const via = channelSummary(group);
    const dwell = totalDwell(group);
    const detail = [
      via ? `via ${via}` : "",
      group.length > 1 ? `${group.length}×` : "",
      dwell >= 15 ? fmtDuration(dwell) : "",
    ].filter(Boolean).join(" · ");
    add(`b${buyerId}`, {
      name: b.name, phone: b.phone, email: b.email, at: latest.viewed_at,
      buyerId, cardId: latest.card_id || "", priority: 3,
      reason: `👀 Viewed ${dealOf[latest.card_id] || "a deck"}${detail ? ` — ${detail}` : ""}`,
    });
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
  const [{ data: terms, error: termsErr }, { data: statuses, error: statusesErr }, { data: fbPosts, error: fbErr }, { data: buyers, error: buyersErr }, { data: leads, error: leadsErr }, { data: blasts, error: blastsErr }, { data: acq, error: acqErr }, { data: morby, error: morbyErr }, { data: cash }, { data: recips, error: recipsErr }, { data: deckViews }, { data: emailEvents }, { data: tasks }, { data: activities, error: actErr }] = await Promise.all([
    supa.from("deal_terms").select("*").in("card_id", cardIds),
    supa.from("property_status").select("*").in("card_id", cardIds),
    supa.from("facebook_posts").select("*").in("card_id", cardIds),
    // Paged (F3): this is the blast-preview audience — must be complete, or
    // the preview understates who a live send reaches past 1,000 buyers.
    // email_bounced_at (031) feeds bounce suppression; falls back to the
    // pre-031 column set so the board still loads before the migration runs.
    fetchAllRows(() => supa.from("buyers").select("id,name,email,phone,tier,states,strategy,sms_opt_in,max_price,max_piti,min_beds,email_opt_out,email_bounced_at").eq("active", true).order("id"))
      .then(r => r.error ? fetchAllRows(() => supa.from("buyers").select("id,name,email,phone,tier,states,strategy,sms_opt_in,max_price,max_piti,min_beds,email_opt_out").eq("active", true).order("id")) : r),
    supa.from("deal_leads").select("*").in("card_id", cardIds).order("updated_at", { ascending: false }),
    supa.from("deal_blasts").select("card_id,channel,status,detail,variation_index,variation_title,blasted_at").in("card_id", cardIds),
    supa.from("deal_acquisition").select("*").in("card_id", cardIds),
    supa.from("morby_deals").select("*").in("card_id", cardIds),
    // Deliberately NOT in loadErrors: like deal_tasks/email_events, this fails
    // soft until its migration (035) runs. No card can be deal_type 'cash'
    // before then, so an empty result changes nothing on screen.
    supa.from("cash_deals").select("*").in("card_id", cardIds),
    // Paged (F3): one blast writes a recipient row per buyer, and deck views /
    // email opens multiply per blast — all three blow past 1,000 rows first.
    fetchAllRows(() => supa.from("blast_recipients").select("card_id,channel,status,buyer_id").in("card_id", cardIds).order("id")),
    // `source`/`dwell_seconds` power the per-channel view rollup (SMS vs email).
    // Falls back to the pre-030 column set so the board still loads if the
    // migration hasn't been run yet.
    fetchAllRows(() => supa.from("deck_views").select("card_id,buyer_id,viewed_at,kind,source,dwell_seconds").in("card_id", cardIds).order("id"))
      .then(r => r.error ? fetchAllRows(() => supa.from("deck_views").select("card_id,buyer_id,viewed_at").in("card_id", cardIds).order("id")) : r),
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
  // H10: a failed buyers query must never render as an empty audience — with
  // zero buyers every blast preview would show 0 matches while a live send
  // (which refetches server-side) would still reach everyone.
  if (buyersErr) {
    content.innerHTML = `<div class="empty">Couldn't load buyers: ${escapeHtml(buyersErr.message)}<br>Refusing to show the board — blast previews would wrongly show an empty audience. <a href="#" onclick="location.reload();return false">Reload</a>.</div>`;
    return;
  }
  // Everything else degrades to a visible warning (kept out of this list: the
  // queries that intentionally fail soft before their migration runs —
  // deal_tasks 027, email_events 026, deck_views 030, dispo stages 022).
  const loadErrors = [
    ["deal terms", termsErr], ["statuses", statusesErr], ["FB posts", fbErr],
    ["leads", leadsErr], ["blast log", blastsErr], ["acquisition info", acqErr],
    ["Morby terms", morbyErr], ["send ledger", recipsErr], ["buyer activity", actErr],
  ].filter(([, e]) => e);

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
  const cashByCard = Object.fromEntries((cash || []).map(c => [c.card_id, c]));
  const tasksByCard = {}; // empty until 027 migration runs
  for (const t of (tasks || [])) (tasksByCard[t.card_id] ||= []).push(t);

  allBuyers = buyers || [];

  // Stash everything the renderer needs so the triage bar (search / filter /
  // sort / expand) can re-render instantly without refetching Supabase.
  boardData = {
    props: props || [], buyers: buyers || [], leads: leads || [], deckViews: deckViews || [],
    activities: activities || [],
    termsByCard, statusByCard, fbByCard, leadsByCard, blastsByCard, recipsByCard,
    viewsByCard, eventsByCard, acqByCard, morbyByCard, cashByCard, tasksByCard,
    loadErrors,
  };
  renderBoard();
}

// ── Board renderer — everything below the page header. Split out of loadAll
// so triage-bar interactions re-render from boardData without a refetch. ──
function renderBoard() {
  if (!boardData) return;
  const content = document.getElementById("content");
  const { props, buyers, leads, deckViews, activities, termsByCard, statusByCard, fbByCard, leadsByCard,
          blastsByCard, recipsByCard, viewsByCard, eventsByCard, acqByCard, morbyByCard, cashByCard, tasksByCard } = boardData;

  // B4.1 — the buy-box completeness number, on the page Zach opens daily. A
  // wildcard buyer has no state, strategy or budget on file, so they land in
  // the audience for every deal; the count is the list-quality metric.
  const boxSplit = DealShared.buyBoxSplit(buyers);
  document.getElementById("prop-count").innerHTML =
    `${props.length} active under-contract propert${props.length === 1 ? "y" : "ies"}`
    + ` · <a href="/buyers.html" style="color:inherit" title="Buyers with a market, strategy and budget on file">${boxSplit.full} of ${boxSplit.total} buyers have a full buy box</a>`
    + (boxSplit.wildcard
      ? ` · <span style="color:#B7791F" title="No market, strategy or budget on file — these buyers match every deal you send. Open the Buyers page and click “wildcard” to see them.">${boxSplit.wildcard} wildcard</span>`
      : "");

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

  const renderArgs = (p) => renderCard(p, termsByCard, statusByCard, fbByCard, buyers || [], leadsByCard, blastsByCard, acqByCard, morbyByCard, cashByCard, recipsByCard, viewsByCard, eventsByCard, attByCard[p.card_id]);
  // Sub-To is the fallback bucket, so it must EXCLUDE every other structure by
  // name — listing only "morby" here is what would silently file cash deals
  // under Sub-To and blast them with a Sub-To email.
  const allSubto = props.filter(p => !["morby", "cash"].includes(p.deal_type || "subto"));
  const allMorby = props.filter(p => p.deal_type === "morby");
  const allCash = props.filter(p => p.deal_type === "cash");
  const subtoProps = applyView(allSubto);
  const morbyProps = applyView(allMorby);
  const cashProps = applyView(allCash);
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

  const loadErrorBanner = (boardData.loadErrors || []).length
    ? `<div class="card" style="margin-bottom:14px;padding:10px 14px;border-left:4px solid #C53030;background:#FFF5F5;color:#742A2A;font-size:0.85rem"><strong>⚠ Some data failed to load:</strong> ${boardData.loadErrors.map(([name, e]) => `${escapeHtml(name)} (${escapeHtml(e.message || String(e))})`).join(" · ")}. Counts and previews on this board may be wrong — reload before sending anything.</div>`
    : "";

  content.innerHTML = `
    ${loadErrorBanner}
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
    </div>
    <div class="deal-type-group">
      <div class="deal-type-group-header flex-between">
        <span>💵 Cash Deals <span class="muted">${groupCount(cashProps, allCash)}</span></span>
        <button type="button" class="btn btn-primary btn-sm" id="add-cash-btn">+ Add Cash Deal</button>
      </div>
      <div id="add-cash-panel" class="card hidden" style="margin-bottom:16px">
        <h3 style="margin-top:0">New Cash Deal — Upload Contract</h3>
        <p class="muted" style="font-size:0.85rem">Upload the purchase contract — PDF or image (JPG/PNG). Add the seller concession addendum, payoff letter or original listing as a second file if the discount lives there. Claude extracts the price stack (original → forgiven → purchase) and creates the card, ready to review and blast.</p>
        <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
          <label style="font-size:0.8rem">Contract (required)<br><input type="file" id="add-cash-contract" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:260px"></label>
          <label style="font-size:0.8rem">Concession / payoff / listing (optional)<br><input type="file" id="add-cash-concession" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:260px"></label>
        </div>
        <div class="flex gap-8 mt-8" style="flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-primary btn-sm" id="add-cash-submit">📤 Extract &amp; Create</button>
          <button type="button" class="btn btn-ghost btn-sm" id="add-cash-cancel">Cancel</button>
          <span id="add-cash-status" class="muted" style="font-size:0.82rem"></span>
        </div>
      </div>
      ${cashProps.length ? stack(cashProps) : (allCash.length ? noMatch : `<div class="empty">No cash deals yet — click "+ Add Cash Deal" and upload the contract to create one.</div>`)}
    </div>`;
  wireCardEvents();
  wireAddMorbyPanel();
  wireAddSubtoPanel();
  wireAddCashPanel();
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

// Which buyer strategy a deal blasts to. Sub-To is the FALLBACK, so every
// other structure has to be named explicitly — mirrors blast-core.js, which
// is the authority on the live send. A structure missing from this ternary
// doesn't fail loudly; it quietly blasts to the wrong buyer list.
function dealStrategyOf(p) {
  return p.deal_type === "morby" ? "morby" : p.deal_type === "cash" ? "cash" : "subto";
}

// The price matchesDeal screens each buyer's max_price against. A cash deal
// has no deal_terms row at all, so reading terms.price would hand matchesDeal
// a 0 — and a 0 price makes it skip the budget cap entirely, previewing a
// $570k deal as a match for a buyer who told us $200k.
function dealMatchPrice(p, t, cash) {
  if (p.deal_type === "cash") return DealShared.cashPriceStack(cash || {}).purchase || 0;
  return Number(t.price) || 0;
}

function matchedBuyersForDeal(p, t, buyers, cash) {
  const state = p.state, price = dealMatchPrice(p, t, cash), piti = Number(t.piti) || 0, beds = Number(t.beds) || 0;
  const dealStrategy = dealStrategyOf(p);
  return buyers
    .filter(b => matchesDeal(b, dealStrategy, state, price, piti, beds))
    .map(b => {
      const { score, reasons, missing } = scoreBuyerForDeal(b, state, price, piti, beds);
      return { ...b, _score: score, _reasons: reasons, _missing: missing };
    })
    .sort((a, b) => b._score - a._score);
}

// B4.4 — buyers who fail matchesDeal ONLY on a numeric cap, and only just
// (nearMissDeal in deal-shared.js owns the band). They are never included in
// a blast automatically: they show up as their own group in the picker so
// they can be added one at a time, on purpose.
function nearMissBuyersForDeal(p, t, buyers, cash) {
  const state = p.state, price = dealMatchPrice(p, t, cash), piti = Number(t.piti) || 0, beds = Number(t.beds) || 0;
  const dealStrategy = dealStrategyOf(p);
  const out = [];
  for (const b of buyers) {
    const near = DealShared.nearMissDeal(b, dealStrategy, state, price, piti, beds);
    if (!near) continue;
    const { score, missing } = scoreBuyerForDeal(b, state, price, piti, beds);
    out.push({ ...b, _score: score, _missing: missing, _near: true, _reasons: near.reasons.map(r => `⚠ ${r}`) });
  }
  return out.sort((a, b) => b._score - a._score);
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
function renderCompactCard(p, t, morby, cash, matchCount, leads, blasts, views, att, dealType) {
  const sent = (blasts || []).filter(b => b.status === "sent").length;
  const bits = [];
  if (dealType === "cash") {
    // Forgiven amount is this structure's headline everywhere else, so it
    // leads the collapsed row too.
    const stack = DealShared.cashPriceStack(cash || {});
    if (stack.purchase) bits.push(fmtMoney(stack.purchase));
    if (stack.forgiven) bits.push(`${fmtMoney(stack.forgiven)} forgiven`);
    bits.push(`👥 ${matchCount}`);
  } else if (dealType === "morby") {
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

function renderCard(p, termsByCard, statusByCard, fbByCard, buyers, leadsByCard, blastsByCard, acqByCard, morbyByCard, cashByCard, recipsByCard, viewsByCard, eventsByCard, attention) {
  const t = termsByCard[p.card_id] || {};
  const status = (statusByCard[p.card_id] || {}).status || "active";
  const posts = fbByCard[p.card_id] || [];
  const cash = (cashByCard && cashByCard[p.card_id]) || {};
  const matched = matchedBuyersForDeal(p, t, buyers, cash);
  const matchCount = matched.length;
  const leads = leadsByCard[p.card_id] || [];
  const blasts = blastsByCard[p.card_id] || [];
  const recips = (recipsByCard && recipsByCard[p.card_id]) || [];
  const acq = acqByCard[p.card_id] || {};
  const morby = (morbyByCard && morbyByCard[p.card_id]) || {};
  const dealType = p.deal_type || "subto";
  dealCache[p.card_id] = { prop: p, terms: t, matched, nearMiss: nearMissBuyersForDeal(p, t, buyers, cash), leads, acq, morby, cash };

  // ── Triage: collapsed (compact) mode is the default. One row per deal;
  // click to expand into the full working card. ──
  if (!expandedDealCards.has(p.card_id)) {
    return renderCompactCard(p, t, morby, cash, matchCount, leads, blasts,
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
            <button type="button" class="btn btn-ghost btn-sm deck-pdf-copy-btn" data-card-id="${escapeHtml(p.card_id)}" style="font-size:0.72rem;padding:1px 8px" title="Copy a direct link to the Deal Deck PDF — generates and hosts it first if this deal hasn't been blasted yet">📄 Copy PDF link</button>
          </div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-primary btn-sm morby-send-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Generate Deal Deck PDF and email it to all Stack Method buyers">📣 Send Deal Deck</button>
          <button class="btn btn-ghost btn-sm to-cash-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="The seller isn't carrying after all — move this to Cash deals, keeping the price, timeline, DSCR assumptions, rents and photos. Reversible.">→ Move to Cash</button>
          <button class="btn btn-ghost btn-sm morby-delete-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Remove this Morby deal">🗑 Remove</button>
          <button class="btn btn-ghost btn-sm collapse-deal-btn" data-card-id="${escapeHtml(p.card_id)}" title="Collapse to one line">▴</button>
        </div>
      </div>
      ${renderStructurePanel(p, morby, t, acq, "morby")}
    </div>`;
  }

  // ── Cash deals use the same stripped-down workflow as Morby: created from
  // a contract upload, worked entirely in one panel, blasted as a Deal Deck.
  // No marketing-copy variations or FB posting tools. ──
  if (dealType === "cash") {
    // A morby_deals row still sitting behind a cash card means this deal was
    // MOVED here. That's what makes the old carry balance available as a
    // suggestion, and what makes the move reversible after the toast is gone.
    const carriedFrom = morby && morby.card_id ? morby : null;
    // The forgiven amount is this deck's headline; without it the hero renders
    // "—". Say so on the card rather than letting it go out blank.
    const needsForgiven = !DealShared.cashPriceStack(cash).forgiven;
    return `
    <div class="card prop-card cash-card" data-card-id="${escapeHtml(p.card_id)}">
      <div class="flex-between">
        <div>
          <p class="prop-title">${escapeHtml(p.name)}</p>
          <div class="prop-meta">
            ${p.state ? `<span class="pill pill-state">${escapeHtml(p.state)}</span>` : ""}
            ${dispoStageChip(p)}
            ${p.deck_slug ? `<a href="${escapeHtml(deckUrlFor(p))}" target="_blank" rel="noopener">Deck page ↗</a>` : ""}
            <button type="button" class="btn btn-ghost btn-sm deck-copy-btn" data-card-id="${escapeHtml(p.card_id)}" style="font-size:0.72rem;padding:1px 8px" title="Copy the public deck-page link for DMs / FB groups">🔗 Copy link</button>
            <button type="button" class="btn btn-ghost btn-sm deck-pdf-copy-btn" data-card-id="${escapeHtml(p.card_id)}" style="font-size:0.72rem;padding:1px 8px" title="Copy a direct link to the Deal Deck PDF — generates and hosts it first if this deal hasn't been blasted yet">📄 Copy PDF link</button>
          </div>
        </div>
        <div class="flex gap-8">
          ${needsForgiven ? `<span class="pill" style="align-self:center;background:#FFF5E6;color:#8A6D1F;border:1px solid #EAD9A0;font-size:0.72rem" title="The deck page hero and the email headline are both the amount forgiven — set it in the panel below before blasting.">⚠ No amount forgiven</span>` : ""}
          <span class="muted" style="font-size:0.78rem;align-self:center">👥 ${matchCount} matching</span>
          <button class="btn btn-primary btn-sm morby-send-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Generate the Deal Deck PDF and blast it to matching cash buyers">📣 Send Deal Deck</button>
          ${carriedFrom ? `<button class="btn btn-ghost btn-sm to-morby-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="This deal was moved here from Morby and its Morby terms are still on file — move it back.">↩ Back to Morby</button>` : ""}
          <button class="btn btn-ghost btn-sm morby-delete-btn" data-card-id="${escapeHtml(p.card_id)}" data-address="${escapeHtml(p.name)}" title="Remove this cash deal">🗑 Remove</button>
          <button class="btn btn-ghost btn-sm collapse-deal-btn" data-card-id="${escapeHtml(p.card_id)}" title="Collapse to one line">▴</button>
        </div>
      </div>
      ${renderStructurePanel(p, cash, t, acq, "cash", carriedFrom)}
    </div>`;
  }

  const variations = p.variations || [];
  const acqDone = acqCompleteness(acq);
  const acqBadgeComplete = acqDone.filled >= 10;
  const flags = acqFlags(acq);

  // ── Pipeline: sorted by stage progression (closest-to-closing first) ──
  // Deck engagement (§7): views for this deal + a buyer_id -> view-count map.
  const allViews = (viewsByCard && viewsByCard[p.card_id]) || [];
  const views = allViews.filter(v => v.kind !== "pdf"); // page views only
  const totalViews = views.length;
  const viewsByBuyer = new Map();
  for (const v of views) if (v.buyer_id != null) viewsByBuyer.set(Number(v.buyer_id), (viewsByBuyer.get(Number(v.buyer_id)) || 0) + 1);
  // Where the views came from (SMS vs email vs direct) + combined time on page.
  const viewsBySource = {};
  for (const v of views) { const k = v.source || ""; viewsBySource[k] = (viewsBySource[k] || 0) + 1; }
  const sourceBreakdown = Object.keys(viewsBySource).length
    ? Object.entries(viewsBySource)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${n} ${sourceLabel(s)}`).join(" · ")
    : "";
  const dwellTotal = totalDwell(views);
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
            ${t.hoa_monthly ? `<span class="term-chip">HOA <b>${fmtMoney(t.hoa_monthly)}/mo</b></span>`
              : (t.hoa_monthly == null && t.hoa_rental_policy === "none" ? `<span class="term-chip"><b>No HOA</b></span>` : "")}
            ${[["ltr", "LTR"], ["mtr", "MTR"], ["str", "STR"]].map(([m, label]) =>
              t[`rent_${m}`] ? `<span class="term-chip">${label} <b>${fmtMoney(t[`rent_${m}`])}/mo</b></span>` : "").join("")}
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

            <div class="te-subhead">HOA</div>
            <div><label>HOA / mo</label><input type="number" class="te-hoa_monthly" value="${numOrBlank(t.hoa_monthly)}"></div>
            <div><label>Rental policy</label><select class="te-hoa_rental_policy">${selectOpts(t.hoa_rental_policy, [["none", "None"], ["allowed", "Allowed"], ["min_term", "Minimum term"], ["capped", "Capped"], ["prohibited", "Prohibited"]])}</select></div>
            <div><label>Min lease (days)</label><input type="number" class="te-hoa_min_lease_days" value="${numOrBlank(t.hoa_min_lease_days)}"></div>

            <div class="te-subhead">Rent strategies <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">— a rent with no source never shows on the deck</span></div>
            <div><label>Long-term rent</label><input type="number" class="te-rent_ltr" value="${numOrBlank(t.rent_ltr)}"></div>
            <div style="grid-column:span 2"><label>Long-term source</label><input type="text" class="te-rent_ltr_source" placeholder="e.g. Rentometer, 3 comps within 0.4mi" value="${escapeHtml(t.rent_ltr_source || "")}"></div>
            <div><label>Mid-term rent</label><input type="number" class="te-rent_mtr" value="${numOrBlank(t.rent_mtr)}"></div>
            <div style="grid-column:span 2"><label>Mid-term source</label><input type="text" class="te-rent_mtr_source" placeholder="e.g. Furnished Finder, 6 active listings" value="${escapeHtml(t.rent_mtr_source || "")}"></div>
            <div><label>MTR furnishing $</label><input type="number" class="te-mtr_furnishing_cost" value="${numOrBlank(t.mtr_furnishing_cost)}"></div>
            <div><label>Short-term rent</label><input type="number" class="te-rent_str" value="${numOrBlank(t.rent_str)}"></div>
            <div style="grid-column:span 2"><label>Short-term source</label><input type="text" class="te-rent_str_source" placeholder="e.g. AirDNA, 12-mo trailing" value="${escapeHtml(t.rent_str_source || "")}"></div>
            <div><label>STR furnishing $</label><input type="number" class="te-str_furnishing_cost" value="${numOrBlank(t.str_furnishing_cost)}"></div>
            <div><label>STR permitted</label><select class="te-str_permitted">${selectOpts(t.str_permitted, [["allowed", "Allowed"], ["permit_required", "Permit required"], ["restricted", "Restricted"], ["unknown", "Unknown"]])}</select></div>
            <div><label>Primary mode</label><select class="te-primary_rent_mode">${selectOpts(t.primary_rent_mode, [["ltr", "Long-term"], ["mtr", "Mid-term"], ["str", "Short-term"]])}</select></div>

            <div class="te-subhead">Other</div>
            <div><label>Loan P&amp;I / mo</label><input type="number" class="te-loan_pi" value="${numOrBlank(t.loan_pi)}"></div>
            <div><label>Est. closing costs</label><input type="number" class="te-est_closing_costs" value="${numOrBlank(t.est_closing_costs)}"></div>
            <div><label>Market value</label><input type="number" class="te-market_value" value="${numOrBlank(t.market_value)}"></div>
          </div>
          <div class="flex gap-8 mt-8" style="flex-wrap:wrap;align-items:center">
            <button type="button" class="btn btn-ghost btn-sm terms-cancel-btn">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm terms-save-btn">Save</button>
            <span class="terms-warn"></span>
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
        <div class="muted" style="font-size:0.76rem;margin:2px 0 4px">👁 ${totalViews} view${totalViews === 1 ? "" : "s"}${sourceBreakdown ? ` (${escapeHtml(sourceBreakdown)})` : ""}${dwellTotal >= 15 ? ` · ⏱ ${escapeHtml(fmtDuration(dwellTotal))} total` : ""} · ${interestedCount} interested</div>
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
      ${galleryBlockHtml(p, a)}
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

// Shared editor panel for BOTH structure-backed deal types (Morby and Cash).
// One renderer on purpose: the two panels share the address override, the deck
// photo, the gallery, the property type, the timeline, the property details,
// the income/expense block and the DSCR assumptions — every one of which would
// otherwise be a second copy free to drift.
//
//   kind "morby" — LOI terms + Seller Financing + Seller Flexibility
//   kind "cash"  — the three-number price stack; NO seller financing, no
//                  balloon, no flexibility notes (the seller is out at close)
//
// The panel carries data-table so wireStructurePanels() knows which table to
// upsert into, and data-structure so the deck generator knows which content
// model to build. `row` is the morby_deals or cash_deals record.
// `carriedFrom` is the morby_deals row a converted cash deal came from, or
// null. Used only to offer the old seller carry as a suggested Amount
// Forgiven — never to fill it in automatically.
function renderStructurePanel(p, row, terms, acq, kind, carriedFrom) {
  const m = row || {};
  const ac = acq || {};
  const cardId = escapeHtml(p.card_id);
  const isCash = kind === "cash";
  const table = isCash ? "cash_deals" : "morby_deals";
  const num = (v) => (v === null || v === undefined) ? "" : v;
  const txt = (v) => escapeHtml(v == null ? "" : String(v));
  const propertyType = m.property_type || "single_family";
  const defaults = MORBY_DSCR_DEFAULTS[propertyType] || MORBY_DSCR_DEFAULTS.single_family;
  const dscrRate = m.dscr_rate != null ? m.dscr_rate : defaults.rate;
  const dscrLtv = m.dscr_ltv != null ? m.dscr_ltv : defaults.ltv;
  const dscrCredit = m.dscr_credit_score != null ? m.dscr_credit_score : defaults.credit;
  const stack = isCash ? DealShared.cashPriceStack(m) : null;

  // What the seller was going to carry, on a deal moved over from Morby.
  // Offered, not applied: "carried $285k" and "forgave $285k" are different
  // deals, and this number becomes the headline investors read.
  const carriedCarry = Number((carriedFrom || {}).seller_carry_balance) || 0;
  const carryHint = (isCash && carriedCarry && !Number(m.amount_forgiven)) ? `
          <p class="muted" style="font-size:0.74rem;margin-top:4px">Moved from Morby, where the seller was carrying ${fmtMoney(carriedCarry)}.
            <button type="button" class="btn btn-ghost btn-sm use-carry-btn" data-amount="${carriedCarry}" style="font-size:0.7rem;padding:1px 6px;margin-left:4px">Use as amount forgiven</button>
          </p>` : "";

  // Upload block — the same shape, different documents and different function.
  const uploadSection = isCash ? `
    <div class="acq-section">
      <h4>📤 Upload Contract</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Upload the purchase contract (PDF or image). Add the concession addendum / payoff letter / original listing as a second file if the discount lives there. The form below auto-fills — review before generating the Deal Deck.</p>
      <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
        <label style="font-size:0.78rem">Contract<br><input type="file" class="cash-contract-input" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:230px"></label>
        <label style="font-size:0.78rem">Concession (optional)<br><input type="file" class="cash-concession-input" accept="application/pdf,image/jpeg,image/png,image/gif,image/webp" style="max-width:230px"></label>
        <button type="button" class="btn btn-ghost btn-sm cash-extract-btn" data-card-id="${cardId}">📤 Extract</button>
        <span class="cash-extract-status muted" style="font-size:0.78rem"></span>
      </div>
    </div>` : `
    <div class="acq-section">
      <h4>📤 Upload LOI</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Upload the signed LOI (PDF) and the form below will be auto-filled — review and adjust before generating the Deal Deck.</p>
      <div class="flex gap-8" style="flex-wrap:wrap;align-items:center">
        <input type="file" class="morby-loi-input" accept="application/pdf" style="max-width:280px">
        <button type="button" class="btn btn-ghost btn-sm morby-loi-btn" data-card-id="${cardId}">📤 Extract from LOI</button>
        <span class="morby-loi-status muted" style="font-size:0.78rem"></span>
      </div>
    </div>`;

  // Financial terms. The cash version leads with the price stack, because the
  // forgiven amount is the headline on the deck, the email and the SMS.
  const termsSection = isCash ? `
    <div class="acq-section">
      <h4>💰 Price &amp; Concession</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Original price − amount forgiven = purchase price. Enter any two and the third is derived — leave one blank rather than guessing at it.</p>
      <div class="acq-grid">
        <div class="acq-field"><label>Original price</label><input type="number" class="acq-input" data-field="original_price" value="${num(m.original_price)}" placeholder="${stack.original || ""}"></div>
        <div class="acq-field"><label>Amount forgiven</label><input type="number" class="acq-input" data-field="amount_forgiven" value="${num(m.amount_forgiven)}" placeholder="${stack.forgiven || ""}"><p class="muted" style="font-size:0.74rem;margin-top:4px">${stack.discountPct ? `${stack.discountPct}% off the original price.` : "The seller's concession — the deck's headline number."}</p>${carryHint}</div>
        <div class="acq-field"><label>Purchase price</label><input type="number" class="acq-input" data-field="purchase_price" value="${num(m.purchase_price)}" placeholder="${stack.purchase || ""}"><p class="muted" style="font-size:0.74rem;margin-top:4px">What the buyer funds at closing.</p></div>
      </div>
    </div>

    <div class="acq-section">
      <h4>📝 Contract Terms</h4>
      <div class="acq-grid">
        <div class="acq-field"><label>Down payment / EMD</label><input type="number" class="acq-input" data-field="down_payment" value="${num(m.down_payment)}"><p class="muted" style="font-size:0.74rem;margin-top:4px">Optional — leave blank on an all-cash close.</p></div>
        <div class="acq-field"><label>Earnest money amount</label><input type="number" class="acq-input" data-field="earnest_money_amount" value="${num(m.earnest_money_amount)}"></div>
        <div class="acq-field"><label>Closing costs</label><input type="text" class="acq-input" data-field="closing_costs_note" value="${txt(m.closing_costs_note != null ? m.closing_costs_note : "Buyer pays all closing costs")}"></div>
        <div class="acq-field"><label>Broker commission</label><input type="text" class="acq-input" data-field="broker_commission" value="${txt(m.broker_commission != null ? m.broker_commission : "None")}"></div>
        <div class="acq-field"><label>Listing agent commission (%)</label><input type="number" step="0.01" class="acq-input" data-field="additional_broker_pct" value="${num(m.additional_broker_pct)}"><p class="muted" style="font-size:0.74rem;margin-top:4px">A % of purchase price, disclosed on the deck as a transaction cost.</p></div>
      </div>
    </div>` : `
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

    <!-- Section: Seller Financing (Deferred Interest) — Morby only -->
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
    </div>`;

  // Seller Flexibility is a seller-financing artifact — a cash seller is out
  // at closing and has nothing left to be flexible about.
  const flexSection = isCash ? "" : `
    <div class="acq-section">
      <h4>🤝 Seller Flexibility Notes</h4>
      <div class="acq-grid">
        <div class="acq-field" style="grid-column:1/-1"><textarea class="acq-input" data-field="seller_flexibility_notes" rows="3" placeholder="e.g. Seller willing to finance $X after balloon...">${txt(m.seller_flexibility_notes)}</textarea></div>
      </div>
    </div>`;

  return `
  <div class="structure-panel ${isCash ? "cash-panel" : "morby-panel"}" data-card-id="${cardId}" data-structure="${isCash ? "cash" : "morby"}" data-table="${table}">
    <span class="acq-saved-flash">Saved ✓</span>

    <!-- Section: Deal Deck Address -->
    <div class="acq-section">
      <h4>📍 Deal Deck Address</h4>
      <p class="muted" style="font-size:0.78rem;margin-top:-4px">Used as the property address on the Deal Deck PDF and the deck page. Defaults to the card name — correct it here if that's wrong, without renaming the card.</p>
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

    <!-- Section: Photo Gallery -->
    <div class="acq-section">
      <h4>📸 Photo Gallery</h4>
      ${galleryBlockHtml(p, ac)}
    </div>

    ${uploadSection}

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

    ${termsSection}

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

    ${flexSection}

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
    // Non-blocking warnings: entered data that won't reach the deck page.
    // Saving is never prevented — a half-filled row is a legitimate save point.
    const warnEl = block.querySelector(".terms-warn");
    const val = (sel) => { const el = block.querySelector(sel); return el ? el.value.trim() : ""; };
    const refreshWarnings = () => {
      if (!warnEl) return;
      const warns = [];
      for (const [mode, label] of [["ltr", "Long-term"], ["mtr", "Mid-term"], ["str", "Short-term"]]) {
        if (val(`.te-rent_${mode}`) && !val(`.te-rent_${mode}_source`)) {
          warns.push(`${label} rent without a source won't display on the deck.`);
        }
      }
      if (val(".te-rent_str") && !val(".te-str_permitted")) {
        warns.push("Short-term column won't display until STR status is confirmed.");
      }
      if (val(".te-hoa_monthly") && !val(".te-hoa_rental_policy")) {
        warns.push("HOA policy unset — rent strategies won't be gated.");
      }
      warnEl.innerHTML = warns.length
        ? `<span class="terms-warn-chip">⚠ ${warns.map(escapeHtml).join(" ")}</span>`
        : "";
    };
    block.querySelectorAll(".terms-edit input, .terms-edit select")
      .forEach(el => el.addEventListener("input", refreshWarnings));
    refreshWarnings();

    saveBtn.addEventListener("click", async () => {
      // The original nine fields keep their existing empty→0 behavior so
      // nothing regresses. Everything migration 034 added must write NULL
      // instead: 0 is a real HOA fee and "" is a real (empty) policy, and the
      // deck's render gates read null as "not entered".
      const num = (sel) => {
        const v = block.querySelector(sel).value.trim();
        return v === "" ? 0 : Number(v);
      };
      const txt = (sel) => block.querySelector(sel).value.trim();
      const numOrNull = (sel) => {
        const v = block.querySelector(sel).value.trim();
        return v === "" ? null : Number(v);
      };
      const txtOrNull = (sel) => {
        const v = block.querySelector(sel).value.trim();
        return v === "" ? null : v;
      };
      const baseRow = {
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
      const rentRow = {
        hoa_monthly: numOrNull(".te-hoa_monthly"),
        hoa_rental_policy: txtOrNull(".te-hoa_rental_policy"),
        hoa_min_lease_days: numOrNull(".te-hoa_min_lease_days"),
        rent_ltr: numOrNull(".te-rent_ltr"),
        rent_mtr: numOrNull(".te-rent_mtr"),
        rent_str: numOrNull(".te-rent_str"),
        rent_ltr_source: txtOrNull(".te-rent_ltr_source"),
        rent_mtr_source: txtOrNull(".te-rent_mtr_source"),
        rent_str_source: txtOrNull(".te-rent_str_source"),
        primary_rent_mode: txtOrNull(".te-primary_rent_mode"),
        str_permitted: txtOrNull(".te-str_permitted"),
        str_furnishing_cost: numOrNull(".te-str_furnishing_cost"),
        mtr_furnishing_cost: numOrNull(".te-mtr_furnishing_cost"),
        loan_pi: numOrNull(".te-loan_pi"),
        est_closing_costs: numOrNull(".te-est_closing_costs"),
        market_value: numOrNull(".te-market_value"),
      };
      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      try {
        let { error } = await supa.from("deal_terms")
          .upsert({ ...baseRow, ...rentRow }, { onConflict: "card_id" });
        // Migration 034 not run yet — save the fields that do exist rather than
        // losing the whole edit (same fail-soft pattern as loadAll's `archived`).
        if (error && /column|schema cache/i.test(error.message || "")) {
          console.warn("deal_terms rent/HOA columns missing (run sql/034) — saving base terms only");
          statusEl.textContent = "Saved base terms — rent/HOA columns need migration 034.";
          ({ error } = await supa.from("deal_terms").upsert(baseRow, { onConflict: "card_id" }));
        }
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
  // ── Deal Deck PDF link: copy a direct /deck/<slug>.pdf link.
  //
  // Two steps, because the file only exists once something has uploaded it and
  // until now only a blast ever did — copying the link on an unblasted deal
  // would have handed out one that 302s back to the deck page (H3). So: ask
  // deck-link.js; if it says needs_pdf, generate the deck right here (the same
  // jsPDF path as Download Deal Deck) and post it back to be hosted. ──
  document.querySelectorAll(".deck-pdf-copy-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.dataset.cardId;
      const label = btn.textContent;
      btn.disabled = true;
      try {
        let res = await fetchDeckPdfLink(cardId);
        if (res.needs_pdf) {
          btn.textContent = "Generating…";
          // returnBase64 throws instead of alerting, so a failed generate
          // surfaces as a toast here rather than a stray dialog.
          const dataUri = await generateDealDeck(cardId, null, { returnBase64: true });
          btn.textContent = "Uploading…";
          res = await fetchDeckPdfLink(cardId, dataUri);
        }
        if (!res.url) throw new Error("no PDF link came back");
        await copyText(res.url);
        btn.textContent = "✓ Copied";
      } catch (err) {
        toast(`Couldn't get the PDF link: ${err.message}`, { type: "error" });
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
  wireGalleryBlocks();
}


// ── Photo gallery (deck-page photos) — Storage folder gallery/<card_id>/ ──
// Three ways in: drag-drop/pick files (downscaled client-side), or paste ANY
// link (Drive folder / listing page / direct image URLs) and import-photos.js
// pulls everything server-side. photos_count auto-syncs to the real count so
// the "Need More Photos" flag reflects reality, not a hand-typed number.
// 🧲 Zillow grabber bookmarklet. Zillow bot-walls its PAGES against servers,
// but Zach's own browser on the listing already has every photo URL — and the
// photo CDN (photos.zillowstatic.com) is not bot-walled, so import-photos.js
// can download whatever this harvests. One-time install: drag to bookmarks
// bar; on a listing, click it → all hi-res photo URLs land on the clipboard →
// paste into the Import box. Keep the logic in sync with zillowPhotoUrls()
// in import-photos.js (same URL pattern, largest-variant-per-photo).
const ZILLOW_GRABBER = [
  "javascript:(async()=>{",
  // 1) Exact: EVERY photo array on/under the property whose zpid matches the
  //    URL, unioned. Off-market pages (i.e. every wholesaling deal) stub the
  //    property's own responsivePhotos to ONE photo and park the real set
  //    under lastSoldListing.photos — a first-match-wins walk sees "1 photo"
  //    while the carousel says 41, so no early exit and no single-array pick.
  //    (Still scoped by zpid: a blind page scan returns "similar homes" too.)
  "const zp=(location.pathname.match(/\\/(\\d+)_zpid/)||[])[1]||'';",
  "const big=p=>{const s=(p&&p.mixedSources)||{},l=[].concat(s.jpeg||[],s.webp||[]);let b=null;",
  "for(const x of l)if(x&&x.url&&(!b||(x.width||0)>(b.width||0)))b=x;return b?b.url:((p&&(p.url||p.hiResImageLink))||'')};",
  "let urls=[];",
  "const el=document.getElementById('__NEXT_DATA__');",
  "if(el){try{const seen=new WeakSet(),arrs=[];const walk=(n,d,sj)=>{if(d>16||!n)return;",
  "if(typeof n==='string'){if(n.length>200&&(n[0]==='{'||n[0]==='[')){try{walk(JSON.parse(n),d+1,sj)}catch(e){}}return}",
  "if(typeof n!=='object')return;if(seen.has(n))return;seen.add(n);",
  "if(Array.isArray(n)){if(n.length&&n.some(p=>p&&typeof p==='object'&&p.mixedSources)){const u=n.map(big).filter(Boolean);if(u.length)arrs.push({u:u,s:sj})}",
  "for(const v of n)walk(v,d+1,sj);return}",
  "if(zp&&String(n.zpid||'')===zp)sj=true;",
  "for(const k in n)walk(n[k],d+1,sj)};walk(JSON.parse(el.textContent),0,false);",
  "let pool=arrs.filter(a=>a.s);if(!pool.length&&arrs.length)pool=[arrs.reduce((a,b)=>b.u.length>a.u.length?b:a)];",
  "pool.sort((a,b)=>b.u.length-a.u.length);for(const a of pool)urls.push(...a.u)}catch(e){}}",
  "let precise=urls.length>0;",
  // 2) Fallback: scoped to the gallery container only
  "if(!urls.length){for(const s of ['[data-testid=\"hollywood-vertical-media-wall\"] img','ul.photo-tile-list img','[class*=\"media-wall\"] img']){",
  "const u=[...document.querySelectorAll(s)].map(i=>{const ss=i.getAttribute('srcset')||'';let b={w:0,u:i.currentSrc||i.src||''};",
  "for(const q of ss.split(',')){const t=q.trim().split(/\\s+/),w=+(t[1]||'').replace('w','')||0;if(t[0]&&w>b.w)b={w:w,u:t[0]}}return b.u})",
  ".filter(u=>u&&u.includes('photos.zillowstatic.com'));if(u.length>=3){urls=u;precise=true;break}}}",
  // 3) Last resort: whole page (imprecise — warn)
  "if(!urls.length){const re=/https:\\/\\/photos\\.zillowstatic\\.com\\/fp\\/([a-f0-9]{12,})-[a-zA-Z_]*?(\\d{2,4})[0-9_]*\\.(?:jpe?g|webp)/g;",
  "const h=document.documentElement.innerHTML,best={},order=[];let m;",
  "while((m=re.exec(h))){const id=m[1],w=+m[2];if(!best[id]){best[id]={w:0,u:''};order.push(id)}if(w>best[id].w)best[id]={w:w,u:m[0]}}",
  "urls=order.filter(id=>best[id].w>=300).map(id=>best[id].u);precise=false}",
  // dedupe by photo hash + cap
  "const seenH=new Set();urls=urls.filter(u=>{const k=(u.match(/\\/fp\\/([a-f0-9]{12,})/)||[,u])[1];if(seenH.has(k))return false;seenH.add(k);return true}).slice(0,80);",
  "if(!urls.length){alert('No Zillow photos found. Open the listing page (not search results) and try again.');return}",
  "const note=precise?'':'\\n\\nHeads-up: these could not be matched to this listing exactly, so some may be from \\u201csimilar homes\\u201d on the page — review the gallery after importing.';",
  "try{await navigator.clipboard.writeText(urls.join('\\n'));alert('\\u2713 Copied '+urls.length+' photo links. Paste them into the deal\\u2019s \\u201cImport from link\\u201d box.'+note)}",
  "catch(e){prompt('Copy these photo links:',urls.join(' '))}",
  "})()",
].join("");

function galleryBlockHtml(p, acq) {
  const n = Number((acq || {}).photos_count) || 0;
  return `
  <div class="gallery-block" data-card-id="${escapeHtml(p.card_id)}" style="border:1px dashed var(--border);border-radius:10px;padding:10px 12px;margin-top:6px">
    <div class="flex gap-8" style="align-items:center;flex-wrap:wrap">
      <span class="acq-media-icon gallery-icon">${n >= 10 ? "✅" : "❌"}</span>
      <span class="acq-media-label">Photo gallery</span>
      <span class="acq-media-status ${n >= 10 ? "ok" : "bad"} gallery-count">${n} photo${n === 1 ? "" : "s"}${n < 10 ? " — need 10+" : ""}</span>
      <span class="muted" style="font-size:0.72rem">powers the deck page's 📸 gallery; auto Street View + aerial shots show until real photos exist</span>
    </div>
    <div class="gallery-grid" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;min-height:10px"><span class="muted" style="font-size:0.76rem">Loading photos…</span></div>
    <div class="flex gap-8 mt-8" style="flex-wrap:wrap;align-items:center">
      <input type="file" class="gallery-file hidden" accept="image/*" multiple>
      <button type="button" class="btn btn-ghost btn-sm gallery-add-btn">📤 Add photos</button>
      <input type="text" class="gallery-import-url" placeholder="Paste Zillow photo links (🧲), a Drive folder, listing page, or image URLs" value="${escapeHtml(p.drive_link || "")}" style="flex:1;min-width:220px;font-size:0.8rem;padding:6px 10px;border:1px solid var(--border);border-radius:8px">
      <button type="button" class="btn btn-primary btn-sm gallery-import-btn">⬇ Import from link</button>
      <span class="muted gallery-status" style="font-size:0.78rem"></span>
    </div>
    <div class="muted" style="font-size:0.72rem;margin-top:6px">
      <b>Zillow</b> blocks direct server pulls, so photos come from your own browser tab.
      Best: install the <b>Seaside Photo Grabber</b> extension once (<code>browser-extension/</code> — see its README) and click 📸 on any listing; photos land here with the deal preselected.
      No-install fallback: drag <a href="${escapeHtml(ZILLOW_GRABBER)}" class="zillow-grabber-link" title="Drag me to your bookmarks bar (one-time). Then on any Zillow listing, click it and paste the result here." style="display:inline-block;padding:1px 8px;border:1px solid var(--border);border-radius:6px;font-weight:600;text-decoration:none">🧲 Grab Zillow Photos</a>
      to your bookmarks bar, click it on the listing, and paste above.
    </div>
  </div>`;
}

const GALLERY_MAX_DIM = 1600;
function galleryPrefix(cardId) { return `gallery/${cardId}`; }

async function listGallery(cardId) {
  const { data, error } = await supa.storage.from("property-photos")
    .list(galleryPrefix(cardId), { limit: 200, sortBy: { column: "name", order: "asc" } });
  if (error) throw error;
  return (data || []).filter(f => f.name && !f.name.startsWith("."));
}

// Downscale to ≤1600px JPEG before upload — a 5 MB phone photo becomes ~300 KB,
// which is what keeps the deck page fast on a buyer's phone. Files the browser
// can't decode (HEIC outside Safari) throw with a convert-to-JPG hint.
async function downscalePhoto(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch (_) { throw new Error(`${file.name}: this browser can't read that format (HEIC? export as JPG first)`); }
  const scale = Math.min(1, GALLERY_MAX_DIM / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", 0.82));
  if (!blob) throw new Error(`${file.name}: couldn't convert`);
  return blob;
}

// photos_count mirrors the real gallery size (same upsert shape as saveField).
async function syncGalleryCount(cardId, n) {
  await supa.from("deal_acquisition").upsert(
    { card_id: cardId, photos_count: n, updated_at: new Date().toISOString() },
    { onConflict: "card_id" });
  const deal = dealCache[cardId];
  if (deal) deal.acq = { ...(deal.acq || {}), photos_count: n };
  if (boardData && boardData.acqByCard) {
    boardData.acqByCard[cardId] = { ...(boardData.acqByCard[cardId] || { card_id: cardId }), photos_count: n };
  }
}

// Import in rounds until the source is exhausted — the function caps each run
// at 16 photos to stay inside its time budget, and re-runs skip what's already
// imported, so a 40-photo listing finishes without the user clicking 3 times.
async function runImportRounds(cardId, url, onProgress) {
  const { data: { session: s } } = await supa.auth.getSession();
  let imported = 0, already = 0, rounds = 0;
  while (rounds < 5) {
    rounds++;
    if (onProgress) onProgress(rounds === 1 ? "Fetching photos…" : `Fetching more… (${imported} so far)`);
    const res = await fetch("/.netlify/functions/import-photos", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ card_id: cardId, url }),
    });
    const result = await res.json();
    if (!res.ok) {
      if (imported) break; // partial success already banked — report it
      throw new Error(result.error || "Import failed");
    }
    imported += result.imported || 0;
    already = result.already || 0;
    if (!result.partial) break;
  }
  return { imported, already };
}

// ── Chrome-extension / bookmarklet handoff ──
// The extension opens dashboard.html#import-photos=<urls>&addr=<address>.
// We pick the matching deal by address (user confirms) and import — so the
// whole Zillow flow is: click the button on the listing, confirm the deal.
function addressMatchScore(dealName, addr) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const a = new Set(norm(addr));
  const d = norm(dealName);
  if (!a.size || !d.length) return 0;
  return d.filter(t => a.has(t)).length;
}
async function handlePhotoHandoff() {
  const m = location.hash.match(/^#import-photos=([^&]*)(?:&addr=([^&]*))?(?:&approx=(\d))?$/);
  if (!m || !boardData) return;
  const allUrls = decodeURIComponent(m[1] || "").split(/\s+/).map(s => s.trim()).filter(Boolean);
  const addr = decodeURIComponent(m[2] || "");
  const approx = m[3] === "1"; // grabber couldn't isolate THIS listing's photos
  history.replaceState(null, "", location.pathname); // don't re-fire on refresh
  if (!allUrls.length) return;

  // A precise send is isolated to this listing by the grabber, and big MLS
  // galleries legitimately run 40–80 photos — import it in full. Only an
  // approx send (the grabber's page-wide fallback) can hold other listings'
  // photos, so only that gets sliced rather than flooding the gallery with
  // neighbours' houses.
  const SANE_MAX = approx ? 40 : 80;
  const urls = allUrls.slice(0, SANE_MAX);
  const trimmed = allUrls.length - urls.length;

  const props = [...boardData.props].sort((x, y) =>
    addressMatchScore(y.name, addr) - addressMatchScore(x.name, addr) ||
    String(x.name || "").localeCompare(String(y.name || "")));
  if (!props.length) { toast("No active deals to import into.", { type: "error" }); return; }

  const warn = (approx || trimmed)
    ? `<p style="margin:0 0 12px;padding:9px 12px;background:#FFFAF0;border:1px solid #F6C468;border-radius:9px;font-size:0.8rem;color:#7B5A16">
         ⚠️ These photos couldn't be matched to this listing exactly${trimmed ? ` (${allUrls.length} found — importing the first ${urls.length})` : ""}, so a few may belong to "similar homes" shown on the page. Review the gallery after importing and delete any that aren't this property.
       </p>`
    : "";

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="card" style="width:100%;max-width:460px">
      <h2 style="margin-top:0">📸 Import ${urls.length} photo${urls.length === 1 ? "" : "s"}</h2>
      <p class="muted" style="margin-top:-8px;font-size:0.86rem">${addr ? `From <b>${escapeHtml(addr)}</b>. ` : ""}Pick the deal these belong to.</p>
      ${warn}
      <div class="field">
        <label>Deal</label>
        <select id="handoff-deal">${props.map(p => `<option value="${escapeHtml(p.card_id)}">${escapeHtml(p.name)}</option>`).join("")}</select>
      </div>
      <div class="flex gap-8 mt-16" style="justify-content:flex-end;align-items:center">
        <span class="muted" id="handoff-status" style="font-size:0.8rem;margin-right:auto"></span>
        <button type="button" class="btn btn-ghost" id="handoff-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="handoff-go">Import photos</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const close = () => backdrop.remove();
  backdrop.querySelector("#handoff-cancel").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector("#handoff-go").addEventListener("click", async () => {
    const cardId = backdrop.querySelector("#handoff-deal").value;
    const goBtn = backdrop.querySelector("#handoff-go");
    const statusEl = backdrop.querySelector("#handoff-status");
    goBtn.disabled = true;
    try {
      const { imported, already } = await runImportRounds(cardId, urls.join("\n"), (msg) => { statusEl.textContent = msg; });
      close();
      expandedDealCards.add(cardId);
      toast(`✓ Imported ${imported} photo${imported === 1 ? "" : "s"}${already ? ` · ${already} already there` : ""}.`, { type: "success", duration: 7000 });
      await loadAll();
    } catch (e) {
      statusEl.textContent = "";
      goBtn.disabled = false;
      toast(`Import failed: ${e.message}`, { type: "error", duration: 9000 });
    }
  });
}

function wireGalleryBlocks() {
  document.querySelectorAll(".gallery-block").forEach(block => {
    const cardId = block.dataset.cardId;
    const grid = block.querySelector(".gallery-grid");
    const statusEl = block.querySelector(".gallery-status");

    async function refresh() {
      let files = [];
      try { files = await listGallery(cardId); }
      catch (e) { grid.innerHTML = `<span class="muted" style="font-size:0.76rem">Couldn't list photos: ${escapeHtml(e.message)}</span>`; return; }
      // Keep the count chip + boardData honest without a full re-render.
      const n = files.length;
      const countEl = block.querySelector(".gallery-count");
      if (countEl) { countEl.textContent = `${n} photo${n === 1 ? "" : "s"}${n < 10 ? " — need 10+" : ""}`; countEl.className = `acq-media-status ${n >= 10 ? "ok" : "bad"} gallery-count`; }
      const iconEl = block.querySelector(".gallery-icon");
      if (iconEl) iconEl.textContent = n >= 10 ? "✅" : "❌";
      const cachedN = Number(((dealCache[cardId] || {}).acq || {}).photos_count) || 0;
      if (n !== cachedN) syncGalleryCount(cardId, n); // fire-and-forget
      if (!n) { grid.innerHTML = `<span class="muted" style="font-size:0.76rem">No photos yet — the deck page shows auto Street View + aerial shots until you add some.</span>`; return; }
      grid.innerHTML = files.map(f => {
        const { data } = supa.storage.from("property-photos").getPublicUrl(`${galleryPrefix(cardId)}/${f.name}`);
        return `
        <span style="position:relative;display:inline-block">
          <a href="${escapeHtml(data.publicUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(data.publicUrl)}" loading="lazy" alt="" style="width:74px;height:74px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"></a>
          <button type="button" class="gallery-del" data-name="${escapeHtml(f.name)}" title="Remove this photo" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:none;background:var(--red,#C53030);color:#fff;font-size:0.72rem;line-height:1;cursor:pointer">×</button>
        </span>`;
      }).join("");
      grid.querySelectorAll(".gallery-del").forEach(btn => btn.addEventListener("click", async () => {
        if (!confirm("Remove this photo from the gallery?")) return;
        const { error } = await supa.storage.from("property-photos").remove([`${galleryPrefix(cardId)}/${btn.dataset.name}`]);
        if (error) { toast(`Couldn't remove: ${error.message}`, { type: "error" }); return; }
        await refresh();
      }));
    }

    // The 🧲 link is for dragging to the bookmarks bar — clicking it here
    // can't run (and shouldn't), so turn a click into instructions.
    block.querySelectorAll(".zillow-grabber-link").forEach(a => a.addEventListener("click", (e) => {
      e.preventDefault();
      toast("Drag the 🧲 button up to your bookmarks bar (one-time). Then on any Zillow listing, click that bookmark — it copies every photo link — and paste into the Import box here.", { type: "info", duration: 9000 });
    }));

    const fileInput = block.querySelector(".gallery-file");
    block.querySelector(".gallery-add-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return;
      const stamp = Date.now();
      let ok = 0;
      const problems = [];
      for (let i = 0; i < files.length; i++) {
        statusEl.textContent = `Uploading ${i + 1} of ${files.length}…`;
        try {
          const blob = await downscalePhoto(files[i]);
          const path = `${galleryPrefix(cardId)}/${stamp}-${String(i).padStart(2, "0")}.jpg`;
          const { error } = await supa.storage.from("property-photos").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
          if (error) throw new Error(`${files[i].name}: ${error.message}`);
          ok++;
        } catch (e) {
          problems.push(e.message);
        }
      }
      fileInput.value = "";
      statusEl.textContent = "";
      await refresh();
      if (ok) toast(`✓ Added ${ok} photo${ok === 1 ? "" : "s"} to the gallery.`, { type: "success" });
      if (problems.length) toast(`${problems.length} file${problems.length === 1 ? "" : "s"} skipped — ${problems[0]}`, { type: "error", duration: 8000 });
    });

    block.querySelector(".gallery-import-btn").addEventListener("click", async () => {
      const url = block.querySelector(".gallery-import-url").value.trim();
      if (!url) { statusEl.textContent = "Paste a link first."; return; }
      const btn = block.querySelector(".gallery-import-btn");
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Importing…";
      try {
        const { imported, already } = await runImportRounds(cardId, url, (msg) => { statusEl.textContent = msg; });
        statusEl.textContent = "";
        const bits = [`✓ Imported ${imported} photo${imported === 1 ? "" : "s"}`];
        if (already) bits.push(`${already} already in the gallery`);
        toast(`${bits.join(" · ")}.`, { type: "success", duration: 7000 });
        await refresh();
      } catch (e) {
        statusEl.textContent = "";
        toast(`Import failed: ${e.message}`, { type: "error", duration: 9000 });
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });

    refresh();
  });
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
  // `.structure-panel` covers BOTH the Morby and the Cash panel — which table
  // a field lands in comes from the panel's own data-table, so adding a fourth
  // structure later means rendering a panel, not editing this function.
  document.querySelectorAll(".structure-panel").forEach(panel => {
    const cardId = panel.dataset.cardId;
    const table = panel.dataset.table || "morby_deals";
    const cacheKey = panel.dataset.structure === "cash" ? "cash" : "morby";
    const flash = panel.querySelector(".acq-saved-flash");
    let flashTimer = null;
    const showSaved = () => {
      flash.classList.add("show");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove("show"), 1600);
    };

    async function saveField(field, value) {
      const row = { card_id: cardId, [field]: value, updated_at: new Date().toISOString() };
      const { error } = await supa.from(table).upsert(row, { onConflict: "card_id" });
      if (error) { alert(`Couldn't save: ${error.message}`); return; }
      const deal = dealCache[cardId];
      if (deal) deal[cacheKey] = { ...(deal[cacheKey] || {}), [field]: value };
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
      const panel = document.querySelector(`.structure-panel[data-card-id="${cardId}"]`);
      const deal  = dealCache[cardId];
      if (!panel || !deal) return;

      // Read live purchase price from form. Both structures store it under
      // purchase_price, so the same selector works for either panel.
      const structKey = panel.dataset.structure === "cash" ? "cash" : "morby";
      const priceInput = panel.querySelector('.acq-input[data-field="purchase_price"]');
      const price = Number(priceInput?.value) || Number(deal[structKey]?.purchase_price) || 0;
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
        openBlastModal(btn, { isDeckPdfBlast: true, dealDeckPdf: pdfBase64 });
      } catch (e) {
        alert(`Couldn't generate Deal Deck: ${e.message}`);
        btn.textContent = original;
        btn.disabled = false;
      }
    });
  });

  // ── Upload LOI → AI extraction (Morby) ──
  document.querySelectorAll(".morby-loi-btn").forEach(btn => {
    btn.addEventListener("click", () => extractLoi(btn));
  });

  // ── Upload contract → AI extraction (Cash) ──
  document.querySelectorAll(".cash-extract-btn").forEach(btn => {
    btn.addEventListener("click", () => extractCashContract(btn));
  });

  // ── Move a deal between structures (Morby ⇄ Cash) ──
  document.querySelectorAll(".to-cash-btn").forEach(btn => {
    btn.addEventListener("click", () => convertMorbyToCash(btn.dataset.cardId, btn.dataset.address));
  });
  document.querySelectorAll(".to-morby-btn").forEach(btn => {
    btn.addEventListener("click", () => moveCashBackToMorby(btn.dataset.cardId, btn.dataset.address));
  });

  // ── "Use as amount forgiven" — writes directly rather than dispatching a
  // synthetic blur. The panel's blur handler is async and dispatchEvent does
  // not await it, so re-rendering after one raced the save and painted the
  // old (blank) value back over the new one. ──
  document.querySelectorAll(".use-carry-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const cardId = btn.closest(".structure-panel")?.dataset.cardId;
      if (!cardId) return;
      btn.disabled = true;
      const { error } = await supa.from("cash_deals").upsert(
        { card_id: cardId, amount_forgiven: Number(btn.dataset.amount), updated_at: new Date().toISOString() },
        { onConflict: "card_id" },
      );
      if (error) { toast(`Couldn't save: ${error.message}`, { type: "error" }); btn.disabled = false; return; }
      await loadAll(); // re-render so the derived original price + "% off" catch up
    });
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
  return arrayBufferToBase64(await file.arrayBuffer());
}

async function extractLoi(btn) {
  const cardId = btn.dataset.cardId;
  const panel = btn.closest(".structure-panel");
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

// Files Claude accepts. HEIC (the iPhone default) is deliberately excluded —
// Claude's API rejects it — so we steer the user to convert rather than fail
// server-side with a cryptic message. Shared by both cash upload paths.
const CASH_ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];
const CASH_MAX_BYTES = 4 * 1024 * 1024; // base64 inflates ~4/3, and it all rides one function call

async function cashFilePayload(f) {
  return { media_type: f.type, data: await pdfFileToBase64(f) };
}

// Validates the (contract, optional concession) pair the same way for the
// "+ Add Cash Deal" panel and the in-card re-extract. Returns an error string
// or null — callers surface it in their own status element.
function cashUploadError(contract, concession) {
  if (!contract) return "Choose the contract file first.";
  const files = [contract, concession].filter(Boolean);
  if (files.some(f => !CASH_ALLOWED.includes(f.type))) {
    return "Files must be PDF, JPG, PNG, GIF, or WebP. (iPhone HEIC photos: convert to JPG first.)";
  }
  if (files.reduce((n, f) => n + f.size, 0) > CASH_MAX_BYTES) {
    return "Files too large — keep the combined size under 4 MB (compress/re-save, or screenshot a smaller region).";
  }
  return null;
}

// ── In-card "📤 Extract" on a cash panel — re-reads the contract into an
// EXISTING card, the way extractLoi does for Morby. parse-cash upserts on
// card_id, so this refreshes the terms without creating a second card. ──
async function extractCashContract(btn) {
  const cardId = btn.dataset.cardId;
  const panel = btn.closest(".structure-panel");
  const contractInput = panel.querySelector(".cash-contract-input");
  const concessionInput = panel.querySelector(".cash-concession-input");
  const statusEl = panel.querySelector(".cash-extract-status");
  const contract = contractInput.files && contractInput.files[0];
  const concession = concessionInput.files && concessionInput.files[0];

  const err = cashUploadError(contract, concession);
  if (err) { statusEl.textContent = err; return; }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reading…";
  statusEl.textContent = "";
  try {
    const body = { card_id: cardId, contract: await cashFilePayload(contract) };
    if (concession) body.concession = await cashFilePayload(concession);
    btn.textContent = "Extracting…";
    const { data: { session: s } } = await supa.auth.getSession();
    const res = await fetch("/.netlify/functions/parse-cash", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Extraction failed");
    statusEl.textContent = "✓ Extracted — review the terms below.";
    await loadAll();
  } catch (e) {
    statusEl.textContent = `Couldn't extract: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── "+ Add Cash Deal" — create a card from a contract upload. Mirrors
// wireAddSubtoPanel, minus the generate-copy call: cash deals go out as a Deal
// Deck (like Morby), not as the three marketing-copy variations. ──
function wireAddCashPanel() {
  const addBtn = document.getElementById("add-cash-btn");
  const panel = document.getElementById("add-cash-panel");
  const cancelBtn = document.getElementById("add-cash-cancel");
  const submitBtn = document.getElementById("add-cash-submit");
  const contractInput = document.getElementById("add-cash-contract");
  const concessionInput = document.getElementById("add-cash-concession");
  const statusEl = document.getElementById("add-cash-status");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => panel.classList.toggle("hidden"));
  cancelBtn.addEventListener("click", () => {
    panel.classList.add("hidden");
    contractInput.value = "";
    concessionInput.value = "";
    statusEl.textContent = "";
  });

  submitBtn.addEventListener("click", async () => {
    const contract = contractInput.files && contractInput.files[0];
    const concession = concessionInput.files && concessionInput.files[0];
    const err = cashUploadError(contract, concession);
    if (err) { statusEl.textContent = err; return; }

    const original = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Reading files…";
    statusEl.textContent = "";
    try {
      const body = { contract: await cashFilePayload(contract) };
      if (concession) body.concession = await cashFilePayload(concession);

      submitBtn.textContent = "Extracting terms with AI…";
      const { data: { session: s } } = await supa.auth.getSession();
      const res = await fetch("/.netlify/functions/parse-cash", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Extraction failed");
      // Open the new card in full so the extracted price stack is reviewed,
      // not buried as a collapsed row.
      if (result.card_id) expandedDealCards.add(result.card_id);

      panel.classList.add("hidden");
      contractInput.value = "";
      concessionInput.value = "";
      await loadAll(); // re-renders #content, so report via toast
      toast("✓ Cash deal created — check the price stack before blasting.", { type: "success" });
    } catch (e) {
      statusEl.textContent = `Couldn't create deal: ${e.message}`;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
}

// ── Moving a deal between structures ────────────────────────────────────
// Morby deals routinely land as cash deals once the seller stops wanting to
// carry. These are the columns that mean the SAME thing on both tables, so
// they move across untouched.
const MORBY_TO_CASH_FIELDS = [
  "property_type", "address_override", "purchase_price", "down_payment",
  "earnest_money_amount", "closing_costs_note", "broker_commission",
  "additional_broker_pct", "inspection_period_days", "close_of_escrow_days",
  "financing_contingency", "tenancy_description", "property_description",
  "ltr_monthly_rent", "str_monthly_rent", "annual_noi", "monthly_noi",
  "monthly_taxes", "monthly_insurance", "dscr_rate", "dscr_ltv",
  "dscr_credit_score",
];

// Seller-financing-only. These have no cash_deals column at all — including
// one in the copied row would 400 the upsert, and more to the point they
// describe a note the seller is no longer carrying.
const MORBY_ONLY_FIELDS = [
  "seller_carry_balance", "interest_type", "deferred_interest_rate",
  "monthly_payment", "balloon_months", "seller_flexibility_notes",
];

// Morby → Cash. Deliberately NON-DESTRUCTIVE: the morby_deals row is left
// exactly as it is, so nothing is lost, the move is undoable from the toast,
// and the cash panel can still show what the seller carry used to be.
//
// It also deliberately does NOT guess the Amount Forgiven. The carry balance
// is the obvious candidate — it's the money the seller was going to be owed —
// but "carried $285k" and "forgave $285k" are different deals, and this number
// becomes the headline on a page investors read. It's offered as a one-click
// suggestion in the panel instead, where it can be looked at.
async function convertMorbyToCash(cardId, address) {
  const deal = dealCache[cardId];
  if (!deal) return;
  const m = deal.morby || {};
  const existing = deal.cash || {};

  // R3's recipient ledger is keyed on card_id, not on structure, so a deal
  // that was blasted as Morby carries that history across the move.
  const hasBlasted = ((boardData && boardData.blastsByCard && boardData.blastsByCard[cardId]) || [])
    .some(b => b.status === "sent");

  const dropped = [];
  if (m.seller_carry_balance) dropped.push(`seller carry ${fmtMoney(m.seller_carry_balance)}`);
  if (m.deferred_interest_rate) dropped.push(`${m.deferred_interest_rate}% deferred interest`);
  if (m.balloon_months) dropped.push(`${m.balloon_months}-month balloon`);
  if (m.seller_flexibility_notes) dropped.push("seller flexibility notes");

  const msg =
    `Move "${address}" from Morby to Cash?\n\n` +
    `CARRIED OVER: purchase price, deposits, timeline, DSCR assumptions, rents, taxes & insurance, property details, deck address and photos.\n\n` +
    (dropped.length
      ? `DROPPED from the deck — seller financing has no cash equivalent: ${dropped.join(", ")}.\n\n`
      : "") +
    `You still need to set the Amount Forgiven; the panel will suggest the old carry balance.\n\n` +
    (hasBlasted
      ? `NOTE: this deal has already been blasted. A normal blast skips anyone who's already received it, so buyers who got the Morby version won't get the cash one — use "Choose specific buyers" to reach them.\n\n`
      : "") +
    `The Morby terms are kept, so this can be undone.`;
  if (!confirm(msg)) return;

  const row = { card_id: cardId, updated_at: new Date().toISOString() };
  for (const f of MORBY_TO_CASH_FIELDS) {
    // Never clobber a value already on the cash row. Converting a second time
    // (after an undo, or after moving back and forth) must not wipe edits
    // made on the cash side.
    const blank = existing[f] === null || existing[f] === undefined || existing[f] === "";
    if (blank && m[f] !== null && m[f] !== undefined) row[f] = m[f];
  }

  // Belt and braces: cash_deals has no column for any of these, so one
  // slipping into MORBY_TO_CASH_FIELDS would 400 the upsert on a live button.
  for (const f of MORBY_ONLY_FIELDS) delete row[f];

  const { error: cErr } = await supa.from("cash_deals").upsert(row, { onConflict: "card_id" });
  if (cErr) { toast(`Couldn't move to Cash: ${cErr.message}`, { type: "error" }); return; }
  // deal_type flips LAST: if the upsert failed we've changed nothing, rather
  // than stranding the card in a group with no terms row behind it.
  const { error: pErr } = await supa.from("properties").update({ deal_type: "cash" }).eq("card_id", cardId);
  if (pErr) { toast(`Couldn't move to Cash: ${pErr.message}`, { type: "error" }); return; }

  // The hosted Deal Deck at deal-decks/<slug>.pdf is still the MORBY deck —
  // seller carry, balloon, the lot. deck.js gates its PDF button (and the
  // /deck/<slug>.pdf route) purely on that file existing, so leaving it would
  // hand investors a seller-finance deck for a deal the page calls cash.
  // Removing it just hides the button until the next blast or Copy PDF link
  // regenerates it from the cash terms. Best-effort: never fail the move.
  const slug = deal.prop && deal.prop.deck_slug;
  if (slug) {
    try { await supa.storage.from("property-photos").remove([`deal-decks/${slug}.pdf`]); }
    catch (e) { console.warn("stale deck PDF cleanup failed:", e.message); }
  }

  expandedDealCards.add(cardId); // land in the panel, not on a collapsed row
  toast(`Moved "${address}" to Cash — set the Amount Forgiven before blasting.`, {
    type: "success",
    actionLabel: "Undo",
    onAction: async () => {
      const { error } = await supa.from("properties").update({ deal_type: "morby" }).eq("card_id", cardId);
      if (error) { toast(`Undo failed: ${error.message}`, { type: "error" }); return; }
      await loadAll();
    },
  });
  await loadAll();
}

// Cash → Morby. Only offered on a card that still HAS a morby_deals row, i.e.
// one that came from a conversion — so this is "undo the move", available long
// after the toast is gone, not a general structure switcher.
async function moveCashBackToMorby(cardId, address) {
  if (!confirm(`Move "${address}" back to Morby?\n\nThe Morby terms are still on file. Anything you entered on the cash side is kept too, so you can move it to Cash again.`)) return;
  const { error } = await supa.from("properties").update({ deal_type: "morby" }).eq("card_id", cardId);
  if (error) { toast(`Couldn't move back: ${error.message}`, { type: "error" }); return; }
  expandedDealCards.add(cardId);
  toast(`Moved "${address}" back to Morby.`, {
    type: "success",
    actionLabel: "Undo",
    onAction: async () => {
      const { error: e2 } = await supa.from("properties").update({ deal_type: "cash" }).eq("card_id", cardId);
      if (e2) { toast(`Undo failed: ${e2.message}`, { type: "error" }); return; }
      await loadAll();
    },
  });
  await loadAll();
}

async function generateDealDeck(cardId, btn, { returnBase64 = false } = {}) {
  const deal = dealCache[cardId];
  if (!deal) return;
  const p = deal.prop, t = deal.terms || {};
  // Both structures render through this one generator: the jsPDF layout engine
  // below (section headers, rows, two-column sections, footer) is identical,
  // and only the CONTENT MODEL differs. Duplicating it for cash would be ~500
  // lines free to drift apart visually.
  const isCash = p.deal_type === "cash";
  // Use live values straight from the form, so an edited field that hasn't
  // blurred (and therefore hasn't saved yet) is still reflected in the deck.
  const m = { ...((isCash ? deal.cash : deal.morby) || {}) };
  const structPanel = document.querySelector(`.structure-panel[data-card-id="${cardId}"]`);
  if (structPanel) {
    structPanel.querySelectorAll(".acq-input[data-field]").forEach(input => {
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
  const stack = isCash ? DealShared.cashPriceStack(m) : null;
  // On a cash deal the DSCR loan sizes off the DERIVED purchase price, not the
  // stored column: a deal entered as original + forgiven leaves purchase_price
  // null, and reading it raw produced a $0 loan and a $0 debt-service payment
  // on a buyer-facing deck. (Sizing off purchase price, not the original, is
  // also the conservative read — lenders lend on the lower of price or value.)
  const price = isCash ? (stack.purchase || 0) : (Number(m.purchase_price) || 0);
  const loanAmount = price * (dscrLtv / 100);
  const monthlyDebtService = dscrMonthlyPayment(price, dscrRate, dscrLtv);

  // Cash the buyer receives at close (same formula as the Stack Method email):
  //   loan proceeds − down payment − 5% closing costs − additional broker
  //   commission, split in half. Shown as a headline figure only when positive.
  const addlBrokerPct = Number(m.additional_broker_pct) || 0;
  const addlBrokerFee = price * (addlBrokerPct / 100);
  // Deliberately 0 on a cash deal — there is no assignment split to take a
  // share of, so any figure here would be money that never changes hands.
  // Every downstream use is already gated on `> 0`.
  const cashToBuyerAtClose = isCash
    ? 0
    : (loanAmount - (Number(m.down_payment) || 0) - price * 0.05 - addlBrokerFee) / 2;

  const fmt = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
  const fmtPct = (n) => `${Number(n) || 0}%`;

  const balloonYears = m.balloon_months ? (Number(m.balloon_months) / 12).toFixed(1).replace(/\.0$/, "") : "—";

  // Plain key/value rows for each section — laid out manually with jsPDF
  // (no html2canvas / off-screen DOM rendering, which was producing blank pages).
  const loiRows = isCash
    ? [
        // The price stack reads top-down, so the concession sits between the
        // two prices it explains. Down Payment / EMD only appears when it's
        // actually on the contract — an all-cash close has no such line.
        ["Original Price", fmt(stack.original)],
        ["Amount Forgiven", `${fmt(stack.forgiven)}${stack.discountPct ? ` (${stack.discountPct}% off)` : ""}`, true],
        ["Purchase Price", fmt(stack.purchase), true],
        ...(Number(m.down_payment) ? [["Down Payment / EMD", fmt(m.down_payment)]] : []),
        ["Earnest Money", fmt(m.earnest_money_amount)],
        ["Closing Costs", m.closing_costs_note || "Buyer pays all closing costs"],
        ["Broker Commission", m.broker_commission || "None"],
      ]
    : [
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
  // A cash deal has no seller note, so this isn't a $0 payment — it's a line
  // that doesn't exist. Printing "Seller Financing Pmt ($0)" invites the
  // question of what seller financing.
  const sellerPmtRow = isCash ? [] : [["Seller Financing Pmt", fmtExpense(sellerPmt)]];
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
      ...sellerPmtRow,
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
      ...sellerPmtRow,
      ...(taxes     ? [["Property Taxes",  fmtExpense(taxes)]]     : []),
      ...(insurance ? [["Insurance",        fmtExpense(insurance)]] : []),
      ["Net Cash Flow",        fmt(ltrNet), true],
    ];
    cashFlowRightRows = [
      ["Rental Income (STR)",  fmt(str)],
      ["DSCR Loan Payment",    fmtExpense(monthlyDebtService)],
      ...sellerPmtRow,
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
    const [logoDataUrl, deckFonts] = await Promise.all([loadLogoDataUrl(), loadDeckFontData()]);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
    // Every setFont below goes through this, so a font that failed to load
    // degrades the whole deck to Helvetica rather than half of it.
    const deckFont = registerDeckFont(doc, deckFonts);
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
    doc.setFont(deckFont, "bold");
    doc.setFontSize(16);
    doc.setTextColor(...NAVY);
    doc.text("Seaside Horizon", textX, y);
    // Structure label, right-aligned on the header line, so the deck names
    // what kind of deal it is before a single number is read.
    if (isCash) {
      doc.setFontSize(11);
      doc.setTextColor(...GOLD);
      const tag = "CASH DEAL";
      doc.text(tag, pageW - marginX - doc.getTextWidth(tag), y);
    }
    y += 18;
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(2);
    doc.line(marginX, y, pageW - marginX, y);
    y += 22;

    // ── Title ──
    doc.setFont(deckFont, "bold");
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
    // Cash: the price stack replaces Seller Carry Balance, and Balloon is gone
    // — there is no note to balloon. Amount Forgiven sits second, where the
    // eye lands after the price.
    const summaryStats = isCash
      ? (propertyType === "commercial"
          ? [
              ["Purchase Price", fmt(stack.purchase)],
              ["Amount Forgiven", fmt(stack.forgiven)],
              ["Original Price", fmt(stack.original)],
              [cashFlowLabelLtr, cashFlowHeadlineLtr],
            ]
          : [
              ["Purchase Price", fmt(stack.purchase)],
              ["Amount Forgiven", fmt(stack.forgiven)],
              ["Original Price", fmt(stack.original)],
              [cashFlowLabelLtr, cashFlowHeadlineLtr],
              [cashFlowLabelStr, cashFlowHeadlineStr],
            ])
      : propertyType === "commercial"
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
      doc.setFont(deckFont, "normal");
      doc.setFontSize(6.5);
      doc.setTextColor(255, 255, 255);
      const labelW = doc.getTextWidth(label.toUpperCase());
      doc.text(label.toUpperCase(), cx - labelW / 2, y + 22);
      doc.setFont(deckFont, "bold");
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
      doc.setFont(deckFont, "bold");
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

    // Row values are right-aligned against the column edge, which only works
    // while they stay short. A free-text value out of the LOI (the closing-costs
    // note, a broker-commission sentence) is wider than the space beside its
    // label, so it used to start left of where the label ended and print
    // straight over it. Wrap those into the room that's actually left; callers
    // grow the row by the extra lines so nothing collides downward either.
    const VALUE_LINE_H = 11.5;
    const wrapValue = (label, value, width, bold) => {
      doc.setFont(deckFont, bold ? "bold" : "normal");
      doc.setFontSize(9.5);
      const text = String(value);
      // 12pt of air between label and value; never wrap narrower than 90pt, or
      // an unusually long label would shred the value into one word per line.
      const avail = Math.max(width - doc.getTextWidth(String(label)) - 12, 90);
      return doc.getTextWidth(text) <= avail ? [text] : doc.splitTextToSize(text, avail);
    };
    const rowHeight = (lines) => 15 + (lines.length - 1) * VALUE_LINE_H;

    const row = (label, value, bold) => {
      const lines = wrapValue(label, value, colW, bold);
      const h = rowHeight(lines);
      ensureSpace(h + 2);
      if (rowIndex % 2 === 0) {
        doc.setFillColor(250, 250, 252);
        doc.rect(marginX - 6, y - 11, colW + 12, h, "F");
      }
      rowIndex++;
      doc.setFont(deckFont, bold ? "bold" : "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 30, 46);
      if (bold) {
        doc.setDrawColor(...NAVY);
        doc.setLineWidth(1);
        doc.line(marginX, y - 9, pageW - marginX, y - 9);
      }
      doc.text(String(label), marginX, y);
      lines.forEach((line, i) => {
        doc.text(line, marginX + colW - doc.getTextWidth(line), y + i * VALUE_LINE_H);
      });
      y += h;
    };

    const paragraph = (text) => {
      doc.setFont(deckFont, "normal");
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
      doc.setFont(deckFont, "normal");
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
    // `h` is the shared height of the row across BOTH columns, so the two
    // backgrounds still line up when only one side wrapped.
    const rowAt = (x, w, label, value, bold, idx, h) => {
      const lines = wrapValue(label, value, w, bold);
      if (idx % 2 === 0) {
        doc.setFillColor(250, 250, 252);
        doc.rect(x - 6, y - 11, w + 12, h, "F");
      }
      doc.setFont(deckFont, bold ? "bold" : "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(30, 30, 46);
      if (bold) {
        doc.setDrawColor(...NAVY);
        doc.setLineWidth(1);
        doc.line(x, y - 9, x + w, y - 9);
      }
      doc.text(String(label), x, y);
      lines.forEach((line, i) => {
        doc.text(line, x + w - doc.getTextWidth(line), y + i * VALUE_LINE_H);
      });
    };

    // Two side-by-side mini-sections sharing a single row of headers —
    // used to pack Timeline & Contingencies next to DSCR Loan.
    const twoColumnSection = (leftTitle, leftRows, rightTitle, rightRows) => {
      const gap = 20;
      const halfW = (colW - gap) / 2;
      const maxRows = Math.max(leftRows.length, rightRows.length);
      // Both columns share a baseline, so the taller side sets each row's
      // height — measured up front so the section can't be split mid-row.
      const rowHeights = [];
      for (let i = 0; i < maxRows; i++) {
        const l = leftRows[i], r = rightRows[i];
        rowHeights.push(Math.max(
          l ? rowHeight(wrapValue(l[0], l[1], halfW, l[2])) : 15,
          r ? rowHeight(wrapValue(r[0], r[1], halfW, r[2])) : 15,
        ));
      }
      ensureSpace(20 + rowHeights.reduce((a, b) => a + b, 0) + 5);
      doc.setFillColor(245, 247, 250);
      doc.rect(marginX - 6, y - 13, halfW + 12, 21, "F");
      doc.rect(marginX + halfW + gap - 6, y - 13, halfW + 12, 21, "F");
      doc.setFont(deckFont, "bold");
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
        const h = rowHeights[i];
        if (leftRows[i]) rowAt(marginX, halfW, leftRows[i][0], leftRows[i][1], leftRows[i][2], i, h);
        if (rightRows[i]) rowAt(marginX + halfW + gap, halfW, rightRows[i][0], rightRows[i][1], rightRows[i][2], i, h);
        y += h;
      }
    };

    // ── Investment Highlights ──
    const highlights = [];
    if (isCash) {
      if (stack.forgiven) {
        const offPart = stack.discountPct ? ` — ${stack.discountPct}% off the ${fmt(stack.original)} original price` : "";
        highlights.push(`Seller is forgiving ${fmt(stack.forgiven)}${offPart}. That discount is equity you own the day you close.`);
      }
    } else if (m.seller_carry_balance) {
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
    if (isCash) {
      if (stack.purchase) {
        const forgivenPart = stack.forgiven ? ` with ${fmt(stack.forgiven)} forgiven` : "";
        highlights.push(`Total purchase price of ${fmt(stack.purchase)}${forgivenPart}. Cash close — no loan to take over and no seller carryback.`);
      }
    } else if (m.purchase_price) {
      const dpPart = m.down_payment ? ` with ${fmt(m.down_payment)} down` : "";
      highlights.push(`Total purchase price of ${fmt(m.purchase_price)}${dpPart}.`);
    }
    if (highlights.length) {
      sectionHeader("Investment Highlights");
      highlights.forEach(bulletParagraph);
      y += 3;
    }

    sectionHeader(isCash ? "Purchase Terms" : "LOI / Financial Terms");
    loiRows.forEach(([l, v, b]) => row(l, v, b));
    y += 5;

    // Seller Financing has no cash equivalent — the seller is paid in full and
    // out at closing. The whole section is omitted, not zeroed.
    if (!isCash) {
      sectionHeader(sellerFinancingTitle);
      financingRows.forEach(([l, v, b]) => row(l, v, b));
      y += 5;
    }

    twoColumnSection("Timeline & Contingencies", timelineRows, "DSCR Loan", dscrRows);
    y += 5;

    if (cashFlowRightRows.length) {
      twoColumnSection("Net Cash Flow (LTR)", cashFlowLeftRows, "Net Cash Flow (STR)", cashFlowRightRows);
    } else {
      sectionHeader("Cash Flow Analysis");
      cashFlowLeftRows.forEach(([l, v, b]) => row(l, v, b));
    }
    y += 5;

    // Also seller-financing-only: a cash seller has nothing left to flex on.
    if (!isCash && m.seller_flexibility_notes) {
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
      doc.setFont(deckFont, "normal");
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

// ── Deal Deck typeface ──────────────────────────────────────────────────────
// The PDF is set in Hanken Grotesk, the sans in seasidehorizon.com's own font
// stack (`"Soehne Buch", "Hanken Grotesk", sans-serif`) — so a deck sheet and
// the website read as the same brand. It is deliberately NOT Söhne itself:
// the site serves Klim's *test* cuts (`test-soehne-*.woff2`), which carry only
// 68 glyphs — no `$`, `%`, `(`, `)` or `—` — so a deck full of dollar figures
// would render with holes in it, and the test licence doesn't cover embedding
// in buyer-facing collateral. Hanken Grotesk is OFL (see fonts/OFL.txt),
// embeddable, and covers Latin-1 plus the typographic punctuation the LOI text
// carries.
//
// jsPDF needs the raw TTF as base64 in its virtual filesystem, so the files are
// fetched once per page and re-registered on each doc (the VFS is per-document).
// Everything here fails soft: if a fetch dies, the deck falls back to Helvetica
// and still generates — the same rule the logo already follows.
const DECK_FONT_FILES = [
  { file: "HankenGrotesk-Regular.ttf", style: "normal" },
  { file: "HankenGrotesk-Bold.ttf", style: "bold" },
];
const DECK_FONT_FAMILY = "HankenGrotesk";
let _deckFontPromise = null;

function loadDeckFontData() {
  if (_deckFontPromise) return _deckFontPromise;
  _deckFontPromise = Promise.all(DECK_FONT_FILES.map(({ file, style }) =>
    fetch(`/fonts/${file}`)
      .then((r) => { if (!r.ok) throw new Error(`${file}: ${r.status}`); return r.arrayBuffer(); })
      .then((buf) => ({ file, style, base64: arrayBufferToBase64(buf) }))
  )).catch(() => null);
  return _deckFontPromise;
}

// btoa() only takes a binary string, and spreading a whole font or contract
// into String.fromCharCode blows the argument limit — hence the chunking.
// Shared with pdfFileToBase64, which is the same conversion off a File.
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Registers the brand font on `doc` and returns the family name to set —
// "helvetica" if the font never loaded, so callers need no branch of their own.
function registerDeckFont(doc, fonts) {
  if (!fonts) return "helvetica";
  try {
    for (const { file, style, base64 } of fonts) {
      doc.addFileToVFS(file, base64);
      doc.addFont(file, DECK_FONT_FAMILY, style);
    }
    return DECK_FONT_FAMILY;
  } catch (e) {
    return "helvetica";
  }
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

let activeBlast = null; // { cardId, address, statusEl, matched, isDeckPdfBlast?, dealDeckPdf? }
// Buyer-facing name for each structure, used in the blast modal's subtitle.
const STRUCTURE_AUDIENCE = { morby: "Stack Method", cash: "cash", subto: "Sub-To" };

function openBlastModal(btn, { isDeckPdfBlast = false, dealDeckPdf = null, followUpIds = null } = {}) {
  const cardId = btn.dataset.cardId;
  const address = btn.dataset.address;
  // Morby/cash cards don't have a .blast-status el in the same .flex-between — use card header
  const statusEl = btn.closest(".flex-between")?.querySelector(".blast-status") || btn.closest(".card")?.querySelector(".blast-status") || btn;
  const deal = dealCache[cardId];
  const matched = (deal && deal.matched) || [];
  const nearMiss = (deal && deal.nearMiss) || [];
  const variations = isDeckPdfBlast ? [] : ((deal && deal.prop && deal.prop.variations) || []);
  // Deal params let us score any buyer (even ones not auto-matched) when the
  // user filters the "Choose specific buyers" list by method.
  const dealParams = deal
    ? { state: deal.prop.state, price: dealMatchPrice(deal.prop, deal.terms || {}, deal.cash), piti: Number(deal.terms?.piti) || 0, beds: Number(deal.terms?.beds) || 0 }
    : { state: "", price: 0, piti: 0, beds: 0 };
  activeBlast = { cardId, address, statusEl, matched, nearMiss, variations, isDeckPdfBlast, dealDeckPdf, dealParams, selectedIds: new Set() };

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

  document.getElementById("blast-modal-title").textContent = isDeckPdfBlast ? `Send Deal Deck — ${address}` : `Send Blast — ${address}`;
  const audienceName = STRUCTURE_AUDIENCE[(deal && deal.prop && deal.prop.deal_type) || "subto"] || "matching";
  document.getElementById("blast-modal-sub").textContent = isDeckPdfBlast
    ? `Deal Deck PDF will be emailed to ${matched.length} ${audienceName} buyer${matched.length === 1 ? "" : "s"}.`
    : `${matched.length} buyer${matched.length === 1 ? "" : "s"} match this deal's state${matched.some(b=>b.max_price||b.max_piti||b.min_beds) ? " & criteria" : ""}.`;
  renderAudienceSplit(matched, nearMiss);
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
    // The audience here is the follow-up list, not the matched list — the
    // split above it would be describing a different set of people.
    document.getElementById("blast-audience-split").innerHTML = "";
    if (variations.length > 1) { varSel.value = "1"; varSel.onchange && varSel.onchange(); }
    selectMethodGroup("__matched");
  }

  document.getElementById("blast-modal-backdrop").classList.remove("hidden");
}

// B4.1 — what the matched count is actually made of. A wildcard buyer has no
// state, strategy or budget on file, so they match every deal we ever send;
// seeing that split at the moment of sending is the whole point. This is
// display only — the audience is unchanged.
function renderAudienceSplit(matched, nearMiss) {
  const el = document.getElementById("blast-audience-split");
  if (!el) return;
  if (!matched.length && !(nearMiss || []).length) { el.innerHTML = ""; return; }
  const split = DealShared.buyBoxSplit(matched);
  const real = split.full + split.partial;
  const pct = split.total ? Math.round((split.wildcard / split.total) * 100) : 0;
  const near = (nearMiss || []).length;
  el.innerHTML = `
    <div style="background:#F7FAFC;border:1px solid var(--border);border-radius:8px;padding:8px 11px;font-size:0.78rem;color:var(--text-2);margin-bottom:10px">
      <div><strong style="color:var(--text-1)">${real}</strong> matched on their stated buy box ·
        <strong style="color:${split.wildcard ? "#B7791F" : "var(--text-1)"}">${split.wildcard}</strong> wildcard (no box on file)
        ${split.wildcard ? `<span class="muted"> — ${pct}% of this audience matches every deal you send</span>` : ""}</div>
      ${near ? `<div style="margin-top:5px;color:#B7791F">⚠ ${near} near miss${near === 1 ? "" : "es"} just outside their cap — not included. Pick “Choose specific buyers” → “Near miss” to add any.</div>` : ""}
    </div>`;
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
  // Near misses get their own group so adding one is always a deliberate act.
  if ((activeBlast.nearMiss || []).length) chips.push({ key: "__near", label: "Near miss", count: activeBlast.nearMiss.length });
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
  const list = key === "__matched" ? activeBlast.matched
    : key === "__near" ? (activeBlast.nearMiss || [])
    : (activeBlast.methodGroups[key] || []).map(decorateBuyer).sort((a, b) => b._score - a._score);
  renderBlastCheckboxes(list, key === "__near"
    ? `These buyers are just outside their own stated cap on this deal — within ${Math.round(DealShared.NEAR_MISS_TOLERANCE * 100)}% on price/PITI, or one bedroom short. None are selected; tick anyone you'd still send this to.`
    : "");
}

function updateSelectedCount() {
  const el = document.getElementById("blast-selected-count");
  if (el) el.textContent = `${activeBlast.selectedIds.size} selected total`;
}

function renderBlastCheckboxes(list, note = "") {
  const box = document.getElementById("blast-buyer-checkboxes");
  const sel = activeBlast.selectedIds;
  const noteHtml = note
    ? `<div style="background:#FFFAF0;border:1px solid #FBD38D;color:#B7791F;border-radius:8px;padding:7px 10px;font-size:0.76rem;margin-bottom:8px">${escapeHtml(note)}</div>`
    : "";
  box.innerHTML = noteHtml + list.map(raw => {
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
        ${DealShared.buyBoxCompleteness(b) === "wildcard" ? '<span style="font-size:0.66rem;color:#B7791F;font-weight:600" title="No market, strategy or budget on file — this buyer matches every deal, so this isn\'t a real match">✳ wildcard</span>' : ""}
        ${missing.length ? `<span style="font-size:0.66rem;color:#C53030;font-weight:600" title="Missing ${missing.join(', ')}">⚠ no ${missing.join("/")}</span>` : ""}
        <button type="button" class="btn btn-ghost btn-sm buyer-link-btn" data-buyer-id="${b.id}" style="margin-left:auto;font-size:0.7rem;padding:2px 8px" title="Copy this buyer's personal tracked deck link — views and Interested taps from it attribute to them, same as a blast">🔗</button>
        <button type="button" class="btn btn-ghost btn-sm log-outcome-btn" data-buyer-id="${b.id}" data-name="${escapeHtml(b.name)}" data-contact="${escapeHtml(b.email || b.phone || "")}" style="font-size:0.7rem;padding:2px 8px" title="Log this buyer's response in the deal pipeline">📋 Log</button>
      </span>
      ${reasons.length ? `<span class="muted" style="font-size:0.72rem;padding-left:26px">${reasons.map(escapeHtml).join(" · ")}</span>` : ""}
    </label>`;
  }).join("");
  if (!list.length) box.innerHTML = noteHtml + `<span class="muted" style="font-size:0.84rem">No buyers in this group.</span>`;

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
    // Hand-picked near misses (B4.4) aren't in `matched` but are really sent,
    // so they have to count against the daily email budget too.
    const audiencePool = idSet ? activeBlast.matched.concat(activeBlast.nearMiss || []) : activeBlast.matched;
    const emailAudience = channels.includes("email")
      ? audiencePool.filter(b => (!idSet || idSet.has(Number(b.id))) && b.email && !b.email_opt_out && !b.email_bounced_at).length
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
    if (activeBlast.isDeckPdfBlast) {
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
    if (activeBlast.isDeckPdfBlast) {
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

  // Photo handoff from the Chrome extension / bookmarklet (#import-photos=…).
  // Runs first and clears the hash, so the #deal= check below can't misread it.
  await handlePhotoHandoff();

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
