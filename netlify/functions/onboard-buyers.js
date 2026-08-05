// On-demand "Request buy-box" function — triggered from the Buyer Dashboard.
// Sends buyers a short message asking what they're buying, linking to the
// public buyer intake form. Their answers flow back into the CRM via
// sync-buyers.js, enriching states / price / strategy so future blasts only
// hit real matches.
//
// B4.2 — this used to be ONE email, ever: onboarded_at was set on the first
// send and that buyer was never asked again, so everyone who ignored the first
// email stayed a wildcard (matching every deal) forever. It is now a short
// sequence of up to ONBOARD_TOUCHES asks, spaced by TOUCH_GAP_DAYS, with the
// last one going out as an SMS when the buyer is textable — a different
// channel is the whole point of a third touch.
//
// Safety rails, in order of how much they matter:
//   • Anyone whose buy box is already complete is dropped from the sequence —
//     we stop asking the moment they've answered.
//   • Spacing is enforced per buyer from their own last touch, so clicking the
//     button twice in a day can't double-send.
//   • Email honors opt-out + hard bounce; SMS honors sms_opt_in AND the
//     sms_suppressions STOP list, and every text carries opt-out language.
//   • Only successful sends are recorded, so failures retry on the next run.
//   • preview mode reports exactly what would go out and sends nothing.
//
// Fails soft when migration 033 hasn't run: without the sequence columns it
// degrades to the old one-email-ever behavior rather than erroring.
//
// Auth: requires the caller's Supabase access token (the logged-in user).

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SB_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM_ADDRESS = process.env.GMAIL_FROM_ADDRESS || "";
const GMAIL_FROM_NAME = process.env.GMAIL_FROM_NAME || "Seaside Horizon";
const GMAIL_REPLY_TO = process.env.GMAIL_REPLY_TO || GMAIL_FROM_ADDRESS;

// Default = the live buyer questionnaire (the site NETLIFY_FORMS_SITE_ID
// points at, same URL buyers.html shares). The old nimble-scone-f6b3c4
// default 404s — never point back at it.
const FORM_URL = process.env.BUYER_FORM_URL || "https://seaside-buyer-questionnaire.netlify.app/";
// Derived from PUBLIC_SITE_URL like deck.js and blast-core.js do, so a custom
// domain reaches this email too. Hardcoding the netlify.app host left the logo
// in buy-box request emails pointing at a different domain than every link
// beside it — mail clients treat that mismatch as a spam signal.
const SITE_URL = (process.env.PUBLIC_SITE_URL || "https://seaside-dispo-app.netlify.app").replace(/\/+$/, "");
const LOGO_URL = `${SITE_URL}/img/logo.png`;
const BRAND_NAVY = "#1B3A6B";
const BRAND_NAVY_DARK = "#112950";
const CONTACT_NAME = process.env.MARKETING_CONTACT_NAME || "Zach — Seaside Horizon";
const EMAIL_CONCURRENCY = 25;

// CAN-SPAM: a marketing sequence needs an opt-out and a postal address.
const CONTACT_ADDRESS = process.env.MARKETING_POSTAL_ADDRESS || "";

