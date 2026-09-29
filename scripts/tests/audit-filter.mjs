// Audit: every item shown (with or without cost), type filter, Copy codes = filtered codes grouped by supplier.
export default async function (page, { log }) {
  await page.evaluate(() => { window.__copied = []; window.copyTextToClipboard = async t => { window.__copied.push(t); return true; }; switchTab('promotions'); });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => { promoViewMode = 'audit'; auditSubView = 'cost'; await renderPromoWorkspace(); });
  await page.waitForTimeout(500);
  const counts = await page.evaluate(() => ({ rows: currentRows.length, nonBlank: currentRows.filter(r => (r.code || '').trim() || (r.description || '').trim()).length,
    withCost: currentRows.filter(r => r.cost !== null && r.cost !== undefined && r.cost !== '').length, auditShown: document.querySelectorAll('#promoAuditCostView tbody tr').length }));
  log('rows:', JSON.stringify(counts));
  log('type chips:', (await page.textContent('#auditTypeFilter')).replace(/\s+/g, ' ').trim());
  // Mark two items locally (no save) as Sell Out from different suppliers, then filter.
  await page.evaluate(async () => {
    const bySup = new Map(); currentRows.filter(r => (r.code || '').trim()).forEach(r => { const s = (r.supplier || '').trim() || 'No supplier listed'; if (!bySup.has(s)) bySup.set(s, r); });
    [...bySup.values()].slice(0, 2).forEach(r => { r.priceType = 'sellout'; });
    const cnRow = currentRows.find(r => (r.code || '').trim() && !r.priceType); if (cnRow) cnRow.priceType = 'cn';
    await renderPromoWorkspace();
  });
  await page.click('#auditTypeFilter [data-audit-type="sellout"]'); await page.waitForTimeout(400);
  log('after Sell Out filter:', (await page.textContent('#auditTypeFilter')).replace(/\s+/g, ' ').trim(), '| rows shown:', await page.$$eval('#promoAuditCostView tbody tr', r => r.length), '| button:', await page.textContent('#copyAuditCodesBtn'));
  await page.click('#copyAuditCodesBtn'); await page.waitForTimeout(300);
  log('copied:\n' + (await page.evaluate(() => window.__copied.at(-1))));
  // By supplier sub-view keeps the filter; its per-supplier copy too.
  await page.click('#auditSubViewSwitch [data-audit-sub="supplier"]'); await page.waitForTimeout(400);
  log('by supplier groups:', await page.$$eval('#promoAuditSupplierView [data-supplier-group]', g => g.map(x => x.dataset.supplierGroup + ' ' + x.querySelector('.dates').textContent).join(' | ')));
  await page.click('#promoAuditSupplierView [data-role="copy-supplier-codes"]'); await page.waitForTimeout(300);
  log('per-supplier copy:', await page.evaluate(() => window.__copied.at(-1)));
  await page.click('#auditTypeFilter [data-audit-type="none"]'); await page.waitForTimeout(400);
  log('No type filter:', (await page.textContent('#copyAuditCodesBtn')));
}
