// Full data backup of every app table to backups/<timestamp>/<table>.json (+ .csv).
// Usage:  node scripts/backup.mjs
// See scripts/backup.md for which key to use before/after Phase 1 (RLS).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL = process.env.SUPABASE_URL || 'https://sezjqcbkiydckhirycjb.supabase.co';
// Default: the publishable key already shipped in the page. After Phase 1 this reads nothing;
// set SUPABASE_KEY to the secret key (never commit it) or SUPABASE_JWT to a signed-in admin's access token.
const KEY = process.env.SUPABASE_KEY || 'sb_publishable_LRI-MmDPYE_IjrHG-LZ7Xg_mQovg24F';
const JWT = process.env.SUPABASE_JWT || '';

const TABLES = [
  'sellouts', 'credit_notes', 'catalog_items', 'app_settings', 'promotions', 'promotion_rows',
  'vendors', 'vendor_orders', 'vendor_skips', 'vendor_rentals',
  'dt_drivers', 'dt_customers', 'dt_orders', 'dt_settings',
  ...(process.env.EXTRA_TABLES ? process.env.EXTRA_TABLES.split(',') : []),
];
const PAGE = 1000;

const headers = { apikey: KEY, Accept: 'application/json', Prefer: 'count=exact' };
if (JWT) headers.Authorization = `Bearer ${JWT}`;

async function fetchTable(table) {
  const rows = [];
  let total = null;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${URL}/rest/v1/${table}?select=*`, {
      headers: { ...headers, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' },
    });
    if (!res.ok && res.status !== 206) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    const cr = res.headers.get('content-range'); // e.g. 0-999/1847
    if (cr && cr.includes('/')) total = Number(cr.split('/')[1]);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, total };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const cell = v => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

// Folder name in Beirut local time (sv-SE gives 'YYYY-MM-DD HH:MM').
const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Beirut', hour12: false }).slice(0, 16).replace(/[ :]/g, '-');
const dir = join('backups', stamp);
await mkdir(dir, { recursive: true });

const summary = {};
let failed = false;
for (const t of TABLES) {
  try {
    const { rows, total } = await fetchTable(t);
    await writeFile(join(dir, `${t}.json`), JSON.stringify(rows, null, 1));
    await writeFile(join(dir, `${t}.csv`), toCsv(rows));
    const ok = total === null || total === rows.length;
    if (!ok) failed = true;
    summary[t] = { rows: rows.length, serverCount: total, complete: ok };
    console.log(`${ok ? 'OK  ' : 'MISMATCH'} ${t.padEnd(16)} ${rows.length}${total !== null ? ' / ' + total : ''}`);
  } catch (e) {
    failed = true;
    summary[t] = { error: e.message };
    console.error(`FAIL ${t}: ${e.message}`);
  }
}
await writeFile(join(dir, '_summary.json'), JSON.stringify({ at: new Date().toISOString(), url: URL, tables: summary }, null, 1));
console.log(`\nSaved to ${dir}`);
if (failed) { console.error('Backup INCOMPLETE - see errors above.'); process.exit(1); }
