// Outbound SMS via GoHighLevel, shared by every function that texts a buyer
// (blast-core.js and onboard-buyers.js today). Lifted verbatim out of
// blast-core so there is exactly one copy of the contact-upsert dance — the
// v2 API needs a contactId, not a number, and getting that wrong fails per
// message rather than loudly.
//
// Env is read at call time (not module load) so a function that never texts
// doesn't care whether GHL is configured.
"use strict";

const ghlEnv = () => ({
  apiKey: process.env.GHL_API_KEY,
  fromNumber: process.env.GHL_FROM_NUMBER,
  locationId: process.env.GHL_LOCATION_ID,
});

// Is SMS available at all? Callers use this to report "not configured"
// instead of failing every recipient.
function smsConfigured() {
  const { apiKey, fromNumber } = ghlEnv();
  return !!(apiKey && fromNumber);
}

function normalizePhone(phone) {
  let p = (phone || "").replace(/[\s\-().]/g, "");
  if (!p) return "";
  if (!p.startsWith("+")) p = p.length === 10 ? `+1${p}` : `+${p}`;
  return p;
}

async function ghlContactId(phone) {
  const { apiKey, locationId } = ghlEnv();
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Version: "2021-07-28" };
  // v2 duplicate search needs locationId + number (not "phone"). Find the
  // existing contact first so we don't try to re-create it.
  const searchUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&number=${encodeURIComponent(phone)}`;
  let r = await fetch(searchUrl, { headers });
  if (r.ok) {
    const data = await r.json();
    if (data && data.contact && data.contact.id) return data.contact.id;
  }
  // Otherwise create. If GHL rejects it as a duplicate, it returns the existing
  // contact's id in meta — reuse that rather than failing.
  r = await fetch(`https://services.leadconnectorhq.com/contacts/`, {
    method: "POST", headers, body: JSON.stringify({ phone, locationId }),
  });
  const bodyText = await r.text();
  if (!r.ok) {
    try {
      const err = JSON.parse(bodyText);
      if (err && err.meta && err.meta.contactId) return err.meta.contactId;
    } catch (_) { /* fall through to throw */ }
    throw new Error(`GHL create contact -> ${r.status}: ${bodyText}`);
  }
  const data = JSON.parse(bodyText);
  if (!data || !data.contact || !data.contact.id) throw new Error("GHL: no contact id returned");
  return data.contact.id;
}

// Resolves to GHL's response ({ conversationId, messageId, ... }) so a caller
// that shows the thread can match what it just sent; existing callers ignore it.
async function sendSms(phone, message) {
  const { apiKey, fromNumber } = ghlEnv();
  const e164 = normalizePhone(phone);
  if (!e164) throw new Error("no phone");
  const contactId = await ghlContactId(e164);
  const r = await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Version: "2021-04-15" },
    body: JSON.stringify({ type: "SMS", contactId, fromNumber, message }),
  });
  if (!r.ok) throw new Error(`GHL send SMS -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch (_) { return {}; }
}

// The SMS history GHL holds for a phone number — every text in or out,
// including ones sent from the GHL app itself, which is why the buyers page
// reads this rather than keeping its own ledger. Raw GHL message rows; the
// caller normalizes them (lib/conversation.js). Returns { contactId,
// conversationId, messages }. A number GHL has never seen yields an empty
// thread rather than creating a contact — creation is the send path's job.
async function fetchSmsThread(phone, { limit = 100 } = {}) {
  const { apiKey, locationId } = ghlEnv();
  const e164 = normalizePhone(phone);
  if (!e164) return { contactId: null, conversationId: null, messages: [] };
  const headers = { Authorization: `Bearer ${apiKey}`, Version: "2021-04-15" };

  const dupUrl = `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&number=${encodeURIComponent(e164)}`;
  const dr = await fetch(dupUrl, { headers: { ...headers, Version: "2021-07-28" } });
  if (!dr.ok) throw new Error(`GHL contact lookup -> ${dr.status}: ${await dr.text()}`);
  const dj = await dr.json();
  const contactId = dj && dj.contact && dj.contact.id;
  if (!contactId) return { contactId: null, conversationId: null, messages: [] };

  const sr = await fetch(
    `https://services.leadconnectorhq.com/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}`,
    { headers });
  if (!sr.ok) throw new Error(`GHL conversations search -> ${sr.status}: ${await sr.text()}`);
  const sj = await sr.json();
  const convos = (sj && sj.conversations) || [];
  if (!convos.length) return { contactId, conversationId: null, messages: [] };

  const messages = [];
  for (const c of convos) {
    const mr = await fetch(
      `https://services.leadconnectorhq.com/conversations/${encodeURIComponent(c.id)}/messages?limit=${limit}`,
      { headers });
    if (!mr.ok) throw new Error(`GHL messages -> ${mr.status}: ${await mr.text()}`);
    const mj = await mr.json();
    const rows = (mj && mj.messages && (Array.isArray(mj.messages) ? mj.messages : mj.messages.messages)) || [];
    for (const m of rows) messages.push({ ...m, conversationId: m.conversationId || c.id });
  }
  return { contactId, conversationId: convos[0].id, messages };
}

module.exports = { sendSms, fetchSmsThread, ghlContactId, normalizePhone, smsConfigured };
