# Implementation Queue — Claude Code Task Prompts

Companion to the August 2026 audit. Each task below is a **copy-paste prompt** for Claude Code,
scoped to one branch and one PR. Work them top to bottom. Do not batch them.

**Status as of 2026-08-01:** commit `6c4306e` shipped the original Block 0 (SMS STOP handling,
bounce suppression, `int0` decimals). Those are verified correct. T0 closes the gaps that
commit left behind.

Block 4 then shipped (branch `block4-list-quality`), which covers **T6** in full plus four
findings that were parked below: the onboarding follow-up sequence with an SMS touch (H12),
manual-add dedupe (H13), tolerance bands / near-miss surfacing (M8), and the complaint
penalty in engagement scoring (M7). **M6 (best-variation default in the blast modal) was
deliberately dropped** — don't rebuild it without asking. T7/T8 (deck returns + plain-English
explainer) were removed from this queue: that work was cut and is not planned.

Everything else from T1 down is still open work.

---

## How to run this

### The loop, per task

```
git checkout main && git pull
git checkout -b <branch-from-the-task>
claude          # paste the task prompt
# review the diff yourself — actually read it
npm test && for f in public/js/*.js netlify/functions/*.js netlify/functions/lib/*.js; do node --check "$f"; done
git push -u origin <branch>
gh pr create --fill
# Netlify builds a deploy preview — verify there, on a phone, before merging
gh pr merge --squash
```

Never push straight to `main`. Push-to-main deploys to production and CI is the only gate.

### Five rules that make Claude Code good on this repo

1. **Point it at `CLAUDE.md` first.** Every prompt below starts with it. That file is why Claude
   Code performs well here — it encodes the invariants (shared logic in `deal-shared.js`, manual
   SQL migrations, test-mode before live sends). Keep it current; it is the highest-leverage file
   in the repo.
2. **Give acceptance criteria, not implementation.** Say "opted-out buyers must be excluded from
   every future SMS send," not "add a filter on line 698." It will find a better seam than you
   specified, and you will catch it in review if it doesn't.
3. **Demand verification in the prompt.** Every task below ends with explicit commands to run.
   Claude Code will run them. If you leave it out, it often won't.
4. **Make it state what it did NOT change.** This catches scope creep before you read the diff.
5. **Use plan mode for anything touching the send path.** Type `/plan` or ask for a plan first on
   T9, T10, T13. Review the plan, then let it execute. Sends reach real investors and are not
   undoable.

### Things Claude Code cannot do here — you must do them

- **Run SQL migrations.** There is no migration runner. Claude Code writes `sql/0XX_*.sql`; you
  paste it into the Supabase SQL editor yourself. Every migration must end with the
  `insert into schema_migrations` line, and the frontend must fail soft if it hasn't run yet
  (see `blast-core.js:530` for the pattern — `!b.email_bounced_at` is a no-op on an undefined
  column, which is exactly right).
- **Set Netlify env vars.** Tasks that need one will say so.
- **Send a live blast.** Test mode (🧪) only, ever. If a task's verification needs a real send,
  do it yourself to seed buyer 248.

### Add these to CLAUDE.md before you start

Commit `6c4306e` created three new invariants that aren't written down yet. Undocumented
invariants drift — that is literally the lesson in your own `lib/subjects.js` comment.

```
- Every outbound SMS body must carry opt-out language. Build SMS text only via
  `buildSubtoSms` / `buildMorbySms` in blast-core.js — never call `buildDealCopyText`
  directly for SMS; it is shared with the email body, where "Reply STOP" makes no sense.
- SMS consent is `buyers.sms_opt_in`. An inbound STOP flips it false (`ghl-inbound.js`),
  and every SMS audience filter requires it. Never send SMS without checking it.
- Hard bounces set `buyers.email_bounced_at` (migration 031). The email audience gate is
  `email && !email_opt_out && !email_bounced_at` — the dashboard preview and the send path
  must apply the identical three conditions or the preview lies.
```

---

# T0 — Test the fixes you just shipped

