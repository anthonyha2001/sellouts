/* ============================================================
   Vendors › Purchase order (owner, 2026-10-06): for a supplier, from the
   system (lv-dashboard po_data), per item:
     code, description, barcode, stock now, units sold in the period,
     average per day and per month, the last purchase (date, quantity with
     its free units, price — the trade deal named, with its real cost),
     a suggested quantity and the quantity to order (yours).
   The selling rate (owner, 2026-10-06): units sold since the item's last
   purchase / days since it (the period's average when that purchase is less
   than 7 days old or unknown). Days left = stock / that rate.
   Suggested = what sells in the days to cover (default: the vendor's
   order cycle + lead time) minus the stock, rounded up to full packs.
   Low stock: stock at 0 while selling, or fewer days of stock than the
   vendor's "days of stock to keep" (default lead + 4).
   Overstock: more than a month of stock (or stock that does not sell); an
   order that would bring the stock over a month is flagged on its box.
   Items listed by their group (the system's Group).
   Excel (the PO), print, and "Log the order" (Orders, not sent yet).
   Public API: window.PurchaseOrder = { open({ vendor?, suppliers?, name? }) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const r1 = v => Math.round(n(v) * 10) / 10;
  const fq = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US');
  const f3 = v => v === null || v === undefined ? '—' : (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const money = v => '$' + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : '—'; };   // dd-mm-yyyy (the owner's format)
  const addDays = (s, k) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA'); };

  function open({ vendor = null, suppliers = null, name = '' } = {}) {
    const sups = suppliers || vendor?.systemSuppliers || [];
    const title = name || vendor?.name || sups.map(s => s.name).join(', ');
    const lead = n(vendor?.leadTimeDays) || 3, cycle = (n(vendor?.frequencyWeeks) || 1) * 7;
    const S = { from: addDays(todayStr(), -29), to: todayStr(), orderDays: cycle + lead, lowDays: n(vendor?.coverDays) || lead + 4, overDays: 30, only: 'low', data: null, qty: new Map(), busy: false };
    document.getElementById('poOverlay')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="poOverlay"><div class="modal-box po-box" role="dialog" aria-modal="true">
      <div class="po-head"><div><h3>Purchase order — ${esc(title)}</h3><p class="muted-note">${esc(sups.map(s => s.name).join(' · ') || 'no supplier in the system linked')} · Ajaltoun · from the system</p></div>
        <button type="button" class="icon-btn" data-po="close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="po-controls">
        <label>Sales from <input type="date" id="poFrom" value="${S.from}"></label>
        <label>to <input type="date" id="poTo" value="${S.to}"></label>
        <div class="filter-row" id="poQuick" style="margin:0;">${[30, 60, 90].map(d => `<button type="button" data-d="${d}" class="${d === 30 ? 'active' : ''}">${d} days</button>`).join('')}</div>
        <label title="The suggested quantity covers this many days of sales">Order for <input type="text" inputmode="numeric" id="poDays" value="${S.orderDays}" style="width:56px;"> days</label>
        <button type="button" class="btn small" id="poLoad">Load</button>
        <span style="flex:1"></span>
        <div class="filter-row" id="poOnly" style="margin:0;"><button type="button" data-o="low" class="active">Low stock</button><button type="button" data-o="over">Overstock</button><button type="button" data-o="all">All items</button></div>
      </div>
      <div id="poBody"></div>
      <div class="po-foot"><span id="poTotal" class="muted-note"></span><span style="flex:1"></span>
        <button type="button" class="icon-btn po-ib" id="poPrint" title="Print" aria-label="Print"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2"/><rect x="6" y="14" width="12" height="7"/></svg></button>
        <button type="button" class="btn secondary" id="poExcel">Download the PO (Excel)</button>
        ${vendor?.id && can('vendors.manage') ? '<button type="button" class="btn" id="poLog">Log the order</button>' : ''}</div>
    </div></div>`);
    const ov = document.getElementById('poOverlay'), $ = id => document.getElementById(id);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape' && !e.target.closest('input')) close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-po="close"]')) close(); });

    const rowsOf = () => {
      if (!S.data) return [];
      const days = Math.max(1, S.data.days);
      return S.data.items.map(it => {
        const periodDay = n(it.sold) / days, stock = it.stock === null || it.stock === undefined ? null : n(it.stock);
        // the rate since the last purchase (what came in and what went out since), else the period's
        const sinceDays = it.sinceFrom ? Math.round((new Date((S.data.today || todayStr()) + 'T00:00:00') - new Date(it.sinceFrom + 'T00:00:00')) / 864e5) + 1 : 0;
        const bySince = it.soldSinceLast !== null && it.soldSinceLast !== undefined && sinceDays >= 7;
        const perDay = bySince ? n(it.soldSinceLast) / sinceDays : periodDay;
        const daysLeft = perDay > 0 && stock !== null ? Math.max(0, stock) / perDay : null;   // a negative stock (the system can go below 0) counts as 0
        const low = perDay > 0 && stock !== null && (stock <= 0 || daysLeft < S.lowDays);
        const over = stock !== null && stock > 0 && (perDay > 0 ? daysLeft > S.overDays : true);
        const pack = n(it.pack) > 1 ? n(it.pack) : 1;
        let sug = perDay > 0 && stock !== null ? Math.max(0, Math.ceil(perDay * S.orderDays - Math.max(0, stock))) : 0;
        if (sug && pack > 1) sug = Math.ceil(sug / pack) * pack;
        // the last purchase: that day's documents together
        const docs = it.last?.docs || [];
        const paidQty = docs.reduce((t, d) => t + n(d.paidQty), 0), freeQty = docs.reduce((t, d) => t + n(d.freeQty), 0), paid = docs.reduce((t, d) => t + n(d.paid), 0);
        const deal = docs.some(d => d.tradeDeal);
        const unitNet = docs.flatMap(d => d.lines).find(l => !l.free)?.net ?? null;
        const real = paidQty + freeQty > 0 ? paid / (paidQty + freeQty) : null;
        return { ...it, perDay, periodDay, perMonth: periodDay * 30, bySince, sinceDays, daysLeft, low, over, pack, sug, grp: String(it.group || '').trim() || 'No group', lastDate: it.last?.date || null, paidQty, freeQty, deal, unitNet, real,
          docs: docs.map(d => d.doc).join(', '), dealText: deal ? docs.filter(d => d.tradeDeal).map(d => d.lines.map(l => l.free ? `${fq(l.qty)} free` : `${fq(l.qty)} @ ${f3(l.net)}`).join(' + ')).join('; ') : '' };
      }).sort((a, b) => (a.grp === 'No group') - (b.grp === 'No group') || a.grp.localeCompare(b.grp) || (b.low - a.low) || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) || b.sold - a.sold);
    };
    const orderOf = r => S.qty.has(r.code) ? S.qty.get(r.code) : r.sug;
    // an order that brings the stock over a month of sales (or orders an item that does not sell)
    const overOrder = r => { const q = orderOf(r); if (!(q > 0)) return null; if (!(r.perDay > 0)) return 'This item does not sell'; const d = (Math.max(0, n(r.stock)) + q) / r.perDay; return d > S.overDays ? `Stock + order = ${Math.round(d)} days of sales (over a month)` : null; };
    const flagBox = (i, r) => { const w = overOrder(r); i.classList.toggle('po-qty-over', !!w); i.title = w || ''; const tag = i.parentElement.querySelector('.po-over-tag'); if (tag) tag.hidden = !w; };
    const paintTotal = () => {
      const rows = rowsOf().filter(r => orderOf(r) > 0);
      const units = rows.reduce((t, r) => t + orderOf(r), 0), value = rows.reduce((t, r) => t + orderOf(r) * n(r.unitNet ?? r.real), 0);
      const hidden = S.only === 'low' ? rows.filter(r => !r.low).length : 0, overs = rows.filter(r => overOrder(r)).length;
      $('poTotal').innerHTML = rows.length ? `<b>${rows.length}</b> item${rows.length === 1 ? '' : 's'} to order${hidden ? ` (${hidden} not low, under All items)` : ''} · <b>${fq(units)}</b> units · about <b>${money(value)}</b> at the last purchase price${overs ? ` · <b class="po-over-txt">${overs} over a month of stock</b>` : ''}` : 'Nothing to order yet.';
    };
    const draw = () => {
      if (!S.data) return;
      const all = rowsOf(), shown = S.only === 'low' ? all.filter(r => r.low) : S.only === 'over' ? all.filter(r => r.over) : all, low = all.filter(r => r.low).length, over = all.filter(r => r.over).length;
      const gCount = new Map(); shown.forEach(r => { const g = gCount.get(r.grp) || { n: 0, low: 0, over: 0 }; g.n++; g.low += r.low; g.over += r.over; gCount.set(r.grp, g); });
      let lastG = null;
      $('poBody').innerHTML = `
        <p class="po-sum">${S.data.items.length} item${S.data.items.length === 1 ? '' : 's'} of the supplier · <b class="${low ? 'po-low' : ''}">${low} low on stock</b> (less than ${S.lowDays} days left) · <b class="${over ? 'po-over-txt' : ''}">${over} overstocked</b> (over a month) · sales over ${S.data.days} days, ${esc(day(S.data.from))} → ${esc(day(S.data.to))}</p>
        <div class="items-scroll po-scroll"><table class="items po-table"><thead><tr>
          <th>Code</th><th>Description</th><th class="num">Qty to order</th><th class="num">Qty available</th><th class="num">Sales (period)</th><th class="num">Sales / month</th>
          <th>Last PU date</th><th class="num">Last PU qty</th><th>Barcode</th><th class="num">Avg / day</th><th class="num">PU price</th><th class="num" title="Units sold since the last purchase, and the daily rate used for the days left">Sold since PU</th><th class="num">Suggested</th></tr></thead>
          <tbody>${shown.map(r => { const g = r.grp !== lastG ? (lastG = r.grp, gCount.get(r.grp)) : null; return (g ? `<tr class="po-group"><td colspan="13">${esc(r.grp)} <span>· ${g.n} item${g.n === 1 ? '' : 's'}${g.low ? ` · ${g.low} low` : ''}${g.over ? ` · ${g.over} overstock` : ''}</span></td></tr>` : '') + `<tr class="${r.low ? 'po-row-low' : r.over ? 'po-row-over' : ''}" data-po-code="${esc(r.code)}">
            <td class="mono">${esc(r.code)}</td><td>${esc(r.description)}${r.pack > 1 ? ` <span class="muted-note">· pack ${r.pack}</span>` : ''}</td>
            <td class="num"><input type="text" inputmode="numeric" class="po-qty" data-q="${esc(r.code)}" value="${orderOf(r) || ''}" placeholder="0" aria-label="Quantity to order"><div class="po-sub po-over-txt po-over-tag" hidden>over a month</div></td>
            <td class="num">${r.stock === null || r.stock === undefined ? '—' : n(r.stock) <= 0 ? `<span class="rc-zero">${fq(r.stock)}</span>` : fq(r.stock)}${n(r.stock) <= 0 && r.perDay > 0 ? '<div class="po-sub po-low">out</div>' : r.daysLeft !== null ? `<div class="po-sub${r.over ? ' po-over-txt' : ''}">${r1(r.daysLeft)} days${r.over ? ' · overstock' : ''}</div>` : r.over ? '<div class="po-sub po-over-txt">not selling</div>' : ''}</td>
            <td class="num">${fq(r.sold)}</td><td class="num">${fq(r.perMonth)}</td>
            <td class="mono">${esc(day(r.lastDate))}${r.docs ? `<div class="po-sub">${esc(r.docs)}</div>` : ''}</td>
            <td class="num">${r.lastDate ? fq(r.paidQty) + (r.freeQty ? ` <span class="po-free">+ ${fq(r.freeQty)} free</span>` : '') : '—'}</td>
            <td class="mono po-bc">${esc(r.barcode || '')}</td><td class="num">${fq(r.periodDay)}</td>
            <td class="num">${r.lastDate ? f3(r.unitNet) : '—'}${r.deal ? `<div class="po-sub"><span class="lp-deal">trade deal</span> real ${f3(r.real)}</div>` : ''}</td>
            <td class="num">${r.soldSinceLast === null || r.soldSinceLast === undefined ? '—' : fq(r.soldSinceLast)}<div class="po-sub">${r.bySince ? `in ${r.sinceDays} d · ${fq(r.perDay)}/day` : r.sinceFrom ? 'PU too recent' : ''}</div></td>
            <td class="num">${r.sug ? fq(r.sug) : ''}</td></tr>`; }).join('')
            || `<tr><td colspan="13" class="empty-note">${S.only === 'low' ? 'Nothing is low on stock. Press "All items" to order anyway.' : S.only === 'over' ? 'Nothing is overstocked.' : 'No item.'}</td></tr>`}</tbody></table></div>
        <p class="muted-note" style="margin:6px 0 0;">Days left = stock / what sold per day since the last purchase (the period's average when that purchase is under 7 days old). Suggested = ${S.orderDays} days of sales minus the stock, in full packs. Type your quantity in Qty to order: it is flagged when stock + order is over a month of sales. Double-click an item for its details.</p>`;
      $('poBody').querySelectorAll('[data-q]').forEach(i => {
        i.onfocus = () => i.select();
        const row = rowsOf().find(r => r.code === i.dataset.q); if (row) flagBox(i, row);
        i.oninput = () => { const v = Math.max(0, Math.round(n(i.value.replace(/[^\d.]/g, '')))); S.qty.set(i.dataset.q, v); if (row) flagBox(i, row); paintTotal(); };
        i.onkeydown = e => { if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); const all = [...$('poBody').querySelectorAll('[data-q]')]; all[all.indexOf(i) + 1]?.focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); const all = [...$('poBody').querySelectorAll('[data-q]')]; all[all.indexOf(i) - 1]?.focus(); } };
      });
      $('poBody').querySelectorAll('tr[data-po-code]').forEach(tr => tr.ondblclick = e => { if (!e.target.closest('input') && window.ItemDetail) ItemDetail.open(tr.dataset.poCode); });
      paintTotal();
    };
    const load = async () => {
      if (!sups.length) { $('poBody').innerHTML = '<p class="login-err">Link this vendor to its supplier in the system first (Directory › edit the vendor › Watch stock › Supplier in the system).</p>'; return; }
      S.from = $('poFrom').value || S.from; S.to = $('poTo').value || S.to;
      S.orderDays = Math.max(1, Math.round(n($('poDays').value)) || S.orderDays);
      $('poBody').innerHTML = '<p class="muted-note">Reading the supplier\'s items, their stock, sales and last purchases from the system… (about 15–40 seconds)</p>';
      $('poLoad').disabled = true;
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'po_data', suppliers: sups.map(s => s.code), from: S.from, to: S.to } });
        if (error || !data?.items) throw error || new Error('no answer');
        S.data = data; S.qty.clear(); draw();
      } catch (e) { $('poBody').innerHTML = '<p class="login-err">The system did not answer. Check the "Link to the system" card on the Dashboard.</p>'; }
      finally { $('poLoad').disabled = false; }
    };
    $('poQuick').onclick = e => { const b = e.target.closest('[data-d]'); if (!b) return; $('poQuick').querySelectorAll('[data-d]').forEach(x => x.classList.toggle('active', x === b)); $('poFrom').value = addDays(todayStr(), -(Number(b.dataset.d) - 1)); $('poTo').value = todayStr(); load(); };
    $('poLoad').onclick = load;
    $('poDays').onchange = () => { S.orderDays = Math.max(1, Math.round(n($('poDays').value)) || S.orderDays); S.qty.clear(); draw(); };
    $('poOnly').onclick = e => { const b = e.target.closest('[data-o]'); if (!b) return; S.only = b.dataset.o; $('poOnly').querySelectorAll('[data-o]').forEach(x => x.classList.toggle('active', x === b)); draw(); };

    const lines = () => rowsOf().filter(r => orderOf(r) > 0);
    $('poExcel').onclick = () => {
      if (!S.data) return;
      const L = lines();
      const aoa = [['Purchase order'], ['Supplier', title], ['Branch', 'Ajaltoun'], ['Date', day(todayStr())], ['Sales period', `${day(S.data.from)} to ${day(S.data.to)} (${S.data.days} days)`], [],
        ['Group', 'Code', 'Description', 'Qty to order', 'Qty available', 'Sales (period)', 'Sales / month', 'Last PU date', 'Last PU qty', 'Barcode', 'Free units', 'Pack', 'Days left', 'Avg / day', 'PU price', 'Trade deal', 'Real cost', 'Sold since PU', 'Suggested', 'Flag']];
      const first = aoa.length;
      (L.length ? L : rowsOf()).forEach(r => aoa.push([r.grp, r.code, r.description, orderOf(r), r.stock ?? '', r.sold, r1(r.perMonth), r.lastDate ? day(r.lastDate) : '', r.paidQty || '', r.barcode || '', r.freeQty || '', r.pack,
        r.daysLeft === null ? '' : r1(r.daysLeft), r1(r.periodDay), r.unitNet ?? '', r.dealText, r.real !== null ? Math.round(r.real * 1000) / 1000 : '', r.soldSinceLast ?? '', r.sug, [r.low ? 'Low stock' : r.over ? 'Overstock' : '', overOrder(r) ? 'Order over a month' : ''].filter(Boolean).join(', ')]));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      for (let i = first; i < aoa.length; i++) ['B', 'H', 'J'].forEach(c => { const ref = c + (i + 1); if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); } });
      ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 40 }, { wch: 11 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 11 }, { wch: 15 }, { wch: 9 }, { wch: 6 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 18 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 20 }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'PO');
      XLSX.writeFile(wb, `PO ${String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim()} ${todayStr()}.xlsx`);
      logActivity('vendors', 'po_export', vendor?.id ? { type: 'vendor', id: vendor.id } : null, `Purchase order for ${title}: ${L.length} items`);
    };
    $('poPrint').onclick = () => {
      const L = lines(); if (!L.length) return showToast('Put a quantity on at least one item.', true);
      const w = window.open('', '_blank'); if (!w) return showToast('Allow pop-ups to print.', true);
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>PO ${esc(title)}</title><style>body{font:13px Arial,sans-serif;margin:24px;color:#111}h2{margin:0 0 4px}p{margin:0 0 14px;color:#555}
        table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #ccc;padding:6px 8px;text-align:left}th{border-bottom:2px solid #333}.n{text-align:right}</style></head><body>
        <h2>Purchase order — ${esc(title)}</h2><p>La Valeur Ajaltoun · ${esc(day(todayStr()))} · ${L.length} items</p>
        <table><thead><tr><th>Code</th><th>Description</th><th class="n">Qty to order</th><th class="n">Qty available</th><th class="n">Sales (period)</th><th class="n">Sales / month</th><th>Last PU date</th><th class="n">Last PU qty</th><th>Barcode</th><th class="n">Last price</th></tr></thead><tbody>
        ${L.map((r, i) => (i === 0 || L[i - 1].grp !== r.grp ? `<tr><td colspan="10" style="padding-top:12px;font-weight:700;border-bottom:1px solid #333">${esc(r.grp)}</td></tr>` : '') + `<tr><td>${esc(r.code)}</td><td>${esc(r.description)}</td><td class="n"><b>${orderOf(r)}</b></td><td class="n">${r.stock ?? ''}</td><td class="n">${fq(r.sold)}</td><td class="n">${fq(r.perMonth)}</td><td>${r.lastDate ? day(r.lastDate) : ''}</td><td class="n">${r.paidQty ? fq(r.paidQty) + (r.freeQty ? ' + ' + fq(r.freeQty) : '') : ''}</td><td>${esc(r.barcode || '')}</td><td class="n">${f3(r.unitNet)}${r.deal ? ' (' + esc(r.dealText) + ')' : ''}</td></tr>`).join('')}
        </tbody></table></body></html>`);
      w.document.close(); w.focus(); w.print();
    };
    $('poLog')?.addEventListener('click', async () => {
      const L = lines(); if (!L.length) return showToast('Put a quantity on at least one item.', true);
      const o = { id: uid(), vendorId: vendor.id, vendorName: vendor.name, orderDate: todayStr(), leadTimeDays: vendor.leadTimeDays ?? null, expectedDelivery: null, status: 'not_sent', deliveredDate: null };
      if (!(await saveOrderRemote(o))) return;
      ordersList.unshift(o);
      logActivity('vendors', 'po_log', { type: 'vendor_order', id: o.id }, `Purchase order for ${vendor.name}: ${L.length} items, ${L.reduce((t, r) => t + orderOf(r), 0)} units`, { lines: L.map(r => ({ code: r.code, qty: orderOf(r) })) });
      showToast(`Logged in Orders (not sent yet). Download the PO to send it.`);
      if (typeof renderOrdersView === 'function') renderOrdersView();
      if (window.VendorCal) VendorCal.renderStats();
    });
    load();
  }
  window.PurchaseOrder = { open };
})();
