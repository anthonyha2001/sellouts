// Sell-outs Phase 2 checks against live data (writes blocked by smoke.mjs).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  const r = await page.evaluate(() => ({
    columns: sellouts.map(s => { const m = detectColumns(s.items); const rows = pricedRowsOf(s);
      return `${s.name}: code=${m.code} desc=${m.description} price=${m.price} | ${rows.filter(p => p.oldPrice !== null).length}/${rows.length} have a price`; }),
    math: {
      'percent 20 of 3.50 (3.5*0.8=2.80)': computeNewPrice(3.5, 'percent', 20),
      'percent 15 of 1.99 (1.6915 -> 1.70)': computeNewPrice(1.99, 'percent', 15),
      'amount 0.30 off 2.10 (1.80)': computeNewPrice(2.1, 'amount', 0.3),
      'fixed 2.957 (2.96)': computeNewPrice(1, 'fixed', 2.957),
      'percent with no old price (null)': computeNewPrice(null, 'percent', 20),
      'discount of 3.50->2.80 (20)': discountPct({ oldPrice: 3.5, newPrice: 2.8 }),
      'warnings 2.00->2.10': priceWarnings({ oldPrice: 2, newPrice: 2.1 }).join('; '),
      'warnings 2.00->1.20 (40%)': priceWarnings({ oldPrice: 2, newPrice: 1.2 }).join('; '),
      'parseNum "1,234.50"': parseNum('1,234.50'), 'parseNum "3,5"': parseNum('3,5'),
    },
    filters: ['all', 'needsaction', 'active', 'upcoming', 'archived'].map(f => { currentFilter = f; return f + '=' + applyFilter(sellouts).length; }).join(' '),
    flags: sellouts.map(s => actionFlag(s)).filter(Boolean),
    pill: document.getElementById('selloutsPill').textContent,
  }));
  currentFilterReset: await page.evaluate(() => { currentFilter = 'all'; renderSellouts(); });
  r.columns.forEach(c => log(c));
  Object.entries(r.math).forEach(([k, v]) => log(k, '=>', JSON.stringify(v)));
  log('filters:', r.filters, '| flags:', r.flags.join(',') || 'none', '| pill:', r.pill || '(hidden)');
  await page.click('#selloutList .sellout .sellout-head .who');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(process.env.SHOT_DIR || tmpdir(), 'so_open.png'), fullPage: false });
}
