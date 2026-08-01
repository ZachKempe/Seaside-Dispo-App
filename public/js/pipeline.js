let session;

// escapeHtml + timeAgo come from /js/ui-shared.js
function fmtMoney(n) { n = Number(n) || 0; return n ? `$${n.toLocaleString()}` : ""; }

// Module-level cache so the detail modal + drag handlers read fresh data.
let PROPS = [];             // all active properties
const propById = {};        // card_id -> property
const notesByCard = {};     // card_id -> [notes] (newest first)
const tasksByCard = {};     // card_id -> [deal_tasks] (due-date ascending)
const leadsByCard = {};     // card_id -> [deal_leads]
const blastsByCard = {};    // card_id -> [deal_blasts]
const recipsByCard = {};    // card_id -> [blast_recipients]
const termsByCard = {};     // card_id -> deal_terms
let openCardId = null;      // detail modal target, if open

async function loadBoard() {
  const board = document.getElementById("board");

  let { data: props, error: pErr } = await supa.from("properties").select("*").eq("archived", false).order("synced_at", { ascending: false });
  if (pErr) {
    // `archived` column may not exist on older DBs — fall back unfiltered.
    ({ data: props, error: pErr } = await supa.from("properties").select("*").order("synced_at", { ascending: false }));
  }
  if (pErr) { board.innerHTML = `<div class="empty">Couldn't load deals: ${escapeHtml(pErr.message)}</div>`; return; }

  const cardIds = (props || []).map(p => p.card_id);
  // deal_tasks fails soft (027 migration may not have run yet) — the tasks
  // UI simply stays empty until the table exists.
  const [{ data: notes }, { data: leads }, { data: blasts }, { data: recips }, { data: terms }, { data: tasks }] = await Promise.all([
    supa.from("deal_notes").select("*").in("card_id", cardIds).order("created_at", { ascending: false }),
    supa.from("deal_leads").select("card_id,stage").in("card_id", cardIds),
    supa.from("deal_blasts").select("card_id,status").in("card_id", cardIds),
    supa.from("blast_recipients").select("card_id,status").in("card_id", cardIds),
    supa.from("deal_terms").select("card_id,price").in("card_id", cardIds),
    supa.from("deal_tasks").select("*").in("card_id", cardIds).order("due_date", { ascending: true }),
  ]);

  // Reset + rebuild caches
  PROPS = props || [];
  for (const k of Object.keys(propById)) delete propById[k];
  for (const o of [notesByCard, tasksByCard, leadsByCard, blastsByCard, recipsByCard, termsByCard]) for (const k of Object.keys(o)) delete o[k];
  for (const p of PROPS) propById[p.card_id] = p;
  for (const n of (notes || [])) (notesByCard[n.card_id] ||= []).push(n);
  for (const t of (tasks || [])) (tasksByCard[t.card_id] ||= []).push(t);
  for (const l of (leads || [])) (leadsByCard[l.card_id] ||= []).push(l);
  for (const b of (blasts || [])) (blastsByCard[b.card_id] ||= []).push(b);
  for (const r of (recips || [])) (recipsByCard[r.card_id] ||= []).push(r);
  for (const t of (terms || [])) termsByCard[t.card_id] = t;

  renderBoard();
  updateHeaderCounts();

  // Keep the detail modal in sync if it's open (after a move / note add).
  if (openCardId && propById[openCardId]) openDetail(openCardId);
}

function updateHeaderCounts() {
  document.getElementById("deal-count").textContent =
    `${PROPS.length} active deal${PROPS.length === 1 ? "" : "s"}`;
  const staleCount = PROPS.filter(isStaleDeal).length;
  document.getElementById("stale-count").textContent = staleCount ? ` · 🕓 ${staleCount} stale` : "";
  const overdue = Object.values(tasksByCard).flat().filter(isOverdueTask).length;
  const taskEl = document.getElementById("task-count");
  if (taskEl) taskEl.textContent = overdue ? ` · ⏰ ${overdue} overdue` : "";
}

