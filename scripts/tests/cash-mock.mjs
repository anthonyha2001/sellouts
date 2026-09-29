// Cash (Phase 4) UI test with made-up data served in place of the cash tables, so it runs before
// migration 005 exists. Nothing is written anywhere: writes to the mocked tables get a fake success.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cashiers = [
  { id: 'c1', name: 'Rita', active: true, sort_order: 1, has_pin: true, failed_attempts: 0, locked_until: null },
  { id: 'c2', name: 'Joe', active: true, sort_order: 2, has_pin: false, failed_attempts: 0, locked_until: null },
  { id: 'c3', name: 'Maya', active: true, sort_order: 3, has_pin: true, failed_attempts: 5, locked_until: new Date(Date.now() + 6e5).toISOString() },
  { id: 'c4', name: 'Old Sam', active: false, sort_order: 4, has_pin: false, failed_attempts: 0, locked_until: null },
];
const settings = { id: 'app', currency: 'USD', warning_threshold: 10, danger_threshold: 20, alert_short_count: 3, alert_short_streak: 3, reminder_hour: 12 };
// 12 months of data, deterministic; Joe has a bad September (3 shortages >= $10 and 3 short days in a row).
const rows = [];
let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
for (let m = 0; m < 12; m++) {
  const d0 = new Date(Date.UTC(2025, 9 + m, 1)); const ym = d0.toISOString().slice(0, 7);
  for (let day = 1; day <= 28; day++) for (const c of cashiers.slice(0, 3)) {
    if (rnd() < 0.35) continue;
    let amt = Math.round((rnd() - 0.55) * 24 * 100) / 100;
    if (c.id === 'c2' && ym === '2026-09' && day >= 10 && day <= 12) amt = -14 - day;
    rows.push({ id: `${c.id}-${ym}-${day}`, cashier_id: c.id, day: `${ym}-${String(day).padStart(2, '0')}`, amount: amt, note: day === 5 && c.id === 'c1' ? 'Counted twice' : null, currency: 'USD', source_amount: null, source_currency: null, source_rate: null });
  }
}
rows.push({ id: 'sam', cashier_id: 'c4', day: '2026-09-03', amount: -3, note: null, currency: 'USD' });

export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  const writes = [];
  await page.route(/\/rest\/v1\/(cashiers|cash_differences|cash_months|cash_settings)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), table = url.pathname.split('/').pop();
    if (r.method() !== 'GET' && r.method() !== 'HEAD') { writes.push(`${r.method()} ${table}`); return route.fulfill({ status: 201, json: r.method() === 'POST' && table === 'cashiers' ? { ...cashiers[0], id: 'new', name: 'New' } : [] }); }
    let data = { cashiers, cash_settings: [settings], cash_months: [], cash_differences: rows }[table];
    for (const [k, v] of url.searchParams) {
      const [op, val] = [v.split('.')[0], v.split('.').slice(1).join('.')];
      if (k === 'day' && op === 'gte') data = data.filter(x => x.day >= val);
      if (k === 'day' && op === 'lte') data = data.filter(x => x.day <= val);
      if (k === 'day' && op === 'eq') data = data.filter(x => x.day === val);
    }
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    return route.fulfill({ status: 200, headers: { 'content-range': `0-${Math.max(0, data.length - 1)}/${data.length}`, 'access-control-expose-headers': 'content-range' },
      json: single ? (data[0] ?? null) : data });
  });
  await page.evaluate(() => { location.hash = '#cash'; location.reload(); });
  await page.waitForTimeout(8000);
  await page.evaluate(async () => { Cash._state.month = '2026-09'; document.getElementById('cashMonth').value = '2026-09'; document.getElementById('cashMonth').dispatchEvent(new Event('change')); });
  await page.waitForTimeout(1500);
  const g = await page.evaluate(() => ({
    columns: [...document.querySelectorAll('.cash-grid thead th')].map(t => t.textContent.trim()),
    rows: document.querySelectorAll('.cash-grid tbody tr').length,
    warn: document.querySelectorAll('.cash-cell.lv-warn').length, danger: document.querySelectorAll('.cash-cell.lv-danger').length,
    notes: document.querySelectorAll('.cash-note.has-note').length,
    footer: document.querySelector('.cash-grid tfoot tr')?.textContent.replace(/\s+/g, ' ').trim(),
  }));
  log('grid:', JSON.stringify(g));
  await page.screenshot({ path: join(dir, 'cash_grid.png') });
  // Enter moves down
  await page.click('.cash-grid input[data-row="1"][data-col="0"]');
  await page.keyboard.press('Enter');
  log('after Enter, focus is on row', await page.evaluate(() => document.activeElement.dataset.row), 'col', await page.evaluate(() => document.activeElement.dataset.col));
  await page.click('#cashTabs [data-tab="analysis"]');
  await page.waitForTimeout(1500);
  log('summary:', await page.$$eval('.cash-summary tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()).join(' || ')));
  log('alerts:', await page.$$eval('.cash-alerts li', l => l.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ')) || 'none');
  const bars = await page.$$eval('.cash-trend', f => f.map(x => `${x.querySelector('b').textContent}: ${x.querySelectorAll('.bar-over').length} over / ${x.querySelectorAll('.bar-short').length} short`));
  log('trend:', bars.join(' | '));
  await page.hover('.cash-trend .hit[data-i="11"]');
  log('tooltip:', await page.$eval('#cashTip', t => t.hidden ? '(hidden)' : t.textContent));
  await page.screenshot({ path: join(dir, 'cash_analysis.png'), fullPage: true });
  await page.click('#cashTabs [data-tab="cashiers"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(dir, 'cash_cashiers.png'), fullPage: true });
  log('mock writes:', writes.join(', ') || 'none');
}
