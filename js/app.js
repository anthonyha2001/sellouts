/* ============================================================
   Storage - Supabase (so data is shared across every PC you use).
   The client `sb` is created in js/core/config.js.
   ============================================================ */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function base64ToBlob(b64, mime) {
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime || 'application/octet-stream' });
}
function guessMime(fileName) {
  const ext = (fileName || '').split('.').pop().toLowerCase();
  if (ext === 'csv') return 'text/csv';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

async function idbAll(store) {
  if (store === 'sellouts') {
    const { data, error } = await sb.from('sellouts').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); showToast('Could not load sell-outs — ' + sbErrText(error), true); return []; }
    return data.map(row => ({
      id: row.id,
      name: row.name,
      from: row.from,
      to: row.to,
      fileName: row.file_name,
      fileBlob: row.file_base64 ? base64ToBlob(row.file_base64, guessMime(row.file_name)) : new Blob([]),
      items: row.items || [],
      active: !!row.active,
      log: row.log || [],
      notifiedFlags: row.notified_flags || {},
      createdAt: row.created_at,
      note: row.note || '',
      archived: !!row.archived,
      archivedAt: row.archived_at || null,
      archivedBy: row.archived_by || null,
      priceColumn: row.price_column || null,
      pricing: row.pricing || null,
      pricedItems: Array.isArray(row.priced_items) ? row.priced_items : null
    }));
  }
  if (store === 'creditnotes') {
    const { data, error } = await sb.from('credit_notes').select('*').order('created_at', { ascending: false });
    if (error) { console.error(error); showToast('Could not load credit notes — ' + sbErrText(error), true); return []; }
    return data.map(row => ({
      id: row.id, number: row.number, supplier: row.supplier,
      details: row.details, status: row.status, createdAt: row.created_at
    }));
  }
  return [];
}

// View-only users (the accountant) never write sell-outs or promotions, whatever the screen offers.
// The database enforces the same rule once the lockdown (002) is applied.
const SELLOUT_ARCHIVE_FIELDS = ['archived', 'archived_at', 'archived_by', 'log', 'notified_flags'];
let viewOnlyWarned = 0;
function refuseViewOnly(what) {
  if (Date.now() - viewOnlyWarned > 3000) { viewOnlyWarned = Date.now(); showToast(`Only an admin can change ${what}. You can view and download them.`, true); }
  return false;
}

async function idbPut(store, val) {
  if (store === 'sellouts') {
    if (!canEditSellouts()) return refuseViewOnly('sell-outs');
    const row = {
      id: val.id, name: val.name, from: val.from, to: val.to,
      file_name: val.fileName,
      items: val.items, active: val.active, log: val.log,
      notified_flags: val.notifiedFlags,
      note: val.note || null,
      archived: !!val.archived, archived_at: val.archivedAt || null, archived_by: val.archivedBy || null,
      price_column: val.priceColumn || null, pricing: val.pricing || null, priced_items: val.pricedItems || null
    };
    if (val.fileBlob instanceof Blob && val.fileBlob.size > 0) {
      row.file_base64 = await blobToBase64(val.fileBlob);
    }
    const { error } = await sb.from('sellouts').upsert(row);
    if (error) { console.error(error); showToast('Could not save that sell-out \u2014 ' + sbErrText(error), true); }
    return;
  }
  if (store === 'creditnotes') {
    const row = { id: val.id, number: val.number, supplier: val.supplier, details: val.details, status: val.status };
    const { error } = await sb.from('credit_notes').upsert(row);
    if (error) { console.error(error); showToast('Could not save that credit note \u2014 ' + sbErrText(error), true); }
    return;
  }
}

// Saves only some sell-out columns (pricing, archive, note...) without re-uploading the file.
async function updateSelloutFields(id, fields) {
  if (!canEditSellouts() && !(canArchiveSellouts() && Object.keys(fields).every(k => SELLOUT_ARCHIVE_FIELDS.includes(k)))) return refuseViewOnly('sell-outs');
  const { error } = await sb.from('sellouts').update(fields).eq('id', id);
  if (error) { console.error(error); showToast('Could not save that sell-out — ' + sbErrText(error), true); return false; }
  return true;
}

async function idbDelete(store, id) {
  if (store === 'sellouts' && !canEditSellouts()) return refuseViewOnly('sell-outs');
  const table = store === 'sellouts' ? 'sellouts' : 'credit_notes';
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete \u2014 ' + sbErrText(error), true); }
}

/* ============================================================
   Promotions - catalog, settings, promotions, promotion rows
   ============================================================ */
// RLS denials become "You don't have permission to do that." (see friendlyError in js/core/config.js).
function sbErrText(error) {
  return friendlyError(error);
}

// Each promotion has its own catalog file, so every catalog row is tagged
// with the promotion it belongs to (promotion_id). The synthetic `id` we
// send is "<promotionId>::<code>" so the same code can exist in more than
// one promotion's catalog without colliding on the primary key \u2014 the real
// code lives in its own `code` column.
async function loadCatalogFor(promoId) {
  if (!promoId) { catalogItems = []; catalogMap = new Map(); catalogBarcodeMap = new Map(); return; }
  const { data, error } = await sb.from('catalog_items').select('*').eq('promotion_id', promoId).order('code', { ascending: true });
  if (error) { console.error(error); showToast('Could not load this promotion\u2019s catalog \u2014 ' + sbErrText(error), true); return; }
  catalogItems = (data || []).map(r => ({ code: r.code, description: r.description || '', balance: r.balance, salePrice: r.sale_price === undefined ? null : r.sale_price, supplier: r.supplier || '', country: r.country || '', outYtd: r.out_ytd === undefined ? null : r.out_ytd, barcodes: Array.isArray(r.barcodes) ? r.barcodes : [] }));
  catalogMap = new Map(catalogItems.map(i => [normalizeCatalogCode(i.code), i]));
  catalogBarcodeMap = new Map();
  catalogItems.forEach(i => i.barcodes.forEach(b => catalogBarcodeMap.set(b, i)));
}

async function replaceCatalog(rows, fileName, promoId) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  if (!promoId) { showToast('Select or create a promotion first.', true); return false; }
  const { error: delErr } = await sb.from('catalog_items').delete().eq('promotion_id', promoId);
  if (delErr) { console.error(delErr); showToast('Could not clear the old catalog \u2014 ' + sbErrText(delErr), true); return false; }
  const now = new Date().toISOString();
  const payload = rows.map(r => ({ id: `${promoId}::${r.code}`, code: r.code, promotion_id: promoId, description: r.description, balance: r.balance, sale_price: r.salePrice, supplier: r.supplier || null, country: r.country || null, out_ytd: r.outYtd === undefined ? null : r.outYtd, updated_at: now,
    ...(r.barcodes && r.barcodes.length ? { barcodes: r.barcodes } : {}) }));
  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error } = await sb.from('catalog_items').insert(chunk);
    if (error) { console.error(error); showToast('Could not upload the catalog \u2014 ' + sbErrText(error), true); return false; }
  }
  catalogFileNames.set(promoId, fileName);
  await loadCatalogFor(promoId);
  return true;
}

async function loadSettings() {
  const { data, error } = await sb.from('app_settings').select('*').eq('id', 'singleton').maybeSingle();
  if (error) { console.error(error); return; }
  if (data && typeof data.low_stock_threshold === 'number') lowStockThreshold = data.low_stock_threshold;
}
async function saveSettings() {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const { error } = await sb.from('app_settings').upsert({ id: 'singleton', low_stock_threshold: lowStockThreshold });
  if (error) { console.error(error); showToast('Could not save the threshold — ' + sbErrText(error), true); }
}

async function loadPromotions() {
  const { data, error } = await sb.from('promotions').select('*').order('created_at', { ascending: false });
  if (error) { console.error(error); showToast('Could not load promotions — ' + sbErrText(error), true); return; }
  promotions = (data || []).map(r => ({
    id: r.id, name: r.name, from: r.from_date, to: r.to_date, createdAt: r.created_at,
    archived: !!r.archived,
    autoArchive: r.auto_archive === false ? false : true,
    sourceFileName: r.source_file_name || null,
    sourceFileBase64: r.source_file_base64 || null
  }));
}
async function savePromotion(promo) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const row = {
    id: promo.id, name: promo.name, from_date: promo.from || null, to_date: promo.to || null,
    archived: !!promo.archived,
    auto_archive: promo.autoArchive !== false
  };
  const { error } = await sb.from('promotions').upsert(row);
  if (error) { console.error(error); showToast('Could not save the promotion — ' + sbErrText(error), true); }
}
// Keeps the raw price-sheet file the person imported, so it stays available
// after a reload instead of only living in that one browser tab's memory.
async function savePromotionSourceFile(promoId, file) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const base64 = await blobToBase64(file);
  const { error } = await sb.from('promotions').upsert({ id: promoId, source_file_name: file.name, source_file_base64: base64 });
  if (error) { console.error(error); showToast('Imported the rows, but could not save the source file — ' + sbErrText(error), true); return; }
  const promo = promotions.find(p => p.id === promoId);
  if (promo) { promo.sourceFileName = file.name; promo.sourceFileBase64 = base64; }
}
async function deletePromotionRemote(id) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const { error } = await sb.from('promotions').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete the promotion — ' + sbErrText(error), true); }
}

async function loadPromoRows(promoId) {
  const { data, error } = await sb.from('promotion_rows').select('*').eq('promotion_id', promoId).order('sort_order', { ascending: true }).order('created_at', { ascending: true });
  if (error) { console.error(error); showToast('Could not load this promotion’s items — ' + sbErrText(error), true); return []; }
  return (data || []).map(r => ({
    id: r.id, promotionId: r.promotion_id || promoId, code: r.code || '', description: r.description || '',
    balance: r.balance === undefined ? null : r.balance,
    promoPrice: r.promo_price === undefined ? null : r.promo_price,
    discount: r.discount === undefined ? null : r.discount,
    beforePrice: r.before_price === undefined ? null : r.before_price,
    salePrice: r.sale_price === undefined ? null : r.sale_price,
    priceType: r.price_type || '',
    supplier: r.supplier || '',
    flagged: !!r.flagged,
    reviewed: !!r.reviewed,
    cost: r.cost === undefined ? null : r.cost,
    country: r.country || '',
    outYtd: r.out_ytd === undefined ? null : r.out_ytd,
    barcode: r.barcode || '',
    note: r.note || '',
    sortOrder: r.sort_order || 0, _savedSortOrder: r.sort_order ?? null, _lastLookupCode: r.code || ''
  }));
  // Older data may have several rows on one position (see renumberRows); the save time
  // keeps each batch together until the next save renumbers them.

}
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  // Round to 2 decimals here too, so a value copied in from a catalog lookup
  // (which can carry long ERP decimal tails, e.g. 45.9690001) comes out
  // clean the moment the row is saved, not just when it's displayed.
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function promoRowPayload(row) {
  return {
    // Each row remembers which promotion it belongs to at the moment it was
    // created/loaded (row.promotionId), rather than trusting whatever
    // promotion happens to be open on screen right now. That avoids a row
    // getting silently re-parented to the wrong promotion if the person
    // switches tabs while an edit is still saving.
    id: row.id, promotion_id: row.promotionId || currentPromoId, code: row.code, description: row.description,
    balance: numOrNull(row.balance),
    promo_price: numOrNull(row.promoPrice),
    discount: numOrNull(row.discount),
    before_price: numOrNull(row.beforePrice),
    sale_price: numOrNull(row.salePrice),
    price_type: row.priceType || null,
    supplier: row.supplier || null,
    flagged: !!row.flagged,
    reviewed: !!row.reviewed,
    cost: (row.cost === null || row.cost === undefined || row.cost === '') ? null : String(row.cost),
    country: row.country || null,
    out_ytd: numOrNull(row.outYtd),
    note: row.note || null,
    sort_order: row.sortOrder,
    // Only sent when there is one, so saving keeps working before migration 008 adds the column.
    ...(row.barcode ? { barcode: String(row.barcode) } : {})
  };
}
function isFkViolation(error) {
  if (!error) return false;
  return error.code === '23503' || /foreign key/i.test(sbErrText(error));
}
/* If a row's parent promotion doesn't exist in the database yet (a slower
   promotion insert hasn't landed before the row insert reached the server)
   or was removed some other way while it was still open here, re-save the
   promotion from what's still held locally and retry once, so an edit is
   never lost to a timing gap or a stale tab. */
async function ensurePromotionExistsFor(row) {
  const promo = promotions.find(p => p.id === (row.promotionId || currentPromoId));
  if (!promo) return false;
  await savePromotion(promo);
  return true;
}
async function savePromoRow(row) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  let { error } = await sb.from('promotion_rows').upsert(promoRowPayload(row));
  if (error && isFkViolation(error) && await ensurePromotionExistsFor(row)) {
    ({ error } = await sb.from('promotion_rows').upsert(promoRowPayload(row)));
  }
  if (error) { console.error(error); showToast('Could not save that row — ' + sbErrText(error), true); }
  else row._savedSortOrder = row.sortOrder;
}
async function persistRowsBulk(rows) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  if (!rows.length) return;
  const payload = rows.map(promoRowPayload);
  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    let { error } = await sb.from('promotion_rows').upsert(chunk);
    if (error && isFkViolation(error) && await ensurePromotionExistsFor(rows[i])) {
      ({ error } = await sb.from('promotion_rows').upsert(chunk));
    }
    if (error) { console.error(error); showToast('Could not save some of the rows — ' + sbErrText(error), true); return; }
    rows.slice(i, i + chunkSize).forEach(r => { r._savedSortOrder = r.sortOrder; });
  }
}
async function deletePromoRow(id) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const { error } = await sb.from('promotion_rows').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete that row — ' + sbErrText(error), true); }
}
async function deleteRowsBulk(ids) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  if (!ids.length) return;
  const { error } = await sb.from('promotion_rows').delete().in('id', ids);
  if (error) { console.error(error); showToast('Could not delete the selected rows — ' + sbErrText(error), true); }
}
// Used by "Import price sheet": the imported rows become the promotion's
// whole table rather than being tacked onto whatever was already there, so
// importing the same (or an overlapping) file twice doesn't leave the table
// full of duplicate codes.
async function replaceAllPromoRows(promoId, rows) {
  if (!canEditPromotions()) return refuseViewOnly('promotions');
  const { error } = await sb.from('promotion_rows').delete().eq('promotion_id', promoId);
  if (error) { console.error(error); showToast('Could not clear the old rows — ' + sbErrText(error), true); return false; }
  await persistRowsBulk(rows);
  return true;
}
// Renumbers every row to its place on screen and returns the rows whose saved position is
// now out of date. Callers MUST save those too: saving only the new/pasted rows left the
// rows below them on their old numbers, two rows shared a position, and the list came back
// interleaved on reload (e.g. two pasted batches mixed row by row).
function renumberRows() {
  currentRows.forEach((r, i) => { r.sortOrder = i; });
  return currentRows.filter(r => r.sortOrder !== r._savedSortOrder);
}
// Rows to save after an edit: the edited ones plus every row that changed position.
const withMoved = (rows, moved) => [...new Set([...rows, ...moved])];
function blankPromoRow() {
  return { id: uid(), promotionId: currentPromoId, code: '', description: '', promoPrice: null, discount: null, beforePrice: null, salePrice: null, balance: null, priceType: '', supplier: '', flagged: false, reviewed: false, cost: null, country: '', outYtd: null, note: '', sortOrder: currentRows.length, _lastLookupCode: '' };
}
const PROMO_FIELDS = ['code', 'description', 'promoPrice', 'beforePrice', 'discount', 'salePrice', 'balance'];
const PRICE_RISK_RATIO = 0.25;
function isPriceRisk(row) {
  const promo = Number(row.promoPrice);
  const sale = Number(row.salePrice);
  if (row.promoPrice === null || row.promoPrice === undefined || row.promoPrice === '') return false;
  if (row.salePrice === null || row.salePrice === undefined || row.salePrice === '') return false;
  if (isNaN(promo) || isNaN(sale) || sale <= 0) return false;
  return promo < sale * PRICE_RISK_RATIO;
}
// A promo price at or above the sale price means zero or negative discount
// \u2014 almost always a typo (wrong price, missing a digit) rather than an
// intentional promotion, so it's worth a flag even though it isn't a "deep
// discount" risk like isPriceRisk() below.
function isPriceGapUnusual(row) {
  const frac = discountFraction(row);
  return frac !== null && frac <= 0;
}
function rowNeedsFlag(row) {
  if (row.flagged) return true;
  if (row.reviewed) return false; // an auto-flag the person already dismissed, until the price changes again
  return isPriceRisk(row) || isPriceGapUnusual(row);
}
// Sales velocity from the catalog's "Out" (units sold year-to-date) column,
// turned into how many weeks the current stock will last at that pace —
// a smarter low-stock signal than a single fixed threshold, since a slow
// mover and a fast mover with the same stock count aren't equally at risk.
function weeksElapsedThisYear() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weeks = (now - startOfYear) / (7 * 24 * 3600 * 1000);
  return Math.max(weeks, 1); // guard against an unstable rate in the first days of January
}
function weeksOfStockLeft(row) {
  const balance = Number(row.balance);
  const outYtd = Number(row.outYtd);
  if (row.balance === null || row.balance === undefined || row.balance === '') return null;
  if (row.outYtd === null || row.outYtd === undefined || row.outYtd === '') return null;
  if (isNaN(balance) || isNaN(outYtd) || outYtd <= 0) return null;
  const weeklyRate = outYtd / weeksElapsedThisYear();
  if (weeklyRate <= 0) return null;
  return balance / weeklyRate;
}
const VELOCITY_LOW_STOCK_WEEKS = 1.5;
function isVelocityLowStock(row) {
  const weeks = weeksOfStockLeft(row);
  return weeks !== null && weeks < VELOCITY_LOW_STOCK_WEEKS;
}
// A plain Reorder/OK call for the "By supplier" accordion: prefers the sales-
// velocity read (Out ÷ weeks elapsed vs. current stock) when the catalog has
// an Out figure for the item, and falls back to the plain low-stock
// threshold when it doesn't — so every item gets a recommendation, not just
// the ones with velocity data on file.
function needsReorder(row) {
  const weeks = weeksOfStockLeft(row);
  if (weeks !== null) return weeks < VELOCITY_LOW_STOCK_WEEKS;
  return row.balance !== null && row.balance !== undefined && Number(row.balance) < lowStockThreshold;
}
function refreshRowFlagUi(tr, row) {
  const btn = tr.querySelector('[data-role="toggle-flag"]');
  if (!btn) return;
  const priceRisk = isPriceRisk(row);
  const gapUnusual = isPriceGapUnusual(row);
  btn.classList.toggle('flag-on', rowNeedsFlag(row));
  btn.title = row.flagged
    ? 'Flagged for review \u2014 click to unflag'
    : (priceRisk ? 'Promo price is under 25% of the sale price \u2014 click to dismiss'
      : (gapUnusual ? 'Promo price is not below the sale price \u2014 click to dismiss' : 'Flag this row for review'));
}

/* Auto-calculated discount (Sale Price vs Promo Price), and the two
   validation cues that go with it: a blinking dot for a discount over 25%,
   and a red border on cells that are missing something they need. */
const BIG_DISCOUNT_RATIO = 0.25;
// mround() and round2() live in js/core/helpers.js (shared by Promotions and Sell-outs).
function discountFraction(row) {
  if (row.salePrice === null || row.salePrice === undefined || row.salePrice === '') return null;
  if (row.promoPrice === null || row.promoPrice === undefined || row.promoPrice === '') return null;
  const sale = Number(row.salePrice), promo = Number(row.promoPrice);
  if (isNaN(sale) || isNaN(promo) || sale <= 0) return null;
  return (sale - promo) / sale;
}
function computeAutoDiscountPct(row) {
  const frac = discountFraction(row);
  if (frac === null) return null;
  return Math.round(mround(frac, 0.05) * 100);
}
// Read-only display for the "Gap" column — the price difference the Sale
// Price and Promo Price already imply, purely informational. It never
// writes to row.discount: Discount is a field the person fills in on
// purpose (see autoSelloutOnDiscount below), so the natural gap is shown
// separately instead of silently landing in that field for them.
function gapPctDisplay(row) {
  const pct = computeAutoDiscountPct(row);
  return pct === null ? '—' : `${pct}%`;
}
// The reverse direction: typing a Discount % directly computes Promo Price
// back from Sale Price, so either field can drive the other — whichever
// one was just edited wins. The result is rounded to the nearest 0.05 (a
// typical shelf-price step, like Excel's MROUND(x, 0.05)) rather than just
// the nearest cent, so promo prices land on realistic price points.
const PROMO_PRICE_STEP = 0.05;
function applyReverseDiscount(row) {
  const sale = Number(row.salePrice);
  if (row.discount === null || row.discount === undefined || row.discount === '') return;
  if (row.salePrice === null || row.salePrice === undefined || row.salePrice === '' || isNaN(sale) || sale <= 0) return;
  const pct = Number(row.discount);
  if (isNaN(pct)) return;
  row.promoPrice = round2(mround(sale * (1 - pct / 100), PROMO_PRICE_STEP));
}
function isBigDiscount(row) {
  const frac = discountFraction(row);
  return frac !== null && frac > BIG_DISCOUNT_RATIO;
}
// A row with a discount % on it is, in practice, always a Sell Out item —
// so as soon as one is entered, default the row into that type automatically
// instead of leaving it to be set by hand in the Audit view later. Only
// fires when no type is set yet, so it never overrides a row someone has
// deliberately marked as C/N or Right Price.
function autoSelloutOnDiscount(row) {
  const hasDiscount = row.discount !== null && row.discount !== undefined && row.discount !== '';
  if (hasDiscount && !row.priceType) row.priceType = 'sellout';
}
// Once a catalog match brings in a Sale Price, a Promo Price is normally
// left exactly as it was typed/imported — the only thing this recomputes is
// the reverse direction: if the row already carries a discount % that was
// set before the code was known (e.g. from a bulk discount applied to
// freshly-inserted blank rows, or a percentage cell from an import), that
// pre-set discount drives the Promo Price. A row with no discount on it
// stays with no discount — it does NOT get one auto-filled from the bare
// Sale-Price/Promo-Price gap, since Discount is a field the person fills in
// on purpose (see autoSelloutOnDiscount below) and auto-filling it here is
// what used to mark nearly every row in a promotion as a Sell Out.
function applyDiscountAfterCatalogMatch(row) {
  const promoBlank = row.promoPrice === null || row.promoPrice === undefined || row.promoPrice === '';
  const hasDiscount = row.discount !== null && row.discount !== undefined && row.discount !== '';
  if (promoBlank && hasDiscount) applyReverseDiscount(row);
}
function isCodeMissingFromCatalog(row) {
  const code = (row.code || '').trim();
  return !!code && !catalogMap.has(normalizeCatalogCode(code));
}
// A row can have real content (a description, a price) but no code at all
// — usually because the source sheet just didn't have one for that line
// (a "25% off everything" note row, a bundled offer, etc). Left unflagged,
// it's easy to scroll right past without noticing anything is missing.
function isCodeBlankWithData(row) {
  const code = (row.code || '').trim();
  if (code) return false;
  const hasNum = (v) => v !== null && v !== undefined && v !== '';
  return !!(row.description && row.description.trim()) || hasNum(row.promoPrice) || hasNum(row.beforePrice) || hasNum(row.salePrice) || hasNum(row.discount) || hasNum(row.balance);
}
function isPromoPriceMissing(row) {
  const hasCode = !!(row.code && row.code.trim());
  return hasCode && (row.promoPrice === null || row.promoPrice === undefined || row.promoPrice === '');
}
/* Duplicate codes within the same promotion are allowed on purpose (some
   items legitimately get listed twice) — they're just flagged with a
   yellow border rather than blocked, so nothing typed is ever lost. */