**Branch:** `t0-block0-tests`
**Why:** commit `6c4306e` added three correctness fixes and zero tests. CI is green but guards
none of them. `int0` and `OPT_OUT_RE` are pure functions — the cheapest tests you will ever write.
Also closes one real hole found in review.

```
Read CLAUDE.md first.

Commit 6c4306e added three fixes with no test coverage. Add it, and close one gap.

1. Extract the `int0` money parser out of netlify/functions/parse-subto.js into a shared
   helper (netlify/functions/lib/ — pick the right home) and require it from parse-subto.
   Add tests covering: "$1,543.21" -> 1543, "1234.56" -> 1235, "1,200" -> 1200,
   "" -> 0, null -> 0, "abc" -> 0, and a multi-dot string like "1.543.21" (assert whatever
   the correct fail-safe behavior is and document the choice in a comment).

2. Extract OPT_OUT_RE from netlify/functions/ghl-inbound.js somewhere testable and add tests:
   "STOP", "stop", " Stop. ", "UNSUBSCRIBE", "cancel", "opt out" must all match;
   "stop sending these", "please stop texting me", "don't stop" must NOT match
   (the whole-message anchor is deliberate — do not loosen it).

3. Fix a real gap: ghl-inbound's handleOptOut calls findBuyer("", phone) and, when no buyer
   matches, silently no-ops with optedOut:false. An unknown or format-mismatched number that
   texts STOP therefore gets no suppression record anywhere. Make an unmatched opt-out still
   durably recorded so it can never be texted later. Choose the approach — a suppression table
   with a normalized phone, or another mechanism you can justify — and if it needs a schema
   change, write sql/032_*.sql following the CLAUDE.md migration rules (additive, idempotent,
   ends with the schema_migrations insert). Do NOT run it; I run migrations myself.
   Whatever you choose, the SMS send path must consult it.

Do not change any send behavior beyond that suppression check.

Verify: npm test (all pass, new tests included);
node --check on every file you touched.
Then tell me exactly which files you changed and which you deliberately did not.
```

---

# T1 — Deck interest creates a buyer  ⭐ highest business value

**Branch:** `t1-deck-creates-buyer`
**Why:** finding C1. Untokenized interest writes only to `deal_leads`. A brand-new investor who
gets a forwarded deck link, reads the deal, and raises their hand never enters your buyer list.
Forwarded links are how wholesaling lists grow; this is the leak.

```
Read CLAUDE.md first, then netlify/functions/deck-interest.js and
netlify/functions/lib/capture.js.

Problem: when someone taps "I'm interested" on a deck page WITHOUT a ?b= token (a forwarded
link — a brand-new investor), we write a deal_leads row with buyer_id null and stop. They
never become a buyer, never get onboarded, never receive another deal.

Change it so untokenized interest also creates or matches a buyers row:
- Reuse the existing dedupe logic in lib/capture.js (findBuyer + normalized phone/email).
  Do NOT write a second dedupe implementation — that class of drift is called out in CLAUDE.md.
- The submitted "contact" field is free text that may be a phone OR an email. Parse it and
  populate the right column. If it's neither, still create the lead but do not create a
  half-broken buyer row.
- list_source: 'deck_page'. sms_opt_in must be false (we have no SMS consent from a deck tap).
  onboarded_at stays null so the buy-box ask picks them up.
- Link the new buyer_id onto the deal_leads row so the lead and buyer are connected.
- An existing buyer arriving untokenized (they forwarded their own link, or typed a contact
  we already have) must MATCH, not duplicate.
- Everything must fail soft: if buyer creation fails for any reason, the lead must still be
  recorded and the investor must still see success. Never lose the lead.

Add tests for the contact-parsing logic (phone vs email vs garbage) as a pure function.

Verify: npm test; node --check on files touched.
Then explain in plain English what now happens for each of these four cases:
(a) tokenized known buyer, (b) untokenized brand-new person,
(c) untokenized person whose email already exists in buyers,
(d) untokenized person who typed nonsense in the contact field.
```

---

# T2 — Instant receipt to the investor

