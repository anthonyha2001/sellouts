// Admin side of the floor check: results with resolve, and repeat problems (in-memory tables).
import floor from './floor-mock.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, ctx) {
  await floor(page, { log: () => {} });                 // admin does a check and finishes it (same flow)
  await page.click('#fcBody [data-resolve]'); await page.waitForTimeout(600);
  ctx.log('after resolve:', await page.$$eval('#fcBody [data-resolve]', b => b.map(x => x.textContent).join(', ')));
  await page.click('#fcTabs [data-tab="repeats"]'); await page.waitForTimeout(1200);
  ctx.log('repeats tab:', (await page.textContent('#fcBody')).replace(/\s+/g, ' ').trim().slice(0, 120));
  ctx.log('tabs:', await page.$$eval('#fcTabs button', b => b.map(x => x.textContent).join(' | ')));
  await page.click('#fcTabs [data-tab="today"]'); await page.waitForTimeout(800);
  await page.click('.fc-filters [data-f="all"]'); await page.waitForTimeout(400);
  await page.screenshot({ path: join(process.env.SHOT_DIR || tmpdir(), 'floor_admin.png') });
}
