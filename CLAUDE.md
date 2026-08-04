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

Page logic lives in `public/js/<page>.js` (one file per page, loaded after `supa.js`).
Presentation helpers (`escapeHtml`, `timeAgo`, `fmtDate`) are in `public/js/ui-shared.js`;
modal chrome is the `.modal-backdrop` class in `app.css` — don't re-inline either.
`fmtMoney` is deliberately per-page (dashboard shows "—" for empty, buyers/pipeline show "").

### Surfaces

| Surface | File | Purpose |
|---|---|---|
| Sign in | `public/index.html` | Supabase email/password auth + forgot-password (`reset.html` handles the recovery link) |
| Reports | `public/reports.html` | Read-only rollups: per-deal funnel, copy-variation performance, time-in-stage aging, closed-deal stats |
| Posting Dashboard | `public/dashboard.html` | Deals (Sub-To via contract upload, Morby via LOI upload — both AI-extracted), terms, copy variations, email/SMS blasts, per-deal leads |
| Buyer Dashboard | `public/buyers.html` | Buyer CRM: master-detail list, CSV import, deal matcher, buy-box onboarding |
| Pipeline | `public/pipeline.html` | Kanban dispo board: manual stages, drag-drop, shared notes, stale flags |
| Deck page (public) | `/deck/<slug>` → `netlify/functions/deck.js` | Buyer-facing deal page; `?b=<token>` attributes views/interest to a buyer; `.pdf` suffix redirects to the stored PDF |

### Functions

- `send-blast.js` — email (Resend, Gmail fallback) + SMS (GoHighLevel) blasts. Recipient-level
  idempotency via `blast_recipients` (full blasts skip prior `sent`; retry mode targets `failed`).
- `deck.js` / `deck-interest.js` — render the deal page, log `deck_views`, capture interest
  AND soft offers into `deal_leads` (`source='deck_page'`; an offer amount sets
  `stage='offer'`, plain interest never downgrades an existing offer). Every hand-raise
  sends two emails: the 🔥 alert to `NOTIFY_EMAIL`, and an instant receipt to the investor
  (deck link + PDF + a booking button that always renders, content in
  `lib/interest-receipt.js`).
  The receipt is best-effort — it can never fail the lead capture — and is skipped for
  hard-bounced buyers and for untokenized contacts that aren't an email address. It's
  tagged with `buyer_id` but deliberately **not** `card_id`, so a complaint still suppresses
  the buyer while a receipt open stays out of per-deal blast metrics.
  An **untokenized** hand-raise (a forwarded link) also becomes a `buyers` row
  (`list_source='deck_page'`, `sms_opt_in` false — a deck tap is not SMS consent;
  `onboarded_at` left null so the buy-box sequence picks them up). `lib/contact.js`
  decides whether the one free-text contact field is an email or a US phone; when it's
  neither, the lead is still recorded and **no** buyer is created. The whole buyer step is
  wrapped so any failure degrades to the old buyer-less behavior — never lose the lead to
  gain a buyer. A soft-deleted match is restored (`restoreRemoved`) and the 🔥 alert says so.
- `resend-events.js` — Resend webhook (svix-verified) for email opens/clicks/bounces/
  complaints → `email_events`, attributed via the buyer_id/card_id tags send-blast sets;
  complaints auto-set `email_opt_out`. Needs `RESEND_WEBHOOK_SECRET` + a webhook configured
  in the Resend dashboard.
- `deck-dwell.js` — sendBeacon target that fills `deck_views.dwell_seconds` (view-token
  signed, only-increases).
- `deck-link.js` — auth'd resolver behind the dashboard's 🔗 Copy-link buttons: ensures
  `properties.deck_slug` (slugs are minted eagerly at intake; this backfills legacy cards)
  and returns the plain or per-buyer tokenized deck URL. Slug generation is shared via
  `lib/deck-slug.js` — never inline a second copy.
- `import-photos.js` — "Import from link" for the per-deal photo gallery: pulls every
  image from a Drive folder (Drive API via `GOOGLE_API_KEY`, falls back to
  `GOOGLE_MAPS_API_KEY`), a listing page, or direct URLs into
  `property-photos/gallery/<card_id>/` (convention + helpers in `lib/gallery.js` — the
  dashboard uploads there directly, deck.js lists it). `deal_acquisition.photos_count`
  auto-syncs to the real gallery size; when a deal has no photos the deck page shows an
  auto Street View + aerial set (`autoExteriorShots` in `lib/deck-photo.js`). Zillow
  bot-walls servers, so Zillow photos come from the user's own browser via
  `browser-extension/` (📸 button → `dashboard.html#import-photos=…`) or the 🧲
  bookmarklet in the dashboard gallery block.