function renderBoard() {
  const byStage = Object.fromEntries(DISPO_STAGES.map(s => [s.key, []]));
  const firstKey = DISPO_STAGES[0] && DISPO_STAGES[0].key;
  for (const p of PROPS) {
    const stage = p.dispo_stage || firstKey;
    // Deals whose stage was deleted/renamed fall into the first column.
    (byStage[stage] || byStage[firstKey]).push(p);
  }
  document.getElementById("board").innerHTML = DISPO_STAGES.map(s => {
    const cards = byStage[s.key] || [];
    return `
    <div class="pl-col" style="--pl-color:${s.color}">
      <div class="pl-col-head"><span class="pl-dot"></span>${escapeHtml(s.label)}<span class="pl-count">${cards.length}</span></div>
      <div class="pl-col-body" data-stage="${s.key}">
        ${cards.map(renderPlCard).join("") || `<div class="pl-empty">Drop a deal here</div>`}
      </div>
    </div>`;
  }).join("");
}

function renderPlCard(p) {
  const stage = p.dispo_stage || "prep";
  const color = (DISPO_BY_KEY[stage] || DISPO_BY_KEY.prep).color;
  const dealType = p.deal_type === "morby" ? "morby" : "subto";
  const notes = notesByCard[p.card_id] || [];
  const stale = isStaleDeal(p);
  const implied = DISPO_TERMINAL.has(stage) ? null : impliedDispoStage(leadsByCard[p.card_id], blastsByCard[p.card_id], recipsByCard[p.card_id]);
  const suggests = implied && DISPO_BY_KEY[implied].rank > (DISPO_BY_KEY[stage] || DISPO_BY_KEY.prep).rank;
  const price = fmtMoney((termsByCard[p.card_id] || {}).price);
  const lastNote = notes[0]; // notes are newest-first
  return `
  <div class="pl-card" draggable="true" data-card-id="${escapeHtml(p.card_id)}" style="--pl-color:${color}">
    <div class="pl-card-title">${escapeHtml(p.name)}</div>
    <div class="pl-card-meta">
      <span class="pl-tag pl-tag-${dealType}">${dealType === "morby" ? "Morby" : "Sub-To"}</span>
      ${p.state ? `<span class="pill pill-state" style="font-size:0.68rem">${escapeHtml(p.state)}</span>` : ""}
      ${price ? `<span class="pl-mini">${price}</span>` : ""}
      ${notes.length ? `<span class="pl-mini" title="${notes.length} note${notes.length === 1 ? "" : "s"}">💬 ${notes.length}</span>` : ""}
      ${stale ? `<span class="pl-mini" style="color:var(--red)" title="No stage change in ${STALE_DAYS}+ days">🕓 Stale</span>` : ""}
      ${suggests ? `<span class="pl-mini" style="color:${DISPO_BY_KEY[implied].color}" title="Signals suggest ${escapeHtml(DISPO_BY_KEY[implied].label)}">⚠️</span>` : ""}
    </div>
    ${lastNote ? `<div class="pl-last-update" title="${escapeHtml(new Date(lastNote.created_at).toLocaleString())}">🗒 Last update ${escapeHtml(timeAgo(lastNote.created_at))}</div>` : ""}
    ${(() => {
      const t = nextOpenTask(p.card_id);
      if (!t) return "";
      const late = isOverdueTask(t);
      return `<div class="pl-last-update" style="${late ? "color:var(--red);font-weight:700" : ""}" title="Next action${t.due_date ? " · due " + escapeHtml(t.due_date) : ""}">⏰ ${escapeHtml(t.title)}${t.due_date ? ` · ${late ? "overdue" : "due"} ${escapeHtml(fmtDue(t.due_date))}` : ""}</div>`;
    })()}
  </div>`;
}