function isDuplicateCodeInPromo(row) {
  const code = (row.code || '').trim();
  if (!code) return false;
  return currentRows.filter(r => (r.code || '').trim() === code).length > 1;
}
function refreshDuplicateFlagsForCode(code) {
  const trimmed = (code || '').trim();
  if (!trimmed) return;
  const body = document.getElementById('promoRowsBody');
  if (!body) return;
  const matches = currentRows.filter(r => (r.code || '').trim() === trimmed);
  const isDup = matches.length > 1;
  matches.forEach(r => {
    const tr = body.querySelector(`tr[data-row-id="${r.id}"]`);
    const codeInput = tr && tr.querySelector('[data-field="code"]');
    if (codeInput) codeInput.classList.toggle('cell-duplicate', isDup);
  });
}
function refreshDiscountUi(tr, row) {
  const dot = tr.querySelector('[data-role="big-discount-dot"]');
  if (dot) dot.style.display = isBigDiscount(row) ? 'inline-block' : 'none';
  const gapCell = tr.querySelector('[data-role="gap-display"]');
  if (gapCell) gapCell.textContent = gapPctDisplay(row);
}
const MISMATCH_TITLE = 'This code was not found in this promotion’s catalog';
const EMPTY_CODE_TITLE = 'This row has no code — nothing was entered for it in the source file';
function refreshRowValidationUi(tr, row) {
  const promoPriceInput = tr.querySelector('[data-field="promoPrice"]');
  const mismatchIcon = tr.querySelector('[data-role="mismatch-icon"]');
  if (mismatchIcon) mismatchIcon.style.display = isCodeMissingFromCatalog(row) ? 'inline-flex' : 'none';
  const emptyCodeIcon = tr.querySelector('[data-role="empty-code-icon"]');
  if (emptyCodeIcon) emptyCodeIcon.style.display = isCodeBlankWithData(row) ? 'inline-flex' : 'none';
  if (promoPriceInput) promoPriceInput.classList.toggle('cell-missing', isPromoPriceMissing(row));
}
function isRowEmpty(row) {
  return !row.code && !row.description &&
    row.promoPrice === null && row.discount === null &&
    row.beforePrice === null && row.salePrice === null && row.balance === null;
}
function computePromoStats(rows) {
  return {
    total: rows.length,
    flagged: rows.filter(rowNeedsFlag).length,
    empty: rows.filter(isRowEmpty).length
  };
}
function fieldValueParse(field, raw) {
  raw = (raw ?? '').trim();
  if (['promoPrice', 'discount', 'beforePrice', 'salePrice', 'balance'].includes(field)) {
    if (raw === '') return null;
    const cleaned = raw.replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  }
  if (field === 'priceType') {
    const norm = raw.toLowerCase();
    if (!norm || norm === '\u2014') return '';
    if (norm.includes('sell')) return 'sellout';
    if (norm.includes('c/n') || norm === 'cn' || norm.includes('credit')) return 'cn';
    if (norm.includes('right')) return 'rightprice';
    return '';
  }
  return raw;
}

/* ============================================================
   State
   ============================================================ */
let sellouts = [];
let creditNotes = [];
let notifications = [];
let currentFilter = 'all';
let soundEnabled = localStorage.getItem('sol-sound') !== 'off';
let openIds = new Set();
let editingSelloutId = null;
let editingCnId = null;

// Promotions
let catalogItems = [];
let catalogMap = new Map();
let catalogBarcodeMap = new Map(); // barcode (digits) -> catalog item, for price sheets (and the Phase 7 scanner)
// Catalog codes are matched case-insensitively and whitespace-trimmed: the
// catalog file and the price sheet / pasted codes are often two different
// exports of the same data, and a code that's "ABC123" in one and "abc123"
// (or with stray spaces) in the other should still match instead of silently
// missing its balance/sale price lookup.
function normalizeCatalogCode(code) {
  return String(code ?? '').trim().toUpperCase();
}
// Re-runs the catalog lookup for every row that already has a code, against
// whatever catalog is currently loaded. Rows only get this treatment at the
// moment their code is typed/pasted/imported — so if a price sheet is
// imported (or codes are pasted) before a catalog has been uploaded for this
// promotion, those rows are left with blank balance/sale price/supplier
// forever, even after the catalog does show up, unless something re-checks
// them. This is that re-check: called after any catalog upload/replace, so
// the two can be done in either order and still end up matched. Returns the
// rows that actually got new data, so the caller can persist just those.
function relookupRowsAgainstCatalog(rows) {
  const updated = [];
  rows.forEach(row => {
    const code = (row.code || '').trim();
    if (!code) return;
    const item = catalogMap.get(normalizeCatalogCode(code));
    if (!item) return;
    row.description = item.description;
    row.balance = item.balance === undefined ? null : item.balance;
    row.salePrice = item.salePrice === undefined ? null : item.salePrice;
    row.supplier = item.supplier || '';
    row.country = item.country || '';
    row.outYtd = item.outYtd === undefined ? null : item.outYtd;
    applyDiscountAfterCatalogMatch(row);
    autoSelloutOnDiscount(row);
    updated.push(row);
  });
  return updated;
}

let catalogFileNames = new Map(); // promotionId -> the uploaded catalog file's name, this session
let lowStockThreshold = 20;
let promotions = [];
let currentPromoId = null;
let currentRows = [];
let selectedRowIds = new Set();
let expandedSupplierRowIds = new Set();
let promoViewMode = 'table'; // 'table' or 'audit'
let tableSubView = 'rows'; // 'rows' (the editable grid) or 'supplier' (grouped-by-supplier accordion), both inside Table
let auditSubView = 'cost'; // 'cost' (cost-check table) or 'supplier' (grouped-by-supplier accordion), both inside Audit
let expandedSupplierGroups = new Set();
let selectedCountries = new Set(); // Country filter, applied across all promo views
let selectedCodeIssues = new Set(); // 'missing' and/or 'mismatch', in the same Filter panel as Country
let countryFilterOpen = false;
let selectedAuditSuppliers = new Set(); // Supplier filter, scoped to the Audit view only
let auditSupplierFilterOpen = false;
let showFlaggedOnly = false; // Flagged-only toggle, scoped to the Table view only
let tableSearchQuery = ''; // Search box, scoped to the Table view only
let countryFilterSearchQuery = ''; // Search box inside the Filter panel's Country list
let auditSupplierFilterSearchQuery = ''; // Search box inside the Audit "Filter by supplier" panel
let catalogCollapsed = localStorage.getItem('sol-catalog-collapsed') === 'true';
let showArchivedPromos = false;

const uid = () => 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
// Local calendar date as YYYY-MM-DD. Deliberately avoids toISOString() here,
// since that reports the UTC date and would read as "yesterday" or
// "tomorrow" for part of the day in any timezone ahead of or behind UTC.
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}
const todayStr = () => beirutToday();   // Beirut date (js/core/config.js), not the device's

/* Default a new promotion to the upcoming Friday-through-Monday run, since
   that is the usual pattern, while staying fully editable afterward. Built
   entirely from local Y/M/D components (no toISOString on a local Date) so
   it lands on the right calendar day regardless of timezone. */