**Branch:** `t2-interest-receipt`
**Why:** finding H4. Today `deck-interest.js` emails *you* and sends the investor nothing. Highest
return per hour in the whole audit — you already have Resend wired and their contact in hand at
that exact moment.

```
Read CLAUDE.md, then netlify/functions/deck-interest.js and
netlify/functions/lib/blast-core.js (for the existing Resend + Gmail-fallback senders and the
CAN-SPAM footer helpers — reuse them, do not write a third sender).

Today when someone taps "I'm interested" we notify NOTIFY_EMAIL and send the investor nothing.
They wait, cold, with nothing in their inbox, until someone calls.

Add an immediate confirmation to the investor when we have an email address for them:
- Subject and body confirming which property, in the same visual language as the existing
  blast emails (reuse the template helpers — do not fork the HTML).
- Include: the deck page link, the PDF link IF one exists for this deal (see T4 — do not link
  a PDF that isn't there), and MARKETING_CONTACT_PHONE.
- Include the standard unsubscribe footer and List-Unsubscribe headers, same as every other
  outbound email.
- If we only have a phone, do nothing for now — do NOT send an SMS. SMS requires sms_opt_in
  and a deck tap is not consent. Leave a comment saying so.
- Fully fail-soft: a send failure must never break the interest capture or the response to
  the page. The investor's tap must always succeed.

Add a test-mode escape hatch consistent with how the rest of the codebase does test sends.

Verify: npm test; node --check.
Send yourself a test confirmation and paste me the rendered result before I merge.
```

---

# T3 — Open Graph tags on the deck page

**Branch:** `t3-deck-og-tags`
**Why:** finding H5. Deck links are built to be forwarded and currently render as bare URLs in
iMessage, WhatsApp and Slack. One hour protecting your primary distribution channel.

```
Read CLAUDE.md, then netlify/functions/deck.js — specifically the page() helper around line 57.

The deck page head has charset, viewport, title and fonts. No Open Graph, no Twitter card,
no meta description, no favicon. Every forwarded deck link renders as a naked URL with no
photo, no address, no price.

Add to page():
- og:title (street address), og:description (the hero money line — entry fee for Sub-To,
  cash-at-close for Morby — plus beds/baths if available), og:image (the resolved hero photo,
  which page() will need passed in), og:url, og:type=website, og:site_name.
- twitter:card=summary_large_image and the matching twitter tags.
- meta name="description" mirroring og:description.
- A favicon pointing at the existing logo.

Constraints:
- og:image must be an absolute URL. If a deal has no photo, fall back to the auto Street View
  image already resolved by lib/deck-photo.js rather than emitting no image at all.
- Escape everything through the existing esc() — these values include user/AI-derived text.
- The 404 and error pages also call page(); they must not break or leak a null image.

Verify: node --check.
Then paste me the exact <head> output for one Sub-To deal and one Morby deal.
```

---

# T4 — Stop showing a broken PDF button

**Branch:** `t4-pdf-button-honesty`
**Why:** finding H3. `deck.js:311` always renders a PDF button, but PDF generation is Morby-only.
Every Sub-To deck sends investors to a raw Supabase storage error at peak interest.

```
Read CLAUDE.md, then netlify/functions/deck.js (the pdfBtn around line 311) and
netlify/functions/lib/blast-core.js around line 568 where the deck PDF is uploaded.

The deck page always renders a "PDF" button linking to /deck/<slug>.pdf, which 302s to
Supabase Storage. But the deal-deck PDF is only ever generated and uploaded for Morby deals.
On every Sub-To deck, an investor taps PDF and lands on a storage error.

Fix it in two parts:
1. Only render the PDF button when the object actually exists. Check Storage for
   deal-decks/<slug>.pdf as part of the existing Promise.all data load so it costs no extra
   round trip, and fail soft to "no button" if the check errors.
2. The .pdf route itself must return a proper branded 404 page (use the existing page()
   helper) instead of 302-ing to a URL that will error.

Do not change PDF generation. That's a separate, larger task.

Verify: node --check. Confirm a Morby deal still shows the button and a Sub-To deal now
doesn't, and tell me how you tested it.
```

