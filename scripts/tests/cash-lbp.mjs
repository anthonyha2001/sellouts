// Cash grid in LBP and the column rule, before migration 015 is applied: the live USD rows are served
// as they will be after 015 (amount = the original LBP amount, currency LBP; levels × 89,500).
// Checks the current month (active + with entries, idle-cashier banner) and a past month (only cashiers with entries).
export default async function (page, { log }) {
  await page.route(/\/rest\/v1\/cash_differences/, async route => {
    const req = route.request();
    if (req.method() !== 'GET') return route.fulfill({ status: 200, json: [] });
    const url = req.url().replace('currency=eq.LBP', 'currency=eq.USD');
    const res = await route.fetch({ url });
    let rows = await res.json();
    if (Array.isArray(rows)) rows = rows.map(r => ({ ...r, amount: r.source_amount != null ? Math.round(r.source_amount) : r.amount, currency: 'LBP' }));
    return route.fulfill({ response: res, json: rows });
  });
  await page.route(/\/rest\/v1\/cash_settings/, async route => {
    const res = await route.fetch();
    const d = await res.json();
    const conv = s => ({ ...s, currency: 'LBP', warning_threshold: s.warning_threshold * 89500, danger_threshold: s.danger_threshold * 89500 });
    return route.fulfill({ response: res, json: Array.isArray(d) ? d.map(conv) : conv(d) });
  });
  await page.reload(); await page.waitForTimeout(7000);
  await page.evaluate(() => switchTab('cash')); await page.waitForTimeout(3500);
  const info = () => page.evaluate(() => ({
    month: document.getElementById('cashMonth').value,
    cols: [...document.querySelectorAll('.cash-grid thead th')].slice(1, -1).map(t => t.textContent.trim()),
    firstCells: [...document.querySelectorAll('.cash-grid tbody tr')].slice(0, 3).map(tr => [...tr.querySelectorAll('input')].map(i => i.value).filter(Boolean).slice(0, 3).join(' ')),
    total: document.querySelector('.cash-grid tfoot td:last-child')?.textContent.trim(),
    legend: document.querySelector('.cash-legend')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 110),
    banner: document.querySelector('.cash-idle')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 300) || '(none)',
  }));
  const cur = await info();
  log('this month', cur.month, `· ${cur.cols.length} columns:`, cur.cols.join(', '));
  log('  cells:', cur.firstCells.join(' / '), '| month total:', cur.total);
  log('  legend:', cur.legend);
  log('  idle banner:', cur.banner);
  await page.evaluate(() => document.getElementById('cashPrev').click()); await page.waitForTimeout(2500);
  const past = await info();
  log('past month', past.month, `· ${past.cols.length} columns:`, past.cols.join(', '));
  log('  month total:', past.total);
  await page.evaluate(() => document.getElementById('cashNext').click()); await page.waitForTimeout(2500);
}