function nextFridayToMonday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun ... 5=Fri, 6=Sat
  const daysUntilFriday = (5 - day + 7) % 7;
  const friday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilFriday);
  const monday = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 3);
  return { from: localDateStr(friday), to: localDateStr(monday) };
}
function fmtDMY(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}`;
}
/* Auto-archive any promotion whose "to" date has passed, unless the person
   has turned auto-archive off for that one. Runs on load and periodically
   while the page stays open, and is always reversible from the UI. */
async function autoArchiveDuePromotions() {
  if (!canEditPromotions()) return false;          // the admin's session archives them
  const today = todayStr();
  const due = promotions.filter(p => !p.archived && p.autoArchive !== false && p.to && p.to < today);
  if (!due.length) return false;
  due.forEach(p => { p.archived = true; });
  await Promise.all(due.map(p => savePromotion(p)));
  return true;
}
function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00'); const B = new Date(b + 'T00:00:00');
  return Math.round((B - A) / 86400000);
}
function fmtDate(d) {
  if (!d) return '\u2014';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtTs(iso) {
  const dt = new Date(iso);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' \u00B7 ' +
         dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
// Runs a section-builder (like buildSupplierGroupedHtml) defensively: the
// whole Promotions workspace is one big template literal, so if any single
// section throws while building its HTML, the entire assignment fails and
// the page goes blank — not just that section. Wrapping each heavy/
// less-proven section in this keeps a bug contained to its own tab instead
// of taking down the whole workspace.
function safeSectionHtml(label, buildFn) {
  try {
    return buildFn();
  } catch (e) {
    console.error(`Error rendering ${label}:`, e);
    return `
      <div class="empty-state" style="padding:34px 16px;">
        <p class="big">Couldn't display this view</p>
        <p>${escapeHtml(e && e.message ? e.message : String(e))}</p>
      </div>`;
  }
}

/* ============================================================
   In-app modal confirm + toast (native confirm()/alert() are
   blocked inside a published, sandboxed artifact page)
   ============================================================ */
function showConfirm(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const input = document.getElementById('modalInput');
    if (input) input.style.display = 'none';
    document.getElementById('modalMsg').textContent = message;
    confirmBtn.textContent = confirmLabel;
    overlay.classList.add('open');

    const cleanup = (result) => {
      overlay.classList.remove('open');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(false); };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
  });
}
function showPrompt(message, opts = {}) {
  const { defaultValue = '', confirmLabel = 'Add', placeholder = '' } = opts;
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const confirmBtn = document.getElementById('modalConfirm');
    const cancelBtn = document.getElementById('modalCancel');
    const input = document.getElementById('modalInput');
    document.getElementById('modalMsg').textContent = message;
    confirmBtn.textContent = confirmLabel;
    input.style.display = 'block';
    input.value = defaultValue;
    input.placeholder = placeholder;
    overlay.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 30);

    const cleanup = (result) => {
      overlay.classList.remove('open');
      input.style.display = 'none';
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      input.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onConfirm = () => cleanup(input.value);
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => { if (e.target === overlay) cleanup(null); };
    const onKeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); cleanup(input.value); } };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    input.addEventListener('keydown', onKeydown);
  });
}
function showToast(message, isError = false) {
  const stack = document.getElementById('toastStack');
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' err' : '');
  t.textContent = message;
  stack.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 220);
  }, 3200);
}

async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) { /* fall through to legacy method */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    return false;
  }
}

/* ============================================================
   Sound - synthesized chime via Web Audio (no external file needed)
   ============================================================ */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  } else if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}
['click', 'keydown', 'touchstart'].forEach(evt => document.addEventListener(evt, ensureAudio, { once: true }));

function playChime() {
  if (!soundEnabled || !audioCtx) return;
  const now = audioCtx.currentTime;
  [784, 1046.5].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + i * 0.13;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0); osc.stop(t0 + 0.4);
  });
}
document.getElementById('soundToggle').addEventListener('change', (e) => {
  soundEnabled = e.target.checked;
  localStorage.setItem('sol-sound', soundEnabled ? 'on' : 'off');
});
document.getElementById('soundToggle').checked = soundEnabled;

/* ============================================================
   Load
   ============================================================ */
async function loadAll() {
  sellouts = canSee('sellouts') ? await idbAll('sellouts') : [];
  creditNotes = canSee('creditnotes') ? await idbAll('creditnotes') : [];
  sellouts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  creditNotes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  renderSellouts();
  renderCreditNotes();
  runNotificationCheck();
}

/* Sell-outs UI: js/modules/sellouts.js */

/* ============================================================
   Credit notes - a fully independent tracker, no link to sell-outs
   ============================================================ */
document.getElementById('cnForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const number = document.getElementById('cnNumber').value.trim();
  const supplier = document.getElementById('cnSupplier').value.trim();
  const status = document.getElementById('cnStatus').value;
  const details = document.getElementById('cnDetails').value.trim();

  const record = { id: uid(), number, supplier, status, details, createdAt: new Date().toISOString() };
  await idbPut('creditnotes', record);
  e.target.reset();
  await loadAll();
  showToast(`Credit note "${number}" added.`);
});

function renderCreditNotes() {
  const body = document.getElementById('cnTableBody');
  const card = document.getElementById('cnTableCard');
  const empty = document.getElementById('cnEmpty');
  body.innerHTML = '';
  if (!creditNotes.length) { card.style.display = 'none'; empty.style.display = 'block'; return; }
  card.style.display = 'block'; empty.style.display = 'none';

  creditNotes.forEach(cn => {
    const tr = document.createElement('tr');
    const isEditing = editingCnId === cn.id;

    if (isEditing) {
      tr.innerHTML = `
        <td><input type="text" class="cn-edit-input" data-field="number" value="${escapeHtml(cn.number)}"></td>
        <td><input type="text" class="cn-edit-input" data-field="supplier" value="${escapeHtml(cn.supplier)}"></td>
        <td><input type="text" class="cn-edit-input" data-field="details" value="${escapeHtml(cn.details || '')}"></td>
        <td>
          <select class="cn-edit-input" data-field="status">
            <option value="issued" ${cn.status === 'issued' ? 'selected' : ''}>Issued</option>
            <option value="signed" ${cn.status === 'signed' ? 'selected' : ''}>Signed</option>
          </select>
        </td>
        <td style="white-space:nowrap;">
          <button class="btn small" data-role="save-cn">Save</button>
          <button class="btn ghost small" data-role="cancel-cn">Cancel</button>
        </td>
      `;
      tr.querySelector('[data-role="save-cn"]').addEventListener('click', async () => {
        const number = tr.querySelector('[data-field="number"]').value.trim();
        const supplier = tr.querySelector('[data-field="supplier"]').value.trim();
        const details = tr.querySelector('[data-field="details"]').value.trim();
        const status = tr.querySelector('[data-field="status"]').value;
        if (!number || !supplier) { showToast('Number and supplier can\u2019t be empty.', true); return; }
        cn.number = number; cn.supplier = supplier; cn.details = details; cn.status = status;
        await idbPut('creditnotes', cn);
        editingCnId = null;
        await loadAll();
        showToast('Credit note updated.');
      });
      tr.querySelector('[data-role="cancel-cn"]').addEventListener('click', () => {
        editingCnId = null;
        renderCreditNotes();
      });
    } else {
      tr.innerHTML = `
        <td class="num">${escapeHtml(cn.number)}</td>
        <td>${escapeHtml(cn.supplier)}</td>
        <td style="max-width:260px;white-space:normal;">${cn.details ? escapeHtml(cn.details) : '<span style="color:var(--ink-faint);">\u2014</span>'}</td>
        <td><button class="status-pill ${cn.status}" data-role="toggle-status">${cn.status}</button></td>
        <td style="white-space:nowrap;">
          <button class="icon-btn" data-role="edit-cn" title="Edit credit note" aria-label="Edit credit note">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="icon-btn danger" data-role="delete-cn" title="Delete credit note" aria-label="Delete credit note">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>
          </button>
        </td>
      `;
      tr.querySelector('[data-role="toggle-status"]').addEventListener('click', async () => {
        cn.status = cn.status === 'issued' ? 'signed' : 'issued';
        await idbPut('creditnotes', cn);
        await loadAll();
      });
      tr.querySelector('[data-role="edit-cn"]').addEventListener('click', () => {
        editingCnId = cn.id;
        renderCreditNotes();
      });
      tr.querySelector('[data-role="delete-cn"]').addEventListener('click', async () => {
        const ok = await showConfirm(`Delete credit note "${cn.number}"?`, 'Delete');
        if (!ok) return;
        await idbDelete('creditnotes', cn.id);
        await loadAll();
        showToast(`Credit note "${cn.number}" deleted.`);
      });
    }
    body.appendChild(tr);
  });
}

/* ============================================================
   Navigation
   ============================================================ */
const PAGES = {
  sellouts:    { eyebrow: 'Overview', title: 'Sell-outs', sub: 'Every sell-out you\u2019re tracking, with items and activation history.' },
  creditnotes: { eyebrow: 'Tracker', title: 'Credit notes', sub: 'Every credit note logged against your suppliers, issued or signed.' },
  promotions:  { eyebrow: 'Builder', title: 'Promotions', sub: 'Look up items by code, build a flyer, and export it when it’s ready.' },
  vendors:     { eyebrow: 'Directory', title: 'Vendors', sub: 'Salesman contacts, delivery schedule, and placing orders.' },
  rentals:     { eyebrow: 'Gondolas', title: 'Rentals', sub: 'Gondola and shelf-space rentals by supplier, tracked year over year.' },
  delivery:    { eyebrow: 'Deliveries', title: 'Delivery', sub: 'Home-delivery orders, driver payments and customers.' },
  cash:        { eyebrow: 'Cashiers', title: 'Cash differences', sub: 'Daily over and short amounts per cashier.' },
  floorcheck:  { eyebrow: 'Store floor', title: 'Floor check', sub: 'Check that every sell-out and promotion item on the floor has the right price.' },
  labels:      { eyebrow: 'Shelves', title: 'Shelf labels', sub: 'Items that need a new shelf label: scanned on the floor, printed by the accountant.' },
  users:       { eyebrow: 'Settings', title: 'Users', sub: 'Who can sign in, and what each person can do.' },
  activity:    { eyebrow: 'Settings', title: 'Activity log', sub: 'Everything that was changed, by whom and when.' }
};
// Sections the signed-in role cannot see fall back to the role's home page (roles.js).
// The address bar mirrors the section (#promotions, #delivery/settle) so reloads and links work.
function switchTab(name, sub) {
  if (!canSee(name)) name = roleInfo().home;
  if (!name) return;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  const meta = PAGES[name];
  document.getElementById('pageEyebrow').textContent = meta.eyebrow;
  document.getElementById('pageTitle').textContent = meta.title;
  document.getElementById('pageSub').textContent = meta.sub;
  document.getElementById('sidenav').classList.remove('open');
  if (name === 'delivery' && window.Delivery) Delivery.show(sub);   // sets its own #delivery/<page> hash
  else if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  if (name === 'users' && window.UsersPage) UsersPage.show();
  if (name === 'cash' && window.Cash) Cash.show();
  if (name === 'floorcheck' && window.FloorCheck) FloorCheck.show();
  if (name === 'labels' && window.Labels) Labels.show();
  if (name !== 'floorcheck' && name !== 'labels' && window.Scanner) Scanner.close();
  if (name === 'activity' && window.ActivityPage) ActivityPage.show();
}
function routeFromHash() {
  const [name, sub] = location.hash.replace(/^#/, '').split('/');
  switchTab(name || roleInfo().home, sub);
}
window.addEventListener('hashchange', () => { if (Session.role) routeFromHash(); });
document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.getElementById('menuToggle').addEventListener('click', () => document.getElementById('sidenav').classList.toggle('open'));

// Collapse the sidebar down to an icon-only rail, for more room on screen.
// Desktop only (see the mobile media query, which switches this control
// off) — the setting is remembered per browser via localStorage.
(function initNavCollapse() {
  const toggle = document.getElementById('navCollapseToggle');
  const sidebarEl = document.getElementById('sidebarEl');
  const STORAGE_KEY = 'sellout-ledger:navCollapsed';
  function apply(collapsed) {
    document.documentElement.classList.toggle('nav-collapsed', collapsed);
    sidebarEl.classList.toggle('collapsed', collapsed);
    const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }
  let collapsed = false;
  try { collapsed = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { /* private browsing / blocked storage — defaults to expanded */ }
  apply(collapsed);
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore — won't persist this time */ }
  });
})();

/* ============================================================
   Notifications
   ============================================================ */
function pushNotification(msg) {
  notifications.unshift({ msg, at: new Date().toISOString() });
  if (notifications.length > 50) notifications.pop();
  playChime();
  if (window.Notification && Notification.permission === 'granted') {
    try { new Notification('LV Ajaltoun', { body: msg }); } catch (e) {}
  }
  renderNotifPanel();
}
function renderNotifPanel() {
  const listEl = document.getElementById('notifList');
  const dot = document.getElementById('bellCount');
  if (notifications.length) {
    dot.style.display = 'flex'; dot.textContent = notifications.length > 9 ? '9+' : notifications.length;
    listEl.innerHTML = notifications.map(n =>
      `<div class="notif-item"><div class="msg">${escapeHtml(n.msg)}</div><div class="ts">${fmtTs(n.at)}</div></div>`
    ).join('');
  } else {
    dot.style.display = 'none';
    listEl.innerHTML = '<div class="notif-empty">No notifications right now.</div>';
  }
}
document.getElementById('bellBtn').addEventListener('click', () => {
  document.getElementById('notifPanel').classList.toggle('open');
  if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
});
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  const bell = document.getElementById('bellBtn');
  if (panel.classList.contains('open') && !panel.contains(e.target) && !bell.contains(e.target)) panel.classList.remove('open');
});
document.getElementById('clearNotifs').addEventListener('click', () => { notifications = []; renderNotifPanel(); });

// The filter panels live inside the Promotions workspace, which gets fully
// re-rendered often, so this looks the elements up fresh on every click
// rather than holding onto a reference that a re-render could detach.
document.addEventListener('click', (e) => {
  if (countryFilterOpen) {
    const wrap = document.getElementById('countryFilterWrap');
    if (wrap && !wrap.contains(e.target)) {
      countryFilterOpen = false;
      const panel = document.getElementById('countryFilterPanel');
      if (panel) panel.style.display = 'none';
    }
  }
  if (auditSupplierFilterOpen) {
    const wrap = document.getElementById('auditSupplierFilterWrap');
    if (wrap && !wrap.contains(e.target)) {
      auditSupplierFilterOpen = false;
      const panel = document.getElementById('auditSupplierFilterPanel');
      if (panel) panel.style.display = 'none';
    }
  }
});

async function runNotificationCheck() {
  const today = todayStr();
  const changedSellouts = new Set();
  for (const so of sellouts) {
    if (so.archived) continue;            // archived sell-outs never notify
    so.notifiedFlags = so.notifiedFlags || {};
    const daysToStart = daysBetween(today, so.from);
    const daysToEnd = daysBetween(today, so.to);
    const fire = (key, msg) => {
      if (so.notifiedFlags[key] === today) return;
      so.notifiedFlags[key] = today; changedSellouts.add(so); pushNotification(msg);
    };
    if (!so.active) {
      if (daysToStart === 1) fire('startSoon', `"${so.name}" starts tomorrow (${fmtDate(so.from)}) and is not activated yet.`);
      if (daysToStart === 0) fire('startDay', `"${so.name}" starts today and is still not activated.`);
      // Only while it is still running: an ended, never-activated one shows "Needs archiving" instead.
      if (daysToStart < 0 && daysToEnd >= 0) fire('startOverdue', `"${so.name}" was due to start on ${fmtDate(so.from)} and has still not been activated.`);
    }
    if (so.active) {
      if (daysToEnd === 1) fire('endSoon', `"${so.name}" ends tomorrow (${fmtDate(so.to)}) \u2014 remember to deactivate it.`);
      if (daysToEnd === 0) fire('endDay', `"${so.name}" ends today \u2014 deactivate it.`);
      if (daysToEnd < 0) fire('endOverdue', `"${so.name}" ended on ${fmtDate(so.to)} and is still active \u2014 deactivate it.`);
    }
  }
  // Only the flags are saved (not the whole row with its file).
  for (const so of changedSellouts) await updateSelloutFields(so.id, { notified_flags: so.notifiedFlags });
  renderNotifPanel();
}
setInterval(runNotificationCheck, 5 * 60 * 1000);
setInterval(runVendorNotificationCheck, 5 * 60 * 1000);

/* ============================================================
   Promotions - UI
   ============================================================ */
function renderCatalogInfo() {
  const el = document.getElementById('catalogInfo');
  const inline = document.getElementById('catalogSummaryInline');
  const uploadInput = document.getElementById('catalogFileInput');
  const promo = promotions.find(p => p.id === currentPromoId);

  if (!currentPromoId || !promo) {
    el.className = 'file-info empty';
    el.textContent = 'Select or create a promotion to manage its catalog.';
    if (inline) inline.textContent = 'Select or create a promotion first.';
    if (uploadInput) uploadInput.disabled = true;
    return;
  }
  if (uploadInput) uploadInput.disabled = false;

  if (!catalogItems.length) {
    el.className = 'file-info empty';
    el.textContent = `No catalog uploaded yet for "${promo.name}".`;
    if (inline) inline.textContent = `No catalog uploaded yet for "${promo.name}".`;
    return;
  }
  el.className = 'file-info';
  el.innerHTML = `
    <div>
      <div class="fi-name">${escapeHtml(catalogFileNames.get(currentPromoId) || 'Catalog on file')} <span class="muted-note">(for "${escapeHtml(promo.name)}")</span></div>
      <div class="fi-meta">${catalogItems.length} item${catalogItems.length === 1 ? '' : 's'} loaded</div>
    </div>
  `;
  if (inline) inline.textContent = `${catalogItems.length} item${catalogItems.length === 1 ? '' : 's'} loaded for "${promo.name}" \u2014 threshold ${lowStockThreshold}`;
}

function applyCatalogCollapse() {
  const bodyEl = document.getElementById('catalogBody');
  const chev = document.getElementById('catalogChevron');
  if (bodyEl) bodyEl.style.display = catalogCollapsed ? 'none' : '';
  if (chev) chev.style.transform = catalogCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
}
document.getElementById('toggleCatalogBtn').addEventListener('click', () => {
  catalogCollapsed = !catalogCollapsed;
  localStorage.setItem('sol-catalog-collapsed', String(catalogCollapsed));
  applyCatalogCollapse();
});

document.getElementById('catalogFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!currentPromoId) { showToast('Select or create a promotion first.', true); e.target.value = ''; return; }
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { showToast('Could not read that file \u2014 check the format.', true); e.target.value = ''; return; }
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Read as a plain array-of-rows (not sheet_to_json's default object form)
  // so each cell's exact position (row, column) is known — that's what lets
  // the code column below read each cell's own formatted display text
  // instead of its raw value.
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (aoa.length < 2) { showToast('That file has no rows.', true); e.target.value = ''; return; }
  const header = aoa[0];

  // Stripped down to letters/digits only, so "Supplier Desc", "Supplier_Desc",
  // "Supplier-Desc." etc. all normalize the same way and still match.
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  // Checks aliases in priority order (not header order): a real ERP export
  // often has both a short code column ("Supplier") and its description
  // ("Supplier Desc"). Scanning headers left-to-right would lock onto
  // whichever one happens to come first in the file, even if that's the
  // wrong one for what we want — so each alias is tried, in the order
  // given, against every header before moving to the next alias.
  const findExactIdx = (...wants) => {
    for (const want of wants) {
      const idx = header.findIndex(h => norm(h) === want);
      if (idx > -1) return idx;
    }
    return -1;
  };
  const codeIdxFound = findExactIdx('code', 'item', 'itemcode', 'sku');
  const codeIdx = codeIdxFound > -1 ? codeIdxFound : 0;
  const descIdxFound = findExactIdx('description', 'desc', 'itemdescription');
  const descIdx = descIdxFound > -1 ? descIdxFound : 1;
  const balanceIdx = findExactIdx('balance', 'stock', 'onhand', 'stockonhand', 'qtyonhand');
  const saleIdx = findExactIdx('saleprice', 'salesprice', 'price');
  const supplierIdx = findExactIdx('supplierdesc', 'supplier', 'suppliername', 'supplierdescription', 'vendordesc', 'vendor', 'vendorname');
  const countryIdx = findExactIdx('countrydesc', 'country', 'countryname', 'countryoforigin', 'origincountry');
  const outIdx = findExactIdx('out', 'outytd', 'ytdout', 'salesytd', 'ytdsales', 'qtyout', 'unitsout', 'totalout', 'soldytd');
  const barcodeIdx = findExactIdx(...BARCODE_HEADERS);
  const balanceKey = balanceIdx > -1, saleKey = saleIdx > -1, supplierKey = supplierIdx > -1, countryKey = countryIdx > -1, outKey = outIdx > -1;

  // Item codes are the join key against price-sheet/pasted codes, so they
  // need to match EXACTLY what a person sees in Excel — but Excel silently
  // strips leading zeros from a cell it decided was a number ("007123" →
  // 7123). Reading the raw value would bake that loss in; the cell's own
  // formatted display text (.w) is what Excel actually shows, so that's
  // used for the code column specifically (other columns keep using raw
  // values, since a formatted price like "$12.50" would break Number()).
  const codeCellText = (r, c) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) return '';
    if (typeof cell.w === 'string' && cell.w !== '') return cell.w;
    return cell.v === undefined || cell.v === null ? '' : String(cell.v);
  };

  const rawParsed = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i] || [];
    rawParsed.push({
      code: codeCellText(i, codeIdx).trim(),
      description: descIdx > -1 ? String(line[descIdx] ?? '').trim() : '',
      balance: (balanceKey && line[balanceIdx] !== '' && !isNaN(Number(line[balanceIdx]))) ? Number(line[balanceIdx]) : null,
      salePrice: (saleKey && line[saleIdx] !== '' && !isNaN(Number(line[saleIdx]))) ? Number(line[saleIdx]) : null,
      supplier: supplierKey ? String(line[supplierIdx] ?? '').trim() : '',
      country: countryKey ? String(line[countryIdx] ?? '').trim() : '',
      outYtd: (outKey && line[outIdx] !== '' && !isNaN(Number(line[outIdx]))) ? Number(line[outIdx]) : null,
      // Several barcodes per item: in one cell ("/ , ;" or spaces) or on repeated rows of the same code.
      barcodes: barcodeIdx > -1 ? splitBarcodes(barcodeCellText(ws, i, barcodeIdx)) : []
    });
  }
  const totalDataRows = aoa.length - 1;
  const withCode = rawParsed.filter(r => r.code);
  const skipped = totalDataRows - withCode.length;

  // Two rows sharing the same code would violate the catalog's unique-code
  // constraint within the same upload, so keep only the last occurrence of
  // each code (a re-exported catalog usually supersedes earlier duplicates).
  const byCode = new Map();
  withCode.forEach(r => {
    const prev = byCode.get(r.code);
    // Keep the last row's details, but collect every barcode seen for that code.
    if (prev) r.barcodes = [...new Set([...prev.barcodes, ...r.barcodes])];
    byCode.set(r.code, r);
  });
  const parsed = Array.from(byCode.values());
  const dupCount = withCode.length - parsed.length;

  if (!parsed.length) { showToast('Could not find an item code column in that file.', true); e.target.value = ''; return; }

  const ok = await replaceCatalog(parsed, file.name, currentPromoId);
  e.target.value = '';
  if (!ok) return;

  // A price sheet (or pasted/manually-typed codes) may already be on the
  // table from before this catalog existed -- those rows never got a
  // chance to match anything at the time, so re-check every row now that
  // the catalog is here. Works the same whichever order the two are done in.
  const relookedUp = relookupRowsAgainstCatalog(currentRows);
  if (relookedUp.length) await persistRowsBulk(relookedUp);

  renderCatalogInfo();
  await renderPromoWorkspace();

  const warnings = [];
  if (!balanceKey) warnings.push('no "Balance" column was found, so low-stock flags won’t work');
  if (!saleKey) warnings.push('no "Saleprice" column was found, so Sale Price won’t auto-fill');
  if (!supplierKey) warnings.push('no "Supplier" column was found, so supplier info won’t show');
  if (!countryKey) warnings.push('no "Country" column was found, so the country filter won’t have anything to show');
  if (!outKey) warnings.push('no "Out"/sales column was found, so the stock-weeks flag won’t work');
  if (skipped > 0) warnings.push(`${skipped} row${skipped === 1 ? '' : 's'} had no code and ${skipped === 1 ? 'was' : 'were'} skipped`);
  if (dupCount > 0 && barcodeIdx === -1) warnings.push(`${dupCount} duplicate code${dupCount === 1 ? '' : 's'} \u2014 kept the last row for each`);

  // With a barcode column, repeated codes are normal (one row per barcode): they are merged, not a warning.
  const barcodeCount = parsed.reduce((n, r) => n + r.barcodes.length, 0);
  const barcodeNote = barcodeIdx > -1 ? ` \u2014 ${barcodeCount} barcode${barcodeCount === 1 ? '' : 's'}${dupCount ? ` (${dupCount} repeated row${dupCount === 1 ? '' : 's'} merged)` : ''}` : '';
  const matchedNote = barcodeNote + (relookedUp.length ? ` \u2014 matched ${relookedUp.length} existing row${relookedUp.length === 1 ? '' : 's'} already on the table` : '');
  if (warnings.length) showToast(`Catalog updated (${parsed.length} items)${matchedNote} \u2014 but ${warnings.join('; ')}.`, true);
  else showToast(`Catalog updated \u2014 ${parsed.length} items loaded${matchedNote}.`);
});

document.getElementById('lowStockInput').addEventListener('change', async (e) => {
  const val = Number(e.target.value);
  if (isNaN(val)) { showToast('Enter a valid number for the threshold.', true); e.target.value = lowStockThreshold; return; }
  lowStockThreshold = val;
  await saveSettings();
  renderCatalogInfo();
  await renderPromoWorkspace();
  showToast(`Low-stock threshold set to ${val}.`);
});

// View-only (accountant): the page is re-rendered from many places, so every render is locked here.
// Buttons that change things are hidden by css (body.ro-promotions); Export, Copy codes, Download stay.
function lockPromotionsViewOnly() {
  if (canEditPromotions()) return;
  const root = document.getElementById('panel-promotions');
  root.querySelectorAll('input[data-field], #promoName, #promoFrom, #promoTo, .audit-note-input').forEach(i => { if (!i.readOnly) i.readOnly = true; });
  root.querySelectorAll('select[data-field], #promoAutoArchive, #catalogFileInput, #lowStockInput, [data-role="audit-type-btn"], [data-role="toggle-flag"]').forEach(i => { if (!i.disabled) i.disabled = true; });
}
new MutationObserver(lockPromotionsViewOnly).observe(document.getElementById('panel-promotions'), { childList: true, subtree: true });

function renderPromoTabstrip() {
  const strip = document.getElementById('promoTabstrip');
  const dropdown = document.getElementById('promoDropdown');
  const emptyEl = document.getElementById('promoEmpty');
  const archivedCount = promotions.filter(p => p.archived).length;
  const toggleBtn = document.getElementById('toggleArchivedBtn');
  if (toggleBtn) {
    toggleBtn.textContent = showArchivedPromos ? 'Active promotions' : `Archived (${archivedCount})`;
    toggleBtn.classList.toggle('secondary', showArchivedPromos);
  }

  const visible = promotions.filter(p => !!p.archived === showArchivedPromos);
  if (!visible.length) {
    strip.innerHTML = '';
    if (dropdown) dropdown.innerHTML = '<option value="">No promotions</option>';
    emptyEl.style.display = 'block';
    const bigP = emptyEl.querySelector('p.big');
    const smallP = emptyEl.querySelector('p:not(.big)');
    if (bigP) bigP.textContent = showArchivedPromos ? 'No archived promotions' : 'No promotions yet';
    if (smallP) smallP.textContent = showArchivedPromos ? 'Promotions archive automatically once their "To" date passes.' : 'Click "+ New promotion" to start one.';
    return;
  }
  emptyEl.style.display = 'none';
  strip.innerHTML = visible.map(p => `
    <button class="promo-tab ${p.id === currentPromoId ? 'active' : ''}" data-promo-id="${p.id}">${escapeHtml(p.name || 'Untitled')}</button>
  `).join('');
  strip.querySelectorAll('.promo-tab').forEach(btn => {
    btn.addEventListener('click', () => selectPromotion(btn.dataset.promoId));
  });

  if (dropdown) {
    dropdown.innerHTML = visible.map(p => `<option value="${p.id}" ${p.id === currentPromoId ? 'selected' : ''}>${escapeHtml(p.name || 'Untitled')}</option>`).join('');
  }
}

document.getElementById('promoDropdown').addEventListener('change', (e) => {
  if (e.target.value) selectPromotion(e.target.value);
});

document.getElementById('toggleArchivedBtn').addEventListener('click', async () => {
  showArchivedPromos = !showArchivedPromos;
  const visible = promotions.filter(p => !!p.archived === showArchivedPromos);
  const targetId = visible.length ? visible[0].id : null;
  if (targetId === currentPromoId) { renderPromoTabstrip(); await renderPromoWorkspace(); return; }
  await selectPromotion(targetId);
});

// The single place a promotion switch happens: loads that promotion's own
// rows AND its own catalog (each promotion has its own uploaded catalog
// file), then re-renders everything that depends on "which promotion is
// open" — the tab strip/dropdown, the catalog card, and the workspace.
async function selectPromotion(id) {
  if (id === currentPromoId) return;
  currentPromoId = id;
  selectedRowIds.clear();
  selectedCountries.clear();
  selectedCodeIssues.clear();
  countryFilterOpen = false;
  selectedAuditSuppliers.clear();
  auditSupplierFilterOpen = false;
  showFlaggedOnly = false;
  tableSearchQuery = '';
  if (id) {
    currentRows = await loadPromoRows(id);
    await loadCatalogFor(id);
  } else {
    currentRows = [];
    catalogItems = [];
    catalogMap = new Map();
  }
  renderPromoTabstrip();
  renderCatalogInfo();
  await renderPromoWorkspace();
}

document.getElementById('newPromoBtn').addEventListener('click', async () => {
  showArchivedPromos = false;
  const { from, to } = nextFridayToMonday();
  const promo = {
    id: uid(), name: `Promotion ${fmtDMY(from)}`, from, to,
    archived: false, autoArchive: true, createdAt: new Date().toISOString()
  };
  promotions.unshift(promo);
  await savePromotion(promo);
  await selectPromotion(promo.id);
  const nameField = document.getElementById('promoName');
  if (nameField) { nameField.focus(); nameField.select(); }
});

function rowStockBadgeHtml(row) {
  const isLow = row.balance !== null && row.balance !== undefined && Number(row.balance) < lowStockThreshold;
  return isLow
    ? '<span class="low-stock-badge"><span class="pulse"></span>Low stock</span>'
    : '<span class="ok-stock-note">\u2014</span>';
}
function numToStr(v) {
  if (v === null || v === undefined || v === '') return '';
  const rounded = round2(v);
  return rounded === null || rounded === undefined ? v : rounded;
}

// Which code issue (if any) a row has, for the Filter panel's "Code issues"
// checkboxes — the same two conditions the two code-issue icons use.
function codeIssueOf(row) {
  if (isCodeBlankWithData(row)) return 'missing';
  if (isCodeMissingFromCatalog(row)) return 'mismatch';
  return null;
}
// The one shared Filter (Country + Code issues) applies across every promo
// view — Table, Group-by-supplier and Audit all start from this same list.
function computeVisibleRows() {
  const countryOf = (row) => (row.country || '').trim() || 'No country listed';
  let rows = selectedCountries.size ? currentRows.filter(r => selectedCountries.has(countryOf(r))) : currentRows;
  if (selectedCodeIssues.size) {
    rows = rows.filter(r => { const issue = codeIssueOf(r); return issue && selectedCodeIssues.has(issue); });
  }
  return rows;
}
// The Flagged-only toggle and search box in the Table view's own toolbar
// narrow the visible rows further (on top of the Filter that applies to
// every view) — Group-by-supplier and Audit are unaffected.
function computeTableVisibleRows(visibleRows) {
  const q = tableSearchQuery.trim().toLowerCase();
  return visibleRows.filter(r => {
    if (showFlaggedOnly && !rowNeedsFlag(r)) return false;
    if (q) {
      const hay = `${r.code || ''} ${r.description || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function tableFilterStatusHtml(tableVisibleRows, visibleRows) {
  if (!tableSearchQuery && !showFlaggedOnly) return '';
  return `<button class="link-btn" id="clearTableFiltersBtn">Clear</button> <span class="muted-note">${tableVisibleRows.length} of ${visibleRows.length} shown</span>`;
}
function tableEmptyStateHtml(tableVisibleRows) {
  if (tableVisibleRows.length || !currentRows.length) return '';
  const reason = showFlaggedOnly && tableSearchQuery ? 'that search and the Flagged filter' : (showFlaggedOnly ? 'the Flagged filter' : 'that search');
  return `<div class="empty-state" style="padding:26px 16px;"><p>No rows match ${reason}.</p></div>`;
}
// Re-renders only the table body, the small "Clear / X of Y shown" status
// line, and the empty-state message — never the search box itself — so
// typing in the search box (or toggling Flagged only) never steals focus
// away from what you're typing.
function refreshPromoTableView() {
  const visibleRows = computeVisibleRows();
  const tableVisibleRows = computeTableVisibleRows(visibleRows);

  const body = document.getElementById('promoRowsBody');
  if (body) {
    body.innerHTML = tableVisibleRows.map(buildPromoRowHtml).join('');
    body.querySelectorAll('tr').forEach(tr => wirePromoRowElement(tr));
  }
  const statusEl = document.getElementById('tableFilterStatus');
  if (statusEl) {
    statusEl.innerHTML = tableFilterStatusHtml(tableVisibleRows, visibleRows);
    wireTableFilterStatus();
  }
  const emptyEl = document.getElementById('tableEmptyState');
  if (emptyEl) emptyEl.innerHTML = tableEmptyStateHtml(tableVisibleRows);
}
// The Filter button is an icon with a small count badge (no text label), so
// this builds its inner markup from the combined Country + Code-issue +
// Flagged-only count — shared by the initial render and the lightweight
// refresh path below so the two never drift out of sync.
function filterButtonInnerHtml(count) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5Z"/></svg>${count ? `<span class="icon-btn-badge">${count}</span>` : ''}`;
}
// Kept in sync here too, since this is called from the Table view's
// lightweight refresh path, which doesn't touch the shared header where
// that button lives.
function updateFilterButtonLabel() {
  const btn = document.getElementById('countryFilterBtn');
  if (!btn) return;
  const count = selectedCountries.size + selectedCodeIssues.size + (showFlaggedOnly ? 1 : 0);
  btn.innerHTML = filterButtonInnerHtml(count);
}
function wireTableFilterStatus() {
  const clearBtn = document.getElementById('clearTableFiltersBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      tableSearchQuery = '';
      showFlaggedOnly = false;
      const searchInput = document.getElementById('tableSearchInput');
      if (searchInput) searchInput.value = '';
      const flaggedCb = document.querySelector('#countryFilterPanel [data-role="flagged-only-option"]');
      if (flaggedCb) flaggedCb.checked = false;
      updateFilterButtonLabel();
      refreshPromoTableView();
    });
  }
}

function buildPromoRowHtml(row) {
  const priceRisk = isPriceRisk(row);
  const needsFlag = rowNeedsFlag(row);
  const gapUnusual = isPriceGapUnusual(row);
  const flagTitle = row.flagged
    ? 'Flagged for review — click to unflag'
    : (priceRisk ? 'Promo price is under 25% of the sale price — click to dismiss'
      : (gapUnusual ? 'Promo price is not below the sale price — click to dismiss' : 'Flag this row for review'));
  const supplierOpen = expandedSupplierRowIds.has(row.id);
  const supplierRow = supplierOpen ? `
  <tr class="supplier-detail-row" data-supplier-row-id="${row.id}">
    <td colspan="11" style="background:var(--paper);font-size:12.5px;color:var(--ink-soft);padding:6px 10px 8px 40px;">
      Supplier: <strong style="color:var(--ink);">${escapeHtml(row.supplier || 'Not listed in the catalog')}</strong>
      &nbsp;&middot;&nbsp; Country: <strong style="color:var(--ink);">${escapeHtml(row.country || 'Not listed in the catalog')}</strong>
    </td>
  </tr>` : '';
  return `
  <tr data-row-id="${row.id}">
    <td class="rowact-col">
      <div class="icon-actions">
        <button class="icon-btn" data-role="insert-row" tabindex="-1" title="Insert row below" aria-label="Insert row below">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button class="icon-btn" data-role="insert-rows-bulk" tabindex="-1" title="Insert multiple rows below" aria-label="Insert multiple rows below">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h10"/><path d="M17 15v6M14 18h6"/></svg>
        </button>
        <button class="icon-btn danger" data-role="remove-row" tabindex="-1" title="Remove row" aria-label="Remove row">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>
    </td>
    <td class="chk-col"><input type="checkbox" data-role="select-row" tabindex="-1" ${selectedRowIds.has(row.id) ? 'checked' : ''}></td>
    <td class="code-cell">
      <div class="code-cell-wrap">
        <input type="text" class="${isDuplicateCodeInPromo(row) ? 'cell-duplicate' : ''}" value="${escapeHtml(row.code)}" data-field="code" placeholder="Code" title="${isDuplicateCodeInPromo(row) ? 'This code appears more than once in this promotion' : ''}">
        <span class="code-issue-icon mismatch-icon" data-role="mismatch-icon" title="${MISMATCH_TITLE}" style="display:${isCodeMissingFromCatalog(row) ? 'inline-flex' : 'none'};">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
        </span>
        <span class="code-issue-icon empty-code-icon" data-role="empty-code-icon" title="${EMPTY_CODE_TITLE}" style="display:${isCodeBlankWithData(row) ? 'inline-flex' : 'none'};">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="0.75" fill="currentColor" stroke="none"/></svg>
        </span>
      </div>
    </td>
    <td class="desc-cell"><input type="text" value="${escapeHtml(row.description)}" data-field="description" placeholder="Description"></td>
    <td class="balance-cell"><input type="text" inputmode="decimal" class="${isPromoPriceMissing(row) ? 'cell-missing' : ''}" value="${numToStr(row.promoPrice)}" data-field="promoPrice" placeholder="0.00" title="${isPromoPriceMissing(row) ? 'Missing the promo price' : ''}"></td>
    <td class="balance-cell"><input type="text" inputmode="decimal" value="${numToStr(row.beforePrice)}" data-field="beforePrice" placeholder="0.00"></td>
    <td class="balance-cell">
      <div class="discount-cell-wrap">
        <input type="text" inputmode="decimal" value="${numToStr(row.discount)}" data-field="discount" placeholder="0%">
        <span class="big-discount-dot" data-role="big-discount-dot" title="Promo price is more than 25% below the sale price" style="display:${isBigDiscount(row) ? 'inline-block' : 'none'};"></span>
      </div>
    </td>
    <td class="balance-cell"><input type="text" inputmode="decimal" value="${numToStr(row.salePrice)}" data-field="salePrice" placeholder="0.00"></td>
    <td class="balance-cell mono" data-role="gap-display" style="color:var(--ink-soft);text-align:right;padding-right:10px;" title="Auto-calculated from Sale Price and Promo Price">${gapPctDisplay(row)}</td>
    <td class="stock-cell">
      <div class="stock-cell-wrap">
        <input type="text" inputmode="numeric" class="stock-input" value="${numToStr(row.balance)}" data-field="balance" placeholder="0">
        <span class="stock-badge-slot">${rowStockBadgeHtml(row)}</span>
      </div>
    </td>
    <td class="row-actions">
      <div class="icon-actions">
        <button class="icon-btn ${supplierOpen ? 'flag-on' : ''}" data-role="toggle-supplier" tabindex="-1" title="${supplierOpen ? 'Hide supplier' : 'Show supplier'}" aria-label="Show supplier">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V6a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v14"/><path d="M6 20h12"/><path d="M9 9h1M14 9h1M9 13h1M14 13h1"/><path d="M10 20v-4h4v4"/></svg>
        </button>
        <button class="icon-btn ${needsFlag ? 'flag-on' : ''}" data-role="toggle-flag" tabindex="-1" title="${flagTitle}" aria-label="Flag row">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4a1 1 0 0 1 1-1h11.2a.6.6 0 0 1 .45 1l-3.15 4 3.15 4a.6.6 0 0 1-.45 1H6"/></svg>
        </button>
      </div>
    </td>
  </tr>${supplierRow}`;
}

