/* ============================================================
   Performance › Store profit (owner, 2026-10-12; migration 090). Admin only.
   Month by month: sales, gross profit on the items with a cost (lv-dashboard month_profit: item by item, as Performance
   does a supplier), the store's expenses typed here (salaries, electricity, generator…, in $ or LBP), the rent from the
   suppliers (rental contracts, each month its share), and the net profit. Apart, never guessed: the butchery (its sales
   and the meat bought that month), what is booked without items in the system (by supplier: say what it is), the sales
   of items with no purchase in 4 months.
   Public API: window.StoreProfit = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const el = id => document.getElementById(id);
  const usd = v => (n(v) < 0 ? '-$' : '$') + Math.abs(Math.round(n(v))).toLocaleString('en-US');
  const pct = v => v === null || !Number.isFinite(v) ? '—' : (Math.round(v * 1000) / 10).toLocaleString('en-US') + '%';
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const CATS = ['Salaries', 'Electricity', 'Generator / fuel', 'Rent', 'Water', 'Internet & phone', 'Delivery', 'Maintenance', 'Supplies & packaging', 'Taxes & fees', 'Bank charges', 'Marketing', 'Other'];
  const ICON = {
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
    redo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  };
  const S = { year: null, months: new Map(), exp: [], contracts: [], rate: 89500, open: null, busy: new Set(), editing: null };
  const curYm = () => todayStr().slice(0, 7);
  const ymOf = d => String(d).slice(0, 7);
  const daysIn = ym => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0).getDate();
  const D = s => new Date(s + 'T00:00:00Z');
  const span = (a, b) => Math.round((D(b) - D(a)) / 864e5) + 1;
  const expUsd = e => e.currency === 'LBP' ? n(e.amount) / (n(e.rate) || S.rate) : n(e.amount);
  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
    return data;
  }
  // the rent from the suppliers in a month: each contract's share of its own dates (a monthly one: its days in that month)
  function rentOf(ym) {
    const a = ym + '-01', b = ym + '-' + String(daysIn(ym)).padStart(2, '0');
    return S.contracts.reduce((t, c) => {
      if (!c.start_date || !c.end_date || c.term === 'temporary') return t;
      const s = c.start_date > a ? c.start_date : a, e = c.end_date < b ? c.end_date : b; if (e < s) return t;
      const o = span(s, e), amt = n(c.amount);
      return t + (c.term === 'monthly' ? amt * o / daysIn(ym) : amt * o / Math.max(1, span(c.start_date, c.end_date)));
    }, 0);
  }
  async function load() {
    const y = S.year;
    const [m, e, c, r] = await Promise.all([
      sb.from('store_months').select('*').gte('month', `${y}-01-01`).lte('month', `${y}-12-01`),
      sb.from('store_expenses').select('*').gte('month', `${y}-01-01`).lte('month', `${y}-12-01`).order('created_at'),
      sb.from('rental_contracts').select('term, start_date, end_date, amount'),
      sb.rpc('get_usd_rate'),
    ]);
    if (m.error) throw new Error(/store_months/.test(m.error.message) ? 'Store profit is not set up yet (migration 090).' : m.error.message);
    S.months = new Map((m.data || []).map(x => [ymOf(x.month), x]));
    S.exp = e.data || []; S.contracts = c.data || [];
    if (Number(r.data) > 0) S.rate = Number(r.data);
  }
  async function compute(ym, quiet) {
    if (S.busy.has(ym)) return; S.busy.add(ym); paint();
    try { const d = await call({ action: 'month_profit', month: ym }); S.months.set(ym, { ...d, month: d.month }); }
    catch (e) { if (!quiet) showToast(`${MON[Number(ym.slice(5)) - 1]}: ${e.message}`, true); }
    finally { S.busy.delete(ym); paint(); }
  }
  async function show(box) {
    if (!box) return;
    S.box = box;
    if (!isAdmin()) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Admin only.</p></div>'; return; }
    if (!S.year) S.year = Number(todayStr().slice(0, 4));
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the months…</p></div>';
    try { await load(); } catch (e) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(e.message)}</p></div>`; return; }
    paint();
    // the months of the year not made yet (one at a time, the newest first), and the month running made again
    const months = monthsOf(S.year);
    const todo = months.filter(ym => !S.months.has(ym) || ym === curYm()).reverse();
    for (const ym of todo) await compute(ym, true);
  }
  const monthsOf = y => { const last = y < Number(todayStr().slice(0, 4)) ? 12 : Number(todayStr().slice(5, 7)); return Array.from({ length: last }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`); };
  function figures(ym) {
    const m = S.months.get(ym), exp = S.exp.filter(e => ymOf(e.month) === ym), expenses = exp.reduce((t, e) => t + expUsd(e), 0), rent = rentOf(ym);
    if (!m) return { m: null, exp, expenses, rent };
    const net = n(m.gross) - expenses + rent;
    return { m, exp, expenses, rent, net, margin: n(m.costed_sales) > 0 ? n(m.gross) / n(m.costed_sales) : null };
  }
  function paint() {
    const box = S.box; if (!box) return;
    const months = monthsOf(S.year);
    const rows = months.map(ym => ({ ym, ...figures(ym) }));
    const tot = rows.reduce((t, r) => { if (!r.m) return t; t.sales += n(r.m.sales); t.gross += n(r.m.gross); t.exp += r.expenses; t.rent += r.rent; t.net += r.net; return t; }, { sales: 0, gross: 0, exp: 0, rent: 0, net: 0 });
    const y0 = Number(todayStr().slice(0, 4));
    box.innerHTML = `<div class="card pf-controls">
        <button type="button" class="icon-btn" data-sp="prev" title="Year before" aria-label="Year before"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <b>${S.year}</b>
        <button type="button" class="icon-btn" data-sp="next" title="Year after" aria-label="Year after" ${S.year >= y0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span class="muted-note">USD rate for LBP expenses: ${S.rate.toLocaleString('en-US')}</span></div>
      <div class="pf-tiles">
        <div class="pf-tile"><span>Sales ${S.year}</span><b>${usd(tot.sales)}</b></div>
        <div class="pf-tile"><span>Gross profit</span><b>${usd(tot.gross)}</b><small>items with a cost</small></div>
        <div class="pf-tile"><span>Expenses</span><b>${usd(tot.exp)}</b><small>+ rent from suppliers ${usd(tot.rent)}</small></div>
        <div class="pf-tile"><span>Net profit</span><b class="${tot.net < 0 ? 'pf-neg' : 'pf-up'}">${usd(tot.net)}</b><small>without the butchery and what is booked without items</small></div>
      </div>
      <div class="card"><div class="items-scroll pf-scroll"><table class="items pf-table sp-table"><thead><tr>
        <th>Month</th><th class="num">Sales</th><th class="num">Gross profit</th><th class="num">Margin</th><th class="num">Expenses</th><th class="num">Rent from suppliers</th><th class="num">Net profit</th><th class="num">Butchery sales / meat bought</th><th class="num">Booked without items</th><th></th></tr></thead>
        <tbody>${rows.slice().reverse().map(r => { const busy = S.busy.has(r.ym), name = MON[Number(r.ym.slice(5)) - 1] + (r.ym === curYm() ? ' (so far)' : '');
          if (!r.m) return `<tr><td><b>${esc(name)}</b></td><td colspan="8" class="muted-note">${busy ? 'reading from the system…' : 'not made yet'}</td><td>${busy ? '' : `<button type="button" class="icon-btn" data-sp-make="${r.ym}" title="Make it" aria-label="Make it">${ICON.redo}</button>`}</td></tr>`;
          const b = (r.m.by_section || {}).butchery || {}, ex = n((r.m.by_section || {}).extras);
          return `<tr class="pf-row" data-sp-open="${r.ym}" title="Open the month (its expenses)">
            <td><b>${esc(name)}</b></td><td class="num">${usd(r.m.sales)}</td><td class="num">${usd(r.m.gross)}</td><td class="num">${pct(r.margin)}</td>
            <td class="num">${r.exp.length ? usd(r.expenses) : '<span class="muted-note">none typed</span>'}</td><td class="num">${usd(r.rent)}</td>
            <td class="num"><b class="${r.net < 0 ? 'pf-neg' : ''}">${usd(r.net)}</b></td>
            <td class="num">${usd(b.sales)} <span class="muted-note">/ ${usd(b.bought)}</span></td>
            <td class="num ${Math.abs(ex) >= 5000 ? 'sp-warn' : ''}">${usd(ex)}</td>
            <td>${busy ? '<span class="muted-note">…</span>' : `<button type="button" class="icon-btn" data-sp-make="${r.ym}" title="Make it again from the system" aria-label="Make it again">${ICON.redo}</button>`}</td></tr>
            ${S.open === r.ym ? `<tr class="sp-detail"><td colspan="10">${detailHtml(r)}</td></tr>` : ''}`; }).join('')}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Gross profit = the sales of the items with a cost - their units x unit cost (that month's purchases, else the 3 months before), as Performance does a supplier; amounts in $ as the system reports them (VAT included on both sides). Net profit = gross profit - the expenses typed here + the rent from the suppliers (each contract's share of the month). The butchery and what is booked without items are shown apart, not counted: open a month to see them.</p></div>`;
    wire();
  }
  function detailHtml(r) {
    const m = r.m, det = m.by_section || {}, b = det.butchery || {};
    const expRows = r.exp.map(e => S.editing === e.id ? expForm(e) : `<tr><td>${esc(e.category)}</td><td>${esc(e.label || '')}</td><td class="num">${e.currency === 'LBP' ? Math.round(n(e.amount)).toLocaleString('en-US') + ' LBP' : usd(e.amount)}</td><td class="num">${usd(expUsd(e))}</td>
      <td class="sp-act"><button type="button" class="vb-ico" data-sp-edit="${e.id}" data-tip="Edit" aria-label="Edit">${ICON.edit}</button><button type="button" class="vb-ico vb-x" data-sp-del="${e.id}" data-tip="Delete" aria-label="Delete">${ICON.del}</button></td></tr>`).join('');
    return `<div class="sp-grid">
      <div><h4>Expenses of ${esc(MON[Number(r.ym.slice(5)) - 1])}</h4>
        <table class="items sp-exp"><thead><tr><th>Category</th><th>Detail</th><th class="num">Amount</th><th class="num">In $</th><th></th></tr></thead>
          <tbody>${expRows}${S.editing === 'new' ? expForm(null) : ''}</tbody></table>
        ${S.editing !== 'new' ? `<button type="button" class="btn small" data-sp="add" style="margin-top:6px;">Add an expense</button>` : ''}
        <p class="muted-note">In all: <b>${usd(r.expenses)}</b></p></div>
      <div><h4>From the system</h4><dl class="sp-kv">
        <dt>Sales</dt><dd>${usd(m.sales)}</dd>
        <dt>Items with a cost</dt><dd>${usd(m.costed_sales)} → gross profit <b>${usd(m.gross)}</b> (${pct(r.margin)})</dd>
        <dt>Without a cost</dt><dd>${usd(m.uncosted_sales)} <span class="muted-note">(${n(m.uncosted_items).toLocaleString('en-US')} items not bought in 4 months: not counted)</span></dd>
        <dt>Butchery</dt><dd>sales ${usd(b.sales)} · meat bought ${usd(b.bought)} <span class="muted-note">(meat section ${usd(b.meatSection)} + "VIANDE" ${usd(b.viande)}: the cuts are never bought under their own codes; not counted)</span></dd>
        <dt>Rent from suppliers</dt><dd>${usd(r.rent)}</dd></dl>
        ${(det.extraBy || []).length ? `<h4>Booked without items (${usd(det.extras)}): what are they?</h4><ul class="sp-list">${det.extraBy.map(x => `<li><span>${esc(x.label)}</span><b>${usd(x.amount)}</b></li>`).join('')}</ul>
          <p class="muted-note">Lines of the transitory items in the system: fees, charges, or a whole invoice on one line. Not counted in the profit until we know what they are.</p>` : ''}
        <p class="muted-note">Made ${esc(new Date(m.computed_at).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', dateStyle: 'medium', timeStyle: 'short' }))}.</p></div></div>`;
  }
  function expForm(e) {
    return `<tr class="sp-form"><td><select id="spCat">${CATS.map(c => `<option ${e && e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
      <td><input type="text" id="spLabel" value="${esc(e?.label || '')}" placeholder="Detail (optional)"></td>
      <td class="num"><input type="text" id="spAmt" inputmode="decimal" value="${e ? esc(e.amount) : ''}" placeholder="Amount" style="width:110px"> <select id="spCur"><option ${!e || e.currency === 'USD' ? 'selected' : ''}>USD</option><option ${e && e.currency === 'LBP' ? 'selected' : ''}>LBP</option></select></td>
      <td class="num"><input type="text" id="spRate" inputmode="decimal" value="${esc(e?.rate || S.rate)}" title="LBP for 1 USD (for an amount in LBP)" style="width:90px"></td>
      <td class="sp-act"><button type="button" class="btn small" data-sp="save" data-id="${e ? e.id : ''}">Save</button><button type="button" class="btn ghost small" data-sp="cancel">Cancel</button></td></tr>`;
  }
  function wire() {
    const box = S.box;
    box.onclick = async ev => {
      const t = ev.target.closest('[data-sp], [data-sp-open], [data-sp-make], [data-sp-edit], [data-sp-del]'); if (!t) return;
      if (t.dataset.spMake) { ev.stopPropagation(); return compute(t.dataset.spMake); }
      if (t.dataset.spEdit) { S.editing = t.dataset.spEdit; return paint(); }
      if (t.dataset.spDel) {
        const e = S.exp.find(x => x.id === t.dataset.spDel); if (!e) return;
        if (!(await showConfirm(`Delete ${e.category}${e.label ? ' (' + e.label + ')' : ''}?`, 'Delete'))) return;
        const { error } = await sb.from('store_expenses').delete().eq('id', e.id);
        if (error) return showToast(error.message, true);
        S.exp = S.exp.filter(x => x.id !== e.id); return paint();
      }
      const a = t.dataset.sp;
      if (a === 'prev' || a === 'next') { S.year += a === 'prev' ? -1 : 1; S.open = null; return show(box); }
      if (a === 'add') { S.editing = 'new'; return paint(); }
      if (a === 'cancel') { S.editing = null; return paint(); }
      if (a === 'save') {
        const amt = Number(String(el('spAmt').value).replace(/,/g, '')), cur = el('spCur').value, rate = Number(String(el('spRate').value).replace(/,/g, ''));
        if (!Number.isFinite(amt) || !amt) return showToast('Type the amount.', true);
        if (cur === 'LBP' && !(rate > 0)) return showToast('Type the USD rate.', true);
        const rec = { month: S.open + '-01', category: el('spCat').value, label: el('spLabel').value.trim() || null, amount: amt, currency: cur, rate: cur === 'LBP' ? rate : null, updated_at: new Date().toISOString() };
        const q = t.dataset.id ? sb.from('store_expenses').update(rec).eq('id', t.dataset.id).select().single() : sb.from('store_expenses').insert(rec).select().single();
        const { data, error } = await q;
        if (error) return showToast(error.message, true);
        S.exp = S.exp.filter(x => x.id !== data.id).concat(data); S.editing = null; return paint();
      }
      if (t.dataset.spOpen && !ev.target.closest('.sp-detail')) { S.open = S.open === t.dataset.spOpen ? null : t.dataset.spOpen; S.editing = null; return paint(); }
    };
  }
  window.StoreProfit = { show };
})();