---

# T5 — Bulk-load buy boxes you already know

**Branch:** `t5-buybox-bulk-load`
**Why:** you said you already know most buy boxes. Today there is **no way to get that into the
system**: the CSV importer maps only name/phone/email/company/states and hardcodes
`max_price: 0, max_piti: 0, min_beds: 0` (`buyers.js:775`), and there is no bulk edit anywhere.
Backfilling 100 buyers means 100 modal cycles.

```
Read CLAUDE.md, then public/js/buyers.js — the CSV import engine (HEADER_SYNONYMS around
line 587, the row builder around 660, and the insert around 775).

Two gaps stop me loading buy-box data I already have:

1. The CSV importer cannot import a buy box. HEADER_SYNONYMS has no entry for max price,
   max PITI, min beds, or a per-row strategy, and line 775 hardcodes all three money fields
   to 0. Add them:
   - max_price, max_piti, min_beds, strategy, asset_type, close_speed (columns 024 added).
   - Realistic header synonyms — think how these come out of a spreadsheet someone typed
     by hand: "max price", "budget", "max purchase", "max piti", "max payment",
     "min beds", "bedrooms", "strategy", "buy box strategy".
   - Money columns must survive "$350,000" and "350k". Reuse the shared money parser from T0
     rather than writing a fourth one.
   - Per-row strategy must override the batch dropdown when the column is present.
   - The import preview must show the new columns so I can see what will land before committing.

2. There is no bulk edit. Add multi-select to the buyer list with a bulk-apply action for
   states, strategy, tier, and the three money fields. Apply only the fields I actually filled
   in — a blank field in the bulk form must leave that column untouched, never zero it.
   Follow the existing soft-delete/undo convention: show what changed and let me undo.

Do not change matchesDeal or anything in deal-shared.js.

Verify: npm test; node --check on public/js/*.js.
Build me a 5-row sample CSV exercising every new column and tell me exactly what the preview
shows for it.
```

---

# T6 — Buy-box completeness, visible

**Branch:** `t6-buybox-completeness`
**Why:** finding C2's visibility half. You cannot manage what you cannot see, and right now
nothing anywhere tells you what share of your list is a wildcard that matches every deal.

```
Read CLAUDE.md, then public/js/deal-shared.js (matchesDeal), public/js/buyers.js, and
public/js/dashboard.js.

matchesDeal treats every blank buyer field as a wildcard: blank states matches every state,
max_price 0 matches every price. So a buyer with no buy box receives every deal we send.
Nothing in the app tells me how many of those I have.

Add, without changing matchesDeal's behavior:
1. A shared classifier in deal-shared.js — buyBoxCompleteness(buyer) returning something like
   'full' | 'partial' | 'wildcard'. Wildcard = no states AND no strategy (or 'all') AND no
   money constraint, i.e. this buyer matches literally everything. Export it via the existing
   UMD pattern. Add tests.
2. A KPI on the buyers page header: "N buyers · M full buy box · K wildcard" with the wildcard
   count clickable to filter the list down to exactly those buyers.
3. In the blast modal on the dashboard, break the matched audience into
   "X matched on their stated box · Y wildcard (no box on file)" so I can see, at the moment
   of sending, how much of the audience is real matching versus blanks passing through.
   Do not change who gets sent to — just show me the split.

Verify: npm test with the new tests; node --check.
Then tell me what the blast modal will now say for an audience of 300 where 180 are wildcards.
```

---

# T9 — Lock the blast  ⚠️ use plan mode

**Branch:** `t9-blast-lock`
**Why:** finding H7. `runBlast` takes no lock. A double-click or two open tabs sends your entire
list the same deal twice.

