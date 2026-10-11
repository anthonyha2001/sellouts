/* ============================================================
   Vendors › Receiving and the stats strip (owner, 2026-10-05; migration 062). The calendar was removed 2026-10-11.
   Calendar (month), two views:
     - Order days: who to order from each day (the vendor's day and
       frequency), and what happened: sent, not sent yet, no order,
       still to do, missed.
     - Deliveries: received, expected, late, and planned (a vendor's next
       order day + its lead time, before the order exists).
   Receiving (one day): the deliveries expected, the late ones and what was
   received; "Received" records how (complete / partial), the supplier's
   invoice number, a note, who and when.
   Uses the vendor page's data and helpers (js/app.js: vendorsList,
   ordersList, skipsList, isVendorDueOn, saveOrderRemote).
   Rights: vendors.manage = everything; vendors.receive = the deliveries
   receiving page only.
   Public API: window.VendorCal = { renderCalendar, renderReceiving, renderStats, openReceiving }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { month: todayStr().slice(0, 7), mode: 'orders', day: todayStr(), open: null };
  const canManage = () => can('vendors.manage');
  const vendorOf = id => vendorsList.find(v => v.id === id) || null;
  const lead = v => (v && v.leadTimeDays !== null && v.leadTimeDays !== undefined && v.leadTimeDays !== '') ? Number(v.leadTimeDays) : null;
  const dayName = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
  const nice = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const short = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
  const phoneLink = p => p ? `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}" class="vc-tel">${esc(p)}</a>` : '';
  const ICON = {
    prev: '<path d="M15 18l-6-6 6-6"/>', next: '<path d="M9 18l6-6-6-6"/>', check: '<path d="M20 6 9 17l-5-5"/>',
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/>',
  };
  const svg = k => `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

  /* ---------------- what each day holds ---------------- */
  function ordersOn(d) {
    const t = todayStr(), out = [];
    vendorsList.forEach(v => {
      if (!isVendorDueOn(v, d)) return;
      const o = ordersList.find(x => x.vendorId === v.id && x.orderDate === d);
      const skip = skipsList.find(s => s.vendorId === v.id && s.skipDate === d);
      const st = o ? (o.status === 'not_sent' ? 'notsent' : 'sent') : skip ? 'skip' : d < t ? 'missed' : 'todo';
      out.push({ v, st, o });
    });
    // orders placed on a day that is not the vendor's usual day
    ordersList.filter(o => o.orderDate === d && !out.some(x => x.o === o)).forEach(o => out.push({ v: vendorOf(o.vendorId) || { name: o.vendorName }, st: o.status === 'not_sent' ? 'notsent' : 'sent', o, extra: true }));
    return out.sort((a, b) => String(a.v.name).localeCompare(String(b.v.name)));
  }
  function deliveriesOn(d) {
    const t = todayStr(), out = [];
    ordersList.forEach(o => {
      const v = vendorOf(o.vendorId) || { name: o.vendorName };
      if (o.status === 'delivered' && o.deliveredDate === d) out.push({ v, o, st: 'received' });
      else if (o.status === 'pending' && o.expectedDelivery === d) out.push({ v, o, st: d < t ? 'late' : 'expected' });
    });
    // planned: the vendor's order day (today or later, nothing ordered yet) + its lead time lands on this day
    if (d >= t) vendorsList.forEach(v => {
      const L = lead(v); if (L === null) return;
      const od = addDaysStr(d, -L);
      if (od < t || !isVendorDueOn(v, od)) return;
      if (ordersList.some(o => o.vendorId === v.id && o.orderDate === od) || skipsList.some(s => s.vendorId === v.id && s.skipDate === od)) return;
      out.push({ v, st: 'planned', od });
    });
    return out.sort((a, b) => String(a.v.name).localeCompare(String(b.v.name)));
  }
  const ORDER_LABEL = { sent: 'Ordered', notsent: 'Not sent yet', skip: 'No order', todo: 'To order', missed: 'Missed' };
  const DELIV_LABEL = { received: 'Received', expected: 'Expected', late: 'Late', planned: 'Planned' };

  /* ---------------- stats strip (top of the vendors page) ---------------- */
  function renderStats() {
    const box = el('vendorStats'); if (!box) return;
    const t = todayStr(), weekAgo = addDaysStr(t, -6);
    const toOrder = ordersOn(t).filter(x => x.st === 'todo' || x.st === 'notsent').length;
    const expected = ordersList.filter(o => o.status === 'pending' && o.expectedDelivery === t).length;
    const late = ordersList.filter(o => o.status === 'pending' && o.expectedDelivery && o.expectedDelivery < t).length;
    const received = ordersList.filter(o => o.status === 'delivered' && o.deliveredDate >= weekAgo && o.deliveredDate <= t).length;
    const stat = (n, label, cls, go) => `<button type="button" class="vc-stat ${cls}" data-vgo="${go}"><b>${n}</b><span>${label}</span></button>`;
    box.innerHTML = (canManage() ? stat(vendorsList.length, 'vendors', '', 'directory') + stat(toOrder, 'to order today', toOrder ? 'warn' : '', 'orders') : '')
      + stat(expected, 'deliveries expected today', expected ? 'info' : '', 'receiving')
      + stat(late, 'late deliveries', late ? 'bad' : '', 'receiving')
      + stat(received, 'received in the last 7 days', 'ok', 'receiving')
      + (canManage() && window.LowStock && vendorsList.some(v => v.watchStock) ? stat(LowStock.openCount(), 'items running low', LowStock.openCount() ? 'bad' : 'ok', 'lowstock') : '');
    box.querySelectorAll('[data-vgo]').forEach(b => b.onclick = () => {
      const g = b.dataset.vgo;
      if (g === 'receiving') S.day = todayStr();
      goTab(g);
    });
  }
  const goTab = tab => tab === 'lowstock' ? switchTab('stockcontrol') : document.querySelector(`#vendorSubTabs [data-vsub="${tab}"]`)?.click();

  /* ---------------- receiving ---------------- */
  function openReceiving(d) { S.day = d || todayStr(); goTab('receiving'); }
  function renderReceiving() {
    const box = el('vendorReceivingView'); if (!box) return;
    const d = S.day, t = todayStr();
    const eff = o => (window.Warehouse && o.expectedDelivery) ? Warehouse.effective(o) : o.expectedDelivery;   // a closed day moves to the next open one
    const expected = ordersList.filter(o => o.status === 'pending' && eff(o) === d);
    const late = d === t ? ordersList.filter(o => o.status === 'pending' && o.expectedDelivery && eff(o) < t).sort((a, b) => a.expectedDelivery.localeCompare(b.expectedDelivery)) : [];
    const noDate = d === t ? ordersList.filter(o => o.status === 'pending' && !o.expectedDelivery) : [];
    const received = ordersList.filter(o => o.status === 'delivered' && o.deliveredDate === d);
    const planned = window.Warehouse ? Warehouse.planned(d, d) : deliveriesOn(d).filter(x => x.st === 'planned');
    const row = (o, kind) => {
      const v = vendorOf(o.vendorId) || {}, open = S.open === o.id;
      const meta = kind === 'late' ? `<span class="vc-late">${daysBetween(o.expectedDelivery, t)} day${daysBetween(o.expectedDelivery, t) === 1 ? '' : 's'} late</span> · expected ${esc(short(o.expectedDelivery))}`
        : kind === 'nodate' ? 'no expected date' : `ordered ${esc(short(o.orderDate))}${o.expectedDelivery ? '' : ''}`;
      return `<li class="vc-rrow ${kind}">
        <div class="vc-rmain"><b>${esc(o.vendorName || v.name || '')}</b><span>${meta}${v.salesmanName ? ' · ' + esc(v.salesmanName) : ''}${v.phone ? ' · ' + phoneLink(v.phone) : ''}</span></div>
        <button type="button" class="btn small" data-rcv="${esc(o.id)}">${svg('check')} Received</button>
        ${open ? formHtml(o) : ''}</li>`;
    };
    const recRow = o => `<li class="vc-rrow done">
        <div class="vc-rmain"><b>${esc(o.vendorName || vendorOf(o.vendorId)?.name || '')}</b>
          <span>${o.receiveStatus === 'partial' ? '<span class="badge warn">Partial</span>' : '<span class="badge active">Complete</span>'}${o.invoiceNo ? ' · invoice ' + esc(o.invoiceNo) : ''}${o.receivedByName ? ' · by ' + esc(o.receivedByName) : ''}${o.receivedAt ? ' · ' + esc(fmtTs(o.receivedAt)) : ''}${o.receiveNote ? `<br><em>${esc(o.receiveNote)}</em>` : ''}</span></div>
        ${canManage() ? `<button type="button" class="link-btn" data-unrcv="${esc(o.id)}">Undo</button>` : ''}</li>`;
    const sec = (title, cls, items, empty) => `<section class="card vc-rsec ${cls}"><h3>${title} <span class="vc-count">${items.length}</span></h3>${items.length ? `<ul class="vc-rlist">${items.join('')}</ul>` : `<p class="muted-note" style="margin:0;">${empty}</p>`}</section>`;
    box.innerHTML = `
      <div class="card vc-head">
        <div class="vc-nav">
          <button type="button" class="icon-btn" data-vd="-1" aria-label="Previous day">${svg('prev')}</button>
          <h3>${esc(nice(d))}</h3>
          <button type="button" class="icon-btn" data-vd="1" aria-label="Next day">${svg('next')}</button>
          ${d !== t ? '<button type="button" class="btn ghost small" data-vd="0">Today</button>' : ''}
        </div>
        <span class="muted-note">${d === t ? 'Today' : d < t ? 'Past day' : 'Coming day'}${window.Warehouse && !Warehouse.isOpen(d) ? ' · <b>warehouse closed</b>' : ''}</span>
      </div>
      ${d === t && late.length ? sec('Late', 'late', late.map(o => row(o, 'late')), '') : ''}
      ${sec(d === t ? 'Expected today' : 'Expected', 'exp', expected.map(o => row(o, d < t ? 'late' : 'exp')), 'No delivery expected on this day.')}
      ${noDate.length ? sec('Ordered, no expected date', 'nodate', noDate.map(o => row(o, 'nodate')), '') : ''}
      ${sec('Received', 'done', received.map(recRow), 'Nothing received on this day yet.')}
      ${planned.length ? `<section class="card vc-rsec planned"><h3>Planned <span class="vc-count">${planned.length}</span></h3>
        <p class="muted-note" style="margin:0 0 8px;">Not ordered yet: these arrive on this day if they are ordered on their usual day.</p>
        <ul class="vc-rlist">${planned.map(x => `<li class="vc-rrow"><div class="vc-rmain"><b>${esc(x.v.name)}</b><span>order on ${esc(short(x.od))} · lead time ${lead(x.v)} day${lead(x.v) === 1 ? '' : 's'}</span></div></li>`).join('')}</ul></section>` : ''}`;
    box.querySelectorAll('[data-vd]').forEach(b => b.onclick = () => { const k = Number(b.dataset.vd); S.day = k ? addDaysStr(S.day, k) : todayStr(); S.open = null; renderReceiving(); });
    box.querySelectorAll('[data-rcv]').forEach(b => b.onclick = () => { S.open = S.open === b.dataset.rcv ? null : b.dataset.rcv; renderReceiving(); el('vcInvoice')?.focus(); });
    box.querySelectorAll('[data-unrcv]').forEach(b => b.onclick = () => undoReceived(b.dataset.unrcv));
    const f = el('vcRcvForm');
    if (f) {
      f.querySelectorAll('[data-rs]').forEach(b => b.onclick = () => f.querySelectorAll('[data-rs]').forEach(x => x.classList.toggle('active', x === b)));
      f.onsubmit = e => { e.preventDefault(); markReceived(S.open); };
      el('vcRcvCancel').onclick = () => { S.open = null; renderReceiving(); };
    }
  }
  function formHtml(o) {
    return `<form class="vc-rform" id="vcRcvForm">
      <div class="filter-row" style="margin:0;"><button type="button" class="active" data-rs="complete">Complete</button><button type="button" data-rs="partial">Partial</button></div>
      <input type="text" id="vcInvoice" placeholder="Invoice number (optional)" maxlength="60" autocomplete="off">
      <input type="text" id="vcNote" placeholder="Note (optional): missing items, damaged…" maxlength="300" autocomplete="off">
      <div class="vc-rform-act"><button type="button" class="btn ghost small" id="vcRcvCancel">Cancel</button><button type="submit" class="btn small">Confirm received</button></div>
    </form>`;
  }
  // one order received: complete or partial, the invoice number, a note, who and when (also used by the Warehouse page)
  async function receiveOrder(id, { status = 'complete', invoice = '', note = '', day = '' } = {}) {
    const o = ordersList.find(x => x.id === id); if (!o) return false;
    const me = Session.profile?.display_name || Session.profile?.username || '';
    const d = day && day <= todayStr() ? day : todayStr();
    const patch = { status: 'delivered', delivered_date: d, received_at: new Date().toISOString(), received_by: Session.user?.id || null,
      received_by_name: me, receive_status: status, invoice_no: String(invoice).trim() || null, receive_note: String(note).trim() || null };
    const { error } = await sb.from('vendor_orders').update(patch).eq('id', id);
    if (error) { console.error(error); showToast('Not saved — ' + sbErrText(error), true); return false; }
    Object.assign(o, { status: 'delivered', deliveredDate: patch.delivered_date, receivedAt: patch.received_at, receivedByName: me, receiveStatus: status, invoiceNo: patch.invoice_no, receiveNote: patch.receive_note });
    logActivity('vendors', 'receive', { type: 'vendor_order', id }, `Received the order of ${o.vendorName}${status === 'partial' ? ' (partial)' : ''}${patch.invoice_no ? ', invoice ' + patch.invoice_no : ''}`, { status, invoice_no: patch.invoice_no, note: patch.receive_note });
    showToast(`${o.vendorName}: received.`);
    return true;
  }
  async function markReceived(id) {
    const status = document.querySelector('#vcRcvForm [data-rs].active')?.dataset.rs || 'complete';
    const ok = await receiveOrder(id, { status, invoice: el('vcInvoice').value, note: el('vcNote').value, day: S.day });
    if (!ok) return;
    S.open = null;
    renderReceiving(); renderStats();
  }
  async function undoReceived(id) {
    const o = ordersList.find(x => x.id === id); if (!o) return;
    if (!await showConfirm(`Undo the receiving of ${o.vendorName}? It goes back to awaiting delivery.`, 'Undo')) return;
    const patch = { status: 'pending', delivered_date: null, received_at: null, received_by: null, received_by_name: null, receive_status: null, invoice_no: null, receive_note: null };
    const { error } = await sb.from('vendor_orders').update(patch).eq('id', id);
    if (error) return showToast('Not saved — ' + sbErrText(error), true);
    Object.assign(o, { status: 'pending', deliveredDate: null, receivedAt: null, receivedByName: null, receiveStatus: null, invoiceNo: null, receiveNote: null });
    logActivity('vendors', 'unreceive', { type: 'vendor_order', id }, `Undid the receiving of ${o.vendorName}`);
    renderReceiving(); renderStats();
  }

  window.VendorCal = { renderReceiving, renderStats, openReceiving, receiveOrder };
})();
