/* ============================================================
   Vendors › PO tracking (owner, 2026-10-13): every PO set/sent in the system against when it was delivered (its PU),
   so each supplier is fully tracked. Reads system_pos (migration 082, synced by po_sync): po_date -> delivered_on, the
   days taken, still open or delivered. One row per supplier (its POs, how many delivered, the average days, the open
   ones and the oldest), expand for its POs. Date range by PO date, filter, search, Excel. Permission: vendors.manage.
   (po_sync started 2026-10-11, so the history fills from there.) Public API: window.VendorPoTrack = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const today = () => todayStr();
  const daysBetween = (a, b) => Math.round((Date.parse(String(b).slice(0, 10) + 'T00:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T00:00:00Z')) / 864e5);
  const sk = c => String(c || '').trim().replace(/^0+(?=\d)/, '');
  const vendorOf = code => (typeof vendorsList !== 'undefined' ? vendorsList : []).find(v => (v.systemSuppliers || []).some(s => sk(s.code) === sk(code)));
  const S = { rows: null, err: '', days: 30, q: '', filter: 'all', sort: 'open', dir: -1, open: new Set() };

  async function load() {
    const from = addDaysStr(today(), -(S.days - 1));
    S.err = '';
    const { data, error } = await sb.from('system_pos').select('po, po_date, supplier_code, supplier_name, status, line_count, requested_qty, received_qty, remaining_qty, delivered_on')
      .gte('po_date', from).order('po_date', { ascending: false }).limit(5000);
    if (error) { S.err = /system_pos/.test(error.message) ? 'PO tracking is not set up yet (migration 082).' : (error.message || 'Could not read the POs.'); S.rows = []; return; }
    S.rows = (data || []).map(r => ({ ...r, days: r.delivered_on && r.po_date ? daysBetween(r.po_date, r.delivered_on) : null,
      open: !r.delivered_on, age: r.po_date ? daysBetween(r.po_date, today()) : null }));
  }
  function groups() {
    const q = S.q.trim().toLowerCase(), m = new Map();
    S.rows.forEach(r => {
      if (q && !String(r.supplier_name || '').toLowerCase().includes(q) && !String(r.po || '').toLowerCase().includes(q)) return;
      const k = sk(r.supplier_code) || r.supplier_name || '?';
      const g = m.get(k) || { key: k, code: r.supplier_code, name: r.supplier_name || 'Supplier ' + r.supplier_code, pos: [] };
      g.pos.push(r); m.set(k, g);
    });
    const out = [...m.values()].map(g => {
      const delivered = g.pos.filter(p => !p.open), open = g.pos.filter(p => p.open);
      const dd = delivered.map(p => p.days).filter(x => x !== null).sort((a, b) => a - b);
      const avg = dd.length ? dd.reduce((t, x) => t + x, 0) / dd.length : null;
      const med = dd.length ? dd[Math.floor(dd.length / 2)] : null;
      const oldest = open.length ? Math.max(...open.map(p => p.age ?? 0)) : null;
      g.pos.sort((a, b) => String(b.po_date).localeCompare(String(a.po_date)));
      return Object.assign(g, { nPos: g.pos.length, nDelivered: delivered.length, nOpen: open.length, avg, med, oldest, vendor: vendorOf(g.code) });
    });
    if (S.filter === 'open') return out.filter(g => g.nOpen);
    if (S.filter === 'delivered') return out.filter(g => g.nDelivered);
    return out;
  }

  async function show() {
    const box = el('vendorPoTrackView'); if (!box) return;
    if (!S.rows) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the POs…</p></div>'; await load(); }
    paint();
  }
  const RANGES = [[14, '14 days'], [30, '30 days'], [90, '90 days']];
  function paint() {
    const box = el('vendorPoTrackView'); if (!box) return;
    if (S.err) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const list = groups();
    const k = S.sort;
    list.sort((a, b) => k === 'name' ? a.name.localeCompare(b.name) : S.dir * ((n(a[k]) ?? -1) - (n(b[k]) ?? -1)));
    const allPos = S.rows.length, delivered = S.rows.filter(r => !r.open).length, open = S.rows.filter(r => r.open).length;
    const dd = S.rows.filter(r => r.days !== null).map(r => r.days); const avgAll = dd.length ? Math.round(dd.reduce((t, x) => t + x, 0) / dd.length * 10) / 10 : null;
    const oldestOpen = S.rows.filter(r => r.open).reduce((m, r) => Math.max(m, r.age ?? 0), 0);
    const sortIc = key => key === S.sort ? (S.dir < 0 ? ' ▾' : ' ▴') : '';
    const th = (key, label) => `<th class="num pt-sort" data-pt-sort="${key}">${label}${sortIc(key)}</th>`;
    box.innerHTML = `
      <div class="card pt-bar">
        <div class="filter-row" style="margin:0;">${RANGES.map(([d, l]) => `<button type="button" data-pt-days="${d}" class="${S.days === d ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="filter-row" style="margin:0;">${[['all', 'All'], ['open', 'Open'], ['delivered', 'Delivered']].map(([v, l]) => `<button type="button" data-pt-filter="${v}" class="${S.filter === v ? 'active' : ''}">${l}</button>`).join('')}</div>
        <input type="search" id="ptQ" placeholder="Find a supplier or PO" value="${esc(S.q)}" aria-label="Find">
        <span style="flex:1"></span>
        <button type="button" class="icon-btn" id="ptXls" title="Download (Excel)" aria-label="Download (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button>
      </div>
      <div class="pf-tiles">
        <div class="pf-tile"><span>POs</span><b>${allPos}</b><small>last ${S.days} days</small></div>
        <div class="pf-tile"><span>Delivered</span><b>${delivered}</b><small>${open} still open</small></div>
        <div class="pf-tile"><span>Avg PO → delivery</span><b>${avgAll === null ? '—' : avgAll + ' d'}</b><small>from set to the PU</small></div>
        <div class="pf-tile"><span>Oldest open</span><b class="${oldestOpen > 7 ? 'pf-neg' : ''}">${open ? oldestOpen + ' d' : '—'}</b><small>not delivered yet</small></div>
      </div>
      <div class="card">
        <div class="items-scroll pf-scroll"><table class="items pf-table pt-tbl"><thead><tr>
          <th class="pt-sort" data-pt-sort="name">Supplier${sortIc('name')}</th>${th('nPos', 'POs')}${th('nDelivered', 'Delivered')}${th('avg', 'Avg days')}${th('nOpen', 'Open')}${th('oldest', 'Oldest open')}</tr></thead>
          <tbody>${list.map(g => groupRows(g)).join('') || `<tr><td colspan="6" class="empty-note">No PO in this period.</td></tr>`}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">From each PO's date in the system to the day it was delivered (its PU, detected by the sync). Tracking began on 11-10-2026, so older POs aren't here. Click a supplier for its POs.</p>
      </div>`;
    el('ptQ').oninput = () => { S.q = el('ptQ').value; const p = el('ptQ').selectionStart; paint(); el('ptQ').focus(); el('ptQ').setSelectionRange(p, p); };
    box.querySelectorAll('[data-pt-days]').forEach(b => b.onclick = async () => { S.days = Number(b.dataset.ptDays); S.rows = null; await load(); paint(); });
    box.querySelectorAll('[data-pt-filter]').forEach(b => b.onclick = () => { S.filter = b.dataset.ptFilter; paint(); });
    box.querySelectorAll('.pt-sort').forEach(h => h.onclick = () => { const key = h.dataset.ptSort; if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = key === 'name' ? 1 : -1; } paint(); });
    box.querySelectorAll('tr[data-pt-g]').forEach(tr => tr.onclick = () => { const k = tr.dataset.ptG; S.open.has(k) ? S.open.delete(k) : S.open.add(k); paint(); });
    box.querySelectorAll('tr[data-pt-code] td').forEach(td => td.ondblclick = () => { const code = td.closest('[data-pt-code]').dataset.ptCode; if (code && window.ItemDetail) return; });
    el('ptXls').onclick = exportXls;
  }
  function groupRows(g) {
    const open = S.open.has(g.key);
    const head = `<tr class="pt-g ${open ? 'open' : ''}" data-pt-g="${esc(g.key)}">
      <td><span class="pt-chev">${open ? '▾' : '▸'}</span><b>${esc(g.name)}</b>${g.vendor ? '' : ' <span class="muted-note">not a vendor</span>'}</td>
      <td class="num">${g.nPos}</td><td class="num">${g.nDelivered}</td>
      <td class="num">${g.avg === null ? '<span class="muted-note">—</span>' : (Math.round(g.avg * 10) / 10) + ' d'}</td>
      <td class="num ${g.nOpen ? 'pf-under' : ''}">${g.nOpen || ''}</td>
      <td class="num ${g.oldest > 7 ? 'pf-neg' : ''}">${g.oldest === null ? '' : g.oldest + ' d'}</td></tr>`;
    if (!open) return head;
    const lines = g.pos.map(p => {
      const st = p.open ? `<span class="pf-under">open ${p.age} d</span>` : `<span class="pf-up">in ${p.days} d</span>`;
      const recv = p.received_qty !== null && p.requested_qty ? ` · ${Math.round(n(p.received_qty) || 0)}/${Math.round(n(p.requested_qty) || 0)}` : '';
      return `<tr class="pt-po"><td class="pt-po-c"><span class="mono">${esc(p.po)}</span> <span class="muted-note">${esc(p.line_count || 0)} line${p.line_count === 1 ? '' : 's'}${recv}</span></td>
        <td class="num muted-note" colspan="2">set ${esc(dmy(p.po_date))}</td>
        <td class="num" colspan="2">${p.open ? '<span class="muted-note">not delivered</span>' : 'delivered ' + esc(dmy(p.delivered_on))}</td>
        <td class="num">${st}</td></tr>`;
    }).join('');
    return head + lines;
  }
  function exportXls() {
    const rows = [['Supplier', 'Code', 'PO', 'Set on', 'Delivered on', 'Days PO→delivery', 'Status', 'Lines', 'Requested', 'Received', 'Vendor in app']];
    groups().forEach(g => g.pos.forEach(p => rows.push([g.name, String(g.code || ''), String(p.po), dmy(p.po_date), p.delivered_on ? dmy(p.delivered_on) : '',
      p.days === null ? '' : p.days, p.open ? 'Open ' + p.age + 'd' : 'Delivered', p.line_count || 0, n(p.requested_qty) ?? '', n(p.received_qty) ?? '', g.vendor ? g.vendor.name : ''])));
    if (rows.length === 1) return showToast('Nothing to export.', true);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    for (let i = 2; i <= rows.length; i++) ['B', 'C'].forEach(c => { const cell = ws[c + i]; if (cell) { cell.t = 's'; cell.v = String(cell.v); } });
    ws['!cols'] = [{ wch: 30 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 7 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'PO tracking');
    XLSX.writeFile(wb, `PO tracking ${todayStr()}.xlsx`);
  }
  window.VendorPoTrack = { show };
})();
