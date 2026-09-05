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
The CSV import engine (`parseCsv`, `detectMapping`, `normalizeState`, `buildRowsFromCsv`,
`classifyImport`, and the `digitsOnly`/`validEmail` dedupe keys) is `public/js/csv-import.js`,
shared by the buyer and contact importers — a second copy of "which column is the phone
number" and "have we already got this person" drifts silently, and drifted dedupe means
duplicate buyers who each receive their own blast.
`fmtMoney` is deliberately per-page (dashboard shows "—" for empty, buyers/pipeline show "").

### Surfaces

| Surface | File | Purpose |
|---|---|---|
| Sign in | `public/index.html` | Supabase email/password auth + forgot-password (`reset.html` handles the recovery link) |
| Reports | `public/reports.html` | Read-only rollups: per-deal funnel, copy-variation performance, time-in-stage aging, closed-deal stats |
| Posting Dashboard | `public/dashboard.html` | Deals in three structure groups (Sub-To via contract upload, Morby via LOI upload, Cash via contract upload — all AI-extracted), terms, copy variations, email/SMS blasts, per-deal leads |
| Buyer Dashboard | `public/buyers.html` | Buyer CRM: master-detail list, CSV import, deal matcher, buy-box onboarding |
| Contacts | `public/contacts.html` | The non-buyer network: DSCR lenders, mortgage brokers, transactional lenders, VIP agents (`?type=` picks the list) + CSV import |
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
  The receipt also carries the **buy-box ask** (below) when the buyer's box isn't already
  `full` — placed under the deal buttons, never among them.
  Whether a deal has a hosted PDF is `lib/deck-pdf.js` (`deckPdfExists`) and **only** that:
  the deck page's PDF button, the receipt's download button and the `/deck/<slug>.pdf`
  route all gate on it. Before H3 the button rendered unconditionally, so every Sub-To deck
  (no blast ever uploads one) sent investors to a raw Storage 404 — and the route logged
  `deck_views(kind='pdf')` *before* resolving anything, so dead-link taps scored +5
  engagement and inflated the deck's own "N PDF downloads" chip. A `.pdf` hit with no file
  now 302s to the deal page carrying `?b=`/`?s=`, and logs nothing.
- `buy-box.js` — the tokenized buy-box form (`/buy-box?t=<deckToken>`) linked from the
  interest receipt. **The ask deliberately lives in the receipt, not on the deck page:** the
  one-tap hand-raise is the best-converting thing on that page, so the conversion is banked
  first and the ask costs nothing if ignored. A plain `<form method="POST">` — no client JS
  — because it is opened from email on a phone. Parsing reuses `lib/buyer-intake.js`
  (same parsers as the public questionnaire) via `lib/buy-box-form.js`, which owns the write
  rules and mints the link, the way `unsub.js` owns its token. Two rules that matter: a
  blank answer **never** overwrites a known one (so a buyer can finish the form across two
  visits), and every number is sanity-banded — a junk cap like `max_piti=5` is a *filter*
  that would silently exclude them from every deal, so it's dropped and re-asked rather than
  saved. Nothing wires into `onboard-buyers.js`: `dueTouch` already stops on
  `buyBoxCompleteness === 'full'`, so an answered form ends the email sequence by itself.
- `buyer-messages.js` — the 💬 Text / ✉️ Email buttons on a buyer's card (buyers.html open a
  conversation panel). `GET ?buyer_id=` returns the buyer's whole thread, both channels merged;
  `POST {buyer_id, channel, body, subject?}` sends one text (GHL) or one email (Gmail, Resend
  fallback, threaded onto the latest Gmail message via In-Reply-To + threadId). **History is
  the `buyer_messages` ledger (migration 037), synced incrementally from the providers on
  each open** — GHL's conversation for the number (`fetchSmsThread` in `lib/ghl-sms.js`) and
  Gmail's messages to/from the address (`lib/gmail.js`), fetching only ids not already saved;
  `ghl-inbound.js` writes inbound texts to the ledger too, and both send paths write what they
  sent. ⚠ The first version read Gmail live on every open and hit the mailbox's
  **per-minute quota within the hour** (403 "Total Query Cost") — never go back to fetching
  a buyer's whole mailbox history per open; the page's background poll syncs `sms` only, and
  only while the tab is visible. A provider error with saved history behind it is reported
  `stale` (amber footnote), not an error. Pre-037 the function runs live-only and returns
  `ledger:false` so the page names the migration. Normalizing/merging/MIME is the pure
  `lib/conversation.js` (`tests/conversation.test.js`); the merge also folds the same text
  under two ids (webhook copy vs GHL listing). Every send logs a `buyer_activity` touch with channel
  **`manual`** and a `📤` detail prefix — never `sms`/`email`, which `buildEngagement` scores
  as *replies*; the test pins that. Compliance lives in the send path: a number on
  `sms_suppressions` (replied STOP) and a hard-bounced address are refused; a buyer without
  `sms_opt_in` CAN be texted one-to-one (a human replying is not a campaign) and the panel
  says so. Nothing here reads `contacts`. If GHL returns 401/403 on the read, the panel says
  the API token needs the Conversations read scopes.
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
- `parse-contacts.js` — "Import from PDF" for the Contacts page: a roster / attendee list /
  page of business cards → Claude → `{contacts:[…]}`. It **writes nothing and never holds the
  service-role key** — the rows go back to the browser and through the same
  preview → dedupe → confirm flow a CSV import uses, so a misread page is something you
  cancel rather than 80 rows you have to undo. `tests/parse-contacts.test.js` pins that (it
  fails if the file gains a `/rest/v1` write), plus the response shaping: every field is a
  string, unreachable rows are dropped, fences are stripped, a `refusal` stop_reason is
  reported instead of parsed, and both the auth and size guards run *before* any API spend.
