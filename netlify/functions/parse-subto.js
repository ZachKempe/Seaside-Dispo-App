// F5 — "Add Sub-To Deal" upload for the dashboard: THE Sub-To intake (the
// Trello sync and the laptop pipeline it fed from are both retired). Sends the
// purchase contract and the seller's mortgage statement (each a PDF or an
// image — screenshot/JPEG) to Claude, extracts the Sub-To deal terms, and
// creates a brand-new standalone deal card: a `properties` row (card_id
// "subto-...") plus a `deal_terms` row. Marketing copy is a second call —
// generate-copy.js — so the numbers in the copy always come from the same
// structured terms saved here.
//
// Auth: requires the caller's Supabase access token (the logged-in user),
// same as parse-loi.js.

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const { ensureDeckSlug } = require("./lib/deck-slug");
const { int0 } = require("./lib/num");

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

// PDF goes in a "document" block; images (screenshots / phone photos of a
// statement) go in an "image" block. Claude accepts these image types only —
// notably NOT image/heic, which the dashboard blocks before upload.
const ALLOWED_MEDIA = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"]);

function fileBlock(file, label) {
  if (!file || !file.data) throw new Error(`${label} file is missing`);
  const mt = file.media_type;
  if (!ALLOWED_MEDIA.has(mt)) throw new Error(`${label} must be a PDF or JPG/PNG/GIF/WebP image (got ${mt || "unknown type"})`);
  const source = { type: "base64", media_type: mt, data: file.data };
  return mt === "application/pdf"
    ? { type: "document", source }
    : { type: "image", source };
}

const EXTRACTION_PROMPT = `You are reading the documents for a "Subject-To" (Sub-To) real estate deal: a purchase contract and the seller's mortgage statement.

Extract the following and return ONLY a valid JSON object — no explanation, no markdown, just the JSON. Use null for anything not stated in the documents. Numbers must be plain JSON numbers (no $ signs or commas).

{
  "property_name": "the property's full street address including city/state/zip as shown, e.g. \\"123 Main St, Ocala, FL 34479\\"" or null,
  "state": "two-letter state code the property is in, e.g. \\"FL\\"" or null,
  "price": number or null — the total purchase price from the contract,
  "entry_fee": number or null — the buyer's cash to seller / down payment / entry fee stated in the contract (NOT earnest money; null if not clearly stated),
  "mortgage": number or null — the current unpaid principal balance of the existing loan (prefer the mortgage statement's figure),
  "rate": number or null — the existing loan's interest rate as a percent, e.g. 3.25 (prefer the mortgage statement),
  "piti": number or null — the TOTAL monthly payment including principal, interest, taxes, and insurance/escrow (the mortgage statement's total amount due each month),
  "beds": integer or null — bedrooms, if stated anywhere,
  "baths": number or null — bathrooms, if stated anywhere (2.5 allowed),
  "sqft": integer or null — living area square footage, if stated,
  "year_built": integer or null — year built, if stated
}`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }) };
    }

    const { contract, statement } = JSON.parse(event.body || "{}");
    if (!contract || !contract.data) return { statusCode: 400, body: JSON.stringify({ error: "contract file required" }) };
    if (!statement || !statement.data) return { statusCode: 400, body: JSON.stringify({ error: "mortgage statement file required" }) };

    // Both files go in one request, each labelled so Claude knows which is which
    // (matters especially when they're images rather than self-labelling PDFs).
    const content = [
      { type: "text", text: "Document 1 — the purchase contract:" },
      fileBlock(contract, "Contract"),
      { type: "text", text: "Document 2 — the seller's mortgage statement:" },
      fileBlock(statement, "Mortgage statement"),
      { type: "text", text: EXTRACTION_PROMPT },
    ];

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

    // Brand-new standalone Sub-To card ("subto-" prefix marks upload-created
    // cards, distinct from legacy Trello card ids).
    const card_id = `subto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const propRow = {
      card_id,
      name: extracted.property_name || "New Sub-To Deal",
      state: extracted.state || "",
      trello_url: "",
      deal_type: "subto",
      synced_at: new Date().toISOString(),
    };
    const savedProp = await sb(`/properties?on_conflict=card_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(propRow),
    });
    const property = (savedProp && savedProp[0]) || propRow;

    // Eagerly mint the deck-page slug so the buyer-facing link exists the
    // moment the card does (it used to appear only on first blast). Non-fatal:
    // blast-core still backfills lazily if this ever fails.
    try { await ensureDeckSlug(sb, property); } catch (e) { console.error("deck slug:", e.message); }

    const termsRow = {
      card_id,
      entry_fee: int0(extracted.entry_fee),
      price: int0(extracted.price),
      mortgage: int0(extracted.mortgage),
      rate: extracted.rate === null || extracted.rate === undefined ? "" : String(extracted.rate),
      piti: int0(extracted.piti),
      beds: int0(extracted.beds),
      baths: extracted.baths === null || extracted.baths === undefined ? "" : String(extracted.baths),
      sqft: int0(extracted.sqft),
      year_built: int0(extracted.year_built),
      updated_at: new Date().toISOString(),
    };
    const savedTerms = await sb(`/deal_terms?on_conflict=card_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(termsRow),
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_id, property, terms: (savedTerms && savedTerms[0]) || termsRow }),
    };
  } catch (err) {
    console.error("parse-subto error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