async function renderPromoWorkspace() {
  const workspace = document.getElementById('promoWorkspace');
  if (!currentPromoId) { workspace.innerHTML = ''; return; }
  const promo = promotions.find(p => p.id === currentPromoId);
  if (!promo) { workspace.innerHTML = ''; return; }

  // Everything below builds one large template and then wires up its
  // buttons/inputs. If any of it throws (bad data, an edge case a specific
  // view hits), the assignment to workspace.innerHTML never happens and the
  // whole Promotions workspace goes blank with no clue why. This try/catch
  // is the last line of defense: it can't fix the underlying bug, but it
  // keeps the page usable and puts the actual error on screen instead of a
  // blank panel, so it can be diagnosed and fixed.
  try {
  const countryOf = (row) => (row.country || '').trim() || 'No country listed';
  const allCountries = Array.from(new Set(currentRows.map(countryOf))).sort((a, b) => a.localeCompare(b));
  const visibleRows = computeVisibleRows();

  // The supplier filter lives only in the Audit view, narrowing that view's
  // own list further — it doesn't touch the Table or Group-by-supplier views.
  const supplierOf = (row) => (row.supplier || '').trim() || 'No supplier listed';
  const auditRows = auditableRows(visibleRows);
  const auditSupplierOptions = Array.from(new Set(auditRows.map(supplierOf))).sort((a, b) => a.localeCompare(b));
  const auditVisibleRows = selectedAuditSuppliers.size ? auditRows.filter(r => selectedAuditSuppliers.has(supplierOf(r))) : auditRows;

  const tableVisibleRows = computeTableVisibleRows(visibleRows);
  const rowsHtml = safeSectionHtml('Table → All rows', () => tableVisibleRows.map(buildPromoRowHtml).join(''));
  const promoStats = computePromoStats(visibleRows);

  workspace.innerHTML = `
    <div class="card promo-header-card">
      <div class="promo-header-fields">
        <div class="field">
          <label for="promoName">Promotion name ${promo.archived ? '<span class="muted-note">(archived)</span>' : ''}</label>
          <input type="text" id="promoName" value="${escapeHtml(promo.name)}">
        </div>
        <div class="field">
          <label for="promoFrom">From</label>
          <input type="date" id="promoFrom" value="${promo.from || ''}">
        </div>
        <div class="field">
          <label for="promoTo">To</label>
          <input type="date" id="promoTo" value="${promo.to || ''}">
        </div>
        <div class="field" style="min-width:auto;flex:0 0 auto;align-self:flex-end;padding-bottom:9px;">
          <label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;font-weight:400;">
            <input type="checkbox" id="promoAutoArchive" ${promo.autoArchive !== false ? 'checked' : ''} style="width:auto;">
            Auto-archive after "To" date
          </label>
        </div>
      </div>
      <div class="promo-header-actions">
        <button class="btn secondary small" id="importPriceSheetBtn" title="Upload the raw supplier price sheet — splits multi-codes into rows and fills in Promo/Before Price automatically">Import price sheet</button>
        <input type="file" id="priceSheetInput" accept=".xlsx,.xls,.csv" style="display:none;">
        <button class="btn secondary small" id="copyCodesBtn">Copy codes</button>
        <button class="btn secondary small" id="exportPromoBtn">Export to Excel</button>
        <button class="btn ghost small" id="toggleArchivePromoBtn">${promo.archived ? 'Unarchive' : 'Archive now'}</button>
        <button class="btn ghost small" id="deletePromoBtn">Delete</button>
      </div>
      ${promo.sourceFileName ? `
      <div class="file-info" style="flex:1 1 100%;">
        <div><span class="fi-name">${escapeHtml(promo.sourceFileName)}</span><div class="fi-meta">Original price sheet saved to this promotion</div></div>
        <button class="btn ghost small" id="downloadSourceFileBtn">Download</button>
      </div>` : ''}
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;">
        <div>
          <p class="muted-note" style="margin:0 0 4px;">${promoStats.total} row${promoStats.total === 1 ? '' : 's'} \u00b7 ${promoStats.flagged} flagged \u00b7 ${promoStats.empty} empty row${promoStats.empty === 1 ? '' : 's'}</p>
          <p class="muted-note" style="margin:0 0 10px;">${promoViewMode === 'audit'
            ? (auditSubView === 'supplier'
              ? 'Items with a cost on file, grouped by supplier, for setting Type and adding a note without one long list.'
              : 'Code and description next to the cost from the imported price sheet, for a manual check. Items with no cost on file are left out.')
            : (tableSubView === 'supplier'
              ? 'Every item grouped by supplier, with stock, Out (YTD) and a reorder recommendation for each.'
              : !canEditPromotions() ? 'View only: only an admin can change promotions. Export to Excel or Download to get the file.'
              : 'Tip: copy a block of cells from Excel and paste directly into the table \u2014 it will fill rows and columns starting from where you paste, adding new rows if needed. Enter moves down a column, Tab at the last field adds a new row.')}</p>
        </div>
        <div class="view-toolbar" style="border:none;background:none;padding:0;margin:0;">
          <div class="filter-row" id="promoViewSwitch" style="margin:0;">
            <button class="${promoViewMode === 'table' ? 'active' : ''}" data-view="table">Table</button>
            <button class="${promoViewMode === 'audit' ? 'active' : ''}" data-view="audit">Audit</button>
          </div>
          <div class="filter-dropdown-wrap" id="countryFilterWrap" style="margin-left:auto;">
            <button class="icon-btn" id="countryFilterBtn" title="Filter" aria-label="Filter">${filterButtonInnerHtml(selectedCountries.size + selectedCodeIssues.size + (showFlaggedOnly ? 1 : 0))}</button>
            <div class="filter-panel filter-panel-up" id="countryFilterPanel" style="display:${countryFilterOpen ? 'block' : 'none'};">
              <div class="filter-panel-head">
                <span>Filters</span>
                <button class="link-btn" id="clearAllFiltersBtn">Clear all</button>
              </div>
              <div class="filter-panel-section">
                <label class="filter-panel-option"><input type="checkbox" data-role="flagged-only-option" ${showFlaggedOnly ? 'checked' : ''}> Flagged only</label>
              </div>
              <div class="filter-panel-section">
                <p class="filter-panel-label">Code issues</p>
                <label class="filter-panel-option"><input type="checkbox" value="missing" data-role="code-issue-option" ${selectedCodeIssues.has('missing') ? 'checked' : ''}> Missing code</label>
                <label class="filter-panel-option"><input type="checkbox" value="mismatch" data-role="code-issue-option" ${selectedCodeIssues.has('mismatch') ? 'checked' : ''}> Not in catalog</label>
              </div>
              <div class="filter-panel-section" id="countryFilterSection">
                ${countryFilterSectionHtml(allCountries)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div id="promoTableView" style="display:${promoViewMode === 'table' ? '' : 'none'};">
        <div class="filter-row" id="tableSubViewSwitch" style="margin-bottom:12px;">
          <button class="${tableSubView === 'rows' ? 'active' : ''}" data-table-sub="rows">All rows</button>
          <button class="${tableSubView === 'supplier' ? 'active' : ''}" data-table-sub="supplier">By supplier</button>
        </div>

        <div id="promoTableRowsView" style="display:${tableSubView === 'rows' ? '' : 'none'};">
        <div class="view-toolbar">
          <input type="text" id="tableSearchInput" placeholder="Search code or description…" style="max-width:260px;" value="${escapeHtml(tableSearchQuery)}">
          <span id="tableFilterStatus">${tableFilterStatusHtml(tableVisibleRows, visibleRows)}</span>
        </div>
        <div class="items-scroll">
          <table class="promo">
            <thead><tr>
              <th class="rowact-col"></th>
              <th class="chk-col"><input type="checkbox" id="selectAllRows"></th>
              <th class="code-cell">Code</th><th class="desc-cell">Description</th><th class="balance-cell">Promo Price</th><th class="balance-cell">Before Price</th><th class="balance-cell">Discount</th><th class="balance-cell">Sale Price</th><th class="balance-cell" title="Auto-calculated — the price gap Sale Price and Promo Price already imply. Purely informational; doesn't affect Discount or Audit type.">Gap</th><th class="stock-cell">Stock</th><th></th>
            </tr></thead>
            <tbody id="promoRowsBody">${rowsHtml}</tbody>
          </table>
          <div id="tableEmptyState">${tableEmptyStateHtml(tableVisibleRows)}</div>
        </div>
        <div class="promo-table-foot">
          <div class="promo-foot-actions">
            <button class="btn secondary small" id="addRowBtn">+ Add row</button>
            <button class="btn secondary small" id="addRowsBulkBtn">+ Add rows\u2026</button>
            <button class="btn ghost small" id="applyDiscountSelectedBtn" style="display:${selectedRowIds.size ? 'inline-flex' : 'none'};">Apply discount to selected (${selectedRowIds.size})</button>
            <button class="btn ghost small" id="deleteSelectedBtn" style="display:${selectedRowIds.size ? 'inline-flex' : 'none'};color:var(--brick);">Delete selected (${selectedRowIds.size})</button>
          </div>
          <span class="muted-note">${currentRows.length} item${currentRows.length === 1 ? '' : 's'}</span>
        </div>
        </div>

        <div id="promoTableSupplierView" style="display:${tableSubView === 'supplier' ? '' : 'none'};">
          ${tableSubView === 'supplier' ? safeSectionHtml('Table → By supplier', () => buildSupplierGroupedHtml(visibleRows, 'stock')) : ''}
        </div>
      </div>

      <div id="promoAuditView" style="display:${promoViewMode === 'audit' ? '' : 'none'};">
        <div class="filter-row" id="auditSubViewSwitch" style="margin-bottom:12px;">
          <button class="${auditSubView === 'cost' ? 'active' : ''}" data-audit-sub="cost">Cost check</button>
          <button class="${auditSubView === 'supplier' ? 'active' : ''}" data-audit-sub="supplier">By supplier</button>
        </div>

        <div id="promoAuditCostView" style="display:${auditSubView === 'cost' ? '' : 'none'};">
          <div class="view-toolbar" style="justify-content:space-between;">
            <div class="filter-dropdown-wrap" id="auditSupplierFilterWrap">
              <button class="btn ghost small" id="auditSupplierFilterBtn">Filter by supplier${selectedAuditSuppliers.size ? ` (${selectedAuditSuppliers.size})` : ''}</button>
              <div class="filter-panel" id="auditSupplierFilterPanel" style="display:${auditSupplierFilterOpen ? 'block' : 'none'};">
                <div class="filter-panel-head">
                  <span>Supplier</span>
                  <button class="link-btn" id="clearAuditSupplierFilterBtn">Clear</button>
                </div>
                ${auditSupplierOptions.length > 6 ? `
                <div class="filter-panel-search-wrap">
                  <input type="text" id="auditSupplierSearchInput" placeholder="Search suppliers…" value="${escapeHtml(auditSupplierFilterSearchQuery)}">
                </div>` : ''}
                ${auditSupplierOptions.length ? auditSupplierOptions.map(s => `
                  <label class="filter-panel-option" data-supplier-label="${escapeHtml(s.toLowerCase())}"><input type="checkbox" value="${escapeHtml(s)}" data-role="audit-supplier-option" ${selectedAuditSuppliers.has(s) ? 'checked' : ''}> ${escapeHtml(s)}</label>
                `).join('') : '<p class="muted-note" style="padding:8px 10px;">No supplier data yet.</p>'}
                <p class="muted-note" id="auditSupplierSearchEmpty" style="display:none;padding:2px 12px 10px;">No matching suppliers.</p>
              </div>
            </div>
            <button class="btn secondary small" id="printAuditBtn">Print</button>
          </div>
          ${auditSubView === 'cost' ? safeSectionHtml('Audit → Cost check', () => buildAuditHtml(auditVisibleRows)) : ''}
        </div>

        <div id="promoAuditSupplierView" style="display:${auditSubView === 'supplier' ? '' : 'none'};">
          ${auditSubView === 'supplier' ? safeSectionHtml('Audit → By supplier', () => buildSupplierGroupedHtml(visibleRows, 'audit')) : ''}
        </div>
      </div>
    </div>
  `;

  wirePromoWorkspaceEvents(promo);
  if (promoViewMode === 'table' && tableSubView === 'supplier') wireSupplierGroupEvents('promoTableSupplierView', 'stock');
  if (promoViewMode === 'audit' && auditSubView === 'supplier') wireSupplierGroupEvents('promoAuditSupplierView', 'audit');
  if (promoViewMode === 'table') {
    document.querySelectorAll('#tableSubViewSwitch [data-table-sub]').forEach(btn => {
      btn.addEventListener('click', async () => {
        tableSubView = btn.dataset.tableSub;
        await renderPromoWorkspace();
      });
    });
  }
  if (promoViewMode === 'audit') {
    document.querySelectorAll('#auditSubViewSwitch [data-audit-sub]').forEach(btn => {
      btn.addEventListener('click', async () => {
        auditSubView = btn.dataset.auditSub;
        await renderPromoWorkspace();
      });
    });

    const printBtn = document.getElementById('printAuditBtn');
    if (printBtn) printBtn.addEventListener('click', () => printAuditTable(promo, auditVisibleRows));

    document.querySelectorAll('#promoAuditView [data-role="audit-type-btn"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = currentRows.find(r => r.id === btn.dataset.rowId);
        if (!row) return;
        // Clicking the already-active type clears it back to "no type", so
        // the buttons can also represent the dropdown's old blank option.
        row.priceType = row.priceType === btn.dataset.type ? '' : btn.dataset.type;
        await savePromoRow(row);
        await renderPromoWorkspace();
      });
    });

    document.querySelectorAll('#promoAuditView [data-role="audit-note-input"]').forEach(input => {
      input.addEventListener('blur', async () => {
        const row = currentRows.find(r => r.id === input.dataset.rowId);
        if (!row) return;
        row.note = input.value;
        await savePromoRow(row);
      });
    });

    const auditSupplierBtn = document.getElementById('auditSupplierFilterBtn');
    const auditSupplierPanel = document.getElementById('auditSupplierFilterPanel');
    if (auditSupplierBtn && auditSupplierPanel) {
      auditSupplierBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        auditSupplierFilterOpen = !auditSupplierFilterOpen;
        auditSupplierPanel.style.display = auditSupplierFilterOpen ? 'block' : 'none';
      });
      auditSupplierPanel.addEventListener('click', (e) => e.stopPropagation());
      auditSupplierPanel.querySelectorAll('[data-role="audit-supplier-option"]').forEach(cb => {
        cb.addEventListener('change', async () => {
          if (cb.checked) selectedAuditSuppliers.add(cb.value); else selectedAuditSuppliers.delete(cb.value);
          auditSupplierFilterOpen = true;
          await renderPromoWorkspace();
        });
      });
      // Purely client-side show/hide of the already-rendered labels, same
      // approach as the Country search above — no re-render, so typing here
      // never loses focus.
      const applyAuditSupplierSearch = () => {
        const q = auditSupplierFilterSearchQuery.trim().toLowerCase();
        let anyVisible = false;
        auditSupplierPanel.querySelectorAll('[data-supplier-label]').forEach(label => {
          const match = !q || label.dataset.supplierLabel.includes(q);
          label.style.display = match ? '' : 'none';
          if (match) anyVisible = true;
        });
        const emptyMsg = document.getElementById('auditSupplierSearchEmpty');
        if (emptyMsg) emptyMsg.style.display = (q && !anyVisible) ? '' : 'none';
      };
      const auditSupplierSearchInput = document.getElementById('auditSupplierSearchInput');
      if (auditSupplierSearchInput) {
        auditSupplierSearchInput.addEventListener('input', () => {
          auditSupplierFilterSearchQuery = auditSupplierSearchInput.value;
          applyAuditSupplierSearch();
        });
      }
      applyAuditSupplierSearch();
      const clearAuditSupplierBtn = document.getElementById('clearAuditSupplierFilterBtn');
      if (clearAuditSupplierBtn) clearAuditSupplierBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        selectedAuditSuppliers.clear();
        auditSupplierFilterSearchQuery = '';
        auditSupplierFilterOpen = true;
        await renderPromoWorkspace();
      });
    }
  }
  } catch (e) {
    console.error('Error rendering promo workspace:', e);
    workspace.innerHTML = `
      <div class="empty-state" style="padding:40px 20px;">
        <p class="big">Something went wrong showing this promotion</p>
        <p>${escapeHtml(e && e.message ? e.message : String(e))}</p>
        <p class="muted-note" style="margin-top:10px;">Try switching to another promotion and back, or reloading the page. If it keeps happening, this error message is what to report.</p>
      </div>`;
  }
}

// The Country half of the shared Filter panel, factored out so it can be
// rebuilt on its own (see refreshCountryFilterOptions below) without
// touching the Code issues section that sits above it in the same panel.
function countryFilterSectionHtml(allCountries) {
  // All countries are always rendered (never server-filtered) so the search
  // box below can just show/hide existing labels as the person types,
  // instead of rebuilding the list and losing focus on every keystroke.
  return `
    <p class="filter-panel-label">Country</p>
    ${allCountries.length > 6 ? `
    <div class="filter-panel-search-wrap">
      <input type="text" data-role="country-search" placeholder="Search countries…" value="${escapeHtml(countryFilterSearchQuery)}">
    </div>` : ''}
    ${allCountries.length ? allCountries.map(c => `
      <label class="filter-panel-option" data-country-label="${escapeHtml(c.toLowerCase())}"><input type="checkbox" value="${escapeHtml(c)}" data-role="country-option" ${selectedCountries.has(c) ? 'checked' : ''}> ${escapeHtml(c)}</label>
    `).join('') : '<p class="muted-note" style="padding:2px 12px 10px;">No country data in the catalog yet.</p>'}
    <p class="muted-note" data-role="country-search-empty" style="display:none;padding:2px 12px 10px;">No matching countries.</p>
  `;
}
// Filters the already-rendered Country checkbox list by the search box's
// text, purely by toggling each label's visibility — no re-render, so the
// input never loses focus while typing.
function applyCountryFilterSearch() {
  const section = document.getElementById('countryFilterSection');
  if (!section) return;
  const q = countryFilterSearchQuery.trim().toLowerCase();
  let anyVisible = false;
  section.querySelectorAll('[data-country-label]').forEach(label => {
    const match = !q || label.dataset.countryLabel.includes(q);
    label.style.display = match ? '' : 'none';
    if (match) anyVisible = true;
  });
  const emptyMsg = section.querySelector('[data-role="country-search-empty"]');
  if (emptyMsg) emptyMsg.style.display = (q && !anyVisible) ? '' : 'none';
}
function wireCountryFilterSearch() {
  const input = document.querySelector('#countryFilterSection [data-role="country-search"]');
  if (input) {
    input.addEventListener('input', () => {
      countryFilterSearchQuery = input.value;
      applyCountryFilterSearch();
    });
  }
  applyCountryFilterSearch();
}
// Editing a single row's code (doLookup) updates that row in place rather than
// doing a full renderPromoWorkspace(), for speed — but that means the Filter
// panel's country list (built once, at the last full render) can miss a
// country that only just became known. Rebuilding just this section keeps
// the list current without paying for a full re-render on every keystroke.
function refreshCountryFilterOptions() {
  const section = document.getElementById('countryFilterSection');
  if (!section) return;
  const countryOf = (row) => (row.country || '').trim() || 'No country listed';
  const allCountries = Array.from(new Set(currentRows.map(countryOf))).sort((a, b) => a.localeCompare(b));
  section.innerHTML = countryFilterSectionHtml(allCountries);
  section.querySelectorAll('[data-role="country-option"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      if (cb.checked) selectedCountries.add(cb.value); else selectedCountries.delete(cb.value);
      countryFilterOpen = true;
      await renderPromoWorkspace();
    });
  });
  wireCountryFilterSearch();
}

