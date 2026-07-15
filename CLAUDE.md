# Seaside Dispo App

Disposition platform for Seaside Horizon (real estate wholesaling): match under-contract
deals to a buyer list, blast them by email/SMS, capture interest, and track each deal to
close. Live production system for a real business — prefer the smallest change that
satisfies the requirement.

## Architecture

Static HTML pages (no framework, no build step) served from `public/`, Netlify Functions
in `netlify/functions/`, Supabase (Postgres + Auth + Storage) as the backend. Pages talk
to Supabase directly from the browser via `public/js/supa.js` (anon key + RLS); functions
use the service-role key via env vars.

### Surfaces

| Surface | File | Purpose |
|---|---|---|
| Sign in | `public/index.html` | Supabase email/password auth |
| Posting Dashboard | `public/dashboard.html` | Deals (synced from Trello), terms, copy variations, email/SMS blasts, Morby deals w/ LOI extraction, per-deal leads |
| Buyer Dashboard | `public/buyers.html` | Buyer CRM: master-detail list, CSV import, deal matcher, buy-box onboarding |
| Pipeline | `public/pipeline.html` | Kanban dispo board: manual stages, drag-drop, shared notes, stale flags |
| Deck page (public) | `/deck/<slug>` → `netlify/functions/deck.js` | Buyer-facing deal page; `?b=<token>` attributes views/interest to a buyer; `.pdf` suffix redirects to the stored PDF |

### Functions

- `send-blast.js` — email (Resend, Gmail fallback) + SMS (GoHighLevel) blasts. Recipient-level
  idempotency via `blast_recipients` (full blasts skip prior `sent`; retry mode targets `failed`).
- `deck.js` / `deck-interest.js` — render the deal page, log `deck_views`, capture interest
  AND soft offers into `deal_leads` (`source='deck_page'`; an offer amount sets
  `stage='offer'`, plain interest never downgrades an existing offer).
- `resend-events.js` — Resend webhook (svix-verified) for email opens/clicks/bounces/
  complaints → `email_events`, attributed via the buyer_id/card_id tags send-blast sets;
  complaints auto-set `email_opt_out`. Needs `RESEND_WEBHOOK_SECRET` + a webhook configured
  in the Resend dashboard.
- `deck-dwell.js` — sendBeacon target that fills `deck_views.dwell_seconds` (view-token
  signed, only-increases).
- `parse-loi.js` — sends an LOI PDF to the Claude API, extracts Morby deal terms.
- `onboard-buyers.js` — one-time buy-box request email to new buyers (`onboarded_at` gate).
- `unsubscribe.js` — HMAC-tokenized opt-out.
- `ghl-inbound.js` — webhook for inbound GHL SMS; attributes the text to the deal most
  recently SMS-blasted to that phone (7-day window via `blast_recipients`).
- Scheduled (see `netlify.toml`): `sync-trello` (10 min, Trello cards → `properties`/`deal_terms`),
  `sync-buyers` (5 min, Netlify Forms buyer intake → `buyers`), `capture-replies`
  (15 min, Gmail replies → buyers + leads).

### Shared logic — the one rule that matters

**Buyer matching, deal money math, and engagement scoring live ONLY in
`public/js/deal-shared.js`** (UMD: browser gets `window.DealShared`, functions
`require("../../public/js/deal-shared")`). The dashboard blast preview, `send-blast.js`, the
emails, and the deck page all import from it, so what you preview is what sends. Never
re-implement `matchesDeal`, `buyerCashAtClose`, `dscrMonthlyPayment`, `engagementScore`, or
the term-row builders locally — past drift between copies caused real bugs.

Engagement data model: `deck_views` (page views + PDF downloads + dwell), `email_events`
(opens/clicks from Resend), `buyer_activity` (inbound replies + manual touches),
`deal_leads` (pipeline stages), `deal_tasks` (next actions with due dates, pipeline page).
buyers.html aggregates these into the per-buyer score and timeline; dashboard.html builds
the "Call today" strip from leads + recent deck views, and the follow-up nudge
(`followUpInfo`) from non-engaged blast recipients 48h+ after a send. A follow-up send is
marked `[follow-up]` in `deal_blasts.detail` — that marker is what caps it at one per deal. Other cross-function helpers live in `netlify/functions/lib/` (`capture.js`,
`deck-token.js`, `deck-photo.js`, `heartbeat.js`).

Scheduled functions must log every run through `lib/heartbeat.js` → `sync_runs` (powers the
dashboard "✓ synced" indicator and the consecutive-failure email alert).

## Database / migrations

Numbered SQL files in `sql/`, **run manually** in the Supabase SQL editor — there is no
migration runner. Take the next number (highest is `025_sync_runs.sql`). Migrations must be
additive/idempotent (`if not exists`, `do $$` policy guards) and the frontend must fail soft
when a migration hasn't run yet (see `loadAll`'s `archived` fallback for the pattern).
RLS convention: authenticated users get full access; public tables written by functions use
the service key.

## Testing & verification

- `npm test` — Node's built-in runner over `tests/` (pure-logic tests for `deal-shared.js`).
  Run it after touching matching or money math.
- Syntax-check inline page scripts after editing:
  `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1])"`
- Blasts have a test mode (🧪 sends only to the caller) — use it before any live send.

## Deploys & env

Push to `main` deploys via Netlify. Key env vars (set in Netlify): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, `RESEND_FROM`,
`GMAIL_*` (fallback sender + reply capture), `GHL_*` (SMS), `TRELLO_*`,
`ANTHROPIC_API_KEY` (LOI parsing), `PUBLIC_SITE_URL`, `UNSUB_SECRET`, `DECK_TOKEN_SECRET`,
`NOTIFY_EMAIL` (interest + sync-failure alerts), `GOOGLE_MAPS_API_KEY` (deck photo fallback),
`CAPTURE_WEBHOOK_SECRET` (GHL webhook).

## Conventions

- Escape everything rendered into HTML (`escapeHtml` client-side, `esc` in `deck.js`).
- Soft-delete + undo toast over hard deletes; deletes/archives are reversible.
- Build specs for larger features live in `docs/` and the repo root (`*-BUILD-SPEC.md`);
  `dispo-stage-tracker-BUILD-SPEC.md` records locked product decisions (six manual stages,
  no move history, no auto-movement) — don't re-litigate them.
