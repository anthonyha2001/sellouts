/* ============================================================
   Paste barcodes (or item codes) and discounts (owner, 2026-10-06):
   one item per line, a discount after it if any (15 · 15% · 0.15), or one
   discount for all. The system finds each item (lv-dashboard items_lookup:
   the barcode or the code), the new price = normal price - % (to 0.05).
   Not found / twice: shown, left out.
   Used by Promotions (the insert button on a row: the items go below it).
   Public API: window.PasteItems.open({ title, okLabel, needDiscount, extraLink })
     -> Promise<{ rows: [{ token, pct, item, newPrice }] } | { extra: true } | null>
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const f2 = v => v === null || v === undefined || v === '' || isNaN(Number(v)) ? '—' : (Math.round(Number(v) * 100) / 100).toFixed(2);
  const newPriceOf = (old, pct) => (old && pct !== null) ? Math.round(Math.round(old * (1 - pct / 100) / 0.05) * 0.05 * 100) / 100 : null;

  function open({ title = 'Paste barcodes and discounts', okLabel = 'Insert', needDiscount = false, extraLink = '', pickLabel = '' } = {}) {
    return new Promise(resolve => {
      document.getElementById('piOverlay')?.remove();
      document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="piOverlay"><div class="modal-box ip-box" role="dialog" aria-modal="true">
        <div class="ip-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-pi="close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        ${pickLabel && window.ItemPicker ? `<button type="button" class="btn secondary pi-pick" id="piPick"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:-3px;stroke:currentColor"><path d="M3 5h18l-7 8v6l-4 2v-8Z"/></svg> ${esc(pickLabel)}</button>
        <p class="pi-or"><span>or paste barcodes</span></p>` : ''}
        <p class="muted-note" style="margin:0 0 8px;">One item per line: a barcode or an item code, then its discount if it has one (15, 15% or 0.15). Paste the columns from Excel as they are.</p>
        <textarea id="piText" rows="8" class="sp-text" placeholder="5283003400038   15&#10;5281056010266   20%&#10;128420"></textarea>
        <div class="sp-row"><label>Discount for the lines without one <input type="text" inputmode="decimal" id="piDefault" placeholder="${needDiscount ? 'e.g. 10' : 'none'}" style="width:90px;"> %</label>
          <span class="muted-note" id="piLines"></span><span style="flex:1"></span>
          ${extraLink ? `<button type="button" class="link-btn" id="piExtra">${esc(extraLink)}</button>` : ''}
          <button type="button" class="btn" id="piFind">Find the items</button></div>
        <div id="piResult"></div>
        <div class="ip-foot"><span class="muted-note" id="piCount"></span><span style="flex:1"></span><button type="button" class="btn" id="piOk" disabled>${esc(okLabel)}</button></div>
      </div></div>`);
      const ov = document.getElementById('piOverlay'), $ = id => document.getElementById(id);
      const done = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-pi="close"]')) done(null); });
      $('piExtra')?.addEventListener('click', () => done({ extra: true }));
      $('piPick')?.addEventListener('click', () => done({ pick: true }));
      let ready = [];
      const parse = () => {
        const def = $('piDefault').value.trim(), lines = [];
        $('piText').value.split(/\r?\n/).forEach(l => {
          const parts = l.trim().split(/[\s;,|]+/).filter(Boolean); if (!parts.length) return;
          let d = String(parts[1] ?? def ?? '').replace('%', '').trim();
          let pct = d === '' ? null : Number(d.replace(',', '.'));
          if (pct !== null && pct > 0 && pct < 1) pct = Math.round(pct * 1000) / 10;   // 0.15 = 15%
          lines.push({ token: parts[0].replace(/^'/, ''), pct: pct !== null && Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : null });
        });
        return lines;
      };
      // how many rows it will make, as you paste
      const count = () => { const n = parse().length; $('piLines').textContent = n ? `${n} line${n === 1 ? '' : 's'}` : ''; };
      $('piText').addEventListener('input', count); $('piDefault').addEventListener('input', count);
      $('piFind').onclick = async () => {
        const lines = parse();
        if (!lines.length) return showToast('Paste at least one barcode or code.', true);
        if (lines.length > 200) return showToast('200 lines at most at a time.', true);
        $('piFind').disabled = true; $('piFind').textContent = `Finding ${lines.length} item${lines.length === 1 ? '' : 's'}…`;
        let items = {};
        try {
          const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'items_lookup', tokens: lines.map(l => l.token) } });
          if (error || !data?.items) throw error || new Error('no answer');
          items = data.items;
        } catch (e) { showToast('The system did not answer. Check the "Link to the system" card on the Dashboard.', true); }
        finally { $('piFind').disabled = false; $('piFind').textContent = 'Find the items'; }
        const seen = new Set();
        const rows = lines.map(l => {
          const it = items[l.token] || null, dup = !!(it && seen.has(it.code)); if (it) seen.add(it.code);
          const old = it && it.salePrice !== null && it.salePrice !== undefined ? Number(it.salePrice) : null;
          return { ...l, item: it, dup, old, newPrice: newPriceOf(old, l.pct) };
        });
        ready = rows.filter(r => r.item && !r.dup && (!needDiscount || r.pct !== null));
        const miss = rows.filter(r => !r.item), noPct = needDiscount ? rows.filter(r => r.item && r.pct === null) : [], dups = rows.filter(r => r.dup);
        $('piResult').innerHTML = `
          ${miss.length || noPct.length || dups.length ? `<p class="cn-warn">${[miss.length ? `${miss.length} not found in the system: ${miss.map(r => esc(r.token)).join(', ')}` : '',
            noPct.length ? `${noPct.length} without a discount: ${noPct.map(r => esc(r.token)).join(', ')}` : '', dups.length ? `${dups.length} twice (kept once)` : ''].filter(Boolean).join(' · ')}</p>` : ''}
          <div class="items-scroll ip-scroll"><table class="items ip-table"><thead><tr><th>Pasted</th><th>Code</th><th>Description</th><th class="num">Normal price</th><th class="num">Discount</th><th class="num">New price</th><th class="num">Stock</th></tr></thead>
          <tbody>${rows.map(r => `<tr class="${!r.item ? 'sp-miss' : r.dup || (needDiscount && r.pct === null) ? 'sp-skip' : ''}"><td class="mono">${esc(r.token)}</td>
            <td class="mono">${r.item ? esc(r.item.code) : ''}</td><td>${r.item ? esc(r.item.description) : '<b>not found</b>'}</td>
            <td class="num">${r.item ? f2(r.old) : ''}</td><td class="num">${r.pct === null ? '—' : r.pct + '%'}</td><td class="num"><b>${f2(r.newPrice)}</b></td>
            <td class="num">${r.item && r.item.stock !== null && r.item.stock !== undefined ? esc(String(Math.round(Number(r.item.stock) * 100) / 100)) : ''}</td></tr>`).join('')}</tbody></table></div>`;
        $('piCount').textContent = `${ready.length} item${ready.length === 1 ? '' : 's'} ready`;
        $('piOk').disabled = !ready.length;
        $('piOk').textContent = ready.length ? `${okLabel} (${ready.length})` : okLabel;
      };
      $('piOk').onclick = () => done({ rows: ready });
      setTimeout(() => $('piText').focus(), 30);
    });
  }
  window.PasteItems = { open };
})();