function buildSupplierGroupedHtml(rows, mode) {
  mode = mode === 'audit' ? 'audit' : 'stock';
  const relevant = mode === 'audit'
    ? auditableRows(rows)
    : rows.filter(r => (r.code || '').trim() || (r.description || '').trim());
  if (!relevant.length) {
    return mode === 'audit' ? `
      <div class="empty-state" style="padding:34px 16px;">
        <p class="big">No cost data yet</p>
        <p>Cost comes in from "Import price sheet" &mdash; items without a cost in that file are left out here.</p>
      </div>` : `
      <div class="empty-state" style="padding:34px 16px;">
        <p class="big">Nothing to group yet</p>
        <p>Add a code or description to a row, then come back here.</p>
      </div>`;
  }
  const bySupplier = new Map();
  relevant.forEach(r => {
    const key = (r.supplier || '').trim() || 'No supplier listed';
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(r);
  });
  const supplierNames = Array.from(bySupplier.keys()).sort((a, b) => a.localeCompare(b));

  const stockSubTable = (label, list) => {
    if (!list.length) return '';
    // Items that need reordering (out of stock, or trending that way) are
    // sorted to the top of their table, so the ones that actually need
    // attention are the first thing seen when the group is opened, instead
    // of being buried among items that are fine.
    const sorted = list.slice().sort((a, b) => {
      const aReorder = needsReorder(a) ? 0 : 1;
      const bReorder = needsReorder(b) ? 0 : 1;
      return aReorder - bReorder;
    });
    return `
      <h4>${label} (${list.length})</h4>
      <div class="items-scroll" style="margin-bottom:14px;">
        <table class="items">
          <thead><tr><th>Code</th><th>Description</th><th>Promo Price</th><th>Discount</th><th>Stock</th><th>Out (YTD)</th><th>Recommendation</th></tr></thead>
          <tbody>
            ${sorted.map(r => {
              const weeks = weeksOfStockLeft(r);
              const reorder = needsReorder(r);
              const recTitle = weeks !== null
                ? `At this year's sales pace, stock covers about ${weeks.toFixed(1)} week${weeks < 2 ? '' : 's'}`
                : (reorder ? 'Stock is below the low-stock threshold' : 'No Out (YTD) figure on file — based on stock level only');
              const recCell = reorder
                ? `<span class="low-stock-badge" title="${recTitle}"><span class="pulse"></span>Order</span>`
                : `<span class="badge active" title="${recTitle}">OK</span>`;
              const discCell = (r.discount === null || r.discount === undefined || r.discount === '') ? '' : `${numToStr(r.discount)}%`;
              return `<tr class="${reorder ? 'needs-order-row' : ''}"><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.description)}</td><td>${numToStr(r.promoPrice)}</td><td>${discCell}</td><td>${numToStr(r.balance)}</td><td>${r.outYtd === null || r.outYtd === undefined ? '' : numToStr(r.outYtd)}</td><td>${recCell}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  };

  const auditSubTable = (list) => {
    if (!list.length) return '';
    return `
      <div class="items-scroll" style="margin-bottom:14px;">
        <table class="items">
          <thead><tr><th>Code</th><th>Description</th><th style="text-align:right;">Cost</th><th>Type</th><th>Note</th></tr></thead>
          <tbody>${list.map(r => `
          <tr class="${auditRowClass(r.priceType)}">
            <td>${escapeHtml(r.code)}</td>
            <td>${escapeHtml(r.description)}</td>
            <td style="text-align:right;">${escapeHtml(r.cost || '')}</td>
            <td>${auditTypeButtonsHtml(r)}</td>
            <td><input type="text" class="audit-note-input" data-role="audit-note-input" data-row-id="${r.id}" value="${escapeHtml(r.note || '')}" placeholder="Note"></td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`;
  };

  // In the stock view, a supplier that has at least one out-of-stock item
  // needs attention, so its group is moved to the top of the accordion (ahead
  // of the plain alphabetical order) and its header carries a red "Order"
  // tag — a glance at the list top tells you which suppliers to order from,
  // without opening every group.
  const supplierNeedsOrder = new Map();
  if (mode === 'stock') {
    supplierNames.forEach(name => {
      supplierNeedsOrder.set(name, bySupplier.get(name).some(needsReorder));
    });
  }
  const orderedSupplierNames = mode === 'stock'
    ? supplierNames.slice().sort((a, b) => {
        const aFlag = supplierNeedsOrder.get(a) ? 0 : 1;
        const bFlag = supplierNeedsOrder.get(b) ? 0 : 1;
        if (aFlag !== bFlag) return aFlag - bFlag;
        return a.localeCompare(b);
      })
    : supplierNames;

  return orderedSupplierNames.map(name => {
    const items = bySupplier.get(name);
    const isOpen = expandedSupplierGroups.has(name);
    const flaggedForOrder = mode === 'stock' && supplierNeedsOrder.get(name);
    let bodyHtml;
    if (mode === 'audit') {
      bodyHtml = auditSubTable(items);
    } else {
      const sellouts = items.filter(r => r.priceType === 'sellout');
      const cns = items.filter(r => r.priceType === 'cn');
      const rightprice = items.filter(r => r.priceType === 'rightprice');
      const untyped = items.filter(r => !r.priceType);
      bodyHtml = stockSubTable('Sell Out', sellouts) + stockSubTable('C/N', cns) + stockSubTable('Right Price', rightprice) + stockSubTable('No type', untyped);
    }
    const countLabel = `${items.length} item${items.length === 1 ? '' : 's'}`;
    const orderTagHtml = flaggedForOrder
      ? `<span class="action-flag danger" title="At least one item from this supplier needs reordering"><span class="pulse"></span>Order</span>`
      : '';
    return `
    <div class="sellout ${isOpen ? 'open' : ''}${flaggedForOrder ? ' needs-action flag-danger' : ''}" data-supplier-group="${escapeHtml(name)}">
      <div class="sellout-head" data-role="supplier-group-toggle">
        <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
        <div class="who">
          <div class="name">${escapeHtml(name)}</div>
          <div class="dates">${countLabel}</div>
        </div>
        ${orderTagHtml}
        <button class="btn ghost small" data-role="copy-supplier-codes" data-supplier="${escapeHtml(name)}">Copy codes</button>
      </div>
      <div class="sellout-body">
        ${bodyHtml}
      </div>
    </div>`;
  }).join('');
}

// Code + description next to the cost pulled in from "Import price sheet",
// so someone can print it and check the numbers by hand against invoices.
// A row with no cost on file (typed manually, or the source sheet had none)
// is left out rather than shown with a blank. Cost is kept as free text
// (not parsed to a number) since real cost cells carry deal notation like
// "5+1" or plain notes like "sell out", not just a price.
function auditableRows(rows) {
  return rows.filter(r => r.cost !== null && r.cost !== undefined && r.cost !== '');
}
function auditRowClass(priceType) {
  if (priceType === 'sellout') return 'audit-row-sellout';
  if (priceType === 'cn') return 'audit-row-cn';
  if (priceType === 'rightprice') return 'audit-row-rightprice';
  return '';
}
const AUDIT_TYPE_BUTTONS = [
  { type: 'rightprice', label: 'Right Price', icon: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>' },
  { type: 'cn', label: 'C/N', icon: '<path d="M5 3h11l3 3v15H5z"/><path d="M9 8h6M9 12h6M9 16h3"/>' },
  { type: 'sellout', label: 'Sell Out', icon: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>' }
];
function auditTypeButtonsHtml(row) {
  return `
    <div class="audit-type-btns">
      ${AUDIT_TYPE_BUTTONS.map(b => `<button type="button" class="audit-type-btn ${row.priceType === b.type ? 'active' : ''}" data-role="audit-type-btn" data-row-id="${row.id}" data-type="${b.type}" title="${b.label}" aria-label="${b.label}"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${b.icon}</svg></button>`).join('')}
    </div>`;
}
function buildAuditHtml(auditRows) {
  if (!auditRows.length) {
    return `
    <div class="empty-state" style="padding:40px 20px;">
      <p class="big">No cost data yet</p>
      <p>Cost comes in from "Import price sheet" — items without a cost in that file (or filtered out by supplier) are left out here.</p>
    </div>`;
  }
  return `
    <div class="items-scroll">
      <table class="items">
        <thead><tr><th>Code</th><th>Description</th><th style="text-align:right;">Cost</th><th>Type</th><th>Note</th></tr></thead>
        <tbody>${auditRows.map(r => `
        <tr class="${auditRowClass(r.priceType)}">
          <td>${escapeHtml(r.code)}</td>
          <td>${escapeHtml(r.description)}</td>
          <td style="text-align:right;">${escapeHtml(r.cost || '')}</td>
          <td>${auditTypeButtonsHtml(r)}</td>
          <td><input type="text" class="audit-note-input" data-role="audit-note-input" data-row-id="${r.id}" value="${escapeHtml(r.note || '')}" placeholder="Note"></td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}
function printAuditTable(promo, auditRows) {
  if (!auditRows.length) { showToast('No rows with a cost to print yet.', true); return; }
  let root = document.getElementById('auditPrintRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'auditPrintRoot';
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <h2 style="font-family:Georgia,serif;margin:0 0 4px;">${escapeHtml(promo.name || 'Untitled promotion')} — Cost audit</h2>
    <p style="margin:0 0 16px;color:#555;font-size:12.5px;">${auditRows.length} item${auditRows.length === 1 ? '' : 's'} with a cost on file</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #333;">Code</th>
        <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #333;">Description</th>
        <th style="text-align:right;padding:6px 8px;border-bottom:2px solid #333;">Cost</th>
        <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #333;">Type</th>
        <th style="text-align:left;padding:6px 8px;border-bottom:2px solid #333;">Note</th>
      </tr></thead>
      <tbody>${auditRows.map(r => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #ccc;">${escapeHtml(r.code)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ccc;">${escapeHtml(r.description)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ccc;text-align:right;">${escapeHtml(r.cost || '')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ccc;">${escapeHtml(PRICE_TYPE_LABELS[r.priceType || ''] || '')}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #ccc;">${escapeHtml(r.note || '')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  document.body.classList.add('printing-audit');
  window.print();
}
window.addEventListener('afterprint', () => document.body.classList.remove('printing-audit'));

// Wires the expand/collapse and "Copy codes" behavior for a by-supplier
// accordion. Called separately for the Table view's version (containerId
// 'promoTableSupplierView', mode 'stock' \u2014 every non-blank row) and the
// Audit view's version (containerId 'promoAuditSupplierView', mode 'audit'
// \u2014 only rows with a cost on file), since the two show different rows.
function wireSupplierGroupEvents(containerId, mode) {
  document.querySelectorAll(`#${containerId} .sellout[data-supplier-group]`).forEach(el => {
    const name = el.dataset.supplierGroup;
    const head = el.querySelector('.sellout-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('[data-role="copy-supplier-codes"]')) return;
      el.classList.toggle('open');
      if (el.classList.contains('open')) expandedSupplierGroups.add(name);
      else expandedSupplierGroups.delete(name);
    });
  });
  document.querySelectorAll(`#${containerId} [data-role="copy-supplier-codes"]`).forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.supplier;
      const supplierRows = currentRows.filter(r => ((r.supplier || '').trim() || 'No supplier listed') === name);
      const scoped = mode === 'audit'
        ? supplierRows.filter(r => r.cost !== null && r.cost !== undefined && r.cost !== '')
        : supplierRows.filter(r => (r.code || '').trim() || (r.description || '').trim());
      const codes = scoped.map(r => (r.code || '').trim()).filter(Boolean);
      if (!codes.length) { showToast('No codes to copy for this supplier.', true); return; }
      const ok = await copyTextToClipboard(codes.join(','));
      if (ok) showToast(`Copied ${codes.length} code${codes.length === 1 ? '' : 's'} for ${name}.`);
      else showToast('Could not copy \u2014 your browser blocked clipboard access.', true);
    });
  });
}

function wirePromoRowElement(tr) {
  const body = tr.parentElement;
    const rowId = tr.dataset.rowId;
    const row = currentRows.find(r => r.id === rowId);
    if (!row) return;
    const rowIdx = Array.prototype.indexOf.call(body.children, tr);

    const focusDown = (field) => {
      const nextTr = body.children[rowIdx + 1];
      if (!nextTr) return;
      const el = nextTr.querySelector(`[data-field="${field}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    };
    const goToNextRowOrCreate = async () => {
      const nextTr = body.children[rowIdx + 1];
      if (nextTr) {
        const el = nextTr.querySelector('[data-field="code"]');
        if (el) { el.focus(); if (el.select) el.select(); }
        return;
      }
      const newRow = blankPromoRow();
      currentRows.push(newRow);
      await renderPromoWorkspace();
      await savePromoRow(newRow);
      const bodyEl = document.getElementById('promoRowsBody');
      const newTr = bodyEl && bodyEl.lastElementChild;
      const codeField = newTr && newTr.querySelector('[data-field="code"]');
      if (codeField) codeField.focus();
    };

    const selectCb = tr.querySelector('[data-role="select-row"]');
    const codeInput = tr.querySelector('[data-field="code"]');
    const descInput = tr.querySelector('[data-field="description"]');
    const promoPriceInput = tr.querySelector('[data-field="promoPrice"]');
    const discountInput = tr.querySelector('[data-field="discount"]');
    const beforePriceInput = tr.querySelector('[data-field="beforePrice"]');
    const salePriceInput = tr.querySelector('[data-field="salePrice"]');
    const balInput = tr.querySelector('[data-field="balance"]');
    const stockBadgeSlot = tr.querySelector('.stock-badge-slot');

    selectCb.addEventListener('change', () => {
      if (selectCb.checked) selectedRowIds.add(rowId); else selectedRowIds.delete(rowId);
      const delBtn = document.getElementById('deleteSelectedBtn');
      if (delBtn) {
        delBtn.style.display = selectedRowIds.size ? 'inline-flex' : 'none';
        delBtn.textContent = `Delete selected (${selectedRowIds.size})`;
      }
      const discBtn = document.getElementById('applyDiscountSelectedBtn');
      if (discBtn) {
        discBtn.style.display = selectedRowIds.size ? 'inline-flex' : 'none';
        discBtn.textContent = `Apply discount to selected (${selectedRowIds.size})`;
      }
      const selectAllCb2 = document.getElementById('selectAllRows');
      if (selectAllCb2) selectAllCb2.checked = currentRows.length > 0 && currentRows.every(r => selectedRowIds.has(r.id));
    });

    const doLookup = () => {
      const prevCode = row.code;
      const code = codeInput.value.trim();
      row.code = code;
      if (code === row._lastLookupCode) { refreshRowValidationUi(tr, row); return; }
      row._lastLookupCode = code;
      if (!code) {
        savePromoRow(row);
        refreshRowValidationUi(tr, row);
        refreshDiscountUi(tr, row);
        refreshDuplicateFlagsForCode(prevCode);
        refreshDuplicateFlagsForCode(code);
        return;
      }
      const item = catalogMap.get(normalizeCatalogCode(code));
      if (item) {
        row.description = item.description;
        row.balance = item.balance === undefined ? null : item.balance;
        row.salePrice = item.salePrice === undefined ? null : item.salePrice;
        row.supplier = item.supplier || '';
        row.country = item.country || '';
        row.outYtd = item.outYtd === undefined ? null : item.outYtd;
        descInput.value = item.description;
        balInput.value = row.balance === null ? '' : row.balance;
        salePriceInput.value = row.salePrice === null ? '' : row.salePrice;
        if ((row.beforePrice === null || row.beforePrice === undefined || row.beforePrice === '') && row.salePrice !== null) {
          row.beforePrice = row.salePrice;
          beforePriceInput.value = row.beforePrice;
        }
        applyDiscountAfterCatalogMatch(row);
        discountInput.value = row.discount === null ? '' : row.discount;
        promoPriceInput.value = row.promoPrice === null ? '' : row.promoPrice;
        autoSelloutOnDiscount(row);
        stockBadgeSlot.innerHTML = rowStockBadgeHtml(row);
        refreshRowFlagUi(tr, row);
        const supplierDetail = document.querySelector(`tr[data-supplier-row-id="${row.id}"]`);
        if (supplierDetail) {
          const strongs = supplierDetail.querySelectorAll('strong');
          if (strongs[0]) strongs[0].textContent = row.supplier || 'Not listed in the catalog';
          if (strongs[1]) strongs[1].textContent = row.country || 'Not listed in the catalog';
        }
        refreshCountryFilterOptions();
      } else {
        showToast(`Code "${code}" not found in this promotion's catalog \u2014 fill it in manually.`, true);
      }
      refreshRowValidationUi(tr, row);
      refreshDiscountUi(tr, row);
      refreshDuplicateFlagsForCode(prevCode);
      refreshDuplicateFlagsForCode(code);
      savePromoRow(row);
    };

    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doLookup(); focusDown('code'); }
    });
    codeInput.addEventListener('blur', doLookup);

    descInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusDown('description'); } });
    descInput.addEventListener('blur', () => { row.description = descInput.value; savePromoRow(row); refreshRowValidationUi(tr, row); });

    promoPriceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusDown('promoPrice'); } });
    promoPriceInput.addEventListener('blur', () => {
      row.promoPrice = numOrNull(promoPriceInput.value);
      row.reviewed = false; // a fresh price edit should be re-evaluated, not stay dismissed
      autoSelloutOnDiscount(row);
      savePromoRow(row);
      refreshRowFlagUi(tr, row);
      refreshRowValidationUi(tr, row);
      refreshDiscountUi(tr, row);
    });

    discountInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusDown('discount'); } });
    discountInput.addEventListener('blur', () => {
      row.discount = numOrNull(discountInput.value);
      row.reviewed = false;
      applyReverseDiscount(row);
      promoPriceInput.value = row.promoPrice === null ? '' : row.promoPrice;
      autoSelloutOnDiscount(row);
      savePromoRow(row);
      refreshRowFlagUi(tr, row);
      refreshRowValidationUi(tr, row);
      refreshDiscountUi(tr, row);
    });

    beforePriceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusDown('beforePrice'); } });
    beforePriceInput.addEventListener('blur', () => { row.beforePrice = numOrNull(beforePriceInput.value); savePromoRow(row); refreshRowValidationUi(tr, row); });

    salePriceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); focusDown('salePrice'); } });
    salePriceInput.addEventListener('blur', () => {
      row.salePrice = numOrNull(salePriceInput.value);
      row.reviewed = false;
      if ((row.beforePrice === null || row.beforePrice === undefined || row.beforePrice === '') && row.salePrice !== null) {
        row.beforePrice = row.salePrice;
        beforePriceInput.value = row.beforePrice;
      }
      const promoBlank = row.promoPrice === null || row.promoPrice === undefined || row.promoPrice === '';
      const hasDiscount = row.discount !== null && row.discount !== undefined && row.discount !== '';
      if (promoBlank && hasDiscount) {
        // A discount already sitting on this row (e.g. imported from a
        // percentage cell) had no sale price to work from yet — now that one
        // was just typed in, compute the promo price from it instead of
        // trying to derive a discount from a promo price that doesn't exist.
        applyReverseDiscount(row);
        promoPriceInput.value = row.promoPrice === null ? '' : row.promoPrice;
      }
      autoSelloutOnDiscount(row);
      savePromoRow(row);
      refreshRowFlagUi(tr, row);
      refreshDiscountUi(tr, row);
      refreshRowValidationUi(tr, row);
    });

    balInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); focusDown('balance'); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); goToNextRowOrCreate(); }
    });
    balInput.addEventListener('blur', () => {
      row.balance = numOrNull(balInput.value);
      stockBadgeSlot.innerHTML = rowStockBadgeHtml(row);
      savePromoRow(row);
      refreshRowValidationUi(tr, row);
    });

    tr.querySelector('[data-role="toggle-flag"]').addEventListener('click', async () => {
      // A manually-flagged row toggles off normally. An auto-flagged row
      // (price risk or an unusual price gap, never manually flagged) can't
      // be unflagged that way — rowNeedsFlag() would just recompute the same
      // auto-condition and flip it right back on — so this marks it
      // "reviewed" instead, which dismisses it until the price changes again.
      if (row.flagged) {
        row.flagged = false;
      } else if (isPriceRisk(row) || isPriceGapUnusual(row)) {
        row.reviewed = true;
      } else {
        row.flagged = true;
      }
      await savePromoRow(row);
      await renderPromoWorkspace();
    });

    tr.querySelector('[data-role="toggle-supplier"]').addEventListener('click', () => {
      if (expandedSupplierRowIds.has(row.id)) expandedSupplierRowIds.delete(row.id);
      else expandedSupplierRowIds.add(row.id);
      renderPromoWorkspace();
    });

    tr.querySelector('[data-role="insert-row"]').addEventListener('click', async () => {
      const idx = currentRows.findIndex(r => r.id === rowId);
      const newRow = blankPromoRow();
      currentRows.splice(idx + 1, 0, newRow);
      renumberRows();
      await renderPromoWorkspace();
      await persistRowsBulk(currentRows);
      const bodyEl = document.getElementById('promoRowsBody');
      const newTr = bodyEl && bodyEl.querySelector(`tr[data-row-id="${newRow.id}"]`);
      const codeField = newTr && newTr.querySelector('[data-field="code"]');
      if (codeField) codeField.focus();
    });

    tr.querySelector('[data-role="insert-rows-bulk"]').addEventListener('click', async () => {
      const val = await showPrompt('How many rows do you want to insert below this row?', { defaultValue: '5', confirmLabel: 'Insert rows', placeholder: 'e.g. 5' });
      if (val === null) return;
      const n = parseInt(val, 10);
      if (!n || n < 1) { showToast('Enter a number of rows greater than 0.', true); return; }
      // Asked once here rather than one row at a time, or via a separate
      // select-all-then-apply step afterward — the same discount lands on
      // every inserted row immediately, and the promo price fills in on its
      // own once a code (and its sale price) is added to each one.
      const discVal = await showPrompt(`Apply a discount % to all ${n} new row${n === 1 ? '' : 's'}? Leave blank to skip.`, { defaultValue: '', confirmLabel: 'Insert rows', placeholder: 'e.g. 20' });
      const pct = (discVal !== null && discVal.trim() !== '' && !isNaN(Number(discVal))) ? round2(Number(discVal)) : null;
      const idx = currentRows.findIndex(r => r.id === rowId);
      const newRows = [];
      for (let i = 0; i < n; i++) {
        const newRow = blankPromoRow();
        if (pct !== null) {
          newRow.discount = pct;
          autoSelloutOnDiscount(newRow);
        }
        currentRows.splice(idx + 1 + i, 0, newRow);
        newRows.push(newRow);
      }
      const moved = renumberRows();
      await renderPromoWorkspace();
      await persistRowsBulk(withMoved(newRows, moved));
      showToast(`${n} row${n === 1 ? '' : 's'} inserted${pct !== null ? ` with a ${pct}% discount` : ''}.`);
    });

    tr.querySelector('[data-role="remove-row"]').addEventListener('click', async () => {
      const ok = await showConfirm('Remove this row?', 'Remove');
      if (!ok) return;
      currentRows = currentRows.filter(r => r.id !== rowId);
      selectedRowIds.delete(rowId);
      const moved = renumberRows();
      await deletePromoRow(rowId);
      await renderPromoWorkspace();
      await persistRowsBulk(moved);
    });
}

