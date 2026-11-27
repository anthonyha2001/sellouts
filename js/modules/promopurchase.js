/* ============================================================
   Promotions › Purchase (owner, 2026-11-27): per item of the promotion, its cost and quantity, with a
   Promo cost typed by hand, and an Excel export.
   - Cost and Last purchase: exactly as in Audit (owner, 2026-11-27: "I should know what is free and what is the
     cost"): the price sheet's Cost as typed, then the last purchase from the system (lastCostHtml): the paid
     lines ("30 @ 1.20"), the free ones ("6 free", trade deal), the real cost = paid / all the units, the document.
   - Quantity: the stock now at Ajaltoun (Items from the system), else the row's stock.
   - Promo cost: free text, saved on the row (promotion_rows.promo_cost, migration 108). Enter / arrows move down and up;
     pasting a column from Excel fills the rows downward. Only promotions.edit may change it.
   Public API: window.PromoPurchase = { render(container, promo, rows), paint() }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const qtyTxt = v => (Math.round(v * 100) / 100).toLocaleString('en-US');
  // Promo cost is free text (owner, 2026-11-27): "1.10", "1.10 + 10% free", "same"… Blank -> null.
  const cleanCost = v => { v = String(v ?? '').trim(); return v === '' ? null : v; };
  let box = null, promoNow = null, rowsNow = [];

  // The last purchase split for the export: paid units / free units / what was paid / real cost, per document.
  const lastBuyOf = row => {
    const h = lastCostCache.get(normalizeCatalogCode(row.code));
    if (!h || !h.v || h.v.failed || !h.v.docs?.length) return null;
    const docs = h.v.docs.map(d => {
      const paid = d.lines.filter(l => !l.free), free = d.lines.filter(l => l.free);
      return { cur: d.currency || '$', real: n(d.realCost), doc: d.doc || '', deal: !!d.tradeDeal,
        paidQty: paid.reduce((t, l) => t + (n(l.qty) || 0), 0), freeQty: free.reduce((t, l) => t + (n(l.qty) || 0), 0),
        paidTxt: paid.map(l => `${lcQty(l.qty)} @ ${lcMoney(l.unit)}${l.discountPct ? ` −${l.discountPct}% = ${lcMoney(l.net)}` : ''}`).join(' + ') };
    });
    return { date: h.v.date, docs };
  };
  const sheetCostOf = row => String(row.cost ?? '').trim();
  const qtyOf = row => {
    const live = typeof catalogMap !== 'undefined' ? catalogMap.get(normalizeCatalogCode(row.code)) : null;
    return n(live?.balance ?? row.balance);
  };

  // the same cell as Audit's Last purchase
  const costCellHtml = row => lastCostHtml(row);

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
            <span class="muted-note">Cost = the price sheet · Last purchase = live from the system: what was paid, what came free (trade deal) and the real cost per unit · Quantity = stock now${edit ? ' · type the promo cost (any text); Enter goes down, paste a column from Excel to fill down' : ''}</span></div>
          <button type="button" class="btn secondary small ibtn" id="ppExport">${ICONS.excel}Export to Excel</button>
        </div>
        ${noColumn ? '<p class="login-err" style="margin:0 18px 12px;">Promo cost cannot be saved yet: run migration 108_promo_cost.sql in Supabase.</p>' : ''}
        <div class="items-scroll" style="margin:0;border:0;"><table class="items pp-table">
          <thead><tr><th>#</th><th>Code</th><th>Description</th><th>Supplier</th><th class="num">Cost</th><th>Last purchase</th><th class="num">Quantity</th><th class="num">Promo cost</th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr>
            <td class="muted-note">${i + 1}</td>
            <td class="mono">${esc(r.code || '')}</td>
            <td>${esc(r.description || '')}</td>
            <td>${esc(r.supplier || '')}</td>
            <td class="num">${esc(sheetCostOf(r))}</td>
            <td class="lp-cell" data-pp-cost="${esc(r.id)}">${costCellHtml(r)}</td>
            <td class="num" data-pp-qty="${esc(r.id)}">${qtyCellHtml(r)}</td>
            <td class="num pp-edit">${edit && !noColumn
              ? `<input type="text" class="pp-input" data-pp-id="${esc(r.id)}" value="${r.promoCost === null || r.promoCost === undefined ? '' : esc(String(r.promoCost))}" aria-label="Promo cost of ${esc(r.code || 'this item')}">`
              : esc(r.promoCost ?? '')}</td>
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
      const v = cleanCost(el.value);
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
        const changed = [];
        lines.forEach((line, k) => {
          const target = inputs[i + k]; if (!target) return;
          const v = cleanCost(line.split('\t')[0]);
          const row = rowOf(target); if (!row) return;
          target.value = v === null ? '' : String(v);
          if ((row.promoCost ?? null) !== v) { row.promoCost = v; changed.push(row); }
        });
        if (changed.length) await persistRowsBulk(changed);
        updateFilled();
        const skipped = lines.length - Math.min(lines.length, inputs.length - i);
        showToast(`Pasted ${changed.length} promo cost${changed.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} line${skipped === 1 ? '' : 's'} past the last row ignored` : ''}.`);
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
      ['Code', 'Description', 'Supplier', 'Cost (sheet)', 'Paid (last purchase)', 'Paid units', 'Free units', 'Real cost per unit', 'Document', 'Purchase date', 'Quantity', 'Promo cost']];
    rowsNow.forEach(r => {
      const b = lastBuyOf(r), q = qtyOf(r);
      // one line per document of that day (usually one)
      (b ? b.docs : [null]).forEach((d, k) => aoa.push([String(r.code || ''), r.description || '', r.supplier || '', sheetCostOf(r),
        d ? d.paidTxt : '', d ? d.paidQty : '', d ? d.freeQty : '', d && d.real !== null ? Math.round(d.real * 1000) / 1000 : '',
        d ? d.doc : '', b ? b.date : '', k === 0 && q !== null ? q : '', k === 0 ? (r.promoCost ?? '') : '']));
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // code, sheet cost and promo cost stay text, exactly as typed (leading zeros, "1.10 + 10% free")
    for (let i = 3; i < aoa.length; i++) [0, 3, 11].forEach(c => { const ref = XLSX.utils.encode_cell({ r: i, c }); if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(ws[ref].v); ws[ref].z = '@'; } });
    ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 22 }, { wch: 12 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 13 }, { wch: 10 }, { wch: 14 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Purchase');
    XLSX.writeFile(wb, `${(promo.name || 'promotion').replace(/[^\w-]+/g, '-')}-purchase.xlsx`);
    logActivity('promotions', 'purchase_export', { type: 'promotion', id: promo.id }, `Exported the purchase sheet of ${promo.name}`);
  }

  window.PromoPurchase = { render, paint };
})();
