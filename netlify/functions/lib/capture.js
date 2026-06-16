// Shared capture core for C1 (auto-capture responders).
// Lives in a subdirectory so Netlify does NOT treat it as its own function —
// it's a module required by capture-replies.js (email) and ghl-inbound.js (SMS).
//
// captureResponder() turns an inbound reply into CRM value:
//   1. find or create the buyer (new ones tagged list_source = "responder"),
//   2. log a buyer_activity touch,
//   3. if we know which deal it's about, create/advance a deal_leads pipeline row.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

function digitsOnly(p) {
  return String(p || "").replace(/\D/g, "").replace(/^1/, "");
}

// Idempotency: record a message id. Returns true if this is the FIRST time we've
// seen it (fresh), false if it was already processed. Relies on the primary-key
// conflict + ignore-duplicates (a conflict returns no representation row).
async function markSeen(messageId, channel) {
  if (!messageId) return true;
  const r = await fetch(`${SB_URL}/rest/v1/inbound_messages?on_conflict=message_id`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify({ message_id: messageId, channel }),
  });
  if (!r.ok) throw new Error(`inbound_messages insert -> ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function findBuyer(email, phone) {
  const e = (email || "").trim().toLowerCase();
  if (e) {
    const rows = await sb(`/buyers?email=eq.${encodeURIComponent(e)}&select=*&limit=1`, { method: "GET" });
    if (rows && rows[0]) return rows[0];
  }
  const pd = digitsOnly(phone);
  if (pd) {
    // Phones are stored in varied formats; compare on digits in code.
    const rows = await sb(`/buyers?select=id,name,email,phone,strategy,tier,sms_opt_in&phone=neq.`, { method: "GET" });
    const hit = (rows || []).find((b) => digitsOnly(b.phone) === pd);
    if (hit) return hit;
  }
  return null;
}

async function captureResponder({ channel, name, email, phone, cardId, address, snippet }) {
  email = (email || "").trim().toLowerCase();
  phone = (phone || "").trim();
  const note = (snippet || "").replace(/\s+/g, " ").trim().slice(0, 500);

  let buyer = await findBuyer(email, phone);
  let isNewBuyer = false;

  if (!buyer) {
    const created = await sb(`/buyers`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        name: name || email || phone || "Unknown responder",
        email, phone,
        strategy: "all", states: "",
        max_price: 0, max_piti: 0, min_beds: 0,
        tier: "B", list_source: "responder", active: true, sms_opt_in: false,
        notes: `Auto-captured from ${channel} reply${address ? ` re: ${address}` : ""}`,
      }),
    });
    buyer = created && created[0];
    isNewBuyer = true;
  }
  if (!buyer) return { ok: false, reason: "could not create buyer" };

  // 2. Activity touch (works with or without a known deal).
  await sb(`/buyer_activity`, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      buyer_id: buyer.id, card_id: cardId || "", address: address || "",
      channel, detail: note || `Inbound ${channel} reply`,
    }),
  });

  // 3. Pipeline lead — only when we can attribute the reply to a specific deal.
  let leadCreated = false, leadBumped = false;
  if (cardId) {
    const existing = await sb(
      `/deal_leads?card_id=eq.${encodeURIComponent(cardId)}&buyer_id=eq.${buyer.id}&select=id,stage&limit=1`,
      { method: "GET" }
    );
    if (existing && existing[0]) {
      if (existing[0].stage === "new") {
        await sb(`/deal_leads?id=eq.${existing[0].id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ stage: "responded" }),
        });
        leadBumped = true;
      }
    } else {
      await sb(`/deal_leads`, {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          card_id: cardId, address: address || "", buyer_id: buyer.id,
          name: buyer.name || name || "Responder",
          contact: email || phone || "",
          source: "buyer_blast", channel, stage: "responded", notes: note,
        }),
      });
      leadCreated = true;
    }
  }

  return { ok: true, buyerId: buyer.id, isNewBuyer, leadCreated, leadBumped };
}

module.exports = { sb, markSeen, captureResponder, digitsOnly };
