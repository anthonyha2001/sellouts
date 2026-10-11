/* ============================================================
   Stock control (owner, 2026-10-11): one section for what to order and what not to.
     To order        : Low stock · Not available · Top sales      (js/modules/lowstock.js)
     Too much stock  : Overstock · Slow movers (here; migration 075) · Top purchases (lowstock.js)
     Checks          : Stock history (here; migration 076)
   Overstock: bought in the last 90 days and sold slowly, so a lot of stock is sitting: its stock, the weeks it
   covers at its selling rate, and what it is worth at its purchase cost.
   Slow movers: selling much less than it used to (last 4 weeks against the 8 weeks before), with stock left.
   Every view has the same frame (owner, 2026-10-11: "the stock control page is extremely messy"): a title and one
   line of summary, a search, expand / collapse, the explanation behind an (i) button, the recount button; the items
   grouped by supplier in groups that fold. Shared with lowstock.js as window.SCUI.
   Permission: vendors.manage.   Public API: window.StockControl = { show, refresh }, window.SCUI.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { tab: 'lowstock', rows: { overstock: null, slow: null }, day: { overstock: '', slow: '' }, built: false, counts: {} };
  const fq = v => (Math.round(Number(v) * 10) / 10).toLocaleString('en-US');
  const money = v => '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  const kmoney = v => { const n = Number(v) || 0; return n >= 10000 ? '$' + Math.round(n / 1000) + 'k' : n >= 1000 ? '$' + (Math.round(n / 100) / 10) + 'k' : money(n); };
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const REFRESH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';
  const NAV = [
    ['To order', [['lowstock', 'Low stock'], ['notavail', 'Not available'], ['topsales', 'Top sales']]],
    ['Too much stock', [['overstock', 'Overstock'], ['slow', 'Slow movers'], ['toppurchases', 'Top purchases']]],
    ['Checks', [['history', 'Stock history']]],
  ];
  const VIEWS = NAV.flatMap(g => g[1].map(t => t[0]));
  const BOX = { lowstock: 'vendorLowStockView', toppurchases: 'vendorTopPurchasesView', topsales: 'vendorTopSalesView', notavail: 'scNotAvailView', overstock: 'scOverstockView', slow: 'scSlowView', history: 'scHistoryView' };

  /* ---------------- the shared frame (SCUI) ---------------- */
  const UI = {
    // a view: title, one line of summary, tools (search, expand / collapse, (i), recount), the explanation, the body
    view({ title, sub = '', info = '', tools = '', refresh = '', search = true, body = '' }) {
      return `<section class="sc-view">
        <header class="sc-vhead">
          <div class="sc-vtitle"><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div>
          <div class="sc-vtools">${tools}
            ${search ? '<input type="search" class="sc-q" placeholder="Search item, code or supplier" aria-label="Search">' : ''}
            ${search ? '<button type="button" class="sc-ico" data-sc-fold title="Open / close all groups" aria-label="Open or close all groups"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 15l5 5 5-5M7 9l5-5 5 5"/></svg></button>' : ''}
            ${info ? '<button type="button" class="sc-ico" data-sc-info title="How it is counted" aria-label="How it is counted"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg></button>' : ''}
            ${refresh}
          </div>
        </header>
        ${info ? `<div class="sc-info" hidden>${info}</div>` : ''}
        <div class="sc-vbody">${body}</div>
      </section>`;
    },
    // a group of items (a supplier), folding; chips = small counts next to its name; actions = buttons on the right
    group({ title, chips = '', actions = '', open = false, body = '', tone = '' }) {
      return `<details class="sc-grp ${tone}"${open ? ' open' : ''}><summary><span class="sc-chev" aria-hidden="true"></span><span class="sc-gname">${title}</span><span class="sc-gchips">${chips}</span>${actions ? `<span class="sc-gact">${actions}</span>` : ''}</summary>
        <div class="sc-gbody">${body}</div></details>`;
    },
    chip: (text, tone = '') => `<span class="sc-chip ${tone}">${text}</span>`,
    table: (head, rows) => `<div class="sc-tbl"><table class="items sc-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`,
    // the item cell: its name, its code under it
    item: (code, desc) => `<td class="sc-it"><span>${esc(desc || '')}</span><small class="mono">${esc(code || '')}</small></td>`,
    empty: text => `<div class="sc-empty">${text}</div>`,
    loading: () => '<div class="sc-empty">Loading…</div>',
    refresh: (attr, title = 'Recount now') => isAdmin() ? `<button type="button" class="sc-ico" ${attr} title="${esc(title)}" aria-label="${esc(title)}">${REFRESH_ICON}</button>` : '',
    // the search, open / close all, (i), double-click for the item's details
    wire(box) {
      const q = box.querySelector('.sc-q');
      if (q) q.addEventListener('input', () => {
        const t = q.value.trim().toLowerCase();
        box.querySelectorAll('.sc-grp').forEach(g => {
          const inName = t && g.querySelector('.sc-gname').textContent.toLowerCase().includes(t);
          let any = false;
          g.querySelectorAll('tbody tr').forEach(tr => { const show = !t || inName || tr.textContent.toLowerCase().includes(t); tr.hidden = !show; if (show) any = true; });
          g.hidden = !!t && !any;
          if (t) g.open = any;
        });
        box.querySelectorAll('.sc-tbl.sc-flat tbody tr').forEach(tr => { tr.hidden = !!t && !tr.textContent.toLowerCase().includes(t); });
      });
      box.querySelector('[data-sc-fold]')?.addEventListener('click', () => {
        const gs = [...box.querySelectorAll('.sc-grp:not([hidden])')], open = !gs.every(g => g.open);
        gs.forEach(g => { g.open = open; });
      });
      box.querySelector('[data-sc-info]')?.addEventListener('click', () => { const i = box.querySelector('.sc-info'); if (i) i.hidden = !i.hidden; });
      // a button in a group's title does not fold the group
      box.querySelectorAll('summary button, summary a').forEach(b => b.addEventListener('click', e => e.preventDefault()));
      box.querySelectorAll('tr[data-ls-code]').forEach(tr => { if (!tr.ondblclick) tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.lsCode); });
    },
    setCount(view, value) { S.counts[view] = value; paintNav(); },
  };
  window.SCUI = UI;

  /* ---------------- the navigation, with a count on each ---------------- */
  function paintNav() {
    const box = el('scTabs'); if (!box) return;
    const c = S.counts, hot = { lowstock: 1, notavail: 1, topsales: 1 };
    // a big count shows 99+ (the exact number in the tooltip)
    const cnt = k => c[k] === undefined || c[k] === null ? '' : `<b class="sc-cnt ${c[k] && hot[k] ? 'hot' : ''} ${!c[k] ? 'zero' : ''}" title="${Number(c[k]).toLocaleString('en-US')}">${k === 'overstock' && c.overstockValue ? kmoney(c.overstockValue) : c[k] > 999 ? '999+' : Number(c[k]).toLocaleString('en-US')}</b>`;
    box.className = 'sc-nav';
    box.innerHTML = NAV.map(([label, tabs]) => `<div class="sc-navgrp"><span class="sc-navlbl">${label}</span><div class="sc-navrow">${tabs.map(([k, l]) =>
      `<button type="button" data-sc="${k}" class="sc-tab ${k === S.tab ? 'active' : ''}">${l}${cnt(k)}</button>`).join('')}</div></div>`).join('');
  }
  // the counts on the navigation: a few light reads
  async function loadCounts() {
    const today = todayStr(), c = S.counts;
    const safe = p => p.then(r => r).catch(() => ({ error: true }));
    const [low, na, top, rev, big] = await Promise.all([
      safe(sb.from('stock_alerts').select('code', { count: 'exact', head: true }).is('resolved_at', null).eq('doubtful', false)),
      safe(sb.from('system_po_lines').select('code', { count: 'exact', head: true }).is('received_on', null).not('po_delivered_on', 'is', null).gte('po_date', addDaysStr(today, -30)).or('stock_now.is.null,stock_now.lte.0')),
      safe(sb.from('top_sales').select('week_end, period, attention').order('week_end', { ascending: false }).limit(600)),
      safe(sb.from('stock_review').select('day, kind, value').order('day', { ascending: false }).limit(1500)),
      safe(sb.from('big_purchases').select('weeks_cover').gte('day', addDaysStr(today, -14))),
    ]);
    // Low stock: what needs doing (order now + check the shelf), the same sorting as its view
    if (window.LowStock && LowStock.actionCount) { try { c.lowstock = await LowStock.actionCount(); } catch (e) { if (!low.error) c.lowstock = low.count ?? null; } }
    else if (!low.error) c.lowstock = low.count ?? null;
    if (!na.error) c.notavail = na.count ?? null;
    if (!top.error) { const wk = top.data?.[0]?.week_end; c.topsales = (top.data || []).filter(t => t.week_end === wk && t.period === 'week' && t.attention).length; }
    if (!rev.error) ['overstock', 'slow'].forEach(k => { const rows = (rev.data || []).filter(r => r.kind === k), d = rows[0]?.day; const l = rows.filter(r => r.day === d); c[k] = l.length; if (k === 'overstock') c.overstockValue = l.reduce((s, r) => s + Number(r.value || 0), 0); });
    if (!big.error) c.toppurchases = (big.data || []).filter(b => b.weeks_cover === null || Number(b.weeks_cover) >= 6).length;
    paintNav();
  }

  /* ---------------- Overstock and Slow movers (migration 075) ---------------- */
  async function load(kind) {
    const { data, error } = await sb.from('stock_review').select('*').eq('kind', kind).order('day', { ascending: false }).order('value', { ascending: false, nullsFirst: false }).limit(600);
    if (error) { S.rows[kind] = null; return; }
    const day = data?.[0]?.day;
    S.day[kind] = day || '';
    S.rows[kind] = (data || []).filter(r => r.day === day);
  }
  // by supplier, the most money sitting there first; the 3 biggest open
  function bySupplier(rows, rowHtml, head) {
    const groups = new Map();
    rows.forEach(r => { const k = r.supplier || 'No vendor linked'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const val = l => l.reduce((s, x) => s + Number(x.value || 0), 0);
    return [...groups.entries()].sort((a, b) => val(b[1]) - val(a[1])).map(([sup, list], i) => UI.group({
      title: esc(sup), open: i < 3,
      chips: UI.chip(`${list.length} item${list.length === 1 ? '' : 's'}`) + (val(list) ? UI.chip(money(val(list)), 'money') : ''),
      body: UI.table(head, list.map(rowHtml).join('')),
    })).join('');
  }
  const stockCell = r => r.stock === null ? '<span class="muted-note">—</span>' : fq(r.stock);
  const weeksCell = r => r.weeks_cover === null ? '<b class="ls-urgent" title="No sale in the period">no sales</b>' : `<b class="${Number(r.weeks_cover) >= 26 ? 'ls-urgent' : 'ls-soon'}">${fq(r.weeks_cover)}</b>`;

  function overstockHtml() {
    const rows = S.rows.overstock;
    if (rows === null) return UI.view({ title: 'Overstock', search: false, body: UI.empty('Could not be read (migration 075 not run yet?).') });
    const total = rows.reduce((s, r) => s + Number(r.value || 0), 0);
    return UI.view({
      title: 'Overstock',
      sub: rows.length ? `<b>${money(total)}</b> sitting in ${rows.length} item${rows.length === 1 ? '' : 's'} · don't reorder these${S.day.overstock ? ' · counted ' + esc(dmy(S.day.overstock)) : ''}` : 'Nothing found in the last count.',
      info: 'Bought in the last 90 days, with stock covering 12 weeks or more at its selling rate, worth $50 or more. Value = stock × the cost of its purchases in the last 90 days. Counted every morning. Double-click an item for its details.',
      refresh: UI.refresh('data-sc-now="overstock"'),
      body: rows.length ? bySupplier(rows,
        r => `<tr data-ls-code="${esc(r.code)}" title="Bought ${fq(r.bought)} · sold ${fq(r.sold)} in 90 days${r.unit_cost === null ? '' : ' · cost $' + (Math.round(Number(r.unit_cost) * 100) / 100)}">${UI.item(r.code, r.description)}<td class="num"><b>${stockCell(r)}</b></td><td class="num">${fq(r.per_week)}</td><td class="num">${weeksCell(r)}</td><td class="num"><b>${money(r.value)}</b></td></tr>`,
        '<th>Item</th><th class="num">Stock</th><th class="num">Sells / wk</th><th class="num">Weeks of stock</th><th class="num">Value</th>') : UI.empty('No overstock in the last count.'),
    });
  }
  function slowHtml() {
    const rows = S.rows.slow;
    if (rows === null) return UI.view({ title: 'Slow movers', search: false, body: UI.empty('Could not be read (migration 075 not run yet?).') });
    const stopped = rows.filter(r => Number(r.per_week) === 0).length;
    return UI.view({
      title: 'Slow movers',
      sub: rows.length ? `${rows.length} item${rows.length === 1 ? '' : 's'} selling half or less than before${stopped ? ` · <b class="ls-urgent">${stopped} stopped</b>` : ''}${S.day.slow ? ' · counted ' + esc(dmy(S.day.slow)) : ''}` : 'Nothing found in the last count.',
      info: 'Selling at most half of what they sold before: the last 4 weeks against the 8 weeks before, with stock left. "stopped" = no sale at all in the last 4 weeks. Check the shelf, the price or a promotion before reordering. Double-click an item for its details.',
      refresh: UI.refresh('data-sc-now="slow"'),
      body: rows.length ? bySupplier(rows,
        r => { const was = Number(r.prior_week), now = Number(r.per_week), ch = was > 0 ? Math.round((now - was) / was * 100) : null;
          return `<tr data-ls-code="${esc(r.code)}">${UI.item(r.code, r.description)}<td class="num">${fq(was)}</td><td class="num"><b>${fq(now)}</b></td>
            <td class="num"><span class="${now === 0 ? 'ls-urgent' : ''}">${now === 0 ? 'stopped' : ch === null ? '—' : ch + '%'}</span></td><td class="num"><b>${stockCell(r)}</b></td><td class="num">${r.value === null ? '—' : money(r.value)}</td></tr>`; },
        '<th>Item</th><th class="num">Before / wk</th><th class="num">Now / wk</th><th class="num">Change</th><th class="num">Stock</th><th class="num">Value</th>') : UI.empty('No slow mover in the last count.'),
    });
  }

  async function renderReview(kind) {
    const box = el(BOX[kind]); if (!box) return;
    if (S.rows[kind] === null || !S.rows[kind]) box.innerHTML = UI.loading();
    await load(kind);
    box.innerHTML = kind === 'overstock' ? overstockHtml() : slowHtml();
    UI.wire(box);
    box.querySelector('[data-sc-now]')?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'stock_review_now', kind } });
        let msg = data?.error || '';
        if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
        if (msg || error || !data) throw new Error(msg || 'no answer');
        showToast(`${data.flagged} item${data.flagged === 1 ? '' : 's'} found.`);
      } catch (err) { console.warn('stock review', err); showToast(err.message && err.message !== 'no answer' ? err.message : 'The system did not answer.', true); }
      renderReview(kind); loadCounts();
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
      : r.finished_at ? `last night (${esc(dmy(r.day))}): ${Number(r.read).toLocaleString('en-US')} of ${Number(r.total).toLocaleString('en-US')} items read` + (r.diff_done ? '' : ' · movements next')
      : r.list_stage < 2 ? `${esc(dmy(r.day))}: listing the items…`
      : `${esc(dmy(r.day))}: reading… ${Number(r.read).toLocaleString('en-US')} of ${Number(r.total).toLocaleString('en-US')} (${r.total ? Math.round(Number(r.read) / Number(r.total) * 100) : 0}%)`;
    const moves = H.moves;
    const tile = (label, v, note, cls = '') => `<div class="sc-kpi ${cls}"><b>${v}</b><span>${label}</span><small>${note}</small></div>`;
    return UI.view({
      title: 'Stock history', sub: status, search: false,
      info: 'Every night the stock of every item that moved in the last year is saved. "Unexplained" = the change in stock minus (bought − sold) of the day, at least 3 units. Negative = stock disappeared (loss, wrong count, unrecorded return); positive = stock appeared (count, wrong receiving, unrecorded entry). Click a row for the item\'s history, double-click for its details.',
      refresh: UI.refresh('data-sc-now="history"', 'Read now'),
      body: `<div class="sc-kpis">
          ${tile('Out of stock', H.out === null ? '—' : H.out.toLocaleString('en-US'), H.moveDay ? 'last finished night · ' + esc(dmy(H.moveDay)) : 'last finished night')}
          ${tile('Below zero', H.neg === null ? '—' : H.neg.toLocaleString('en-US'), 'impossible on a shelf: count them', H.neg ? 'bad' : '')}
          ${tile('Unexplained', moves === null ? '—' : moves.length, 'stock moved without a purchase or sale', moves && moves.length ? 'warn' : '')}</div>
        <div class="sc-hsearch"><input type="search" id="scHq" placeholder="One item's history: code or name" value="${esc(H.q)}"> <button type="button" class="btn small" id="scHgo">Show</button></div>
        <div id="scHitem">${itemHistoryHtml()}</div>
        ${moves === null ? UI.empty('Could not be read (migration 076 not run yet?).')
          : moves.length ? UI.group({ title: 'Unexplained movements', open: true, chips: UI.chip(`${moves.length}`) + (H.moveDay ? UI.chip(esc(dmy(H.moveDay))) : ''),
              body: UI.table('<th>Item</th><th>Supplier</th><th class="num">Before</th><th class="num">+ Bought</th><th class="num">− Sold</th><th class="num">Now</th><th class="num">Unexplained</th>',
                moves.map(m => `<tr data-ls-code="${esc(m.code)}" data-sc-hist="${esc(m.code)}">${UI.item(m.code, m.description)}<td>${esc(m.supplier || '')}</td><td class="num">${fq(m.stock_prev)}</td><td class="num">${fq(m.bought)}</td><td class="num">${fq(m.sold)}</td>
                  <td class="num"><b>${fq(m.stock_now)}</b></td><td class="num"><b class="${Number(m.unexplained) < 0 ? 'ls-urgent' : 'ls-soon'}">${Number(m.unexplained) > 0 ? '+' : ''}${fq(m.unexplained)}</b></td></tr>`).join('')) })
          : UI.empty('Nothing unexplained in the last finished night' + (H.moveDay ? '' : ' (needs two finished nights in a row)') + '.')}`,
    });
  }
  function itemHistoryHtml() {
    if (H.hits && !H.item) return H.hits.length ? `<div class="filter-row" style="margin:4px 0;flex-wrap:wrap;">${H.hits.map(h => `<button type="button" data-sc-pick="${esc(h.code)}">${esc(h.code)} · ${esc((h.description || '').slice(0, 40))}</button>`).join('')}</div>` : '<p class="muted-note" style="margin:4px 0;">No item found in the snapshots.</p>';
    if (!H.item) return '';
    const s = H.series || [], last = s[0];
    const oos = s.filter(p => p.stock !== null && Number(p.stock) <= 0).length;
    return `<div class="sc-hitem"><b>${esc(H.item.code)}</b> ${esc(H.item.description || '')} <span class="muted-note">${esc(H.item.supplier || '')}</span>
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
    if (H.run === null && H.moves === null) box.innerHTML = UI.loading();
    await loadHistory();
    box.innerHTML = historyHtml();
    UI.wire(box);
    box.querySelectorAll('tr[data-sc-hist]').forEach(tr => { tr.onclick = () => openItem(tr.dataset.scHist); });
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
    paintNav();
    if (S.tab === 'lowstock' && window.LowStock) LowStock.render();
    if (S.tab === 'toppurchases' && window.LowStock) LowStock.renderTopPurchases();
    if (S.tab === 'topsales' && window.LowStock) LowStock.renderTopSales();
    if (S.tab === 'notavail' && window.LowStock) LowStock.renderNotAvailable();
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
    loadCounts();
  }
  // data reloaded elsewhere (vendors, low stock count): repaint when this section is the one showing
  function refresh() { if (S.built && el('panel-stockcontrol')?.classList.contains('active')) { paint(); loadCounts(); } }

  window.StockControl = { show, refresh };
})();
