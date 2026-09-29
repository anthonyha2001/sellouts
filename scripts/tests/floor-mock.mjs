// Floor check UI test. floor_checks / floor_check_items are kept in memory here (migration 006 not
// applied yet); the sell-outs are the real ones (read-only). Nothing reaches the database.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  const tables = { floor_checks: [], floor_check_items: [] };
  // FAKE_TODAY=YYYY-MM-DD makes the page believe it is that day (to test a promotion that is not running yet).
  const today = process.env.FAKE_TODAY || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  if (process.env.FAKE_TODAY) await page.addInitScript(d => { window.__fakeToday = d; }, process.env.FAKE_TODAY);
  const fakeDay = async () => { if (process.env.FAKE_TODAY) await page.evaluate(d => { beirutToday = () => d; }, process.env.FAKE_TODAY); };
  await fakeDay();
  const filt = (rows, url) => {
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      const [op, ...rest] = v.split('.'); const val = rest.join('.');
      if (op === 'eq') rows = rows.filter(r => String(r[k]) === val);
      if (op === 'neq') rows = rows.filter(r => String(r[k]) !== val);
      if (op === 'gt') rows = rows.filter(r => r[k] && String(r[k]) > val);
      if (op === 'gte') rows = rows.filter(r => String(r[k]) >= val);
      if (op === 'in') { const set = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/"/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); }
    }
    return rows;
  };
  await page.route(/\/rest\/v1\/(floor_checks|floor_check_items)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop();
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    const reply = (data, status = 200) => route.fulfill({ status, json: single ? (Array.isArray(data) ? data[0] ?? null : data) : data });
    if (r.method() === 'GET') return reply(filt(tables[t], url).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    if (r.method() === 'POST') {
      let body = JSON.parse(r.postData() || '{}'); body = Array.isArray(body) ? body : [body];
      const made = body.map(b => t === 'floor_checks'
        ? { id: randomUUID(), check_date: today, started_by: 'me', started_at: new Date().toISOString(), completed_at: null, summary: null, ...b }
        : { id: randomUUID(), status: 'pending', note: null, photo_path: null, resolved: false, ...b });
      if (t === 'floor_checks') made.forEach(m => { m.started_by = page._uid; });
      tables[t].push(...made);
      return reply(made, 201);
    }
    if (r.method() === 'PATCH') {
      const patch = JSON.parse(r.postData() || '{}');
      const rows = filt(tables[t], url); rows.forEach(x => Object.assign(x, patch));
      return reply(rows);
    }
    return reply([]);
  });
  page._uid = await page.evaluate(() => Session.user.id);
  await page.evaluate(() => { location.hash = '#floorcheck'; });
  await page.waitForTimeout(1500);
  log('before start:', (await page.textContent('#fcBody')).replace(/\s+/g, ' ').trim().slice(0, 80));
  await page.click('#fcStart');
  await page.waitForTimeout(2500);
  const items = tables.floor_check_items;
  log('by source:', JSON.stringify(items.reduce((m, x) => (m[x.source + ': ' + x.source_name] = (m[x.source + ': ' + x.source_name] || 0) + 1, m), {})));
  log('items created:', items.length, '| first:', items[0]?.source_name, '| with expected price:', items.filter(i => i.expected_price !== null).length,
      '| priority 0 first:', items.every((x, i) => i === 0 || items[i - 1].priority <= x.priority));
  // mark a few
  const cards = await page.$$('.fc-item');
  await (await cards[0].$('[data-status="ok"]')).click(); await page.waitForTimeout(300);
  await (await (await page.$$('.fc-item'))[0].$('[data-status="wrong_price"]')).click(); await page.waitForTimeout(300);
  await (await (await page.$$('.fc-item'))[0].$('[data-status="missing_tag"]')).click(); await page.waitForTimeout(300);
  log('progress:', (await page.textContent('.fc-progress-top')).replace(/\s+/g, ' ').trim(), '| statuses:', JSON.stringify(tables.floor_check_items.slice(0, 4).map(x => x.status)));
  await page.screenshot({ path: join(dir, 'floor_today.png') });
  // resume: reload the page, the same check comes back (skipped with FAKE_TODAY: the reload
  // would briefly run with the real date before the fake one is applied again)
  if (!process.env.FAKE_TODAY) {
    await page.reload(); await page.waitForTimeout(6000);
    await page.evaluate(() => { location.hash = '#floorcheck'; }); await page.waitForTimeout(1500);
    log('after reload:', (await page.textContent('.fc-progress-top')).replace(/\s+/g, ' ').trim());
  }
  // finish
  await page.click('#fcFinish'); await page.waitForTimeout(300);
  await page.click('#modalConfirm'); await page.waitForTimeout(800);
  log('finished summary:', JSON.stringify(tables.floor_checks[0].summary));
  await page.click('#fcTabs [data-tab="results"]'); await page.waitForTimeout(800);
  await page.click('#fcBody [data-check] [data-toggle]'); await page.waitForTimeout(800);
  log('results:', (await page.textContent('#fcBody')).replace(/\s+/g, ' ').trim().slice(0, 220));
  await page.screenshot({ path: join(dir, 'floor_results.png') });
}