const { fetchAllRows } = require("./lib/fetch-all");
const { unsubUrlFor } = require("./lib/unsub");
const { sendSms, smsConfigured } = require("./lib/ghl-sms");
const { suppressedPhoneDigits } = require("./lib/sms-optout");
const { digitsOnly } = require("./lib/capture");
// buyBoxCompleteness is the same classifier the buyers page and the blast
// modal use — "who still needs asking" has to mean the same thing everywhere.
const { buyBoxCompleteness } = require("../../public/js/deal-shared");
// The sequence: at most ONBOARD_TOUCHES asks, each at least TOUCH_GAP_DAYS
// after that buyer's own previous one. Touch 3 goes out as a text when we're
// allowed to text them — a fourth email from the same sender is just noise.
// Scheduling is pure and lives in lib (tests/onboard-sequence.test.js).
const { dueTouch, touchesOf, ONBOARD_TOUCHES } = require("./lib/onboard-sequence");

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}`,
      "Content-Type": "application/json", ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function verifyUser(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function firstName(name) {
  const n = (name || "").trim().split(/\s+/)[0];
  return n && !/@/.test(n) ? n : "there";
}

// Per-touch copy. Touch 1 is the original email, unchanged. The follow-ups
// get shorter and more direct, and the last one says outright that it's the
// last one — a sequence that never admits it's a sequence reads as spam.
const EMAIL_TOUCHES = {
  1: {
    subject: "Quick question — what are you buying right now?",
    lead: `You're on Seaside Horizon's cash-buyer list — we move creative-finance and
        discounted deals across the country. So we only send you deals you'd actually
        close on, give us your buy box. Takes about 60 seconds:`,
    cta: "Tell us what you're buying →",
    tail: `States, price range, property types, cash vs. creative — whatever fits your
        criteria. Or just reply to this email and tell me directly.`,
  },
  2: {
    subject: "Following up — what's your buy box?",
    lead: `Circling back on this one. Right now I don't know your criteria, so you're
        getting every deal we run instead of the ones you'd actually close. Sixty
        seconds fixes that:`,
    cta: "Send me your criteria →",
    tail: `Even a one-liner works — "SFH in FL/GA under $300k, creative only" is
        plenty. Reply to this email if that's easier.`,
  },
  3: {
    subject: "Last check — should I keep sending you deals?",
    lead: `Last one from me on this. If you tell me what you're buying, I'll only send
        deals that fit. If I don't hear back, I'll leave you on the general list and
        stop asking:`,
    cta: "Two minutes, then I'm done asking →",
    tail: `Or just reply with the states and price range you're in.`,
  },
};

function buildEmail(buyer, touch = 1) {
  const copy = EMAIL_TOUCHES[touch] || EMAIL_TOUCHES[1];
  const hi = escapeHtml(firstName(buyer.name));
  // One ask was arguably a courtesy; a sequence is marketing email, so it
  // carries the same unsubscribe the blasts do (same token, same function).
  const unsubUrl = buyer.id ? unsubUrlFor(buyer.id) : "";
  const footer = unsubUrl
    ? `<p style="font-size:11px;color:#A0AEC0;text-align:center;margin:16px 0 0">
         <a href="${escapeHtml(unsubUrl)}" style="color:#A0AEC0">Unsubscribe</a>
         from Seaside Horizon emails${CONTACT_ADDRESS ? ` · ${escapeHtml(CONTACT_ADDRESS)}` : ""}
       </p>`
    : "";
  return `
  <div style="max-width:540px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#2D3748">
    <div style="background:${BRAND_NAVY_DARK};padding:18px 24px;border-radius:10px 10px 0 0">
      <img src="${LOGO_URL}" alt="Seaside Horizon" height="34" style="display:block">
    </div>
    <div style="border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">Hey ${hi},</p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 14px">
        ${copy.lead}
      </p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escapeHtml(FORM_URL)}" style="background:${BRAND_NAVY};color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:8px;display:inline-block">${escapeHtml(copy.cta)}</a>
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 14px;color:#4A5568">
        ${copy.tail}
      </p>
      <p style="font-size:15px;line-height:1.6;margin:18px 0 0">— ${escapeHtml(CONTACT_NAME)}</p>
    </div>
    ${footer}
  </div>`;
}

// The SMS variant. Short, names who it's from (they may never have opened an
// email from us), and carries the opt-out language every outbound text needs.
function buildSms(buyer) {
  const hi = firstName(buyer.name);
  return `Hey ${hi} — ${CONTACT_NAME.split("—")[0].trim()} with Seaside Horizon. `
    + `You're on our buyer list but I don't have your criteria, so you're getting every deal instead of the right ones. `
    + `What are you buying? 60-sec form: ${FORM_URL} — or just text me back.\n\nReply STOP to opt out.`;
}

async function sendViaResend(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
}

async function gmailAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Gmail token refresh failed: ${r.status}`);
  return (await r.json()).access_token;
}
async function sendViaGmail(token, to, subject, html) {
  const headers = [
    `From: ${GMAIL_FROM_NAME} <${GMAIL_FROM_ADDRESS}>`, `To: ${to}`,
    `Reply-To: ${GMAIL_REPLY_TO}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`,
    `MIME-Version: 1.0`, `Content-Type: text/html; charset="UTF-8"`,
  ];
  const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${html}`, "utf-8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send -> ${r.status}: ${await r.text()}`);
}