- `parse-cash.js` — the **third structure**'s intake (migration 035). Purchase contract
  (+ an optional concession addendum / payoff letter / original listing) → Claude extracts
  the price stack into `cash_deals`, creating a `properties` row (`card_id` `cash-…`).
  A cash deal is a wholesale purchase priced off a **seller concession**:
  `original_price − amount_forgiven = purchase_price`. All three columns are nullable and
  `cashPriceStack` derives whichever is missing, so a contract that only states two still
  renders a complete stack; parse-cash reconciles once at intake and only ever FILLS a
  blank — a stated concession beats arithmetic.
  Structurally the cash deck is **the Morby deck minus seller financing**: no carry balance,
  no deferred rate, no balloon, no seller-flexibility notes. It keeps the DSCR loan block and
  the LTR/STR net-cash-flow columns. There is deliberately **no cash-at-close** anywhere on
  a cash deal — `buyerCashAtClose` must never be called on one. On a Morby deal the DSCR loan
  proceeds exceed the buyer's cash in, which produces a real payday at the table that gets
  split; a cash buyer funds the purchase and walks away with equity, so the **amount forgiven
  is the headline** (deck-page hero, email band, SMS first line, PDF summary band).
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
re-implement `matchesDeal`, `buyerCashAtClose`, `dscrMonthlyPayment`, `cashPriceStack`,
`engagementScore`, or the term-row builders locally — past drift between copies caused real
bugs.

**Sub-To is the FALLBACK structure everywhere it's resolved**, so every other structure has
to be named explicitly — `dealStrategyOf` (dashboard.js), the `dealStrategy` ternary in
`blast-core.js`, the `allSubto` board filter, and `plDealType` (pipeline.js). A structure
missing from one of those doesn't fail loudly; it quietly files a cash deal under Sub-To and
blasts it with a Sub-To email. `dealMatchPrice` exists for the same reason: a cash deal has
no `deal_terms` row, so reading `terms.price` hands `matchesDeal` a 0 — and a 0 price makes
it skip every buyer's budget cap.

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
A `deck_views` row with `kind='pdf'` must mean a real download — `deck.js` resolves the
Storage object before logging one (see `lib/deck-pdf.js`), because that row feeds both
`engagementScore` and the buyer-facing download count.
buyers.html aggregates these into the per-buyer score and timeline; dashboard.html builds
the "Call today" strip from leads + recent deck views, and the follow-up nudge
(`followUpInfo`) from non-engaged blast recipients 48h+ after a send. A follow-up send is
marked `[follow-up]` in `deal_blasts.detail` — that marker is what caps it at one per deal. Other cross-function helpers live in `netlify/functions/lib/` (`capture.js`,
`deck-token.js`, `deck-photo.js`, `heartbeat.js`, `ghl-sms.js`, `unsub.js`,
`interest-receipt.js`, `contact.js`, `buyer-intake.js`,
`onboard-sequence.js`, `buy-box-form.js`, `deck-pdf.js`, `deal-address.js`, `gmail.js`,
`conversation.js`). `unsub.js` owns both minting and verifying the unsubscribe token —
they must agree or live links in already-sent email break (pinned in `tests/unsub.test.js`).

**The Deal Deck Address override lives on the STRUCTURE table** — `morby_deals`
(migration 012) and `cash_deals` (035) — and has never existed on `properties`.
`lib/deal-address.js` (`dealAddress(prop, structRow)`) is the only place that resolves it;
never read `prop.address_override`, which is permanently `undefined` and falls through to the
card name without erroring. That silence is why every Morby deck page, blast email, blast SMS
and emailed-PDF filename ignored the corrected address from migration 012 until Aug 2026 —
only the locally-generated PDF ever honored it. `tests/deal-address.test.js` fails if any
function under `netlify/functions/` reads the column off a properties row again.