// ── Tasks: next action per deal ──
function isOverdueTask(t) {
  return !t.done && t.due_date && new Date(t.due_date + "T23:59:59") < new Date();
}
// Open tasks arrive due-date ascending (nulls last), so the first is "next".
function nextOpenTask(cardId) {
  return (tasksByCard[cardId] || []).find(t => !t.done) || null;
}
function fmtDue(d) {
  if (!d) return "";
  const date = new Date(d + "T00:00:00");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function addTask(cardId) {
  const title = (document.getElementById("task-title")?.value || "").trim();
  const due = document.getElementById("task-due")?.value || null;
  if (!title) return;
  const { error } = await supa.from("deal_tasks")
    .insert({ card_id: cardId, title, due_date: due, created_by: session?.user?.email || "" });
  if (error) { toast(`Couldn't add task: ${error.message}`, { type: "error" }); return; }
  toast("Task added", { type: "success" });
  await loadBoard();
}
async function toggleTask(taskId, done) {
  const { error } = await supa.from("deal_tasks")
    .update({ done, done_at: done ? new Date().toISOString() : null })
    .eq("id", taskId);
  if (error) { toast(`Couldn't update task: ${error.message}`, { type: "error" }); return; }
  await loadBoard();
}
async function deleteTask(taskId) {
  const { error } = await supa.from("deal_tasks").delete().eq("id", taskId);
  if (error) { toast(`Couldn't delete task: ${error.message}`, { type: "error" }); return; }
  toast("Task deleted", { type: "success" });
  await loadBoard();
}

// ── Stage move (shared by drag-drop, the accept button, and the dropdown) ──
async function moveStage(cardId, stage) {
  const p = propById[cardId];
  if (!p || (p.dispo_stage || "prep") === stage) return;
  const email = session?.user?.email || "";
  // Optimistic: update the cache + repaint so the card jumps immediately.
  p.dispo_stage = stage; p.stage_moved_at = new Date().toISOString(); p.stage_moved_by = email;
  renderBoard();
  const { error } = await supa.from("properties")
    .update({ dispo_stage: stage, stage_moved_at: p.stage_moved_at, stage_moved_by: email })
    .eq("card_id", cardId);
  if (error) { toast(`Couldn't move deal: ${error.message}`, { type: "error" }); loadBoard(); return; }
  toast(`Moved to ${DISPO_BY_KEY[stage]?.label || stage}`, { type: "success" });
  if (openCardId === cardId) openDetail(cardId);
  updateHeaderCounts(); // refresh count + stale rollup without a full spinner
}

// ── Detail modal ──
function openDetail(cardId) {
  const p = propById[cardId];
  if (!p) return;
  openCardId = cardId;
  const stage = p.dispo_stage || "prep";
  const cur = DISPO_BY_KEY[stage] || DISPO_BY_KEY.prep;
  const dealType = p.deal_type === "morby" ? "Morby" : "Sub-To";
  const notes = notesByCard[cardId] || [];
  const implied = DISPO_TERMINAL.has(stage) ? null : impliedDispoStage(leadsByCard[cardId], blastsByCard[cardId], recipsByCard[cardId]);
  const suggests = implied && DISPO_BY_KEY[implied].rank > cur.rank;
  const price = fmtMoney((termsByCard[cardId] || {}).price);
  const movedMeta = p.stage_moved_at
    ? `Moved ${new Date(p.stage_moved_at).toLocaleDateString()}${p.stage_moved_by ? " · " + escapeHtml(p.stage_moved_by) : ""}`
    : "Not moved yet";

  const noteList = notes.map(n => `
    <div class="pl-note">
      <div>${escapeHtml(n.body)}</div>
      <div class="pl-note-meta">${escapeHtml(n.author_email || "unknown")} · ${new Date(n.created_at).toLocaleString()}</div>
    </div>`).join("") || `<p class="muted" style="font-size:0.84rem">No notes yet.</p>`;

  document.getElementById("detail-card").innerHTML = `
    <div class="flex-between" style="align-items:flex-start;gap:10px">
      <div>
        <h2 style="margin:0 0 4px;font-size:1.15rem;color:var(--navy-dark)">${escapeHtml(p.name)}</h2>
        <div class="flex gap-8" style="align-items:center;flex-wrap:wrap">
          <span class="pl-tag pl-tag-${p.deal_type === "morby" ? "morby" : "subto"}">${dealType}</span>
          ${p.state ? `<span class="pill pill-state">${escapeHtml(p.state)}</span>` : ""}
          ${price ? `<span class="muted" style="font-size:0.82rem">${price}</span>` : ""}
          <a href="/dashboard.html#deal=${encodeURIComponent(p.card_id)}" style="font-size:0.82rem" title="Open this deal's full card on the Posting dashboard (terms, copy, blasts, leads)">Posting ↗</a>
          ${p.trello_url ? `<a href="${escapeHtml(p.trello_url)}" target="_blank" rel="noopener" style="font-size:0.82rem">Trello ↗</a>` : ""}
        </div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="detail-close">✕</button>
    </div>

    <div style="margin:16px 0;padding:12px 14px;background:${cur.color}0f;border-left:3px solid ${cur.color};border-radius:9px">
      <div class="flex gap-8" style="align-items:center;flex-wrap:wrap">
        <label style="margin:0">Stage</label>
        <select id="detail-stage" style="width:auto;font-weight:700;color:${cur.color}">
          ${DISPO_STAGES.map(s => `<option value="${s.key}" ${s.key === stage ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("")}
        </select>
        ${isStaleDeal(p) ? `<span class="pill" style="background:#C5303022;color:#C53030;font-size:0.7rem;font-weight:700">🕓 Stale</span>` : ""}
      </div>
      ${suggests ? `
        <div style="margin-top:8px;font-size:0.8rem;color:${DISPO_BY_KEY[implied].color};display:flex;align-items:center;gap:8px">
          ⚠️ signals suggest <b>${escapeHtml(DISPO_BY_KEY[implied].label)}</b>
          <button type="button" class="btn btn-ghost btn-sm" id="detail-accept" data-stage="${implied}" style="padding:1px 10px">Move</button>
        </div>` : ""}
      <div class="muted" style="font-size:0.72rem;margin-top:8px">${movedMeta}</div>
    </div>

    ${(() => {
      const tasks = tasksByCard[cardId] || [];
      const open = tasks.filter(t => !t.done);
      const doneTasks = tasks.filter(t => t.done);
      const row = (t) => `
        <div style="display:flex;align-items:center;gap:9px;padding:6px 0;border-bottom:1px solid #F1F5F9;font-size:0.86rem">
          <input type="checkbox" class="task-toggle" data-task-id="${t.id}" ${t.done ? "checked" : ""} style="width:auto;margin:0;cursor:pointer">
          <span style="flex:1;${t.done ? "text-decoration:line-through;color:var(--text-3)" : ""}">${escapeHtml(t.title)}</span>
          ${t.due_date ? `<span class="pill" style="font-size:0.68rem;font-weight:700;${isOverdueTask(t) ? "background:#C5303022;color:#C53030" : "background:#EDF2F7;color:#4A5568"}">${isOverdueTask(t) ? "⏰ overdue · " : ""}${escapeHtml(fmtDue(t.due_date))}</span>` : ""}
          <button type="button" class="task-del" data-task-id="${t.id}" title="Delete task" style="border:none;background:none;color:var(--text-3);cursor:pointer;font-size:0.9rem;line-height:1">×</button>
        </div>`;
      return `
    <h3 style="margin:0 0 6px;font-size:0.95rem;color:var(--navy-dark)">Next actions${open.length ? ` (${open.length})` : ""}</h3>
    <div style="margin-bottom:6px">${open.map(row).join("") || `<p class="muted" style="font-size:0.82rem;margin:4px 0">Nothing scheduled — add the next step so this deal can't stall silently.</p>`}</div>
    ${doneTasks.length ? `<details style="margin-bottom:8px"><summary class="muted" style="cursor:pointer;font-size:0.78rem">Completed (${doneTasks.length})</summary>${doneTasks.map(row).join("")}</details>` : ""}
    <div class="flex gap-8" style="margin-bottom:16px;flex-wrap:wrap">
      <input id="task-title" placeholder="Next action… e.g. Call top 3 interested buyers" style="flex:2;min-width:180px;font-size:0.86rem">
      <input id="task-due" type="date" style="width:auto;font-size:0.86rem">
      <button type="button" class="btn btn-primary btn-sm" id="task-add-btn">Add</button>
    </div>`;
    })()}

    <h3 style="margin:0 0 6px;font-size:0.95rem;color:var(--navy-dark)">Notes &amp; updates (${notes.length})</h3>
    <div style="max-height:240px;overflow-y:auto;margin-bottom:10px">${noteList}</div>
    <div class="flex gap-8">
      <textarea id="detail-note" rows="2" placeholder="Add an update…" style="flex:1;font-family:inherit;font-size:0.86rem"></textarea>
      <button type="button" class="btn btn-primary btn-sm" id="detail-note-add">Add</button>
    </div>`;

  document.getElementById("detail-backdrop").classList.remove("hidden");

  document.getElementById("detail-close").onclick = closeDetail;
  document.getElementById("detail-stage").onchange = (e) => moveStage(cardId, e.target.value);
  const acceptBtn = document.getElementById("detail-accept");
  if (acceptBtn) acceptBtn.onclick = () => moveStage(cardId, acceptBtn.dataset.stage);
  document.getElementById("detail-note-add").onclick = () => addNote(cardId);
  const taskAdd = document.getElementById("task-add-btn");
  if (taskAdd) taskAdd.onclick = () => addTask(cardId);
  const taskTitle = document.getElementById("task-title");
  if (taskTitle) taskTitle.addEventListener("keydown", (e) => { if (e.key === "Enter") addTask(cardId); });
  document.querySelectorAll("#detail-card .task-toggle").forEach(cb =>
    cb.addEventListener("change", () => toggleTask(Number(cb.dataset.taskId), cb.checked)));
  document.querySelectorAll("#detail-card .task-del").forEach(btn =>
    btn.addEventListener("click", () => deleteTask(Number(btn.dataset.taskId))));
}

function closeDetail() {
  openCardId = null;
  document.getElementById("detail-backdrop").classList.add("hidden");
}

async function addNote(cardId) {
  const ta = document.getElementById("detail-note");
  const body = (ta?.value || "").trim();
  if (!body) return;
  const email = session?.user?.email || "";
  const { error } = await supa.from("deal_notes").insert({ card_id: cardId, body, author_email: email });
  if (error) { toast(`Couldn't save note: ${error.message}`, { type: "error" }); return; }
  toast("Note added", { type: "success" });
  await loadBoard(); // re-opens the modal with the new note (openCardId still set)
}

// ── Drag & drop (delegated on the board) ──
function wireBoardDnD() {
  const board = document.getElementById("board");
  let draggingId = null;

  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".pl-card");
    if (!card) return;
    draggingId = card.dataset.cardId;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggingId);
  });
  board.addEventListener("dragend", (e) => {
    const card = e.target.closest(".pl-card");
    if (card) card.classList.remove("dragging");
    draggingId = null;
    document.querySelectorAll(".pl-col-body.drag-over").forEach(el => el.classList.remove("drag-over"));
  });
  board.addEventListener("dragover", (e) => {
    const body = e.target.closest(".pl-col-body");
    if (!body) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".pl-col-body.drag-over").forEach(el => { if (el !== body) el.classList.remove("drag-over"); });
    body.classList.add("drag-over");
  });
  board.addEventListener("dragleave", (e) => {
    const body = e.target.closest(".pl-col-body");
    if (body && !body.contains(e.relatedTarget)) body.classList.remove("drag-over");
  });
  board.addEventListener("drop", (e) => {
    const body = e.target.closest(".pl-col-body");
    if (!body) return;
    e.preventDefault();
    body.classList.remove("drag-over");
    const cardId = draggingId || e.dataTransfer.getData("text/plain");
    if (cardId) moveStage(cardId, body.dataset.stage);
  });
  // Click a card (that wasn't a drag) → open detail.
  board.addEventListener("click", (e) => {
    const card = e.target.closest(".pl-card");
    if (card) openDetail(card.dataset.cardId);
  });
}

