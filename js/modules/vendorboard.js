/* ============================================================
   Vendor board (owner, 2026-10-11): the Vendors directory as a working board, not a list.
   One card per vendor: who, when to order next, what is waiting, the stock that needs attention, and the
   actions you need: Order now (any day), Mark sent, Delivered, Cancel; WhatsApp (icon), No order (×) and Edit (pencil)
   are icons top right; a click on the card opens the vendor sheet.
   Filters: All · This week (day picker) · Awaiting · Late · Not sent · No order (counter + reset) · Stock alerts · Not scheduled.
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
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 864e5);

  // "No order" tab (owner, 2026-10-11): counts the no-order entries since the last reset (this week's Monday until a
  // reset is made). The reset point is kept on this device: { date, ids } = the reset day and the entries of that day
  // or later that existed at the reset, so they are not counted again.
  const NO_KEY = 'lv-vb-noorder-reset';
  const mondayOf = t => { const d = new Date(t + 'T00:00:00'); return addDaysStr(t, -((d.getDay() + 6) % 7)); };
  const noReset = () => { try { const r = JSON.parse(localStorage.getItem(NO_KEY) || 'null'); if (r && r.date) return r; } catch (e) { /* none */ } return { date: mondayOf(todayStr()), ids: [], auto: true }; };
  function noOrders(vendorId) {
    const r = noReset(), ids = new Set(r.ids || []);
    return skipsList.filter(s => s.vendorId === vendorId && s.skipDate >= r.date && !ids.has(s.id));
  }
  async function resetNoOrders() {
    const r = noReset();
    const ok = await showConfirm(`Reset the no-order counter? It now counts from ${r.auto ? 'Monday' : dmy(r.date)}. After the reset it starts again from 0 (the no-order history is kept).`, 'Reset');
    if (!ok) return;
    const t = todayStr();
    try { localStorage.setItem(NO_KEY, JSON.stringify({ date: t, ids: skipsList.filter(s => s.skipDate >= t).map(s => s.id) })); } catch (e) { showToast('Could not save the reset on this device.', true); return; }
    render(); showToast('No-order counter reset.');
  }

  // delivery monitoring (owner, 2026-10-11): for the last delivered orders of a vendor, the day it was ordered (sent),
  // the day it arrived, how many days it took and whether it came by the expected day. Also used by the vendor sheet.
  function delivery(vendorId) {
    const done = ordersList.filter(o => o.vendorId === vendorId && o.status === 'delivered' && o.deliveredDate)
      .sort((a, b) => b.deliveredDate.localeCompare(a.deliveredDate))
      .map(o => {
        const took = o.orderDate ? Math.max(0, dayDiff(o.orderDate.slice(0, 10), o.deliveredDate.slice(0, 10))) : null;
        const lateBy = o.expectedDelivery ? dayDiff(o.expectedDelivery.slice(0, 10), o.deliveredDate.slice(0, 10)) : null;
        return { o, ordered: o.orderDate, received: o.deliveredDate, took, lateBy };
      });
    const recent = done.slice(0, 6);
    const tk = recent.filter(r => r.took !== null), ex = recent.filter(r => r.lateBy !== null);
    return {
      last: done[0] || null, recent, count: done.length,
      avg: tk.length ? Math.round(tk.reduce((s, r) => s + r.took, 0) / tk.length * 10) / 10 : null,
      onTime: ex.filter(r => r.lateBy <= 0).length, judged: ex.length,
    };
  }
  function lastHtml(d) {
    const r = d.last; if (!r) return '';
    const verdict = r.lateBy === null ? '' : r.lateBy > 0 ? `<em class="late">${r.lateBy}d late</em>` : r.lateBy < 0 ? `<em class="ok">${-r.lateBy}d early</em>` : '<em class="ok">on time</em>';
    const rel = d.recent.length > 1 ? `<div class="vb-rel">Last ${d.recent.length}: ${d.avg !== null ? `avg ${d.avg} days` : ''}${d.judged ? ` · <b class="${d.onTime === d.judged ? 'ok' : d.onTime / d.judged < .7 ? 'late' : ''}">${d.onTime}/${d.judged} on time</b>` : ''}</div>` : '';
    return `<div class="vb-last">
        <div><span>Ordered</span><b>${r.ordered ? esc(dmy(r.ordered)) : '—'}</b></div>
        <i aria-hidden="true">→</i>
        <div><span>Received</span><b>${esc(dmy(r.received))}</b></div>
        <div class="vb-took">${r.took !== null ? `${r.took} day${r.took === 1 ? '' : 's'}` : ''}${verdict}</div>
      </div>${rel}`;
  }

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
    const received = !!last && !pend && !ns && daysSince(last.deliveredDate) <= 7;   // delivered in the last week, nothing open
    const nos = noOrders(v.id);
    return { v, pend, ns, next, days, dueNow, skipToday, received, late, last, st, urgency, nos, week: days !== null && days <= 6 && !pend && !ns };
  }
  const FILTERS = [
    ['all', 'All', () => true],
    ['week', 'This week', i => i.week],
    ['awaiting', 'Awaiting', i => !!i.pend && !i.late],
    ['late', 'Late', i => i.late],
    ['notsent', 'Not sent', i => !!i.ns],
    ['noorder', 'No order', i => i.nos.length > 0],
    ['stock', 'Stock alerts', i => i.st.low > 0 || i.st.fast > 0],
    ['none', 'Not scheduled', i => i.next === null],
  ];

  function render() {
    const box = el('vendorBoard'); if (!box) return;
    const t = todayStr(), term = (typeof vendorSearchTerm === 'string' ? vendorSearchTerm : '').trim().toLowerCase();
    const all = vendorsList.map(v => info(v, t));
    const searched = all.filter(i => !term || ((i.v.name || '') + ' ' + (i.v.salesmanName || '') + ' ' + (i.v.phone || '')).toLowerCase().includes(term));
    // This week (owner, 2026-10-11): a small day picker next to the tab, the next 7 days with today chosen by default;
    // a day shows every supplier ordered on that day, "Whole week" the ones still to order in the next 7 days
    const week = [...Array(7)].map((_, k) => addDaysStr(t, k));
    if (S.day !== 'all' && !week.includes(S.day)) S.day = t;
    const weekFn = i => S.day === 'all' ? i.week : isVendorDueOn(i.v, S.day);
    const f = FILTERS.find(x => x[0] === S.filter) || FILTERS[0];
    const list = searched.filter(S.filter === 'week' ? weekFn : f[2]);
    const sorters = {
      urgency: (a, b) => a.urgency - b.urgency || (a.days ?? 999) - (b.days ?? 999) || a.v.name.localeCompare(b.v.name),
      next: (a, b) => (a.days ?? 999) - (b.days ?? 999) || a.v.name.localeCompare(b.v.name),
      name: (a, b) => a.v.name.localeCompare(b.v.name),
    };
    list.sort(sorters[S.sort] || sorters.urgency);

    if (el('vendorCountNote')) el('vendorCountNote').textContent = vendorsList.length ? `${vendorsList.length} vendor${vendorsList.length === 1 ? '' : 's'}` : 'No vendors yet.';
    el('vbFilters').innerHTML = FILTERS.filter(x => x[0] !== 'stock' || canManage()).map(([k, l, fn]) => {
      if (k === 'noorder') {   // counts the no-order entries (not vendors) since the reset, with the reset button next to it
        const n = searched.reduce((s, i) => s + i.nos.length, 0), r = noReset();
        return `<span class="vb-fgroup"><button type="button" data-vbf="${k}" class="${k === S.filter ? 'active' : ''}" title="No-order entries since ${r.auto ? 'Monday' : 'the reset of ' + dmy(r.date)}">${l} <span class="vb-n k-noorder ${n ? '' : 'zero'}">${n}</span></button><button type="button" class="vb-reset" data-vbreset aria-label="Reset the no-order counter" data-tip="Reset counter"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg></button></span>`;
      }
      if (k === 'week') {
        const opts = week.map((d, x) => {
          const c = searched.filter(i => isVendorDueOn(i.v, d)).length;
          return `<option value="${d}" ${S.day === d ? 'selected' : ''}>${DAYS[new Date(d + 'T00:00:00').getDay()]} ${dmy(d)}${x === 0 ? ' · today' : ''} (${c})</option>`;
        }).join('');
        const n = searched.filter(weekFn).length;
        return `<span class="vb-fgroup"><button type="button" data-vbf="${k}" class="${k === S.filter ? 'active' : ''}">${l} <span class="vb-n k-week ${n ? '' : 'zero'}">${n}</span></button><select class="vb-day" data-vbday aria-label="Day of the week">${opts}<option value="all" ${S.day === 'all' ? 'selected' : ''}>Whole week</option></select></span>`;
      }
      const n = searched.filter(fn).length;
      return `<button type="button" data-vbf="${k}" class="${k === S.filter ? 'active' : ''}">${l}${k !== 'all' ? ` <span class="vb-n k-${k} ${n ? '' : 'zero'}">${n}</span>` : ''}</button>`;
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
    if (S.filter === 'noorder' && i.nos.length) badges.push(`<span class="badge danger" title="${esc(i.nos.map(s => dmy(s.skipDate)).sort().join(', '))}">No order ×${i.nos.length}</span>`);
    if (i.st.low) badges.push(`<span class="badge danger" title="Items running low">${i.st.low} low</span>`);
    if (i.st.fast) badges.push(`<span class="badge danger" title="Selling fast, may run out">⚠ ${i.st.fast} fast</span>`);
    const sched = v.dayOfWeek !== null && v.dayOfWeek !== undefined ? `${DAYS[Number(v.dayOfWeek)]} · ${VENDOR_FREQ_LABELS[v.frequencyWeeks] ? VENDOR_FREQ_LABELS[v.frequencyWeeks].replace('Every ', 'every ').replace(' (monthly)', '') : ''}` : '';
    // the border says where the vendor stands: late (blinks red) > no order today (red) > draft (yellow) > sent (green) > due today (gold) > received (grey, still orderable)
    const state = i.late ? 'late' : i.skipToday ? 'noorder' : i.ns ? 'draft' : i.pend ? 'sent' : i.dueNow ? 'due' : i.received ? 'received' : '';
    return `<article class="vb-card ${state ? 'st-' + state : ''}" data-id="${esc(v.id)}">
      <div class="vb-top"><div class="vb-avatar" aria-hidden="true">${esc((v.name || '?').trim().charAt(0).toUpperCase())}</div>
        <div class="vb-id"><h4>${esc(v.name)}</h4><p class="muted-note">${[v.salesmanName ? esc(v.salesmanName) : '', v.phone ? `<span class="mono">${esc(v.phone)}</span>` : ''].filter(Boolean).join(' · ') || '&nbsp;'}</p></div>
        <div class="vb-icons">
          ${wa ? `<a class="vb-ico vb-wa" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp" data-tip="WhatsApp"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.47-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.08.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2.01-1.42.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35z"/><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 4.54 0 8.24 3.7 8.24 8.24 0 4.54-3.7 8.24-8.24 8.24z"/></svg></a>` : ''}
          ${!i.ns && !i.pend && !i.skipToday ? '<button type="button" class="vb-ico vb-x" data-act="skip" aria-label="No order" data-tip="No order"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ''}
          ${canManage() ? '<button type="button" class="vb-ico vb-edit" data-act="edit" aria-label="Edit vendor" data-tip="Edit"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' : ''}
        </div>
      </div>
      ${window.VendorContract && VendorContract.chip(v.contract) ? `<div class="vb-chips">${VendorContract.chip(v.contract)}</div>` : ''}
      <div class="vb-when">${when}</div>
      <div class="vb-meta">${sched ? esc(sched) : ''}${v.leadTimeDays !== null && v.leadTimeDays !== undefined ? ` · ${esc(v.leadTimeDays)}d lead` : ''}${(v.receivingDays || []).length ? ` · receives ${esc(v.receivingDays.map(d => DAYS[d]).join(', '))}` : ''}</div>
      ${!i.pend && !i.ns ? lastHtml(delivery(v.id)) : ''}
      <div class="vb-badges">${badges.join('') || '<span class="muted-note">Nothing waiting</span>'}</div>
      <div class="vb-actions">
        <div class="vb-cta">${i.skipToday && !i.ns && !i.pend ? '<button type="button" class="btn small" data-act="unskip" title="No order was logged today: click to undo">Undo no order</button>'
          : i.ns ? '<button type="button" class="btn small" data-act="sent">Mark sent</button>'
          : i.pend ? '<button type="button" class="btn small" data-act="delivered">Delivered</button>'
          : '<button type="button" class="btn small" data-act="order">Order now</button>'}${(i.ns || i.pend) && window.VendorOrder && VendorOrder.undoable && VendorOrder.undoable(v.id) ? '<button type="button" class="vb-ico vb-undo" data-act="undoorder" aria-label="Undo order" data-tip="Undo order"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>' : ''}</div>
        ${!(i.skipToday && !i.ns && !i.pend) ? `
        ${i.pend ? '<button type="button" class="btn ghost small vb-cancel" data-act="cancel" title="The supplier will not deliver this order: cancel it (kept in the history)">Cancel</button>' : ''}
        ${i.late ? '<button type="button" class="btn ghost small" data-act="order" title="The delivery is overdue: order again">Order again</button>' : ''}` : ''}
      </div></article>`;
  }

  async function act(a, id) {
    const v = vendorsList.find(x => x.id === id); if (!v) return;
    if (a === 'open') return openVendorDetail(id);
    if (a === 'edit') return openVendorForm(id);
    if (a === 'order') return window.VendorOrder && VendorOrder.open(id);
    if (a === 'skip') return window.VendorOrder && VendorOrder.noOrder(id, todayStr());
    if (a === 'undoorder') return window.VendorOrder && VendorOrder.undo(id);
    if (a === 'unskip') { await undoSkip(id, todayStr()); renderVendorsPage(); if (window.VendorCal) VendorCal.renderStats(); showToast('The no-order entry was removed.'); return; }
    if (a === 'sent') { const o = notSentOrderForVendor(id); if (o) { await markOrderSent(o.id); render(); } return; }
    if (a === 'cancel') { const o = pendingOrderForVendor(id); if (o && await cancelOrder(o.id)) { render(); if (window.VendorCal) VendorCal.renderStats(); } return; }
    if (a === 'delivered') { const o = pendingOrderForVendor(id); if (o) { await markOrderDelivered(o.id); render(); if (window.VendorCal) VendorCal.renderStats(); } }
  }

  function wire() {
    const bar = el('vbFilters'); if (!bar || bar.dataset.wired) return;
    bar.dataset.wired = '1';
    bar.addEventListener('click', e => {
      if (e.target.closest('[data-vbreset]')) return resetNoOrders();
      const b = e.target.closest('[data-vbf]'); if (b) { S.filter = b.dataset.vbf; render(); }
    });
    bar.addEventListener('change', e => { const s = e.target.closest('[data-vbday]'); if (s) { S.day = s.value; S.filter = 'week'; render(); } });
    el('vbSort')?.addEventListener('change', e => { S.sort = e.target.value; render(); });
  }
  function show() { wire(); render(); loadStock(); }
  function reload() { S.stockAt = 0; loadStock(); }

  window.VendorBoard = { render: () => { wire(); render(); if (S.stock === null) loadStock(); }, show, reload, delivery };
})();
