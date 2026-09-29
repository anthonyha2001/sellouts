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

  async function show(title, body, opts = {}) {
    if (!enabled()) return false;
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
    setPref('on'); renderFoot();
    show('La Valeur', 'Notifications are on. You will get sell-out, rental, floor check and cash alerts here.', { force: true, tag: 'lv-test' });
  }

  function renderFoot() {
    const foot = document.getElementById('npFoot'); if (!foot) return;
    const perm = supported() ? Notification.permission : 'unsupported';
    const on = enabled();
    const notifRow = perm === 'unsupported'
      ? `<span class="np-note">${isIOS && !standalone() ? 'iPhone: install the app to get notifications.' : 'Notifications are not available in this browser.'}</span>`
      : perm === 'denied'
        ? '<span class="np-note">Notifications are blocked for this site — allow them in the browser settings.</span>'
        : `<span class="np-note">${on ? 'Alerts also show on this device when the app is in the background.' : 'Get alerts on this device even when the app is in the background.'}</span>
           <button type="button" class="np-btn" data-np="${on ? 'off' : 'on'}">${on ? 'Turn off' : 'Turn on notifications'}</button>`;
    const canInstall = !standalone() && (installEvt || isIOS);
    foot.innerHTML = `<div class="np-row">${notifRow}</div>${canInstall ? `<div class="np-row"><span class="np-note">Put La Valeur on your home screen or desktop, like an app.</span>
      <button type="button" class="np-btn" data-np="install">Install app</button></div>` : ''}`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-np]'); if (!b) return;
    e.stopPropagation();
    if (b.dataset.np === 'on') return turnOn();
    if (b.dataset.np === 'off') { setPref('off'); renderFoot(); return showToast('Notifications turned off on this device.'); }
    if (b.dataset.np === 'install') {
      if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); if (r && r.outcome === 'accepted') installEvt = null; return renderFoot(); }
      if (isIOS) return showConfirm('To install La Valeur on iPhone or iPad:\n\n1. Open this page in Safari.\n2. Tap the Share button (square with an arrow).\n3. Tap "Add to Home Screen", then "Add".\n\nThen open La Valeur from the home screen and turn notifications on from the bell.', 'OK');
    }
  });
  document.addEventListener('DOMContentLoaded', renderFoot);
  renderFoot();

  window.AppNotify = { show, enabled, renderFoot };
})();
