/* ============================================================
   Pricing (owner, 2026-10-06): a wizard over the purchases of one day,
   live from the system (lv-dashboard pricing_day / pricing_supplier).
     1. the day
     2. the suppliers that delivered that day
     3. PU by PU (supplier by supplier): every line with its price, the
        previous purchase price and the difference, the stock we had when
        it arrived; the PU's total and its flags in the footer.
   Flags: a price different from the previous purchase (net price, or the
   real cost of a trade deal), and an item that arrived while we already
   had more than 2 months of stock (stock before / daily sales of the 90
   days before > 60, or stock that did not sell at all).
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
  const S = { day: null, list: null, supIdx: 0, cache: new Map(), pus: [], puIdx: 0, sel: 0, busy: false, wired: false };

  function show() {
    const root = el('panel-pricing'); if (!root) return;
    if (!S.day) S.day = todayStr();
    if (!root.dataset.built) {
      root.dataset.built = '1';
      root.innerHTML = `<div class="pr-steps" id="prSteps"></div><div id="prBody"></div>`;
    }
    if (!S.wired) { S.wired = true; document.addEventListener('keydown', onKey); }
    if (S.list && S.pus.length) paintPu(); else if (S.list) paintSuppliers(); else paintDay();
  }
  const active = () => el('panel-pricing')?.classList.contains('active');
  function steps(k) {
    el('prSteps').innerHTML = ['Day', 'Suppliers', 'Purchases'].map((t, i) => `<button type="button" class="pr-step${i === k ? ' on' : ''}${i < k ? ' done' : ''}" data-step="${i}" ${i > k ? 'disabled' : ''}><b>${i + 1}</b> ${t}</button>`).join('<span class="pr-step-sep"></span>');
    el('prSteps').querySelectorAll('[data-step]').forEach(b => b.onclick = () => { const i = Number(b.dataset.step); if (i === 0) paintDay(); if (i === 1 && S.list) paintSuppliers(); });
  }
  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
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
    if (S.day !== d || !S.list) { S.cache.clear(); S.list = null; }
    S.day = d;
    if (!S.list) {
      el('prNext').disabled = true; el('prNext').textContent = 'Reading…';
      try { S.list = await call({ action: 'pricing_day', day: d }); }
      catch (e) { showToast(e.message, true); el('prNext').disabled = false; el('prNext').textContent = 'Next'; return; }
    }
    paintSuppliers();
  }

  /* ---------------- 2. the suppliers ---------------- */
  function flagsOf(code) { const c = S.cache.get(code); if (!c) return null; const p = puList(c); return { price: p.reduce((t, x) => t + x.flags.price.length, 0), over: p.reduce((t, x) => t + x.flags.over.length, 0), pus: p.length }; }
  function paintSuppliers() {
    steps(1); S.pus = [];
    const L = S.list.suppliers;
    el('prBody').innerHTML = `<div class="card">
      <div class="pr-head"><h3>${L.length} supplier${L.length === 1 ? '' : 's'} delivered on ${esc(dmy(S.list.day))}</h3><span style="flex:1"></span>
        ${L.length ? '<button type="button" class="btn" id="prStart">Check them one by one</button>' : ''}</div>
      <div class="items-scroll"><table class="items pr-sups"><thead><tr><th>Supplier</th><th class="num">Items</th><th class="num">Value ($)</th><th>Checked</th></tr></thead>
        <tbody>${L.map((s, i) => { const f = flagsOf(s.code); return `<tr data-i="${i}" tabindex="0"><td><b>${esc(s.name)}</b> <span class="muted-note mono">${esc(s.code)}</span></td><td class="num">${s.items}</td>
          <td class="num">${Math.round(s.value).toLocaleString('en-US')}</td>
          <td>${f ? `${f.pus} PU${f.pus === 1 ? '' : 's'}${f.price ? ` · <span class="pr-flag-price">${f.price} price change${f.price === 1 ? '' : 's'}</span>` : ''}${f.over ? ` · <span class="pr-flag-over">${f.over} over 2 months</span>` : ''}${!f.price && !f.over ? ' · <span class="pr-ok">nothing flagged</span>' : ''}` : '<span class="muted-note">not yet</span>'}</td></tr>`; }).join('')
          || '<tr><td colspan="4" class="empty-note">No purchase on that day.</td></tr>'}</tbody></table></div></div>`;
    el('prStart')?.addEventListener('click', () => openSupplier(0));
    el('prBody').querySelectorAll('tr[data-i]').forEach(tr => { tr.onclick = () => openSupplier(Number(tr.dataset.i)); tr.onkeydown = e => { if (e.key === 'Enter') openSupplier(Number(tr.dataset.i)); }; });
  }

  /* ---------------- 3. PU by PU ---------------- */
  // one row per item per PU: its lines (paid + free), the previous purchase, the stock we had
  function puList(data) {
    const pus = new Map();
    data.items.forEach(it => {
      const prevDocs = it.prev?.docs || [];
      const pPaid = prevDocs.flatMap(d => d.lines).find(l => !l.free);
      const pAll = prevDocs.reduce((t, d) => t + n(d.paidQty) + n(d.freeQty), 0), pPaidSum = prevDocs.reduce((t, d) => t + n(d.paid), 0);
      const prev = it.prev ? { date: it.prev.date, net: pPaid ? pPaid.net : null, real: pAll > 0 ? pPaidSum / pAll : null, deal: prevDocs.some(d => d.tradeDeal), currency: prevDocs[0]?.currency || '', docs: prevDocs.map(d => d.doc).join(', ') } : null;
      const perDay = n(it.soldBefore) / Math.max(1, n(it.salesDays) || 90);
      const had = it.stockBefore === null || it.stockBefore === undefined ? null : n(it.stockBefore);
      const daysHad = had !== null && had > 0 && perDay > 0 ? had / perDay : null;
      const overArr = had !== null && had > 0.001 && (perDay > 0 ? daysHad > OVER_DAYS : true);
      (it.docs || []).forEach(d => {
        const paid = d.lines.find(l => !l.free);
        const real = n(d.paidQty) + n(d.freeQty) > 0 ? n(d.paid) / (n(d.paidQty) + n(d.freeQty)) : null;
        const net = paid ? paid.net : null;
        const same = prev && (prev.currency || '') === (d.currency || '');
        const diffNet = same && net !== null && prev.net !== null ? net - prev.net : null;
        const diffReal = same && real !== null && prev.real !== null && (d.tradeDeal || prev.deal) ? real - prev.real : null;
        const changed = (x, base) => x !== null && Math.abs(x) > Math.max(0.0005, Math.abs(n(base)) * 0.0001);
        const generic = GENERIC.test(String(it.description || ''));
        const priceFlag = !generic && (changed(diffNet, prev?.net) || changed(diffReal, prev?.real));
        const row = { it, doc: d, paid, net, real, prev, diffNet, diffReal, priceFlag, otherCurrency: prev && !same, had, perDay, daysHad, overArr: overArr && !generic, generic };
        if (!pus.has(d.doc)) pus.set(d.doc, { doc: d.doc, currency: d.currency, rows: [] });
        pus.get(d.doc).rows.push(row);
      });
    });
    return [...pus.values()].sort((a, b) => a.doc.localeCompare(b.doc)).map(p => ({ ...p,
      total: p.rows.reduce((t, r) => t + n(r.doc.paid), 0),
      flags: { price: p.rows.filter(r => r.priceFlag), over: p.rows.filter(r => r.overArr) } }));
  }
  async function openSupplier(i, atEnd) {
    const s = S.list.suppliers[i]; if (!s) return;
    S.supIdx = i;
    if (!S.cache.has(s.code)) {
      steps(2);
      el('prBody').innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">Reading ${esc(s.name)}: ${s.items} item${s.items === 1 ? '' : 's'}, their PU, the previous purchase and the stock we had… (about ${Math.max(5, Math.round(s.items * 0.6))} seconds)</p></div>`;
      S.busy = true;
      try { S.cache.set(s.code, await call({ action: 'pricing_supplier', day: S.day, supplier: s.code })); }
      catch (e) { S.busy = false; showToast(e.message, true); paintSuppliers(); return; }
      S.busy = false;
    }
    S.pus = puList(S.cache.get(s.code));
    S.puIdx = atEnd ? Math.max(0, S.pus.length - 1) : 0; S.sel = 0;
    if (!S.pus.length) { showToast(`${s.name}: no PU line found in the cardex.`, true); paintSuppliers(); return; }
    paintPu();
  }
  function go(step) {
    if (S.busy) return;
    const k = S.puIdx + step;
    if (k >= 0 && k < S.pus.length) { S.puIdx = k; S.sel = 0; paintPu(); return; }
    const j = S.supIdx + step;
    if (j < 0) return showToast('This is the first PU of the day.');
    if (j >= S.list.suppliers.length) { showToast('That was the last PU of the day.'); paintSuppliers(); return; }
    openSupplier(j, step < 0);
  }
  function diffHtml(x, base, cur) {
    if (x === null) return '';
    if (Math.abs(x) <= Math.max(0.0005, Math.abs(n(base)) * 0.0001)) return '<span class="pr-ok">same</span>';
    const p = n(base) ? ` (${x > 0 ? '+' : ''}${(Math.round(x / n(base) * 1000) / 10).toLocaleString('en-US')}%)` : '';
    return `<span class="${x > 0 ? 'prc-up' : 'prc-down'}">${x > 0 ? '+' : '-'}${price(Math.abs(x), cur)}${p}</span>`;
  }
  function paintPu() {
    steps(2);
    const s = S.list.suppliers[S.supIdx], pu = S.pus[S.puIdx], cur = pu.currency;
    const nPu = S.pus.length;
    el('prBody').innerHTML = `<div class="card pr-pu">
      <div class="pr-head">
        <button type="button" class="icon-btn" data-go="-1" title="Previous PU (left arrow)" aria-label="Previous PU"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="pr-title"><h3>${esc(pu.doc)} <span class="muted-note">· ${esc(s.name)}</span></h3>
          <span class="muted-note">${esc(dmy(S.day))} · PU ${S.puIdx + 1} of ${nPu} · supplier ${S.supIdx + 1} of ${S.list.suppliers.length} · ${pu.rows.length} line${pu.rows.length === 1 ? '' : 's'} · prices in ${esc(cur || '$')}</span></div>
        <button type="button" class="icon-btn" data-go="1" title="Next PU (right arrow)" aria-label="Next PU"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
      </div>
      <div class="items-scroll pr-scroll"><table class="items pr-table"><thead><tr>
        <th>Code</th><th>Description</th><th>Barcode</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Net</th>
        <th class="num">Previous</th><th class="num">Difference</th><th class="num" title="The stock we had when it arrived, and how many days of sales that was">Stock we had</th><th class="num">Sale price now</th></tr></thead>
        <tbody>${pu.rows.map((r, i) => `<tr data-r="${i}" class="${i === S.sel ? 'pr-sel' : ''}${r.priceFlag ? ' pr-row-price' : ''}${r.overArr ? ' pr-row-over' : ''}">
          <td class="mono">${esc(r.it.code)}</td><td>${esc(r.it.description || '')}${n(r.it.pack) > 1 ? ` <span class="muted-note">· pack ${n(r.it.pack)}</span>` : ''}</td>
          <td class="mono pr-sub-txt">${esc(r.it.barcode || '')}</td>
          <td class="num">${qty(r.doc.paidQty)}${n(r.doc.freeQty) ? ` <span class="po-free">+ ${qty(r.doc.freeQty)} free</span>` : ''}</td>
          <td class="num">${r.paid ? price(r.paid.unit, cur) : '—'}${r.paid?.discountPct ? `<div class="pr-sub">-${r.paid.discountPct}%</div>` : ''}</td>
          <td class="num"><b>${price(r.net, cur)}</b>${r.doc.tradeDeal ? `<div class="pr-sub"><span class="lp-deal">trade deal</span> real ${price(r.real, cur)}</div>` : ''}</td>
          <td class="num">${r.prev ? `${price(r.prev.net, r.prev.currency)}${r.prev.deal ? ` <span class="pr-sub">real ${price(r.prev.real, r.prev.currency)}</span>` : ''}<div class="pr-sub">${esc(dmy(r.prev.date))}${r.otherCurrency ? ` · in ${esc(r.prev.currency)}` : ''}</div>` : '<span class="muted-note">first purchase</span>'}</td>
          <td class="num">${r.generic ? '<span class="muted-note">catch-all item</span>' : r.otherCurrency ? '<span class="muted-note">other currency</span>' : diffHtml(r.diffNet, r.prev?.net, cur)}${r.diffReal !== null && Math.abs(r.diffReal) > 0.0005 ? `<div class="pr-sub">real ${diffHtml(r.diffReal, r.prev?.real, cur)}</div>` : ''}</td>
          <td class="num">${r.had === null ? '—' : qty(r.had)}<div class="pr-sub${r.overArr ? ' pr-flag-over' : ''}">${r.generic ? '' : r.daysHad !== null ? `${Math.round(r.daysHad)} days` : r.had > 0.001 && !(r.perDay > 0) ? 'no sales in 90 days' : ''}</div></td>
          <td class="num">${r.it.salePrice ? price(r.it.salePrice, '$') : '—'}</td></tr>`).join('')}</tbody></table></div>
      <div class="pr-foot">
        <div class="pr-total"><span>Total ${esc(pu.doc)}</span><b>${price(pu.total, cur)} ${esc(cur || '$')}</b></div>
        <div class="pr-flags">
          ${pu.flags.price.length ? `<div><b class="pr-flag-price">Price different from the last purchase (${pu.flags.price.length})</b> ${pu.flags.price.map(r => `<button type="button" class="pr-chip" data-jump="${pu.rows.indexOf(r)}">${esc(r.it.description || r.it.code)}: ${price(r.prev.net, cur)} → ${price(r.net, cur)}</button>`).join('')}</div>` : ''}
          ${pu.flags.over.length ? `<div><b class="pr-flag-over">Arrived with over 2 months of stock (${pu.flags.over.length})</b> ${pu.flags.over.map(r => `<button type="button" class="pr-chip" data-jump="${pu.rows.indexOf(r)}">${esc(r.it.description || r.it.code)}: had ${qty(r.had)}${r.daysHad !== null ? ` = ${Math.round(r.daysHad)} days` : ', no sales'}</button>`).join('')}</div>` : ''}
          ${!pu.flags.price.length && !pu.flags.over.length ? '<span class="pr-ok">Nothing flagged on this PU.</span>' : ''}
        </div>
      </div>
      <p class="muted-note" style="margin:8px 0 0;">Up / down: move along the rows · left / right: previous / next PU · Enter or double-click: the item's details. Stock we had = the stock just before the PU; days = that stock / what sold per day in the 90 days before.</p>
    </div>`;
    el('prBody').querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
    el('prBody').querySelectorAll('tr[data-r]').forEach(tr => { tr.onclick = () => select(Number(tr.dataset.r)); tr.ondblclick = () => openItem(); });
    el('prBody').querySelectorAll('[data-jump]').forEach(b => b.onclick = () => select(Number(b.dataset.jump), true));
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
  window.Pricing = { show };
})();
