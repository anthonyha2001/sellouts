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
      window.LowStock && LowStock.loadPOs ? LowStock.loadPOs().catch(() => null) : null,   // the system's POs (migration 082)
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
    o.addEventListener('dblclick', e => {
      const pt = e.target.closest('tr[data-pt]'); if (pt) return openPt(pt.dataset.pt, pt.dataset.year);
      const tr = e.target.closest('tr[data-code]'); if (tr && window.ItemDetail) ItemDetail.open(tr.dataset.code);
    });
    o.addEventListener('keydown', e => { const pt = e.target.closest?.('tr[data-pt]'); if (pt && e.key === 'Enter') openPt(pt.dataset.pt, pt.dataset.year); });
    return o;
  }
  function onClick(e) {
    const t = e.target.closest('[data-vs]'); if (!t) return;
    const a = t.dataset.vs;
    if (a === 'close') return close();
    if (a === 'tab') { S.tab = t.dataset.tab; paintTabs(); paintBody(); if (S.tab === 'pos' && (!S.pos || S.pos.id !== S.id)) loadPos(''); if (S.tab === 'pts' && (!S.pts || S.pts.id !== S.id || S.pts.days !== S.ptDays)) loadPts(); return; }
    if (a === 'ptrange') { S.ptDays = Number(t.dataset.days); return loadPts(); }
    if (a === 'ptreload') return loadPts();
    if (a === 'po') return loadPos(t.dataset.po || '');
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
    if (a === 'report') return openReport();
    if (a === 'noorder') { if (window.VendorOrder) VendorOrder.noOrder(S.id, todayStr()); return; }
    if (a === 'canceldraft') { if (window.VendorOrder) VendorOrder.cancelDraft(S.id); return; }
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
  function open(id, tab) {
    const v = vendorsList.find(x => x.id === id); if (!v) return;
    S.id = id; S.tab = tab || 'overview'; S.q = ''; S.sort = 'sold'; S.dir = -1; S.perf = null; S.stock = null; S.pos = null; S.pts = null;
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
    if (notSent) badges.push(`<span class="badge inactive">Order not sent (${esc(dmy(notSent.orderDate))})</span>${canData() ? '<button type="button" class="vs-canceldraft" data-vs="canceldraft" title="This order was never sent: cancel the draft (kept in the history)">Cancel draft</button>' : ''}`);
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
        ${/* owner, 2026-10-12: fewer buttons - Order now as the one text button, the rest as icons (no Call, like the vendor cards) */ ''}
        ${canData() ? '<button type="button" class="btn small" data-vs="ordernow">Order now</button>' : ''}
        ${wa ? `<a class="icon-btn vs-ic" href="${esc(wa)}" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4z"/><path d="M9 8.5c0 3.2 3.3 6.5 6.5 6.5l1.2-1.4-2-1-1 .9a5 5 0 0 1-2.9-2.9l.9-1-1-2z"/></svg></a>` : ''}
        ${canData() ? `<button type="button" class="icon-btn vs-ic" data-vs="report" title="Monthly report for the supplier" aria-label="Monthly report for the supplier"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 17v-3M12 17v-6M16 17v-4"/></svg></button>` : ''}
        ${canData() ? `<button type="button" class="icon-btn vs-ic" data-vs="noorder" title="No order today" aria-label="No order today"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg></button>
        <button type="button" class="icon-btn vs-ic" data-vs="edit" title="Edit" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
        <button type="button" class="icon-btn vs-ic vs-ic-del" data-vs="delete" title="Delete" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>` : ''}
        <button type="button" class="icon-btn" data-vs="close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div></div>`;
  }
  function paintTabs() {
    const tabs = [['overview', 'Overview'], ['items', 'Items'], ['orders', 'Orders'], ['pos', 'POs'], ['pts', 'Returns'], ['stock', 'Stock'], ['contract', 'Contract']].filter(([k]) => canData() || k === 'orders');
    if (!canData()) S.tab = 'orders';
    el('vsTabs').innerHTML = tabs.map(([k, l]) => `<button type="button" data-vs="tab" data-tab="${k}" class="${k === S.tab ? 'active' : ''}">${l}${k === 'stock' && S.stock ? ` <span class="vs-n">${S.stock.low.length + S.stock.top.length + S.stock.over.length + S.stock.slow.length}</span>` : ''}</button>`).join('');
  }
  function paintBody() {
    const box = el('vsBody'); if (!box) return;
    paintTabs();
    box.innerHTML = ({ overview: overviewHtml, items: itemsHtml, orders: ordersHtml, pos: posHtml, pts: ptsHtml, stock: stockHtml, contract: contractHtml }[S.tab] || overviewHtml)();
  }

  /* ---------------- POs tab (owner, 2026-10-11): the supplier's POs of the last 7 days, live from the system ---------------- */
  async function loadPos(po) {
    const v = vendor(), id = S.id; if (!v) return;
    const sups = (v.systemSuppliers || []).map(s => String(s.code || '')).filter(Boolean);
    if (!sups.length) { S.pos = { id, none: true }; return paintBody(); }
    S.pos = { id, loading: true, picked: po, prev: S.pos && S.pos.id === id ? S.pos.data : null }; paintBody();
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'vendor_pos', suppliers: sups, po } });
      let msg = data?.error || '';
      if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
      if (msg || error || !data) throw new Error(msg || 'no answer');
      if (S.id !== id) return;
      S.pos = { id, data };
    } catch (e) { if (S.id !== id) return; S.pos = { id, error: /Unknown action/i.test(e.message) ? 'Deploy the latest lv-dashboard to see the POs.' : 'The system did not answer: ' + e.message }; }
    if (S.tab === 'pos') paintBody();
  }
  function posHtml() {
    const v = vendor(), p = S.pos;
    if (!p || p.id !== S.id) return '<div class="vs-note vs-loading">Reading the POs from the system…</div>';
    if (p.none) return `<div class="vs-note">${esc(v.name)} is not linked to its supplier in the system yet, so its POs can't be found. <button type="button" class="btn small" data-vs="edit">Link it now</button></div>`;
    if (p.error) return `<div class="vs-note vs-err">${esc(p.error)} <button type="button" class="btn ghost small" data-vs="po">Try again</button></div>`;
    const d = p.loading ? p.prev : p.data;
    if (!d) return '<div class="vs-note vs-loading">Reading the POs of the last 7 days from the system…</div>';
    if (!d.po) return `<div class="vs-note">No PO for ${esc(v.name)} in the last 7 days (since ${esc(dmy(d.since))}). <button type="button" class="btn ghost small" data-vs="po">↻ Read again</button></div>`;
    const po = d.po, ls = po.lines || [], got = ls.filter(l => l.received > 0), delivered = got.length > 0;
    const missing = delivered ? ls.filter(l => !(l.received > 0)) : [], partial = ls.filter(l => l.received > 0 && l.received < l.qty);
    const age = daysSince(po.po_date);
    const status = !po.receivedRead ? '<span class="badge inactive">Delivery could not be read</span>'
      : !delivered ? `<span class="badge warn">Not delivered yet · ${age === 0 ? 'ordered today' : age + ' day' + (age === 1 ? '' : 's') + ' ago'}</span>`
      : missing.length || partial.length ? `<span class="badge danger">Delivered ${esc(dmy(got.map(l => l.received_on).sort()[0]))} · ${missing.length} not delivered${partial.length ? ` · ${partial.length} short` : ''}</span>`
      : `<span class="badge active">Delivered complete · ${esc(dmy(got.map(l => l.received_on).sort()[0]))}</span>`;
    const row = l => {
      const out = l.stock !== null && l.stock <= 0, miss = delivered && !(l.received > 0), short = l.received > 0 && l.received < l.qty;
      const rec = l.received > 0 ? `<b>${qty(l.received)}</b> <span class="muted-note">${esc(dmy(l.received_on).slice(0, 5))}</span>${short ? ' <em class="vs-warn">short</em>' : ''}`
        : miss ? '<em class="vs-warn">not delivered</em>' : '<span class="muted-note">—</span>';
      return `<tr data-code="${esc(l.code)}" class="${miss && out ? 'vs-hot' : ''}"><td class="mono">${esc(l.code)}</td><td>${esc(l.description)}</td><td class="num"><b>${qty(l.qty)}</b></td>
        <td class="num">${l.unit_price === null ? '—' : (Math.round(l.unit_price * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${rec}</td>
        <td class="num">${l.stock === null ? '<span class="muted-note">—</span>' : out ? `<b class="vs-warn">${qty(l.stock)}</b>` : qty(l.stock)}</td></tr>`;
    };
    return `${p.loading ? '<div class="vs-note vs-loading">Reading…</div>' : ''}
      <div class="filter-row vs-range" style="margin:0 0 10px;flex-wrap:wrap;">${d.pos.map(x => `<button type="button" data-vs="po" data-po="${esc(x.po)}" class="${x.po === po.po ? 'active' : ''}">${esc(x.po)} · ${esc(dmy(x.po_date).slice(0, 5))} · ${x.lines} line${x.lines === 1 ? '' : 's'}</button>`).join('')}
        <button type="button" class="btn ghost small" data-vs="po" data-po="${esc(po.po)}" title="Read again from the system">↻</button></div>
      <div class="vs-card vs-wide"><h4>${esc(po.po)} <span class="muted-note">· ${esc(dmy(po.po_date))} · ${ls.length} item${ls.length === 1 ? '' : 's'} · ${qty(ls.reduce((s, l) => s + l.qty, 0))} units${po.total ? ` · ${esc(po.currency || '$')}${(Math.round(po.total * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}</span></h4>
        <div class="vs-badges" style="margin:0 0 8px;">${status}</div>
        <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th>Code</th><th>Item</th><th class="num">Ordered</th><th class="num">Price</th><th>Delivered</th><th class="num">Stock now</th></tr></thead>
          <tbody>${ls.map(row).join('') || '<tr><td colspan="6" class="empty-note">No line on this PO.</td></tr>'}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Delivered = the units this supplier delivered of the item since the PO's day (its PUs). Red = not delivered and out of stock: ask the supplier. Double-click an item for its details.</p></div>`;
  }

  /* ---------------- Returns tab (owner, 2026-10-11): the supplier's PTs, live from the system; double-click one for its lines ---------------- */
  const call = async body => {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    let msg = data?.error || '';
    if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
    if (msg || error || !data) throw new Error(msg || 'no answer');
    return data;
  };
  const cur = (v, c) => (c && c !== '$' ? c + ' ' : '$') + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ptErr = e => /Unknown action/i.test(e.message) ? 'Deploy the latest lv-dashboard to see the returns.' : 'The system did not answer: ' + e.message;
  async function loadPts() {
    const v = vendor(), id = S.id; if (!v) return;
    S.ptDays = S.ptDays || 90;
    const sups = (v.systemSuppliers || []).map(s => String(s.code || '')).filter(Boolean), names = (v.systemSuppliers || []).map(s => String(s.name || '')).filter(Boolean);
    if (!sups.length) { S.pts = { id, days: S.ptDays, none: true }; return paintBody(); }
    const days = S.ptDays;
    S.pts = { id, days, loading: true }; if (S.tab === 'pts') paintBody();
    try {
      const data = await call({ action: 'vendor_pts', suppliers: sups, names, from: rangeFrom(days), to: todayStr() });
      if (S.id !== id || S.ptDays !== days) return;
      S.pts = { id, days, data };
    } catch (e) { if (S.id !== id) return; S.pts = { id, days, error: ptErr(e) }; }
    if (S.tab === 'pts') paintBody();
  }
  function ptsHtml() {
    const v = vendor(), p = S.pts, days = S.ptDays || 90;
    const bar = `<div class="filter-row vs-range" style="margin:0 0 10px;">${[[30, '30 days'], [90, '90 days'], [365, '12 months']].map(([d, l]) => `<button type="button" data-vs="ptrange" data-days="${d}" class="${days === d ? 'active' : ''}">${l}</button>`).join('')}<button type="button" class="btn ghost small" data-vs="ptreload" title="Read again from the system">↻</button></div>`;
    if (!p || p.id !== S.id || p.loading) return bar + '<div class="vs-note vs-loading">Reading the returns (PTs) from the system…</div>';
    if (p.none) return `<div class="vs-note">${esc(v.name)} is not linked to its supplier in the system yet, so its returns can't be found. <button type="button" class="btn small" data-vs="edit">Link it now</button></div>`;
    if (p.error) return bar + `<div class="vs-note vs-err">${esc(p.error)}</div>`;
    const list = p.data.pts || [];
    if (!list.length) return bar + `<div class="vs-note">No return (PT) to ${esc(v.name)} in the last ${days === 365 ? '12 months' : days + ' days'}.</div>`;
    const byCur = {}; list.forEach(x => { const c = x.currency || '$'; byCur[c] = (byCur[c] || 0) + n(x.withVat); });
    return bar + `<div class="vs-card vs-wide"><h4>${list.length} return${list.length === 1 ? '' : 's'} <span class="muted-note">· ${Object.entries(byCur).map(([c, t]) => cur(t, c)).join(' + ')} · ${qty(list.reduce((t, x) => t + n(x.qty), 0))} units</span></h4>
      <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th>PT</th><th>Date</th><th>Supplier in the system</th><th>Reference</th><th class="num">Lines</th><th class="num">Units</th><th class="num">Total</th></tr></thead>
        <tbody>${list.map(x => `<tr data-pt="${esc(x.pt)}" data-year="${esc(x.year)}" tabindex="0" class="vs-pt" title="Double-click to see its lines"><td class="mono"><b>${esc(x.pt)}</b></td><td>${esc(dmy(x.date))}</td><td>${esc(x.partner)}</td><td class="mono">${(x.refs || []).length ? esc(x.refs.length > 2 ? x.refs[0] + ' – ' + x.refs[x.refs.length - 1] : x.refs.join(', ')) : '<span class="muted-note">—</span>'}</td>
          <td class="num">${x.lines}</td><td class="num">${qty(x.qty)}</td><td class="num"><b>${cur(x.withVat, x.currency)}</b></td></tr>`).join('')}</tbody></table></div>
      ${p.data.truncated ? '<p class="vs-note vs-err" style="margin:8px 0 0;">Many return days: the oldest may be missing. Choose a shorter period.</p>' : ''}
      <p class="muted-note" style="margin:8px 0 0;">The returns to this supplier, from the system: a PT is found from the item cards of the days it delivered or returned (also a return made on the delivery day). A PT holding only some items of a delivery, without that day's main item, can still be missed. Double-click a PT (or Enter) to see its lines.</p></div>`;
  }
  // one PT, as the system has it: its lines in their order
  async function openPt(pt, yr) {
    let dlg = el('vsPtDlg');
    if (!dlg) {
      dlg = document.createElement('dialog'); dlg.id = 'vsPtDlg'; dlg.className = 'vs-pt-dlg'; document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-ptclose]')) dlg.close(); });
      dlg.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-today]'); if (tr && tr.dataset.today && window.ItemDetail) ItemDetail.open(tr.dataset.today); });
    }
    const head = t => `<div class="vs-pt-head"><h3>${esc(pt)}</h3>${t}<button type="button" class="icon-btn" data-ptclose title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`;
    dlg.innerHTML = head('') + '<div class="vs-note vs-loading">Reading the PT from the system…</div>';
    if (!dlg.open) dlg.showModal();
    try {
      const d = await call({ action: 'pt_detail', pt, year: yr });
      dlg.innerHTML = head(`<span class="muted-note">${esc(dmy(d.date))} · ${esc(d.partner)}${d.supplierCode ? ' · ' + esc(d.supplierCode) : ''}</span>`) + `
        <div class="items-scroll vs-scroll"><table class="items vs-table"><thead><tr><th class="num">#</th><th>Code</th><th>Item</th><th>Reference</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Disc.</th><th class="num">Total incl. VAT</th><th class="num">VAT</th></tr></thead>
          <tbody>${d.lines.map(l => `<tr data-today="${esc(l.today)}" ${l.today ? 'title="Double-click for the item details"' : ''}><td class="num muted-note">${l.line}</td><td class="mono">${esc(l.today || l.code)}</td><td>${esc(l.description)}${l.remarks ? `<div class="muted-note">${esc(l.remarks)}</div>` : ''}</td><td class="mono">${esc(l.ref || '')}</td>
            <td class="num"><b>${qty(l.qty)}</b></td><td class="num">${cur(l.unit, d.currency)}</td><td class="num">${l.disc ? l.disc + '%' : ''}</td><td class="num">${cur(l.withVat, d.currency)}</td><td class="num">${l.vat ? cur(l.vat, d.currency) : ''}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td></td><td></td><td><b>Total</b></td><td></td><td class="num"><b>${qty(d.qty)}</b></td><td></td><td class="num">${d.discountPct ? d.discountPct + '%' : ''}</td><td class="num"><b>${cur(d.withVat, d.currency)}</b></td><td class="num">${d.vat ? cur(d.vat, d.currency) : ''}</td></tr></tfoot></table></div>
        <p class="muted-note" style="margin:8px 0 0;">${d.lines.length} line${d.lines.length === 1 ? '' : 's'}, in the system's order. Without VAT ${cur(d.withoutVat, d.currency)}. Double-click an item for its details.</p>`;
    } catch (e) { dlg.innerHTML = head('') + `<div class="vs-note vs-err">${esc(ptErr(e))}</div>`; }
  }

  /* ---------------- the monthly supplier report (owner, 2026-10-12; migration 091) ----------------
     Their month against the one before (lv-dashboard supplier_report: sales and units, no cost), their sell-outs (units sold of
     their items that month), their rented spots; kept in supplier_reports with a private link (report.html?t=…, no sign-in). */
  const SPOT_NAMES = { endcap: 'End cap', side_gondola: 'Side gondola', basket_side: 'Basket side', display: 'Display', display_side: 'Display side', freezer: 'Fridge / freezer',
    fridge_door: 'Fridge door', wall_spot: 'Wall spot', pillar: 'Pillar', screen_wall: 'Screen', screen_island: 'Screen', promo_table: 'Promo table', promo_zone: 'Promo zone' };
  const reportLink = token => location.origin + location.pathname.replace(/[^/]*$/, '') + 'report.html?t=' + token;
  async function openReport() {
    const v = vendor(); if (!v) return;
    const sups = (v.systemSuppliers || []).map(s => String(s.code || '')).filter(Boolean);
    if (!sups.length) return showToast(`${v.name} is not linked to its supplier in the system: Edit › Watch stock › Supplier in the system.`, true);
    let dlg = el('vsRepDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'vsRepDlg'; dlg.className = 'vs-pt-dlg vs-rep-dlg'; document.body.appendChild(dlg); dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-repclose]')) dlg.close(); }); }
    const t = todayStr(), months = Array.from({ length: 6 }, (_, i) => { const d = new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1 - i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
    const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const mName = ym => `${MON[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}${ym === t.slice(0, 7) ? ' (so far)' : ''}`;
    const { data: past } = await sb.from('supplier_reports').select('token, month, created_at').eq('vendor_id', v.id).order('created_at', { ascending: false }).limit(12);
    dlg.innerHTML = `<div class="vs-pt-head"><h3>Monthly report · ${esc(v.name)}</h3><button type="button" class="icon-btn" data-repclose title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>
      <div class="vs-rep-bar"><select id="vsRepMonth">${months.map((m, i) => `<option value="${m}" ${i === 1 ? 'selected' : ''}>${mName(m)}</option>`).join('')}</select>
        <button type="button" class="btn small" id="vsRepMake">Make the report</button>
        ${(past || []).length ? `<select id="vsRepPast"><option value="">Made before…</option>${past.map(p => `<option value="${esc(p.token)}">${mName(String(p.month).slice(0, 7))} · made ${esc(new Date(p.created_at).toLocaleDateString('en-GB'))}</option>`).join('')}</select>` : ''}</div>
      <div id="vsRepOut"><p class="muted-note">No cost and no margin in it: their sales and units against the month before, their best items, what did not sell, their sell-outs and their spots. It opens without signing in, by its private link.</p></div>`;
    if (!dlg.open) dlg.showModal();
    el('vsRepPast')?.addEventListener('change', e => { if (e.target.value) showLink(v, e.target.value, null); });
    el('vsRepMake').onclick = async () => {
      const ym = el('vsRepMonth').value, btn = el('vsRepMake');
      btn.disabled = true; el('vsRepOut').innerHTML = '<p class="muted-note">Reading their month from the system…</p>';
      try {
        const data = await call({ action: 'supplier_report', suppliers: sups, month: ym });
        const from = data.from, to = data.to, qty = new Map((data.items || []).map(x => [x.code, n(x.qty)]));
        // their sell-outs that month: by the supplier's name in the system, the units sold of their items
        const names = new Set((v.systemSuppliers || []).map(s => String(s.name || '').trim().toUpperCase()).concat([String(v.name).trim().toUpperCase()]));
        const { data: sos } = await sb.from('sellouts').select('name, supplier, from, to, items, priced_items').lte('from', to).gte('to', from);
        data.sellouts = (sos || []).filter(s => names.has(String(s.supplier || '').trim().toUpperCase())).map(s => {
          const list = (Array.isArray(s.priced_items) && s.priced_items.length ? s.priced_items : Array.isArray(s.items) ? s.items : []).map(r => String(r.code ?? r.Code ?? r.CODE ?? '').trim()).filter(Boolean);
          return { name: s.name, from: s.from, to: s.to, items: list.length, units: list.reduce((tt, c) => tt + (qty.get(c) || 0), 0) };
        });
        // their rented spots that month (no amount)
        const { data: cs } = await sb.from('rental_contracts').select('supplier, spot_id, term, start_date, end_date').neq('term', 'temporary').lte('start_date', to).gte('end_date', from);
        const mine = (cs || []).filter(c => String(c.supplier || '').trim().toLowerCase() === String(v.name).trim().toLowerCase());
        const ids = [...new Set(mine.map(c => c.spot_id).filter(Boolean))];
        const objs = ids.length ? ((await sb.from('store_map_objects').select('id, type, label').in('id', ids)).data || []) : [];
        data.spots = mine.map(c => { const o = objs.find(x => x.id === c.spot_id); return { what: o ? [SPOT_NAMES[o.type] || o.type, o.label].filter(Boolean).join(' · ') : 'Spot', from: c.start_date, to: c.end_date }; });
        data.vendor = v.name;
        const { data: row, error } = await sb.from('supplier_reports').insert({ vendor_id: v.id, vendor_name: v.name, month: ym + '-01', data }).select('token, vendor_name, month, data, created_at').single();
        if (error) throw new Error(/supplier_reports/.test(error.message) ? 'The supplier reports are not set up yet (migration 091).' : error.message);
        showLink(v, row.token, row);
        logActivity('vendors', 'report', { type: 'vendor', id: v.id }, `Monthly report for ${v.name} (${mName(ym)})`);
      } catch (e) { el('vsRepOut').innerHTML = `<p class="vs-note vs-err">${esc(e.message === 'no answer' ? 'The system did not answer.' : e.message)}</p>`; }
      finally { btn.disabled = false; }
    };
  }
  async function showLink(v, token, row) {
    if (!row) { const { data } = await sb.from('supplier_reports').select('token, vendor_name, month, data, created_at').eq('token', token).single(); row = data; }
    if (!row) return;
    const link = reportLink(token), wa = waLink(v.phone);
    const text = `Hello, here is your monthly report from La Valeur Ajaltoun: ${link}`;
    el('vsRepOut').innerHTML = `<div class="vs-rep-share">
        <a class="btn small" href="${esc(link)}" target="_blank" rel="noopener">Open (print / PDF)</a>
        <button type="button" class="btn ghost small" id="vsRepCopy">Copy link</button>
        ${wa ? `<a class="btn ghost small" href="${esc(wa + '?text=' + encodeURIComponent(text))}" target="_blank" rel="noopener">WhatsApp to ${esc(v.name)}</a>` : `<a class="btn ghost small" href="${esc('https://wa.me/?text=' + encodeURIComponent(text))}" target="_blank" rel="noopener">WhatsApp</a>`}
        <span class="muted-note">Anyone with the link can open it (read only).</span></div>
      <div class="vs-rep-prev">${window.SupplierReportView ? SupplierReportView.html(row) : ''}</div>`;
    el('vsRepCopy').onclick = async () => { try { await navigator.clipboard.writeText(link); showToast('Link copied.'); } catch (e) { showToast(link); } };
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
    const dv = window.VendorBoard && VendorBoard.delivery ? VendorBoard.delivery(v.id) : { last: null, avg: null, onTime: 0, judged: 0 };
    const avgLead = dv.avg, lastDel = dv.last;
    const facts = `<div class="vs-card"><h4>Schedule</h4><ul class="vs-facts">
        <li><span>Order day</span><b>${v.dayOfWeek !== null && v.dayOfWeek !== undefined ? esc(VENDOR_DAY_NAMES[Number(v.dayOfWeek)]) : '—'}</b></li>
        <li><span>Frequency</span><b>${esc(VENDOR_FREQ_LABELS[v.frequencyWeeks] || '—')}</b></li>
        <li><span>Lead time (set)</span><b>${v.leadTimeDays === null ? '—' : esc(v.leadTimeDays) + ' days'}</b></li>
        <li><span>Lead time (real)</span><b>${avgLead === null ? '—' : avgLead + ' days'}</b>${avgLead !== null && v.leadTimeDays !== null && Math.abs(avgLead - Number(v.leadTimeDays)) >= 1.5 ? `<em class="vs-warn">${avgLead > Number(v.leadTimeDays) ? 'slower' : 'faster'} than set</em>` : ''}</li>
        <li style="flex-wrap:wrap;"><span>Received on</span><div class="vs-recv" title="The warehouse receives this vendor only on the ticked days; none = any open day">${[1, 2, 3, 4, 5, 6].map(d => `<button type="button" data-vs="recv" data-d="${d}" class="${(v.receivingDays || []).includes(d) ? 'on' : ''}" ${canData() ? '' : 'disabled'}>${['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}</button>`).join('')}</div></li>
        <li><span>Last order → received</span><b>${lastDel ? `${lastDel.ordered ? esc(dmy(lastDel.ordered)) : '—'} → ${esc(dmy(lastDel.received))}${lastDel.took !== null ? ` · ${lastDel.took}d` : ''}` : '—'}</b>${lastDel && lastDel.lateBy > 0 ? `<em class="vs-warn">${lastDel.lateBy}d late</em>` : ''}</li>
        <li><span>On time</span><b>${dv.judged ? `${dv.onTime}/${dv.judged} last deliveries` : '—'}</b>${dv.judged && dv.onTime / dv.judged < .7 ? '<em class="vs-warn">often late</em>' : ''}</li>
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
        const o = r.o, st = o.status === 'cancelled' ? '<span class="badge danger">Cancelled</span>' : o.status === 'delivered' ? '<span class="badge active">Delivered</span>' : o.status === 'not_sent' ? '<span class="badge inactive">Not sent</span>' : isOrderOverdue(o) ? '<span class="badge danger">Late</span>' : '<span class="badge warn">Pending</span>';
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
    // the system's POs next to the items out of stock, and this vendor's items not delivered (js/modules/lowstock.js)
    const LS = window.LowStock && LowStock.poFlag ? LowStock : null;
    const k = c => String(c || '').trim().replace(/^0+(?=\d)/, '');
    const sups = new Set((vendor().systemSuppliers || []).map(s => k(s.code)).filter(Boolean));
    const na = LS && LS.notAvailable ? LS.notAvailable().filter(l => sups.has(k(l.supplier_code))) : [];
    return `<div class="vs-grid vs-one">
      ${na.length ? sec('Not available', 'Ordered on a PO, the supplier delivered the PO without them, still out of stock: ask the supplier.', na,
        '<th>Code</th><th>Item</th><th>PO</th><th>Ordered</th><th class="num">Qty</th><th>PO delivered</th>',
        l => `<tr data-code="${esc(l.code)}" class="vs-hot"><td class="mono">${esc(l.code)}</td><td>${esc(l.description || '')}</td><td class="mono">${esc(l.po)}</td><td>${esc(dmy(l.po_date))}</td><td class="num">${qty(l.qty)}</td><td>${esc(dmy(l.po_delivered_on))}</td></tr>`) : ''}
      ${sec('Running low', 'Items that sold in the last 30 days and will not last the vendor\'s cover days.', st.low, `<th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Sells / week</th><th class="num">Days left</th>${LS ? '<th>Order</th>' : ''}`,
        a => `<tr data-code="${esc(a.code)}"><td class="mono">${esc(a.code)}</td><td>${esc(a.description || '')}</td><td class="num">${Number(a.stock) <= 0 ? '<b class="vs-warn">0</b>' : qty(a.stock)}</td><td class="num">${qty(n(a.per_day) * 7)}</td><td class="num">${a.days_left === null || Number(a.stock) <= 0 ? '<b class="vs-warn">out</b>' : a.ghost ? `<b class="vs-warn" title="Sells on ${a.days_sold} of 30 days, no sale for ${a.quiet_days} days while the system shows stock: the shelf is most likely empty">check shelf</b>` : days(a)}</td>${LS ? `<td>${LS.poFlag(a.code, Number(a.stock) <= 0)}</td>` : ''}</tr>`)}
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
