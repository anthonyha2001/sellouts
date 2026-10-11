/* ============================================================
   Vendors › Low stock (owner, 2026-10-06; migration 066): the items of the
   watched suppliers that are running low, live from the system.
   Only items that sold in the last 30 days are followed (inactive items
   never show). Low = stock covers fewer days than the vendor needs (its
   "days of stock to keep", default lead time + 4) at the item's own daily
   sales, or stock at 0 while selling. Checked every 15 minutes from 07:00
   to 19:00 (the vendor checked longest ago each time); one notification a
   day per vendor when something newly ran low (push-alerts).
   Also: the vendor form's "Watch stock" part (supplier in the system).
   Public API: window.LowStock = { render, formHtml, wireForm, readForm, openCount }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const S = { alerts: [], loaded: false };
  const el = id => document.getElementById(id);
  const fq = v => (Math.round(Number(v) * 10) / 10).toLocaleString('en-US');
  const ago = iso => { if (!iso) return 'not checked yet'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 2 ? 'checked just now' : m < 60 ? `checked ${m} min ago` : m < 1440 ? `checked ${Math.round(m / 60)} h ago` : `checked ${Math.round(m / 1440)} d ago`; };

  async function load() {
    const { data, error } = await sb.from('stock_alerts').select('*').is('resolved_at', null).order('days_left', { ascending: true, nullsFirst: true });
    if (error) { console.warn('low stock', error); S.alerts = []; } else S.alerts = data || [];
    S.loaded = true;
  }
  const openCount = () => S.alerts.filter(a => !a.doubtful).length;   // a wrong count in the system is not low (migration 072)
  // the system's POs of the week (owner, 2026-10-11; migration 082, lv-dashboard po_sync every 30 minutes): an item
  // on a PO of the last 7 days not received yet (no PU of it since the PO's day) is flagged with the PO, its day and
  // the quantity ordered; amber once the PO is more than 4 days old. Out of stock and on no PO = "No PO".
  const dm = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const keyOf = c => String(c || '').trim().replace(/^0+(?=\d)/, '').toUpperCase();
  S.po = undefined; S.poAt = 0; S.poSeen = null;
  async function loadPOs(force) {
    if (!force && S.poAt && Date.now() - S.poAt < 5 * 60e3) return;
    const weekAgo = addDaysStr(todayStr(), -7), m = new Map();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('system_po_lines').select('po, po_date, code, qty, supplier_name').is('received_on', null).is('po_delivered_on', null).gte('po_date', weekAgo)
        .order('po_date', { ascending: false }).range(from, from + 999);
      if (error) { S.po = null; S.poAt = Date.now(); return; }   // migration 082 not run yet: no flag at all
      (data || []).forEach(l => { const k = keyOf(l.code); if (!m.has(k)) m.set(k, []); m.get(k).push(l); });
      if ((data || []).length < 1000) break;
    }
    const { data: last } = await sb.from('system_pos').select('seen_at').order('seen_at', { ascending: false }).limit(1);
    S.po = m; S.poAt = Date.now(); S.poSeen = last?.[0]?.seen_at || null;
    await loadNotAvail();
  }
  // not delivered (owner, 2026-10-11): the supplier delivered the PO but not these items (no PU of them since), the last
  // 30 days; "Not available" = still out of stock (or not read yet), to ask the supplier
  async function loadNotAvail() {
    const { data, error } = await sb.from('system_po_lines').select('po, po_date, code, description, qty, supplier_code, supplier_name, po_delivered_on, stock_now, stock_read_at')
      .is('received_on', null).not('po_delivered_on', 'is', null).gte('po_date', addDaysStr(todayStr(), -30)).order('po_delivered_on', { ascending: false }).limit(2000);
    S.na = error ? null : (data || []);
    S.naMap = new Map(); (S.na || []).forEach(l => { const k = keyOf(l.code); if (!S.naMap.has(k)) S.naMap.set(k, l); });
  }
  const notAvailable = () => (S.na || []).filter(l => l.stock_now === null || Number(l.stock_now) <= 0);
  const onPO = code => !!(S.po && (S.po.get(keyOf(code)) || []).length);
  function poFlag(code, out) {
    if (!S.po) return '';
    const ls = S.po.get(keyOf(code)) || [];
    if (ls.length) {
      const l = ls[0], qty = ls.reduce((s, x) => s + Number(x.qty || 0), 0), age = daysSince(l.po_date);
      const tip = ls.map(x => `${x.po} of ${dm(x.po_date)}: ${fq(x.qty)} ordered${x.supplier_name ? ' from ' + x.supplier_name : ''}`).join('\n') + `\nNot received yet${age > 4 ? ` (${age} days)` : ''}`;
      return `<span class="ls-po ${age > 4 ? 'draft' : 'ok'}" title="${esc(tip)}">${esc(l.po)} · ${dm(l.po_date)} · ${fq(qty)}</span>`;
    }
    const na = out && S.naMap && S.naMap.get(keyOf(code));
    if (na) return `<span class="ls-po late" title="${esc(`${na.po} of ${dm(na.po_date)}: ${fq(na.qty)} ordered. The supplier delivered on ${dm(na.po_delivered_on)} without this item. Ask the supplier (Stock control › Not available).`)}">Not delivered · ${esc(na.po)}</span>`;
    return out ? '<span class="ls-po none" title="Out of stock and on no PO of the week">No PO</span>' : '';
  }

  /* ---------------- the views, in Stock control's frame (window.SCUI, js/modules/stockcontrol.js) ---------------- */
  const U = () => window.SCUI;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const poTools = () => S.po === null ? '' : `<span class="sc-meta">POs ${S.poSeen ? esc(ago(S.poSeen).replace('checked ', 'read ')) : 'not read yet'}</span>${isAdmin() ? '<button type="button" class="btn ghost small" id="lsPoNow" title="Read the POs of the week from the system now">Read POs</button>' : ''}`;
  const lastPu = a => a.last_pu_state === 'ok' ? `${esc(dm(a.last_pu_date))} <span class="muted-note">· ${fq(a.last_pu_qty)}</span>`
    : `<span class="muted-note">${a.last_pu_state === 'none' ? 'none in 12 months' : a.last_pu_state === 'failed' ? 'not read' : 'next check'}</span>`;
  const soldSince = a => a.last_pu_state === 'ok' ? fq(a.sold_since) : '<span class="muted-note">—</span>';

  /* ---------------- Not available: ordered, the PO delivered without them, still out of stock ---------------- */
  async function renderNotAvailable() {
    const box = el('scNotAvailView'); if (!box) return;
    box.innerHTML = U().loading();
    S.poAt = 0; await loadPOs();
    if (S.po === null || S.na === null) { box.innerHTML = U().view({ title: 'Not available', search: false, body: U().empty('Not set up yet: run migration 082 and deploy lv-dashboard.') }); return; }
    const list = notAvailable(), groups = new Map();
    list.forEach(l => { const k = l.supplier_name || 'Unknown supplier'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); });
    const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    U().setCount('notavail', list.length);
    box.innerHTML = U().view({
      title: 'Not available',
      sub: list.length ? `<b>${plural(list.length, 'item')}</b> from ${plural(ordered.length, 'supplier')}: ordered, delivered without them, still out of stock` : 'Nothing missing: every item ordered on a delivered PO came in, or is back in stock.',
      info: 'An item is listed when it was on a PO, the supplier delivered that PO (a PU of it came in) without this item, and its stock is still 0 or below. Ask the supplier about it: "Copy for the supplier" makes the message. The last 30 days; an item leaves the list when it comes in.',
      tools: poTools(),
      body: ordered.map(([sup, ls], gi) => U().group({
        title: esc(sup), open: gi < 3, tone: 'bad',
        chips: U().chip(`${ls.length} missing`, 'bad') + U().chip(esc([...new Set(ls.map(l => l.po))].join(', '))),
        actions: `<button type="button" class="btn ghost small" data-na-copy="${gi}" title="Copy the list to send it to the supplier">Copy for the supplier</button>`,
        body: U().table('<th>Item</th><th>PO</th><th class="num">Qty</th><th>Delivered</th><th class="num">Stock</th><th class="num">Waiting</th>',
          ls.map(l => `<tr data-ls-code="${esc(l.code)}">${U().item(l.code, l.description)}<td class="mono">${esc(l.po)} <span class="muted-note">${dm(l.po_date)}</span></td><td class="num">${fq(l.qty)}</td>
            <td>${dm(l.po_delivered_on)}</td><td class="num">${l.stock_now === null ? '<span class="muted-note" title="Not read yet">…</span>' : `<span class="rc-zero">${fq(l.stock_now)}</span>`}</td>
            <td class="num"><b class="ls-urgent">${daysSince(l.po_delivered_on)}d</b></td></tr>`).join('')),
      })).join(''),
    });
    U().wire(box);
    box.querySelectorAll('[data-na-copy]').forEach(b => b.addEventListener('click', async () => {
      const [sup, ls] = ordered[Number(b.dataset.naCopy)];
      const text = `${sup}: these items were ordered but not delivered. Are they available?\n` + ls.map(l => `- ${l.code} ${l.description || ''} × ${fq(l.qty)} (${l.po} of ${dm(l.po_date)})`).join('\n');
      try { await navigator.clipboard.writeText(text); showToast('Copied: paste it in WhatsApp or an email.'); } catch (e) { showToast('Could not copy on this device.', true); }
    }));
    el('lsPoNow')?.addEventListener('click', e => poNow(e.currentTarget, renderNotAvailable));
  }
  async function poNow(btn, after) {
    btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'po_sync_now' } });
      if (error || data?.error) throw new Error(data?.error || 'failed');
      showToast(`${plural(data.pos, 'PO')} of the week read · ${plural(data.openLines, 'item line')} not received yet.`);
    } catch (e) { showToast('The POs could not be read' + (e.message && e.message !== 'failed' ? ': ' + e.message : '') + '.', true); }
    await loadPOs(true); after();
  }

  /* ---------------- Top purchases: the big purchases (migration 071), the last 14 days ---------------- */
  async function loadBig() {
    const from = new Date(Date.now() - 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const { data, error } = await sb.from('big_purchases').select('*').gte('day', from).order('day', { ascending: false });
    S.big = error ? null : (data || []).filter(b => b.weeks_cover === null || Number(b.weeks_cover) >= 6);
  }
  async function renderTopPurchases() {
    const box = el('vendorTopPurchasesView'); if (!box) return;
    box.innerHTML = U().loading();
    await loadBig();
    if (S.big === null) { box.innerHTML = U().view({ title: 'Top purchases', search: false, body: U().empty('Could not be read.') }); return; }
    const groups = new Map();
    S.big.forEach(b => { const k = b.supplier || 'Unknown supplier'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); });
    U().setCount('toppurchases', S.big.length);
    box.innerHTML = U().view({
      title: 'Top purchases',
      sub: S.big.length ? `<b>${plural(S.big.length, 'big purchase')}</b> in the last 14 days: far more than usual, more than 6 weeks of sales` : 'No big purchase in the last 14 days.',
      info: 'Bought at least 3 times the item\'s usual order (the middle quantity of its purchase days in the 12 months before), worth $100 or more, and more than 6 weeks of sales at the last 90 days\' rate. Double-click an item for its details.',
      body: [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([sup, ls], i) => U().group({
        title: esc(sup), open: i < 3, chips: U().chip(plural(ls.length, 'item')),
        body: U().table('<th>Day</th><th>PU</th><th>Item</th><th class="num">Bought</th><th class="num">Usually</th><th class="num">Sells / wk</th><th class="num">Weeks</th>',
          ls.map(b => `<tr data-ls-code="${esc(b.code)}"><td>${esc(dm(b.day))}</td><td class="mono">${esc(b.documents || '')}</td>${U().item(b.code, b.description)}
            <td class="num"><b>${fq(b.qty)}</b></td><td class="num" title="The middle quantity of its ${b.times} purchase days in the 12 months before">${fq(b.usual_qty)}</td><td class="num">${fq(b.weekly_sales)}</td>
            <td class="num"><b class="ls-urgent">${b.weeks_cover === null ? 'no sales' : fq(b.weeks_cover)}</b></td></tr>`).join('')),
      })).join(''),
    });
    U().wire(box);
  }

  /* ---------------- Top sales (migrations 073, 074): selling more than they used to ---------------- */
  const TOP_VIEWS = {
    day:   { label: 'Day',   span: 'Yesterday',    usual: 'Usually',  note: 'yesterday against the daily average of the 4 weeks before (at least 2×)' },
    week:  { label: 'Week',  span: 'Last 7 days',  usual: 'Usually',  note: 'the last 7 days against the weekly average of the 8 weeks before (at least 1.5×)' },
    month: { label: 'Month', span: 'Last 30 days', usual: 'Usually',  note: 'the last 30 days against the monthly average of the 3 months before (at least 1.3×)' },
  };
  S.topPeriod = 'week'; S.topRisk = false;
  async function loadTop() {
    const { data, error } = await sb.from('top_sales').select('*').order('week_end', { ascending: false }).order('sold_week', { ascending: false }).limit(1000);
    if (error) { S.top = null; return; }
    const wk = data?.[0]?.week_end;
    S.top = (data || []).filter(t => t.week_end === wk);
  }
  async function renderTopSales() {
    const box = el('vendorTopSalesView'); if (!box) return;
    box.innerHTML = U().loading();
    await Promise.all([loadTop(), loadPOs()]);
    paintTopSales();
  }
  function paintTopSales() {
    const box = el('vendorTopSalesView'); if (!box) return;
    if (!S.top) { box.innerHTML = U().view({ title: 'Top sales', search: false, body: U().empty('Not set up yet (migrations 073, 074).') }); return; }
    const v = TOP_VIEWS[S.topPeriod], all = S.top.filter(t => t.period === S.topPeriod);
    const toOrder = t => t.attention && !onPO(t.code);
    const nAttn = all.filter(toOrder).length, list = S.topRisk ? all.filter(t => t.attention) : all;
    U().setCount('topsales', S.top.filter(t => t.period === 'week' && toOrder(t)).length);
    const groups = new Map();
    list.forEach(t => { const k = t.supplier || 'No vendor linked'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
    // a supplier with something to order first, then by its biggest gain
    const ordered = [...groups.entries()].map(([sup, l]) => [sup, l.slice().sort((a, b) => (toOrder(b) - toOrder(a)) || (b.attention - a.attention) || (Number(b.sold_week) - Number(b.usual_week)) - (Number(a.sold_week) - Number(a.usual_week)))])
      .sort((a, b) => (b[1].filter(toOrder).length - a[1].filter(toOrder).length) || a[0].localeCompare(b[0]));
    const days = n => n === null ? '<span class="muted-note">—</span>' : `<b class="${Number(n) < 3 ? 'ls-urgent' : 'ls-soon'}">${fq(n)}</b>`;
    const tools = `<div class="sc-seg">${Object.entries(TOP_VIEWS).map(([id, x]) => `<button type="button" data-lsp="${id}" class="${id === S.topPeriod ? 'active' : ''}">${x.label} <small>${S.top.filter(t => t.period === id).length}</small></button>`).join('')}</div>
      <button type="button" id="lsTopRisk" class="sc-toggle ${S.topRisk ? 'active' : ''}" title="Only the items that may run out soon">⚠ May run out <small>${all.filter(t => t.attention).length}</small></button>`;
    box.innerHTML = U().view({
      title: 'Top sales',
      sub: all.length ? `<b>${plural(all.length, 'item')}</b> selling more than usual${nAttn ? ` · <b class="ls-urgent">${nAttn} to order</b>` : ''} · ${esc(v.span.toLowerCase())}, counted ${esc(dm(S.top[0]?.week_end))}` : 'Nothing selling more than usual in this view.',
      info: `Selling more than usual: ${esc(v.note)}. ⚠ Order = out of stock, or fewer days of stock than the vendor needs to be re-supplied (its cover days, default 7), and on no PO of the week. A PO number instead = already ordered in the system, not received yet. Counted every morning. Double-click an item for its details.`,
      tools, refresh: U().refresh('id="lsTopNow"'),
      body: ordered.length ? ordered.map(([sup, l], i) => { const k = l.filter(toOrder).length; return U().group({
        title: esc(sup), open: k > 0 || i < 2, tone: k ? 'bad' : '',
        chips: U().chip(plural(l.length, 'item')) + (k ? U().chip(`${k} to order`, 'bad') : ''),
        body: U().table(`<th></th><th>Item</th><th class="num">${esc(v.span)}</th><th class="num">${esc(v.usual)}</th><th class="num">×</th><th class="num">Stock</th><th class="num">Days left</th>`,
          l.map(t => { const po = t.attention && onPO(t.code); return `<tr data-ls-code="${esc(t.code)}" class="${toOrder(t) ? 'ls-nopo' : ''}"><td>${po ? poFlag(t.code, false) : t.attention ? '<span class="ls-po none" title="May run out soon and on no PO of the week: order again">⚠ Order</span>' : ''}</td>${U().item(t.code, t.description)}
            <td class="num"><b>${fq(t.sold_week)}</b></td><td class="num">${fq(t.usual_week)}</td><td class="num">${fq(t.ratio)}×</td>
            <td class="num">${t.stock === null ? '<span class="muted-note">—</span>' : Number(t.stock) <= 0 ? '<span class="rc-zero">0</span>' : fq(t.stock)}</td><td class="num">${days(t.days_left)}</td></tr>`; }).join('')),
      }); }).join('') : U().empty(S.topRisk ? 'None of these may run out soon.' : 'Nothing selling more than usual in this view.'),
    });
    U().wire(box);
    box.querySelectorAll('[data-lsp]').forEach(b => b.onclick = () => { S.topPeriod = b.dataset.lsp; paintTopSales(); });
    el('lsTopRisk')?.addEventListener('click', () => { S.topRisk = !S.topRisk; paintTopSales(); });
    el('lsTopNow')?.addEventListener('click', async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        // one period per call (the store is big): day, week, month, one after the other
        let flagged = 0, attention = 0;
        for (const period of ['day', 'week', 'month']) {
          b.title = `Counting the ${period}…`;
          const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'top_sales_now', period } });
          let msg = data?.error || '';
          if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
          if (msg || error || !data) throw new Error(`${period}: ${msg || 'no answer'}`);
          flagged += data.flagged; attention += data.attention;
        }
        showToast(`${flagged} selling more than usual (${attention} may run out soon).`);
      } catch (err) { console.warn('top sales', err); showToast(err.message && err.message !== 'no answer' ? err.message : 'The system did not answer.', true); }
      renderTopSales();
    });
  }

  /* ---------------- Low stock (migration 066): the watched suppliers' items running low ---------------- */
  async function render() {
    const box = el('vendorLowStockView'); if (!box) return;
    if (!S.loaded) { box.innerHTML = U().loading(); await load(); }
    await loadPOs();
    const watched = vendorsList.filter(v => v.watchStock);
    const byV = new Map(); S.alerts.forEach(a => { if (!byV.has(a.vendor_id)) byV.set(a.vendor_id, []); byV.get(a.vendor_id).push(a); });
    const out = a => Number(a.stock) <= 0 || a.days_left === null;
    const noPo = a => S.po && Number(a.stock) <= 0 && !onPO(a.code);
    const rows = watched.map(v => { const all = byV.get(v.id) || []; return { v, list: all.filter(a => !a.doubtful), wrong: all.filter(a => a.doubtful) }; });
    const withLow = rows.filter(r => r.list.length)
      .sort((a, b) => b.list.filter(noPo).length - a.list.filter(noPo).length || b.list.filter(out).length - a.list.filter(out).length || b.list.length - a.list.length);
    const quiet = rows.filter(r => !r.list.length), wrong = rows.flatMap(r => r.wrong.map(a => ({ ...a, vendor: r.v.name })));
    const all = withLow.flatMap(r => r.list), nOut = all.filter(out).length, nNoPo = all.filter(noPo).length;
    U().setCount('lowstock', all.length);
    const checkBtn = v => isAdmin() ? `<button type="button" class="sc-ico" data-ls-check="${esc(v.id)}" title="Check ${esc(v.name)} now" aria-label="Check now"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>` : '';
    box.innerHTML = U().view({
      title: 'Low stock',
      sub: !watched.length ? 'No supplier is watched yet: edit a vendor and tick <b>Watch stock</b>.'
        : all.length ? `<b>${plural(all.length, 'item')}</b> running low${nOut ? ` · ${nOut} out` : ''}${nNoPo ? ` · <b class="ls-urgent">${nNoPo} out with no PO</b>` : ''} · ${plural(watched.length, 'supplier')} watched` : `Nothing running low at the ${plural(watched.length, 'supplier')} watched.`,
      info: 'The watched suppliers\' items that sold in the last 30 days and will not last the vendor\'s stock days (its cover days, default lead time + 4) at their own selling rate, or are at 0. Checked every 15 minutes in the day. The Order column: the PO of the week from the system (not received yet), "Not delivered" (the PO came without it) or "No PO". Last PU = the last purchase and its quantity; Sold since = units sold from that day. Double-click an item for its details.',
      tools: poTools(),
      body: (withLow.map((r, i) => { const v = r.v, l = r.list, o = l.filter(out).length, n = l.filter(noPo).length; return U().group({
          title: esc(v.name), open: n > 0 || i < 3, tone: n ? 'bad' : '',
          chips: U().chip(`${l.length} low`) + (o ? U().chip(`${o} out`, 'warn') : '') + (n ? U().chip(`${n} no PO`, 'bad') : '') + `<span class="sc-meta" title="${esc((v.systemSuppliers || []).map(s => s.name).join(', '))}">keep ${v.coverDays || ((v.leadTimeDays || 3) + 4)} d · ${esc(ago(v.stockCheckedAt))}</span>`,
          actions: checkBtn(v),
          body: U().table('<th>Item</th><th class="num">Stock</th><th class="num">Sells / wk</th><th class="num">Days left</th><th>Order</th><th>Last PU</th><th class="num">Sold since</th>',
            l.map(a => `<tr data-ls-code="${esc(a.code)}" class="${noPo(a) ? 'ls-nopo' : ''}">${U().item(a.code, a.description)}
              <td class="num">${Number(a.stock) <= 0 ? '<span class="rc-zero">0</span>' : fq(a.stock)}</td><td class="num">${fq(Number(a.per_day) * 7)}</td>
              <td class="num"><b class="${out(a) || Number(a.days_left) < 3 ? 'ls-urgent' : 'ls-soon'}">${out(a) ? 'out' : fq(a.days_left)}</b></td>
              <td>${poFlag(a.code, Number(a.stock) <= 0)}</td><td>${lastPu(a)}</td><td class="num">${soldSince(a)}</td></tr>`).join('')),
        }); }).join('')
        + (wrong.length ? U().group({ title: 'Count these: the stock in the system looks wrong', tone: 'warn', chips: U().chip(plural(wrong.length, 'item'), 'warn'),
            body: `<p class="muted-note sc-gnote">Not counted as running low: below 0 in the system (impossible on a shelf), or the last PU minus the sales since leaves more than the system shows. Count them and fix the stock in the system.</p>`
              + U().table('<th>Item</th><th>Supplier</th><th class="num">In the system</th><th>Last PU</th><th class="num">Sold since</th><th class="num">Should be</th>',
                wrong.map(a => `<tr data-ls-code="${esc(a.code)}">${U().item(a.code, a.description)}<td>${esc(a.vendor)}</td><td class="num"><b class="ls-urgent">${fq(a.stock)}</b></td><td>${lastPu(a)}</td><td class="num">${soldSince(a)}</td>
                  <td class="num" title="Bought at the last PU minus sold since">${a.est_stock !== null && Number(a.est_stock) > Number(a.stock) ? '<b>' + fq(a.est_stock) + '</b>' : '<span class="muted-note">—</span>'}</td></tr>`).join('')) }) : '')
        + (quiet.length ? `<p class="sc-quiet">Nothing low at ${quiet.map(r => esc(r.v.name)).join(', ')}.</p>` : '')) || U().empty('Nothing to show.'),
    });
    U().wire(box);
    box.querySelectorAll('[data-ls-check]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'stock_check_now', vendor: b.dataset.lsCheck } });
        if (error) throw error;
        const r = data?.checked?.[0];
        showToast(r ? `${r.vendor}: ${r.items} selling item${r.items === 1 ? '' : 's'} checked, ${r.low} running low.` : 'Checked.');
      } catch (e) { showToast('The system did not answer.', true); }
      await loadVendorsData(); await load(); render();
      if (window.VendorCal) VendorCal.renderStats();
    }));
    el('lsPoNow')?.addEventListener('click', e => poNow(e.currentTarget, render));
  }

  /* ---------------- the vendor form: Watch stock ---------------- */
  let picked = [];
  function wireForm(v) {
    picked = (v?.systemSuppliers || []).slice();
    const box = el('vendorWatchBox'); if (!box) return;
    el('vendorWatch').checked = !!v?.watchStock;
    el('vendorCover').value = v?.coverDays || '';
    el('vendorCover').placeholder = `default ${(v?.leadTimeDays || 3) + 4}`;
    const paintPicked = () => {
      el('vendorSysChosen').innerHTML = picked.map((s, i) => `<span class="ip-chip">${esc(s.name)}<button type="button" data-unpick="${i}" aria-label="Remove">×</button></span>`).join('') || '<span class="muted-note">No supplier linked.</span>';
      el('vendorSysChosen').querySelectorAll('[data-unpick]').forEach(b => b.onclick = () => { picked.splice(Number(b.dataset.unpick), 1); paintPicked(); });
    };
    const sync = () => { box.querySelector('.vw-more').hidden = false; el('vendorCover').disabled = !el('vendorWatch').checked; };   // the supplier link serves purchase orders too
    el('vendorWatch').onchange = () => {
      sync();
      if (el('vendorWatch').checked && !picked.length && !el('vendorSysQ').value) { el('vendorSysQ').value = el('vendorName').value.trim().split(/\s+/)[0] || ''; search(); }
    };
    let t = null, seq = 0;
    const search = async () => {
      const my = ++seq, q = el('vendorSysQ').value.trim(), out = el('vendorSysOptions');
      if (!q) { out.innerHTML = ''; return; }
      out.innerHTML = '<span class="muted-note">Searching…</span>';
      try {
        const { data } = await sb.functions.invoke('lv-dashboard', { body: { action: 'filter_options', field: 'supplier', q } });
        if (my !== seq) return;
        out.innerHTML = (data?.options || []).slice(0, 12).map(o => `<button type="button" class="ip-opt" data-sys="${esc(o.code)}" data-name="${esc(o.name.trim())}">${esc(o.name.trim())} <span class="muted-note">${esc(o.code)}</span></button>`).join('') || '<span class="muted-note">Nothing found.</span>';
        out.querySelectorAll('[data-sys]').forEach(b => b.onclick = () => { if (!picked.some(p => p.code === b.dataset.sys)) picked.push({ code: b.dataset.sys, name: b.dataset.name }); paintPicked(); });
      } catch (e) { if (my === seq) out.innerHTML = '<span class="login-err">The system did not answer.</span>'; }
    };
    el('vendorSysQ').oninput = () => { clearTimeout(t); t = setTimeout(search, 300); };
    el('vendorSysOptions').innerHTML = ''; el('vendorSysQ').value = '';
    paintPicked(); sync();
  }
  function readForm() {
    const cover = Number(el('vendorCover')?.value || 0);
    return { watchStock: !!el('vendorWatch')?.checked && picked.length > 0, systemSuppliers: picked.slice(), coverDays: cover > 0 ? Math.round(cover) : null };   // the link is kept even when not watched (purchase orders use it)
  }

  window.LowStock = { render, renderNotAvailable, loadPOs, onPO, poFlag, notAvailable, wireForm, readForm, openCount, renderTopPurchases, renderTopSales, reload: async () => { await load(); } };
})();
