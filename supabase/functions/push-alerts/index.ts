// push-alerts — notifications while the app is closed (Web Push), PLAN §10e.
//
// POST { action: 'run' }   from pg_cron every 10 minutes (header x-cron-secret = PUSH_CRON_SECRET):
//   works out the same alerts the app shows on its bell and pushes each one ONCE to every device of
//   every person whose permissions cover it (push_log). Quiet hours 22:00–07:00 Beirut: nothing is
//   sent; the alerts go out in the morning.
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

  // Sell-outs: not activated when it starts / still active when it ends.
  const { data: sos } = await db.from('sellouts').select('id, name, from, to, active, archived').eq('archived', false);
  for (const so of sos ?? []) {
    const toStart = daysBetween(today, so.from), toEnd = daysBetween(today, so.to);
    const a = (k: string, body: string, daily = false) => add({ key: `so:${so.id}:${k}${daily ? ':' + today : ''}`, perms: ['sellouts.view'], title: 'Sell-out', body, url: '#sellouts' });
    if (!so.active) {
      if (toStart === 1) a('startSoon', `"${so.name}" starts tomorrow (${fmt(so.from)}) and is not activated yet.`);
      if (toStart === 0) a('startDay', `"${so.name}" starts today and is still not activated.`);
      if (toStart < 0 && toEnd >= 0) a('startOverdue', `"${so.name}" was due to start on ${fmt(so.from)} and has still not been activated.`, true);
    } else {
      if (toEnd === 1) a('endSoon', `"${so.name}" ends tomorrow (${fmt(so.to)}) — remember to deactivate it.`);
      if (toEnd === 0) a('endDay', `"${so.name}" ends today — deactivate it.`);
      if (toEnd < 0) a('endOverdue', `"${so.name}" ended on ${fmt(so.to)} and is still active — deactivate it.`, true);
    }
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

  // Rental contracts ending (30, 14, 7, 3, 1 days before, and the day itself) and not renewed.
  const { data: rc } = await db.from('rental_contracts').select('id, spot_id, supplier, start_date, end_date').gte('end_date', today).lte('end_date', addDays(today, 30));
  if (rc?.length) {
    const { data: later } = await db.from('rental_contracts').select('spot_id, supplier, start_date').gt('start_date', today);
    const spotIds = rc.map(c => c.spot_id).filter(Boolean);
    const { data: spots } = spotIds.length ? await db.from('store_map_objects').select('id, type, label').in('id', spotIds) : { data: [] };
    const spot = new Map((spots ?? []).map(s => [s.id, s]));
    for (const c of rc) {
      const d = daysBetween(today, c.end_date);
      if (![30, 14, 7, 3, 1, 0].includes(d) || c.start_date > today) continue;
      const renewed = (later ?? []).some(x => x.start_date > c.end_date && (c.spot_id ? x.spot_id === c.spot_id : x.supplier.trim().toLowerCase() === c.supplier.trim().toLowerCase()));
      if (renewed) continue;
      const sp = c.spot_id ? spot.get(c.spot_id) : null;
      const where = sp ? ` on ${String(sp.type).replace(/_/g, ' ')}${sp.label ? ' ' + sp.label : ''}` : '';
      add({ key: `rent:${c.id}:${d}`, perms: ['rentals.view'], title: 'Rental contract', url: '#rentals',
        body: `Contract for ${c.supplier}${where} ends ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`} (${fmt(c.end_date)}) — time to review the renewal.` });
    }
  }

  // Shelf labels: a list sent for printing and not exported yet (last 24 h).
  const { data: lists } = await db.from('label_lists').select('id, created_by_name, submitted_at').not('submitted_at', 'is', null).is('exported_at', null).gt('submitted_at', since);
  for (const l of lists ?? []) {
    const { count } = await db.from('label_items').select('id', { count: 'exact', head: true }).eq('list_id', l.id);
    add({ key: `labels:${l.id}`, perms: ['labels.print'], title: 'Labels to print', url: '#labels', body: `${l.created_by_name || 'A shelf worker'} sent ${count ?? 0} item${count === 1 ? '' : 's'} for new shelf labels.` });
  }
  return out;
}

// ---- sending
type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };
async function pushTo(subs: Sub[], payload: Record<string, unknown>) {
  let sent = 0, gone = 0, failed = 0;
  for (const s of subs) {
    try {
      const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, VAPID, { topic: String(payload.tag || '') });
      if (r.ok) { sent++; await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq('id', s.id); }
      else if (r.gone) { gone++; await db.from('push_subscriptions').delete().eq('id', s.id); }
      else { failed++; console.warn('push failed', r.status, r.text); await db.from('push_subscriptions').update({ failures: 1 }).eq('id', s.id); }
    } catch (e) { failed++; console.error('push error', e); }
  }
  return { sent, gone, failed };
}

async function run() {
  const today = beirut(), hour = beirutHour();
  if (hour < 7 || hour >= 22) return { quiet: true };
  const { data: subs } = await db.from('push_subscriptions').select('id, user_id, endpoint, p256dh, auth');
  if (!subs?.length) return { devices: 0 };
  const users = [...new Set(subs.map(s => s.user_id))];
  const perms = new Map<string, Set<string>>();
  for (const u of users) { const { data } = await db.rpc('perms_of', { p_user: u }); perms.set(u, new Set((data as string[]) ?? [])); }
  const alerts = await buildAlerts(today);
  let pushed = 0;
  for (const a of alerts) {
    for (const u of users) {
      if (u === a.except || !a.perms.some(p => perms.get(u)?.has(p))) continue;
      // once per alert per person: only the first run that records it sends it
      const { data: fresh, error } = await db.from('push_log').insert({ key: a.key, user_id: u }).select('key');
      if (error || !fresh?.length) continue;
      const r = await pushTo(subs.filter(s => s.user_id === u), { title: a.title, body: a.body, url: a.url, tag: a.key.split(':').slice(0, 2).join('-') });
      pushed += r.sent;
    }
  }
  return { devices: subs.length, alerts: alerts.length, pushed };
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
