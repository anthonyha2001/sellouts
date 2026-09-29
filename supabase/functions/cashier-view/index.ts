// cashier-view — the public cashier page's only door to the data (PLAN §8.5). No login.
// A cashier picks their name and types their 4-digit PIN; the PIN is checked in the database
// (cashier_verify_pin: bcrypt, 5 wrong tries -> locked 15 minutes) and ONLY that cashier's
// differences for the current or previous month are returned. Read-only.
//
// POST { action: 'cashiers' }                              -> { cashiers: [{ id, name, has_pin }] }
// POST { action: 'view', cashier_id, pin, month? }         -> { cashier, month, months, entries, total, levels }
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
function monthEnd(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
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
      const pin = String(body.pin ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(cashierId)) return json({ error: 'Choose your name.' }, 400);
      if (!/^\d{4}$/.test(pin)) return json({ error: 'The PIN is 4 digits.' }, 400);

      const { data: check, error: checkErr } = await db.rpc('cashier_verify_pin', { p_cashier: cashierId, p_pin: pin });
      if (checkErr) throw checkErr;
      const result = Array.isArray(check) ? check[0] : check;
      if (result.status === 'locked') return json({ error: 'Too many wrong PINs. Try again later.', locked_until: result.locked_until }, 423);
      if (result.status === 'wrong') return json({ error: 'Wrong PIN.', attempts_left: result.attempts_left }, 401);
      if (result.status === 'no_pin') return json({ error: 'No PIN has been set for you yet. Ask the accountant.' }, 403);
      if (result.status !== 'ok') return json({ error: 'Choose your name.' }, 404);

      const months = beirutMonths();
      const month = months.includes(String(body.month)) ? String(body.month) : months[0];
      // The amounts are in the app's cash currency (cash_settings.currency; LBP since migration 015).
      const { data: settings } = await db.from('cash_settings').select('warning_threshold, danger_threshold, currency').eq('id', 'app').single();
      const currency = settings?.currency ?? 'LBP';
      const [{ data: cashier }, { data: rows, error: rowsErr }] = await Promise.all([
        db.from('cashiers').select('name').eq('id', cashierId).single(),
        db.from('cash_differences').select('day, amount, note')
          .eq('cashier_id', cashierId).eq('currency', currency)
          .gte('day', `${month}-01`).lte('day', monthEnd(month)).order('day'),
      ]);
      if (rowsErr) throw rowsErr;
      const entries = (rows ?? []).map(r => ({ day: r.day, amount: Number(r.amount), note: r.note }));
      const total = Math.round(entries.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      return json({
        cashier: { name: cashier?.name ?? '' }, month, months, entries, total,
        levels: { warning: Number(settings?.warning_threshold ?? 0), danger: Number(settings?.danger_threshold ?? 0), currency },
      });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'Something went wrong. Try again.' }, 500);
  }
});
