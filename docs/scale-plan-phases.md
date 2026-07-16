# Seaside Dispo — Scale Plan (Phases 1 & 2)

Derived from the July 2026 systems review. **Phase 0 is done and merged** (PRs #2, #3).
This doc is the implementation plan for the remaining phases, written to be picked up
by a fresh session with no prior context.

## How to use this doc
- Read `CLAUDE.md` first — it holds the hard rules (shared logic in `deal-shared.js`,
  manual SQL migrations ending with the `schema_migrations` insert, `npm test` +
  `node --check` verification, test-mode before any live send, $0/month preference).
- Findings keep their original IDs (F3, F4, …) from the review.
- Suggested workflow: **one item per branch + PR**, Netlify builds a deploy preview,
  verify there, then merge. Never touch the live send path without a 🧪 test send to
  seed buyer id 248 first.
- The `git remote` uses `gh` keyring auth (no embedded token).

## Status recap
Done in Phase 0: F1 (reply-capture drift fix + shared `lib/subjects.js` + tests),
F2 (nightly encrypted DB backup → private repo `ZachKempe/seaside-db-backups`, verified),
migration 019 (dropped dead `leads` table), F10 (CAN-SPAM footer via
`MARKETING_POSTAL_ADDRESS`). F6 was investigated and de-risked (automation folder isn't
git/cloud-synced; nothing auto-runs).

## Open questions that gate sequencing
1. **Which Resend plan?** (free = 100 emails/day). Sets blast-budget urgency + affects F4.
2. **Is `main.py` still the live Sub-To intake?** Gates F5 (real port vs. cleanup).
3. **Active buyer count + growth target?** ~600 vs ~5,000 changes Phase-1 urgency (esp. F3).

---

# Phase 1 — Scale-proof the send path (~1 week)

### F3 — Hidden 1,000-row cap  ·  ~1 day  ·  HIGHEST PRIORITY
**Problem:** Supabase PostgREST returns at most 1,000 rows per request by default.
Whole-table fetches silently truncate past 1,000 rows — **no error thrown**. Past 1,000
buyers this drops buyers from blasts, breaks dedupe (→ duplicates), and misses reply
attribution.
**Call sites to fix:**
- `netlify/functions/send-blast.js` — `/buyers?active=eq.true&select=*` (the blast audience)
- `netlify/functions/sync-buyers.js` — `/buyers?select=phone,email` (dedupe set)
- `netlify/functions/lib/capture.js` — `findBuyer` phone path scans `/buyers?...&phone=neq.`
- `netlify/functions/sync-trello.js` — properties/deal_terms card_id fetches (lower risk, same pattern)
- Browser: `public/js/buyers.js`, `public/js/dashboard.js` — supabase-js has the same default cap
**Approach:** Add a `fetchAll` paging helper in `netlify/functions/lib/` (offset+limit or
`Range` headers, page size 1000, loop until a short page). Apply at each server call site.
Browser: supabase-js `.range()` loops or explicit `.limit()` raises where a full set is needed.
**Verify:** `npm test`; `node --check`; reason through / seed >1000 rows in a scratch project;
confirm the blast "matched" count includes buyers beyond row 1000.
**Note:** a task chip (`task_30e25dc5`) already exists for this.

### F4 — send-blast → background function  ·  ~2–3 days
**Problem:** Synchronous Netlify functions get ~10s. Email runs 25-concurrent (~600
recipients fit); SMS is fully serial with 2 GHL calls each (~8–10 texts) before timeout.
Large blasts die mid-send. The `blast_recipients` idempotency ledger lets a re-click resume
safely, but "click until it stops timing out" isn't a real process.
**Files:** `netlify/functions/send-blast.js` (→ Netlify background function — name suffix
`-background`, 15-min limit, returns 202 immediately); `public/js/dashboard.js` (blast modal
polls progress).
**Approach:** Background functions can't return a result body, so the dashboard polls
`blast_recipients` (counts by status) for a live progress bar — the ledger already has
everything needed. Keep **test mode synchronous** (small, returns immediately) so the preview
UX is unchanged; only the live path goes async.
**Verify:** test mode still returns inline; large live blast (to a test audience) fills
`blast_recipients` while the dashboard shows progress.

### F8 — CI on every push  ·  ~0.5 day
**Problem:** Push to `main` deploys to production with no gate; tests run only when someone
remembers. F1-class drift ships silently.
**Files:** new `.github/workflows/ci.yml`.
**Approach:** On push + PR: `npm test` and `node --check` over `public/js/*.js` and
`netlify/functions/**/*.js` (and the inline index.html/reset.html scripts per CLAUDE.md).
Netlify deploy previews are already free — use a branch + preview for anything touching send paths.
**Verify:** the workflow runs green on a PR; break a test locally to confirm it would fail red.

### F7 — DB-level buyer uniqueness  ·  ~1 day
**Problem:** Three intake paths (`submit-buyer.js` direct write, `sync-buyers.js` poll, GHL
webhook) with two different dedupe implementations (exact-string vs normalized-digits) and no
database constraint. Format-sensitive dedupe → duplicate buyers → split engagement history +
double-texting one person.
**Files:** new `sql/029_buyer_dedupe.sql`; align normalization in `netlify/functions/sync-buyers.js`
and the buyer-form's `submit-buyer.js` (separate repo, see below).
**Approach:** Migration 029 — add a generated normalized-phone column (digits only, strip
leading `1`) + partial unique indexes on it (`where phone <> ''`) and on `lower(email)`
(`where email <> ''`). Additive/idempotent; ends with the `schema_migrations` insert.
**Gotcha:** a unique index creation FAILS if duplicates already exist — include a
dupe-detection query and a merge/deactivate step to run first. Frontend must fail soft if the
migration hasn't run yet.
**Verify:** attempt a duplicate insert via both paths → the second is rejected/deduped.

### Resend plan confirmation  ·  15 min  ·  (open question #1)
Confirm the tier and set a per-blast sending budget. Free tier's 100 emails/day is a hard
ceiling that fails a blast mid-send. Pro is ~$20/mo for 50k.

---

# Phase 2 — Retire the laptop, close the loop (~2 weeks, spread out)

### F5 — Server-side Sub-To intake  ·  ~1 week  ·  (gated by open question #2)
**Problem:** Sub-To deal intake depends on `main.py` running on Zach's laptop (watches Trello,
pulls contracts from Discord, extracts terms via Claude, posts the `DEAL TERMS` comment that
`sync-trello` ingests). The dispo side is cloud-native; intake is one laptop. Laptop
closed/crashed → new deals arrive with no terms and no copy, no alert.
**Files:** new Netlify function mirroring `netlify/functions/parse-loi.js`; `public/dashboard.html`
+ `public/js/dashboard.js` (add a Sub-To contract/mortgage-statement upload UI, same pattern as
the existing Morby LOI upload).
**Approach:** Upload contract + mortgage statement → Claude extracts terms server-side → write
`deal_terms`. Retires `main.py`; Trello becomes a mirror, not a dependency.
**Interim mitigation (already available):** the dashboard supports manual term entry — runbook
line: "if a card has no terms 15 min after sync, enter manually."
**Verify:** upload a sample contract → terms populate the deal.

