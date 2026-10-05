/* ============================================================
   Tools › Sell-out & promotion check (owner, 2026-10-05).
   Import the system's export of the items on promotion (e.g. "Export to
   Excel": Item, Description, Type Of Sell, Sale Price, Old Price…) and
   compare every item code with the sell-outs and promotions running in
   the app now. Only the items that are in NONE of them are marked —
   each with where it was last seen (a sell-out or promotion that ended),
   if anywhere. Download: the list of the items not found, or the file as
   it came with a "Check" column (NOT FOUND on those rows).
   Prices (owner, 2026-10-05): an item found in the app whose price in the
   file is not the app's promo price (in any of the sell-outs / promotions
   it is in) is listed apart, with both prices. Items sold by the kilo (/KG):
   a promotion price for 200 g or 100 g (x5 / x10 = the file's price per kg)
   is the same price.
   Codes match with or without leading zeros ("0124" = "124").
   Stock (owner, 2026-10-06): the flagged items show their stock at Ajaltoun now, read live from the La Valeur
   Dashboard (server function lv-dashboard); 0 is marked.
   Everything runs in this browser; nothing is changed in the app.
   Public API: window.Reconcile = { mount(container) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const key = c => { const s = String(c ?? '').trim().replace(/\.0+$/, ''); return s.replace(/^0+(?=\d)/, '').toUpperCase(); };
  const num = v => { if (v === null || v === undefined || v === '') return null; const x = Number(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(x) ? x : null; };
  const money = v => v === null ? '—' : (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const norm = h => String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const CODE_HEADERS = ['item', 'code', 'item code', 'itemcode', 'item no', 'item number', 'article', 'sku'];
  const R = { host: null, file: null, rows: null, header: null, cols: null, result: null, busy: false };
  const el = id => document.getElementById(id);

  /* ---------------- the file ---------------- */
  // The header row: the first row (of the first 15) with an item / code column.
  function readSheet(wb) {
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
      for (let h = 0; h < Math.min(15, aoa.length); h++) {
        const row = aoa[h].map(norm), ci = row.findIndex(c => CODE_HEADERS.includes(c));
        if (ci < 0) continue;
        const find = (...names) => { for (const n of names) { const i = row.findIndex((c, j) => j !== ci && c === n); if (i >= 0) return i; } return -1; };
        const descs = row.map((c, j) => c === 'description' ? j : -1).filter(j => j >= 0);
        const cols = {
          code: ci, desc: descs[0] ?? find('item description', 'name'),
          type: find('type of sell', 'type'), typeDesc: descs.length > 1 ? descs[1] : -1,
          price: find('sale price', 'price', 'promo price', 'unit price'), old: find('old price', 'before price'),
          from: find('date from', 'from'), to: find('date to', 'to'), group: find('group'), sub: find('sub group'),
        };
        const rows = aoa.slice(h + 1).filter(r => String(r[ci] ?? '').trim() !== '');
        return { sheet: name, header: aoa[h], cols, rows, headerIndex: h, aoa };
      }
    }
    return null;
  }

  /* ---------------- what the app has ---------------- */
  async function loadApp() {
    const today = todayStr();
    const [{ data: so, error: e1 }, { data: pr, error: e2 }] = await Promise.all([
      sb.from('sellouts').select('id, name, from, to, active, archived, online, items, priced_items, price_column'),
      sb.from('promotions').select('id, name, from_date, to_date, archived'),
    ]);
    if (e1 || e2) throw e1 || e2;
    const promos = pr || [];
    const { data: rows, error: e3 } = promos.length ? await sb.from('promotion_rows').select('promotion_id, code, promo_price') : { data: [] };
    if (e3) throw e3;
    const now = new Map(), past = new Map();   // code key -> [where]
    const put = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    (so || []).forEach(s => {
      const live = s.active && !s.archived;
      const shape = { items: s.items || [], pricedItems: Array.isArray(s.priced_items) ? s.priced_items : null, priceColumn: s.price_column };
      let codes = [];
      try { codes = pricedRowsOf(shape).map(p => ({ code: p.code, price: p.newPrice })); } catch (e) { codes = []; }
      codes.forEach(c => put(live ? now : past, key(c.code), { kind: s.online ? 'Online sell-out' : 'Sell-out', name: s.name, to: s.to, archived: s.archived, price: num(c.price) }));
    });
    const byId = new Map(promos.map(p => [p.id, p]));
    (rows || []).forEach(r => {
      const p = byId.get(r.promotion_id); if (!p) return;
      const live = !p.archived && (!p.from_date || p.from_date <= today) && (!p.to_date || p.to_date >= today);
      put(live ? now : past, key(r.code), { kind: 'Promotion', name: p.name, to: p.to_date, archived: p.archived, price: num(r.promo_price) });
    });
    return { now, past, sellouts: (so || []).filter(s => s.active && !s.archived).length, promotions: promos.filter(p => !p.archived && (!p.from_date || p.from_date <= today) && (!p.to_date || p.to_date >= today)).length };
  }

  /* ---------------- page ---------------- */
  function mount(host) {
    R.host = host;
    host.innerHTML = `
      <div class="card tool-card">
        <p class="muted-note" style="margin:0 0 14px;">Import the system's list of items on promotion. Each item code is compared with the sell-outs and promotions running in the app now, and <b>only the items found in none of them are marked</b>. Nothing is changed in the app.</p>
        <label class="tool-drop" id="rcDrop">
          <input type="file" id="rcFile" accept=".xlsx,.xls,.csv" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13l2 2 4-4"/></svg>
          <b>Choose the Excel file</b><span class="muted-note">or drop it here · .xlsx, .xls, .csv</span>
        </label>
      </div>
      <div id="rcOut"></div>`;
    const drop = el('rcDrop');
    el('rcFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) run(f); };
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) run(f); });
    if (R.result) renderResult();
  }

  async function run(file) {
    if (R.busy) return;
    R.busy = true;
    el('rcOut').innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Comparing…</p></div>';
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = readSheet(wb);
      if (!sheet) throw new Error('No column named Item or Code was found in this file.');
      const app = await loadApp();
      const c = sheet.cols, cell = (r, i) => i >= 0 ? String(r[i] ?? '').trim() : '';
      const realDate = v => v && !/^0?1\/0?1\/1900/.test(v) ? v.split(' ')[0] : '';
      const items = sheet.rows.map((r, i) => {
        const k = key(r[c.code]);
        const seen = app.past.get(k) || [];
        const last = seen.slice().sort((a, b) => String(b.to || '').localeCompare(String(a.to || '')))[0] || null;
        return { i, code: cell(r, c.code), desc: cell(r, c.desc), type: [cell(r, c.type), cell(r, c.typeDesc)].filter(Boolean).join(' · '),
          price: cell(r, c.price), old: cell(r, c.old), from: realDate(cell(r, c.from)), to: realDate(cell(r, c.to)),
          group: [cell(r, c.group), cell(r, c.sub)].filter(Boolean).join(' › '),
          found: app.now.get(k) || null, last };
      });
      items.forEach(x => {
        if (!x.found) return;
        const fp = num(x.price), withPrice = x.found.filter(w => w.price !== null);
        x.filePrice = fp;
        // Items sold by the kilo: the promotion often gives the price of 200 g or 100 g (2.10 = 10.50 / kg): the same price.
        const perKg = /\/\s*KG\b|\bPER\s*KG\b/i.test(x.desc);
        const same = w => Math.abs(w.price - fp) < 0.005 || (perKg && [5, 10].some(m => Math.abs(w.price * m - fp) < 0.011));
        x.priceOff = fp !== null && withPrice.length > 0 && !withPrice.some(same);
      });
      R.file = file.name; R.sheet = sheet; R.result = { items, app }; R.stock = {};
      logActivity('tools', 'reconcile', null, `Checked ${items.length} promotion items from "${file.name}" against the sell-outs and promotions: ${items.filter(x => !x.found).length} not found, ${items.filter(x => x.priceOff).length} with a different price`);
      renderResult();
    } catch (err) {
      console.error(err);
      el('rcOut').innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(err.message || 'Could not read this file.')}</p></div>`;
    } finally { R.busy = false; }
  }

  function renderResult() {
    const { items, app } = R.result;
    const miss = items.filter(x => !x.found), found = items.length - miss.length, off = items.filter(x => x.priceOff);
    const dup = new Map(); items.forEach(x => dup.set(key(x.code), (dup.get(key(x.code)) || 0) + 1));
    el('rcOut').innerHTML = `
      <div class="card rc-sum">
        <div class="rc-stats">
          <div><b>${items.length}</b><span>items in the file</span></div>
          <div class="ok"><b>${found}</b><span>in a running sell-out or promotion</span></div>
          <div class="${miss.length ? 'bad' : 'ok'}"><b>${miss.length}</b><span>not found</span></div>
          <div class="${off.length ? 'warn' : 'ok'}"><b>${off.length}</b><span>found, but the price differs</span></div>
        </div>
        <p class="muted-note" style="margin:10px 0 0;">"${esc(R.file)}" · compared with ${app.sellouts} running sell-out${app.sellouts === 1 ? '' : 's'} and ${app.promotions} running promotion${app.promotions === 1 ? '' : 's'}.</p>
        <div class="rc-actions">
          <button type="button" class="btn small" id="rcExportMiss" ${miss.length ? '' : 'disabled'}>Download the ${miss.length} not found</button>
          <button type="button" class="btn small" id="rcExportOff" ${off.length ? '' : 'disabled'}>Download the ${off.length} with a different price</button>
          <button type="button" class="btn secondary small" id="rcExportAll">Download the file with the marks</button>
        </div>
      </div>
      ${miss.length ? `<div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items rc-table">
        <thead><tr><th>Code</th><th>Description</th><th>Type</th><th class="num">Price</th><th class="num">Old price</th><th>Group</th><th class="num">Stock</th><th>Last seen in the app</th></tr></thead>
        <tbody>${miss.map(x => `<tr><td class="mono"><b>${esc(x.code)}</b>${dup.get(key(x.code)) > 1 ? ' <span class="badge warn">twice</span>' : ''}</td><td>${esc(x.desc)}</td><td class="rc-type">${esc(x.type)}</td>
          <td class="num">${esc(x.price)}</td><td class="num">${esc(x.old)}</td><td class="rc-group">${esc(x.group)}</td><td class="num rc-stock" data-stock="${esc(x.code)}"><span class="muted-note">…</span></td>
          <td>${x.last ? `${esc(x.last.kind)} <b>${esc(x.last.name)}</b>${x.last.to ? ` · ended ${esc(fmtDate(String(x.last.to).slice(0, 10)))}` : ''}${x.last.archived ? ' · archived' : ''}` : '<span class="rc-never">never</span>'}</td></tr>`).join('')}</tbody>
      </table></div></div>` : '<div class="card"><p style="margin:0;"><b>Every item in the file is in a running sell-out or promotion.</b></p></div>'}
      ${off.length ? `<h4 class="cc-h" style="margin:18px 0 8px;">Found, but the price is not the same</h4>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items rc-table rc-off">
        <thead><tr><th>Code</th><th>Description</th><th class="num">Price in the file</th><th class="num">Price in the app</th><th class="num">Gap</th><th class="num">Stock</th><th>Where</th></tr></thead>
        <tbody>${off.map(x => { const w = x.found.filter(y => y.price !== null), best = w.slice().sort((a, b) => Math.abs(a.price - x.filePrice) - Math.abs(b.price - x.filePrice))[0];
          return `<tr><td class="mono"><b>${esc(x.code)}</b></td><td>${esc(x.desc)}</td><td class="num">${money(x.filePrice)}</td>
          <td class="num">${w.map(y => money(y.price)).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}</td>
          <td class="num ${x.filePrice > best.price ? 'rc-up' : 'rc-down'}">${x.filePrice > best.price ? '+' : '-'}${money(Math.abs(x.filePrice - best.price))}</td>
          <td class="num rc-stock" data-stock="${esc(x.code)}"><span class="muted-note">…</span></td>
          <td>${w.map(y => `${esc(y.kind)} <b>${esc(y.name)}</b>`).join('<br>')}</td></tr>`; }).join('')}</tbody>
      </table></div></div>` : ''}`;
    el('rcExportMiss').onclick = () => exportMissing(miss);
    el('rcExportOff').onclick = () => exportOff(off);
    const flagged = [...new Set([...off, ...miss].map(x => x.code))];
    R.flagged = flagged;
    fillStock(flagged.slice(0, STOCK_AUTO));
  }
  // Live stock (lv-dashboard), kept for this file. One lookup per item on the dashboard, a few at a time (light on
  // their server): the first STOCK_AUTO flagged items by themselves, the rest with "Show the stock of all".
  const STOCK_AUTO = 60, STOCK_BATCH = 60;
  async function fillStock(codes) {
    R.stock = R.stock || {};
    const want = [...new Set(codes)].filter(c => !(c in R.stock));
    for (let i = 0; i < want.length; i += STOCK_BATCH) {
      const part = want.slice(i, i + STOCK_BATCH);
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'items_stock', codes: part } });
        if (error || !data?.stock) throw error || new Error('no stock');
        Object.assign(R.stock, data.stock);
      } catch (e) { console.warn('stock', e); part.forEach(c => { R.stock[c] = undefined; }); }
      paintStock();
    }
    paintStock();
  }
  function paintStock() {
    const left = (R.flagged || []).filter(c => !(c in (R.stock || {}))).length;
    let bar = document.getElementById('rcStockMore');
    if (left && !bar) {
      document.querySelector('#rcOut .rc-actions')?.insertAdjacentHTML('beforeend', '<button type="button" class="btn secondary small" id="rcStockMore"></button>');
      bar = document.getElementById('rcStockMore');
      bar.onclick = () => { bar.disabled = true; bar.textContent = 'Loading the stock…'; fillStock(R.flagged); };
    }
    if (bar && !left) bar.remove();
    else if (bar && !bar.disabled) bar.textContent = `Show the stock of all (${left} more)`;
    else if (bar) bar.textContent = `Loading the stock… ${left} left`;
    document.querySelectorAll('#rcOut [data-stock]').forEach(td => {
      if (!(td.dataset.stock in (R.stock || {}))) { td.innerHTML = '<span class="muted-note">·</span>'; return; }
      const v = R.stock[td.dataset.stock];
      td.innerHTML = v === undefined ? '<span class="muted-note" title="The dashboard did not answer">—</span>'
        : v === null ? '<span class="muted-note" title="Not found in the system">?</span>'
        : Number(v) <= 0 ? '<span class="rc-zero" title="Nothing in stock">0</span>' : (Math.round(Number(v) * 100) / 100).toLocaleString('en-US');
    });
    el('rcExportAll').onclick = exportMarked;
  }

  function exportOff(off) {
    const aoa = [['Code', 'Description', 'Price in the file', 'Price in the app', 'Where']];
    off.forEach(x => { const w = x.found.filter(y => y.price !== null);
      aoa.push([x.code, x.desc, x.filePrice, w.map(y => y.price).filter((v, i, a) => a.indexOf(v) === i).join(' / '), w.map(y => `${y.kind} ${y.name}`).join(', ')]); });
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 10 }, { wch: 44 }, { wch: 16 }, { wch: 16 }, { wch: 40 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Price differs');
    XLSX.writeFile(wb, `price-differs-${todayStr()}.xlsx`);
  }
  function exportMissing(miss) {
    const aoa = [['Code', 'Description', 'Type', 'Price', 'Old price', 'Group', 'Stock', 'Last seen in the app']];
    miss.forEach(x => aoa.push([x.code, x.desc, x.type, x.price, x.old, x.group, R.stock?.[x.code] ?? '', x.last ? `${x.last.kind} ${x.last.name}${x.last.to ? ', ended ' + String(x.last.to).slice(0, 10) : ''}` : 'never']));
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 10 }, { wch: 44 }, { wch: 22 }, { wch: 9 }, { wch: 9 }, { wch: 12 }, { wch: 40 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Not found');
    XLSX.writeFile(wb, `not-found-${todayStr()}.xlsx`);
  }
  // The file as it came, with a "Check" column: NOT FOUND on the items in no running sell-out or promotion.
  function exportMarked() {
    const s = R.sheet, items = R.result.items, out = s.aoa.map(r => [...r]);
    out[s.headerIndex].push('Check');
    let k = 0;
    for (let r = s.headerIndex + 1; r < out.length; r++) {
      if (String(out[r][s.cols.code] ?? '').trim() === '') continue;
      const x = items[k++];
      out[r][s.header.length] = !x ? '' : !x.found ? 'NOT FOUND'
        : x.priceOff ? 'PRICE DIFFERS (app ' + x.found.filter(y => y.price !== null).map(y => money(y.price)).filter((v, i, a) => a.indexOf(v) === i).join(' / ') + ')' : '';
    }
    const ws = XLSX.utils.aoa_to_sheet(out);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, (s.sheet || 'Sheet1').slice(0, 31));
    XLSX.writeFile(wb, R.file.replace(/\.(xlsx|xls|csv)$/i, '') + '-checked.xlsx');
  }

  window.Reconcile = { mount };
})();
