/* ============================================================
   Vendor sheet (owner, 2026-10-11): everything about one vendor in one place, fast.
   Opens from any vendor name in the Vendors page (openVendorDetail hands over here).
     Overview : who, when to order, what is waiting, purchases / sales / profit of the period, months, what needs
                attention (bought and not sold, selling at a loss, best sellers)
     Items    : every item of the supplier, bought vs sold, profit and margin, searchable and sortable
     Orders   : every order and no-order entry, with the invoice and the receiving note
     Stock    : running low, selling more than usual, overstock, slow movers, big purchases
     Contract : back margins and terms
   The page's own data (vendors, orders) shows at once; the system's figures (perf_supplier) and the stock tables
   load in parallel and are kept 10 minutes. Sales / purchases figures need vendors.manage.
   Public API: window.VendorSheet = { open, close }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = v => (n(v) < 0 ? '-$' : '$') + Math.abs(Math.round(n(v))).toLocaleString('en-US');
  const qty = v => (Math.round(n(v) * 10) / 10).toLocaleString('en-US');
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const S = { id: null, tab: 'overview', range: 90, q: '', sort: 'sold', dir: -1, perf: null, perfBusy: false, stock: null, cache: new Map() };
  const canData = () => can('vendors.manage');
  const vendor = () => vendorsList.find(v => v.id === S.id) || null;
  const rangeFrom = days => addDaysStr(todayStr(), -(days - 1));

  /* ---------------- data ---------------- */
  async function loadPerf(force) {
    const v = vendor(); if (!v) return;
    const sups = (v.systemSuppliers || []).map(s => s.code).filter(Boolean);
    if (!canData() || !sups.length) { S.perf = { none: true }; return; }
    const from = rangeFrom(S.range), to = todayStr(), key = `${v.id}|${S.range}|${to}`;
    const hit = S.cache.get(key);
    if (hit && !force && Date.now() - hit.at < 10 * 60e3) { S.perf = hit.data; return; }
    S.perfBusy = true; S.perf = null;
    try {
      const parts = await Promise.all(sups.map(async code => {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'perf_supplier', supplier: code, from, to } });
        if (error || !data || data.error) throw new Error(data?.error || 'no answer');
        return data;
      }));
      const items = new Map(), months = {};
      parts.forEach(p => {
        (p.items || []).forEach(i => {
          const o = items.get(i.code) || { code: i.code, description: i.description, bought: 0, boughtQty: 0, sold: 0, soldQty: 0, profit: null, unitCost: i.unitCost };
          o.bought += n(i.bought); o.boughtQty += n(i.boughtQty); o.sold += n(i.sold); o.soldQty += n(i.soldQty);
          if (typeof i.profit === 'number') o.profit = n(o.profit) + i.profit;
          items.set(i.code, o);
        });
        Object.entries(p.months || {}).forEach(([k, m]) => { const o = months[k] = months[k] || { bought: 0, sold: 0 }; o.bought += n(m.bought); o.sold += n(m.sold); });
      });
      S.perf = { from, to, items: [...items.values()], months };
      S.cache.set(key, { at: Date.now(), data: S.perf });
    } catch (e) { S.perf = { error: e.message === 'no answer' ? 'The system did not answer.' : e.message }; }
    S.perfBusy = false;
  }
  async function loadStock() {
    const v = vendor(); if (!v || !canData()) { S.stock = null; return; }
    const names = (v.systemSuppliers || []).map(s => String(s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
    const since = addDaysStr(todayStr(), -30);
    const [low, top, rev, big] = await Promise.all([
      sb.from('stock_alerts').select('*').eq('vendor_id', v.id).is('resolved_at', null).order('days_left', { ascending: true, nullsFirst: true }),
      sb.from('top_sales').select('*').eq('vendor_id', v.id).order('week_end', { ascending: false }).limit(300),
      sb.from('stock_review').select('*').eq('vendor_id', v.id).order('day', { ascending: false }).limit(300),
      names.length ? sb.from('big_purchases').select('*').gte('day', since).order('day', { ascending: false }) : Promise.resolve({ data: [] }),
    ]);
    const latest = (rows, f) => { const d = rows?.[0]?.[f]; return d ? rows.filter(r => r[f] === d) : []; };
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    S.stock = {
      low: (low.data || []).filter(a => !a.doubtful),
      top: latest(top.data || [], 'week_end'),
      over: latest((rev.data || []).filter(r => r.kind === 'overstock'), 'day'),
      slow: latest((rev.data || []).filter(r => r.kind === 'slow'), 'day'),
      big: (big.data || []).filter(b => names.some(nm => norm(b.supplier).includes(nm) || nm.includes(norm(b.supplier)) && norm(b.supplier))),
      error: low.error || top.error || rev.error || null,
    };
  }

  /* ---------------- small pieces ---------------- */
  function nextOrderDay(v) {
    for (let i = 0; i < 90; i++) { const d = addDaysStr(todayStr(), i); if (isVendorDueOn(v, d)) return d; }
    return null;
  }
  function waLink(p) {
    let d = String(p || '').replace(/\D/g, ''); if (d.length < 6) return '';
    if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '961' + d.slice(1); else if (!d.startsWith('961')) d = '961' + d;
    return 'https://wa.me/' + d;
  }
  const tile = (label, value, sub, cls = '') => `<div class="vs-tile ${cls}"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  function monthsChart(months) {
    const keys = Object.keys(months || {}).sort();
    if (!keys.length) return '<p class="muted-note" style="margin:0;">No purchases or sales in the period.</p>';
    const max = Math.max(1, ...keys.map(k => Math.max(months[k].bought, months[k].sold)));
    const W = Math.max(320, keys.length * 64), H = 150, pad = 24, bw = 18, step = (W - 16) / keys.length, y = x => H - pad - (x / max) * (H - pad - 12);
    const bar = (x, v, cls, t) => { const top = y(v), h = Math.max(0, H - pad - top); return h > 0 ? `<rect class="${cls}" x="${x}" y="${top}" width="${bw}" height="${h}" rx="3"><title>${esc(t)}</title></rect>` : ''; };
    return `<div class="vs-legend"><span><i class="vs-kb"></i>Purchases</span><span><i class="vs-ks"></i>Sales</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:200px;" role="img" aria-label="Purchases and sales per month">
        <line x1="8" x2="${W - 8}" y1="${H - pad}" y2="${H - pad}" stroke="currentColor" opacity=".2"/>
        ${keys.map((k, i) => { const cx = 8 + step * i + step / 2, m = months[k], lab = `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
          return bar(cx - bw - 1, m.bought, 'vs-b', `${lab} purchases ${money(m.bought)}`) + bar(cx + 1, m.sold, 'vs-s', `${lab} sales ${money(m.sold)}`)
            + `<text x="${cx}" y="${H - 7}" text-anchor="middle" font-size="10" fill="currentColor" opacity=".65">${lab}</text>`; }).join('')}
      </svg>`;
  }

  /* ---------------- the sheet ---------------- */
  function shell() {
    let o = el('vendorSheet');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'vendorSheet'; o.className = 'vs-overlay';
    o.innerHTML = '<div class="vs-sheet" role="dialog" aria-modal="true" aria-label="Vendor sheet"><div id="vsHead"></div><div class="vs-tabs" id="vsTabs"></div><div class="vs-body" id="vsBody"></div></div>';
    document.body.appendChild(o);
    o.addEventListener('mousedown', e => { if (e.target === o) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && o.classList.contains('open')) close(); });
    o.addEventListener('click', onClick);
    o.addEventListener('input', e => { if (e.target.id === 'vsQ') { S.q = e.target.value; const pos = e.target.selectionStart; paintBody(); const q = el('vsQ'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } } });
    o.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-code]'); if (tr && window.ItemDetail) ItemDetail.open(tr.dataset.code); });
    return o;
  }
  function onClick(e) {
    const t = e.target.closest('[data-vs]'); if (!t) return;
    const a = t.dataset.vs;
    if (a === 'close') return close();
    if (a === 'tab') { S.tab = t.dataset.tab; paintTabs(); paintBody(); return; }
    if (a === 'range') { S.range = Number(t.dataset.days); refresh(false); return; }
    if (a === 'reload') return refresh(true);
    if (a === 'sort') { const k = t.dataset.k; if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === 'description' ? 1 : -1; } return paintBody(); }
    if (a === 'edit') { const id = S.id; close(); document.querySelector('#vendorSubTabs [data-vsub="directory"]')?.click(); openVendorForm(id); return; }
    if (a === 'orders') { close(); ordersViewDate = todayStr(); document.querySelector('#vendorSubTabs [data-vsub="orders"]')?.click(); return; }
    if (a === 'receiving') { close(); document.querySelector('#vendorSubTabs [data-vsub="receiving"]')?.click(); return; }
    if (a === 'recv') {
      const v = vendor(); if (!v || !canData()) return;
      const d = Number(t.dataset.d), set = new Set(v.receivingDays || []);
      if (set.has(d)) set.delete(d); else set.add(d);
      v.receivingDays = [...set].sort();
      saveVendorRemote(v).then(ok => {
        if (!ok) return;
        showToast(v.receivingDays.length ? `${v.name}: received on ${v.receivingDays.map(x => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', ')}.` : `${v.name}: received on any open day.`);
        if (window.Warehouse) Warehouse.refresh();
        paintBody(); renderVendorsPage();
      });
      paintBody();
      return;
    }
    if (a === 'ordernow') { if (window.VendorOrder) VendorOrder.open(S.id); return; }
    if (a === 'delete') {
      const v = vendor(); if (!v) return;
      showConfirm(`Delete "${v.name}"?`, 'Delete').then(async ok => {
        if (!ok) return;
        await deleteVendorRemote(v.id);
        vendorsList = vendorsList.filter(x => x.id !== v.id);
        close(); renderVendorsPage(); showToast('Vendor deleted.');
      });
      return;
    }
    if (a === 'perf') { close(); switchTab('performance'); return; }
    if (a === 'stockpage') { close(); switchTab('stockcontrol'); return; }
  }
  function open(id) {
    const v = vendorsList.find(x => x.id === id); if (!v) return;
    S.id = id; S.tab = 'overview'; S.q = ''; S.sort = 'sold'; S.dir = -1; S.perf = null; S.stock = null;
    shell().classList.add('open');
    document.body.classList.add('vs-lock');
    paintHead(); paintTabs(); paintBody();
    refresh(false);
  }
  function close() { el('vendorSheet')?.classList.remove('open'); document.body.classList.remove('vs-lock'); }
  async function refresh(force) {
    const id = S.id;
    paintBody();
    await Promise.all([loadPerf(force), loadStock()]);
    if (S.id !== id) return;   // another vendor was opened meanwhile
    paintHead(); paintBody();
  }

  function paintHead() {
    const v = vendor(); if (!v) return;
    const t = todayStr(), pend = pendingOrderForVendor(v.id), notSent = notSentOrderForVendor(v.id);
    const dueToday = isVendorDueOn(v, t) && !pend && !notSent && !skipsList.some(s => s.vendorId === v.id && s.skipDate === t);
    const next = nextOrderDay(v), wa = waLink(v.phone);
    const freq = Number(v.frequencyWeeks || 1) === 1 ? 'every week' : `every ${v.frequencyWeeks} weeks`;
    const badges = [];
    if (dueToday) badges.push('<span class="badge warn">Order due today</span>');
    if (notSent) badges.push(`<span class="badge inactive">Order not sent (${esc(dmy(notSent.orderDate))})</span>`);
    if (pend) badges.push(isOrderOverdue(pend) ? `<span class="badge danger">Delivery late · expected ${esc(dmy(pend.expectedDelivery))}</span>` : `<span class="badge active">Awaiting delivery${pend.expectedDelivery ? ' · ' + esc(dmy(pend.expectedDelivery)) : ''}</span>`);
    if (S.stock && S.stock.low.length) badges.push(`<span class="badge danger">${S.stock.low.length} item${S.stock.low.length === 1 ? '' : 's'} running low</span>`);
    if (S.stock && S.stock.top.some(x => x.attention)) badges.push(`<span class="badge danger">${S.stock.top.filter(x => x.attention).length} selling fast, may run out</span>`);
    el('vsHead').innerHTML = `<div class="vs-head">
      <div class="vs-avatar" aria-hidden="true">${esc((v.name || '?').trim().charAt(0).toUpperCase())}</div>
      <div class="vs-title">
        <h2>${esc(v.name)} ${window.VendorContract ? VendorContract.chip(v.contract) : ''}</h2>
        <p class="muted-note">${[v.salesmanName ? esc(v.salesmanName) : '', v.phone ? `<a href="tel:${esc(String(v.phone).replace(/[^\d+]/g, ''))}">${esc(v.phone)}</a>` : '',
          v.dayOfWeek !== null && v.dayOfWeek !== undefined ? `${esc(VENDOR_DAY_NAMES[Number(v.dayOfWeek)])}, ${freq}` : '', v.leadTimeDays !== null && v.leadTimeDays !== undefined ? `${esc(v.leadTimeDays)} day lead time` : '',
          next ? `next order <b>${esc(dmy(next))}</b>` : ''].filter(Boolean).join(' · ') || 'No schedule on file.'}</p>
        <div class="vs-badges">${badges.join('')}</div>
      </div>
      <div class="vs-actions">
        ${v.phone ? `<a class="btn ghost small" href="tel:${esc(String(v.phone).replace(/[^\d+]/g, ''))}">Call</a>` : ''}
        ${wa ? `<a class="btn ghost small" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        ${canData() ? '<button type="button" class="btn small" data-vs="ordernow">Order now</button><button type="button" class="btn ghost small" data-vs="edit">Edit</button><button type="button" class="btn ghost small" data-vs="delete" style="color:var(--brick);">Delete</button>' : ''}
        <button type="button" class="icon-btn" data-vs="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div></div>`;
  }
  function paintTabs() {
    const tabs = [['overview', 'Overview'], ['items', 'Items'], ['orders', 'Orders'], ['stock', 'Stock'], ['contract', 'Contract']].filter(([k]) => canData() || k === 'orders');
    if (!canData()) S.tab = 'orders';
    el('vsTabs').innerHTML = tabs.map(([k, l]) => `<button type="button" data-vs="tab" data-tab="${k}" class="${k === S.tab ? 'active' : ''}">${l}${k === 'stock' && S.stock ? ` <span class="vs-n">${S.stock.low.length + S.stock.top.length + S.stock.over.length + S.stock.slow.length}</span>` : ''}</button>`).join('');
  }
  function paintBody() {
    const box = el('vsBody'); if (!box) return;
    paintTabs();
    box.innerHTML = ({ overview: overviewHtml, items: itemsHtml, orders: ordersHtml, stock: stockHtml, contract: contractHtml }[S.tab] || overviewHtml)();
  }

  /* ---------------- tabs ---------------- */
  const rangeBar = () => `<div class="filter-row vs-range" style="margin:0 0 10px;">${[[30, '30 days'], [90, '90 days'], [365, '12 months']].map(([d, l]) => `<button type="button" data-vs="range" data-days="${d}" class="${S.range === d ? 'active' : ''}">${l}</button>`).join('')}<button type="button" class="btn ghost small" data-vs="reload" title="Read again from the system">↻</button></div>`;
  function perfGuard() {
    const v = vendor(), p = S.perf;
    if (p && p.none) return `<div class="vs-note">${canData() ? `${esc(v.name)} is not linked to its supplier in the system yet, so sales and purchases can't be shown. <button type="button" class="btn small" data-vs="edit">Link it now</button>` : 'Not available.'}</div>`;
    if (!p) return `<div class="vs-note vs-loading">Reading ${esc(v.name)} from the system…</div>`;
    if (p.error) return `<div class="vs-note vs-err">${esc(p.error)} <button type="button" class="btn ghost small" data-vs="reload">Try again</button></div>`;
    return '';
  }
  const sums = items => {
    const t = { bought: 0, sold: 0, boughtQty: 0, soldQty: 0, profit: 0, pSales: 0, notSold: [], loss: [], items: items.length };
    items.forEach(i => { t.bought += i.bought; t.sold += i.sold; t.boughtQty += i.boughtQty; t.soldQty += i.soldQty;
      if (typeof i.profit === 'number') { t.profit += i.profit; t.pSales += i.sold; if (i.sold > 0 && i.profit / i.sold < -0.02) t.loss.push(i); }
      if (i.boughtQty > 0 && i.soldQty <= 0) t.notSold.push(i); });
    return t;
  };

  function overviewHtml() {
    const v = vendor(), g = perfGuard();
    const pend = pendingOrderForVendor(v.id), orders = ordersList.filter(o => o.vendorId === v.id);
    const delivered = orders.filter(o => o.status === 'delivered' && o.orderDate && o.deliveredDate);
    const avgLead = delivered.length ? Math.round(delivered.slice(0, 12).reduce((s, o) => s + Math.max(0, Math.round((new Date(o.deliveredDate) - new Date(o.orderDate)) / 864e5)), 0) / Math.min(12, delivered.length) * 10) / 10 : null;
    const lastDel = delivered.slice().sort((a, b) => b.deliveredDate.localeCompare(a.deliveredDate))[0];
    const facts = `<div class="vs-card"><h4>Schedule</h4><ul class="vs-facts">
        <li><span>Order day</span><b>${v.dayOfWeek !== null && v.dayOfWeek !== undefined ? esc(VENDOR_DAY_NAMES[Number(v.dayOfWeek)]) : '—'}</b></li>
        <li><span>Frequency</span><b>${esc(VENDOR_FREQ_LABELS[v.frequencyWeeks] || '—')}</b></li>
        <li><span>Lead time (set)</span><b>${v.leadTimeDays === null ? '—' : esc(v.leadTimeDays) + ' days'}</b></li>
        <li><span>Lead time (real)</span><b>${avgLead === null ? '—' : avgLead + ' days'}</b>${avgLead !== null && v.leadTimeDays !== null && Math.abs(avgLead - Number(v.leadTimeDays)) >= 1.5 ? `<em class="vs-warn">${avgLead > Number(v.leadTimeDays) ? 'slower' : 'faster'} than set</em>` : ''}</li>
        <li style="flex-wrap:wrap;"><span>Received on</span><div class="vs-recv" title="The warehouse receives this vendor only on the ticked days; none = any open day">${[1, 2, 3, 4, 5, 6].map(d => `<button type="button" data-vs="recv" data-d="${d}" class="${(v.receivingDays || []).includes(d) ? 'on' : ''}" ${canData() ? '' : 'disabled'}>${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}</button>`).join('')}</div></li>
        <li><span>Last delivery</span><b>${lastDel ? esc(dmy(lastDel.deliveredDate)) : '—'}</b></li>
        <li><span>Open order</span><b>${pend ? esc(dmy(pend.orderDate)) + (pend.expectedDelivery ? ' → ' + esc(dmy(pend.expectedDelivery)) : '') : 'none'}</b></li>
        <li><span>Orders logged</span><b>${orders.length}</b></li>
        <li><span>Stock keep</span><b>${v.coverDays ? esc(v.coverDays) + ' days' : 'default'}</b></li></ul>
      <div class="vs-links"><button type="button" class="btn ghost small" data-vs="orders">Orders</button><button type="button" class="btn ghost small" data-vs="receiving">Receiving</button></div></div>`;
    if (g) return `${rangeBar()}${g}<div class="vs-grid">${facts}</div>`;
    const t = sums(S.perf.items), d = t.bought > 0 ? (t.sold - t.bought) / t.bought : null, margin = t.pSales > 0 ? t.profit / t.pSales : null;
    const best = S.perf.items.slice().sort((a, b) => b.sold - a.sold).slice(0, 5);
    return `${rangeBar()}
      <div class="vs-tiles">
        ${tile('Purchases', money(t.bought), qty(t.boughtQty) + ' units')}
        ${tile('Sales', money(t.sold), qty(t.soldQty) + ' units')}
        ${tile('Sales vs purchases', d === null ? '—' : (d > 0 ? '+' : '') + Math.round(d * 100) + '%', money(t.sold - t.bought), d !== null && d < -0.2 ? 'bad' : d !== null && d > 0.2 ? 'ok' : '')}
        ${tile('Profit', money(t.profit), margin === null ? 'no cost known' : 'margin ' + (Math.round(margin * 1000) / 10) + '%', t.profit < 0 ? 'bad' : '')}
        ${tile('Items', t.items, `${t.notSold.length} bought, not sold`)}
      </div>
      <div class="vs-grid">
        <div class="vs-card vs-wide"><h4>Purchases and sales per month</h4>${monthsChart(S.perf.months)}</div>
        ${facts}
        <div class="vs-card"><h4>Needs attention</h4>
          ${t.notSold.length ? `<p><b>${t.notSold.length}</b> item${t.notSold.length === 1 ? '' : 's'} bought and not sold <span class="muted-note">(${money(t.notSold.reduce((s, i) => s + i.bought, 0))} bought)</span></p>
            <ul class="vs-list">${t.notSold.sort((a, b) => b.bought - a.bought).slice(0, 4).map(i => `<li data-code="${esc(i.code)}">${esc(i.description || i.code)} <b>${money(i.bought)}</b></li>`).join('')}</ul>` : '<p class="muted-note">Everything bought also sold.</p>'}
          ${t.loss.length ? `<p style="margin-top:8px;"><b class="vs-warn">${t.loss.length}</b> item${t.loss.length === 1 ? '' : 's'} sold below cost <span class="muted-note">(check the cost or the unit)</span></p>
            <ul class="vs-list">${t.loss.sort((a, b) => a.profit - b.profit).slice(0, 4).map(i => `<li data-code="${esc(i.code)}">${esc(i.description || i.code)} <b class="vs-warn">${money(i.profit)}</b></li>`).join('')}</ul>` : ''}
        </div>
        <div class="vs-card"><h4>Best sellers</h4>
          ${best.length ? `<ul class="vs-list">${best.map(i => `<li data-code="${esc(i.code)}">${esc(i.description || i.code)} <span class="muted-note">${qty(i.soldQty)} units</span> <b>${money(i.sold)}</b></li>`).join('')}</ul>` : '<p class="muted-note">No sales in the period.</p>'}
        </div>
      </div>
      <p class="muted-note" style="margin:8px 0 0;">${esc(dmy(S.perf.from))} → ${esc(dmy(S.perf.to))}, in USD as the system reports them (VAT included on both sides).</p>`;
  }

  function itemsHtml() {
    const g = perfGuard(); if (g) return rangeBar() + g;
    const q = S.q.trim().toLowerCase();
    const list = S.perf.items.map(i => ({ ...i, diff: i.sold - i.bought, dp: i.bought > 0 ? (i.sold - i.bought) / i.bought : null, margin: typeof i.profit === 'number' && i.sold > 0 ? i.profit / i.sold : null }))
      .filter(i => !q || (i.description || '').toLowerCase().includes(q) || String(i.code).toLowerCase().includes(q));
    const k = S.sort;
    list.sort((a, b) => S.dir * (k === 'description' ? String(a.description).localeCompare(String(b.description)) : (n(a[k] ?? -1e12) - n(b[k] ?? -1e12))));
    const th = (key, label, num = true) => `<th class="${num ? 'num' : ''} vs-sort" data-vs="sort" data-k="${key}">${label}${S.sort === key ? (S.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
    return `${rangeBar()}<div class="filter-row" style="margin:0 0 8px;"><input type="search" id="vsQ" placeholder="Find an item: code or name" value="${esc(S.q)}" style="min-width:240px;"><span class="muted-note">${list.length} item${list.length === 1 ? '' : 's'}</span></div>
      <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th>Code</th>${th('description', 'Item', false)}${th('boughtQty', 'Bought')}${th('bought', 'Purchases')}${th('soldQty', 'Sold')}${th('sold', 'Sales')}${th('dp', 'Sales vs purchases')}${th('profit', 'Profit')}${th('margin', 'Margin')}</tr></thead>
      <tbody>${list.slice(0, 400).map(i => `<tr data-code="${esc(i.code)}"><td class="mono">${esc(i.code)}</td><td>${esc(i.description || '')}</td><td class="num">${qty(i.boughtQty)}</td><td class="num">${money(i.bought)}</td><td class="num">${qty(i.soldQty)}</td><td class="num">${money(i.sold)}</td>
        <td class="num">${i.bought > 0 ? `<span class="${i.dp < -0.2 ? 'vs-warn' : i.dp > 0.2 ? 'vs-good' : ''}">${i.dp > 0 ? '+' : ''}${Math.round(i.dp * 100)}%</span>` : '<span class="muted-note">not bought</span>'}</td>
        <td class="num ${n(i.profit) < 0 ? 'vs-warn' : ''}">${typeof i.profit === 'number' ? money(i.profit) : ''}</td><td class="num">${i.margin === null ? '' : `<span class="${i.margin < 0 ? 'vs-warn' : ''}">${Math.round(i.margin * 1000) / 10}%</span>`}</td></tr>`).join('')
        || '<tr><td colspan="9" class="empty-note">Nothing bought or sold in the period.</td></tr>'}</tbody></table></div>
      <p class="muted-note" style="margin:6px 0 0;">Double-click an item for its details${list.length > 400 ? ' · showing the first 400' : ''}.</p>`;
  }

  function ordersHtml() {
    const v = vendor();
    const orders = ordersList.filter(o => o.vendorId === v.id), skips = skipsList.filter(s => s.vendorId === v.id);
    const rows = [...orders.map(o => ({ date: o.orderDate || '', o })), ...skips.map(s => ({ date: s.skipDate || '', s }))].sort((a, b) => b.date.localeCompare(a.date));
    const delivered = orders.filter(o => o.status === 'delivered').length, pend = orders.filter(o => o.status === 'pending').length, late = orders.filter(isOrderOverdue).length;
    return `<div class="vs-badges" style="margin:0 0 10px;"><span class="badge active">${orders.length} order${orders.length === 1 ? '' : 's'}</span>${delivered ? `<span class="badge active">${delivered} delivered</span>` : ''}${pend ? `<span class="badge warn">${pend} pending</span>` : ''}${late ? `<span class="badge danger">${late} late</span>` : ''}${skips.length ? `<span class="badge inactive">${skips.length} no-order</span>` : ''}</div>
      <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th>Ordered</th><th>Status</th><th>Expected</th><th>Delivered</th><th>Invoice</th><th>Receiving</th></tr></thead><tbody>${rows.map(r => {
        if (r.s) return `<tr><td class="mono">${esc(dmy(r.s.skipDate))}</td><td><span class="badge inactive">No order</span></td><td></td><td></td><td></td><td></td></tr>`;
        const o = r.o, st = o.status === 'delivered' ? '<span class="badge active">Delivered</span>' : o.status === 'not_sent' ? '<span class="badge inactive">Not sent</span>' : isOrderOverdue(o) ? '<span class="badge danger">Late</span>' : '<span class="badge warn">Pending</span>';
        const lt = o.status === 'delivered' && o.orderDate && o.deliveredDate ? Math.round((new Date(o.deliveredDate) - new Date(o.orderDate)) / 864e5) : null;
        return `<tr><td class="mono">${esc(dmy(o.orderDate))}</td><td>${st}</td><td class="mono">${esc(dmy(o.expectedDelivery))}</td><td class="mono">${esc(dmy(o.deliveredDate))}${lt !== null ? ` <span class="muted-note">(${lt}d)</span>` : ''}</td>
          <td class="mono">${esc(o.invoiceNo || '')}</td><td>${o.receiveStatus ? esc(o.receiveStatus === 'partial' ? 'Partial' : 'Complete') : ''}${o.receiveNote ? ` <span class="muted-note">${esc(o.receiveNote)}</span>` : ''}</td></tr>`; }).join('')
        || '<tr><td colspan="6" class="empty-note">No order logged for this vendor yet.</td></tr>'}</tbody></table></div>`;
  }

  function stockHtml() {
    const st = S.stock; if (!st) return '<div class="vs-note vs-loading">Reading the stock…</div>';
    if (st.error) return `<div class="vs-note vs-err">The stock tables could not be read (migrations 073–075 not run yet?).</div>`;
    const sec = (title, note, rows, head, row) => `<div class="vs-card vs-wide"><h4>${title} <span class="vs-n">${rows.length}</span></h4>${note ? `<p class="muted-note" style="margin:0 0 6px;">${note}</p>` : ''}
      ${rows.length ? `<div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr>${head}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>` : '<p class="muted-note" style="margin:0;">None.</p>'}</div>`;
    const days = r => r.days_left === null || r.days_left === undefined ? '—' : `<b class="${Number(r.days_left) < 3 ? 'vs-warn' : ''}">${qty(r.days_left)}</b>`;
    return `<div class="vs-grid vs-one">
      ${sec('Running low', 'Items that sold in the last 30 days and will not last the vendor\'s cover days.', st.low, '<th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Sells / week</th><th class="num">Days left</th>',
        a => `<tr data-code="${esc(a.code)}"><td class="mono">${esc(a.code)}</td><td>${esc(a.description || '')}</td><td class="num">${Number(a.stock) <= 0 ? '<b class="vs-warn">0</b>' : qty(a.stock)}</td><td class="num">${qty(n(a.per_day) * 7)}</td><td class="num">${a.days_left === null || Number(a.stock) <= 0 ? '<b class="vs-warn">out</b>' : days(a)}</td></tr>`)}
      ${sec('Selling more than usual', 'The latest daily count; ⚠ = may run out soon.', st.top.sort((a, b) => (b.attention - a.attention) || (n(b.sold_week) - n(b.usual_week)) - (n(a.sold_week) - n(a.usual_week))),
        '<th></th><th>Code</th><th>Item</th><th>View</th><th class="num">Sold</th><th class="num">Usually</th><th class="num">Times</th><th class="num">Stock</th><th class="num">Days left</th>',
        t => `<tr data-code="${esc(t.code)}"${t.attention ? ' class="vs-hot"' : ''}><td>${t.attention ? '<b class="vs-warn">⚠</b>' : ''}</td><td class="mono">${esc(t.code)}</td><td>${esc(t.description || '')}</td><td>${esc({ day: 'Day', week: 'Week', month: 'Month' }[t.period] || t.period)}</td><td class="num"><b>${qty(t.sold_week)}</b></td><td class="num">${qty(t.usual_week)}</td><td class="num">${qty(t.ratio)}×</td><td class="num">${t.stock === null ? '—' : qty(t.stock)}</td><td class="num">${days(t)}</td></tr>`)}
      ${sec('Overstock', 'Bought in the last 90 days, covering 12 weeks or more.', st.over.sort((a, b) => n(b.value) - n(a.value)), '<th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Weeks of stock</th><th class="num">Value</th>',
        r => `<tr data-code="${esc(r.code)}"><td class="mono">${esc(r.code)}</td><td>${esc(r.description || '')}</td><td class="num"><b>${qty(r.stock)}</b></td><td class="num">${r.weeks_cover === null ? 'no sales' : qty(r.weeks_cover)}</td><td class="num"><b>${money(r.value)}</b></td></tr>`)}
      ${sec('Slow movers', 'Selling at most half of what they sold before.', st.slow.sort((a, b) => n(b.value) - n(a.value)), '<th>Code</th><th>Item</th><th class="num">Before / week</th><th class="num">Now / week</th><th class="num">Stock</th><th class="num">Value</th>',
        r => `<tr data-code="${esc(r.code)}"><td class="mono">${esc(r.code)}</td><td>${esc(r.description || '')}</td><td class="num">${qty(r.prior_week)}</td><td class="num"><b>${qty(r.per_week)}</b></td><td class="num">${qty(r.stock)}</td><td class="num">${r.value === null ? '—' : money(r.value)}</td></tr>`)}
      ${sec('Big purchases', 'Far above the usual order, the last 30 days.', st.big, '<th>Day</th><th>PU</th><th>Item</th><th class="num">Bought</th><th class="num">Usually</th><th class="num">Weeks of sales</th>',
        b => `<tr data-code="${esc(b.code)}"><td>${esc(dmy(b.day))}</td><td class="mono">${esc(b.documents || '')}</td><td>${esc(b.description || '')}</td><td class="num"><b>${qty(b.qty)}</b></td><td class="num">${qty(b.usual_qty)}</td><td class="num">${b.weeks_cover === null ? 'no sales' : qty(b.weeks_cover)}</td></tr>`)}
      </div><div class="vs-links" style="margin-top:8px;"><button type="button" class="btn ghost small" data-vs="stockpage">Open Stock control</button></div>`;
  }

  function contractHtml() {
    const v = vendor(), c = v.contract || {}, VC = window.VendorContract;
    const has = c && (c.text || c.strategy || (c.margins && c.margins.length) || c.paymentDays || c.minOrder || c.signed || c.status || c.notes);
    if (!has) return `<div class="vs-note">No contract terms on file for ${esc(v.name)}. <button type="button" class="btn small" data-vs="edit">Add them</button></div>`;
    const margins = (c.margins || []).map(m => `<li><b>${VC && VC.marginLabel ? esc(VC.marginLabel(m)) : esc(`${m.type} ${m.value}${m.unit}`)}</b> <span class="muted-note">${m.basis === 'invoice' ? 'on invoice' : 'on statement' + (m.freq ? ', ' + esc(m.freq) : '')}${m.note ? ' · ' + esc(m.note) : ''}</span></li>`).join('');
    const f = (l, x) => x || x === 0 ? `<li><span>${l}</span><b>${esc(x)}</b></li>` : '';
    return `<div class="vs-grid">
      <div class="vs-card"><h4>Terms</h4><ul class="vs-facts">${f('Signed', c.signed)}${f('Status', c.status)}${f('Payment', c.paymentDays ? c.paymentDays + ' days' : '')}${f('Minimum order', c.minOrder ? '$' + c.minOrder : '')}
        ${f('Expired goods taken back', c.expiredReturns === 'yes' ? 'Yes' : c.expiredReturns === 'no' ? 'No' : '')}${f('From', c.from ? dmy(c.from) : '')}${f('To', c.to ? dmy(c.to) : '')}</ul></div>
      <div class="vs-card"><h4>Back margins</h4>${margins ? `<ul class="vs-list">${margins}</ul>` : '<p class="muted-note">None.</p>'}</div>
      ${c.strategy ? `<div class="vs-card"><h4>Pricing strategy</h4><p>${esc(c.strategy)}</p></div>` : ''}
      ${c.text ? `<div class="vs-card vs-wide"><h4>Contract</h4><p style="white-space:pre-wrap;">${esc(c.text)}</p></div>` : ''}
      ${c.notes ? `<div class="vs-card vs-wide"><h4>Notes</h4><p style="white-space:pre-wrap;">${esc(c.notes)}</p></div>` : ''}</div>`;
  }

  // the page's own data changed (an order was logged): repaint from it, without reading the system again
  function refreshLocal() { if (S.id && el('vendorSheet')?.classList.contains('open')) { paintHead(); paintBody(); } }
  window.VendorSheet = { open, close, refreshLocal };
})();
