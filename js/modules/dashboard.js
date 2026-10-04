/* ============================================================
   Dashboard (owner, 2026-10-04): the admin's view of the whole store,
   from A to Z, on one page. Admin only (roles.js canSee).
   "Needs attention" first (red = act now, amber = soon), then one
   card per part of the app with its key figures and a link to it:
   cash, cash count, sell-outs, promotions, credit notes, supplier
   orders, rentals, delivery, floor check, shelf labels, promo ladies,
   schedule, staff, app users, and the latest activity.
   Read only: every figure comes from the tables the pages already use.
   Each card loads on its own: one that fails says so, the rest show.
   Public API: window.Dashboard = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-dashboard');
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const lbp = v => Math.round(n(v)).toLocaleString('en-US');
  const usd = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const signed = (v, fmt) => Math.abs(n(v)) < 0.005 ? '0' : (n(v) < 0 ? '-' : '+') + fmt(Math.abs(n(v)));
  const tone = v => Math.abs(n(v)) < 0.005 ? '' : n(v) < 0 ? 'neg' : 'pos';
  const q = async p => { const { data, error } = await p; if (error) throw error; return data || []; };
  const qc = async p => { const { count, error } = await p; if (error) throw error; return count || 0; };
  const ago = iso => {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 2 ? 'now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };
  const S = { loading: false, at: null };

  const I = {
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    count: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
    sellout: '<rect x="3" y="4" width="18" height="4" rx="1"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1"/>',
    promo: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    credit: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 14h6"/>',
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
    map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    bike: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-8h5l3 8M10 9l-1-3H7"/>',
    check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    label: '<path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3"/><path d="M8 8v8M11 8v8M14 8v8M17 8v8"/>',
    lady: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14a5 5 0 0 1 5.5 5"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
    go: '<path d="M9 6l6 6-6 6"/>',
  };
  const svg = (k, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

  /* ---------------- loading: one function per part ---------------- */
  const today = () => todayStr();
  const monthOf = d => d.slice(0, 7);
  const firstOfMonth = d => monthOf(d) + '-01';
  const mondayOf = s => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('en-CA'); };
  const addMonths = (ym, k) => { const [y, m] = ym.split('-').map(Number), d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  async function loadCash() {
    const t = today(), yest = addDaysStr(t, -1), from = [firstOfMonth(t), yest].sort()[0];
    const [diffs, cashiers, months, settings] = await Promise.all([
      q(sb.from('cash_differences').select('cashier_id, day, amount, currency').gte('day', from).lte('day', t)),
      q(sb.from('cashiers').select('id, name, active')),
      q(sb.from('cash_months').select('month, locked')),
      q(sb.from('cash_settings').select('usd_rate, warning_threshold, danger_threshold').limit(1)),
    ]);
    const rate = n(settings[0]?.usd_rate) || 89500, danger = n(settings[0]?.danger_threshold);
    const name = id => cashiers.find(c => c.id === id)?.name || '(removed)';
    const eq = r => r.currency === 'USD' ? n(r.amount) * rate : n(r.amount);   // in LBP
    const month = diffs.filter(r => r.day >= firstOfMonth(t));
    const y = diffs.filter(r => r.day === yest);
    const per = {};
    month.forEach(r => { per[r.cashier_id] = (per[r.cashier_id] || 0) + eq(r); });
    const worst = Object.entries(per).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([id, v]) => ({ name: name(id), v }));
    const yPer = {};
    y.forEach(r => { yPer[r.cashier_id] = (yPer[r.cashier_id] || 0) + eq(r); });
    const bigY = Object.entries(yPer).filter(([, v]) => danger && v <= -danger).map(([id, v]) => ({ name: name(id), v }));
    const lastMonth = addMonths(monthOf(t), -1);
    const lastLocked = months.some(m => m.month === lastMonth && m.locked);
    return {
      rate, worst, bigY, lastMonth, lastLocked, dayOfMonth: Number(t.slice(8, 10)),
      monthNet: month.reduce((s, r) => s + eq(r), 0), monthShort: month.filter(r => n(r.amount) < 0).reduce((s, r) => s + eq(r), 0),
      yNet: y.reduce((s, r) => s + eq(r), 0), yEntries: new Set(y.map(r => r.cashier_id)).size,
      yShortCount: Object.values(yPer).filter(v => v < 0).length,
    };
  }

  async function loadCashCount() {
    if (!window.CashCount) return null;
    const t = today();
    const rows = await q(sb.from('cash_counts').select('*').gte('count_date', addDaysStr(t, -45)));
    const calc = CashCount._calc, list = rows.map(c => ({ c, r: calc(c) }));
    return {
      today: list.filter(x => x.c.count_date === t).length,
      notSigned: list.filter(x => !x.c.signed_at),
      notRec: list.filter(x => x.c.signed_at && !x.c.reconciled_at),
      missing: list.filter(x => x.c.reconciled_at && x.r.notFound.length),
      missingLbp: list.reduce((s, x) => s + (x.c.reconciled_at ? x.r.notFoundLbp : 0), 0),
      notSent: list.filter(x => x.c.reconciled_at && x.r.posted === null),
      resend: list.filter(x => x.r.needsResend),
      monthAfter: list.filter(x => x.c.count_date >= firstOfMonth(t) && x.c.reconciled_at).reduce((s, x) => s + x.r.afterMargin, 0),
    };
  }

  async function loadSellouts() {
    const t = today(), soon = addDaysStr(t, 7);
    const rows = await q(sb.from('sellouts').select('id, name, from, to, active, archived, online, supplier').eq('archived', false));
    const on = rows.filter(r => r.active);
    return {
      active: on.length, online: on.filter(r => r.online).length,
      ending: on.filter(r => r.to && r.to >= t && r.to <= soon).sort((a, b) => a.to.localeCompare(b.to)),
      endingToday: on.filter(r => r.to === t),
      overdue: on.filter(r => r.to && r.to < t),
      starting: rows.filter(r => r.from && r.from > t && r.from <= soon).length,
    };
  }

  async function loadPromotions() {
    const t = today();
    const rows = await q(sb.from('promotions').select('id, name, from_date, to_date, archived').eq('archived', false));
    return {
      running: rows.filter(r => (!r.from_date || r.from_date <= t) && (!r.to_date || r.to_date >= t)),
      upcoming: rows.filter(r => r.from_date && r.from_date > t).sort((a, b) => a.from_date.localeCompare(b.from_date)),
      ended: rows.filter(r => r.to_date && r.to_date < t),
    };
  }

  async function loadCredit() {
    const rows = await q(sb.from('credit_notes').select('status, supplier, created_at'));
    const issued = rows.filter(r => r.status !== 'signed');
    const old = issued.filter(r => r.created_at && Date.now() - new Date(r.created_at).getTime() > 30 * 864e5);
    return { total: rows.length, issued: issued.length, signed: rows.length - issued.length, old: old.length };
  }

  async function loadOrders() {
    const t = today();
    const rows = await q(sb.from('vendor_orders').select('vendor_name, order_date, expected_delivery, status').neq('status', 'delivered'));
    const pending = rows.filter(r => r.status === 'pending');
    return {
      pending: pending.length, notSent: rows.filter(r => r.status === 'not_sent'),
      dueToday: pending.filter(r => r.expected_delivery === t),
      late: pending.filter(r => r.expected_delivery && r.expected_delivery < t).sort((a, b) => a.expected_delivery.localeCompare(b.expected_delivery)),
    };
  }

  async function loadRentals() {
    const t = today(), soon = addDaysStr(t, 30);
    const rows = await q(sb.from('rental_contracts').select('id, spot_id, supplier, term, start_date, end_date, amount, billed, paid'));
    const active = rows.filter(r => (!r.start_date || r.start_date <= t) && (!r.end_date || r.end_date >= t));
    const yearly = rows.filter(r => r.term === 'yearly' && r.start_date && r.start_date <= t);
    return {
      active: active.length, yearlyValue: active.reduce((s, r) => s + (r.term === 'monthly' ? n(r.amount) * 12 : n(r.amount)), 0),
      ending: active.filter(r => r.end_date && r.end_date <= soon).sort((a, b) => a.end_date.localeCompare(b.end_date)),
      notBilled: yearly.filter(r => !r.billed), notPaid: yearly.filter(r => r.billed && !r.paid),
    };
  }

  async function loadDelivery() {
    const t = today();
    const [month, unpaid] = await Promise.all([
      q(sb.from('dt_orders').select('order_date, amount, paid, payment, platform').gte('order_date', firstOfMonth(t))),
      q(sb.from('dt_orders').select('order_date, amount, driver_id').eq('paid', false)),
    ]);
    const sum = l => l.reduce((s, r) => s + n(r.amount), 0);
    const td = month.filter(r => r.order_date === t), yd = month.filter(r => r.order_date === addDaysStr(t, -1));
    const oldUnpaid = unpaid.filter(r => r.order_date && r.order_date < addDaysStr(t, -2));
    return { today: td.length, todayAmt: sum(td), yesterday: yd.length, month: month.length, monthAmt: sum(month), unpaid: unpaid.length, unpaidAmt: sum(unpaid), oldUnpaid: oldUnpaid.length, oldUnpaidAmt: sum(oldUnpaid) };
  }

  async function loadFloor() {
    const [last, wrong, pending] = await Promise.all([
      q(sb.from('floor_checks').select('check_date, started_at, completed_at, summary').order('started_at', { ascending: false }).limit(1)),
      qc(sb.from('floor_check_items').select('id', { count: 'exact', head: true }).eq('status', 'wrong_price').eq('resolved', false)),
      qc(sb.from('floor_check_items').select('id', { count: 'exact', head: true }).eq('status', 'wrong_price').eq('resolved', false).is('label_sent_at', null)),
    ]);
    return { last: last[0] || null, wrong, noLabel: pending };
  }

  async function loadLabels() {
    const lists = await q(sb.from('label_lists').select('id, submitted_at, exported_at, created_by_name').not('submitted_at', 'is', null).is('exported_at', null));
    const items = lists.length ? await q(sb.from('label_items').select('list_id, qty').in('list_id', lists.map(l => l.id))) : [];
    const oldest = lists.map(l => l.submitted_at).sort()[0] || null;
    return { lists: lists.length, labels: items.reduce((s, i) => s + (n(i.qty) || 1), 0), oldest };
  }

  async function loadLadies() {
    const t = today();
    const [ladies, att] = await Promise.all([
      q(sb.from('promo_ladies').select('id, supplier, item, paid, start_date, end_date').lte('start_date', t).gte('end_date', t)),
      q(sb.from('promo_lady_attendance').select('promo_lady_id, came').eq('day', t)),
    ]);
    const marked = new Set(att.map(a => a.promo_lady_id));
    return { today: ladies, came: att.filter(a => a.came).length, absent: att.filter(a => a.came === false).length, notMarked: ladies.filter(l => !marked.has(l.id)).length };
  }

  async function loadSchedule() {
    const t = today(), mon = mondayOf(t), next = addDaysStr(mon, 7);
    const [weeks, reqs] = await Promise.all([
      q(sb.from('schedule_weeks').select('week_start, published, updated_at').in('week_start', [mon, next])),
      qc(sb.from('schedule_requests').select('cashier_id', { count: 'exact', head: true }).eq('week_start', next)),
    ]);
    const w = d => weeks.find(x => x.week_start === d);
    return { mon, next, thisPub: !!w(mon)?.published, nextPub: !!w(next)?.published, nextStarted: !!w(next), requests: reqs, dow: (new Date(t + 'T00:00:00').getDay() + 6) % 7 };
  }

  async function loadPeople() {
    const [staff, cashiers, profiles, subs, csubs] = await Promise.all([
      q(sb.from('staff').select('job, active, user_id, cashier_id')),
      q(sb.from('cashiers').select('id, name, active, has_pin, installed_at, last_seen_at')),
      q(sb.from('profiles').select('id, username, display_name, role, active, last_seen_at, installed_at')),
      q(sb.from('push_subscriptions').select('user_id')),
      q(sb.from('cashier_push_subscriptions').select('cashier_id')),
    ]);
    const act = staff.filter(s => s.active), jobs = {};
    act.forEach(s => { jobs[s.job || 'Other'] = (jobs[s.job || 'Other'] || 0) + 1; });
    const ac = cashiers.filter(c => c.active), notif = new Set(csubs.map(s => s.cashier_id)), unotif = new Set(subs.map(s => s.user_id));
    return {
      staff: act.length, jobs: Object.entries(jobs).sort((a, b) => b[1] - a[1]),
      cashiers: ac.length, noPin: ac.filter(c => !c.has_pin), installed: ac.filter(c => c.installed_at).length, notified: ac.filter(c => notif.has(c.id)).length,
      users: profiles.filter(p => p.active).map(p => ({ ...p, notif: unotif.has(p.id) })).sort((a, b) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))),
      online: profiles.filter(p => p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < 10 * 60000).length
        + cashiers.filter(c => c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 10 * 60000).length,
    };
  }

  async function loadActivity() {
    return q(sb.from('activity_log').select('at, username, module, summary').order('at', { ascending: false }).limit(14));
  }

  const PARTS = { cash: loadCash, cashcount: loadCashCount, sellouts: loadSellouts, promotions: loadPromotions, credit: loadCredit, orders: loadOrders,
    rentals: loadRentals, delivery: loadDelivery, floor: loadFloor, labels: loadLabels, ladies: loadLadies, schedule: loadSchedule, people: loadPeople, activity: loadActivity };

  /* ---------------- what needs attention ---------------- */
  function alerts(D) {
    const out = [], add = (level, text, tab) => out.push({ level, text, tab });
    const c = D.cash;
    if (c) {
      c.bigY.forEach(x => add('red', `${x.name} was short ${lbp(-x.v)} LBP yesterday`, 'cash'));
      if (!c.lastLocked && c.dayOfMonth >= 5) add('amber', `${monthName(c.lastMonth)} is not locked on the Cash page yet`, 'cash');
    }
    const k = D.cashcount;
    if (k) {
      if (k.missing.length) add('red', `${k.missing.length} cash count${k.missing.length === 1 ? ' has' : 's have'} missing card slips (${lbp(k.missingLbp)} LBP)`, 'cashcount');
      if (k.notRec.length) add('amber', `${k.notRec.length} signed cash count${k.notRec.length === 1 ? '' : 's'} not reconciled yet`, 'cashcount');
      if (k.notSigned.length) add('amber', `${k.notSigned.length} cash count${k.notSigned.length === 1 ? '' : 's'} not signed by the cashier`, 'cashcount');
      if (k.notSent.length) add('amber', `${k.notSent.length} reconciled count${k.notSent.length === 1 ? '' : 's'} not sent to the Cash page`, 'cashcount');
      if (k.resend.length) add('amber', `${k.resend.length} count${k.resend.length === 1 ? '' : 's'} changed since sent to the Cash page`, 'cashcount');
    }
    const s = D.sellouts;
    if (s) {
      if (s.overdue.length) add('red', `${s.overdue.length} sell-out${s.overdue.length === 1 ? ' is' : 's are'} past the end date and still active: ${s.overdue.slice(0, 3).map(x => x.name).join(', ')}`, 'sellouts');
      if (s.endingToday.length) add('amber', `Ending today: ${s.endingToday.map(x => x.name).join(', ')}`, 'sellouts');
    }
    const o = D.orders;
    if (o?.late.length) add('red', `${o.late.length} supplier order${o.late.length === 1 ? ' is' : 's are'} late: ${o.late.slice(0, 3).map(x => x.vendor_name).join(', ')}`, 'vendors');
    if (o?.notSent.length) add('amber', `${o.notSent.length} supplier order${o.notSent.length === 1 ? '' : 's'} not sent yet`, 'vendors');
    const r = D.rentals;
    if (r?.notPaid.length) add('amber', `${r.notPaid.length} yearly rental${r.notPaid.length === 1 ? '' : 's'} billed but not paid`, 'rentals');
    if (r?.notBilled.length) add('amber', `${r.notBilled.length} yearly rental${r.notBilled.length === 1 ? '' : 's'} not billed yet`, 'rentals');
    if (r?.ending.length) add('amber', `${r.ending.length} rental contract${r.ending.length === 1 ? ' ends' : 's end'} within 30 days`, 'rentals');
    const d = D.delivery;
    if (d?.oldUnpaid) add('red', `${d.oldUnpaid} delivery order${d.oldUnpaid === 1 ? '' : 's'} unpaid for more than 2 days ($${usd(d.oldUnpaidAmt)})`, 'delivery');
    const f = D.floor;
    if (f?.noLabel) add('amber', `${f.noLabel} wrong price${f.noLabel === 1 ? '' : 's'} on the floor without a label request`, 'floorcheck');
    if (f && (!f.last || Date.now() - new Date(f.last.started_at).getTime() > 7 * 864e5)) add('amber', `No floor check in the last 7 days`, 'floorcheck');
    const l = D.labels;
    if (l?.lists && l.oldest && Date.now() - new Date(l.oldest).getTime() > 864e5) add('amber', `Shelf labels waiting more than a day to be printed (${l.labels})`, 'labels');
    const pl = D.ladies;
    if (pl?.notMarked) add('amber', `${pl.notMarked} promo lad${pl.notMarked === 1 ? 'y' : 'ies'} booked today, attendance not marked`, 'promoladies');
    const sc = D.schedule;
    if (sc && !sc.thisPub) add('red', `This week's cashier schedule is not published`, 'schedule');
    if (sc && !sc.nextPub && sc.dow >= 3) add('amber', `Next week's cashier schedule is not published yet`, 'schedule');
    const p = D.people;
    if (p?.noPin.length) add('amber', `${p.noPin.length} active cashier${p.noPin.length === 1 ? ' has' : 's have'} no PIN: ${p.noPin.slice(0, 4).map(x => x.name).join(', ')}`, 'staff');
    const c2 = D.credit;
    if (c2?.old) add('amber', `${c2.old} credit note${c2.old === 1 ? '' : 's'} issued over 30 days ago, not signed`, 'creditnotes');
    return out.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1));
  }
  const monthName = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  /* ---------------- drawing ---------------- */
  const stat = (label, value, cls = '') => `<div class="db-stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  const line = (left, right = '', cls = '') => `<li class="${cls}"><span>${left}</span>${right !== '' && right != null ? `<b>${right}</b>` : ''}</li>`;
  const card = (key, tab, icon, title, body) => `<section class="card db-card" data-part="${key}">
      <header><span class="db-ic">${svg(icon)}</span><h3>${title}</h3>${tab && canSee(tab) ? `<button type="button" class="link-btn db-open" data-go="${tab}">Open ${svg('go', 'db-go')}</button>` : ''}</header>
      ${body}</section>`;
  const failed = key => `<p class="muted-note">Could not load this part.</p>`;

  function render(D, E) {
    const box = (k, fn) => E[k] ? failed(k) : D[k] === undefined ? '<p class="muted-note">Loading…</p>' : D[k] === null ? '<p class="muted-note">Not available.</p>' : fn(D[k]);
    const A = alerts(D);
    const reds = A.filter(a => a.level === 'red').length;
    panel.innerHTML = `
      <div class="db-top">
        <div class="db-date"><b>${esc(new Date(today() + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</b>
          <span class="muted-note">${S.at ? 'Updated ' + esc(fmtTs(S.at)) : ''}</span></div>
        <button type="button" class="btn secondary small" id="dbRefresh">${svg('refresh', 'db-btn-ic')} Refresh</button>
      </div>

      <section class="card db-alerts ${A.length ? '' : 'ok'}">
        <header><span class="db-ic">${svg('alert')}</span><h3>Needs attention</h3>
          <span class="db-count">${A.length ? `${reds ? `<span class="db-dot red"></span>${reds} urgent · ` : ''}${A.length} in all` : 'Nothing right now'}</span></header>
        ${A.length ? `<ul class="db-alist">${A.map(a => `<li class="${a.level}"><span class="db-dot ${a.level}"></span><span class="db-atext">${esc(a.text)}</span>${canSee(a.tab) ? `<button type="button" class="link-btn" data-go="${a.tab}">Open</button>` : ''}</li>`).join('')}</ul>`
          : '<p class="muted-note" style="margin:0;">Everything is in order.</p>'}
      </section>

      <div class="db-grid">
        ${card('cash', 'cash', 'cash', 'Cash differences', box('cash', c => `
          <div class="db-stats">${stat('Yesterday', `<span class="${tone(c.yNet)}">${signed(c.yNet, lbp)}</span>`)}${stat('This month', `<span class="${tone(c.monthNet)}">${signed(c.monthNet, lbp)}</span>`)}${stat('Shorts this month', `<span class="neg">${lbp(-c.monthShort)}</span>`)}</div>
          <p class="db-note">LBP, USD at ${lbp(c.rate)} · yesterday ${c.yEntries} cashier${c.yEntries === 1 ? '' : 's'} entered, ${c.yShortCount} short</p>
          ${c.worst.length ? `<h4>Most short this month</h4><ul class="db-list">${c.worst.map(w => line(esc(w.name), `<span class="neg">${signed(w.v, lbp)}</span>`)).join('')}</ul>` : ''}
          <p class="db-note">${esc(monthName(c.lastMonth))}: ${c.lastLocked ? 'locked' : 'not locked'}</p>`))}

        ${card('cashcount', 'cashcount', 'count', 'Cash count', box('cashcount', k => `
          <div class="db-stats">${stat('Counts today', k.today)}${stat('To reconcile', k.notRec.length, k.notRec.length ? 'warn' : '')}${stat('Missing slips', k.missing.length, k.missing.length ? 'bad' : '')}</div>
          <ul class="db-list">
            ${line('Not signed by the cashier', k.notSigned.length)}
            ${line('Reconciled, not sent to the Cash page', k.notSent.length)}
            ${line('Changed since sent', k.resend.length)}
            ${k.missingLbp ? line('Missing slips value', lbp(k.missingLbp) + ' LBP', 'neg') : ''}
            ${line('This month after the margin', `<span class="${tone(k.monthAfter)}">${signed(k.monthAfter, lbp)} LBP</span>`)}
          </ul>`))}

        ${card('sellouts', 'sellouts', 'sellout', 'Sell-outs', box('sellouts', s => `
          <div class="db-stats">${stat('Active', s.active)}${stat('Ending in 7 days', s.ending.length, s.ending.length ? 'warn' : '')}${stat('Past end, still active', s.overdue.length, s.overdue.length ? 'bad' : '')}</div>
          <p class="db-note">${s.online} online · ${s.starting} starting in the next 7 days</p>
          ${s.ending.length ? `<h4>Ending soon</h4><ul class="db-list">${s.ending.slice(0, 5).map(x => line(esc(x.name), esc(x.to === today() ? 'today' : fmtDate(x.to)), x.to === today() ? 'end-today' : '')).join('')}</ul>` : ''}`))}

        ${card('promotions', 'promotions', 'promo', 'Promotions', box('promotions', p => `
          <div class="db-stats">${stat('Running now', p.running.length)}${stat('Coming', p.upcoming.length)}${stat('Ended, not archived', p.ended.length, p.ended.length ? 'warn' : '')}</div>
          <ul class="db-list">${p.running.slice(0, 3).map(x => line(esc(x.name), x.to_date ? 'until ' + esc(fmtDate(x.to_date)) : '')).join('')}${p.upcoming.slice(0, 2).map(x => line(esc(x.name), 'from ' + esc(fmtDate(x.from_date)), 'muted')).join('')}</ul>`))}

        ${card('orders', 'vendors', 'truck', 'Supplier orders', box('orders', o => `
          <div class="db-stats">${stat('Waiting delivery', o.pending)}${stat('Due today', o.dueToday.length)}${stat('Late', o.late.length, o.late.length ? 'bad' : '')}</div>
          ${o.late.length ? `<h4>Late</h4><ul class="db-list">${o.late.slice(0, 5).map(x => line(esc(x.vendor_name), 'expected ' + esc(fmtDate(x.expected_delivery)), 'neg')).join('')}</ul>` : ''}
          ${o.notSent.length ? `<p class="db-note">${o.notSent.length} order${o.notSent.length === 1 ? '' : 's'} not sent yet</p>` : ''}`))}

        ${card('delivery', 'delivery', 'bike', 'Delivery', box('delivery', d => `
          <div class="db-stats">${stat('Orders today', d.today)}${stat('Today', '$' + usd(d.todayAmt))}${stat('Unpaid', d.unpaid, d.oldUnpaid ? 'bad' : '')}</div>
          <ul class="db-list">${line('Yesterday', d.yesterday + ' orders')}${line('This month', `${d.month} orders · $${usd(d.monthAmt)}`)}${line('Unpaid amount', '$' + usd(d.unpaidAmt))}</ul>`))}

        ${card('rentals', 'rentals', 'map', 'Rentals', box('rentals', r => `
          <div class="db-stats">${stat('Active contracts', r.active)}${stat('Ending in 30 days', r.ending.length, r.ending.length ? 'warn' : '')}${stat('Billed, unpaid', r.notPaid.length, r.notPaid.length ? 'warn' : '')}</div>
          <p class="db-note">Yearly value of the active contracts: ${lbp(r.yearlyValue)}</p>
          ${r.ending.length ? `<h4>Ending soon</h4><ul class="db-list">${r.ending.slice(0, 4).map(x => line(esc(x.supplier || x.spot_id), esc(fmtDate(x.end_date)))).join('')}</ul>` : ''}`))}

        ${card('credit', 'creditnotes', 'credit', 'Credit notes', box('credit', c => `
          <div class="db-stats">${stat('Issued, not signed', c.issued, c.old ? 'warn' : '')}${stat('Signed', c.signed)}${stat('Older than 30 days', c.old, c.old ? 'warn' : '')}</div>`))}

        ${card('floor', 'floorcheck', 'check', 'Floor check', box('floor', f => `
          <div class="db-stats">${stat('Wrong prices open', f.wrong, f.wrong ? 'bad' : '')}${stat('Without label request', f.noLabel, f.noLabel ? 'warn' : '')}</div>
          <p class="db-note">Last check: ${f.last ? esc(fmtTs(f.last.started_at)) + (f.last.completed_at ? ' · completed' : ' · not completed') : 'none yet'}</p>`))}

        ${card('labels', 'labels', 'label', 'Shelf labels', box('labels', l => `
          <div class="db-stats">${stat('Lists to print', l.lists, l.lists ? 'warn' : '')}${stat('Labels', l.labels)}</div>
          ${l.oldest ? `<p class="db-note">Oldest waiting since ${esc(fmtTs(l.oldest))}</p>` : '<p class="db-note">Nothing waiting.</p>'}`))}

        ${card('ladies', 'promoladies', 'lady', 'Promo ladies', box('ladies', p => `
          <div class="db-stats">${stat('Booked today', p.today.length)}${stat('Came', p.came)}${stat('Not marked', p.notMarked, p.notMarked ? 'warn' : '')}</div>
          <ul class="db-list">${p.today.slice(0, 4).map(x => line(esc(x.supplier || ''), esc(x.item || ''))).join('')}</ul>`))}

        ${card('schedule', 'schedule', 'calendar', 'Staff schedule', box('schedule', s => `
          <ul class="db-list">
            ${line('This week (' + esc(fmtDate(s.mon)) + ')', s.thisPub ? '<span class="db-ok">published</span>' : '<span class="neg">not published</span>')}
            ${line('Next week (' + esc(fmtDate(s.next)) + ')', s.nextPub ? '<span class="db-ok">published</span>' : s.nextStarted ? 'in progress' : 'not started')}
            ${line('Day-off requests for next week', s.requests)}
          </ul>`))}

        ${card('people', 'staff', 'people', 'Staff and app', box('people', p => `
          <div class="db-stats">${stat('Staff working', p.staff)}${stat('Cashiers', p.cashiers)}${stat('Online now', p.online)}</div>
          <ul class="db-list">
            ${line('Cashiers with the app installed', `${p.installed} / ${p.cashiers}`)}
            ${line('Cashiers with notifications on', `${p.notified} / ${p.cashiers}`)}
            ${line('Cashiers without a PIN', p.noPin.length, p.noPin.length ? 'neg' : '')}
          </ul>
          <h4>By job</h4><div class="db-chips">${p.jobs.map(([j, c]) => `<span>${esc(j)} <b>${c}</b></span>`).join('')}</div>`))}

        ${card('users', 'users', 'phone', 'App users', box('people', p => `
          <ul class="db-list">${p.users.map(u => line(`${esc(u.display_name || u.username)} <span class="muted-note">${esc(u.role || '')}${u.installed_at ? ' · app' : ''}${u.notif ? ' · notifications' : ''}</span>`, esc(ago(u.last_seen_at)))).join('')}</ul>`))}

        ${card('activity', 'activity', 'clock', 'Latest activity', box('activity', a => a.length ? `
          <ul class="db-feed">${a.map(x => `<li><span class="db-when">${esc(ago(x.at))}</span><span><b>${esc(x.username || '')}</b> ${esc(x.summary || x.module || '')}</span></li>`).join('')}</ul>` : '<p class="muted-note">No activity yet.</p>'))}
      </div>`;
    el('dbRefresh').onclick = () => load(true);
    panel.querySelectorAll('[data-go]').forEach(b => b.onclick = () => switchTab(b.dataset.go));
  }
  const el = id => document.getElementById(id);

  async function load(manual) {
    if (S.loading) return;
    S.loading = true;
    const D = {}, E = {};
    if (!panel.innerHTML) render(D, E);
    if (manual) el('dbRefresh')?.setAttribute('disabled', '');
    await Promise.all(Object.entries(PARTS).map(async ([k, fn]) => {
      try { D[k] = await fn(); } catch (e) { console.error('dashboard ' + k, e); E[k] = true; }
    }));
    S.at = new Date().toISOString(); S.loading = false;
    render(D, E);
  }
  async function show() {
    if (!isAdmin()) return;
    await load(false);
  }
  window.Dashboard = { show };
})();
