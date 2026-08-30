// Contacts — the non-buyer side of the network: DSCR lenders, mortgage
// brokers, transactional lenders and VIP agents.
//
// Deliberately a PURE CONTACT LIST. It reads and writes `contacts` /
// `contact_activity` and nothing else — no buy box, no matching, no sending.
// Buyers keep their own page and their own table on purpose: matchesDeal
// treats a record with no state/strategy/cap as a wildcard and passes it on
// every deal, so a lender filed among the buyers would receive every blast.
// Nothing in the blast path can see this table.

// `lower` is spelled out rather than derived: .toLowerCase() on the plural
// turns "DSCR Lenders" into "dscr lenders" and "VIP Agents" into "vip agents".
const CONTACT_TYPES = [
  { key: "dscr_lender",           icon: "🏦", plural: "DSCR Lenders",          singular: "DSCR Lender",          lower: "DSCR lenders" },
  { key: "mortgage_broker",       icon: "📋", plural: "Mortgage Brokers",      singular: "Mortgage Broker",      lower: "mortgage brokers" },
  { key: "transactional_lender",  icon: "⚡", plural: "Transactional Lenders", singular: "Transactional Lender", lower: "transactional lenders" },
  { key: "vip_agent",             icon: "⭐", plural: "VIP Agents",            singular: "VIP Agent",            lower: "VIP agents" },
];
const DEFAULT_TYPE = CONTACT_TYPES[0].key;
function typeInfo(key) {
  return CONTACT_TYPES.find(t => t.key === key) || { key, icon: "👤", plural: "Contacts", singular: "Contact", lower: "contacts" };
}

let allContacts = [];            // every type — the tab counts need the full set
let lastTouchById = {};
let activityById = {};
let activeType = DEFAULT_TYPE;
let selectedId = null;
const RENDER_CAP = 400;

// escapeHtml / fmtDate / timeAgo come from /js/ui-shared.js
function contactStates(c) {
  return (c.states || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
}
function phoneHref(c) { return (c.phone || "").replace(/[^\d+]/g, ""); }
function digitsOnly(p) { return String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); }

// PostgREST reports an unrun migration as a missing relation rather than a
// crash. The page has to say so plainly instead of showing an empty list that
// looks like "you have no contacts".
function isMissingTable(error) {
  const msg = `${error.code || ""} ${error.message || ""}`.toLowerCase();
  return msg.includes("42p01") || msg.includes("pgrst205") || (msg.includes("does not exist") && msg.includes("relation"));
}

async function loadContacts() {
  const [{ data, error }, { data: activity }] = await Promise.all([
    fetchAllRows(() => supa.from("contacts").select("*").eq("active", true).order("name").order("id")),
    fetchAllRows(() => supa.from("contact_activity").select("contact_id,channel,detail,created_at").order("created_at", { ascending: false }).order("id"), { maxRows: 4000 })
      .then(r => r.error ? { data: [], error: null } : r),
  ]);
  const loading = document.getElementById("loading");
  if (error) {
    loading.innerHTML = isMissingTable(error)
      ? `<div class="empty">Contacts aren't set up yet — run <code>sql/036_contacts.sql</code> in the Supabase SQL editor, then reload.</div>`
      : `<div class="empty">Couldn't load contacts: ${escapeHtml(error.message)}</div>`;
    return;
  }
  allContacts = data || [];
  lastTouchById = {};
  activityById = {};
  for (const a of (activity || [])) {
    (activityById[a.contact_id] = activityById[a.contact_id] || []).push(a);
    const cur = lastTouchById[a.contact_id];
    if (!cur || new Date(a.created_at) > new Date(cur)) lastTouchById[a.contact_id] = a.created_at;
  }
  loading.classList.add("hidden");
  document.getElementById("main-ui").classList.remove("hidden");
  renderAll();
}

// ── List + detail rendering ──

function ofType(key) { return allContacts.filter(c => c.contact_type === key); }