// ── Manage stages modal ──
let stagesOpen = false;

function openStages() { stagesOpen = true; renderStages(); document.getElementById("stages-backdrop").classList.remove("hidden"); }
function closeStages() { stagesOpen = false; document.getElementById("stages-backdrop").classList.add("hidden"); }

// How many active deals sit in each stage (unknown stages counted in the first).
function dealCountByStage() {
  const counts = {};
  const firstKey = DISPO_STAGES[0] && DISPO_STAGES[0].key;
  for (const p of PROPS) {
    const s = DISPO_BY_KEY[p.dispo_stage] ? p.dispo_stage : firstKey;
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function renderStages() {
  const counts = dealCountByStage();
  const rows = DISPO_STAGES.map((s, i) => `
    <div class="stage-row" data-key="${escapeHtml(s.key)}" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;flex-direction:column;gap:2px">
        <button type="button" class="stage-up" ${i === 0 ? "disabled" : ""} style="border:none;background:none;cursor:pointer;color:var(--text-2);line-height:1;padding:0;font-size:0.8rem;${i === 0 ? "opacity:.25;cursor:default" : ""}">▲</button>
        <button type="button" class="stage-down" ${i === DISPO_STAGES.length - 1 ? "disabled" : ""} style="border:none;background:none;cursor:pointer;color:var(--text-2);line-height:1;padding:0;font-size:0.8rem;${i === DISPO_STAGES.length - 1 ? "opacity:.25;cursor:default" : ""}">▼</button>
      </div>
      <input type="color" class="stage-color" value="${escapeHtml(s.color)}" style="width:34px;height:34px;padding:2px;border:1px solid var(--border);border-radius:6px;cursor:pointer" title="Column color">
      <input type="text" class="stage-label" value="${escapeHtml(s.label)}" placeholder="Stage name" style="flex:1;font-weight:600">
      <label class="flex gap-8" style="align-items:center;font-size:0.72rem;color:var(--text-2);white-space:nowrap;margin:0" title="Final stage — deals here never show a stale flag or shoulder-tap">
        <input type="checkbox" class="stage-terminal" ${s.is_terminal ? "checked" : ""} style="width:auto"> final
      </label>
      <span class="muted" style="font-size:0.72rem;width:52px;text-align:right">${counts[s.key] || 0} deal${(counts[s.key] || 0) === 1 ? "" : "s"}</span>
      <button type="button" class="stage-del" ${DISPO_STAGES.length <= 1 ? "disabled" : ""} style="border:none;background:none;cursor:pointer;color:var(--red);font-size:0.95rem;${DISPO_STAGES.length <= 1 ? "opacity:.25;cursor:default" : ""}" title="Delete stage">🗑</button>
    </div>`).join("");

  document.getElementById("stages-card").innerHTML = `
    <div class="flex-between" style="align-items:center">
      <h2 style="margin:0;font-size:1.15rem;color:var(--navy-dark)">Manage stages</h2>
      <button type="button" class="btn btn-ghost btn-sm" id="stages-close">✕</button>
    </div>
    <p class="muted" style="font-size:0.82rem;margin:6px 0 12px">Rename, recolor, reorder, add, or remove your pipeline columns. Renaming keeps deals in place; deleting a stage moves its deals to the first column. "Final" stages never show a stale flag.</p>
    <div id="stage-rows">${rows}</div>
    <button type="button" class="btn btn-ghost btn-sm" id="stage-add" style="margin-top:12px">+ Add stage</button>`;

  document.getElementById("stages-close").onclick = closeStages;
  document.getElementById("stage-add").onclick = addStage;
  document.querySelectorAll("#stage-rows .stage-row").forEach(row => {
    const key = row.dataset.key;
    const label = row.querySelector(".stage-label");
    label.addEventListener("change", (e) => updateStage(key, { label: e.target.value.trim() || "Untitled" }));
    label.addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
    row.querySelector(".stage-color").addEventListener("change", (e) => updateStage(key, { color: e.target.value }));
    row.querySelector(".stage-terminal").addEventListener("change", (e) => updateStage(key, { is_terminal: e.target.checked }));
    const up = row.querySelector(".stage-up"); if (!up.disabled) up.onclick = () => reorderStage(key, -1);
    const dn = row.querySelector(".stage-down"); if (!dn.disabled) dn.onclick = () => reorderStage(key, 1);
    const del = row.querySelector(".stage-del"); if (!del.disabled) del.onclick = () => deleteStage(key);
  });
}

// Reload stage defs, repaint board + modal, refresh header. Cheap: reuses
// in-memory PROPS (no deal refetch) since stage edits don't change deals.
async function refreshStages() {
  await loadDispoStages();
  renderBoard();
  updateHeaderCounts();
  if (stagesOpen) renderStages();
}

async function updateStage(key, patch) {
  const { error } = await supa.from("dispo_stages").update(patch).eq("key", key);
  if (error) { toast(`Couldn't update stage: ${error.message}`, { type: "error" }); return; }
  await refreshStages();
}

async function addStage() {
  const key = "stage_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { error } = await supa.from("dispo_stages").insert({ key, label: "New stage", color: "#718096", position: DISPO_STAGES.length, is_terminal: false });
  if (error) { toast(`Couldn't add stage: ${error.message}`, { type: "error" }); return; }
  toast("Stage added", { type: "success" });
  await refreshStages();
}

async function reorderStage(key, dir) {
  const idx = DISPO_STAGES.findIndex(s => s.key === key);
  const swap = idx + dir;
  if (idx < 0 || swap < 0 || swap >= DISPO_STAGES.length) return;
  const a = DISPO_STAGES[idx], b = DISPO_STAGES[swap];
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    supa.from("dispo_stages").update({ position: swap }).eq("key", a.key),
    supa.from("dispo_stages").update({ position: idx }).eq("key", b.key),
  ]);
  if (e1 || e2) { toast("Couldn't reorder stages", { type: "error" }); return; }
  await refreshStages();
}

