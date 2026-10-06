/* ============================================================
   Item details (owner, 2026-10-06): double-click an item in a promotion
   or a sell-out. Live from the system (lv-dashboard item_detail):
     - the item: description, size, barcode, supplier, section, group,
       brand, pack;
     - the selling price now (and the normal unit price, the pack price);
     - the stock and price in every branch;
     - the item cardex at Ajaltoun: All / Purchases only / Invoices only,
       over the last 30 days, 90 days or the year. A purchase line at 0
       (a free unit of a trade deal) is marked "free".
   Read only.
   Public API: window.ItemDetail = { open(code) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const fq = v => (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US');
  const money = (v, cur) => v === null || v === undefined || v === '' ? '—'
    : cur === 'LBP' ? Math.round(n(v)).toLocaleString('en-US') + ' LBP' : '$' + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = s => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const addDays = (s, k) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA'); };
  const S = { code: null, kind: 'all', span: 90, data: null, seq: 0 };

  function shell() {
    document.getElementById('idOverlay')?.remove();
    document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay open" id="idOverlay"><div class="modal-box id-box" role="dialog" aria-modal="true"><p class="muted-note">Reading the item from the system…</p></div></div>');
    const ov = document.getElementById('idOverlay');
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-id-close]')) close(); });
    return ov.querySelector('.id-box');
  }

  async function load(box) {
    const my = ++S.seq, to = todayStr(), from = S.span === 'year' ? `${to.slice(0, 4)}-01-01` : addDays(to, -(S.span - 1));
    const cx = box.querySelector('#idCardex'); if (cx) cx.innerHTML = '<p class="muted-note">Reading the cardex…</p>';
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'item_detail', code: S.code, kind: S.kind, from, to } });
      if (my !== S.seq || !box.isConnected) return;
      if (error) { let m = 'The system did not answer.'; try { m = (await error.context.json()).error || m; } catch (e) { /* keep */ } throw new Error(m); }
      S.data = data; draw(box);
    } catch (e) {
      if (my === S.seq && box.isConnected) box.innerHTML = `<div class="id-head"><h3>${esc(S.code)}</h3><button type="button" class="icon-btn" data-id-close title="Close" aria-label="Close">${X}</button></div><p class="login-err">${esc(e.message || 'The system did not answer.')}</p>`;
    }
  }
  const X = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function draw(box) {
    const { item: it, branches, cardex: c } = S.data;
    const tags = [['Supplier', it.supplier], ['Section', it.section], ['Group', [it.group, it.subgroup && !/^no sub/i.test(it.subgroup) ? it.subgroup : ''].filter(Boolean).join(' › ')], ['Brand', it.brand], ['Pack', it.pack > 1 ? `${it.pack} units` : '']].filter(([, v]) => v);
    const totalStock = branches.reduce((s, b) => s + (b.found ? n(b.stock) : 0), 0);
    const sm = c.summary || {};
    box.innerHTML = `
      <div class="id-head"><div><h3>${esc(it.description)}</h3>
        <p class="muted-note">${esc(it.code)}${it.size ? ' · ' + esc(it.size) : ''}${it.barcode ? ' · ' + esc(it.barcode) : ''}</p></div>
        <button type="button" class="icon-btn" data-id-close title="Close" aria-label="Close">${X}</button></div>
      <div class="id-tags">${tags.map(([k, v]) => `<span><em>${k}</em>${esc(v)}</span>`).join('')}</div>
      <div class="id-prices">
        <div class="id-price-main"><b>${money(it.price)}</b><span>selling price now${it.promoted ? ' <span class="badge warn">on promotion</span>' : ''}</span></div>
        <div><b>${money(it.salePrice)}</b><span>normal price (unit)</span></div>
        ${it.pack > 1 ? `<div><b>${money(it.packPrice)}</b><span>pack of ${esc(String(it.pack))}</span></div>` : ''}
      </div>
      <h4 class="cc-h">Stock in the branches <span class="cc-h-note">${fq(totalStock)} in all</span></h4>
      <table class="items id-branches"><thead><tr><th>Branch</th><th class="num">Stock</th><th class="num">Price now</th><th class="num">Normal</th></tr></thead>
        <tbody>${branches.map(b => `<tr class="${b.branch === 'Ajaltoun' ? 'id-here' : ''}"><td>${esc(b.branch)}</td>
          ${b.found ? `<td class="num"><b class="${n(b.stock) <= 0 ? 'id-zero' : ''}">${fq(b.stock)}</b></td><td class="num">${money(b.price)}${b.promoted ? ' <span class="badge warn">promo</span>' : ''}</td><td class="num">${money(b.salePrice)}</td>`
            : '<td colspan="3" class="muted-note num">not sold here</td>'}</tr>`).join('')}</tbody></table>
      <div class="id-cx-head">
        <h4 class="cc-h" style="margin:0;">Item cardex · Ajaltoun</h4>
        <div class="filter-row" id="idKind" style="margin:0;">${[['all', 'All'], ['purchases', 'Purchases only'], ['invoices', 'Invoices only']].map(([k, l]) => `<button type="button" data-k="${k}" class="${S.kind === k ? 'active' : ''}">${l}</button>`).join('')}</div>
        <select id="idSpan" aria-label="Period">${[[30, 'Last 30 days'], [90, 'Last 90 days'], ['year', 'This year']].map(([v, l]) => `<option value="${v}" ${String(S.span) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div id="idCardex">
        <div class="id-cx-sum">
          <span>Opening <b>${fq(sm.opening_balance)}</b></span><span>Bought <b>${fq(c.totals?.purchasesIn)}</b></span><span>Sold (invoices) <b>${fq(c.totals?.invoicesOut)}</b></span><span>Closing <b>${fq(sm.closing_balance)}</b></span>
          <span class="muted-note">${esc(day(c.from))} → ${esc(day(c.to))} · ${c.count} line${c.count === 1 ? '' : 's'}${c.count > 400 ? ' (the last 400 shown)' : ''}</span>
        </div>
        <div class="items-scroll id-cx-scroll"><table class="items id-cx"><thead><tr><th>Date</th><th>Document</th><th>Operation</th><th>Details</th><th class="num">In</th><th class="num">Out</th><th class="num">Unit price</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
          <tbody>${c.rows.map(r => { const free = n(r.in) > 0 && /purchase/i.test(r.op || '') && Math.abs(n(r.net)) < 0.005;
            return `<tr class="${/purchase/i.test(r.op || '') ? 'id-buy' : ''}"><td class="mono">${esc(day(r.date))}</td><td class="mono">${esc(r.doc || '')}</td><td>${esc(r.op || '')}</td><td class="id-det">${esc(r.details || '')}</td>
              <td class="num">${n(r.in) ? fq(r.in) : ''}</td><td class="num">${n(r.out) ? fq(Math.abs(n(r.out))) : ''}</td>
              <td class="num">${free ? '<span class="lp-deal">free</span>' : money(r.net ?? r.unit, r.currency)}</td><td class="num">${money(r.total, r.currency)}</td><td class="num">${fq(r.balance)}</td></tr>`; }).join('')
            || '<tr><td colspan="9" class="empty-note">Nothing in this period.</td></tr>'}</tbody></table></div>
      </div>`;
    box.querySelector('#idKind').onclick = e => { const b = e.target.closest('[data-k]'); if (!b || b.dataset.k === S.kind) return; S.kind = b.dataset.k; box.querySelectorAll('#idKind [data-k]').forEach(x => x.classList.toggle('active', x === b)); load(box); };
    box.querySelector('#idSpan').onchange = e => { S.span = e.target.value === 'year' ? 'year' : Number(e.target.value); load(box); };
  }

  function open(code) {
    code = String(code || '').trim();
    if (!code) return;
    S.code = code; S.data = null;
    load(shell());
  }
  window.ItemDetail = { open };
})();
