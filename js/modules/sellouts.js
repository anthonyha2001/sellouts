/* ============================================================
   Sell-outs (PLAN §6): import with column mapping, pricing
   (percent / amount off / fixed price, per-row overrides), notes,
   filters, manual archiving, duplicating, Excel export.
   Shared state (sellouts, currentFilter, openIds, editingSelloutId)
   and the data layer (idbPut, updateSelloutFields, loadAll) are in app.js.
   ============================================================ */

const PRICE_MODES = {
  percent: { label: 'Percentage off', short: '% off', placeholder: 'e.g. 20' },
  amount:  { label: 'Fixed amount off', short: 'Amount off', placeholder: 'e.g. 0.50' },
  fixed:   { label: 'Fixed final price', short: 'Fixed', placeholder: 'e.g. 2.95' },
  manual:  { label: 'Set by hand', short: 'Manual' },
  file:    { label: 'From the file', short: 'From file' },
};
const BIG_SELLOUT_DISCOUNT = 25;   // % — warn above this, like Promotions

// Header aliases, compared after lower-casing and removing everything but letters.
const PRICE_ALIASES = ['oldprice', 'saleprice', 'unitprice', 'retailprice', 'sellingprice', 'price', 'retail', 'prix', 'pu'];
const DESC_ALIASES = ['description', 'desc', 'itemdescription', 'itemname', 'productname', 'designation', 'libelle', 'article', 'product', 'name', 'item'];
// Many supplier files already carry the new price ("Promoted price", "Promo price"...). Plain
// "Promotion" is NOT one of them: in some files it is a percentage (e.g. 50).
const NEW_PRICE_ALIASES = ['promotedprice', 'promoprice', 'promotionprice', 'newprice', 'offerprice', 'specialprice', 'selloutprice', 'discountedprice', 'netprice'];
// Shelf prices are in USD (owner, 2026-09-29): an "old price" this big is almost certainly LBP.
const LBP_LOOKING_PRICE = 1000;
const normHeader = h => String(h ?? '').toLowerCase().replace(/[^a-z]/g, '');

function itemColumns(items) {
  if (!items || !items.length) return [];
  const cols = new Set();
  items.forEach(row => Object.keys(row).forEach(k => cols.add(k)));
  return Array.from(cols);
}

// Code = first column (as before). Description, old price and (optional) new price by header name.
// The new-price column is found first so "Promoted price" is never taken as the old price.
function detectColumns(items) {
  const cols = itemColumns(items);
  const find = (aliases, exclude) => {
    for (const a of aliases) { const c = cols.find(c => !exclude.includes(c) && normHeader(c) === a); if (c) return c; }
    for (const a of aliases) { const c = cols.find(c => !exclude.includes(c) && normHeader(c).includes(a)); if (c) return c; }
    return null;
  };
  const code = cols[0] || null;
  const description = find(DESC_ALIASES, [code]);
  const newPrice = find(NEW_PRICE_ALIASES, [code, description]);
  const price = find(PRICE_ALIASES, [code, description, newPrice]);
  const barcode = cols.find(c => c !== code && BARCODE_HEADERS.includes(normHeader(c))) || null;
  return { code, description, price, newPrice, barcode };
}

function buildPricedItems(items, map) {
  return items.map((r, i) => {
    const fromFile = map.newPrice ? parseNum(r[map.newPrice]) : null;
    return {
      row: i,
      code: String(r[map.code] ?? '').trim(),
      description: map.description ? String(r[map.description] ?? '').trim() : '',
      oldPrice: map.price ? parseNum(r[map.price]) : null,
      barcode: map.barcode ? (splitBarcodes(r[map.barcode])[0] || '') : '',
      mode: fromFile !== null ? 'file' : null, value: null,
      newPrice: fromFile !== null ? round2(fromFile) : null,
    };
  });
}

// Priced rows of a sell-out; older sell-outs (before pricing existed) get them from their file on the fly,
// including the new price when the file has a "Promoted price"-type column.
function pricedRowsOf(so) {
  if (so.pricedItems && so.pricedItems.length === so.items.length) return so.pricedItems;
  const map = detectColumns(so.items);
  if (so.priceColumn) map.price = so.priceColumn;
  so.pricedItems = buildPricedItems(so.items, map);
  so.priceColumn = map.price;
  return so.pricedItems;
}

