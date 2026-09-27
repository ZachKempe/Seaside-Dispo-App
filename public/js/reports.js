// Reports page — read-only rollups over the engagement data the platform
// already collects. Two sections: per-deal funnel and copy-variation
// performance. (Time-in-stage aging and closed-deal stats went with the
// Pipeline board, Sept 27 2026 — nothing moves deal stages any more.) Every
// query fails soft (missing migrations just leave a section sparse).

let session;

// escapeHtml comes from /js/ui-shared.js
function pct(part, whole) {
  if (!whole) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}
function bar(part, whole, color) {
  const w = whole ? Math.min(100, Math.round((part / whole) * 100)) : 0;
  return `<span class="rpt-bar"><span style="width:${w}%;${color ? `background:${color}` : ""}"></span></span>`;
}
function metricCell(count, total, color) {
  return `<div class="rpt-cell-metric"><span class="rpt-num"><b>${count}</b> <span class="muted">(${pct(count, total)})</span></span>${bar(count, total, color)}</div>`;
}
function shortAddr(name) { return escapeHtml((name || "").split(",")[0]); }

const INTEREST_RANK = new Set(["interested", "offer", "under_contract", "closed"]);

async function loadReports() {
  const loading = document.getElementById("rpt-loading");
  const content = document.getElementById("rpt-content");

  const [{ data: props }, { data: recips }, { data: events }, { data: views }, { data: leads }] = await Promise.all([
    supa.from("properties").select("card_id,name,deal_type,archived"),
    supa.from("blast_recipients").select("card_id,buyer_id,channel,status,variation_index,variation_title,blasted_at").order("blasted_at", { ascending: false }).limit(8000),
    supa.from("email_events").select("card_id,buyer_id,event").limit(8000),
    supa.from("deck_views").select("card_id,buyer_id,kind").limit(8000),
    supa.from("deal_leads").select("card_id,buyer_id,stage"),
  ]);

  if (!props) {
    loading.innerHTML = `<div class="empty">Couldn't load reports — check your connection and refresh.</div>`;
    return;
  }

  const byCard = (rows) => {
    const m = {};
    for (const r of (rows || [])) (m[r.card_id] ||= []).push(r);
    return m;
  };
  const recipsBy = byCard(recips), eventsBy = byCard(events), viewsBy = byCard(views), leadsBy = byCard(leads);

  renderFunnel(props, recipsBy, eventsBy, viewsBy, leadsBy);
  renderVariations(recips || [], events || [], leads || []);

  const active = props.filter(p => !p.archived).length;
  document.getElementById("rpt-sub").textContent =
    `${props.length} deal${props.length === 1 ? "" : "s"} tracked · ${active} active`;
  loading.classList.add("hidden");
  content.classList.remove("hidden");
}

