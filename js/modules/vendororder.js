/* ============================================================
   Order now (owner, 2026-10-11): an order for ANY vendor on ANY day, not only on its usual order day.
   A vendor that comes on Friday can be ordered on Monday: it is logged now, and the vendor then no longer
   shows as "due" on Friday (an open order silences it).
     - order date    : today by default (any day)
     - expected      : order date + the vendor's lead time, or the date you choose (the vendor's usual
                       delivery days are offered as one tap)
     - how           : "Already sent to the supplier" (awaiting delivery, expected date set) or
                       "Draft, not sent yet" (it waits in Orders > Not sent, like a due order)
     - quantity note : optional note kept with the order (what was ordered)
   Uses the vendor page's helpers (js/app.js: vendorsList, ordersList, saveOrderRemote, createSkip, uid,
   addDaysStr, isVendorDueOn, pendingOrderForVendor, notSentOrderForVendor).
   Public API: window.VendorOrder = { open(vendorId, opts), noOrder(vendorId, date) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const nice = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const lead = v => (v && v.leadTimeDays !== null && v.leadTimeDays !== undefined && v.leadTimeDays !== '') ? Number(v.leadTimeDays) : 4;
  let current = null;

  function shell() {
    let o = el('vendorOrderDlg');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'vendorOrderDlg'; o.className = 'modal-overlay';
    o.innerHTML = `<div class="modal-box form-box" style="max-width:520px;" role="dialog" aria-modal="true" aria-label="Order now">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
        <div><h3 style="margin:0 0 2px;" id="voTitle">Order now</h3><p class="muted-note" id="voSub" style="margin:0;"></p></div>
        <button class="icon-btn" id="voClose" type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div id="voWarn"></div>
      <div class="form-grid" style="margin-top:12px;">
        <div><label for="voDate">Order date</label><input type="date" id="voDate"></div>
        <div><label for="voLead">Lead time (days)</label><input type="text" inputmode="numeric" id="voLead"></div>
        <div class="full"><label for="voExpected">Expected delivery</label><input type="date" id="voExpected">
          <div class="vo-quick" id="voQuick"></div><div id="voNote" class="muted-note" style="margin-top:6px;"></div></div>
        <div class="full"><label>How</label>
          <label class="vo-radio"><input type="radio" name="voHow" value="pending" checked> <span><b>Already sent to the supplier</b><br><small>Awaiting delivery on the expected date</small></span></label>
          <label class="vo-radio"><input type="radio" name="voHow" value="not_sent"> <span><b>Draft, not sent yet</b><br><small>It waits in Orders &rsaquo; Not sent until you mark it sent</small></span></label></div>
      </div>
      <div class="actions-row" style="margin-top:14px;">
        <button class="btn ghost small" id="voCancel" type="button">Cancel</button>
        <button class="btn small" id="voSave" type="button">Log the order</button>
      </div></div>`;
    document.body.appendChild(o);
    o.addEventListener('mousedown', e => { if (e.target === o) close(); });
    el('voClose').onclick = el('voCancel').onclick = close;
    el('voSave').onclick = save;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && o.classList.contains('open')) close(); });
    ['voDate', 'voLead'].forEach(id => el(id).addEventListener('input', recalc));
    el('voQuick').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) { el('voExpected').value = b.dataset.d; paintQuick(); } });
    el('voExpected').addEventListener('input', () => { paintQuick(); note(); });
    return o;
  }
  // the day the order is expected: the vendor's receiving days (set on the vendor, migration 078), after the lead
  // time, on a day the warehouse is open
  const expectedFor = (v, d0, L) => window.Warehouse ? Warehouse.expectedFor(v, d0, L) : addDaysStr(d0, Number.isFinite(Number(L)) ? Number(L) : lead(v));
  const DNAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // one-tap choices: the earliest receiving day, then the next ones after it
  function quickDates() {
    const v = current.vendor, d0 = el('voDate').value || todayStr(), L = Number(el('voLead').value);
    const first = expectedFor(v, d0, Number.isFinite(L) ? L : lead(v)), out = [[first, 'earliest']];
    if (window.Warehouse) Warehouse.receivingDates(v, addDaysStr(first, 1), 3).forEach(d => out.push([d, DNAME[new Date(d + 'T00:00:00').getDay()]]));
    return out;
  }
  // the warehouse is closed on Sundays and (usually) Saturdays: say so, and say what the date was moved from
  function note() {
    const e = el('voExpected').value, d0 = el('voDate').value || todayStr(), L = Number(el('voLead').value);
    const raw = Number.isFinite(L) && el('voLead').value !== '' ? addDaysStr(d0, L) : '';
    const n = el('voNote'); if (!n) return;
    if (!window.Warehouse) { n.textContent = ''; return; }
    if (e && !Warehouse.isOpen(e)) n.innerHTML = '<span class="vs-warn">The warehouse is closed on ' + esc(nice(e)) + '.</span>';
    else if (raw && raw !== e && !Warehouse.isOpen(raw)) n.textContent = nice(raw) + ' falls on a closed day (' + Warehouse.closedWhy(raw).split(':')[0] + '): moved to the next receiving day.';
    else if (raw && raw !== e && current && current.vendor && (current.vendor.receivingDays || []).length)
      n.textContent = 'This vendor is received on ' + current.vendor.receivingDays.map(d => DNAME[d].slice(0, 3)).join(', ') + ': moved from ' + nice(raw) + '.';
    else n.textContent = '';
  }
  function paintQuick() {
    const cur = el('voExpected').value;
    el('voQuick').innerHTML = quickDates().map(([d, l]) => `<button type="button" class="btn ghost small ${d === cur ? 'active' : ''}" data-d="${d}">${esc(nice(d))} <span class="muted-note">${esc(l)}</span></button>`).join('');
  }
  function recalc() {
    const d0 = el('voDate').value || todayStr(), L = Number(el('voLead').value);
    if (Number.isFinite(L) && el('voLead').value !== '') el('voExpected').value = expectedFor(current.vendor, d0, L);
    note();
    paintQuick();
  }

  function open(vendorId, opts = {}) {
    const v = vendorsList.find(x => x.id === vendorId); if (!v) return;
    current = { vendor: v };
    const o = shell(), t = todayStr();
    el('voTitle').textContent = 'Order now · ' + v.name;
    const next = (() => { for (let i = 0; i < 90; i++) { const d = addDaysStr(t, i); if (isVendorDueOn(v, d)) return d; } return null; })();
    el('voSub').textContent = next ? `Usual order day: ${nice(next)}${next === t ? ' (today)' : ''}. You can order on any other day too.` : 'Any day works.';
    const pend = pendingOrderForVendor(v.id), ns = notSentOrderForVendor(v.id);
    el('voWarn').innerHTML = pend ? `<div class="vs-note" style="margin-top:10px;">There is already an order awaiting delivery (placed ${esc(pend.orderDate || '')}${pend.expectedDelivery ? ', expected ' + esc(pend.expectedDelivery) : ''}). Logging another one is allowed.</div>`
      : ns ? `<div class="vs-note" style="margin-top:10px;">There is already a draft order from ${esc(ns.orderDate || '')} that was not sent. Mark that one sent from Orders, or log a new one here.</div>` : '';
    el('voDate').value = opts.date || t;
    el('voLead').value = String(lead(v));
    el('voExpected').value = expectedFor(v, el('voDate').value, lead(v));
    note();
    o.querySelector('input[name="voHow"][value="pending"]').checked = true;
    paintQuick();
    o.classList.add('open');
    // the open Saturdays (migration 077) may not be loaded yet: read them, then set the default date again
    if (window.Warehouse) Warehouse.ensure().then(() => { if (current && current.vendor === v) { el('voExpected').value = expectedFor(v, el('voDate').value, Number(el('voLead').value)); paintQuick(); note(); } });
  }
  function close() { el('vendorOrderDlg')?.classList.remove('open'); current = null; }
  async function save() {
    const v = current && current.vendor; if (!v) return;
    const date = el('voDate').value, how = document.querySelector('input[name="voHow"]:checked')?.value || 'pending';
    let expected = el('voExpected').value;
    if (!date) return showToast('Choose the order date.', true);
    if (how === 'pending' && !expected) return showToast('Choose the expected delivery date.', true);
    if (how === 'pending' && expected < date) return showToast('The expected delivery cannot be before the order date.', true);
    if (how === 'pending' && window.Warehouse && !Warehouse.isOpen(expected)) {
      const to = Warehouse.nextOpen(expected);
      if (await showConfirm(`The warehouse is closed on ${nice(expected)}. Log the delivery for ${nice(to)} instead?`, 'Move to ' + nice(to))) { expected = to; el('voExpected').value = to; }
    }
    const L = Number(el('voLead').value);
    const order = { id: uid(), vendorId: v.id, vendorName: v.name, orderDate: date, leadTimeDays: Number.isFinite(L) ? L : lead(v),
      expectedDelivery: how === 'pending' ? expected : null, status: how, deliveredDate: null };
    el('voSave').disabled = true;
    const ok = await saveOrderRemote(order);
    el('voSave').disabled = false;
    if (!ok) return;
    ordersList.push(order);
    close();
    refresh();
    showToast(how === 'pending' ? `Order logged for ${v.name} — expected ${expected}.` : `Draft logged for ${v.name} — mark it sent once it has gone.`);
    if (typeof logActivity === 'function') logActivity('vendors', 'order', { type: 'vendor_order', id: order.id }, `Order for ${v.name}${how === 'pending' ? ', expected ' + expected : ' (draft)'}`, { date, expected: order.expectedDelivery, status: how });
  }
  async function noOrder(vendorId, date) {
    const v = vendorsList.find(x => x.id === vendorId); if (!v) return;
    const d = date || todayStr();
    // a draft that was never sent stands in the way (the card keeps saying "Not sent"): cancel it with the no order
    const ns = notSentOrderForVendor(vendorId);
    if (ns) {
      if (!(await showConfirm(`"${v.name}" has a draft order from ${ns.orderDate} that was never sent. Cancel it and log "no order" for ${d}?`, 'Cancel draft & log no order'))) return;
      if (!(await cancelDraft(vendorId, true))) return;
    } else if (!(await showConfirm(`Log "no order" for "${v.name}" on ${d}?`, 'Log no order'))) return;
    if (await createSkip(v, d)) { refresh(); showToast('Logged — no order for ' + v.name + '.'); }
  }
  // cancel a draft order that was never sent to the supplier (owner, 2026-10-12): kept in the history as cancelled
  async function cancelDraft(vendorId, quiet) {
    const v = vendorsList.find(x => x.id === vendorId), o = notSentOrderForVendor(vendorId); if (!v || !o) return false;
    if (!quiet && !(await showConfirm(`Cancel the draft order for "${v.name}" (from ${o.orderDate}, never sent)? It stays in the history as cancelled.`, 'Cancel draft'))) return false;
    const note = `Draft cancelled ${todayStr()} — never sent`;
    const { error } = await sb.from('vendor_orders').update({ status: 'cancelled', receive_note: note }).eq('id', o.id);
    if (error) { console.error(error); showToast('Could not cancel that draft — ' + sbErrText(error), true); return false; }
    o.status = 'cancelled'; o.receiveNote = note;
    refresh();
    if (!quiet) showToast('Draft cancelled for ' + v.name + '.');
    if (typeof logActivity === 'function') logActivity('vendors', 'order_cancel', { type: 'vendor_order', id: o.id }, `Draft order for ${v.name} cancelled (never sent)`, { date: o.orderDate });
    return true;
  }
  // undo an order logged today by mistake (owner, 2026-10-11): the small undo icon next to the card's main button.
  // Only today's order (draft or sent today) can be undone; it is removed. An older one is cancelled instead.
  function undoable(vendorId) {
    const t = todayStr(), ns = notSentOrderForVendor(vendorId), pend = pendingOrderForVendor(vendorId);
    const o = ns || pend;
    return o && String(o.orderDate || '').slice(0, 10) === t ? o : null;
  }
  async function undo(vendorId) {
    const v = vendorsList.find(x => x.id === vendorId), o = undoable(vendorId); if (!v || !o) return;
    if (!(await showConfirm(`Undo the order logged today for "${v.name}"? It will be removed.`, 'Undo order'))) return;
    const { error } = await sb.from('vendor_orders').delete().eq('id', o.id);
    if (error) { console.error(error); showToast('Could not undo that order — ' + sbErrText(error), true); return; }
    const ix = ordersList.indexOf(o); if (ix >= 0) ordersList.splice(ix, 1);
    refresh();
    showToast('Order undone for ' + v.name + '.');
    if (typeof logActivity === 'function') logActivity('vendors', 'order_undo', { type: 'vendor_order', id: o.id }, `Order for ${v.name} undone`, { date: o.orderDate, status: o.status });
  }
  function refresh() {
    if (typeof renderVendorsPage === 'function') renderVendorsPage();
    if (typeof renderOrdersView === 'function') renderOrdersView();
    if (window.VendorCal) VendorCal.renderStats();
    if (window.VendorSheet && el('vendorSheet')?.classList.contains('open')) VendorSheet.refreshLocal && VendorSheet.refreshLocal();
    if (window.Warehouse) Warehouse.refresh();
  }
  window.VendorOrder = { open, noOrder, undo, undoable, cancelDraft };
})();
