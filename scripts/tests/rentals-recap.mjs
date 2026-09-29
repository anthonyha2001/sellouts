// Rentals list = recap per supplier (after 016): tables served from memory, the map seeded, then
// Halwani gets an end cap ($1,000) and a gondola ($20,000) + one monthly screen; Najjar one end cap.
// Checks the recap line, the totals, the contracts table and saving the supplier's sales.
export default async function (page, { log }) {
  const T = { store_floors: [], store_map_objects: [], store_layout_versions: [], store_map_config: [], rental_contracts: [], rental_supplier_sales: [] };
  const val = v => v.split('.').slice(1).join('.');
  const filt = (rows, url) => {
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === val(v));
      else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
    }
    return rows;
  };
  const keyCol = t => t === 'rental_supplier_sales' ? 'supplier_key' : 'id';
  await page.route(/\/rest\/v1\/(store_floors|store_map_objects|store_layout_versions|store_map_config|rental_contracts|rental_supplier_sales)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop();
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    let rows = filt(T[t], url);
    if (r.method() === 'GET') { const range = r.headers()['range']; if (range) { const [a, b] = range.split('-').map(Number); rows = rows.slice(a, b + 1); } return route.fulfill({ status: 200, json: single ? rows[0] ?? null : rows }); }
    if (r.method() === 'POST') {
      let body = JSON.parse(r.postData() || '[]'); body = Array.isArray(body) ? body : [body];
      const out = body.map(x => { const k = keyCol(t); const ex = x[k] != null && T[t].find(y => y[k] === x[k]); if (ex) { Object.assign(ex, x); return ex; } const n = { id: T[t].length + 1, ...x }; T[t].push(n); return n; });
      return route.fulfill({ status: 201, json: single ? out[0] : out });
    }
    if (r.method() === 'PATCH') { const patch = JSON.parse(r.postData() || '{}'); rows.forEach(x => Object.assign(x, patch)); return route.fulfill({ status: 200, json: rows }); }
    if (r.method() === 'DELETE') { T[t] = T[t].filter(x => !rows.includes(x)); return route.fulfill({ status: 200, json: rows }); }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.evaluate(() => switchTab('rentals'));
  await page.waitForFunction(() => Rentals.map && Rentals.map.floors && Rentals.map.floors.length, null, { timeout: 30000 });
  await page.waitForTimeout(1000);

  // Assign spots the way the map's contract form does (straight to the adapter + the map's list).
  const today = await page.evaluate(() => beirutToday());
  const y = today.slice(0, 4);
  await page.evaluate(async ({ y }) => {
    const m = Rentals.map, objs = m.objects;
    const endcap = objs.find(o => o.type === 'endcap'), endcap2 = objs.filter(o => o.type === 'endcap')[1], gondola = objs.find(o => o.type === 'gondola');
    const screen = objs.find(o => o.type === 'screen_wall') || objs.find(o => o.type === 'display');
    const add = async c => { const saved = await m.adapter.saveContract(c); m.contracts.push(saved); };
    await add({ id: 'rc-t1', spotId: endcap.id, supplier: 'Halwani', term: 'yearly', start: `${y}-01-01`, end: `${y}-12-31`, amount: 1000, billed: true, paid: false });
    await add({ id: 'rc-t2', spotId: gondola.id, supplier: 'Halwani ', term: 'yearly', start: `${y}-01-01`, end: `${y}-12-31`, amount: 20000, billed: false, paid: false });
    await add({ id: 'rc-t3', spotId: screen.id, supplier: 'halwani', term: 'monthly', start: `${y}-03-01`, end: `${y}-12-31`, amount: 250, billed: true, paid: true });
    await add({ id: 'rc-t4', spotId: endcap2.id, supplier: 'Najjar', term: 'yearly', start: `${y - 1}-02-01`, end: `${y}-01-31`, amount: 5000, billed: true, paid: true });
    m.renderSvg();
  }, { y: Number(y) });
  await page.click('#rentalViewTabs [data-view="list"]'); await page.waitForTimeout(500);
  log('totals:', (await page.textContent('#rentalTotals')).replace(/\s+/g, ' ').trim());
  log('current cards:', await page.$$eval('#rentalList [data-supplier] .sellout-head', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' || ')));
  await page.click('#rentalShowTabs [data-show="all"]'); await page.waitForTimeout(300);
  log('with ended:', await page.$$eval('#rentalList [data-supplier] .who', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' || ')));
  await page.click('#rentalShowTabs [data-show="current"]'); await page.waitForTimeout(300);
  // open Halwani, enter sales, save
  await page.click('#rentalList [data-supplier="halwani"] .sellout-head .who'); await page.waitForTimeout(300);
  log('Halwani contracts:', await page.$$eval('#rentalList [data-supplier="halwani"] tbody tr[data-contract]', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
  await page.fill(`#rentalList [data-supplier="halwani"] .rental-sales-input[data-mkey="${y - 1}-07"]`, '10000');
  await page.fill(`#rentalList [data-supplier="halwani"] .rental-sales-input[data-mkey="${y}-07"]`, '12500');
  await page.click('#rentalList [data-supplier="halwani"] [data-role="save-sales"]'); await page.waitForTimeout(500);
  log('saved sales rows:', JSON.stringify(T.rental_supplier_sales.map(r => ({ k: r.supplier_key, s: r.supplier, m: r.monthly_sales }))));
  log('Halwani head now:', (await page.textContent('#rentalList [data-supplier="halwani"] .rental-summary')).replace(/\s+/g, ' ').trim());
}
