// "Import from PDF" for the Contacts page — sends a PDF (conference attendee
// list, lender roster, broker directory, a page of business cards) to Claude
// and returns the people it found.
//
// It deliberately WRITES NOTHING. The rows come back to the browser and go
// through the same review → dedupe → confirm flow as a CSV import, so an
// extraction that misreads a column can't quietly create 80 contacts. The
// insert only happens when the user clicks Import, from contacts.js.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const SB_URL = process.env.SUPABASE_URL;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Anthropic caps a request at 32MB; base64 inflates a file by ~4/3. Reject
// early with a readable message rather than letting the API 413.
const MAX_B64_BYTES = 24 * 1024 * 1024;
const MAX_CONTACTS = 200;

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

const EXTRACTION_PROMPT = `You are reading a document that lists PEOPLE — a conference attendee list, a lender or brokerage roster, a membership directory, a page of scanned business cards, a printed email thread, or similar.

Extract every distinct person who appears with at least a name or a way to reach them.

Return ONLY a valid JSON object — no explanation, no markdown fences, just the JSON:

{
  "contacts": [
    {
      "name": "the person's full name as printed, e.g. \\"Dana Feldman\\"",
      "company": "their company / lender / brokerage, or \\"\\" if not shown",
      "title": "their job title or role, or \\"\\" if not shown",
      "email": "their email address, or \\"\\" if not shown",
      "phone": "their phone number as printed, or \\"\\" if not shown",
      "states": "US states they cover or are located in, as comma-separated two-letter codes, e.g. \\"FL,GA,TN\\" — or \\"\\" if not shown",
      "notes": "anything else short and useful printed about them (specialty, loan products, market focus), or \\"\\" if nothing"
    }
  ]
}

Rules that matter:
- NEVER invent or guess an email address, phone number or company. If it is not printed in the document, use "". A plausible-looking fabricated email is worse than a blank one — someone will try to send to it.
- Do not "correct" or reformat what is printed. Copy emails and phone numbers exactly as they appear.
- Skip page headers, footers, page numbers, column titles, sponsor logos, and the document's own author/sender unless they are clearly one of the listed people.
- If the same person appears more than once, include them once.
- If a row is a company with no named person, use the company name as "name" and repeat it in "company".
- If the document contains no people at all, return {"contacts": []}.
- Return at most ${MAX_CONTACTS} people. If there are more, return the first ${MAX_CONTACTS} in document order.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  try {
    const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
    if (!user) return { statusCode: 401, body: "Unauthorized" };

    if (!ANTHROPIC_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on the server." }) };
    }

    const { pdf_base64 } = JSON.parse(event.body || "{}");
    if (!pdf_base64) return { statusCode: 400, body: JSON.stringify({ error: "pdf_base64 required" }) };
    if (pdf_base64.length > MAX_B64_BYTES) {
      return { statusCode: 413, body: JSON.stringify({ error: "That PDF is too large to read (over ~18MB). Split it up and import a piece at a time." }) };
    }

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 8000,
        // A roster is a long list of short records — medium effort reads it
        // accurately without the extra latency that would push a synchronous
        // Netlify function toward its timeout.
        output_config: { effort: "medium" },
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
    // A safety decline comes back HTTP 200 — check before reading content.
    if (aiData.stop_reason === "refusal") {
      return { statusCode: 422, body: JSON.stringify({ error: "Claude declined to read that document." }) };
    }
    const textBlock = (aiData.content || []).find(b => b.type === "text");
    let raw = ((textBlock && textBlock.text) || "").trim();
    if (raw.startsWith("```")) {
      const lines = raw.split("\n");
      raw = lines.slice(1, lines[lines.length - 1].trim() === "```" ? -1 : undefined).join("\n");
    }

    let extracted;
    try {
      extracted = JSON.parse(raw);
    } catch (e) {
      console.error("parse-contacts unparseable response:", raw.slice(0, 400));
      throw new Error("Couldn't read that PDF as a contact list — Claude didn't return usable data.");
    }

    const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
    const contacts = (Array.isArray(extracted.contacts) ? extracted.contacts : [])
      .slice(0, MAX_CONTACTS)
      .map(c => ({
        name: str(c.name),
        company: str(c.company),
        title: str(c.title),
        email: str(c.email).toLowerCase(),
        phone: str(c.phone),
        states: str(c.states),
        notes: str(c.notes),
      }))
      .filter(c => c.name || c.email || c.phone);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacts, truncated: (extracted.contacts || []).length > MAX_CONTACTS }),
    };
  } catch (err) {
    console.error("parse-contacts error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
