// lib/gdrive.js — Drive mirror for imported photos. Network is stubbed.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GDRIVE_SA_EMAIL = "sa@proj.iam.gserviceaccount.com";
process.env.GDRIVE_SA_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
process.env.GDRIVE_PHOTOS_FOLDER_ID = "PARENT123";
const gdrive = require("../netlify/functions/lib/gdrive");

test("configured only when all three env vars are set", () => {
  assert.equal(gdrive.driveConfigured(), true);
});

test("dealFolder escapes quotes, reuses an existing folder, else creates one", async () => {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "T", expires_in: 3600 }) };
    if (opts.method === "POST") return { ok: true, json: async () => ({ id: "NEW" }) };
    return { ok: true, json: async () => ({ files: [] }) };
  };
  const f = await gdrive.dealFolder("O'Brien St/Unit 2");
  assert.equal(f.id, "NEW");
  assert.equal(f.name, "O'Brien St-Unit 2");
  const search = calls.find(c => c.url.includes("/drive/v3/files?") && !c.opts.method);
  assert.ok(decodeURIComponent(search.url).includes("name = 'O\\'Brien St-Unit 2'"));
  assert.ok(decodeURIComponent(search.url).includes("'PARENT123' in parents"));
  const create = calls.find(c => c.opts.method === "POST" && c.url.includes("/drive/v3/files"));
  assert.deepEqual(JSON.parse(create.opts.body).parents, ["PARENT123"]);
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