function wirePromoWorkspaceEvents(promo) {
  const nameInput = document.getElementById('promoName');
  const fromInput = document.getElementById('promoFrom');
  const toInput = document.getElementById('promoTo');
  const autoArchiveCb = document.getElementById('promoAutoArchive');

  const saveHeader = async () => {
    promo.name = nameInput.value.trim() || 'Untitled promotion';
    promo.from = fromInput.value || null;
    promo.to = toInput.value || null;
    await savePromotion(promo);
    renderPromoTabstrip();
  };
  nameInput.addEventListener('blur', saveHeader);
  fromInput.addEventListener('change', saveHeader);
  toInput.addEventListener('change', saveHeader);

  document.querySelectorAll('#promoViewSwitch [data-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      promoViewMode = btn.dataset.view;
      await renderPromoWorkspace();
    });
  });

  const countryFilterBtn = document.getElementById('countryFilterBtn');
  const countryFilterPanel = document.getElementById('countryFilterPanel');
  if (countryFilterBtn && countryFilterPanel) {
    countryFilterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      countryFilterOpen = !countryFilterOpen;
      countryFilterPanel.style.display = countryFilterOpen ? 'block' : 'none';
    });
    countryFilterPanel.addEventListener('click', (e) => e.stopPropagation());
    countryFilterPanel.querySelectorAll('[data-role="country-option"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        if (cb.checked) selectedCountries.add(cb.value); else selectedCountries.delete(cb.value);
        countryFilterOpen = true; // keep the panel open across the re-render while picking several
        await renderPromoWorkspace();
      });
    });
    countryFilterPanel.querySelectorAll('[data-role="code-issue-option"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        if (cb.checked) selectedCodeIssues.add(cb.value); else selectedCodeIssues.delete(cb.value);
        countryFilterOpen = true;
        await renderPromoWorkspace();
      });
    });
    const flaggedOnlyOption = countryFilterPanel.querySelector('[data-role="flagged-only-option"]');
    if (flaggedOnlyOption) {
      flaggedOnlyOption.addEventListener('change', async () => {
        showFlaggedOnly = flaggedOnlyOption.checked;
        countryFilterOpen = true;
        await renderPromoWorkspace();
      });
    }
    const clearAllBtn = document.getElementById('clearAllFiltersBtn');
    if (clearAllBtn) clearAllBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      selectedCountries.clear();
      selectedCodeIssues.clear();
      showFlaggedOnly = false;
      countryFilterSearchQuery = '';
      countryFilterOpen = true;
      await renderPromoWorkspace();
    });
    wireCountryFilterSearch();
  }

  autoArchiveCb.addEventListener('change', async () => {
    promo.autoArchive = autoArchiveCb.checked;
    await savePromotion(promo);
    showToast(promo.autoArchive ? 'Will auto-archive once the "To" date passes.' : 'Auto-archive turned off for this promotion.');
  });

  document.getElementById('toggleArchivePromoBtn').addEventListener('click', async () => {
    promo.archived = !promo.archived;
    await savePromotion(promo);
    showToast(promo.archived ? 'Promotion archived.' : 'Promotion unarchived.');
    const stillVisible = !!promo.archived === showArchivedPromos;
    if (!stillVisible) {
      const visible = promotions.filter(p => !!p.archived === showArchivedPromos && p.id !== promo.id);
      await selectPromotion(visible.length ? visible[0].id : null);
    } else {
      renderPromoTabstrip();
      await renderPromoWorkspace();
    }
  });

  document.getElementById('exportPromoBtn').addEventListener('click', () => exportPromotionToExcel(promo));

  document.getElementById('importPriceSheetBtn').addEventListener('click', () => {
    document.getElementById('priceSheetInput').click();
  });

  const downloadSourceBtn = document.getElementById('downloadSourceFileBtn');
  if (downloadSourceBtn) {
    downloadSourceBtn.addEventListener('click', () => {
      if (!promo.sourceFileBase64) { showToast('That file isn’t available anymore.', true); return; }
      const blob = base64ToBlob(promo.sourceFileBase64, guessMime(promo.sourceFileName));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = promo.sourceFileName || 'price-sheet.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  }

  document.getElementById('priceSheetInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let buf;
    try { buf = await file.arrayBuffer(); }
    catch (err) { showToast('Could not read that file — check the format.', true); e.target.value = ''; return; }

    let result;
    try { result = parsePriceSheetRows(buf); }
    catch (err) { console.error(err); showToast('Could not read that file — check the format.', true); e.target.value = ''; return; }
    e.target.value = '';

    if (result.error) { showToast(result.error, true); return; }
    if (!result.rows.length) { showToast('No item lines found in that file.', true); return; }

    // Importing REPLACES the table rather than adding to it — a re-import of
    // the same (or an overlapping) file used to double every code instead of
    // updating them, so this confirms before throwing away what's there now.
    if (currentRows.length) {
      const ok = await showConfirm(
        `Import ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} from this file? This replaces the ${currentRows.length} row${currentRows.length === 1 ? '' : 's'} currently in this promotion's table.`,
        'Replace table'
      );
      if (!ok) return;
    }

    currentRows = result.rows;
    selectedRowIds.clear();
    renumberRows();
    await renderPromoWorkspace();
    await Promise.all([
      replaceAllPromoRows(promo.id, currentRows),
      savePromotionSourceFile(promo.id, file)
    ]);
    await renderPromoWorkspace();

    const parts = [`Imported ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} from ${result.sourceLineCount} line${result.sourceLineCount === 1 ? '' : 's'}, replacing the previous table`];
    if (result.splitCount) parts.push(`${result.splitCount} multi-code line${result.splitCount === 1 ? '' : 's'} split`);
    if (result.blankCodeCount) parts.push(`${result.blankCodeCount} line${result.blankCodeCount === 1 ? '' : 's'} had no code — kept blank so you can spot ${result.blankCodeCount === 1 ? 'it' : 'them'}`);
    if (result.percentAsDiscountCount) parts.push(`${result.percentAsDiscountCount} line${result.percentAsDiscountCount === 1 ? '' : 's'} had a percentage in the price column — read as Discount instead`);
    showToast(parts.join(', ') + '.', !!result.blankCodeCount);
  });

  document.getElementById('copyCodesBtn').addEventListener('click', async () => {
    const codes = currentRows.map(r => (r.code || '').trim()).filter(Boolean);
    if (!codes.length) { showToast('No codes to copy yet.', true); return; }
    const ok = await copyTextToClipboard(codes.join(','));
    if (ok) showToast(`Copied ${codes.length} code${codes.length === 1 ? '' : 's'}.`);
    else showToast('Could not copy \u2014 your browser blocked clipboard access.', true);
  });

  document.getElementById('deletePromoBtn').addEventListener('click', async () => {
    const ok = await showConfirm(`Delete "${promo.name}"? This removes all its rows and its catalog too.`, 'Delete');
    if (!ok) return;
    await deletePromotionRemote(promo.id);
    promotions = promotions.filter(p => p.id !== promo.id);
    selectedRowIds.clear();
    if (currentPromoId === promo.id) {
      const visible = promotions.filter(p => !!p.archived === showArchivedPromos);
      await selectPromotion(visible.length ? visible[0].id : null);
    } else {
      renderPromoTabstrip();
    }
    showToast('Promotion deleted.');
  });

  document.getElementById('addRowBtn').addEventListener('click', async () => {
    const row = blankPromoRow();
    currentRows.push(row);
    await renderPromoWorkspace();
    await savePromoRow(row);
    const bodyEl = document.getElementById('promoRowsBody');
    const lastRow = bodyEl && bodyEl.lastElementChild;
    const codeField = lastRow && lastRow.querySelector('[data-field="code"]');
    if (codeField) codeField.focus();
  });

  document.getElementById('addRowsBulkBtn').addEventListener('click', async () => {
    const val = await showPrompt('How many rows do you want to add?', { defaultValue: '5', confirmLabel: 'Add rows', placeholder: 'e.g. 5' });
    if (val === null) return;
    const n = parseInt(val, 10);
    if (!n || n < 1) { showToast('Enter a number of rows greater than 0.', true); return; }
    // Asking for a discount up front (instead of one row at a time, or a
    // separate "select all + apply" step afterward) is the point of this
    // dialog — it lands on every new row immediately, and once a code is
    // typed in and a sale price is known, the promo price computes from it.
    const discVal = await showPrompt(`Apply a discount % to all ${n} new row${n === 1 ? '' : 's'}? Leave blank to skip.`, { defaultValue: '', confirmLabel: 'Add rows', placeholder: 'e.g. 20' });
    const pct = (discVal !== null && discVal.trim() !== '' && !isNaN(Number(discVal))) ? round2(Number(discVal)) : null;
    const newRows = [];
    for (let i = 0; i < n; i++) {
      const row = blankPromoRow();
      row.sortOrder = currentRows.length;
      if (pct !== null) {
        row.discount = pct;
        autoSelloutOnDiscount(row);
      }
      currentRows.push(row);
      newRows.push(row);
    }
    await renderPromoWorkspace();
    await persistRowsBulk(newRows);
    showToast(`${n} row${n === 1 ? '' : 's'} added${pct !== null ? ` with a ${pct}% discount` : ''}.`);
  });

  document.getElementById('applyDiscountSelectedBtn').addEventListener('click', async () => {
    const ids = Array.from(selectedRowIds);
    if (!ids.length) return;
    const val = await showPrompt(`Apply what discount % to ${ids.length} selected row${ids.length === 1 ? '' : 's'}?`, { defaultValue: '', confirmLabel: 'Apply', placeholder: 'e.g. 20' });
    if (val === null) return;
    const pct = Number(val);
    if (val.trim() === '' || isNaN(pct)) { showToast('Enter a valid discount percentage.', true); return; }
    const rows = currentRows.filter(r => selectedRowIds.has(r.id));
    rows.forEach(r => {
      r.discount = round2(pct);
      r.reviewed = false;
      // Recompute the promo price from this discount wherever a sale price
      // is already known; rows with no sale price yet keep the discount and
      // pick up their promo price once one is typed in (see the Sale Price
      // blur handler above).
      if (r.salePrice !== null && r.salePrice !== undefined && r.salePrice !== '') applyReverseDiscount(r);
      autoSelloutOnDiscount(r);
    });
    await renderPromoWorkspace();
    await persistRowsBulk(rows);
    showToast(`${pct}% discount applied to ${rows.length} row${rows.length === 1 ? '' : 's'}.`);
  });

  document.getElementById('deleteSelectedBtn').addEventListener('click', async () => {
    const ids = Array.from(selectedRowIds);
    if (!ids.length) return;
    const ok = await showConfirm(`Delete ${ids.length} selected row${ids.length === 1 ? '' : 's'}?`, 'Delete');
    if (!ok) return;
    currentRows = currentRows.filter(r => !selectedRowIds.has(r.id));
    selectedRowIds.clear();
    renumberRows();
    await deleteRowsBulk(ids);
    await persistRowsBulk(currentRows);
    await renderPromoWorkspace();
    showToast('Selected rows deleted.');
  });

  const selectAllCb = document.getElementById('selectAllRows');
  if (selectAllCb) {
    selectAllCb.checked = currentRows.length > 0 && currentRows.every(r => selectedRowIds.has(r.id));
    selectAllCb.addEventListener('change', async () => {
      if (selectAllCb.checked) currentRows.forEach(r => selectedRowIds.add(r.id));
      else selectedRowIds.clear();
      await renderPromoWorkspace();
    });
  }

  // The search box only touches the table body (and the small status line
  // above it), never the whole workspace, so typing in it never loses focus
  // on every keystroke. Flagged-only now lives in the Filter panel above.
  const searchInput = document.getElementById('tableSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      tableSearchQuery = searchInput.value;
      refreshPromoTableView();
    });
  }
  wireTableFilterStatus();

  const body = document.getElementById('promoRowsBody');
  if (!body) return;
  body.querySelectorAll('tr').forEach(tr => wirePromoRowElement(tr));

  body.addEventListener('paste', async (e) => {
    const target = e.target;
    if (!target || !target.matches('input[data-field], select[data-field]')) return;
    if (!canEditPromotions()) { e.preventDefault(); return; }
    const clipboard = e.clipboardData || window.clipboardData;
    if (!clipboard) return;
    const text = clipboard.getData('text/plain');
    if (!text) return;
    let gridRows = text.replace(/\r/g, '').split('\n');
    while (gridRows.length && gridRows[gridRows.length - 1] === '') gridRows.pop();
    if (!gridRows.length) return;
    let grid = gridRows.map(line => line.split('\t'));

    // Treat "/" as an extra row separator when pasting a single column of
    // values (e.g. "111/222/333") \u2014 each part becomes its own row.
    const singleColumn = grid.every(r => r.length === 1);
    const hasSlashList = singleColumn && grid.some(r => r[0].includes('/'));
    if (hasSlashList) {
      const expanded = [];
      grid.forEach(r => {
        r[0].split('/').map(s => s.trim()).filter(Boolean).forEach(v => expanded.push([v]));
      });
      if (expanded.length) grid = expanded;
    }

    if (grid.length === 1 && grid[0].length === 1 && !hasSlashList) return;
    e.preventDefault();

    const startTr = target.closest('tr');
    const startRowId = startTr && startTr.dataset.rowId;
    const startRowIdx = currentRows.findIndex(r => r.id === startRowId);
    const startField = target.dataset.field;
    const startColIdx = PROMO_FIELDS.indexOf(startField);
    if (startRowIdx === -1 || startColIdx === -1) return;

    // A pasted Code cell sometimes bundles several SKUs that share one price
    // line in the source sheet (e.g. "78615/90174/230752"). Splitting that
    // into one row per code, each carrying the same pasted Promo Price /
    // Before Price / etc., means the price only has to be typed once instead
    // of once per split row.
    const codeColOffset = PROMO_FIELDS.indexOf('code') - startColIdx;
    const touchedRows = [];
    let writeIdx = startRowIdx;
    for (let r = 0; r < grid.length; r++) {
      const cols = grid[r];
      let codeParts = null;
      if (codeColOffset >= 0 && codeColOffset < cols.length) {
        const parts = cols[codeColOffset].split('/').map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) codeParts = parts;
      }
      const isSplit = !!codeParts;
      const expansions = isSplit ? codeParts : [null];

      for (let k = 0; k < expansions.length; k++) {
        let row2;
        if (k === 0) {
          if (writeIdx < currentRows.length) {
            row2 = currentRows[writeIdx];
          } else {
            row2 = blankPromoRow();
            currentRows.push(row2);
          }
        } else {
          // Extra rows created by a multi-code split must be INSERTED, not
          // overwrite whatever row already followed — otherwise that row's
          // data would be silently clobbered instead of pushed further down.
          row2 = blankPromoRow();
          currentRows.splice(writeIdx, 0, row2);
        }
        writeIdx++;

        for (let c = 0; c < cols.length; c++) {
          const fieldIdx = startColIdx + c;
          if (fieldIdx >= PROMO_FIELDS.length) break;
          const field = PROMO_FIELDS[fieldIdx];
          const raw = (isSplit && field === 'code') ? expansions[k] : cols[c];
          if (field === 'code') {
            const code = raw.trim();
            row2.code = code;
            row2._lastLookupCode = code;
            const item = catalogMap.get(normalizeCatalogCode(code));
            if (item) {
              row2.description = item.description;
              row2.balance = item.balance === undefined ? null : item.balance;
              row2.salePrice = item.salePrice === undefined ? null : item.salePrice;
              row2.supplier = item.supplier || '';
              row2.country = item.country || '';
              row2.outYtd = item.outYtd === undefined ? null : item.outYtd;
            }
          } else {
            row2[field] = fieldValueParse(field, raw);
          }
        }
        if ((row2.beforePrice === null || row2.beforePrice === undefined || row2.beforePrice === '') && row2.salePrice !== null && row2.salePrice !== undefined && row2.salePrice !== '') {
          row2.beforePrice = row2.salePrice;
        }
        applyDiscountAfterCatalogMatch(row2);
        autoSelloutOnDiscount(row2);
        touchedRows.push(row2);
      }
    }

    // Sync the DOM value of the cell that was actually pasted into. Re-rendering
    // below removes it from the document while it still has focus, which fires a
    // native "blur" on it \u2014 if its value still shows the pre-paste text (since
    // the real paste was prevented), that stale blur handler would overwrite the
    // freshly-pasted value with the old one.
    const targetRow = currentRows[startRowIdx];
    if (targetRow && target.tagName !== 'SELECT') {
      const v = targetRow[startField];
      target.value = (v === null || v === undefined) ? '' : String(v);
    }

    const moved = renumberRows();
    await renderPromoWorkspace();
    await persistRowsBulk(withMoved(touchedRows, moved));
    showToast(`Pasted ${grid.length} row${grid.length === 1 ? '' : 's'}.`);
  });
}

const PRICE_TYPE_LABELS = { sellout: 'Sell Out', cn: 'C/N', rightprice: 'Right Price', '': '' };

function exportPromotionToExcel(promo) {
  if (!currentRows.length) { showToast('Add at least one item before exporting.', true); return; }
  const aoa = [
    [promo.name || 'Untitled promotion'],
    [`${promo.from ? fmtDate(promo.from) : '?'} \u2192 ${promo.to ? fmtDate(promo.to) : '?'}`],
    [],
    ['Code', 'Description', 'Promo Price', 'Before Price', 'Discount', 'Sale Price', 'Gap', 'Stock', 'Low Stock', 'Type']
  ];
  currentRows.forEach(r => {
    const isLow = r.balance !== null && r.balance !== undefined && Number(r.balance) < lowStockThreshold;
    aoa.push([
      r.code, r.description,
      numToStr(r.promoPrice),
      numToStr(r.beforePrice),
      numToStr(r.discount),
      numToStr(r.salePrice),
      gapPctDisplay(r),
      numToStr(r.balance),
      isLow ? 'Yes' : 'No',
      PRICE_TYPE_LABELS[r.priceType || ''] || ''
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 40 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 10 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Promotion');
  const safeName = (promo.name || 'promotion').replace(/[\\/:*?"<>|]/g, '-').trim() || 'promotion';
  XLSX.writeFile(wb, `${safeName}.xlsx`);
  showToast('Promotion exported.');
}

// Supplier price sheets often list several SKUs on one line (e.g. "78615/90174")
// and sometimes skip the code cell entirely for a line item. This turns a raw,
// as-downloaded sheet like that directly into promotion rows: one row per code,
// each carrying the line's own Promo Price / Before Price, and a blank row kept
// in place (instead of silently dropped) wherever the source had no code at all
// so a missing item is still visible.
function findPriceSheetHeaderRow(aoa) {
  const isMatch = (cell, re) => typeof cell === 'string' && re.test(cell.trim());
  const codeRe = /^item ?code$/i, altCodeRe = /^code$/i, descRe = /^description$/i;
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const row = aoa[i] || [];
    const hasCode = row.some(c => isMatch(c, codeRe) || isMatch(c, altCodeRe));
    const hasDesc = row.some(c => isMatch(c, descRe));
    if (hasCode && hasDesc) return i;
  }
  return -1;
}

function parsePriceSheetRows(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  const headerIdx = findPriceSheetHeaderRow(aoa);
  if (headerIdx === -1) return { error: 'Could not find an "Itemcode" and "Description" header row in that file.' };

  const header = aoa[headerIdx];
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');
  // Same alias-priority-first matching as the catalog upload: try each
  // alias, in order, against every header before moving to the next alias,
  // rather than taking whichever column happens to come first in the file.
  const findCol = (...wants) => {
    for (const want of wants) {
      const idx = header.findIndex(h => norm(h) === want);
      if (idx > -1) return idx;
    }
    return -1;
  };
  const codeCol = findCol('itemcode', 'code');
  const descCol = findCol('description');
  const promoCol = findCol('promoprice', 'promo');
  const beforeCol = findCol('oldprice', 'beforeprice', 'before');
  const costCol = findCol('cost');
  // Optional columns: Barcode, and a Discount % used only when a line has no promo price.
  const barcodeCol = findCol(...BARCODE_HEADERS, 'barcode');
  const discountCol = findCol('discount', 'discount%', 'disc%', 'disc');
  if (codeCol === -1 || descCol === -1) return { error: 'Could not find an "Itemcode" and "Description" header row in that file.' };

  const toNum = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    if (typeof v === 'number') return v;
    const cleaned = String(v).replace(/[^0-9.\-]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return isNaN(n) ? null : n;
  };
  // Cost cells in real supplier sheets are free-form ("2.15 5+1", "6.66$",
  // "10.874/7+1", "sell out", or just "N") — rather than guess which part is
  // a real number, this keeps the cell exactly as typed, as text, so nothing
  // in it gets silently dropped.
  const toText = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  };
  // Some supplier sheets reuse the Promo Price (or Old Price) column to carry
  // a discount rate instead of an actual price for a given line — the cell
  // shows as a plain fraction like 0.2 because it's formatted as a percentage
  // ("0%") in Excel, not because it's a 20-cent price. Reading the cell's own
  // number format (not just its value) is the only way to tell those apart.
  const isPercentCell = (r, c) => {
    if (c < 0) return false;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    // .w is the cell's formatted display text ("20%"), which SheetJS always
    // fills in; .z (the raw number-format string) isn't populated unless the
    // workbook is read with cellNF turned on, so .w is the reliable signal.
    return !!(cell && typeof cell.w === 'string' && cell.w.includes('%'));
  };

  const newRows = [];
  // Item codes are the join key against the catalog, so they need to match
  // EXACTLY what a person sees in Excel — but Excel silently strips
  // leading zeros from a cell it decided was a number ("007123" →
  // 7123). Reading the raw value would bake that loss in; the cell's own
  // formatted display text (.w) is what Excel actually shows, so that's
  // what gets used for the code column specifically (other columns keep
  // using raw values, since a formatted price like "$12.50" would break
  // Number() parsing).
  const codeCellText = (r, c) => {
    if (c < 0) return '';
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) return '';
    if (typeof cell.w === 'string' && cell.w !== '') return cell.w;
    return cell.v === undefined || cell.v === null ? '' : String(cell.v);
  };
  let splitCount = 0, blankCodeCount = 0, sourceLineCount = 0, percentAsDiscountCount = 0;
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const line = aoa[i] || [];
    const rawCode = codeCellText(i, codeCol).trim();
    const desc = descCol > -1 ? String(line[descCol] ?? '').trim() : '';
    let promoPrice = promoCol > -1 ? toNum(line[promoCol]) : null;
    let beforePrice = beforeCol > -1 ? toNum(line[beforeCol]) : null;
    const cost = costCol > -1 ? toText(line[costCol]) : null;
    const barcodes = barcodeCol > -1 ? splitBarcodes(barcodeCellText(ws, i, barcodeCol)) : [];
    let discountFromPercent = null;
    if (promoPrice !== null && isPercentCell(i, promoCol)) {
      discountFromPercent = round2(promoPrice * 100);
      promoPrice = null; // that cell held a discount rate, not a price
      percentAsDiscountCount++;
    } else if (beforePrice !== null && isPercentCell(i, beforeCol)) {
      discountFromPercent = round2(beforePrice * 100);
      beforePrice = null;
      percentAsDiscountCount++;
    }
    if (promoPrice === null && discountFromPercent === null && discountCol > -1) {
      const d = toNum(line[discountCol]);
      if (d !== null) discountFromPercent = isPercentCell(i, discountCol) ? round2(d * 100) : round2(d);
    }
    const isBlankLine = !rawCode && !desc && promoPrice === null && beforePrice === null && cost === null && discountFromPercent === null && !barcodes.length;
    if (isBlankLine) continue;
    sourceLineCount++;

    let codes = rawCode ? rawCode.split('/').map(s => s.trim()).filter(Boolean) : [];
    // No item code but a barcode the catalog knows: use the catalog's code.
    if (!codes.length && barcodes.length) { const hit = barcodes.map(b => catalogBarcodeMap.get(b)).find(Boolean); if (hit) codes = [hit.code]; }
    if (codes.length > 1) splitCount++;
    if (!codes.length) blankCodeCount++;
    const expansions = codes.length ? codes : [''];

    expansions.forEach(code => {
      const row = blankPromoRow();
      row.code = code;
      row._lastLookupCode = code;
      row.description = desc;
      row.promoPrice = promoPrice;
      row.beforePrice = beforePrice;
      row.cost = cost;
      row.barcode = barcodes[0] || '';
      if (discountFromPercent !== null) { row.discount = discountFromPercent; autoSelloutOnDiscount(row); }
      if (code) {
        const item = catalogMap.get(normalizeCatalogCode(code));
        if (item) {
          row.balance = item.balance === undefined ? null : item.balance;
          row.salePrice = item.salePrice === undefined ? null : item.salePrice;
          row.supplier = item.supplier || '';
          row.country = item.country || '';
          row.outYtd = item.outYtd === undefined ? null : item.outYtd;
        }
      }
      // A discount pulled from a percentage-formatted cell already has its
      // real value — recompute the promo price from it (now that a catalog
      // match may have filled in the sale price). A row with no discount in
      // the source file is left with Discount blank — it does not get one
      // auto-filled from the bare Sale-Price/Promo-Price gap (that's what
      // the read-only Gap column is for; see gapPctDisplay).
      if (discountFromPercent !== null) applyReverseDiscount(row);
      newRows.push(row);
    });
  }
  return { rows: newRows, splitCount, blankCodeCount, sourceLineCount, percentAsDiscountCount };
}

async function initPromotions() {
  await Promise.all([loadSettings(), loadPromotions()]);
  await autoArchiveDuePromotions();
  const thresholdInput = document.getElementById('lowStockInput');
  if (thresholdInput) thresholdInput.value = lowStockThreshold;
  applyCatalogCollapse();
  renderPromoTabstrip();
  const activePromos = promotions.filter(p => !p.archived);
  if (activePromos.length) {
    await selectPromotion(activePromos[0].id);
  } else {
    renderCatalogInfo();
    await renderPromoWorkspace();
  }

  // Re-check every hour in case this tab is left open across the weekend,
  // so a promotion still archives on time without needing a page reload.
  setInterval(async () => {
    const changed = await autoArchiveDuePromotions();
    if (!changed) return;
    if (currentPromoId) {
      const cur = promotions.find(p => p.id === currentPromoId);
      if (cur && !!cur.archived !== showArchivedPromos) {
        const visible = promotions.filter(p => !!p.archived === showArchivedPromos);
        await selectPromotion(visible.length ? visible[0].id : null);
        renderPromoTabstrip();
        return;
      }
    }
    renderPromoTabstrip();
    await renderPromoWorkspace();
  }, 60 * 60 * 1000);
}

/* ============================================================
   Vendors
   ============================================================ */
let vendorsList = [];
let editingVendorId = null;
let vendorSearchTerm = '';
let vendorSubTab = 'directory';

// Orders / no-order weeks / rentals
let ordersList = [];
let skipsList = [];
let rentalsList = [];
let ordersViewDate = todayStr();
let orderHistoryFilter = 'all';
let ordersSearchTerm = ''; // Filters Due/Awaiting/No-order/History by vendor name, across the whole Orders sub-tab
let editingRentalId = null;
let expandedRentalIds = new Set();
let ordersDueSelection = new Set(); // Vendor ids checked in the "Due" bulk-action list; cleared whenever the date/search changes what's shown.

const VENDOR_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const VENDOR_FREQ_LABELS = { 1: 'Every week', 2: 'Every 2 weeks', 3: 'Every 3 weeks', 4: 'Every 4 weeks (monthly)' };
const VENDOR_DAY_MAP = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
};
function parseVendorDay(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (VENDOR_DAY_MAP.hasOwnProperty(s)) return VENDOR_DAY_MAP[s];
  const n = Number(s);
  if (!isNaN(n) && n >= 0 && n <= 6) return n;
  return null;
}
function parseVendorFrequency(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const s = String(raw).trim().toLowerCase();
  const digitMatch = s.match(/\d+/);
  if (digitMatch) {
    const n = Number(digitMatch[0]);
    if (n >= 1 && n <= 4) return n;
  }
  if (s.includes('month')) return 4;
  if (s.includes('bi')) return 2;
  return 1;
}
function findVendorHeaderKey(headers, candidates) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx > -1) return headers[idx];
  }
  for (let i = 0; i < lower.length; i++) {
    for (const c of candidates) {
      if (lower[i].includes(c)) return headers[i];
    }
  }
  return null;
}

async function loadVendorsData() {
  const { data, error } = await sb.from('vendors').select('*').order('name', { ascending: true });
  if (error) { console.error(error); showToast('Could not load vendors — ' + sbErrText(error), true); return; }
  vendorsList = (data || []).map(r => ({
    id: r.id, name: r.name || '', salesmanName: r.salesman_name || '', phone: r.phone || '',
    dayOfWeek: r.day_of_week === undefined ? null : r.day_of_week,
    frequencyWeeks: r.frequency_weeks || 1,
    leadTimeDays: r.lead_time_days === undefined ? null : r.lead_time_days,
    anchorDate: r.anchor_date || ''
  }));
}
async function saveVendorRemote(v) {
  const row = {
    id: v.id, name: v.name, salesman_name: v.salesmanName || null, phone: v.phone || null,
    day_of_week: v.dayOfWeek, frequency_weeks: v.frequencyWeeks || 1,
    lead_time_days: v.leadTimeDays === null || v.leadTimeDays === '' ? null : Number(v.leadTimeDays),
    anchor_date: v.anchorDate || null
  };
  const { error } = await sb.from('vendors').upsert(row);
  if (error) { console.error(error); showToast('Could not save that vendor — ' + sbErrText(error), true); return false; }
  return true;
}
async function deleteVendorRemote(id) {
  const { error } = await sb.from('vendors').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete that vendor — ' + sbErrText(error), true); }
}

