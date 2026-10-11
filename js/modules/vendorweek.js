/* ============================================================
   Vendors › Week plan (owner, 2026-10-11): the week at a glance, Monday to Sunday.
   Per day, two lists:
     Order      : the vendors whose order day it is (to order / ordered / no order / missed)
     Deliveries : what arrives that day: received, expected, late, and planned (a vendor's order day + its lead time)
   The warehouse is closed on Sundays and (usually) Saturdays: a delivery landing there is shown on the next open
   day, and managers can open a Saturday with one tap. A busy day shows its count, so the orders can be spread.
   Tap a vendor to order now (to order) or open its sheet; "+" orders any vendor on that day.
   Uses the vendor page's data (js/app.js) and js/modules/warehouse.js. Public API: window.VendorWeek = { show, render }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { monday: null };
  const mondayOf = d => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toLocaleDateString('en-CA'); };
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const canManage = () => can('vendors.manage');
  const vendorOf = id => vendorsList.find(v => v.id === id) || null;
  const lead = v => (v && v.leadTimeDays !== null && v.leadTimeDays !== undefined && v.leadTimeDays !== '') ? Number(v.leadTimeDays) : 4;
  const dm = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  function render() {
    const box = el('vendorWeekView'); if (!box) return;
    const t = todayStr(); if (!S.monday) S.monday = mondayOf(t);
    const days = Array.from({ length: 7 }, (_, i) => addDaysStr(S.monday, i));
    const W = window.Warehouse, isOpen = d => W ? W.isOpen(d) : ![0, 6].includes(new Date(d + 'T00:00:00').getDay());
    const eff = o => (W && o.expectedDelivery) ? W.effective(o) : o.expectedDelivery;
    const planned = W ? W.planned(days[0], days[6]) : [];

    const cols = days.map((d, i) => {
      // orders
      const orders = vendorsList.filter(v => isVendorDueOn(v, d)).map(v => {
        const o = ordersList.find(x => x.vendorId === v.id && x.orderDate === d), skip = skipsList.some(s => s.vendorId === v.id && s.skipDate === d);
        // an order logged on another day (an early order) also answers this due day
        const early = !o && ordersList.find(x => x.vendorId === v.id && x.status !== 'delivered' && x.orderDate && x.orderDate < d && x.orderDate >= addDaysStr(d, -6));
        const st = o ? (o.status === 'not_sent' ? 'notsent' : 'ordered') : early ? 'early' : skip ? 'skip' : d < t ? 'missed' : 'todo';
        return { v, st };
      }).sort((a, b) => a.v.name.localeCompare(b.v.name));
      // deliveries
      const dels = [];
      ordersList.forEach(o => {
        const v = vendorOf(o.vendorId) || { name: o.vendorName, id: o.vendorId };
        if (o.status === 'delivered' && o.deliveredDate === d) dels.push({ v, st: 'received', o });
        else if (o.status === 'pending' && eff(o) === d) dels.push({ v, st: d < t ? 'late' : 'expected', o, moved: o.expectedDelivery !== d });
      });
      planned.filter(p => p.day === d).forEach(p => dels.push({ v: p.v, st: 'planned', od: p.od }));
      dels.sort((a, b) => String(a.v.name).localeCompare(String(b.v.name)));
      const closed = !isOpen(d), sat = i === 5;
      return { d, i, orders, dels, closed, sat, today: d === t, past: d < t };
    });

    const chipO = x => `<button type="button" class="vw-chip vw-${x.st}" data-vid="${esc(x.v.id)}" data-st="${x.st}" title="${esc(x.v.name)}">${esc(x.v.name)}</button>`;
    const chipD = x => `<button type="button" class="vw-chip vd-${x.st}" data-vid="${esc(x.v.id || '')}" title="${esc(x.v.name)}${x.st === 'planned' ? ' (order on ' + dm(x.od) + ')' : ''}${x.moved ? ' (was ' + dm(x.o.expectedDelivery) + ', warehouse closed)' : ''}">${esc(x.v.name)}${x.moved ? ' ↷' : ''}</button>`;
    const LAB = { todo: 'To order', ordered: 'Ordered', notsent: 'Not sent', early: 'Ordered early', skip: 'No order', missed: 'Missed' };
    const todoTotal = cols.reduce((s, c) => s + c.orders.filter(x => x.st === 'todo' || x.st === 'notsent').length, 0);
    const delTotal = cols.reduce((s, c) => s + c.dels.filter(x => x.st !== 'received').length, 0);
    const maxDel = Math.max(1, ...cols.map(c => c.dels.length));
    const label = `${dm(days[0])} → ${dm(days[6])} ${new Date(days[6] + 'T00:00:00').getFullYear()}`;

    box.innerHTML = `
      <div class="card vc-head"><div class="vc-nav">
        <button type="button" class="icon-btn" data-vw="-7" aria-label="Previous week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3>${esc(label)}</h3>
        <button type="button" class="icon-btn" data-vw="7" aria-label="Next week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        ${S.monday !== mondayOf(t) ? '<button type="button" class="btn ghost small" data-vw="0">This week</button>' : ''}
      </div><span class="muted-note"><b>${todoTotal}</b> to order · <b>${delTotal}</b> deliveries</span></div>
      <div class="vw-legend"><span class="vw-chip vw-todo">To order</span><span class="vw-chip vw-ordered">Ordered</span><span class="vw-chip vw-notsent">Not sent</span><span class="vw-chip vw-missed">Missed</span>
        <span class="vw-sep"></span><span class="vw-chip vd-expected">Expected</span><span class="vw-chip vd-late">Late</span><span class="vw-chip vd-received">Received</span><span class="vw-chip vd-planned">Planned</span><span class="muted-note">↷ moved: warehouse closed</span></div>
      <div class="vw-grid">${cols.map(c => `
        <section class="vw-col ${c.today ? 'today' : ''} ${c.closed ? 'closed' : ''} ${c.past ? 'past' : ''}">
          <header><b>${DOW[c.i]}</b> <span>${dm(c.d)}</span>${c.today ? '<em>today</em>' : ''}
            ${c.closed ? '<div class="vw-closed">Warehouse closed</div>' : `<div class="vw-load" title="${c.dels.length} deliveries"><i style="width:${Math.round(c.dels.length / maxDel * 100)}%"></i></div>`}
            ${c.sat && canManage() && W ? `<label class="vw-satopen"><input type="checkbox" data-sat="${c.d}" ${W.isOpen(c.d) ? 'checked' : ''}> open this Saturday</label>` : ''}</header>
          <h5>Order <span>${c.orders.length}</span></h5>
          <div class="vw-list">${c.orders.map(chipO).join('') || '<span class="muted-note">—</span>'}</div>
          ${canManage() ? `<button type="button" class="vw-add" data-add="${c.d}" title="Order any vendor on this day">+ Order</button>` : ''}
          <h5>Deliveries <span>${c.dels.length}</span></h5>
          <div class="vw-list">${c.closed ? '<span class="muted-note">Nothing is received</span>' : (c.dels.map(chipD).join('') || '<span class="muted-note">—</span>')}</div>
        </section>`).join('')}</div>
      <p class="muted-note" style="margin:8px 0 0;">Tap <b>To order</b> to order now, any other vendor opens its sheet. Planned = the vendor's next order day plus its lead time, before the order exists.</p>`;
    box.querySelectorAll('[data-vw]').forEach(b => b.onclick = () => { const k = Number(b.dataset.vw); S.monday = k ? addDaysStr(S.monday, k) : mondayOf(todayStr()); render(); });
    box.querySelectorAll('.vw-chip[data-vid]').forEach(b => b.onclick = () => {
      const st = b.dataset.st, id = b.dataset.vid; if (!id) return;
      if ((st === 'todo' || st === 'missed') && window.VendorOrder && canManage()) VendorOrder.open(id); else openVendorDetail(id);
    });
    box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => pickVendor(b.dataset.add));
    box.querySelectorAll('[data-sat]').forEach(c => c.onchange = async () => { const ok = await Warehouse.setOpen(c.dataset.sat, c.checked); if (!ok) c.checked = !c.checked; render(); });
  }

  // "+ Order": any vendor on that day (a small chooser)
  function pickVendor(day) {
    let o = el('vwPick');
    if (!o) {
      o = document.createElement('div'); o.id = 'vwPick'; o.className = 'modal-overlay';
      o.innerHTML = '<div class="modal-box form-box" style="max-width:420px;"><h3 style="margin:0 0 8px;" id="vwPickTitle">Order a vendor</h3><input type="search" id="vwPickQ" placeholder="Find a vendor…" autocomplete="off"><div id="vwPickList" class="vw-pick"></div><div class="actions-row"><button class="btn ghost small" id="vwPickX" type="button">Close</button></div></div>';
      document.body.appendChild(o);
      o.addEventListener('mousedown', e => { if (e.target === o) o.classList.remove('open'); });
      el('vwPickX').onclick = () => o.classList.remove('open');
    }
    el('vwPickTitle').textContent = 'Order a vendor on ' + new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const paint = () => {
      const q = el('vwPickQ').value.trim().toLowerCase();
      el('vwPickList').innerHTML = vendorsList.filter(v => !q || v.name.toLowerCase().includes(q)).slice(0, 40).map(v => `<button type="button" class="vw-pickrow" data-id="${esc(v.id)}">${esc(v.name)}<span class="muted-note">${esc(v.salesmanName || '')}</span></button>`).join('') || '<p class="muted-note">No vendor.</p>';
      el('vwPickList').querySelectorAll('[data-id]').forEach(b => b.onclick = () => { o.classList.remove('open'); VendorOrder.open(b.dataset.id, { date: day < todayStr() ? todayStr() : day }); });
    };
    el('vwPickQ').value = ''; el('vwPickQ').oninput = paint; paint();
    o.classList.add('open'); setTimeout(() => el('vwPickQ').focus(), 30);
  }

  async function show() { if (window.Warehouse) await Warehouse.ensure(); render(); }
  window.VendorWeek = { show, render };
})();
