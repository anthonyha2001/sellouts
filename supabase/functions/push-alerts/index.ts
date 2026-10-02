// push-alerts — notifications while the app is closed (Web Push), PLAN §10e.
//
// POST { action: 'run' }   from pg_cron every 10 minutes (header x-cron-secret = PUSH_CRON_SECRET):
//   works out the same alerts the app shows on its bell and pushes each one ONCE to every device of
//   every person whose permissions cover it (push_log). Quiet hours 22:00–07:00 Beirut: nothing is
//   sent; the alerts go out in the morning.
//   Also the cashiers' phones (cashier_push_subscriptions, migration 023; registered on the cashier page
//   through cashier-view after the PIN): their weekly program once it is published (and when it changes),
//   and each cash difference entered for them (5 minutes after the last edit, so a quick fix sends once).
// POST { action: 'test' }  from a signed-in user (Authorization: Bearer <their token>): a test push to
//   their own devices.
//
// Secrets (supabase secrets set …): VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK, PUSH_CRON_SECRET, VAPID_SUBJECT
// (optional, defaults to the app's address). Deploy with --no-verify-jwt; the function checks callers itself.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sendPush } from './webpush.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
// Keys: the function's secrets if set, otherwise Vault through push_keys() (migration 017).
let CRON_SECRET = Deno.env.get('PUSH_CRON_SECRET') ?? '';
const VAPID = {
  publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
  privateJwk: JSON.parse(Deno.env.get('VAPID_PRIVATE_JWK') ?? '{}'),
  subject: Deno.env.get('VAPID_SUBJECT') ?? 'https://anthonyha2001.github.io/sellouts/',
};
let keysLoaded = !!(VAPID.publicKey && VAPID.privateJwk.d && CRON_SECRET);
async function loadKeys() {
  if (keysLoaded) return;
  const { data, error } = await db.rpc('push_keys');
  if (error) throw new Error('Push keys not available: ' + error.message);
  const k = (data ?? {}) as Record<string, string>;
  CRON_SECRET = CRON_SECRET || k.push_cron_secret || '';
  VAPID.publicKey = VAPID.publicKey || k.vapid_public_key || '';
  if (!VAPID.privateJwk.d && k.vapid_private_jwk) VAPID.privateJwk = JSON.parse(k.vapid_private_jwk);
  if (k.vapid_subject && !Deno.env.get('VAPID_SUBJECT')) VAPID.subject = k.vapid_subject;
  keysLoaded = !!(VAPID.publicKey && VAPID.privateJwk.d && CRON_SECRET);
}
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---- Beirut dates
const beirut = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
const beirutHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false }));
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const fmt = (s: string) => s ? s.split('-').reverse().join('/') : '';

type Alert = { key: string; perms: string[]; title: string; body: string; url: string; except?: string };

