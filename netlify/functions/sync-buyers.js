// Scheduled function — runs every 5 minutes.
// Pulls new "buyer-intake" submissions from the Netlify Forms API (the
// public buyer questionnaire) and inserts them into Supabase as buyers,
// deduping against existing phone/email. Mirrors the logic that used to
// live in netlify_sync.py, but writes straight to the hosted database.

const NAME_TO_ABBR = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",
  illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",
  maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",
  pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA",
  "west virginia":"WV",wisconsin:"WI",wyoming:"WY",
};
const VALID_ABBR = new Set(Object.values(NAME_TO_ABBR));

function parseStates(raw) {
  const out = [];
  for (let part of (raw || "").replace(/;/g, ",").split(",")) {
    part = part.trim();
    if (!part) continue;
    if (VALID_ABBR.has(part.toUpperCase())) out.push(part.toUpperCase());
    else if (NAME_TO_ABBR[part.toLowerCase()]) out.push(NAME_TO_ABBR[part.toLowerCase()]);
  }
  return [...new Set(out)].join(",");
}

function parseStrategy(raw) {
  const r = (raw || "").toLowerCase().trim();
  if (r.includes("all")) return "all";
  if (r.includes("morby") || r.includes("stack")) return "morby";
  if (r.includes("subject")) return "subto";
  if (r.includes("seller") || r.includes("owner") || r.includes("finance")) return "owner_finance";
  if (r.includes("cash")) return "cash";
  return "all";
}

function parseInt0(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

function cleanPhone(raw) {
  return String(raw || "").replace(/[^\d+]/g, "");
}

function digitsOnly(phone) {
  return String(phone || "").replace(/\D/g, "").replace(/^1/, "");
}

async function sb(path, opts, sbUrl, sbKey) {
  const r = await fetch(`${sbUrl}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      "Content-Type": "application/json",
      ...(opts?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

exports.handler = async () => {
  const NETLIFY_TOKEN = process.env.NETLIFY_ACCESS_TOKEN;
  const SITE_ID       = process.env.NETLIFY_FORMS_SITE_ID;
  const FORM_NAME     = process.env.NETLIFY_FORM_NAME || "buyer-intake";
  const SB_URL        = process.env.SUPABASE_URL;
  const SB_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    // 1. Find the form ID
    const formsRaw = await (await fetch(
      `https://api.netlify.com/api/v1/sites/${SITE_ID}/forms`,
      { headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` } }
    )).json();
    const forms = Array.isArray(formsRaw) ? formsRaw : (formsRaw.forms || []);
    const form = forms.find(f => f.name === FORM_NAME);
    if (!form) throw new Error(`Form '${FORM_NAME}' not found on site ${SITE_ID}`);

    // 2. Fetch submissions
    const submissions = await (await fetch(
      `https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=1000`,
      { headers: { Authorization: `Bearer ${NETLIFY_TOKEN}` } }
    )).json();

    // 3. Existing buyers (for dedupe)
    const existing = await sb(`/buyers?select=phone,email`, { method: "GET" }, SB_URL, SB_KEY);
    const exPhones = new Set(existing.map(b => digitsOnly(b.phone)).filter(Boolean));
    const exEmails = new Set(existing.map(b => (b.email || "").toLowerCase()).filter(Boolean));

    let added = 0;
    for (const sub of submissions) {
      const data = sub.data || sub.ordered || {};
      const name = (data.name || "").trim();
      if (!name) continue;

      const email = (data.email || "").trim().toLowerCase();
      const phone = cleanPhone(data.phone);
      const phoneDigits = digitsOnly(phone);

      if (phoneDigits && exPhones.has(phoneDigits)) continue;
      if (email && exEmails.has(email)) continue;

      const states   = parseStates(data.states);
      const strategy = parseStrategy(data.strategy);
      const maxPiti  = parseInt0(data.max_piti || data.sf_max_piti);
      const maxEntry = parseInt0(data.max_entry_fee);
      const minBeds  = parseInt0(data.min_beds || data.sf_min_beds || data.cash_min_beds);
      const smsConsent = ["yes","true","1","on"].includes(String(data.sms_consent || "").toLowerCase());

      const noteParts = [];
      if (data.company)          noteParts.push(`Company: ${data.company}`);
      if (data.close_speed)      noteParts.push(`Close speed: ${data.close_speed}`);
      if (data.active_status)    noteParts.push(`Status: ${data.active_status}`);
      if (data.referral_source)  noteParts.push(`Referral: ${data.referral_source}`);
      if (data.has_sreo)         noteParts.push(`SREO: ${data.has_sreo}`);
      if (data.stack_deals_done) noteParts.push(`Stack deals done: ${data.stack_deals_done}`);
      if (data.prop_type)        noteParts.push(`Property types: ${data.prop_type}`);
      if (maxEntry)              noteParts.push(`Max entry fee: $${maxEntry.toLocaleString()}`);

      await sb(`/buyers`, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          name, email, phone, states,
          max_price: 0, max_piti: maxPiti, min_beds: minBeds,
          strategy, tier: "B", list_source: "investor",
          active: true, sms_opt_in: smsConsent,
          notes: noteParts.join(" | "),
        }),
      }, SB_URL, SB_KEY);

      if (phoneDigits) exPhones.add(phoneDigits);
      if (email) exEmails.add(email);
      added++;
    }

    console.log(`sync-buyers: added ${added} new buyer(s) of ${submissions.length} submissions`);
    return { statusCode: 200, body: `added ${added} new buyer(s)` };
  } catch (err) {
    console.error("sync-buyers error:", err.message);
    return { statusCode: 500, body: err.message };
  }
};
