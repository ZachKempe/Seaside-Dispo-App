# Dispo Stage Tracker + Shared Notes — BUILD SPEC

Adds a **manual, property-level dispo stage** (moved by hand by the operator and
partners) plus an **append-only, authored notes feed** per deal. Works
identically for subto and Morby deals. Fully manual movement — nothing auto-moves
a card. Two safety nets keep a hand-maintained board from rotting: a **stale flag**
(7 days untouched in a non-terminal stage) and a **non-destructive "shoulder-tap"**
that suggests (never applies) a stage change when the deal's own signals imply the
board is behind reality.

## Locked decisions
- **Six stages, manual only:** `prep → live → interest → committed → closed → dead`.
- **Everything lands in `prep`** (migration default backfills existing rows).
- **Current stage only** — no move history table. `stage_moved_at` / `stage_moved_by`
  capture the last move for aging + accountability.
- **Stale = 7 days** in a non-terminal stage (`prep`/`live`/`interest`/`committed`)
  with no stage move since. Fallback clock is `synced_at` when never moved.
- **Notes:** append-only `deal_notes` rows, stamped with the mover's email. The old
  `property_status.notes` blob is left alone (not used for this feature).

---

## STEP 1 — Migration (already written)

Run `sql/021_dispo_stage_and_notes.sql` against Supabase (renamed from `020` on
copy-in — `020` was already taken by `020_deck_pages.sql`). It is purely additive:
adds `dispo_stage` (default `'prep'`), `stage_moved_at`, `stage_moved_by` to
`properties`, and creates the `deal_notes` table with an authenticated-only RLS
policy matching the existing pattern.

Verify after running:
```sql
select card_id, dispo_stage from properties limit 5;   -- all 'prep'
select * from deal_notes limit 1;                       -- table exists, empty
```

---

## STEP 2 — Stage constants + helpers (dashboard.html)

Immediately AFTER the existing `STAGE_BY_KEY` definition (the line
`const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s, i) => [s.key, { ...s, rank: i }]));`),
insert:

```js
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
```

---

## STEP 3 — Fetch the notes feed

In the `Promise.all([...])` block (the one that begins
`const [{ data: terms }, { data: statuses }, ...`), add a `deal_notes` query.

Add a destructured binding for it — change the opening of the destructure to include
`{ data: notes }` (append it before the closing `]`):

```js
      const [{ data: terms }, { data: statuses }, { data: fbPosts }, { data: buyers }, { data: leads }, { data: blasts }, { data: acq }, { data: morby }, { data: recips }, { data: notes }] = await Promise.all([
```

…and add the matching query as the LAST element of the array, after the
`blast_recipients` line:

```js
        supa.from("deal_notes").select("*").in("card_id", cardIds).order("created_at", { ascending: false }),
```

Then, alongside the other `...ByCard` builders (near
`const acqByCard = Object.fromEntries(...)`), add:

```js
      const notesByCard = {};
      for (const n of (notes || [])) (notesByCard[n.card_id] ||= []).push(n);
```

`dispo_stage`, `stage_moved_at`, `stage_moved_by` need no new query — they come
free on the existing `properties.select("*")`.

Pass `notesByCard` into `renderCard`. Update the `renderArgs` closure:

```js
      const renderArgs = (p) => renderCard(p, termsByCard, statusByCard, fbByCard, buyers || [], leadsByCard, blastsByCard, acqByCard, morbyByCard, recipsByCard, notesByCard);
```

And update the `renderCard` signature (the `function renderCard(...)` line) to add
`, notesByCard` as the final parameter.

---

## STEP 4 — Shared dispo bar renderer

Add this helper function just ABOVE `function renderCard(`. It renders the stage
selector, stale flag, shoulder-tap suggestion, and notes feed — used by BOTH card
types so subto and Morby stay in sync (same class of drift the deck-content module
was built to prevent).

