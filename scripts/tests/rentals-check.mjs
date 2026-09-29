// Rentals Phase 3 UI check on live data; yearly contracts are simulated in memory only.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  await page.evaluate(() => { window.saveRentalRemote = async () => true; saveRentalRemote = window.saveRentalRemote; });
  const counts = await page.evaluate(() => {
    const out = { total: rentalsList.length, yearly_before: rentalsList.filter(r => r.term === 'yearly').length };
    // Simulate: supplier A has last year's and this year's side-gondola contract; B ends in 10 days.
    const [a, b, c] = rentalsList;
    Object.assign(a, { term: 'yearly', equipment: 'side_gondola', annual: 1500, dateFrom: '2026-06-06', dateTo: '2027-06-05', billed: true, billedAt: '2026-06-10' });
    Object.assign(b, { term: 'yearly', equipment: 'gondola', annual: 900, dateFrom: '2025-10-10', dateTo: addDaysStr(todayStr(), 10), billed: false });
    Object.assign(c, { term: 'other', equipment: 'screen_island' });
    rentalsList.push({ ...a, id: 'sim-prev', dateFrom: '2025-06-06', dateTo: '2026-06-05', annual: 1800, billed: true });
    rentalView.term = 'yearly'; renderRentalsPage();
    out.soon = rentalsList.filter(endingSoon).map(r => r.supplier);
    out.prevOfA = previousContract(a)?.annual;
    notifications.length = 0; localStorage.removeItem('lv:rentalNotifyLog');
    runRentalNotificationCheck(); const n1 = notifications.length; runRentalNotificationCheck(); out.notifs = [n1, notifications.length];
    return out;
  });
  log('rentals:', JSON.stringify(counts));
  log('yearly totals:', await page.$eval('#rentalTotals', e => e.textContent.replace(/\s+/g, ' ').trim()));
  await page.screenshot({ path: join(dir, 'rent_yearly.png') });
  await page.click('#rentalTermTabs [data-term="other"]');
  for (const t of ['gondola', 'basket_side', 'screens']) {
    await page.click(`#rentalTypeTabs [data-type="${t}"]`);
    log(`other/${t}:`, await page.$$eval('#rentalList [data-rental-id]', x => x.length), 'rows |', await page.$eval('#rentalTotals', e => e.textContent.replace(/\s+/g, ' ').trim()));
  }
  await page.click('#rentalTypeTabs [data-type="gondola"]');
  await page.screenshot({ path: join(dir, 'rent_other.png') });
  // Form adapts to the term
  await page.click('#addRentalBtn');
  const f = await page.evaluate(() => {
    const vis = () => [...document.querySelectorAll('#rentalFormCard [data-term-only]')].filter(x => !x.hidden).map(x => x.dataset.termOnly)[0];
    const opts = () => [...document.getElementById('rentalEquipment').options].map(o => o.value).join(',');
    const t = document.getElementById('rentalTerm'); const r = { other: [vis(), opts()] };
    t.value = 'yearly'; t.dispatchEvent(new Event('change')); r.yearly = [vis(), opts(), document.getElementById('rentalDateFromLabel').textContent];
    return r;
  });
  log('form:', JSON.stringify(f));
  log('import parse:', await page.evaluate(() => JSON.stringify(['Yearly|Side gondola', 'yearly|side', 'Other|Basket side', 'other|side', '|Screen wall', '|island', 'Annual|basket'].map(x => { const [t, y] = x.split('|'); const term = parseRentalTerm(t); return `${x} -> ${term}/${parseRentalType(y, term)}`; }))));
}
