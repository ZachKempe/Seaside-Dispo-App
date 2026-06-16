// "Upload LOI" function for the Morby Deal tab — sends the LOI PDF to Claude,
// extracts the deal terms into the morby_deals schema, and upserts them so
// the dashboard can re-render the (pre-filled, still-editable) Morby Deal
// form and the Deal Deck PDF can be generated from it.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

const EXTRACTION_PROMPT = `You are analyzing a Letter of Intent (LOI) for a "Morby Method" seller-finance / deferred-interest real estate deal.

Extract the following information and return ONLY a valid JSON object — no explanation, no markdown, just the JSON. Use null for any value that is not stated in the LOI.

{
  "property_name": "the property's street address (and city/state if shown), used as the deal's display name, e.g. \\"123 Main St, Austin, TX\\"" or null,
  "state": "two-letter state code the property is in, e.g. \\"TX\\"" or null,
  "property_type": "single_family" or "commercial" — infer from the property description; default to "single_family" if unclear,
  "purchase_price": number or null — the total purchase price,
  "down_payment": number or null — down payment / earnest money deposit amount,
  "earnest_money_amount": number or null — earnest money deposit amount (may be the same as down_payment),
  "closing_costs_note": short string describing who pays closing costs, e.g. "Buyer pays all closing costs",
  "broker_commission": short string describing any broker/agent commission terms, or "None",
  "seller_carry_balance": number or null — the seller-financed balance,
  "interest_type": "deferred" or "interest_only" — how the seller-financed balance accrues interest. Look closely at the Seller Financing Terms language:
    - Use "deferred" if the LOI says interest "accrues" / "compounds" / is "deferred" and that the "principal balance together with ALL accrued interest" (or similar "all"/"compounded" wording) is due at balloon. This means the balloon payoff GROWS over the term (principal + compounded interest).
    - Use "interest_only" if the LOI describes the financing on an "interest-only basis" (even if the stated monthly payment is $0). This means the balloon payoff stays equal to the original principal balance — no extra interest is added to the balloon amount.
    - Default to "deferred" if unclear.
  "deferred_interest_rate": number or null — the stated interest rate as a percent, e.g. 0 or 5 (only set if a specific rate is stated; for "interest_only" structures with no stated rate, use 0),
  "monthly_payment": number or null — any monthly payment due during the deferral period (0 if no monthly payments are required),
  "balloon_months": integer or null — the balloon term in months,
  "inspection_period_days": integer or null — due diligence / inspection period in days,
  "close_of_escrow_days": integer or null — days to close,
  "financing_contingency": true or false — whether the offer is contingent on buyer financing,
  "tenancy_description": short string describing current tenancy/occupancy if mentioned, else null,
  "property_description": short string summarizing the property if described, else null,
  "ltr_monthly_rent": number or null — long-term rent estimate (single family only),
  "str_monthly_rent": number or null — short-term rental income estimate (single family only),
  "annual_noi": number or null — annual net operating income (commercial only),
  "monthly_noi": number or null — monthly net operating income (commercial only),
  "seller_flexibility_notes": short string capturing any seller-flexibility language (e.g. "Seller willing to finance $X after balloon..."), else null
}

Numbers must be plain JSON numbers (no $ signs or commas).`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }) };
    }

    let { card_id, pdf_base64 } = JSON.parse(event.body || "{}");
    if (!pdf_base64) return { statusCode: 400, body: "pdf_base64 required" };

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf_base64 } },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Claude extraction failed: ${aiRes.status} ${errText}`);
    }

    const aiData = await aiRes.json();
    let raw = (aiData.content && aiData.content[0] && aiData.content[0].text || "").trim();
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

    let property = null;
    if (!card_id) {
      // No existing card — this LOI upload creates a brand-new standalone
      // Morby deal card (not tied to the Trello/Sub-To pipeline).
      card_id = `morby-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const propRow = {
        card_id,
        name: extracted.property_name || "New Morby Deal",
        state: extracted.state || "",
        trello_url: "",
        deal_type: "morby",
      };
      const savedProp = await sb(`/properties?on_conflict=card_id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(propRow),
      });
      property = (savedProp && savedProp[0]) || propRow;
    }

    // Only keep known morby_deals columns, drop nulls so we don't clobber
    // existing values the user may have already entered manually.
    const ALLOWED_FIELDS = [
      "property_type", "purchase_price", "down_payment", "earnest_money_amount",
      "closing_costs_note", "broker_commission", "seller_carry_balance",
      "interest_type", "deferred_interest_rate", "monthly_payment", "balloon_months",
      "inspection_period_days", "close_of_escrow_days", "financing_contingency",
      "tenancy_description", "property_description", "ltr_monthly_rent",
      "str_monthly_rent", "annual_noi", "monthly_noi", "seller_flexibility_notes",
    ];
    const row = { card_id, updated_at: new Date().toISOString() };
    for (const f of ALLOWED_FIELDS) {
      if (extracted[f] !== null && extracted[f] !== undefined) row[f] = extracted[f];
    }

    const saved = await sb(`/morby_deals?on_conflict=card_id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_id, property, morby: (saved && saved[0]) || row }) };
  } catch (err) {
    console.error("parse-loi error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
