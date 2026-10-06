/* ============================================================
   Pick items from the system (owner, 2026-10-06): choose by supplier,
   brand, group, sub-group or section (the system's own lists, searchable,
   several at once), see their items (what was sold or bought this year at
   Ajaltoun), tick the ones you want. Or one by one (owner, 2026-10-06): the Item tab searches a code,
   a barcode or a name; each item ticked is kept while searching for the next. Used by:
     - Promotions: "Add from the system" adds the ticked items as rows;
     - Sell-outs: "Pick from the system" makes the new sell-out's item file.
   Live from the system (lv-dashboard: filter_options, items_by, items_info).
   Public API: window.ItemPicker = { open({ title, okLabel, withPrices }) } -> Promise<{ items, by } | null>
     items: [{ code, description, sold, bought, ...prices when withPrices }]; by: { field, names }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const FIELDS = [['item', 'Item'], ['supplier', 'Supplier'], ['brand', 'Brand'], ['group', 'Group'], ['subgroup', 'Sub-group'], ['section', 'Section']];
  const call = async body => { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error) throw error; return data; };
  const fq = v => (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-US');

  function open({ title = 'Add items from the system', okLabel = 'Add', withPrices = false } = {}) {
    return new Promise(resolve => {
      document.getElementById('ipOverlay')?.remove();
      document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="ipOverlay"><div class="modal-box ip-box" role="dialog" aria-modal="true">
        <div class="ip-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-ip="close" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="filter-row ip-fields" id="ipFields">${FIELDS.map(([k, l]) => `<button type="button" data-f="${k}" class="${k === 'supplier' ? 'active' : ''}">${l}</button>`).join('')}</div>
        <div class="ip-search"><input type="search" id="ipQ" placeholder="Search a supplier…" autocomplete="off"></div>
        <div class="ip-chosen" id="ipChosen"></div>
        <div class="ip-options" id="ipOptions"><p class="muted-note">Type to search.</p></div>
        <div class="ip-items" id="ipItems" hidden></div>
        <div class="ip-foot"><span class="muted-note" id="ipCount"></span><span style="flex:1"></span>
          <button type="button" class="btn secondary" id="ipShow" disabled>Show the items</button>
          <button type="button" class="btn" id="ipOk" disabled>${esc(okLabel)}</button></div>
      </div></div>`);
      const ov = document.getElementById('ipOverlay'), $ = id => document.getElementById(id);
      const S = { field: 'supplier', chosen: new Map(), items: [], ticked: new Set(), filter: '', basket: new Map() };
      let timer = null, seq = 0;
      const done = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', onKey);
      ov.addEventListener('click', e => { if (e.target === ov || e.target.closest('[data-ip="close"]')) done(null); });

      const label = () => FIELDS.find(f => f[0] === S.field)[1].toLowerCase();
      // the Item tab: the items ticked so far (kept while searching for the next one)
      const paintBasket = () => {
        $('ipChosen').innerHTML = [...S.basket.values()].map(i => `<span class="ip-chip" title="${esc(i.code)}">${esc(i.description || i.code)}<button type="button" data-unitem="${esc(i.code)}" aria-label="Remove">×</button></span>`).join('');
        $('ipCount').textContent = S.basket.size ? `${S.basket.size} item${S.basket.size === 1 ? '' : 's'} chosen` : '';
        $('ipOk').disabled = !S.basket.size; $('ipShow').hidden = true;
      };
      const searchItems = async () => {
        const my = ++seq, q = $('ipQ').value.trim();
        if (q.length < 2) { $('ipOptions').innerHTML = '<p class="muted-note">Type a code, a barcode or part of the name (2 letters at least).</p>'; return; }
        $('ipOptions').innerHTML = '<p class="muted-note">Searching…</p>';
        try {
          const { items } = await call({ action: 'item_search', search: q });
          if (my !== seq) return;
          $('ipOptions').innerHTML = (items || []).length ? items.map(i => `<button type="button" class="ip-opt ip-item ${S.basket.has(i.code) ? 'on' : ''}" data-item="${esc(i.code)}" data-desc="${esc(String(i.description || '').trim())}" data-bc="${esc((i.barcodes || [])[0] || '')}">
              <span>${esc(String(i.description || '').trim())}${i.size ? ` <span class="muted-note">${esc(i.size)}</span>` : ''}</span>
              <span class="muted-note mono">${esc(i.code)}${(i.barcodes || [])[0] ? ' · ' + esc(i.barcodes[0]) : ''}${i.stock !== null && i.stock !== undefined ? ' · stock ' + fq(i.stock) : ''}</span></button>`).join('')
            : '<p class="muted-note">Nothing found.</p>';
        } catch (e) { if (my === seq) $('ipOptions').innerHTML = '<p class="login-err">The system did not answer.</p>'; }
      };
      const paintChosen = () => {
        $('ipChosen').innerHTML = [...S.chosen.entries()].filter(([c, nm], i, a) => a.findIndex(x => x[1].trim().toUpperCase() === nm.trim().toUpperCase()) === i).map(([c, nm]) => `<span class="ip-chip">${esc(nm)}<button type="button" data-unpick="${esc(c)}" aria-label="Remove">×</button></span>`).join('');
        $('ipShow').disabled = !S.chosen.size;
      };
      const search = async () => {
        if (S.field === 'item') return searchItems();
        const my = ++seq, q = $('ipQ').value.trim();
        $('ipOptions').innerHTML = '<p class="muted-note">Searching…</p>';
        try {
          const { options } = await call({ action: 'filter_options', field: S.field, q });
          if (my !== seq) return;
          $('ipOptions').innerHTML = options.length ? options.map(o => `<button type="button" class="ip-opt ${S.chosen.has(o.code) ? 'on' : ''}" data-pick="${esc(o.code)}" data-name="${esc(o.name.trim() || o.code)}">${esc(o.name.trim() || o.code)} <span class="muted-note">${esc(o.code)}</span></button>`).join('')
            : '<p class="muted-note">Nothing found.</p>';
        } catch (e) { if (my === seq) $('ipOptions').innerHTML = '<p class="login-err">The system did not answer.</p>'; }
      };
      $('ipFields').onclick = e => {
        const b = e.target.closest('[data-f]'); if (!b) return;
        S.field = b.dataset.f; S.chosen.clear(); S.items = []; S.ticked.clear();
        $('ipFields').querySelectorAll('[data-f]').forEach(x => x.classList.toggle('active', x === b));
        $('ipQ').placeholder = S.field === 'item' ? 'Search an item: code, barcode or name…' : `Search a ${label()}…`; $('ipQ').value = '';
        $('ipItems').hidden = true; $('ipOptions').hidden = false; $('ipOk').disabled = true; $('ipCount').textContent = ''; $('ipShow').hidden = false;
        if (S.field === 'item') paintBasket(); else { S.basket.clear(); paintChosen(); }
        search(); $('ipQ').focus();
      };
      $('ipQ').oninput = () => { clearTimeout(timer); timer = setTimeout(search, 300); };
      $('ipOptions').onclick = e => {
        const it = e.target.closest('[data-item]');
        if (it) { const c = it.dataset.item; if (S.basket.has(c)) S.basket.delete(c); else S.basket.set(c, { code: c, description: it.dataset.desc, barcodes: it.dataset.bc ? [it.dataset.bc] : [], sold: 0, bought: 0 });
          it.classList.toggle('on', S.basket.has(c)); paintBasket(); return; }
        const b = e.target.closest('[data-pick]'); if (!b) return;
        // the system can list one name under several codes (two "DIVELLA" brands): one click takes them all
        const on = !S.chosen.has(b.dataset.pick);
        $('ipOptions').querySelectorAll('[data-pick]').forEach(x => {
          if (x.dataset.name.trim().toUpperCase() !== b.dataset.name.trim().toUpperCase()) return;
          if (on) S.chosen.set(x.dataset.pick, x.dataset.name); else S.chosen.delete(x.dataset.pick);
          x.classList.toggle('on', on);
        });
        paintChosen();
      };
      $('ipChosen').onclick = e => {
        const u = e.target.closest('[data-unitem]');
        if (u) { S.basket.delete(u.dataset.unitem); $('ipOptions').querySelector(`[data-item="${CSS.escape(u.dataset.unitem)}"]`)?.classList.remove('on'); paintBasket(); return; }
        const b = e.target.closest('[data-unpick]'); if (!b) return; const nm = (S.chosen.get(b.dataset.unpick) || '').trim().toUpperCase(); [...S.chosen.entries()].forEach(([c, x]) => { if (x.trim().toUpperCase() === nm) S.chosen.delete(c); }); paintChosen(); search(); };

      const paintItems = () => {
        const f = S.filter.toLowerCase(), shown = S.items.filter(i => !f || i.code.toLowerCase().includes(f) || i.description.toLowerCase().includes(f));
        $('ipItems').innerHTML = `<div class="ip-items-bar"><input type="search" id="ipFilter" placeholder="Filter these items…" value="${esc(S.filter)}">
            <button type="button" class="btn ghost small" id="ipAll">All</button><button type="button" class="btn ghost small" id="ipNone">None</button>
            <button type="button" class="btn ghost small" id="ipBack">Change the choice</button></div>
          <div class="items-scroll ip-scroll"><table class="items ip-table"><thead><tr><th></th><th>Code</th><th>Description</th><th class="num">Sold this year</th><th class="num">Bought</th></tr></thead>
          <tbody>${shown.map(i => `<tr><td><input type="checkbox" data-tick="${esc(i.code)}" ${S.ticked.has(i.code) ? 'checked' : ''}></td><td class="mono">${esc(i.code)}</td><td>${esc(i.description)}</td><td class="num">${fq(i.sold)}</td><td class="num">${fq(i.bought)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="empty-note">No item.</td></tr>'}</tbody></table></div>`;
        $('ipCount').textContent = `${S.ticked.size} of ${S.items.length} item${S.items.length === 1 ? '' : 's'} ticked`;
        $('ipOk').disabled = !S.ticked.size;
        $('ipFilter').oninput = e => { S.filter = e.target.value; const pos = e.target.selectionStart; paintItems(); const x = $('ipFilter'); x.focus(); x.setSelectionRange(pos, pos); };
        $('ipAll').onclick = () => { shown.forEach(i => S.ticked.add(i.code)); paintItems(); };
        $('ipNone').onclick = () => { shown.forEach(i => S.ticked.delete(i.code)); paintItems(); };
        $('ipBack').onclick = () => { $('ipItems').hidden = true; $('ipOptions').hidden = false; $('ipOk').disabled = true; $('ipCount').textContent = ''; $('ipShow').hidden = false; };
        $('ipItems').querySelectorAll('[data-tick]').forEach(c => c.onchange = () => { if (c.checked) S.ticked.add(c.dataset.tick); else S.ticked.delete(c.dataset.tick); $('ipCount').textContent = `${S.ticked.size} of ${S.items.length} items ticked`; $('ipOk').disabled = !S.ticked.size; });
      };
      $('ipShow').onclick = async () => {
        $('ipShow').disabled = true; $('ipShow').textContent = 'Loading…';
        try {
          const { items } = await call({ action: 'items_by', field: S.field, codes: [...S.chosen.keys()] });
          S.items = (items || []).map(i => ({ ...i, description: String(i.description || '').trim() }));
          S.ticked = new Set(S.items.map(i => i.code)); S.filter = '';
          $('ipOptions').hidden = true; $('ipItems').hidden = false; $('ipShow').hidden = true;
          paintItems();
        } catch (e) { showToast('The system did not answer.', true); }
        finally { $('ipShow').disabled = !S.chosen.size; $('ipShow').textContent = 'Show the items'; }
      };
      $('ipOk').onclick = async () => {
        let picked = S.field === 'item' ? [...S.basket.values()] : S.items.filter(i => S.ticked.has(i.code));
        if (withPrices) {
          $('ipOk').disabled = true;
          const info = {};
          try {
            for (let i = 0; i < picked.length; i += 100) {
              $('ipOk').textContent = `Reading the prices… ${Math.min(i + 100, picked.length)} / ${picked.length}`;
              Object.assign(info, (await call({ action: 'items_info', codes: picked.slice(i, i + 100).map(x => x.code) })).items || {});
            }
          } catch (e) { showToast('The system did not answer for the prices.', true); $('ipOk').disabled = false; $('ipOk').textContent = okLabel; return; }
          picked = picked.map(x => ({ ...x, ...(info[x.code] || {}), description: info[x.code]?.description || x.description }));
        }
        done({ items: picked, by: { field: S.field, names: S.field === 'item' ? (picked.length === 1 ? [picked[0].description] : []) : [...new Set([...S.chosen.values()].map(x => x.trim()))] } });
      };
      paintChosen(); search(); setTimeout(() => $('ipQ').focus(), 30);
    });
  }
  window.ItemPicker = { open };
})();
