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
}

module.exports = { sendSms, normalizePhone, smsConfigured };