function computeNewPrice(oldPrice, mode, value) {
  if (mode === 'fixed' || mode === 'manual') return round2(value);
  if (oldPrice === null || oldPrice === undefined) return null;
  if (mode === 'percent') return round2(mround(oldPrice * (1 - value / 100), 0.05));
  if (mode === 'amount') return round2(mround(oldPrice - value, 0.05));
  return null;
}
function discountPct(p) {
  if (p.oldPrice === null || p.newPrice === null || !p.oldPrice) return null;
  return Math.round(((p.oldPrice - p.newPrice) / p.oldPrice) * 1000) / 10;
}
function priceWarnings(p) {
  const w = [];
  if (p.oldPrice === null) w.push('Missing old price');
  else if (p.oldPrice >= LBP_LOOKING_PRICE) w.push('Old price looks like LBP: choose the USD price column');
  if (p.newPrice !== null) {
    if (p.newPrice <= 0) w.push('New price is zero or below');
    else if (p.oldPrice !== null && p.newPrice >= p.oldPrice) w.push('New price is not lower than the old price');
    const d = discountPct(p);
    if (d !== null && d > BIG_SELLOUT_DISCOUNT) w.push(`Discount above ${BIG_SELLOUT_DISCOUNT}%`);
  }
  return w;
}

/* ---------------- status, flags, filters ---------------- */
function selloutStatusBadge(so) {
  if (so.archived) return '<span class="badge inactive">Archived</span>';
  if (so.active) return '<span class="badge active">Active</span>';
  if (so.from > todayStr()) return '<span class="badge inactive">Upcoming</span>';
  return '<span class="badge inactive">Inactive</span>';
}

// The "To" date is INCLUDED: the sell-out runs through that day and is switched off the next morning
// (owner, 2026-09-30).
// 'activate'   = start date reached, still inactive, not ended yet
// 'deactivate' = the day after the end date (or later), still active
// 'archive'    = ended, deactivated, not yet confirmed removed from the store system
function actionFlag(so) {
  if (so.archived) return null;
  const today = todayStr();
  const daysToStart = daysBetween(today, so.from);
  const daysToEnd = daysBetween(today, so.to);
  if (!so.active && daysToStart <= 0 && daysToEnd >= 0) return 'activate';
  if (so.active && daysToEnd < 0) return 'deactivate';
  if (!so.active && daysToEnd < 0) return 'archive';
  return null;
}
// Its last day (To = today, still active): nothing to do yet — a reminder, not an action.
const isLastDay = so => !so.archived && so.active && daysBetween(todayStr(), so.to) === 0;
const FLAG_LABELS = { activate: ['warn', 'Needs activation'], deactivate: ['danger', 'Needs deactivation'], archive: ['warn', 'Needs archiving'] };
function actionFlagHtml(so) {
  const flag = actionFlag(so);
  if (!flag && isLastDay(so)) return `<span class="action-flag info" title="The To date is included: switch it off tomorrow (${fmtDate(addDaysStr(so.to, 1))})">Last day — deactivate tomorrow</span>`;
  if (!flag) return '';
  const [cls, label] = FLAG_LABELS[flag];
  return `<span class="action-flag ${cls}"><span class="pulse"></span>${label}</span>`;
}

function applyFilter(list) {
  const today = todayStr();
  if (currentFilter === 'archived') return list.filter(s => s.archived);
  const live = list.filter(s => !s.archived);
  if (currentFilter === 'active') return live.filter(s => s.active);
  if (currentFilter === 'upcoming') return live.filter(s => !s.active && s.from > today);
  if (currentFilter === 'needsaction') return live.filter(s => actionFlag(s));
  return live;   // 'all' = everything not archived
}

document.querySelectorAll('#selloutFilters button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#selloutFilters button').forEach(x => x.classList.toggle('active', x === b));
    currentFilter = b.dataset.filter;
    renderSellouts();
  });
});

function updateSelloutsPill() {
  const pill = document.getElementById('selloutsPill');
  const n = sellouts.filter(s => actionFlag(s)).length;
  pill.textContent = n;
  pill.hidden = !n;
}

/* ---------------- add: file -> column mapping -> save ---------------- */
let pendingImport = null;   // { items, map } while the Add form is open

function readSheetItems(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // raw:false keeps codes as the text shown in Excel (leading zeros survive); prices are parsed later.
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  // Barcode columns: Excel's display text can turn 5281018709276 into "5.28102E+12", so take the exact
  // number there (text cells stay as typed).
  const raw = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  const barcodeCols = itemColumns(rows).filter(c => BARCODE_HEADERS.includes(normHeader(c)));
  barcodeCols.forEach(c => rows.forEach((r, i) => {
    const v = raw[i]?.[c];
    if (typeof v === 'number' && Number.isFinite(v)) r[c] = String(Math.round(v));
  }));
  return rows;
}

