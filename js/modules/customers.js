/* ============================================================
   Customers (owner, 2026-10-27): the store's customers from the system (the dashboard's /customers/*).
   Find a customer by name or phone, then see their profile for a period: what they spent, how many invoices,
   their average basket, their first and last visit, a month-by-month graph of their invoices, the branches they
   shop at, the items they buy most, and their recent invoices. Double-click a result (or click it) to open the
   profile and its graph. Read only, live from the system (lv-dashboard customers_search / customer_profile).
   Store-wide "top customers" and "who stopped coming" need a ranked all-customers feed the system does not expose
   yet; this page covers per-customer lookup until that feed is available.
   Public API: window.Customers = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const S = { built: false, year: '', q: '', results: null, profile: null, loading: false, err: '' };
  const money = v => '$' + (Math.abs(Number(v) || 0) >= 1000 ? Math.round(Number(v)).toLocaleString('en-US') : (Math.round((Number(v) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  const daysAgo = d => d ? Math.round((Date.now() - new Date(d + 'T00:00:00').getTime()) / 864e5) : null;

  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error) { let msg = error.message; try { msg = (await error.context.json()).error || msg; } catch (e) { /* keep */ } throw new Error(msg); }
    if (!data || data.error) throw new Error(data?.error || 'The system did not answer.');
    return data;
  }
  function yearRange() {
    const y = S.year || todayStr().slice(0, 4);
    return [y + '-01-01', y === todayStr().slice(0, 4) ? todayStr() : y + '-12-31'];
  }

  function build() {
    const box = el('panel-customers'); if (!box || S.built) return;
    S.built = true;
    S.year = todayStr().slice(0, 4);
    const thisY = Number(todayStr().slice(0, 4));
    const years = [thisY, thisY - 1, thisY - 2];
    box.innerHTML = `
      <div class="card pc-bar">
        <div class="pc-inputrow">
          <input type="search" id="cuQ" inputmode="search" placeholder="Customer name or phone…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button type="button" class="btn" id="cuGo">Find</button>
          <select id="cuYear" class="btn secondary" title="Which year">${years.map(y => `<option value="${y}">${y}</option>`).join('')}</select>
        </div>
        <p class="muted-note" style="margin:6px 0 0;">Search a customer, then open them for the full picture and a graph of their invoices. Store-wide “top customers” and “who stopped coming” will come once the system gives a ranked list.</p>
      </div>
      <div id="cuBody"></div>`;
    el('cuGo').onclick = () => { S.q = el('cuQ').value.trim(); runSearch(); };
    el('cuQ').addEventListener('keydown', e => { if (e.key === 'Enter') { S.q = el('cuQ').value.trim(); runSearch(); } });
    el('cuYear').value = S.year;
    el('cuYear').onchange = () => { S.year = el('cuYear').value; if (S.profile) openCustomer(S.profile.code, S.profile.nameShown); };
    renderBody();
  }

  async function runSearch() {
    if (S.q.length < 2) { S.err = 'Type at least two letters.'; S.results = null; S.profile = null; return renderBody(); }
    S.loading = true; S.err = ''; S.profile = null; renderBody();
    try { const d = await call({ action: 'customers_search', q: S.q }); S.results = d.customers || []; }
    catch (e) { S.err = e.message || 'Could not search.'; S.results = null; }
    S.loading = false; renderBody();
  }
  async function openCustomer(code, name) {
    const [from, to] = yearRange();
    S.loading = true; S.err = ''; renderBody();
    try { const d = await call({ action: 'customer_profile', code, from, to }); d.nameShown = name || d.name || code; S.profile = d; }
    catch (e) { S.err = e.message || 'Could not open this customer.'; S.profile = null; }
    S.loading = false; renderBody();
  }

  // the monthly invoice graph — same inline-SVG idiom as Performance (bars per month, tooltip with the count)
  function chart(months) {
    if (!months || !months.length) return '<p class="muted-note" style="margin:0;">No invoices in this period.</p>';
    const max = Math.max(1, ...months.map(m => m.total));
    const W = Math.max(320, months.length * 70), H = 180, pad = 26, bw = 30, step = (W - 20) / months.length;
    const y = v => H - pad - (v / max) * (H - pad - 14);
    const bar = (x, v, label) => { const top = y(v), h = Math.max(0, H - pad - top); return h > 0 ? `<path class="pf-s" d="M${x},${H - pad} V${top + Math.min(4, h)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H - pad} Z"><title>${esc(label)}</title></path>` : ''; };
    return `<div class="pf-chart"><div class="pf-legend"><span><i class="pf-k-s"></i>Invoices per month</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" role="img" aria-label="Spending per month">
        <line x1="10" x2="${W - 10}" y1="${H - pad}" y2="${H - pad}" class="pf-axis"/>
        ${months.map((m, i) => { const cx = 10 + step * i + step / 2, lab = `${MON[Number(m.month.slice(5, 7)) - 1]} ${m.month.slice(2, 4)}`;
          return bar(cx - bw / 2, m.total, `${lab}: ${money(m.total)} · ${m.count} invoice${m.count === 1 ? '' : 's'}`)
            + `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="pf-lab">${lab}</text>`; }).join('')}
      </svg></div>`;
  }

  function tile(label, value, sub) { return `<div class="vs-tile"><span>${esc(label)}</span><b>${value}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`; }

  function profileHtml(p) {
    const gap = daysAgo(p.last);
    const churn = gap !== null && gap > 60 ? `<span class="badge danger" title="Last invoice ${esc(fmtDate(p.last))}">Not seen in ${gap} days</span>` : gap !== null && gap > 30 ? `<span class="badge warn">${gap} days since last visit</span>` : '';
    const invRows = (p.invoices || []).slice(0, 60).map(v => `<tr><td class="mono">${esc(v.day)}</td><td class="mono">${esc(v.invoice)}</td><td>${esc(v.branch)}</td><td class="num">${esc(money(v.total))}</td></tr>`).join('');
    return `
      <div class="card">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
          <h3 style="margin:0;">${esc(p.nameShown || p.code)}</h3><span class="muted-note mono">#${esc(p.code)}</span>${churn}
          <button type="button" class="btn ghost small" id="cuBack" style="margin-left:auto;">← Back to results</button>
        </div>
        <div class="vs-tiles" style="margin-top:10px;">
          ${tile('Spent', money(p.total), p.from.slice(0, 4))}
          ${tile('Invoices', (p.invoiceCount || 0).toLocaleString('en-US'))}
          ${tile('Average basket', money(p.avgBasket))}
          ${tile('First visit', p.first ? esc(fmtDate(p.first)) : '—')}
          ${tile('Last visit', p.last ? esc(fmtDate(p.last)) : '—', gap !== null ? gap + ' days ago' : '')}
        </div>
      </div>
      <div class="card"><h3 style="margin:0 0 8px;">Invoices over the year</h3>${chart(p.months)}</div>
      ${(p.branches && p.branches.length > 1) ? `<div class="card"><h3 style="margin:0 0 8px;">By branch</h3><ul class="db-list">${p.branches.map(b => `<li><span>${esc(b.branch)}</span><b>${esc(money(b.total))} · ${b.count}</b></li>`).join('')}</ul></div>` : ''}
      ${(p.topItems && p.topItems.length) ? `<div class="card"><h3 style="margin:0 0 8px;">Buys most</h3><ul class="db-list">${p.topItems.map(it => `<li><span>${esc(it.description || it.code)}</span><b>${esc(money(it.value))}</b></li>`).join('')}</ul></div>` : ''}
      ${invRows ? `<div class="card"><h3 style="margin:0 0 8px;">Recent invoices</h3><div class="items-scroll pf-scroll"><table class="items pf-table"><thead><tr><th>Date</th><th>Invoice</th><th>Branch</th><th class="num">Total</th></tr></thead><tbody>${invRows}</tbody></table></div></div>` : ''}`;
  }

  function renderBody() {
    const body = el('cuBody'); if (!body) return;
    if (S.loading) { body.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the system…</p></div>'; return; }
    if (S.err) { body.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;color:var(--danger,#c0392b);">${esc(S.err)}</p></div>`; return; }
    if (S.profile) { body.innerHTML = profileHtml(S.profile); el('cuBack').onclick = () => { S.profile = null; renderBody(); }; return; }
    if (S.results) {
      if (!S.results.length) { body.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">No customer matched. Try a phone number or a different spelling.</p></div>'; return; }
      body.innerHTML = `<div class="card"><h3 style="margin:0 0 8px;">${S.results.length} match${S.results.length === 1 ? '' : 'es'}</h3>
        <ul class="cu-results db-list">${S.results.map(c => `<li class="cu-row" data-code="${esc(c.code)}" data-name="${esc(c.name)}" style="cursor:pointer;" title="Open ${esc(c.name)}"><span>${esc(c.name || c.code)}${c.tel ? ` <span class="muted-note">${esc(c.tel)}</span>` : ''}</span><b class="mono">#${esc(c.code)}</b></li>`).join('')}</ul>
        <p class="muted-note" style="margin:8px 0 0;">Click a customer to open their profile and invoice graph.</p></div>`;
      body.querySelectorAll('.cu-row').forEach(r => {
        const open = () => openCustomer(r.dataset.code, r.dataset.name);
        r.addEventListener('click', open); r.addEventListener('dblclick', open);
      });
      return;
    }
    body.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Search a customer by name or phone to begin.</p></div>';
  }

  function show() { build(); el('cuQ')?.focus(); }
  window.Customers = { show };
})();
