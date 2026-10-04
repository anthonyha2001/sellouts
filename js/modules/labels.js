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
  const canScan = () => can('labels.scan');
  const canPrint = () => can('labels.print');
  // What is asked for each item (migration 048): a regular shelf label or a promo paper.
  const KINDS = { label: 'Regular label', promo: 'Promo paper' };
  const kindOf = x => x.kind === 'promo' ? 'promo' : 'label';
  const keyOf = x => `${x.barcode}|${kindOf(x)}`;
  const splitKey = k => { const i = k.lastIndexOf('|'); return { barcode: k.slice(0, i), kind: k.slice(i + 1) }; };
  try { S.kind = localStorage.getItem('lv:labelKind') === 'promo' ? 'promo' : 'label'; } catch (e) { S.kind = 'label'; }
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
  // The list is also kept on this phone (localStorage), updated on every scan, so a refresh, a closed
  // page or a lost connection never loses it. Items not yet saved to the database are marked `dirty`,
  // removals not yet saved are kept in `removed`; both are sent again on the next load.
  const draftKey = () => `lv:labelDraft:${Session.user.id}`;
  function readDraft() {
    try { const d = JSON.parse(localStorage.getItem(draftKey())); return d && Array.isArray(d.items) ? d : { items: [], removed: [] }; }
    catch (e) { return { items: [], removed: [] }; }
  }
  function saveDraft() {
    try {
      localStorage.setItem(draftKey(), JSON.stringify({
        items: S.items.map(x => ({ barcode: x.barcode, kind: kindOf(x), qty: x.qty, dirty: !!x.dirty })),
        removed: S.removed || [],
      }));
    } catch (e) { /* storage full or blocked: the database copy still works */ }
  }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ } }
  const pendingCount = () => S.items.filter(x => x.dirty).length + (S.removed || []).length;

  async function loadMine() {
    const draft = readDraft();
    S.removed = [...(draft.removed || [])];
    S.offline = false;
    let dbItems = [];
    const { data, error } = await sb.from('label_lists').select('*').eq('created_by', Session.user.id).is('submitted_at', null).maybeSingle();
    if (error) {
      // No connection or the database refused: carry on with the copy on this phone.
      S.offline = true;
      S.list = null;
      S.items = draft.items.map(x => ({ ...x, dirty: true }));
      console.warn('Labels: using the draft on this phone', error);
      return;
    }
    S.list = data;
    if (data) {
      const { data: items, error: e2 } = await sb.from('label_items').select('*').eq('list_id', data.id).order('scanned_at', { ascending: false });
      if (e2) { S.offline = true; S.items = draft.items.map(x => ({ ...x, dirty: true })); return; }
      dbItems = items;
    }
    // Merge: the database, plus changes made on this phone that were not saved yet.
    // Before migration 048 the drafts had no kind (regular label) and removals were plain barcodes.
    S.removed = S.removed.map(k => k.includes('|') ? k : k + '|label');
    const byCode = new Map(dbItems.map(x => [keyOf(x), { ...x, dirty: false }]));
    draft.items.filter(x => x.dirty).forEach(x => byCode.set(keyOf(x), { ...(byCode.get(keyOf(x)) || { id: null }), barcode: x.barcode, kind: kindOf(x), qty: x.qty, dirty: true }));
    S.removed.forEach(k => byCode.delete(k));
    const draftOrder = draft.items.map(keyOf);
    S.items = [...byCode.values()].sort((a, b) => {
      const ia = draftOrder.indexOf(keyOf(a)), ib = draftOrder.indexOf(keyOf(b));
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    saveDraft();
    // Send whatever did not reach the database last time.
    S.items.filter(x => x.dirty).forEach(it => enqueue(() => saveItem(it)));
    [...S.removed].forEach(k => enqueue(() => deleteItem(k)));
  }
  async function ensureList() {
    if (S.list) return S.list;
    const { data, error } = await sb.from('label_lists').insert({}).select().single();
    if (error) {
      // Another device of the same person may have opened one a moment ago: use that one.
      const { data: open } = await sb.from('label_lists').select('*').eq('created_by', Session.user.id).is('submitted_at', null).maybeSingle();
      if (open) { S.list = open; return open; }
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
    const kind = S.kind;
    let it = S.items.find(x => x.barcode === code && kindOf(x) === kind);
    if (it) { it.qty = Math.min(9999, it.qty + 1); S.items = [it, ...S.items.filter(x => x !== it)]; }
    else { it = { id: null, barcode: code, kind, qty: 1 }; S.items.unshift(it); }
    it.dirty = true;
    S.removed = (S.removed || []).filter(k => k !== keyOf(it));
    saveDraft();                                   // on the phone first, instantly
    renderMine(keyOf(it));
    enqueue(() => saveItem(it));
    return `<span class="scan-ok"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span><span class="scan-code">${esc(code)}</span><b>× ${it.qty}</b>`
      + `<span class="scan-sub">${KINDS[kind]} · ${S.items.length} item${S.items.length === 1 ? '' : 's'} in your list</span>`;
  }
  let offlineWarned = false;
  async function saveItem(it) {
    if (!S.items.includes(it)) return;             // removed meanwhile
    try {
      const list = await ensureList();
      const { data, error } = await sb.from('label_items')
        .upsert({ list_id: list.id, barcode: it.barcode, kind: kindOf(it), qty: it.qty }, { onConflict: 'list_id,barcode,kind' }).select().single();
      if (error) throw error;
      it.id = data.id;
      if (Number(data.qty) === it.qty) it.dirty = false;
      S.offline = false;
      saveDraft();
      updatePending();
    } catch (e) {
      S.offline = true;
      updatePending();
      // One message, not one per scan: the list is safe on the phone and is sent again later.
      if (!offlineWarned) {
        offlineWarned = true; console.error(e);
        // A refusal from the database (not a lost connection) is shown as is, so it can be reported.
        const refused = e && e.code && !/fetch|network/i.test(e.message || '');
        showToast(refused ? `Not sent — the server refused it: ${friendlyError(e)}. Your list is saved on this phone.`
          : 'Not sent yet — your list is saved on this phone and will be sent automatically.', true);
      }
    }
  }
  async function deleteItem(key) {
    if (!S.list) { S.removed = S.removed.filter(k => k !== key); saveDraft(); return; }
    const { barcode, kind } = splitKey(key);
    const { error } = await sb.from('label_items').delete().eq('list_id', S.list.id).eq('barcode', barcode).eq('kind', kind);
    if (error) { S.offline = true; updatePending(); return; }
    S.removed = S.removed.filter(k => k !== key);
    saveDraft();
    updatePending();
  }
  async function setQty(key, qty) {
    const it = S.items.find(x => keyOf(x) === key); if (!it) return;
    if (qty <= 0) return removeCode(key);
    it.qty = Math.min(9999, qty);
    it.dirty = true;
    saveDraft();
    renderMine();
    enqueue(() => saveItem(it));
  }
  async function removeCode(key) {
    const it = S.items.find(x => keyOf(x) === key); if (!it) return;
    S.items = S.items.filter(x => x !== it);
    S.removed = [...new Set([...(S.removed || []), key])];
    saveDraft();
    renderMine();
    enqueue(() => deleteItem(key));
  }
  // Regular label <-> promo paper for one item (joins the other one if it is already in the list).
  function switchKind(key) {
    const it = S.items.find(x => keyOf(x) === key); if (!it) return;
    const to = kindOf(it) === 'promo' ? 'label' : 'promo';
    const other = S.items.find(x => x.barcode === it.barcode && kindOf(x) === to);
    removeCode(key);
    if (other) { other.qty = Math.min(9999, other.qty + it.qty); other.dirty = true; saveDraft(); renderMine(keyOf(other)); enqueue(() => saveItem(other)); }
    else { const n = { id: null, barcode: it.barcode, kind: to, qty: it.qty, dirty: true }; S.items.unshift(n); S.removed = S.removed.filter(k => k !== keyOf(n)); saveDraft(); renderMine(keyOf(n)); enqueue(() => saveItem(n)); }
  }
  // "N not sent yet" line under the list; retry button when offline.
  function updatePending() {
    const box = el('lbPending'); if (!box) return;
    const n = pendingCount();
    box.hidden = !n;
    box.innerHTML = n ? `${n} change${n === 1 ? '' : 's'} not sent yet — saved on this phone. <button type="button" class="link-btn" id="lbRetry">Send now</button>` : '';
    el('lbRetry')?.addEventListener('click', () => {
      S.items.filter(x => x.dirty).forEach(it => enqueue(() => saveItem(it)));
      [...(S.removed || [])].forEach(k => enqueue(() => deleteItem(k)));
    });
  }

  function renderMine(flash) {
    const body = el('lbBody'); if (!body) return;
    const labels = S.items.reduce((n, x) => n + x.qty, 0);
    const byKind = k => S.items.filter(x => kindOf(x) === k).reduce((n, x) => n + x.qty, 0);
    body.innerHTML = `
      <div class="lb-kind" role="group" aria-label="What to ask for">
        <span class="lb-kind-t">Scanning for</span>
        ${Object.entries(KINDS).map(([k, l]) => `<button type="button" data-kind="${k}" class="${S.kind === k ? 'on' : ''}" aria-pressed="${S.kind === k}">${l}</button>`).join('')}
      </div>
      <div class="card lb-scan-card">
        <button type="button" class="btn lb-scan-btn" id="lbScan">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>
          Scan</button>
        <form class="lb-manual" id="lbManual" autocomplete="off">
          <input type="text" id="lbCode" inputmode="numeric" placeholder="Or type a barcode" spellcheck="false">
          <button class="btn secondary small" type="submit">Add</button>
        </form>
      </div>
      <div class="lb-summary"><b>${S.items.length}</b> item${S.items.length === 1 ? '' : 's'} · <b>${byKind('label')}</b> regular label${byKind('label') === 1 ? '' : 's'} · <b>${byKind('promo')}</b> promo paper${byKind('promo') === 1 ? '' : 's'}</div>
      <div class="lb-pending" id="lbPending" hidden></div>
      <div class="lb-list">${S.items.map(x => `
        <div class="lb-row ${keyOf(x) === flash ? 'flash' : ''}" data-code="${esc(keyOf(x))}">
          <span class="lb-code">${esc(x.barcode)}<button type="button" class="lb-kind-chip lb-kind-${kindOf(x)}" data-switch title="Tap to switch between a regular label and a promo paper">${KINDS[kindOf(x)]}</button></span>
          <div class="lb-qty">
            <button type="button" data-q="-1" aria-label="One less">−</button>
            <input type="text" inputmode="numeric" value="${x.qty}" aria-label="Quantity for ${esc(x.barcode)}">
            <button type="button" data-q="1" aria-label="One more">+</button>
          </div>
          <button type="button" class="lb-remove" data-remove aria-label="Remove ${esc(x.barcode)}">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>`).join('') || '<div class="empty-state" style="padding:30px 16px;"><p class="big">Nothing scanned yet</p><p>Tap Scan and point the camera at the barcodes that need a new label.</p></div>'}</div>
      ${S.items.length ? `<div class="lb-done"><button class="btn" id="lbDone">Done</button></div>` : ''}`;
    el('lbScan').onclick = () => Scanner.open({ title: `Scan for labels — ${KINDS[S.kind]}`, continuous: true, onCode: code => addCode(code, true) });
    body.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { S.kind = b.dataset.kind; try { localStorage.setItem('lv:labelKind', S.kind); } catch (e) { /* ignore */ } renderMine(); });
    el('lbManual').onsubmit = e => { e.preventDefault(); const v = el('lbCode').value; if (addCode(v)) { el('lbCode').value = ''; el('lbCode').focus(); } };
    body.querySelectorAll('.lb-row').forEach(row => {
      const code = row.dataset.code;
      row.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { const it = S.items.find(x => keyOf(x) === code); setQty(code, it.qty + Number(b.dataset.q)); });
      row.querySelector('[data-switch]').onclick = () => switchKind(code);
      row.querySelector('input').onchange = e => { const n = parseInt(e.target.value, 10); setQty(code, Number.isFinite(n) ? n : 0); };
      row.querySelector('[data-remove]').onclick = () => removeCode(code);
    });
    el('lbDone')?.addEventListener('click', submitList);
    updatePending();
  }

  async function submitList() {
    const labels = S.items.reduce((n, x) => n + x.qty, 0);
    const btn = el('lbDone'); if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    // Everything must be in the database first: resend what is still only on this phone.
    S.items.filter(x => x.dirty).forEach(it => enqueue(() => saveItem(it)));
    [...(S.removed || [])].forEach(k => enqueue(() => deleteItem(k)));
    await S.queue;
    if (pendingCount() || !S.list) {
      showToast('Some scans are not saved to the server yet (no connection?). Your list is safe on this phone — try Done again in a moment.', true);
      if (btn) { btn.disabled = false; btn.textContent = 'Done'; }
      return;
    }
    const { error } = await sb.from('label_lists').update({ submitted_at: new Date().toISOString() }).eq('id', S.list.id);
    if (error) { if (btn) { btn.disabled = false; btn.textContent = 'Done'; } return fail('Could not send the list', error); }
    logActivity('labels', 'submit', { type: 'label_list', id: S.list.id }, `Sent ${S.items.length} items (${labels} labels) for printing`, { items: S.items.length, labels });
    S.list = null; S.items = []; S.removed = [];
    clearDraft();
    renderMine();
    showToast(`Sent to the accountant — ${labels} label${labels === 1 ? '' : 's'}.`);
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
      const g = m.get(keyOf(i)) || { barcode: i.barcode, kind: kindOf(i), qty: 0, lists: 0 };
      g.qty += i.qty; g.lists++; m.set(keyOf(i), g);
    }));
    return [...m.values()].sort((a, b) => a.barcode.localeCompare(b.barcode));
  }
  // One card per sent list, like the sell-outs: the worker's name, when it was sent, items / labels;
  // open it to see the barcodes; Export downloads that list (then it leaves this page); Edit corrects
  // quantities, removes or adds a barcode before printing (migration 026).
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  function renderToPrint() {
    const body = el('lbBody'); if (!body) return;
    if (!S.toPrint.length) {
      body.innerHTML = '<div class="empty-state"><p class="big">Nothing to print</p><p>Lists appear here when a shelf worker taps Done.</p></div>';
      return;
    }
    S.open = S.open || new Set();
    const total = merged().reduce((n, r) => n + r.qty, 0);
    body.innerHTML = `
      <div class="lb-print-top">
        <span class="muted-note">${S.toPrint.length} list${S.toPrint.length === 1 ? '' : 's'} · ${total} label${total === 1 ? '' : 's'} to print</span>
        ${S.toPrint.length > 1 ? '<button class="btn secondary small" id="lbExportAll">Export all together</button>' : ''}
      </div>
      ${S.toPrint.map(listCard).join('')}`;
    el('lbExportAll')?.addEventListener('click', () => exportLists(S.toPrint));
    body.querySelectorAll('.sellout[data-list]').forEach(card => wireCard(card));
  }
  function listCard(l) {
    const editing = S.editing === l.id;
    const items = (editing ? S.draftItems : l.items).slice().sort((x, y) => kindOf(x).localeCompare(kindOf(y)) || x.barcode.localeCompare(y.barcode));
    const kindCell = i => `<td><span class="lb-kind-chip lb-kind-${kindOf(i)}">${KINDS[kindOf(i)]}</span></td>`;
    const labels = l.items.reduce((n, i) => n + i.qty, 0);
    const open = editing || S.open.has(l.id);
    const rows = items.map(i => editing
      ? `<tr data-code="${esc(keyOf(i))}"><td style="font-family:var(--font-mono);">${esc(i.barcode)}</td>${kindCell(i)}
          <td class="num"><input type="text" inputmode="numeric" class="lb-edit-qty" value="${i.qty}" aria-label="Quantity for ${esc(i.barcode)}"></td>
          <td class="num"><button type="button" class="icon-btn danger" data-act="remove" title="Remove" aria-label="Remove ${esc(i.barcode)}">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button></td></tr>`
      : `<tr><td style="font-family:var(--font-mono);">${esc(i.barcode)}</td>${kindCell(i)}<td class="num" style="font-family:var(--font-mono);">${i.qty}</td></tr>`).join('');
    return `<div class="sellout ${open ? 'open' : ''}" data-list="${esc(l.id)}">
      <div class="sellout-head" data-toggle>
        <span class="chev">${svg('<path d="M9 6l6 6-6 6"/>')}</span>
        <div class="who"><div class="name">${esc(l.created_by_name || 'Shelf worker')}</div>
          <div class="dates"><span>${esc(fmtTs(l.submitted_at))}</span><span>· ${l.items.length} item${l.items.length === 1 ? '' : 's'} · ${labels} label${labels === 1 ? '' : 's'}</span></div></div>
        <div class="icon-actions">
          <button class="icon-btn" data-act="edit" title="Edit this list" aria-label="Edit this list" ${editing ? 'disabled' : ''}>${svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>
          <button class="btn small lb-export-one" data-act="export" ${editing ? 'disabled' : ''}>${svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>')} Export</button>
        </div>
      </div>
      <div class="sellout-body">
        <div class="items-scroll" style="margin:0;">
          <table class="items"><thead><tr><th>ItemCode</th><th>Type</th><th class="num">Qty</th>${editing ? '<th></th>' : ''}</tr></thead><tbody>${rows || '<tr><td colspan="4" class="empty-note">No items.</td></tr>'}</tbody></table>
        </div>
        ${editing ? `<form class="lb-edit-add" data-act="add-form"><input type="text" inputmode="numeric" placeholder="Add a barcode" aria-label="Add a barcode"><select aria-label="Type">${Object.entries(KINDS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select><input type="text" inputmode="numeric" value="1" class="lb-edit-qty" aria-label="Quantity"><button class="btn secondary small" type="submit">Add</button></form>
          <div class="actions-row"><button type="button" class="btn ghost small" data-act="cancel">Cancel</button><button type="button" class="btn small" data-act="save">Save changes</button></div>` : ''}
      </div>
    </div>`;
  }
  function wireCard(card) {
    const l = S.toPrint.find(x => x.id === card.dataset.list); if (!l) return;
    card.querySelector('[data-toggle]').addEventListener('click', e => {
      if (e.target.closest('.icon-actions') || S.editing === l.id) return;
      S.open.has(l.id) ? S.open.delete(l.id) : S.open.add(l.id);
      card.classList.toggle('open');
    });
    card.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'FORM') return;
      e.stopPropagation();
      if (b.dataset.act === 'export') return exportLists([l]);
      if (b.dataset.act === 'edit') { S.editing = l.id; S.draftItems = l.items.map(i => ({ barcode: i.barcode, kind: kindOf(i), qty: i.qty })); return renderToPrint(); }
      if (b.dataset.act === 'cancel') { S.editing = null; return renderToPrint(); }
      if (b.dataset.act === 'remove') { const code = b.closest('tr').dataset.code; S.draftItems = S.draftItems.filter(i => keyOf(i) !== code); return renderToPrint(); }
      if (b.dataset.act === 'save') return saveEdit(l);
    });
    card.querySelectorAll('.lb-edit-qty').forEach(inp => inp.addEventListener('change', () => {
      const code = inp.closest('tr')?.dataset.code; if (!code) return;
      const it = S.draftItems.find(i => keyOf(i) === code); const n = parseInt(inp.value, 10);
      if (it) it.qty = Number.isFinite(n) && n > 0 ? n : 1;
    }));
    card.querySelector('[data-act="add-form"]')?.addEventListener('submit', e => {
      e.preventDefault();
      const [codeInp, qtyInp] = e.target.querySelectorAll('input'), kind = e.target.querySelector('select').value;
      const code = codeInp.value.replace(/\s+/g, ''); const n = parseInt(qtyInp.value, 10) || 1;
      if (!code) return;
      const it = S.draftItems.find(i => i.barcode === code && kindOf(i) === kind);
      if (it) it.qty += n; else S.draftItems.push({ barcode: code, kind, qty: n });
      renderToPrint();
      el('lbBody').querySelector(`.sellout[data-list="${CSS.escape(l.id)}"] [data-act="add-form"] input`)?.focus();
    });
  }
  async function saveEdit(l) {
    // Quantities typed but not yet "changed" (still focused) count too.
    el('lbBody').querySelectorAll(`.sellout[data-list="${CSS.escape(l.id)}"] tr[data-code] .lb-edit-qty`).forEach(inp => {
      const it = S.draftItems.find(i => keyOf(i) === inp.closest('tr').dataset.code); const n = parseInt(inp.value, 10);
      if (it) it.qty = Number.isFinite(n) && n > 0 ? n : 1;
    });
    const now = new Map(S.draftItems.map(i => [keyOf(i), i.qty]));
    const removed = l.items.filter(i => !now.has(keyOf(i)));
    const upserts = S.draftItems.filter(i => { const o = l.items.find(x => keyOf(x) === keyOf(i)); return !o || o.qty !== i.qty; })
      .map(i => ({ list_id: l.id, barcode: i.barcode, kind: kindOf(i), qty: i.qty }));
    if (removed.length) { const { error } = await sb.from('label_items').delete().in('id', removed.map(i => i.id)); if (error) return fail('Could not save the list', error); }
    if (upserts.length) { const { error } = await sb.from('label_items').upsert(upserts, { onConflict: 'list_id,barcode,kind' }); if (error) return fail('Could not save the list', error); }
    if (removed.length || upserts.length) logActivity('labels', 'edit', { type: 'label_list', id: l.id }, `Edited the label list of ${l.created_by_name || 'a shelf worker'} (${upserts.length} changed, ${removed.length} removed)`);
    S.editing = null;
    await loadToPrint();
    renderToPrint();
    showToast('List saved.');
  }

  // Export one list (or all together): the Excel file, then those lists are marked printed and leave the page.
  async function exportLists(lists) {
    // One sheet per type: "Labels" (regular, the same columns as before) and "Promo paper".
    const byKind = { label: new Map(), promo: new Map() };
    lists.forEach(l => l.items.forEach(i => { const m = byKind[kindOf(i)]; m.set(i.barcode, (m.get(i.barcode) || 0) + i.qty); }));
    const sheetRows = k => [...byKind[k].entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = [...sheetRows('label'), ...sheetRows('promo')];
    if (!rows.length) return showToast('This list is empty.', true);
    const wb = XLSX.utils.book_new();
    [['label', 'Labels'], ['promo', 'Promo paper']].forEach(([k, name]) => {
      const aoa = [['ItemCode', 'Qty'], ...sheetRows(k)];
      if (aoa.length === 1) return;
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      for (let r = 1; r < aoa.length; r++) { const ref = XLSX.utils.encode_cell({ r, c: 0 }); ws[ref].t = 's'; ws[ref].v = String(aoa[r][0]); ws[ref].w = String(aoa[r][0]); }
      ws['!cols'] = [{ wch: 18 }, { wch: 6 }];
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Beirut' }).slice(0, 16).replace(/[ :]/g, '-');
    const who = lists.length === 1 ? '-' + String(lists[0].created_by_name || 'list').replace(/[^\w-]+/g, '-').toLowerCase() : '';
    XLSX.writeFile(wb, `labels${who}-${stamp}.xlsx`);
    const ids = lists.map(l => l.id);
    const { error } = await sb.from('label_lists').update({ exported_at: new Date().toISOString() }).in('id', ids);
    if (error) return fail('The file was downloaded, but the list could not be marked as printed. Try Export again', error);
    const labels = rows.reduce((n, r) => n + r[1], 0);
    logActivity('labels', 'export', null, `Exported ${rows.length} items (${labels} labels) for printing`, { lists: ids, items: rows.length });
    S.toPrint = S.toPrint.filter(l => !ids.includes(l.id));
    renderToPrint();
    showToast(`Excel downloaded — ${labels} label${labels === 1 ? '' : 's'}.`);
  }

  window.Labels = { show, _state: S, _addCode: addCode };
})();