// ── Section 1: per-deal funnel ────────────────────────────────────
function renderFunnel(props, recipsBy, eventsBy, viewsBy, leadsBy) {
  const rows = props
    .map(p => {
      const recips = recipsBy[p.card_id] || [];
      const emailSent = new Set(recips.filter(r => r.channel === "email" && r.status === "sent" && r.buyer_id != null).map(r => r.buyer_id));
      if (!emailSent.size && p.archived) return null; // never-blasted archived deals are noise
      const ev = eventsBy[p.card_id] || [];
      const opened = new Set(ev.filter(e => e.event === "opened" && e.buyer_id != null).map(e => e.buyer_id));
      const clicked = new Set(ev.filter(e => e.event === "clicked" && e.buyer_id != null).map(e => e.buyer_id));
      const vws = viewsBy[p.card_id] || [];
      const viewers = new Set(vws.filter(v => v.buyer_id != null).map(v => v.buyer_id));
      const interested = (leadsBy[p.card_id] || []).filter(l => INTEREST_RANK.has(l.stage)).length;
      const lastBlast = recips.length ? recips[0].blasted_at : null; // recips arrive newest-first
      return { p, sent: emailSent.size, opened: opened.size, clicked: clicked.size, views: vws.length, viewers: viewers.size, interested, lastBlast };
    })
    .filter(Boolean)
    .sort((a, b) => (b.sent - a.sent) || new Date(b.lastBlast || 0) - new Date(a.lastBlast || 0));

  document.getElementById("rpt-funnel").innerHTML = rows.length ? `
    <table class="rpt-table">
      <thead><tr><th>Deal</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Deck views</th><th>Interested+</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr>
          <td><b>${shortAddr(r.p.name)}</b>${r.p.deal_type === "morby" ? ` <span class="muted" style="font-size:0.7rem">Morby</span>` : r.p.deal_type === "cash" ? ` <span class="muted" style="font-size:0.7rem">Cash</span>` : ""}${r.p.archived ? ` <span class="muted" style="font-size:0.7rem">archived</span>` : ""}</td>
          <td class="rpt-num"><b>${r.sent}</b></td>
          <td>${metricCell(r.opened, r.sent, "#3182CE")}</td>
          <td>${metricCell(r.clicked, r.sent, "#6B46C1")}</td>
          <td class="rpt-num"><b>${r.views}</b> <span class="muted">(${r.viewers} buyer${r.viewers === 1 ? "" : "s"})</span></td>
          <td class="rpt-num" style="${r.interested ? "color:#DD6B20;font-weight:700" : ""}">${r.interested || "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : `<div class="rpt-empty">No blasts sent yet — the funnel fills in after your first send.</div>`;
}

// ── Section 2: copy-variation performance ─────────────────────────
function renderVariations(recips, events, leads) {
  // Attribute each buyer's opens/clicks/interest to the variation they were
  // sent, via the (card_id, buyer_id) pair recorded at send time.
  const varOf = {}; // `${card}:${buyer}` -> variation label
  const varName = (r) => r.variation_title || (r.variation_index != null ? `Variation ${r.variation_index + 1}` : "(untracked)");
  const agg = {};   // label -> { sends, opened:Set, clicked:Set, interested:Set }
  for (const r of recips) {
    if (r.channel !== "email" || r.status !== "sent" || r.buyer_id == null) continue;
    const label = varName(r);
    const key = `${r.card_id}:${r.buyer_id}`;
    if (!varOf[key]) varOf[key] = label; // newest-first: keep the latest send's variation
    (agg[label] ||= { sends: 0, opened: new Set(), clicked: new Set(), interested: new Set() }).sends++;
  }
  for (const e of events) {
    const label = varOf[`${e.card_id}:${e.buyer_id}`];
    if (!label || !agg[label]) continue;
    if (e.event === "opened") agg[label].opened.add(`${e.card_id}:${e.buyer_id}`);
    if (e.event === "clicked") agg[label].clicked.add(`${e.card_id}:${e.buyer_id}`);
  }
  for (const l of leads) {
    if (l.buyer_id == null || !INTEREST_RANK.has(l.stage)) continue;
    const label = varOf[`${l.card_id}:${l.buyer_id}`];
    if (label && agg[label]) agg[label].interested.add(`${l.card_id}:${l.buyer_id}`);
  }

  const rows = Object.entries(agg).sort((a, b) => b[1].sends - a[1].sends);
  document.getElementById("rpt-variations").innerHTML = rows.length ? `
    <table class="rpt-table">
      <thead><tr><th>Variation</th><th>Sends</th><th>Open rate</th><th>Click rate</th><th>Interested+</th></tr></thead>
      <tbody>${rows.map(([label, a]) => `
        <tr>
          <td><b>${escapeHtml(label)}</b></td>
          <td class="rpt-num"><b>${a.sends}</b></td>
          <td>${metricCell(a.opened.size, a.sends, "#3182CE")}</td>
          <td>${metricCell(a.clicked.size, a.sends, "#6B46C1")}</td>
          <td class="rpt-num" style="${a.interested.size ? "color:#DD6B20;font-weight:700" : ""}">${a.interested.size || "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : `<div class="rpt-empty">No variation-tagged sends yet.</div>`;
}

(async () => {
  session = await requireAuth();
  if (!session) return;
  wireLogout(document.getElementById("logout-btn"));
  await loadReports();
  document.getElementById("refresh-btn").addEventListener("click", () => {
    document.getElementById("rpt-content").classList.add("hidden");
    document.getElementById("rpt-loading").classList.remove("hidden");
    loadReports();
  });
})();
