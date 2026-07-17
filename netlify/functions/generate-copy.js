// F5 — marketing copy generation for a Sub-To deal. Reads the deal's saved
// properties + deal_terms rows (never the PDFs — the structured terms are the
// single source of truth, so the numbers in the copy can't drift from what the
// dashboard shows and what send-blast sends; findCopyMismatches stays green)
// and asks Claude for 3 copy variations, saved to properties.variations in the
// same [{title, body}] shape sync-trello used to seed from Trello comments.
// The dashboard's copy editor remains the source of truth after generation —
// this only ever runs on a card whose variations are still empty, unless the
// caller passes force:true.
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

// The copy is checked against deal_terms by the dashboard's mismatch detector
// (entry fee / price / beds patterns), so the prompt pins the exact figures.
function buildPrompt(prop, t) {
  const known = [];
  if (t.price) known.push(`Purchase Price: $${Number(t.price).toLocaleString()}`);
  if (t.entry_fee) known.push(`Entry Fee: $${Number(t.entry_fee).toLocaleString()} + TC + CC`);
  if (t.mortgage) known.push(`Existing Loan Balance: $${Number(t.mortgage).toLocaleString()}`);
  if (t.piti) known.push(`PITI: $${Number(t.piti).toLocaleString()}/mo`);
  if (t.rate) known.push(`Rate: ${t.rate}%`);
  if (t.beds) known.push(`Beds: ${t.beds}`);
  if (t.baths) known.push(`Baths: ${t.baths}`);
  if (t.sqft) known.push(`Sqft: ${Number(t.sqft).toLocaleString()}`);
  if (t.year_built) known.push(`Year Built: ${t.year_built}`);

  return `Write marketing copy for a Subject-To ("Sub-To") real estate wholesale deal being blasted to a cash/creative-finance buyer list and posted in investor Facebook groups.

PROPERTY: ${prop.name}${prop.state ? ` (${prop.state})` : ""}

DEAL TERMS (use these EXACT figures, formatted with commas exactly as shown — do not round, restate, or invent any number that is not listed):
${known.join("\n")}

Return ONLY a valid JSON array of exactly 3 variations — no explanation, no markdown fences:
[
  {"title": "short label for this angle, e.g. \\"Numbers First\\"", "body": "the copy"},
  ...
]

Rules for each body:
- Plain text (no markdown), short lines, skimmable. 60–120 words.
- Start with a hook, include the address, the key terms above, and end with a call to action to reply/DM for details.
- Each variation takes a genuinely different angle (e.g. numbers-led, cashflow story, low-entry hook) — not the same copy reworded.
- Never mention figures that are not in the DEAL TERMS list. If entry fee is not listed, say "Ask about the entry fee" instead of guessing.`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }) };
    }

    const { card_id, force } = JSON.parse(event.body || "{}");
    if (!card_id) return { statusCode: 400, body: JSON.stringify({ error: "card_id required" }) };

    const [props, termsRows] = await Promise.all([
      sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}&select=card_id,name,state,variations&limit=1`, { method: "GET" }),
      sb(`/deal_terms?card_id=eq.${encodeURIComponent(card_id)}&select=*&limit=1`, { method: "GET" }),
    ]);
    const prop = (props || [])[0];
    if (!prop) return { statusCode: 404, body: JSON.stringify({ error: "property not found" }) };

    // Dashboard edits are authoritative — never clobber existing copy unless
    // the caller explicitly asks to regenerate.
    if (!force && Array.isArray(prop.variations) && prop.variations.length) {
      return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_id, variations: prop.variations, skipped: "already has copy" }) };
    }

    const terms = (termsRows || [])[0] || {};

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1500,
        messages: [{ role: "user", content: buildPrompt(prop, terms) }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Claude copy generation failed: ${aiRes.status} ${errText}`);
    }

    const aiData = await aiRes.json();
    let raw = ((aiData.content || []).find(b => b.type === "text") || {}).text || "";
    raw = raw.trim();
    if (raw.startsWith("```")) {
      const lines = raw.split("\n");
      raw = lines.slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined).join("\n");
    }

    let variations;
    try {
      variations = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Couldn't parse Claude's response as JSON: ${e.message}`);
    }
    if (!Array.isArray(variations)) throw new Error("Claude did not return an array of variations");
    variations = variations
      .filter(v => v && typeof v === "object" && v.body)
      .slice(0, 3)
      .map((v, i) => ({ title: String(v.title || `Variation ${i + 1}`).slice(0, 60), body: String(v.body) }));
    if (!variations.length) throw new Error("Claude returned no usable variations");

    await sb(`/properties?card_id=eq.${encodeURIComponent(card_id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ variations }),
    });

    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ card_id, variations }) };
  } catch (err) {
    console.error("generate-copy error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
