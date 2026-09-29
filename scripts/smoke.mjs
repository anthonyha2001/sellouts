// Headless smoke test of the app against the LIVE database, with all writes blocked.
//   node --env-file=.env scripts/smoke.mjs [page] [--login user:pass] [--steps file.mjs] [--shot out.png] [--dark] [--mobile]
// Every non-GET request to Supabase REST/Storage is aborted (logged as "blocked write"), so tests
// cannot change data. Auth (sign-in) requests are allowed. Prints console errors, page errors and
// failed requests; exits 1 if there were any errors.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const flag = k => args.includes('--' + k);
const page0 = args[0] && !args[0].startsWith('--') ? args[0] : 'index.html';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root) || /[\\/](\.env|backups|node_modules)/.test(file)) throw 0;
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const exe = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const ctx = await browser.newContext({
  viewport: flag('mobile') ? { width: 390, height: 844 } : { width: 1400, height: 900 },
  colorScheme: flag('dark') ? 'dark' : 'light',
  timezoneId: 'Asia/Beirut',
});
const page = await ctx.newPage();
const problems = [];
page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ERR_ABORTED')) problems.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`); });
const blocked = [];
// The browser has no direct network in this sandbox, so every external request is fetched by
// Playwright's Node side (route.fetch) and handed back. Writes to Supabase data are refused instead.
await page.route(url => !url.href.startsWith(base), async route => {
  const r = route.request();
  const isData = /supabase\.co\/(rest|storage|functions)\//.test(r.url());
  if (isData && !['GET', 'HEAD', 'OPTIONS'].includes(r.method())) {
    blocked.push(`${r.method()} ${r.url().replace(/^.*supabase\.co/, '')}`);
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'smoke test: writes are blocked' }) });
  }
  try { await route.fulfill({ response: await route.fetch() }); }
  catch (e) { problems.push(`fetch failed: ${r.url()} ${e.message.split('\n')[0]}`); await route.abort(); }
});

await page.goto(base + page0);
const login = opt('login');
if (login) {
  const [u, ...pw] = login.split(':');
  await page.fill('#loginUser', u);
  await page.fill('#loginPass', pw.join(':'));
  await page.click('#loginSubmit');
}
await page.waitForTimeout(Number(opt('wait') || 4000));
const steps = opt('steps');
if (steps) {
  const mod = await import('file:///' + resolve(root, steps).replace(/\\/g, '/'));
  await mod.default(page, { base, log: (...a) => console.log('  ·', ...a) });
}
const shot = opt('shot');
if (shot) await page.screenshot({ path: shot, fullPage: flag('full') });

const summary = await page.evaluate(() => ({
  title: document.title,
  heading: document.getElementById('pageTitle')?.textContent,
  visibleNav: [...document.querySelectorAll('.sidenav .nav-btn')].filter(b => b.offsetParent).map(b => b.dataset.tab),
}));
console.log('PAGE   ', JSON.stringify(summary));
console.log('BLOCKED', blocked.length ? blocked.join('\n        ') : 'none');
console.log('ERRORS ', problems.length ? problems.join('\n        ') : 'none');
await browser.close();
server.close();
process.exitCode = problems.length ? 1 : 0;
