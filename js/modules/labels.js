/* ============================================================
   Shelf labels (PLAN §10b, Phase 7).
   Shelf worker (and admin): "My list" — scan items that need a new
   shelf label (camera, continuous), adjust quantities, then Done
   sends the list to the accountant.
   Accountant (and admin): "To print" — submitted lists, merged per
   barcode; Export to Excel (ItemCode, Qty) and the page empties
   (lists are marked exported, never deleted).
   Public API: window.Labels = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-labels');
  const S = { tab: null, list: null, items: [], started: false, queue: Promise.resolve(), toPrint: [] };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const fail = (what, error) => { console.error(error); showToast(`${what} — ${friendlyError(error)}`, true); };
  const canScan = () => ['shelf', 'admin'].includes(Session.role);
  const canPrint = () => ['accountant', 'admin'].includes(Session.role);
  const cleanCode = v => String(v ?? '').trim().replace(/\s+/g, '');
  const validCode = v => /^[0-9A-Za-z.\-]{1,64}$/.test(v);

  /* ---------------- shell ---------------- */
  function shell() {
    const tabs = [canScan() && ['mine', 'My list'], canPrint() && ['print', 'To print']].filter(Boolean);
    S.tab = S.tab || tabs[0][0];
    panel.innerHTML = `${tabs.length > 1 ? `<div class="filter-row" id="lbTabs">${tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</div>` : ''}<div id="lbBody"></div>`;
    el('lbTabs')?.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; show(); } });
  }
  async function show() {
    if (!S.started) { S.started = true; shell(); }
    panel.querySelectorAll('#lbTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    if (S.tab === 'mine') { Scanner.warmUp(); await loadMine(); renderMine(); }
    else { await loadToPrint(); renderToPrint(); }
  }

  /* ================= My list (scanning) ================= */
  async function loadMine() {
    const { data, error } = await sb.from('label_lists').select('*').eq('created_by', Session.user.id).is('submitted_at', null).maybeSingle();
    if (error) return fail('Could not load your list', error);
    S.list = data;
    S.items = [];
    if (data) {
      const { data: items, error: e2 } = await sb.from('label_items').select('*').eq('list_id', data.id).order('scanned_at', { ascending: false });
      if (e2) return fail('Could not load your list', e2);
      S.items = items;
    }
  }
  async function ensureList() {
    if (S.list) return S.list;
    const { data, error } = await sb.from('label_lists').insert({}).select().single();
    if (error) {
      // Another device of the same person may have opened one a moment ago: use that one.
      await loadMine();
      if (S.list) return S.list;
      throw error;
    }
    S.list = data;
    return data;
  }
  // Saves run one after another, so fast scanning never races itself.
  function enqueue(fn) { S.queue = S.queue.then(fn, fn); return S.queue; }

  function addCode(raw, fromScanner) {
    const code = cleanCode(raw);
    if (!code) return null;
    if (!validCode(code)) { showToast('That is not a barcode.', true); return null; }
    let it = S.items.find(x => x.barcode === code);
    if (it) { it.qty = Math.min(9999, it.qty + 1); S.items = [it, ...S.items.filter(x => x !== it)]; }
    else { it = { id: null, barcode: code, qty: 1 }; S.items.unshift(it); }
    renderMine(code);
    enqueue(() => saveItem(it));
    return `<span class="scan-ok">✓</span> <span class="scan-code">${esc(code)}</span> <b>× ${it.qty}</b>${fromScanner ? ` <span class="scan-count">${S.items.length} item${S.items.length === 1 ? '' : 's'}</span>` : ''}`;
  }
  async function saveItem(it) {
    try {
      const list = await ensureList();
      const { data, error } = await sb.from('label_items')
        .upsert({ list_id: list.id, barcode: it.barcode, qty: it.qty }, { onConflict: 'list_id,barcode' }).select().single();
      if (error) throw error;
      it.id = data.id;
    } catch (e) { fail(`Could not save ${it.barcode}`, e); }
  }
  async function setQty(code, qty) {
    const it = S.items.find(x => x.barcode === code); if (!it) return;
    if (qty <= 0) return removeCode(code);
    it.qty = Math.min(9999, qty);
    renderMine();
    enqueue(() => saveItem(it));
  }
  async function removeCode(code) {
    const it = S.items.find(x => x.barcode === code); if (!it) return;
    S.items = S.items.filter(x => x !== it);
    renderMine();
    if (S.list) enqueue(async () => {
      const { error } = await sb.from('label_items').delete().eq('list_id', S.list.id).eq('barcode', code);
      if (error) fail(`Could not remove ${code}`, error);
    });
  }

  function renderMine(flash) {
    const body = el('lbBody'); if (!body) return;
    const labels = S.items.reduce((n, x) => n + x.qty, 0);
    body.innerHTML = `
      <div class="card lb-scan-card">
        <button type="button" class="btn lb-scan-btn" id="lbScan">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>
          Scan</button>
        <form class="lb-manual" id="lbManual" autocomplete="off">
          <input type="text" id="lbCode" inputmode="numeric" placeholder="Or type a barcode" spellcheck="false">
          <button class="btn secondary small" type="submit">Add</button>
        </form>
      </div>
      <div class="lb-summary"><b>${S.items.length}</b> item${S.items.length === 1 ? '' : 's'} · <b>${labels}</b> label${labels === 1 ? '' : 's'}</div>
      <div class="lb-list">${S.items.map(x => `
        <div class="lb-row ${x.barcode === flash ? 'flash' : ''}" data-code="${esc(x.barcode)}">
          <span class="lb-code">${esc(x.barcode)}</span>
          <div class="lb-qty">
            <button type="button" data-q="-1" aria-label="One less">−</button>
            <input type="text" inputmode="numeric" value="${x.qty}" aria-label="Quantity for ${esc(x.barcode)}">
            <button type="button" data-q="1" aria-label="One more">+</button>
          </div>
          <button type="button" class="lb-remove" data-remove aria-label="Remove ${esc(x.barcode)}">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`).join('') || '<div class="empty-state" style="padding:30px 16px;"><p class="big">Nothing scanned yet</p><p>Tap Scan and point the camera at the barcodes that need a new label.</p></div>'}</div>
      ${S.items.length ? `<div class="lb-done"><button class="btn" id="lbDone">Done — send to the accountant</button></div>` : ''}`;
    el('lbScan').onclick = () => Scanner.open({ title: 'Scan for labels', continuous: true, onCode: code => addCode(code, true) });
    el('lbManual').onsubmit = e => { e.preventDefault(); const v = el('lbCode').value; if (addCode(v)) { el('lbCode').value = ''; el('lbCode').focus(); } };
    body.querySelectorAll('.lb-row').forEach(row => {
      const code = row.dataset.code;
      row.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { const it = S.items.find(x => x.barcode === code); setQty(code, it.qty + Number(b.dataset.q)); });
      row.querySelector('input').onchange = e => { const n = parseInt(e.target.value, 10); setQty(code, Number.isFinite(n) ? n : 0); };
      row.querySelector('[data-remove]').onclick = () => removeCode(code);
    });
    el('lbDone')?.addEventListener('click', submitList);
  }

  async function submitList() {
    const labels = S.items.reduce((n, x) => n + x.qty, 0);
    if (!(await showConfirm(`Send ${S.items.length} item${S.items.length === 1 ? '' : 's'} (${labels} label${labels === 1 ? '' : 's'}) to the accountant? You start a new list after this.`, 'Send'))) return;
    await S.queue;                                  // every scan is saved first
    const { error } = await sb.from('label_lists').update({ submitted_at: new Date().toISOString() }).eq('id', S.list.id);
    if (error) return fail('Could not send the list', error);
    logActivity('labels', 'submit', { type: 'label_list', id: S.list.id }, `Sent ${S.items.length} items (${labels} labels) for printing`, { items: S.items.length, labels });
    S.list = null; S.items = [];
    renderMine();
    showToast('Sent. The accountant will print the labels.');
  }

  /* ================= To print (accountant / admin) ================= */
  async function loadToPrint() {
    const { data: lists, error } = await sb.from('label_lists').select('*').not('submitted_at', 'is', null).is('exported_at', null).order('submitted_at');
    if (error) return fail('Could not load the lists', error);
    let items = [];
    if (lists.length) {
      const { data, error: e2 } = await sb.from('label_items').select('*').in('list_id', lists.map(l => l.id));
      if (e2) return fail('Could not load the lists', e2);
      items = data;
    }
    S.toPrint = lists.map(l => ({ ...l, items: items.filter(i => i.list_id === l.id) }));
  }
  function merged() {
    const m = new Map();
    S.toPrint.forEach(l => l.items.forEach(i => {
      const g = m.get(i.barcode) || { barcode: i.barcode, qty: 0, lists: 0 };
      g.qty += i.qty; g.lists++; m.set(i.barcode, g);
    }));
    return [...m.values()].sort((a, b) => a.barcode.localeCompare(b.barcode));
  }
  function renderToPrint() {
    const body = el('lbBody'); if (!body) return;
    const rows = merged();
    const labels = rows.reduce((n, r) => n + r.qty, 0);
    if (!S.toPrint.length) {
      body.innerHTML = '<div class="empty-state"><p class="big">Nothing to print</p><p>Lists appear here when a shelf worker taps Done.</p></div>';
      return;
    }
    body.innerHTML = `
      <div class="card">
        <div class="lb-print-head">
          <div><h3 style="margin:0 0 4px;">${rows.length} item${rows.length === 1 ? '' : 's'} · ${labels} label${labels === 1 ? '' : 's'}</h3>
            <span class="muted-note">From ${S.toPrint.length} list${S.toPrint.length === 1 ? '' : 's'}: ${S.toPrint.map(l => `${esc(l.created_by_name || 'Shelf worker')} (${esc(fmtTs(l.submitted_at))})`).join(', ')}</span></div>
          <button class="btn" id="lbExport">Export to Excel</button>
        </div>
        <div class="items-scroll" style="margin:14px 0 0;">
          <table class="items"><thead><tr><th>ItemCode</th><th class="num">Qty</th><th class="num">Lists</th></tr></thead>
            <tbody>${rows.map(r => `<tr><td style="font-family:var(--font-mono);">${esc(r.barcode)}</td><td class="num" style="font-family:var(--font-mono);">${r.qty}</td><td class="num">${r.lists}</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
    el('lbExport').onclick = exportAndEmpty;
  }

  async function exportAndEmpty() {
    const rows = merged();
    const ids = S.toPrint.map(l => l.id);
    const aoa = [['ItemCode', 'Qty'], ...rows.map(r => [r.barcode, r.qty])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let r = 1; r < aoa.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: 0 }); ws[ref].t = 's'; ws[ref].v = String(aoa[r][0]); ws[ref].w = String(aoa[r][0]); }
    ws['!cols'] = [{ wch: 18 }, { wch: 6 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Labels');
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Beirut' }).slice(0, 16).replace(/[ :]/g, '-');
    XLSX.writeFile(wb, `labels-${stamp}.xlsx`);
    // The file is out: mark the lists exported, which empties this page (they stay in the database).
    const { error } = await sb.from('label_lists').update({ exported_at: new Date().toISOString() }).in('id', ids);
    if (error) return fail('The file was downloaded, but the lists could not be marked as printed. Try Export again', error);
    logActivity('labels', 'export', null, `Exported ${rows.length} items (${rows.reduce((n, r) => n + r.qty, 0)} labels) for printing`, { lists: ids, items: rows.length });
    S.toPrint = [];
    renderToPrint();
    showToast('Excel downloaded. The list is now empty.');
  }

  window.Labels = { show, _state: S, _addCode: addCode };
})();
