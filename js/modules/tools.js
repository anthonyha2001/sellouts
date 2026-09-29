/* ============================================================
   Tools › PDF / photo to Excel (PLAN §10d). Everything runs in this
   browser: files never leave the device.
   - Digital PDFs: the text and its position are read from the PDF
     (pdf.js), so the result is exact.
   - Photos and scanned PDF pages: OCR (Tesseract.js); words the OCR is
     unsure about are highlighted so they can be checked.
   Rows and columns are rebuilt from where the words sit on the page.
   The result can be edited (cells, delete row / column, merge a row
   into the one above) and downloaded as .xlsx (SheetJS, already loaded).
   Libraries come from jsDelivr, only when the page is first used.
   Permission: tools.convert. Public API: window.Tools = { show }.
   ============================================================ */
(function () {
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const LOW_CONFIDENCE = 70;          // OCR words below this are highlighted
  const panel = document.getElementById('panel-tools');
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const S = { started: false, busy: false, tables: [], active: 0, base: 'converted', ocr: null, ocrLang: null };

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="card tool-card">
        <p class="muted-note" style="margin:0 0 14px;">Price lists, invoices, statements… Everything happens on this device — the file is not uploaded anywhere.</p>
        <label class="tool-drop" id="toolDrop">
          <input type="file" id="toolFile" accept="application/pdf,image/*" multiple>
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
          <b>Choose a PDF or photos</b><span>or drop them here · several photos = several pages</span>
        </label>
        <div class="tool-options">
          <label>Text in photos / scans
            <select id="toolLang">
              <option value="eng">English</option>
              <option value="eng+fra">English + French</option>
              <option value="ara+eng">Arabic + English</option>
            </select></label>
          <label class="tool-check"><input type="checkbox" id="toolSheets"> Each page on its own sheet</label>
          <label class="tool-check"><input type="checkbox" id="toolForceOcr"> Read PDFs as images (for scanned PDFs)</label>
        </div>
        <p class="muted-note" style="margin:10px 0 0;">Tips for photos: flat page, good light, straight on, the table filling the picture.</p>
      </div>
      <div id="toolProgress"></div>
      <div id="toolResult"></div>`;
    const file = el('toolFile'), drop = el('toolDrop');
    file.onchange = () => { if (file.files.length) convert([...file.files]); file.value = ''; };
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) convert(f); });
    el('toolSheets').onchange = renderResult;
  }

  /* ---------------- libraries (loaded on first use) ---------------- */
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) pdfjsPromise = import(PDFJS).then(m => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return m; })
      .catch(e => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }
  let tessPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (!tessPromise) tessPromise = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = TESSERACT;
      s.onload = () => res(window.Tesseract); s.onerror = () => { tessPromise = null; rej(new Error('Could not load the text reader (check the connection).')); };
      document.head.appendChild(s);
    });
    return tessPromise;
  }
  async function ocrWorker(lang, onProgress) {
    if (S.ocr && S.ocrLang === lang) { S.onProgress = onProgress; return S.ocr; }
    if (S.ocr) { await S.ocr.terminate(); S.ocr = null; }
    const T = await loadTesseract();
    S.onProgress = onProgress;
    S.ocr = await T.createWorker(lang, 1, { logger: m => S.onProgress && S.onProgress(m) });
    // Page = one block of text: keeps a table row together across its columns (the automatic
    // layout would read each column as its own block).
    await S.ocr.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    S.ocrLang = lang;
    return S.ocr;
  }

  /* ---------------- converting ---------------- */
  function progress(html) { el('toolProgress').innerHTML = html ? `<div class="card tool-progress">${html}</div>` : ''; }
  const bar = (label, frac) => `<div class="tool-bar-label">${esc(label)}</div><div class="tool-bar"><i style="width:${Math.round((frac || 0) * 100)}%"></i></div>`;

  async function convert(files) {
    if (S.busy) return showToast('Still working on the previous file…', true);
    S.busy = true;
    S.tables = []; S.active = 0;
    S.base = files[0].name.replace(/\.[^.]+$/, '') || 'converted';
    el('toolResult').innerHTML = '';
    const lang = el('toolLang').value, forceOcr = el('toolForceOcr').checked;
    try {
      let n = 0;
      for (const f of files) {
        n++;
        const label = files.length > 1 ? `${f.name} (${n} of ${files.length})` : f.name;
        if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) await convertPdf(f, label, lang, forceOcr);
        else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|heic)$/i.test(f.name)) await convertImage(f, label, lang);
        else showToast(`${f.name}: not a PDF or a photo — skipped.`, true);
      }
      progress('');
      if (!S.tables.length) return showToast('No table text found in that file.', true);
      const ocrPages = S.tables.filter(t => t.ocr).length;
      logActivity('tools', 'convert', { type: 'file', id: null }, `Converted ${files.map(f => f.name).join(', ')} to Excel (${S.tables.length} page${S.tables.length === 1 ? '' : 's'})`, { pages: S.tables.length, ocr_pages: ocrPages });
      renderResult();
    } catch (e) {
      console.error(e);
      progress('');
      showToast('Could not convert that file — ' + (e.message || e), true);
    } finally { S.busy = false; }
  }

  async function convertPdf(file, label, lang, forceOcr) {
    progress(bar(`Opening ${label}…`, 0));
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      let words = [];
      if (!forceOcr) {
        progress(bar(`${label} — reading page ${p} of ${doc.numPages}`, (p - 1) / doc.numPages));
        const tc = await page.getTextContent();
        words = tc.items.filter(it => it.str && it.str.trim()).map(it => {
          const h = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
          const x = it.transform[4], y = vp.height - it.transform[5];
          return { t: it.str.trim(), x0: x, x1: x + (it.width || h * it.str.length * 0.5), y0: y - h, y1: y, conf: 100 };
        });
      }
      let ocr = false, canvas = null;
      if (words.length < 3) {        // no text layer: a scanned page
        ocr = true;
        canvas = document.createElement('canvas');
        const view = page.getViewport({ scale: Math.min(3, 2400 / vp.width) });
        canvas.width = view.width; canvas.height = view.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: view }).promise;
        words = await ocrCanvas(canvas, `${label} — reading page ${p} of ${doc.numPages} (scan)`, lang);
      }
      const rows = toTable(words);
      if (rows.length) S.tables.push({ name: doc.numPages > 1 ? `Page ${p}` : trimName(label), rows, ocr, canvas, lang });
    }
  }

  async function convertImage(file, label, lang) {
    progress(bar(`Opening ${label}…`, 0));
    const canvas = await imageToCanvas(file);
    const words = await ocrCanvas(canvas, `${label} — reading the text`, lang);
    const rows = toTable(words);
    if (rows.length) S.tables.push({ name: trimName(label), rows, ocr: true, canvas, lang });
  }
  const trimName = s => s.replace(/\s*\(\d+ of \d+\)$/, '').replace(/\.[^.]+$/, '').slice(0, 28);

  // Photos: upright (EXIF), about 2400–3200 px wide so small print (decimal points!) is readable.
  async function imageToCanvas(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { throw new Error(`${file.name}: this image format can't be read here — save it as JPG or PNG.`); }
    const scale = Math.min(3, Math.max(1, 2400 / bmp.width), 3200 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  function rotateCanvas(src) {
    const c = document.createElement('canvas'); c.width = src.height; c.height = src.width;
    const g = c.getContext('2d'); g.translate(c.width, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0);
    return c;
  }

  async function ocrCanvas(canvas, label, lang) {
    const worker = await ocrWorker(lang, m => {
      const what = /load|init/i.test(m.status) ? 'getting the text reader ready (first time only)' : 'reading';
      progress(bar(`${label} · ${what}`, m.progress));
    });
    const { data } = await worker.recognize(canvas);
    let words = data.words, lines = data.lines;
    if (!words || !words.length) words = (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => l.words || [])));
    if (!lines || !lines.length) lines = (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
    // A photo is rarely straight: measure the tilt of the text lines and straighten the word
    // positions, so a row stays one row from its first column to its last.
    const angles = (lines || []).map(l => l.baseline).filter(b => b && b.x1 - b.x0 > canvas.width * 0.15)
      .map(b => Math.atan2(b.y1 - b.y0, b.x1 - b.x0)).sort((a, b) => a - b);
    const tilt = angles.length ? Math.tan(angles[Math.floor(angles.length / 2)]) : 0;
    return (words || []).filter(w => w.text && w.text.trim()).map(w => {
      const dy = tilt * (w.bbox.x0 + w.bbox.x1) / 2;
      return { t: w.text.trim(), x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0 - dy, y1: w.bbox.y1 - dy, conf: w.confidence };
    });
  }

  /* ---------------- words -> rows and columns ---------------- */
  // Exposed for tests as Tools._toTable. Returns [[{t, low}]] (low = OCR unsure).
  function toTable(words) {
    words = words.filter(w => w.t && w.x1 > w.x0);
    if (!words.length) return [];
    const hs = words.map(w => w.y1 - w.y0).sort((a, b) => a - b);
    const h = hs[Math.floor(hs.length / 2)] || 10;
    // 1. lines: words whose middles are at the same height
    const mid = w => (w.y0 + w.y1) / 2;
    const lines = [];
    words.slice().sort((a, b) => mid(a) - mid(b)).forEach(w => {
      const L = lines[lines.length - 1];
      if (L && Math.abs(mid(w) - L.cy) < h * 0.55) { L.words.push(w); L.cy += (mid(w) - L.cy) / L.words.length; }
      else lines.push({ cy: mid(w), words: [w] });
    });
    // 2. cells: words close together on a line (a gap of about one space) belong to one cell
    const gapMax = h * 0.85;
    lines.forEach(L => {
      L.words.sort((a, b) => a.x0 - b.x0);
      L.cells = [];
      L.words.forEach(w => {
        const c = L.cells[L.cells.length - 1];
        if (c && w.x0 - c.x1 < gapMax) { c.t += ' ' + w.t; c.x1 = Math.max(c.x1, w.x1); c.low = c.low || w.conf < LOW_CONFIDENCE; }
        else L.cells.push({ t: w.t, x0: w.x0, x1: w.x1, low: w.conf < LOW_CONFIDENCE });
      });
    });
    // 3. columns: where cells line up across the lines that look like table rows (2+ cells);
    //    a title spanning the page does not merge the columns.
    const tableLines = lines.filter(L => L.cells.length >= 2);
    const src = (tableLines.length ? tableLines : lines).flatMap(L => L.cells.map(c => [c.x0, c.x1])).sort((a, b) => a[0] - b[0]);
    const cols = [];
    src.forEach(([a, b]) => { const c = cols[cols.length - 1]; if (c && a <= c[1] + h * 0.25) c[1] = Math.max(c[1], b); else cols.push([a, b]); });
    const colOf = c => {
      const m = (c.x0 + c.x1) / 2;
      let best = 0, bd = Infinity;
      cols.forEach(([a, b], i) => { const d = m < a ? a - m : m > b ? m - b : 0; if (d < bd) { bd = d; best = i; } });
      return best;
    };
    // 4. rows
    const rows = lines.map(L => {
      const row = cols.map(() => ({ t: '', low: false }));
      L.cells.forEach(c => { const i = colOf(c); row[i].t = row[i].t ? row[i].t + ' ' + c.t : c.t; row[i].low = row[i].low || c.low; });
      return row;
    });
    // 5. a right-aligned column's heading sits left of its numbers and becomes a column of its own:
    //    join two neighbouring columns when they never both have text on a row and one of them is
    //    almost empty (a heading). Two full columns (Debit / Credit) are kept apart.
    const filled = i => rows.filter(r => r[i].t.trim()).length;
    for (let i = 0; i < rows[0]?.length - 1; ) {
      const clash = rows.some(r => r[i].t.trim() && r[i + 1].t.trim());
      if (!clash && Math.min(filled(i), filled(i + 1)) <= Math.max(2, rows.length * 0.1)) {
        rows.forEach(r => { if (!r[i].t.trim()) r[i] = r[i + 1]; r.splice(i + 1, 1); });
      } else i++;
    }
    return rows;
  }

  /* ---------------- result: preview, edit, download ---------------- */
  const tidy = rows => {
    // drop empty rows / columns
    rows = rows.filter(r => r.some(c => c.t.trim()));
    const n = Math.max(0, ...rows.map(r => r.length));
    const keep = [...Array(n).keys()].filter(i => rows.some(r => (r[i]?.t || '').trim()));
    return rows.map(r => keep.map(i => r[i] || { t: '', low: false }));
  };

  function sheetsToExport() {
    const perPage = el('toolSheets').checked;
    const tables = S.tables.map(t => ({ name: t.name, rows: tidy(t.rows) })).filter(t => t.rows.length);
    if (perPage || tables.length === 1) return tables;
    // One sheet: pages one after another; the title / header lines repeated at the top of each page
    // (the same as one of the first page's first rows) are kept only once.
    const key = r => r.map(c => c.t.trim()).join('|');
    const top = new Set(tables[0].rows.slice(0, 5).map(key));
    const rows = tables.flatMap((t, i) => {
      if (!i) return t.rows;
      let k = 0;
      while (k < t.rows.length && k < 5 && top.has(key(t.rows[k]))) k++;
      return t.rows.slice(k);
    });
    return [{ name: 'Sheet1', rows }];
  }

  function renderResult() {
    const box = el('toolResult');
    if (!S.tables.length) { box.innerHTML = ''; return; }
    const t = S.tables[S.active];
    t.rows = tidy(t.rows);
    const lows = t.rows.reduce((n, r) => n + r.filter(c => c.low).length, 0);
    const ncol = Math.max(0, ...t.rows.map(r => r.length));
    box.innerHTML = `
      <div class="card">
        <div class="tool-result-head">
          <div>
            <h3 style="margin:0;">${esc(S.base)}.xlsx</h3>
            <span class="muted-note">${S.tables.length} page${S.tables.length === 1 ? '' : 's'} · ${t.rows.length} rows × ${ncol} columns on this page${t.ocr ? ' · read from an image' : ''}</span>
          </div>
          <div class="tool-actions">
            ${t.ocr && t.canvas ? '<button class="btn ghost small" id="toolRotate" title="Turn the photo a quarter and read it again">Rotate &amp; re-read</button>' : ''}
            <button class="btn secondary small" id="toolCopy">Copy</button>
            <button class="btn small" id="toolDownload">Download Excel</button>
          </div>
        </div>
        ${S.tables.length > 1 ? `<div class="filter-row" id="toolTabs" style="margin:12px 0 0;">${S.tables.map((x, i) => `<button data-i="${i}" class="${i === S.active ? 'active' : ''}">${esc(x.name)}</button>`).join('')}</div>` : ''}
        ${lows ? `<p class="tool-warn"><span class="tool-low-sample"></span> ${lows} cell${lows === 1 ? '' : 's'} the reader was not sure about — check them against the original.</p>` : ''}
        <p class="muted-note" style="margin:10px 0 8px;">Click a cell to correct it. <b>×</b> removes a row or column, <b>↑</b> joins a row to the one above (for text that wrapped onto two lines).</p>
        <div class="items-scroll tool-grid-wrap">
          <table class="items tool-grid">
            <thead><tr><th></th>${[...Array(ncol).keys()].map(i => `<th><button class="tool-x" data-delcol="${i}" title="Remove this column">×</button> ${colName(i)}</th>`).join('')}</tr></thead>
            <tbody>${t.rows.map((r, ri) => `<tr>
              <td class="tool-rowbtns"><button class="tool-x" data-delrow="${ri}" title="Remove this row">×</button>${ri ? `<button class="tool-x" data-mergerow="${ri}" title="Join to the row above">↑</button>` : ''}</td>
              ${r.map((c, ci) => `<td contenteditable="true" spellcheck="false" data-r="${ri}" data-c="${ci}" class="${c.low ? 'tool-low' : ''}">${esc(c.t)}</td>`).join('')}
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
    el('toolTabs')?.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { S.active = Number(b.dataset.i); renderResult(); } });
    el('toolDownload').onclick = download;
    el('toolCopy').onclick = copyTable;
    el('toolRotate')?.addEventListener('click', rotateAndReread);
    const grid = box.querySelector('.tool-grid');
    grid.addEventListener('input', e => {
      const td = e.target.closest('td[data-r]'); if (!td) return;
      const c = t.rows[td.dataset.r][td.dataset.c];
      c.t = td.textContent; c.low = false; td.classList.remove('tool-low');
    });
    grid.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.delrow !== undefined) t.rows.splice(Number(b.dataset.delrow), 1);
      else if (b.dataset.delcol !== undefined) t.rows.forEach(r => r.splice(Number(b.dataset.delcol), 1));
      else if (b.dataset.mergerow !== undefined) {
        const i = Number(b.dataset.mergerow), up = t.rows[i - 1];
        t.rows[i].forEach((c, ci) => { if (!c.t.trim()) return; up[ci].t = up[ci].t.trim() ? up[ci].t + ' ' + c.t : c.t; up[ci].low = up[ci].low || c.low; });
        t.rows.splice(i, 1);
      } else return;
      renderResult();
    });
  }
  const colName = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  async function rotateAndReread() {
    const t = S.tables[S.active];
    if (S.busy || !t.canvas) return;
    S.busy = true;
    try {
      t.canvas = rotateCanvas(t.canvas);
      const words = await ocrCanvas(t.canvas, `${t.name} — reading again`, t.lang);
      progress('');
      t.rows = toTable(words);
      if (!t.rows.length) showToast('No text found after turning it either.', true);
      renderResult();
    } catch (e) { progress(''); showToast('Could not read it again — ' + (e.message || e), true); }
    finally { S.busy = false; }
  }

  // "1,234.50" → 1234.5, "(12.00)" → -12, "12 %" stays text; leading zeros (barcodes, codes) stay text.
  function cellValue(s) {
    const v = String(s).trim();
    if (!v) return '';
    const neg = /^\(.*\)$/.test(v);
    const core = v.replace(/^\(|\)$/g, '').replace(/^[$€£]|\s*(USD|LBP|\$)$/i, '').trim();
    if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(core) && !/^-?0\d/.test(core) && core.replace(/\D/g, '').length <= 15) {
      const n = Number(core.replace(/,/g, ''));
      return neg ? -n : n;
    }
    return v;
  }

  function download() {
    const sheets = sheetsToExport();
    if (!sheets.length) return showToast('Nothing to export.', true);
    const wb = XLSX.utils.book_new();
    const used = new Set();
    sheets.forEach(sh => {
      let name = (sh.name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet';
      for (let k = 2; used.has(name); k++) name = `${name.slice(0, 28)} ${k}`;
      used.add(name);
      const aoa = sh.rows.map(r => r.map(c => cellValue(c.t)));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = (aoa[0] || []).map((_, i) => ({ wch: Math.min(60, Math.max(8, ...aoa.map(r => String(r[i] ?? '').length + 2))) }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    XLSX.writeFile(wb, `${S.base}.xlsx`);
    logActivity('tools', 'download', { type: 'file', id: null }, `Downloaded ${S.base}.xlsx (${sheets.length} sheet${sheets.length === 1 ? '' : 's'})`);
  }

  async function copyTable() {
    const t = S.tables[S.active];
    const text = tidy(t.rows).map(r => r.map(c => c.t.replace(/\s+/g, ' ').trim()).join('\t')).join('\n');
    const ok = await copyTextToClipboard(text);
    showToast(ok ? 'Copied — paste it into Excel.' : 'Could not copy — your browser blocked clipboard access.', !ok);
  }

  window.Tools = {
    show() {
      if (!can('tools.convert')) return;
      if (!S.started) { S.started = true; shell(); }
    },
    _toTable: toTable, _cellValue: cellValue, _state: S, _convert: convert,
  };
})();