async function deleteStage(key) {
  if (DISPO_STAGES.length <= 1) return;
  const stage = DISPO_BY_KEY[key];
  const n = dealCountByStage()[key] || 0;
  const firstOther = DISPO_STAGES.find(s => s.key !== key);
  const msg = n > 0
    ? `"${stage.label}" has ${n} deal${n === 1 ? "" : "s"}. Deleting it will move ${n === 1 ? "it" : "them"} to "${firstOther.label}". Continue?`
    : `Delete the "${stage.label}" stage?`;
  if (!confirm(msg)) return;
  // Reassign deals out of this stage first so none orphan.
  if (n > 0) {
    const { error: rErr } = await supa.from("properties").update({ dispo_stage: firstOther.key }).eq("dispo_stage", key);
    if (rErr) { toast(`Couldn't move deals: ${rErr.message}`, { type: "error" }); return; }
    PROPS.forEach(p => { if (p.dispo_stage === key) p.dispo_stage = firstOther.key; });
  }
  const { error } = await supa.from("dispo_stages").delete().eq("key", key);
  if (error) { toast(`Couldn't delete stage: ${error.message}`, { type: "error" }); return; }
  // Re-sequence remaining positions to stay 0..n-1.
  const remaining = DISPO_STAGES.filter(s => s.key !== key);
  await Promise.all(remaining.map((s, i) => supa.from("dispo_stages").update({ position: i }).eq("key", s.key)));
  toast("Stage deleted", { type: "success" });
  await refreshStages();
}

// Close modals on backdrop click / Escape.
document.getElementById("detail-backdrop").addEventListener("click", (e) => { if (e.target.id === "detail-backdrop") closeDetail(); });
document.getElementById("stages-backdrop").addEventListener("click", (e) => { if (e.target.id === "stages-backdrop") closeStages(); });
document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; if (stagesOpen) closeStages(); else if (openCardId) closeDetail(); });

(async () => {
  session = await requireAuth();
  if (!session) return;
  wireLogout(document.getElementById("logout-btn"));
  wireBoardDnD();
  document.getElementById("refresh-btn").addEventListener("click", loadBoard);
  document.getElementById("stages-btn").addEventListener("click", openStages);
  await loadDispoStages();
  await loadBoard();

  // #deal=<card_id> deep link (Posting dashboard → this deal's detail modal).
  const m = location.hash.match(/^#deal=(.+)$/);
  if (m) {
    const cardId = decodeURIComponent(m[1]);
    if (propById[cardId]) openDetail(cardId);
  }
})();
