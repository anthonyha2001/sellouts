// relay — the app's road to the La Valeur Dashboard through this computer in Lebanon (owner, 2026-11-24).
// The dashboard's Cloudflare blocks the Supabase servers ("Attention Required! | Cloudflare") but lets this computer
// through. This program:
//   1. listens on 127.0.0.1:8787 and forwards ONLY /api/lavaleur/* to https://dashboard.lavaleursupermarche.com, and only for
//      a request carrying the secret key (header X-Relay-Key); nothing else is reachable;
//   2. opens a free Cloudflare quick tunnel to it (cloudflared; its https address changes at every start);
//   3. writes that address and a fresh key into public.app_relay (one row) with SUPABASE_DB_URL from .env, and checks itself
//      every 2 minutes (seen_at). The lv-dashboard function reads the row and goes through here while it is fresh
//      (15 minutes); otherwise it goes direct.
// Run:   node --env-file=.env scripts/relay.mjs        (started at Windows log-on by the "La Valeur relay" task)
// Log:   scripts/relay.log
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PORT = 8787, TARGET = 'https://dashboard.lavaleursupermarche.com', PREFIX = '/api/lavaleur/';
const CLOUDFLARED = process.env.CLOUDFLARED || 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const LOG = fileURLToPath(new URL('./relay.log', import.meta.url));
const KEY = randomBytes(24).toString('hex');
const PASS = ['content-type', 'accept', 'authorization', 'user-agent', 'origin', 'referer', 'accept-language'];

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.join(' ') + '\n';
  try { if (existsSync(LOG) && statSync(LOG).size > 5e6) writeFileSync(LOG, ''); appendFileSync(LOG, line); } catch { /* no log */ }
  process.stdout.write(line);
}
if (!process.env.SUPABASE_DB_URL) { log('SUPABASE_DB_URL missing: run with --env-file=.env'); process.exit(2); }
const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 2 });

const keyOk = k => { const a = Buffer.from(String(k || '')), b = Buffer.from(KEY); return a.length === b.length && timingSafeEqual(a, b); };

/* ---------------- the forwarder ---------------- */
let served = 0, failed = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/relay-health') { res.writeHead(keyOk(req.headers['x-relay-key']) ? 200 : 403).end('ok'); return; }
  if (!keyOk(req.headers['x-relay-key'])) { res.writeHead(403).end('forbidden'); return; }
  if (!req.url.startsWith(PREFIX) || !['GET', 'POST'].includes(req.method)) { res.writeHead(404).end('not here'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = {}; PASS.forEach(h => { if (req.headers[h]) headers[h] = req.headers[h]; });
  try {
    const r = await fetch(TARGET + req.url, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(60000) });
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' }).end(body);
    served++;
    if (r.status >= 400 && r.status !== 401 && r.status !== 404 && r.status !== 422) log('dashboard answered', r.status, req.method, req.url.slice(0, 80));
  } catch (e) { failed++; log('forward failed', req.method, req.url.slice(0, 80), e.message); res.writeHead(502).end('relay: ' + e.message); }
});
server.listen(PORT, '127.0.0.1', () => log('relay listening on 127.0.0.1:' + PORT));

/* ---------------- the row the function reads ---------------- */
async function ensureTable() {
  await db.query(`create table if not exists public.app_relay (id int primary key check (id = 1), url text, key text, seen_at timestamptz);
    alter table public.app_relay enable row level security;
    revoke all on public.app_relay from anon, authenticated;`);
}
async function publish(url) {
  await db.query(`insert into public.app_relay (id, url, key, seen_at) values (1, $1, $2, now())
    on conflict (id) do update set url = excluded.url, key = excluded.key, seen_at = now()`, [url, KEY]);
  log('published', url);
}

/* ---------------- the tunnel ---------------- */
let tunnel = null, url = '', bad = 0;
function startTunnel() {
  url = ''; bad = 0;
  tunnel = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { windowsHide: true });
  const scan = d => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(String(d));
    // a new quick-tunnel name needs a little while to exist: asking too early makes Windows remember "no such name"
    if (m && !url) { url = m[0]; log('tunnel', url); setTimeout(() => check(true), 25000); }
  };
  tunnel.stdout.on('data', scan); tunnel.stderr.on('data', scan);
  tunnel.on('exit', code => { log('tunnel stopped (' + code + '): starting again in 10 s'); tunnel = null; setTimeout(startTunnel, 10000); });
}
// through the tunnel and back: publish the address once it answers; a tunnel dead 3 times in a row is restarted
async function check(first = false) {
  if (!url) return;
  try {
    const r = await fetch(url + '/relay-health', { headers: { 'x-relay-key': KEY }, signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) throw new Error('status ' + r.status);
    bad = 0;
    if (first) await publish(url); else await db.query('update public.app_relay set seen_at = now() where id = 1 and url = $1', [url]);
  } catch (e) {
    bad++; log('tunnel check failed (' + bad + '):', e.message, e.cause?.code || e.cause?.message || '');
    if (first && bad < 12) return setTimeout(() => check(true), 15000);   // a new quick tunnel can take a little while to answer
    if (bad >= 3 && tunnel) { log('restarting the tunnel'); tunnel.kill(); }
  }
}
setInterval(() => { check(false); if (served || failed) { log(`forwarded ${served}, failed ${failed} in the last 2 min`); served = failed = 0; } }, 120000);

await ensureTable();
startTunnel();