function renderMappingStep() {
  const box = document.getElementById('soMapping');
  if (!pendingImport) { box.innerHTML = ''; return; }
  const { items, map } = pendingImport;
  const cols = itemColumns(items);
  const opts = sel => ['<option value="">— none —</option>'].concat(cols.map(c => `<option value="${escapeHtml(c)}" ${c === sel ? 'selected' : ''}>${escapeHtml(c)}</option>`)).join('');
  const preview = buildPricedItems(items.slice(0, 5), map);
  const all = buildPricedItems(items, map);
  const missingPrices = map.price ? all.filter(p => p.oldPrice === null).length : items.length;
  const lbpLooking = all.filter(p => p.oldPrice !== null && p.oldPrice >= LBP_LOOKING_PRICE).length;
  box.innerHTML = `
    <div class="so-mapping">
      <h4>Check the columns <span class="muted-note">(${items.length} item rows found)</span></h4>
      <div class="form-grid so-map-grid">
        <div><label for="soMapCode">Code</label><select id="soMapCode" data-map="code">${opts(map.code)}</select></div>
        <div><label for="soMapDesc">Description</label><select id="soMapDesc" data-map="description">${opts(map.description)}</select></div>
        <div><label for="soMapPrice">Old price (USD)</label><select id="soMapPrice" data-map="price">${opts(map.price)}</select></div>
        <div><label for="soMapNew">New price <span style="opacity:.6;">(if the file has it)</span></label><select id="soMapNew" data-map="newPrice">${opts(map.newPrice)}</select></div>
      </div>
      <div class="items-scroll" style="margin:12px 0 0;">
        <table class="items"><thead><tr><th>Code</th><th>Description</th><th>Old price</th><th>New price</th></tr></thead>
        <tbody>${preview.map(p => `<tr><td style="font-family:var(--font-mono);">${escapeHtml(p.code)}</td><td>${escapeHtml(p.description)}</td><td>${p.oldPrice === null ? '<span class="empty-note">—</span>' : p.oldPrice}</td><td>${p.newPrice === null ? '<span class="empty-note">—</span>' : p.newPrice.toFixed(2)}</td></tr>`).join('')}</tbody></table>
      </div>
      ${missingPrices ? `<p class="muted-note" style="margin:8px 0 0;color:var(--gold);">${missingPrices} row${missingPrices === 1 ? ' has' : 's have'} no old price in this column.</p>` : ''}
      ${lbpLooking ? `<p class="muted-note" style="margin:8px 0 0;color:var(--brick);">${lbpLooking} old price${lbpLooking === 1 ? ' looks' : 's look'} like LBP. Shelf prices are in USD: pick the USD price column.</p>` : ''}
    </div>`;
  box.querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', () => {
    pendingImport.map[sel.dataset.map] = sel.value || null;
    renderMappingStep();
  }));
}

document.getElementById('soFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  pendingImport = null;
  if (file) {
    try {
      const items = readSheetItems(await file.arrayBuffer());
      if (!items.length) showToast('That file has no item rows.', true);
      else pendingImport = { items, map: detectColumns(items) };
    } catch (err) {
      showToast('Could not read that file as Excel/CSV. Please check the format.', true);
    }
  }
  renderMappingStep();
});

document.getElementById('selloutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('soName').value.trim();
  const from = document.getElementById('soFrom').value;
  const to = document.getElementById('soTo').value;
  const note = document.getElementById('soNote').value.trim();
  const file = document.getElementById('soFile').files[0];
  if (!file || !pendingImport) { showToast('Choose an Excel file with item rows.', true); return; }
  if (new Date(to) < new Date(from)) {
    showToast('The "To" date is before the "From" date — please check the dates.', true);
    return;
  }
  const { items, map } = pendingImport;
  if (!map.code) { showToast('Pick the Code column.', true); return; }

  const record = {
    id: uid(), name, from, to, note, fileName: file.name, fileBlob: file, items,
    active: false, log: [], notifiedFlags: {},
    priceColumn: map.price, pricing: null, pricedItems: buildPricedItems(items, map),
    createdAt: new Date().toISOString()
  };
  await idbPut('sellouts', record);
  logActivity('sellouts', 'create', { type: 'sellout', id: record.id }, `Added sell-out "${name}" (${items.length} items)`,
    { from, to, columns: map });
  await loadAll();
  closeAddSelloutModal();
  showToast(`"${name}" added.`);
});

function openAddSelloutModal() {
  document.getElementById('addSelloutOverlay').classList.add('open');
  setTimeout(() => document.getElementById('soName').focus(), 30);
}
function closeAddSelloutModal() {
  document.getElementById('addSelloutOverlay').classList.remove('open');
  document.getElementById('selloutForm').reset();
  pendingImport = null;
  renderMappingStep();
}
document.getElementById('openAddSelloutBtn').addEventListener('click', openAddSelloutModal);
document.getElementById('closeAddSelloutBtn').addEventListener('click', closeAddSelloutModal);
document.getElementById('cancelAddSelloutBtn').addEventListener('click', closeAddSelloutModal);
document.getElementById('addSelloutOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'addSelloutOverlay') closeAddSelloutModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('addSelloutOverlay').classList.contains('open')) closeAddSelloutModal();
  if (document.getElementById('dupSelloutOverlay').classList.contains('open')) closeDuplicate();
});

