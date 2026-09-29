// Offer import review screen with a stand-in extract-offer answer (the function is not called).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  // Real catalog items of the open promotion, to build lines that must match.
  const cat = await page.evaluate(() => catalogItems.slice(0, 3).map(i => ({ code: i.code, description: i.description })));
  log('promotion:', await page.evaluate(() => promotions.find(p => p.id === currentPromoId)?.name), '| catalog items:', await page.evaluate(() => catalogItems.length));
  const lines = [
    { barcode: '5281018709276', supplier_code: cat[0].code, description: cat[0].description, old_price: 3.5, promo_price: 2.95, discount_pct: null, pack_note: null, confidence: 0.95, source_file: 1, source_page: 1 },
    { barcode: '4006381333932', supplier_code: null, description: cat[1].description, old_price: null, promo_price: null, discount_pct: 20, pack_note: '5+1', confidence: 0.9, source_file: 1, source_page: 1 },
    { barcode: null, supplier_code: 'X-99', description: cat[2].description.split(' ').slice(0, 3).join(' '), old_price: 4, promo_price: 3.2, discount_pct: null, pack_note: null, confidence: 0.55, source_file: 1, source_page: 1 },
  ];
  await page.route(/\/functions\/v1\/extract-offer/, r => r.fulfill({ json: { lines, model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 300 } } }));
  await page.route(/\/storage\/v1\/object\/list\/promotion-offers/, r => r.fulfill({ json: [] }));
  await page.click('#offerImportBtn');
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#000'; g.font = '20px sans-serif'; g.fillText('OFFER 2.95', 40, 100); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('#offerFiles', { name: 'whatsapp-offer.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForTimeout(500);
  await page.click('#offerExtract'); await page.waitForTimeout(1200);
  const rows = await page.$$eval('.offer-table tbody tr', trs => trs.map(t => ({ cls: t.className, code: t.querySelector('[data-f=code]').value,
    check: t.querySelector('.offer-checks').textContent.replace(/\s+/g, ' ').trim(), suggest: t.querySelectorAll('[data-pick]').length })));
  rows.forEach((r, i) => log(`line ${i + 1}:`, JSON.stringify(r)));
  log('subtitle:', await page.textContent('#offerSub'));
  await page.screenshot({ path: join(dir, 'offer_review.png') });
  // Pick the first suggestion on line 3, then round-trip the export through the price-sheet import.
  const pick = await page.$('.offer-table tbody tr:nth-child(3) [data-pick]'); if (pick) { await pick.click(); await page.waitForTimeout(300); }
  const rt = await page.evaluate(() => {
    const wb = OfferImport._buildSheet(OfferImport._state.lines);
    const res = parsePriceSheetRows(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    return res.error || res.rows.map(r => ({ code: r.code, barcode: r.barcode, promo: r.promoPrice, before: r.beforePrice, discount: r.discount, cost: r.cost, sale: r.salePrice, supplier: r.supplier }));
  });
  log('round trip through "Import price sheet":', JSON.stringify(rt));
}
