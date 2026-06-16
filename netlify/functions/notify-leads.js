/**
 * notify-leads — called by buyer_scraper.py after inserting new leads.
 * Sends a summary email to the owner so they know new hot buyers are waiting.
 *
 * POST body: { count: number, deals: [{deal_id, deal_address, leads: [{name,phone,email,score}]}] }
 */
const RESEND_API = "https://api.resend.com/emails";
const GMAIL_API  = "https://www.googleapis.com/gmail/v1/users/me/messages/send";

const NOTIFY_TO   = "zach.kempe2025@gmail.com";
const NOTIFY_FROM = process.env.RESEND_FROM || "Seaside Horizon <deals@seasidehorizon.com>";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  const { count = 0, deals = [] } = payload;
  if (!count) return { statusCode: 200, body: JSON.stringify({ skipped: true }) };

  const subject = `🔥 ${count} new hot buyer${count === 1 ? "" : "s"} on InvestorLift`;

  // Build deal sections for the email body.
  const dealSections = deals.map(d => {
    const label = d.deal_address || `Deal #${d.deal_id}`;
    const rows = (d.leads || []).slice(0, 10).map(l => {
      const score = l.score ? `🔥 ${Number(l.score).toLocaleString()}` : "";
      const contact = [l.phone, l.email].filter(Boolean).join(" · ");
      return `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(l.name)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;color:#555">${esc(contact)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${score}</td>
      </tr>`;
    }).join("");
    const more = d.leads.length > 10
      ? `<p style="color:#888;font-size:0.85em">…and ${d.leads.length - 10} more</p>` : "";
    return `
      <h3 style="margin:24px 0 8px;color:#1a3a5c">🏠 ${esc(label)} <span style="font-weight:400;font-size:0.85em;color:#666">(${d.leads.length} new)</span></h3>
      <table style="width:100%;border-collapse:collapse;font-size:0.9em">
        <thead><tr style="background:#f0f4f8">
          <th style="padding:4px 8px;text-align:left">Name</th>
          <th style="padding:4px 8px;text-align:left">Contact</th>
          <th style="padding:4px 8px;text-align:right">Score</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>${more}`;
  }).join("");

  const html = `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a3a5c;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;color:#fff">Seaside Horizon — New Leads</h2>
      </div>
      <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px">
        <p style="font-size:1.1em;margin-top:0">
          <strong>${count} new hot buyer${count === 1 ? "" : "s"}</strong> just landed in your
          <a href="https://seaside-dispo-app.netlify.app/leads.html" style="color:#1a3a5c">Leads tab</a>.
        </p>
        ${dealSections}
        <div style="margin-top:28px;text-align:center">
          <a href="https://seaside-dispo-app.netlify.app/leads.html"
             style="background:#1a3a5c;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">
            View Leads →
          </a>
        </div>
      </div>
    </div>`;

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const res = await fetch(RESEND_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
        body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], subject, html }),
      });
      if (res.ok) return { statusCode: 200, body: JSON.stringify({ sent: "resend" }) };
    } catch (e) { console.error("Resend failed:", e.message); }
  }

  // Gmail fallback.
  const gmailToken = process.env.GMAIL_ACCESS_TOKEN;
  if (gmailToken) {
    try {
      const raw = Buffer.from(
        `To: ${NOTIFY_TO}\r\nFrom: ${NOTIFY_FROM}\r\nSubject: ${subject}\r\n` +
        `MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
      ).toString("base64url");
      await fetch(GMAIL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gmailToken}` },
        body: JSON.stringify({ raw }),
      });
      return { statusCode: 200, body: JSON.stringify({ sent: "gmail" }) };
    } catch (e) { console.error("Gmail failed:", e.message); }
  }

  return { statusCode: 500, body: "No email sender configured" };
};

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