```js
    function renderDispoBar(p, leads, blasts, recips, notes) {
      const stage   = p.dispo_stage || "prep";
      const cur     = DISPO_BY_KEY[stage] || DISPO_BY_KEY.prep;
      const stale   = isStaleDeal(p);
      const cardId  = escapeHtml(p.card_id);

      // Shoulder-tap: only suggest an UPGRADE, only on non-terminal manual stages,
      // never move anything automatically.
      let suggestHtml = "";
      if (!DISPO_TERMINAL.has(stage)) {
        const impliedKey = impliedDispoStage(leads, blasts, recips);
        if (impliedKey && DISPO_BY_KEY[impliedKey].rank > cur.rank) {
          const sug = DISPO_BY_KEY[impliedKey];
          suggestHtml = `
            <span class="dispo-suggest" style="display:inline-flex;align-items:center;gap:6px;font-size:0.74rem;color:${sug.color}">
              ⚠️ signals suggest <b>${escapeHtml(sug.label)}</b>
              <button type="button" class="btn btn-ghost btn-sm dispo-accept-btn"
                      data-card-id="${cardId}" data-stage="${sug.key}"
                      style="font-size:0.7rem;padding:1px 8px">Move</button>
            </span>`;
        }
      }

      const noteList = (notes || []).map(n => `
        <div class="dispo-note" style="padding:6px 0;border-bottom:1px solid var(--border,#eee);font-size:0.82rem">
          <div>${escapeHtml(n.body)}</div>
          <div class="muted" style="font-size:0.7rem;margin-top:2px">
            ${escapeHtml(n.author_email || "unknown")} · ${new Date(n.created_at).toLocaleString()}
          </div>
        </div>`).join("") || `<p class="muted" style="font-size:0.8rem;margin:4px 0">No notes yet.</p>`;

      const movedMeta = p.stage_moved_at
        ? `moved ${new Date(p.stage_moved_at).toLocaleDateString()}${p.stage_moved_by ? " · " + escapeHtml(p.stage_moved_by) : ""}`
        : "";

      return `
      <div class="dispo-bar" data-card-id="${cardId}" style="margin:10px 0;padding:10px 12px;background:${cur.color}0f;border-left:3px solid ${cur.color};border-radius:8px">
        <div class="flex-between" style="flex-wrap:wrap;gap:8px">
          <div class="flex gap-8" style="align-items:center;flex-wrap:wrap">
            <label style="margin:0;font-size:0.74rem;color:var(--text-2)">Stage</label>
            <select class="dispo-stage-select" data-card-id="${cardId}" style="width:auto;font-weight:700;color:${cur.color}">
              ${DISPO_STAGES.map(s => `<option value="${s.key}" ${s.key === stage ? "selected" : ""}>${s.label}</option>`).join("")}
            </select>
            ${stale ? `<span class="pill" style="background:#C5303022;color:#C53030;font-size:0.7rem;font-weight:700" title="No stage change in ${STALE_DAYS}+ days">🕓 Stale</span>` : ""}
            ${suggestHtml}
          </div>
          <span class="muted" style="font-size:0.7rem">${movedMeta}</span>
        </div>
        <details style="margin-top:8px">
          <summary style="cursor:pointer;font-size:0.78rem;color:var(--text-2)">Notes (${(notes || []).length})</summary>
          <div style="max-height:200px;overflow-y:auto;margin-top:6px">${noteList}</div>
          <div class="flex gap-8 mt-8">
            <textarea class="dispo-note-input" data-card-id="${cardId}" rows="2"
                      placeholder="Add an update…" style="flex:1;font-family:inherit;font-size:0.82rem"></textarea>
            <button type="button" class="btn btn-primary btn-sm dispo-note-add-btn" data-card-id="${cardId}">Add</button>
          </div>
        </details>
      </div>`;
    }
```

---

## STEP 5 — Inject the bar into both card types

**Subto card:** inside `renderCard`, in the returned subto template, insert the bar
right after the header `</div>` that closes the `flex-between` title row and before
the `${(() => { const activeTab = ... })()}` tabs block. Concretely, place it on
its own line immediately after the line ending
`</div>` that follows `<span class="blast-status muted" ...></span>`'s closing
`</div>` — i.e. right before the tabs `<div class="card-tabs">` group:

```js
          ${renderDispoBar(p, leads, blasts, recips, notesByCard[p.card_id] || [])}
```

**Morby card:** in the `if (dealType === "morby")` branch, insert the same call
between the header `flex-between` block's closing `</div>` and the
`${renderMorbyPanel(p, morby, t)}` line:

```js
          ${renderDispoBar(p, leads, [], recips, notesByCard[p.card_id] || [])}
```

(Morby has no `blasts` array wired in that branch; passing `[]` is fine — the
`recips` sent-rows already carry the Morby deck-send signal.) If `leads`/`recips`
aren't in scope at that point in the Morby branch, compute them at the top of
`renderCard` before the `if (dealType === "morby")` check — `leads` already is
(`const leads = leadsByCard[p.card_id] || [];`); add `recips` there too if needed.

---

## STEP 6 — Current-user email helper

Add near the top of the dashboard script (after `requireAuth` usage), a small
cached getter so stage moves and notes can be stamped:

