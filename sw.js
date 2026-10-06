/* La Valeur — service worker (js/core/pwa.js registers it).
   - Makes the app installable ("Add to home screen" / "Install app").
   - Keeps the app's own files so it still opens without a connection; always tries the network
     first, so a new version is used as soon as it is online (the data itself always comes live
     from Supabase and is never cached here).
   - Shows notifications (phones only allow notifications through a service worker) and opens
     the app on the right page when one is tapped. */
const CACHE = 'lv-app-v6';
const SHELL = ['./', 'index.html', 'css/app.css', 'css/delivery.css', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png',
  'cashier.html', 'css/cashier.css', 'js/cashier.js', 'manifest-cashier.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app's own files (same origin, GET); anything else goes straight to the network.
// 'no-cache': the browser asks the server every time whether a file changed (GitHub Pages lets browsers keep
// files 10 minutes), so a new version is used right after it is pushed; an unchanged file costs a tiny check.
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const fresh = req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' });
  e.respondWith(fetch(fresh).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match(/cashier\.html$/.test(url.pathname) ? 'cashier.html' : 'index.html') : undefined))));
});

// Tapping a notification: bring the app to the front (or open it) on the page the notification is about.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    // The cashier page (its own app) and the main app are separate: open the window of the same page.
    const isCashier = u => /cashier\.html/.test(u);
    const open = list.find(c => c.url.startsWith(self.registration.scope) && isCashier(c.url) === isCashier(target));
    if (open) { open.focus(); if (e.notification.data?.url) open.navigate(target).catch(() => {}); return; }
    return self.clients.openWindow(target);
  }));
});

// Web Push from the push-alerts function (alerts while the app is closed). When the app is open and in
// front, it is skipped: the app's own bell already shows the same alert.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const front = list.find(c => c.visibilityState === 'visible' && c.focused);
    if (d.tag !== 'lv-test' && !d.cashier && front) { front.postMessage({ type: 'lv-push', title: d.title, body: d.body, url: d.url }); return; }   // into the bell
    return self.registration.showNotification(d.title || 'La Valeur', {
      body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', tag: d.tag, renotify: !!d.tag, data: { url: d.url || './' },
    });
  }));
});