function renderVendorsPage() {
  const term = vendorSearchTerm.trim().toLowerCase();
  const filtered = vendorsList.filter(v => {
    if (!term) return true;
    return ((v.name || '') + ' ' + (v.salesmanName || '') + ' ' + (v.phone || '')).toLowerCase().includes(term);
  });

  document.getElementById('vendorCountNote').textContent =
    vendorsList.length ? `${vendorsList.length} vendor${vendorsList.length === 1 ? '' : 's'}` : 'No vendors yet.';

  const body = document.getElementById('vendorTableBody');
  body.innerHTML = filtered.map(v => `
    <tr data-vendor-id="${v.id}">
      <td><button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(v.name)}</button></td>
      <td>${escapeHtml(v.salesmanName || '—')}</td>
      <td class="mono">${escapeHtml(v.phone || '—')}</td>
      <td>${v.dayOfWeek === null ? '—' : VENDOR_DAY_NAMES[v.dayOfWeek]}</td>
      <td>${VENDOR_FREQ_LABELS[v.frequencyWeeks] || '—'}</td>
      <td>${v.leadTimeDays === null ? '—' : v.leadTimeDays + 'd'}</td>
      <td class="mono">${escapeHtml(v.anchorDate || '—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn ghost small" data-role="edit-vendor">Edit</button>
        <button class="btn ghost small" data-role="delete-vendor" style="color:var(--brick);">Delete</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('vendorEmpty').style.display = vendorsList.length ? 'none' : 'block';
  document.getElementById('vendorNoMatch').style.display = (vendorsList.length && term && !filtered.length) ? 'block' : 'none';

  body.querySelectorAll('tr[data-vendor-id]').forEach(tr => {
    const id = tr.dataset.vendorId;
    tr.querySelector('[data-role="open-vendor-detail"]').addEventListener('click', () => openVendorDetail(id));
    tr.querySelector('[data-role="edit-vendor"]').addEventListener('click', () => openVendorForm(id));
    tr.querySelector('[data-role="delete-vendor"]').addEventListener('click', async () => {
      const v = vendorsList.find(x => x.id === id);
      const ok = await showConfirm(`Delete "${v ? v.name : 'this vendor'}"?`, 'Delete');
      if (!ok) return;
      await deleteVendorRemote(id);
      vendorsList = vendorsList.filter(x => x.id !== id);
      renderVendorsPage();
      showToast('Vendor deleted.');
    });
  });
}

function openVendorForm(id) {
  editingVendorId = id || null;
  const v = id ? vendorsList.find(x => x.id === id) : null;
  document.getElementById('vendorFormTitle').textContent = v ? 'Edit vendor' : 'Add vendor';
  document.getElementById('saveVendorBtn').textContent = v ? 'Save changes' : 'Add vendor';
  document.getElementById('vendorName').value = v ? v.name : '';
  document.getElementById('vendorSalesman').value = v ? v.salesmanName : '';
  document.getElementById('vendorPhone').value = v ? v.phone : '';
  document.getElementById('vendorDay').value = v && v.dayOfWeek !== null ? String(v.dayOfWeek) : '5';
  document.getElementById('vendorFrequency').value = v ? String(v.frequencyWeeks) : '1';
  document.getElementById('vendorLeadTime').value = v && v.leadTimeDays !== null ? v.leadTimeDays : '';
  document.getElementById('vendorAnchor').value = v ? v.anchorDate : '';
  document.getElementById('vendorFormCard').style.display = 'block';
  document.getElementById('vendorFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('vendorName').focus();
}
function closeVendorForm() {
  editingVendorId = null;
  document.getElementById('vendorFormCard').style.display = 'none';
}

document.getElementById('addVendorBtn').addEventListener('click', () => openVendorForm(null));
document.getElementById('cancelVendorFormBtn').addEventListener('click', closeVendorForm);

document.getElementById('saveVendorBtn').addEventListener('click', async () => {
  const name = document.getElementById('vendorName').value.trim();
  if (!name) { showToast('Enter a vendor name.', true); return; }
  const leadRaw = document.getElementById('vendorLeadTime').value.trim();
  const vendor = {
    id: editingVendorId || uid(),
    name,
    salesmanName: document.getElementById('vendorSalesman').value.trim(),
    phone: document.getElementById('vendorPhone').value.trim(),
    dayOfWeek: Number(document.getElementById('vendorDay').value),
    frequencyWeeks: Number(document.getElementById('vendorFrequency').value),
    leadTimeDays: leadRaw === '' ? null : Number(leadRaw),
    anchorDate: document.getElementById('vendorAnchor').value || ''
  };
  const ok = await saveVendorRemote(vendor);
  if (!ok) return;
  if (editingVendorId) {
    const idx = vendorsList.findIndex(x => x.id === editingVendorId);
    if (idx > -1) vendorsList[idx] = vendor; else vendorsList.push(vendor);
  } else {
    vendorsList.push(vendor);
  }
  vendorsList.sort((a, b) => a.name.localeCompare(b.name));
  closeVendorForm();
  renderVendorsPage();
  showToast(editingVendorId ? 'Vendor updated.' : 'Vendor added.');
});

document.getElementById('vendorSearchInput').addEventListener('input', (e) => {
  vendorSearchTerm = e.target.value;
  renderVendorsPage();
});

document.getElementById('importVendorsBtn').addEventListener('click', () => {
  document.getElementById('vendorFileInput').click();
});

document.getElementById('vendorFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { showToast('Could not read that file — check the format.', true); e.target.value = ''; return; }

  const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'vendors') || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) { showToast('That sheet has no rows.', true); e.target.value = ''; return; }

  const headerKeys = Object.keys(rows[0]);
  const nameKey = findVendorHeaderKey(headerKeys, ['name', 'vendor', 'vendor name', 'supplier', 'supplier name']);
  const salesKey = findVendorHeaderKey(headerKeys, ['salesman', 'salesman name', 'rep', 'sales rep', 'contact']);
  const phoneKey = findVendorHeaderKey(headerKeys, ['phone', 'phone number', 'contact number', 'tel', 'mobile']);
  const dayKey = findVendorHeaderKey(headerKeys, ['day', 'day of week', 'delivery day', 'routing day']);
  const freqKey = findVendorHeaderKey(headerKeys, ['frequency', 'routing', 'interval']);
  const leadKey = findVendorHeaderKey(headerKeys, ['lead time', 'lead time days', 'leadtime', 'lead']);
  const anchorKey = findVendorHeaderKey(headerKeys, ['anchor date', 'start date', 'first date', 'anchor']);

  if (!nameKey) { showToast('Could not find a vendor name column in that file.', true); e.target.value = ''; return; }

  const parsed = [];
  let skipped = 0;
  rows.forEach(row => {
    const name = String(row[nameKey] ?? '').trim();
    if (!name) { skipped++; return; }
    let anchorDate = anchorKey ? String(row[anchorKey] ?? '').trim() : '';
    if (anchorDate && !isNaN(Date.parse(anchorDate))) {
      anchorDate = localDateStr(new Date(anchorDate));
    } else if (anchorDate) {
      anchorDate = '';
    }
    parsed.push({
      id: uid(),
      name,
      salesmanName: salesKey ? String(row[salesKey] ?? '').trim() : '',
      phone: phoneKey ? String(row[phoneKey] ?? '').trim() : '',
      dayOfWeek: dayKey ? parseVendorDay(row[dayKey]) : null,
      frequencyWeeks: freqKey ? parseVendorFrequency(row[freqKey]) : 1,
      leadTimeDays: (leadKey && row[leadKey] !== '' && !isNaN(Number(row[leadKey]))) ? Number(row[leadKey]) : null,
      anchorDate
    });
  });

  if (!parsed.length) { showToast('No vendors found to import.', true); e.target.value = ''; return; }

  const chunkSize = 500;
  for (let i = 0; i < parsed.length; i += chunkSize) {
    const chunk = parsed.slice(i, i + chunkSize).map(v => ({
      id: v.id, name: v.name, salesman_name: v.salesmanName || null, phone: v.phone || null,
      day_of_week: v.dayOfWeek, frequency_weeks: v.frequencyWeeks,
      lead_time_days: v.leadTimeDays, anchor_date: v.anchorDate || null
    }));
    const { error } = await sb.from('vendors').insert(chunk);
    if (error) { console.error(error); showToast('Import failed partway through — ' + sbErrText(error), true); e.target.value = ''; await loadVendorsData(); renderVendorsPage(); return; }
  }

  e.target.value = '';
  await loadVendorsData();
  renderVendorsPage();
  const skippedNote = skipped ? ` (${skipped} row${skipped === 1 ? '' : 's'} skipped — no name)` : '';
  showToast(`Imported ${parsed.length} vendor${parsed.length === 1 ? '' : 's'}${skippedNote}.`);
});

/* ============================================================
   Orders & no-order weeks (placing/tracking orders per vendor)
   ============================================================ */
function parseLocalDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDaysStr(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function fmtOrdersDate(dateStr) {
  if (!dateStr) return '';
  const d = parseLocalDate(dateStr);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[d.getDay()] + ', ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function isVendorDueOn(v, dateStr) {
  if (v.dayOfWeek === null || v.dayOfWeek === undefined || !v.anchorDate) return false;
  const date = parseLocalDate(dateStr);
  if (date.getDay() !== Number(v.dayOfWeek)) return false;
  const anchor = parseLocalDate(v.anchorDate);
  const diffDays = Math.round((date - anchor) / 86400000);
  if (diffDays < 0) return false;
  const diffWeeks = Math.round(diffDays / 7);
  return diffWeeks % Number(v.frequencyWeeks || 1) === 0;
}
function pendingOrderForVendor(vendorId) {
  const list = ordersList.filter(o => o.vendorId === vendorId && o.status === 'pending')
    .sort((a, b) => (a.orderDate || '') < (b.orderDate || '') ? 1 : -1);
  return list.length ? list[0] : null;
}
// "Place order" is a two-step flow: clicking it first logs the order as
// 'not_sent' (drafted — you've decided to order but haven't actually told
// the supplier), which is a separate bucket from 'pending' (sent, now
// waiting on delivery). No expected-delivery date exists yet for a
// not-yet-sent order, since the lead time only starts counting once it's
// actually sent.
function notSentOrderForVendor(vendorId) {
  const list = ordersList.filter(o => o.vendorId === vendorId && o.status === 'not_sent')
    .sort((a, b) => (a.orderDate || '') < (b.orderDate || '') ? 1 : -1);
  return list.length ? list[0] : null;
}
function isOrderOverdue(o) {
  return !!o && o.status === 'pending' && !!o.expectedDelivery && o.expectedDelivery < todayStr();
}
// Orders that are long overdue (or "no order" logs from a while back) stay
// in Order history forever, but drop out of the day-to-day working lists
// after this many days so a forgotten delivery doesn't clutter every visit.
const ORDERS_STALE_AFTER_DAYS = 7;
function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.round((parseLocalDate(todayStr()) - parseLocalDate(dateStr)) / 86400000);
}
function isAwaitingOrderStale(o) {
  return !!o && isOrderOverdue(o) && daysSince(o.expectedDelivery) > ORDERS_STALE_AFTER_DAYS;
}
// An order logged as "not sent" has no expected-delivery countdown yet, so
// it can't go "overdue" the way a pending order can — it can only sit
// forgotten. This is the nag threshold for that: past this many days since
// it was logged, it's worth a reminder that it was never actually sent.
const NOT_SENT_ALERT_AFTER_DAYS = 2;
function isNotSentAging(o) {
  return !!o && o.status === 'not_sent' && daysSince(o.orderDate) >= NOT_SENT_ALERT_AFTER_DAYS;
}
function hasSkipOnDate(vendorId, dateStr) {
  return skipsList.some(s => s.vendorId === vendorId && s.skipDate === dateStr);
}
function skipForDate(vendorId, dateStr) {
  return skipsList.find(s => s.vendorId === vendorId && s.skipDate === dateStr);
}

// Vendor/order notifications (overdue orders, due-tomorrow reminders) reuse
// the existing bell/sound/browser-notification system (pushNotification),
// but vendor_orders has no spare column to store a per-record dedup flag
// the way sell-outs do, so the "already notified today" log lives in
// localStorage instead — keyed per order/vendor + occurrence so a fired
// notification never repeats the same day.
const VENDOR_NOTIFY_LOG_KEY = 'sellout-ledger:vendorNotifyLog';
function loadVendorNotifyLog() {
  try {
    const raw = localStorage.getItem(VENDOR_NOTIFY_LOG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function saveVendorNotifyLog(log) {
  try { localStorage.setItem(VENDOR_NOTIFY_LOG_KEY, JSON.stringify(log)); } catch (e) { /* ignore — won't persist this time */ }
}
function runVendorNotificationCheck() {
  const today = todayStr();
  const log = loadVendorNotifyLog();
  let changed = false;
  const fire = (key, msg) => {
    if (log[key] === today) return;
    log[key] = today; changed = true; pushNotification(msg);
  };
  ordersList.forEach(o => {
    if (isOrderOverdue(o)) {
      const v = vendorsList.find(x => x.id === o.vendorId);
      const name = v ? v.name : (o.vendorName || 'A vendor');
      fire(`vendorOrderOverdue:${o.id}`, `"${name}"'s order is overdue — expected ${fmtOrdersDate(o.expectedDelivery)} and still not marked delivered.`);
    }
    if (isNotSentAging(o)) {
      const v = vendorsList.find(x => x.id === o.vendorId);
      const name = v ? v.name : (o.vendorName || 'A vendor');
      const days = daysSince(o.orderDate);
      fire(`vendorNotSentAging:${o.id}`, `"${name}"'s order has been logged for ${days} day${days === 1 ? '' : 's'} but still hasn't been marked sent to the supplier.`);
    }
  });
  if (changed) saveVendorNotifyLog(log);
}

async function loadOrdersData() {
  const { data, error } = await sb.from('vendor_orders').select('*').order('order_date', { ascending: false });
  if (error) { console.error(error); showToast('Could not load orders — ' + sbErrText(error), true); return; }
  ordersList = (data || []).map(r => ({
    id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name || '',
    orderDate: r.order_date, leadTimeDays: r.lead_time_days === undefined ? null : r.lead_time_days,
    expectedDelivery: r.expected_delivery, status: r.status || 'pending', deliveredDate: r.delivered_date
  }));
}
async function saveOrderRemote(o) {
  const row = {
    id: o.id, vendor_id: o.vendorId || null, vendor_name: o.vendorName || null,
    order_date: o.orderDate || null,
    lead_time_days: (o.leadTimeDays === null || o.leadTimeDays === undefined) ? null : Number(o.leadTimeDays),
    expected_delivery: o.expectedDelivery || null, status: o.status || 'pending', delivered_date: o.deliveredDate || null
  };
  const { error } = await sb.from('vendor_orders').upsert(row);
  if (error) { console.error(error); showToast('Could not save that order — ' + sbErrText(error), true); return false; }
  return true;
}
async function deleteOrderRemote(id) {
  const { error } = await sb.from('vendor_orders').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete that order — ' + sbErrText(error), true); }
}
async function loadSkipsData() {
  const { data, error } = await sb.from('vendor_skips').select('*');
  if (error) { console.error(error); showToast('Could not load no-order weeks — ' + sbErrText(error), true); return; }
  skipsList = (data || []).map(r => ({ id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name || '', skipDate: r.skip_date }));
}
async function saveSkipRemote(s) {
  const row = { id: s.id, vendor_id: s.vendorId || null, vendor_name: s.vendorName || null, skip_date: s.skipDate };
  const { error } = await sb.from('vendor_skips').upsert(row);
  if (error) { console.error(error); showToast('Could not save that — ' + sbErrText(error), true); return false; }
  return true;
}
async function deleteSkipRemote(id) {
  const { error } = await sb.from('vendor_skips').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not undo that — ' + sbErrText(error), true); }
}

document.querySelectorAll('#vendorSubTabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    vendorSubTab = btn.dataset.vsub;
    document.querySelectorAll('#vendorSubTabs button').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('vendorDirectoryView').style.display = vendorSubTab === 'directory' ? 'block' : 'none';
    document.getElementById('vendorOrdersView').style.display = vendorSubTab === 'orders' ? 'block' : 'none';
    if (vendorSubTab === 'orders') renderOrdersView();
  });
});

