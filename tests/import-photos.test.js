// import-photos handler smoke test — network stubbed. Exists because the Drive
// mirror once declared a local `driveFolderId` that shadowed the Drive-link
// parser of the same name (TDZ → every import 500'd). node --check can't see that.
const test = require("node:test");
const assert = require("node:assert");

process.env.SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_ANON_KEY = "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.GMAIL_CLIENT_ID = "cid";
process.env.GMAIL_CLIENT_SECRET = "cs";
process.env.GDRIVE_REFRESH_TOKEN = "rt";
const { handler } = require("../netlify/functions/import-photos");

function stub(driveOn) {
  const drive = { uploads: 0 };
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    const json = (b, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => "" } });
    if (url.includes("/auth/v1/user")) return json({ id: "u" });
    if (url.includes("/storage/v1/object/list")) return json([]);
    if (url.includes("/storage/v1/object/property-photos")) return json({});
    if (url.includes("/rest/v1/properties")) return json([{ name: "1 Test St" }]);
    if (url.includes("/rest/v1/deal_acquisition")) return json({});
    if (url.includes("oauth2.googleapis.com")) return json({ access_token: "T", expires_in: 3600 });
    if (url.includes("upload/drive/v3/files")) { drive.uploads++; return json({ id: "f" }); }
    if (url.includes("/drive/v3/files") && opts.method === "POST") return json({ id: "NEW" });
    if (url.includes("/drive/v3/files")) return json({ files: [] });
    if (url.includes("img.test")) {
      return { ok: true, status: 200, headers: { get: (h) => (h === "content-type" ? "image/jpeg" : "") }, arrayBuffer: async () => new Uint8Array(30 * 1024).buffer };
    }
    throw new Error("unexpected fetch " + url);
  };
  return drive;
}
const req = () => ({ httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ card_id: "c1", url: "https://img.test/a.jpg" }) });

test("import succeeds and mirrors to Drive when Drive is configured", async () => {
  const drive = stub(true);
  const r = await handler(req());
  assert.equal(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  assert.equal(b.imported, 1);
  assert.equal(drive.uploads, 1);
  assert.equal(b.drive.saved, 1);
});

test("import still succeeds with Drive off", async () => {
  const t = process.env.GDRIVE_REFRESH_TOKEN; delete process.env.GDRIVE_REFRESH_TOKEN;
  stub(false);
  const r = await handler(req());
  process.env.GDRIVE_REFRESH_TOKEN = t;
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).drive, null);
});