⚠ The override is **coupled to reply capture**: blast subjects carry it, and
`capture-replies.js` looks a reply's property up by the street in the subject. It matches
`properties.name` first and then falls back to `address_override` on both structure tables —
without that fallback, correcting a deal's address silently stops capturing its replies.
`lib/deck-slug.js` deliberately does NOT consult the override: a slug is an opaque published
identifier, not a display string.

**Deals move between structures.** A Morby deal that ends up as a cash deal is moved with
"→ Move to Cash" on the card (`convertMorbyToCash`), which copies the columns that mean the
same thing on both tables (`MORBY_TO_CASH_FIELDS`) and **leaves `morby_deals` intact** — so
the move is lossless, undoable from the toast, reversible later via "↩ Back to Morby", and
the old seller carry stays available as a *suggested* Amount Forgiven. It is only ever
suggested: "carried $285k" and "forgave $285k" are different deals, and that number is the
deck's headline. `tests/structure-move.test.js` checks every copied field against the real
`cash_deals` column list, because an unknown column is a 400 on a live button. The move also
deletes the hosted `deal-decks/<slug>.pdf` (still the Morby deck) and warns that R3's
recipient ledger is keyed on `card_id`, so a normal re-blast skips buyers who already got
the Morby version — use "Choose specific buyers" for those.

**Contacts are NOT buyers, and that separation is the whole point.** The four non-buyer
lists (DSCR lenders, mortgage brokers, transactional lenders, VIP agents) live in their own
`contacts` table (migration 036, `contact_type` column), read only by
`public/js/contacts.js`. They are deliberately kept out of `buyers` because `matchesDeal`
passes anyone with no state/strategy/money cap as a **wildcard** — a lender filed among the
buyers would silently receive every blast, forever, with nothing in the UI saying so. Nothing
under `netlify/functions/` reads `contacts`: it is a directory (name, company, email, phone,
markets, notes) plus a manual touch log in `contact_activity`, with no matching and no
sending. If a send path ever needs it, give it its own recipient ledger and opt-out — never
route it through `buyers`. The page fails soft before 036 runs, naming the file to run.
Its CSV import shares the buyer engine but dedupes **within one `contact_type`**: a mortgage
broker who also does transactional lending is one person and two legitimate rows, so a
cross-type dedupe would silently drop the second. PDF import (`parse-contacts.js`) enters the
same flow one step earlier — the extracted rows are normalized through the *same*
`normalizeState` / `validEmail` helpers as CSV rows, so "Florida" becomes `FL` and a
hallucinated non-address becomes blank on both routes.

The nav's **Contacts** dropdown is inlined in each page's `<nav>` (same convention as the
rest of the top bar; `.nav-drop` in `app.css`). Buyers is the dropdown's first item *and* the
trigger's own href, so a tap on touch — where `:hover` never fires — still lands somewhere
useful.

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
migration runner. Take the next number (highest is `037_buyer_messages.sql`). Every new
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
`NOTIFY_EMAIL` (interest + sync-failure alerts), `DIRECT_EMAIL_FROM` (who a one-to-one
email from the buyer conversation panel is from — production: `Zach Kempe
<zach@seasidehorizon.com>`; defaults to the Gmail identity. **Blasts are the brand
(`RESEND_FROM`, deals@); personal emails are a person (zach@)** — a deliberate split. The
Gmail API only honors a From that is the mailbox or a verified "Send mail as" alias, so
this cannot be deals@ until deals@ exists as an alias of that account), `GOOGLE_MAPS_API_KEY`
(deck photo fallback),
`CAPTURE_WEBHOOK_SECRET` (GHL webhook), `CALENDLY_URL` (**optional** override for the
booking button on the deck-page interest receipt — `lib/interest-receipt.js` hardcodes
`DEFAULT_CALENDLY_URL` as the fallback, so the button renders whether or not this is set.
Relying on the env var alone silently stripped the button from live receipts once, because
Netlify only injects env vars into functions at deploy time).

### deals@seasidehorizon.com is a sender, not a mailbox (verified 2026-09-05)

`RESEND_FROM` is `Seaside Horizon <deals@seasidehorizon.com>`, but Resend only needs DNS for
that — nothing delivers mail *to* deals@ into any inbox we read (zach@'s Gmail has never
received a message addressed to it, and a Gmail "Send mail as" confirmation sent there never
arrived). Consequences, both handled in code: **every Resend send sets `reply_to:
GMAIL_REPLY_TO`** (blast-core + onboard-buyers; deck-interest already used `NOTIFY_EMAIL`), so
a buyer's reply lands in the inbox `capture-replies.js` polls and the conversation panel
reads — until that fix, replies to Resend-era blasts went nowhere; and the panel's personal
emails send as zach@, not deals@. `tests/conversation.test.js` pins the reply_to. If deals@
is ever made a real alias of zach@ in Google Workspace Admin, both constraints lift.

