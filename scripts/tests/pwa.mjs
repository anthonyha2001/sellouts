// Installable app + notifications: manifest, icons, service worker, the bell's "Turn on notifications".
export default async function (page, { log }) {
  await page.context().grantPermissions(['notifications']);
  const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const m = await (await fetch(l.href)).json(); return { name: m.name, display: m.display, icons: m.icons.map(i => i.sizes + ':' + i.purpose).join(', '), theme: m.theme_color }; });
  log('manifest:', JSON.stringify(man));
  const icons = await page.evaluate(async () => Promise.all(['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/badge-96.png'].map(async u => u.split('/')[1] + ':' + (await fetch(u)).status)));
  log('icons:', icons.join(' '));
  await page.waitForTimeout(1500);
  log('service worker:', await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r ? (r.active ? 'active' : r.installing ? 'installing' : 'waiting') + ' · scope ' + r.scope : 'none'; }));
  await page.click('#bellBtn'); await page.waitForTimeout(300);
  log('bell footer:', (await page.textContent('#npFoot')).replace(/\s+/g, ' ').trim());
  if (await page.$('#npFoot [data-np="on"]')) { await page.click('#npFoot [data-np="on"]'); await page.waitForTimeout(800); }
  log('after Turn on:', (await page.textContent('#npFoot')).replace(/\s+/g, ' ').trim(), '| enabled:', await page.evaluate(() => AppNotify.enabled()));
  await page.evaluate(() => AppNotify.show('La Valeur', 'Test: sell-out ends tomorrow', { force: true, tag: 'lv-t2', url: '#sellouts' }));
  await page.waitForTimeout(500);
  log('notifications shown by the service worker:', await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications()).map(n => n.title + ' — ' + n.body + ' (icon ' + n.icon.split('/').pop() + ')').join(' | ')));
  log('theme:', await page.evaluate(() => ({ sidebar: getComputedStyle(document.getElementById('sidebarEl')).backgroundColor, pine: getComputedStyle(document.documentElement).getPropertyValue('--pine').trim(), title: document.title })));
}
