/* ============================================================
   Promotions › Results (owner, 2026-10-06): how a promotion did, from its
   first day to its last (or to today while it runs), against the same
   number of days just before it started. Live from the system (server
   function lv-dashboard, action sales_compare): units and sales per item.
   Per item: units and sales during / before, the change, units per day,
   stock now (Items from the system). For the whole promotion: totals,
   the change, items that sold more, the same, less, or nothing.
   Excel export. Read only.
   Public API: window.PromoResults = { render(container, promo, rows) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const cache = new Map();   // promo id + dates -> { at, data }
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const money = v => '$' + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qty = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US');
  const pct = (a, b) => b > 0 ? Math.round((a - b) / b * 100) : a > 0 ? null : 0;   // null = new sales (nothing before)
  const pctHtml = p => p === null ? '<span class="pr-up">new</span>' : p === 0 ? '<span class="muted-note">0%</span>' : `<span class="${p > 0 ? 'pr-up' : 'pr-down'}">${p > 0 ? '+' : ''}${p}%</span>`;
  const day = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const addDays = (s, k) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA'); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5) + 1;

  // The periods: during = from .. min(to, today); before = the same number of days, ending the day before the start.
  function periodsOf(promo) {
    const t = todayStr();
    if (!promo.from) return null;
    const from = promo.from, to = promo.to && promo.to < t ? promo.to : t;
    if (from > t) return { future: true, from, to: promo.to || from };
    const len = daysBetween(from, to);
    return { from, to, len, running: !promo.to || promo.to >= t, baseTo: addDays(from, -1), baseFrom: addDays(from, -len) };
  }

  async function render(box, promo, rows) {
    const P = periodsOf(promo);
    if (!P) { box.innerHTML = '<div class="card"><p style="margin:0;">Set the promotion\'s <b>From</b> date to see its results.</p></div>'; return; }
    if (P.future) { box.innerHTML = `<div class="card"><p style="margin:0;">This promotion starts on <b>${esc(day(P.from))}</b>: its results show from then.</p></div>`; return; }
    // one line per code (a code twice in the table counts once)
    const items = [], seen = new Set();
    rows.forEach(r => { const c = String(r.code || '').trim(); if (!c || seen.has(c.toUpperCase())) return; seen.add(c.toUpperCase()); items.push(r); });
    if (!items.length) { box.innerHTML = '<div class="card"><p style="margin:0;">No item codes in this promotion yet.</p></div>'; return; }
    const k = `${promo.id}|${P.from}|${P.to}|${items.length}`;
    let hit = cache.get(k);
    if (!hit || Date.now() - hit.at > 15 * 60e3) {
      box.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">Reading the sales of ${items.length} item${items.length === 1 ? '' : 's'} from the system…</p></div>`;
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'sales_compare', codes: items.map(r => String(r.code).trim()),
          from: P.from, to: P.to, baseFrom: P.baseFrom, baseTo: P.baseTo } });
        if (error || !data?.items) throw error || new Error('no answer');
        hit = { at: Date.now(), data: data.items }; cache.set(k, hit);
      } catch (e) {
        console.warn('results', e);
        if (box.isConnected) box.innerHTML = '<div class="card"><p class="login-err" style="margin:0;">The system did not answer. Check the "Link to the system" card on the Dashboard, then try again.</p></div>';
        return;
      }
    }
    if (!box.isConnected) return;
    draw(box, promo, P, items, hit);
  }

  function draw(box, promo, P, items, hit) {
    const list = items.map(r => {
      const s = hit.data[String(r.code).trim()] || { during: { qty: 0, sales: 0 }, before: { qty: 0, sales: 0 } };
      const live = typeof catalogMap !== 'undefined' ? catalogMap.get(normalizeCatalogCode(r.code)) : null;
      return { code: String(r.code).trim(), desc: r.description || live?.description || '', supplier: r.supplier || live?.supplier || '',
        promoPrice: r.promoPrice, beforePrice: r.beforePrice ?? r.salePrice, stock: live?.balance ?? r.balance ?? null,
        dq: n(s.during.qty), ds: n(s.during.sales), bq: n(s.before.qty), bs: n(s.before.sales) };
    }).map(x => ({ ...x, p: pct(x.dq, x.bq) }));
    const T = list.reduce((t, x) => ({ dq: t.dq + x.dq, ds: t.ds + x.ds, bq: t.bq + x.bq, bs: t.bs + x.bs }), { dq: 0, ds: 0, bq: 0, bs: 0 });
    const more = list.filter(x => x.dq > x.bq), same = list.filter(x => x.dq === x.bq && x.dq > 0), less = list.filter(x => x.dq < x.bq && x.dq > 0), none = list.filter(x => x.dq === 0);
    const sort = box.dataset.sort || 'change';
    const sorted = list.slice().sort(sort === 'units' ? (a, b) => b.dq - a.dq : sort === 'sales' ? (a, b) => b.ds - a.ds
      : (a, b) => (b.p === null ? 1e9 : b.p) - (a.p === null ? 1e9 : a.p) || b.dq - a.dq);
    box.innerHTML = `
      <div class="card pr-head">
        <div><b>${esc(day(P.from))} → ${esc(day(P.to))}</b> <span class="muted-note">· ${P.len} day${P.len === 1 ? '' : 's'}${P.running ? ' so far (running)' : ''}</span><br>
          <span class="muted-note">compared with ${esc(day(P.baseFrom))} → ${esc(day(P.baseTo))}, the ${P.len} day${P.len === 1 ? '' : 's'} before it started · Ajaltoun · live from the system</span></div>
        <button type="button" class="icon-btn pr-ib" id="prExport" title="Export (Excel)" aria-label="Export (Excel)"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></button>
        <button type="button" class="icon-btn pr-ib" id="prRefresh" title="Read the sales again" aria-label="Read the sales again"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg></button>
      </div>
      <div class="pr-stats">
        <div><b>${qty(T.dq)}</b><span>units sold · before ${qty(T.bq)}</span>${pctHtml(pct(T.dq, T.bq))}</div>
        <div><b>${money(T.ds)}</b><span>sales · before ${money(T.bs)}</span>${pctHtml(pct(T.ds, T.bs))}</div>
        <div><b>${qty(T.dq / P.len)}</b><span>units per day · before ${qty(T.bq / P.len)}</span></div>
        <div class="pr-mix"><span class="pr-up"><b>${more.length}</b> sold more</span><span><b>${same.length}</b> the same</span><span class="pr-down"><b>${less.length}</b> sold less</span><span class="pr-zero"><b>${none.length}</b> sold nothing</span></div>
      </div>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items pr-table">
        <thead><tr><th>Code</th><th>Description</th><th class="num" title="As entered in the promotion">Promo price</th>
          <th class="num pr-sort ${sort === 'units' ? 'on' : ''}" data-sort="units">Units during</th><th class="num">Before</th>
          <th class="num pr-sort ${sort === 'change' ? 'on' : ''}" data-sort="change">Change</th>
          <th class="num pr-sort ${sort === 'sales' ? 'on' : ''}" data-sort="sales">Sales during</th><th class="num">Before</th><th class="num">Per day</th><th class="num">Stock now</th></tr></thead>
        <tbody>${sorted.map(x => `<tr class="${x.dq === 0 ? 'pr-row-zero' : ''}">
          <td class="mono">${esc(x.code)}</td><td>${esc(x.desc)}${x.supplier ? `<div class="pr-sup">${esc(x.supplier)}</div>` : ''}</td>
          <td class="num">${x.promoPrice !== null && x.promoPrice !== undefined && x.promoPrice !== '' ? (Math.round(n(x.promoPrice) * 100) / 100).toLocaleString('en-US') : ''}</td>
          <td class="num"><b>${qty(x.dq)}</b></td><td class="num">${qty(x.bq)}</td><td class="num">${pctHtml(x.p)}</td>
          <td class="num">${money(x.ds)}</td><td class="num">${money(x.bs)}</td><td class="num">${qty(x.dq / P.len)}</td>
          <td class="num">${x.stock === null || x.stock === undefined ? '' : n(x.stock) <= 0 ? '<span class="rc-zero">0</span>' : qty(x.stock)}</td></tr>`).join('')}</tbody>
      </table></div></div>
      <p class="muted-note" style="margin:8px 0 0;">Before = the same number of days just before the start. Click a column title to sort. Stock now comes from the system (Items from the system).</p>`;
    box.querySelectorAll('[data-sort]').forEach(th => th.onclick = () => { box.dataset.sort = th.dataset.sort; draw(box, promo, P, items, hit); });
    box.querySelector('#prRefresh').onclick = () => { cache.clear(); render(box, promo, items); };
    box.querySelector('#prExport').onclick = () => {
      const aoa = [[`${promo.name} — results ${P.from} to ${P.to} (before: ${P.baseFrom} to ${P.baseTo})`], [],
        ['Code', 'Description', 'Supplier', 'Promo price', 'Units during', 'Units before', 'Change %', 'Sales during', 'Sales before', 'Units per day', 'Stock now']];
      sorted.forEach(x => aoa.push([x.code, x.desc, x.supplier, x.promoPrice ?? '', x.dq, x.bq, x.p === null ? 'new' : x.p, Math.round(x.ds * 100) / 100, Math.round(x.bs * 100) / 100, Math.round(x.dq / P.len * 100) / 100, x.stock ?? '']));
      aoa.push([], ['Total', '', '', '', T.dq, T.bq, pct(T.dq, T.bq) ?? 'new', Math.round(T.ds * 100) / 100, Math.round(T.bs * 100) / 100, Math.round(T.dq / P.len * 100) / 100, '']);
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 10 }, { wch: 44 }, { wch: 24 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Results');
      XLSX.writeFile(wb, `${(promo.name || 'promotion').replace(/[^\w-]+/g, '-')}-results.xlsx`);
      logActivity('promotions', 'results_export', { type: 'promotion', id: promo.id }, `Exported the results of ${promo.name}`);
    };
  }

  window.PromoResults = { render };
})();
