// Run a .sql file (or -e "sql") against the live database using SUPABASE_DB_URL from .env.
//   node --env-file=.env scripts/db.mjs docs/inspect-schema.sql        read-only transaction (default)
//   node --env-file=.env scripts/db.mjs -e "select now()"               read-only
//   node --env-file=.env scripts/db.mjs a.sql b.sql --dry-run   runs the files for real in one transaction, then ROLLS BACK
//   node --env-file=.env scripts/db.mjs supabase/migrations/001_x.sql --apply   writes; ONLY after owner approval
// With --apply the whole file runs in one transaction: any error rolls everything back.
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dry = args.includes('--dry-run');
const rest = args.filter(a => !a.startsWith('--'));
const sql = rest[0] === '-e' ? rest[1] : (await Promise.all(rest.map(f => readFile(f, 'utf8')))).join('\n;\n');
if (!sql) { console.error('Usage: db.mjs <file.sql> | -e "<sql>" [--apply]'); process.exit(2); }
if (!process.env.SUPABASE_DB_URL) { console.error('SUPABASE_DB_URL missing: run with --env-file=.env'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
client.on('notice', n => console.log('NOTICE:', n.message));
await client.connect();
try {
  await client.query(apply || dry ? 'begin' : 'begin read only');
  const res = await client.query(sql);
  await client.query(apply ? 'commit' : 'rollback');
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  if (last?.rows?.length) {
    // Single JSON cell → print it raw; otherwise print rows as JSON lines.
    const r = last.rows;
    if (r.length === 1 && Object.keys(r[0]).length === 1) {
      const v = Object.values(r[0])[0];
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    } else for (const row of r) console.log(JSON.stringify(row));
  } else console.log(`${last?.command ?? 'OK'} ${last?.rowCount ?? ''}`.trim());
  console.log(apply ? '-- COMMITTED' : dry ? '-- DRY RUN: all changes rolled back' : '-- read-only, rolled back');
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error('ERROR:', e.message, e.detail ?? '', e.hint ?? '');
  process.exitCode = 1;
} finally {
  await client.end();
}
