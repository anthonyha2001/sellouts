// Delivery › Reports › Customers: ordering pattern, "not ordering lately", owed on account, statement.
// Adds made-up histories to the real orders the page loads (nothing is saved).
export default async function (page, { log }) {
  const t = await page.evaluate(() => beirutToday());
  const day = n => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const mk = (id, cust, name, daysAgo, amount, payment = 'Cash', paid = true) => ({ id, created: 0, order_date: day(daysAgo), customer_id: cust, c_name: name, c_phone: '03 111 222', c_area: 'Ajaltoun', c_address: '', driver_id: null, amount, platform: 'WhatsApp', payment, paid, paid_at: paid ? day(daysAgo) : null, note: '' });
  const fake = [
    // weekly customer who stopped 45 days ago -> not ordering
    ...[45, 52, 59, 66, 73].map((d, i) => mk('t-a' + i, 'test-cust-a', 'Test Weekly Stopped', d, 20 + i)),
    // every ~5 days, last 12 days ago -> late
    ...[12, 17, 22, 27].map((d, i) => mk('t-b' + i, 'test-cust-b', 'Test Slightly Late', d, 15)),
    // regular every 3 days, last yesterday, with On Account orders (one paid, two due)
    ...[1, 4, 7, 10].map((d, i) => mk('t-c' + i, 'test-cust-c', 'Test On Account', d, 50, 'On Account', i === 3)),
    // one order 60 days ago -> not ordering (one-order customer)
    mk('t-d0', 'test-cust-d', 'Test One Old Order', 60, 9),
  ];
  await page.route(/\/rest\/v1\/dt_orders\?/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch(); const rows = await res.json();
    return route.fulfill({ response: res, json: Array.isArray(rows) && !/offset=[1-9]/.test(route.request().url()) ? rows.concat(fake) : rows });
  });
  await page.reload(); await page.waitForTimeout(7000);
  await page.evaluate(() => { location.hash = '#delivery/reports'; }); await page.waitForTimeout(1500);
  await page.click('#rMode [data-mode="customers"]'); await page.waitForTimeout(800);
  log('kpis:', (await page.textContent('#crBody .kpis')).replace(/\s+/g, ' ').trim());
  const rows = () => page.$$eval('#crBody tbody tr[data-key]', trs => trs.filter(tr => /Test /.test(tr.textContent)).map(tr => [...tr.children].slice(0, 9).map(td => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
  (await rows()).forEach(r => log('  ' + r));
  await page.click('#crFilter [data-f="late"]'); await page.waitForTimeout(300);
  log('"Not ordering lately" filter:', await page.$$eval('#crBody tbody tr[data-key] td:first-child b', b => b.map(x => x.textContent).filter(x => /Test/.test(x)).join(', ')));
  await page.click('#crFilter [data-f="owed"]'); await page.waitForTimeout(300);
  log('"Owes money" filter:', await page.$$eval('#crBody tbody tr[data-key] td:first-child b', b => b.map(x => x.textContent).join(', ')));
  // statement for the On Account customer
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#crBody tr[data-key="test-cust-c"] [data-act="statement"]')]);
  await popup.waitForLoadState();
  log('statement summary:', (await popup.textContent('.sum')).replace(/\s+/g, ' ').trim());
  log('statement rows:', await popup.$$eval('.st tbody tr', trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim()).join(' | ')).join(' // ')));
  await popup.setViewportSize({ width: 900, height: 900 });
  await popup.screenshot({ path: process.env.TEMP + '/statement.png' });
  await popup.close();
  await page.click('#crFilter [data-f="all"]'); await page.waitForTimeout(300);
}
