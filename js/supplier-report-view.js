/* ============================================================
   The monthly supplier report, as the supplier sees it (owner, 2026-10-12; migration 091).
   Shared by the app (vendor sheet › Supplier report) and report.html (the private link, no sign-in).
   No cost, no margin: sales and units against the month before, the best items, what did not sell,
   the sell-outs, the rented spots. Plain functions, no app helpers.
   Public API: window.SupplierReportView = { html(report) }.
   ============================================================ */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const usd = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const units = v => Math.round(n(v)).toLocaleString('en-US');
  const ch = (a, b) => n(b) > 0 ? n(a) / n(b) - 1 : null;
  const pct = v => v === null ? '—' : (v > 0 ? '+' : '') + (Math.round(v * 1000) / 10).toLocaleString('en-US') + '%';
  const cls = v => v === null ? '' : v < 0 ? 'sr-down' : 'sr-up';
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const monthName = s => MON[Number(String(s).slice(5, 7)) - 1] + ' ' + String(s).slice(0, 4);

  function html(rep) {
    const d = rep.data || {}, month = rep.month || d.from;
    const c = ch(d.sales, d.prevSales), cu = ch(d.qty, d.prevQty);
    const items = d.items || [], top = items.slice(0, 15);
    const movers = items.filter(x => n(x.prevSales) > 0).map(x => ({ ...x, c: ch(x.sales, x.prevSales) }));
    const up = movers.filter(x => x.c > 0.15 && n(x.sales) >= 20).sort((a, b) => (b.sales - b.prevSales) - (a.sales - a.prevSales)).slice(0, 5);
    const down = movers.filter(x => x.c < -0.15 && n(x.prevSales) >= 20).sort((a, b) => (a.sales - a.prevSales) - (b.sales - b.prevSales)).slice(0, 5);
    const row = x => `<tr><td>${esc(x.name || x.code)}</td><td class="sr-n">${units(x.qty)}</td><td class="sr-n">${usd(x.sales)}</td><td class="sr-n ${cls(ch(x.sales, x.prevSales))}">${n(x.prevSales) > 0 ? pct(ch(x.sales, x.prevSales)) : '<span class="sr-mute">new</span>'}</td></tr>`;
    const so = d.sellouts || [], spots = d.spots || [];
    return `<div class="sr">
      <header class="sr-head"><div><div class="sr-brand">La Valeur · Ajaltoun</div><h1>${esc(rep.vendor_name || d.vendor || '')}</h1><div class="sr-sub">Monthly report · ${esc(monthName(month))}${d.to && d.to < d.from.slice(0, 8) + '31' && String(d.to).slice(0, 7) === String(d.from).slice(0, 7) && new Date(d.to + 'T00:00:00Z').getUTCDate() < new Date(Date.UTC(Number(d.from.slice(0, 4)), Number(d.from.slice(5, 7)), 0)).getUTCDate() ? ` (to ${esc(dmy(d.to))})` : ''}</div></div></header>
      <section class="sr-tiles">
        <div class="sr-tile"><span>Sales</span><b>${usd(d.sales)}</b><small class="${cls(c)}">${pct(c)} against ${esc(MON[Number(String(d.prevFrom).slice(5, 7)) - 1])}</small></div>
        <div class="sr-tile"><span>Units sold</span><b>${units(d.qty)}</b><small class="${cls(cu)}">${pct(cu)}</small></div>
        <div class="sr-tile"><span>Items sold</span><b>${items.filter(x => n(x.qty) > 0).length}</b><small>${(d.notSold || []).length} not sold this month</small></div>
      </section>
      <section><h2>Best items</h2><table class="sr-t"><thead><tr><th>Item</th><th class="sr-n">Units</th><th class="sr-n">Sales</th><th class="sr-n">vs ${esc(MON[Number(String(d.prevFrom).slice(5, 7)) - 1])}</th></tr></thead><tbody>${top.map(row).join('') || '<tr><td colspan="4" class="sr-mute">No sale this month.</td></tr>'}</tbody></table></section>
      ${up.length || down.length ? `<section class="sr-two">${up.length ? `<div><h2>Growing</h2><table class="sr-t"><tbody>${up.map(row).join('')}</tbody></table></div>` : ''}${down.length ? `<div><h2>Falling</h2><table class="sr-t"><tbody>${down.map(row).join('')}</tbody></table></div>` : ''}</section>` : ''}
      ${(d.notSold || []).length ? `<section><h2>Not sold this month</h2><p class="sr-mute">Delivered in the last months, no sale in ${esc(MON[Number(String(month).slice(5, 7)) - 1])}: worth a promotion, a better place on the shelf, or taking back.</p><ul class="sr-list">${d.notSold.map(x => `<li>${esc(x.name || x.code)}</li>`).join('')}</ul></section>` : ''}
      ${so.length ? `<section><h2>Sell-outs</h2><table class="sr-t"><thead><tr><th>Sell-out</th><th>Dates</th><th class="sr-n">Items</th><th class="sr-n">Units sold this month</th></tr></thead><tbody>${so.map(x => `<tr><td>${esc(x.name)}</td><td>${esc(dmy(x.from))} → ${esc(dmy(x.to))}</td><td class="sr-n">${n(x.items)}</td><td class="sr-n">${units(x.units)}</td></tr>`).join('')}</tbody></table></section>` : ''}
      ${spots.length ? `<section><h2>Your spots in the store</h2><table class="sr-t"><thead><tr><th>Spot</th><th>From</th><th>To</th></tr></thead><tbody>${spots.map(x => `<tr><td>${esc(x.what)}</td><td>${esc(dmy(x.from))}</td><td>${esc(dmy(x.to))}</td></tr>`).join('')}</tbody></table></section>` : ''}
      <footer class="sr-foot">Sales at the shelf price, as our system records them. Made on ${esc(dmy(String(rep.created_at || '').slice(0, 10)))}.</footer>
    </div>`;
  }
  window.SupplierReportView = { html };
})();
