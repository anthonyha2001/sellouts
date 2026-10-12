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
    // placeholder items ("MARCHANDISE AVEC TVA", "EXTRA ITEM /TVA") are not goods: left out (owner, 2026-10-12)
    S.big = error ? null : (data || []).filter(b => (b.weeks_cover === null || Number(b.weeks_cover) >= 6) && !/^\s*(MARCHANDISE\b|EXTRA ITEM\b)/i.test(b.description || ''));
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
            <td class="num" title="Read at the morning count">${t.stock === null ? '<span class="muted-note">—</span>' : Number(t.stock) <= 0 ? `<span class="rc-zero">${fq(t.stock)}</span>` : fq(t.stock)}</td><td class="num">${days(t.days_left)}</td></tr>`; }).join('')),
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

  /* ---------------- Low stock (migration 066): the watched suppliers' items running low ----------------
     Sorted by what to do (owner, 2026-10-11: "still huge, I have 551 items"), one list at a time, "Order now" first:
       Order now   : not on a PO of the week, sells 1 a week or more, and out of stock, or it runs out before a delivery
                     can come (its days left <= the vendor's lead time, 2 days at least)
       Check shelf : ghost stock (migration 083): stock in the system, but it stopped selling when it always sells
       Soon        : low, not on a PO, but there is still time (or it sells less than 1 a week)
       On order    : on a PO of the week from the system, not received yet: nothing to do
     Count these (the stock in the system looks wrong) stays apart, folded, under every list. */
  S.lsMode = 'now';
  const LS_MODES = [['now', 'Order now'], ['shelf', 'Check shelf'], ['soon', 'Soon'], ['onorder', 'On order'], ['all', 'All']];
  const out = a => Number(a.stock) <= 0 || a.days_left === null;
  const weekly = a => Number(a.per_day) * 7;
  const lead = v => Math.max(2, Number(v && v.leadTimeDays) || 3);
  const ghostOnly = a => a.ghost && Number(a.stock) > 0 && !(a.days_left !== null && Number(a.days_left) < Number(a.cover_days || 7));
  // the stock read live when the list is opened (owner, 2026-10-11: "I have 6 in stock, why does it show 0?"): the saved
  // alerts are only as fresh as the last background check of their supplier (hours, with every supplier watched), so the
  // items of the list shown are read again from the system; an item no longer low leaves the list
  S.fresh = new Map(); S.freshBusy = 0;
  const FRESH_MS = 10 * 60e3;
  function withFresh(a) {
    const f = S.fresh.get(keyOf(a.code));
    if (!f || f.stock === null) return a;
    const per = Number(a.per_day);
    return { ...a, stock: f.stock, days_left: per > 0 ? Math.round(Math.max(0, f.stock) / per * 10) / 10 : null, freshAt: f.at };
  }
  async function refreshStock(codes) {
    const todo = [...new Set(codes)].filter(c => { const f = S.fresh.get(keyOf(c)); return !f || Date.now() - f.at > FRESH_MS; }).slice(0, 200);
    if (!todo.length || S.freshBusy) return false;
    S.freshBusy = todo.length;
    try {
      for (let i = 0; i < todo.length; i += 60) {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'items_stock', codes: todo.slice(i, i + 60) } });
        if (error || !data?.stock) break;
        const at = Date.now();
        Object.entries(data.stock).forEach(([c, q]) => S.fresh.set(keyOf(c), { stock: q === null || q === undefined ? null : Number(q), at }));
      }
    } catch (e) { console.warn('stock refresh', e); }
    S.freshBusy = 0;
    return true;
  }
  // every item in one bucket (see above), with the count of each; read live and no longer low = 'fine' (not shown)
  function classify() {
    const watched = vendorsList.filter(v => v.watchStock), vOf = new Map(watched.map(v => [v.id, v]));
    const items = S.alerts.filter(a => vOf.has(a.vendor_id)).map(a0 => {
      const v = vOf.get(a0.vendor_id), a = withFresh(a0);
      if (a.freshAt && !a.doubtful && !a.ghost && Number(a.stock) > 0 && a.days_left !== null && Number(a.days_left) >= Number(a.cover_days || 7)) return { ...a, v, cat: 'fine' };
      // order now only what sold lately (its last sale within 14 days): out of stock for weeks = most likely stopped,
      // seasonal or delisted, not to order today (it stays in Soon)
      const recent = !a.last_sale || daysSince(a.last_sale) <= 14;
      const cat = a.doubtful ? 'wrong' : ghostOnly(a) ? 'shelf' : onPO(a.code) ? 'onorder'
        : weekly(a) >= 1 && recent && (out(a) || Number(a.days_left) <= lead(v)) ? 'now' : 'soon';
      return { ...a, v, cat };
    });
    const n = { now: 0, shelf: 0, soon: 0, onorder: 0, wrong: 0, fine: 0 };
    items.forEach(a => { n[a.cat]++; });
    n.all = n.now + n.shelf + n.soon + n.onorder;
    return { watched, vOf, items, n };
  }
  // for Stock control's navigation: what needs doing (order now + check the shelf), not every low item
  async function actionCount() {
    if (!S.loaded) await load();
    await loadPOs();
    const { n } = classify();
    return n.now + n.shelf;
  }
  async function render() {
    const box = el('vendorLowStockView'); if (!box) return;
    if (!S.loaded) { box.innerHTML = U().loading(); await load(); }
    await loadPOs();
    const { watched, vOf, items, n } = classify();
    const wrong = items.filter(a => a.cat === 'wrong');
    U().setCount('lowstock', n.now + n.shelf);
    const mode = S.lsMode, shown = items.filter(a => a.cat !== 'wrong' && a.cat !== 'fine' && (mode === 'all' || a.cat === mode));
    // read the live stock of what is shown (once every 10 minutes), then paint again
    const stale = shown.filter(a => !a.freshAt).map(a => a.code);
    if (stale.length && !S.freshBusy) refreshStock(stale).then(changed => { if (changed && el('vendorLowStockView')?.offsetParent !== null) render(); });
    // the most urgent first: out of stock, then the fewest days left, then the fastest sellers
    shown.sort((a, b) => (out(b) - out(a)) || (Number(a.days_left ?? -1) - Number(b.days_left ?? -1)) || weekly(b) - weekly(a));

    const ghostTag = a => a.ghost ? ` <span class="ls-po draft" title="Sold on ${a.days_sold} of the last 30 days, nothing for ${a.quiet_days} days: check the shelf">no sale ${a.quiet_days}d</span>` : '';
    const checkBtn = v => isAdmin() ? `<button type="button" class="sc-ico" data-ls-check="${esc(v.id)}" title="Check ${esc(v.name)} now" aria-label="Check now"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>` : '';
    const tag = { now: '<span class="ls-po none">Order now</span>', soon: '<span class="ls-po draft">Soon</span>' };
    const lowRow = a => `<tr data-ls-code="${esc(a.code)}" class="${a.cat === 'now' && out(a) ? 'ls-nopo' : ''}">${U().item(a.code, a.description)}
      <td class="num" title="${a.freshAt ? 'Read from the system just now' : 'From the last check of ' + esc(a.v.name) + ', ' + esc(ago(a.last_seen || a.v.stockCheckedAt))}">${Number(a.stock) <= 0 ? `<span class="rc-zero">${fq(a.stock)}</span>` : fq(a.stock)}${a.freshAt ? '' : ' <span class="muted-note">…</span>'}</td><td class="num">${fq(weekly(a))}</td>
      <td class="num"><b class="${out(a) || Number(a.days_left) < 3 ? 'ls-urgent' : 'ls-soon'}">${out(a) ? 'out' : fq(a.days_left)}</b></td>
      <td>${a.cat === 'onorder' ? poFlag(a.code, false) : (mode === 'all' ? tag[a.cat] || '' : '') + (Number(a.stock) <= 0 ? ' ' + poFlag(a.code, true) : '')}${ghostTag(a)}</td><td>${lastPu(a)}</td><td class="num">${soldSince(a)}</td></tr>`;
    const lowHead = '<th>Item</th><th class="num">Stock</th><th class="num">Sells / wk</th><th class="num">Days left</th><th>Order</th><th>Last PU</th><th class="num">Sold since</th>';
    const shelfRow = a => `<tr data-ls-code="${esc(a.code)}">${U().item(a.code, a.description)}<td class="num"><b>${fq(a.stock)}</b></td><td class="num">${fq(weekly(a))}</td>
      <td>${a.last_sale ? esc(dm(a.last_sale)) : '<span class="muted-note">—</span>'} <span class="muted-note" title="Days with a sale in the last 30">· sold ${a.days_sold}/30 d</span></td>
      <td class="num"><b class="ls-urgent">${a.quiet_days} days</b></td><td>${poFlag(a.code, false)}</td></tr>`;
    const shelfHead = '<th>Item</th><th class="num">In the system</th><th class="num">Sells / wk</th><th>Last sale</th><th class="num">No sale for</th><th>Order</th>';

    // by supplier: the most "order now" first; the first 3 open
    const groups = new Map();
    shown.forEach(a => { if (!groups.has(a.vendor_id)) groups.set(a.vendor_id, []); groups.get(a.vendor_id).push(a); });
    const ordered = [...groups.entries()].map(([vid, l]) => [vOf.get(vid), l]).sort((a, b) => b[1].filter(x => x.cat === 'now').length - a[1].filter(x => x.cat === 'now').length || b[1].length - a[1].length);
    const groupHtml = ([v, l], i) => {
      const nNow = l.filter(x => x.cat === 'now').length, nOut = l.filter(out).length;
      return U().group({
        title: esc(v.name), open: i < 3, tone: nNow ? 'bad' : '',
        chips: U().chip(plural(l.length, 'item')) + (nNow && mode !== 'now' ? U().chip(`${nNow} order now`, 'bad') : '') + (nOut && mode !== 'shelf' ? U().chip(`${nOut} out`, 'warn') : '')
          + `<span class="sc-meta" title="${esc((v.systemSuppliers || []).map(s => s.name).join(', '))}">lead ${lead(v)} d · ${esc(ago(v.stockCheckedAt))}</span>`,
        actions: checkBtn(v),
        body: mode === 'shelf' ? `<p class="muted-note sc-gnote">Sells almost every day, no sale for days while the system shows stock: the shelf is most likely empty (lost, stolen, still in the storeroom, or mis-scanned). Count it, fix the stock in the system, then reorder.</p>` + U().table(shelfHead, l.map(shelfRow).join(''))
          : U().table(lowHead, l.map(a => a.cat === 'shelf' ? lowRow({ ...a }) : lowRow(a)).join('')),
      });
    };
    const empty = { now: 'Nothing to order now: every low item is on a PO, or has time left.', shelf: 'No ghost stock: every regular seller sold recently.', soon: 'Nothing in this list.', onorder: 'No low item is on a PO of the week.', all: 'Nothing running low.' }[mode];
    const tools = `<div class="sc-seg">${LS_MODES.map(([k, l]) => `<button type="button" data-lsm="${k}" class="${k === mode ? 'active' : ''}">${l} <small>${n[k]}</small></button>`).join('')}</div>` + poTools();
    box.innerHTML = U().view({
      title: 'Low stock',
      sub: !watched.length ? 'No supplier is watched yet: edit a vendor and tick <b>Watch stock</b>.'
        : `<b class="${n.now ? 'ls-urgent' : ''}">${n.now} to order now</b>${n.shelf ? ` · <b class="ls-urgent">${n.shelf} to check on the shelf</b>` : ''} · ${n.soon} soon · ${n.onorder} on order · ${plural(watched.length, 'supplier')} watched`,
      info: '<b>Order now</b>: not on a PO of the week, sells 1 a week or more, sold in the last 14 days, and out of stock or it runs out before a delivery can come (days left ≤ the vendor\'s lead time, 2 days at least). <b>Check shelf</b>: the system shows stock, but an item that sells on 6 days or more of 30 has not sold for so long that it almost never happens by chance: the shelf is most likely empty. <b>Soon</b>: low, but there is still time, or it sells less than 1 a week. <b>On order</b>: on a PO of the week from the system, not received yet. Checked every 15 minutes in the day (only the items that sold in the last 30 days). Last PU = the last purchase and its quantity; Sold since = units sold from that day. Double-click an item for its details.',
      tools,
      body: (ordered.length ? ordered.map(groupHtml).join('') : U().empty(empty))
        + (wrong.length ? U().group({ title: 'Count these: the stock in the system looks wrong', tone: 'warn', chips: U().chip(plural(wrong.length, 'item'), 'warn'),
            body: `<p class="muted-note sc-gnote">Not counted as running low: below 0 in the system (impossible on a shelf), or the last PU minus the sales since leaves more than the system shows. Count them and fix the stock in the system.</p>`
              + U().table('<th>Item</th><th>Supplier</th><th class="num">In the system</th><th>Last PU</th><th class="num">Sold since</th><th class="num">Should be</th>',
                wrong.map(a => `<tr data-ls-code="${esc(a.code)}">${U().item(a.code, a.description)}<td>${esc(a.v.name)}</td><td class="num"><b class="ls-urgent">${fq(a.stock)}</b></td><td>${lastPu(a)}</td><td class="num">${soldSince(a)}</td>
                  <td class="num" title="Bought at the last PU minus sold since">${a.est_stock !== null && Number(a.est_stock) > Number(a.stock) ? '<b>' + fq(a.est_stock) + '</b>' : '<span class="muted-note">—</span>'}</td></tr>`).join('')) }) : ''),
    });
    U().wire(box);
    box.querySelectorAll('[data-lsm]').forEach(b => b.onclick = () => { S.lsMode = b.dataset.lsm; render(); });
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

  window.LowStock = { render, actionCount, renderNotAvailable, loadPOs, onPO, poFlag, notAvailable, wireForm, readForm, openCount, renderTopPurchases, renderTopSales, reload: async () => { await load(); } };
})();
