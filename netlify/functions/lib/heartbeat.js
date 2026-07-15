// Heartbeat log for the scheduled sync functions. Every run writes a
// sync_runs row (ok/error + a short summary). On the SECOND consecutive
// failure of the same function it emails NOTIFY_EMAIL — one alert per failure
// streak, so a single blip stays quiet but a dead sync gets noticed.
//
// logSyncRun never throws: a broken heartbeat must not break the sync it's
// reporting on (including before the 025_sync_runs.sql migration has run).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";

async function sb(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} -> ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function alertFailureStreak(fn, detail) {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [NOTIFY_EMAIL],
      subject: `⚠️ ${fn} is failing (2+ runs in a row)`,
      html: `<p><b>${fn}</b> has now failed twice in a row. Latest error:</p>
             <pre style="background:#f7fafc;padding:12px;border-radius:8px">${String(detail).replace(/</g, "&lt;")}</pre>
             <p>Check the Netlify function logs. No further alerts will be sent until it recovers and fails again.</p>`,
    }),
  });
}

async function logSyncRun(fn, status, detail = "") {
  try {
    // Read the two prior runs BEFORE inserting, so "prior" means previous runs.
    const prior = status === "error"
      ? await sb(`/sync_runs?fn=eq.${encodeURIComponent(fn)}&select=status&order=ran_at.desc&limit=2`, { method: "GET" })
      : null;

    await sb(`/sync_runs`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ fn, status, detail: String(detail).slice(0, 500) }),
    });

    // Alert exactly once per streak: this failure is the 2nd consecutive one.
    if (
      status === "error" &&
      prior && prior[0] && prior[0].status === "error" &&
      (!prior[1] || prior[1].status !== "error")
    ) {
      await alertFailureStreak(fn, detail);
    }
  } catch (e) {
    console.warn(`heartbeat (${fn}) failed:`, e.message);
  }
}

module.exports = { logSyncRun };
