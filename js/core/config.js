/* ============================================================
   Supabase client + small shared helpers. Loaded first.
   Publishable key only: access is enforced by RLS in the database.
   NEVER put the secret key in any file the browser loads.
   ============================================================ */
const SUPABASE_URL = 'https://sezjqcbkiydckhirycjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LRI-MmDPYE_IjrHG-LZ7Xg_mQovg24F';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'lv-auth' }
});

// Staff log in with a username; Supabase Auth needs an email, so a username maps to
// <username>@lvajaltoun.local. Anything containing "@" is used as a real email.
const LOGIN_DOMAIN = 'lvajaltoun.local';
function loginEmailFor(input) {
  const v = String(input || '').trim().toLowerCase();
  return v.includes('@') ? v : `${v}@${LOGIN_DOMAIN}`;
}

// "Today" is always the Beirut date, never UTC and never the device's own timezone.
function beirutToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
}

// RLS denials and the delivery-order trigger both surface as Postgres 42501.
function isPermissionError(error) {
  if (!error) return false;
  const text = [error.code, error.message, error.details, error.hint].join(' ');
  return error.code === '42501' || /row-level security|permission denied/i.test(text);
}
const PERMISSION_MESSAGE = 'You don’t have permission to do that.';

// Human-readable text for any Supabase error. Our own trigger messages (e.g. "Only the paid
// status can be changed on this order") are already friendly, so they are kept as they are.
function friendlyError(error) {
  if (!error) return 'Unknown error';
  if (isPermissionError(error)) {
    const m = error.message || '';
    return /row-level security|permission denied|^$/i.test(m) ? PERMISSION_MESSAGE : m;
  }
  return error.message || error.details || error.hint || JSON.stringify(error);
}
