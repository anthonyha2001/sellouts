/* ============================================================
   Supabase client + small shared helpers. Loaded first.
   Publishable key only: access is enforced by RLS in the database.
   NEVER put the secret key in any file the browser loads.
   ============================================================ */
const SUPABASE_URL = 'https://sezjqcbkiydckhirycjb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_LRI-MmDPYE_IjrHG-LZ7Xg_mQovg24F';
// Web Push: the PUBLIC half of the push key (the private half is a secret of the push-alerts function).
const VAPID_PUBLIC_KEY = 'BMG7Z2phSxCqVWAVaXv0Al16YLNNwbBXMZYfrkFc7FmYkcM9FTxqIzhxTcDpnM7BO-_qDILf0m-7pys_XnAbd4o';
// Where the sign-in is kept (owner, 2026-09-30: a phone's home-screen app must stay signed in).
// "Keep me signed in on this device" (the default): localStorage, plus a backup of the refresh token
// (SessionBackup below) in case the phone clears localStorage. Not kept: sessionStorage, so closing
// the browser signs out (shared computers).
const REMEMBER_KEY = 'lv-remember';
const authStorage = {
  remember() { try { return localStorage.getItem(REMEMBER_KEY) !== '0'; } catch (e) { return true; } },
  setRemember(on) { try { localStorage.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ } },
  area() { try { return this.remember() ? window.localStorage : window.sessionStorage; } catch (e) { return null; } },
  getItem(k) { try { return this.area()?.getItem(k) ?? null; } catch (e) { return null; } },
  setItem(k, v) { try { this.area()?.setItem(k, v); } catch (e) { /* storage blocked */ } },
  removeItem(k) { try { localStorage.removeItem(k); } catch (e) { } try { sessionStorage.removeItem(k); } catch (e) { } },
};
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'lv-auth', storage: authStorage }
});

// Backup of the refresh token (only for "keep me signed in"): a long-lived first-party cookie and
// IndexedDB. If the phone has wiped localStorage, auth.js signs back in from it. It is the same token
// that localStorage already holds, and it is updated every time Supabase renews it.
const SessionBackup = (function () {
  const NAME = 'lv_rt', PATH = location.pathname.replace(/[^/]*$/, '') || '/';
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  const idb = () => new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no IndexedDB'));
    const r = indexedDB.open('lv-keep', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbDo = async (mode, fn) => { try { const db = await idb(); return await new Promise((res, rej) => { const tx = db.transaction('kv', mode), st = tx.objectStore('kv'); const q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }); } catch (e) { return null; } };
  return {
    save(token) {
      if (!token || !authStorage.remember()) return;
      try { document.cookie = `${NAME}=${encodeURIComponent(token)}; Max-Age=${400 * 86400}; Path=${PATH}; SameSite=Strict${secure}`; } catch (e) { }
      idbDo('readwrite', st => st.put(token, 'rt'));
    },
    async read() {
      const m = document.cookie.match(new RegExp('(?:^|; )' + NAME + '=([^;]*)'));
      if (m && m[1]) return decodeURIComponent(m[1]);
      return (await idbDo('readonly', st => st.get('rt'))) || null;
    },
    clear() {
      try { document.cookie = `${NAME}=; Max-Age=0; Path=${PATH}; SameSite=Strict${secure}`; } catch (e) { }
      idbDo('readwrite', st => st.delete('rt'));
    },
  };
})();
// Ask the browser not to clear this app's storage when the phone runs low on space (installed apps).
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* not supported */ }

// A failed request because there is no connection (not a refusal from the server).
function isNetworkError(error) {
  const m = String((error && (error.message || error.name)) || error || '');
  return /fetch|network|load failed|timed? ?out|offline/i.test(m) || (error && error.status === 0);
}

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
