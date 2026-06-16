// D1 — One-click unsubscribe target referenced by the List-Unsubscribe header
// and the email footer. Verifies a signed per-buyer token, flips email_opt_out,
// and shows a small confirmation page. Supports RFC 8058 one-click POST too.

const crypto = require("crypto");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UNSUB_SECRET = process.env.UNSUB_SECRET || SB_KEY || "seaside-unsub";

function verifyToken(token) {
  const [id, h] = String(token || "").split(".");
  if (!id || !h) return null;
  const good = crypto.createHmac("sha256", UNSUB_SECRET).update(String(id)).digest("hex").slice(0, 16);
  return h === good ? Number(id) : null;
}

async function optOut(buyerId) {
  const r = await fetch(`${SB_URL}/rest/v1/buyers?id=eq.${buyerId}`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ email_opt_out: true }),
  });
  if (!r.ok) throw new Error(`unsubscribe patch -> ${r.status}: ${await r.text()}`);
}

function page(msg) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;background:#F0F4F8;margin:0;padding:48px 16px;text-align:center;color:#1B3A6B}
  .card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:12px;padding:32px}
  h1{font-size:20px;margin:0 0 8px} p{color:#4A5568;font-size:14px;line-height:1.6}</style></head>
  <body><div class="card"><h1>Seaside Horizon</h1><p>${msg}</p></div></body></html>`;
}

exports.handler = async (event) => {
  const token = (event.queryStringParameters || {}).b;
  const buyerId = verifyToken(token);

  if (!buyerId) {
    return { statusCode: 400, headers: { "Content-Type": "text/html" }, body: page("This unsubscribe link is invalid or expired.") };
  }
  try {
    await optOut(buyerId);
  } catch (err) {
    console.error("unsubscribe error:", err.message);
    return { statusCode: 500, headers: { "Content-Type": "text/html" }, body: page("Something went wrong. Please reply to the email to be removed.") };
  }
  // One-click POST (RFC 8058) expects a 200 with no body needed.
  if (event.httpMethod === "POST") return { statusCode: 200, body: "unsubscribed" };
  return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: page("You've been unsubscribed from Seaside Horizon deal emails. You won't receive further emails.") };
};
