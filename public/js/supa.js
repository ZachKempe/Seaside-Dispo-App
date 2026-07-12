// Shared Supabase client + auth guard for every dashboard page.
// Loaded via the Supabase JS CDN bundle (see <script> tags in each page).

const SUPABASE_URL = "https://huyrdziomrttlhzyyzyr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh1eXJkemlvbXJ0dGxoenl5enlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NzUyMTUsImV4cCI6MjA5NjM1MTIxNX0.2-seLOhot_haYL1CeI9sdOVvLobqqguFGoU2Trx56Qo";

const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** Redirect to login if there's no active session. Call at the top of every protected page. */
async function requireAuth() {
  const { data: { session } } = await supa.auth.getSession();
  if (!session) {
    window.location.href = "/";
    return null;
  }
  return session;
}

function wireLogout(buttonEl) {
  if (!buttonEl) return;
  buttonEl.addEventListener("click", async () => {
    await supa.auth.signOut();
    window.location.href = "/";
  });
}

// ── Toast notifications (shared) ──────────────────────────────────
// toast("Saved", { type: "success" }) · toast("Couldn't save", { type: "error" })
// Undo: toast("Removed", { type: "success", actionLabel: "Undo", onAction: fn })
function toast(message, opts = {}) {
  const { type = "info", actionLabel = null, onAction = null, duration = null } = opts;
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none";
    document.body.appendChild(host);
  }
  const colors = {
    success: { bg: "#065f46", fg: "#ecfdf5" },
    error:   { bg: "#991b1b", fg: "#fef2f2" },
    info:    { bg: "#1B3A6B", fg: "#eef2ff" },
  };
  const c = colors[type] || colors.info;
  const el = document.createElement("div");
  el.style.cssText = "pointer-events:auto;background:" + c.bg + ";color:" + c.fg + ";padding:11px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:500 0.9rem/1.35 Inter,system-ui,sans-serif;max-width:440px;display:flex;align-items:center;gap:14px;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s";
  const span = document.createElement("span");
  span.textContent = message;
  span.style.flex = "1";
  el.appendChild(span);
  let timer = null;
  const dismiss = () => { clearTimeout(timer); el.style.opacity = "0"; el.style.transform = "translateY(8px)"; setTimeout(() => el.remove(), 200); };
  if (actionLabel && onAction) {
    const btn = document.createElement("button");
    btn.textContent = actionLabel;
    btn.style.cssText = "background:rgba(255,255,255,.2);color:inherit;border:none;border-radius:7px;padding:5px 12px;font-weight:700;cursor:pointer;font-size:0.85rem";
    btn.addEventListener("click", () => { dismiss(); try { onAction(); } catch (e) { console.error(e); } });
    el.appendChild(btn);
  }
  host.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
  timer = setTimeout(dismiss, duration != null ? duration : (actionLabel ? 8000 : 3500));
  return el;
}
