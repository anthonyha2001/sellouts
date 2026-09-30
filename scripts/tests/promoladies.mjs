// Promo ladies: add (paid / free), calendar, day list, list tab, edit, access by role. promo_ladies is
// served from memory (as after 018). Run with --as-role floor_manager (and accountant: no access).
export default async function (page, { log }) {
  const rows = [];
  await page.route(/\/rest\/v1\/promo_ladies/, async route => {
    const r = route.request(), url = new URL(r.url());
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    if (r.method() === 'GET') return route.fulfill({ status: 200, json: rows });
    if (r.method() === 'POST') { const b = JSON.parse(r.postData()); const x = { id: 'pl-' + (rows.length + 1), created_at: new Date().toISOString(), ...b }; rows.push(x); return route.fulfill({ status: 201, json: single ? x : [x] }); }
    if (r.method() === 'PATCH') { const x = rows.find(y => y.id === id); Object.assign(x, JSON.parse(r.postData())); return route.fulfill({ status: 200, json: single ? x : [x] }); }
    if (r.method() === 'DELETE') { rows.splice(rows.findIndex(y => y.id === id), 1); return route.fulfill({ status: 200, json: [] }); }
    return route.fulfill({ status: 200, json: [] });
  });
  const nav = await page.evaluate(() => [...document.querySelectorAll('.nav-btn[data-tab]')].filter(b => !b.hidden).map(b => b.dataset.tab).join(','));
  log('menu:', nav);
  if (!nav.includes('promoladies')) return;
  await page.evaluate(() => switchTab('promoladies')); await page.waitForTimeout(1500);
  const t = await page.evaluate(() => beirutToday());
  const add = async (sup, paid, amount, item, from, to) => {
    await page.click('#plAdd'); await page.waitForTimeout(200);
    await page.fill('#plSupplier', sup);
    await page.click(`#plPaidSeg [data-paid="${paid ? 1 : 0}"]`);
    if (paid) await page.fill('#plAmount', String(amount));
    await page.fill('#plItem', item); await page.fill('#plFrom', from); await page.fill('#plTo', to);
    await page.click('#plSave'); await page.waitForTimeout(400);
  };
  const plus = n => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  await page.click('#plAdd'); await page.waitForTimeout(200);
  log('vendor list in the form:', await page.$$eval('#plVendors option', o => o.length), 'vendors');
  await page.fill('#plSupplier', 'Zzz not a vendor'); await page.waitForTimeout(100);
  log('warning for a non-vendor:', await page.isVisible('#plSupWarn'));
  await page.click('#plPaidSeg [data-paid="1"]'); await page.fill('#plFrom', t); await page.fill('#plTo', t);
  await page.click('#plSave'); await page.waitForTimeout(300);
  log('paid without amount refused:', await page.isVisible('#plOverlay'), '| rows:', rows.length);
  await page.click('#plCancel');
  await add('Nestle', true, 300, 'Nescafé 3-in-1 tasting', t, plus(2));
  await add('Abboud trading', false, 0, 'Olive oil', plus(1), plus(1));
  log('saved:', JSON.stringify(rows.map(r => ({ s: r.supplier, paid: r.paid, amount: r.amount, from: r.start_date, to: r.end_date }))));
  log('calendar today cell:', (await page.textContent(`.pl-day[data-day="${t}"]`)).replace(/\s+/g, ' ').trim(), '| tomorrow:', (await page.textContent(`.pl-day[data-day="${plus(1)}"]`)).replace(/\s+/g, ' ').trim());
  log('month summary:', (await page.textContent('.pl-cal-sum')).trim());
  await page.click(`.pl-day[data-day="${plus(1)}"] .pl-dnum`); await page.waitForTimeout(200);
  log('day card:', (await page.textContent('#plDayCard')).replace(/\s+/g, ' ').trim().slice(0, 200));
  await page.click('#plTabs [data-tab="list"]'); await page.waitForTimeout(200);
  log('list totals:', (await page.textContent('.rental-totals')).replace(/\s+/g, ' ').trim());
  log('list rows:', await page.$$eval('.pl-table tbody tr', tr => tr.map(x => [...x.children].slice(0, 7).map(td => td.textContent.trim()).join(' | ')).join(' // ')));
  // edit: make the free one paid
  await page.click('.pl-table tbody tr:last-child [data-edit]'); await page.waitForTimeout(200);
  await page.click('#plPaidSeg [data-paid="1"]'); await page.fill('#plAmount', '150'); await page.click('#plSave'); await page.waitForTimeout(400);
  log('after edit:', JSON.stringify(rows.map(r => r.supplier + ':' + (r.paid ? r.amount : 'free'))));
  await page.click('#plTabs [data-tab="calendar"]'); await page.waitForTimeout(300);
}
