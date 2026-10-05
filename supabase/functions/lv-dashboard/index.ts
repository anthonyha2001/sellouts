// lv-dashboard — the app's read-only link to the La Valeur Dashboard (dashboard.lavaleursupermarche.com) (owner, 2026-10-06).
// The dashboard's login is a server secret (LV_DASH_USER / LV_DASH_PASS, typed by the owner, never in the code or the
// browser). This function logs in (POST /api/lavaleur/auth/token), keeps the token (about a day) and logs in again when
// it expires, and answers only what the app needs:
//   POST { action: 'status' }                         -> { ok, user, expires_at }      admin (or the server key): the link works
//   POST { action: 'item_search', search, branch? }   -> { items: [...] }               code / barcode / name -> code, barcodes, description, stock
//   POST { action: 'items_stock', codes: [...] }      -> { stock: { code: qty|null } }  up to 300 codes (exact code match)
// Callers: a signed-in, active app user (Authorization: Bearer <their session>). Read only: nothing is ever written there.
// Deploy with JWT verification OFF (the user is checked here).
import { createClient } from 'npm:@supabase/supabase-js@2';

const BASE = 'https://dashboard.lavaleursupermarche.com/api/lavaleur';
const BRANCH = 'Ajaltoun';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// The server's own keys (for a check from the server side only).
function serverKeys(): string[] {
  const out = [Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''];
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); Object.values(k).forEach(v => out.push(String(v))); } catch { /* not JSON */ }
  return out.filter(Boolean);
}

