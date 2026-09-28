// Write access to Google Drive, for import-photos.js: every photo imported into a
// deal's gallery is also saved into a per-deal subfolder of one parent Drive folder.
//
// Auth is a Google SERVICE ACCOUNT (no consent screen, no refresh token that
// expires — the Gmail OAuth app can't be reused: it has no Drive scope, and the
// API key used for Drive *reads* can't write). The parent folder must be shared
// with the service account's email as Editor. Files it creates are owned by the
// service account and count against ITS quota, not Zach's — fine for photos.
//
// Env (all optional — unset = the Drive copy is off and imports behave as before):
//   GDRIVE_SA_EMAIL              service account client_email
//   GDRIVE_SA_PRIVATE_KEY        its private_key (literal "\n" sequences are fine)
//   GDRIVE_PHOTOS_FOLDER_ID      the parent folder's id (from its Drive URL)
"use strict";

const crypto = require("crypto");

const env = () => ({
  email: process.env.GDRIVE_SA_EMAIL || "",
  key: (process.env.GDRIVE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  parent: process.env.GDRIVE_PHOTOS_FOLDER_ID || "",
});

function driveConfigured() {
  const { email, key, parent } = env();
  return !!(email && key && parent);
}

const b64u = (b) => Buffer.from(b).toString("base64url");

let cachedToken = null; // { token, exp } — warm lambdas reuse it
async function driveToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const { email, key } = env();
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}`,
    }),
  });
  if (!r.ok) throw new Error(`Drive auth failed (${r.status}) — check GDRIVE_SA_EMAIL / GDRIVE_SA_PRIVATE_KEY`);
  const j = await r.json();
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function driveApi(path, opts = {}) {
  const token = await driveToken();
  const r = await fetch(`https://www.googleapis.com${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(7000),
  });
  if (r.status === 404 && /\/drive\/v3\/files/.test(path)) {
    throw new Error("Drive folder not found — share it with the service account email as Editor");
  }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// Drive query strings quote with ' — a deal name with an apostrophe must be escaped.
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// The deal's subfolder under the parent, created on first use. Matched by name,
// so re-imports (and a second listing for the same deal) land in the same place.
async function dealFolder(name) {
  const { parent } = env();
  const folderName = String(name || "").replace(/[\/\\]/g, "-").trim() || "Untitled deal";
  const found = await driveApi(`/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)&q=${encodeURIComponent(
    `'${q(parent)}' in parents and name = '${q(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}`);
  if (found.files && found.files.length) return { id: found.files[0].id, name: folderName };
  const made = await driveApi("/drive/v3/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
  });
  return { id: made.id, name: folderName };
}

async function listFolderNames(folderId) {
  const names = new Set();
  let pageToken = "";
  do {
    const r = await driveApi(`/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1000&fields=nextPageToken,files(name)&q=${encodeURIComponent(
      `'${q(folderId)}' in parents and trashed = false`)}${pageToken ? `&pageToken=${pageToken}` : ""}`);
    (r.files || []).forEach((f) => names.add(f.name));
    pageToken = r.nextPageToken || "";
  } while (pageToken);
  return names;
}

// multipart/related upload of one image. Throws on failure.
async function uploadToFolder(folderId, filename, buf, contentType) {
  const boundary = `seaside${crypto.randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return driveApi("/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

module.exports = { driveConfigured, dealFolder, listFolderNames, uploadToFolder, folderUrl };