```
/plan first — do not write code until I approve the plan.

Read CLAUDE.md, then netlify/functions/lib/blast-core.js (runBlast, ~line 470 onward) and
netlify/functions/send-blast-background.js.

runBlast takes no lock keyed on card_id. Two concurrent invocations — a double-click, a client
retry, two tabs — both read the "already sent" set before either flushes, both compute the
same full audience, and both send to everyone. The existing idempotency comments only cover
crash recovery, not concurrency.

Requirement: it must be impossible for two concurrent live blasts of the same card_id to both
send. Design it yourself — a unique lock row, a Postgres advisory lock, whatever you can
defend — and cover in the plan:
- What happens when a lock is held: the second caller must fail loudly with a clear message
  the dashboard can show, not silently no-op.
- Stale lock recovery. A function that dies holding the lock must not block that deal forever.
- Test mode must NOT take the lock (it's small, synchronous, and I run it repeatedly).
- Any schema change goes in sql/0XX_*.sql per CLAUDE.md rules. I run it, not you.

This is the live send path reaching real investors. Smallest change that provably works.

After I approve: implement, then npm test, node --check, and tell me exactly how you'd
verify the race is closed without doing a live send.
```

---

# T10 — Flush the ledger per recipient  ⚠️ use plan mode

**Branch:** `t10-ledger-flush`
**Why:** finding H8. Email flushes every 25, SMS every 10. A crash mid-batch means successful
sends were never recorded — so a later full blast re-sends to them, and `retry_failed` never
picks up the ones that actually failed.

```
/plan first.

Read CLAUDE.md, then netlify/functions/lib/blast-core.js — the email chunk loop around
line 654-669 and the SMS loop around 712.

Emails send 25-concurrent and flush the blast_recipients ledger only after each chunk
resolves; SMS flushes every 10. If the function dies mid-chunk — 15-minute budget, OOM,
deploy rotation — sends that already succeeded were never written to the ledger. Two bad
consequences: a later full blast re-sends to them, and a retry_failed run never picks up the
ones that genuinely failed. Both are silent. Worse, a crash before the final flush means no
deal_blasts row and no heartbeat at all, so the dashboard shows a blast that never happened
while hundreds of messages are already out.

Make the ledger write durable per recipient rather than per batch. Cover in the plan:
- The write ordering that actually closes the window, and which direction you fail in if the
  ledger write itself fails after a successful send (I'd rather double-send than silently drop
  — argue with me if you disagree).
- The cost: extra round trips. Quantify it for a 600-recipient blast. SMS is already serial so
  it should be free there.
- Whether deal_blasts / heartbeat logging should move earlier so a crashed run is still visible.

Do not change who gets sent to, the audience filters, or the retry semantics.

After approval: npm test, node --check, and walk me through what now happens if the function
dies at recipient 300 of 600.
```

---

# T11 — Stop the dashboard failing silently

**Branch:** `t11-loadall-errors`
**Why:** finding H10. `loadAll()` fires 13 queries and checks `error` on one. A failed buyers
fetch looks identical to "you have no buyers" — right before you open the blast modal.

```
Read CLAUDE.md, then public/js/dashboard.js — loadAll() around line 398-448.

loadAll() runs 13 parallel Supabase queries and only checks error on properties. If the buyers
query fails transiently, allBuyers silently becomes empty: every deal shows 0 matched buyers,
the blast modal shows an empty audience, Call Today goes blank — and none of it looks like an
error. The dangerous version is me seeing a smaller audience than expected, shrugging, and
sending to a fraction of my list.

Fix:
- Check error on every query.
- Show one persistent, dismissible banner naming which data failed to load.
- Anything that gates a send must hard-block rather than silently proceed: if the buyers query
  failed, the Send Blast button must be disabled with an explanatory tooltip, not enabled over
  an empty audience.
- Keep the existing fail-soft-on-missing-migration behavior (the archived / email_bounced_at
  fallbacks). A missing COLUMN is expected and must stay silent; a failed QUERY must not.
  Make sure you can tell those two apart.

While you're in here: the facebook_posts insert around line 1533-1544 ignores its error and
resets the UI as if it succeeded. The delete handler right below it does it correctly. Fix it
to match.

Verify: node --check on public/js/*.js.
Tell me how to trigger the banner locally so I can see it before merging.
```

