// Floor check grouping: by supplier, by sell-out / promotion, and the Show filter. Uses floor-mock's in-memory tables.
import floor from './floor-mock.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, ctx) {
  const dir = process.env.SHOT_DIR || tmpdir();
  await page.evaluate(() => localStorage.removeItem('lv:floorView'));
  await floor(page, { log: () => {} });
  await page.click('#fcTabs [data-tab="today"]'); await page.waitForTimeout(800);
  await page.click('.fc-filters [data-f="all"]'); await page.waitForTimeout(300);
  const heads = async () => page.$$eval('.fc-group-head', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  const h1 = await heads();
  ctx.log(`by supplier: ${h1.length} groups ->`, h1.slice(0, 6).join(' | '), h1.length > 6 ? '…' : '');
  await page.screenshot({ path: join(dir, 'floor_by_supplier.png') });
  await page.click('.fc-view [data-group="source"]'); await page.waitForTimeout(300);
  const h2 = await heads();
  ctx.log(`by sell-out / promotion: ${h2.length} groups ->`, h2.join(' | '));
  await page.screenshot({ path: join(dir, 'floor_by_source.png') });
  await page.click('.fc-view [data-show="promotion"]'); await page.waitForTimeout(300);
  ctx.log('show promotions only ->', (await heads()).join(' | '));
  await page.click('.fc-view [data-show="sellout"]'); await page.click('.fc-view [data-group="supplier"]'); await page.waitForTimeout(300);
  ctx.log('sell-outs by supplier ->', (await heads()).length, 'groups; remembered view:', await page.evaluate(() => localStorage.getItem('lv:floorView')));
}
