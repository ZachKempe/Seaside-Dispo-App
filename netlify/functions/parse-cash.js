// "+ Add Cash Deal" upload for the dashboard — the intake for the THIRD deal
// structure. Sends the purchase contract (plus an optional second document:
// a seller concession addendum, payoff letter, or the original listing) to
// Claude, extracts the cash deal terms, and creates a brand-new standalone
// deal card: a `properties` row (card_id "cash-…") plus a `cash_deals` row.
//
// Shaped after parse-subto.js rather than parse-loi.js: same two-file upload,
// same PDF-or-image handling, same eager slug mint. The one thing it does that
// neither of those does is reconcile the price stack — see below.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const { ensureDeckSlug } = require("./lib/deck-slug");
const { cashPriceStack } = require("../../public/js/deal-shared");

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// Same media rules as parse-subto: PDFs go in a "document" block, phone
// photos / screenshots go in an "image" block. Notably NOT image/heic.
const ALLOWED_MEDIA = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);

function fileBlock(file, label) {
  if (!file || !file.data) throw new Error(`${label} file is missing`);
  const mt = file.media_type;
  if (!ALLOWED_MEDIA.has(mt)) throw new Error(`${label} must be a PDF or JPG/PNG/GIF/WebP image (got ${mt || "unknown type"})`);
  const source = { type: "base64", media_type: mt, data: file.data };
  return mt === "application/pdf" ? { type: "document", source } : { type: "image", source };
}

const EXTRACTION_PROMPT = `You are reading the documents for a CASH (wholesale) real estate deal: a purchase contract, and possibly a second document such as a seller concession addendum, a payoff/short-payoff letter, or the original listing.

In this deal structure the seller FORGIVES part of what they were originally asking or owed, and the buyer purchases with cash at the reduced number. There is NO subject-to takeover of an existing loan and NO seller carryback financing — if the documents describe seller financing, a carryback balance, deferred interest or a balloon, say so in "property_description" but do NOT invent price-stack numbers from it.

Extract the following and return ONLY a valid JSON object — no explanation, no markdown, just the JSON. Use null for anything not stated in the documents. Numbers must be plain JSON numbers (no $ signs or commas).

{
  "property_name": "the property's full street address including city/state/zip as shown, e.g. \\"3014 N Tampa St, Tampa, FL 33603\\"" or null,
  "state": "two-letter state code the property is in, e.g. \\"FL\\"" or null,
  "property_type": "single_family" or "commercial" — infer from the property description; default to "single_family" if unclear,

  "original_price": number or null — the ORIGINAL price: what the seller was asking, had it listed at, or owed BEFORE the concession,
  "amount_forgiven": number or null — the amount the seller is forgiving / conceding / discounting off that original number,
  "purchase_price": number or null — the FINAL contract purchase price the buyer actually pays,

  "down_payment": number or null — a down payment stated in the contract (null if the buyer is paying all cash with no separate down payment line),
  "earnest_money_amount": number or null — the earnest money deposit,
  "closing_costs_note": short string describing who pays closing costs, e.g. "Buyer pays all closing costs",
  "broker_commission": short string describing any broker/agent commission terms, or "None",

  "inspection_period_days": integer or null — due diligence / inspection period in days,
  "close_of_escrow_days": integer or null — days to close,
  "financing_contingency": true or false — whether the offer is contingent on buyer financing,

  "tenancy_description": short string describing current tenancy/occupancy if mentioned, else null,
  "property_description": short string summarizing the property and any unusual terms, else null,

  "ltr_monthly_rent": number or null — long-term rent estimate (single family only),
  "str_monthly_rent": number or null — short-term rental income estimate (single family only),
  "annual_noi": number or null — annual net operating income (commercial only),
  "monthly_noi": number or null — monthly net operating income (commercial only)
}

Only report a number you can actually find. Do not compute "amount_forgiven" yourself by subtracting two prices — leave it null if the documents never state a concession, and the app will derive it.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }) };
    }

    // `concession` is optional: plenty of these deals put the whole price stack
    // in the contract itself, and requiring a second file would block intake.
    const { contract, concession } = JSON.parse(event.body || "{}");
    if (!contract || !contract.data) return { statusCode: 400, body: JSON.stringify({ error: "contract file required" }) };

    const content = [
      { type: "text", text: "Document 1 — the purchase contract:" },
      fileBlock(contract, "Contract"),
    ];
    if (concession && concession.data) {
      content.push({ type: "text", text: "Document 2 — the seller concession addendum / payoff letter / original listing:" });
      content.push(fileBlock(concession, "Concession document"));
    }
    content.push({ type: "text", text: EXTRACTION_PROMPT });

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        messages: [{ role: "user", content }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Claude extraction failed: ${aiRes.status} ${errText}`);
    }

    const aiData = await aiRes.json();
    let raw = ((aiData.content || []).find(b => b.type === "text") || {}).text || "";
    raw = raw.trim();
    if (raw.startsWith("```")) {
      const lines = raw.split("\n");
      raw = lines.slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined).join("\n");
    }

    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Couldn't parse Claude's response as JSON: ${e.message}`);
    }

    // Brand-new standalone cash card ("cash-" prefix, matching the
    // "subto-"/"morby-" convention gallery.js and the deck slug already rely on).
    const card_id = `cash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const propRow = {
      card_id,
      name: extracted.property_name || "New Cash Deal",
      state: extracted.state || "",
      trello_url: "",
      deal_type: "cash",
      synced_at: new Date().toISOString(),
    };
    const savedProp = await sb(`/properties?on_conflict=card_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(propRow),
    });
    const property = (savedProp && savedProp[0]) || propRow;

    // Eagerly mint the deck-page slug so the buyer-facing link exists the
    // moment the card does. Non-fatal: blast-core still backfills lazily.
    try { await ensureDeckSlug(sb, property); } catch (e) { console.error("deck slug:", e.message); }

    const ALLOWED_FIELDS = [
      "property_type", "original_price", "amount_forgiven", "purchase_price",
      "down_payment", "earnest_money_amount", "closing_costs_note",
      "broker_commission", "inspection_period_days", "close_of_escrow_days",
      "financing_contingency", "tenancy_description", "property_description",
      "ltr_monthly_rent", "str_monthly_rent", "annual_noi", "monthly_noi",
    ];
    const row = { card_id, updated_at: new Date().toISOString() };
    for (const f of ALLOWED_FIELDS) {
      if (extracted[f] !== null && extracted[f] !== undefined) row[f] = extracted[f];
    }

    // Reconcile the price stack ONCE, here, so the third number is on the row
    // rather than being re-derived on every render. cashPriceStack is the same
    // function the deck page and the email use, so a stored stack and a derived
    // one can never disagree. Only ever FILLS a blank — an extracted value is
    // never overwritten, because a stated concession beats arithmetic (a
    // contract can carry credits that make the three numbers not subtract
    // cleanly, and that is the seller's paperwork, not our error to correct).
    const stack = cashPriceStack(row);
    if (row.original_price == null && stack.original) row.original_price = stack.original;
    if (row.amount_forgiven == null && stack.forgiven) row.amount_forgiven = stack.forgiven;
    if (row.purchase_price == null && stack.purchase) row.purchase_price = stack.purchase;

    const savedCash = await sb(`/cash_deals?on_conflict=card_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_id, property, cash: (savedCash && savedCash[0]) || row }),
    };
  } catch (err) {
    console.error("parse-cash error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
