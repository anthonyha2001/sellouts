// Floor check "Scan an item": the scanner is handed a code (no camera), the page must jump to the item.
import floor from './floor-mock.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  await page.evaluate(() => localStorage.removeItem('lv:floorView'));
  await floor(page, { log: () => {} });                       // starts a check (in memory) and finishes it
  await page.click('#fcTabs [data-tab="today"]'); await page.waitForTimeout(800);
  const info = await page.evaluate(async () => {
    const res = {};
    const scanWith = code => new Promise(resolve => {
      const orig = Scanner.open;
      Scanner.open = opts => { const html = opts.onCode(code, 'ean_13'); Scanner.open = orig; resolve(html); };
      document.getElementById('fcScan') ? document.getElementById('fcScan').click() : resolve('no scan button (finished check)');
    });
    res.unknown = await scanWith('0000000000000');
    res.known = await scanWith('5281018709276');
    await new Promise(r => setTimeout(r, 300));
    const card = document.querySelector('.fc-item.fc-focus');
    res.focused = card ? card.querySelector('.fc-desc').textContent + ' · ' + card.querySelector('.fc-code').textContent : 'none';
    res.groupOpen = card ? card.closest('.fc-group')?.classList.contains('open') : false;
    return res;
  });
  log('unknown barcode ->', info.unknown);
  log('IBI barcode 5281018709276 -> focused:', info.focused, '| its group open:', info.groupOpen);
  await page.screenshot({ path: join(process.env.SHOT_DIR || tmpdir(), 'floor_scan.png') });
}
