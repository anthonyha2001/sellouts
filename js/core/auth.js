/* ============================================================
   Sign-in, session and start-up. Loaded last: it boots the app.
   No session -> login screen. Session -> load profile -> role ->
   show only that role's sections and start their modules.
   ============================================================ */
(function () {
  const el = id => document.getElementById(id);
  let started = false;

  function showLogin(message) {
    document.body.classList.add('locked');
    document.body.classList.remove('booting');
    el('loginErr').textContent = message || '';
    el('loginSubmit').disabled = false;
    setTimeout(() => el(el('loginUser').value ? 'loginPass' : 'loginUser').focus(), 30);
  }

  // Loads the staff profile for a signed-in auth user, then opens the app.
  async function enter(user) {
    const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error && isNetworkError(error)) throw error;          // no connection yet: boot() retries, still signed in
    if (error) return showLogin('Could not load your profile: ' + friendlyError(error));
    if (!profile) {
      await sb.auth.signOut();
      return showLogin('This login is not set up as a staff account yet. Ask the admin.');
    }
    if (!profile.active) {
      await sb.auth.signOut();
      return showLogin('This account has been disabled. Ask the admin if you need access.');
    }
    if (!ROLES[profile.role]) {
      await sb.auth.signOut();
      return showLogin('This account has an unknown role. Ask the admin.');
    }
    Session.user = user;
    Session.profile = profile;
    Session.role = profile.role;
    await loadMyPermissions();
    applyEditClasses();
    startApp();
    return true;
  }

  function renderFoot() {
    const p = Session.profile;
    const name = p.display_name || p.username;
    el('sidebarFoot').innerHTML = `
      <div class="who">
        <span class="avatar" aria-hidden="true">${escapeHtml(name.trim().charAt(0).toUpperCase())}</span>
        <div class="who-txt"><b>${escapeHtml(name)}</b><small>${escapeHtml(roleInfo().label)}</small></div>
      </div>
      <button type="button" class="signout-btn" id="signOutBtn">Sign out</button>`;
    el('signOutBtn').addEventListener('click', signOut);
  }

  function startApp() {
    if (started) return;
    started = true;
    document.body.classList.remove('locked', 'booting');
    document.querySelectorAll('.nav-btn[data-tab]').forEach(b => { b.hidden = !canSee(b.dataset.tab); });
    renderFoot();
    startMainModules();
    if (canSee('delivery') && window.Delivery) Delivery.start();
    routeFromHash();
    if (window.AppNotify) AppNotify.sync();                  // push alerts for the person now signed in
  }

  async function signOut() {
    await logActivity('auth', 'logout', null, `${Session.profile?.username} signed out`);
    if (window.AppNotify) await AppNotify.unsubscribe();   // this device stops getting this person's alerts
    SessionBackup.clear();
    await sb.auth.signOut();
    history.replaceState(null, '', location.pathname);
    location.reload();   // simplest way to drop every module's in-memory data
  }

  el('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const user = el('loginUser').value.trim();
    const password = el('loginPass').value;
    if (!user || !password) return showLogin('Enter your username and password.');
    el('loginSubmit').disabled = true;
    el('loginErr').textContent = '';
    // Before signing in: decides where Supabase keeps the session (js/core/config.js).
    authStorage.setRemember(el('loginRemember').checked);
    if (!el('loginRemember').checked) SessionBackup.clear();
    const { data, error } = await sb.auth.signInWithPassword({ email: loginEmailFor(user), password });
    if (error) {
      el('loginPass').value = '';
      const msg = /invalid login credentials/i.test(error.message) ? 'Wrong username or password.'
        : /fetch|network/i.test(error.message) ? 'Could not reach the server. Check the internet connection and try again.'
        : error.message;
      return showLogin(msg);
    }
    if (await enter(data.user)) logActivity('auth', 'login', null, `${Session.profile.username} signed in`);
  });
  el('mobileSignOut').addEventListener('click', signOut);

  // Keep the backup in step with the session (it is renewed about every hour).
  // Signed out elsewhere (another tab, disabled account, expired refresh token) -> back to the login.
  sb.auth.onAuthStateChange((event, session) => {
    if (session && session.refresh_token) SessionBackup.save(session.refresh_token);
    if (event === 'SIGNED_OUT') { SessionBackup.clear(); if (started) location.reload(); }
  });

  // The session on this device; if the phone wiped it, sign back in from the backup refresh token.
  async function restoreSession() {
    const { data: { session }, error } = await sb.auth.getSession();
    if (session) return session;
    if (error && isNetworkError(error)) throw error;
    if (!authStorage.remember()) return null;
    const rt = await SessionBackup.read();
    if (!rt) return null;
    const r = await sb.auth.refreshSession({ refresh_token: rt });
    if (r.error) {
      if (isNetworkError(r.error)) throw r.error;
      SessionBackup.clear();                  // revoked / expired: a real sign-in is needed
      return null;
    }
    return r.data.session;
  }

  // Opening the app from the home screen, the phone is sometimes not online yet: keep trying for a
  // while ("Connecting…") instead of showing the sign-in form to someone who is still signed in.
  el('loginRemember').checked = authStorage.remember();
  (async function boot() {
    const waits = [0, 1000, 2000, 3000, 5000, 8000];
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) { el('loginScreen').querySelector('.login-loading').textContent = 'Connecting…'; await new Promise(r => setTimeout(r, waits[i])); }
      try {
        const session = await restoreSession();
        if (session) await enter(session.user);
        else showLogin();
        return;
      } catch (err) {
        if (!isNetworkError(err)) { showLogin('Could not start: ' + (err.message || err)); return; }
        console.warn('Start: no connection yet, retrying', err);
      }
    }
    showLogin('Could not reach the server. Check the internet connection — you are still signed in; reopen the app when you are online.');
  })();
})();
