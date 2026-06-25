// Scheduled function — runs every 10 minutes.
// Pulls "Under Contract" cards from Trello, parses copy variations / agent /
// Drive link / deal terms out of the card comments, and upserts everything
// into Supabase so the dashboard can read it instantly without hitting Trello.

const TRELLO_BASE = "https://api.trello.com/1";

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
]);

function extractState(address) {
  const parts = address.split(/[\s,]+/).reverse();
  for (const p of parts) {
    if (US_STATES.has(p.toUpperCase())) return p.toUpperCase();
  }
  return "";
}

function parseVariations(comments) {
  const variations = [];
  // oldest → newest
  for (const c of [...comments].reverse()) {
    const text = c?.data?.text || "";
    if (/VARIATION\s+\d/.test(text)) {
      const body = text.replace(/^\*\*---[^*]+---\*\*\s*\n+/, "").trim();
      if (body) variations.push(body);
    }
  }
  return variations.slice(0, 3);
}

// Pull the machine-readable deal-terms JSON block the local pipeline posts
// (a fenced ```json {...}``` comment under "DEAL TERMS"). Robust by design:
// we parse structured JSON, never the human marketing copy.
function parseDealTerms(comments) {
  for (const c of [...comments].reverse()) {
    const text = c?.data?.text || "";
    if (text.includes("DEAL TERMS")) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]); } catch (e) { /* keep looking */ }
      }
    }
  }
  return null;
}

