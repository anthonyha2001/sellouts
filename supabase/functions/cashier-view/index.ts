// cashier-view — the public cashier page's only door to the data (PLAN §8.5). No login.
// A cashier picks their name and types their 4-digit PIN; the PIN is checked in the database
// (cashier_verify_pin: bcrypt, 5 wrong tries -> locked 15 minutes) and ONLY that cashier's
// differences for the current or previous month are returned. Read-only.
//
// POST { action: 'cashiers' }                              -> { cashiers: [{ id, name, has_pin }] }
// POST { action: 'view', cashier_id, pin, month? }         -> { cashier, month, months, entries, total, levels, schedule }
//   schedule: this week and next week of the staff schedule (migration 020), published weeks only:
//   [{ week_start, days: ['am:front' | 'pm:back|14:30-20:00' | 'full' | 'off' | '', … Mon→Sun] }]
//   team (supervisors only): [{ week_start, people: [{ name, position, days }] }] — the whole published week
// POST { action: 'subscribe', cashier_id, pin, endpoint, p256dh, auth } -> { ok }  this phone gets the cashier's
//   notifications (schedule published, difference entered; sent by push-alerts, migration 023)
// POST { action: 'unsubscribe', endpoint }                -> { ok }  this phone stops getting them
// POST { action: 'change_pin', cashier_id, pin, new_pin }  -> { ok }  the cashier's own new PIN (migration 038):
//   the current PIN is checked first (same lock-out); 4 digits, not the same as before, not too easy
//
// Supervisors' shared draft (migration 024): every call carries cashier_id + pin of a SUPERVISOR.
// POST { action: 'draft_get', week_start? }       -> { weeks: [{ week_start, status, submitted_by, last_editor }], week, staff }
//   status: 'none' | 'draft' | 'sent' | 'published' (published = read-only); weeks = this week and the next three
// POST { action: 'draft_create', week_start, copy } -> { ok }  start a week (copy of the week before, or empty)
// POST { action: 'draft_set', week_start, staff_id, day, code } -> { days }  one cell (schedule_set_cell)
// Requests (migration 027; any active cashier or supervisor, with their PIN):
// POST { action: 'req_get' }                       -> { weeks: [{ week_start, published, days, note, updated_at }] }  the next three weeks
// POST { action: 'req_save', week_start, days, note } -> { ok }  refused once the week is published
// POST { action: 'draft_submit', week_start }     -> { ok }  "Send to HR": HR is notified (push-alerts) and publishes
//
// Activity (migration 039): what a cashier does here goes into activity_log (module "cashier_page", under
// their name): opened the page (once per 30 minutes), wrong PIN / locked out, changed their PIN, sent
// requests, turned notifications on, supervisors' draft (started, edited — once per 30 minutes, sent).
// cashiers.last_seen_at = when they last opened the page.
//
// Deploy with JWT verification OFF (the page has no user session).
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Current and previous month in Beirut time, as 'YYYY-MM'.
function beirutMonths() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
  const [y, m] = today.split('-').map(Number);
  const cur = `${y}-${String(m).padStart(2, '0')}`;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [cur, prev];
}
// Monday of this week and of next week in Beirut time.
function beirutWeeks() {
  const d = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const next = new Date(d); next.setUTCDate(d.getUTCDate() + 7);
  return [d.toISOString().slice(0, 10), next.toISOString().slice(0, 10)];
}
// The person's published shifts; an empty list before migration 020 or when nothing is published.
async function scheduleOf(id: string) {
  const { data, error } = await db.from('schedule_weeks').select('week_start, assignments')
    .in('week_start', beirutWeeks()).eq('published', true).order('week_start');
  if (error) { console.error(error); return []; }
  return (data ?? []).map(w => ({ week_start: w.week_start, days: ((w.assignments ?? {})[id] ?? []).slice(0, 7) }));
}
// Supervisors see the whole team's published schedule (owner, 2026-10-01): names and shifts only.
async function teamOf() {
  const [{ data: weeks, error }, { data: staff }] = await Promise.all([
    db.from('schedule_weeks').select('week_start, assignments').in('week_start', beirutWeeks()).eq('published', true).order('week_start'),
    db.from('cashiers').select('id, name, position, active').order('sort_order').order('name'),
  ]);
  if (error) { console.error(error); return []; }
  return (weeks ?? []).map(w => {
    const a = (w.assignments ?? {}) as Record<string, string[]>;
    const people = (staff ?? []).filter(p => ['cashier', 'supervisor'].includes(p.position ?? 'cashier') && (p.active || (a[p.id] ?? []).some(Boolean)))
      .map(p => ({ name: p.name, position: p.position ?? 'cashier', days: (a[p.id] ?? []).slice(0, 7) }));
    return { week_start: w.week_start, people };
  });
}
// The supervisors' editable weeks: this week and the next three (Beirut).
function draftWeeks() {
  const [w0] = beirutWeeks();
  return [0, 7, 14, 21].map(n => { const d = new Date(w0 + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); });
}
// PIN right AND an active supervisor: their name, otherwise the error response.
async function supervisorOf(body: Record<string, unknown>): Promise<{ name: string } | Response> {
  const bad = await pinError(body);
  if (bad) return bad;
  const { data: me } = await db.from('cashiers').select('name, position, active').eq('id', String(body.cashier_id)).maybeSingle();
  if (!me || !me.active || me.position !== 'supervisor') return json({ error: 'Only supervisors can work on the draft schedule.' }, 403);
  return { name: me.name };
}
function monthEnd(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

// The cashier's name + PIN: null when they are right, otherwise the error response to send.
// One line in the activity log, under the cashier's name. `once`: not again for the same action within 30 minutes.
async function logAs(cashierId: string, action: string, summary: string, details: Record<string, unknown> | null = null, once = false) {
  try {
    if (once) {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { count } = await db.from('activity_log').select('id', { count: 'exact', head: true })
        .eq('module', 'cashier_page').eq('action', action).eq('entity_id', cashierId).gte('at', since);
      if (count) return;
    }
    const { data: c } = await db.from('cashiers').select('name, position').eq('id', cashierId).maybeSingle();
    if (!c) return;
    await db.from('activity_log').insert({ username: c.name, role: c.position === 'supervisor' ? 'supervisor' : 'cashier',
      module: 'cashier_page', action, entity_type: 'cashier', entity_id: cashierId, summary: `${c.name} ${summary}`, details });
  } catch (e) { console.error('activity log', e); }
}

async function pinError(body: Record<string, unknown>): Promise<Response | null> {
  const cashierId = String(body.cashier_id ?? '');
  const pin = String(body.pin ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(cashierId)) return json({ error: 'Choose your name.' }, 400);
  if (!/^\d{4}$/.test(pin)) return json({ error: 'The PIN is 4 digits.' }, 400);
  const { data: check, error: checkErr } = await db.rpc('cashier_verify_pin', { p_cashier: cashierId, p_pin: pin });
  if (checkErr) throw checkErr;
  const result = Array.isArray(check) ? check[0] : check;
  if (result.status === 'locked') { await logAs(cashierId, 'locked_out', 'is locked out (too many wrong PINs)', { until: result.locked_until }, true); return json({ error: 'Too many wrong PINs. Try again later.', locked_until: result.locked_until }, 423); }
  if (result.status === 'wrong') { await logAs(cashierId, 'wrong_pin', `typed a wrong PIN (${result.attempts_left} tries left)`); return json({ error: 'Wrong PIN.', attempts_left: result.attempts_left }, 401); }
  if (result.status === 'no_pin') return json({ error: 'No PIN has been set for you yet. Ask your manager.' }, 403);
  if (result.status !== 'ok') return json({ error: 'Choose your name.' }, 404);
  return null;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  try {
    if (body.action === 'cashiers') {
      const { data, error } = await db.from('cashiers').select('id, name, has_pin')
        .eq('active', true).order('sort_order').order('name');
      if (error) throw error;
      return json({ cashiers: data });
    }

    if (body.action === 'view') {
      const cashierId = String(body.cashier_id ?? '');
      const bad = await pinError(body);
      if (bad) return bad;

      await Promise.all([
        logAs(cashierId, 'opened', 'opened the cashier page', null, true),
        db.from('cashiers').update({ last_seen_at: new Date().toISOString() }).eq('id', cashierId),
      ]);
      const months = beirutMonths();
      const month = months.includes(String(body.month)) ? String(body.month) : months[0];
      // Always LBP, like the Cash page (js/modules/cash.js CURRENCY); the old USD rows stay in the
      // database but are not shown (owner, 2026-10-01). cash_settings.currency is not used.
      const { data: settings } = await db.from('cash_settings').select('warning_threshold, danger_threshold').eq('id', 'app').single();
      const currency = 'LBP';
      const [{ data: cashier }, { data: rows, error: rowsErr }, schedule, { data: pos }] = await Promise.all([
        db.from('cashiers').select('name').eq('id', cashierId).single(),
        db.from('cash_differences').select('day, amount, note')
          .eq('cashier_id', cashierId).eq('currency', currency)
          .gte('day', `${month}-01`).lte('day', monthEnd(month)).order('day'),
        scheduleOf(cashierId),
        db.from('cashiers').select('position').eq('id', cashierId).maybeSingle(),   // null before migration 020
      ]);
      if (rowsErr) throw rowsErr;
      const team = pos?.position === 'supervisor' ? await teamOf() : undefined;
      const entries = (rows ?? []).map(r => ({ day: r.day, amount: Number(r.amount), note: r.note }));
      const total = Math.round(entries.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      return json({
        cashier: { name: cashier?.name ?? '', position: pos?.position ?? 'cashier' }, schedule, team, month, months, entries, total,
        levels: { warning: Number(settings?.warning_threshold ?? 0), danger: Number(settings?.danger_threshold ?? 0), currency },
      });
    }

    if (body.action === 'change_pin') {
      const bad = await pinError(body);
      if (bad) return bad;
      const next = String(body.new_pin ?? '');
      if (!/^\d{4}$/.test(next)) return json({ error: 'The new PIN must be 4 digits.' }, 400);
      if (next === String(body.pin)) return json({ error: 'The new PIN is the same as the old one.' }, 400);
      // Too easy to guess: 1111, 1234, 4321, 0000…
      if (/^(\d)\1{3}$/.test(next) || '0123456789'.includes(next) || '9876543210'.includes(next))
        return json({ error: 'That PIN is too easy to guess. Choose another one.' }, 400);
      const { error } = await db.rpc('cashier_change_pin', { p_cashier: String(body.cashier_id), p_pin: next });
      if (error) throw error;
      await logAs(String(body.cashier_id), 'change_pin', 'changed their PIN');   // never the PIN itself
      return json({ ok: true });
    }

    if (body.action === 'subscribe') {
      const bad = await pinError(body);
      if (bad) return bad;
      const endpoint = String(body.endpoint ?? ''), p256dh = String(body.p256dh ?? ''), auth = String(body.auth ?? '');
      if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return json({ error: 'This phone cannot get notifications.' }, 400);
      // One phone = one person: registering again moves it to whoever signed in now.
      const { error } = await db.from('cashier_push_subscriptions').upsert({
        cashier_id: String(body.cashier_id), endpoint, p256dh, auth,
        user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300), created_at: new Date().toISOString(), failures: 0,
      }, { onConflict: 'endpoint' });
      if (error) throw error;
      await logAs(String(body.cashier_id), 'notifications_on', 'turned on notifications on their phone', null, true);
      return json({ ok: true });
    }

    if (body.action === 'req_get' || body.action === 'req_save') {
      const bad = await pinError(body);
      if (bad) return bad;
      const me = String(body.cashier_id);
      const weeks = draftWeeks().slice(1);          // next week and the two after
      if (body.action === 'req_get') {
        const [{ data: reqs }, { data: pub }] = await Promise.all([
          db.from('schedule_requests').select('week_start, days, note, updated_at').eq('cashier_id', me).in('week_start', weeks),
          db.from('schedule_weeks').select('week_start, published').in('week_start', weeks),
        ]);
        return json({ weeks: weeks.map(w => {
          const r = (reqs ?? []).find(x => x.week_start === w);
          return { week_start: w, published: !!(pub ?? []).find(x => x.week_start === w)?.published, days: r?.days ?? null, note: r?.note ?? '', updated_at: r?.updated_at ?? null };
        }) });
      }
      const week = String(body.week_start ?? '');
      if (!weeks.includes(week)) return json({ error: 'That week cannot be requested here.' }, 400);
      const { data: wk } = await db.from('schedule_weeks').select('published').eq('week_start', week).maybeSingle();
      if (wk?.published) return json({ error: 'This week is already published — ask your supervisor.' }, 409);
      const days = Array.isArray(body.days) ? body.days.slice(0, 7).map(d => String(d ?? '')) : [];
      while (days.length < 7) days.push('');
      if (days.some(d => !['', 'am', 'pm', 'full', 'off'].includes(d))) return json({ error: 'Bad request.' }, 400);
      const note = String(body.note ?? '').trim().slice(0, 300) || null;
      const { error } = await db.from('schedule_requests').upsert({ week_start: week, cashier_id: me, days, note, updated_at: new Date().toISOString() }, { onConflict: 'week_start,cashier_id' });
      if (error) throw error;
      const asked = days.map((d, i) => d ? `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} ${d === 'off' ? 'Off' : d === 'full' ? 'Full' : d.toUpperCase()}` : '').filter(Boolean);
      await logAs(me, 'request', `sent their requests for the week of ${week}${asked.length ? ': ' + asked.join(', ') : ''}`, { week_start: week, days, note });
      return json({ ok: true });
    }

    if (typeof body.action === 'string' && body.action.startsWith('draft_')) {
      const me = await supervisorOf(body);
      if (me instanceof Response) return me;
      const weeks = draftWeeks();
      const week = String(body.week_start ?? weeks[0]);
      if (!weeks.includes(week)) return json({ error: 'That week cannot be edited here.' }, 400);

      if (body.action === 'draft_get') {
        const [{ data: rows, error }, { data: staff }, { data: reqs }] = await Promise.all([
          db.from('schedule_weeks').select('week_start, published, submitted_at, submitted_by, last_editor, assignments').in('week_start', weeks),
          db.from('cashiers').select('id, name, position, default_station').eq('active', true).in('position', ['cashier', 'supervisor']).order('sort_order').order('name'),
          db.from('schedule_requests').select('cashier_id, days, note').eq('week_start', week),
        ]);
        if (error) throw error;
        const byWeek = new Map((rows ?? []).map(r => [r.week_start, r]));
        const prevOf = (w: string) => { const d = new Date(w + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10); };
        const { data: prev } = await db.from('schedule_weeks').select('week_start').eq('week_start', prevOf(week)).maybeSingle();
        const cur = byWeek.get(week);
        return json({
          weeks: weeks.map(w => { const r = byWeek.get(w); return { week_start: w, status: !r ? 'none' : r.published ? 'published' : r.submitted_at ? 'sent' : 'draft', submitted_by: r?.submitted_by ?? null, submitted_at: r?.submitted_at ?? null, last_editor: r?.last_editor ?? null }; }),
          week: cur ? { week_start: week, published: cur.published, submitted_at: cur.submitted_at, submitted_by: cur.submitted_by, last_editor: cur.last_editor, assignments: cur.assignments ?? {} } : null,
          staff: staff ?? [], can_copy: !!prev, requests: reqs ?? [],
        });
      }

      if (body.action === 'draft_create') {
        const { data: exists } = await db.from('schedule_weeks').select('week_start').eq('week_start', week).maybeSingle();
        if (exists) return json({ ok: true });
        let assignments: Record<string, string[]> = {};
        if (body.copy) {
          const d = new Date(week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 7);
          // Everyone still working: cashiers-list ids, and the staff ids of the other departments (migration 043).
          const [{ data: prev }, { data: active }, { data: others }] = await Promise.all([
            db.from('schedule_weeks').select('assignments').eq('week_start', d.toISOString().slice(0, 10)).maybeSingle(),
            db.from('cashiers').select('id').eq('active', true),
            db.from('staff').select('id').eq('active', true).is('cashier_id', null),
          ]);
          const ids = new Set([...(active ?? []), ...(others ?? [])].map(c => c.id));
          for (const [id, days] of Object.entries((prev?.assignments ?? {}) as Record<string, string[]>)) if (ids.has(id)) assignments[id] = days.slice(0, 7);
        }
        const { error } = await db.from('schedule_weeks').insert({ week_start: week, assignments, published: false, last_editor: me.name });
        if (error && !/duplicate/i.test(error.message)) throw error;
        await logAs(String(body.cashier_id), 'draft_start', `started the draft schedule of the week of ${week}${body.copy ? ' (copied from the week before)' : ''}`, { week_start: week });
        return json({ ok: true });
      }

      if (body.action === 'draft_set') {
        const staffId = String(body.staff_id ?? ''), day = Number(body.day), code = String(body.code ?? '');
        const { data: person } = await db.from('cashiers').select('id').eq('id', staffId).eq('active', true).maybeSingle();
        if (!person) return json({ error: 'Unknown person.' }, 400);
        const { data, error } = await db.rpc('schedule_set_cell', { p_week: week, p_staff: staffId, p_day: day, p_code: code, p_editor: me.name });
        if (error) return json({ error: /published/i.test(error.message) ? 'This week is published — ask HR to unpublish it to change it.' : 'Not saved: ' + error.message }, 409);
        await logAs(String(body.cashier_id), 'draft_edit', `edited the draft schedule of the week of ${week}`, { week_start: week }, true);
        return json({ days: data });
      }

      if (body.action === 'draft_submit') {
        const { data, error } = await db.from('schedule_weeks').update({ submitted_at: new Date().toISOString(), submitted_by: me.name })
          .eq('week_start', week).eq('published', false).select('week_start');
        if (error) throw error;
        if (!data?.length) return json({ error: 'This week is already published.' }, 409);
        await logAs(String(body.cashier_id), 'draft_send', `sent the draft schedule of the week of ${week} to HR`, { week_start: week });
        return json({ ok: true });
      }
      return json({ error: 'Unknown action' }, 400);
    }

    if (body.action === 'unsubscribe') {
      const endpoint = String(body.endpoint ?? '');
      if (endpoint) await db.from('cashier_push_subscriptions').delete().eq('endpoint', endpoint);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
});
