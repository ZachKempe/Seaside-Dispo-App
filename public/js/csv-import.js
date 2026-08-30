// Shared CSV import engine — the parser, header detection and dedupe used by
// BOTH the buyer importer (buyers.js) and the contact importer (contacts.js).
// Load after ui-shared.js, before the page script.
//
// It was extracted from buyers.js when contacts got their own import: a second
// copy of "which column is the phone number" and "have we already got this
// person" is exactly the kind of duplication that drifts apart silently, and
// dedupe drifting means duplicate records that each receive their own blast.
// Everything here is page-agnostic — nothing knows about buyers or contacts.

// RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, commas
// and newlines inside quotes, and \r\n / \r / \n line endings.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  text = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(v => v !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(v => v !== "")) rows.push(row); }
  return rows;
}

// Header synonym sets — map messy real-world headers to our fields.
const HEADER_SYNONYMS = {
  first:   ["first name","first","fname","owner first name","owner first","first_name","contact first name"],
  last:    ["last name","last","lname","owner last name","owner last","last_name","contact last name"],
  name:    ["name","full name","owner name","contact name","contact","buyer name","investor name","display name"],
  email:   ["email","email 1","email1","email address","e-mail","primary email","email_1","emailaddress"],
  phone:   ["phone","phone 1","phone1","mobile","cell","cell phone","phone number","telephone","primary phone","phone_1","mobile phone","contact phone"],
  company: ["company","business","business name","llc","entity","company name","organization","lender","brokerage","brokerage name","firm"],
  state:   ["state","states","mailing state","property state","st","mailing st","buy box states","buy_box","markets","coverage"],
  city:    ["city","mailing city","property city"],
  notes:   ["notes","note","comment","comments","tags","tag"],
};
// Header substrings that mark ADDITIONAL phone/email columns to harvest.
const PHONE_HINT = ["phone","mobile","cell","tel"];
const EMAIL_HINT = ["email","e-mail"];

function detectMapping(headers) {
  const norm = headers.map(h => (h || "").trim().toLowerCase());
  const map = {};
  // Exact-ish single-field detection (first match wins).
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) {
    const idx = norm.findIndex(h => syns.includes(h));
    if (idx !== -1) map[field] = idx;
  }
  // Fallback fuzzy: header contains a synonym word.
  for (const [field, syns] of Object.entries(HEADER_SYNONYMS)) {
    if (map[field] != null) continue;
    const idx = norm.findIndex(h => syns.some(s => h.includes(s)));
    if (idx !== -1) map[field] = idx;
  }
  // All phone/email column indices (we harvest the first non-empty per row).
  map._phones = norm.map((h, i) => PHONE_HINT.some(w => h.includes(w)) ? i : -1).filter(i => i !== -1);
  map._emails = norm.map((h, i) => EMAIL_HINT.some(w => h.includes(w)) ? i : -1).filter(i => i !== -1);
  return map;
}

const ALL_STATE_ABBR = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
const STATE_NAME_TO_ABBR = {alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC"};
function normalizeState(raw) {
  const out = [];
  for (let part of String(raw || "").replace(/[;|/]/g, ",").split(",")) {
    part = part.trim();
    if (!part) continue;
    const up = part.toUpperCase();
    if (ALL_STATE_ABBR.has(up)) out.push(up);
    else if (STATE_NAME_TO_ABBR[part.toLowerCase()]) out.push(STATE_NAME_TO_ABBR[part.toLowerCase()]);
  }
  return [...new Set(out)].join(",");
}

// The dedupe keys, app-wide: digits-only phone (leading US 1 stripped) and
// lower-cased email. The CSV importers, the Add forms and findOrCreateBuyer
// on the server must all agree on these or the same person lands twice.
function digitsOnly(p) { return String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); }
function validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "").trim()); }
function firstNonEmpty(row, idxs) {
  for (const i of idxs) { const v = (row[i] || "").trim(); if (v) return v; }
  return "";
}

// CSV rows + a column mapping → neutral { name, phone, email, company, states,
// notes } records. Callers turn those into their own table's shape.
function buildRowsFromCsv(rows, mapping) {
  const out = [];
  for (const row of rows) {
    let name = "";
    if (mapping.first != null || mapping.last != null) {
      name = [row[mapping.first] || "", row[mapping.last] || ""].map(s => s.trim()).filter(Boolean).join(" ");
    }
    if (!name && mapping.name != null) name = (row[mapping.name] || "").trim();
    const phoneRaw = mapping._phones.length ? firstNonEmpty(row, mapping._phones)
                   : (mapping.phone != null ? (row[mapping.phone] || "").trim() : "");
    let email = mapping._emails.length ? firstNonEmpty(row, mapping._emails)
              : (mapping.email != null ? (row[mapping.email] || "").trim() : "");
    email = email.toLowerCase();
    if (email && !validEmail(email)) email = "";
    const company = mapping.company != null ? (row[mapping.company] || "").trim() : "";
    const states = mapping.state != null ? normalizeState(row[mapping.state]) : "";
    const extraNote = mapping.notes != null ? (row[mapping.notes] || "").trim() : "";
    if (!name && company) name = company;
    if (!name && (phoneRaw || email)) name = email || phoneRaw;
    out.push({ name: name.trim(), phone: phoneRaw.trim(), email, company, states, notes: extraNote });
  }
  return out;
}

// Split parsed rows against `existing` (anything with .phone/.email) into
// fresh / dupes / invalid. Dedupes against the existing list AND within the
// file itself — a CSV that lists the same person twice is common.
function classifyImport(parsedRows, existing) {
  const exPhones = new Set((existing || []).map(b => digitsOnly(b.phone)).filter(Boolean));
  const exEmails = new Set((existing || []).map(b => (b.email || "").toLowerCase()).filter(Boolean));
  const seenPhones = new Set(), seenEmails = new Set();
  const fresh = [], dupes = [], invalid = [];
  for (const r of parsedRows) {
    const pd = digitsOnly(r.phone);
    const em = r.email;
    if (!r.name && !pd && !em) { invalid.push(r); continue; }
    if (!pd && !em) { invalid.push(r); continue; }
    if ((pd && exPhones.has(pd)) || (em && exEmails.has(em)) ||
        (pd && seenPhones.has(pd)) || (em && seenEmails.has(em))) { dupes.push(r); continue; }
    if (pd) seenPhones.add(pd);
    if (em) seenEmails.add(em);
    fresh.push(r);
  }
  return { fresh, dupes, invalid };
}
