// Visits every Delivery page the signed-in role can see and screenshots each one.
// Used with: node --env-file=.env scripts/smoke.mjs "index.html#delivery/orders" --login ... --steps scripts/tests/delivery-tour.mjs
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  const tag = process.env.SHOT_TAG || 'dt';
  const pages = await page.$$eval('#dtNav button', bs => bs.filter(b => !b.hidden).map(b => b.dataset.page));
  log('visible delivery pages:', pages.join(', ') || '(none)');
  const navShown = await page.isVisible('#dtNav');   // hidden when the role has a single page
  for (const p of pages) {
    if (navShown) await page.click(`#dtNav button[data-page="${p}"]`);
    else await page.goto(page.url().replace(/#.*$/, '') + '#delivery/' + p);
    await page.waitForTimeout(600);
    if (p === 'orders') {
      await page.click('#dayPrev');            // step back to a day that has orders
      await page.waitForTimeout(400);
      const info = await page.$$eval('#ordersBody tr.row', rows => ({
        rows: rows.length,
        edit: rows.filter(r => r.querySelector('[data-act=edit]')).length,
        del: rows.filter(r => r.querySelector('[data-act=del]')).length,
      }));
      log('orders on previous day:', JSON.stringify(info));
    }
    if (p === 'settle') {
      const first = await page.$('#settleCards .dcard');
      if (first) { await first.click(); await page.waitForTimeout(400); }
    }
    const file = join(dir, `${tag}_${p}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log('shot', file);
  }
}