- `parse-loi.js` — sends an LOI PDF to the Claude API, extracts Morby deal terms.
- `parse-subto.js` / `generate-copy.js` — the Sub-To intake (Trello retired July 2026):
  contract + optional mortgage-statement PDFs → Claude extracts `deal_terms` and creates
  the card (`card_id` `subto-…`); a second call writes 3 marketing copy variations FROM
  the saved structured terms so copy numbers can't drift from `deal_terms`.
- `onboard-buyers.js` — buy-box request sequence: up to 3 asks per buyer, each ≥5 days
  after that buyer's own last one, the final one by SMS when they're textable
  (`onboard_touches` / `onboard_last_at` / `onboard_last_channel`, migration 033 —
  without it the function refuses follow-ups it couldn't record and behaves like the old
  one-email-ever version). Stops asking anyone whose `buyBoxCompleteness` is `full`,
  honors email opt-out/bounce and the SMS STOP list, and `{preview:true}` reports exactly
  what would go out without sending. GHL sending is `lib/ghl-sms.js`, shared with blast-core.
- `unsubscribe.js` — HMAC-tokenized opt-out.
- `ghl-inbound.js` — webhook for inbound GHL SMS; attributes the text to the deal most
  recently SMS-blasted to that phone (7-day window via `blast_recipients`).
- Scheduled (see `netlify.toml`): `sync-buyers` (5 min, Netlify Forms buyer intake →
  `buyers`), `capture-replies` (15 min, Gmail replies → buyers + leads; also purges
  `sync_runs` >30 days), `weekly-digest` (Mondays 14:00 UTC, 7-day rollup email).
  There is no Trello sync — deal creation and lifecycle (archive via the 🗑 button)
  are fully in-dashboard.

### Shared logic — the one rule that matters

**Buyer matching, deal money math, and engagement scoring live ONLY in
`public/js/deal-shared.js`** (UMD: browser gets `window.DealShared`, functions
`require("../../public/js/deal-shared")`). The dashboard blast preview, `send-blast.js`, the
emails, and the deck page all import from it, so what you preview is what sends. Never
re-implement `matchesDeal`, `buyerCashAtClose`, `dscrMonthlyPayment`, `engagementScore`, or
the term-row builders locally — past drift between copies caused real bugs.

Two Block 4 companions to `matchesDeal`, both **advisory** — neither may ever be wired into
the send path, and `matchesDeal` stays the sole authority on who receives a blast:

- `buyBoxCompleteness(buyer)` → `full` / `partial` / `wildcard`. A wildcard has no state,
  strategy, money cap or bed floor, so `matchesDeal` passes them on *every* deal. The
  buyers-page header and the blast modal both show the split so a "300 matched" audience
  can't quietly be 180 blanks; `onboard-buyers.js` uses `full` as "stop asking".
- `nearMissDeal(...)` → the tolerance band (10% over a money cap, or one bed short). State
  and strategy mismatches are never near misses. Near misses render as their own group in
  the blast picker, unselected — adding one is always a deliberate click.

