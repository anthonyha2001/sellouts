// Labels UI test (Phase 7) with label_lists / label_items kept in memory (migration 010 not applied yet).
// Run twice: SHELF=1 (scan + Done) then as accountant (merged list, export, empties).
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  const uid = await page.evaluate(() => Session.user.id);
  const T = { label_lists: [], label_items: [] };
  if (!process.env.SHELF) {   // accountant: two submitted lists from two shelf workers, one open list (must stay hidden)
    T.label_lists.push({ id: 'L1', created_by: 'w1', created_by_name: 'Rami', submitted_at: '2026-09-29T08:00:00Z', exported_at: null },
                       { id: 'L2', created_by: 'w2', created_by_name: 'Nour', submitted_at: '2026-09-29T09:30:00Z', exported_at: null },
                       { id: 'L3', created_by: 'w1', created_by_name: 'Rami', submitted_at: null, exported_at: null });
    T.label_items.push({ id: 'a', list_id: 'L1', barcode: '0012345678905', qty: 2 }, { id: 'b', list_id: 'L1', barcode: '5281018709276', qty: 1 },
                       { id: 'c', list_id: 'L2', barcode: '5281018709276', qty: 4 }, { id: 'd', list_id: 'L3', barcode: '999999', qty: 1 });
  }
  const filt = (rows, url) => {
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
      const val = v.split('.').slice(1).join('.');
      if (v.startsWith('eq.')) rows = rows.filter(r => String(r[k]) === val);
      else if (v === 'is.null') rows = rows.filter(r => r[k] == null);
      else if (v === 'not.is.null') rows = rows.filter(r => r[k] != null);
      else if (v.startsWith('in.')) { const set = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/"/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
    }
    return rows;
  };
  await page.route(/\/rest\/v1\/(label_lists|label_items)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop();
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    const reply = (d, st = 200) => route.fulfill({ status: st, json: single ? (Array.isArray(d) ? d[0] ?? null : d) : d });
    if (r.method() === 'GET') return reply(filt(T[t], url));
    if (r.method() === 'POST') {
      let body = JSON.parse(r.postData() || '{}'); body = Array.isArray(body) ? body : [body];
      const out = body.map(b => {
        if (t === 'label_lists') { const l = { id: randomUUID(), created_by: uid, created_by_name: 'Test shelf', submitted_at: null, exported_at: null, ...b }; T.label_lists.push(l); return l; }
        const ex = T.label_items.find(i => i.list_id === b.list_id && i.barcode === b.barcode);
        if (ex) { Object.assign(ex, b); return ex; }
        const it = { id: randomUUID(), ...b }; T.label_items.push(it); return it;
      });
      return reply(out, 201);
    }
    if (r.method() === 'PATCH') { const p = JSON.parse(r.postData()); const rows = filt(T[t], url); rows.forEach(x => Object.assign(x, p)); return reply(rows); }
    if (r.method() === 'DELETE') { const rows = filt(T[t], url); T[t] = T[t].filter(x => !rows.includes(x)); return reply(rows); }
    return reply([]);
  });
  await page.evaluate(() => { window.__exports = []; XLSX.writeFile = (wb, name) => window.__exports.push({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }), types: Object.values(wb.Sheets[wb.SheetNames[0]]).filter(c => c && c.t).map(c => c.t).join('') }); switchTab('labels'); });
  await page.waitForTimeout(800);

  if (process.env.SHELF) {
    for (const code of ['0012345678905', '5281018709276', '0012345678905']) await page.evaluate(c => Labels._addCode(c, true), code);
    await page.waitForTimeout(800);
    await page.click('.lb-row[data-code="5281018709276"] [data-q="1"]'); await page.click('.lb-row[data-code="5281018709276"] [data-q="1"]');
    await page.fill('#lbCode', '96385074'); await page.click('#lbManual button'); await page.waitForTimeout(800);
    log('list on screen:', await page.$$eval('.lb-row', rs => rs.map(r => r.querySelector('.lb-code').textContent + ' x' + r.querySelector('input').value).join(', ')));
    log('summary:', (await page.textContent('.lb-summary')).replace(/\s+/g, ' ').trim());
    log('saved rows:', JSON.stringify(T.label_items.map(i => i.barcode + ':' + i.qty)));
    await page.screenshot({ path: join(dir, 'labels_shelf.png') });
    await page.click('#lbDone'); await page.waitForTimeout(300); await page.click('#modalConfirm'); await page.waitForTimeout(1000);
    log('after Done: list submitted =', !!T.label_lists[0]?.submitted_at, '| page:', (await page.textContent('#lbBody')).replace(/\s+/g, ' ').trim().slice(0, 60));
  } else {
    log('to print:', (await page.textContent('#lbBody')).replace(/\s+/g, ' ').trim().slice(0, 160));
    await page.screenshot({ path: join(dir, 'labels_print.png') });
    await page.click('#lbExport'); await page.waitForTimeout(1000);
    const ex = await page.evaluate(() => window.__exports);
    log('excel:', ex[0]?.name, JSON.stringify(ex[0]?.rows), '| cell types:', ex[0]?.types);
    log('lists exported:', T.label_lists.filter(l => l.exported_at).map(l => l.id).join(','), '| open list untouched:', !T.label_lists.find(l => l.id === 'L3').exported_at);
    log('page after export:', (await page.textContent('#lbBody')).replace(/\s+/g, ' ').trim().slice(0, 60));
  }
}