function renderOrdersView() {
  const dateStr = ordersViewDate;
  const isToday = dateStr === todayStr();
  document.getElementById('ordersDateLabel').textContent = fmtOrdersDate(dateStr) + (isToday ? ' · Today' : '');
  document.getElementById('ordersDateTodayBtn').style.display = isToday ? 'none' : '';
  document.getElementById('ordersDueTitle').textContent = 'Due ' + (isToday ? 'today' : 'on this date');
  document.getElementById('ordersSkippedTitle').textContent = 'No order logged — ' + fmtOrdersDate(dateStr);

  // One search box filters every table on this sub-tab by vendor name, so
  // switching dates or the History status filter never has to be paired
  // with re-typing a vendor name to find them again.
  const searchTerm = ordersSearchTerm.trim().toLowerCase();
  const matchesVendorSearch = (name) => !searchTerm || (name || '').toLowerCase().includes(searchTerm);

  const dueVendors = vendorsList.filter(v => isVendorDueOn(v, dateStr) && matchesVendorSearch(v.name));
  const dueNeedAction = dueVendors.filter(v => !pendingOrderForVendor(v.id) && !notSentOrderForVendor(v.id) && !hasSkipOnDate(v.id, dateStr));
  const skippedAll = vendorsList.filter(v => !pendingOrderForVendor(v.id) && hasSkipOnDate(v.id, dateStr) && matchesVendorSearch(v.name));
  const skippedForDate = skippedAll.filter(v => daysSince(skipForDate(v.id, dateStr).skipDate) <= ORDERS_STALE_AFTER_DAYS);
  const skippedHiddenCount = skippedAll.length - skippedForDate.length;
  const notSent = vendorsList.filter(v => notSentOrderForVendor(v.id) && matchesVendorSearch(v.name)).sort((a, b) => {
    const oa = notSentOrderForVendor(a.id), ob = notSentOrderForVendor(b.id);
    return (oa.orderDate || '') < (ob.orderDate || '') ? -1 : 1;
  });
  const awaitingAll = vendorsList.filter(v => pendingOrderForVendor(v.id) && matchesVendorSearch(v.name));
  const awaiting = awaitingAll.filter(v => !isAwaitingOrderStale(pendingOrderForVendor(v.id))).sort((a, b) => {
    const oa = pendingOrderForVendor(a.id), ob = pendingOrderForVendor(b.id);
    return (oa.expectedDelivery || '') < (ob.expectedDelivery || '') ? -1 : 1;
  });
  const awaitingHiddenCount = awaitingAll.length - awaiting.length;
  const overdueCount = awaiting.filter(v => isOrderOverdue(pendingOrderForVendor(v.id))).length;

  document.getElementById('ordersDueBadge').textContent = dueNeedAction.length + ' due';
  document.getElementById('ordersNotSentBadge').textContent = notSent.length + ' not sent';
  document.getElementById('ordersAwaitingBadge').textContent = awaiting.length + ' awaiting';
  document.getElementById('ordersOverdueBadge').textContent = overdueCount + ' overdue';

  // Bulk selection only ever applies to vendors currently shown in the Due
  // list, so drop any ids left over from a previous date or search — the
  // bulk bar's count should never refer to a vendor that's scrolled off.
  const dueIds = new Set(dueNeedAction.map(v => v.id));
  Array.from(ordersDueSelection).forEach(id => { if (!dueIds.has(id)) ordersDueSelection.delete(id); });

  const dueBody = document.getElementById('ordersDueBody');
  dueBody.innerHTML = dueNeedAction.map(v => `
    <tr data-vendor-id="${v.id}">
      <td class="checkbox-cell"><input type="checkbox" data-role="due-check" ${ordersDueSelection.has(v.id) ? 'checked' : ''}></td>
      <td><button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(v.name)}</button></td>
      <td>${escapeHtml(v.salesmanName || '—')}</td>
      <td class="mono">${escapeHtml(v.phone || '—')}</td>
      <td>${v.leadTimeDays === null ? '—' : v.leadTimeDays + 'd'}</td>
      <td style="white-space:nowrap;">
        <button class="btn small" data-role="place-order">Place order</button>
        <button class="btn ghost small" data-role="no-order">No order</button>
      </td>
    </tr>
  `).join('');
  document.getElementById('ordersDueEmpty').style.display = dueNeedAction.length ? 'none' : 'block';
  dueBody.querySelectorAll('tr[data-vendor-id]').forEach(tr => {
    const v = vendorsList.find(x => x.id === tr.dataset.vendorId);
    tr.querySelector('[data-role="open-vendor-detail"]').addEventListener('click', () => openVendorDetail(v.id));
    tr.querySelector('[data-role="place-order"]').addEventListener('click', () => placeOrderForVendor(v));
    tr.querySelector('[data-role="no-order"]').addEventListener('click', () => logNoOrder(v, dateStr));
    tr.querySelector('[data-role="due-check"]').addEventListener('change', (e) => {
      if (e.target.checked) ordersDueSelection.add(v.id); else ordersDueSelection.delete(v.id);
      renderOrdersDueSelectAll(dueNeedAction);
      renderOrdersBulkBar(dueNeedAction, dateStr);
    });
  });
  renderOrdersDueSelectAll(dueNeedAction);
  const selectAllBox = document.getElementById('ordersDueSelectAll');
  selectAllBox.onchange = () => {
    if (selectAllBox.checked) dueNeedAction.forEach(v => ordersDueSelection.add(v.id));
    else dueNeedAction.forEach(v => ordersDueSelection.delete(v.id));
    renderOrdersView();
  };
  renderOrdersBulkBar(dueNeedAction, dateStr);
  renderOrdersWeekStrip();

  const notSentBody = document.getElementById('ordersNotSentBody');
  notSentBody.innerHTML = notSent.map(v => {
    const o = notSentOrderForVendor(v.id);
    return `
    <tr data-order-id="${o.id}" data-vendor-id="${v.id}">
      <td><button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(v.name)}</button></td>
      <td>${escapeHtml(v.salesmanName || '—')}</td>
      <td class="mono">${escapeHtml(o.orderDate || '—')}</td>
      <td style="white-space:nowrap;">
        <button class="btn small" data-role="mark-sent">Mark sent</button>
        <button class="btn ghost small" data-role="delete-order" style="color:var(--brick);">Delete</button>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('ordersNotSentEmpty').style.display = notSent.length ? 'none' : 'block';
  notSentBody.querySelectorAll('tr[data-order-id]').forEach(tr => {
    const id = tr.dataset.orderId;
    tr.querySelector('[data-role="open-vendor-detail"]').addEventListener('click', () => openVendorDetail(tr.dataset.vendorId));
    tr.querySelector('[data-role="mark-sent"]').addEventListener('click', () => markOrderSent(id));
    tr.querySelector('[data-role="delete-order"]').addEventListener('click', () => deleteOrderRow(id));
  });

  const awaitBody = document.getElementById('ordersAwaitingBody');
  awaitBody.innerHTML = awaiting.map(v => {
    const o = pendingOrderForVendor(v.id);
    const overdue = isOrderOverdue(o);
    return `
    <tr data-order-id="${o.id}" data-vendor-id="${v.id}">
      <td><button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(v.name)}</button></td>
      <td>${escapeHtml(v.salesmanName || '—')}</td>
      <td class="mono">${escapeHtml(o.orderDate || '—')}</td>
      <td class="mono">${escapeHtml(o.expectedDelivery || '—')}</td>
      <td><span class="badge ${overdue ? 'danger' : 'warn'}">${overdue ? 'Overdue' : 'Pending'}</span></td>
      <td style="white-space:nowrap;">
        <button class="btn small" data-role="mark-delivered">Mark delivered</button>
        <button class="btn ghost small" data-role="delete-order" style="color:var(--brick);">Delete</button>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('ordersAwaitingEmpty').style.display = awaiting.length ? 'none' : 'block';
  awaitBody.querySelectorAll('tr[data-order-id]').forEach(tr => {
    const id = tr.dataset.orderId;
    tr.querySelector('[data-role="open-vendor-detail"]').addEventListener('click', () => openVendorDetail(tr.dataset.vendorId));
    tr.querySelector('[data-role="mark-delivered"]').addEventListener('click', () => markOrderDelivered(id));
    tr.querySelector('[data-role="delete-order"]').addEventListener('click', () => deleteOrderRow(id));
  });
  const awaitingHiddenNote = document.getElementById('ordersAwaitingHiddenNote');
  if (awaitingHiddenCount > 0) {
    awaitingHiddenNote.style.display = 'block';
    awaitingHiddenNote.textContent = `${awaitingHiddenCount} order${awaitingHiddenCount === 1 ? '' : 's'} more than a week overdue — hidden here, still in Order history below.`;
  } else {
    awaitingHiddenNote.style.display = 'none';
  }

  const skipBody = document.getElementById('ordersSkippedBody');
  skipBody.innerHTML = skippedForDate.map(v => `
    <tr data-vendor-id="${v.id}">
      <td><button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(v.name)}</button></td>
      <td>${escapeHtml(v.salesmanName || '—')}</td>
      <td class="mono">${dateStr}</td>
      <td><button class="btn ghost small" data-role="undo-skip">Undo</button></td>
    </tr>
  `).join('');
  document.getElementById('ordersSkippedEmpty').style.display = skippedForDate.length ? 'none' : 'block';
  skipBody.querySelectorAll('tr[data-vendor-id]').forEach(tr => {
    tr.querySelector('[data-role="open-vendor-detail"]').addEventListener('click', () => openVendorDetail(tr.dataset.vendorId));
    tr.querySelector('[data-role="undo-skip"]').addEventListener('click', () => undoSkip(tr.dataset.vendorId, dateStr));
  });
  const skippedHiddenNote = document.getElementById('ordersSkippedHiddenNote');
  if (skippedHiddenCount > 0) {
    skippedHiddenNote.style.display = 'block';
    skippedHiddenNote.textContent = `${skippedHiddenCount} logged more than a week ago — no longer shown here.`;
  } else {
    skippedHiddenNote.style.display = 'none';
  }

  renderOrderHistory();
}

// A rolling 7-day look-ahead (today + the next 6 days) so a vendor's next
// couple of deliveries are visible without stepping through the date
// arrows one day at a time. Clicking a day jumps the whole Orders sub-tab
// to that date, same as the prev/next arrows.
function renderOrdersWeekStrip() {
  const strip = document.getElementById('ordersWeekStrip');
  if (!strip) return;
  const today = todayStr();
  const dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDaysStr(today, i));
  strip.innerHTML = days.map(d => {
    const date = parseLocalDate(d);
    const dueHere = vendorsList.filter(v => isVendorDueOn(v, d));
    const needAction = dueHere.filter(v => !pendingOrderForVendor(v.id) && !notSentOrderForVendor(v.id) && !hasSkipOnDate(v.id, d));
    let countLabel, countClass;
    if (!dueHere.length) { countLabel = 'None due'; countClass = ''; }
    else if (needAction.length) { countLabel = `${needAction.length} due`; countClass = 'has-due'; }
    else { countLabel = `${dueHere.length} done`; countClass = 'all-done'; }
    const classes = ['week-strip-day'];
    if (d === today) classes.push('is-today');
    if (d === ordersViewDate) classes.push('active');
    return `<div class="${classes.join(' ')}" data-date="${d}" title="${dueHere.length} vendor${dueHere.length === 1 ? '' : 's'} due ${fmtOrdersDate(d)}">
      <div class="wd-dow">${dowLabels[date.getDay()]}</div>
      <div class="wd-num">${date.getDate()}</div>
      <div class="wd-count ${countClass}">${countLabel}</div>
    </div>`;
  }).join('');
  strip.querySelectorAll('.week-strip-day').forEach(el => {
    el.addEventListener('click', () => { ordersViewDate = el.dataset.date; renderOrdersView(); });
  });
}
function renderOrdersDueSelectAll(dueNeedAction) {
  const box = document.getElementById('ordersDueSelectAll');
  box.disabled = dueNeedAction.length === 0;
  box.checked = dueNeedAction.length > 0 && dueNeedAction.every(v => ordersDueSelection.has(v.id));
}
function renderOrdersBulkBar(dueNeedAction, dateStr) {
  const bar = document.getElementById('ordersBulkBar');
  const selected = dueNeedAction.filter(v => ordersDueSelection.has(v.id));
  if (!selected.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  document.getElementById('ordersBulkCount').textContent = selected.length + ' selected';
  document.getElementById('ordersBulkPlaceBtn').onclick = () => bulkPlaceOrders(selected, dateStr);
  document.getElementById('ordersBulkNoOrderBtn').onclick = () => bulkNoOrder(selected, dateStr);
  document.getElementById('ordersBulkClearBtn').onclick = () => { ordersDueSelection.clear(); renderOrdersView(); };
}

// Placing an order is two steps: this logs it as 'not_sent' — you've
// decided to order from this vendor, but haven't actually sent it to them
// yet — with no expected-delivery date, since the lead-time countdown only
// starts once it's really sent (see markOrderSent). Split out from
// placeOrderForVendor so bulkPlaceOrders can create several without
// popping a confirm dialog or a toast per vendor.
async function createNotSentOrder(v, orderDate) {
  const leadTimeDays = (v.leadTimeDays === null || v.leadTimeDays === undefined) ? 4 : Number(v.leadTimeDays);
  const order = { id: uid(), vendorId: v.id, vendorName: v.name, orderDate, leadTimeDays, expectedDelivery: null, status: 'not_sent', deliveredDate: null };
  const saved = await saveOrderRemote(order);
  if (!saved) return false;
  ordersList.push(order);
  return true;
}
async function placeOrderForVendor(v) {
  const ok = await showConfirm(`Log an order to place for "${v.name}"? It'll sit in "Not sent yet" until you mark it as actually sent to the supplier.`, 'Place order');
  if (!ok) return;
  const done = await createNotSentOrder(v, ordersViewDate);
  if (!done) return;
  renderOrdersView();
  showToast('Logged for ' + v.name + ' — mark it sent once it’s actually gone to the supplier.');
}
// The lead-time countdown starts here, not when the order was first logged
// — "sent" is the moment the supplier actually knows about the order.
async function markOrderSent(orderId) {
  const o = ordersList.find(x => x.id === orderId);
  if (!o) return;
  const sentDate = todayStr();
  const leadTimeDays = (o.leadTimeDays === null || o.leadTimeDays === undefined) ? 4 : Number(o.leadTimeDays);
  const expected = addDaysStr(sentDate, leadTimeDays);
  const ok = await showConfirm(`Mark this order as sent to the supplier today (${sentDate})? Expected delivery ${expected} (lead time ${leadTimeDays}d).`, 'Mark sent');
  if (!ok) return;
  o.orderDate = sentDate;
  o.expectedDelivery = expected;
  o.status = 'pending';
  const saved = await saveOrderRemote(o);
  if (!saved) return;
  renderOrdersView();
  showToast('Marked sent — now awaiting delivery.');
}
// Split out (see createNotSentOrder above) so bulkNoOrder can log several
// "no order" entries behind a single confirm.
async function createSkip(v, dateStr) {
  const skip = { id: uid(), vendorId: v.id, vendorName: v.name, skipDate: dateStr };
  const saved = await saveSkipRemote(skip);
  if (!saved) return false;
  skipsList.push(skip);
  return true;
}
async function logNoOrder(v, dateStr) {
  const ok = await showConfirm(`Log "no order" for "${v.name}" on ${dateStr}?`, 'Log no order');
  if (!ok) return;
  const done = await createSkip(v, dateStr);
  if (!done) return;
  renderOrdersView();
  showToast('Logged — no order for ' + v.name + '.');
}
async function bulkPlaceOrders(vendors, dateStr) {
  if (!vendors.length) return;
  const ok = await showConfirm(
    `Log orders to place for ${vendors.length} vendor${vendors.length === 1 ? '' : 's'}? Each will sit in "Not sent yet" until you mark it sent to the supplier.`,
    `Place ${vendors.length} order${vendors.length === 1 ? '' : 's'}`
  );
  if (!ok) return;
  let count = 0;
  for (const v of vendors) {
    if (await createNotSentOrder(v, dateStr)) { count++; ordersDueSelection.delete(v.id); }
  }
  renderOrdersView();
  showToast(`Logged ${count} order${count === 1 ? '' : 's'} — mark each sent once it's actually gone to the supplier.`);
}
async function bulkNoOrder(vendors, dateStr) {
  if (!vendors.length) return;
  const ok = await showConfirm(
    `Log "no order" for ${vendors.length} vendor${vendors.length === 1 ? '' : 's'} on ${dateStr}?`,
    `Log ${vendors.length} as no order`
  );
  if (!ok) return;
  let count = 0;
  for (const v of vendors) {
    if (await createSkip(v, dateStr)) { count++; ordersDueSelection.delete(v.id); }
  }
  renderOrdersView();
  showToast(`Logged "no order" for ${count} vendor${count === 1 ? '' : 's'}.`);
}
async function undoSkip(vendorId, dateStr) {
  const skip = skipForDate(vendorId, dateStr);
  if (!skip) return;
  await deleteSkipRemote(skip.id);
  skipsList = skipsList.filter(s => s.id !== skip.id);
  renderOrdersView();
}
async function markOrderDelivered(orderId) {
  const o = ordersList.find(x => x.id === orderId);
  if (!o) return;
  const deliveredDate = todayStr();
  const ok = await showConfirm(`Mark this order delivered today (${deliveredDate})?`, 'Mark delivered');
  if (!ok) return;
  o.status = 'delivered';
  o.deliveredDate = deliveredDate;
  const saved = await saveOrderRemote(o);
  if (!saved) return;
  renderOrdersView();
  showToast('Marked delivered.');
}
async function deleteOrderRow(orderId) {
  const ok = await showConfirm('Delete this order? This can’t be undone.', 'Delete');
  if (!ok) return;
  await deleteOrderRemote(orderId);
  ordersList = ordersList.filter(o => o.id !== orderId);
  renderOrdersView();
  showToast('Order deleted.');
}

// One vendor's full picture in a single place — every order and no-order
// entry it has ever had, newest first — so a question like "when did we
// last actually order from them?" doesn't mean hunting across the
// separate Due / Not sent / Awaiting / Skipped / History tables above.
function openVendorDetail(vendorId) {
  const v = vendorsList.find(x => x.id === vendorId);
  if (!v) return;

  document.getElementById('vendorDetailName').textContent = v.name;
  const metaParts = [];
  if (v.salesmanName) metaParts.push(v.salesmanName);
  if (v.phone) metaParts.push(v.phone);
  if (v.dayOfWeek !== null && v.dayOfWeek !== undefined) {
    const freq = Number(v.frequencyWeeks || 1) === 1 ? 'every week' : `every ${v.frequencyWeeks} weeks`;
    metaParts.push(`${VENDOR_DAY_NAMES[Number(v.dayOfWeek)]}, ${freq}`);
  }
  if (v.leadTimeDays !== null && v.leadTimeDays !== undefined) metaParts.push(`${v.leadTimeDays}d lead time`);
  document.getElementById('vendorDetailMeta').textContent = metaParts.length ? metaParts.join(' · ') : 'No schedule details on file.';

  const vOrders = ordersList.filter(o => o.vendorId === vendorId);
  const vSkips = skipsList.filter(s => s.vendorId === vendorId);
  const delivered = vOrders.filter(o => o.status === 'delivered').length;
  const pendingCount = vOrders.filter(o => o.status === 'pending').length;
  const notSentCount = vOrders.filter(o => o.status === 'not_sent').length;
  const overdueCount = vOrders.filter(isOrderOverdue).length;

  const stats = [`<span class="badge active">${vOrders.length} order${vOrders.length === 1 ? '' : 's'} logged</span>`];
  if (delivered) stats.push(`<span class="badge active">${delivered} delivered</span>`);
  if (pendingCount) stats.push(`<span class="badge warn">${pendingCount} pending</span>`);
  if (overdueCount) stats.push(`<span class="badge danger">${overdueCount} overdue</span>`);
  if (notSentCount) stats.push(`<span class="badge inactive">${notSentCount} not sent</span>`);
  if (vSkips.length) stats.push(`<span class="badge inactive">${vSkips.length} no-order log${vSkips.length === 1 ? '' : 's'}</span>`);
  document.getElementById('vendorDetailStats').innerHTML = stats.join('');

  const rows = [
    ...vOrders.map(o => ({ date: o.orderDate || '', order: o })),
    ...vSkips.map(s => ({ date: s.skipDate || '', skip: s }))
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const body = document.getElementById('vendorDetailHistoryBody');
  body.innerHTML = rows.map(r => {
    if (r.skip) {
      return `<tr><td class="mono">${escapeHtml(r.skip.skipDate || '—')}</td><td>No order</td><td><span class="badge inactive">Skipped</span></td><td>—</td></tr>`;
    }
    const o = r.order;
    const overdue = isOrderOverdue(o);
    const statusBadge = o.status === 'delivered' ? '<span class="badge active">Delivered</span>'
      : o.status === 'not_sent' ? '<span class="badge inactive">Not sent</span>'
      : (overdue ? '<span class="badge danger">Overdue</span>' : '<span class="badge warn">Pending</span>');
    const secondDate = o.status === 'delivered' ? o.deliveredDate : o.expectedDelivery;
    return `<tr><td class="mono">${escapeHtml(o.orderDate || '—')}</td><td>Order</td><td>${statusBadge}</td><td class="mono">${escapeHtml(secondDate || '—')}</td></tr>`;
  }).join('');
  document.getElementById('vendorDetailEmpty').style.display = rows.length ? 'none' : 'block';

  document.getElementById('vendorDetailOverlay').classList.add('open');
}
function closeVendorDetail() {
  document.getElementById('vendorDetailOverlay').classList.remove('open');
}
document.getElementById('closeVendorDetailBtn').addEventListener('click', closeVendorDetail);
document.getElementById('vendorDetailOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'vendorDetailOverlay') closeVendorDetail();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('vendorDetailOverlay').classList.contains('open')) closeVendorDetail();
});

function renderOrderHistory() {
  let list = ordersList.slice().sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
  if (orderHistoryFilter === 'pending') list = list.filter(o => o.status === 'pending' && !isOrderOverdue(o));
  if (orderHistoryFilter === 'overdue') list = list.filter(isOrderOverdue);
  if (orderHistoryFilter === 'delivered') list = list.filter(o => o.status === 'delivered');
  const historySearchTerm = ordersSearchTerm.trim().toLowerCase();
  if (historySearchTerm) {
    list = list.filter(o => {
      const v = o.vendorId ? vendorsList.find(x => x.id === o.vendorId) : null;
      const name = v ? v.name : (o.vendorName || '');
      return name.toLowerCase().includes(historySearchTerm);
    });
  }

  const body = document.getElementById('orderHistoryBody');
  body.innerHTML = list.map(o => {
    const v = o.vendorId ? vendorsList.find(x => x.id === o.vendorId) : null;
    const name = v ? v.name : (o.vendorName || 'Unknown vendor');
    const overdue = isOrderOverdue(o);
    const statusBadge = o.status === 'delivered' ? '<span class="badge active">Delivered</span>'
      : o.status === 'not_sent' ? '<span class="badge inactive">Not sent</span>'
      : (overdue ? '<span class="badge danger">Overdue</span>' : '<span class="badge warn">Pending</span>');
    const nameCell = v ? `<button type="button" class="vendor-link" data-role="open-vendor-detail">${escapeHtml(name)}</button>` : `<strong>${escapeHtml(name)}</strong>`;
    return `
    <tr data-order-id="${o.id}"${v ? ` data-vendor-id="${v.id}"` : ''}>
      <td>${nameCell}</td>
      <td class="mono">${escapeHtml(o.orderDate || '—')}</td>
      <td class="mono">${escapeHtml(o.expectedDelivery || '—')}</td>
      <td>${statusBadge}</td>
      <td class="mono">${escapeHtml(o.deliveredDate || '—')}</td>
      <td><button class="btn ghost small" data-role="delete-order-h" style="color:var(--brick);">Delete</button></td>
    </tr>`;
  }).join('');
  document.getElementById('orderHistoryEmpty').style.display = list.length ? 'none' : 'block';
  body.querySelectorAll('tr[data-order-id]').forEach(tr => {
    const detailBtn = tr.querySelector('[data-role="open-vendor-detail"]');
    if (detailBtn) detailBtn.addEventListener('click', () => openVendorDetail(tr.dataset.vendorId));
    tr.querySelector('[data-role="delete-order-h"]').addEventListener('click', () => deleteOrderRow(tr.dataset.orderId));
  });
}
document.querySelectorAll('#orderHistoryFilters button').forEach(btn => {
  btn.addEventListener('click', () => {
    orderHistoryFilter = btn.dataset.ofilter;
    document.querySelectorAll('#orderHistoryFilters button').forEach(b => b.classList.toggle('active', b === btn));
    renderOrderHistory();
  });
});
document.getElementById('ordersDatePrev').addEventListener('click', () => { ordersViewDate = addDaysStr(ordersViewDate, -1); renderOrdersView(); });
document.getElementById('ordersDateNext').addEventListener('click', () => { ordersViewDate = addDaysStr(ordersViewDate, 1); renderOrdersView(); });
document.getElementById('ordersDateTodayBtn').addEventListener('click', () => { ordersViewDate = todayStr(); renderOrdersView(); });
document.getElementById('ordersSearchInput').addEventListener('input', (e) => {
  ordersSearchTerm = e.target.value;
  renderOrdersView();
});

document.getElementById('importOrdersBtn').addEventListener('click', () => document.getElementById('ordersFileInput').click());
document.getElementById('ordersFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { showToast('Could not read that file — check the format.', true); e.target.value = ''; return; }

  function vendorIdForName(name) {
    const n = (name || '').trim().toLowerCase();
    const v = vendorsList.find(x => x.name.trim().toLowerCase() === n);
    return v ? v.id : null;
  }

  let importedOrders = 0, importedSkips = 0;

  const ordersSheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'orders');
  if (ordersSheetName) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[ordersSheetName], { defval: '' });
    const headerKeys = rows.length ? Object.keys(rows[0]) : [];
    const vendorKey = findVendorHeaderKey(headerKeys, ['vendor', 'vendor name', 'name', 'supplier']);
    const orderDateKey = findVendorHeaderKey(headerKeys, ['order date', 'ordered', 'date']);
    const leadKey = findVendorHeaderKey(headerKeys, ['lead time (days)', 'lead time', 'lead']);
    const expectedKey = findVendorHeaderKey(headerKeys, ['expected delivery', 'expected']);
    const statusKey = findVendorHeaderKey(headerKeys, ['status']);
    const deliveredDateKey = findVendorHeaderKey(headerKeys, ['delivered date', 'delivery date']);

    const parsedOrders = [];
    rows.forEach(row => {
      const vendorName = vendorKey ? String(row[vendorKey] ?? '').trim() : '';
      if (!vendorName) return;
      const orderDateRaw = orderDateKey ? String(row[orderDateKey] ?? '').trim() : '';
      const orderDate = (orderDateRaw && !isNaN(Date.parse(orderDateRaw))) ? localDateStr(new Date(orderDateRaw)) : '';
      const expectedRaw = expectedKey ? String(row[expectedKey] ?? '').trim() : '';
      const expectedDelivery = (expectedRaw && !isNaN(Date.parse(expectedRaw))) ? localDateStr(new Date(expectedRaw)) : '';
      const deliveredRaw = deliveredDateKey ? String(row[deliveredDateKey] ?? '').trim() : '';
      const deliveredDate = (deliveredRaw && !isNaN(Date.parse(deliveredRaw))) ? localDateStr(new Date(deliveredRaw)) : null;
      const statusRaw = (statusKey ? String(row[statusKey] ?? '') : '').trim().toLowerCase();
      const status = statusRaw.includes('deliver') ? 'delivered' : 'pending';
      const leadRaw = leadKey ? row[leadKey] : '';
      parsedOrders.push({
        id: uid(), vendorId: vendorIdForName(vendorName), vendorName,
        orderDate: orderDate || null,
        leadTimeDays: (leadRaw !== '' && !isNaN(Number(leadRaw))) ? Number(leadRaw) : null,
        expectedDelivery: expectedDelivery || null, status, deliveredDate
      });
    });
    for (let i = 0; i < parsedOrders.length; i += 500) {
      const chunk = parsedOrders.slice(i, i + 500).map(o => ({
        id: o.id, vendor_id: o.vendorId, vendor_name: o.vendorName, order_date: o.orderDate,
        lead_time_days: o.leadTimeDays, expected_delivery: o.expectedDelivery, status: o.status, delivered_date: o.deliveredDate
      }));
      const { error } = await sb.from('vendor_orders').insert(chunk);
      if (error) { console.error(error); showToast('Order import failed partway — ' + sbErrText(error), true); e.target.value = ''; await loadOrdersData(); renderOrdersView(); return; }
    }
    importedOrders = parsedOrders.length;
  }

  const skipsSheetName = wb.SheetNames.find(n => ['no-order weeks', 'no order weeks'].includes(n.trim().toLowerCase()));
  if (skipsSheetName) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[skipsSheetName], { defval: '' });
    const headerKeys = rows.length ? Object.keys(rows[0]) : [];
    const vendorKey = findVendorHeaderKey(headerKeys, ['vendor', 'vendor name', 'name']);
    const dateKey = findVendorHeaderKey(headerKeys, ['no-order date', 'no order date', 'date']);
    const parsedSkips = [];
    rows.forEach(row => {
      const vendorName = vendorKey ? String(row[vendorKey] ?? '').trim() : '';
      if (!vendorName) return;
      const dateRaw = dateKey ? String(row[dateKey] ?? '').trim() : '';
      const skipDate = (dateRaw && !isNaN(Date.parse(dateRaw))) ? localDateStr(new Date(dateRaw)) : '';
      if (!skipDate) return;
      parsedSkips.push({ id: uid(), vendorId: vendorIdForName(vendorName), vendorName, skipDate });
    });
    for (let i = 0; i < parsedSkips.length; i += 500) {
      const chunk = parsedSkips.slice(i, i + 500).map(s => ({ id: s.id, vendor_id: s.vendorId, vendor_name: s.vendorName, skip_date: s.skipDate }));
      const { error } = await sb.from('vendor_skips').insert(chunk);
      if (error) { console.error(error); showToast('No-order import failed partway — ' + sbErrText(error), true); e.target.value = ''; await loadSkipsData(); renderOrdersView(); return; }
    }
    importedSkips = parsedSkips.length;
  }

  e.target.value = '';
  await loadOrdersData();
  await loadSkipsData();
  renderOrdersView();
  if (!importedOrders && !importedSkips) {
    showToast('No "Orders" or "No-Order Weeks" sheet found in that file.', true);
  } else {
    showToast(`Imported ${importedOrders} order${importedOrders === 1 ? '' : 's'} and ${importedSkips} no-order entr${importedSkips === 1 ? 'y' : 'ies'}.`);
  }
});

/* Rentals: js/modules/rentals.js */

async function initVendors() {
  await loadVendorsData();
  renderVendorsPage();
  await loadOrdersData();
  await loadSkipsData();
  renderOrdersView();
  runVendorNotificationCheck();
  await loadRentalsData();
  renderRentalsPage();
  runRentalNotificationCheck();   // yearly contracts ending within 30 days (js/modules/rentals.js)
}

// Called by auth.js after sign-in, once the role is known. Each module only
// starts if the role can see it (the database refuses the rest anyway).
function startMainModules() {
  if (canSee('sellouts') || canSee('creditnotes')) loadAll();
  if (canSee('promotions')) initPromotions();
  if (canSee('vendors') || canSee('rentals')) initVendors();
  if (canSee('cash') && window.Cash) Cash.start();
  if (canSee('floorcheck') && window.FloorCheck) FloorCheck.start();   // admin: finished-check notifications
}
