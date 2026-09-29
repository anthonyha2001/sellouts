// Tools › PDF / photo to Excel, end to end (files from make-table-files.mjs):
// the digital PDF (2 pages) and a photo of the same table; checks the rebuilt rows and columns,
// the numbers / barcodes in the downloaded .xlsx, and the edit buttons.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
export default async function (page, { log }) {
  await page.evaluate(() => switchTab('tools')); await page.waitForTimeout(500);
  const rows = () => page.evaluate(() => Tools._state.tables.map(t => ({ name: t.name, ocr: t.ocr, rows: t.rows.map(r => r.map(c => c.t + (c.low ? '?' : ''))) })));

  for (const [label, file, wait] of [['PDF', 'lv-pricelist.pdf', 15000], ['PHOTO', 'lv-pricelist-photo.jpg', 90000]]) {
    await page.setInputFiles('#toolFile', join(tmpdir(), file));
    await page.waitForFunction(() => !Tools._state.busy && Tools._state.tables.length, null, { timeout: wait });
    await page.waitForTimeout(300);
    const r = await rows();
    log(`${label}: ${r.length} table(s)`);
    r.forEach(t => { log(`  ${t.name}${t.ocr ? ' (OCR)' : ''}:`); t.rows.forEach(x => log('    | ' + x.join(' | '))); });
    const dl = page.waitForEvent('download', { timeout: 10000 });
    await page.click('#toolDownload');
    const d = await dl;
    const path = join(tmpdir(), 'lv-' + d.suggestedFilename());
    await d.saveAs(path);
    // Read the downloaded file back with the page's own SheetJS.
    const info = await page.evaluate(b64 => {
      const wb = XLSX.read(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { type: 'array' });
      return wb.SheetNames.map(n => {
        const ws = wb.Sheets[n];
        const cells = Object.keys(ws).filter(k => /^[A-Z]+\d+$/.test(k));
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
        const codeRow = aoa.find(r => /^00\d+/.test(String(r[0] ?? ''))) || [];
        return `sheet "${n}": ${cells.length} cells, ${aoa.length} rows · first code row: ${codeRow.map(v => `${v}(${typeof v === 'number' ? 'n' : 's'})`).join(' | ')}`;
      });
    }, readFileSync(path).toString('base64'));
    info.forEach(i => log(`  xlsx ${d.suggestedFilename()} ${i}`));
  }
  // edit tools on the photo result: delete the first row, merge row 2 into 1, delete last column
  const before = await page.evaluate(() => { const t = Tools._state.tables[0]; return [t.rows.length, t.rows[0].length]; });
  await page.click('[data-delrow="0"]'); await page.click('[data-mergerow="1"]');
  const lastCol = await page.$$eval('[data-delcol]', b => b.length - 1); await page.click(`[data-delcol="${lastCol}"]`);
  const after = await page.evaluate(() => { const t = Tools._state.tables[0]; return [t.rows.length, t.rows[0].length]; });
  log('edit buttons: rows x cols', before.join('x'), '->', after.join('x'));
  log('cellValue:', await page.evaluate(() => JSON.stringify(['1,234.50', '(12.00)', '0012345678905', '96385074', '12 %', '$9.60'].map(v => [v, Tools._cellValue(v)]))));
  // Debit / Credit: two sparse columns side by side must stay apart
  log('debit/credit kept apart:', await page.evaluate(() => {
    const w = (t, x, y) => ({ t, x0: x, x1: x + t.length * 7, y0: y, y1: y + 12, conf: 100 });
    const words = [w('Date', 0, 0), w('Debit', 200, 0), w('Credit', 300, 0),
      ...[...Array(8).keys()].flatMap(i => [w('0' + (i + 1) + '/09', 0, 20 + i * 20), i % 2 ? w('50.00', 200, 20 + i * 20) : w('75.00', 300, 20 + i * 20)])];
    return Tools._toTable(words)[0].map(c => c.t).join(' | ');
  }));
}
