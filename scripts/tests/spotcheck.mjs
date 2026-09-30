// Floor check › Rented spots: start a check (the real rented spots), mark right / other / empty,
// report a spot used without a contract, finish, see it in the history. spot_checks served from memory.
export default async function (page, { log }) {
  const T = [];
  await page.route(/\/rest\/v1\/spot_checks/, async route => {
    const r = route.request(), url = new URL(r.url()), single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (r.method() === 'GET') {
      let rows = T;
      if (url.searchParams.get('completed_at') === 'is.null') rows = T.filter(x => !x.completed_at);
      else if (url.searchParams.get('completed_at') === 'not.is.null') rows = T.filter(x => x.completed_at);
      return route.fulfill({ status: 200, json: single ? rows[0] ?? null : rows });
    }
    if (r.method() === 'POST') { const x = { id: 'sc1', started_at: new Date().toISOString(), started_by_name: 'Test Floor', completed_at: null, ...JSON.parse(r.postData()) }; T.push(x); return route.fulfill({ status: 201, json: single ? x : [x] }); }
    if (r.method() === 'PATCH') { Object.assign(T[0], JSON.parse(r.postData())); return route.fulfill({ status: 200, json: [T[0]] }); }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.evaluate(() => switchTab('floorcheck')); await page.waitForTimeout(1500);
  log('floor check tabs:', await page.$$eval('#fcTabs button', b => b.map(x => x.textContent).join(' | ')));
  await page.click('#fcTabs [data-tab="spots"]'); await page.waitForTimeout(2500);
  log('start card:', (await page.textContent('#fcBody .card')).replace(/\s+/g, ' ').trim().slice(0, 160));
  await page.click('#scStart'); await page.waitForTimeout(800);
  log('check:', (await page.textContent('.sc-progress')).replace(/\s+/g, ' ').trim());
  log('first spots:', await page.$$eval('#scList .sc-item', li => li.slice(0, 3).map(x => x.querySelector('.sc-main').textContent.replace(/\s+/g, ' ').trim()).join(' || ')));
  // right, empty, other
  await page.click('#scList .sc-item:nth-child(1) [data-set="ok"]'); await page.waitForTimeout(300);
  await page.click('#scList .sc-item:nth-child(1) [data-set="empty"]'); await page.waitForTimeout(300);
  page.once('dialog', d => d.accept('Nestle'));
  await page.evaluate(() => { window.__origPrompt = window.showPrompt; window.showPrompt = async () => 'Nestle'; });
  await page.click('#scList .sc-item:nth-child(1) [data-set="other"]'); await page.waitForTimeout(500);
  await page.click('#scView [data-view="problems"]'); await page.waitForTimeout(200);
  log('problems:', await page.$$eval('#scList .sc-item', li => li.map(x => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)).join(' || ')));
  // extra: a free spot used without contract
  await page.selectOption('#scFree', { index: 1 }); await page.fill('#scFreeWho', 'Kazzi'); await page.click('#scAddExtra'); await page.waitForTimeout(500);
  log('saved in db:', JSON.stringify({ statuses: T[0].items.reduce((m, i) => (m[i.status] = (m[i.status] || 0) + 1, m), {}), extra: T[0].extra.map(x => x.found + ' @ ' + x.type) }));
  await page.evaluate(() => { window.showConfirm = async () => true; });
  await page.click('#scFinish'); await page.waitForTimeout(1200);
  log('after finish:', JSON.stringify(T[0].summary), '| history rows:', await page.$$eval('#fcBody table tbody tr', t => t.length));
  await page.click('[data-detail]'); await page.waitForTimeout(300);
  log('detail:', (await page.textContent('#fcBody .sc-head')).replace(/\s+/g, ' ').trim());
}
