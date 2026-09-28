// lib/gdrive.js — Drive mirror for imported photos. Network is stubbed.
const test = require("node:test");
const assert = require("node:assert");

process.env.GMAIL_CLIENT_ID = "cid";
process.env.GMAIL_CLIENT_SECRET = "csecret";
process.env.GDRIVE_REFRESH_TOKEN = "rtok";
const gdrive = require("../netlify/functions/lib/gdrive");

test("configured only when the client + refresh token are set", () => {
  assert.equal(gdrive.driveConfigured(), true);
  const t = process.env.GDRIVE_REFRESH_TOKEN; delete process.env.GDRIVE_REFRESH_TOKEN;
  assert.equal(gdrive.driveConfigured(), false);
  process.env.GDRIVE_REFRESH_TOKEN = t;
});

test("dealFolder creates Deal Photos in root, then the escaped deal folder inside it", async () => {
  const calls = [];
  let n = 0;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "T", expires_in: 3600 }) };
    if (opts.method === "POST") return { ok: true, json: async () => ({ id: `NEW${++n}` }) };
    return { ok: true, json: async () => ({ files: [] }) };
  };
  const f = await gdrive.dealFolder("O'Brien St/Unit 2");
  assert.equal(f.id, "NEW2");
  assert.equal(f.name, "O'Brien St-Unit 2");
  const searches = calls.filter(c => c.url.includes("/drive/v3/files?") && !c.opts.method).map(c => decodeURIComponent(c.url));
  assert.ok(searches[0].includes("'root' in parents") && searches[0].includes("name = 'Deal Photos'"));
  assert.ok(searches[1].includes("'NEW1' in parents") && searches[1].includes("name = 'O\\'Brien St-Unit 2'"));
  const creates = calls.filter(c => c.opts.method === "POST" && c.url.includes("/drive/v3/files"));
  assert.deepEqual(JSON.parse(creates[1].opts.body).parents, ["NEW1"]);
});

test("uploadToFolder sends multipart with the folder as parent", async () => {
  let sent;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("oauth2")) return { ok: true, json: async () => ({ access_token: "T", expires_in: 3600 }) };
    sent = opts; return { ok: true, json: async () => ({ id: "F" }) };
  };
  await gdrive.uploadToFolder("FOLD", "000-abc-imp.jpg", Buffer.from("IMG"), "image/jpeg");
  assert.match(sent.headers["Content-Type"], /^multipart\/related; boundary=/);
  assert.ok(sent.body.toString().includes('"parents":["FOLD"]'));
  assert.ok(sent.body.toString().includes("IMG"));
});
