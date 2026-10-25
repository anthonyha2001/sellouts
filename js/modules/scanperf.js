/* ============================================================
   Performance by scan (owner, 2026-10-25): scan (or type) an item and see how it performs — not its price (that is
   Price check), but its SALES and where it stands in its category:
     · how much it sells in the period (units and $), against the same period just before;
     · its share of its GROUP and its rank among the group's items (the group = the category);
     · its BRAND's share and rank inside that group, with the group's brands ranked;
     · the group's share of its SECTION.
   Live from the system (lv-dashboard scan_perf — the sales reports of Ajaltoun). Read only.
   Permission: vendors.manage. Public API: window.ScanPerf = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { built: false, busy: false, days: 90, item: null, data: null, choices: null, msg: '', code: '' };

  // the sales reports are in $; show whole dollars, with cents under $100
  const usd = v => { const x = Number(v); if (!Number.isFinite(x)) return '—'; return '$' + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString('en-US') : (Math.round(x * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })); };
  const qty = v => { const x = Number(v); if (!Number.isFinite(x)) return '—'; return (Math.round(x * 100) / 100).toLocaleString('en-US'); };
  const pct = v => v === null || v === undefined ? '—' : (Math.round(Number(v) * 1000) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%';
  const nth = n => n === null || n === undefined ? '—' : '#' + n;

  const DAYS = [['30 days', 30], ['90 days', 90], ['This year', 'ytd']];
  function range() {
    const today = todayStr();
    if (S.days === 'ytd') return [today.slice(0, 4) + '-01-01', today];
    return [addDaysStr(today, -(Number(S.days) - 1)), today];
  }

  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
    return data;
  }

  function build() {
    const box = el('panel-scanperf'); if (!box || S.built) return;
    S.built = true;
    box.innerHTML = `
      <div class="card pc-bar">
        <div class="pc-inputrow">
          <input type="search" id="spQ" inputmode="search" placeholder="Barcode, item code or name…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button type="button" class="btn" id="spGo">See</button>
          <button type="button" class="btn secondary" id="spScan">Scan</button>
        </div>
        <div class="filter-row sp-days" id="spDays" style="margin:8px 0 0;">${DAYS.map(([l, v]) => `<button type="button" data-d="${v}" class="${v === S.days ? 'active' : ''}">${l}</button>`).join('')}</div>
        <p class="muted-note" style="margin:6px 0 0;">Scan an item to see how much it sells and where it ranks in its category.</p>
      </div>
      <div id="spBody"></div>`;
    el('spGo').onclick = () => resolve(el('spQ').value);
    el('spQ').addEventListener('keydown', e => { if (e.key === 'Enter') resolve(el('spQ').value); });
    el('spScan').onclick = () => {
      let stop = null;
      stop = Scanner.open({ title: 'Scan an item to see its performance', continuous: false, onCode: code => { setTimeout(() => stop && stop(), 0); el('spQ').value = code; resolve(code); } });
    };
    el('spDays').addEventListener('click', e => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      S.days = b.dataset.d === 'ytd' ? 'ytd' : Number(b.dataset.d);
      el('spDays').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      if (S.code) load(S.code);   // re-run for the new period
    });
    box.addEventListener('click', e => {
      const t = e.target.closest('[data-sp]'); if (!t) return;
      if (t.dataset.sp === 'pick') resolve(t.dataset.code, true);
      if (t.dataset.sp === 'scan') el('spScan').click();
    });
  }

  // resolve what was typed / scanned to one item code (a name may need a choice), then load its performance
  async function resolve(raw, byCode) {
    const q = String(raw || '').trim(); if (!q || S.busy) return;
    S.busy = true; S.msg = ''; S.choices = null; S.data = null; paint('Looking up the item…');
    try {
      let code = q;
      const looksCode = /^[\d\s.-]{5,}$/.test(q) || /^[A-Za-z]{0,3}\d{3,}$/.test(q);
      if (!byCode && !looksCode) {
        const r = await call({ action: 'item_search', search: q });
        const items = r.items || [];
        if (!items.length) { S.msg = `Nothing found for "${q}".`; S.busy = false; return paint(); }
        if (items.length > 1) { S.choices = items.slice(0, 10); S.busy = false; return paint(); }
        code = items[0].code;
      } else if (!byCode) {
        // a barcode or a code: turn a barcode into the item code
        const r = await call({ action: 'items_lookup', tokens: [q] });
        const it = r.items && r.items[q];
        if (it && it.code) code = it.code;
      }
      S.busy = false;
      await load(code);
    } catch (e) { S.msg = e.message; S.busy = false; paint(); }
  }

  async function load(code) {
    if (S.busy) return;
    S.busy = true; S.msg = ''; S.choices = null; S.code = code; paint('Reading the sales…');
    try {
      const [from, to] = range();
      const d = await call({ action: 'scan_perf', code, from, to });
      if (!d.found) { S.data = null; S.msg = `Not found in the system’s sales: ${code}`; }
      else { S.data = d; }
    } catch (e) { S.data = null; S.msg = e.message; }
    S.busy = false;
    paint();
  }

  // a share bar (the item / brand / group filled against the category)
  const bar = (frac, cls) => `<div class="sp-bar"><i class="${cls || ''}" style="width:${Math.max(1.5, Math.min(100, (Number(frac) || 0) * 100))}%"></i></div>`;
  function growth(now, before) {
    if (!(Number(before) > 0)) return Number(now) > 0 ? '<span class="sp-up">new</span>' : '';
    const g = Number(now) / Number(before) - 1;
    const cls = g > 0.02 ? 'sp-up' : g < -0.02 ? 'sp-down' : 'sp-flat';
    return `<span class="${cls}">${g > 0 ? '▲' : g < 0 ? '▼' : '='} ${Math.abs(Math.round(g * 100))}%</span>`;
  }

  function paint(loading) {
    build();
    const body = el('spBody'); if (!body) return;
    if (loading) { body.innerHTML = `<div class="card"><p class="muted-note vs-loading" style="margin:0;">${esc(loading)}</p></div>`; return; }
    if (S.choices) {
      body.innerHTML = `<div class="card"><h4 style="margin:0 0 8px;">Which one?</h4><div class="pc-choices">${S.choices.map(c => `<button type="button" class="pc-choice" data-sp="pick" data-code="${esc(c.code)}"><b>${esc(c.description || c.code)}</b><span class="muted-note">${esc(c.size || '')} · ${esc(c.code)}${c.barcodes && c.barcodes[0] ? ' · ' + esc(c.barcodes[0]) : ''}</span></button>`).join('')}</div></div>`;
      return;
    }
    if (S.msg) { body.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(S.msg)}</p></div>`; return; }
    const d = S.data; if (!d) { body.innerHTML = ''; return; }
    const it = d.item, g = d.group, br = d.brand, sc = d.section;
    const path = [it.department, it.section, it.group, it.subgroup].filter(Boolean).map(esc).join(' <span class="sp-sep">›</span> ');
    const sold = Number(d.qty) > 0 || Number(d.sales) > 0;
    body.innerHTML = `
      <div class="card sp-head">
        <h3>${esc(it.description || d.code)}</h3>
        <div class="sp-chips">${it.brand ? `<span class="sp-chip sp-brandchip">${esc(it.brand)}</span>` : ''}<span class="muted-note mono">${esc(d.code)}</span></div>
        <div class="sp-path">${path || '<span class="muted-note">Not classified</span>'}</div>
      </div>
      ${!sold ? '<div class="card"><p class="muted-note" style="margin:0;">No sales in this period — the figures below are for its category.</p></div>' : ''}
      <div class="pf-tiles sp-tiles">
        <div class="pf-tile"><span>Units sold</span><b>${qty(d.qty)}</b><small>${growth(d.qty, d.prevQty)} · ${qty(d.prevQty)} before</small></div>
        <div class="pf-tile"><span>Sales</span><b>${usd(d.sales)}</b><small>${growth(d.sales, d.prevSales)} · ${usd(d.prevSales)} before</small></div>
        <div class="pf-tile"><span>Share of ${esc(it.group || 'group')}</span><b>${pct(g.share)}</b><small>rank ${nth(g.rank)} of ${g.itemCount} items</small></div>
      </div>

      <div class="card sp-block">
        <div class="sp-blockhead"><h4>Its place in ${esc(it.group || 'the group')}</h4><span class="muted-note">${usd(g.sales)} sold in this group · ${g.itemCount} items</span></div>
        <div class="sp-rankrow">
          <div><span class="muted-note">This item</span><div class="sp-big">${pct(g.share)}</div>${bar(g.share, 'me')}</div>
          <div><span class="muted-note">Rank</span><div class="sp-big">${nth(g.rank)}<small> of ${g.itemCount}</small></div></div>
        </div>
        <div class="sp-top">
          <div class="sp-toptitle">Top sellers in this group</div>
          ${g.topItems.map((x, i) => `<div class="sp-toprow ${x.me ? 'me' : ''}"><span class="sp-rk">${i + 1}</span><span class="sp-nm">${esc(x.name || x.code)}${x.me ? ' <span class="sp-youtag">this item</span>' : ''}</span><span class="sp-sh">${pct(x.share)}</span><span class="sp-val">${usd(x.sales)}</span></div>`).join('') || '<p class="muted-note" style="margin:0;">No items.</p>'}
        </div>
      </div>

      <div class="card sp-block">
        <div class="sp-blockhead"><h4>${esc(br.name || 'This brand')} in ${esc(it.group || 'the group')}</h4><span class="muted-note">${br.count} brand${br.count === 1 ? '' : 's'} in this group</span></div>
        ${br.name ? `<div class="sp-rankrow">
          <div><span class="muted-note">Brand share</span><div class="sp-big">${pct(br.share)}</div>${bar(br.share, 'brand')}</div>
          <div><span class="muted-note">Brand rank</span><div class="sp-big">${nth(br.rank)}<small> of ${br.count}</small></div></div>
          <div><span class="muted-note">Brand sales</span><div class="sp-big">${usd(br.sales)}</div></div>
        </div>` : '<p class="muted-note" style="margin:0;">This item has no brand set in the system.</p>'}
        <div class="sp-top">
          <div class="sp-toptitle">Brands in this group</div>
          ${br.top.map((x, i) => `<div class="sp-toprow ${x.me ? 'me' : ''}"><span class="sp-rk">${i + 1}</span><span class="sp-nm">${esc(x.name || '—')}${x.me ? ' <span class="sp-youtag">this brand</span>' : ''}</span><span class="sp-sh">${pct(x.share)}</span><span class="sp-val">${usd(x.sales)}</span></div>`).join('') || '<p class="muted-note" style="margin:0;">No brands.</p>'}
        </div>
      </div>

      <div class="card sp-block">
        <div class="sp-blockhead"><h4>${esc(it.group || 'The group')} in ${esc(it.section || 'its section')}</h4><span class="muted-note">${usd(sc.sales)} sold in this section · ${sc.groupCount} groups</span></div>
        <div class="sp-rankrow">
          <div><span class="muted-note">Group share</span><div class="sp-big">${pct(sc.groupShare)}</div>${bar(sc.groupShare, 'group')}</div>
          <div><span class="muted-note">Group rank</span><div class="sp-big">${nth(sc.groupRank)}<small> of ${sc.groupCount}</small></div></div>
        </div>
      </div>
      <p class="muted-note sp-foot">${esc(dmyRange(d.from, d.to))} · against ${esc(dmyRange(d.prevFrom, d.prevTo))} · Ajaltoun, from the system.</p>`;
  }
  const dmyRange = (a, b) => (typeof fmtDate === 'function' ? fmtDate(a) + ' → ' + fmtDate(b) : a + ' → ' + b);

  function show() { build(); paint(); setTimeout(() => el('spQ')?.focus(), 50); }
  window.ScanPerf = { show };
})();
