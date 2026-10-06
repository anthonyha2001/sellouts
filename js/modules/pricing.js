/* ============================================================
   Pricing (owner, 2026-10-06): a wizard over the purchases of one day,
   live from the system (lv-dashboard pricing_day / pricing_supplier).
     1. the day
     2. the suppliers that delivered that day
     3. PU by PU (supplier by supplier): every line with its price, the
        previous purchase price and the difference, the stock we had when
        it arrived; the PU's total and its flags in the footer.
   Two tabs: Purchases (the wizard, deliveries only) and Returns (every
   item returned to a supplier, PT, between two days: grouped by PT, with
   the last purchase price on request).
   Flags: a price different from the previous purchase (net price, or the
   real cost of a trade deal), and an item that arrived while we already
   had more than 2 months of stock (stock before / daily sales of the 90
   days before > 60, or stock that did not sell at all).
   Speed: a supplier's PU lines come first (part 'lines'), the previous
   purchase, the stock we had and the sale price fill in after (part
   'more'); the next supplier loads in the background meanwhile.
   New sale price (owner, 2026-10-06): typed per line, kept for the day on
   this device, and downloaded as one Excel for the floor manager (what
   changed: old and new sale price, the purchase price behind it).
   Find a PU (owner, 2026-10-06): type its number (PU0010852, 10852, PC…,
   PT…): it opens on its day, supplier and PU (a return: under Returns).
   Keys: up / down move along the rows, left / right go to the previous /
   next PU, Enter opens the item's details.
   Permission: vendors.manage.  Public API: window.Pricing = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const OVER_DAYS = 60;
  // the system's catch-all items (any goods, any price): never compared
  const GENERIC = /MARCHANDISE|SANS TVA|DIVERS|MISC/i;
  const el = id => document.getElementById(id);
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : '—'; };
  const qty = v => (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US');
  // a price in its PU's currency: LBP whole, $ with 3 decimals at most
  const isLbp = c => /l\.?l|lbp|ل/i.test(String(c || '')) ;
  const price = (v, cur) => v === null || v === undefined ? '—' : (n(v) >= 1000 || isLbp(cur))
    ? Math.round(n(v)).toLocaleString('en-US') : (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const S = { day: null, list: null, supIdx: 0, cache: new Map(), loading: new Map(), pus: [], puIdx: 0, sel: 0, busy: false, wired: false, tab: 'purchases', np: new Map() };
  // the new sale prices typed for the day (kept on this device until downloaded; one per item)
  const npKey = () => 'lv.pricing.newprices.' + S.day;
  const npLoad = () => { S.np = new Map(); try { (JSON.parse(localStorage.getItem(npKey()) || '[]')).forEach(e => S.np.set(e.code, e)); } catch (e) { /* no storage */ } };
  const npSave = () => { try { localStorage.setItem(npKey(), JSON.stringify([...S.np.values()])); } catch (e) { /* no storage */ } };
  const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
  const npButton = () => `<button type="button" class="icon-btn pr-np-dl" data-np-dl title="Download the new sale prices (Excel) for the floor manager" aria-label="Download the new sale prices">${ICON_DL}${S.np.size ? `<span class="pr-np-count">${S.np.size}</span>` : ''}</button>`;
  // the suppliers the wizard goes through: the ones that delivered (a supplier that only returned goods is under Returns)
  const sups = () => (S.list?.suppliers || []).filter(x => x.value > 0);

  function show() {
    const root = el('panel-pricing'); if (!root) return;
    if (!S.day) S.day = todayStr();
    if (!root.dataset.built) {
      root.dataset.built = '1';
      root.innerHTML = `<div class="pr-topbar"><div class="filter-row pr-tabs" id="prTabs"><button type="button" data-t="purchases" class="active">Purchases</button><button type="button" data-t="returns">Returns</button></div>
        <form class="pr-find" id="prFind" autocomplete="off"><input type="search" id="prFindQ" placeholder="Find a PU (PU0010852 or 10852)" aria-label="Find a PU by its number">
          <button type="submit" class="icon-btn" title="Find the PU" aria-label="Find the PU"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button></form></div>
        <div id="prWiz"><div class="pr-steps" id="prSteps"></div><div id="prBody"></div></div><div id="prRet" hidden></div>`;
      el('prTabs').onclick = e => { const b = e.target.closest('[data-t]'); if (b) tab(b.dataset.t); };
      el('prFind').onsubmit = e => { e.preventDefault(); findPu(el('prFindQ').value); };
    }
    if (S.tab === 'returns') return tab('returns');
    if (!S.wired) { S.wired = true; document.addEventListener('keydown', onKey); }
    if (S.list && S.pus.length) paintPu(); else if (S.list) paintSuppliers(); else paintDay();
  }
  const active = () => el('panel-pricing')?.classList.contains('active') && S.tab === 'purchases';
  function tab(t, opts) {
    S.tab = t;
    el('prTabs').querySelectorAll('[data-t]').forEach(b => b.classList.toggle('active', b.dataset.t === t));
    el('prWiz').hidden = t !== 'purchases'; el('prRet').hidden = t !== 'returns';
    if (t === 'returns') Returns.show(opts);
    else if (S.list && S.pus.length) paintPu(); else if (S.list) paintSuppliers(); else paintDay();
  }
  function steps(k) {
    el('prSteps').innerHTML = ['Day', 'Suppliers', 'Purchases'].map((t, i) => `<button type="button" class="pr-step${i === k ? ' on' : ''}${i < k ? ' done' : ''}" data-step="${i}" ${i > k ? 'disabled' : ''}><b>${i + 1}</b> ${t}</button>`).join('<span class="pr-step-sep"></span>');
    el('prSteps').querySelectorAll('[data-step]').forEach(b => b.onclick = () => { const i = Number(b.dataset.step); if (i === 0) paintDay(); if (i === 1 && S.list) paintSuppliers(); });
  }
  // a request that never ends (the system stuck) is given up after 90 s: the page says so and stays usable
  async function call(body) {
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('The system is taking too long to answer. Try again in a moment.')), 90000); });
    const { data, error } = await Promise.race([sb.functions.invoke('lv-dashboard', { body }), late]).finally(() => clearTimeout(timer));
    if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer. Check the "Link to the system" card on the Dashboard.');
    return data;
  }

  /* ---------------- 1. the day ---------------- */
  function paintDay() {
    steps(0); S.pus = [];
    el('prBody').innerHTML = `<div class="card pr-day">
      <h3>Which day's purchases?</h3>
      <p class="muted-note">Every PU of that day, supplier by supplier: the price against the previous purchase, and the stock we had when it arrived.</p>
      <div class="pr-day-row"><input type="date" id="prDay" value="${esc(S.day)}" max="${esc(todayStr())}">
        <div class="filter-row" style="margin:0;"><button type="button" data-d="0">Today</button><button type="button" data-d="1">Yesterday</button></div>
        <button type="button" class="btn" id="prNext">Next</button></div></div>`;
    el('prBody').querySelectorAll('[data-d]').forEach(b => b.onclick = () => { const d = new Date(todayStr() + 'T00:00:00'); d.setDate(d.getDate() - Number(b.dataset.d)); el('prDay').value = d.toLocaleDateString('en-CA'); });
    el('prNext').onclick = loadDay;
    el('prDay').onkeydown = e => { if (e.key === 'Enter') loadDay(); };
  }
  async function loadDay() {
    const d = el('prDay').value; if (!d) return showToast('Choose a day.', true);
    if (S.day !== d || !S.list) { S.cache.clear(); S.loading.clear(); S.list = null; }
    S.day = d; npLoad();
    if (!S.list) {
      el('prNext').disabled = true; el('prNext').textContent = 'Reading…';
      try { S.list = await call({ action: 'pricing_day', day: d }); }
      catch (e) { showToast(e.message, true); el('prNext').disabled = false; el('prNext').textContent = 'Next'; return; }
    }
    paintSuppliers();
  }

  /* ---------------- 2. the suppliers ---------------- */
  function flagsOf(code) { const c = S.cache.get(code); if (!c) return null; const p = puList(c); if (!p.length) return { none: true }; if (!c.moreReady) return { checking: true, pus: p.length }; return { price: p.reduce((t, x) => t + x.flags.price.length, 0), over: p.reduce((t, x) => t + x.flags.over.length, 0), pus: p.length }; }
  function paintSuppliers() {
    steps(1); S.pus = [];
    const L = sups(), backOnly = S.list.suppliers.filter(x => x.value <= 0);
    el('prBody').innerHTML = `<div class="card">
      <div class="pr-head"><h3>${L.length} supplier${L.length === 1 ? '' : 's'} delivered on ${esc(dmy(S.list.day))}</h3><span style="flex:1"></span>
        ${npButton()}${L.length ? '<button type="button" class="btn" id="prStart">Check them one by one</button>' : ''}</div>
      <div class="items-scroll"><table class="items pr-sups"><thead><tr><th>Supplier</th><th class="num">Items</th><th class="num">Value ($)</th><th>Checked</th></tr></thead>
        <tbody>${L.map((s, i) => { const f = flagsOf(s.code); return `<tr data-i="${i}" tabindex="0"><td><b>${esc(s.name)}</b> <span class="muted-note mono">${esc(s.code)}</span></td><td class="num">${s.items}</td>
          <td class="num">${s.value < 0 ? `<span class="pr-ret">${Math.round(s.value).toLocaleString('en-US')}</span><div class="pr-sub">returned</div>` : Math.round(s.value).toLocaleString('en-US')}</td>
          <td>${f?.none ? '<span class="muted-note">no line found</span>' : f?.checking ? `${f.pus} PU${f.pus === 1 ? '' : 's'} · <span class="muted-note">checking…</span>` : f ? `${f.pus} PU${f.pus === 1 ? '' : 's'}${f.price ? ` · <span class="pr-flag-price">${f.price} price change${f.price === 1 ? '' : 's'}</span>` : ''}${f.over ? ` · <span class="pr-flag-over">${f.over} over 2 months</span>` : ''}${!f.price && !f.over ? ' · <span class="pr-ok">nothing flagged</span>' : ''}` : '<span class="muted-note">not yet</span>'}</td></tr>`; }).join('')
          || '<tr><td colspan="4" class="empty-note">No purchase on that day.</td></tr>'}</tbody></table></div>
      ${backOnly.length ? `<p class="muted-note pr-backonly">${backOnly.length} supplier${backOnly.length === 1 ? '' : 's'} only returned goods that day (${backOnly.map(x => esc(x.name)).join(', ')}). <button type="button" class="btn small secondary" id="prSeeRet">See the returns</button></p>` : ''}</div>`;
    el('prSeeRet')?.addEventListener('click', () => tab('returns', { from: S.list.day, to: S.list.day }));
    el('prStart')?.addEventListener('click', () => openSupplier(0));
    el('prBody').querySelector('[data-np-dl]')?.addEventListener('click', npExcel);
    if (L.length) prefetch(0);   // the first supplier is ready when you start
    el('prBody').querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => openSupplier(Number(tr.dataset.i)); tr.onkeydown = e => { if (e.key === 'Enter') openSupplier(Number(tr.dataset.i)); }; });
  }

  /* ---------------- 3. PU by PU ---------------- */
  // one row per item per PU: its lines (paid + free), the previous purchase, the stock we had
  function puList(data) {
    const pus = new Map(), pending = !data.moreReady;
    data.items.forEach(it => {
      // the previous purchase: the last PU before this day (one PU: never several mixed)
      const prevDocs = it.prev?.docs || [];
      const pd = [...prevDocs].reverse().find(d => n(d.paidQty) > 0) || prevDocs[prevDocs.length - 1];
      const docPrice = d => { const p = d.lines.find(l => !l.free); const u = n(d.paidQty) + n(d.freeQty); return { net: p ? p.net : null, real: u ? n(d.paid) / u : null, deal: !!d.tradeDeal, currency: d.currency || '' }; };
      const prevFailed = !!it.prev?.failed;
      let prev = it.prev && pd ? { date: it.prev.date, ...docPrice(pd), docs: pd.doc } : null;
      const perDay = n(it.soldBefore) / Math.max(1, n(it.salesDays) || 90);
      const had = it.stockBefore === null || it.stockBefore === undefined ? null : n(it.stockBefore);
      const daysHad = had !== null && had > 0 && perDay > 0 ? had / perDay : null;
      const overArr = had !== null && had > 0.001 && (perDay > 0 ? daysHad > OVER_DAYS : true);
      (it.docs || []).filter(d => d.kind !== 'return').forEach(d => {
        const paid = d.lines.find(l => !l.free);
        const real = n(d.paidQty) + n(d.freeQty) !== 0 ? n(d.paid) / (n(d.paidQty) + n(d.freeQty)) : null;
        const net = paid ? paid.net : null;
        const same = prev && (prev.currency || '') === (d.currency || '');
        const diffNet = same && net !== null && prev.net !== null ? net - prev.net : null;
        const diffReal = same && real !== null && prev.real !== null && (d.tradeDeal || prev.deal) ? real - prev.real : null;
        const changed = (x, base) => x !== null && Math.abs(x) > Math.max(0.0005, Math.abs(n(base)) * 0.0001);
        const generic = GENERIC.test(String(it.description || '')), back = d.kind === 'return';
        const priceFlag = !pending && !prevFailed && !generic && (changed(diffNet, prev?.net) || changed(diffReal, prev?.real));
        const row = { it, doc: d, paid, net, real, prev: prev ? { ...prev } : null, diffNet, diffReal, priceFlag, otherCurrency: prev && !same, had, perDay, daysHad, overArr: !pending && overArr && !generic && !back, generic, pending, prevFailed };
        if (!pus.has(d.doc)) pus.set(d.doc, { doc: d.doc, kind: d.kind || 'purchase', currency: d.currency, rows: [] });
        pus.get(d.doc).rows.push(row);
        if (!back && paid) prev = { date: S.day, ...docPrice(d), docs: d.doc, sameDay: true };
      });
    });
    const kk = c => String(c).replace(/^0+(?=\d)/, '').toUpperCase();
    return [...pus.values()].sort((a, b) => a.doc.localeCompare(b.doc)).map(p => ({ ...p, pending, failed: !!data.moreFailed,
      info: data.docInfo?.[p.doc] || null,
      // the lines shown against the PU in the system: quantities per item (a line missing or different is said)
      mismatch: (() => { const v = data.docInfo?.[p.doc]; if (!v || v.failed || !v.items) return [];
        const shown = {}; p.rows.forEach(r => { const k = kk(r.it.code); shown[k] = (shown[k] || 0) + Math.abs(n(r.doc.paidQty) + n(r.doc.freeQty)); });
        const keys = new Set([...Object.keys(v.items), ...Object.keys(shown)]);
        return [...keys].filter(k => Math.abs(n(v.items[k]?.qty) - n(shown[k])) > 0.001); })(), unread: p.rows.filter(r => r.prevFailed).length,
      total: p.rows.reduce((t, r) => t + n(r.doc.paid), 0),
      flags: { price: p.rows.filter(r => r.priceFlag), over: p.rows.filter(r => r.overArr) } }));
  }
  // a supplier: its PU lines first (the promise resolves then), the comparisons after (a repaint when they arrive)
  function fetchSupplier(code) {
    if (S.loading.has(code)) return S.loading.get(code);
    const day = S.day;
    const p = (async () => {
      const data = await call({ action: 'pricing_supplier', day, supplier: code, part: 'lines', name: (S.list?.suppliers || []).find(x => x.code === code)?.name || '' });
      data.moreReady = false;
      if (day === S.day) { S.cache.set(code, data); fetchMore(code, data, day); }
      return data;
    })();
    p.catch(() => { if (S.loading.get(code) === p) S.loading.delete(code); });
    S.loading.set(code, p);
    return p;
  }
  async function fetchMore(code, data, day) {
    try {
      const docs = [...new Map(data.items.flatMap(i => (i.docs || []).map(d => [d.doc, { doc: d.doc, ret: d.kind === 'return' }]))).values()];
      const m = await call({ action: 'pricing_supplier', day, supplier: code, part: 'more', codes: data.items.map(i => i.code), docs });
      data.docInfo = m.docs || {};
      // VAT per item, from the PU documents (empty = no VAT)
      const kk = c => String(c).replace(/^0+(?=\d)/, '').toUpperCase();
      data.items.forEach(it => { const hits = (it.docs || []).map(d => data.docInfo[d.doc]?.items?.[kk(it.code)]).filter(Boolean); if (hits.length) it.vat = hits.some(h => Math.abs(n(h.vat)) > 0.0001); });
      const by = new Map(m.items.map(x => [x.code, x]));
      data.items.forEach(it => { const x = by.get(it.code); if (!x) return; const { code: _c, pcBarcode, ...rest } = x; Object.assign(it, rest); if (!it.barcode && pcBarcode) it.barcode = pcBarcode; });
    } catch (e) { data.moreFailed = true; }
    data.moreReady = true;
    if (day === S.day) refresh(code);
    // this one is done: now the next one, in the background (one at a time: lighter on the system)
    if (day === S.day && sups()[S.supIdx]?.code === code && S.pus.length) prefetch(S.supIdx + 1);
  }
  // repaint what is on screen when a supplier's comparisons arrive (same PU, same row)
  function refresh(code) {
    if (S.tab !== 'purchases') return;
    if (S.pus.length && sups()[S.supIdx]?.code === code && el('prBody').querySelector('.pr-pu')) {
      const doc = S.pus[S.puIdx]?.doc; S.pus = puList(S.cache.get(code));
      const k = S.pus.findIndex(p => p.doc === doc); if (k >= 0) S.puIdx = k;
      paintPu();
    } else if (!S.pus.length && el('prBody').querySelector('.pr-sups')) paintSuppliers();
  }
  const prefetch = i => { const x = sups()[i]; if (x && !S.loading.has(x.code)) fetchSupplier(x.code).catch(() => {}); };
  // find a PU by its number: its day, its supplier, then that PU (a return goes to Returns)
  async function findPu(q) {
    q = String(q || '').trim(); if (!q) return showToast('Type a PU number.', true);
    const btn = el('prFind').querySelector('button'); btn.disabled = true; btn.classList.add('ls-spin');
    try {
      const r = await call({ action: 'pu_find', q });
      if (!r.found) return showToast(`${r.doc} was not found in the system (this year or last year).`, true);
      if (r.ret) { tab('returns', { from: r.day, to: r.day, q: r.doc }); showToast(`${r.doc}: a return to ${r.partner}, on ${dmy(r.day)}.`); return; }
      if (S.tab !== 'purchases') tab('purchases');
      if (S.day !== r.day || !S.list) { S.day = r.day; npLoad(); S.cache.clear(); S.loading.clear(); S.list = null; S.pus = [];
        el('prBody').innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">${esc(r.doc)} · ${esc(r.partner)} · ${esc(dmy(r.day))}: reading that day…</p></div>`;
        S.list = await call({ action: 'pricing_day', day: r.day }); }
      const key = x => String(x || '').toUpperCase().replace(/\s+\d+\s*$/, '').replace(/[^A-Z0-9\u0600-\u06FF]/g, '');
      const L = sups(); let i = L.findIndex(x => key(x.name) === key(r.partner));
      if (i < 0) i = L.findIndex(x => key(x.name).startsWith(key(r.partner).slice(0, 6)) || key(r.partner).startsWith(key(x.name).slice(0, 6)));
      if (i < 0) { paintSuppliers(); return showToast(`${r.doc} is from ${r.partner} on ${dmy(r.day)}, not found in that day's list: open it from the list.`, true); }
      await openSupplier(i);
      const k = S.pus.findIndex(p => p.doc === r.doc);
      if (k >= 0) { S.puIdx = k; S.sel = 0; paintPu(); }
      else showToast(`${r.doc} has no line found for ${r.partner} that day.`, true);
      el('prFindQ').value = '';
    } catch (e) { showToast(e.message, true); }
    finally { btn.disabled = false; btn.classList.remove('ls-spin'); }
  }
  async function openSupplier(i, atEnd) {
    const s = sups()[i]; if (!s) return;
    S.supIdx = i;
    const had = S.cache.get(s.code);
    if (had?.moreFailed) { had.moreFailed = false; had.moreReady = false; fetchMore(s.code, had, S.day); }
    if (!S.cache.has(s.code)) {
      steps(2);
      el('prBody').innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">Reading the PU of ${esc(s.name)} (${s.items} item${s.items === 1 ? '' : 's'})… a few seconds</p></div>`;
      S.busy = true;
      try { await fetchSupplier(s.code); }
      catch (e) { S.busy = false; showToast(e.message, true); paintSuppliers(); return; }
      S.busy = false;
      if (S.supIdx !== i || S.tab !== 'purchases') return;
    }
    S.pus = puList(S.cache.get(s.code));
    S.puIdx = atEnd ? Math.max(0, S.pus.length - 1) : 0; S.sel = 0;
    if (!S.pus.length) { showToast(`${s.name}: no delivery found in the cardex for that day (returns are under Returns).`, true); paintSuppliers(); return; }
    paintPu();
    if (S.cache.get(s.code)?.moreReady) prefetch(i + 1);   // the next supplier, while you check this one (else once this one is fully checked)
  }
  function go(step) {
    if (S.busy) return;
    const k = S.puIdx + step;
    if (k >= 0 && k < S.pus.length) { S.puIdx = k; S.sel = 0; paintPu(); return; }
    const j = S.supIdx + step;
    if (j < 0) return showToast('This is the first PU of the day.');
    if (j >= sups().length) { showToast('That was the last PU of the day.'); paintSuppliers(); return; }
    openSupplier(j, step < 0);
  }
  // the tags: price increase / decrease, check the stock
  const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
  const ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7l10 10M17 9v8H9"/></svg>';
  const ICON_STOCK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>';
  const priceDir = r => { const x = r.diffNet !== null && Math.abs(r.diffNet) > 0.0005 ? r.diffNet : r.diffReal; return n(x) > 0 ? 'up' : 'down'; };
  const priceTag = r => priceDir(r) === 'up' ? `<span class="pr-tag pr-tag-up">${ICON_UP}Price increase</span>` : `<span class="pr-tag pr-tag-down">${ICON_DOWN}Price decrease</span>`;
  const stockTag = r => `<span class="pr-tag pr-tag-stock" title="We had ${qty(r.had)}${r.daysHad !== null ? ` = ${Math.round(r.daysHad)} days of sales` : ', with no sales in the 90 days before'} when it arrived">${ICON_STOCK}Check stock</span>`;
  function diffHtml(x, base, cur) {
    if (x === null) return '';
    if (Math.abs(x) <= Math.max(0.0005, Math.abs(n(base)) * 0.0001)) return '<span class="pr-ok">same</span>';
    const p = n(base) ? ` (${x > 0 ? '+' : ''}${(Math.round(x / n(base) * 1000) / 10).toLocaleString('en-US')}%)` : '';
    return `<span class="${x > 0 ? 'prc-up' : 'prc-down'}">${x > 0 ? '+' : '-'}${price(Math.abs(x), cur)}${p}</span>`;
  }
  function paintPu() {
    steps(2);
    const s = sups()[S.supIdx], pu = S.pus[S.puIdx], cur = pu.currency;
    const nPu = S.pus.length;
    el('prBody').innerHTML = `<div class="card pr-pu">
      <div class="pr-head">
        <button type="button" class="icon-btn" data-go="-1" title="Previous PU (left arrow)" aria-label="Previous PU"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="pr-title"><h3>${pu.kind === 'return' ? '<span class="pr-ret-tag">Return to supplier</span> ' : ''}${esc(pu.doc)} <span class="muted-note">· ${esc(s.name)}</span></h3>
          <span class="muted-note">${esc(dmy(S.day))} · PU ${S.puIdx + 1} of ${nPu} · supplier ${S.supIdx + 1} of ${sups().length} · ${pu.rows.length} line${pu.rows.length === 1 ? '' : 's'} · prices in ${esc(cur || '$')}</span></div>
        ${npButton()}
        <button type="button" class="icon-btn" data-go="1" title="Next PU (right arrow)" aria-label="Next PU"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
      <div class="items-scroll pr-scroll"><table class="items pr-table"><thead><tr>
        <th>Code</th><th>Description</th><th>Barcode</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Net</th>
        <th class="num">Previous</th><th class="num">Difference</th><th class="num" title="The stock we had when it arrived, and how many days of sales that was">Stock we had</th><th class="num">Sale price now</th><th class="num" title="Type the new sale price: downloaded for the floor manager">New sale price</th></tr></thead>
        <tbody>${pu.rows.map((r, i) => `<tr data-r="${i}" class="${i === S.sel ? 'pr-sel' : ''}${r.priceFlag ? ' pr-row-price' : ''}${r.overArr ? ' pr-row-over' : ''}">
          <td class="mono">${esc(r.it.code)}</td><td>${r.it.vat ? '<span class="pr-vat" title="This item has VAT on the PU">VAT</span> ' : ''}${esc(r.it.description || '')}${n(r.it.pack) > 1 ? ` <span class="muted-note">· pack ${n(r.it.pack)}</span>` : ''}${(r.it.otherSuppliers || []).length ? `<div class="pr-sub" title="${esc(r.it.otherSuppliers.join(', '))}">also delivered today by ${r.it.otherSuppliers.length === 1 ? esc(r.it.otherSuppliers[0]) : `${r.it.otherSuppliers.length} other suppliers`}</div>` : ''}</td>
          <td class="mono pr-sub-txt">${esc(r.it.barcode || '')}</td>
          <td class="num">${qty(r.doc.paidQty)}${n(r.doc.freeQty) ? ` <span class="po-free">+ ${qty(r.doc.freeQty)} free</span>` : ''}</td>
          <td class="num">${r.paid ? price(r.paid.unit, cur) : '—'}${r.paid?.discountPct ? `<div class="pr-sub">-${r.paid.discountPct}%</div>` : ''}</td>
          <td class="num"><b>${price(r.net, cur)}</b>${r.doc.tradeDeal ? `<div class="pr-sub"><span class="lp-deal">trade deal</span> real ${price(r.real, cur)}</div>` : ''}</td>
          <td class="num">${r.pending ? '<span class="pr-wait" title="Checking…">…</span>' : r.prevFailed ? '<span class="login-err">could not be read</span>' : r.prev ? `${price(r.prev.net, r.prev.currency)}${r.prev.deal ? ` <span class="pr-sub">real ${price(r.prev.real, r.prev.currency)}</span>` : ''}<div class="pr-sub">${esc(dmy(r.prev.date))} · ${esc(r.prev.docs || '')}${r.prev.sameDay ? ' (same day)' : ''}${r.otherCurrency ? ` · in ${esc(r.prev.currency)}` : ''}</div>` : r.it.prev ? `<span class="muted-note">no price found</span><div class="pr-sub">${esc(dmy(r.it.prev.date))}</div>` : '<span class="muted-note">no earlier purchase</span>'}</td>
          <td class="num">${r.priceFlag ? priceTag(r) : ''}${r.pending ? '<span class="pr-wait" title="Checking…">…</span>' : r.generic ? '<span class="muted-note">catch-all item</span>' : r.otherCurrency ? '<span class="muted-note">other currency</span>' : diffHtml(r.diffNet, r.prev?.net, cur)}${r.diffReal !== null && Math.abs(r.diffReal) > 0.0005 ? `<div class="pr-sub">real ${diffHtml(r.diffReal, r.prev?.real, cur)}</div>` : ''}</td>
          <td class="num">${r.overArr ? stockTag(r) : ''}${r.had === null ? '—' : qty(r.had)}<div class="pr-sub${r.overArr ? ' pr-flag-over' : ''}">${r.pending ? '…' : r.generic ? '' : r.daysHad !== null ? `${Math.round(r.daysHad)} days` : r.had > 0.001 && !(r.perDay > 0) ? 'no sales in 90 days' : ''}</div></td>
          <td class="num">${r.pending ? '<span class="pr-wait" title="Checking…">…</span>' : r.it.priceFailed ? '<span class="login-err">could not be read</span>' : r.it.salePrice ? price(r.it.salePrice, r.it.saleCurrency || '$') : '—'}</td>
          <td class="num"><input type="text" inputmode="decimal" class="pr-np${S.np.has(r.it.code) ? ' set' : ''}" data-np="${i}" value="${S.np.has(r.it.code) ? esc(String(S.np.get(r.it.code).newPrice)) : ''}" placeholder="${r.it.salePrice ? esc(price(r.it.salePrice, r.it.saleCurrency || '$')) : ''}" aria-label="New sale price of ${esc(r.it.description || r.it.code)}"></td></tr>`).join('')}</tbody></table></div>
      <div class="pr-foot">
        <div class="pr-total"><span>${pu.kind === 'return' ? 'Total returned' : 'Total'} ${esc(pu.doc)}</span><b>${price(pu.info && !pu.info.failed ? (pu.kind === 'return' ? -pu.info.withVat : pu.info.withVat) : pu.total, cur)} ${esc(cur || '$')}</b>
          ${pu.info && !pu.info.failed ? `<div class="pr-vatline">without VAT ${price(pu.info.withoutVat, cur)} · VAT ${price(pu.info.vat, cur)}${pu.info.discountPct ? ` · discount ${pu.info.discountPct}%` : ''}</div>` : ''}</div>
        <div class="pr-flags">
          ${pu.mismatch.length ? `<div class="login-err">The PU in the system differs from these lines on ${pu.mismatch.length} item${pu.mismatch.length === 1 ? '' : 's'} (${esc(pu.mismatch.slice(0, 6).join(', '))}): check the PU in the system.</div>` : ''}
          ${pu.info?.discountPct ? `<div class="pr-flagline"><span class="pr-tag pr-tag-stock">Discount ${pu.info.discountPct}%</span> <span class="muted-note">on the whole PU: the line prices are before it.</span></div>` : ''}
          ${pu.unread && !pu.pending ? `<div class="login-err">${pu.unread} previous price${pu.unread === 1 ? '' : 's'} could not be read from the system (not compared). <button type="button" class="btn small secondary" id="prRetry">Read again</button></div>` : ''}
          ${pu.pending ? '<span class="muted-note pr-checking">Checking the previous prices and the stock we had…</span>' : pu.failed ? '<span class="login-err">The previous prices could not be read. Open the supplier again to retry.</span>' : ''}
        </div>
      </div>
      <p class="muted-note" style="margin:8px 0 0;">Up / down: move along the rows · left / right: previous / next PU · Enter or double-click: the item's details. New sale price: type it, Enter goes to the next line; the download button gives the floor manager every new price of the day. Stock we had = the stock just before the PU; days = that stock / what sold per day in the 90 days before.</p>
    </div>`;
    el('prBody').querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
    el('prRetry')?.addEventListener('click', () => { const code = sups()[S.supIdx]?.code, d = S.cache.get(code); if (!d) return; d.items.forEach(it => { if (it.prev?.failed) delete it.prev; }); d.moreReady = false; refresh(code); fetchMore(code, d, S.day); });
    el('prBody').querySelectorAll('tr[data-r]').forEach(tr => { tr.onclick = () => select(Number(tr.dataset.r)); tr.ondblclick = () => openItem(); });
    el('prBody').querySelector('[data-np-dl]')?.addEventListener('click', npExcel);
    const boxes = [...el('prBody').querySelectorAll('[data-np]')];
    boxes.forEach((inp, k) => {
      inp.onfocus = () => { select(Number(inp.dataset.np), false); inp.select(); };
      inp.onclick = e => e.stopPropagation();
      inp.onchange = () => npSet(pu.rows[Number(inp.dataset.np)], inp, s, pu);
      inp.onkeydown = e => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); npSet(pu.rows[Number(inp.dataset.np)], inp, s, pu); boxes[k + 1]?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); npSet(pu.rows[Number(inp.dataset.np)], inp, s, pu); boxes[k - 1]?.focus(); }
        else if (e.key === 'Escape') { inp.blur(); }
      };
    });
  }
  // keep (or clear) one new sale price, with what it is based on
  function npSet(r, inp, sup, pu) {
    const txt = inp.value.trim().replace(/,/g, '');
    if (!txt) { if (S.np.delete(r.it.code)) { npSave(); inp.classList.remove('set'); npCount(); } return; }
    const v = Number(txt);
    if (!Number.isFinite(v) || v <= 0) { showToast('Type a price (a number).', true); inp.value = S.np.get(r.it.code)?.newPrice ?? ''; return; }
    S.np.set(r.it.code, { code: r.it.code, description: r.it.description || '', barcode: r.it.barcode || '', supplier: sup.name, doc: pu.doc, day: S.day,
      vat: r.it.vat ? 'VAT' : '', oldPrice: r.it.salePrice ?? null, currency: r.it.saleCurrency || '$', newPrice: v,
      cost: r.net ?? null, costCurrency: pu.currency || '$', prevCost: r.prev?.net ?? null, costChange: r.priceFlag ? (priceDir(r) === 'up' ? 'Price increase' : 'Price decrease') : '', at: new Date().toISOString() });
    npSave(); inp.classList.add('set'); npCount();
  }
  const npCount = () => el('prBody').querySelectorAll('[data-np-dl]').forEach(b => { b.querySelector('.pr-np-count')?.remove(); if (S.np.size) b.insertAdjacentHTML('beforeend', `<span class="pr-np-count">${S.np.size}</span>`); });
  // the Excel for the floor manager: every new sale price of the day
  function npExcel() {
    const L = [...S.np.values()].sort((a, b) => a.supplier.localeCompare(b.supplier) || a.doc.localeCompare(b.doc) || a.description.localeCompare(b.description));
    if (!L.length) return showToast('Type a new sale price on at least one line first.', true);
    const r3 = v => v === null || v === undefined || v === '' ? '' : Math.round(Number(v) * 1000) / 1000;
    const aoa = [['New sale prices'], ['Purchases of', dmy(S.day)], ['Made', new Date().toLocaleString('en-GB')], [],
      ['Code', 'Description', 'Barcode', 'VAT', 'Old sale price', 'New sale price', 'Change', 'Change %', 'Currency', 'Supplier', 'PU', 'Purchase price', 'Previous purchase price', 'Cost']];
    const first = aoa.length;
    L.forEach(e => { const ch = e.oldPrice ? e.newPrice - e.oldPrice : null;
      aoa.push([e.code, e.description, e.barcode, e.vat || '', r3(e.oldPrice), r3(e.newPrice), ch === null ? '' : r3(ch), ch === null ? '' : Math.round(ch / e.oldPrice * 1000) / 10, e.currency, e.supplier, e.doc, r3(e.cost), r3(e.prevCost), e.costChange]); });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let i = first; i < aoa.length; i++) ['A', 'C'].forEach(c => { const x = ws[c + (i + 1)]; if (x) { x.t = 's'; x.v = String(x.v); } });
    ws['!cols'] = [10, 40, 15, 6, 13, 14, 10, 9, 9, 28, 12, 14, 20, 15].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'New prices');
    XLSX.writeFile(wb, `New sale prices ${dmy(S.day)}.xlsx`);
    if (typeof logActivity === 'function') logActivity('pricing', 'new_prices_export', null, `New sale prices of ${dmy(S.day)}: ${L.length} items`);
  }
  function select(i, scroll = true) {
    const rows = el('prBody').querySelectorAll('tr[data-r]'); if (!rows.length) return;
    S.sel = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('pr-sel', k === S.sel));
    if (scroll) rows[S.sel].scrollIntoView({ block: 'nearest' });
  }
  function openItem() { const r = S.pus[S.puIdx]?.rows[S.sel]; if (r && window.ItemDetail) ItemDetail.open(r.it.code); }
  function onKey(e) {
    if (!active() || !S.pus.length || !el('prBody').querySelector('.pr-pu')) return;
    if (e.target.closest('input, textarea, select') || document.querySelector('.modal-overlay.open')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); select(S.sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(S.sel - 1); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openItem(); }
  }
  /* ---------------- Returns: every item returned to a supplier between two days ---------------- */
  const Returns = (() => {
    const R = { from: null, to: null, lines: [], q: '', prev: false, seq: 0, done: 0, total: 0, busy: false, built: false };
    const addDays = (d, k) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + k); return x.toLocaleDateString('en-CA'); };
    const daysOf = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
    const prevOf = l => { const docs = l.prev?.docs || []; const p = docs.flatMap(d => d.lines).find(x => !x.free); return p ? { date: l.prev.date, net: p.net, currency: docs[0]?.currency || '' } : l.prev ? { date: l.prev.date, net: null } : null; };
    function show(opts) {
      const box = el('prRet');
      if (!R.from) { R.from = opts?.from || S.day || todayStr(); R.to = opts?.to || R.from; }
      if (opts?.from) { R.from = opts.from; R.to = opts.to || opts.from; R.lines = []; R.total = 0; }
      if (opts?.q !== undefined) R.q = opts.q;
      if (!R.built) {
        R.built = true;
        box.innerHTML = `<div class="card pr-ret-controls">
            <label>From <input type="date" id="rtFrom" max="${esc(todayStr())}"></label><label>to <input type="date" id="rtTo" max="${esc(todayStr())}"></label>
            <div class="filter-row" id="rtQuick" style="margin:0;"><button type="button" data-q="0">Today</button><button type="button" data-q="1">Yesterday</button><button type="button" data-q="7">Last 7 days</button><button type="button" data-q="m">This month</button></div>
            <button type="button" class="btn small" id="rtLoad">Load</button>
            <span style="flex:1"></span>
            <input type="search" id="rtQ" placeholder="Find a supplier, an item, a PT" aria-label="Find">
            <button type="button" class="icon-btn" id="rtPrev" title="Compare with the last purchase price (slower)" aria-label="Compare with the last purchase price"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg></button>
            <button type="button" class="icon-btn" id="rtXls" title="Download (Excel)" aria-label="Download (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button>
          </div><div id="rtBody"></div>`;
        el('rtQuick').onclick = e => { const b = e.target.closest('[data-q]'); if (!b) return; const t = todayStr(), q = b.dataset.q;
          if (q === 'm') { el('rtFrom').value = t.slice(0, 8) + '01'; el('rtTo').value = t; }
          else if (q === '7') { el('rtFrom').value = addDays(t, -6); el('rtTo').value = t; }
          else { el('rtFrom').value = el('rtTo').value = addDays(t, -Number(q)); }
          load(); };
        el('rtLoad').onclick = () => load();
        el('rtQ').oninput = () => { R.q = el('rtQ').value; paint(); };
        el('rtPrev').onclick = () => { if (R.prev) return; R.prev = true; el('rtPrev').classList.add('on'); load(); };
        el('rtXls').onclick = xls;
      }
      el('rtFrom').value = R.from; el('rtTo').value = R.to; el('rtQ').value = R.q;
      if (!R.lines.length && !R.busy) load(); else paint();
    }
    async function load() {
      const a = el('rtFrom').value, b = el('rtTo').value;
      if (!a || !b || a > b) return showToast('Choose the dates (from before to).', true);
      const days = daysOf(a, b);
      if (days.length > 31) return showToast('Choose up to 31 days.', true);
      const my = ++R.seq; R.from = a; R.to = b; R.lines = []; R.done = 0; R.total = days.length; R.busy = true; R.failed = [];
      paint();
      for (const d of days.reverse()) {                       // the latest day first
        try { const x = await call({ action: 'returns_range', from: d, to: d, withPrev: R.prev }); if (my !== R.seq) return; R.lines.push(...x.lines); }
        catch (e) { if (my !== R.seq) return; R.failed.push(d); }
        R.done++; paint();
      }
      R.busy = false; paint();
      if (R.failed.length) showToast(`The system did not answer for ${R.failed.map(dmy).join(', ')}.`, true);
    }
    const filtered = () => { const q = R.q.trim().toLowerCase(); return !q ? R.lines : R.lines.filter(l => [l.supplierName, l.description, l.code, l.barcode, l.doc].some(v => String(v || '').toLowerCase().includes(q))); };
    function paint() {
      const box = el('rtBody'); if (!box) return;
      const L = filtered();
      const docs = new Map(); L.forEach(l => { if (!docs.has(l.doc)) docs.set(l.doc, { doc: l.doc, day: l.day, supplier: l.supplierName || l.supplier, currency: l.currency, lines: [] }); docs.get(l.doc).lines.push(l); });
      const D = [...docs.values()].sort((a, b) => b.day.localeCompare(a.day) || a.doc.localeCompare(b.doc));
      const byCur = {}; L.forEach(l => { const c = l.currency || '$'; byCur[c] = (byCur[c] || 0) - n(l.paid); });
      const units = L.reduce((t, l) => t - n(l.paidQty) - n(l.freeQty), 0);
      const progress = R.busy ? `<p class="muted-note pr-progress">Reading the returns… ${R.done} of ${R.total} day${R.total === 1 ? '' : 's'}${R.prev ? ', with the last purchase prices (slower)' : ''}</p>` : '';
      const cols = R.prev ? 10 : 8;
      box.innerHTML = `${progress}
        <div class="pf-tiles">
          <div class="pf-tile"><span>Returns (PT)</span><b>${D.length}</b><small>${esc(dmy(R.from))}${R.to !== R.from ? ' → ' + esc(dmy(R.to)) : ''}</small></div>
          <div class="pf-tile"><span>Items returned</span><b>${L.length}</b><small>${qty(units)} units</small></div>
          <div class="pf-tile"><span>Value returned</span><b>${Object.entries(byCur).map(([c, v]) => `${price(v, c)} ${esc(c)}`).join('<br>') || '0'}</b></div>
          <div class="pf-tile"><span>Suppliers</span><b>${new Set(L.map(l => l.supplier)).size}</b></div>
        </div>
        <div class="card"><div class="items-scroll pr-scroll"><table class="items pr-table rt-table"><thead><tr>
          <th>Code</th><th>Description</th><th>Barcode</th><th class="num">Qty returned</th><th class="num">Unit price</th><th class="num">Net</th><th class="num">Total</th><th class="num" title="Our stock after the return">Stock after</th>
          ${R.prev ? '<th class="num">Last purchase</th><th class="num">Difference</th>' : ''}</tr></thead>
          <tbody>${D.map(d => `<tr class="rt-doc"><td colspan="${cols}"><span class="pr-ret-tag">${esc(d.doc)}</span> <b>${esc(d.supplier)}</b> <span class="muted-note">· ${esc(dmy(d.day))} · ${d.lines.length} item${d.lines.length === 1 ? '' : 's'} · total ${price(-d.lines.reduce((t, l) => t + n(l.paid), 0), d.currency)} ${esc(d.currency || '$')}</span></td></tr>`
            + d.lines.map(l => { const p = l.lines.find(x => !x.free) || l.lines[0], pv = R.prev ? prevOf(l) : null;
              const same = pv && pv.net !== null && (pv.currency || '') === (l.currency || ''), diff = same && p ? p.net - pv.net : null;
              return `<tr data-code="${esc(l.code)}"><td class="mono">${esc(l.code)}</td><td>${esc(l.description || '')}</td><td class="mono pr-sub-txt">${esc(l.barcode || '')}</td>
                <td class="num"><b>${qty(-n(l.paidQty))}</b>${n(l.freeQty) ? ` <span class="po-free">+ ${qty(-n(l.freeQty))} free</span>` : ''}</td>
                <td class="num">${p ? price(p.unit, l.currency) : '—'}${p?.discountPct ? `<div class="pr-sub">-${p.discountPct}%</div>` : ''}</td><td class="num">${p ? price(p.net, l.currency) : '—'}</td>
                <td class="num">${price(-n(l.paid), l.currency)}</td><td class="num">${qty(l.stockAfter)}</td>
                ${R.prev ? `<td class="num">${pv ? (pv.net !== null ? price(pv.net, pv.currency) : '<span class="muted-note">no price found</span>') + `<div class="pr-sub">${esc(dmy(pv.date))}</div>` : '<span class="muted-note">no earlier purchase</span>'}</td>
                  <td class="num">${diff === null ? (pv && pv.net !== null && !same ? '<span class="muted-note">other currency</span>' : '') : diffHtml(diff, pv.net, l.currency)}</td>` : ''}</tr>`; }).join('')).join('')
            || `<tr><td colspan="${cols}" class="empty-note">${R.busy ? 'Reading…' : 'No return in these days.'}</td></tr>`}</tbody></table></div>
          <p class="muted-note" style="margin:8px 0 0;">Every item returned to a supplier, grouped by return (PT). ${R.prev ? 'Difference = the return price against the last purchase before the return.' : 'The arrows button adds the last purchase price of each item (slower).'} Double-click an item for its details.</p></div>`;
      box.querySelectorAll('tr[data-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.code));
    }
    function xls() {
      const L = filtered(); if (!L.length) return showToast('Nothing to download.', true);
      const aoa = [['Date', 'Return (PT)', 'Supplier', 'Code', 'Description', 'Barcode', 'Qty returned', 'Unit price', 'Net', 'Total', 'Currency', 'Stock after', 'Last purchase date', 'Last purchase price', 'Difference']];
      L.forEach(l => { const p = l.lines.find(x => !x.free) || l.lines[0], pv = prevOf(l), same = pv && pv.net !== null && (pv.currency || '') === (l.currency || '');
        aoa.push([dmy(l.day), l.doc, l.supplierName || l.supplier, l.code, l.description, l.barcode || '', -n(l.paidQty), p ? p.unit : '', p ? p.net : '', -n(l.paid), l.currency || '$', l.stockAfter,
          pv ? dmy(pv.date) : '', pv?.net ?? '', same && p ? Math.round((p.net - pv.net) * 1000) / 1000 : '']); });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      for (let i = 2; i <= aoa.length; i++) ['D', 'F'].forEach(c => { const x = ws[c + i]; if (x) { x.t = 's'; x.v = String(x.v); } });
      ws['!cols'] = [12, 12, 28, 10, 40, 15, 11, 10, 10, 10, 9, 10, 14, 14, 11].map(w => ({ wch: w }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Returns');
      XLSX.writeFile(wb, `Returns ${R.from}${R.to !== R.from ? ' ' + R.to : ''}.xlsx`);
    }
    return { show };
  })();
  window.Pricing = { show };
})();
