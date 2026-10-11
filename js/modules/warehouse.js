/* ============================================================
   Warehouse (owner, 2026-10-11): who is coming to the receiving warehouse, and the opening days.
   Opening days: closed on Sundays (never open) and on Saturdays, except the Saturdays marked open
   (table warehouse_days, migration 077). An expected delivery that lands on a closed day is received on the
   next open day (Monday): the page shows it there, and the vendor pages move such a date when they log an order.
   Page (js/modules/warehouse.js, section "Warehouse"; permission vendors.manage or vendors.receive):
     - the day in focus (today, or the next open day when closed): who to expect, with Received / Partial
     - late deliveries, orders with no expected date
     - the coming open days: confirmed orders and planned ones (a vendor's next order day + its lead time)
     - orders expected on a closed day: shown on the next open day; managers can move the date for good
     - managers: which coming Saturdays are open
   Uses the vendor page's data (js/app.js: vendorsList, ordersList, skipsList, saveOrderRemote, isVendorDueOn)
   and VendorCal.receiveOrder (js/modules/vendorcal.js).
   Public API: window.Warehouse = { isOpen, nextOpen, ensure, planned, setOpen, closedWhy, show, refresh }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const W = { openSat: new Set(), loadedAt: 0, loading: null, openForm: null, st: 'complete' };
  const dow = d => new Date(d + 'T00:00:00').getDay();
  const nice = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const short = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const canManage = () => can('vendors.manage');
  const vendorOf = id => vendorsList.find(v => v.id === id) || null;
  const lead = v => (v && v.leadTimeDays !== null && v.leadTimeDays !== undefined && v.leadTimeDays !== '') ? Number(v.leadTimeDays) : 4;
  const phoneLink = p => p ? `<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>` : '';

  /* ---------------- opening days ---------------- */
  const isOpen = d => { const w = dow(d); return w === 0 ? false : w === 6 ? W.openSat.has(d) : true; };
  const nextOpen = d => { let x = d; for (let i = 0; i < 14 && !isOpen(x); i++) x = addDaysStr(x, 1); return x; };
  const closedWhy = d => dow(d) === 0 ? 'Sunday: the warehouse is never open' : 'Saturday: the warehouse is closed';
  function ensure(force) {
    if (!force && Date.now() - W.loadedAt < 5 * 60e3) return Promise.resolve();
    if (W.loading) return W.loading;
    W.loading = (async () => {
      try {
        const { data, error } = await sb.from('warehouse_days').select('day, open').gte('day', addDaysStr(todayStr(), -14)).eq('open', true);
        if (error) throw error;
        W.openSat = new Set((data || []).filter(r => dow(String(r.day)) === 6).map(r => String(r.day)));
        W.loadedAt = Date.now();
      } catch (e) { console.warn('warehouse days (migration 077 run?)', e); W.loadedAt = Date.now() - 4 * 60e3; }   // retry in a minute; Saturdays stay closed
      W.loading = null;
    })();
    return W.loading;
  }
  async function setOpen(day, open) {
    if (dow(day) !== 6) return false;
    const { error } = open
      ? await sb.from('warehouse_days').upsert({ day, open: true, set_by: Session.user?.id || null, updated_at: new Date().toISOString() })
      : await sb.from('warehouse_days').delete().eq('day', day);
    if (error) { showToast('Not saved — ' + sbErrText(error), true); return false; }
    if (open) W.openSat.add(day); else W.openSat.delete(day);
    if (typeof logActivity === 'function') logActivity('vendors', 'warehouse_day', null, `Warehouse ${open ? 'open' : 'closed'} on Saturday ${day}`);
    return true;
  }

  /* ---------------- what is coming ---------------- */
  // The day a new order is expected: the first of the vendor's receiving days (none = any day) on or after
  // order date + lead time, on a day the warehouse is open. A vendor with Saturday ticked gets Saturdays only when open.
  function expectedFor(v, orderDate, leadOverride) {
    const L = leadOverride !== undefined && leadOverride !== null && leadOverride !== '' && Number.isFinite(Number(leadOverride)) ? Number(leadOverride) : lead(v);
    const days = (v && Array.isArray(v.receivingDays)) ? v.receivingDays : [];
    let x = addDaysStr(orderDate, L);
    for (let i = 0; i < 28; i++) { if (isOpen(x) && (!days.length || days.includes(dow(x)))) return x; x = addDaysStr(x, 1); }
    return nextOpen(addDaysStr(orderDate, L));
  }
  // the next few days this vendor can be received (for one-tap choices)
  function receivingDates(v, from, count = 4) {
    const days = (v && Array.isArray(v.receivingDays)) ? v.receivingDays : [], out = [];
    for (let i = 0, x = from; i < 60 && out.length < count; i++, x = addDaysStr(x, 1)) if (isOpen(x) && (!days.length || days.includes(dow(x)))) out.push(x);
    return out;
  }
  // orders sent and awaiting delivery: the day each one will really be received (a closed day moves to the next open one)
  const effective = o => o.expectedDelivery ? (isOpen(o.expectedDelivery) ? o.expectedDelivery : nextOpen(o.expectedDelivery)) : null;
  // planned (nothing ordered yet): a vendor's next order days + its lead time, moved to the next open day
  function planned(from, to) {
    const t = todayStr(), out = [];
    vendorsList.forEach(v => {
      const L = lead(v);
      for (let od = t; od <= to; od = addDaysStr(od, 1)) {
        if (!isVendorDueOn(v, od)) continue;
        if (ordersList.some(o => o.vendorId === v.id && o.orderDate === od) || skipsList.some(s => s.vendorId === v.id && s.skipDate === od)) continue;
        const day = expectedFor(v, od);
        if (day >= from && day <= to) out.push({ v, od, day });
      }
    });
    return out.sort((a, b) => String(a.v.name).localeCompare(String(b.v.name)));
  }
  function openDays(from, count) {
    const out = []; let d = from;
    for (let i = 0; i < 40 && out.length < count; i++) { if (isOpen(d)) out.push(d); d = addDaysStr(d, 1); }
    return out;
  }

  /* ---------------- the page ---------------- */
  function row(o, kind, t) {
    const v = vendorOf(o.vendorId) || {}, open = W.openForm === o.id, eff = effective(o);
    const meta = [];
    if (kind === 'late') meta.push(`<span class="vc-late">${Math.max(1, Math.round((new Date(t) - new Date(eff || o.expectedDelivery)) / 864e5))} day(s) late</span> · expected ${esc(short(o.expectedDelivery))}`);
    else meta.push(`ordered ${esc(short(o.orderDate))}`);
    if (o.expectedDelivery && eff && eff !== o.expectedDelivery) meta.push(`<span class="badge inactive" title="${esc(closedWhy(o.expectedDelivery))}">was ${esc(short(o.expectedDelivery))}, warehouse closed</span>`);
    if (v.salesmanName) meta.push(esc(v.salesmanName));
    if (v.phone) meta.push(phoneLink(v.phone));
    const fix = canManage() && o.expectedDelivery && eff && eff !== o.expectedDelivery
      ? `<button type="button" class="btn ghost small" data-wh-move="${esc(o.id)}" title="Change the expected date to ${esc(short(eff))}">Move to ${esc(short(eff))}</button>` : '';
    return `<li class="vc-rrow ${kind}"><div class="vc-rmain"><b>${esc(o.vendorName || v.name || '')}</b><span>${meta.join(' · ')}</span></div>
      ${fix}<button type="button" class="btn small" data-wh-rcv="${esc(o.id)}">✓ Received</button>
      ${open ? `<form class="vc-rform" data-wh-form="${esc(o.id)}">
        <div class="filter-row" style="margin:0;"><button type="button" class="${W.st === 'complete' ? 'active' : ''}" data-wh-st="complete">Complete</button><button type="button" class="${W.st === 'partial' ? 'active' : ''}" data-wh-st="partial">Partial</button></div>
        <input type="text" id="whInvoice" placeholder="Invoice number (optional)" maxlength="60" autocomplete="off">
        <input type="text" id="whNote" placeholder="Note (optional): missing items, damaged…" maxlength="300" autocomplete="off">
        <div class="vc-rform-act"><button type="button" class="btn ghost small" data-wh-cancel>Cancel</button><button type="submit" class="btn small">Confirm received</button></div></form>` : ''}</li>`;
  }
  const sec = (title, cls, items, empty, note) => `<section class="card vc-rsec ${cls}"><h3>${title} <span class="vc-count">${items.length}</span></h3>${note ? `<p class="muted-note" style="margin:0 0 8px;">${note}</p>` : ''}
    ${items.length ? `<ul class="vc-rlist">${items.join('')}</ul>` : `<p class="muted-note" style="margin:0;">${empty}</p>`}</section>`;

  function render() {
    const box = el('panel-warehouse'); if (!box) return;
    const t = todayStr(), open = isOpen(t);
    const pend = ordersList.filter(o => o.status === 'pending');
    const focus = open ? t : nextOpen(t);
    const lateList = pend.filter(o => o.expectedDelivery && (effective(o) < t)).sort((a, b) => a.expectedDelivery.localeCompare(b.expectedDelivery));
    const noDate = pend.filter(o => !o.expectedDelivery);
    const onDay = d => pend.filter(o => effective(o) === d);
    const recToday = ordersList.filter(o => o.status === 'delivered' && o.deliveredDate === t);
    const focusList = onDay(focus), focusPlanned = planned(focus, focus);
    const later = openDays(addDaysStr(focus, 1), 6);
    const stuck = pend.filter(o => o.expectedDelivery && !isOpen(o.expectedDelivery) && o.expectedDelivery >= addDaysStr(t, -7));
    const sats = []; for (let d = t, i = 0; i < 45 && sats.length < 6; i++, d = addDaysStr(d, 1)) if (dow(d) === 6) sats.push(d);

    box.innerHTML = `
      <div class="card wh-head ${open ? 'open' : 'closed'}">
        <div><h3 style="margin:0;">${esc(nice(t))}</h3>
          <span class="muted-note">${open ? 'The warehouse is <b>open</b> today.' : `The warehouse is <b>closed</b> today (${esc(closedWhy(t))}). Next open day: <b>${esc(nice(nextOpen(t)))}</b>.`}</span></div>
        <div class="wh-tiles"><span><b>${focusList.length}</b> expected ${focus === t ? 'today' : esc(short(focus))}</span><span class="${lateList.length ? 'bad' : ''}"><b>${lateList.length}</b> late</span><span><b>${recToday.length}</b> received today</span></div>
      </div>
      ${lateList.length ? sec('Late', 'late', lateList.map(o => row(o, 'late', t)), '') : ''}
      ${sec(focus === t ? 'Expected today' : 'Expected ' + esc(nice(focus)), 'exp', focusList.map(o => row(o, 'exp', t)), 'No delivery expected.')}
      ${focusPlanned.length ? `<section class="card vc-rsec planned"><h3>Likely ${focus === t ? 'today' : 'that day'} <span class="vc-count">${focusPlanned.length}</span></h3><p class="muted-note" style="margin:0 0 8px;">Not ordered yet: they arrive on this day if they are ordered on their usual day.</p>
        <ul class="vc-rlist">${focusPlanned.map(x => `<li class="vc-rrow"><div class="vc-rmain"><b>${esc(x.v.name)}</b><span>order on ${esc(short(x.od))} · ${lead(x.v)} day lead${x.v.salesmanName ? ' · ' + esc(x.v.salesmanName) : ''}</span></div></li>`).join('')}</ul></section>` : ''}
      ${noDate.length ? sec('Ordered, no expected date', 'nodate', noDate.map(o => row(o, 'nodate', t)), '') : ''}
      ${recToday.length ? sec('Received today', 'done', recToday.map(o => `<li class="vc-rrow done"><div class="vc-rmain"><b>${esc(o.vendorName || '')}</b><span>${o.receiveStatus === 'partial' ? '<span class="badge warn">Partial</span>' : '<span class="badge active">Complete</span>'}${o.invoiceNo ? ' · invoice ' + esc(o.invoiceNo) : ''}${o.receivedByName ? ' · by ' + esc(o.receivedByName) : ''}${o.receiveNote ? '<br><em>' + esc(o.receiveNote) + '</em>' : ''}</span></div></li>`), '') : ''}
      <h3 class="wh-h">Coming up</h3>
      <div class="wh-days">${later.map(d => {
        const c = onDay(d), p = planned(d, d);
        return `<section class="card wh-day"><h4>${esc(nice(d))} <span class="vc-count">${c.length}${p.length ? ' + ' + p.length + ' likely' : ''}</span></h4>
          ${c.length ? `<ul class="wh-ul">${c.map(o => { const v = vendorOf(o.vendorId) || {}; const moved = o.expectedDelivery && o.expectedDelivery !== d;
            return `<li><b>${esc(o.vendorName || v.name || '')}</b>${v.salesmanName ? ` <span class="muted-note">${esc(v.salesmanName)}</span>` : ''}${moved ? ` <span class="badge inactive" title="Expected ${esc(short(o.expectedDelivery))}, warehouse closed">from ${esc(short(o.expectedDelivery))}</span>` : ''}</li>`; }).join('')}</ul>` : '<p class="muted-note" style="margin:0;">Nothing confirmed.</p>'}
          ${p.length ? `<ul class="wh-ul wh-likely">${p.map(x => `<li>${esc(x.v.name)} <span class="muted-note">likely · ordered ${esc(short(x.od))}</span></li>`).join('')}</ul>` : ''}</section>`; }).join('')}</div>
      ${canManage() && stuck.length ? sec('Expected on a closed day', 'nodate', stuck.map(o => row(o, 'exp', t)), '', 'These are received on the next open day. Move the date to make it permanent.') : ''}
      ${canManage() ? `<section class="card"><h3 style="margin:0 0 6px;">Saturdays</h3><p class="muted-note" style="margin:0 0 8px;">Closed by default. Open the ones the warehouse works: deliveries can then be expected on them. Sundays never open.</p>
        <div class="wh-sats">${sats.map(d => `<label class="wh-sat ${W.openSat.has(d) ? 'on' : ''}"><input type="checkbox" data-wh-sat="${d}" ${W.openSat.has(d) ? 'checked' : ''}> ${esc(short(d))}</label>`).join('')}</div></section>` : ''}
      <p class="muted-note" style="margin:10px 0 0;">Closed days: Sunday always, Saturday unless opened above. Deliveries that land on a closed day are shown on the next open day.</p>`;
    wire(box);
  }

  function wire(box) {
    box.querySelectorAll('[data-wh-rcv]').forEach(b => b.onclick = () => { W.openForm = W.openForm === b.dataset.whRcv ? null : b.dataset.whRcv; W.st = 'complete'; render(); document.getElementById('whInvoice')?.focus(); });
    box.querySelectorAll('[data-wh-st]').forEach(b => b.onclick = () => { W.st = b.dataset.whSt; b.parentElement.querySelectorAll('[data-wh-st]').forEach(x => x.classList.toggle('active', x === b)); });
    box.querySelectorAll('[data-wh-cancel]').forEach(b => b.onclick = () => { W.openForm = null; render(); });
    box.querySelectorAll('form[data-wh-form]').forEach(f => f.onsubmit = async e => {
      e.preventDefault();
      const ok = await VendorCal.receiveOrder(f.dataset.whForm, { status: W.st, invoice: el('whInvoice').value, note: el('whNote').value, day: todayStr() });
      if (ok) { W.openForm = null; render(); if (window.VendorCal) VendorCal.renderStats(); }
    });
    box.querySelectorAll('[data-wh-move]').forEach(b => b.onclick = async () => {
      const o = ordersList.find(x => x.id === b.dataset.whMove); if (!o) return;
      const to = effective(o);
      if (!await showConfirm(`Move the expected delivery of ${o.vendorName} from ${o.expectedDelivery} to ${to} (warehouse closed)?`, 'Move')) return;
      o.expectedDelivery = to;
      if (await saveOrderRemote(o)) { showToast('Date moved to ' + to + '.'); render(); }
    });
    box.querySelectorAll('[data-wh-sat]').forEach(c => c.onchange = async () => {
      const ok = await setOpen(c.dataset.whSat, c.checked);
      if (!ok) c.checked = !c.checked;
      render();
    });
  }

  async function show() { await ensure(); render(); }
  function refresh() { if (el('panel-warehouse')?.classList.contains('active')) render(); }

  window.Warehouse = { isOpen, nextOpen, ensure, planned, setOpen, closedWhy, effective, expectedFor, receivingDates, show, refresh };
})();