`engagementScore` can go **down**: `ENGAGEMENT_PENALTIES` docks hard bounces (−15, capped
at −30, keyed off `email_bounced_at` so transient bounces don't count) and zeroes anyone
who filed a spam complaint. Positives are clamped to 100 *before* the penalty applies, so
a complaint outweighs any amount of open/click history, and penalties don't decay.

Engagement data model: `deck_views` (page views + PDF downloads + dwell + `source`:
which channel the link came from — `sms`/`email`/`dm`/`''`=direct, migration 030;
blast-core tags every deck link with `&s=<channel>`), `email_events`
(opens/clicks from Resend), `buyer_activity` (inbound replies + manual touches),
`deal_leads` (pipeline stages), `deal_tasks` (next actions with due dates, pipeline page).
buyers.html aggregates these into the per-buyer score and timeline; dashboard.html builds
the "Call today" strip from leads + recent deck views, and the follow-up nudge
(`followUpInfo`) from non-engaged blast recipients 48h+ after a send. A follow-up send is
marked `[follow-up]` in `deal_blasts.detail` — that marker is what caps it at one per deal. Other cross-function helpers live in `netlify/functions/lib/` (`capture.js`,
`deck-token.js`, `deck-photo.js`, `heartbeat.js`, `ghl-sms.js`, `unsub.js`,
`interest-receipt.js`, `contact.js`, `buyer-intake.js`,
`onboard-sequence.js`). `unsub.js` owns both minting and verifying the unsubscribe token —
they must agree or live links in already-sent email break (pinned in `tests/unsub.test.js`).

Buyer records are deduped on **digits-only phone / lower-cased email** — the CSV importer
(`classifyImport`) and the Add Buyer form (`findDuplicateBuyer`) must keep using the same
keys, and the form additionally checks soft-deleted rows so a removed buyer is restored
rather than duplicated. Server-side, `findOrCreateBuyer` in `lib/capture.js` is the **only**
find-or-create implementation — inbound replies (`captureResponder`) and deck-page
hand-raises (`deck-interest.js`) both go through it. Never add a second one.

The public buy-box questionnaire is parsed by `lib/buyer-intake.js` (`parseStates`,
`parseStrategy`, `parseMaxPrice`). Two things it must keep doing: the strategy pills are
**multi-select**, so a buyer who picks several structures is stored as the comma list
`matchesDeal` already understands (`"subto,cash"`) — collapsing to one silently stops them
receiving deal types they asked for; and `cash_max_price` must land in `max_price`, or a
fully-answered cash buyer stays `partial` and `onboard-buyers.js` keeps asking them for a
box they already gave. `sf_max_down` is a **down-payment** cap and must never become
`max_price`. ⚠ A near-identical copy of this parsing lives in the separate, drag-and-drop
deployed buyer-form repo (`~/seaside-buyer-form/netlify/functions/submit-buyer.js`), which
inserts directly and wins the race against the 5-minute `sync-buyers` poll — change both
together or live submissions land differently depending on which writer got there first.

Scheduled functions must log every run through `lib/heartbeat.js` → `sync_runs` (powers the
dashboard "✓ synced" indicator and the consecutive-failure email alert).

## Database / migrations

Numbered SQL files in `sql/`, **run manually** in the Supabase SQL editor — there is no
migration runner. Take the next number (highest is `033_onboard_sequence.sql`). Every new
migration must END with `insert into schema_migrations (filename) values ('0XX_name.sql')
on conflict do nothing;` so applied state stays queryable. Migrations must be
additive/idempotent (`if not exists`, `do $$` policy guards) and the frontend must fail soft
when a migration hasn't run yet (see `loadAll`'s `archived` fallback for the pattern).
RLS convention: authenticated users get full access; public tables written by functions use
the service key.

## Testing & verification

- `npm test` — Node's built-in runner over `tests/` (pure-logic tests for `deal-shared.js`).
  Run it after touching matching or money math.
- Syntax-check page scripts after editing: `for f in public/js/*.js; do node --check "$f"; done`
  (index.html/reset.html still carry small inline scripts — extract-and-parse those with
  `new Function(...)` if touched).
- Blasts have a test mode (🧪 sends only to the caller) — use it before any live send.

## Deploys & env

Push to `main` deploys via Netlify. Key env vars (set in Netlify): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, `RESEND_FROM`,
`GMAIL_*` (fallback sender + reply capture), `GHL_*` (SMS),
`ANTHROPIC_API_KEY` (LOI/contract parsing + copy generation), `PUBLIC_SITE_URL`, `UNSUB_SECRET`, `DECK_TOKEN_SECRET`,
`NOTIFY_EMAIL` (interest + sync-failure alerts), `GOOGLE_MAPS_API_KEY` (deck photo fallback),
`CAPTURE_WEBHOOK_SECRET` (GHL webhook), `CALENDLY_URL` (**optional** override for the
booking button on the deck-page interest receipt — `lib/interest-receipt.js` hardcodes
`DEFAULT_CALENDLY_URL` as the fallback, so the button renders whether or not this is set.
Relying on the env var alone silently stripped the button from live receipts once, because
Netlify only injects env vars into functions at deploy time).

## Conventions

- Escape everything rendered into HTML (`escapeHtml` client-side, `esc` in `deck.js`).
- Soft-delete + undo toast over hard deletes; deletes/archives are reversible.
- Build specs for larger features live in `docs/` and the repo root (`*-BUILD-SPEC.md`);
  `dispo-stage-tracker-BUILD-SPEC.md` records locked product decisions (six manual stages,
  no move history, no auto-movement) — don't re-litigate them.
