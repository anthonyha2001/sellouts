/* ============================================================
   Promotions › Import from file or photo (PLAN §10.3). Admin only.
   Supplier offers (PDF, photos, WhatsApp screenshots) are read by the
   extract-offer edge function (Claude); the admin reviews the lines,
   exports them, or adds them to the promotion through the existing
   price-sheet import (parsePriceSheetRows), so catalog lookup,
   discount rules and flags work exactly as for a price sheet.
   Public API: window.OfferImport = { open(promo) }.
   ============================================================ */
(function () {
  const MAX_FILES = 10;
  const MAX_TOTAL_B64 = 28 * 1024 * 1024;
  const LOW_CONFIDENCE = 0.7;
  const BUCKET = 'promotion-offers';
  const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  const S = { promo: null, files: [], lines: [], view: 0, busy: false };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const n2 = v => (v === null || v === undefined || v === '' ? '' : String(round2(v)));

  /* ---------------- modal shell ---------------- */
  function ensureModal() {
    if (el('offerOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="offerOverlay">
        <div class="modal-box offer-box" role="dialog" aria-labelledby="offerTitle">
          <div class="offer-head">
            <div><h3 id="offerTitle">Import from file or photo</h3><p class="muted-note" id="offerSub"></p></div>
            <button class="icon-btn" id="offerClose" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>
          <div id="offerBody"></div>
        </div>
      </div>`);
    el('offerClose').onclick = close;
  }
  async function close() {
    if (S.lines.length && !(await showConfirm('Close the offer import? The extracted lines that were not added will be lost.', 'Close'))) return;
    S.files.forEach(f => URL.revokeObjectURL(f.url));
    Object.assign(S, { files: [], lines: [], view: 0 });
    el('offerOverlay').classList.remove('open');
  }

  /* ---------------- step 1: files ---------------- */
  function renderPick() {
    el('offerSub').textContent = `Promotion: ${S.promo.name || ''}. PDFs, photos or WhatsApp screenshots of supplier offers (up to ${MAX_FILES}).`;
    el('offerBody').innerHTML = `
      <div class="offer-pick">
        <label class="offer-drop" id="offerDrop">
          <input type="file" id="offerFiles" accept="application/pdf,image/jpeg,image/png,image/webp" multiple hidden>
          <b>Choose files</b><span>or drop them here</span>
        </label>
        <ul class="offer-file-list">${S.files.map((f, i) => `<li><span>${esc(f.name)}</span><span class="muted-note">${f.type === 'application/pdf' ? 'PDF' : 'Photo'} · ${Math.round(f.b64.length * 0.75 / 1024)} KB</span><button class="link-btn" data-remove="${i}">Remove</button></li>`).join('')}</ul>
        <div class="actions-row">
          <button class="btn ghost small" id="offerCancel">Cancel</button>
          <button class="btn small" id="offerExtract" ${S.files.length ? '' : 'disabled'}>Read the offers</button>
        </div>
        <div id="offerSaved"></div>
      </div>`;
    const input = el('offerFiles');
    input.onchange = () => addFiles([...input.files]);
    const drop = el('offerDrop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
    el('offerBody').querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { const [f] = S.files.splice(+b.dataset.remove, 1); URL.revokeObjectURL(f.url); renderPick(); });
    el('offerCancel').onclick = close;
    el('offerExtract').onclick = extract;
    listSavedFiles();
  }

  async function addFiles(list) {
    for (const file of list) {
      if (S.files.length >= MAX_FILES) { showToast(`At most ${MAX_FILES} files at a time.`, true); break; }
      if (!TYPES.includes(file.type)) { showToast(`"${file.name}" is not a PDF, JPG, PNG or WEBP.`, true); continue; }
      try {
        // Phone photos are shrunk (sharp enough to read, much lighter to send); PDFs go as they are.
        const blob = file.type === 'application/pdf' ? file : await shrinkImage(file);
        const type = file.type === 'application/pdf' ? file.type : 'image/jpeg';
        S.files.push({ name: file.name, type, original: file, blob, b64: await blobToBase64(blob), url: URL.createObjectURL(blob) });
      } catch (e) { showToast(`Could not read "${file.name}".`, true); }
    }
    renderPick();
  }
  async function shrinkImage(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file.type === 'image/jpeg' ? file : toJpeg(img, 1);
    return toJpeg(img, scale);
  }
  function toJpeg(img, scale) {
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('image')), 'image/jpeg', 0.88));
  }

  async function listSavedFiles() {
    const { data } = await sb.storage.from(BUCKET).list(S.promo.id, { limit: 100, sortBy: { column: 'name', order: 'desc' } });
    const box = el('offerSaved'); if (!box || !data?.length) return;
    box.innerHTML = `<h4>Offer files saved with this promotion</h4><ul class="offer-file-list">${data.map(o => `<li><span>${esc(o.name.replace(/^\d+-/, ''))}</span><button class="link-btn" data-open="${esc(o.name)}">Open</button></li>`).join('')}</ul>`;
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
      const { data: u, error } = await sb.storage.from(BUCKET).createSignedUrl(`${S.promo.id}/${b.dataset.open}`, 600);
      if (error) return showToast(friendlyError(error), true);
      window.open(u.signedUrl, '_blank', 'noopener');
    });
  }

  /* ---------------- extract (edge function) ---------------- */
  async function extract() {
    const total = S.files.reduce((n, f) => n + f.b64.length, 0);
    if (total > MAX_TOTAL_B64) { showToast('The files are too large together. Send fewer or smaller files at a time.', true); return; }
    S.busy = true;
    el('offerBody').innerHTML = `<div class="offer-wait"><div class="offer-spinner"></div><p><b>Reading ${S.files.length} file${S.files.length === 1 ? '' : 's'}…</b></p><p class="muted-note">This usually takes under a minute; long price lists can take a few minutes.</p></div>`;
    try {
      const { data, error } = await sb.functions.invoke('extract-offer', {
        body: { files: S.files.map(f => ({ name: f.name, media_type: f.type, data: f.b64 })) },
      });
      if (error) {
        let msg = error.message;
        try { const b = await error.context.json(); if (b?.error) msg = b.error; } catch (e) { /* not JSON */ }
        if (error.context?.status === 404) msg = 'The offer reader is not set up yet (the extract-offer function is not deployed).';
        throw new Error(msg);
      }
      S.lines = (data.lines || []).map(l => prepareLine(l));
      logActivity('promotions', 'offer_extract', { type: 'promotion', id: S.promo.id },
        `Read ${S.files.length} offer file${S.files.length === 1 ? '' : 's'}: ${S.lines.length} lines`,
        { files: S.files.map(f => f.name), lines: S.lines.length, model: data.model, usage: data.usage });
      if (!S.lines.length) { showToast('No offer lines were found in these files.', true); renderPick(); return; }
      S.view = 0;
      renderReview();
    } catch (e) {
      showToast(e.message || 'Could not read the offers.', true);
      renderPick();
    } finally { S.busy = false; }
  }

  /* ---------------- matching ---------------- */
  const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(w => w.length >= 2);
  function similarity(a, b) {
    const A = new Set(words(a)), B = new Set(words(b));
    if (!A.size || !B.size) return 0;
    let common = 0; A.forEach(w => { if (B.has(w)) common++; });
    return (2 * common) / (A.size + B.size);
  }
  // Barcode -> item code; else the supplier code if it is a catalog code; else top 3 by description.
  function matchLine(l) {
    l.suggestions = [];
    if (l.barcode && catalogBarcodeMap.has(l.barcode)) { const it = catalogBarcodeMap.get(l.barcode); return Object.assign(l, { code: it.code, match: 'barcode', catalogDesc: it.description }); }
    if (l.supplier_code && catalogMap.has(normalizeCatalogCode(l.supplier_code))) {
      const it = catalogMap.get(normalizeCatalogCode(l.supplier_code));
      return Object.assign(l, { code: it.code, match: 'code', catalogDesc: it.description });
    }
    l.suggestions = catalogItems.map(it => ({ code: it.code, description: it.description, score: similarity(l.description, it.description) }))
      .filter(x => x.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, 3);
    return Object.assign(l, { code: l.code || '', match: l.code ? 'manual' : 'none', catalogDesc: '' });
  }
  function prepareLine(l) {
    return matchLine({ ...l, accept: true, code: '' });
  }
  function checks(l) {
    const c = [];
    if (l.barcode && !isValidBarcode(l.barcode)) c.push('Barcode check digit fails (likely misread)');
    if (l.confidence < LOW_CONFIDENCE) c.push(`Low confidence (${Math.round(l.confidence * 100)}%)`);
    if (!l.code) c.push('Not matched to an item code');
    if (l.promo_price === null && l.discount_pct === null) c.push('No promo price or discount');
    return c;
  }

  /* ---------------- step 2: review ---------------- */
  function renderReview() {
    const accepted = S.lines.filter(l => l.accept).length;
    const flagged = S.lines.filter(l => checks(l).length).length;
    el('offerSub').textContent = `${S.lines.length} lines read from ${S.files.length} file${S.files.length === 1 ? '' : 's'} · ${accepted} to add · ${flagged} to check`;
    const f = S.files[S.view];
    el('offerBody').innerHTML = `
      <div class="offer-review">
        <div class="offer-preview">
          <div class="filter-row offer-file-tabs">${S.files.map((x, i) => `<button class="${i === S.view ? 'active' : ''}" data-view="${i}">File ${i + 1}</button>`).join('')}</div>
          <div class="offer-preview-frame" id="offerPreview">${f.type === 'application/pdf'
            ? `<iframe src="${f.url}#page=${S.page || 1}" title="${esc(f.name)}"></iframe>`
            : `<img src="${f.url}" alt="${esc(f.name)}">`}</div>
          <p class="muted-note">${esc(f.name)}</p>
        </div>
        <div class="offer-lines">
          <div class="offer-toolbar">
            <label class="offer-check-all"><input type="checkbox" id="offerAll" ${accepted === S.lines.length ? 'checked' : ''}> Add all</label>
            <span class="offer-legend"><i class="lv-bad"></i> barcode misread / not matched <i class="lv-low"></i> low confidence</span>
            <span class="spacer"></span>
            <button class="btn secondary small" id="offerExport">Export to Excel</button>
            <button class="btn small" id="offerAdd" ${accepted ? '' : 'disabled'}>Add ${accepted} to promotion</button>
          </div>
          <div class="items-scroll offer-table-wrap">
            <table class="items offer-table">
              <thead><tr><th></th><th>Item code</th><th>Barcode</th><th>Supplier code</th><th>Description</th><th class="num">Old price</th><th class="num">Promo price</th><th class="num">Disc. %</th><th>Pack</th><th>Check</th><th>From</th></tr></thead>
              <tbody>${S.lines.map(rowHtml).join('')}</tbody>
            </table>
          </div>
        </div>
      </div>`;
    wireReview();
  }
  function rowHtml(l, i) {
    const c = checks(l);
    const badBarcode = l.barcode && !isValidBarcode(l.barcode);
    const cls = [!l.accept && 'is-skipped', (badBarcode || !l.code) && 'lv-bad', l.confidence < LOW_CONFIDENCE && 'lv-low'].filter(Boolean).join(' ');
    const matchNote = l.match === 'barcode' ? 'by barcode' : l.match === 'code' ? 'by code' : l.match === 'picked' ? 'picked' : '';
    return `<tr data-i="${i}" class="${cls}">
      <td><input type="checkbox" data-f="accept" ${l.accept ? 'checked' : ''} title="Add this line"></td>
      <td class="offer-code-cell">
        <input type="text" data-f="code" value="${esc(l.code)}" placeholder="Item code" spellcheck="false">
        ${matchNote ? `<small class="muted-note">${matchNote}${l.catalogDesc ? ' · ' + esc(l.catalogDesc) : ''}</small>` : ''}
        ${!l.code && l.suggestions.length ? `<div class="offer-suggest">${l.suggestions.map(s => `<button type="button" class="link-btn" data-pick="${esc(s.code)}" title="${esc(s.description)}">${esc(s.code)} · ${esc(s.description.slice(0, 28))} (${Math.round(s.score * 100)}%)</button>`).join('')}</div>` : ''}
      </td>
      <td><input type="text" data-f="barcode" value="${esc(l.barcode || '')}" class="${badBarcode ? 'cell-missing' : ''}" inputmode="numeric" spellcheck="false"></td>
      <td><input type="text" data-f="supplier_code" value="${esc(l.supplier_code || '')}" spellcheck="false"></td>
      <td><input type="text" data-f="description" value="${esc(l.description)}"></td>
      <td class="num"><input type="text" data-f="old_price" value="${n2(l.old_price)}" inputmode="decimal"></td>
      <td class="num"><input type="text" data-f="promo_price" value="${n2(l.promo_price)}" inputmode="decimal"></td>
      <td class="num"><input type="text" data-f="discount_pct" value="${n2(l.discount_pct)}" inputmode="decimal"></td>
      <td><input type="text" data-f="pack_note" value="${esc(l.pack_note || '')}"></td>
      <td class="offer-checks">${c.length ? `<span class="big-discount-dot" title="${esc(c.join(' · '))}"></span> <small>${esc(c[0])}${c.length > 1 ? ` +${c.length - 1}` : ''}</small>` : '<span class="badge active">OK</span>'}</td>
      <td><button class="link-btn" data-src="${i}">${l.source_file ? `F${l.source_file}${l.source_page ? ' p' + l.source_page : ''}` : '—'}</button></td>
    </tr>`;
  }
  function wireReview() {
    el('offerBody').querySelectorAll('[data-view]').forEach(b => b.onclick = () => { S.view = +b.dataset.view; S.page = 1; renderReview(); });
    el('offerAll').onchange = e => { S.lines.forEach(l => { l.accept = e.target.checked; }); renderReview(); };
    const tbody = el('offerBody').querySelector('.offer-table tbody');
    tbody.addEventListener('change', e => {
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const l = S.lines[+tr.dataset.i], f = e.target.dataset.f;
      if (f === 'accept') l.accept = e.target.checked;
      else if (['old_price', 'promo_price', 'discount_pct'].includes(f)) l[f] = parseNum(e.target.value);
      else if (f === 'barcode') { l.barcode = e.target.value.replace(/\D/g, '') || null; if (!l.code || l.match === 'barcode') { l.code = ''; matchLine(l); } }
      else if (f === 'code') { l.code = e.target.value.trim(); l.match = l.code ? 'manual' : 'none'; if (!l.code) matchLine(l); }
      else l[f] = e.target.value.trim() || (f === 'description' ? '' : null);
      renderReview();
    });
    tbody.addEventListener('click', e => {
      const pick = e.target.closest('[data-pick]');
      if (pick) { const l = S.lines[+pick.closest('tr').dataset.i]; l.code = pick.dataset.pick; l.match = 'picked'; renderReview(); return; }
      const src = e.target.closest('[data-src]');
      if (src) { const l = S.lines[+src.dataset.src]; if (l.source_file) { S.view = Math.min(S.files.length, l.source_file) - 1; S.page = l.source_page || 1; renderReview(); } }
    });
    el('offerExport').onclick = () => exportExcel(S.lines, `${S.promo.name || 'offer'} - offer lines.xlsx`);
    el('offerAdd').onclick = addToPromotion;
  }

  /* ---------------- export (re-imports through "Import price sheet") ---------------- */
  const HEADERS = ['Itemcode', 'Barcode', 'Description', 'Old Price', 'Promo Price', 'Discount', 'Cost', 'Check'];
  function buildSheet(lines) {
    const aoa = [HEADERS, ...lines.map(l => [l.code || l.supplier_code || '', l.barcode || '', l.description, l.old_price, l.promo_price, l.discount_pct,
      l.pack_note ? l.pack_note : null, checks(l).join('; ')])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Codes and barcodes as text so leading zeros survive.
    for (let r = 1; r < aoa.length; r++) [0, 1].forEach(c => {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (ws[ref]) { ws[ref].t = 's'; ws[ref].v = String(aoa[r][c]); ws[ref].w = String(aoa[r][c]); }
    });
    ws['!cols'] = [{ wch: 12 }, { wch: 15 }, { wch: 44 }, { wch: 10 }, { wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Offer');
    return wb;
  }
  function exportExcel(lines, name) {
    XLSX.writeFile(buildSheet(lines.filter(l => l.accept)), name.replace(/[\\/:*?"<>|]+/g, ' '));
  }

  /* ---------------- add to promotion ---------------- */
  function askAppendOrReplace() {
    return new Promise(resolve => {
      const box = document.createElement('div');
      box.className = 'offer-choice';
      box.innerHTML = `<div class="modal-box"><p>Add the lines to the ${currentRows.length} row${currentRows.length === 1 ? '' : 's'} already in this promotion, or replace them?</p>
        <div class="modal-actions"><button class="btn ghost small" data-c="">Cancel</button><button class="btn secondary small" data-c="replace">Replace the table</button><button class="btn small" data-c="append">Add to the table</button></div></div>`;
      el('offerOverlay').appendChild(box);
      box.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; box.remove(); resolve(b.dataset.c || null); };
    });
  }

  async function addToPromotion() {
    const lines = S.lines.filter(l => l.accept);
    if (!lines.length) return;
    const mode = currentRows.length ? await askAppendOrReplace() : 'replace';
    if (!mode) return;
    // Same path as "Import price sheet": catalog lookup, discount rules and flags all apply.
    const buf = XLSX.write(buildSheet(lines), { type: 'array', bookType: 'xlsx' });
    const result = parsePriceSheetRows(buf);
    if (result.error) { showToast(result.error, true); return; }
    const promo = S.promo;
    if (mode === 'replace') {
      currentRows = result.rows;
      selectedRowIds.clear();
      renumberRows();
      await renderPromoWorkspace();
      await replaceAllPromoRows(promo.id, currentRows);
    } else {
      currentRows.push(...result.rows);
      const moved = renumberRows();
      await renderPromoWorkspace();
      await persistRowsBulk(withMoved(result.rows, moved));
    }
    const saved = await saveFiles(promo.id);
    logActivity('promotions', 'offer_import', { type: 'promotion', id: promo.id },
      `${mode === 'replace' ? 'Replaced the table with' : 'Added'} ${result.rows.length} rows from ${S.files.length} offer file${S.files.length === 1 ? '' : 's'}`,
      { mode, rows: result.rows.length, lines: lines.length, files: S.files.map(f => f.name), saved });
    S.lines = [];
    await close();
    await renderPromoWorkspace();
    showToast(`${result.rows.length} row${result.rows.length === 1 ? '' : 's'} ${mode === 'replace' ? 'now in' : 'added to'} the promotion${saved ? `; ${saved} offer file${saved === 1 ? '' : 's'} saved with it` : ''}.`);
  }
  async function saveFiles(promoId) {
    let n = 0;
    for (const f of S.files) {
      const path = `${promoId}/${Date.now()}-${f.name.replace(/[^\w.\- ]+/g, '_')}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, f.original, { contentType: f.original.type || f.type, upsert: false });
      if (error) console.warn('Offer file not saved', f.name, error); else n++;
    }
    return n;
  }

  window.OfferImport = {
    open(promo) {
      if (!isAdmin()) return;
      ensureModal();
      Object.assign(S, { promo, files: [], lines: [], view: 0 });
      el('offerOverlay').classList.add('open');
      renderPick();
    },
    _state: S, _checks: checks, _matchLine: matchLine, _buildSheet: buildSheet,
  };
})();
