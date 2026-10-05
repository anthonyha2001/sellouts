/* ============================================================
   Sell-outs › Credit note (owner, 2026-10-06): the sell-out's turnover and
   the credit note to claim from the supplier, worked out from the system.
   For each item of the sell-out:
     sold    = units sold during the sell-out (its From → To, or today)
     cost    = the last purchase cost on or before its last day, 3 decimals;
               a trade deal (10 + 1 @ $2 in one document) = paid / all units
               = 20 / 11 = 1.818
     %       = the sell-out's percentage (15%), or worked out from its old /
               new price when it was set as a price
     after   = cost x (100 - %) %             (15% -> cost x 85%)
     credit  = sold x (cost - after)          (= sold x cost x 15%)
   Checked on screen, then Excel, and (with the right) added to Credit notes.
   Live from the system (lv-dashboard: sales_compare, last_cost). Read only.
   Public API: window.CreditNote = { open(sellout) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const r3 = v => Math.round(n(v) * 1000) / 1000;
  const r2 = v => Math.round(n(v) * 100) / 100;
  const f3 = v => r3(v).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const f2 = v => r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fq = v => (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US');
  const day = s => s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const call = async body => { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error) throw error; return data; };

  function overlay() {
    let ov = document.getElementById('cnOverlay');
    if (!ov) {
      document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay" id="cnOverlay"><div class="modal-box cn-box" role="dialog" aria-modal="true"></div></div>');
      ov = document.getElementById('cnOverlay');
      ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-cn="close"]')) ov.classList.remove('open'); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') ov.classList.remove('open'); });
    }
    ov.classList.add('open');
    return ov.querySelector('.cn-box');
  }

  async function open(so) {
    const box = overlay();
    const t = todayStr(), from = String(so.from || '').slice(0, 10), endDay = String(so.to || '').slice(0, 10);
    const head = `<div class="cn-head"><div><h3>Credit note — ${esc(so.name)}</h3>
      <p class="muted-note">${esc(so.supplier || '')}${so.supplier ? ' · ' : ''}${esc(day(from))} → ${esc(day(endDay))}${endDay > t ? ' (running: sales up to today)' : ''}</p></div>
      <button type="button" class="icon-btn" data-cn="close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;
    if (!from || from > t) { box.innerHTML = head + '<p>This sell-out has not started yet: nothing sold.</p>'; return; }
    const to = endDay && endDay < t ? endDay : t;
    // the sell-out's items: code, description, the percentage (set, or from the old / new price)
    const items = [], seen = new Set();
    pricedRowsOf(so).forEach(p => {
      const code = String(p.code || '').trim(); if (!code || seen.has(code.toUpperCase())) return; seen.add(code.toUpperCase());
      const pctRaw = p.mode === 'percent' && p.value !== null && p.value !== '' ? n(p.value) : discountPct(p);
      items.push({ code, desc: p.description || '', pct: pctRaw === null || pctRaw === undefined ? null : Math.round(n(pctRaw) * 10) / 10 });
    });
    if (!items.length) { box.innerHTML = head + '<p>No item codes in this sell-out.</p>'; return; }
    box.innerHTML = head + `<p class="muted-note" id="cnStep">Reading what was sold during the sell-out (${items.length} items)…</p>`;
    let sales, costs = {};
    try {
      sales = (await call({ action: 'sales_compare', onlyDuring: true, codes: items.map(i => i.code), from, to })).items || {};
      if (!box.isConnected) return;
      const sold = items.filter(i => n(sales[i.code]?.during?.qty) > 0);
      document.getElementById('cnStep').textContent = `Reading the last purchase costs (${sold.length} items sold)…`;
      for (let i = 0; i < sold.length; i += 40) {
        const part = sold.slice(i, i + 40).map(x => x.code);
        Object.assign(costs, (await call({ action: 'last_cost', codes: part, until: endDay || t })).costs || {});
        const s = document.getElementById('cnStep'); if (s) s.textContent = `Reading the last purchase costs… ${Math.min(i + 40, sold.length)} / ${sold.length}`;
      }
    } catch (e) {
      console.warn('credit note', e);
      box.innerHTML = head + '<p class="login-err">The system did not answer. Check the "Link to the system" card on the Dashboard, then try again.</p>';
      return;
    }
    const lines = items.map(i => {
      const s = sales[i.code]?.during || { qty: 0, sales: 0 }, c = costs[i.code];
      // the day's documents together: what was paid / all the units received (trade deals included)
      let cost = null, deal = '', doc = '', date = '';
      if (c && c.docs?.length) {
        const paid = c.docs.reduce((t, d) => t + n(d.paid), 0), units = c.docs.reduce((t, d) => t + n(d.paidQty) + n(d.freeQty), 0);
        cost = units > 0 ? r3(paid / units) : null;
        deal = c.docs.filter(d => d.tradeDeal).map(d => d.lines.map(l => l.free ? `${fq(l.qty)} free` : `${fq(l.qty)} @ ${f3(l.unit)}`).join(' + ')).join('; ');
        doc = c.docs.map(d => d.doc).join(', '); date = c.date;
      }
      const qty = n(s.qty), after = cost !== null && i.pct !== null ? r3(cost * (100 - i.pct) / 100) : null;
      const credit = after !== null ? r2(qty * (cost - after)) : null;
      const issue = !qty ? 'not sold' : cost === null ? 'no purchase found' : i.pct === null ? 'no % on the sell-out' : '';
      return { ...i, qty, turnover: n(s.sales), cost, deal, doc, date, after, credit, issue };
    });
    const T = lines.reduce((t, l) => ({ qty: t.qty + l.qty, turnover: t.turnover + l.turnover, credit: t.credit + n(l.credit) }), { qty: 0, turnover: 0, credit: 0 });
    const flagged = lines.filter(l => l.qty && l.issue);
    box.innerHTML = head + `
      <div class="cn-stats">
        <div><b>${fq(T.qty)}</b><span>units sold</span></div>
        <div><b>$${f2(T.turnover)}</b><span>turnover</span></div>
        <div class="cn-total"><b>$${f2(T.credit)}</b><span>credit note</span></div>
      </div>
      ${flagged.length ? `<p class="cn-warn">${flagged.length} item${flagged.length === 1 ? '' : 's'} sold without a credit: ${flagged.map(l => `${esc(l.code)} (${esc(l.issue)})`).join(', ')}.</p>` : ''}
      <div class="items-scroll cn-scroll"><table class="items cn-table">
        <thead><tr><th>Code</th><th>Description</th><th class="num">Sold</th><th class="num">Turnover</th><th class="num">Last cost</th><th class="num">%</th><th class="num">Cost after</th><th class="num">Credit</th></tr></thead>
        <tbody>${lines.filter(l => l.qty).sort((a, b) => n(b.credit) - n(a.credit)).map(l => `<tr class="${l.issue ? 'cn-row-issue' : ''}">
          <td class="mono">${esc(l.code)}</td>
          <td>${esc(l.desc)}${l.deal ? `<div class="cn-sub"><span class="lp-deal">trade deal</span> ${esc(l.deal)}</div>` : ''}${l.doc ? `<div class="cn-sub">${esc(l.doc)} · ${esc(day(l.date))}</div>` : ''}${l.issue ? `<div class="cn-sub cn-issue">${esc(l.issue)}</div>` : ''}</td>
          <td class="num">${fq(l.qty)}</td><td class="num">${f2(l.turnover)}</td>
          <td class="num">${l.cost === null ? '—' : f3(l.cost)}</td><td class="num">${l.pct === null ? '—' : l.pct + '%'}</td>
          <td class="num">${l.after === null ? '—' : f3(l.after)}</td><td class="num"><b>${l.credit === null ? '—' : f2(l.credit)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="2">Total</th><th class="num">${fq(T.qty)}</th><th class="num">${f2(T.turnover)}</th><th colspan="3"></th><th class="num">${f2(T.credit)}</th></tr></tfoot>
      </table></div>
      ${lines.some(l => !l.qty) ? `<p class="muted-note" style="margin:8px 0 0;">${lines.filter(l => !l.qty).length} item${lines.filter(l => !l.qty).length === 1 ? '' : 's'} of the sell-out sold nothing (not in the credit note; listed in the Excel).</p>` : ''}
      <div class="cn-actions">
        <button type="button" class="btn secondary" id="cnExcel">Download Excel</button>
        ${can('creditnotes.edit') ? '<button type="button" class="btn" id="cnAdd">Add to Credit notes</button>' : ''}
      </div>`;
    document.getElementById('cnExcel').onclick = () => exportExcel(so, from, to, lines, T);
    document.getElementById('cnAdd')?.addEventListener('click', () => addCreditNote(so, from, to, lines, T));
  }

  function exportExcel(so, from, to, lines, T) {
    const aoa = [['Credit note — sell-out', so.name], ['Supplier', so.supplier || ''], ['Period', `${from} to ${to}`], ['Branch', 'Ajaltoun'], ['Made', todayStr()], [],
      ['Code', 'Description', 'Units sold', 'Turnover', 'Last purchase cost', 'Trade deal', 'Purchase document', 'Purchase date', 'Sell-out %', 'Cost after %', 'Credit', 'Note']];
    const first = aoa.length;
    lines.slice().sort((a, b) => n(b.credit) - n(a.credit)).forEach(l => aoa.push([l.code, l.desc, l.qty, r2(l.turnover), l.cost ?? '', l.deal, l.doc, l.date, l.pct ?? '', l.after ?? '', l.credit ?? '', l.issue]));
    aoa.push([], ['Total', '', r3(T.qty), r2(T.turnover), '', '', '', '', '', '', r2(T.credit), '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = first; r < first + lines.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: 0 }); if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); } }
    ws['!cols'] = [{ wch: 10 }, { wch: 42 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 22 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 11 }, { wch: 22 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Credit note');
    XLSX.writeFile(wb, `${String(so.name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'sellout'} - credit note.xlsx`);
    logActivity('sellouts', 'credit_note_export', { type: 'sellout', id: so.id }, `Credit note of ${so.name}: $${f2(T.credit)} (${fq(T.qty)} units, turnover $${f2(T.turnover)})`, { credit: r2(T.credit), turnover: r2(T.turnover), units: r3(T.qty) });
  }

  async function addCreditNote(so, from, to, lines, T) {
    const number = await showPrompt(`Credit note number for ${so.supplier || so.name} (optional):`, { confirmLabel: 'Add', placeholder: 'e.g. CN-2026-041' });
    if (number === null) return;
    const row = { id: uid(), number: number.trim(), supplier: so.supplier || so.name, status: 'issued',
      details: `Sell-out "${so.name}" ${from} to ${to}: credit $${f2(T.credit)} on ${fq(T.qty)} units sold (turnover $${f2(T.turnover)}), ${lines.filter(l => n(l.credit) > 0).length} items, at the last purchase cost` };
    const { error } = await sb.from('credit_notes').insert(row);
    if (error) return showToast('Not added — ' + friendlyError(error), true);
    logActivity('creditnotes', 'create', { type: 'credit_note', id: row.id }, `Credit note for ${row.supplier}: $${f2(T.credit)} (sell-out ${so.name})`);
    showToast(`Added to Credit notes: $${f2(T.credit)}.`);
    if (typeof loadAll === 'function') loadAll();
  }

  window.CreditNote = { open };
})();
