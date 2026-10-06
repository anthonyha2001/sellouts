/* ============================================================
   Performance (owner, 2026-10-06): a supplier's sales vs its purchases
   over the dates you choose, live from the system (lv-dashboard
   perf_suppliers / perf_supplier, amounts in USD as the system reports them).
   First every supplier (purchases, sales, sales / purchases, units), then
   one supplier: the months side by side and its items, with the profit:
   sales - units sold x unit cost (the period's purchase cost, else the
   last purchase day in the 12 months before; none: not counted).
   Permission: vendors.manage.
   Public API: window.Performance = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const qty = v => (Math.round(n(v) * 10) / 10).toLocaleString('en-US');
  const pct = v => v === null ? '—' : Math.round(v * 100) + '%';
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ymd = d => d.toLocaleDateString('en-CA');
  const el = id => document.getElementById(id);
  const S = { from: null, to: null, list: null, q: '', sort: 'bought', dir: -1, sup: null, detail: null, isort: 'bought', idir: -1, busy: false };

  function presets() {
    const t = new Date(todayStr() + 'T00:00:00'), y = t.getFullYear(), m = t.getMonth();
    return [
      ['This month', ymd(new Date(y, m, 1)), todayStr()],
      ['Last month', ymd(new Date(y, m - 1, 1)), ymd(new Date(y, m, 0))],
      ['Last 3 months', ymd(new Date(y, m - 2, 1)), todayStr()],
      ['This year', `${y}-01-01`, todayStr()],
    ];
  }
  const ratio = (a, b) => b > 0 ? a / b : null;
  // the difference (owner, 2026-10-06): sales - purchases, and in % of the purchases (+10.8% = sold 10.8% more than bought)
  const diffPct = (sold, bought) => bought > 0 ? (sold - bought) / bought : null;
  const signedMoney = v => (n(v) > 0 ? '+' : n(v) < 0 ? '-' : '') + '$' + Math.abs(Math.round(n(v))).toLocaleString('en-US');
  const flagDiff = d => d === null ? '<span class="muted-note">no purchase</span>' : `<span class="${d < -0.2 ? 'pf-under' : d > 0.2 ? 'pf-over' : ''}">${d > 0 ? '+' : ''}${(Math.round(d * 1000) / 10).toLocaleString('en-US')}%</span>`;

  function show() {
    const root = el('panel-performance'); if (!root) return;
    if (!S.from) { const p = presets()[2]; S.from = p[1]; S.to = p[2]; }
    if (!root.dataset.built) {
      root.dataset.built = '1';
      root.innerHTML = `
        <div class="card pf-controls">
          <label>From <input type="date" id="pfFrom"></label>
          <label>to <input type="date" id="pfTo"></label>
          <div class="filter-row" id="pfQuick" style="margin:0;">${presets().map((p, i) => `<button type="button" data-p="${i}">${p[0]}</button>`).join('')}</div>
          <button type="button" class="btn small" id="pfLoad">Load</button>
        </div>
        <div id="pfBody"></div>`;
      el('pfQuick').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; const p = presets()[Number(b.dataset.p)]; el('pfFrom').value = p[1]; el('pfTo').value = p[2]; load(); };
      el('pfLoad').onclick = load;
    }
    el('pfFrom').value = S.from; el('pfTo').value = S.to;
    if (!S.list && !S.busy) load(); else paint();
  }

  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'no answer');
    return data;
  }
  async function load() {
    const f = el('pfFrom').value, t = el('pfTo').value;
    if (!f || !t || f > t) return showToast('Choose the dates (from before to).', true);
    S.from = f; S.to = t; S.busy = true; S.list = null; S.detail = null;
    el('pfQuick').querySelectorAll('[data-p]').forEach(b => { const p = presets()[Number(b.dataset.p)]; b.classList.toggle('active', p[1] === f && p[2] === t); });
    el('pfBody').innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the purchases and the sales of every supplier from the system…</p></div>';
    try { S.list = await call({ action: 'perf_suppliers', from: f, to: t }); if (S.sup) await openSupplier(S.sup, true); else paint(); }
    catch (e) { el('pfBody').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(e.message === 'no answer' ? 'The system did not answer. Check the "Link to the system" card on the Dashboard.' : e.message)}</p></div>`; }
    finally { S.busy = false; }
  }

  const sortIcon = (key, cur, dir) => key === cur ? (dir < 0 ? ' ▾' : ' ▴') : '';
  function paint() { if (S.sup && S.detail) paintDetail(); else paintList(); }

  /* ---------------- every supplier ---------------- */
  function paintList() {
    const box = el('pfBody'); if (!S.list) return;
    const all = S.list.suppliers.filter(s => s.bought > 0 || s.sold > 0);
    const q = S.q.trim().toLowerCase();
    const rows = all.filter(s => !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
      .map(s => ({ ...s, r: ratio(s.sold, s.bought), ru: ratio(s.soldQty, s.boughtQty), diff: s.sold - s.bought, dp: diffPct(s.sold, s.bought) }));
    const k = S.sort; rows.sort((a, b) => S.dir * (k === 'name' ? a.name.localeCompare(b.name) : (n(a[k] ?? -1) - n(b[k] ?? -1))));
    const tb = all.reduce((t, s) => t + s.bought, 0), ts = all.reduce((t, s) => t + s.sold, 0);
    const th = (key, label, num = true) => `<th class="${num ? 'num' : ''} pf-sort" data-k="${key}">${label}${sortIcon(key, S.sort, S.dir)}</th>`;
    box.innerHTML = `
      <div class="pf-tiles">
        <div class="pf-tile"><span>Purchases</span><b>${money(tb)}</b></div>
        <div class="pf-tile"><span>Sales</span><b>${money(ts)}</b></div>
        <div class="pf-tile"><span>Difference</span><b>${flagDiff(diffPct(ts, tb))}</b><small>${signedMoney(ts - tb)} sales - purchases</small></div>
        <div class="pf-tile"><span>Suppliers</span><b>${all.length}</b></div>
      </div>
      <div class="card">
        <div class="pf-head"><h3>Suppliers · ${esc(dmy(S.list.from))} → ${esc(dmy(S.list.to))}</h3>
          <input type="search" id="pfQ" placeholder="Find a supplier" value="${esc(S.q)}" aria-label="Find a supplier">
          <button type="button" class="icon-btn" id="pfXls" title="Download (Excel)" aria-label="Download (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table"><thead><tr>
          ${th('name', 'Supplier', false)}${th('bought', 'Purchases')}${th('sold', 'Sales')}${th('diff', 'Difference')}${th('dp', 'Difference %')}${th('boughtQty', 'Units bought')}${th('soldQty', 'Units sold')}${th('ru', 'Units sold ÷ bought')}</tr></thead>
          <tbody>${rows.map(s => `<tr data-sup="${esc(s.code)}" class="pf-row" tabindex="0">
            <td><b>${esc(s.name)}</b> <span class="muted-note mono">${esc(s.code)}</span></td>
            <td class="num">${money(s.bought)}</td><td class="num">${money(s.sold)}</td>
            <td class="num">${signedMoney(s.diff)}</td><td class="num">${flagDiff(s.dp)}</td><td class="num">${qty(s.boughtQty)}</td><td class="num">${qty(s.soldQty)}</td><td class="num">${flagRatio(s.ru)}</td></tr>`).join('')
            || '<tr><td colspan="8" class="empty-note">No supplier.</td></tr>'}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Amounts in USD as the system reports them. Difference % = (sales - purchases) / purchases: under -20%, bought more than sold in the period (gold). Click a supplier for its months and items.</p>
      </div>`;
    el('pfQ').oninput = () => { S.q = el('pfQ').value; const pos = el('pfQ').selectionStart; paintList(); el('pfQ').focus(); el('pfQ').setSelectionRange(pos, pos); };
    box.querySelectorAll('.pf-sort').forEach(h => h.onclick = () => { const key = h.dataset.k; if (S.sort === key) S.dir = -S.dir; else { S.sort = key; S.dir = key === 'name' ? 1 : -1; } paintList(); });
    box.querySelectorAll('tr[data-sup]').forEach(tr => { tr.onclick = () => openSupplier(tr.dataset.sup); tr.onkeydown = e => { if (e.key === 'Enter') openSupplier(tr.dataset.sup); }; });
    el('pfXls').onclick = () => xls([['Supplier', 'Code', 'Purchases ($)', 'Sales ($)', 'Difference ($)', 'Difference %', 'Units bought', 'Units sold', 'Units sold / bought'],
      ...rows.map(s => [s.name, s.code, round2(s.bought), round2(s.sold), round2(s.diff), s.dp === null ? '' : Math.round(s.dp * 1000) / 10, round2(s.boughtQty), round2(s.soldQty), s.ru === null ? '' : Math.round(s.ru * 1000) / 1000])],
      `Performance suppliers ${S.list.from} ${S.list.to}`);
  }
  const round2 = v => Math.round(n(v) * 100) / 100;
  const money2 = v => (n(v) < 0 ? '-$' : '$') + Math.abs(Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cost3 = v => '$' + (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const flagRatio = r => r === null ? '<span class="muted-note">no purchase</span>' : `<span class="${r < 0.8 ? 'pf-under' : r > 1.2 ? 'pf-over' : ''}">${pct(r)}</span>`;

  /* ---------------- one supplier ---------------- */
  async function openSupplier(code, keep) {
    S.sup = code; if (!keep) S.detail = null;
    const s = S.list?.suppliers.find(x => x.code === code);
    el('pfBody').innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">Reading ${esc(s?.name || code)}: its items and months…</p></div>`;
    try { S.detail = await call({ action: 'perf_supplier', supplier: code, from: S.from, to: S.to }); paintDetail(); }
    catch (e) { el('pfBody').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(e.message)}</p></div>`; }
  }
  function chart(months) {
    const keys = Object.keys(months).sort();
    if (!keys.length) return '';
    const max = Math.max(1, ...keys.map(k => Math.max(months[k].bought, months[k].sold)));
    const W = Math.max(320, keys.length * 70), H = 180, pad = 26, bw = 22, step = (W - 20) / keys.length;
    const y = v => H - pad - (v / max) * (H - pad - 14);
    const bar = (x, v, cls, label) => { const top = y(v), h = Math.max(0, H - pad - top); return h > 0 ? `<path class="${cls}" d="M${x},${H - pad} V${top + Math.min(4, h)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H - pad} Z"><title>${esc(label)}</title></path>` : ''; };
    return `<div class="pf-chart"><div class="pf-legend"><span><i class="pf-k-b"></i>Purchases</span><span><i class="pf-k-s"></i>Sales</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Purchases and sales per month">
        <line x1="10" x2="${W - 10}" y1="${H - pad}" y2="${H - pad}" class="pf-axis"/>
        ${keys.map((k, i) => { const cx = 10 + step * i + step / 2, m = months[k], lab = `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
          return bar(cx - bw - 1, m.bought, 'pf-b', `${lab} purchases ${money(m.bought)}`) + bar(cx + 1, m.sold, 'pf-s', `${lab} sales ${money(m.sold)}`)
            + `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="pf-lab">${lab}</text>`; }).join('')}
      </svg></div>`;
  }
  function paintDetail() {
    const d = S.detail, box = el('pfBody'); if (!d) return;
    const s = S.list?.suppliers.find(x => x.code === S.sup) || { name: S.sup, code: S.sup };
    const items = d.items.map(i => ({ ...i, ru: ratio(i.soldQty, i.boughtQty), diff: i.sold - i.bought, dp: diffPct(i.sold, i.bought), margin: typeof i.profit === 'number' && i.sold > 0 ? i.profit / i.sold : null }));
    const k = S.isort; items.sort((a, b) => S.idir * (k === 'description' ? a.description.localeCompare(b.description) : (n(a[k] ?? -1) - n(b[k] ?? -1))));
    const tb = items.reduce((t, i) => t + i.bought, 0), ts = items.reduce((t, i) => t + i.sold, 0), qb = items.reduce((t, i) => t + i.boughtQty, 0), qs = items.reduce((t, i) => t + i.soldQty, 0);
    const notSold = items.filter(i => i.boughtQty > 0 && i.soldQty <= 0).length, notBought = items.filter(i => i.soldQty > 0 && i.boughtQty <= 0).length;
    const costed = items.filter(i => typeof i.profit === 'number'), pSales = costed.reduce((t, i) => t + i.sold, 0), profit = costed.reduce((t, i) => t + i.profit, 0);
    const noCost = items.filter(i => i.soldQty > 0 && typeof i.profit !== 'number'), noCostSales = noCost.reduce((t, i) => t + i.sold, 0);
    const th = (key, label, num = true) => `<th class="${num ? 'num' : ''} pf-isort" data-k="${key}">${label}${sortIcon(key, S.isort, S.idir)}</th>`;
    box.innerHTML = `
      <div class="pf-head pf-head-top"><button type="button" class="icon-btn" id="pfBack" title="Back to every supplier" aria-label="Back to every supplier"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3>${esc(s.name)} <span class="muted-note mono">${esc(s.code)}</span></h3><span class="muted-note">${esc(dmy(d.from))} → ${esc(dmy(d.to))}</span></div>
      <div class="pf-tiles">
        <div class="pf-tile"><span>Purchases</span><b>${money(tb)}</b><small>${qty(qb)} units</small></div>
        <div class="pf-tile"><span>Sales</span><b>${money(ts)}</b><small>${qty(qs)} units</small></div>
        <div class="pf-tile"><span>Difference</span><b>${flagDiff(diffPct(ts, tb))}</b><small>${signedMoney(ts - tb)} · units ${qb > 0 ? flagDiff(diffPct(qs, qb)) : '—'}</small></div>
        <div class="pf-tile"><span>Profit</span><b class="${profit < 0 ? 'pf-neg' : ''}">${money(profit)}</b><small>margin ${pSales ? (Math.round(profit / pSales * 1000) / 10) + '%' : '—'}${noCost.length ? ` · ${noCost.length} item${noCost.length === 1 ? '' : 's'} (${money(noCostSales)} of sales) with no purchase in 12 months not counted` : ''}</small></div>
        <div class="pf-tile"><span>Items</span><b>${items.length}</b><small>${notSold} bought, not sold · ${notBought} sold, not bought</small></div>
      </div>
      <div class="card">${chart(d.months)}</div>
      <div class="card">
        <div class="pf-head"><h3>Items</h3><span style="flex:1"></span>
          <button type="button" class="icon-btn" id="pfXls" title="Download (Excel)" aria-label="Download (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table"><thead><tr>
          <th>Code</th>${th('description', 'Description', false)}${th('boughtQty', 'Units bought')}${th('bought', 'Purchases')}${th('soldQty', 'Units sold')}${th('sold', 'Sales')}${th('diff', 'Difference')}${th('dp', 'Difference %')}${th('ru', 'Sold ÷ bought')}${th('unitCost', 'Unit cost')}${th('profit', 'Profit')}${th('margin', 'Margin')}</tr></thead>
          <tbody>${items.map(i => `<tr data-code="${esc(i.code)}"><td class="mono">${esc(i.code)}</td><td>${esc(i.description)}</td>
            <td class="num">${qty(i.boughtQty)}</td><td class="num">${money(i.bought)}</td><td class="num">${qty(i.soldQty)}</td><td class="num">${money(i.sold)}</td>
            <td class="num">${signedMoney(i.diff)}</td><td class="num">${i.bought > 0 ? flagDiff(i.dp) : '<span class="muted-note">not bought</span>'}</td>
            <td class="num">${i.boughtQty > 0 ? flagRatio(i.ru) : '<span class="muted-note">not bought</span>'}</td>
            <td class="num">${typeof i.unitCost === 'number' ? cost3(i.unitCost) + (i.costFrom === 'last' ? `<div class="pf-sub" title="Not bought in the period: the last purchase before it">last PU ${esc(dmy(i.costDate))}</div>` : '') : i.soldQty > 0 ? `<span class="muted-note">${i.costFrom === 'failed' ? 'could not be read' : 'no purchase in 12 months'}</span>` : ''}</td>
            <td class="num ${n(i.profit) < 0 ? 'pf-neg' : ''}">${typeof i.profit === 'number' ? money2(i.profit) : ''}</td>
            <td class="num">${i.margin === null ? '' : `<span class="${i.margin < 0 ? 'pf-neg' : ''}">${Math.round(i.margin * 1000) / 10}%</span>${i.margin < -0.2 ? ' <span class="pf-check" title="Sold far below its cost: check the cost or the unit (pack / piece) in the system">check</span>' : ''}`}</td></tr>`).join('') || '<tr><td colspan="12" class="empty-note">Nothing bought or sold in the period.</td></tr>'}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Profit = sales - units sold x unit cost. Unit cost = the purchases of the period / their units (free units included, so trade deals lower it); an item not bought in the period takes its last purchase day in the 12 months before. Amounts in $ with VAT, as the system reports both sales and purchases. Double-click an item for its details.</p>
      </div>`;
    el('pfBack').onclick = () => { S.sup = null; S.detail = null; paintList(); };
    box.querySelectorAll('.pf-isort').forEach(h => h.onclick = () => { const key = h.dataset.k; if (S.isort === key) S.idir = -S.idir; else { S.isort = key; S.idir = key === 'description' ? 1 : -1; } paintDetail(); });
    box.querySelectorAll('tr[data-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.code));
    el('pfXls').onclick = () => xls([['Code', 'Description', 'Units bought', 'Purchases ($)', 'Units sold', 'Sales ($)', 'Difference ($)', 'Difference %', 'Units sold / bought', 'Unit cost ($)', 'Cost from', 'Profit ($)', 'Margin %'],
      ...items.map(i => [i.code, i.description, round2(i.boughtQty), round2(i.bought), round2(i.soldQty), round2(i.sold), round2(i.diff), i.dp === null ? '' : Math.round(i.dp * 1000) / 10, i.ru === null ? '' : Math.round(i.ru * 1000) / 1000,
        typeof i.unitCost === 'number' ? Math.round(i.unitCost * 1000) / 1000 : '', i.costFrom === 'period' ? 'purchases of the period' : i.costFrom === 'last' ? 'last purchase ' + dmy(i.costDate) : i.soldQty > 0 ? 'no purchase in 12 months' : '',
        typeof i.profit === 'number' ? round2(i.profit) : '', i.margin === null ? '' : Math.round(i.margin * 1000) / 10]),
      [], ['Total', '', round2(qb), round2(tb), round2(qs), round2(ts), round2(ts - tb), tb > 0 ? Math.round((ts - tb) / tb * 1000) / 10 : '', '', '', 'profit on ' + money(pSales) + ' of sales with a cost', round2(profit), pSales ? Math.round(profit / pSales * 1000) / 10 : '']],
      `Performance ${s.name} ${d.from} ${d.to}`, true);
  }
  function xls(aoa, name, codeText) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (codeText) for (let i = 2; i <= aoa.length; i++) { const c = ws['A' + i]; if (c) { c.t = 's'; c.v = String(c.v); } }
    ws['!cols'] = aoa[0].map((h, i) => ({ wch: i === 0 && !codeText ? 34 : i === 1 && codeText ? 40 : 14 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Performance');
    XLSX.writeFile(wb, `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.xlsx`);
  }
  window.Performance = { show };
})();
