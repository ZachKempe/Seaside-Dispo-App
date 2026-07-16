// F9 — Weekly digest. Scheduled (Mondays, see netlify.toml). Emails NOTIFY_EMAIL
// a one-glance rollup of the last 7 days so nobody has to remember to open the
// Reports page. Everything here is a coarser server-side echo of what
// public/js/reports.js renders in the browser — this function only counts, it
// doesn't own any new metric logic.
//
// Fails soft: any query/send error is logged to sync_runs (heartbeat) and the
// run returns 200-ish so a broken digest never pages anyone. Skips cleanly when
// Resend isn't configured or the tables don't exist yet.

const { sb } = require("./lib/capture");
const { fetchAllRows } = require("./lib/fetch-all");
const { logSyncRun } = require("./lib/heartbeat");

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || process.env.GMAIL_FROM_ADDRESS || "";
const SITE_URL = (process.env.PUBLIC_SITE_URL || "").replace(/\/+$/, "");

const get = (path, order) => fetchAllRows((p) => sb(p, { method: "GET" }), path, order ? { order } : undefined);
const esc = (s) => String(s).replace(/</g, "&lt;");

async function sendDigest(html, subject) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: RESEND_FROM, to: [NOTIFY_EMAIL], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend -> ${r.status}: ${await r.text()}`);
}

exports.handler = async () => {
  if (!RESEND_API_KEY || !RESEND_FROM || !NOTIFY_EMAIL) {
    return { statusCode: 200, body: "Digest skipped — Resend/NOTIFY_EMAIL not configured" };
  }
  try {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();

    const [recips, events, views, leads, newBuyers, openLeads] = await Promise.all([
      get(`/blast_recipients?blasted_at=gte.${since}&select=channel,status`),
      get(`/email_events?created_at=gte.${since}&select=event`),
      get(`/deck_views?viewed_at=gte.${since}&select=kind`),
      get(`/deal_leads?created_at=gte.${since}&select=stage`),
      get(`/buyers?date_added=gte.${since}&select=id`),
      get(`/deal_leads?stage=in.(new,responded,interested,offer,under_contract)&select=stage`),
    ]);

    const count = (rows, pred) => rows.filter(pred).length;
    const emailSent = count(recips, (r) => r.channel === "email" && r.status === "sent");
    const emailFail = count(recips, (r) => r.channel === "email" && r.status === "failed");
    const smsSent = count(recips, (r) => r.channel === "sms" && r.status === "sent");
    const smsFail = count(recips, (r) => r.channel === "sms" && r.status === "failed");

    const ev = (name) => count(events, (e) => e.event === name);
    const opened = ev("opened"), clicked = ev("clicked"), bounced = ev("bounced"), complained = ev("complained");

    const pageViews = count(views, (v) => v.kind !== "pdf");
    const pdfs = count(views, (v) => v.kind === "pdf");

    const hotLeads = count(leads, (l) => ["interested", "offer", "under_contract", "closed"].includes(l.stage));

    const stageOrder = ["new", "responded", "interested", "offer", "under_contract"];
    const stageLabel = { new: "New", responded: "Responded", interested: "Interested", offer: "Offer", under_contract: "Under contract" };
    const pipeline = stageOrder
      .map((s) => ({ s, n: count(openLeads, (l) => l.stage === s) }))
      .filter((x) => x.n > 0);

    const row = (label, value, note = "") =>
      `<tr><td style="padding:6px 14px 6px 0;color:#4A5568">${esc(label)}</td>` +
      `<td style="padding:6px 0;font-weight:700;text-align:right">${esc(value)}</td>` +
      `<td style="padding:6px 0 6px 14px;color:#718096;font-size:13px">${esc(note)}</td></tr>`;

    const emailNote = emailFail ? `${emailFail} failed` : "";
    const smsNote = smsFail ? `${smsFail} failed` : "";
    const engNote = [bounced ? `${bounced} bounced` : "", complained ? `${complained} complaints` : ""].filter(Boolean).join(" · ");

    const pipelineHtml = pipeline.length
      ? pipeline.map((x) => `${esc(stageLabel[x.s])}: <b>${x.n}</b>`).join(" &nbsp;·&nbsp; ")
      : "no open leads";

    const totalActivity = emailSent + smsSent + opened + clicked + pageViews + leads.length + newBuyers.length;
    const heading = totalActivity === 0 ? "Quiet week — no blast or engagement activity" : "Last 7 days";

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1A202C">
        <h2 style="margin:0 0 4px">Seaside Dispo — weekly digest</h2>
        <p style="margin:0 0 18px;color:#718096;font-size:14px">${esc(heading)}</p>
        <table style="border-collapse:collapse;width:100%;font-size:15px">
          ${row("Email blasts sent", emailSent, emailNote)}
          ${row("SMS blasts sent", smsSent, smsNote)}
          ${row("Email opens", opened)}
          ${row("Email clicks", clicked, engNote)}
          ${row("Deck page views", pageViews)}
          ${row("PDF downloads", pdfs)}
          ${row("New leads captured", leads.length, hotLeads ? `${hotLeads} interested+` : "")}
          ${row("New buyers added", newBuyers.length)}
        </table>
        <p style="margin:18px 0 4px;font-weight:700">Pipeline right now</p>
        <p style="margin:0 0 18px;font-size:14px;color:#2D3748">${pipelineHtml}</p>
        ${SITE_URL ? `<p style="margin:0"><a href="${esc(SITE_URL)}/reports.html" style="color:#2B6CB0">Open full Reports →</a></p>` : ""}
        <p style="margin:22px 0 0;color:#A0AEC0;font-size:12px">Automated weekly digest · Seaside Dispo</p>
      </div>`;

    await sendDigest(html, `Seaside weekly digest — ${emailSent + smsSent} blasts, ${leads.length} new leads`);

    const summary = `weekly-digest: ${emailSent} email + ${smsSent} sms sent, ${opened} opens, ${leads.length} new leads, ${newBuyers.length} new buyers`;
    console.log(summary);
    await logSyncRun("weekly-digest", "ok", summary);
    return { statusCode: 200, body: summary };
  } catch (err) {
    console.error("weekly-digest error:", err.message);
    await logSyncRun("weekly-digest", "error", err.message);
    return { statusCode: 500, body: err.message };
  }
};
