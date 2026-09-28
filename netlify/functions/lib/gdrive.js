// Write access to Google Drive, for import-photos.js: every photo imported into a
// deal's gallery is also saved into a per-deal subfolder of a "Deal Photos" folder
// in zach@seasidehorizon.com's Drive.
//
// Auth is the same Google OAuth app as Gmail (client `dispo-gmail-capture`, published
// to production so the refresh token persists) with ONE extra scope, drive.file:
// the app can only see files it created itself. It therefore creates the
// "Deal Photos" root on first use and finds it again by name — no folder id to
// configure, and it can't touch anything else in the Drive. (A service account was
// tried first; the org policy iam.disableServiceAccountKeyCreation blocks its key.)
//
// Env (unset = the Drive copy is off and imports behave as before):
//   GDRIVE_REFRESH_TOKEN         refresh token for zach@ granted the drive.file scope
//   GMAIL_CLIENT_ID / _SECRET    reused — same OAuth client
"use strict";

const crypto = require("crypto");

const ROOT_NAME = "Deal Photos";

const env = () => ({
  clientId: process.env.GMAIL_CLIENT_ID || "",
  clientSecret: process.env.GMAIL_CLIENT_SECRET || "",
  refreshToken: process.env.GDRIVE_REFRESH_TOKEN || "",
});

function driveConfigured() {
  const { clientId, clientSecret, refreshToken } = env();
  return !!(clientId && clientSecret && refreshToken);
}

let cachedToken = null; // { token, exp } — warm lambdas reuse it
async function driveToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const { clientId, clientSecret, refreshToken } = env();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Drive auth failed (${r.status}) — GDRIVE_REFRESH_TOKEN may be revoked or missing the drive.file scope`);
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
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// Drive query strings quote with ' — a deal name with an apostrophe must be escaped.
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// The deal's subfolder under the parent, created on first use. Matched by name,
// so re-imports (and a second listing for the same deal) land in the same place.
const FOLDER = "application/vnd.google-apps.folder";
async function findOrCreateFolder(name, parent) {
  const inParent = parent ? `'${q(parent)}' in parents and ` : "'root' in parents and ";
  const found = await driveApi(`/drive/v3/files?fields=files(id)&q=${encodeURIComponent(
    `${inParent}name = '${q(name)}' and mimeType = '${FOLDER}' and trashed = false`)}`);
  if (found.files && found.files.length) return found.files[0].id;
  const made = await driveApi("/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) }),
  });
  return made.id;
}

async function dealFolder(name) {
  const parent = await findOrCreateFolder(ROOT_NAME, null);
  const folderName = String(name || "").replace(/[\/\\]/g, "-").trim() || "Untitled deal";
  return { id: await findOrCreateFolder(folderName, parent), name: folderName };
}

async function listFolderNames(folderId) {
  const names = new Set();
  let pageToken = "";
  do {
    const r = await driveApi(`/drive/v3/files?pageSize=1000&fields=nextPageToken,files(name)&q=${encodeURIComponent(
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
  return driveApi("/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`;

module.exports = { driveConfigured, dealFolder, listFolderNames, uploadToFolder, folderUrl };