/* ---------------- duplicate ---------------- */
let duplicatingId = null;
function openDuplicate(so) {
  duplicatingId = so.id;
  document.getElementById('dupName').value = so.name + ' (copy)';
  document.getElementById('dupFrom').value = '';
  document.getElementById('dupTo').value = '';
  document.getElementById('dupSelloutOverlay').classList.add('open');
  setTimeout(() => document.getElementById('dupFrom').focus(), 30);
}
function closeDuplicate() {
  duplicatingId = null;
  document.getElementById('dupSelloutOverlay').classList.remove('open');
}
document.getElementById('dupCancel').addEventListener('click', closeDuplicate);
document.getElementById('dupSelloutOverlay').addEventListener('click', e => { if (e.target.id === 'dupSelloutOverlay') closeDuplicate(); });
document.getElementById('dupSelloutForm').addEventListener('submit', async e => {
  e.preventDefault();
  const src = sellouts.find(s => s.id === duplicatingId);
  if (!src) return closeDuplicate();
  const name = document.getElementById('dupName').value.trim();
  const from = document.getElementById('dupFrom').value;
  const to = document.getElementById('dupTo').value;
  if (!name) { showToast('Name can’t be empty.', true); return; }
  if (new Date(to) < new Date(from)) { showToast('The "To" date is before the "From" date.', true); return; }
  const copy = {
    id: uid(), name, from, to, note: src.note, fileName: src.fileName, fileBlob: src.fileBlob,
    items: JSON.parse(JSON.stringify(src.items)),
    pricedItems: JSON.parse(JSON.stringify(pricedRowsOf(src))),
    pricing: src.pricing ? { ...src.pricing } : null, priceColumn: src.priceColumn,
    active: false, log: [], notifiedFlags: {}, archived: false, archivedAt: null, archivedBy: null,
    createdAt: new Date().toISOString()
  };
  await idbPut('sellouts', copy);
  logActivity('sellouts', 'duplicate', { type: 'sellout', id: copy.id }, `Duplicated "${src.name}" as "${name}"`, { source: src.id, from, to });
  closeDuplicate();
  currentFilter = 'all';
  document.querySelectorAll('#selloutFilters button').forEach(x => x.classList.toggle('active', x.dataset.filter === 'all'));
  openIds.add(copy.id);
  await loadAll();
  showToast(`"${name}" created.`);
});

/* ---------------- pricing panel ---------------- */
const pricingState = new Map();   // sellout id -> { view: 'pricing'|'file', selected: Set<row>, mode, value }
function stateOf(so) {
  if (!pricingState.has(so.id)) pricingState.set(so.id, {
    view: 'pricing', selected: new Set(), mode: so.pricing?.mode || 'percent', value: so.pricing?.value ?? '',
  });
  return pricingState.get(so.id);
}

async function savePricing(so) {
  return updateSelloutFields(so.id, { priced_items: so.pricedItems, pricing: so.pricing, price_column: so.priceColumn });
}

