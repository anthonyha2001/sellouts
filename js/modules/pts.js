/* ============================================================
   Returns to suppliers — PTs (owner, 2026-10-13): a dedicated page listing every PT (return to a supplier) with a status the
   owner sets: Taken / Compensated / Traded / Owner. The PTs are kept in public.pts (migration 095, synced every 30 min by
   lv-dashboard pts_sync, which does not touch the status). Reads the table (instant); the status change is saved at once.
   Filters by status, supplier and date, search, totals, Excel; double-click a PT for its lines (pt_detail). Permission:
   vendors.manage. Public API: window.PTs = { show }.
   2026-10-20 (owner): each PT's reference (migration 097, read from the PT document; the missing ones are asked for in the
   background), a By supplier view (each supplier's total returned) and a supplier's detailed page (totals, status, months,
   its PTs, the items it was returned).
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const isL = c => /LBP|L\.?L/i.test(String(c || ''));
  const money = (v, c) => (isL(c) ? Math.round(Math.abs(n(v))).toLocaleString('en-US') + ' LBP' : '$' + (Math.round(Math.abs(n(v)) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const qty = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US');
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = k => { const [y, m] = k.split('-'); return `${MONTHS[Number(m) - 1] || m} ${y}`; };
  const STATUS = [['taken', 'Taken'], ['compensated', 'Compensated'], ['traded', 'Traded'], ['owner', 'Owner']];
  const SLABEL = Object.fromEntries(STATUS);
  const onPhone = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
  const S = { rows: null, err: '', days: onPhone ? 7 : 30, q: '', status: 'all', newOnly: false, sup: '', sort: 'pt_date', dir: -1, view: 'pts', ssort: 'usd', sdir: -1, detail: '',
    refs: { busy: false, rounds: 0 }, lines: {}, items: { key: '', busy: false, done: 0, of: 0 } };
  const supOf = r => r.supplier_name || r.supplier_code || 'No supplier';
  // "New": came in from the system in the last 24 hours (the green badge)
  const isNew = r => r.first_seen && Date.now() - new Date(r.first_seen).getTime() < 864e5;
  // the two currencies apart: "$1,240.00 + 3,500,000 LBP"
  const both = (usd, lbp) => [usd || !lbp ? money(usd, '$') : '', lbp ? money(lbp, 'LBP') : ''].filter(Boolean).join(' + ');

  async function call(body) { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.'); return data; }
  async function load() {
    S.err = '';
    const from = addDaysStr(todayStr(), -(S.days - 1));
    let qy = sb.from('pts').select('*').order('pt_date', { ascending: false }).limit(5000);
    if (S.days !== 0) qy = qy.gte('pt_date', from);
    const { data, error } = await qy;
    if (error) { S.err = /pts\b|relation/.test(error.message) ? 'The returns tracker is not set up yet (migration 095).' : (error.message || 'Could not read the returns.'); S.rows = []; return; }
    S.rows = data || [];
    fillRefs();
  }
  // the PTs whose reference was never read (refs null; the column missing = migration 097 not run: nothing asked)
  async function fillRefs() {
    if (S.refs.busy || S.refs.rounds >= 6) return;
    if (!(S.rows || []).some(r => 'refs' in r && r.refs === null)) return;
    S.refs.busy = true; paintRefNote();
    try {
      const d = await call({ action: 'pts_refs', limit: 40 });
      S.refs.rounds++;
      const { data } = await sb.from('pts').select('pt, year, refs').in('pt', (S.rows || []).filter(r => r.refs === null).map(r => r.pt).slice(0, 300));
      (data || []).forEach(x => { const r = (S.rows || []).find(y => y.pt === x.pt && y.year === x.year); if (r) r.refs = x.refs; });
      S.refs.busy = false;
      if (el('panel-pts') && !el('panel-pts').querySelector('input:focus')) paint();
      if (d.read > 0 && d.left > 0) fillRefs();
    } catch (e) { S.refs.busy = false; S.refs.rounds = 99; paintRefNote(); }
  }
  function paintRefNote() { const x = el('ptsRefNote'); if (x) x.textContent = S.refs.busy ? 'Reading the references…' : ''; }

  const matches = r => {
    const q = S.q.trim().toLowerCase();
    return (S.status === 'all' || (S.status === 'none' ? !r.status : r.status === S.status))
      && (!S.newOnly || isNew(r))
      && (!q || [r.pt, r.supplier_name, r.refs, r.note].some(v => String(v || '').toLowerCase().includes(q)));
  };
  const shown = () => (S.rows || []).filter(r => matches(r) && (!S.sup || supOf(r) === S.sup));

  async function show() {
    const box = el('panel-pts'); if (!box) return;
    if (!S.rows) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the returns…</p></div>'; await load(); }
    paint();
  }
  const RANGES = [[7, 'This week'], [30, '30 days'], [90, '90 days'], [365, '12 months'], [0, 'All']];
  const ICON = {
    reload: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    xls: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  };
  function paint() {
    const box = el('panel-pts'); if (!box) return;
    if (S.err) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const base = (S.rows || []).filter(r => !S.sup || supOf(r) === S.sup);
    const cnt = st => base.filter(r => st === 'all' ? true : st === 'none' ? !r.status : r.status === st).length;
    const sups = [...new Set((S.rows || []).map(supOf))].sort();
    box.innerHTML = `
      <div class="card pts-bar">
        <div class="filter-row" style="margin:0;">${[['pts', 'PTs'], ['sups', 'By supplier']].map(([k, l]) => `<button type="button" data-pts-view="${k}" class="${(S.detail ? 'sups' : S.view) === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="filter-row" style="margin:0;">${RANGES.map(([d, l]) => `<button type="button" data-pts-days="${d}" class="${S.days === d ? 'active' : ''}">${l}</button>`).join('')}</div>
        <input type="search" id="ptsQ" placeholder="Find a PT, reference or supplier" value="${esc(S.q)}" aria-label="Find">
        ${S.view === 'pts' && !S.detail ? `<select id="ptsSup" aria-label="Supplier"><option value="">All suppliers</option>${sups.map(s => `<option value="${esc(s)}" ${s === S.sup ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
        <span style="flex:1"></span>
        <span class="muted-note" id="ptsRefNote">${S.refs.busy ? 'Reading the references…' : ''}</span>
        <button type="button" class="icon-btn" id="ptsReload" title="Read again" aria-label="Read again">${ICON.reload}</button>
        <button type="button" class="icon-btn" id="ptsXls" title="Download (Excel)" aria-label="Download (Excel)">${ICON.xls}</button>
      </div>
      <div class="filter-row pts-status" style="margin:0 0 12px;">
        <button type="button" data-pts-status="all" class="${S.status === 'all' ? 'active' : ''}">All <span class="muted-note">${cnt('all')}</span></button>
        <button type="button" data-pts-status="none" class="${S.status === 'none' ? 'active' : ''}">Not set <span class="muted-note">${cnt('none')}</span></button>
        ${STATUS.map(([k2, l]) => `<button type="button" data-pts-status="${k2}" class="${S.status === k2 ? 'active' : ''}">${l} <span class="muted-note">${cnt(k2)}</span></button>`).join('')}
        <span style="flex:1"></span>
        <button type="button" id="ptsNew" class="pts-newbtn ${S.newOnly ? 'active' : ''}" title="Only the returns that came in the last 24 hours">New <span class="muted-note">${base.filter(isNew).length}</span></button>
      </div>
      ${S.detail ? detailHtml() : S.view === 'sups' ? supsHtml() : ptsHtml(shown(), true)}`;
    bind(box);
  }

  /* ---------- the PTs list ---------- */
  function sortPts(list) {
    const k = S.sort;
    return list.sort((a, b) => (k === 'supplier_name' || k === 'pt' || k === 'refs' ? S.dir * String(a[k] || '').localeCompare(String(b[k] || ''))
      : k === 'pt_date' ? S.dir * String(a.pt_date || '').localeCompare(String(b.pt_date || ''))
      : S.dir * (Math.abs(n(a[k])) - Math.abs(n(b[k])))) || String(b.pt_date).localeCompare(String(a.pt_date)));
  }
  function ptsHtml(list, withSupplier) {
    sortPts(list);
    const usd = list.filter(r => !isL(r.currency)).reduce((t, r) => t + Math.abs(n(r.value)), 0), lbp = list.filter(r => isL(r.currency)).reduce((t, r) => t + Math.abs(n(r.value)), 0);
    const sortIc = key => key === S.sort ? (S.dir < 0 ? ' ▾' : ' ▴') : '';
    const th = (key, label, num = true) => `<th class="${num ? 'num ' : ''}pts-sort" data-pts-sort="${key}">${label}${sortIc(key)}</th>`;
    const cols = withSupplier ? 9 : 8;
    return `<div class="card">
        <div class="pf-head"><h3>Returns ${S.sup && withSupplier ? '· ' + esc(S.sup) : ''}</h3><span class="muted-note">${list.length} PT${list.length === 1 ? '' : 's'} · ${both(usd, lbp)}</span></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table pts-tbl pts-cards"><thead><tr>
          ${th('pt', 'PT', false)}${th('pt_date', 'Date')}${withSupplier ? th('supplier_name', 'Supplier', false) : ''}${th('refs', 'Reference', false)}${th('lines', 'Lines')}${th('qty', 'Units')}${th('value', 'Value')}<th>Status</th><th>Note</th></tr></thead>
          <tbody>${list.map(r => rowHtml(r, withSupplier)).join('') || `<tr><td colspan="${cols}" class="empty-note">No PT in this period.</td></tr>`}</tbody>
          ${list.length > 1 ? `<tfoot><tr class="pts-tot"><td colspan="${withSupplier ? 4 : 3}"><b>Total</b></td><td class="num">${list.reduce((t, r) => t + n(r.lines), 0)}</td><td class="num">${qty(list.reduce((t, r) => t + Math.abs(n(r.qty)), 0))}</td><td class="num"><b>${both(usd, lbp)}</b></td><td colspan="2"></td></tr></tfoot>` : ''}</table></div>
        <p class="muted-note" style="margin:8px 0 0;">Every return to a supplier, synced from the system every 30 minutes. Set each one's status; double-click a PT for its lines${withSupplier ? ', click a supplier for its returns page' : ''}. Value is the money returned.</p>
      </div>`;
  }
  function rowHtml(r, withSupplier = true) {
    const ref = r.refs === null || r.refs === undefined ? `<span class="muted-note">${'refs' in r ? '…' : ''}</span>` : r.refs ? `<span class="pts-ref">${esc(r.refs)}</span>` : '<span class="muted-note">—</span>';
    return `<tr data-pt="${esc(r.pt)}" data-year="${esc(r.year)}" class="${r.status ? 'pts-done' : ''}" title="Double-click for its lines">
      <td class="mono"><b>${esc(r.pt)}</b>${isNew(r) ? ' <span class="pts-new" title="Came in from the system in the last 24 hours">New</span>' : ''}
        <button type="button" class="pts-hist" data-pts-hist="${esc(r.pt)}" data-pts-year="${esc(r.year)}" title="Who changed this, and when"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></button></td><td data-label="Date">${esc(dmy(r.pt_date))}</td>
      ${withSupplier ? `<td data-label="Supplier"><button type="button" class="link-btn pts-suplink" data-pts-open="${esc(supOf(r))}">${esc(supOf(r))}</button></td>` : ''}
      <td data-label="Reference">${ref}</td><td class="num" data-label="Lines">${r.lines ?? ''}</td><td class="num" data-label="Units">${qty(Math.abs(n(r.qty)))}</td><td class="num" data-label="Value"><b class="pts-cardval">${money(r.value, r.currency)}</b></td>
      <td data-label="Status"><select class="pts-sel k-${r.status || 'none'}" data-pts-set="${esc(r.pt)}" data-pts-year="${esc(r.year)}" aria-label="Status"><option value="">Not set</option>${STATUS.map(([k, l]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${r.status_by_name ? `<div class="pts-sub" title="Last changed${r.status_at ? ' on ' + esc(dmy(r.status_at)) + ' ' + new Date(r.status_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}">${esc(r.status_by_name)}${r.status_at ? ' · ' + esc(dmy(r.status_at)) : ''}</div>` : ''}</td>
      <td data-label="Note"><input type="text" class="pts-note" data-pts-note="${esc(r.pt)}" data-pts-year="${esc(r.year)}" value="${esc(r.note || '')}" placeholder="Add a note…" aria-label="Note"></td></tr>`;
  }

  /* ---------- by supplier: each supplier's total returned ---------- */
  function supAgg(list) {
    const m = new Map();
    list.forEach(r => {
      const k = supOf(r), v = Math.abs(n(r.value)), l = isL(r.currency);
      const x = m.get(k) || { name: k, code: r.supplier_code || '', pts: 0, lines: 0, qty: 0, usd: 0, lbp: 0, open: 0, openUsd: 0, openLbp: 0, last: '' };
      x.pts++; x.lines += n(r.lines); x.qty += Math.abs(n(r.qty));
      if (l) x.lbp += v; else x.usd += v;
      if (!r.status) { x.open++; if (l) x.openLbp += v; else x.openUsd += v; }
      if (String(r.pt_date || '') > x.last) x.last = String(r.pt_date || '');
      m.set(k, x);
    });
    return [...m.values()];
  }
  function supsHtml() {
    const all = (S.rows || []).filter(matches), list = supAgg(all);
    const k = S.ssort;
    list.sort((a, b) => (k === 'name' ? S.sdir * a.name.localeCompare(b.name) : k === 'last' ? S.sdir * a.last.localeCompare(b.last) : S.sdir * (n(a[k]) - n(b[k]))) || b.usd - a.usd);
    const T = list.reduce((t, x) => { ['pts', 'lines', 'qty', 'usd', 'lbp', 'open', 'openUsd', 'openLbp'].forEach(f => { t[f] += x[f]; }); return t; }, { pts: 0, lines: 0, qty: 0, usd: 0, lbp: 0, open: 0, openUsd: 0, openLbp: 0 });
    const anyL = T.lbp > 0;
    const sortIc = key => key === S.ssort ? (S.sdir < 0 ? ' ▾' : ' ▴') : '';
    const th = (key, label, num = true) => `<th class="${num ? 'num ' : ''}pts-sort" data-pts-ssort="${key}">${label}${sortIc(key)}</th>`;
    const share = v => T.usd > 0 ? Math.round(v / T.usd * 1000) / 10 : 0;
    return `<div class="card">
      <div class="pf-head"><h3>Returns by supplier</h3><span class="muted-note">${list.length} supplier${list.length === 1 ? '' : 's'} · ${T.pts} PT${T.pts === 1 ? '' : 's'} · ${both(T.usd, T.lbp)}</span></div>
      <div class="items-scroll pf-scroll"><table class="items pf-table pts-tbl pts-sups"><thead><tr>
        ${th('name', 'Supplier', false)}${th('pts', 'PTs')}${th('lines', 'Lines')}${th('qty', 'Units')}${th('usd', 'Total $')}${anyL ? th('lbp', 'Total LBP') : ''}<th class="num">Share</th>${th('open', 'Not set')}${th('last', 'Last PT')}</tr></thead>
        <tbody>${list.map(x => `<tr class="pts-suprow" data-pts-open="${esc(x.name)}" title="Open ${esc(x.name)}'s returns">
          <td><b>${esc(x.name)}</b>${x.code ? ` <span class="muted-note mono">${esc(x.code)}</span>` : ''}</td><td class="num">${x.pts}</td><td class="num">${x.lines}</td><td class="num">${qty(x.qty)}</td>
          <td class="num"><b>${money(x.usd, '$')}</b></td>${anyL ? `<td class="num">${x.lbp ? money(x.lbp, 'LBP') : ''}</td>` : ''}
          <td class="num"><span class="pts-share"><i style="width:${Math.min(100, share(x.usd))}%"></i></span>${share(x.usd)}%</td>
          <td class="num">${x.open ? `<span class="pts-open">${x.open} · ${both(x.openUsd, x.openLbp)}</span>` : '<span class="muted-note">—</span>'}</td><td class="num">${esc(dmy(x.last))}</td></tr>`).join('')
          || `<tr><td colspan="${anyL ? 9 : 8}" class="empty-note">No PT in this period.</td></tr>`}</tbody>
        ${list.length > 1 ? `<tfoot><tr class="pts-tot"><td><b>Total</b></td><td class="num">${T.pts}</td><td class="num">${T.lines}</td><td class="num">${qty(T.qty)}</td><td class="num"><b>${money(T.usd, '$')}</b></td>${anyL ? `<td class="num"><b>${money(T.lbp, 'LBP')}</b></td>` : ''}<td></td><td class="num">${T.open ? `${T.open} · ${both(T.openUsd, T.openLbp)}` : ''}</td><td></td></tr></tfoot>` : ''}</table></div>
      <p class="muted-note" style="margin:8px 0 0;">The money returned to each supplier in the period (the filters above apply). "Not set" = PTs with no status yet. Click a supplier for its detailed returns.</p>
    </div>`;
  }

  /* ---------- one supplier's returns page ---------- */
  function detailHtml() {
    const name = S.detail, list = (S.rows || []).filter(r => supOf(r) === name && matches(r));
    const all = (S.rows || []).filter(r => supOf(r) === name);
    const x = supAgg(list)[0] || { pts: 0, lines: 0, qty: 0, usd: 0, lbp: 0, open: 0, openUsd: 0, openLbp: 0, last: '', code: all[0]?.supplier_code || '' };
    // per status: count and money
    const st = [['none', 'Not set'], ...STATUS].map(([k, l]) => { const rs = list.filter(r => (k === 'none' ? !r.status : r.status === k));
      return { k, l, c: rs.length, usd: rs.filter(r => !isL(r.currency)).reduce((t, r) => t + Math.abs(n(r.value)), 0), lbp: rs.filter(r => isL(r.currency)).reduce((t, r) => t + Math.abs(n(r.value)), 0) }; }).filter(s => s.c);
    // per month
    const mm = new Map(); list.forEach(r => { const k = String(r.pt_date || '').slice(0, 7); if (!k) return; const y = mm.get(k) || { pts: 0, usd: 0, lbp: 0, qty: 0 }; y.pts++; y.qty += Math.abs(n(r.qty)); if (isL(r.currency)) y.lbp += Math.abs(n(r.value)); else y.usd += Math.abs(n(r.value)); mm.set(k, y); });
    const months = [...mm.entries()].sort((a, b) => b[0].localeCompare(a[0])), maxM = Math.max(1, ...months.map(([, y]) => y.usd));
    const avg = x.pts ? x.usd / x.pts : 0;
    const stat = (v, l, cls = '') => `<div class="db-stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
    return `
      <div class="card">
        <div class="pts-dhead">
          <button type="button" class="icon-btn" id="ptsBack" title="All suppliers" aria-label="Back">${ICON.back}</button>
          <div><h3 style="margin:0;">${esc(name)}</h3><span class="muted-note">${x.code ? 'Code ' + esc(x.code) + ' · ' : ''}${S.days ? 'last ' + (S.days === 365 ? '12 months' : S.days + ' days') : 'all time'}${x.last ? ' · last PT ' + esc(dmy(x.last)) : ''}</span></div>
        </div>
        <div class="pts-stats">
          ${stat(both(x.usd, x.lbp), 'Total returned')}
          ${stat(x.pts, 'PT' + (x.pts === 1 ? '' : 's'))}
          ${stat(qty(x.qty), 'Units returned')}
          ${stat(x.lines, 'Lines')}
          ${stat(money(avg, '$'), 'Average PT ($)')}
          ${stat(x.open ? both(x.openUsd, x.openLbp) : '—', x.open ? `Not set (${x.open} PT${x.open === 1 ? '' : 's'})` : 'All set', x.open ? 'pts-warn' : '')}
        </div>
        ${st.length ? `<div class="pts-stchips">${st.map(s => `<span class="pts-chip k-${s.k}">${esc(s.l)} · ${s.c} · ${both(s.usd, s.lbp)}</span>`).join('')}</div>` : ''}
      </div>
      ${months.length > 1 ? `<div class="card"><div class="pf-head"><h3>By month</h3></div>
        <table class="items pf-table pts-tbl"><thead><tr><th>Month</th><th class="num">PTs</th><th class="num">Units</th><th class="num">Returned</th><th style="width:40%"></th></tr></thead>
        <tbody>${months.map(([k, y]) => `<tr><td>${esc(monthLabel(k))}</td><td class="num">${y.pts}</td><td class="num">${qty(y.qty)}</td><td class="num"><b>${both(y.usd, y.lbp)}</b></td><td><span class="pts-share wide"><i style="width:${Math.round(y.usd / maxM * 100)}%"></i></span></td></tr>`).join('')}</tbody></table></div>` : ''}
      ${ptsHtml(list, false)}
      ${itemsHtml(list)}`;
  }
  // the items returned to this supplier: the lines of its PTs (pt_detail, kept once read), added up per item
  const ITEM_CAP = 60;
  function itemsHtml(list) {
    const key = S.detail + '|' + S.days + '|' + S.status, todo = list.slice(0, ITEM_CAP);
    const read = todo.filter(r => S.lines[r.pt + '|' + r.year]);
    if (S.items.key !== key && !S.items.busy) setTimeout(() => readItems(key, todo), 0);
    const m = new Map();
    read.forEach(r => (S.lines[r.pt + '|' + r.year].lines || []).forEach(l => {
      const c = l.today || l.code; const x = m.get(c) || { code: c, desc: l.description, qty: 0, usd: 0, lbp: 0, pts: new Set(), refs: new Set() };
      x.qty += Math.abs(n(l.qty)); if (isL(S.lines[r.pt + '|' + r.year].currency || r.currency)) x.lbp += Math.abs(n(l.withVat)); else x.usd += Math.abs(n(l.withVat));
      x.pts.add(r.pt); if (l.ref) x.refs.add(l.ref); m.set(c, x);
    }));
    const items = [...m.values()].sort((a, b) => b.usd - a.usd || b.qty - a.qty);
    const note = S.items.busy ? `Reading the PTs… ${S.items.done} / ${S.items.of}` : list.length > ITEM_CAP ? `From the newest ${ITEM_CAP} PTs of ${list.length}` : `${items.length} item${items.length === 1 ? '' : 's'}`;
    return `<div class="card"><div class="pf-head"><h3>Items returned</h3><span class="muted-note" id="ptsItemsNote">${note}</span></div>
      <div class="items-scroll pf-scroll"><table class="items pf-table pts-tbl"><thead><tr><th>Code</th><th>Item</th><th class="num">Units</th><th class="num">Value</th><th class="num">PTs</th><th>Reference</th></tr></thead>
      <tbody>${items.map(x => `<tr data-item="${esc(x.code)}" title="Double-click for the item's details"><td class="mono">${esc(x.code)}</td><td>${esc(x.desc)}</td><td class="num"><b>${qty(x.qty)}</b></td><td class="num">${both(x.usd, x.lbp)}</td><td class="num">${x.pts.size}</td><td><span class="pts-ref">${esc([...x.refs].join(', '))}</span></td></tr>`).join('')
        || `<tr><td colspan="6" class="empty-note">${S.items.busy ? 'Reading…' : 'No items.'}</td></tr>`}</tbody></table></div></div>`;
  }
  async function readItems(key, todo) {
    S.items = { key, busy: true, done: 0, of: todo.length };
    const need = todo.filter(r => !S.lines[r.pt + '|' + r.year]);
    S.items.done = todo.length - need.length;
    for (let i = 0; i < need.length; i += 4) {
      if (S.items.key !== key) return;
      await Promise.all(need.slice(i, i + 4).map(async r => {
        try { S.lines[r.pt + '|' + r.year] = await call({ action: 'pt_detail', pt: r.pt, year: r.year }); } catch (e) { S.lines[r.pt + '|' + r.year] = { lines: [], failed: true }; }
        S.items.done++;
      }));
      const nt = el('ptsItemsNote'); if (nt) nt.textContent = `Reading the PTs… ${S.items.done} / ${S.items.of}`;
    }
    if (S.items.key !== key) return;
    S.items.busy = false;
    if (S.detail && el('panel-pts') && !el('panel-pts').querySelector('input:focus')) paint();
  }

  function bind(box) {
    const q = el('ptsQ');
    q.oninput = () => { S.q = q.value; const p = q.selectionStart; paint(); el('ptsQ').focus(); el('ptsQ').setSelectionRange(p, p); };
    if (el('ptsSup')) el('ptsSup').onchange = () => { S.sup = el('ptsSup').value; paint(); };
    el('ptsReload').onclick = async () => { S.rows = null; S.refs.rounds = 0; S.items.key = ''; await load(); paint(); };
    el('ptsXls').onclick = exportXls;
    if (el('ptsBack')) el('ptsBack').onclick = () => { S.detail = ''; S.view = 'sups'; paint(); };
    box.querySelectorAll('[data-pts-view]').forEach(b => b.onclick = () => { S.view = b.dataset.ptsView; S.detail = ''; paint(); });
    box.querySelectorAll('[data-pts-days]').forEach(b => b.onclick = async () => { S.days = Number(b.dataset.ptsDays); S.rows = null; S.items.key = ''; await load(); paint(); });
    box.querySelectorAll('[data-pts-status]').forEach(b => b.onclick = () => { S.status = b.dataset.ptsStatus; paint(); });
    if (el('ptsNew')) el('ptsNew').onclick = () => { S.newOnly = !S.newOnly; paint(); };
    box.querySelectorAll('[data-pts-sort]').forEach(h => h.onclick = () => { const key = h.dataset.ptsSort; if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = ['supplier_name', 'pt', 'refs'].includes(key) ? 1 : -1; } paint(); });
    box.querySelectorAll('[data-pts-ssort]').forEach(h => h.onclick = () => { const key = h.dataset.ptsSsort; if (S.ssort === key) S.sdir = -S.sdir; else { S.ssort = key; S.sdir = key === 'name' ? 1 : -1; } paint(); });
    box.querySelectorAll('[data-pts-open]').forEach(b => b.onclick = e => { e.stopPropagation(); S.detail = b.dataset.ptsOpen; S.sort = 'pt_date'; S.dir = -1; paint(); window.scrollTo({ top: 0 }); });
    box.querySelectorAll('[data-pts-set]').forEach(s => s.onchange = () => setStatus(s.dataset.ptsSet, s.dataset.ptsYear, s.value));
    box.querySelectorAll('[data-pts-note]').forEach(i => { i.onchange = () => setNote(i.dataset.ptsNote, i.dataset.ptsYear, i.value); i.onclick = e => e.stopPropagation(); });
    box.querySelectorAll('[data-pts-hist]').forEach(b => b.onclick = e => { e.stopPropagation(); openHistory(b.dataset.ptsHist, b.dataset.ptsYear); });
    box.querySelectorAll('tr[data-pt]').forEach(tr => tr.ondblclick = () => openPt(tr.dataset.pt, tr.dataset.year));
    box.querySelectorAll('tr[data-item]').forEach(tr => tr.ondblclick = () => { if (window.ItemDetail && tr.dataset.item) ItemDetail.open(tr.dataset.item); });
  }
  async function setStatus(pt, year, status) {
    const r = (S.rows || []).find(x => x.pt === pt && x.year === year); if (!r) return;
    const was = r.status;
    const { data, error } = await sb.from('pts').update({ status: status || null }).eq('pt', pt).eq('year', year).select().single();
    if (error) return showToast(friendlyError(error), true);
    Object.assign(r, data);
    // who changed what, kept in the activity log (both people use the same form): from → to
    logActivity('vendors', 'pt_status', { type: 'pt', id: pt }, `${pt} (${supOf(r)}): ${was ? SLABEL[was] : 'not set'} → ${status ? SLABEL[status] : 'not set'}`);
    paint();   // the totals per status / supplier follow, and the "changed by" line
  }
  async function setNote(pt, year, note) {
    const r = (S.rows || []).find(x => x.pt === pt && x.year === year); if (!r || (r.note || '') === note.trim()) return;
    const { data, error } = await sb.from('pts').update({ note: note.trim() || null }).eq('pt', pt).eq('year', year).select().single();
    if (error) return showToast(friendlyError(error), true);
    Object.assign(r, data);
    logActivity('vendors', 'pt_note', { type: 'pt', id: pt }, `${pt} (${supOf(r)}): note ${note.trim() ? '"' + note.trim() + '"' : 'cleared'}`);
    paint();
  }
  // the whole history of a PT (every status / note change), from the activity log
  async function openHistory(pt, year) {
    let dlg = el('ptsHistDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'ptsHistDlg'; dlg.className = 'vs-pt-dlg pts-hist-dlg'; document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-histclose]')) dlg.close(); }); }
    const close = '<button type="button" class="icon-btn" data-histclose title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>';
    dlg.innerHTML = `<div class="vs-pt-head"><h3>${esc(pt)} — history</h3><span style="flex:1"></span>${close}</div><div class="vs-note vs-loading">Reading the history…</div>`;
    if (!dlg.open) dlg.showModal();
    const { data, error } = await sb.from('activity_log').select('at, username, action, summary').eq('entity_type', 'pt').eq('entity_id', pt).order('at', { ascending: false }).limit(200);
    const body = dlg.querySelector('.vs-note');
    if (error) { body.className = 'vs-note vs-err'; body.textContent = friendlyError(error); return; }
    const when = s => { const d = new Date(s); return isNaN(d) ? '' : `${dmy(d.toISOString())} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`; };
    dlg.innerHTML = `<div class="vs-pt-head"><h3>${esc(pt)} — history</h3><span style="flex:1"></span>${close}</div>` + (
      (data || []).length ? `<div class="items-scroll vs-scroll"><table class="items vs-table pts-hist"><thead><tr><th>When</th><th>Who</th><th>Change</th></tr></thead>
        <tbody>${data.map(r => `<tr><td class="muted-note" style="white-space:nowrap;">${esc(when(r.at))}</td><td>${esc(r.username || '—')}</td><td>${esc(String(r.summary || '').replace(new RegExp('^' + pt + '[^:]*:\\s*'), ''))}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="vs-note">No change recorded yet.</div>');
  }
  async function openPt(pt, year) {
    let dlg = el('ptsDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'ptsDlg'; dlg.className = 'vs-pt-dlg'; document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-ptclose]')) dlg.close(); });
      dlg.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-today]'); if (tr && tr.dataset.today && window.ItemDetail) ItemDetail.open(tr.dataset.today); }); }
    const head = t => `<div class="vs-pt-head"><h3>${esc(pt)}</h3>${t}<button type="button" class="icon-btn" data-ptclose title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
    dlg.innerHTML = head('') + '<div class="vs-note vs-loading">Reading the PT…</div>'; if (!dlg.open) dlg.showModal();
    try {
      const d = S.lines[pt + '|' + year] && !S.lines[pt + '|' + year].failed ? S.lines[pt + '|' + year] : (S.lines[pt + '|' + year] = await call({ action: 'pt_detail', pt, year }));
      const cur = c => c || d.currency || '$';
      const refs = [...new Set((d.lines || []).map(l => l.ref).filter(Boolean))];
      dlg.innerHTML = head(`<span class="muted-note">${esc(dmy(d.date))} · ${esc(d.partner)}${refs.length ? ' · Ref ' + esc(refs.join(', ')) : ''}</span>`) + `
        <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th class="num">#</th><th>Code</th><th>Item</th><th>Reference</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total incl. VAT</th></tr></thead>
          <tbody>${(d.lines || []).map(l => `<tr data-today="${esc(l.today || '')}"><td class="num muted-note">${l.line}</td><td class="mono">${esc(l.today || l.code)}</td><td>${esc(l.description)}${l.remarks ? `<div class="muted-note">${esc(l.remarks)}</div>` : ''}</td>
            <td><span class="pts-ref">${esc(l.ref || '')}</span></td><td class="num"><b>${qty(l.qty)}</b></td><td class="num">${money(l.unit, cur(d.currency))}</td><td class="num">${money(l.withVat, cur(d.currency))}</td></tr>`).join('')}</tbody>
          <tfoot><tr class="pts-tot"><td colspan="4"><b>Total</b></td><td class="num"><b>${qty((d.lines || []).reduce((t, l) => t + n(l.qty), 0))}</b></td><td></td><td class="num"><b>${money(d.withVat, cur(d.currency))}</b></td></tr></tfoot></table></div>
        <p class="muted-note" style="margin:8px 0 0;">${(d.lines || []).length} line${(d.lines || []).length === 1 ? '' : 's'}, as the system has it. Double-click an item for its details.</p>`;
    } catch (e) { dlg.innerHTML = head('') + `<div class="vs-note vs-err">${esc(e.message)}</div>`; }
  }
  function exportXls() {
    const wb = XLSX.utils.book_new();
    const inView = S.detail ? (S.rows || []).filter(r => supOf(r) === S.detail && matches(r)) : S.view === 'sups' ? (S.rows || []).filter(matches) : shown();
    if (!inView.length) return showToast('Nothing to export.', true);
    // the suppliers' totals
    const sa = supAgg(inView).sort((a, b) => b.usd - a.usd);
    const s1 = [['Supplier', 'Code', 'PTs', 'Lines', 'Units', 'Total $', 'Total LBP', 'Not set (PTs)', 'Not set $', 'Last PT']];
    sa.forEach(x => s1.push([x.name, String(x.code || ''), x.pts, x.lines, Math.round(x.qty * 100) / 100, Math.round(x.usd * 100) / 100, Math.round(x.lbp), x.open, Math.round(x.openUsd * 100) / 100, dmy(x.last)]));
    const ws1 = XLSX.utils.aoa_to_sheet(s1); ws1['!cols'] = [{ wch: 30 }, { wch: 10 }, { wch: 6 }, { wch: 7 }, { wch: 9 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 11 }, { wch: 11 }];
    // the PTs
    const aoa = [['PT', 'Date', 'Supplier', 'Code', 'Reference', 'Lines', 'Units', 'Value', 'Currency', 'Status', 'Note', 'Set by']];
    sortPts([...inView]).forEach(r => aoa.push([String(r.pt), dmy(r.pt_date), r.supplier_name || '', String(r.supplier_code || ''), r.refs || '', r.lines ?? '', Math.abs(n(r.qty)), Math.round(Math.abs(n(r.value)) * 100) / 100, r.currency || '$', r.status ? SLABEL[r.status] : '', r.note || '', r.status_by_name || '']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let i = 2; i <= aoa.length; i++) ['A', 'D', 'E'].forEach(c => { const cell = ws[c + i]; if (cell) { cell.t = 's'; cell.v = String(cell.v); } });
    ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 28 }, { wch: 10 }, { wch: 18 }, { wch: 7 }, { wch: 9 }, { wch: 11 }, { wch: 8 }, { wch: 13 }, { wch: 24 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'By supplier');
    XLSX.utils.book_append_sheet(wb, ws, 'PTs');
    XLSX.writeFile(wb, `Returns ${S.detail ? S.detail.replace(/[\\/:*?"<>|]/g, ' ') + ' ' : ''}${todayStr()}.xlsx`);
  }
  window.PTs = { show };
})();