```js
    let _userEmail = null;
    async function currentUserEmail() {
      if (_userEmail) return _userEmail;
      const { data: { session } } = await supa.auth.getSession();
      _userEmail = session?.user?.email || "";
      return _userEmail;
    }
```

---

## STEP 7 — Event handlers (delegated)

Wire these alongside the existing delegated listeners (the file already uses
`document.querySelectorAll(...).forEach` and/or a delegated click handler — match
whichever pattern the surrounding code uses; delegation on a container is safest
because cards re-render).

**Stage change:**
```js
    document.addEventListener("change", async (e) => {
      const sel = e.target.closest(".dispo-stage-select");
      if (!sel) return;
      const cardId = sel.dataset.cardId;
      const stage  = sel.value;
      const email  = await currentUserEmail();
      const { error } = await supa.from("properties")
        .update({ dispo_stage: stage, stage_moved_at: new Date().toISOString(), stage_moved_by: email })
        .eq("card_id", cardId);
      if (error) { toast("Couldn't move deal: " + error.message, { type: "error" }); return; }
      toast(`Moved to ${DISPO_BY_KEY[stage]?.label || stage}`, { type: "success" });
      loadDashboard();   // or whatever the existing full-refresh fn is named
    });
```

**Accept shoulder-tap suggestion** (same write, target stage from the button):
```js
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".dispo-accept-btn");
      if (!btn) return;
      const cardId = btn.dataset.cardId, stage = btn.dataset.stage;
      const email  = await currentUserEmail();
      const { error } = await supa.from("properties")
        .update({ dispo_stage: stage, stage_moved_at: new Date().toISOString(), stage_moved_by: email })
        .eq("card_id", cardId);
      if (error) { toast("Couldn't move deal: " + error.message, { type: "error" }); return; }
      toast(`Moved to ${DISPO_BY_KEY[stage]?.label || stage}`, { type: "success" });
      loadDashboard();
    });
```

**Add note:**
```js
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".dispo-note-add-btn");
      if (!btn) return;
      const cardId = btn.dataset.cardId;
      const ta = document.querySelector(`.dispo-note-input[data-card-id="${CSS.escape(cardId)}"]`);
      const body = (ta?.value || "").trim();
      if (!body) return;
      const email = await currentUserEmail();
      const { error } = await supa.from("deal_notes").insert({ card_id: cardId, body, author_email: email });
      if (error) { toast("Couldn't save note: " + error.message, { type: "error" }); return; }
      if (ta) ta.value = "";
      toast("Note added", { type: "success" });
      loadDashboard();
    });
```

> Replace `loadDashboard()` with the actual name of the existing function that
> re-runs the fetch+render (the one wrapping the `Promise.all` block). If there
> isn't a single callable, extract that block into one before wiring these.

---

## STEP 8 (optional) — Stale count in the header

Where `prop-count` is set (`document.getElementById("prop-count").textContent = ...`),
append a stale rollup so partners see the aging pressure at a glance:

```js
      const staleCount = (props || []).filter(isStaleDeal).length;
      const staleEl = document.getElementById("stale-count");
      if (staleEl) staleEl.textContent = staleCount ? `· 🕓 ${staleCount} stale` : "";
```

Add `<span id="stale-count" style="color:#C53030;font-weight:700"></span>` next to
the `prop-count` element in the markup. (Optional but recommended — in a fully
manual board this is the single highest-value surface; it's the thing that catches
rot.)

---

## Test checklist
1. Run migration → every property shows **Prep / Not Live**, notes empty.
2. Move a deal to **Live** → pill + left-border recolor, `stage_moved_by` = your
   email, `stage_moved_at` = now. Partner logged in as a different user sees it.
3. Add a note as user A, add another as user B → both show, newest first, each
   stamped with the correct author.
4. Log a `deal_leads` row at `interested` on a deal manually left at **Live** →
   shoulder-tap "⚠️ signals suggest Interest" appears; clicking **Move** advances
   it; it never moved on its own.
5. Send a blast (or Morby deck) on a **Prep** deal → shoulder-tap suggests **Live**.
6. Back-date `stage_moved_at` >7 days on a non-terminal deal → 🕓 Stale badge +
   header count. Set it to **Closed** → badge clears (terminal never goes stale).
7. Confirm subto and Morby cards both render the bar and behave identically.

## Deliberately out of scope (don't add)
- No move-history table (current stage only, by decision).
- No "fell out" stage — a backed-out **Committed** deal moves back to **Live** with
  a note.
- No "negotiating" stage — that's a note inside **Interest**.
- No auto-movement — the shoulder-tap suggests; a human always confirms.
