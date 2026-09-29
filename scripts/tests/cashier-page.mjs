// Public cashier page with a stand-in for the cashier-view function (PIN 1234 = right).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default async function (page, { log }) {
  const dir = process.env.SHOT_DIR || tmpdir();
  let tries = 5;
  await page.route(/\/functions\/v1\/cashier-view/, async route => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (b.action === 'cashiers') return route.fulfill({ json: { cashiers: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Rita', has_pin: true }, { id: '22222222-2222-2222-2222-222222222222', name: 'Joe', has_pin: false }] } });
    if (b.pin !== '1234') return route.fulfill({ status: 401, json: { error: 'Wrong PIN.', attempts_left: --tries } });
    const month = b.month || '2026-09';
    const entries = month === '2026-09'
      ? [{ day: '2026-09-01', amount: -0.57, note: null }, { day: '2026-09-02', amount: 12.5, note: null }, { day: '2026-09-05', amount: -23.4, note: 'Counted twice, confirmed by manager' }, { day: '2026-09-06', amount: 3.99, note: null }]
      : [{ day: '2026-08-14', amount: -2, note: null }];
    return route.fulfill({ json: { cashier: { name: 'Rita' }, month, months: ['2026-09', '2026-08'], entries, total: entries.reduce((s, e) => s + e.amount, 0), levels: { warning: 10, danger: 20, currency: 'USD' } } });
  });
  await page.reload(); await page.waitForTimeout(1500);
  await page.selectOption('#cpName', { label: 'Rita' });
  await page.fill('#cpPin', '9999'); await page.click('#cpGo'); await page.waitForTimeout(400);
  log('wrong PIN says:', await page.textContent('#cpErr'));
  await page.fill('#cpPin', '1234'); await page.click('#cpGo'); await page.waitForTimeout(500);
  log('shows:', await page.textContent('#cpWho'), '|', (await page.textContent('#cpTotal')).replace(/\s+/g, ' ').trim(), '| rows:', await page.$$eval('#cpList tr', r => r.length));
  await page.screenshot({ path: join(dir, 'cashier_page.png'), fullPage: true });
  await page.click('#cpMonths button:not(.active)'); await page.waitForTimeout(400);
  log('last month:', (await page.textContent('#cpTotal')).replace(/\s+/g, ' ').trim());
  await page.click('#cpDone');
  log('after Done: view hidden =', await page.isHidden('#cpView'), '| PIN box empty =', (await page.inputValue('#cpPin')) === '');
}