const int0 = (v) => {
  const n = parseInt(String(v ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};

function parseMeta(comments) {
  for (const c of [...comments].reverse()) {
    const text = c?.data?.text || "";
    if (text.includes("LISTING AGENT")) {
      let drive = "";
      let agent = "";
      for (const line of text.split("\n")) {
        if (line.includes("drive.google.com")) {
          drive = line.replace(/\*\*[^*]+\*\*\s*/g, "").trim();
        }
        if (line.includes("LISTING AGENT")) {
          agent = line.replace(/\*\*/g, "").trim();
        }
      }
      return { agent, drive };
    }
  }
  return { agent: "", drive: "" };
}

async function trelloGet(path, params, key, token) {
  const url = new URL(`${TRELLO_BASE}${path}`);
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Trello ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supabaseGetExistingCardIds(sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1/properties?select=card_id`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
  });
  if (!r.ok) throw new Error(`Supabase select properties -> ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return new Set(rows.map(row => row.card_id));
}

// All non-archived SUB-TO properties currently in the DB, with their card_id —
// used to detect cards that moved off the watched Trello list since the last
// sync. Scoped to deal_type=subto so this diff can never touch Morby deals —
// those are created/deleted entirely independently of Trello (LOI upload +
// the manual 🗑 Remove button) and must never be auto-archived by this sync.
async function supabaseGetActiveCardIds(sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1/properties?select=card_id&archived=is.false&deal_type=eq.subto`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
  });
  if (!r.ok) throw new Error(`Supabase select active properties -> ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return rows.map(row => row.card_id);
}

async function supabaseSetArchived(sbUrl, sbKey, cardIds, archived) {
  if (!cardIds.length) return;
  const idList = cardIds.map(id => `"${id}"`).join(",");
  const r = await fetch(`${sbUrl}/rest/v1/properties?card_id=in.(${idList})`, {
    method: "PATCH",
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(archived
      ? { archived: true, archived_at: new Date().toISOString() }
      : { archived: false, archived_at: null }),
  });
  if (!r.ok) throw new Error(`Supabase set archived(${archived}) -> ${r.status}: ${await r.text()}`);
}

async function supabaseGetExistingDealTermIds(sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1/deal_terms?select=card_id`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
  });
  if (!r.ok) throw new Error(`Supabase select deal_terms -> ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return new Set(rows.map(row => row.card_id));
}

async function supabaseUpsert(table, rows, conflictCol, sbUrl, sbKey) {
  if (!rows.length) return;
  const r = await fetch(`${sbUrl}/rest/v1/${table}?on_conflict=${conflictCol}`, {
    method: "POST",
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase upsert ${table} -> ${r.status}: ${await r.text()}`);
}

exports.handler = async () => {
  const TRELLO_KEY   = process.env.TRELLO_API_KEY;
  const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
  const BOARD_ID     = process.env.TRELLO_BOARD_ID;
  const LIST_NAME    = process.env.TRELLO_LIST_NAME || "Under Contract";
  const SB_URL       = process.env.SUPABASE_URL;
  const SB_KEY       = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const lists = await trelloGet(`/boards/${BOARD_ID}/lists`, {}, TRELLO_KEY, TRELLO_TOKEN);
    const list = lists.find(l => l.name.toLowerCase() === LIST_NAME.toLowerCase());
    if (!list) throw new Error(`List '${LIST_NAME}' not found on board`);

    const cards = await trelloGet(`/lists/${list.id}/cards`, {}, TRELLO_KEY, TRELLO_TOKEN);

    // Marketing copy is generated from Trello ONLY at deal-creation time.
    // Once a deal exists in the dashboard, the dashboard/DB copy is the
    // source of truth — edits happen there, and we must never clobber them
    // by re-pulling `variations` from Trello on later syncs. So: know which
    // card_ids already exist, and only set `variations` for brand-new ones.
    const existingCardIds = await supabaseGetExistingCardIds(SB_URL, SB_KEY);

    // Deal terms drive buyer matching + blasts. We seed them automatically from
    // the pipeline's DEAL TERMS comment, but ONLY for cards that don't already
    // have a deal_terms row — so a manual dashboard edit is never overwritten,
    // and a card synced before the pipeline posted terms still gets them later.
    const existingDealTermIds = await supabaseGetExistingDealTermIds(SB_URL, SB_KEY);

    // Kept as two separate batches (rather than one mixed array) because
    // PostgREST's bulk upsert derives its column list from the request body —
    // mixing rows that do/don't include `variations` risks either an error
    // or, worse, silently nulling out existing copy. Two clean batches avoid
    // that entirely.
    const newRows = [];
    const existingRows = [];
    const dealTermRows = [];
    let newCount = 0;

    for (const card of cards) {
      const comments = await trelloGet(`/cards/${card.id}/actions`, { filter: "commentCard" }, TRELLO_KEY, TRELLO_TOKEN);
      const meta = parseMeta(comments);
      const state = extractState(card.name);
      const isNew = !existingCardIds.has(card.id);
      if (isNew) newCount++;

      const row = {
        card_id: card.id,
        name: card.name,
        trello_url: `https://trello.com/c/${card.id}`,
        state,
        agent: meta.agent,
        drive_link: meta.drive,
        raw_comments: comments.slice(0, 20).map(c => ({ text: c?.data?.text || "", date: c?.date })),
        synced_at: new Date().toISOString(),
      };

      // Only generate/seed copy on initial creation. Existing deals keep
      // whatever copy lives in the DB (dashboard edits are authoritative) —
      // so `variations` is simply absent from their row and PostgREST leaves
      // the existing column value untouched on conflict.
      if (isNew) {
        const variations = parseVariations(comments);
        row.variations = variations.map(v => ({ body: v }));
        newRows.push(row);
      } else {
        existingRows.push(row);
      }

      // Seed deal terms if the pipeline posted them and we don't have a row yet.
      if (!existingDealTermIds.has(card.id)) {
        const dt = parseDealTerms(comments);
        if (dt) {
          dealTermRows.push({
            card_id: card.id,
            entry_fee: int0(dt.entry_fee),
            price: int0(dt.price),
            mortgage: int0(dt.mortgage),
            rate: String(dt.rate ?? ""),
            piti: int0(dt.piti),
            beds: int0(dt.beds),
            baths: String(dt.baths ?? ""),
            sqft: int0(dt.sqft),
            year_built: int0(dt.year_built),
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    await supabaseUpsert("properties", newRows, "card_id", SB_URL, SB_KEY);
    await supabaseUpsert("properties", existingRows, "card_id", SB_URL, SB_KEY);
    await supabaseUpsert("deal_terms", dealTermRows, "card_id", SB_URL, SB_KEY);

    // Anything previously active that ISN'T on the watched list anymore was
    // moved off it (or archived/deleted in Trello) — flag it so the dashboard
    // stops showing it. Anything that came back (bounced back onto the list)
    // gets un-flagged. This is the diff sync-trello never used to do.
    const currentCardIds = new Set(cards.map(c => c.id));
    const activeCardIds = await supabaseGetActiveCardIds(SB_URL, SB_KEY);
    const toArchive = activeCardIds.filter(id => !currentCardIds.has(id));
    const toUnarchive = [...currentCardIds].filter(id => existingCardIds.has(id) && !activeCardIds.includes(id));

    await supabaseSetArchived(SB_URL, SB_KEY, toArchive, true);
    await supabaseSetArchived(SB_URL, SB_KEY, toUnarchive, false);

    const total = newRows.length + existingRows.length;
    console.log(`sync-trello: synced ${total} card(s), ${newCount} new, ${dealTermRows.length} deal-term row(s) seeded, ${toArchive.length} archived (moved off list), ${toUnarchive.length} restored`);
    return { statusCode: 200, body: `synced ${total} cards (${newCount} new, ${toArchive.length} archived, ${dealTermRows.length} terms seeded)` };
  } catch (err) {
    console.error("sync-trello error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
