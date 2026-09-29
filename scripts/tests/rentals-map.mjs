// Rentals + store map end to end, with the store-map tables served from memory (as after 012 + 013):
// first open seeds the ground floor, the 46 migrated contracts show as "not placed", Place puts one on
// a gondola, the list follows, sales save, contract edits keep the sales.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export default async function (page, { log }) {
  const T = { store_floors: [], store_map_objects: [], store_layout_versions: [], store_map_config: [],
    rental_contracts: JSON.parse(readFileSync(process.env.CONTRACTS_FILE || join(tmpdir(), 'contracts.json'), 'utf8')) };
  const writes = [];
  const val = v => v.split('.').slice(1).join('.');
  const filt = (rows, url) => {
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === val(v));
      else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
    }
    const order = url.searchParams.get('order');
    if (order) { const [col, dir] = order.split('.'); rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1)); }
    return rows;
  };
  await page.route(/\/rest\/v1\/(store_floors|store_map_objects|store_layout_versions|store_map_config|rental_contracts)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop(), h = r.headers();
    const single = (h['accept'] || '').includes('vnd.pgrst.object');
    let rows = filt(T[t], url);
    const range = h['range'];
    if (r.method() === 'GET') {
      if (range) { const [a, b] = range.split('-').map(Number); rows = rows.slice(a, b + 1); }
      return route.fulfill({ status: 200, json: single ? rows[0] ?? null : rows });
    }
    writes.push(r.method() + ' ' + t);
    if (r.method() === 'POST') {
      let body = JSON.parse(r.postData() || '[]'); body = Array.isArray(body) ? body : [body];
      const out = body.map(x => {
        if (t === 'store_layout_versions') { const v = { id: T[t].length + 1, created_at: new Date().toISOString(), ...x }; T[t].push(v); return v; }
        const ex = T[t].find(y => y.id === x.id); if (ex) { Object.assign(ex, x); return ex; }
        T[t].push({ ...x }); return x;
      });
      return route.fulfill({ status: 201, json: single ? out[0] : out });
    }
    if (r.method() === 'PATCH') { const patch = JSON.parse(r.postData() || '{}'); rows.forEach(x => Object.assign(x, patch)); return route.fulfill({ status: 200, json: rows }); }
    if (r.method() === 'DELETE') { T[t] = T[t].filter(x => !rows.includes(x)); return route.fulfill({ status: 200, json: rows }); }
    return route.fulfill({ status: 200, json: [] });
  });

  await page.evaluate(() => switchTab('rentals'));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log('console:', m.text().slice(0, 300)); });
  page.on('pageerror', e => log('pageerror:', e.message));
  await page.waitForTimeout(6000);
  log('DEBUG map:', await page.evaluate(() => JSON.stringify({ map: !!Rentals.map, floors: Rentals.map?.floors?.length, html: document.getElementById('rentalsMap').innerText.slice(0, 200) })), '| T floors', T.store_floors.length, 'writes', writes.join(','));
  await page.waitForFunction(() => Rentals.map && Rentals.map.floors && Rentals.map.floors.length, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  log('seeded:', T.store_floors.map(f => f.id).join(','), '| objects:', T.store_map_objects.length, '| versions:', T.store_layout_versions.length);
  log('map floors tabs:', await page.evaluate(() => [...document.querySelectorAll('#rentalsMap .sm-floor-tab, #rentalsMap [data-floor]')].map(b => b.textContent.trim()).join(' | ')));
  log('overview:', await page.evaluate(() => (document.querySelector('#rentalsMap .sm-panel, #rentalsMap .sm-side')?.innerText || '').split('\n').slice(0, 12).join(' / ')));

  // Place Abboud trading's contract on the first gondola, from the List view.
  await page.click('#rentalViewTabs [data-view="list"]'); await page.waitForTimeout(400);
  log('list totals:', (await page.textContent('#rentalTotals')).replace(/\s+/g, ' ').trim());
  log('type chips:', (await page.textContent('#rentalTypeTabs')).replace(/\s+/g, ' ').trim());
  const card = '#rentalList [data-contract="rc-legacy-id-mug4x0q3-3opbut"]';
  log('Abboud card:', (await page.textContent(card + ' .sellout-head')).replace(/\s+/g, ' ').trim());
  await page.click(card + ' [data-role="place"]'); await page.waitForTimeout(500);
  log('banner:', (await page.textContent('#rentalsMap .sm-banner')).replace(/\s+/g, ' ').trim(), '| map view shown:', await page.isVisible('#rentalsMap'));
  const gid = await page.evaluate(() => Rentals.map.objects.find(o => o.type === 'gondola').id);
  await page.evaluate(id => Rentals.map.finishAssign(id), gid); await page.waitForTimeout(600);
  const saved = T.rental_contracts.find(c => c.id === 'rc-legacy-id-mug4x0q3-3opbut');
  log('placed on', gid, '→ db spot_id:', saved.spot_id, '| sales kept in db:', !!saved.monthly_sales && saved.monthly_sales['2026-07']);
  log('panel:', await page.evaluate(() => (document.querySelector('#rentalsMap .sm-panel, #rentalsMap .sm-side')?.innerText || '').split('\n').slice(0, 8).join(' / ')));
  log('gondola status class:', await page.evaluate(id => document.querySelector(`#rentalsMap [data-id="${id}"]`)?.getAttribute('class'), gid));

  // Edit the contract on the map (amount), the sales must survive.
  await page.evaluate(() => { const c = Rentals.map.contracts.find(x => x.id === 'rc-legacy-id-mug4x0q3-3opbut'); Rentals.map.contractAction('edit', c.id, Rentals.map.objects.find(o => o.id === c.spotId)); });
  await page.waitForTimeout(300);
  await page.fill('#rentalsMap [data-role="cform"] [name="amount"]', '1200');
  await page.click('#rentalsMap [data-role="cform"] button.primary'); await page.waitForTimeout(600);
  log('after edit: amount', saved.amount, '| sales still there:', saved.monthly_sales && saved.monthly_sales['2026-07']);

  // Back to the list: the card now shows the spot; save a sales figure.
  await page.click('#rentalViewTabs [data-view="list"]'); await page.waitForTimeout(400);
  log('Abboud card now:', (await page.textContent(card + ' .sellout-head')).replace(/\s+/g, ' ').trim());
  await page.click(card + ' .sellout-head .who'); await page.waitForTimeout(300);
  await page.fill(card + ' .rental-sales-input[data-mkey="2026-09"]', '1500');
  await page.click(card + ' [data-role="save-sales"]'); await page.waitForTimeout(500);
  log('sales saved 2026-09:', saved.monthly_sales && saved.monthly_sales['2026-09'], '| signal:', (await page.textContent(card + ' .rental-summary')).replace(/\s+/g, ' ').trim());
  log('writes:', [...new Set(writes)].join(', '));
  if (process.env.END_VIEW === 'map') { await page.click(card + ' [data-role="show"]'); await page.waitForTimeout(1500); }
}
// (screenshots) END_VIEW=map ends on the map with the placed gondola selected
export const after = true;