function visibleContacts() {
  const q = document.getElementById("list-search").value.trim().toLowerCase();
  let list = ofType(activeType);
  if (q) {
    list = list.filter(c =>
      [c.name, c.company, c.email, c.phone, c.states, c.notes]
        .some(v => String(v || "").toLowerCase().includes(q)));
  }
  const sort = document.getElementById("list-sort").value;
  return list.slice().sort((a, b) => {
    if (sort === "newest") return new Date(b.date_added || 0) - new Date(a.date_added || 0);
    if (sort === "touched") return new Date(lastTouchById[b.id] || 0) - new Date(lastTouchById[a.id] || 0);
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function renderTabs() {
  document.getElementById("ct-tabs").innerHTML = CONTACT_TYPES.map(t => `
    <a class="ct-tab ${t.key === activeType ? "active" : ""}" href="/contacts.html?type=${t.key}" data-type="${t.key}">
      <span>${t.icon}</span><span>${escapeHtml(t.plural)}</span>
      <span class="ct-tab-n">${ofType(t.key).length}</span>
    </a>`).join("");
}

function renderAll() {
  const info = typeInfo(activeType);
  document.title = `${info.plural} — Seaside Horizon`;
  document.getElementById("page-title").textContent = info.plural;
  document.getElementById("list-label").textContent = info.plural;
  document.getElementById("add-btn").textContent = `+ Add ${info.singular}`;

  const mine = ofType(activeType);
  const reachable = mine.filter(c => c.email || c.phone).length;
  document.getElementById("contact-count").textContent =
    `${mine.length} ${info.lower}` + (mine.length ? ` · ${reachable} with contact info` : "");

  renderTabs();
  const list = visibleContacts();
  document.getElementById("list-count").textContent = list.length;
  if (!list.some(c => c.id === selectedId)) selectedId = list.length ? list[0].id : null;
  renderRows(list);
  renderDetail();
}

function renderRows(list) {
  const rowsEl = document.getElementById("contact-rows");
  const info = typeInfo(activeType);
  if (!list.length) {
    rowsEl.innerHTML = `<div class="empty" style="padding:36px 16px">No ${escapeHtml(info.lower)}${ofType(activeType).length ? " match your search" : " yet — add your first one"}.</div>`;
    return;
  }
  const shown = list.slice(0, RENDER_CAP);
  const capNotice = list.length > RENDER_CAP
    ? `<div class="muted" style="padding:12px 16px;text-align:center;font-size:0.8rem">Showing the first ${RENDER_CAP} of ${list.length}. Use search to narrow down.</div>`
    : "";
  rowsEl.innerHTML = shown.map(c => {
    const chips = contactStates(c).map(s => `<span class="chip-market">${escapeHtml(s)}</span>`).join("");
    const touched = lastTouchById[c.id];
    return `
      <div class="buyer-row ${c.id === selectedId ? "selected" : ""}" data-id="${c.id}">
        <div style="flex:1;min-width:0">
          <div class="flex" style="gap:7px;flex-wrap:wrap">
            <strong style="color:var(--navy-dark);font-size:0.92rem">${escapeHtml(c.name)}</strong>
            ${(!c.email && !c.phone) ? `<span title="No email or phone" style="font-size:0.72rem">⚠️</span>` : ""}
          </div>
          ${c.company ? `<div class="muted" style="font-size:0.8rem;margin-top:2px">${escapeHtml(c.company)}</div>` : ""}
          ${chips ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${chips}</div>` : ""}
        </div>
        <div style="align-self:center;flex-shrink:0">
          ${touched ? `<span class="muted" style="font-size:0.72rem;white-space:nowrap">${escapeHtml(timeAgo(touched))}</span>` : ""}
        </div>
      </div>`;
  }).join("") + capNotice;
}

function renderDetail() {
  const el = document.getElementById("contact-detail");
  const c = allContacts.find(x => x.id === selectedId);
  const info = typeInfo(activeType);
  if (!c) {
    el.innerHTML = `<div class="empty">Select a contact on the left${ofType(activeType).length ? "" : `, or add your first ${escapeHtml(info.singular)}`}.</div>`;
    return;
  }
  const tel = phoneHref(c);
  const markets = contactStates(c);
  const lastContact = fmtDate(lastTouchById[c.id]);
  const events = (activityById[c.id] || []).slice(0, 25);

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div style="min-width:0">
        <div class="flex" style="gap:10px;flex-wrap:wrap;align-items:center">
          <h2 style="margin:0;font-size:1.4rem;color:var(--navy-dark)">${escapeHtml(c.name)}</h2>
          <span class="bd-chip-strat"><span style="margin-right:5px">${info.icon}</span>${escapeHtml(info.singular)}</span>
        </div>
        ${c.company ? `<div style="font-size:0.95rem;color:var(--text-2);font-weight:600;margin-top:4px">${escapeHtml(c.company)}</div>` : ""}
      </div>
      <div class="flex gap-8" style="flex-wrap:wrap">
        ${tel ? `<a class="btn btn-primary btn-sm" href="tel:${escapeHtml(tel)}">📞 Call</a>
                 <a class="btn btn-ghost btn-sm" href="sms:${escapeHtml(tel)}">📱 Text</a>` : ""}
        ${c.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${escapeHtml(c.email)}">✉️ Email</a>` : ""}
        <button class="btn btn-ghost btn-sm" id="detail-edit">Edit</button>
      </div>
    </div>

    <div style="margin-top:12px;display:flex;flex-direction:column;gap:5px;font-size:0.92rem">
      ${c.phone ? `<div>📞 <a href="tel:${escapeHtml(tel)}">${escapeHtml(c.phone)}</a></div>` : ""}
      ${c.email ? `<div>✉️ <a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></div>` : ""}
      ${(!c.phone && !c.email) ? `<div class="muted">No phone or email on file yet.</div>` : ""}
    </div>

    <div style="margin-top:22px">
      <div class="bd-seclabel" style="margin-bottom:8px">Markets</div>
      ${markets.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${markets.map(s => `<span class="bd-chip-market">${escapeHtml(s)}</span>`).join("")}</div>`
        : `<div class="muted" style="font-size:0.88rem">No states set.</div>`}
    </div>

    <div style="margin-top:22px">
      <div class="bd-seclabel" style="margin-bottom:8px">Notes</div>
      ${c.notes
        ? `<div style="font-size:0.9rem;color:var(--text-1);line-height:1.65;background:#F7FAFC;border:1px solid var(--border);border-radius:10px;padding:14px 16px;white-space:pre-wrap">${escapeHtml(c.notes)}</div>`
        : `<div style="font-size:0.88rem;color:var(--text-3);font-style:italic;background:#F7FAFC;border:1px dashed var(--border);border-radius:10px;padding:14px 16px">No notes yet — terms, rates, who referred them, what they're good for.</div>`}
    </div>

    ${events.length ? `
    <div style="margin-top:22px">
      <div class="bd-seclabel" style="margin-bottom:8px">Recent activity</div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;background:#fff">
        ${events.map(ev => `
          <div style="display:flex;gap:10px;align-items:baseline;padding:8px 14px;border-bottom:1px solid #F1F5F9;font-size:0.84rem">
            <span style="flex-shrink:0">📝</span>
            <span style="flex:1;color:var(--text-1)">${escapeHtml(ev.detail || "Touched")}</span>
            <span class="muted" style="flex-shrink:0;font-size:0.72rem">${escapeHtml(fmtDate(ev.created_at) || "")}</span>
          </div>`).join("")}
      </div>
    </div>` : ""}

    <div style="margin-top:22px;padding-top:16px;border-top:1px solid #EDF1F6;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="width:8px;height:8px;border-radius:50%;background:${lastContact ? "var(--green)" : "#CBD5E0"};display:inline-block"></span>
      <span style="font-size:0.86rem;color:var(--text-2);font-weight:500">${lastContact ? `Last contacted ${escapeHtml(lastContact)}` : "Not yet contacted"}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="detail-log">+ Log activity</button>
        <button class="btn btn-danger btn-sm" id="detail-remove">Remove</button>
      </div>
    </div>`;

  document.getElementById("detail-edit").addEventListener("click", () => openModal(c));
  document.getElementById("detail-log").addEventListener("click", () => logActivity(c));
  document.getElementById("detail-remove").addEventListener("click", () => removeContact(c));
}

async function logActivity(c) {
  const detail = prompt(`Log activity for ${c.name} — what happened?`, "");
  if (detail === null) return;
  const { error } = await supa.from("contact_activity").insert({ contact_id: c.id, channel: "manual", detail: detail.trim() });
  if (error) { toast(`Couldn't log activity: ${error.message}`, { type: "error" }); return; }
  const now = new Date().toISOString();
  lastTouchById[c.id] = now;
  (activityById[c.id] = activityById[c.id] || []).unshift({ contact_id: c.id, channel: "manual", detail: detail.trim(), created_at: now });
  toast("Activity logged.", { type: "success" });
  renderDetail();
}

// Soft delete + Undo, same convention as the buyer list — the row survives so
// the activity history isn't lost.
async function removeContact(c) {
  if (!confirm(`Remove ${c.name} from your contacts?`)) return;
  const { error } = await supa.from("contacts").update({ active: false }).eq("id", c.id);
  if (error) { toast(`Couldn't remove ${c.name}: ${error.message}`, { type: "error" }); return; }
  toast(`Removed ${c.name}.`, { type: "success", actionLabel: "Undo", onAction: async () => {
    const { error: e2 } = await supa.from("contacts").update({ active: true }).eq("id", c.id);
    if (e2) { toast(`Undo failed: ${e2.message}`, { type: "error" }); return; }
    await loadContacts();
  }});
  if (selectedId === c.id) selectedId = null;
  await loadContacts();
}

// ── Dedupe ──
// Same keys as everywhere else in the app: digits-only phone, lower-cased
// email. Scoped to the contact's own type, because the same broker can
// legitimately sit in two lists (a mortgage broker who also lends).
function findDuplicateContact(payload, excludeId) {
  const pd = digitsOnly(payload.phone);
  const em = (payload.email || "").trim().toLowerCase();
  if (!pd && !em) return null;
  return allContacts.find(c =>
    Number(c.id) !== Number(excludeId) &&
    c.contact_type === payload.contact_type &&
    ((pd && digitsOnly(c.phone) === pd) || (em && (c.email || "").toLowerCase() === em))
  ) || null;
}

// Removed contacts are soft-deleted and so aren't in allContacts. Ask the DB
// directly so re-adding someone restores them instead of leaving two rows.
// Fails soft: a lookup error just falls through to a normal insert.
async function findRemovedContact(payload) {
  const em = (payload.email || "").trim().toLowerCase();
  const phone = (payload.phone || "").trim();
  const parts = [];
  if (em && !/[,()]/.test(em)) parts.push(`email.ilike.${em}`);
  if (phone && !/[,()]/.test(phone)) parts.push(`phone.eq.${phone}`);
  if (!parts.length) return null;
  const { data, error } = await supa.from("contacts")
    .select("id,name,email,phone,contact_type").eq("active", false)
    .eq("contact_type", payload.contact_type).or(parts.join(",")).limit(1);
  if (error) { console.warn("removed-contact dedupe check failed:", error.message); return null; }
  return (data && data[0]) || null;
}

function openModal(c) {
  const info = typeInfo(c ? c.contact_type : activeType);
  document.getElementById("modal-title").textContent = c ? `Edit ${info.singular}` : `Add ${info.singular}`;
  document.getElementById("c-id").value = c ? c.id : "";
  document.getElementById("c-name").value = c ? c.name : "";
  document.getElementById("c-type").value = c ? c.contact_type : activeType;
  document.getElementById("c-company").value = c ? (c.company || "") : "";
  document.getElementById("c-email").value = c ? (c.email || "") : "";
  document.getElementById("c-phone").value = c ? (c.phone || "") : "";
  document.getElementById("c-states").value = c ? (c.states || "") : "";
  document.getElementById("c-notes").value = c ? (c.notes || "") : "";
  document.getElementById("modal-backdrop").classList.remove("hidden");
  document.getElementById("c-name").focus();
}
function closeModal() { document.getElementById("modal-backdrop").classList.add("hidden"); }

// Switch lists without a reload, keeping the URL shareable and the back
// button honest — the nav dropdown links to the same ?type= addresses.
function setType(key, { push = true } = {}) {
  if (!CONTACT_TYPES.some(t => t.key === key)) key = DEFAULT_TYPE;
  activeType = key;
  selectedId = null;
  document.getElementById("list-search").value = "";
  if (push) history.pushState({ type: key }, "", `/contacts.html?type=${key}`);
  renderAll();
}

(async () => {
  const session = await requireAuth();
  if (!session) return;
  wireLogout(document.getElementById("logout-btn"));

  activeType = new URLSearchParams(location.search).get("type") || DEFAULT_TYPE;
  if (!CONTACT_TYPES.some(t => t.key === activeType)) activeType = DEFAULT_TYPE;

  document.getElementById("c-type").innerHTML =
    CONTACT_TYPES.map(t => `<option value="${t.key}">${t.icon} ${escapeHtml(t.singular)}</option>`).join("");

  document.getElementById("add-btn").addEventListener("click", () => openModal(null));
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", e => { if (e.target.id === "modal-backdrop") closeModal(); });

  document.getElementById("ct-tabs").addEventListener("click", e => {
    const tab = e.target.closest(".ct-tab");
    if (!tab) return;
    e.preventDefault();
    setType(tab.dataset.type);
  });
  window.addEventListener("popstate", () => {
    setType(new URLSearchParams(location.search).get("type") || DEFAULT_TYPE, { push: false });
  });

  let renderTimer = null;
  document.getElementById("list-search").addEventListener("input", () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderAll, 180);
  });
  document.getElementById("list-sort").addEventListener("change", renderAll);
  document.getElementById("contact-rows").addEventListener("click", e => {
    const row = e.target.closest(".buyer-row");
    if (!row) return;
    selectedId = Number(row.dataset.id);
    document.querySelectorAll("#contact-rows .buyer-row").forEach(r =>
      r.classList.toggle("selected", Number(r.dataset.id) === selectedId));
    renderDetail();
  });

  document.getElementById("contact-form").addEventListener("submit", async e => {
    e.preventDefault();
    const id = document.getElementById("c-id").value;
    const payload = {
      contact_type: document.getElementById("c-type").value,
      name: document.getElementById("c-name").value.trim(),
      company: document.getElementById("c-company").value.trim(),
      email: document.getElementById("c-email").value.trim(),
      phone: document.getElementById("c-phone").value.trim(),
      states: document.getElementById("c-states").value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).join(","),
      notes: document.getElementById("c-notes").value.trim(),
    };

    const dupe = findDuplicateContact(payload, id);
    if (dupe) {
      const how = digitsOnly(payload.phone) && digitsOnly(dupe.phone) === digitsOnly(payload.phone) ? "phone number" : "email address";
      if (id) {
        if (!confirm(`${dupe.name} already has that ${how}.\n\nSave anyway and leave two contacts sharing it?`)) return;
      } else {
        if (confirm(`${dupe.name} is already on this list with that ${how}.\n\nOpen their record instead of adding a duplicate?`)) {
          closeModal();
          setType(dupe.contact_type, { push: dupe.contact_type !== activeType });
          selectedId = dupe.id;
          renderAll();
        } else {
          toast(`Not added — ${dupe.name} already has that ${how}.`, { type: "error" });
        }
        return;
      }
    }

    let restoreId = null;
    if (!id) {
      const removed = await findRemovedContact(payload);
      if (removed && confirm(`${removed.name} was removed from this list but still has that contact info.\n\nRestore them with these details? (Cancel adds a separate new contact.)`)) {
        restoreId = removed.id;
      }
    }

    const { data, error } = id
      ? await supa.from("contacts").update(payload).eq("id", id).select("id").single()
      : restoreId
        ? await supa.from("contacts").update({ ...payload, active: true }).eq("id", restoreId).select("id").single()
        : await supa.from("contacts").insert({ ...payload, source: "direct", active: true }).select("id").single();
    if (error) { toast(`Couldn't save contact: ${error.message}`, { type: "error" }); return; }

    closeModal();
    toast(id ? "Contact saved." : restoreId ? "Contact restored." : "Contact added.", { type: "success" });
    // Saving can move a contact to another type — follow it there.
    if (payload.contact_type !== activeType) setType(payload.contact_type);
    selectedId = data ? data.id : selectedId;
    await loadContacts();
  });

  await loadContacts();
})();
