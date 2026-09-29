// Per-user permissions in the UI. Run twice:
//   PERMS_AS=acct  (with --as-role accountant): my_permissions returns the accountant defaults
//                  + rentals.view, promotions.audit, activity.view, sellouts.price − cash.enter
//   (admin, default): Users → Permissions editor saves only the differences from the role.
export default async function (page, { log }) {
  if (process.env.PERMS_AS === 'acct') {
    const perms = ['sellouts.view', 'sellouts.price', 'sellouts.archive', 'promotions.view', 'promotions.audit', 'delivery.settle',
      'rentals.view', 'cash.view', 'cash.lock', 'cash.cashiers', 'labels.print', 'activity.view'];
    await page.route(/\/rest\/v1\/rpc\/my_permissions/, r => r.fulfill({ status: 200, json: perms }));
    await page.reload(); await page.waitForTimeout(8000);
    log('perms loaded:', await page.evaluate(() => [...Session.perms].length), '| nav:', await page.evaluate(() => [...document.querySelectorAll('.nav-btn[data-tab]')].filter(b => !b.hidden).map(b => b.dataset.tab).join(',')));
    await page.evaluate(() => switchTab('sellouts')); await page.waitForTimeout(1200);
    await page.evaluate(() => document.querySelector('#panel-sellouts .sellout-head')?.click()); await page.waitForTimeout(500);
    log('sell-outs: price controls', await page.isVisible('#panel-sellouts .so-price-controls'), '| price input enabled', await page.evaluate(() => document.querySelector('.so-new-price') && !document.querySelector('.so-new-price').disabled),
      '| add button', await page.isVisible('#openAddSelloutBtn'), '| delete', await page.evaluate(() => { const b = document.querySelector('#panel-sellouts [data-role="delete"]'); return !!b && b.offsetParent !== null; }));
    await page.evaluate(async () => { switchTab('promotions'); await new Promise(r => setTimeout(r, 2000)); promoViewMode = 'audit'; await renderPromoWorkspace(); });
    await page.waitForTimeout(600);
    log('promotions audit: type buttons enabled', await page.evaluate(() => { const b = document.querySelector('[data-role="audit-type-btn"]'); return !!b && !b.disabled; }),
      '| notes editable', await page.evaluate(() => { const i = document.querySelector('.audit-note-input'); return !!i && !i.readOnly; }),
      '| rows read-only', await page.evaluate(() => { promoViewMode = 'table'; return true; }));
    await page.evaluate(() => switchTab('cash')); await page.waitForTimeout(2500);
    log('cash: grid read-only', await page.evaluate(() => { const i = document.querySelector('#cashBody input[data-c]'); return i ? i.readOnly : 'no grid'; }),
      '| banner', (await page.evaluate(() => document.querySelector('#cashBody .cash-banner')?.textContent || '')).trim(),
      '| tabs', await page.evaluate(() => [...document.querySelectorAll('#cashTabs button')].map(b => b.textContent.trim()).join(' / ')),
      '| lock button', await page.isVisible('#cashLock'));
    return;
  }
  // Admin: the editor
  const T = []; const sent = [];
  await page.route(/\/rest\/v1\/user_permissions/, async route => {
    const r = route.request();
    if (r.method() === 'GET') return route.fulfill({ status: 200, json: T });
    sent.push(r.method() + ' ' + (r.postData() || new URL(r.url()).search));
    if (r.method() === 'DELETE') { T.length = 0; return route.fulfill({ status: 200, json: [] }); }
    if (r.method() === 'POST') { JSON.parse(r.postData()).forEach(x => T.push(x)); return route.fulfill({ status: 201, json: [] }); }
    return route.fulfill({ status: 200, json: [] });
  });
  // The live database may only have the admin: add a pretend accountant to the user list.
  await page.route(/\/functions\/v1\/admin-users/, async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'list') return route.fulfill({ status: 200, json: {} });
    const me = await page.evaluate(() => ({ ...Session.profile, email: Session.user.email, last_sign_in_at: null }));
    return route.fulfill({ status: 200, json: { users: [me, { id: '00000000-0000-0000-0000-0000000000ac', username: 'nour', display_name: 'Nour', role: 'accountant', active: true, email: 'nour@lvajaltoun.local', last_sign_in_at: null }] } });
  });
  await page.evaluate(() => switchTab('users')); await page.waitForTimeout(3000);
  const row = await page.evaluate(() => { const tr = [...document.querySelectorAll('#usersBody tr')].find(t => t.querySelector('[data-act="perms"]')); return tr ? tr.querySelector('td').textContent.trim() : null; });
  log('first user with a Permissions button:', row);
  if (!row) return;
  await page.evaluate(() => [...document.querySelectorAll('#usersBody tr')].find(t => t.querySelector('[data-act="perms"]')).querySelector('[data-act="perms"]').click());
  await page.waitForTimeout(800);
  log('editor:', (await page.textContent('#upSub')).trim(), '| groups:', await page.$$eval('.perm-group legend', l => l.length), '| ticked:', await page.$$eval('#upBody input:checked', l => l.map(i => i.dataset.perm).join(',')));
  // add Rentals › contracts (should tick Rentals › see too), remove the first ticked permission
  await page.check('#upBody input[data-perm="rentals.contracts"]');
  const firstOn = await page.$eval('#upBody input:checked:not([data-perm^="rentals"])', i => i.dataset.perm).catch(() => null);
  if (firstOn) await page.uncheck(`#upBody input[data-perm="${firstOn}"]`);
  log('after changes: custom rows', await page.$$eval('#upBody .perm-row.is-custom', l => l.map(x => x.textContent.replace(/\s+/g, ' ').trim()).join(' | ')));
  if (process.env.STOP_BEFORE_SAVE) return;       // leave the editor open for a screenshot
  await page.click('#upSave'); await page.waitForTimeout(800);
  log('saved:', JSON.stringify(T), '| requests:', sent.map(s => s.slice(0, 60)).join(' ; '));
  log('users badge:', await page.evaluate(() => [...document.querySelectorAll('#usersBody .badge')].map(b => b.textContent.trim()).filter(t => /custom/.test(t)).join(',')));
}
