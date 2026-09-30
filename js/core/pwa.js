/* ============================================================
   Installable app + phone / computer notifications (PLAN §10e).
   - Registers sw.js (install, offline start, notifications).
   - "Install app": the browser's install prompt (Android / Chrome /
     Edge); on iPhone, the Share → Add to Home Screen steps.
   - Notifications: the bell's footer turns them on (the browser asks
     permission after a tap); AppNotify.show() then shows a system
     notification when the app is not in front. They come from the
     app while it is open or in the background; see PLAN §10e for
     notifications while it is fully closed (Web Push).
   Public API: window.AppNotify = { show, enabled, renderFoot }.
   ============================================================ */
(function () {
  const PREF_KEY = 'lv:notify';        // 'on' | 'off' (the person's own choice, on this device)
  let swReg = null, installEvt = null;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pref = () => { try { return localStorage.getItem(PREF_KEY); } catch (e) { return null; } };
  const setPref = v => { try { localStorage.setItem(PREF_KEY, v); } catch (e) { /* ignore */ } };
  const supported = () => 'Notification' in window;

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(e => console.warn('Service worker not registered', e));
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderFoot(); });
  window.addEventListener('appinstalled', () => { installEvt = null; renderFoot(); showToast('La Valeur is installed. Open it from your home screen or app list.'); });

  function enabled() { return supported() && Notification.permission === 'granted' && pref() !== 'off'; }

  /* ---- Web Push: alerts while the app is closed (supabase/functions/push-alerts, migration 017) ---- */
  let pushOn = false;                 // this device is registered: the server sends the alerts
  const b64uBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const getReg = async () => swReg || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null);
  async function subscribePush() {
    try {
      const reg = await getReg();
      if (!reg || !reg.pushManager || typeof VAPID_PUBLIC_KEY === 'undefined' || !(typeof Session !== 'undefined' && Session.user)) return false;
      let s = await reg.pushManager.getSubscription();
      if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(VAPID_PUBLIC_KEY) });
      const j = s.toJSON();
      const { error } = await sb.rpc('register_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent });
      if (error) { console.warn('Push not registered (migration 017?)', error.message); pushOn = false; return false; }
      pushOn = true; return true;
    } catch (e) { console.warn('Push subscription failed', e); pushOn = false; return false; }
  }
  // Turned off here, or signing out: this device stops getting the alerts (also for the next person).
  async function unsubscribePush() {
    try {
      const reg = await getReg(), s = reg && reg.pushManager && await reg.pushManager.getSubscription();
      if (s) { try { await sb.rpc('unregister_push', { p_endpoint: s.endpoint }); } catch (e) { /* offline */ } await s.unsubscribe().catch(() => {}); }
    } catch (e) { /* ignore */ }
    pushOn = false;
  }
  // After sign-in: keep this device registered for the person now signed in.
  async function syncPush() { if (enabled()) { await subscribePush(); renderFoot(); } }
  async function sendTest() {
    const { data, error } = await sb.functions.invoke('push-alerts', { body: { action: 'test' } });
    let msg = error ? error.message : '';
    try { if (error && error.context) { const b = await error.context.json(); if (b.error) msg = b.error; } } catch (e) { /* not JSON */ }
    if (error) return showToast('Test not sent — ' + (/not found|Failed to send/i.test(msg) ? 'the notification service is not set up yet.' : msg), true);
    showToast(data && data.sent ? `Test sent to ${data.sent} device${data.sent === 1 ? '' : 's'} — it arrives in a few seconds.` : 'Test not delivered — try turning notifications off and on.', !(data && data.sent));
  }

  async function show(title, body, opts = {}) {
    if (!enabled()) return false;
    if (pushOn && !opts.force) return false;       // the server sends it (also when the app is closed): no double
    if (!opts.force && document.visibilityState === 'visible' && document.hasFocus()) return false;   // the bell is enough
    const options = { body, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: opts.tag, renotify: !!opts.tag, data: { url: opts.url || location.hash || './' } };
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      if (reg) { await reg.showNotification(title, options); return true; }
      new Notification(title, options); return true;       // desktop without a service worker (http)
    } catch (e) { console.warn('Notification not shown', e); return false; }
  }

  async function turnOn() {
    if (!supported()) {
      return showToast(isIOS && !standalone() ? 'On iPhone, install the app first (Share → Add to Home Screen), then turn notifications on from the app.' : 'This browser cannot show notifications.', true);
    }
    const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (p !== 'granted') { renderFoot(); return showToast('Notifications are blocked for this site. Allow them in the browser (padlock icon → Notifications), then try again.', true); }
    setPref('on');
    const push = await subscribePush();
    renderFoot();
    show('La Valeur', push ? 'Notifications are on — you will get alerts here even when the app is closed.'
      : 'Notifications are on. You will get alerts here while the app is open or in the background.', { force: true, tag: 'lv-test' });
  }

  function renderFoot() {
    const foot = document.getElementById('npFoot'); if (!foot) return;
    const perm = supported() ? Notification.permission : 'unsupported';
    const on = enabled();
    const notifRow = perm === 'unsupported'
      ? `<span class="np-note">${isIOS && !standalone() ? 'iPhone: install the app to get notifications.' : 'Notifications are not available in this browser.'}</span>`
      : perm === 'denied'
        ? '<span class="np-note">Notifications are blocked for this site — allow them in the browser settings.</span>'
        : `<span class="np-note">${on ? (pushOn ? 'Alerts come to this device, even when the app is closed.' : 'Alerts show on this device while the app is open or in the background.') : 'Get alerts on this device, even when the app is closed.'}</span>
           ${on && pushOn ? '<button type="button" class="np-btn" data-np="test" style="background:none;color:var(--pine)">Send a test</button>' : ''}
           <button type="button" class="np-btn" data-np="${on ? 'off' : 'on'}">${on ? 'Turn off' : 'Turn on notifications'}</button>`;
    const canInstall = !standalone() && (installEvt || isIOS);
    foot.innerHTML = `<div class="np-row">${notifRow}</div>${canInstall ? `<div class="np-row"><span class="np-note">Put La Valeur on your home screen or desktop, like an app.</span>
      <button type="button" class="np-btn" data-np="install">Install app</button></div>` : ''}`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-np]'); if (!b) return;
    e.stopPropagation();
    if (b.dataset.np === 'on') return turnOn();
    if (b.dataset.np === 'off') { setPref('off'); await unsubscribePush(); renderFoot(); return showToast('Notifications turned off on this device.'); }
    if (b.dataset.np === 'test') return sendTest();
    if (b.dataset.np === 'install') {
      if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); if (r && r.outcome === 'accepted') installEvt = null; return renderFoot(); }
      if (isIOS) return showConfirm('To install La Valeur on iPhone or iPad:\n\n1. Open this page in Safari.\n2. Tap the Share button (square with an arrow).\n3. Tap "Add to Home Screen", then "Add".\n\nThen open La Valeur from the home screen and turn notifications on from the bell.', 'OK');
    }
  });
  document.addEventListener('DOMContentLoaded', renderFoot);
  renderFoot();

  window.AppNotify = { show, enabled, renderFoot, sync: syncPush, unsubscribe: unsubscribePush };
})();