---

# T12 — Finish the fetchAll sweep

**Branch:** `t12-fetchall-sweep`
**Why:** findings M3 and M4. You already found and fixed PostgREST's silent 1,000-row truncation.
It just wasn't applied everywhere.

```
Read CLAUDE.md, then netlify/functions/lib/fetch-all.js and public/js/supa.js (fetchAllRows).

The 1,000-row PostgREST cap was fixed with fetchAll/fetchAllRows but three places still
truncate silently:
- public/js/pipeline.js around lines 30-36: plain .in(...) queries on deal_notes, deal_leads,
  deal_blasts, blast_recipients, deal_terms, deal_tasks.
- public/js/reports.js around lines 35-38: hardcoded .limit(8000) on blast_recipients,
  email_events and deck_views — tables that grow forever.
- netlify/functions/onboard-buyers.js around line 157: the target /buyers query is a single
  unpaged GET, so past 1,000 never-onboarded buyers everyone after row 1,000 is skipped.

Sweep all three using the existing helpers. Do not write a new pager.

Then grep the whole repo for any remaining whole-table or fixed-limit fetch of a table that
grows without bound, and either fix it or tell me why it's safe. I want the list either way.

Verify: npm test; node --check on everything you touched.
```

---

# T13 — Human sign-off before AI numbers reach investors  ⚠️ use plan mode

**Branch:** `t13-terms-verified-gate`
**Why:** finding H9. AI-extracted terms flow to `deal_terms` with an allowlist and no sanity
bounds. The only thing between a bad extraction and your whole buyer list is you noticing.
`findCopyMismatches` is client-side only.

```
/plan first.

Read CLAUDE.md, then netlify/functions/parse-loi.js, parse-subto.js, generate-copy.js,
lib/blast-core.js (runBlast), and the findCopyMismatches logic in public/js/dashboard.js.

AI-extracted deal terms are written straight to deal_terms / morby_deals with only a column
allowlist — no numeric sanity bounds, no cross-field checks. The copy/terms mismatch check
exists only in the browser. Nothing server-side requires that a human ever looked at the
numbers before a card can blast to hundreds of investors.

Build a verification gate:
- terms_verified_at / verified_by on the deal, set only by an explicit human confirm action
  in the dashboard that shows the extracted numbers next to the source document.
- runBlast refuses any non-test send when it's unset, with a message the dashboard can display.
  Test mode stays unblocked.
- Editing any money field after verification clears the flag. Re-verify required.
- Add server-side sanity bounds at extraction time and surface violations in the confirm UI
  rather than silently correcting: PITI plausible against price, entry fee against price,
  year_built in range, and whatever else you can justify. Propose the bounds in the plan.

Schema change goes in sql/0XX_*.sql. I run it.

In the plan, tell me how many extra clicks this adds to my new-deal flow. If it's more than
one, redesign it.

After approval: npm test, node --check.
```

---

## Recommended order

**Now:** T0 → T1 → T2 → T3 → T4. About a week. Closes the investor loop and the test gap.

**Then, your call:** T5 if the wildcard query says your list still has a data problem.

**Then:** T9 → T10 → T11 → T12 → T13. Correctness work. Gets more valuable and more expensive
the longer you wait, but nothing here is on fire.

**Not in this queue** — from the audit, deliberately deferred: dashboard.js decomposition (M17),
mobile nav breakpoint (M18), full-reload-on-edit (M5), best-variation default (M6), tolerance
bands (M8), the `/deals` index and `/me` portal. Do those after the above. The portal is worth
far more once the loop above actually closes.

## The one thing to check before starting T5 or T6

```sql
select count(*) filter (where coalesce(states,'') = ''
                    and coalesce(max_price,0) = 0
                    and coalesce(max_piti,0)  = 0) as wildcard,
       count(*) as total_active
from buyers where active is true;
```

Under 15% wildcard: do T5 casually. Over 40%: T5 jumps the queue — and the dashboard now
reports this same number on every page load (see the status note at the top), so the query
is really only for a one-off sanity check against the app.
