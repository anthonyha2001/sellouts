/* ============================================================
   Vendor board (owner, 2026-10-11): the Vendors directory as a working board, not a list.
   One card per vendor: who, when to order next, what is waiting, the stock that needs attention, and the
   actions you need: Order now (any day), No order, Call, WhatsApp, Open the sheet, Edit.
   Filters: All · To order now · This week · Awaiting · Late · Not sent · Stock alerts · Not scheduled.
   Sorting: Urgency (default) · Next order · Name. A search finds by vendor, salesman or phone.
   The stock badges (running low, selling fast) come from stock_alerts / top_sales, kept 5 minutes.
   Uses the vendor page's data and helpers (js/app.js). Public API: window.VendorBoard = { render, reload }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { filter: 'all', sort: 'urgency', stock: null, stockAt: 0, loading: false };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const nice = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const canManage = () => can('vendors.manage');

  async function loadStock() {
    if (!canManage()) { S.stock = {}; return; }
    if (S.stock && Date.now() - S.stockAt < 5 * 60e3) return;
    if (S.loading) return;
    S.loading = true;
    try {
      const [low, top] = await Promise.all([
        sb.from('stock_alerts').select('vendor_id').is('resolved_at', null).eq('doubtful', false),
        sb.from('top_sales').select('vendor_id, week_end, attention').order('week_end', { ascending: false }).limit(1500),
      ]);
      const m = {};
      (low.data || []).forEach(a => { (m[a.vendor_id] = m[a.vendor_id] || { low: 0, fast: 0 }).low++; });
      const wk = top.data?.[0]?.week_end;
      const seen = new Set();
      (top.data || []).filter(t => t.week_end === wk && t.attention && t.vendor_id).forEach(t => { (m[t.vendor_id] = m[t.vendor_id] || { low: 0, fast: 0 }).fast++; });
      S.stock = m; S.stockAt = Date.now();
    } catch (e) { S.stock = S.stock || {}; }
    S.loading = false;
    render();   // repaint with the stock badges
  }

  // everything the board needs to know about one vendor, from the page's own data
  function info(v, t) {
    const pend = pendingOrderForVendor(v.id), ns = notSentOrderForVendor(v.id);
    let next = null, days = null;
    for (let i = 0; i < 90; i++) { const d = addDaysStr(t, i); if (isVendorDueOn(v, d)) { next = d; days = i; break; } }
    const skipToday = skipsList.some(s => s.vendorId === v.id && s.skipDate === t);
    const dueNow = days === 0 && !pend && !ns && !skipToday;
    const late = !!pend && isOrderOverdue(pend);
    const last = ordersList.filter(o => o.vendorId === v.id && o.status === 'delivered' && o.deliveredDate).sort((a, b) => b.deliveredDate.localeCompare(a.deliveredDate))[0] || null;
    const st = (S.stock && S.stock[v.id]) || { low: 0, fast: 0 };
    let urgency = 9;
    if (late) urgency = 0; else if (dueNow) urgency = 1; else if (ns) urgency = 2; else if (st.low || st.fast) urgency = 3; else if (pend) urgency = 4; else if (days !== null && days <= 3 && !pend) urgency = 5; else if (days !== null) urgency = 6; else urgency = 8;
    return { v, pend, ns, next, days, dueNow, skipToday, late, last, st, urgency, week: days !== null && days <= 6 && !pend && !ns };
  }
  const FILTERS = [
    ['all', 'All', () => true],
    ['now', 'To order now', i => i.dueNow],
    ['week', 'This week', i => i.week],
    ['awaiting', 'Awaiting', i => !!i.pend && !i.late],
    ['late', 'Late', i => i.late],
    ['notsent', 'Not sent', i => !!i.ns],
    ['stock', 'Stock alerts', i => i.st.low > 0 || i.st.fast > 0],
    ['none', 'Not scheduled', i => i.next === null],
  ];

  function render() {
    const box = el('vendorBoard'); if (!box) return;
    const t = todayStr(), term = (typeof vendorSearchTerm === 'string' ? vendorSearchTerm : '').trim().toLowerCase();
    const all = vendorsList.map(v => info(v, t));
    const searched = all.filter(i => !term || ((i.v.name || '') + ' ' + (i.v.salesmanName || '') + ' ' + (i.v.phone || '')).toLowerCase().includes(term));
    const f = FILTERS.find(x => x[0] === S.filter) || FILTERS[0];
    const list = searched.filter(f[2]);
    const sorters = {
      urgency: (a, b) => a.urgency - b.urgency || (a.days ?? 999) - (b.days ?? 999) || a.v.name.localeCompare(b.v.name),
      next: (a, b) => (a.days ?? 999) - (b.days ?? 999) || a.v.name.localeCompare(b.v.name),
      name: (a, b) => a.v.name.localeCompare(b.v.name),
    };
    list.sort(sorters[S.sort] || sorters.urgency);

    if (el('vendorCountNote')) el('vendorCountNote').textContent = vendorsList.length ? `${vendorsList.length} vendor${vendorsList.length === 1 ? '' : 's'}` : 'No vendors yet.';
    el('vbFilters').innerHTML = FILTERS.filter(x => x[0] !== 'stock' || canManage()).map(([k, l, fn]) => {
      const n = searched.filter(fn).length;
      return `<button type="button" data-vbf="${k}" class="${k === S.filter ? 'active' : ''}">${l}${k !== 'all' ? ` <span class="vb-n ${n && (k === 'late' || k === 'now') ? 'hot' : ''}">${n}</span>` : ''}</button>`;
    }).join('');
    const sel = el('vbSort'); if (sel && sel.value !== S.sort) sel.value = S.sort;

    box.innerHTML = list.map(i => card(i, t)).join('');
    el('vendorEmpty').style.display = vendorsList.length ? 'none' : 'block';
    el('vendorNoMatch').style.display = (vendorsList.length && !list.length) ? 'block' : 'none';
    box.querySelectorAll('.vb-card').forEach(c => {
      const id = c.dataset.id;
      c.addEventListener('click', e => { if (!e.target.closest('button, a')) openVendorDetail(id); });
      c.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); act(b.dataset.act, id); }));
    });
  }

  function card(i, t) {
    const v = i.v, tel = v.phone ? String(v.phone).replace(/[^\d+]/g, '') : '';
    let wa = ''; if (tel) { let d = tel.replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '961' + d.slice(1); else if (!d.startsWith('961')) d = '961' + d; wa = 'https://wa.me/' + d; }
    const when = i.next === null ? '<span class="muted-note">no order day set</span>'
      : i.days === 0 ? '<b class="vb-today">Today</b>' : i.days === 1 ? `<b>Tomorrow</b> <span class="muted-note">${esc(nice(i.next))}</span>` : `<b>${esc(nice(i.next))}</b> <span class="muted-note">in ${i.days} days</span>`;
    const badges = [];
    if (i.late) badges.push(`<span class="badge danger">Delivery late · ${esc(dmy(i.pend.expectedDelivery))}</span>`);
    else if (i.pend) badges.push(`<span class="badge warn">Awaiting${i.pend.expectedDelivery ? ' · ' + esc(dmy(i.pend.expectedDelivery)) : ''}</span>`);
    if (i.ns) badges.push(`<span class="badge inactive">Not sent · ${esc(dmy(i.ns.orderDate))}</span>`);
    if (i.dueNow) badges.push('<span class="badge warn">Order today</span>');
    if (i.skipToday) badges.push('<span class="badge inactive">No order today</span>');
    if (i.st.low) badges.push(`<span class="badge danger" title="Items running low">${i.st.low} low</span>`);
    if (i.st.fast) badges.push(`<span class="badge danger" title="Selling fast, may run out">⚠ ${i.st.fast} fast</span>`);
    const sched = v.dayOfWeek !== null && v.dayOfWeek !== undefined ? `${DAYS[Number(v.dayOfWeek)]} · ${VENDOR_FREQ_LABELS[v.frequencyWeeks] ? VENDOR_FREQ_LABELS[v.frequencyWeeks].replace('Every ', 'every ').replace(' (monthly)', '') : ''}` : '';
    return `<article class="vb-card ${i.late ? 'late' : i.dueNow ? 'due' : ''}" data-id="${esc(v.id)}">
      <div class="vb-top"><div class="vb-avatar" aria-hidden="true">${esc((v.name || '?').trim().charAt(0).toUpperCase())}</div>
        <div class="vb-id"><h4>${esc(v.name)}</h4><p class="muted-note">${[v.salesmanName ? esc(v.salesmanName) : '', v.phone ? `<span class="mono">${esc(v.phone)}</span>` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</p></div>
</div>
      ${window.VendorContract && VendorContract.chip(v.contract) ? `<div class="vb-chips">${VendorContract.chip(v.contract)}</div>` : ''}
      <div class="vb-when">${when}</div>
      <div class="vb-meta">${sched ? esc(sched) : ''}${v.leadTimeDays !== null && v.leadTimeDays !== undefined ? ` · ${esc(v.leadTimeDays)}d lead` : ''}${(v.receivingDays || []).length ? ` · receives ${esc(v.receivingDays.map(d => DAYS[d]).join(', '))}` : ''}${i.last ? ` · last delivery ${esc(dmy(i.last.deliveredDate))}` : ''}</div>
      <div class="vb-badges">${badges.join('') || '<span class="muted-note">Nothing waiting</span>'}</div>
      <div class="vb-actions">
        <button type="button" class="btn small" data-act="order">Order now</button>
        ${i.skipToday ? '<button type="button" class="btn ghost small" data-act="unskip" title="No order was logged today: click to undo">No order today ✓ · Undo</button>' : '<button type="button" class="btn ghost small" data-act="skip" title="Log that nothing is ordered from this vendor today">No order</button>'}
        ${i.ns ? '<button type="button" class="btn ghost small" data-act="sent">Mark sent</button>' : ''}
        ${i.pend ? '<button type="button" class="btn ghost small" data-act="delivered">Delivered</button>' : ''}
        <span class="vb-spacer"></span>
        ${tel ? `<a class="btn ghost small" href="tel:${esc(tel)}" title="Call">Call</a>` : ''}
        ${wa ? `<a class="btn ghost small" href="${esc(wa)}" target="_blank" rel="noopener" title="WhatsApp">WA</a>` : ''}
        <button type="button" class="btn ghost small" data-act="open">Open</button>
        ${canManage() ? '<button type="button" class="btn ghost small" data-act="edit">Edit</button>' : ''}
      </div></article>`;
  }

  async function act(a, id) {
    const v = vendorsList.find(x => x.id === id); if (!v) return;
    if (a === 'open') return openVendorDetail(id);
    if (a === 'edit') return openVendorForm(id);
    if (a === 'order') return window.VendorOrder && VendorOrder.open(id);
    if (a === 'skip') return window.VendorOrder && VendorOrder.noOrder(id, todayStr());
    if (a === 'unskip') { await undoSkip(id, todayStr()); renderVendorsPage(); if (window.VendorCal) VendorCal.renderStats(); showToast('The no-order entry was removed.'); return; }
    if (a === 'sent') { const o = notSentOrderForVendor(id); if (o) { await markOrderSent(o.id); render(); } return; }
    if (a === 'delivered') { const o = pendingOrderForVendor(id); if (o) { await markOrderDelivered(o.id); render(); if (window.VendorCal) VendorCal.renderStats(); } }
  }

  function wire() {
    const bar = el('vbFilters'); if (!bar || bar.dataset.wired) return;
    bar.dataset.wired = '1';
    bar.addEventListener('click', e => { const b = e.target.closest('[data-vbf]'); if (b) { S.filter = b.dataset.vbf; render(); } });
    el('vbSort')?.addEventListener('change', e => { S.sort = e.target.value; render(); });
  }
  function show() { wire(); render(); loadStock(); }
  function reload() { S.stockAt = 0; loadStock(); }

  window.VendorBoard = { render: () => { wire(); render(); if (S.stock === null) loadStock(); }, show, reload };
})();