// Has migration 033 run? Without the sequence columns we cannot record which
// touch a buyer has had, and a sequence we can't record is a sequence that
// re-sends the same follow-up every run — so we fall back to touch 1 only.
async function hasSequenceColumns() {
  try {
    await sb(`/buyers?select=onboard_touches&limit=1`, { method: "GET" });
    return true;
  } catch (e) {
    console.warn("onboard sequence columns missing (033 not run?):", e.message);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };
  const user = await verifyUser(event.headers.authorization || event.headers.Authorization);
  if (!user) return { statusCode: 401, body: "Unauthorized" };

  const useResend = !!(RESEND_API_KEY && RESEND_FROM);
  const smsOk = smsConfigured();
  if (!useResend && (!GMAIL_CLIENT_ID || !GMAIL_REFRESH_TOKEN) && !smsOk) {
    return { statusCode: 500, body: JSON.stringify({ error: "No email or SMS provider configured" }) };
  }
  const emailOk = useResend || !!(GMAIL_CLIENT_ID && GMAIL_REFRESH_TOKEN);

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const isTest = !!body.test;
  const isPreview = !!body.preview;

  try {
    // TEST: one message to the caller, no DB writes. `test_touch` previews a
    // specific step's copy; channel:"sms" previews the text instead.
    if (isTest) {
      const touch = Math.min(Math.max(Number(body.test_touch) || 1, 1), ONBOARD_TOUCHES);
      if (body.channel === "sms") {
        const to = (body.test_phone || "").trim();
        if (!smsOk) return { statusCode: 400, body: JSON.stringify({ error: "GHL SMS not configured" }) };
        if (!to) return { statusCode: 400, body: JSON.stringify({ error: "No test phone number" }) };
        await sendSms(to, `[TEST] ${buildSms({ name: "" })}`);
        return { statusCode: 200, body: JSON.stringify({ test: true, channel: "sms", to }) };
      }
      const to = (body.test_email || user.email || "").trim();
      if (!emailOk) return { statusCode: 400, body: JSON.stringify({ error: "No email provider configured" }) };
      if (!to) return { statusCode: 400, body: JSON.stringify({ error: "No test address" }) };
      const subject = (EMAIL_TOUCHES[touch] || EMAIL_TOUCHES[1]).subject;
      const html = buildEmail({ name: "" }, touch);
      if (useResend) await sendViaResend(to, `[TEST] ${subject}`, html);
      else await sendViaGmail(await gmailAccessToken(), to, `[TEST] ${subject}`, html);
      return { statusCode: 200, body: JSON.stringify({ test: true, channel: "email", touch, to }) };
    }

    // ── Build the due list ──
    const seqCols = await hasSequenceColumns();
    // Without 033 the sequence can't be tracked, so nobody gets a 2nd ask.
    const maxTouches = seqCols ? ONBOARD_TOUCHES : 1;

    // select=* rather than a column list: the sequence columns may not exist
    // yet, and PostgREST 400s on selecting a column it doesn't have. Paged —
    // this is the whole buyer table.
    let filter = "/buyers?active=eq.true&select=*";
    if (Array.isArray(body.buyer_ids) && body.buyer_ids.length) {
      filter += `&id=in.(${body.buyer_ids.map(Number).filter(Boolean).join(",")})`;
    } else if (body.source) {
      filter += `&list_source=eq.${encodeURIComponent(body.source)}`;
    }
    const all = await fetchAllRows(p => sb(p, { method: "GET" }), filter);

    // Reachability. Email honors opt-out + hard bounce (031); SMS honors
    // opt-in AND the STOP list (032) — sms_opt_in alone can't cover a STOP
    // that matched no buyer row.
    const suppressed = smsOk ? await suppressedPhoneDigits(sb) : new Set();
    const canEmail = (b) => !!(emailOk && b.email && /@/.test(b.email) && b.email_opt_out !== true && !b.email_bounced_at);
    const canSms = (b) => !!(smsOk && b.sms_opt_in && b.phone && !suppressed.has(digitsOnly(b.phone)));
    // The last touch of the full sequence is the text — a different channel
    // is the point of it. Keyed off ONBOARD_TOUCHES, not maxTouches: when 033
    // hasn't run maxTouches is 1, and that must not turn the FIRST ask into a
    // text for everyone with a phone.
    const channelFor = (b, touch) => {
      if (touch >= ONBOARD_TOUCHES && canSms(b)) return "sms";
      if (canEmail(b)) return "email";
      if (canSms(b)) return "sms";
      return null;
    };

    const now = Date.now();
    const targets = [];
    const skipped = { box_complete: 0, not_due: 0, sequence_finished: 0, unreachable: 0 };
    for (const b of all) {
      const touch = dueTouch(b, now, maxTouches);
      if (!touch) {
        if (buyBoxCompleteness(b) === "full") skipped.box_complete++;
        else if (touchesOf(b) >= maxTouches) skipped.sequence_finished++;
        else skipped.not_due++;
        continue;
      }
      const channel = channelFor(b, touch);
      if (!channel) { skipped.unreachable++; continue; }
      targets.push({ buyer: b, touch, channel });
    }

    const plan = { touch1: 0, touch2: 0, touch3: 0, email: 0, sms: 0 };
    for (const t of targets) { plan[`touch${t.touch}`]++; plan[t.channel]++; }
    const note = seqCols ? undefined : "Migration 033 hasn't run — first-touch only, no follow-ups.";

    // PREVIEW: report the plan, send nothing.
    if (isPreview) {
      return { statusCode: 200, body: JSON.stringify({ preview: true, due: targets.length, plan, skipped, note }) };
    }
    if (!targets.length) {
      return { statusCode: 200, body: JSON.stringify({ sent: 0, failed: 0, plan, skipped, note: note || "Nobody is due for a buy-box request right now." }) };
    }

    // ── Send ──
    let sent = 0, failed = 0;
    const sentByChannel = { email: 0, sms: 0 };
    // Successful sends only, grouped by the touch number to write back.
    const doneByTouch = { 1: [], 2: [], 3: [] };
    const doneChannel = {};

    const emailTargets = targets.filter(t => t.channel === "email");
    const smsTargets = targets.filter(t => t.channel === "sms");

    if (emailTargets.length) {
      const token = useResend ? null : await gmailAccessToken();
      for (let i = 0; i < emailTargets.length; i += EMAIL_CONCURRENCY) {
        const chunk = emailTargets.slice(i, i + EMAIL_CONCURRENCY);
        await Promise.all(chunk.map(async ({ buyer: b, touch }) => {
          try {
            const subject = (EMAIL_TOUCHES[touch] || EMAIL_TOUCHES[1]).subject;
            const html = buildEmail(b, touch);
            if (useResend) await sendViaResend(b.email, subject, html);
            else await sendViaGmail(token, b.email, subject, html);
            sent++; sentByChannel.email++;
            doneByTouch[touch].push(b.id); doneChannel[b.id] = "email";
          } catch (e) { failed++; console.error("onboard email failed:", b.email, e.message); }
        }));
      }
    }
    // Texts go one at a time (GHL upserts a contact per send).
    for (const { buyer: b, touch } of smsTargets) {
      try {
        await sendSms(b.phone, buildSms(b));
        sent++; sentByChannel.sms++;
        doneByTouch[touch].push(b.id); doneChannel[b.id] = "sms";
      } catch (e) { failed++; console.error("onboard sms failed:", b.phone, e.message); }
    }

    // ── Record, so the next run picks up where this one left off ──
    // Only successful sends are stamped: a failure stays due and retries.
    const stampedAt = new Date().toISOString();
    for (const touch of [1, 2, 3]) {
      const ids = doneByTouch[touch];
      if (!ids.length) continue;
      // Group by channel so onboard_last_channel is accurate per row.
      for (const channel of ["email", "sms"]) {
        const group = ids.filter(id => doneChannel[id] === channel);
        if (!group.length) continue;
        const patch = { onboarded_at: stampedAt };
        if (seqCols) {
          patch.onboard_touches = touch;
          patch.onboard_last_at = stampedAt;
          patch.onboard_last_channel = channel;
        }
        // onboarded_at means "first asked" — don't move it on a follow-up.
        if (touch > 1) delete patch.onboarded_at;
        try {
          await sb(`/buyers?id=in.(${group.join(",")})`,
            { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
        } catch (e) {
          console.error(`onboard stamp failed (touch ${touch}, ${channel}):`, e.message);
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ sent, failed, plan, by_channel: sentByChannel, skipped, esp: useResend ? "resend" : "gmail", note }),
    };
  } catch (err) {
    console.error("onboard-buyers error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