/* ---------------- the dashboard's token ---------------- */
let token: string | null = null, tokenExp = 0;
// "eyJleHAiOjE3OTEyNjExNDgsInN1YiI6Ii4uLiJ9.signature": the first part says when it expires.
function expOf(t: string): number {
  try { const p = JSON.parse(atob(t.split('.')[0])); return Number(p.exp) * 1000 || 0; } catch { return 0; }
}
async function login(): Promise<string> {
  const username = Deno.env.get('LV_DASH_USER'), password = Deno.env.get('LV_DASH_PASS');
  if (!username || !password) throw new Error('The dashboard login is not set (server secrets).');
  const r = await fetch(`${BASE}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username, password }) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dashboard login refused (${r.status})`);
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(text); } catch { /* the token as plain text */ }
  const t = String(d.access_token ?? d.token ?? (d.data as Record<string, unknown>)?.access_token ?? (d.data as Record<string, unknown>)?.token ?? (text.startsWith('ey') ? text : ''));
  if (!t) throw new Error('Dashboard login: no token in the answer');
  token = t; tokenExp = expOf(t) || Date.now() + 6 * 3600e3;
  return t;
}
async function dash(path: string, init: RequestInit = {}, retry = true): Promise<unknown> {
  if (!token || Date.now() > tokenExp - 5 * 60e3) await login();
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (r.status === 401 && retry) { token = null; return dash(path, init, false); }
  if (!r.ok) throw new Error(`Dashboard answered ${r.status}${r.status === 422 ? ": " + (await r.text()).slice(0, 300) : ""}`);
  return r.json();
}
const year = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }).slice(0, 4);
type Item = { code: string; barcode?: string; barcodes?: string[]; description?: string; description4?: string; available_quantity?: number | null; available_quantity_branch?: string };
const slim = (i: Item) => ({ code: String(i.code ?? ''), barcodes: i.barcodes || (i.barcode ? [i.barcode] : []), description: i.description || '', size: i.description4 || '', stock: i.available_quantity ?? null, branch: i.available_quantity_branch || BRANCH });
async function search(q: string, branch = BRANCH): Promise<Item[]> {
  const p = new URLSearchParams({ search: q, year: year(), preferred_branch: branch });
  const d = await dash(`/items/search?${p}`);
  return Array.isArray(d) ? d as Item[] : [];
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  // who is asking: a signed-in, active app user (or the server itself, for "status")
  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') || '';
  const isServer = (!!bearer && serverKeys().includes(bearer)) || (!!apikey && serverKeys().includes(apikey));
  let role = '';
  if (!isServer) {
    const { data: u } = await db.auth.getUser(bearer);
    if (!u?.user) return json({ error: 'Sign in first.' }, 401);
    const { data: prof } = await db.from('profiles').select('role, active').eq('id', u.user.id).maybeSingle();
    if (!prof?.active) return json({ error: 'Not allowed.' }, 403);
    role = prof.role || '';
  }

  try {
    if (body.action === 'status') {
      if (!isServer && role !== 'admin') return json({ error: 'Admin only.' }, 403);
      // a real, light read (logs in only when needed): proves the login and the data both work
      if (body.fresh) token = null;
      const t0 = Date.now();
      const sample = await search(String(body.code || '128420'));
      return json({ ok: true, user: Deno.env.get('LV_DASH_USER'), expires_at: new Date(tokenExp).toISOString(), ms: Date.now() - t0,
        sample: sample[0] ? { code: sample[0].code, description: sample[0].description, stock: sample[0].available_quantity ?? null } : null });
    }
    // Server key only (maintenance): one read-only report, as the dashboard answers it, to map its fields.
    if (body.action === 'probe') {
      if (!isServer) return json({ error: 'Not allowed.' }, 403);
      const path = String(body.path || '');
      const READ = /^\/(item-price-checker|item-cardex|items\/search|items\/filter-options\/[a-z]+|items_sales(\/grid|\/summary)?|items_purchases(\/grid)?)$/;
      if (!READ.test(path)) return json({ error: 'Not a read-only report.' }, 400);
      if (body.post) return json(await dash(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.post) }));
      return json(await dash(`${path}?${new URLSearchParams((body.query || {}) as Record<string, string>)}`));
    }
    // The Promotions page's item details, live (replaces the catalog file): up to 100 codes.
    //   price check (one per code): description, barcode, pack, supplier, section, group, brand, price now,
    //   normal price, on promotion, stock; sales this year (one report); last purchase date (one report).
    if (body.action === 'items_info') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 100);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const y = year(), today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
      const out: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < codes.length; i += 6) {
        await Promise.all(codes.slice(i, i + 6).map(async c => {
          try {
            const d = await dash(`/item-price-checker?${new URLSearchParams({ search: c, year: y, branches: BRANCH })}`) as Record<string, unknown>;
            const br = ((d.branches as Record<string, Record<string, unknown[]>>) || {})[BRANCH] || {};
            const rows = (Object.values(br).flat() as Record<string, unknown>[]);
            const hit = rows.find(r => key(String(r.ItemCode ?? '')) === key(c));
            if (!hit) return;
            const t = (v: unknown) => String(v ?? '').trim();
            out[c] = { code: t(hit.ItemCode), description: t(hit.Description), size: t(hit.Description4), barcodes: hit.Barcode ? [t(hit.Barcode)] : [],
              pack: hit.Pack ?? null, supplier: t(hit.Supplier), section: t(hit.Section), group: t(hit.Group), brand: t(hit.Brand),
              price: hit.Price ?? null, salePrice: hit.SalePrice ?? null, promoted: !!Number(hit.isPromoted || 0), stock: hit.AvailableQuantity ?? null,
              outYtd: null, lastPurchase: null };
          } catch (e) { console.warn('price check', c, e); }
        }));
      }
      const found = Object.keys(out);
      if (found.length) {
        const base = { branches: [BRANCH], year: y, from_date: `${y}-01-01`, to_date: today, group_by: ['item'], item: found.map(c => String(out[c].code)) };
        const byItem = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
        const codeOf = new Map(found.map(c => [key(String(out[c].code)), c]));
        try {
          const s = await dash('/items_sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, aggregation: 'Monthly' }) });
          byItem(s).forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c) out[c].outYtd = Number(out[c].outYtd || 0) + Number(r.total_quantity || 0); });
          found.forEach(c => { if (out[c].outYtd === null) out[c].outYtd = 0; });
        } catch (e) { console.warn('sales', e); }
        try {
          const p = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, aggregation: 'Daily' }) });
          byItem(p).forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c && Number(r.total_quantity || 0) > 0 && String(r.period) > String(out[c].lastPurchase || '')) out[c].lastPurchase = String(r.period); });
        } catch (e) { console.warn('purchases', e); }
      }
      return json({ items: out });
    }
    // Last purchase cost (owner, 2026-10-06), up to 60 codes: the day of the last purchase (this year, else last
    // year), then that day's purchase lines from the item cardex, grouped by document (the PU / PC number).
    // In one document, a paid line + a line at 100% discount = a trade deal (e.g. 30 + 6 free):
    // both lines are given, and the real cost = what was paid / all the units received.
    if (body.action === 'last_cost') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 60);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }), y = Number(today.slice(0, 4));
      const last: Record<string, string> = {};
      const byItem = (d: unknown) => (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
      for (const yr of [y, y - 1]) {
        const want = codes.filter(c => !last[c]); if (!want.length) break;
        try {
          const d = await dash('/items_purchases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            branches: [BRANCH], year: String(yr), from_date: `${yr}-01-01`, to_date: yr === y ? today : `${yr}-12-31`, aggregation: 'Daily', group_by: ['item'], item: want }) });
          const codeOf = new Map(want.map(c => [key(c), c]));
          byItem(d).forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (c && Number(r.total_quantity || 0) > 0 && String(r.period) > String(last[c] || '')) last[c] = String(r.period); });
        } catch (e) { console.warn('last purchase', yr, e); }
      }
      const r2 = (n: number) => Math.round(n * 10000) / 10000;
      const costs: Record<string, unknown> = {};
      const todo = Object.keys(last);
      for (let i = 0; i < todo.length; i += 6) {
        await Promise.all(todo.slice(i, i + 6).map(async c => {
          const day = last[c];
          try {
            const d = await dash(`/item-cardex?${new URLSearchParams({ branch: BRANCH, item_code: c, year: day.slice(0, 4), from_date: day, to_date: day })}`) as Record<string, unknown>;
            const rows = (((d.data as Record<string, unknown>)?.rows || []) as Record<string, unknown>[])
              .filter(r => String(r.operation_code) === '15' || /purchase/i.test(String(r.operation_label || '')))
              .filter(r => Number(r.qty_in || 0) > 0);
            const docs = new Map<string, Record<string, unknown>[]>();
            rows.forEach(r => { const k = String(r.document_no || r.document_number || '?'); if (!docs.has(k)) docs.set(k, []); docs.get(k)!.push(r); });
            costs[c] = { date: day, docs: [...docs.entries()].map(([doc, ls]) => {
              const lines = ls.map(r => {
                const up = Number(r.unit_price || 0), net = Math.abs(Number(r.net_unit_price || 0)) < 0.005 ? 0 : Number(r.net_unit_price || 0);
                return { qty: r2(Number(r.qty_in || 0)), unit: r2(up), net: r2(net), total: r2(Number(r.line_total || 0)),
                  discountPct: up > 0 ? Math.round((1 - net / up) * 100) : 0, free: net === 0 };
              });
              const paidQty = lines.filter(l => !l.free).reduce((t, l) => t + l.qty, 0), freeQty = lines.filter(l => l.free).reduce((t, l) => t + l.qty, 0);
              const paid = lines.reduce((t, l) => t + l.total, 0);
              return { doc, supplier: String(ls[0].details || ''), currency: String(ls[0].currency || '$'), lines,
                paidQty: r2(paidQty), freeQty: r2(freeQty), paid: r2(paid), tradeDeal: paidQty > 0 && freeQty > 0,
                realCost: paidQty + freeQty > 0 ? r2(paid / (paidQty + freeQty)) : null };
            }) };
          } catch (e) { console.warn('cardex', c, e); }
        }));
      }
      codes.forEach(c => { if (!(c in costs)) costs[c] = null; });
      return json({ costs });
    }
    // A promotion's results (owner, 2026-10-06): units and sales per item over its dates, and over the same number
    // of days just before (the baseline). Up to 300 codes; periods within one year each.
    if (body.action === 'sales_compare') {
      const codes = [...new Set((Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean))].slice(0, 300);
      const okDate = (d: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
      const periods = { during: [body.from, body.to], before: [body.baseFrom, body.baseTo] } as Record<string, unknown[]>;
      if (!codes.length || !Object.values(periods).every(([a, b]) => okDate(a) && okDate(b) && String(a) <= String(b))) return json({ error: 'Bad dates or no codes.' }, 400);
      const key = (c: string) => c.replace(/^0+(?=\d)/, '').toUpperCase();
      const codeOf = new Map(codes.map(c => [key(c), c]));
      const out: Record<string, Record<string, { qty: number; sales: number }>> = {};
      codes.forEach(c => { out[c] = { during: { qty: 0, sales: 0 }, before: { qty: 0, sales: 0 } }; });
      // a period across two years: one report per year
      const pieces = (a: string, b: string) => a.slice(0, 4) === b.slice(0, 4) ? [[a, b]] : [[a, `${a.slice(0, 4)}-12-31`], [`${b.slice(0, 4)}-01-01`, b]];
      for (const [name, [a, b]] of Object.entries(periods)) {
        for (const [f, t] of pieces(String(a), String(b))) {
          for (let i = 0; i < codes.length; i += 100) {
            const d = await dash('/items_sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
              branches: [BRANCH], year: f.slice(0, 4), from_date: f, to_date: t, aggregation: 'Monthly', group_by: ['item'], item: codes.slice(i, i + 100) }) });
            const rows = (((d as Record<string, unknown>)?.data as Record<string, unknown>)?.branches as Record<string, Record<string, unknown>[]>)?.[BRANCH] || [];
            rows.forEach(r => { const c = codeOf.get(key(String(r.item ?? ''))); if (!c) return; out[c][name].qty += Number(r.total_quantity || 0); out[c][name].sales += Number(r.total_sales || 0); });
          }
        }
      }
      return json({ items: out });
    }
    if (body.action === 'item_search') {
      const q = String(body.search ?? '').trim();
      if (q.length < 2) return json({ items: [] });
      return json({ items: (await search(q, String(body.branch || BRANCH))).map(slim) });
    }
    if (body.action === 'items_stock') {
      const codes = (Array.isArray(body.codes) ? body.codes : []).map(c => String(c).trim()).filter(Boolean).slice(0, 300);
      const stock: Record<string, number | null> = {};
      const key = (c: string) => c.replace(/^0+(?=\d)/, '');
      for (let i = 0; i < codes.length; i += 6) {                 // a few at a time: light on their server
        await Promise.all(codes.slice(i, i + 6).map(async c => {
          try { const hit = (await search(c)).find(x => key(String(x.code)) === key(c)); stock[c] = hit ? (hit.available_quantity ?? null) : null; }
          catch { stock[c] = null; }
        }));
      }
      return json({ stock });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Something went wrong' }, 502);
  }
});
