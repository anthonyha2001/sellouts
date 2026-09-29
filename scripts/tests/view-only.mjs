// Accountant: sell-outs and promotions are view + download only (archive sell-outs allowed).
// Run as accountant and as admin; prints which controls are visible and whether any write was sent.
export default async function (page, { log }) {
  const writes = [];
  page.on('request', r => { if (/\/rest\/v1\/(sellouts|promotions|promotion_rows|catalog_items|app_settings)/.test(r.url()) && r.method() !== 'GET') writes.push(r.method() + ' ' + new URL(r.url()).pathname.split('/').pop()); });
  const vis = sels => page.evaluate(sels => sels.map(s => { const e = document.querySelector(s); return `${s}:${e && e.offsetParent !== null ? 'shown' : 'hidden'}`; }).join(' '), sels);

  await page.evaluate(() => switchTab('sellouts')); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelector('#panel-sellouts .sellout-head')?.click()); await page.waitForTimeout(600);
  log('sell-outs:', await vis(['#openAddSelloutBtn', '#panel-sellouts [data-role="edit"]', '#panel-sellouts [data-role="duplicate"]', '#panel-sellouts [data-role="delete"]', '#panel-sellouts [data-role="download"]', '#panel-sellouts [data-role="export"]', '#panel-sellouts .so-price-controls']));
  log('sell-outs: price input disabled:', await page.evaluate(() => document.querySelector('.so-new-price')?.disabled), '| active switch disabled:', await page.evaluate(() => document.querySelector('[data-role="active-toggle"]')?.disabled), '| archive btn present:', await page.evaluate(() => !!document.querySelector('#panel-sellouts [data-role="archive"], #panel-sellouts [data-role="unarchive"]')));

  await page.evaluate(() => switchTab('promotions')); await page.waitForTimeout(2500);
  log('promotions:', await vis(['#newPromoBtn', '#catalogFileInput', '#importPriceSheetBtn', '#deletePromoBtn', '#toggleArchivePromoBtn', '#addRowBtn', '#exportPromoBtn', '#copyCodesBtn', '[data-role="remove-row"]']));
  log('promotions: row inputs read-only:', await page.evaluate(() => { const i = [...document.querySelectorAll('#promoWorkspace input[data-field]')]; return i.length ? i.every(x => x.readOnly) + ` (${i.length})` : 'no rows'; }),
      '| name read-only:', await page.evaluate(() => document.getElementById('promoName')?.readOnly));
  // Try to change something anyway (as a user forcing it): the data layer must refuse.
  await page.evaluate(async () => { const p = promotions[0]; if (p) await savePromotion({ ...p, name: p.name }); });
  await page.waitForTimeout(500);
  log('write requests sent:', JSON.stringify(writes));
}
