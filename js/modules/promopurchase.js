/* ============================================================
   Promotions › Purchase (owner, 2026-11-27): per item of the promotion, its cost and quantity, with a
   Promo cost typed by hand, and an Excel export.
   - Cost: what was really paid the last time (lv-dashboard last_cost, the same as Audit's Last purchase);
     the price sheet's own Cost shows under it when there is one.
   - Quantity: the stock now at Ajaltoun (Items from the system), else the row's stock.
   - Promo cost: saved on the row (promotion_rows.promo_cost, migration 108). Enter / arrows move down and up;
     pasting a column from Excel fills the rows downward. Only promotions.edit may change it.
   Public API: window.PromoPurchase = { render(container, promo, rows), paint() }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const money = v => (Math.round(v * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const qtyTxt = v => (Math.round(v * 100) / 100).toLocaleString('en-US');
  // "1.25", "$1.25", "1,25" -> 1.25; "1,050" -> 1050; blank -> null; not a number -> NaN
  const parseCost = s => {
    s = String(s ?? '').trim().replace(/^\$\s*/, '');
    if (!s) return null;
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    s = s.replace(/,/g, '');
    return /^-?\d*\.?\d+$/.test(s) ? Math.round(Number(s) * 10000) / 10000 : NaN;
  };
  let box = null, promoNow = null, rowsNow = [];

  const lastCostOf = row => {
    const h = lastCostCache.get(normalizeCatalogCode(row.code));
    if (!h) return { state: 'wait' };
    if (h.v === undefined) return { state: 'noanswer' };
    if (!h.v || h.v.failed || !h.v.docs?.length) return { state: 'none' };
    const d = h.v.docs[0];
    return { state: 'ok', cost: n(d.realCost), currency: d.currency || '$', date: h.v.date, more: h.v.docs.length - 1 };
  };
  const sheetCostOf = row => String(row.cost ?? '').trim();
  const qtyOf = row => {
    const live = typeof catalogMap !== 'undefined' ? catalogMap.get(normalizeCatalogCode(row.code)) : null;
    return n(live?.balance ?? row.balance);
  };

  function costCellHtml(row) {
    if (!String(row.code || '').trim()) return '';
    const c = lastCostOf(row), sheet = sheetCostOf(row);
    const main = c.state === 'wait' ? '<span class="muted-note">…</span>'
      : c.state === 'noanswer' ? '<span class="muted-note" title="The system did not answer">—</span>'
      : c.state === 'none' ? '<span class="muted-note">no purchase</span>'
      : `<b title="Last purchase ${esc(c.date)}${c.more ? ` (+${c.more} other document${c.more === 1 ? '' : 's'} that day)` : ''}">${esc(c.currency)}${money(c.cost)}</b>`;
    return main + (sheet ? `<div class="pp-sub" title="The price sheet's Cost">sheet: ${esc(sheet)}</div>` : '');
  }

  function render(container, promo, rows) {
    box = container; promoNow = promo; rowsNow = rows;
    queueLastCost(rows.map(r => r.code));
    queueLiveItems(rows.map(r => r.code));
    const edit = can('promotions.edit');
    const noColumn = rows.length && rows.every(r => r.promoCost === undefined);
    if (!rows.length) { box.innerHTML = '<div class="card"><p style="margin:0;">No items in this promotion yet.</p></div>'; return; }
    const filled = rows.filter(r => r.promoCost !== null && r.promoCost !== undefined && r.promoCost !== '').length;
    box.innerHTML = `
      <div class="card" style="padding:0;">
        <div class="pr-head">
          <div><b>Purchase</b> <span class="muted-note">· ${rows.length} item${rows.length === 1 ? '' : 's'} · <span id="ppFilled">${filled}</span> with a promo cost</span><br>
            <span class="muted-note">Cost = the last purchase (live from the system) · Quantity = stock now${edit ? ' · type the promo cost; Enter goes down, paste a column from Excel to fill down' : ''}</span></div>
          <button type="button" class="btn secondary small ibtn" id="ppExport">${ICONS.excel}Export to Excel</button>
        </div>
        ${noColumn ? '<p class="login-err" style="margin:0 18px 12px;">Promo cost cannot be saved yet: run migration 108_promo_cost.sql in Supabase.</p>' : ''}
        <div class="items-scroll" style="margin:0;border:0;"><table class="items pp-table">
          <thead><tr><th>#</th><th>Code</th><th>Description</th><th>Supplier</th><th class="num">Cost</th><th class="num">Quantity</th><th class="num">Promo cost</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td class="muted-note">${i + 1}</td>
            <td class="mono">${esc(r.code || '')}</td>
            <td>${esc(r.description || '')}</td>
            <td>${esc(r.supplier || '')}</td>
            <td class="num" data-pp-cost="${esc(r.id)}">${costCellHtml(r)}</td>
            <td class="num" data-pp-qty="${esc(r.id)}">${qtyCellHtml(r)}</td>
            <td class="num pp-edit">${edit && !noColumn
              ? `<input type="text" inputmode="decimal" class="pp-input" data-pp-id="${esc(r.id)}" value="${r.promoCost === null || r.promoCost === undefined ? '' : esc(String(r.promoCost))}" aria-label="Promo cost of ${esc(r.code || 'this item')}">`
              : (r.promoCost === null || r.promoCost === undefined ? '' : money(Number(r.promoCost)))}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    box.querySelector('#ppExport').onclick = exportXlsx;
    wireInputs();
  }

  function qtyCellHtml(r) {
    const q = qtyOf(r);
    return q === null ? '' : q <= 0 ? `<span class="rc-zero">${qtyTxt(q)}</span>` : qtyTxt(q);
  }

  function wireInputs() {
    const inputs = [...box.querySelectorAll('.pp-input')];
    const rowOf = el => rowsNow.find(r => r.id === el.dataset.ppId);
    const save = async (el) => {
      const row = rowOf(el); if (!row) return;
      const v = parseCost(el.value);
      if (Number.isNaN(v)) { el.classList.add('pp-bad'); showToast('Promo cost: type a number, e.g. 1.25', true); return; }
      el.classList.remove('pp-bad');
      if ((row.promoCost ?? null) === v) return;
      row.promoCost = v;
      el.value = v === null ? '' : String(v);
      await savePromoRow(row);
      updateFilled();
    };
    inputs.forEach((el, i) => {
      el.addEventListener('change', () => save(el));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); inputs[i + 1]?.focus(); inputs[i + 1]?.select(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); inputs[i - 1]?.focus(); inputs[i - 1]?.select(); }
      });
      // a column pasted from Excel: one value per row, from this row down
      el.addEventListener('paste', async e => {
        const text = e.clipboardData?.getData('text') || '';
        const lines = text.replace(/\r/g, '').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
        if (lines.length < 2) return;
        e.preventDefault();
        const changed = [], bad = [];
        lines.forEach((line, k) => {
          const target = inputs[i + k]; if (!target) return;
          const v = parseCost(line.split('\t')[0]);
          if (Number.isNaN(v)) { bad.push(i + k + 1); target.classList.add('pp-bad'); return; }
          target.classList.remove('pp-bad');
          const row = rowOf(target); if (!row) return;
          target.value = v === null ? '' : String(v);
          if ((row.promoCost ?? null) !== v) { row.promoCost = v; changed.push(row); }
        });
        if (changed.length) await persistRowsBulk(changed);
        updateFilled();
        const skipped = lines.length - Math.min(lines.length, inputs.length - i);
        showToast(`Pasted ${changed.length} promo cost${changed.length === 1 ? '' : 's'}${bad.length ? ` · not a number on row${bad.length === 1 ? '' : 's'} ${bad.join(', ')}` : ''}${skipped ? ` · ${skipped} line${skipped === 1 ? '' : 's'} past the last row ignored` : ''}.`, !!bad.length);
      });
    });
  }

  function updateFilled() {
    const el = box?.querySelector('#ppFilled');
    if (el) el.textContent = rowsNow.filter(r => r.promoCost !== null && r.promoCost !== undefined && r.promoCost !== '').length;
  }

  // Called when last costs / stock arrive from the system: repaint those cells only (never the inputs).
  function paint() {
    if (!box || !box.isConnected) return;
    box.querySelectorAll('[data-pp-cost]').forEach(td => { const r = rowsNow.find(x => x.id === td.dataset.ppCost); if (r) td.innerHTML = costCellHtml(r); });
    box.querySelectorAll('[data-pp-qty]').forEach(td => { const r = rowsNow.find(x => x.id === td.dataset.ppQty); if (r) td.innerHTML = qtyCellHtml(r); });
  }

  function exportXlsx() {
    const promo = promoNow;
    const aoa = [[`${promo.name || 'Promotion'} — purchase${promo.from ? ` · ${promo.from}${promo.to ? ' to ' + promo.to : ''}` : ''}`], [],
      ['Code', 'Description', 'Supplier', 'Cost', 'Last purchase date', 'Sheet cost', 'Quantity', 'Promo cost']];
    rowsNow.forEach(r => {
      const c = lastCostOf(r), q = qtyOf(r);
      aoa.push([String(r.code || ''), r.description || '', r.supplier || '',
        c.state === 'ok' ? Math.round(c.cost * 1000) / 1000 : '', c.state === 'ok' ? c.date : '',
        sheetCostOf(r), q === null ? '' : q,
        r.promoCost === null || r.promoCost === undefined ? '' : Number(r.promoCost)]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // codes stay text (leading zeros)
    for (let i = 3; i < aoa.length; i++) { const ref = XLSX.utils.encode_cell({ r: i, c: 0 }); if (ws[ref]) { ws[ref].t = 's'; ws[ref].z = '@'; } }
    ws['!cols'] = [{ wch: 12 }, { wch: 44 }, { wch: 24 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 10 }, { wch: 11 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Purchase');
    XLSX.writeFile(wb, `${(promo.name || 'promotion').replace(/[^\w-]+/g, '-')}-purchase.xlsx`);
    logActivity('promotions', 'purchase_export', { type: 'promotion', id: promo.id }, `Exported the purchase sheet of ${promo.name}`);
  }

  window.PromoPurchase = { render, paint };
})();
