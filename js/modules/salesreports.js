/* ============================================================
   Performance › Categories and Daily sales (owner, 2026-10-11), live
   from the system (lv-dashboard sales_categories / store_daily).
   Compared with LAST MONTH (owner: "there is no data in last year"):
   - Categories: the store's sales by department, section, group or
     brand for the chosen dates, against the same dates one month
     before (a whole month against the whole month before). Click a
     department / section / group to open what is inside it.
   - Daily sales: one month day by day; each day against the same
     weekday four weeks before (a Saturday with a Saturday), the month
     to date against the same dates of last month. Today is shown
     apart ("so far"): a day in progress is never compared.
   Permission: as Performance (vendors.manage).
   - By hour (2026-10-12): measured every 15 minutes (sales_snapshots, migration 086).
   Public API: window.SalesReports = { showCategories, showDaily, showHourly }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const qty = v => Math.round(n(v)).toLocaleString('en-US');
  const pct = v => v === null ? '—' : (v > 0 ? '+' : '') + (Math.round(v * 1000) / 10).toLocaleString('en-US') + '%';
  const chg = (a, b) => b > 0 ? a / b - 1 : null;
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const el = id => document.getElementById(id);
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const D = s => new Date(s + 'T00:00:00Z');
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (s, k) => { const d = D(s); d.setUTCDate(d.getUTCDate() + k); return iso(d); };
  const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const shiftMonths = (s, k) => { const d = D(s), y = d.getUTCFullYear(), m = d.getUTCMonth() - k, yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12; return iso(new Date(Date.UTC(yy, mm, Math.min(d.getUTCDate(), lastDay(yy, mm))))); };
  // the period to compare with: the same dates one month before; whole months against the whole months before
  function prevPeriod(f, t) {
    const F = D(f), T = D(t);
    const whole = F.getUTCDate() === 1 && T.getUTCDate() === lastDay(T.getUTCFullYear(), T.getUTCMonth());
    const span = (T.getUTCFullYear() - F.getUTCFullYear()) * 12 + T.getUTCMonth() - F.getUTCMonth() + 1;
    if (whole) { const pf = shiftMonths(f, span), pt = shiftMonths(t, span), P = D(pt); return [pf, iso(new Date(Date.UTC(P.getUTCFullYear(), P.getUTCMonth(), lastDay(P.getUTCFullYear(), P.getUTCMonth()))))]; }
    if (span === 1) return [shiftMonths(f, 1), shiftMonths(t, 1)];
    const len = Math.round((T - F) / 864e5) + 1; return [addDays(f, -len), addDays(f, -1)];   // longer odd ranges: the same number of days before
  }
  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'no answer');
    return data;
  }
  const failMsg = e => e.message === 'no answer' ? 'The system did not answer. Check the "Link to the system" card on the Dashboard.' : e.message;
  const xlsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
  function xls(aoa, name) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map((h, i) => ({ wch: i === 0 ? 34 : 14 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sales');
    XLSX.writeFile(wb, `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim()}.xlsx`);
  }
  const cls = v => v === null ? '' : v < 0 ? 'pf-neg' : 'pf-up';

  /* ================= Categories ================= */
  const LEVELS = [['department', 'Department'], ['section', 'Section'], ['group', 'Group'], ['brand', 'Brand']];
  const CHILD = { department: 'section', section: 'group', group: 'subgroup' };
  const LABEL = { department: 'Department', section: 'Section', group: 'Group', subgroup: 'Sub-group', brand: 'Brand' };
  const C = { from: null, to: null, level: 'department', path: [], q: '', sort: 'sales', dir: -1, data: null, seq: 0 };
  function presets() {
    const t = todayStr(), y = addDays(t, -1), T = D(t), first = iso(new Date(Date.UTC(T.getUTCFullYear(), T.getUTCMonth(), 1)));
    const lmFirst = shiftMonths(first, 1), lmLast = addDays(first, -1);
    const list = [];
    if (y >= first) list.push(['This month', first, y]);       // to yesterday: a day in progress is not compared
    list.push(['Last month', lmFirst, lmLast]);
    list.push(['Last 7 days', addDays(t, -7), y]);
    return list;
  }
  function showCategories(box) {
    if (!box) return;
    if (!C.from) { const p = presets()[0]; C.from = p[1]; C.to = p[2]; }
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = `
        <div class="card pf-controls">
          <label>From <input type="date" id="scFrom"></label>
          <label>to <input type="date" id="scTo"></label>
          <div class="filter-row" id="scQuick" style="margin:0;"></div>
          <button type="button" class="btn small" id="scLoad">Load</button>
        </div>
        <div id="scBody"></div>`;
      el('scQuick').onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; const p = presets()[Number(b.dataset.p)]; C.from = p[1]; C.to = p[2]; loadCats(); };
      el('scLoad').onclick = () => { const f = el('scFrom').value, t = el('scTo').value; if (!f || !t || f > t) return showToast('Choose the dates (from before to).', true); C.from = f; C.to = t; loadCats(); };
    }
    if (!C.data) loadCats(); else paintCats();
  }
  async function loadCats() {
    el('scFrom').value = C.from; el('scTo').value = C.to;
    el('scQuick').innerHTML = presets().map((p, i) => `<button type="button" data-p="${i}" class="${p[1] === C.from && p[2] === C.to ? 'active' : ''}">${p[0]}</button>`).join('');
    const my = ++C.seq, [pf, pt] = prevPeriod(C.from, C.to), parent = C.path[C.path.length - 1];
    const level = parent ? CHILD[parent.level] : C.level;
    el('scBody').innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the sales by ' + esc(LABEL[level].toLowerCase()) + ' from the system…</p></div>';
    const body = (f, t) => ({ action: 'sales_categories', from: f, to: t, level, ...(parent ? { parentLevel: parent.level, parentCode: parent.code } : {}) });
    try {
      const [now, prev] = await Promise.all([call(body(C.from, C.to)), call(body(pf, pt))]);
      if (my !== C.seq) return;
      const pm = new Map(prev.rows.map(r => [r.code, r]));
      const rows = now.rows.map(r => ({ ...r, prevSales: n(pm.get(r.code)?.sales), prevQty: n(pm.get(r.code)?.qty) }));
      prev.rows.forEach(r => { if (!rows.some(x => x.code === r.code)) rows.push({ code: r.code, name: r.name, sales: 0, qty: 0, prevSales: n(r.sales), prevQty: n(r.qty) }); });
      rows.forEach(r => { r.ch = chg(r.sales, r.prevSales); r.diff = r.sales - r.prevSales; });
      C.data = { level, rows, pf, pt, from: C.from, to: C.to };
      paintCats();
    } catch (e) { if (my === C.seq) el('scBody').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(failMsg(e))}</p></div>`; }
  }
  function paintCats() {
    const d = C.data, box = el('scBody'); if (!d || !box) return;
    const total = d.rows.reduce((t, r) => t + r.sales, 0), ptotal = d.rows.reduce((t, r) => t + r.prevSales, 0);
    const q = C.q.trim().toLowerCase();
    const rows = d.rows.filter(r => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q));
    const k = C.sort; rows.sort((a, b) => C.dir * (k === 'name' ? a.name.localeCompare(b.name) : (n(a[k] ?? -1e15) - n(b[k] ?? -1e15))));
    const movers = d.rows.filter(r => r.prevSales >= total * 0.002 || r.sales >= total * 0.002);   // ignore crumbs for the best / worst tiles
    const up = [...movers].sort((a, b) => b.diff - a.diff)[0], down = [...movers].sort((a, b) => a.diff - b.diff)[0];
    const sortIc = key => key === C.sort ? (C.dir < 0 ? ' ▾' : ' ▴') : '';
    const th = (key, label, num = true) => `<th class="${num ? 'num ' : ''}pf-sort" data-k="${key}">${label}${sortIc(key)}</th>`;
    const crumbs = [`<button type="button" data-crumb="-1">All ${esc(LEVELS.find(l => l[0] === C.level)?.[1].toLowerCase() || '')}s</button>`]
      .concat(C.path.map((p, i) => `<span class="muted-note">›</span><button type="button" data-crumb="${i}">${esc(p.name)}</button>`)).join(' ');
    const canOpen = !!CHILD[d.level];
    box.innerHTML = `
      <div class="filter-row sc-levels" style="margin:0 0 10px;">${C.path.length ? `<div class="sc-crumbs">${crumbs}</div>` : LEVELS.map(([v, l]) => `<button type="button" data-level="${v}" class="${v === C.level ? 'active' : ''}">${l}</button>`).join('')}</div>
      <div class="pf-tiles">
        <div class="pf-tile"><span>Sales</span><b>${money(total)}</b><small>${esc(dmy(d.from))} → ${esc(dmy(d.to))}</small></div>
        <div class="pf-tile"><span>Last month</span><b>${money(ptotal)}</b><small>${esc(dmy(d.pf))} → ${esc(dmy(d.pt))}</small></div>
        <div class="pf-tile"><span>Change</span><b class="${cls(chg(total, ptotal))}">${pct(chg(total, ptotal))}</b><small>${(total - ptotal >= 0 ? '+' : '-') + money(Math.abs(total - ptotal)).slice(0)}</small></div>
        ${up && up.diff > 0 ? `<div class="pf-tile"><span>Grew most</span><b class="pf-up" style="font-size:15px;">${esc(up.name)}</b><small>+${money(up.diff)} · ${pct(up.ch)}</small></div>` : ''}
        ${down && down.diff < 0 ? `<div class="pf-tile"><span>Fell most</span><b class="pf-neg" style="font-size:15px;">${esc(down.name)}</b><small>-${money(-down.diff)} · ${pct(down.ch)}</small></div>` : ''}
      </div>
      <div class="card">
        <div class="pf-head"><h3>${esc(LABEL[d.level])}s${C.path.length ? ' of ' + esc(C.path[C.path.length - 1].name) : ''}</h3>
          <input type="search" id="scQ" placeholder="Find a ${esc(LABEL[d.level].toLowerCase())}" value="${esc(C.q)}" aria-label="Find">
          <span style="flex:1"></span>
          <button type="button" class="icon-btn" id="scXls" title="Download (Excel)" aria-label="Download (Excel)">${xlsIcon}</button></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table sc-table"><thead><tr>
          ${th('name', LABEL[d.level], false)}${th('sales', 'Sales')}<th class="num">Share</th>${th('prevSales', 'Last month')}${th('diff', 'Difference')}${th('ch', 'Change')}${th('qty', 'Units')}${th('prevQty', 'Units last month')}</tr></thead>
          <tbody>${rows.map(r => `<tr class="${canOpen ? 'pf-row' : ''}" data-code="${esc(r.code)}" ${canOpen ? `tabindex="0" title="Open the ${esc(LABEL[CHILD[d.level]].toLowerCase())}s of ${esc(r.name)}"` : ''}>
            <td><b>${esc(r.name)}</b></td>
            <td class="num">${money(r.sales)}</td>
            <td class="num"><span class="sc-share"><i style="width:${total > 0 ? Math.max(1, Math.round(r.sales / total * 100)) : 0}%"></i></span>${total > 0 ? (Math.round(r.sales / total * 1000) / 10) + '%' : ''}</td>
            <td class="num">${money(r.prevSales)}</td>
            <td class="num ${r.diff < 0 ? 'pf-neg' : ''}">${(r.diff >= 0 ? '+' : '-') + money(Math.abs(r.diff))}</td>
            <td class="num"><span class="${cls(r.ch)}">${r.prevSales > 0 ? pct(r.ch) : '<span class="muted-note">new</span>'}</span></td>
            <td class="num">${qty(r.qty)}</td><td class="num">${qty(r.prevQty)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-note">No sales.</td></tr>'}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Sales in $ as the system reports them, against the same dates one month before (a whole month against the whole month before). ${canOpen ? 'Click a line to open what is inside it.' : ''}</p>
      </div>`;
    box.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { C.level = b.dataset.level; C.path = []; C.q = ''; loadCats(); });
    box.querySelectorAll('[data-crumb]').forEach(b => b.onclick = () => { C.path = C.path.slice(0, Number(b.dataset.crumb) + 1); C.q = ''; loadCats(); });
    box.querySelectorAll('.pf-sort').forEach(h => h.onclick = () => { const key = h.dataset.k; if (C.sort === key) C.dir = -C.dir; else { C.sort = key; C.dir = key === 'name' ? 1 : -1; } paintCats(); });
    el('scQ').oninput = () => { C.q = el('scQ').value; const pos = el('scQ').selectionStart; paintCats(); el('scQ').focus(); el('scQ').setSelectionRange(pos, pos); };
    if (canOpen) box.querySelectorAll('tr[data-code]').forEach(tr => { const go = () => { const r = d.rows.find(x => x.code === tr.dataset.code); C.path.push({ level: d.level, code: r.code, name: r.name }); C.q = ''; loadCats(); };
      tr.onclick = go; tr.onkeydown = e => { if (e.key === 'Enter') go(); }; });
    el('scXls').onclick = () => xls([[LABEL[d.level], 'Code', 'Sales ($)', 'Share %', 'Last month ($)', 'Difference ($)', 'Change %', 'Units', 'Units last month'],
      ...rows.map(r => [r.name, r.code, Math.round(r.sales * 100) / 100, total > 0 ? Math.round(r.sales / total * 1000) / 10 : '', Math.round(r.prevSales * 100) / 100, Math.round(r.diff * 100) / 100, r.ch === null ? '' : Math.round(r.ch * 1000) / 10, Math.round(r.qty), Math.round(r.prevQty)]),
      [], ['Total', '', Math.round(total * 100) / 100, '', Math.round(ptotal * 100) / 100, Math.round((total - ptotal) * 100) / 100, ptotal > 0 ? Math.round((total / ptotal - 1) * 1000) / 10 : '']],
      `Sales by ${LABEL[d.level].toLowerCase()} ${d.from} ${d.to}`);
  }

  /* ================= Daily sales ================= */
  const S = { month: null, data: null, seq: 0 };
  function showDaily(box) {
    if (!box) return;
    if (!S.month) S.month = todayStr().slice(0, 7);
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = `
        <div class="card pf-controls">
          <button type="button" class="icon-btn" id="sdPrev" title="Month before" aria-label="Month before"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <input type="month" id="sdMonth" aria-label="Month">
          <button type="button" class="icon-btn" id="sdNext" title="Month after" aria-label="Month after"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
          <button type="button" class="icon-btn" id="sdReload" title="Read again" aria-label="Read again"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
        </div>
        <div id="sdBody"></div>`;
      const go = k => { const [y, m] = S.month.split('-').map(Number), d = new Date(Date.UTC(y, m - 1 + k, 1)), v = iso(d).slice(0, 7); if (v > todayStr().slice(0, 7)) return; S.month = v; loadDaily(); };
      el('sdPrev').onclick = () => go(-1); el('sdNext').onclick = () => go(1);
      el('sdMonth').onchange = () => { if (el('sdMonth').value && el('sdMonth').value <= todayStr().slice(0, 7)) { S.month = el('sdMonth').value; loadDaily(); } };
      el('sdReload').onclick = () => loadDaily();
    }
    if (!S.data || S.data.month !== S.month) loadDaily(); else paintDaily();
  }
  async function loadDaily() {
    el('sdMonth').value = S.month; el('sdMonth').max = todayStr().slice(0, 7);
    const my = ++S.seq, first = S.month + '-01', [y, m] = S.month.split('-').map(Number), last = iso(new Date(Date.UTC(y, m, 0)));
    const to = last < todayStr() ? last : todayStr(), lmFirst = shiftMonths(first, 1), from = addDays(first, -28) < lmFirst ? addDays(first, -28) : lmFirst;
    el('sdBody').innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the sales day by day from the system…</p></div>';
    try {
      const r = await call({ action: 'store_daily', from, to });
      if (my !== S.seq) return;
      S.data = { month: S.month, first, last, to, days: r.days || {} };
      paintDaily();
    } catch (e) { if (my === S.seq) el('sdBody').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(failMsg(e))}</p></div>`; }
  }
  function paintDaily() {
    const d = S.data, box = el('sdBody'); if (!d || !box) return;
    const today = todayStr(), days = [];
    for (let x = d.first; x <= d.to; x = addDays(x, 1)) {
      const v = d.days[x] || { sales: 0, qty: 0 }, cmpDay = addDays(x, -28), c = d.days[cmpDay];
      days.push({ day: x, sales: n(v.sales), qty: n(v.qty), cmpDay, cmpSales: c ? n(c.sales) : null, today: x === today });
    }
    const done = days.filter(x => !x.today);
    const mtd = done.reduce((t, x) => t + x.sales, 0);
    // the same dates of last month (1st to the same day number), from the days read
    const lastDone = done.length ? done[done.length - 1].day : null;
    let lmTotal = 0; const lmOk = !!lastDone;
    if (lastDone) for (let x = shiftMonths(d.first, 1); x <= shiftMonths(lastDone, 1); x = addDays(x, 1)) lmTotal += n(d.days[x]?.sales);
    const avg = done.length ? mtd / done.length : 0, best = [...done].sort((a, b) => b.sales - a.sales)[0];
    const td = days.find(x => x.today);
    const max = Math.max(1, ...days.map(x => Math.max(x.sales, n(x.cmpSales))));
    const slots = D(d.last).getUTCDate();   // the whole month, the days to come left empty
    const W = 900, H = 200, L = 6, B = 26, top = 10, bw = Math.min(18, (W - 2 * L) / slots - 6);
    const xc = i => L + (i + 0.5) * (W - 2 * L) / slots, yv = v => top + (1 - v / max) * (H - top - B);
    const line = days.map((x, i) => x.cmpSales === null ? '' : `${i && days[i - 1].cmpSales !== null ? 'L' : 'M'}${xc(i).toFixed(1)},${yv(x.cmpSales).toFixed(1)}`).join(' ');
    const chart = `<div class="pf-chart"><div class="pf-legend"><span><i class="pf-k-s"></i>${esc(MON[Number(d.month.slice(5)) - 1])}</span><span><i class="sd-k-cmp"></i>Same weekday, 4 weeks before</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Sales per day against the same weekday four weeks before">
        <line class="pf-axis" x1="${L}" x2="${W - L}" y1="${H - B}" y2="${H - B}"/>
        ${days.map((x, i) => { const tp = yv(x.sales), h = Math.max(0, H - B - tp); return `<g><title>${DAY[D(x.day).getUTCDay()]} ${dmy(x.day)}: ${money(x.sales)}${x.today ? ' (so far)' : ''}${x.cmpSales !== null ? ` · ${DAY[D(x.cmpDay).getUTCDay()]} ${dmy(x.cmpDay)}: ${money(x.cmpSales)}` : ''}</title>
          ${h > 0 ? `<path class="pf-s ${x.today ? 'sd-today' : ''}" d="M${(xc(i) - bw / 2).toFixed(1)},${H - B} V${(tp + Math.min(3, h)).toFixed(1)} q0,-3 3,-3 h${(bw - 6).toFixed(1)} q3,0 3,3 V${H - B} Z"/>` : ''}
          <rect x="${(xc(i) - (W - 2 * L) / slots / 2).toFixed(1)}" y="${top}" width="${((W - 2 * L) / slots).toFixed(1)}" height="${H - top - B}" fill="transparent"/>
          ${D(x.day).getUTCDate() % 2 === 1 ? `<text x="${xc(i).toFixed(1)}" y="${H - 9}" text-anchor="middle" class="pf-lab">${D(x.day).getUTCDate()}</text>` : ''}</g>`; }).join('')}
        <path class="sd-cmp" d="${line}"/>
      </svg></div>`;
    const mtdCh = lmOk && lmTotal > 0 ? mtd / lmTotal - 1 : null;
    box.innerHTML = `
      <div class="pf-tiles">
        <div class="pf-tile"><span>Month to date</span><b>${money(mtd)}</b><small>${done.length ? `${dmy(d.first)} → ${dmy(lastDone)}` : 'no finished day yet'}</small></div>
        <div class="pf-tile"><span>Same dates last month</span><b>${lastDone ? money(lmTotal) : '—'}</b><small>${lastDone ? `${dmy(shiftMonths(d.first, 1))} → ${dmy(shiftMonths(lastDone, 1))}` : ''}</small></div>
        <div class="pf-tile"><span>Change</span><b class="${cls(mtdCh)}">${pct(mtdCh)}</b><small>${lastDone ? (mtd - lmTotal >= 0 ? '+' : '-') + money(Math.abs(mtd - lmTotal)) : ''}</small></div>
        <div class="pf-tile"><span>Per day</span><b>${money(avg)}</b><small>${best ? `best ${DAY[D(best.day).getUTCDay()]} ${dmy(best.day)}: ${money(best.sales)}` : ''}</small></div>
        ${td ? `<div class="pf-tile"><span>Today so far</span><b>${money(td.sales)}</b><small>${qty(td.qty)} units · not compared until the day ends</small></div>` : ''}
      </div>
      <div class="card">${chart}</div>
      <div class="card">
        <div class="pf-head"><h3>${esc(MON[Number(d.month.slice(5)) - 1])} ${esc(d.month.slice(0, 4))}, day by day</h3><span style="flex:1"></span>
          <button type="button" class="icon-btn" id="sdXls" title="Download (Excel)" aria-label="Download (Excel)">${xlsIcon}</button></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table"><thead><tr><th>Day</th><th class="num">Sales</th><th class="num">Units</th><th>Compared with</th><th class="num">Its sales</th><th class="num">Change</th></tr></thead>
          <tbody>${[...days].reverse().map(x => { const c = x.today || x.cmpSales === null ? null : chg(x.sales, x.cmpSales);
            return `<tr class="${x.today ? 'sd-row-today' : ''}"><td><b>${DAY[D(x.day).getUTCDay()]}</b> ${esc(dmy(x.day))}${x.today ? ' <span class="muted-note">so far</span>' : ''}</td><td class="num">${money(x.sales)}</td><td class="num">${qty(x.qty)}</td>
              <td class="muted-note">${DAY[D(x.cmpDay).getUTCDay()]} ${esc(dmy(x.cmpDay))}</td><td class="num">${x.cmpSales === null ? '—' : money(x.cmpSales)}</td>
              <td class="num">${x.today ? '<span class="muted-note">in progress</span>' : `<span class="${cls(c)}">${pct(c)}</span>`}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Sales in $ as the system reports them. Each day is compared with the same weekday four weeks before (a Saturday with a Saturday); the month to date with the same dates of last month. Today is not compared until it ends.</p>
      </div>`;
    el('sdXls').onclick = () => xls([['Day', 'Weekday', 'Sales ($)', 'Units', 'Compared with', 'Its sales ($)', 'Change %'],
      ...days.map(x => [dmy(x.day), DAY[D(x.day).getUTCDay()], Math.round(x.sales * 100) / 100, Math.round(x.qty), dmy(x.cmpDay), x.cmpSales === null ? '' : Math.round(x.cmpSales * 100) / 100, x.today || x.cmpSales === null || !(x.cmpSales > 0) ? '' : Math.round((x.sales / x.cmpSales - 1) * 1000) / 10]),
      [], ['Month to date', '', Math.round(mtd * 100) / 100, '', 'same dates last month', Math.round(lmTotal * 100) / 100, mtdCh === null ? '' : Math.round(mtdCh * 1000) / 10]],
      `Daily sales ${d.month}`);
  }

  /* ================= By hour (owner, 2026-10-12; migration 086) =================
     The system has no hours: lv-dashboard keeps today's running sales per section every 15 minutes (sales_snapshots).
     An hour's sales = the running total at its last snapshot - the running total at the last snapshot before it.
     Sales land in the hour the system received them (its sync), said under the chart. Compared with the same weekday
     one week before, when that day was measured. */
  const H = { day: null, sec: '', q: '' };
  const hourOf = iso => Number(new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false })) % 24;
  const hhmm = iso => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit' });
  // { hours: {h: {section: sales}}, names, total, last, snaps }
  function byHour(rows) {
    const snaps = [...new Set(rows.map(r => r.taken_at))].sort();
    const names = {}, cum = {}, hours = {};
    const at = new Map(); rows.forEach(r => { names[r.section] = r.section_desc || r.section; if (!at.has(r.taken_at)) at.set(r.taken_at, []); at.get(r.taken_at).push(r); });
    snaps.forEach(t => {
      const h = hourOf(t) < 2 ? 24 + hourOf(t) : hourOf(t);   // after midnight: the day's last sync, shown as 24, 25
      at.get(t).forEach(r => { const prev = n(cum[r.section]), v = n(r.sales); const d = v - prev; cum[r.section] = v;
        if (Math.abs(d) < 0.005) return; (hours[h] = hours[h] || {})[r.section] = n(hours[h]?.[r.section]) + d; });
    });
    return { hours, names, total: n(cum['*']), last: snaps[snaps.length - 1] || null, snaps: snaps.length };
  }
  async function readDay(day) {
    // the database gives 1000 rows per request at most (about 12 measures of 83 sections): read the day page by page
    // (owner, 2026-10-13: the hours stopped at 12:45 while the measures went on)
    const out = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await sb.from('sales_snapshots').select('taken_at, section, section_desc, sales').eq('day', day)
        .order('taken_at').order('section').range(from, from + 999);
      if (error) throw new Error(error.message);
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  function showHourly(box) {
    if (!box) return;
    if (!H.day) H.day = todayStr();
    if (!box.dataset.built) {
      box.dataset.built = '1';
      box.innerHTML = `
        <div class="card pf-controls">
          <button type="button" class="icon-btn" id="shPrev" title="Day before" aria-label="Day before"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <input type="date" id="shDay" aria-label="Day">
          <button type="button" class="icon-btn" id="shNext" title="Day after" aria-label="Day after"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
          <button type="button" class="icon-btn" id="shReload" title="Read again" aria-label="Read again"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
          <select id="shSec" aria-label="Section" style="width:auto;min-width:200px;"><option value="">Whole store</option></select>
        </div>
        <div id="shBody"></div>`;
      const go = k => { const d = addDays(H.day, k); if (d > todayStr()) return; H.day = d; loadHourly(); };
      el('shPrev').onclick = () => go(-1); el('shNext').onclick = () => go(1); el('shReload').onclick = () => loadHourly();
      el('shDay').onchange = () => { if (el('shDay').value && el('shDay').value <= todayStr()) { H.day = el('shDay').value; loadHourly(); } };
      el('shSec').onchange = () => { H.sec = el('shSec').value; paintHourly(); };
    }
    loadHourly();
  }
  async function loadHourly() {
    el('shDay').value = H.day; el('shDay').max = todayStr();
    el('shBody').innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the day’s measures…</p></div>';
    try {
      const [cur, prev] = await Promise.all([readDay(H.day), readDay(addDays(H.day, -7))]);
      H.data = { day: H.day, cur: byHour(cur), prev: prev.length ? byHour(prev) : null };
      paintHourly();
    } catch (e) { el('shBody').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(/sales_snapshots/.test(e.message) ? 'The hours are not set up yet (migration 086).' : e.message)}</p></div>`; }
  }
  function paintHourly() {
    const d = H.data, box = el('shBody'); if (!d || !box) return;
    const c = d.cur, sec = H.sec || '*';
    const opts = Object.entries(c.names).filter(([k]) => k !== '*').sort((a, b) => a[1].localeCompare(b[1]));
    el('shSec').innerHTML = '<option value="">Whole store</option>' + opts.map(([k, v]) => `<option value="${esc(k)}" ${k === H.sec ? 'selected' : ''}>${esc(v)}</option>`).join('');
    if (!c.snaps) { box.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">No measure for ${esc(dmy(d.day))}. The hours are measured from 12-10-2026 on (the system gives sales per day only): every 15 minutes from 07:00 to 00:45, whenever the system's sales change.</p></div>`; return; }
    const hs = Object.keys(c.hours).map(Number), ph = d.prev ? Object.keys(d.prev.hours).map(Number) : [];
    const lo = Math.min(7, ...hs, ...ph), hi = Math.max(22, ...hs, ...ph);
    const val = (src, h) => n(src?.hours[h]?.[sec]);
    const hours = []; for (let h = lo; h <= hi; h++) hours.push(h);
    const vals = hours.map(h => val(c, h)), pv = hours.map(h => d.prev ? val(d.prev, h) : null);
    const tot = vals.reduce((t, v) => t + v, 0), best = hours.reduce((b, h, i) => vals[i] > (b === null ? -1 : vals[hours.indexOf(b)]) ? h : b, null);
    const lab = h => String(h % 24).padStart(2, '0') + ':00';
    const max = Math.max(1, ...vals, ...pv.map(v => n(v)));
    const W = 900, Hh = 210, L = 6, B = 26, top = 12, slot = (W - 2 * L) / hours.length, bw = Math.min(26, slot - 8);
    const xc = i => L + (i + 0.5) * slot, yv = v => top + (1 - v / max) * (Hh - top - B);
    const line = d.prev ? pv.map((v, i) => `${i ? 'L' : 'M'}${xc(i).toFixed(1)},${yv(n(v)).toFixed(1)}`).join(' ') : '';
    const chart = `<div class="pf-chart"><div class="pf-legend"><span><i class="pf-k-s"></i>${esc(DAY[D(d.day).getUTCDay()])} ${esc(dmy(d.day))}</span>${d.prev ? `<span><i class="sd-k-cmp"></i>${esc(DAY[D(d.day).getUTCDay()])} a week before</span>` : ''}</div>
      <svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Sales per hour">
        <line class="pf-axis" x1="${L}" x2="${W - L}" y1="${Hh - B}" y2="${Hh - B}"/>
        ${hours.map((h, i) => { const v = vals[i], tp = yv(v), hgt = Math.max(0, Hh - B - tp); return `<g><title>${lab(h)}–${lab(h + 1)}: ${money(v)}${d.prev ? ` · a week before: ${money(pv[i])}` : ''}</title>
          ${hgt > 0 ? `<path class="pf-s" d="M${(xc(i) - bw / 2).toFixed(1)},${Hh - B} V${(tp + Math.min(3, hgt)).toFixed(1)} q0,-3 3,-3 h${(bw - 6).toFixed(1)} q3,0 3,3 V${Hh - B} Z"/>` : ''}
          <rect x="${(xc(i) - slot / 2).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${Hh - top - B}" fill="transparent"/>
          <text x="${xc(i).toFixed(1)}" y="${Hh - 9}" text-anchor="middle" class="pf-lab">${String(h % 24).padStart(2, '0')}</text></g>`; }).join('')}
        ${line ? `<path class="sd-cmp" d="${line}"/>` : ''}
      </svg></div>`;
    // sections x hours: the busiest sections, each cell shaded by its share of that section's day
    const secTotals = Object.entries(c.names).filter(([k]) => k !== '*').map(([k, name]) => ({ k, name, t: hours.reduce((t, h) => t + n(c.hours[h]?.[k]), 0) }))
      .filter(x => x.t > 0).sort((a, b) => b.t - a.t);
    const q = H.q.trim().toLowerCase(), shown = secTotals.filter(x => !q || x.name.toLowerCase().includes(q));
    const usedHours = hours.filter(h => Object.values(c.hours[h] || {}).some(v => Math.abs(v) > 0.005));
    const cell = (k, h, rowMax) => { const v = n(c.hours[h]?.[k]); if (Math.abs(v) < 0.5) return '<td class="num sh-cell"></td>'; const a = rowMax > 0 ? Math.max(0.06, Math.min(1, v / rowMax)) : 0;
      return `<td class="num sh-cell" style="--a:${a.toFixed(2)}" title="${esc(c.names[k])} ${lab(h)}–${lab(h + 1)}: ${money(v)}">${money(v)}</td>`; };
    box.innerHTML = `
      <div class="pf-tiles">
        <div class="pf-tile"><span>${sec === '*' ? 'Sales' : esc(c.names[sec] || sec)}</span><b>${money(tot)}</b><small>${esc(dmy(d.day))}${d.day === todayStr() ? ' · so far' : ''}</small></div>
        <div class="pf-tile"><span>Busiest hour</span><b>${best === null ? '—' : lab(best)}</b><small>${best === null ? '' : money(vals[hours.indexOf(best)])}</small></div>
        ${d.prev ? `<div class="pf-tile"><span>A week before</span><b>${money(pv.reduce((t, v) => t + n(v), 0))}</b><small>${esc(DAY[D(d.day).getUTCDay()])} ${esc(dmy(addDays(d.day, -7)))}</small></div>` : ''}
        <div class="pf-tile"><span>Last change seen</span><b>${c.last ? hhmm(c.last) : '—'}</b><small>${c.snaps} measure${c.snaps === 1 ? '' : 's'}</small></div>
      </div>
      <div class="card">${chart}<p class="muted-note" style="margin:6px 0 0;">The system gives sales per day only: they are measured here every 15 minutes, so an hour shows what reached the system in that hour.</p></div>
      ${sec === '*' ? `<div class="card">
        <div class="pf-head"><h3>Sections by hour</h3><input type="search" id="shQ" placeholder="Find a section" value="${esc(H.q)}" aria-label="Find a section"><span style="flex:1"></span>
          <button type="button" class="icon-btn" id="shXls" title="Download (Excel)" aria-label="Download (Excel)">${xlsIcon}</button></div>
        <div class="items-scroll pf-scroll"><table class="items pf-table sh-table"><thead><tr><th>Section</th><th class="num">Day</th>${usedHours.map(h => `<th class="num">${String(h % 24).padStart(2, '0')}h</th>`).join('')}</tr></thead>
          <tbody>${shown.map(x => { const rowMax = Math.max(...usedHours.map(h => n(c.hours[h]?.[x.k])));
            return `<tr data-sec="${esc(x.k)}" class="pf-row" title="Show ${esc(x.name)} hour by hour"><td><b>${esc(x.name)}</b></td><td class="num"><b>${money(x.t)}</b></td>${usedHours.map(h => cell(x.k, h, rowMax)).join('')}</tr>`; }).join('') || `<tr><td colspan="${usedHours.length + 2}" class="empty-note">No section.</td></tr>`}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Each cell is darker when it is a bigger part of that section's day. Click a section to see it hour by hour.</p></div>` : ''}`;
    if (el('shQ')) el('shQ').oninput = () => { H.q = el('shQ').value; const pos = el('shQ').selectionStart; paintHourly(); el('shQ').focus(); el('shQ').setSelectionRange(pos, pos); };
    box.querySelectorAll('tr[data-sec]').forEach(tr => tr.onclick = () => { H.sec = tr.dataset.sec; paintHourly(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    if (el('shXls')) el('shXls').onclick = () => xls([['Section', 'Day ($)', ...usedHours.map(h => lab(h))], ...shown.map(x => [x.name, Math.round(x.t * 100) / 100, ...usedHours.map(h => Math.round(n(c.hours[h]?.[x.k]) * 100) / 100)]),
      [], ['Whole store', Math.round(tot * 100) / 100, ...usedHours.map(h => Math.round(n(c.hours[h]?.['*']) * 100) / 100)]], `Sales by hour ${d.day}`);
  }

  window.SalesReports = { showCategories, showDaily, showHourly, _prevPeriod: prevPeriod, _byHour: byHour };
})();
