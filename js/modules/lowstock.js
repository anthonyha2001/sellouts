/* ============================================================
   Vendors › Low stock (owner, 2026-10-06; migration 066): the items of the
   watched suppliers that are running low, live from the system.
   Only items that sold in the last 30 days are followed (inactive items
   never show). Low = stock covers fewer days than the vendor needs (its
   "days of stock to keep", default lead time + 4) at the item's own daily
   sales, or stock at 0 while selling. Checked every 15 minutes from 07:00
   to 19:00 (the vendor checked longest ago each time); one notification a
   day per vendor when something newly ran low (push-alerts).
   Also: the vendor form's "Watch stock" part (supplier in the system).
   Public API: window.LowStock = { render, formHtml, wireForm, readForm, openCount }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const S = { alerts: [], loaded: false };
  const el = id => document.getElementById(id);
  const fq = v => (Math.round(Number(v) * 10) / 10).toLocaleString('en-US');
  const ago = iso => { if (!iso) return 'not checked yet'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 2 ? 'checked just now' : m < 60 ? `checked ${m} min ago` : m < 1440 ? `checked ${Math.round(m / 60)} h ago` : `checked ${Math.round(m / 1440)} d ago`; };

  async function load() {
    const { data, error } = await sb.from('stock_alerts').select('*').is('resolved_at', null).order('days_left', { ascending: true, nullsFirst: true });
    if (error) { console.warn('low stock', error); S.alerts = []; } else S.alerts = data || [];
    S.loaded = true;
  }
  const openCount = () => S.alerts.filter(a => !a.doubtful).length;   // a wrong count in the system is not low (migration 072)
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  // the last PU (12 months back) and the units sold from that day to today (owner, 2026-10-06; migration 071)
  function lastPuCells(a) {
    if (a.last_pu_state === 'ok') return `<td>${esc(dmy(a.last_pu_date))} <span class="muted-note">· ${fq(a.last_pu_qty)} unit${Number(a.last_pu_qty) === 1 ? '' : 's'}</span></td><td class="num">${fq(a.sold_since)}</td>`;
    const why = a.last_pu_state === 'none' ? 'no PU in 12 months' : a.last_pu_state === 'failed' ? 'could not be read' : 'at the next check';
    return `<td colspan="2" class="muted-note">${why}</td>`;
  }
  // big purchases (migration 071): far above the item's usual order, more than 6 weeks of sales; the last 14 days
  async function loadBig() {
    const from = new Date(Date.now() - 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const { data, error } = await sb.from('big_purchases').select('*').gte('day', from).order('day', { ascending: false });
    S.big = error ? null : (data || []).filter(b => b.weeks_cover === null || Number(b.weeks_cover) >= 6);
  }
  function bigHtml() {
    if (!S.big || !S.big.length) return '';
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Big purchases</h3><span class="muted-note">bought at least 3 times the item's usual order, more than 6 weeks of sales · the last 14 days</span></div></div>
      <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Day</th><th>PU</th><th>Supplier</th><th>Code</th><th>Item</th><th class="num">Bought</th><th class="num">Usually</th><th class="num">Sells / week</th><th class="num">Weeks of sales</th></tr></thead>
      <tbody>${S.big.map(b => `<tr data-ls-code="${esc(b.code)}"><td>${esc(dmy(b.day))}</td><td class="mono">${esc(b.documents || '')}</td><td>${esc(b.supplier || '')}</td><td class="mono">${esc(b.code)}</td><td>${esc(b.description || '')}</td>
        <td class="num"><b>${fq(b.qty)}</b></td><td class="num" title="The middle quantity of its ${b.times} purchase days in the 12 months before">${fq(b.usual_qty)}</td><td class="num">${fq(b.weekly_sales)}</td>
        <td class="num"><b class="ls-urgent">${b.weeks_cover === null ? 'no sales' : fq(b.weeks_cover)}</b></td></tr>`).join('')}</tbody></table></div></section>`;
  }

  async function render() {
    const box = el('vendorLowStockView'); if (!box) return;
    if (!S.loaded) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>'; await Promise.all([load(), loadBig()]); }
    const watched = vendorsList.filter(v => v.watchStock);
    const byV = new Map(); S.alerts.forEach(a => { if (!byV.has(a.vendor_id)) byV.set(a.vendor_id, []); byV.get(a.vendor_id).push(a); });
    box.innerHTML = `
      ${window.PurchaseOrder ? `<div class="card ls-po-start"><b>Purchase order</b> for any vendor:
        <select id="lsPoVendor"><option value="">Choose a vendor…</option>${vendorsList.slice().sort((a, b) => a.name.localeCompare(b.name)).map(v => `<option value="${esc(v.id)}">${esc(v.name)}${(v.systemSuppliers || []).length ? '' : ' (not linked)'}</option>`).join('')}</select>
        <button type="button" class="btn small" id="lsPoGo">Open</button></div>` : ''}
      <div class="card ls-intro"><p style="margin:0;">Items of the suppliers you watch that are <b>running low</b>, from the system. Only items that sold in the last 30 days are followed. ${watched.length
        ? `<b>${watched.length}</b> supplier${watched.length === 1 ? '' : 's'} watched.` : 'No supplier is watched yet: edit a vendor in the Directory and tick <b>Watch stock</b>.'}</p></div>
      ${bigHtml()}
      ${watched.map(v => {
        const all = byV.get(v.id) || [], list = all.filter(a => !a.doubtful), wrong = all.filter(a => a.doubtful);
        return `<section class="card ls-vendor">
          <div class="ls-head"><div><h3>${esc(v.name)}</h3><span class="muted-note">${esc((v.systemSuppliers || []).map(s => s.name).join(', ') || 'no supplier linked')} · keep ${v.coverDays || ((v.leadTimeDays || 3) + 4)} days of stock · ${esc(ago(v.stockCheckedAt))}</span></div>
            ${window.PurchaseOrder ? `<button type="button" class="btn small" data-ls-po="${esc(v.id)}">Purchase order</button>` : ''}
            ${isAdmin() ? `<button type="button" class="icon-btn" data-ls-check="${esc(v.id)}" title="Check now" aria-label="Check now"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>` : ''}</div>
          ${list.length ? `<div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Sells / week</th><th class="num">Days left</th><th>Last PU</th><th class="num">Sold since</th><th>Since</th></tr></thead>
            <tbody>${list.map(a => `<tr data-ls-code="${esc(a.code)}"><td class="mono">${esc(a.code)}</td><td>${esc(a.description || '')}</td>
              <td class="num">${Number(a.stock) <= 0 ? '<span class="rc-zero">0</span>' : fq(a.stock)}</td><td class="num">${fq(Number(a.per_day) * 7)}</td>
              <td class="num"><b class="${a.days_left === null || Number(a.stock) <= 0 || Number(a.days_left) < 3 ? 'ls-urgent' : 'ls-soon'}">${a.days_left === null || Number(a.stock) <= 0 ? 'out' : fq(a.days_left)}</b></td>
              ${lastPuCells(a)}
              <td class="muted-note">${esc(new Date(a.first_seen).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</td></tr>`).join('')}</tbody></table></div>`
            : '<p class="muted-note" style="margin:0;">Nothing running low.</p>'}
          ${wrong.length ? `<div class="ls-wrong"><h4>Stock in the system looks wrong: count it</h4>
            <p class="muted-note" style="margin:0 0 6px;">Not counted as running low: the stock is below 0 in the system (impossible on a shelf), or the last PU minus the sales since leaves more than the system shows (sold before being received, PU in cases and sales in pieces, or a count error). Count them and fix the stock in the system.</p>
            <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Code</th><th>Item</th><th class="num">In the system</th><th>Last PU</th><th class="num">Sold since</th><th class="num">Should be at least</th></tr></thead>
            <tbody>${wrong.map(a => `<tr data-ls-code="${esc(a.code)}"><td class="mono">${esc(a.code)}</td><td>${esc(a.description || '')}</td>
              <td class="num"><b class="ls-urgent">${fq(a.stock)}</b></td>${lastPuCells(a)}<td class="num" title="Bought at the last PU minus sold since (if the stock before that PU was not below 0)">${a.est_stock !== null && Number(a.est_stock) > Number(a.stock) ? '<b>' + fq(a.est_stock) + '</b>' : '<span class="muted-note">—</span>'}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        </section>`; }).join('')}
      <p class="muted-note" style="margin:6px 0 0;">Double-click an item for its details (stock in the branches, cardex).</p>`;
    box.querySelectorAll('[data-ls-check]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'stock_check_now', vendor: b.dataset.lsCheck } });
        if (error) throw error;
        const r = data?.checked?.[0];
        showToast(r ? `${r.vendor}: ${r.items} selling item${r.items === 1 ? '' : 's'} checked, ${r.low} running low.` : 'Checked.');
      } catch (e) { showToast('The system did not answer.', true); }
      await loadVendorsData(); await load(); render();
      if (window.VendorCal) VendorCal.renderStats();
    });
    box.querySelectorAll('[data-ls-po]').forEach(b => b.onclick = () => PurchaseOrder.open({ vendor: vendorsList.find(v => v.id === b.dataset.lsPo) }));
    el('lsPoGo')?.addEventListener('click', () => {
      const v = vendorsList.find(x => x.id === el('lsPoVendor').value);
      if (!v) return showToast('Choose a vendor.', true);
      if (!(v.systemSuppliers || []).length) return showToast(`Link ${v.name} to its supplier in the system first: Directory › edit › Watch stock › Supplier in the system.`, true);
      PurchaseOrder.open({ vendor: v });
    });
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
  }

  /* ---------------- the vendor form: Watch stock ---------------- */
  let picked = [];
  function wireForm(v) {
    picked = (v?.systemSuppliers || []).slice();
    const box = el('vendorWatchBox'); if (!box) return;
    el('vendorWatch').checked = !!v?.watchStock;
    el('vendorCover').value = v?.coverDays || '';
    el('vendorCover').placeholder = `default ${(v?.leadTimeDays || 3) + 4}`;
    const paintPicked = () => {
      el('vendorSysChosen').innerHTML = picked.map((s, i) => `<span class="ip-chip">${esc(s.name)}<button type="button" data-unpick="${i}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted-note">No supplier linked.</span>';
      el('vendorSysChosen').querySelectorAll('[data-unpick]').forEach(b => b.onclick = () => { picked.splice(Number(b.dataset.unpick), 1); paintPicked(); });
    };
    const sync = () => { box.querySelector('.vw-more').hidden = false; el('vendorCover').disabled = !el('vendorWatch').checked; };   // the supplier link serves purchase orders too
    el('vendorWatch').onchange = () => {
      sync();
      if (el('vendorWatch').checked && !picked.length && !el('vendorSysQ').value) { el('vendorSysQ').value = el('vendorName').value.trim().split(/\s+/)[0] || ''; search(); }
    };
    let t = null, seq = 0;
    const search = async () => {
      const my = ++seq, q = el('vendorSysQ').value.trim(), out = el('vendorSysOptions');
      if (!q) { out.innerHTML = ''; return; }
      out.innerHTML = '<span class="muted-note">Searching…</span>';
      try {
        const { data } = await sb.functions.invoke('lv-dashboard', { body: { action: 'filter_options', field: 'supplier', q } });
        if (my !== seq) return;
        out.innerHTML = (data?.options || []).slice(0, 12).map(o => `<button type="button" class="ip-opt" data-sys="${esc(o.code)}" data-name="${esc(o.name.trim())}">${esc(o.name.trim())} <span class="muted-note">${esc(o.code)}</span></button>`).join('') || '<span class="muted-note">Nothing found.</span>';
        out.querySelectorAll('[data-sys]').forEach(b => b.onclick = () => { if (!picked.some(p => p.code === b.dataset.sys)) picked.push({ code: b.dataset.sys, name: b.dataset.name }); paintPicked(); });
      } catch (e) { if (my === seq) out.innerHTML = '<span class="login-err">The system did not answer.</span>'; }
    };
    el('vendorSysQ').oninput = () => { clearTimeout(t); t = setTimeout(search, 300); };
    el('vendorSysOptions').innerHTML = ''; el('vendorSysQ').value = '';
    paintPicked(); sync();
  }
  function readForm() {
    const cover = Number(el('vendorCover')?.value || 0);
    return { watchStock: !!el('vendorWatch')?.checked && picked.length > 0, systemSuppliers: picked.slice(), coverDays: cover > 0 ? Math.round(cover) : null };   // the link is kept even when not watched (purchase orders use it)
  }

  window.LowStock = { render, wireForm, readForm, openCount, reload: async () => { await Promise.all([load(), loadBig()]); } };
})();
