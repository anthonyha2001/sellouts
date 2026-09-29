// Applies a 20% rule, overrides one row by hand, then screenshots (saves are faked in-page;
// smoke.mjs blocks any real write anyway).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  await page.evaluate(() => { window.updateSelloutFields = async () => true; updateSelloutFields = window.updateSelloutFields; });
  await page.click('#selloutList .sellout .sellout-head .who');
  await page.waitForTimeout(400);
  await page.fill('#selloutList .sellout.open [data-role="price-value"]', '20');
  await page.click('#selloutList .sellout.open [data-role="apply-all"]');
  await page.waitForTimeout(400);
  const inputs = await page.$$('#selloutList .sellout.open [data-role="new-price"]');
  await inputs[1].fill('4.99'); await inputs[1].press('Enter');           // not lower than old 6.33? it is lower; 21% off
  await page.waitForTimeout(300);
  const again = await page.$$('#selloutList .sellout.open [data-role="new-price"]');
  await again[2].fill('9'); await again[2].press('Enter');                 // above old price -> warning
  await page.waitForTimeout(400);
  const rows = await page.$$eval('#selloutList .sellout.open .so-price-table tbody tr', trs => trs.slice(0, 4).map(tr =>
    [...tr.querySelectorAll('td')].slice(1, 7).map(td => td.querySelector('input')?.value ?? td.textContent.trim()).join(' | ')
    + (tr.querySelector('.big-discount-dot') ? '  ⚠ ' + tr.querySelector('.big-discount-dot').title : '')));
  rows.forEach(r => log(r));
  log('summary:', await page.$eval('#selloutList .sellout.open .so-price-summary', e => e.textContent.replace(/\s+/g, ' ').trim()));
  await page.screenshot({ path: join(process.env.SHOT_DIR || tmpdir(), 'so_priced.png') });
}
