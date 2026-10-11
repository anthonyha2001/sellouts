/* ============================================================
   Stock control (owner, 2026-10-11): one section for what to order and what not to.
     Low stock · Top purchases · Top sales   (js/modules/lowstock.js)
     Overstock · Slow movers                 (here; migration 075, lv-dashboard stock_review)
   Overstock: bought in the last 90 days and sold slowly, so a lot of stock is sitting: its stock, the weeks it
   covers at its selling rate, and what it is worth at its purchase cost.
   Slow movers: selling much less than it used to (last 4 weeks against the 8 weeks before), with stock left.
   Counted every morning from the system; admins can recount with the button.
   Permission: vendors.manage.   Public API: window.StockControl = { show, refresh }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { tab: 'lowstock', rows: { overstock: null, slow: null }, day: { overstock: '', slow: '' }, built: false, collapsed: {} };
  const fq = v => (Math.round(Number(v) * 10) / 10).toLocaleString('en-US');
  const money = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const REFRESH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';
  const VIEWS = ['lowstock', 'toppurchases', 'topsales', 'overstock', 'slow', 'history'];
  const BOX = { lowstock: 'vendorLowStockView', toppurchases: 'vendorTopPurchasesView', topsales: 'vendorTopSalesView', overstock: 'scOverstockView', slow: 'scSlowView', history: 'scHistoryView' };

  async function load(kind) {
    const { data, error } = await sb.from('stock_review').select('*').eq('kind', kind).order('day', { ascending: false }).order('value', { ascending: false, nullsFirst: false }).limit(600);
    if (error) { S.rows[kind] = null; return; }
    const day = data?.[0]?.day;
    S.day[kind] = day || '';
    S.rows[kind] = (data || []).filter(r => r.day === day);
  }

  function groupedTables(rows, head, rowHtml) {
    const groups = new Map();
    rows.forEach(r => { const k = r.supplier || 'No vendor linked'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    // the vendors with the most money sitting there first
    const ordered = [...groups.entries()].sort((a, b) => b[1].reduce((s, x) => s + Number(x.value || 0), 0) - a[1].reduce((s, x) => s + Number(x.value || 0), 0));
    return ordered.map(([sup, list]) => `<h4 style="margin:10px 0 4px;">${esc(sup)} <span class="muted-note">${list.length} item${list.length === 1 ? '' : 's'} · ${money(list.reduce((s, x) => s + Number(x.value || 0), 0))}</span></h4>
      <div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr>${head}</tr></thead><tbody>${list.map(rowHtml).join('')}</tbody></table></div>`).join('');
  }
  const stockCell = r => r.stock === null ? '<span class="muted-note">—</span>' : fq(r.stock);
  const weeksCell = r => r.weeks_cover === null ? '<b class="ls-urgent" title="No sale in the period">no sales</b>' : `<b class="${Number(r.weeks_cover) >= 26 ? 'ls-urgent' : 'ls-soon'}">${fq(r.weeks_cover)}</b>`;

  function overstockHtml() {
    const rows = S.rows.overstock;
    if (rows === null) return '<div class="card"><p class="muted-note" style="margin:0;">Could not be read (migration 075 not run yet?).</p></div>';
    const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Overstock</h3><span class="muted-note">bought in the last 90 days, stock covering 12 weeks or more at its selling rate, worth $50 or more${S.day.overstock ? ' · ' + esc(dmy(S.day.overstock)) : ''}${rows.length ? ` · <b>${money(total)}</b> of stock in ${rows.length} item${rows.length === 1 ? '' : 's'}` : ''}</span></div>${refreshBtn('overstock')}</div>
      ${rows.length ? groupedTables(rows,
        '<th>Code</th><th>Item</th><th class="num">Stock</th><th class="num">Sells / week</th><th class="num">Weeks of stock</th><th class="num">Bought 90 d</th><th class="num">Sold 90 d</th><th class="num">Cost</th><th class="num">Value</th>',
        r => `<tr data-ls-code="${esc(r.code)}"><td class="mono">${esc(r.code)}</td><td>${esc(r.description || '')}</td><td class="num"><b>${stockCell(r)}</b></td><td class="num">${fq(r.per_week)}</td><td class="num">${weeksCell(r)}</td>
          <td class="num">${fq(r.bought)}</td><td class="num">${fq(r.sold)}</td><td class="num">${r.unit_cost === null ? '—' : '$' + (Math.round(Number(r.unit_cost) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td class="num"><b>${money(r.value)}</b></td></tr>`)
        : '<p class="muted-note" style="margin:8px 0 0;">No overstock found in the last count. It is counted every morning.</p>'}
      <p class="muted-note" style="margin:8px 0 0;">Don't reorder these. Value = stock × the cost of its purchases in the last 90 days. Double-click an item for its details.</p></section>`;
  }
  function slowHtml() {
    const rows = S.rows.slow;
    if (rows === null) return '<div class="card"><p class="muted-note" style="margin:0;">Could not be read (migration 075 not run yet?).</p></div>';
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Slow movers</h3><span class="muted-note">selling at most half of what they sold before (last 4 weeks against the 8 weeks before), with stock left${S.day.slow ? ' · ' + esc(dmy(S.day.slow)) : ''}</span></div>${refreshBtn('slow')}</div>
      ${rows.length ? groupedTables(rows,
        '<th>Code</th><th>Item</th><th class="num">Before / week</th><th class="num">Now / week</th><th class="num">Change</th><th class="num">Stock</th><th class="num">Weeks of stock</th><th class="num">Value</th>',
        r => { const was = Number(r.prior_week), now = Number(r.per_week), ch = was > 0 ? Math.round((now - was) / was * 100) : null;
          return `<tr data-ls-code="${esc(r.code)}"><td class="mono">${esc(r.code)}</td><td>${esc(r.description || '')}</td><td class="num">${fq(was)}</td><td class="num"><b>${fq(now)}</b></td>
            <td class="num"><span class="${now === 0 ? 'ls-urgent' : ''}">${now === 0 ? 'stopped' : ch === null ? '—' : ch + '%'}</span></td><td class="num"><b>${stockCell(r)}</b></td><td class="num">${weeksCell(r)}</td><td class="num">${r.value === null ? '—' : money(r.value)}</td></tr>`; })
        : '<p class="muted-note" style="margin:8px 0 0;">No slow mover found in the last count. It is counted every morning.</p>'}
      <p class="muted-note" style="margin:8px 0 0;">Check the shelf, the price or a promotion before reordering. "stopped" = no sale at all in the last 4 weeks. Double-click an item for its details.</p></section>`;
  }
  const refreshBtn = kind => isAdmin() ? `<button type="button" class="icon-btn" data-sc-now="${kind}" title="Recount now" aria-label="Recount now">${REFRESH_ICON}</button>` : '';

  async function renderReview(kind) {
    const box = el(BOX[kind]); if (!box) return;
    if (S.rows[kind] === null || !S.built) box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>';
    await load(kind);
    box.innerHTML = kind === 'overstock' ? overstockHtml() : slowHtml();
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode));
    box.querySelector('[data-sc-now]')?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'stock_review_now', kind } });
        let msg = data?.error || '';
        if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
        if (msg || error || !data) throw new Error(msg || 'no answer');
        showToast(`${data.flagged} item${data.flagged === 1 ? '' : 's'} found.`);
      } catch (err) { console.warn('stock review', err); showToast(err.message && err.message !== 'no answer' ? err.message : 'The system did not answer.', true); }
      renderReview(kind);
    });
  }

  /* ---------------- Stock history (migration 076): the nightly snapshots ---------------- */
  const H = { run: null, moves: null, moveDay: '', out: null, neg: null, q: '', hits: null, item: null, series: null };
  async function loadHistory() {
    const { data: run } = await sb.from('stock_snapshot_runs').select('*').order('day', { ascending: false }).limit(1).maybeSingle();
    H.run = run || null;
    // the latest FINISHED day: what is out of stock / below zero in it, and its unexplained movements
    const { data: fin } = await sb.from('stock_snapshot_runs').select('day').not('finished_at', 'is', null).order('day', { ascending: false }).limit(1).maybeSingle();
    const day = fin?.day || '';
    H.moveDay = day;
    if (!day) { H.moves = []; H.out = null; H.neg = null; return; }
    const [m, o, n] = await Promise.all([
      sb.from('stock_moves').select('*').eq('day', day).order('unexplained', { ascending: true }).limit(500),
      sb.from('stock_snapshots').select('code', { count: 'exact', head: true }).eq('day', day).lte('stock', 0),
      sb.from('stock_snapshots').select('code', { count: 'exact', head: true }).eq('day', day).lt('stock', 0),
    ]);
    H.moves = m.error ? null : (m.data || []).sort((a, b) => Math.abs(Number(b.unexplained)) - Math.abs(Number(a.unexplained)));
    H.out = o.count ?? null; H.neg = n.count ?? null;
  }
  function chartSvg(series) {
    const pts = series.filter(p => p.stock !== null);
    if (pts.length < 2) return '<p class="muted-note" style="margin:6px 0 0;">At least two nights are needed for the line.</p>';
    const W = 560, H_ = 150, L = 36, R = 10, T = 10, B = 24;
    const vals = pts.map(p => Number(p.stock)), min = Math.min(0, ...vals), max = Math.max(1, ...vals);
    const x = i => L + i * (W - L - R) / (pts.length - 1), y = v => T + (1 - (v - min) / (max - min || 1)) * (H_ - T - B);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.stock)).toFixed(1)}`).join(' ');
    const zero = y(0);
    return `<svg viewBox="0 0 ${W} ${H_}" style="width:100%;max-width:640px;height:auto;" role="img" aria-label="Stock per night">
      <line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" stroke="currentColor" opacity=".25"/>
      <path d="${d}" fill="none" stroke="var(--brand, #1f6f5c)" stroke-width="2"/>
      ${pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(Number(p.stock)).toFixed(1)}" r="${Number(p.stock) <= 0 ? 3.5 : 2}" fill="${Number(p.stock) <= 0 ? '#c0392b' : 'var(--brand, #1f6f5c)'}"><title>${esc(dmy(p.day))}: ${fq(p.stock)}</title></circle>`).join('')}
      <text x="${L - 4}" y="${T + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${fq(max)}</text>
      <text x="${L - 4}" y="${H_ - B + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${fq(min)}</text>
      <text x="${L}" y="${H_ - 6}" font-size="10" fill="currentColor" opacity=".6">${esc(dmy(pts[0].day))}</text>
      <text x="${W - R}" y="${H_ - 6}" text-anchor="end" font-size="10" fill="currentColor" opacity=".6">${esc(dmy(pts[pts.length - 1].day))}</text></svg>`;
  }
  function historyHtml() {
    const r = H.run;
    const status = !r ? 'No night counted yet: it starts at midnight, or press the button.'
      : r.finished_at ? `${esc(dmy(r.day))}: ${Number(r.read).toLocaleString('en-US')} of ${Number(r.total).toLocaleString('en-US')} items read` + (r.diff_done ? '' : ' · movements next')
      : r.list_stage < 2 ? `${esc(dmy(r.day))}: listing the items…`
      : `${esc(dmy(r.day))}: reading… ${Number(r.read).toLocaleString('en-US')} of ${Number(r.total).toLocaleString('en-US')} items (${r.total ? Math.round(Number(r.read) / Number(r.total) * 100) : 0}%)`;
    const moves = H.moves;
    return `<section class="card ls-big"><div class="ls-head"><div><h3>Stock history</h3><span class="muted-note">every night the stock of every item that moved in the last year is saved · ${status}</span></div>${refreshBtn('history')}</div>
      <div class="pf-tiles" style="margin:8px 0;">
        <div class="pf-tile"><span>Out of stock</span><b>${H.out === null ? '—' : H.out.toLocaleString('en-US')}</b><small>in the last finished night${H.moveDay ? ' · ' + esc(dmy(H.moveDay)) : ''}</small></div>
        <div class="pf-tile"><span>Below zero</span><b class="${H.neg ? 'ls-urgent' : ''}">${H.neg === null ? '—' : H.neg.toLocaleString('en-US')}</b><small>impossible on a shelf: count them</small></div>
        <div class="pf-tile"><span>Unexplained</span><b>${moves === null ? '—' : moves.length}</b><small>stock moved without a purchase or sale</small></div></div>
      <div class="filter-row" style="margin:6px 0;"><input type="search" id="scHq" placeholder="An item: code or name" value="${esc(H.q)}" style="min-width:260px;"> <button type="button" class="btn small" id="scHgo">History</button></div>
      <div id="scHitem">${itemHistoryHtml()}</div>
      <h4 style="margin:14px 0 4px;">Unexplained movements <span class="muted-note">${H.moveDay ? esc(dmy(H.moveDay)) : ''} · the change in stock minus (bought − sold) of the day, at least 3 units</span></h4>
      ${moves === null ? '<p class="muted-note">Could not be read (migration 076 not run yet?).</p>'
        : moves.length ? `<div class="items-scroll" style="margin:0;"><table class="items ls-table"><thead><tr><th>Code</th><th>Item</th><th>Supplier</th><th class="num">Before</th><th class="num">Bought</th><th class="num">Sold</th><th class="num">Expected</th><th class="num">Now</th><th class="num">Unexplained</th></tr></thead>
          <tbody>${moves.map(m => { const exp = Number(m.stock_prev) + Number(m.bought) - Number(m.sold);
            return `<tr data-ls-code="${esc(m.code)}" data-sc-hist="${esc(m.code)}"><td class="mono">${esc(m.code)}</td><td>${esc(m.description || '')}</td><td>${esc(m.supplier || '')}</td><td class="num">${fq(m.stock_prev)}</td><td class="num">${fq(m.bought)}</td><td class="num">${fq(m.sold)}</td><td class="num">${fq(exp)}</td>
              <td class="num"><b>${fq(m.stock_now)}</b></td><td class="num"><b class="${Number(m.unexplained) < 0 ? 'ls-urgent' : 'ls-soon'}">${Number(m.unexplained) > 0 ? '+' : ''}${fq(m.unexplained)}</b></td></tr>`; }).join('')}</tbody></table></div>
          <p class="muted-note" style="margin:8px 0 0;">Negative = stock disappeared (loss, wrong count, unrecorded return); positive = stock appeared (count, wrong receiving, unrecorded entry). Click a row for the item's history, double-click for its details.</p>`
        : '<p class="muted-note" style="margin:0;">Nothing unexplained in the last finished night' + (H.moveDay ? '' : ' (needs two finished nights in a row)') + '.</p>'}
      </section>`;
  }
  function itemHistoryHtml() {
    if (H.hits && !H.item) return H.hits.length ? `<div class="filter-row" style="margin:4px 0;">${H.hits.map(h => `<button type="button" data-sc-pick="${esc(h.code)}">${esc(h.code)} · ${esc((h.description || '').slice(0, 40))}</button>`).join('')}</div>` : '<p class="muted-note" style="margin:4px 0;">No item found in the snapshots.</p>';
    if (!H.item) return '';
    const s = H.series || [], last = s[0];
    const oos = s.filter(p => p.stock !== null && Number(p.stock) <= 0).length;
    return `<div class="card" style="margin:6px 0;"><b>${esc(H.item.code)}</b> ${esc(H.item.description || '')} <span class="muted-note">${esc(H.item.supplier || '')}</span>
      <p class="muted-note" style="margin:2px 0 6px;">${s.length} night${s.length === 1 ? '' : 's'} saved${last ? ` · now <b>${fq(last.stock)}</b>` : ''}${oos ? ` · <b class="ls-urgent">${oos} night${oos === 1 ? '' : 's'} at 0 or below</b>` : ''}</p>
      ${chartSvg(s.slice().reverse())}</div>`;
  }
  async function openItem(code) {
    const { data } = await sb.from('stock_snapshots').select('day, code, description, supplier, stock').eq('code', code).order('day', { ascending: false }).limit(60);
    H.item = data?.[0] ? { code, description: data[0].description, supplier: data[0].supplier } : { code, description: '', supplier: '' };
    H.series = data || [];
    const box = el('scHitem'); if (box) box.innerHTML = itemHistoryHtml();
  }
  async function renderHistory() {
    const box = el(BOX.history); if (!box) return;
    if (H.run === null && H.moves === null) box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>';
    await loadHistory();
    box.innerHTML = historyHtml();
    box.querySelectorAll('tr[data-ls-code]').forEach(tr => { tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode); tr.onclick = () => openItem(tr.dataset.scHist); });
    const go = async () => {
      H.q = el('scHq').value.trim(); H.item = null; H.series = null;
      if (!H.q) { H.hits = null; el('scHitem').innerHTML = ''; return; }
      const day = H.moveDay || (H.run && H.run.day) || '';
      let qb = sb.from('stock_snapshots').select('code, description, supplier').eq('day', day).limit(12);
      qb = /^[\w.-]+$/.test(H.q) && !/\s/.test(H.q) ? qb.or(`code.eq.${H.q},description.ilike.%${H.q}%`) : qb.ilike('description', `%${H.q.replace(/[%,]/g, ' ')}%`);
      const { data } = await qb;
      H.hits = data || [];
      if (H.hits.length === 1) return openItem(H.hits[0].code);
      el('scHitem').innerHTML = itemHistoryHtml();
      el('scHitem').querySelectorAll('[data-sc-pick]').forEach(b => b.onclick = () => openItem(b.dataset.scPick));
    };
    el('scHgo')?.addEventListener('click', go);
    el('scHq')?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    box.querySelector('[data-sc-now]')?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'stock_snapshot_now' } });
        let msg = data?.error || '';
        if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
        if (msg || error || !data) throw new Error(msg || 'no answer');
        showToast(`${data.step}${data.read !== undefined ? ': ' + data.read + ' read' : ''}${data.total ? ' of ' + data.total : ''}`);
      } catch (err) { console.warn('snapshot', err); showToast(err.message && err.message !== 'no answer' ? err.message : 'The system did not answer.', true); }
      renderHistory();
    });
  }

  function paint() {
    VIEWS.forEach(v => { const b = el(BOX[v]); if (b) b.style.display = v === S.tab ? '' : 'none'; });
    el('scTabs')?.querySelectorAll('[data-sc]').forEach(b => b.classList.toggle('active', b.dataset.sc === S.tab));
    if (S.tab === 'lowstock' && window.LowStock) LowStock.render();
    if (S.tab === 'toppurchases' && window.LowStock) LowStock.renderTopPurchases();
    if (S.tab === 'topsales' && window.LowStock) LowStock.renderTopSales();
    if (S.tab === 'overstock') renderReview('overstock');
    if (S.tab === 'slow') renderReview('slow');
    if (S.tab === 'history') renderHistory();
  }
  function show() {
    if (!S.built) {
      S.built = true;
      el('scTabs').onclick = e => { const b = e.target.closest('[data-sc]'); if (!b) return; S.tab = b.dataset.sc; paint(); };
    }
    paint();
  }
  // data reloaded elsewhere (vendors, low stock count): repaint when this section is the one showing
  function refresh() { if (S.built && el('panel-stockcontrol')?.classList.contains('active')) paint(); }

  window.StockControl = { show, refresh };
})();