### Env vars are per-context — deploy previews cannot send email

Verified 2026-08-03 with `netlify env:list --context <ctx>`: **`RESEND_API_KEY` has a value
only in the `production` context — it is EMPTY in `deploy-preview`, `branch-deploy` and
`dev`.** Every Resend caller guards on it (`if (!RESEND_API_KEY || !RESEND_FROM …) return`)
and those guards return *before* any logging, so on a preview email simply doesn't happen and
nothing says so: `deck-interest.js` reports `receipt:false`, no 🔥 alert arrives, the function
log is clean. **Do not read that as a bug, and never try to verify email behavior on a deploy
preview** — DB writes, dedupe and lead capture all work there (previews share the production
Supabase), but email can only be observed in production. To check which provider production is
actually using, run a 🧪 test blast: the result reports `esp: "resend"` or `"gmail"`, and
`gmail` means Resend is silently falling back and receipts/alerts are dead.

Also currently unset in **every** context, despite being listed above: `NOTIFY_EMAIL` (so the
🔥 interest and sync-failure alerts fall back to `GMAIL_FROM_ADDRESS`, i.e.
zach@seasidehorizon.com — check that inbox, not the gmail.com one) and `DECK_TOKEN_SECRET`.
That one has a code fallback so nothing is broken, but ⚠ **never set `DECK_TOKEN_SECRET`
now** — `deck-token.js` currently falls through to `UNSUB_SECRET`, and changing the signing
secret invalidates every per-buyer deck token already sitting in a sent email.

### The public host is `deals.seasidehorizon.com` (since 2026-08-07)

`PUBLIC_SITE_URL=https://deals.seasidehorizon.com`, set in the **production context only**.
Every investor-facing URL derives from that one value (`SITE_URL` in `deck.js`,
`blast-core.js`, `deck-link.js`, `deck-interest.js`, `buy-box.js`, `onboard-buyers.js`,
`weekly-digest.js`, and `siteUrl()` in `lib/unsub.js`) — never hardcode a host beside them,
including for the email logo, or the logo loads from a different domain than the links next
to it and mail clients read the mismatch as a spam signal. Nothing stores an absolute deck
URL; links are composed at send time, so the constant is the whole truth and old rows can't
re-emit an old host.

**Every fallback is the custom domain too**, deliberately: the env var is one Netlify UI
edit away from being unset or typo'd, and the `||` arm ships silently on the next deploy
with nothing in the logs. `tests/site-url.test.js` fails if any fallback drifts, if the
netlify.app host reappears anywhere under `netlify/functions/`, or if one of the link
builders stops reading `SITE_URL`. Moving the domain again means changing the Netlify env
var **and** that test's `PUBLIC_HOST`. (That guard immediately caught `weekly-digest.js`
falling back to `""`, which had silently dropped the "Open full Reports" link out of every
digest email ever sent, since `PUBLIC_SITE_URL` was unset for that function's whole life.)

DNS is a CNAME at **GoDaddy** (`deals` → `seaside-dispo-app.netlify.app`); the apex and `www`
belong to a *different* Netlify site and must stay untouched. `deals.` is the primary domain
on the Netlify project, but the `netlify.app` host still serves 200 rather than redirecting —
so deck links in already-sent email keep working, and the Resend / GHL webhooks registered at
the old host are still fine. Supabase Auth allows both hosts (`/**`) with Site URL on `deals.`;
before that the allowlist was empty and Site URL was the stock `http://localhost:3000`, which
is where every forgot-password link had been going.

## Conventions

- Escape everything rendered into HTML (`escapeHtml` client-side, `esc` in `deck.js`).
- The Deal Deck PDF is set in **Hanken Grotesk** (`public/fonts/`, OFL), embedded into
  jsPDF by `loadDeckFontData`/`registerDeckFont` in `dashboard.js` and used via the single
  `deckFont` local — never re-add a literal `"helvetica"` there, or half the deck reverts.
  It's the sans in seasidehorizon.com's own stack (`"Soehne Buch","Hanken Grotesk",…`);
  the site's actual display face, Söhne, deliberately can't be used — it's served as Klim
  *test* cuts carrying 68 glyphs (no `$`, `%`, `(`, `)`, `—`), which a deck of dollar
  figures would render full of holes, and the test licence doesn't cover embedding. If a
  licensed Söhne OTF ever lands, swapping `DECK_FONT_FILES` is the whole change.
- Soft-delete + undo toast over hard deletes; deletes/archives are reversible.
- Build specs for larger features live in `docs/` and the repo root (`*-BUILD-SPEC.md`);
  `dispo-stage-tracker-BUILD-SPEC.md` records locked product decisions (six manual stages,
  no move history, no auto-movement) — don't re-litigate them.
