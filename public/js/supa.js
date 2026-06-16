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
