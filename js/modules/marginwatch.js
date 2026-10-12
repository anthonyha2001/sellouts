/* ============================================================
   Pricing › Margin watch (owner, 2026-10-12; migration 087).
   lv-dashboard (margin_watch, every 10 minutes from 07:00) checks each
   item bought against its previous PU and its price now:
   - Cost up: the cost went up 3% and 2 cents or more, the price did not
     follow and no new price was sent from Pricing;
   - Below cost: the price now is under the cost with VAT (not on promotion);
   - Check unit: the cost doubled, or is more than twice the price - a
     case / piece change most likely, to check in the system.
   A flag closes by itself when a new price is sent or the price goes up.
   Each line opens its PU in Pricing (to send the new price from there).
   Permission: vendors.manage. Public API: window.MarginWatch = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const el = id => document.getElementById(id);
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const KINDS = [['cost_up', 'Cost up, price not'], ['below_cost', 'Below cost'], ['check_unit', 'Check the unit'], ['done', 'Done']];
  const S = { kind: 'cost_up', q: '', rows: null, openPu: null };
  const amt = (v, cur) => v === null || v === undefined ? '—' : cur === 'LBP' ? Math.round(n(v)).toLocaleString('en-US') + ' LBP' : '$' + (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = v => v === null || v === undefined ? '—' : (Math.round(n(v) * 1000) / 10).toLocaleString('en-US') + '%';
  const ICON_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  const ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

  async function load() {
    const from = addDaysStr(todayStr(), -14);
    const { data, error } = await sb.from('margin_checks').select('*').gte('day', from).in('kind', ['cost_up', 'below_cost', 'check_unit']).order('day', { ascending: false }).limit(3000);
    if (error) throw new Error(/margin_checks/.test(error.message) ? 'The margin watch is not set up yet (migration 087).' : error.message);
    S.rows = data || [];
  }
  async function show(box, opts = {}) {
    if (!box) return;
    S.openPu = opts.openPu || null;
    box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Reading the margin watch…</p></div>';
    try { await load(); paint(box); }
    catch (e) { box.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(e.message)}</p></div>`; }
  }
  function list(kind) {
    const all = S.rows || [];
    return kind === 'done' ? all.filter(r => r.resolved_at && ['cost_up', 'below_cost'].includes(r.kind)) : all.filter(r => r.kind === kind && !r.resolved_at);
  }
  function paint(box) {
    const counts = Object.fromEntries(KINDS.map(([k]) => [k, list(k).length]));
    const q = S.q.trim().toLowerCase();
    const rows = list(S.kind).filter(r => !q || [r.code, r.description, r.supplier, r.doc].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => S.kind === 'check_unit' ? String(b.day).localeCompare(String(a.day)) : n(a.margin) - n(b.margin));
    const head = S.kind === 'check_unit' ? '<th>Day</th><th>PU</th><th>Supplier</th><th>Code</th><th>Item</th><th class="num">Cost before</th><th class="num">Cost now</th><th class="num">Price now</th><th></th>'
      : '<th>Day</th><th>PU</th><th>Supplier</th><th>Code</th><th>Item</th><th class="num">Cost before</th><th class="num">Cost now</th><th class="num">Change</th><th class="num">Price now</th><th class="num">Margin before</th><th class="num">Margin now</th>' + (S.kind === 'done' ? '<th>How</th>' : '') + '<th></th>';
    const row = r => {
      const cur = r.currency || '$';
      const tags = `${r.vat ? '<span class="pr-vat" title="The PU has VAT: the cost includes it">VAT</span>' : ''}${r.promoted ? ' <span class="pr-vat" title="On promotion now">PROMO</span>' : ''}`;
      const base = `<td>${esc(dmy(r.day))}</td><td class="mono">${esc(r.doc || '')}</td><td>${esc(r.supplier || '')}</td><td class="mono">${esc(r.code)}</td><td>${esc(r.description || '')} ${tags}</td>
        <td class="num">${amt(r.prev_cost, cur)}${r.prev_day ? `<div class="pf-sub">${esc(dmy(r.prev_day))}</div>` : ''}</td><td class="num"><b>${amt(r.cost, cur)}</b></td>`;
      const open = `<td><button type="button" class="icon-btn" data-open="${esc(r.doc || '')}" title="Open ${esc(r.doc || '')} in Pricing to set the new price" aria-label="Open the PU">${ICON_OPEN}</button></td>`;
      if (S.kind === 'check_unit') return `<tr data-code="${esc(r.code)}">${base}<td class="num">${amt(r.sale_price, r.sale_currency || cur)}</td>${open}</tr>`;
      return `<tr data-code="${esc(r.code)}">${base}<td class="num ${n(r.cost_change) > 0 ? 'pf-neg' : ''}">${r.cost_change === null ? '—' : (n(r.cost_change) > 0 ? '+' : '') + pct(r.cost_change)}</td>
        <td class="num">${amt(r.sale_price, r.sale_currency || cur)}</td><td class="num">${pct(r.prev_margin)}</td><td class="num"><b class="${n(r.margin) < 0 ? 'pf-neg' : n(r.margin) < 0.1 ? 'mw-low' : ''}">${pct(r.margin)}</b></td>
        ${S.kind === 'done' ? `<td class="muted-note">${esc(r.resolved_how || '')}</td>` : ''}${open}</tr>`;
    };
    const note = { cost_up: 'The cost went up 3% and 2 cents (1,000 LBP) or more since the previous PU, and the price did not follow (no new price sent from Pricing). Lowest margin first.',
      below_cost: 'The price now is under the cost with VAT (by a cent and 1% at least; items on promotion are left out). Lowest margin first.',
      check_unit: 'The cost doubled since the previous PU, or is more than twice the price: most likely a PU in cases against a price per piece (or the other way). Check the unit in the system - not counted as a loss.',
      done: 'Closed by themselves: a new price was sent from Pricing, or the price went up enough.' }[S.kind];
    box.innerHTML = `<div class="card">
      <div class="pf-head"><div class="filter-row" id="mwKinds" style="margin:0;">${KINDS.map(([k, l]) => `<button type="button" data-k="${k}" class="${k === S.kind ? 'active' : ''}">${l} <span class="muted-note">${counts[k]}</span></button>`).join('')}</div>
        <input type="search" id="mwQ" placeholder="Find an item, a supplier, a PU" value="${esc(S.q)}" aria-label="Find"><span style="flex:1"></span>
        <button type="button" class="icon-btn" id="mwXls" title="Download (Excel)" aria-label="Download (Excel)">${ICON_DL}</button></div>
      <div class="items-scroll pf-scroll"><table class="items pf-table mw-table"><thead><tr>${head}</tr></thead>
        <tbody>${rows.map(row).join('') || '<tr><td colspan="13" class="empty-note">Nothing here for the last 14 days.</td></tr>'}</tbody></table></div>
      <p class="muted-note" style="margin:8px 0 0;">${note} The PUs of the last 14 days; checked every 10 minutes from 07:00. Cost = the PU's unit cost (free units counted, VAT added when the PU has it). Double-click an item for its details.</p></div>`;
    el('mwKinds').onclick = e => { const b = e.target.closest('[data-k]'); if (b) { S.kind = b.dataset.k; paint(box); } };
    el('mwQ').oninput = () => { S.q = el('mwQ').value; const pos = el('mwQ').selectionStart; paint(box); el('mwQ').focus(); el('mwQ').setSelectionRange(pos, pos); };
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { if (b.dataset.open && S.openPu) S.openPu(b.dataset.open); });
    box.querySelectorAll('tr[data-code]').forEach(tr => tr.ondblclick = () => window.ItemDetail && ItemDetail.open(tr.dataset.code));
    el('mwXls').onclick = () => {
      const aoa = [['Day', 'PU', 'Supplier', 'Code', 'Item', 'Currency', 'VAT', 'Cost before', 'Previous PU day', 'Cost now', 'Change %', 'Price now', 'Margin before %', 'Margin now %', 'On promotion', 'Closed']];
      rows.forEach(r => aoa.push([dmy(r.day), r.doc || '', r.supplier || '', r.code, r.description || '', r.currency || '$', r.vat ? 'yes' : '', r.prev_cost === null ? '' : n(r.prev_cost), dmy(r.prev_day), n(r.cost),
        r.cost_change === null ? '' : Math.round(n(r.cost_change) * 1000) / 10, r.sale_price === null ? '' : n(r.sale_price), r.prev_margin === null ? '' : Math.round(n(r.prev_margin) * 1000) / 10,
        r.margin === null ? '' : Math.round(n(r.margin) * 1000) / 10, r.promoted ? 'yes' : '', r.resolved_how || '']));
      const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map((h, i) => ({ wch: i === 4 ? 36 : i === 2 ? 22 : 12 }));
      for (let i = 2; i <= aoa.length; i++) { const c = ws['D' + i]; if (c) { c.t = 's'; c.v = String(c.v); } }
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Margin watch');
      XLSX.writeFile(wb, `Margin watch ${KINDS.find(k => k[0] === S.kind)[1]} ${todayStr()}.xlsx`);
    };
  }
  window.MarginWatch = { show, count: () => list('cost_up').length + list('below_cost').length };
})();
