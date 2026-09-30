// "Keep me signed in on this device": the app reopens signed in even when the phone wipes
// localStorage (backup in a cookie + IndexedDB), waits for the connection at launch, forgets
// everything on sign-out, and "not remembered" ends with the browser session.
// Run WITHOUT --login:  node scripts/smoke.mjs index.html --steps scripts/tests/remember-device.mjs
const USER = process.env.LV_USER || 'anthony.hasrouny@lavaleur.net', PASS = process.env.LV_PASS || '123Soleil@1';
export default async function (page, { log }) {
  const ctx = page.context();
  const state = () => page.evaluate(() => ({ signedIn: !document.body.classList.contains('locked') && typeof Session !== 'undefined' && !!Session.user, who: typeof Session !== 'undefined' ? Session.profile?.username || null : null }));
  const open = async (p = page) => { await p.reload(); await p.waitForTimeout(6000); };
  const signIn = async remember => {
    await page.waitForSelector('#loginUser', { state: 'visible' });
    await page.fill('#loginUser', USER); await page.fill('#loginPass', PASS);
    await page.setChecked('#loginRemember', remember);
    await page.click('#loginSubmit'); await page.waitForTimeout(5000);
  };
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await ctx.clearCookies(); await open();

  await signIn(true);
  log('1. signed in (remember on):', JSON.stringify(await state()), '| backup cookie:', (await ctx.cookies()).some(c => c.name === 'lv_rt'));
  await open();
  log('2. reopened:', JSON.stringify(await state()));

  await page.evaluate(() => { localStorage.removeItem('lv-auth'); });
  await open();
  log('3. phone wiped localStorage → reopened:', JSON.stringify(await state()), '| session back in localStorage:', await page.evaluate(() => !!localStorage.getItem('lv-auth')));

  await page.evaluate(() => { localStorage.removeItem('lv-auth'); }); await ctx.clearCookies();
  await open();
  log('4. localStorage AND cookie wiped (IndexedDB only) → reopened:', JSON.stringify(await state()));

  // no connection for the first 4 seconds of the launch
  let blockUntil = Date.now() + 1e9;
  await page.route(/supabase\.co\//, r => Date.now() < blockUntil ? r.abort('internetdisconnected') : r.fallback());
  const reopening = page.reload();
  blockUntil = Date.now() + 4000;
  await reopening; await page.waitForTimeout(1500);
  log('5. offline at launch, after 1.5 s:', await page.evaluate(() => document.querySelector('.login-loading')?.textContent), '| form shown:', await page.isVisible('#loginUser'));
  await page.waitForTimeout(9000);
  log('   …once online:', JSON.stringify(await state()));
  await page.unroute(/supabase\.co\//);

  // sign out: everything forgotten
  await page.evaluate(() => document.getElementById('signOutBtn').click()); await page.waitForTimeout(5000);
  log('6. signed out → backup cookie:', (await ctx.cookies()).some(c => c.name === 'lv_rt'), '| state:', JSON.stringify(await state()));

  // remember off: a new window of the browser starts signed out
  await signIn(false);
  log('7. signed in (remember OFF):', JSON.stringify(await state()), '| in localStorage:', await page.evaluate(() => !!localStorage.getItem('lv-auth')), '| backup cookie:', (await ctx.cookies()).some(c => c.name === 'lv_rt'));
  const p2 = await ctx.newPage(); await p2.goto(page.url().replace(/#.*$/, '')); await p2.waitForTimeout(6000);
  log('   new window (like reopening the browser):', await p2.evaluate(() => document.body.classList.contains('locked') ? 'sign-in form' : 'signed in'));
  await p2.close();
  await page.evaluate(() => { localStorage.setItem('lv-remember', '1'); });
}