### Buyer-form repo → GitHub + Netlify CI  ·  ~0.5 day
**Problem:** `~/seaside-buyer-form` (the public intake questionnaire, Netlify site
`seaside-buyer-questionnaire`) deploys by manual drag-and-drop with no GitHub remote — not
reproducible or reviewable. It writes to the same Supabase `buyers` table via `submit-buyer.js`.
**Approach:** Push that folder to a GitHub repo and connect the Netlify site for auto-deploy.
See the `seaside-infra-map` memory for which site/account owns it.

### F9 — Observability round-out  ·  ~1–2 days
**Problem:** Heartbeats (`sync_runs`) cover only the 3 scheduled jobs. Failures in
`resend-events`, `deck-interest`, `ghl-inbound`, and `submit-buyer` (on the other site) surface
only in Netlify logs nobody reads. `sync_runs` grows ~16k rows/month with no retention.
**Approach:** (a) 30-day `sync_runs` purge inside an existing scheduled run; (b) extend the
dashboard sync-health strip with "last webhook event received" timestamps (a stale
`email_events` max-date after a blast means the Resend webhook is broken); (c) a weekly digest
email — the Reports page already computes everything it would contain.

### Paid-tiers decision point
When buyers pass ~2,000 or a blast regularly exceeds the Resend daily budget: move to
Supabase Pro ($25/mo — includes managed point-in-time backups, so the `db-backup` workflow can
be retired) + Resend Pro ($20/mo). ~$45/mo total. Revisit the $0 constraint then, not before.

---

# Leftover Phase 0 nits
- **Rotate the dead `ghp_…` GitHub PAT** (classic token) — cleanup; pushes already use `gh` keyring.
- **Optional live sanity check:** 🧪 test blast to seed buyer 248 to confirm the F1 deploy +
  footer render correctly on production.
- **F6 folder cleanup:** archive retired scripts in `~/seaside_automation` once F5 retires
  `main.py`; rotate `config.json` secrets only if that folder was ever cloud-synced (currently not).

# References
- Review artifact: "Dispo Platform — Systems Review & Scale Plan" (published July 2026).
- `docs/db-backup-SETUP.md` (backups + restore drill), `docs/migration-check.sql`.
- Memory: `phase0-scale-review-status`, `migration-028-ledger-gotcha`, `seaside-infra-map`.
