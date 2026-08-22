// KaamAI runtime config.
//
// These two values are the PUBLIC Supabase project URL and anon key. They are
// safe to ship in the browser — Row-Level Security (see db/schema.sql) is what
// actually protects data. NEVER put the service_role key here.
//
// Fill these in from your Supabase project: Settings -> API.
// Until they are set, the app runs in local-only mode (no backend, no OTP) and
// behaves exactly as it did before the backend existed.
window.KAAMAI_CONFIG = {
  SUPABASE_URL: "", // e.g. "https://xxxxxxxxxxxx.supabase.co"
  SUPABASE_ANON_KEY: "" // e.g. "eyJhbGciOi..."
};
