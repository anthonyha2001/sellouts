// Promo lady attendance: came / didn't come, hours, note; calendar marks; list "x of y days".
export default async function (page, { log }) {
  const t = await page.evaluate(() => beirutToday());
  const day = n => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const rows = [{ id: 'p1', supplier: 'Nestle', paid: true, amount: 300, item: 'Nescafé tasting', start_date: day(-2), end_date: day(1), note: null }];
  const A = [];
  await page.route(/\/rest\/v1\/promo_ladies/, r => r.fulfill({ status: 200, json: rows }));
  await page.route(/\/rest\/v1\/promo_lady_attendance/, async route => {
    const r = route.request(), url = new URL(r.url()), single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    if (r.method() === 'GET') return route.fulfill({ status: 200, json: A });
    if (r.method() === 'POST') { const b = JSON.parse(r.postData()); const i = A.findIndex(x => x.promo_lady_id === b.promo_lady_id && x.day === b.day); if (i > -1) A[i] = b; else A.push(b); return route.fulfill({ status: 201, json: single ? b : [b] }); }
    if (r.method() === 'DELETE') { const d = url.searchParams.get('day').slice(3); A.splice(A.findIndex(x => x.day === d), 1); return route.fulfill({ status: 200, json: [] }); }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.evaluate(() => switchTab('promoladies')); await page.waitForTimeout(1500);
  const mark = async (d, came) => { await page.click(`.pl-day[data-day="${d}"] .pl-dnum`); await page.waitForTimeout(200); await page.click(`.pl-att[data-day="${d}"] [data-came="${came ? 1 : 0}"]`); await page.waitForTimeout(400); };
  await mark(day(-2), true); await mark(day(-1), false); await mark(t, true);
  await page.fill(`.pl-att[data-day="${t}"] [data-f="time_from"]`, '10:00'); await page.dispatchEvent(`.pl-att[data-day="${t}"] [data-f="time_from"]`, 'change'); await page.waitForTimeout(300);
  await page.fill(`.pl-att[data-day="${t}"] [data-f="note"]`, 'Stand near aisle 4'); await page.dispatchEvent(`.pl-att[data-day="${t}"] [data-f="note"]`, 'change'); await page.waitForTimeout(300);
  log('saved:', JSON.stringify(A.map(a => ({ day: a.day, came: a.came, from: a.time_from, note: a.note }))));
  log('calendar chips:', await page.$$eval('.pl-chip', c => c.map(x => x.textContent).join(', ')));
  log('tomorrow has no attendance buttons:', await page.evaluate(d => { const c = document.querySelector(`.pl-day[data-day="${d}"] .pl-dnum`); c.click(); return !document.querySelector('.pl-att'); }, day(1)));
  await page.click('#plTabs [data-tab="list"]'); await page.waitForTimeout(300);
  log('list attendance:', await page.$$eval('.pl-table tbody tr td:nth-child(7)', t => t.map(x => x.textContent.trim()).join(' | ')));
  await page.click('#plTabs [data-tab="calendar"]'); await page.waitForTimeout(200);
  await page.click(`.pl-day[data-day="${t}"] .pl-dnum`); await page.waitForTimeout(200);
}
