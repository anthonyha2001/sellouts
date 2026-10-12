/* ============================================================
   Pricing › Promotion ideas (owner, 2026-10-12; migration 092).
   The items worth putting on promotion (lv-dashboard promo_ideas, kept as last made): expiring within 30 days, stopped
   selling, overstocked, bought far above the usual - ranked by the money in stock, each with a suggested price that keeps a
   margin (editable here). Tick items and create a promotion with them in one step (Promotions page).
   Doubtful ones say so (months of stock: check the count first; sells below its cost now).
   Permission: vendors.manage (creating the promotion: promotions.edit). Public API: window.PromoIdeas = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const el = id => document.getElementById(id);
  const usd = v => '$' + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd0 = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const REASON = { expiring: 'Expiring', stopped: 'Stopped selling', overstock: 'Overstock', big: 'Big purchase' };
  const S = { data: null, busy: false, reason: '', sup: '', q: '', sel: new Set(), price: {}, box: null };
  const ICON_REDO = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  const uid = () => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

  async function show(box) {
    if (!box) return; S.box = box;
    if (!S.data) {
      box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the ideas…</p></div>';
      const { data, error } = await sb.from('promo_ideas').select('data, made_at').eq('id', 1).maybeSingle();
      if (error) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(/promo_ideas/.test(error.message) ? 'Promotion ideas are not set up yet (migration 092).' : error.message)}</p></div>`; return; }
      S.data = data ? data.data : null;
      if (!S.data) return make();
    }
    paint();
  }
  async function make() {
    if (S.busy) return; S.busy = true; paint();
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'promo_ideas' } });
      if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
      S.data = data; S.sel.clear(); S.price = {};
    } catch (e) { showToast(e.message, true); }
    finally { S.busy = false; paint(); }
  }
  const priceOf = x => S.price[x.code] !== undefined ? S.price[x.code] : x.suggested;
  const shown = () => (S.data?.items || []).filter(x => (!S.reason || x.reasons.includes(S.reason)) && (!S.sup || x.sup === S.sup)
    && (!S.q.trim() || [x.desc, x.code, x.sup].some(v => String(v || '').toLowerCase().includes(S.q.trim().toLowerCase()))));
  function paint() {
    const box = S.box; if (!box) return;
    if (!S.data) { box.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">${S.busy ? 'Reading the stock, the sales and the prices from the system (about a minute)…' : 'No ideas yet.'}</p></div>`; return; }
    const a = document.activeElement, typing = a && a.id === 'piQ', pos = typing ? a.selectionStart : 0;
    const all = S.data.items || [], list = shown();
    const cnt = r => all.filter(x => x.reasons.includes(r)).length;
    const sups = [...new Set(all.map(x => x.sup).filter(Boolean))].sort();
    const selList = all.filter(x => S.sel.has(x.code));
    box.innerHTML = `<div class="card pi-bar">
        <div class="filter-row" style="margin:0;"><button type="button" data-pr="" class="${!S.reason ? 'active' : ''}">All <span class="ex-n">${all.length}</span></button>${Object.entries(REASON).map(([k, l]) => `<button type="button" data-pr="${k}" class="${S.reason === k ? 'active' : ''}">${l} <span class="ex-n">${cnt(k)}</span></button>`).join('')}</div>
        <input type="search" id="piQ" placeholder="Find an item" value="${esc(S.q)}" aria-label="Find">
        <select id="piSup" aria-label="Supplier"><option value="">All suppliers</option>${sups.map(s => `<option ${s === S.sup ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <span style="flex:1"></span>
        <span class="muted-note">${S.busy ? 'making them again…' : `made ${esc(new Date(S.data.made).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', dateStyle: 'short', timeStyle: 'short' }))} · stock of ${esc(String(S.data.day).split('-').reverse().join('-'))}`}</span>
        <button type="button" class="icon-btn" data-pi="redo" ${S.busy ? 'disabled' : ''} title="Make the ideas again from the system (about a minute)" aria-label="Make again">${ICON_REDO}</button></div>
      ${selList.length ? `<div class="ex-bulk"><b>${selList.length} ticked</b> · ${usd0(selList.reduce((t, x) => t + n(x.value), 0))} in stock
        ${canEditPromotions() ? `<button type="button" class="btn small" data-pi="create">Create a promotion with them</button>` : '<span class="muted-note">Creating a promotion needs the Promotions edit right.</span>'}
        <button type="button" class="btn ghost small" data-pi="clear">Clear</button></div>` : ''}
      <div class="card ex-tcard"><div class="items-scroll ex-scroll"><table class="items ex-tbl pi-tbl"><thead><tr>
        <th class="ex-ck"><input type="checkbox" data-pi="ckall" ${list.length && list.every(x => S.sel.has(x.code)) ? 'checked' : ''} aria-label="Tick all shown"></th>
        <th>Item</th><th>Why</th><th class="num">Stock</th><th class="num">Sold 30 days</th><th class="num">Days of stock</th><th class="num">In stock</th><th class="num">Cost</th><th class="num">Price now</th><th class="num">Promo price</th><th class="num">Margin</th></tr></thead>
        <tbody>${list.map(x => { const p = priceOf(x), m = p !== null && p !== '' && x.cost !== null && n(p) > 0 ? (n(p) - n(x.cost)) / n(p) : null;
          return `<tr data-code="${esc(x.code)}" class="${S.sel.has(x.code) ? 'sel' : ''}">
            <td class="ex-ck"><input type="checkbox" data-pi-ck="${esc(x.code)}" ${S.sel.has(x.code) ? 'checked' : ''} ${x.suggested === null && S.price[x.code] === undefined ? '' : ''} aria-label="Tick"></td>
            <td class="ex-c-item"><b>${esc(x.desc || x.code)}</b><small><span class="mono">${esc(x.code)}</span> · ${esc(x.sup || '')}${x.note ? ` · <em class="pi-note">${esc(x.note)}</em>` : ''}</small></td>
            <td>${x.reasons.map(r => `<span class="pi-tag k-${r}">${esc(REASON[r] || r)}</span>`).join(' ')}${x.expires ? `<small class="pi-sub">expires ${esc(String(x.expires).split('-').reverse().join('-'))}</small>` : ''}</td>
            <td class="num">${x.stock === null ? '—' : Math.round(n(x.stock)).toLocaleString('en-US')}</td><td class="num">${Math.round(n(x.sold30)).toLocaleString('en-US')}</td>
            <td class="num">${x.days === null ? (n(x.sold30) ? '—' : '<span class="muted-note">no sale</span>') : x.days.toLocaleString('en-US')}</td>
            <td class="num"><b>${x.value === null ? '—' : usd0(x.value)}</b></td><td class="num">${x.cost === null ? '—' : usd(x.cost)}</td>
            <td class="num">${x.currency === 'LBP' ? n(x.price).toLocaleString('en-US') + ' LBP' : usd(x.price)}</td>
            <td class="num">${x.currency === 'LBP' ? '<span class="muted-note">—</span>' : `<input type="text" class="pi-price" data-pi-price="${esc(x.code)}" inputmode="decimal" value="${p === null ? '' : esc(p)}" placeholder="—" aria-label="Promo price">`}</td>
            <td class="num ${m !== null && m < 0.03 ? 'pf-neg' : ''}">${m === null ? '—' : (Math.round(m * 1000) / 10) + '%'}</td></tr>`; }).join('') || '<tr><td colspan="11" class="empty-note">Nothing here.</td></tr>'}</tbody></table></div>
        <p class="muted-note ex-foot">Expiring: within 30 days (Expiries). Stopped selling: in stock, no sale in 30 days, sold in the 60 before. Overstock: more than 120 days of stock at the last 30 days' pace. Big purchase: far above the usual order. Ranked by the money in stock (stock x cost of the last 6 months' purchases). The promo price is a suggestion (expiring -25%, stopped -20%, overstock -15%, big purchase -10%, never under the cost + 5%, the cost itself when expiring): change it before creating the promotion. Items already on promotion are left out.</p></div>`;
    if (typing) { const q = el('piQ'); q.focus(); q.setSelectionRange(pos, pos); }
    wire();
  }
  function wire() {
    const box = S.box;
    box.onclick = e => {
      const r = e.target.closest('[data-pr]'); if (r) { S.reason = r.dataset.pr; return paint(); }
      const t = e.target.closest('[data-pi]'); if (!t) return;
      if (t.dataset.pi === 'redo') return make();
      if (t.dataset.pi === 'clear') { S.sel.clear(); return paint(); }
      if (t.dataset.pi === 'create') return create();
    };
    box.onchange = e => {
      const t = e.target;
      if (t.id === 'piSup') { S.sup = t.value; return paint(); }
      if (t.dataset.pi === 'ckall') { shown().forEach(x => t.checked ? S.sel.add(x.code) : S.sel.delete(x.code)); return paint(); }
      if (t.dataset.piCk) { t.checked ? S.sel.add(t.dataset.piCk) : S.sel.delete(t.dataset.piCk); return paint(); }
      if (t.dataset.piPrice) { const v = String(t.value).trim().replace(',', '.'); S.price[t.dataset.piPrice] = v === '' ? null : Number(v); return paint(); }
    };
    box.oninput = e => { if (e.target.id === 'piQ') { S.q = e.target.value; paint(); } };
  }
  // the ticked items, a promotion (Promotions page): its name and dates, each item with its price now and its promo price
  async function create() {
    const items = (S.data.items || []).filter(x => S.sel.has(x.code));
    if (!items.length) return;
    const noPrice = items.filter(x => { const p = priceOf(x); return p === null || p === '' || !(n(p) > 0); });
    const t = todayStr(), plus = k => { const d = new Date(t + 'T00:00:00'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA'); };
    const name = await showPrompt(`Name of the promotion (${items.length} item${items.length === 1 ? '' : 's'}${noPrice.length ? `, ${noPrice.length} without a promo price yet` : ''}):`, { defaultValue: `Clearance ${t.split('-').reverse().slice(0, 2).join('/')}` });
    if (!name) return;
    const id = uid();
    const { error } = await sb.from('promotions').insert({ id, name: name.trim(), from_date: t, to_date: plus(13), archived: false, auto_archive: true });
    if (error) return showToast(friendlyError(error), true);
    const rows = items.map((x, i) => ({ id: uid() + i, promotion_id: id, code: x.code, description: x.desc || null, supplier: x.sup || null, before_price: x.price ?? null,
      promo_price: priceOf(x) === null || priceOf(x) === '' ? null : n(priceOf(x)), sort_order: i, note: x.reasons.map(r => REASON[r] || r).join(', ') + (x.note ? ' · ' + x.note : '') }));
    const { error: e2 } = await sb.from('promotion_rows').insert(rows);
    if (e2) return showToast(friendlyError(e2), true);
    logActivity('promotions', 'create', { type: 'promotion', id }, `Promotion "${name.trim()}" from Promotion ideas: ${items.length} items`);
    S.sel.clear(); paint();
    showToast(`"${name.trim()}" created with ${items.length} item${items.length === 1 ? '' : 's'}, ${t.split('-').reverse().join('-')} for 2 weeks: change the dates in Promotions.`);
    if (typeof switchTab === 'function') setTimeout(() => switchTab('promotions'), 600);
  }
  window.PromoIdeas = { show };
})();