// ---- the alerts (same rules as the app's bell)
async function buildAlerts(today: string): Promise<Alert[]> {
  const out: Alert[] = [];
  const add = (a: Alert) => out.push(a);

  // Sell-outs (one query for every sell-out alert below).
  const { data: sosFull } = await db.from('sellouts').select('id, name, from, to, active, archived, online, log, items').eq('archived', false);
  // Online-only sell-out (migration 032): the delivery team prepares the online shop (Online promotion
  // page). Once per sell-out and dates; again if its dates change (owner, 2026-10-02).
  for (const so of sosFull ?? []) {
    if (!so.online || so.to < today) continue;
    const n = Array.isArray(so.items) ? so.items.length : 0;
    add({ key: `so:${so.id}:online:${so.from}:${so.to}`, perms: ['sellouts.online'], title: 'Online promotion', url: '#onlinepromo',
      body: `"${so.name}" is on the online shop${n ? ` (${n} items)` : ''} from ${fmt(so.from)} — due date ${fmt(so.to)}.` });
  }
  // Not activated when it starts / still active when it ends: whoever follows sell-outs (accountant, admin).
  for (const so of sosFull ?? []) {
    const toStart = daysBetween(today, so.from), toEnd = daysBetween(today, so.to);
    const a = (k: string, body: string, daily = false) => add({ key: `so:${so.id}:${k}${daily ? ':' + today : ''}`, perms: ['sellouts.view'], title: 'Sell-out', body, url: '#sellouts' });
    if (!so.active) {
      if (toStart === 1) a('startSoon', `"${so.name}" starts tomorrow (${fmt(so.from)}) and is not activated yet.`);
      if (toStart === 0) a('startDay', `"${so.name}" starts today and is still not activated.`);
      if (toStart < 0 && toEnd >= 0) a('startOverdue', `"${so.name}" was due to start on ${fmt(so.from)} and has still not been activated.`, true);
    } else {
      // The To date is included: its last day is To, it is switched off the next morning.
      if (toEnd === 0) a('lastDay', `"${so.name}": today (${fmt(so.to)}) is its last day — deactivate it tomorrow (${fmt(addDays(so.to, 1))}).`);
      if (toEnd === -1) a('endDay', `"${so.name}" ended yesterday (${fmt(so.to)}) — deactivate it today.`);
      if (toEnd < -1) a('endOverdue', `"${so.name}" ended on ${fmt(so.to)} and is still active — deactivate it.`, true);
    }
  }

  // Sell-out switched on (last 24 h): the floor managers check the new prices on the shelves.
  // Ended, switched off and not archived yet: the accountant confirms it left the tills (archive).
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const so of sosFull ?? []) {
    const recent = (action: string) => (Array.isArray(so.log) ? so.log : []).filter((l: { action?: string; at?: string }) => l.action === action && l.at && Date.parse(l.at) > dayAgo).pop();
    const n = Array.isArray(so.items) ? so.items.length : 0;
    const act = recent('activated'), deact = recent('deactivated');
    if (so.active && act)
      add({ key: `so:${so.id}:activated:${act.at}`, perms: ['floorcheck.do'], title: 'Sell-out now active — floor check',
        body: `"${so.name}" is now active${n ? ` (${n} items)` : ''} — check the new prices on the shelves.`, url: '#floorcheck' });
    // Switched off: the floor managers check the prices went back to normal (owner, 2026-09-30).
    if (!so.active && deact)
      add({ key: `so:${so.id}:deactivated:${deact.at}`, perms: ['floorcheck.do'], title: 'Sell-out ended — floor check',
        body: `"${so.name}" was switched off${n ? ` (${n} items)` : ''} — check the prices on the shelves are back to normal.`, url: '#floorcheck' });
    if (!so.active && so.to < today)
      add({ key: `so:${so.id}:needsArchive`, perms: ['sellouts.archive'], title: 'Sell-out to archive', url: '#sellouts',
        body: `"${so.name}" ended on ${fmt(so.to)} and is switched off — confirm it was removed from the tills and archive it.` });
  }

  // Promotion starting tomorrow: ready to export for the tills (or still empty).
  const tomorrow = addDays(today, 1);
  const { data: promos } = await db.from('promotions').select('id, name, from_date').eq('from_date', tomorrow).eq('archived', false);
  for (const p of promos ?? []) {
    const { count } = await db.from('promotion_rows').select('id', { count: 'exact', head: true }).eq('promotion_id', p.id).not('code', 'is', null).neq('code', '');
    if (count) add({ key: `promo:${p.id}:tomorrow`, perms: ['promotions.view'], title: 'Promotion starts tomorrow', url: '#promotions',
      body: `"${p.name}" starts tomorrow (${fmt(p.from_date)}) — ${count} item${count === 1 ? '' : 's'} ready. Export it for the tills.` });
    else add({ key: `promo:${p.id}:tomorrow-empty`, perms: ['promotions.edit'], title: 'Promotion starts tomorrow', url: '#promotions',
      body: `"${p.name}" starts tomorrow (${fmt(p.from_date)}) but has no items yet.` });
  }

  // Promo ladies (018): the day before she starts, and the morning she starts — to whoever manages them.
  const { data: pls, error: plErr } = await db.from('promo_ladies').select('id, supplier, item, paid, amount, start_date, end_date').in('start_date', [today, tomorrow]);
  if (!plErr) for (const p of pls ?? []) {
    const days = daysBetween(p.start_date, p.end_date) + 1;
    const what = `${p.supplier}${p.item ? ` (${p.item})` : ''}, ${days === 1 ? 'one day' : `${days} days until ${fmt(p.end_date)}`}${p.paid ? ` — paid $${Number(p.amount || 0).toLocaleString('en-US')}` : ' — free'}`;
    if (p.start_date === tomorrow) add({ key: `pl:${p.id}:tomorrow`, perms: ['promoladies.manage'], title: 'Promo lady tomorrow', url: '#promoladies', body: `Tomorrow: promo lady for ${what}.` });
    else add({ key: `pl:${p.id}:today`, perms: ['promoladies.manage'], title: 'Promo lady today', url: '#promoladies', body: `Today: promo lady for ${what} — prepare her spot.` });
  }

  // Promo lady attendance (019): a paid one who didn't come (to the others who manage promo ladies —
  // the admin), and at 15:00 a reminder to mark today's attendance.
  const { data: att, error: attErr } = await db.from('promo_lady_attendance').select('promo_lady_id, day, came, checked_by, checked_at').gt('checked_at', new Date(dayAgo).toISOString());
  if (!attErr) {
    const absent = (att ?? []).filter(a => !a.came);
    if (absent.length) {
      const { data: bk } = await db.from('promo_ladies').select('id, supplier, item, paid, amount').in('id', absent.map(a => a.promo_lady_id));
      for (const a of absent) {
        const p = (bk ?? []).find(x => x.id === a.promo_lady_id); if (!p || !p.paid) continue;
        add({ key: `pl:${p.id}:absent:${a.day}`, perms: ['promoladies.manage'], except: a.checked_by ?? undefined, title: "Promo lady didn't come", url: '#promoladies',
          body: `${p.supplier}'s paid promo lady${p.item ? ` (${p.item})` : ''} didn't come on ${fmt(a.day)} — paid $${Number(p.amount || 0).toLocaleString('en-US')}.` });
      }
    }
    if (beirutHour() >= 15) {
      const { data: todayPl } = await db.from('promo_ladies').select('id, supplier').lte('start_date', today).gte('end_date', today);
      const { data: marked } = todayPl?.length ? await db.from('promo_lady_attendance').select('promo_lady_id').eq('day', today).in('promo_lady_id', todayPl.map(p => p.id)) : { data: [] };
      const done = new Set((marked ?? []).map(m => m.promo_lady_id));
      const left = (todayPl ?? []).filter(p => !done.has(p.id));
      if (left.length) add({ key: `pl:attendance:${today}`, perms: ['promoladies.manage'], title: 'Promo lady attendance', url: '#promoladies',
        body: `Mark today's attendance: ${left.map(p => p.supplier).join(', ')} — did she come?` });
    }
  }

  // Rented spot check finished (019): the result to whoever manages the contracts (not the one who did it).
  const { data: sc, error: scErr } = await db.from('spot_checks').select('id, started_by, started_by_name, completed_at, summary').gt('completed_at', new Date(dayAgo).toISOString());
  if (!scErr) for (const c of sc ?? []) {
    const s = c.summary || {};
    const problems = (s.other || 0) + (s.empty || 0) + (s.extra || 0);
    add({ key: `spotcheck:${c.id}`, perms: ['rentals.contracts'], except: c.started_by, title: 'Rented spot check finished', url: '#floorcheck',
      body: `By ${c.started_by_name || 'the floor manager'}: ${s.ok || 0} right${problems ? ` · ${s.other || 0} other supplier · ${s.empty || 0} empty · ${s.extra || 0} used without a contract` : ' — no problems'}${s.pending ? ` · ${s.pending} not checked` : ''}.` });
  }

  // Delivery: yesterday's day is closed — its count and value (morning summary).
  const yd = addDays(today, -1);
  const [{ data: dOrders }, { data: dSet }] = await Promise.all([
    db.from('dt_orders').select('amount, paid, payment').eq('order_date', yd),
    db.from('dt_settings').select('value').eq('key', 'app').maybeSingle(),
  ]);
  if (dOrders?.length) {
    const cur = (dSet?.value as { currency?: string } | null)?.currency || '$';
    const money = (n: number) => cur + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = dOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    const unpaid = dOrders.filter(o => !o.paid), unpaidSum = unpaid.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    add({ key: `delivery:day:${yd}`, perms: ['delivery.manage', 'delivery.reports'], title: `Delivery ${fmt(yd)} closed`, url: '#delivery/reports',
      body: `${dOrders.length} order${dOrders.length === 1 ? '' : 's'} · ${money(total)}${unpaid.length ? ` · ${unpaid.length} not paid yet (${money(unpaidSum)})` : ' · all paid'}.` });
  }

  // Vendor orders: overdue deliveries, orders logged 2+ days ago and never sent.
  const [{ data: orders }, { data: vendors }] = await Promise.all([
    db.from('vendor_orders').select('id, vendor_id, vendor_name, order_date, expected_delivery, status').in('status', ['pending', 'not_sent']),
    db.from('vendors').select('id, name'),
  ]);
  const vname = new Map((vendors ?? []).map(v => [v.id, v.name]));
  for (const o of orders ?? []) {
    const name = vname.get(o.vendor_id) || o.vendor_name || 'A vendor';
    if (o.status === 'pending' && o.expected_delivery && o.expected_delivery < today)
      add({ key: `vo:${o.id}:overdue:${today}`, perms: ['vendors.manage'], title: 'Vendor order', body: `"${name}"'s order is overdue — expected ${fmt(o.expected_delivery)} and still not marked delivered.`, url: '#vendors' });
    const age = o.order_date ? daysBetween(o.order_date, today) : 0;
    if (o.status === 'not_sent' && age >= 2)
      add({ key: `vo:${o.id}:notsent:${today}`, perms: ['vendors.manage'], title: 'Vendor order', body: `"${name}"'s order has been logged for ${age} days but still hasn't been marked sent to the supplier.`, url: '#vendors' });
  }

  // Cash: yesterday still empty after the reminder hour.
  const { data: cs } = await db.from('cash_settings').select('reminder_hour').eq('id', 'app').maybeSingle();
  if (beirutHour() >= (cs?.reminder_hour ?? 12)) {
    const y = addDays(today, -1);
    const [{ count: entries }, { count: active }] = await Promise.all([
      db.from('cash_differences').select('id', { count: 'exact', head: true }).eq('day', y),
      db.from('cashiers').select('id', { count: 'exact', head: true }).eq('active', true),
    ]);
    if (!entries && active) add({ key: `cash:empty:${y}`, perms: ['cash.enter'], title: 'Cash differences', body: `No cash differences entered yet for yesterday (${fmt(y)}).`, url: '#cash' });
  }

  // Floor check finished (last 24 h), to the people who follow all checks — not the one who did it.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: checks } = await db.from('floor_checks').select('id, started_by, completed_at, summary').gt('completed_at', since);
  if (checks?.length) {
    const { data: ps } = await db.from('profiles').select('id, username, display_name').in('id', checks.map(c => c.started_by));
    const who = new Map((ps ?? []).map(p => [p.id, p.display_name || p.username]));
    for (const c of checks) {
      const s = c.summary || {};
      add({ key: `floor:${c.id}`, perms: ['floorcheck.manage'], except: c.started_by, title: 'Floor check finished', url: '#floorcheck',
        body: `By ${who.get(c.started_by) || 'someone'}: ${s.wrong_price || 0} wrong price, ${s.missing_tag || 0} tag missing, ${s.out_of_stock || 0} out of stock${s.pending ? `, ${s.pending} not checked` : ''}.` });
    }
  }

  // Rentals: a spot rented (new contract, last 24 h — not to the person who entered it); a contract ending
  // (30, 14, 7, 3, 1 days before and the day itself) or expired yesterday, and not renewed.
  const { data: rc } = await db.from('rental_contracts').select('id, spot_id, supplier, term, amount, start_date, end_date, created_by, created_at')
    .or(`created_at.gt.${new Date(dayAgo).toISOString()},and(end_date.gte.${addDays(today, -1)},end_date.lte.${addDays(today, 30)})`);
  if (rc?.length) {
    const { data: later } = await db.from('rental_contracts').select('spot_id, supplier, start_date').gt('start_date', addDays(today, -1));
    const spotIds = rc.map(c => c.spot_id).filter(Boolean);
    const { data: spots } = spotIds.length ? await db.from('store_map_objects').select('id, type, label').in('id', spotIds) : { data: [] };
    const spot = new Map((spots ?? []).map(s => [s.id, s]));
    const TYPE: Record<string, string> = { gondola: 'gondola', endcap: 'end cap', side_gondola: 'side gondola', basket_side: 'basket side', display: 'display',
      display_side: 'display side', freezer: 'fridge / freezer', fridge_door: 'fridge door', wall_spot: 'wall spot', screen_wall: 'wall screen',
      screen_island: 'island screen', promo_table: 'promo table', promo_zone: 'promo zone', pillar: 'pillar' };
    const whereOf = (c: { spot_id: string | null }) => { const sp = c.spot_id ? spot.get(c.spot_id) : null; return sp ? `${TYPE[sp.type] || String(sp.type).replace(/_/g, ' ')}${sp.label ? ' ' + sp.label : ''}` : ''; };
    const money = (n: number) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    for (const c of rc) {
      const where = whereOf(c);
      if (c.created_at && Date.parse(c.created_at) > dayAgo)
        add({ key: `rent:${c.id}:new`, perms: ['rentals.contracts'], except: c.created_by ?? undefined, title: 'Spot rented', url: '#rentals',
          body: `${c.supplier} rented ${where ? 'the ' + where : 'a spot'} — ${money(c.amount)}${c.term === 'monthly' ? ' / month' : ' / year'} (${fmt(c.start_date)} → ${fmt(c.end_date)}).` });
      const d = daysBetween(today, c.end_date);
      if (c.start_date > today || d < -1 || d > 30) continue;
      const renewed = (later ?? []).some(x => x.start_date > c.end_date && (c.spot_id ? x.spot_id === c.spot_id : x.supplier.trim().toLowerCase() === c.supplier.trim().toLowerCase()));
      if (renewed) continue;
      const on = where ? ` on the ${where}` : '';
      if (d === -1) add({ key: `rent:${c.id}:expired`, perms: ['rentals.view'], title: 'Rent expired', url: '#rentals',
        body: `The contract for ${c.supplier}${on} expired yesterday (${fmt(c.end_date)}) and was not renewed — the spot is free.` });
      else if ([30, 14, 7, 3, 1, 0].includes(d)) add({ key: `rent:${c.id}:${d}`, perms: ['rentals.view'], title: 'Rent ending', url: '#rentals',
        body: `The contract for ${c.supplier}${on} ends ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`} (${fmt(c.end_date)}) — time to review the renewal.` });
    }
  }

  // Shelf labels: a list sent for printing and not exported yet (last 24 h).
  const { data: lists } = await db.from('label_lists').select('id, created_by_name, submitted_at').not('submitted_at', 'is', null).is('exported_at', null).gt('submitted_at', since);
  for (const l of lists ?? []) {
    const { count } = await db.from('label_items').select('id', { count: 'exact', head: true }).eq('list_id', l.id);
    add({ key: `labels:${l.id}`, perms: ['labels.print'], title: 'Labels to print', url: '#labels', body: `${l.created_by_name || 'A shelf worker'} sent ${count ?? 0} item${count === 1 ? '' : 's'} for new shelf labels.` });
  }
  // A supervisor changed a PUBLISHED week (migration 031): HR is told once the editing has stopped
  // (5 minutes without a change), with what was changed per person and day.
  const lab = (c: string) => { if (!c) return '—'; if (c === 'off') return 'Off'; const [m, t] = c.split('|'); const [sh, st] = m.split(':');
    return `${({ am: 'AM', pm: 'PM', full: 'Full' } as Record<string, string>)[sh] || sh}${st ? ' ' + (st === 'front' ? 'Front' : 'Back') : ''}${t ? ' ' + t : ''}`; };
  const { data: chg } = await db.from('schedule_changes').select('id, week_start, by_name, details, updated_at').is('notified_at', null)
    .lt('updated_at', new Date(Date.now() - 5 * 60 * 1000).toISOString());
  for (const c of chg ?? []) {
    const items = Object.values((c.details ?? {}) as Record<string, { name: string; day: string; dayIndex: number; from: string; to: string }>)
      .sort((a, b) => a.name.localeCompare(b.name) || a.dayIndex - b.dayIndex);
    if (!items.length) continue;
    const lines = items.slice(0, 4).map(i => `${i.name} ${i.day}: ${lab(i.from)} → ${lab(i.to)}`);
    add({ key: `sched-chg:${c.id}`, perms: ['schedule.manage'], title: `Schedule changed by ${c.by_name || 'a supervisor'}`, url: '#schedule',
      body: `Week of ${fmt(c.week_start)} (published) — ${lines.join('; ')}${items.length > 4 ? `; …and ${items.length - 4} more` : ''}.` });
    await db.from('schedule_changes').update({ notified_at: new Date().toISOString() }).eq('id', c.id);
  }

  // A supervisor sent the draft schedule for review (cashier page, migration 024): HR reviews and publishes it.
  const { data: sent } = await db.from('schedule_weeks').select('week_start, submitted_at, submitted_by').eq('published', false).not('submitted_at', 'is', null);
  for (const w of sent ?? [])
    add({ key: `sched-sent:${w.week_start}:${w.submitted_at}`, perms: ['schedule.manage'], title: 'Schedule draft ready', url: '#schedule',
      body: `${w.submitted_by || 'A supervisor'} sent the schedule of the week of ${fmt(w.week_start)} for review — check it and publish it.` });

  return out;
}

// ---- sending
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };
async function pushTo(subs: Sub[], payload: Record<string, unknown>, table = 'push_subscriptions') {
  let sent = 0, gone = 0, failed = 0;
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, VAPID, { topic: String(payload.tag || '') });
      if (r.ok) { sent++; await db.from(table).update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq('id', s.id); }
      else if (r.gone) { gone++; await db.from(table).delete().eq('id', s.id); }
      else { failed++; console.warn('push failed', r.status, r.text); await db.from(table).update({ failures: 1 }).eq('id', s.id); }
    } catch (e) { failed++; console.error('push error', e); }
  }
  return { sent, gone, failed };
}

async function run() {
  const today = beirut(), hour = beirutHour();
  if (hour < 7 || hour >= 22) return { quiet: true };
  const cashiers = await runCashiers(today);
  const { data: subs } = await db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth');
  if (!subs?.length) return { devices: 0, cashiers };
  const users = [...new Set(subs.map(s => s.user_id))];
  const perms = new Map<string, Set<string>>();
  for (const u of users) { const { data } = await db.rpc('perms_of', { p_user: u }); perms.set(u, new Set((data as string[]) ?? [])); }
  const alerts = await buildAlerts(today);
  let pushed = 0;
  for (const u of users) {
    // this person's alerts not sent yet — once per alert per person: only the run that records it sends it
    const mine: Alert[] = [];
    for (const a of alerts) {
      if (u === a.except || !a.perms.some(p => perms.get(u)?.has(p))) continue;
      const { data: fresh, error } = await db.from('push_log').insert({ key: a.key, user_id: u }).select('key');
      if (!error && fresh?.length) mine.push(a);
    }
    if (!mine.length) continue;
    const devices = subs.filter(s => s.user_id === u);
    if (mine.length <= 3) {
      for (const a of mine) pushed += (await pushTo(devices, { title: a.title, body: a.body, url: a.url, tag: a.key.split(':').slice(0, 2).join('-') })).sent;
    } else {
      // Many at once (e.g. the morning after quiet hours): one notification instead of a flood.
      const body = mine.slice(0, 3).map(a => '• ' + a.body).join('\n') + `\n…and ${mine.length - 3} more — open the app (bell).`;
      pushed += (await pushTo(devices, { title: `La Valeur — ${mine.length} new alerts`, body, url: './', tag: 'lv-digest' })).sent;
    }
  }
  return { devices: subs.length, alerts: alerts.length, pushed, cashiers };
}

// ---- cashiers' phones (no login: registered with their PIN on the cashier page)
const mondayOf = (d: string) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (d: string) => WEEKDAY[new Date(d + 'T00:00:00Z').getUTCDay()];
const money = (n: number, cur: string) => cur === 'USD'
  ? (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2)
  : (n < 0 ? '-' : '') + Math.round(Math.abs(n)).toLocaleString('en-US') + ' LBP';

async function runCashiers(today: string) {
  const { data: subs } = await db.from('cashier_push_subscriptions').select('id, cashier_id, endpoint, p256dh, auth, created_at');
  if (!subs?.length) return { devices: 0 };
  const ids = [...new Set(subs.map(x => x.cashier_id as string))];
  const { data: staff } = await db.from('cashiers').select('id').in('id', ids).eq('active', true);
  const active = new Set((staff ?? []).map(c => c.id));
  // Only what happened after the phone was registered (no flood of old news on the first run).
  const since = new Map<string, number>();
  subs.forEach(x => { const t = Date.parse(x.created_at); if (!since.has(x.cashier_id) || t < since.get(x.cashier_id)!) since.set(x.cashier_id, t); });
  const settled = new Date(Date.now() - 5 * 60 * 1000).toISOString();     // 5 minutes after the last edit
  const monday = mondayOf(today);
  const [{ data: weeks }, { data: diffs }] = await Promise.all([
    db.from('schedule_weeks').select('week_start, assignments, updated_at').eq('published', true)
      .gte('week_start', monday).lte('week_start', addDays(monday, 14)).lte('updated_at', settled),
    db.from('cash_differences').select('id, cashier_id, day, amount, currency, updated_at').in('cashier_id', ids)
      .gte('updated_at', new Date(Date.now() - 3 * 86400000).toISOString()).lte('updated_at', settled).order('day'),
  ]);
  const cur = 'LBP';   // like the Cash page and the cashier page
  let pushed = 0;
  for (const cid of ids) {
    if (!active.has(cid)) continue;
    const from = since.get(cid)!;
    const items: { key: string; body: string }[] = [];
    for (const w of weeks ?? []) {
      if (Date.parse(w.updated_at) < from) continue;
      const days = (((w.assignments ?? {}) as Record<string, string[]>)[cid] ?? []).slice(0, 7);
      if (!days.some(Boolean)) continue;
      const { data: before } = await db.from('cashier_push_log').select('key').eq('cashier_id', cid).like('key', `sched:${w.week_start}:%`).limit(1);
      items.push({ key: `sched:${w.week_start}:${days.join(',')}`,
        body: before?.length ? `Your schedule for the week of ${fmt(w.week_start)} was changed. Tap to see it.`
          : `Your schedule for the week of ${fmt(w.week_start)} is out. Tap to see it.` });
    }
    for (const d of diffs ?? []) {
      if (d.cashier_id !== cid || d.currency !== cur || Date.parse(d.updated_at) < from) continue;
      items.push({ key: `cash:${d.id}:${Number(d.amount)}`, body: `${dayName(d.day)} ${fmt(d.day)}: ${money(Number(d.amount), cur)}` });
    }
    const fresh: typeof items = [];
    for (const it of items) {
      const { data, error } = await db.from('cashier_push_log').insert({ key: it.key, cashier_id: cid }).select('key');
      if (!error && data?.length) fresh.push(it);
    }
    if (!fresh.length) continue;
    const devices = subs.filter(x => x.cashier_id === cid) as unknown as Sub[];
    const send = (title: string, body: string, tag: string) => pushTo(devices, { title, body, url: './cashier.html', tag, cashier: true }, 'cashier_push_subscriptions');
    for (const a of fresh.filter(i => i.key.startsWith('sched:'))) pushed += (await send('Your schedule', a.body, 'lv-sched')).sent;
    const cash = fresh.filter(i => i.key.startsWith('cash:'));
    if (cash.length === 1) pushed += (await send('Cash difference', cash[0].body, 'lv-cash')).sent;
    else if (cash.length > 1) pushed += (await send(`${cash.length} cash differences`,
      cash.slice(0, 4).map(c => '• ' + c.body).join('\n') + (cash.length > 4 ? `\n…and ${cash.length - 4} more` : ''), 'lv-cash')).sent;
  }
  return { devices: subs.length, pushed };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try { await loadKeys(); } catch (e) { return json({ error: (e as Error).message }, 500); }
  if (!keysLoaded) return json({ error: 'Push keys are not set up (Vault: supabase/secrets/push-vault.sql).' }, 500);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  try {
    if (body.action === 'test') {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return json({ error: 'Not signed in' }, 401);
      const { data: subs } = await db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth').eq('user_id', user.id);
      if (!subs?.length) return json({ error: 'No device of yours has notifications turned on.' }, 404);
      return json(await pushTo(subs, { title: 'La Valeur', body: 'Test notification — notifications work on this device, even with the app closed.', url: './', tag: 'lv-test' }));
    }
    if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ error: 'Forbidden' }, 403);
    return json(await run());
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message ?? 'Server error' }, 500);
  }
});
