/* ============================================================
   Performance › Weekly report (owner, 2026-10-12; migration 089).
   Made every Monday at 08:00 by lv-dashboard (weekly_report) and kept
   as it was that day: last week (Monday to Sunday) against the week
   before. Pick a past week, print it (or save it as a PDF from the
   print window). An admin can make a week again (Make again).
   Permission: vendors.manage. Public API: window.WeeklyReport = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const el = id => document.getElementById(id);
  const usd = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const lbp = v => (n(v) < 0 ? '-' : '') + Math.abs(Math.round(n(v))).toLocaleString('en-US') + ' LBP';
  const pct = v => v === null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + (Math.round(v * 1000) / 10).toLocaleString('en-US') + '%';
  const ch = (a, b) => n(b) > 0 ? n(a) / n(b) - 1 : null;
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const S = { weeks: [], week: null, data: null };
  const failed = x => !x || x.failed;
  const FAIL = '<p class="login-err" style="margin:0;">Could not be read when the report was made.</p>';
  const ICON_PRINT = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg>';
  const ICON_REDO = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

  async function show(box) {
    if (!box) return;
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the weekly reports…</p></div>';
    const { data, error } = await sb.from('weekly_reports').select('week_start').order('week_start', { ascending: false }).limit(60);
    if (error) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(/weekly_reports/.test(error.message) ? 'The weekly report is not set up yet (migration 089).' : error.message)}</p></div>`; return; }
    S.weeks = (data || []).map(r => r.week_start);
    if (!S.week || !S.weeks.includes(S.week)) S.week = S.weeks[0] || null;
    await open(box);
  }
  async function open(box) {
    if (!S.week) { box.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">No report yet: the first one is made on Monday at 08:00.${isAdmin() ? ' <button type="button" class="btn small" id="wrMake">Make last week’s now</button>' : ''}</p></div>`; el('wrMake')?.addEventListener('click', () => make(box)); return; }
    const { data, error } = await sb.from('weekly_reports').select('data').eq('week_start', S.week).maybeSingle();
    if (error || !data) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(error ? error.message : 'Not found.')}</p></div>`; return; }
    S.data = data.data; paint(box);
  }
  async function make(box, week) {
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'weekly_report', week } });
      if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
      S.week = data.start; showToast('The report is made again.'); await show(box);
    } catch (e) { showToast(e.message, true); }
  }
  function paint(box) {
    const d = S.data, s = d.sales;
    const total = failed(s) ? null : s.total, prev = failed(s) ? null : s.prev;
    const card = (title, body, cls = '') => `<section class="card wr-card ${cls}"><h3>${title}</h3>${body}</section>`;
    const table = (head, rows, empty) => rows.length ? `<table class="items wr-table"><thead><tr>${head.map(h => `<th class="${h.startsWith('#') ? 'num' : ''}">${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="muted-note" style="margin:0;">${empty}</p>`;
    const maxDay = failed(s) ? 1 : Math.max(1, ...s.days.map(x => Math.max(n(x.sales), n(x.prev))));
    const daysHtml = failed(s) ? FAIL : `<div class="wr-days">${s.days.map(x => { const c = ch(x.sales, x.prev); const dd = new Date(x.day + 'T00:00:00Z');
      return `<div class="wr-day"><div class="wr-bars"><i class="wr-b-prev" style="height:${Math.round(n(x.prev) / maxDay * 100)}%" title="${esc(DAY[dd.getUTCDay()])} before (${esc(dmy(x.prevDay))}): ${usd(x.prev)}"></i><i class="wr-b-now" style="height:${Math.round(n(x.sales) / maxDay * 100)}%" title="${esc(dmy(x.day))}: ${usd(x.sales)}"></i></div>
        <b>${DAY[dd.getUTCDay()]}</b><span>${usd(x.sales)}</span><span class="${c === null ? '' : c < 0 ? 'pf-neg' : 'pf-up'}">${pct(c)}</span></div>`; }).join('')}</div>
      <div class="pf-legend" style="margin-top:6px;"><span><i class="pf-k-s"></i>Last week</span><span><i class="wr-k-prev"></i>The week before</span></div>`;
    const sec = d.sections;
    const secHtml = failed(sec) ? FAIL : `<div class="wr-two"><div><h4>Grew most</h4>${table(['Section', '#Sales', '#Change'], sec.up.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${usd(r.sales)}</td><td class="num pf-up">+$${Math.round(r.diff).toLocaleString('en-US')}</td></tr>`), 'None.')}</div>
      <div><h4>Fell most</h4>${table(['Section', '#Sales', '#Change'], sec.down.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${usd(r.sales)}</td><td class="num pf-neg">-$${Math.round(-r.diff).toLocaleString('en-US')}</td></tr>`), 'None.')}</div></div>`;
    const m = d.margin;
    const amt = (v, c) => c === 'LBP' ? lbp(v) : '$' + (Math.round(n(v) * 100) / 100).toFixed(2);
    const marginHtml = failed(m) ? FAIL : `<p class="wr-line"><b>${m.costUp}</b> cost up with the price not following · <b>${m.below}</b> below cost · <b>${m.closed}</b> closed since · <b>${m.open}</b> still open</p>
      ${table(['Item', 'Supplier', '#Cost', '#Price', '#Margin'], m.worst.map(r => `<tr><td>${esc(r.description || r.code)}</td><td>${esc(r.supplier || '')}</td><td class="num">${amt(r.cost, r.currency)}</td><td class="num">${amt(r.sale_price, r.currency)}</td><td class="num ${n(r.margin) < 0 ? 'pf-neg' : ''}">${pct(n(r.margin))}</td></tr>`), 'Nothing open.')}`;
    const b = d.bigBuys;
    const bigHtml = failed(b) ? FAIL : table(['Day', 'Item', 'Supplier', '#Bought', '#Usually', '#Weeks of sales'], b.top.map(r => `<tr><td>${esc(dmy(r.day))}</td><td>${esc(r.description || '')}</td><td>${esc(r.supplier || '')}</td><td class="num"><b>${Math.round(n(r.qty))}</b></td><td class="num">${Math.round(n(r.usual_qty))}</td><td class="num">${r.weeks_cover === null ? 'no sales' : Math.round(n(r.weeks_cover))}</td></tr>`), 'None.')
      + (failed(b) || b.count <= b.top.length ? '' : `<p class="muted-note" style="margin:6px 0 0;">${b.count} in all (the biggest shown).</p>`);
    const st = d.stock, po = d.pos;
    const stockHtml = failed(st) ? FAIL : `<p class="wr-line"><b>${st.low}</b> running low · <b>${st.ghost}</b> shelves to check (stock in the system, no sale) · <b>${st.wrongCount}</b> counts wrong in the system</p>`;
    const poHtml = failed(po) ? FAIL : `<p class="wr-line"><b>${po.notDelivered}</b> PO${po.notDelivered === 1 ? '' : 's'} not delivered after 3 days · <b>${po.ordersLate}</b> order${po.ordersLate === 1 ? '' : 's'} late on the vendor board</p>`
      + table(['PO', 'Day', 'Supplier', '#Lines'], po.list.map(r => `<tr><td class="mono">${esc(r.po)}</td><td>${esc(dmy(r.po_date))}</td><td>${esc(r.supplier_name || '')}</td><td class="num">${n(r.line_count)}</td></tr>`), '');
    const ex = d.expiries;
    const expHtml = failed(ex) ? FAIL : table(['Expires', 'Item', 'Supplier', '#Qty'], ex.list.map(r => `<tr><td>${esc(dmy(r.expiry_date))}</td><td>${esc(r.description || '')}</td><td>${esc(r.supplier || '')}</td><td class="num">${r.qty === null ? '' : n(r.qty)}</td></tr>`), 'Nothing recorded expiring in the coming week.');
    const ca = d.cash;
    const cashHtml = failed(ca) ? FAIL : `<p class="wr-line">In all: <b class="${ca.lbp < 0 ? 'pf-neg' : ''}">${lbp(ca.lbp)}</b>${ca.usd ? ` and <b class="${ca.usd < 0 ? 'pf-neg' : ''}">$${ca.usd.toLocaleString('en-US')}</b>` : ''}</p>`
      + table(['Cashier', '#Days', '#LBP', '#USD'], ca.list.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.n}</td><td class="num ${r.lbp < 0 ? 'pf-neg' : ''}">${lbp(r.lbp)}</td><td class="num ${r.usd < 0 ? 'pf-neg' : ''}">${r.usd ? '$' + (Math.round(r.usd * 100) / 100).toLocaleString('en-US') : ''}</td></tr>`), 'No cash difference recorded.');
    const re = d.rentals;
    const rentHtml = failed(re) ? FAIL : table(['Ends', 'Supplier', '#Amount'], re.ending.map(r => `<tr><td>${esc(dmy(r.end_date))}</td><td>${esc(r.supplier)}</td><td class="num">${usd(r.amount)}${r.term === 'monthly' ? '/mo' : r.term === 'yearly' ? '/yr' : ''}</td></tr>`), 'No rent ending in the next 30 days.');
    const c = ch(total, prev);
    box.innerHTML = `<div class="card pf-controls wr-controls">
        <label>Week <select id="wrWeek">${S.weeks.map(w => `<option value="${w}" ${w === S.week ? 'selected' : ''}>${esc(dmy(w))} → ${esc(dmy(addDaysStr(w, 6)))}</option>`).join('')}</select></label>
        <span style="flex:1"></span>
        ${isAdmin() ? `<button type="button" class="icon-btn" id="wrRedo" title="Make this week again (from today's data)" aria-label="Make again">${ICON_REDO}</button>` : ''}
        <button type="button" class="icon-btn" id="wrPrint" title="Print (or save as PDF)" aria-label="Print">${ICON_PRINT}</button></div>
      <div class="wr-page" id="wrPage">
        <div class="wr-title"><h2>Weekly report</h2><span>${esc(dmy(d.start))} → ${esc(dmy(d.end))} · against ${esc(dmy(d.prevStart))} → ${esc(dmy(d.prevEnd))}</span></div>
        <div class="pf-tiles">
          <div class="pf-tile"><span>Sales</span><b>${total === null ? '—' : usd(total)}</b><small>the week before ${prev === null ? '—' : usd(prev)}</small></div>
          <div class="pf-tile"><span>Change</span><b class="${c === null ? '' : c < 0 ? 'pf-neg' : 'pf-up'}">${pct(c)}</b><small>${total === null ? '' : (total - prev >= 0 ? '+' : '-') + usd(Math.abs(total - prev))}</small></div>
          <div class="pf-tile"><span>Margin watch</span><b>${failed(m) ? '—' : m.open}</b><small>open alerts</small></div>
          <div class="pf-tile"><span>Running low</span><b>${failed(st) ? '—' : st.low}</b><small>${failed(st) ? '' : st.ghost + ' shelves to check'}</small></div>
        </div>
        ${card('Sales, day by day', daysHtml)}
        ${card('Sections', secHtml)}
        ${card('Margin watch', marginHtml)}
        ${card('Big purchases', bigHtml)}
        <div class="wr-two">${card('Stock', stockHtml)}${card('Purchase orders', poHtml)}</div>
        ${card('Expiring in the coming week', expHtml)}
        <div class="wr-two">${card('Cash differences', cashHtml)}${card('Rentals ending in 30 days', rentHtml)}</div>
        <p class="muted-note">Made on ${esc(new Date(d.made).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', dateStyle: 'medium', timeStyle: 'short' }))}, kept as it was. Sales in $ as the system reports them.</p>
      </div>`;
    el('wrWeek').onchange = () => { S.week = el('wrWeek').value; open(box); };
    el('wrPrint').onclick = () => { document.body.classList.add('wr-printing'); const after = () => { document.body.classList.remove('wr-printing'); window.removeEventListener('afterprint', after); }; window.addEventListener('afterprint', after); window.print(); };
    el('wrRedo')?.addEventListener('click', async e => { e.currentTarget.disabled = true; await make(box, S.week); });
  }
  window.WeeklyReport = { show };
})();
