// Draft on the phone: scan while the server is unreachable, refresh, the list must still be there,
// then the server comes back and the unsent scans are sent.
export default async function (page, { log }) {
  // Phase 1: the label tables are unreachable (as before migration 010 / no connection).
  await page.route(/\/rest\/v1\/(label_lists|label_items)(\?|$)/, r => r.fulfill({ status: 503, json: { message: 'offline test' } }));
  await page.evaluate(() => { Object.keys(localStorage).filter(k => k.startsWith('lv:labelDraft:')).forEach(k => localStorage.removeItem(k)); switchTab('labels'); });
  await page.waitForTimeout(800);
  for (const c of ['0012345678905', '5281018709276', '0012345678905']) await page.evaluate(code => Labels._addCode(code, true), c);
  await page.waitForTimeout(800);
  log('offline list:', await page.$$eval('.lb-row', rs => rs.map(r => r.querySelector('.lb-code').textContent + ' x' + r.querySelector('input').value).join(', ')));
  log('pending note:', (await page.textContent('#lbPending')).replace(/\s+/g, ' ').trim());
  // Refresh the page: the draft must come back.
  await page.reload(); await page.waitForTimeout(7000);
  await page.evaluate(() => switchTab('labels')); await page.waitForTimeout(1000);
  log('after refresh:', await page.$$eval('.lb-row', rs => rs.map(r => r.querySelector('.lb-code').textContent + ' x' + r.querySelector('input').value).join(', ')));
  // Phase 2: server back (in-memory tables from labels-mock): the unsent scans are sent.
  await page.unroute(/\/rest\/v1\/(label_lists|label_items)(\?|$)/);
  process.env.SHELF = '1';
  const T = await labelsServer(page);
  await page.evaluate(() => { document.querySelector('#lbTabs [data-tab="mine"]')?.click(); Labels.show(); });
  await page.waitForTimeout(1500);
  log('sent to server:', JSON.stringify(T.label_items.map(i => i.barcode + ':' + i.qty)), '| pending note hidden:', await page.isHidden('#lbPending'));
}
// Minimal in-memory server for label tables (same shape as labels-mock.mjs).
async function labelsServer(page) {
  const { randomUUID } = await import('node:crypto');
  const uid = await page.evaluate(() => Session.user.id);
  const T = { label_lists: [], label_items: [] };
  const filt = (rows, url) => { for (const [k, v] of url.searchParams) { if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) continue; const val = v.split('.').slice(1).join('.');
    if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === val); else if (v === 'is.null') rows = rows.filter(r => r[k] == null); } return rows; };
  await page.route(/\/rest\/v1\/(label_lists|label_items)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop();
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    const reply = (d, st = 200) => route.fulfill({ status: st, json: single ? (Array.isArray(d) ? d[0] ?? null : d) : d });
    if (r.method() === 'GET') return reply(filt(T[t], url));
    if (r.method() === 'POST') { let b = JSON.parse(r.postData() || '{}'); b = Array.isArray(b) ? b : [b];
      return reply(b.map(x => { if (t === 'label_lists') { const l = { id: randomUUID(), created_by: uid, submitted_at: null, ...x }; T.label_lists.push(l); return l; }
        const ex = T.label_items.find(i => i.list_id === x.list_id && i.barcode === x.barcode); if (ex) { Object.assign(ex, x); return ex; }
        const it = { id: randomUUID(), ...x }; T.label_items.push(it); return it; }), 201); }
    if (r.method() === 'DELETE') { const rows = filt(T[t], url); T[t] = T[t].filter(x => !rows.includes(x)); return reply(rows); }
    return reply([]);
  });
  return T;
}
