// Import mapping step with a generated file (leading-zero codes, "1,250.50" prices) + archive flag.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  const bytes = await page.evaluate(() => {
    const ws = XLSX.utils.aoa_to_sheet([['Barcode No', 'Item Description', 'Qty', 'Retail Price'],
      ['00123', 'TEST ITEM ONE', 5, '1,250.50'], ['04567', 'TEST ITEM TWO', 3, 2.4], ['7788', 'NO PRICE ITEM', 1, '']]);
    ws['A2'].t = 's'; ws['A3'].t = 's';
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S');
    return Array.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
  });
  await page.click('#openAddSelloutBtn');
  await page.setInputFiles('#soFile', { name: 'test.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => ({
    code: document.getElementById('soMapCode').value, desc: document.getElementById('soMapDesc').value, price: document.getElementById('soMapPrice').value,
    preview: [...document.querySelectorAll('#soMapping tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()),
    warn: document.querySelector('#soMapping p')?.textContent.trim(),
  }));
  log('detected:', JSON.stringify({ code: m.code, desc: m.desc, price: m.price }));
  m.preview.forEach(p => log('preview:', p)); log('note:', m.warn);
  await page.screenshot({ path: join(process.env.SHOT_DIR || tmpdir(), 'so_import.png') });
  await page.click('#cancelAddSelloutBtn');
  const a = await page.evaluate(() => {
    const so = sellouts[0]; const keep = { active: so.active, to: so.to };
    so.active = false; so.to = '2026-09-01';
    const out = { flag: actionFlag(so), needs: (currentFilter = 'needsaction', applyFilter(sellouts).length) };
    currentFilter = 'all'; renderSellouts();
    out.pill = document.getElementById('selloutsPill').hidden ? 'hidden' : document.getElementById('selloutsPill').textContent;
    out.archiveEnabled = !document.querySelector('#selloutList .sellout [data-role="archive"]').disabled;
    Object.assign(so, keep); renderSellouts();
    return out;
  });
  log('ended+inactive ->', JSON.stringify(a));
}
