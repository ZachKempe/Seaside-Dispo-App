# Step 7 — Deck Page Test Plan Runbook (§11)

Copy-paste runbook for verifying the interactive deck page. You run these; Claude
stands by to fix any failure. **Nothing here sends a live blast** except where
explicitly noted (Part D, your choice).

Ordering note: there's no local `netlify dev` set up, so the DB parts (Part A)
run now, and the function tests (Parts C–E) run against the **deployed** site
after Step 8. This merges Step 7's function tests with §11's "prod smoke."

---

## Part A — Migration + schema (do now, no deploy) → acceptance #1

1. In the **Supabase SQL editor**, paste and run `sql/020_deck_pages.sql`.
2. Verify the objects exist:
   ```sql
   select column_name, data_type from information_schema.columns
     where table_name = 'properties' and column_name = 'deck_slug';
   select column_name, data_type from information_schema.columns
     where table_name = 'deck_views' order by ordinal_position;
   select policyname from pg_policies where tablename = 'deck_views';
   ```
   Expect: `deck_slug text`; the six `deck_views` columns; one policy
   `authenticated_full_access_deck_views`.
3. **Idempotency:** run `sql/020_deck_pages.sql` a second time. It must complete
   with no error and change nothing (acceptance #1). ✅

---

## Part B — Mint a test token (matches production)

The deck token secret resolves as: `DECK_TOKEN_SECRET` → `UNSUB_SECRET` →
`SUPABASE_SERVICE_ROLE_KEY` → `"seaside-deck"`. To make a token the **deployed**
function will accept, mint it with the **same** secret the site uses. In a shell,
supply that secret yourself (Claude never handles it):

```bash
# Use whichever your Netlify site actually has set (UNSUB_SECRET is typical).
DECK_TOKEN_SECRET='<your production secret value>' \
  node -e 'console.log(require("./netlify/functions/lib/deck-token").deckToken(<REAL_BUYER_ID>))'
```

Copy the printed `<id>.<hmac>` — that's your `?b=` value.
(If you skip the env var, the token uses the `"seaside-deck"` fallback and will
NOT verify against production — you'd get an anonymous render instead of a
greeted one. That's the #1 gotcha.)

---

## Part C — Render tests (after deploy) → acceptance #3, #5, #6, #7, #9

Pick a deal that has a `deck_slug` (set one manually, or let a blast mint it):
```sql
-- manual slug for testing without a blast:
update properties set deck_slug = 'test-deal-slug' where card_id = '<CARD_ID>';
```

Then, on the live site (`https://seaside-dispo-app.netlify.app`):

| # | URL | Expect |
|---|-----|--------|
| 3 | `/deck/test-deal-slug?b=<token from B>` | 200 page, greeted by first name, correct hero (Morby cash / Sub-To fee), terms, gallery. **One new `deck_views` row with the right `buyer_id`** (check: `select * from deck_views order by id desc limit 5;`) |
| 5 | `/deck/test-deal-slug` (no `?b=`) | Renders anonymously; tapping **I'm interested** opens the name/contact dialog |
| 6 | `/deck/test-deal-slug.pdf` and `/deck/test-deal-slug?format=pdf` | 302 → Storage PDF (old links unbroken) |
| 7 | Set `property_status.status='sold'` for the card, reload | Grey **Sold** badge, **no** Interested button |
| 9 | `/deck/does-not-exist` | Branded 404 ("no longer available"), not a stack trace |

---

## Part D — Interest tap (after deploy) → acceptance #4, #5

**Tokenized (attributed):**
```bash
curl -s -X POST https://seaside-dispo-app.netlify.app/.netlify/functions/deck-interest \
  -H 'Content-Type: application/json' \
  -d '{"slug":"test-deal-slug","token":"<token from B>"}'
# expect: {"ok":true,"attributed":true}
```
Verify one `deal_leads` row: `source='deck_page'`, `channel='deck'`,
`stage='interested'`, right `buyer_id`; and a `buyer_activity` touch.
Run the same curl again → **no duplicate**, and if the lead is already at
`offer`/`under_contract`/`closed` it must **not** downgrade (acceptance #4):
```sql
select id, stage, source, channel, notes from deal_leads
  where card_id = '<CARD_ID>' order by id desc limit 5;
```

**Anonymous (external lead):**
```bash
curl -s -X POST https://seaside-dispo-app.netlify.app/.netlify/functions/deck-interest \
  -H 'Content-Type: application/json' \
  -d '{"slug":"test-deal-slug","name":"Test Buyer","contact":"test@example.com"}'
# expect: {"ok":true,"attributed":false}  → deal_leads row with buyer_id null, deduped on card_id+contact
```

---

## Part E — Blast link + dashboard (after deploy) → acceptance #2, #8

- **#2 (per-recipient links):** send yourself a **test-mode** blast from the
  dashboard. Confirm the email CTA **"View deal & respond"** and the SMS both
  contain `…/deck/<slug>?b=…`. Note: test mode uses `?b=preview` (anonymous). To
  smoke-test the *tokenized* path end-to-end, add yourself as a buyer and do a
  **targeted live blast to just your own id** (this is the only step that sends a
  real message — your call).
- **#8 (dashboard):** after the taps above, open that deal in the posting
  dashboard. Expect the **"👁 N views · N interested"** line, a gold **deck**
  pill on deck-sourced leads, **"· viewed n×"** on the attributed buyer, and the
  deck-page interested lead sorted to the top. A fresh deal shows **"👁 0 views"**
  cleanly.

---

## Acceptance recap (§10)

Already verified offline by Claude: **#6, #9 (404), #10**.
This runbook covers the rest: **#1** (Part A), **#2** (E), **#3** (C), **#4** (D),
**#5** (C/D), **#7** (C), **#8** (E).

When every box is green, proceed to Step 8 (deploy) — but Step 8's live blast
still needs explicit go-ahead.