function pricingPanelHtml(so) {
  const st = stateOf(so);
  const rows = pricedRowsOf(so);
  const cols = itemColumns(so.items);
  const warnCount = rows.filter(p => priceWarnings(p).length).length;
  const priced = rows.filter(p => p.newPrice !== null).length;
  const allSel = rows.length && st.selected.size === rows.length;
  return `
    <div class="so-price-controls">
      <div><label>Rule</label><select data-role="price-mode">${['percent', 'amount', 'fixed'].map(m => `<option value="${m}" ${st.mode === m ? 'selected' : ''}>${PRICE_MODES[m].label}</option>`).join('')}</select></div>
      <div><label>Value</label><input type="text" inputmode="decimal" data-role="price-value" value="${escapeHtml(st.value)}" placeholder="${PRICE_MODES[st.mode].placeholder}"></div>
      <div class="so-price-buttons">
        <button type="button" class="btn small" data-role="apply-all">Apply to all</button>
        <button type="button" class="btn secondary small" data-role="apply-selected" ${st.selected.size ? '' : 'disabled'}>Apply to selected (${st.selected.size})</button>
      </div>
      <div><label>Old price column</label><select data-role="price-column"><option value="">— none —</option>${cols.map(c => `<option value="${escapeHtml(c)}" ${c === so.priceColumn ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select></div>
    </div>
    <div class="so-price-summary">
      <span><b>${priced}</b> of ${rows.length} priced</span>
      ${so.pricing ? `<span>Last rule: <b>${escapeHtml(PRICE_MODES[so.pricing.mode]?.short || so.pricing.mode)} ${escapeHtml(so.pricing.value)}</b></span>` : ''}
      ${warnCount ? `<span style="color:var(--brick);"><b>${warnCount}</b> row${warnCount === 1 ? '' : 's'} to check</span>` : ''}
      <span class="muted-note">Type in New price to set a row by hand.</span>
    </div>
    <div class="items-scroll">
      <table class="items so-price-table">
        <thead><tr>
          <th class="checkbox-cell"><input type="checkbox" data-role="select-all" ${allSel ? 'checked' : ''} title="Select all"></th>
          <th>Code</th><th>Description</th><th class="num">Old price</th><th class="num">New price</th><th class="num">Discount</th><th>Mode</th><th></th>
        </tr></thead>
        <tbody>${rows.map(p => {
          const w = priceWarnings(p);
          const d = discountPct(p);
          return `<tr data-row="${p.row}" class="${w.length ? 'so-warn-row' : ''}">
            <td class="checkbox-cell"><input type="checkbox" data-role="select-row" ${st.selected.has(p.row) ? 'checked' : ''}></td>
            <td style="font-family:var(--font-mono);">${escapeHtml(p.code)}</td>
            <td class="so-desc">${escapeHtml(p.description)}</td>
            <td class="num">${p.oldPrice === null ? '<span class="empty-note">—</span>' : p.oldPrice.toFixed(2)}</td>
            <td class="num"><input type="text" inputmode="decimal" class="so-new-price" data-role="new-price" ${can('sellouts.price') ? '' : 'disabled'} value="${p.newPrice === null ? '' : p.newPrice.toFixed(2)}"></td>
            <td class="num">${d === null ? '' : d + '%'}</td>
            <td>${p.mode ? `<span class="badge ${p.mode === 'manual' ? 'warn' : 'active'}">${escapeHtml(PRICE_MODES[p.mode].short)}${p.mode !== 'manual' && p.value !== null ? ' ' + escapeHtml(p.value) : ''}</span>` : ''}</td>
            <td>${w.length ? `<span class="big-discount-dot" title="${escapeHtml(w.join(' · '))}"></span>` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function wirePricingPanel(el, so) {
  const st = stateOf(so);
  const panel = el.querySelector('[data-role="pricing-panel"]');
  if (!panel) return;
  const rerender = () => { panel.innerHTML = pricingPanelHtml(so); wirePricingPanel(el, so); updateSelloutsPill(); };

  panel.querySelector('[data-role="price-mode"]').addEventListener('change', e => { st.mode = e.target.value; rerender(); });
  panel.querySelector('[data-role="price-value"]').addEventListener('input', e => { st.value = e.target.value; });
  panel.querySelector('[data-role="select-all"]').addEventListener('change', e => {
    const rows = pricedRowsOf(so);
    st.selected = e.target.checked ? new Set(rows.map(p => p.row)) : new Set();
    rerender();
  });
  panel.querySelectorAll('[data-role="select-row"]').forEach(cb => cb.addEventListener('change', e => {
    const row = Number(e.target.closest('tr').dataset.row);
    e.target.checked ? st.selected.add(row) : st.selected.delete(row);
    rerender();
  }));

  const apply = async scope => {
    const value = parseNum(st.value);
    const mode = st.mode;
    if (value === null || value <= 0 || (mode === 'percent' && value >= 100)) {
      showToast(mode === 'percent' ? 'Enter a percentage between 0 and 100.' : 'Enter an amount greater than 0.', true);
      return;
    }
    const rows = pricedRowsOf(so);
    const targets = scope === 'selected' ? rows.filter(p => st.selected.has(p.row)) : rows;
    let skipped = 0;
    targets.forEach(p => {
      const np = computeNewPrice(p.oldPrice, mode, value);
      if (np === null) { skipped++; return; }
      Object.assign(p, { mode, value, newPrice: np });
    });
    so.pricing = { mode, value };
    if (!(await savePricing(so))) return;
    logActivity('sellouts', 'apply_pricing', { type: 'sellout', id: so.id },
      `Priced "${so.name}": ${PRICE_MODES[mode].short} ${value} on ${targets.length - skipped} item${targets.length - skipped === 1 ? '' : 's'}`,
      { mode, value, scope, applied: targets.length - skipped, skipped });
    if (scope === 'selected') st.selected.clear();
    rerender();
    showToast(`Prices set on ${targets.length - skipped} item${targets.length - skipped === 1 ? '' : 's'}` + (skipped ? ` — ${skipped} skipped (no old price).` : '.'));
  };
  panel.querySelector('[data-role="apply-all"]').addEventListener('click', () => apply('all'));
  panel.querySelector('[data-role="apply-selected"]').addEventListener('click', () => apply('selected'));

  panel.querySelector('[data-role="price-column"]').addEventListener('change', async e => {
    const col = e.target.value || null;
    const rows = pricedRowsOf(so);
    rows.forEach(p => {
      p.oldPrice = col ? parseNum(so.items[p.row]?.[col]) : null;
      if (p.mode === 'percent' || p.mode === 'amount') p.newPrice = computeNewPrice(p.oldPrice, p.mode, p.value);
    });
    const before = so.priceColumn;
    so.priceColumn = col;
    if (!(await savePricing(so))) return;
    logActivity('sellouts', 'edit', { type: 'sellout', id: so.id }, `Changed the old-price column of "${so.name}"`, { from: before, to: col });
    rerender();
  });

  panel.querySelectorAll('[data-role="new-price"]').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { const p = pricedRowsOf(so)[Number(inp.closest('tr').dataset.row)]; inp.value = p.newPrice === null ? '' : p.newPrice.toFixed(2); inp.blur(); }
    });
    inp.addEventListener('blur', async () => {
      const p = pricedRowsOf(so)[Number(inp.closest('tr').dataset.row)];
      const raw = inp.value.trim();
      const before = p.newPrice;
      if (raw === '') {
        if (before === null) return;
        Object.assign(p, { mode: null, value: null, newPrice: null });
      } else {
        const v = parseNum(raw);
        if (v === null) { showToast('Enter a price, e.g. 2.95', true); inp.value = before === null ? '' : before.toFixed(2); return; }
        if (round2(v) === before) { inp.value = before.toFixed(2); return; }
        Object.assign(p, { mode: 'manual', value: round2(v), newPrice: round2(v) });
      }
      if (!(await savePricing(so))) return;
      logActivity('sellouts', 'manual_price', { type: 'sellout', id: so.id },
        `"${so.name}": ${p.code} ${raw === '' ? 'price cleared' : `set to ${p.newPrice.toFixed(2)} by hand`}`,
        { code: p.code, row: p.row, from: before, to: p.newPrice });
      rerender();
    });
  });
}

function exportSelloutPricing(so) {
  const rows = pricedRowsOf(so);
  const aoa = [
    ['Sell-out', so.name],
    ['From', fmtDate(so.from)],
    ['To', fmtDate(so.to)],
    ['Note', so.note || ''],
    [],
    ['Code', 'Description', 'Old price', 'New price', 'Discount %'],
    ...rows.map(p => [String(p.code), p.description, p.oldPrice, p.newPrice, discountPct(p)]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Keep codes as text so leading zeros survive.
  for (let r = 6; r < aoa.length; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: 0 });
    if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(aoa[r][0]); }
  }
  ws['!cols'] = [{ wch: 14 }, { wch: 44 }, { wch: 11 }, { wch: 11 }, { wch: 11 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sell-out');
  XLSX.writeFile(wb, `${so.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'sellout'} - prices.xlsx`);
}

/* ---------------- list ---------------- */
const LOG_LABELS = { activated: 'Activated', deactivated: 'Deactivated', archived: 'Archived', unarchived: 'Unarchived' };

function renderSellouts() {
  const list = document.getElementById('selloutList');
  const empty = document.getElementById('selloutEmpty');
  list.innerHTML = '';
  updateSelloutsPill();
  const shown = applyFilter(sellouts)
    .slice()
    .sort((a, b) => (actionFlag(b) ? 1 : 0) - (actionFlag(a) ? 1 : 0));
  if (!shown.length) {
    empty.style.display = 'block';
    empty.querySelector('p.big').textContent = sellouts.length ? 'No sell-outs match this filter' : 'No sell-outs yet';
    return;
  }
  empty.style.display = 'none';

  shown.forEach(so => {
    const cols = itemColumns(so.items);
    const el = document.createElement('div');
    const flag = actionFlag(so);
    const isEditing = editingSelloutId === so.id;
    const st = stateOf(so);
    el.className = 'sellout'
      + (flag ? ' needs-action flag-' + (flag === 'deactivate' ? 'danger' : 'warn') : '')
      + (so.archived ? ' is-archived' : '')
      + (openIds.has(so.id) ? ' open' : '');
    el.dataset.id = so.id;

    const logHtml = so.log.length
      ? '<ul class="log-list">' + so.log.slice().reverse().map(l =>
          `<li><span class="dot2 ${l.action === 'activated' ? 'on' : 'off'}"></span>
           <div>${escapeHtml(LOG_LABELS[l.action] || l.action)}${l.by ? ` by ${escapeHtml(l.by)}` : ''} <span class="ts">— ${fmtTs(l.at)}</span></div></li>`
        ).join('') + '</ul>'
      : '<p class="empty-note">No activity yet.</p>';

    const fileHtml = so.items.length
      ? `<div class="items-scroll"><table class="items"><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
         <tbody>${so.items.map(row => `<tr>${cols.map(c => `<td>${escapeHtml(row[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="empty-note">No item rows found in this file.</p>';

    const bodyHtml = isEditing ? `
        <div class="edit-form">
          <div class="form-grid">
            <div class="full">
              <label for="edit-name-${so.id}">Name</label>
              <input type="text" id="edit-name-${so.id}" data-field="name" value="${escapeHtml(so.name)}">
            </div>
            <div>
              <label for="edit-from-${so.id}">From</label>
              <input type="date" id="edit-from-${so.id}" data-field="from" value="${so.from}">
            </div>
            <div>
              <label for="edit-to-${so.id}">To</label>
              <input type="date" id="edit-to-${so.id}" data-field="to" value="${so.to}">
            </div>
            <div class="full">
              <label for="edit-note-${so.id}">Note</label>
              <textarea id="edit-note-${so.id}" data-field="note">${escapeHtml(so.note || '')}</textarea>
            </div>
          </div>
          <div class="actions-row">
            <button type="button" class="btn ghost small" data-role="cancel-edit">Cancel</button>
            <button type="button" class="btn small" data-role="save-edit">Save changes</button>
          </div>
        </div>
      ` : `
        <div class="so-body-head">
          <div class="filter-row" style="margin:0;">
            <button type="button" class="${st.view === 'pricing' ? 'active' : ''}" data-view="pricing">Prices (${so.items.length})</button>
            <button type="button" class="${st.view === 'file' ? 'active' : ''}" data-view="file">Original file</button>
            <button type="button" class="${st.view === 'log' ? 'active' : ''}" data-view="log">Activity</button>
          </div>
          ${st.view === 'pricing' ? '<button type="button" class="btn secondary small" data-role="export">Export to Excel</button>' : ''}
        </div>
        ${st.view === 'pricing' ? `<div data-role="pricing-panel">${so.items.length ? pricingPanelHtml(so) : '<p class="empty-note">No item rows found in this file.</p>'}</div>` : ''}
        ${st.view === 'file' ? fileHtml : ''}
        ${st.view === 'log' ? logHtml : ''}
      `;

    const archiveBtn = so.archived
      ? `<button class="icon-btn" data-role="unarchive" title="Unarchive" aria-label="Unarchive">
           <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M12 17v-6M9.5 13.5 12 11l2.5 2.5"/></svg>
         </button>`
      : `<button class="icon-btn" data-role="archive" ${so.active ? `disabled title="${canEditSellouts() ? 'Deactivate it first' : 'It has to be turned off first'}"` : 'title="Archive (removed from the system)"'} aria-label="Archive">
           <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M10 12h4"/></svg>
         </button>`;

    el.innerHTML = `
      <div class="sellout-head" data-toggle>
        ${actionFlagHtml(so)}
        <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
        <div class="who">
          <div class="name">${escapeHtml(so.name)}</div>
          <div class="dates"><span>${fmtDate(so.from)}</span><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg><span>${fmtDate(so.to)}</span></div>
          ${so.note ? `<div class="so-note">${escapeHtml(so.note)}</div>` : ''}
        </div>
        <div class="badge-row">${selloutStatusBadge(so)}</div>
        <button class="btn ghost small" data-role="copy-codes" title="Copy this sell-out's codes (column 1 of its item file)">Copy codes</button>
        <div class="icon-actions">
          <button class="icon-btn" data-role="edit" title="Edit sell-out" aria-label="Edit sell-out">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="icon-btn" data-role="duplicate" title="Duplicate (use as a template)" aria-label="Duplicate sell-out">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
          </button>
          <button class="icon-btn" data-role="download" title="Download original file" aria-label="Download original file">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>
          </button>
          ${archiveBtn}
          <button class="icon-btn danger" data-role="delete" title="Delete sell-out" aria-label="Delete sell-out">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </div>
        <label class="switch" title="${!canEditSellouts() ? (so.active ? 'Active (you cannot change this)' : 'Inactive (you cannot change this)') : so.archived ? 'Unarchive it to activate' : 'Toggle active'}">
          <input type="checkbox" data-role="active-toggle" ${so.active ? 'checked' : ''} ${so.archived || !canEditSellouts() ? 'disabled' : ''}>
          <span class="track"></span>
        </label>
      </div>
      <div class="sellout-body">${bodyHtml}</div>
    `;
    list.appendChild(el);

    el.querySelector('[data-toggle]').addEventListener('click', (ev) => {
      if (ev.target.closest('.switch') || ev.target.closest('.icon-actions') || ev.target.closest('[data-role="copy-codes"]')) return;
      el.classList.toggle('open');
      if (el.classList.contains('open')) openIds.add(so.id); else openIds.delete(so.id);
    });
    el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      st.view = b.dataset.view;
      renderSellouts();
    }));
    el.querySelector('[data-role="export"]')?.addEventListener('click', ev => { ev.stopPropagation(); exportSelloutPricing(so); });
    if (!isEditing && st.view === 'pricing') wirePricingPanel(el, so);

    // Codes live in whatever the first column of the uploaded file turned out to be.
    el.querySelector('[data-role="copy-codes"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const codes = pricedRowsOf(so).map(p => p.code).filter(Boolean);
      if (!codes.length) { showToast('No codes found in column 1.', true); return; }
      const ok = await copyTextToClipboard(codes.join(','));
      if (ok) showToast(`Copied ${codes.length} code${codes.length === 1 ? '' : 's'} for ${so.name}.`);
      else showToast('Could not copy — your browser blocked clipboard access.', true);
    });
    el.querySelector('[data-role="active-toggle"]').addEventListener('change', async (ev) => {
      ev.stopPropagation();
      so.active = ev.target.checked;
      so.log.push({ action: so.active ? 'activated' : 'deactivated', at: new Date().toISOString(), by: Session.profile?.username });
      if (!(await updateSelloutFields(so.id, { active: so.active, log: so.log }))) { await loadAll(); return; }
      logActivity('sellouts', so.active ? 'activate' : 'deactivate', { type: 'sellout', id: so.id }, `${so.active ? 'Activated' : 'Deactivated'} "${so.name}"`);
      await loadAll();
    });
    el.querySelector('[data-role="download"]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const url = URL.createObjectURL(so.fileBlob);
      const a = document.createElement('a');
      a.href = url; a.download = so.fileName || 'sellout.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
    el.querySelector('[data-role="duplicate"]').addEventListener('click', ev => { ev.stopPropagation(); openDuplicate(so); });
    el.querySelector('[data-role="archive"]')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (so.active) { showToast('Deactivate it first.', true); return; }
      if (!(await showConfirm(`Confirm this sell-out has been removed from the system?\n\n"${so.name}"`, 'Archive'))) return;
      const at = new Date().toISOString();
      so.log.push({ action: 'archived', at, by: Session.profile?.username });
      if (!(await updateSelloutFields(so.id, { archived: true, archived_at: at, archived_by: Session.user.id, log: so.log }))) { await loadAll(); return; }
      logActivity('sellouts', 'archive', { type: 'sellout', id: so.id }, `Archived "${so.name}" (removed from the system)`);
      openIds.delete(so.id);
      await loadAll();
      showToast(`"${so.name}" archived.`);
    });
    el.querySelector('[data-role="unarchive"]')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!(await showConfirm(`Unarchive "${so.name}"? It goes back to the normal list.`, 'Unarchive'))) return;
      so.log.push({ action: 'unarchived', at: new Date().toISOString(), by: Session.profile?.username });
      if (!(await updateSelloutFields(so.id, { archived: false, archived_at: null, archived_by: null, log: so.log }))) { await loadAll(); return; }
      logActivity('sellouts', 'unarchive', { type: 'sellout', id: so.id }, `Unarchived "${so.name}"`);
      await loadAll();
      showToast(`"${so.name}" unarchived.`);
    });
    el.querySelector('[data-role="delete"]').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await showConfirm(`Delete "${so.name}"? This can't be undone.`, 'Delete');
      if (!ok) return;
      await idbDelete('sellouts', so.id);
      logActivity('sellouts', 'delete', { type: 'sellout', id: so.id }, `Deleted sell-out "${so.name}"`, { from: so.from, to: so.to, items: so.items.length });
      openIds.delete(so.id);
      await loadAll();
      showToast(`"${so.name}" deleted.`);
    });
    el.querySelector('[data-role="edit"]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      editingSelloutId = so.id;
      openIds.add(so.id);
      renderSellouts();
    });

    if (isEditing) {
      el.querySelector('[data-role="cancel-edit"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        editingSelloutId = null;
        renderSellouts();
      });
      el.querySelector('[data-role="save-edit"]').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const name = el.querySelector('[data-field="name"]').value.trim();
        const from = el.querySelector('[data-field="from"]').value;
        const to = el.querySelector('[data-field="to"]').value;
        const note = el.querySelector('[data-field="note"]').value.trim();
        if (!name) { showToast('Name can’t be empty.', true); return; }
        if (!from || !to) { showToast('Please set both dates.', true); return; }
        if (new Date(to) < new Date(from)) { showToast('The "To" date is before the "From" date.', true); return; }
        const changed = {};
        [['name', name], ['from', from], ['to', to], ['note', note]].forEach(([k, v]) => { if ((so[k] || '') !== v) changed[k] = { from: so[k] || '', to: v }; });
        so.name = name; so.from = from; so.to = to; so.note = note;
        if (!(await updateSelloutFields(so.id, { name, from, to, note: note || null }))) return;
        if (Object.keys(changed).length) logActivity('sellouts', 'edit', { type: 'sellout', id: so.id }, `Edited sell-out "${name}"`, { changed });
        editingSelloutId = null;
        await loadAll();
        showToast('Sell-out updated.');
      });
    }
  });
}
