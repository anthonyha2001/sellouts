/* ============================================================
   Import vendors from the system (owner, 2026-10-13): instead of entering a vendor by hand and then linking it to the system,
   pull the system's supplier list (its purchases of the last 12 months, lv-dashboard supplier_catalog) and create vendors
   straight from it — each already linked to its real code, so the link is right by construction and dead duplicates never happen.
   A supplier already linked to a vendor is shown as such and skipped. Admin / vendors.manage.
   Public API: window.VendorImport = { open }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const norm = c => String(c || '').replace(/^0+/, '').toUpperCase();
  const S = { list: null, err: '', q: '', only: 'new', sel: new Set(), busy: false, sort: 'purchases' };

  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
    return data;
  }
  // every system code already linked to some vendor -> that vendor's name
  function linkedMap() {
    const m = new Map();
    (typeof vendorsList !== 'undefined' ? vendorsList : []).forEach(v => (v.systemSuppliers || []).forEach(s => { if (s.code) m.set(norm(s.code), v.name); }));
    return m;
  }

  async function open() {
    el('viOverlay')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="viOverlay"><div class="modal-box vi-box" role="dialog" aria-modal="true" aria-label="Import vendors from the system">
      <div class="vi-head"><h3>Import vendors from the system</h3><button type="button" class="icon-btn" data-vi="close" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div id="viBody"><p class="muted-note" style="margin:0;">Reading the system's suppliers (their purchases of the last 12 months)…</p></div></div></div>`);
    const ov = el('viOverlay');
    const onKey = e => { if (e.key === 'Escape') close(); };
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    ov.addEventListener('click', e => { const t = e.target.closest('[data-vi]'); if (t && t.dataset.vi === 'close') close(); });
    ov._close = close;
    try { if (!S.list) { const d = await call({ action: 'supplier_catalog' }); S.list = d.suppliers || []; } }
    catch (e) { el('viBody').innerHTML = `<p class="login-err" style="margin:0;">${esc(/Unknown action/i.test(e.message) ? 'Deploy the latest lv-dashboard to import from the system.' : e.message)}</p>`; return; }
    S.sel = new Set();
    paint();
  }

  function rows() {
    const linked = linkedMap(), q = S.q.trim().toLowerCase();
    let list = S.list.map(s => ({ ...s, linkedTo: linked.get(norm(s.code)) || null }));
    if (S.only === 'new') list = list.filter(s => !s.linkedTo);
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q) || String(s.code).includes(q));
    list.sort((a, b) => S.sort === 'name' ? a.name.localeCompare(b.name) : b.purchases - a.purchases);
    return { list, linked };
  }
  function paint() {
    const { list, linked } = rows();
    const total = S.list.length, inApp = S.list.filter(s => linked.has(norm(s.code))).length;
    el('viBody').innerHTML = `
      <div class="vi-bar">
        <input type="search" id="viQ" placeholder="Find a supplier or code" value="${esc(S.q)}" aria-label="Find">
        <div class="filter-row" style="margin:0;"><button type="button" data-vi-only="new" class="${S.only === 'new' ? 'active' : ''}">Not in the app (${total - inApp})</button><button type="button" data-vi-only="all" class="${S.only === 'all' ? 'active' : ''}">All (${total})</button></div>
        <span style="flex:1"></span>
        <label class="vi-sel-all"><input type="checkbox" id="viAll" ${list.length && list.every(s => S.sel.has(s.code)) ? 'checked' : ''}> Select shown</label>
      </div>
      <div class="items-scroll vi-scroll"><table class="items vi-tbl"><thead><tr><th></th><th>Supplier</th><th>Code</th><th class="num">Purchases 12m</th><th class="num">Months</th><th>In the app?</th></tr></thead>
        <tbody>${list.map(s => `<tr class="${s.linkedTo ? 'vi-linked' : ''}"><td class="vi-ck">${s.linkedTo ? '' : `<input type="checkbox" data-vi-ck="${esc(s.code)}" ${S.sel.has(s.code) ? 'checked' : ''} aria-label="Select">`}</td>
          <td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.code)}</td><td class="num">${money(s.purchases)}</td><td class="num">${s.active_months}</td>
          <td>${s.linkedTo ? `<span class="muted-note">→ ${esc(s.linkedTo)}</span>` : '<span class="vi-new">New</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-note">Nothing matches.</td></tr>'}</tbody></table></div>
      <div class="vi-foot">
        <span class="muted-note">${S.sel.size} selected. Each becomes a vendor already linked to its system code; stock-watch on. You can edit its order day and lead time after.</span>
        <button type="button" class="btn" id="viImport" ${S.sel.size && !S.busy ? '' : 'disabled'}>${S.busy ? 'Importing…' : `Import ${S.sel.size || ''}`.trim()}</button>
      </div>`;
    const b = el('viBody');
    el('viQ').oninput = () => { S.q = el('viQ').value; const p = el('viQ').selectionStart; paint(); el('viQ').focus(); el('viQ').setSelectionRange(p, p); };
    b.querySelectorAll('[data-vi-only]').forEach(x => x.onclick = () => { S.only = x.dataset.viOnly; paint(); });
    el('viAll').onchange = () => { const { list } = rows(); list.forEach(s => { if (!s.linkedTo) el('viAll').checked ? S.sel.add(s.code) : S.sel.delete(s.code); }); paint(); };
    b.querySelectorAll('[data-vi-ck]').forEach(x => x.onchange = () => { x.checked ? S.sel.add(x.dataset.viCk) : S.sel.delete(x.dataset.viCk); paint(); });
    el('viImport').onclick = doImport;
  }

  async function doImport() {
    const chosen = S.list.filter(s => S.sel.has(s.code));
    if (!chosen.length || S.busy) return;
    S.busy = true; paint();
    let made = 0;
    for (const s of chosen) {
      const v = { id: uid(), name: s.name, salesmanName: '', phone: '', dayOfWeek: null, frequencyWeeks: 1, leadTimeDays: null, anchorDate: '',
        watchStock: true, systemSuppliers: [{ code: s.code, name: s.name }], coverDays: null, contract: {}, receivingDays: [] };
      const ok = await saveVendorRemote(v);
      if (ok) { vendorsList.push(v); made++; }
    }
    S.busy = false;
    if (typeof logActivity === 'function') logActivity('vendors', 'import_system', { type: 'vendor', id: null }, `Imported ${made} vendor${made === 1 ? '' : 's'} from the system`);
    showToast(`${made} vendor${made === 1 ? '' : 's'} imported from the system.`);
    S.sel = new Set();
    if (typeof renderVendorsPage === 'function') renderVendorsPage();
    if (window.LowStock && LowStock.reload) LowStock.reload();
    paint();
  }
  window.VendorImport = { open };
})();
