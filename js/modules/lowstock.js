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
  // the system's POs of the week (owner, 2026-10-11; migration 082, lv-dashboard po_sync every 30 minutes): an item
  // on a PO of the last 7 days not received yet (no PU of it since the PO's day) is flagged with the PO, its day and
  // the quantity ordered; amber once the PO is more than 4 days old. Out of stock and on no PO = "No PO".
  const dm = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const keyOf = c => String(c || '').trim().replace(/^0+(?=\d)/, '').toUpperCase();
  S.po = undefined; S.poAt = 0; S.poSeen = null;
  async function loadPOs(force) {
    if (!force && S.poAt && Date.now() - S.poAt < 5 * 60e3) return;
    const weekAgo = addDaysStr(todayStr(), -7), m = new Map();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('system_po_lines').select('po, po_date, code, qty, supplier_name').is('received_on', null).is('po_delivered_on', null).gte('po_date', weekAgo)
        .order('po_date', { ascending: false }).range(from, from + 999);
      if (error) { S.po = null; S.poAt = Date.now(); return; }   // migration 082 not run yet: no flag at all
      (data || []).forEach(l => { const k = keyOf(l.code); if (!m.has(k)) m.set(k, []); m.get(k).push(l); });
      if ((data || []).length < 1000) break;
    }
    const { data: last } = await sb.from('system_pos').select('seen_at').order('seen_at', { ascending: false }).limit(1);
    S.po = m; S.poAt = Date.now(); S.poSeen = last?.[0]?.seen_at || null;
    await loadNotAvail();
  }
  // not delivered (owner, 2026-10-11): the supplier delivered the PO but not these items (no PU of them since), the last
  // 30 days; "Not available" = still out of stock (or not read yet), to ask the supplier
  async function loadNotAvail() {
    const { data, error } = await sb.from('system_po_lines').select('po, po_date, code, description, qty, supplier_code, supplier_name, po_delivered_on, stock_now, stock_read_at')
      .is('received_on', null).not('po_delivered_on', 'is', null).gte('po_date', addDaysStr(todayStr(), -30)).order('po_delivered_on', { ascending: false }).limit(2000);
    S.na = error ? null : (data || []);
    S.naMap = new Map(); (S.na || []).forEach(l => { const k = keyOf(l.code); if (!S.naMap.has(k)) S.naMap.set(k, l); });
  }
  const notAvailable = () => (S.na || []).filter(l => l.stock_now === null || Number(l.stock_now) <= 0);
  const onPO = code => !!(S.po && (S.po.get(keyOf(code)) || []).length);
  function poFlag(code, out) {
    if (!S.po) return '';
    const ls = S.po.get(keyOf(code)) || [];
    if (ls.length) {
      const l = ls[0], qty = ls.reduce((s, x) => s + Number(x.qty || 0), 0), age = daysSince(l.po_date);
      const tip = ls.map(x => `${x.po} of ${dm(x.po_date)}: ${fq(x.qty)} ordered${x.supplier_name ? ' from ' + x.supplier_name : ''}`).join('\n') + `\nNot received yet${age > 4 ? ` (${age} days)` : ''}`;
      return `<span class="ls-po ${age > 4 ? 'draft' : 'ok'}" title="${esc(tip)}">${esc(l.po)} · ${dm(l.po_date)} · ${fq(qty)}</span>`;
    }
    const na = out && S.naMap && S.naMap.get(keyOf(code));
    if (na) return `<span class="ls-po late" title="${esc(`${na.po} of ${dm(na.po_date)}: ${fq(na.qty)} ordered. The supplier delivered on ${dm(na.po_delivered_on)} without this item. Ask the supplier (Stock control › Not available).`)}">Not delivered · ${esc(na.po)}</span>`;
    return out ? '<span class="ls-po none" title="Out of stock and on no PO of the week">No PO</span>' : '';
  }

  /* ---------------- Not available tab: ordered, the PO delivered without them, still out of stock ---------------- */
  async function renderNotAvailable() {
    const box = el('scNotAvailView'); if (!box) return;
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>';
    S.poAt = 0; await loadPOs();
    if (S.po === null || S.na === null) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Not set up yet: run migration 082 and deploy lv-dashboard.</p></div>'; return; }
    const list = notAvailable(), groups = new Map();
    list.forEach(l => { const k = l.supplier_name || 'Unknown supplier'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); });
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    box.innerHTML = `<div class="card ls-intro"><p style="margin:0;">Items <b>ordered on a PO</b>, the supplier <b>delivered the PO without them</b> (no PU of the item since), and they are <b>still out of stock</b>. Ask the supplier about them. The last 30 days; an item leaves the list when it comes in.</p>
        <p class="ls-ponote">${poNote()}</p></div>
      ${ordered.length ? ordered.map(([sup, ls], gi) => `<section class="card ls-vendor"><div class="ls-head"><div><h3>${esc(sup)} <span class="ls-po late">${ls.length} not available</span></h3>
          <span class="muted-note">${[...new Set(ls.map(l => l.po))].map(esc).join(', ')}</span></div>
          <button type="button" class="btn ghost small" data-na-copy="${gi}" title="Copy the list to send it to the supplier">Copy for the supplier</button></div>
        <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Code</th><th>Item</th><th>PO</th><th>Ordered</th><th class="num">Qty</th><th>PO delivered</th><th class="num">Stock</th><th class="num">Waiting</th></tr></thead>
        <tbody>${ls.map(l => `<tr data-ls-code="${esc(l.code)}"><td class="mono">${esc(l.code)}</td><td>${esc(l.description || '')}</td><td class="mono">${esc(l.po)}</td><td>${dm(l.po_date)}</td><td class="num">${fq(l.qty)}</td>
          <td>${dm(l.po_delivered_on)}</td><td class="num">${l.stock_now === null ? '<span class="muted-note" title="Not read yet">…</span>' : `<span class="rc-zero">${fq(l.stock_now)}</span>`}</td>
          <td class="num"><b class="ls-urgent">${daysSince(l.po_delivered_on)}d</b></td></tr>`).join('')}</tbody></table></div></section>`).join('')
        : '<div class="card"><p class="muted-note" style="margin:0;">Nothing: every item ordered on a delivered PO came in, or is back in stock.</p></div>'}`;
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
    box.querySelectorAll('[data-na-copy]').forEach(b => b.onclick = async () => {
      const [sup, ls] = ordered[Number(b.dataset.naCopy)];
      const text = `${sup}: these items were ordered but not delivered. Are they available?\n` + ls.map(l => `- ${l.code} ${l.description || ''} × ${fq(l.qty)} (${l.po} of ${dm(l.po_date)})`).join('\n');
      try { await navigator.clipboard.writeText(text); showToast('Copied: paste it in WhatsApp or an email.'); } catch (e) { showToast('Could not copy on this device.', true); }
    });
    el('lsPoNow')?.addEventListener('click', e => poNow(e.currentTarget, renderNotAvailable));
  }
  const poNote = () => S.po === null ? '<span class="muted-note">POs: run migration 082.</span>'
    : `<span class="muted-note">POs of the week from the system${S.poSeen ? ', ' + esc(ago(S.poSeen).replace('checked', 'read')) : ''}</span>${isAdmin() ? ' <button type="button" class="btn ghost small" id="lsPoNow">Read the POs now</button>' : ''}`;
  async function poNow(btn, after) {
    btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'po_sync_now' } });
      if (error || data?.error) throw new Error(data?.error || 'failed');
      showToast(`${data.pos} PO${data.pos === 1 ? '' : 's'} of the week read · ${data.openLines} item line${data.openLines === 1 ? '' : 's'} not received yet.`);
    } catch (e) { showToast('The POs could not be read' + (e.message && e.message !== 'failed' ? ': ' + e.message : '') + '.', true); }
    await loadPOs(true); after();
  }

  // big purchases (migration 071): far above the item's usual order, more than 6 weeks of sales; the last 14 days
  async function loadBig() {
    const from = new Date(Date.now() - 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const { data, error } = await sb.from('big_purchases').select('*').gte('day', from).order('day', { ascending: false });
    S.big = error ? null : (data || []).filter(b => b.weeks_cover === null || Number(b.weeks_cover) >= 6);
  }
  function bigHtml() {
    if (!S.big || !S.big.length) return '';
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Top purchases</h3><span class="muted-note">bought at least 3 times the item's usual order, more than 6 weeks of sales · the last 14 days</span></div></div>
      <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Day</th><th>PU</th><th>Supplier</th><th>Code</th><th>Item</th><th class="num">Bought</th><th class="num">Usually</th><th class="num">Sells / week</th><th class="num">Weeks of sales</th></tr></thead>
      <tbody>${S.big.map(b => `<tr data-ls-code="${esc(b.code)}"><td>${esc(dmy(b.day))}</td><td class="mono">${esc(b.documents || '')}</td><td>${esc(b.supplier || '')}</td><td class="mono">${esc(b.code)}</td><td>${esc(b.description || '')}</td>
        <td class="num"><b>${fq(b.qty)}</b></td><td class="num" title="The middle quantity of its ${b.times} purchase days in the 12 months before">${fq(b.usual_qty)}</td><td class="num">${fq(b.weekly_sales)}</td>
        <td class="num"><b class="ls-urgent">${b.weeks_cover === null ? 'no sales' : fq(b.weeks_cover)}</b></td></tr>`).join('')}</tbody></table></div></section>`;
  }

  // top sales (migrations 073, 074): items selling more than they used to, per day / week / month, the latest daily run,
  // per supplier; the ones that may run out soon are marked (attention) and come first
  const TOP_VIEWS = {
    day:   { label: 'Day',   span: 'Yesterday',    usual: 'Usually / day',   note: 'yesterday against the daily average of the 4 weeks before (at least 2×)' },
    week:  { label: 'Week',  span: 'Last 7 days',  usual: 'Usually / week',  note: 'the last 7 days against the weekly average of the 8 weeks before (at least 1.5×)' },
    month: { label: 'Month', span: 'Last 30 days', usual: 'Usually / month', note: 'the last 30 days against the monthly average of the 3 months before (at least 1.3×)' },
  };
  S.topPeriod = 'week'; S.topRisk = false;
  async function loadTop() {
    const { data, error } = await sb.from('top_sales').select('*').order('week_end', { ascending: false }).order('sold_week', { ascending: false }).limit(1000);
    if (error) { S.top = null; return; }
    const wk = data?.[0]?.week_end;
    S.top = (data || []).filter(t => t.week_end === wk);
  }
  const refreshBtn = () => isAdmin() ? `<button type="button" class="icon-btn" id="lsTopNow" title="Recount now" aria-label="Recount now"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>` : '';
  function topHtml() {
    if (!S.top) return '';   // table not there yet (migration 073 / 074 not run)
    if (!S.top.length) return isAdmin() ? `<section class="card ls-big"><div class="ls-head"><div><h3>Selling more than usual</h3><span class="muted-note">Nothing counted yet: it runs every morning, or press the button.</span></div>${refreshBtn()}</div></section>` : '';
    const v = TOP_VIEWS[S.topPeriod], all = S.top.filter(t => t.period === S.topPeriod);
    const nAttn = all.filter(t => t.attention).length, list = S.topRisk ? all.filter(t => t.attention) : all;
    const groups = new Map();
    list.forEach(t => { const k = t.supplier || 'No vendor linked'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    // a supplier with something to order first, then by its biggest gain
    const ordered = [...groups.entries()].map(([sup, l]) => [sup, l.slice().sort((a, b) => (b.attention - a.attention) || (Number(b.sold_week) - Number(b.usual_week)) - (Number(a.sold_week) - Number(a.usual_week)))])
      .sort((a, b) => (b[1].filter(x => x.attention).length - a[1].filter(x => x.attention).length) || a[0].localeCompare(b[0]));
    const days = n => n === null ? '<span class="muted-note">—</span>' : `<b class="${Number(n) < 3 ? 'ls-urgent' : 'ls-soon'}">${fq(n)}</b>`;
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Selling more than usual</h3><span class="muted-note">${esc(v.note)} · ${esc(dmy(S.top[0].week_end))}</span></div>${refreshBtn()}</div>
      <div class="filter-row" id="lsTopPeriods" style="margin:8px 0;">${Object.entries(TOP_VIEWS).map(([id, x]) => `<button type="button" data-lsp="${id}" class="${id === S.topPeriod ? 'active' : ''}">${x.label} <span class="muted-note">${S.top.filter(t => t.period === id).length}</span></button>`).join('')}
        <button type="button" id="lsTopRisk" class="${S.topRisk ? 'active' : ''}" title="Only the items that may run out soon">⚠ May run out <span class="muted-note">${nAttn}</span></button></div>
      ${ordered.length ? ordered.map(([sup, l]) => `<h4 style="margin:10px 0 4px;">${esc(sup)} <span class="muted-note">${l.length} item${l.length === 1 ? '' : 's'}${l.some(x => x.attention) ? ` · <b class="ls-urgent">${l.filter(x => x.attention).length} to order</b>` : ''}</span></h4>
      <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th></th><th>Code</th><th>Item</th><th class="num">${esc(v.span)}</th><th class="num">${esc(v.usual)}</th><th class="num">Times</th><th class="num">Stock</th><th class="num">Days left</th></tr></thead>
      <tbody>${l.map(t => { const po = t.attention && onPO(t.code); return `<tr data-ls-code="${esc(t.code)}"${t.attention && !po ? ' style="background:rgba(214,69,69,.08)"' : ''}><td>${po ? poFlag(t.code, false) : t.attention ? '<span class="badge" title="May run out soon: order again (on no PO of the week)" style="color:#b42318;font-weight:700;">⚠ Order</span>' : ''}</td><td class="mono">${esc(t.code)}</td><td>${esc(t.description || '')}</td>
        <td class="num"><b>${fq(t.sold_week)}</b></td><td class="num">${fq(t.usual_week)}</td><td class="num">${fq(t.ratio)}×</td>
        <td class="num">${t.stock === null ? '<span class="muted-note">—</span>' : Number(t.stock) <= 0 ? '<span class="rc-zero">0</span>' : fq(t.stock)}</td>
        <td class="num">${days(t.days_left)}</td></tr>`; }).join('')}</tbody></table></div>`).join('')
        : `<p class="muted-note" style="margin:8px 0 0;">${S.topRisk ? 'None of these may run out soon.' : 'Nothing selling more than usual in this view.'}</p>`}
      <p class="muted-note" style="margin:8px 0 0;">⚠ Order = out of stock, or fewer days of stock than the vendor needs to be re-supplied (its cover days, default 7) at the item's selling rate, and on no PO of the week. A PO number instead = already ordered in the system, not received yet. Double-click an item for its details.</p></section>`;
  }

  async function render() {
    const box = el('vendorLowStockView'); if (!box) return;
    if (!S.loaded) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>'; await load(); }
    await loadPOs();
    const watched = vendorsList.filter(v => v.watchStock);
    const byV = new Map(); S.alerts.forEach(a => { if (!byV.has(a.vendor_id)) byV.set(a.vendor_id, []); byV.get(a.vendor_id).push(a); });
    box.innerHTML = `
      <div class="card ls-intro"><p style="margin:0;">Items of the suppliers you watch that are <b>running low</b>, from the system. Only items that sold in the last 30 days are followed. ${watched.length
        ? `<b>${watched.length}</b> supplier${watched.length === 1 ? '' : 's'} watched.` : 'No supplier is watched yet: edit a vendor in the Directory and tick <b>Watch stock</b>.'}</p>
        <p class="ls-ponote">${poNote()}</p></div>
      ${watched.map(v => {
        const all = byV.get(v.id) || [], list = all.filter(a => !a.doubtful), wrong = all.filter(a => a.doubtful);
        const noPo = S.po ? list.filter(a => Number(a.stock) <= 0 && !onPO(a.code)).length : 0;
        return `<section class="card ls-vendor">
          <div class="ls-head"><div><h3>${esc(v.name)}${noPo ? ` <span class="ls-po none" title="Out of stock and on no PO of the week">${noPo} out, no PO</span>` : ''}</h3><span class="muted-note">${esc((v.systemSuppliers || []).map(s => s.name).join(', ') || 'no supplier linked')} · keep ${v.coverDays || ((v.leadTimeDays || 3) + 4)} days of stock · ${esc(ago(v.stockCheckedAt))}</span></div>
            ${isAdmin() ? `<button type="button" class="icon-btn" data-ls-check="${esc(v.id)}" title="Check now" aria-label="Check now"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>` : ''}</div>
          ${list.length ? `<div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Sells / week</th><th class="num">Days left</th><th>Order</th><th>Last PU</th><th class="num">Sold since</th><th>Since</th></tr></thead>
            <tbody>${list.map(a => `<tr data-ls-code="${esc(a.code)}" class="${S.po && Number(a.stock) <= 0 && !onPO(a.code) ? 'ls-nopo' : ''}"><td class="mono">${esc(a.code)}</td><td>${esc(a.description || '')}</td>
              <td class="num">${Number(a.stock) <= 0 ? '<span class="rc-zero">0</span>' : fq(a.stock)}</td><td class="num">${fq(Number(a.per_day) * 7)}</td>
              <td class="num"><b class="${a.days_left === null || Number(a.stock) <= 0 || Number(a.days_left) < 3 ? 'ls-urgent' : 'ls-soon'}">${a.days_left === null || Number(a.stock) <= 0 ? 'out' : fq(a.days_left)}</b></td>
              <td>${poFlag(a.code, Number(a.stock) <= 0)}</td>
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
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
    el('lsPoNow')?.addEventListener('click', e => poNow(e.currentTarget, render));
  }

  /* ---------------- Top purchases tab: the big purchases (migration 071) ---------------- */
  async function renderTopPurchases() {
    const box = el('vendorTopPurchasesView'); if (!box) return;
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>';
    await loadBig();
    box.innerHTML = S.big === null ? '<div class="card"><p class="muted-note" style="margin:0;">Could not be read.</p></div>'
      : S.big.length ? bigHtml() : '<div class="card"><p class="muted-note" style="margin:0;">No big purchase in the last 14 days.</p></div>';
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
  }

  /* ---------------- Top sales tab (migration 073): selling more than they used to ---------------- */
  async function renderTopSales() {
    const box = el('vendorTopSalesView'); if (!box) return;
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>';
    await Promise.all([loadTop(), loadPOs()]);
    paintTopSales();
  }
  function paintTopSales() {
    const box = el('vendorTopSalesView'); if (!box) return;
    box.innerHTML = topHtml() || '<div class="card"><p class="muted-note" style="margin:0;">Nothing selling more than usual yet. It is counted every morning.</p></div>';
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
    box.querySelectorAll('[data-lsp]').forEach(b => b.onclick = () => { S.topPeriod = b.dataset.lsp; paintTopSales(); });
    el('lsTopRisk')?.addEventListener('click', () => { S.topRisk = !S.topRisk; paintTopSales(); });
    el('lsTopNow')?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        // one period per call (the store is big): day, week, month, one after the other
        let flagged = 0, attention = 0;
        for (const period of ['day', 'week', 'month']) {
          b.title = `Counting the ${period}…`;
          const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'top_sales_now', period } });
          let msg = data?.error || '';
          if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (e) { msg = error.message || ''; } }
          if (msg || error || !data) throw new Error(`${period}: ${msg || 'no answer'}`);
          flagged += data.flagged; attention += data.attention;
        }
        showToast(`${flagged} selling more than usual (${attention} may run out soon).`);
      } catch (err) { console.warn('top sales', err); showToast(err.message && err.message !== 'no answer' ? err.message : 'The system did not answer.', true); }
      renderTopSales();
    });
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

  window.LowStock = { render, renderNotAvailable, loadPOs, onPO, poFlag, notAvailable, wireForm, readForm, openCount, renderTopPurchases, renderTopSales, reload: async () => { await load(); } };
})();
