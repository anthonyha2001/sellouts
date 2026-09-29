// Import preview for sheets shaped like the old Google Sheet (LBP), using cash-mock's stand-in tables.
import mock from './cash-mock.mjs';
export default async function (page, ctx) {
  const noop = { log: () => {} };
  await mock(page, noop);                                  // installs the stand-in tables and opens Cash
  const bytes = await page.evaluate(() => {
    const aug = [['Cash differences August'], [], ['Day of the month', 'Rita', 'Joe', '', 'Nadia'],
      [1, '249000', '-2500', '', ''], [2, '', '-895000', '77', '100,000'], [3, 'n/a', '', '', ''], ['Total', 1, 2, '', 3]];
    const cur = [['Day of the month', 'Rita', 'Joe'], [1, -89500, ''], [2, 179000, 44750]];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aug), 'AUG-2026');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cur), 'Current Month');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['notes only']]), 'Notes');
    return Array.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })));
  });
  await page.click('#cashTabs [data-tab="import"]');
  await page.setInputFiles('#cashImportFile', { name: 'cash.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(bytes) });
  await page.waitForTimeout(600);
  const rows = await page.$$eval('#cashImportPreview tbody tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  rows.forEach(r => ctx.log('tab:', r));
  ctx.log('new names:', await page.$$eval('[data-newname]', x => x.map(i => i.dataset.newname).join(', ')));
  ctx.log('problems:', await page.$$eval('.cash-problems li', l => l.map(x => x.textContent).join(' | ')));
  await page.screenshot({ path: (process.env.SHOT_DIR || '.') + '/cash_import.png', fullPage: true });
}
