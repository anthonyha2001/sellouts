// One-off repair for promotions whose rows share positions (the pre-fix ordering bug:
// inserts/pastes saved only the new rows, so rows below kept stale numbers and batches
// came back interleaved).
//
// It replays history: rows saved in one go share a created_at, so each later batch is known.
// For every batch, in time order, all OLDER rows at or after where the batch went in are
// moved down by the batch's size, which is what the app showed at the time but never saved.
// Rows are then renumbered 0..n-1 in that order (remaining ties: older save first).
//
//   node --env-file=.env scripts/fix-row-order.mjs            show the plan, change nothing
//   node --env-file=.env scripts/fix-row-order.mjs --apply    write the new positions (one transaction)
import pg from 'pg';

const apply = process.argv.includes('--apply');
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(`
  select r.id, r.promotion_id, r.sort_order as pos, r.created_at, p.name, coalesce(r.description, '') as item
  from promotion_rows r join promotions p on p.id = r.promotion_id
  order by p.name, r.sort_order, r.created_at`);

const byPromo = new Map();
for (const r of rows) {
  if (!byPromo.has(r.promotion_id)) byPromo.set(r.promotion_id, []);
  byPromo.get(r.promotion_id).push({ ...r, t: +r.created_at });
}

const updates = [];
for (const list of byPromo.values()) {
  const name = list[0].name;
  const clashes = list.length - new Set(list.map(r => r.pos)).size;
  if (!clashes) { console.log(`${name}: ${list.length} rows, no clashes, left as is`); continue; }

  const pos = new Map(list.map(r => [r.id, r.pos]));
  const times = [...new Set(list.map(r => r.t))].sort((a, b) => a - b);
  for (const t of times.slice(1)) {
    const batch = list.filter(r => r.t === t);
    const start = Math.min(...batch.map(r => pos.get(r.id)));
    for (const r of list) if (r.t < t && pos.get(r.id) >= start) pos.set(r.id, pos.get(r.id) + batch.length);
  }
  const ordered = list.slice().sort((a, b) => pos.get(a.id) - pos.get(b.id) || a.t - b.t);
  ordered.forEach((r, i) => { if (r.pos !== i) updates.push({ id: r.id, pos: i }); });

  // Show where batches now start, so the result can be eyeballed.
  console.log(`\n${name}: ${list.length} rows, ${clashes} clashes -> new order:`);
  let prevT = null;
  ordered.forEach((r, i) => {
    if (r.t !== prevT) {
      const size = ordered.slice(i).findIndex(x => x.t !== r.t);
      console.log(`  #${String(i + 1).padStart(3)}  ${String(size < 0 ? ordered.length - i : size).padStart(3)} rows from one save, starting with ${r.item.slice(0, 40)}`);
    }
    prevT = r.t;
  });
}

console.log(`\n${updates.length} row positions to change.`);
if (apply && updates.length) {
  await db.query('begin');
  try {
    for (const u of updates) await db.query('update promotion_rows set sort_order = $1 where id = $2', [u.pos, u.id]);
    await db.query('commit');
    console.log('APPLIED.');
  } catch (e) {
    await db.query('rollback');
    console.error('Rolled back:', e.message);
    process.exitCode = 1;
  }
} else if (!apply) {
  console.log('Nothing written. Re-run with --apply to save this order.');
}
await db.end();
