// parse-contacts turns a PDF into rows for the contact importer. What matters
// here is the shaping AFTER Claude answers: the function must never hand the
// browser a half-formed record, and must never write to the database (the
// import is confirmed by a human — see contacts.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.ANTHROPIC_API_KEY = "sk-test";

const { handler } = require("../netlify/functions/parse-contacts");

const realFetch = globalThis.fetch;
// Stub both calls the handler makes: the Supabase token check, then Anthropic.
function stubFetch({ authOk = true, anthropic }) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/auth/v1/user")) {
      return { ok: authOk, json: async () => ({ id: "u1" }) };
    }
    if (String(url).includes("api.anthropic.com")) {
      globalThis.__lastBody = JSON.parse(opts.body);
      return { ok: true, json: async () => anthropic, text: async () => "" };
    }
    throw new Error("unexpected fetch: " + url);
  };
}
const say = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const call = (body) => handler({ httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });

test.afterEach(() => { globalThis.fetch = realFetch; });

test("extracts contacts and trims every field", async () => {
  stubFetch({ anthropic: say(JSON.stringify({ contacts: [
    { name: "  Dana Feldman ", company: "Harborline", title: "VP", email: " DANA@Harborline.com ", phone: " (919) 555-0134 ", states: "NC,GA", notes: "met at conf" },
  ] })) });
  const res = await call({ pdf_base64: "abc" });
  assert.strictEqual(res.statusCode, 200);
  const { contacts } = JSON.parse(res.body);
  assert.deepStrictEqual(contacts, [{
    name: "Dana Feldman", company: "Harborline", title: "VP",
    email: "dana@harborline.com", phone: "(919) 555-0134", states: "NC,GA", notes: "met at conf",
  }]);
});

test("drops rows with no name and no way to reach them", async () => {
  stubFetch({ anthropic: say(JSON.stringify({ contacts: [
    { name: "", company: "Page 3 of 12", email: "", phone: "" },
    { name: "Real Person", email: "", phone: "" },
    { name: "", email: "someone@co.com" },
  ] })) });
  const { contacts } = JSON.parse((await call({ pdf_base64: "abc" })).body);
  assert.deepStrictEqual(contacts.map(c => c.name || c.email), ["Real Person", "someone@co.com"]);
});

test("missing / null fields become empty strings, never null or undefined", async () => {
  // contacts.js writes these straight into Postgres columns; a null company
  // would blow past the table's '' default and a stray undefined would drop
  // the key from the JSON body entirely.
  stubFetch({ anthropic: say(JSON.stringify({ contacts: [{ name: "Solo", company: null, phone: 5551234 }] })) });
  const { contacts } = JSON.parse((await call({ pdf_base64: "abc" })).body);
  for (const v of Object.values(contacts[0])) assert.strictEqual(typeof v, "string");
  assert.strictEqual(contacts[0].phone, "5551234");
});

test("strips markdown fences Claude sometimes wraps JSON in", async () => {
  stubFetch({ anthropic: say('```json\n{"contacts":[{"name":"Fenced"}]}\n```') });
  const { contacts } = JSON.parse((await call({ pdf_base64: "abc" })).body);
  assert.strictEqual(contacts[0].name, "Fenced");
});

test("caps the list at 200 and reports the truncation", async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ name: `P${i}` }));
  stubFetch({ anthropic: say(JSON.stringify({ contacts: many })) });
  const out = JSON.parse((await call({ pdf_base64: "abc" })).body);
  assert.strictEqual(out.contacts.length, 200);
  assert.strictEqual(out.truncated, true);
});

test("a refusal is reported, not read as content", async () => {
  stubFetch({ anthropic: { stop_reason: "refusal", content: [], stop_details: { category: "cyber" } } });
  assert.strictEqual((await call({ pdf_base64: "abc" })).statusCode, 422);
});

test("an empty result is an empty list, not an error", async () => {
  stubFetch({ anthropic: say('{"contacts":[]}') });
  const res = await call({ pdf_base64: "abc" });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(JSON.parse(res.body).contacts, []);
});

test("unparseable output fails loudly instead of returning junk", async () => {
  stubFetch({ anthropic: say("I couldn't find a roster in this document.") });
  const res = await call({ pdf_base64: "abc" });
  assert.strictEqual(res.statusCode, 500);
  assert.match(JSON.parse(res.body).error, /Couldn't read that PDF/);
});

test("rejects an unauthenticated caller before spending a single API token", async () => {
  let anthropicCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.anthropic.com")) { anthropicCalled = true; }
    return { ok: false, json: async () => ({}) };
  };
  assert.strictEqual((await call({ pdf_base64: "abc" })).statusCode, 401);
  assert.strictEqual(anthropicCalled, false);
});

test("rejects an oversized PDF before calling the API", async () => {
  let anthropicCalled = false;
  stubFetch({ anthropic: say("{}") });
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url).includes("anthropic")) anthropicCalled = true; return inner(url, o); };
  const res = await call({ pdf_base64: "x".repeat(25 * 1024 * 1024) });
  assert.strictEqual(res.statusCode, 413);
  assert.strictEqual(anthropicCalled, false);
});

test("sends the PDF as a document block and asks Claude for no invention", async () => {
  stubFetch({ anthropic: say('{"contacts":[]}') });
  await call({ pdf_base64: "PDFDATA" });
  const body = globalThis.__lastBody;
  assert.strictEqual(body.model, "claude-opus-5");
  const [doc, txt] = body.messages[0].content;
  assert.strictEqual(doc.type, "document");
  assert.strictEqual(doc.source.media_type, "application/pdf");
  assert.strictEqual(doc.source.data, "PDFDATA");
  assert.match(txt.text, /NEVER invent or guess an email/);
});

test("the function never writes to the database", async () => {
  // The whole safety story is that a human confirms the import. If this file
  // ever gains a Supabase REST write, that story is gone.
  const src = fs.readFileSync(path.join(__dirname, "../netlify/functions/parse-contacts.js"), "utf8");
  assert.ok(!/\/rest\/v1/.test(src), "parse-contacts must not write to Supabase — the import is confirmed in the browser");
  assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(src), "parse-contacts must not hold the service-role key");
});
