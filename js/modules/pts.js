/* ============================================================
   Returns to suppliers — PTs (owner, 2026-10-13): a dedicated page listing every PT (return to a supplier) with a status the
   owner sets: Taken / Compensated / Traded / Owner. The PTs are kept in public.pts (migration 095, synced every 30 min by
   lv-dashboard pts_sync, which does not touch the status). Reads the table (instant); the status change is saved at once.
   Filters by status, supplier and date, search, totals, Excel; double-click a PT for its lines (pt_detail). Permission:
   vendors.manage. Public API: window.PTs = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = (v, c) => (c === 'LBP' ? Math.round(Math.abs(n(v))).toLocaleString('en-US') + ' LBP' : '$' + (Math.round(Math.abs(n(v)) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const STATUS = [['taken', 'Taken'], ['compensated', 'Compensated'], ['traded', 'Traded'], ['owner', 'Owner']];
  const SLABEL = Object.fromEntries(STATUS);
  const S = { rows: null, err: '', days: 30, q: '', status: 'all', sup: '', sort: 'pt_date', dir: -1, busy: false };

  async function call(body) { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.'); return data; }
  async function load() {
    S.err = '';
    const from = addDaysStr(todayStr(), -(S.days - 1));
    let qy = sb.from('pts').select('*').order('pt_date', { ascending: false }).limit(5000);
    if (S.days !== 0) qy = qy.gte('pt_date', from);
    const { data, error } = await qy;
    if (error) { S.err = /pts\b|relation/.test(error.message) ? 'The returns tracker is not set up yet (migration 095).' : (error.message || 'Could not read the returns.'); S.rows = []; return; }
    S.rows = data || [];
  }
  const shown = () => {
    const q = S.q.trim().toLowerCase();
    return (S.rows || []).filter(r => (S.status === 'all' || (S.status === 'none' ? !r.status : r.status === S.status))
      && (!S.sup || r.supplier_name === S.sup)
      && (!q || [r.pt, r.supplier_name].some(v => String(v || '').toLowerCase().includes(q))));
  };

  async function show() {
    const box = el('panel-pts'); if (!box) return;
    if (!S.rows) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the returns…</p></div>'; await load(); }
    paint();
  }
  const RANGES = [[30, '30 days'], [90, '90 days'], [0, 'All']];
  function paint() {
    const box = el('panel-pts'); if (!box) return;
    if (S.err) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const base = (S.rows || []).filter(r => !S.sup || r.supplier_name === S.sup);
    const cnt = st => base.filter(r => st === 'all' ? true : st === 'none' ? !r.status : r.status === st).length;
    const list = shown();
    const k = S.sort; list.sort((a, b) => k === 'supplier_name' || k === 'pt' ? S.dir * String(a[k] || '').localeCompare(String(b[k] || '')) : S.dir * ((n(a[k]) ?? -1) - (n(b[k]) ?? -1)) || String(b.pt_date).localeCompare(String(a.pt_date)));
    const total = list.reduce((t, r) => t + Math.abs(n(r.value)), 0);
    const sups = [...new Set((S.rows || []).map(r => r.supplier_name).filter(Boolean))].sort();
    const sortIc = key => key === S.sort ? (S.dir < 0 ? ' ▾' : ' ▴') : '';
    const th = (key, label, num = true) => `<th class="${num ? 'num ' : ''}pts-sort" data-pts-sort="${key}">${label}${sortIc(key)}</th>`;
    box.innerHTML = `
      <div class="card pts-bar">
        <div class="filter-row" style="margin:0;">${RANGES.map(([d, l]) => `<button type="button" data-pts-days="${d}" class="${S.days === d ? 'active' : ''}">${l}</button>`).join('')}</div>
        <input type="search" id="ptsQ" placeholder="Find a PT or supplier" value="${esc(S.q)}" aria-label="Find">
        <select id="ptsSup" aria-label="Supplier"><option value="">All suppliers</option>${sups.map(s => `<option value="${esc(s)}" ${s === S.sup ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <span style="flex:1"></span>
        <button type="button" class="icon-btn" id="ptsReload" title="Read again" aria-label="Read again"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
        <button type="button" class="icon-btn" id="ptsXls" title="Download (Excel)" aria-label="Download (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button>
      </div>
      <div class="filter-row pts-status" style="margin:0 0 12px;">
        <button type="button" data-pts-status="all" class="${S.status === 'all' ? 'active' : ''}">All <span class="muted-note">${cnt('all')}</span></button>
        <button type="button" data-pts-status="none" class="${S.status === 'none' ? 'active' : ''}">Not set <span class="muted-note">${cnt('none')}</span></button>
        ${STATUS.map(([k2, l]) => `<button type="button" data-pts-status="${k2}" class="${S.status === k2 ? 'active' : ''}">${l} <span class="muted-note">${cnt(k2)}</span></button>`).join('')}
      </div>
      <div class="card">
        <div class="pf-head"><h3>Returns ${S.sup ? '· ' + esc(S.sup) : ''}</h3><span class="muted-note">${list.length} PT${list.length === 1 ? '' : 's'} · ${money(total, '$')}</span></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table pts-tbl"><thead><tr>
          ${th('pt', 'PT', false)}${th('pt_date', 'Date')}${th('supplier_name', 'Supplier', false)}${th('lines', 'Lines')}${th('value', 'Value')}<th>Status</th><th>Note</th></tr></thead>
          <tbody>${list.map(rowHtml).join('') || `<tr><td colspan="7" class="empty-note">No PT in this period.</td></tr>`}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Every return to a supplier, synced from the system every 30 minutes. Set each one's status; double-click a PT for its lines. Value is the money returned.</p>
      </div>`;
    el('ptsQ').oninput = () => { S.q = el('ptsQ').value; const p = el('ptsQ').selectionStart; paint(); el('ptsQ').focus(); el('ptsQ').setSelectionRange(p, p); };
    el('ptsSup').onchange = () => { S.sup = el('ptsSup').value; paint(); };
    el('ptsReload').onclick = async () => { S.rows = null; await load(); paint(); };
    el('ptsXls').onclick = exportXls;
    box.querySelectorAll('[data-pts-days]').forEach(b => b.onclick = async () => { S.days = Number(b.dataset.ptsDays); S.rows = null; await load(); paint(); });
    box.querySelectorAll('[data-pts-status]').forEach(b => b.onclick = () => { S.status = b.dataset.ptsStatus; paint(); });
    box.querySelectorAll('.pts-sort').forEach(h => h.onclick = () => { const key = h.dataset.ptsSort; if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = key === 'supplier_name' || key === 'pt' ? 1 : -1; } paint(); });
    box.querySelectorAll('[data-pts-set]').forEach(s => s.onchange = () => setStatus(s.dataset.ptsSet, s.dataset.ptsYear, s.value));
    box.querySelectorAll('[data-pts-note]').forEach(i => { i.onchange = () => setNote(i.dataset.ptsNote, i.dataset.ptsYear, i.value); i.onclick = e => e.stopPropagation(); });
    box.querySelectorAll('tr[data-pt]').forEach(tr => tr.ondblclick = () => openPt(tr.dataset.pt, tr.dataset.year));
  }
  function rowHtml(r) {
    return `<tr data-pt="${esc(r.pt)}" data-year="${esc(r.year)}" class="${r.status ? 'pts-done' : ''}" title="Double-click for its lines">
      <td class="mono"><b>${esc(r.pt)}</b></td><td>${esc(dmy(r.pt_date))}</td><td>${esc(r.supplier_name || r.supplier_code || '')}</td>
      <td class="num">${r.lines ?? ''}</td><td class="num">${money(r.value, r.currency)}</td>
      <td><select class="pts-sel k-${r.status || 'none'}" data-pts-set="${esc(r.pt)}" data-pts-year="${esc(r.year)}" aria-label="Status"><option value="">Not set</option>${STATUS.map(([k, l]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${r.status_by_name ? `<div class="pts-sub">${esc(r.status_by_name)}</div>` : ''}</td>
      <td><input type="text" class="pts-note" data-pts-note="${esc(r.pt)}" data-pts-year="${esc(r.year)}" value="${esc(r.note || '')}" placeholder="…" aria-label="Note"></td></tr>`;
  }
  async function setStatus(pt, year, status) {
    const r = (S.rows || []).find(x => x.pt === pt && x.year === year); if (!r) return;
    const { data, error } = await sb.from('pts').update({ status: status || null }).eq('pt', pt).eq('year', year).select().single();
    if (error) return showToast(friendlyError(error), true);
    Object.assign(r, data);
    const sel = document.querySelector(`[data-pts-set="${CSS.escape(pt)}"][data-pts-year="${CSS.escape(year)}"]`); if (sel) sel.className = 'pts-sel k-' + (status || 'none');
    logActivity('vendors', 'pt_status', { type: 'pt', id: pt }, `${pt}: ${status ? SLABEL[status] : 'status cleared'}`);
    if (S.status !== 'all') paint();
  }
  async function setNote(pt, year, note) {
    const r = (S.rows || []).find(x => x.pt === pt && x.year === year); if (!r || (r.note || '') === note.trim()) return;
    const { data, error } = await sb.from('pts').update({ note: note.trim() || null }).eq('pt', pt).eq('year', year).select().single();
    if (error) return showToast(friendlyError(error), true);
    Object.assign(r, data);
  }
  async function openPt(pt, year) {
    let dlg = el('ptsDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'ptsDlg'; dlg.className = 'vs-pt-dlg'; document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-ptclose]')) dlg.close(); });
      dlg.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-today]'); if (tr && tr.dataset.today && window.ItemDetail) ItemDetail.open(tr.dataset.today); }); }
    const head = t => `<div class="vs-pt-head"><h3>${esc(pt)}</h3>${t}<button type="button" class="icon-btn" data-ptclose title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
    dlg.innerHTML = head('') + '<div class="vs-note vs-loading">Reading the PT…</div>'; if (!dlg.open) dlg.showModal();
    try {
      const d = await call({ action: 'pt_detail', pt, year });
      const cur = c => c || d.currency || '$';
      dlg.innerHTML = head(`<span class="muted-note">${esc(dmy(d.date))} · ${esc(d.partner)}</span>`) + `
        <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th class="num">#</th><th>Code</th><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total incl. VAT</th></tr></thead>
          <tbody>${(d.lines || []).map(l => `<tr data-today="${esc(l.today || '')}"><td class="num muted-note">${l.line}</td><td class="mono">${esc(l.today || l.code)}</td><td>${esc(l.description)}${l.remarks ? `<div class="muted-note">${esc(l.remarks)}</div>` : ''}</td>
            <td class="num"><b>${(Math.round(n(l.qty) * 100) / 100).toLocaleString('en-US')}</b></td><td class="num">${money(l.unit, cur(d.currency))}</td><td class="num">${money(l.withVat, cur(d.currency))}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">${(d.lines || []).length} line${(d.lines || []).length === 1 ? '' : 's'}, as the system has it. Double-click an item for its details.</p>`;
    } catch (e) { dlg.innerHTML = head('') + `<div class="vs-note vs-err">${esc(e.message)}</div>`; }
  }
  function exportXls() {
    const list = shown();
    if (!list.length) return showToast('Nothing to export.', true);
    const aoa = [['PT', 'Date', 'Supplier', 'Code', 'Lines', 'Units', 'Value', 'Currency', 'Status', 'Note', 'Set by']];
    list.forEach(r => aoa.push([String(r.pt), dmy(r.pt_date), r.supplier_name || '', String(r.supplier_code || ''), r.lines ?? '', n(r.qty), Math.round(Math.abs(n(r.value)) * 100) / 100, r.currency || '$', r.status ? SLABEL[r.status] : '', r.note || '', r.status_by_name || '']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let i = 2; i <= aoa.length; i++) ['A', 'D'].forEach(c => { const cell = ws[c + i]; if (cell) { cell.t = 's'; cell.v = String(cell.v); } });
    ws['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 28 }, { wch: 10 }, { wch: 7 }, { wch: 9 }, { wch: 11 }, { wch: 8 }, { wch: 13 }, { wch: 24 }, { wch: 16 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'PTs');
    XLSX.writeFile(wb, `Returns PTs ${todayStr()}.xlsx`);
  }
  window.PTs = { show };
})();
