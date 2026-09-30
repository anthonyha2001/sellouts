/* ============================================================
   Floor check (PLAN §9): each day the floor manager walks the
   store and checks every item of every sell-out and promotion running today
   against its new price. One check per person per day; reopening
   the page resumes it. Admin sees results, resolves problems, and
   sees items that keep coming back wrong. Public API: window.FloorCheck.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-floorcheck');
  const STATUSES = {
    ok:           { label: 'Correct',     icon: '✅', cls: 'ok' },
    wrong_price:  { label: 'Wrong price', icon: '❌', cls: 'bad' },
    missing_tag:  { label: 'Tag missing', icon: '🏷️', cls: 'bad' },
    out_of_stock: { label: 'Out of stock', icon: '📦', cls: 'warn' },
  };
  const PROBLEMS = ['wrong_price', 'missing_tag', 'out_of_stock'];
  const PHOTO_BUCKET = 'floor-photos';
  const S = { tab: 'today', check: null, items: [], filter: 'todo', started: false, openNote: null, checks: [], results: new Map(), photoUrls: new Map(),
    groupBy: 'supplier', show: 'all', openGroups: null };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  // Some sell-out files are in LBP (e.g. 429,600), others in USD (4.72): show as written, with separators.
  const price = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const fail = (what, error) => { console.error(error); showToast(`${what} — ${friendlyError(error)}`, true); };
  let profileNames = new Map();

  /* ---------------- which items to check today ---------------- */
  // Sell-outs running today: switched on in the store's system, or today falls in their dates. Never archived.
  // Promotions running today: not archived and today falls in their dates (owner: promotions are checked too).
  async function todaysSources() {
    const today = todayStr();
    const [so, pr] = await Promise.all([
      sb.from('sellouts').select('id, name, from, to, active, archived, items, priced_items, price_column'),
      sb.from('promotions').select('id, name, from_date, to_date, archived').eq('archived', false).lte('from_date', today).gte('to_date', today),
    ]);
    if (so.error) { fail('Could not load the sell-outs', so.error); return { sellouts: [], promotions: [] }; }
    if (pr.error) { fail('Could not load the promotions', pr.error); return { sellouts: [], promotions: [] }; }
    const sellouts = so.data
      .filter(s => !s.archived && (s.active || (s.from <= today && today <= s.to)))
      .map(s => ({ id: s.id, name: s.name, from: s.from, to: s.to, items: s.items || [], pricedItems: Array.isArray(s.priced_items) ? s.priced_items : null, priceColumn: s.price_column }));
    const promotions = pr.data.map(p => ({ id: p.id, name: p.name || 'Promotion', from: p.from_date, to: p.to_date, rows: [] }));
    if (promotions.length) {
      const { data: rows, error } = await sb.from('promotion_rows').select('id, promotion_id, code, description, supplier, barcode, promo_price, before_price, sale_price, sort_order')
        .in('promotion_id', promotions.map(p => p.id)).order('sort_order');
      if (error) { fail('Could not load the promotion items', error); return { sellouts, promotions: [] }; }
      promotions.forEach(p => { p.rows = rows.filter(r => r.promotion_id === p.id); });
    }
    return { sellouts, promotions };
  }
  const numOrNull = v => (v === null || v === undefined || v === '' ? null : Number(v));
  function itemsFor({ sellouts, promotions }) {
    const today = todayStr();
    const out = [];
    const priorityOf = x => (x.from === today || x.to === today) ? 0 : 1;
    sellouts.forEach(so => {
      const bcCol = detectColumns(so.items).barcode;
      pricedRowsOf(so).forEach(p => {
        if (!p.code && !p.description) return;
        // Sell-out files have no supplier column; each sell-out is one supplier's offer, so its name groups it.
        out.push({ source: 'sellout', sellout_id: so.id, source_name: so.name, supplier: so.name, item_key: `so:${so.id}:${p.row}`, item_row: p.row,
          code: p.code, description: p.description, expected_price: p.newPrice ?? null, old_price: p.oldPrice ?? null, priority: priorityOf(so),
          barcode: p.barcode || (bcCol ? (splitBarcodes(so.items[p.row]?.[bcCol])[0] || '') : '') });
      });
    });
    promotions.forEach(pm => {
      pm.rows.forEach((r, i) => {
        if (!String(r.code || '').trim() && !String(r.description || '').trim()) return;
        out.push({ source: 'promotion', promotion_id: pm.id, source_name: pm.name, supplier: String(r.supplier || '').trim() || 'No supplier',
          item_key: `pr:${r.id}`, item_row: i, code: String(r.code || '').trim(), description: r.description || '',
          expected_price: numOrNull(r.promo_price), old_price: numOrNull(r.before_price) ?? numOrNull(r.sale_price), priority: priorityOf(pm),
          barcode: String(r.barcode || '').trim() });
      });
    });
    // Supplier by supplier: suppliers with something starting/ending today first, then A-Z.
    const groupPriority = new Map();
    out.forEach(x => groupPriority.set(x.supplier, Math.min(groupPriority.get(x.supplier) ?? 1, x.priority)));
    out.sort((a, b) => groupPriority.get(a.supplier) - groupPriority.get(b.supplier) || a.supplier.localeCompare(b.supplier)
      || a.priority - b.priority || a.source_name.localeCompare(b.source_name) || a.item_row - b.item_row);
    out.forEach((x, i) => { x.sort_order = i; if (!x.barcode) delete x.barcode; });
    return out;
  }
  const supplierOf = x => x.supplier || x.source_name || 'No supplier';

  // Groups for the list: by supplier, or by each sell-out / promotion. Kept in item order
  // (groups with something starting or ending today already come first).
  function groupItems(items) {
    const map = new Map();
    items.slice().sort((a, b) => a.sort_order - b.sort_order).forEach(x => {
      const bySource = S.groupBy === 'source';
      const key = bySource ? `${x.source}|${x.source_name}` : `s|${supplierOf(x)}`;
      if (!map.has(key)) map.set(key, {
        key, items: [],
        label: bySource ? (x.source_name || '') : supplierOf(x),
        badge: bySource ? `<span class="badge ${x.source === 'promotion' ? 'active' : 'inactive'}">${x.source === 'promotion' ? 'Promo' : 'Sell-out'}</span> ` : '',
        priority: 1,
      });
      const g = map.get(key);
      g.items.push(x);
      g.priority = Math.min(g.priority, x.priority);
    });
    return [...map.values()].sort((a, b) => a.priority - b.priority || (S.groupBy === 'source' ? a.label.localeCompare(b.label) : 0));
  }
  function saveView() { try { localStorage.setItem('lv:floorView', JSON.stringify({ groupBy: S.groupBy, show: S.show })); } catch (e) { /* ignore */ } }
  try { Object.assign(S, JSON.parse(localStorage.getItem('lv:floorView')) || {}); } catch (e) { /* storage blocked */ }

  /* ---------------- data ---------------- */
  async function loadToday() {
    const { data, error } = await sb.from('floor_checks').select('*').eq('check_date', todayStr()).eq('started_by', Session.user.id).maybeSingle();
    if (error) { fail('Could not load today’s check', error); return; }
    S.check = data;
    S.items = [];
    if (data) {
      const { data: items, error: e2 } = await sb.from('floor_check_items').select('*').eq('check_id', data.id).order('sort_order');
      if (e2) return fail('Could not load the items', e2);
      S.items = items;
    }
  }
  async function startCheck() {
    const sources = await todaysSources();
    const items = itemsFor(sources);
    if (!items.length) { showToast('No sell-out or promotion is running today, so there is nothing to check.', true); return; }
    const { data: check, error } = await sb.from('floor_checks').insert({}).select().single();
    if (error) return fail('Could not start the check', error);
    for (let i = 0; i < items.length; i += 500) {
      const { error: e2 } = await sb.from('floor_check_items').insert(items.slice(i, i + 500).map(x => ({ ...x, check_id: check.id })));
      if (e2) return fail('Could not add the items', e2);
    }
    logActivity('floorcheck', 'start', { type: 'floor_check', id: check.id },
      `Started today's floor check (${items.length} items from ${sources.sellouts.length} sell-outs and ${sources.promotions.length} promotions)`);
    await loadToday();
    render();
  }

  /* ---------------- today's check (mobile-first) ---------------- */
  function counts(items) {
    const c = { total: items.length, pending: 0, ok: 0, wrong_price: 0, missing_tag: 0, out_of_stock: 0 };
    items.forEach(x => { c[x.status] = (c[x.status] || 0) + 1; });
    c.done = c.total - c.pending;
    c.problems = c.wrong_price + c.missing_tag + c.out_of_stock;
    return c;
  }

  function renderToday() {
    const body = el('fcBody');
    if (!S.check) {
      body.innerHTML = `<div class="card fc-start">
        <p class="big">Today's floor check</p>
        <p>Walk the store and check every item of every sell-out and promotion running today against its price.</p>
        <button class="btn" id="fcStart">Start today's check</button>
      </div>`;
      el('fcStart').onclick = async () => { el('fcStart').disabled = true; await startCheck(); };
      return;
    }
    const c = counts(S.items);
    const finished = !!S.check.completed_at;
    const locked = finished && !can('floorcheck.manage');
    const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
    const inShow = x => S.show === 'all' || x.source === S.show;
    const matches = x => inShow(x) && (S.filter === 'all' || (S.filter === 'todo' ? x.status === 'pending' : PROBLEMS.includes(x.status)));
    const groups = groupItems(S.items.filter(inShow));
    // First visit: open the first group that still has something to check.
    if (!S.openGroups) S.openGroups = new Set([(groups.find(g => g.items.some(x => x.status === 'pending')) || groups[0])?.key].filter(Boolean));
    const groupsHtml = groups.map(g => {
      const shown = g.items.filter(matches);
      if (!shown.length) return '';
      const gc = counts(g.items);
      const open = S.openGroups.has(g.key);
      return `<section class="fc-group ${open ? 'open' : ''}">
        <button type="button" class="fc-group-head" data-group="${esc(g.key)}" aria-expanded="${open}">
          <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
          <span class="fc-group-name">${g.badge}${esc(g.label)}</span>
          <span class="fc-group-count">${gc.done}/${gc.total}${gc.problems ? ` · <span class="fc-bad-text">${gc.problems} problem${gc.problems === 1 ? '' : 's'}</span>` : ''}</span>
          <span class="fc-group-bar"><span style="width:${gc.total ? Math.round(gc.done / gc.total * 100) : 0}%"></span></span>
        </button>
        ${open ? `<div class="fc-group-body">${shown.map(itemCard).join('')}</div>` : ''}
      </section>`;
    }).join('');
    const pill = (attr, val, cur, label) => `<button data-${attr}="${val}" class="${cur === val ? 'active' : ''}">${label}</button>`;
    body.innerHTML = `
      <div class="card fc-progress-card">
        <div class="fc-progress-top">
          <span><b>${c.done}</b> of ${c.total} checked${c.problems ? ` · <span class="fc-bad-text">${c.problems} problem${c.problems === 1 ? '' : 's'}</span>` : ''}</span>
          <span class="muted-note">${finished ? 'Finished ' + esc(fmtTs(S.check.completed_at)) : pct + '%'}</span>
        </div>
        <div class="fc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${c.done}"><span style="width:${pct}%"></span></div>
        <div id="fcMissing"></div>
      </div>
      <div class="filter-row fc-filters">
        <button data-f="todo" class="${S.filter === 'todo' ? 'active' : ''}">To check (${c.pending})</button>
        <button data-f="problems" class="${S.filter === 'problems' ? 'active' : ''}">Problems (${c.problems})</button>
        <button data-f="all" class="${S.filter === 'all' ? 'active' : ''}">All (${c.total})</button>
      </div>
      ${locked ? '' : `<button type="button" class="btn fc-scan-btn" id="fcScan">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>
        Scan an item</button>`}
      <div class="fc-view">
        <div class="fc-view-row"><span class="fc-view-label">Group by</span><div class="filter-row">
          ${pill('group', 'supplier', S.groupBy, 'Supplier')}${pill('group', 'source', S.groupBy, 'Sell-out / promotion')}</div></div>
        <div class="fc-view-row"><span class="fc-view-label">Show</span><div class="filter-row">
          ${pill('show', 'all', S.show, 'All')}${pill('show', 'sellout', S.show, 'Sell-outs')}${pill('show', 'promotion', S.show, 'Promotions')}</div></div>
      </div>
      <div class="fc-list">${groupsHtml || `<div class="empty-state" style="padding:30px 16px;"><p class="big">${S.filter === 'todo' ? 'Everything is checked' : 'Nothing here'}</p>${S.filter === 'todo' && !finished ? '<p>Tap “Finish check” when you are done.</p>' : ''}</div>`}</div>
      ${finished ? '' : `<div class="fc-finish"><button class="btn" id="fcFinish">Finish check</button></div>`}`;
    body.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { S.filter = b.dataset.f; renderToday(); });
    body.querySelectorAll('[data-group]').forEach(b => b.onclick = () => {
      if (b.classList.contains('fc-group-head')) {
        S.openGroups.has(b.dataset.group) ? S.openGroups.delete(b.dataset.group) : S.openGroups.add(b.dataset.group);
      } else {
        S.groupBy = b.dataset.group; S.openGroups = null; saveView();
      }
      renderToday();
    });
    body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { S.show = b.dataset.show; S.openGroups = null; saveView(); renderToday(); });
    el('fcScan')?.addEventListener('click', scanToItem);
    if (S.focus) {
      const card = body.querySelector(`.fc-item[data-id="${CSS.escape(S.focus)}"]`);
      S.focus = null;
      if (card) { card.scrollIntoView({ block: 'center' }); card.classList.add('fc-focus'); setTimeout(() => card.classList.remove('fc-focus'), 2500); }
    }
    body.querySelectorAll('.fc-item').forEach(card => wireItem(card, locked));
    el('fcFinish')?.addEventListener('click', finishCheck);
    loadPhotoThumbs(body);
    const extra = !finished ? (S.extra || []) : [];
    if (extra.length) {
      el('fcMissing').innerHTML = `<div class="fc-missing"><span>${extra.length} new item${extra.length === 1 ? '' : 's'} from sell-outs or promotions started since you began.</span><button class="btn secondary small" id="fcAddMissing">Add them</button></div>`;
      el('fcAddMissing').onclick = async () => {
        const base = Math.max(0, ...S.items.map(x => x.sort_order)) + 1;
        const { error } = await sb.from('floor_check_items').insert(extra.map((x, i) => ({ ...x, check_id: S.check.id, sort_order: base + i })));
        if (error) return fail('Could not add the items', error);
        await loadToday(); await syncOpenCheck(); renderToday();
      };
    }
  }

  // Scan a shelf barcode and jump to that item: opens its group, clears filters that hide it, highlights it.
  function scanToItem() {
    Scanner.open({
      title: 'Scan an item', continuous: true,
      onCode: code => {
        const x = S.items.find(i => i.barcode && i.barcode === code) || S.items.find(i => i.code && i.code === code);
        if (!x) return { ok: false, html: `<span class="scan-code">${esc(code)}</span><span class="scan-sub">Not in today's check</span>` };
        if (S.show !== 'all' && x.source !== S.show) S.show = 'all';
        const matchesFilter = S.filter === 'all' || (S.filter === 'todo' ? x.status === 'pending' : PROBLEMS.includes(x.status));
        if (!matchesFilter) S.filter = 'all';
        const key = S.groupBy === 'source' ? `${x.source}|${x.source_name}` : `s|${supplierOf(x)}`;
        S.openGroups = S.openGroups || new Set();
        S.openGroups.add(key);
        S.focus = x.id;
        Scanner.close();
        renderToday();
        return '';
      },
    });
  }

  // An open check follows price changes made after it started (e.g. a sell-out priced later):
  // items not yet checked get the current price; checked items keep the price they were checked against.
  // Also finds items from sell-outs / promotions that started since.
  async function syncOpenCheck() {
    S.extra = [];
    if (!S.check || S.check.completed_at) return;
    const current = itemsFor(await todaysSources());
    const byKey = new Map(current.map(x => [x.item_key, x]));
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    const stale = S.items.filter(i => i.status === 'pending' && byKey.has(i.item_key))
      .filter(i => { const c = byKey.get(i.item_key); return !same(i.expected_price, c.expected_price) || !same(i.old_price, c.old_price) || (c.barcode && !same(i.barcode, c.barcode)); });
    for (let k = 0; k < stale.length; k += 20) {
      await Promise.all(stale.slice(k, k + 20).map(async i => {
        const c = byKey.get(i.item_key);
        const patch = { expected_price: c.expected_price, old_price: c.old_price, ...(c.barcode ? { barcode: c.barcode } : {}) };
        const { error } = await sb.from('floor_check_items').update(patch).eq('id', i.id);
        if (!error) Object.assign(i, patch);
      }));
    }
    if (stale.length) showToast(`Updated ${stale.length} item${stale.length === 1 ? '' : 's'} not checked yet (prices / barcodes).`);
    const have = new Set(S.items.map(x => x.item_key));
    S.extra = current.filter(x => !have.has(x.item_key));
  }

  function itemCard(x) {
    const st = STATUSES[x.status];
    const tag = x.priority === 0 ? '<span class="badge warn">Starts or ends today</span>' : '';
    return `<article class="fc-item fc-${st ? st.cls : 'pending'}" data-id="${esc(x.id)}">
      <div class="fc-item-top">
        <div class="fc-item-info">
          <div class="fc-meta"><span class="fc-code">${esc(x.code)}</span>${tag}${x.source === 'promotion' ? '<span class="badge active">Promo</span>' : ''}<span class="fc-so">${esc(x.source_name || '')}</span></div>
          <div class="fc-desc">${esc(x.description || '')}</div>
        </div>
        <div class="fc-price">
          ${x.expected_price === null
            ? `${x.old_price !== null ? `<b>${price(x.old_price)}</b>` : ''}<span class="badge inactive">No new price set</span>`
            : `<b>${price(x.expected_price)}</b>${x.old_price !== null ? `<s>${price(x.old_price)}</s>` : ''}`}
        </div>
      </div>
      <div class="fc-buttons">${Object.entries(STATUSES).map(([k, s]) => `
        <button type="button" data-status="${k}" class="fc-btn fc-btn-${s.cls} ${x.status === k ? 'on' : ''}" aria-pressed="${x.status === k}">
          <span aria-hidden="true">${s.icon}</span>${s.label}</button>`).join('')}
      </div>
      <div class="fc-extra">
        <button type="button" class="link-btn" data-act="note">${x.note ? 'Edit note' : '+ Note'}</button>
        <label class="link-btn fc-photo-btn">${x.photo_path ? 'Replace photo' : '+ Photo'}<input type="file" accept="image/*" capture="environment" data-act="photo" hidden></label>
        ${x.photo_path ? `<img class="fc-thumb" data-photo="${esc(x.photo_path)}" alt="Photo of ${esc(x.code)}">` : ''}
      </div>
      ${x.note ? `<p class="fc-note">${esc(x.note)}</p>` : ''}
    </article>`;
  }

  function wireItem(card, locked) {
    const x = S.items.find(i => i.id === card.dataset.id);
    card.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => {
      if (locked) { showToast('This check is finished.', true); return; }
      const next = x.status === b.dataset.status ? 'pending' : b.dataset.status;   // tap again to undo
      const before = x.status;
      x.status = next;
      renderToday();
      const { error } = await sb.from('floor_check_items').update({ status: next }).eq('id', x.id);
      if (error) { x.status = before; renderToday(); fail('Could not save', error); }
    });
    card.querySelector('[data-act="note"]').onclick = async () => {
      if (locked) { showToast('This check is finished.', true); return; }
      const v = await showPrompt(`Note for ${x.code} — ${x.description || ''}`, { defaultValue: x.note || '', confirmLabel: 'Save note', placeholder: 'e.g. Shelf shows 1.70' });
      if (v === null) return;
      const { error } = await sb.from('floor_check_items').update({ note: v.trim() || null }).eq('id', x.id);
      if (error) return fail('Could not save the note', error);
      x.note = v.trim() || null; renderToday();
    };
    card.querySelector('[data-act="photo"]').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      if (locked) { showToast('This check is finished.', true); return; }
      try {
        const blob = await shrinkPhoto(file);
        const path = `${Session.user.id}/${S.check.id}/${x.id}.jpg`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (error) throw error;
        const { error: e2 } = await sb.from('floor_check_items').update({ photo_path: path }).eq('id', x.id);
        if (e2) throw e2;
        x.photo_path = path; S.photoUrls.delete(path);
        renderToday();
        showToast('Photo saved.');
      } catch (err) { fail('Could not save the photo', err); }
    };
  }

  // Phone photos are large: scale to 1280px on the longest side, JPEG 80%.
  async function shrinkPhoto(file) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not read the photo')), 'image/jpeg', 0.8));
  }
  async function loadPhotoThumbs(root) {
    for (const img of root.querySelectorAll('img[data-photo]')) {
      const path = img.dataset.photo;
      if (!S.photoUrls.has(path)) {
        const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
        S.photoUrls.set(path, data?.signedUrl || '');
      }
      img.src = S.photoUrls.get(path);
      img.onclick = () => window.open(img.src, '_blank', 'noopener');
    }
  }

  async function finishCheck() {
    const c = counts(S.items);
    const msg = c.pending
      ? `${c.pending} item${c.pending === 1 ? ' is' : 's are'} not checked yet. Finish anyway?`
      : `Finish today's check? ${c.problems ? `${c.problems} problem${c.problems === 1 ? '' : 's'} will be sent to the admin.` : 'No problems found.'}`;
    if (!(await showConfirm(msg, 'Finish check'))) return;
    const summary = { total: c.total, ok: c.ok, wrong_price: c.wrong_price, missing_tag: c.missing_tag, out_of_stock: c.out_of_stock, pending: c.pending };
    const { error } = await sb.from('floor_checks').update({ completed_at: new Date().toISOString(), summary }).eq('id', S.check.id);
    if (error) return fail('Could not finish the check', error);
    logActivity('floorcheck', 'finish', { type: 'floor_check', id: S.check.id },
      `Finished the floor check: ${c.ok} correct, ${c.wrong_price} wrong price, ${c.missing_tag} tag missing, ${c.out_of_stock} out of stock${c.pending ? `, ${c.pending} not checked` : ''}`, summary);
    await loadToday();
    S.filter = 'problems';
    render();
    showToast('Check finished. Thank you!');
  }

  /* ---------------- results (admin: all; floor manager: own) ---------------- */
  async function loadResults() {
    const { data, error } = await sb.from('floor_checks').select('*').order('check_date', { ascending: false }).order('started_at', { ascending: false }).limit(60);
    if (error) return fail('Could not load the checks', error);
    S.checks = data;
    if (can('floorcheck.manage')) {
      const { data: ps } = await sb.from('profiles').select('id, username, display_name');
      profileNames = new Map((ps || []).map(p => [p.id, p.display_name || p.username]));
    }
  }
  const whoName = id => id === Session.user.id ? 'You' : (profileNames.get(id) || 'Floor manager');

  function summaryBadges(s) {
    if (!s) return '<span class="badge inactive">In progress</span>';
    return [['wrong_price', 'danger'], ['missing_tag', 'danger'], ['out_of_stock', 'warn']]
      .filter(([k]) => s[k]).map(([k, cls]) => `<span class="badge ${cls}">${s[k]} ${STATUSES[k].label.toLowerCase()}</span>`).join(' ')
      + (s.pending ? ` <span class="badge inactive">${s.pending} not checked</span>` : '')
      + (!s.wrong_price && !s.missing_tag && !s.out_of_stock ? ' <span class="badge active">All correct</span>' : '');
  }

  function renderResults() {
    const body = el('fcBody');
    body.innerHTML = S.checks.length ? S.checks.map(c => `
      <div class="sellout ${S.results.has(c.id) ? 'open' : ''}" data-check="${esc(c.id)}">
        <div class="sellout-head" data-toggle>
          <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
          <div class="who"><div class="name">${esc(fmtDate(c.check_date))}</div><div class="dates">${esc(whoName(c.started_by))}${c.summary ? ` · ${c.summary.total} items` : ''}</div></div>
          <div class="badge-row">${summaryBadges(c.summary)}</div>
        </div>
        <div class="sellout-body">${S.results.has(c.id) ? problemsHtml(S.results.get(c.id)) : ''}</div>
      </div>`).join('')
      : '<div class="empty-state"><p class="big">No checks yet</p></div>';
    body.querySelectorAll('[data-check]').forEach(card => {
      card.querySelector('[data-toggle]').onclick = async () => {
        const id = card.dataset.check;
        if (S.results.has(id)) { S.results.delete(id); renderResults(); return; }
        const { data, error } = await sb.from('floor_check_items').select('*').eq('check_id', id).in('status', PROBLEMS).order('supplier').order('sort_order');
        if (error) return fail('Could not load the problems', error);
        S.results.set(id, data); renderResults();
      };
      card.querySelectorAll('[data-resolve]').forEach(b => b.onclick = ev => { ev.stopPropagation(); resolve(card.dataset.check, b.dataset.resolve); });
      loadPhotoThumbs(card);
    });
  }
  function problemsHtml(items) {
    if (!items.length) return '<p class="empty-note">No problems in this check.</p>';
    return `<div class="items-scroll" style="margin-bottom:0;"><table class="items">
      <thead><tr><th>Problem</th><th>Supplier</th><th>Code</th><th>Description</th><th>From</th><th class="num">Expected</th><th>Note / photo</th><th></th></tr></thead>
      <tbody>${items.map(x => `<tr class="${x.resolved ? 'fc-resolved' : ''}">
        <td><span class="badge ${x.status === 'out_of_stock' ? 'warn' : 'danger'}">${STATUSES[x.status].icon} ${STATUSES[x.status].label}</span></td>
        <td>${esc(supplierOf(x))}</td>
        <td style="font-family:var(--font-mono);">${esc(x.code)}</td>
        <td style="white-space:normal;">${esc(x.description || '')}</td>
        <td>${x.source === 'promotion' ? 'Promo · ' : ''}${esc(x.source_name || '')}</td>
        <td class="num" style="font-family:var(--font-mono);">${price(x.expected_price)}</td>
        <td style="white-space:normal;">${esc(x.note || '')}${x.photo_path ? ` <img class="fc-thumb" data-photo="${esc(x.photo_path)}" alt="Photo">` : ''}</td>
        <td>${can('floorcheck.manage')
          ? `<button class="btn ${x.resolved ? 'ghost' : 'secondary'} small" data-resolve="${esc(x.id)}">${x.resolved ? 'Reopen' : 'Mark resolved'}</button>`
          : (x.resolved ? '<span class="badge active">Resolved</span>' : '')}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }
  async function resolve(checkId, itemId) {
    const x = S.results.get(checkId).find(i => i.id === itemId);
    const on = !x.resolved;
    const { error } = await sb.from('floor_check_items').update({ resolved: on }).eq('id', itemId);
    if (error) return fail('Could not update the problem', error);
    x.resolved = on;
    logActivity('floorcheck', on ? 'resolve' : 'reopen', { type: 'floor_check_item', id: itemId },
      `${on ? 'Resolved' : 'Reopened'} "${STATUSES[x.status].label}" on ${x.code} ${x.description || ''}`.trim(), { check_id: checkId, status: x.status });
    renderResults();
  }

  /* ---------------- repeat problems (admin) ---------------- */
  async function renderRepeats() {
    const body = el('fcBody');
    body.innerHTML = '<p class="muted-note">Loading…</p>';
    const since = addDaysStr(todayStr(), -90);
    const { data: checks } = await sb.from('floor_checks').select('id, check_date').gte('check_date', since);
    const dates = new Map((checks || []).map(c => [c.id, c.check_date]));
    let rows = [];
    if (dates.size) {
      const { data, error } = await sb.from('floor_check_items').select('check_id, code, description, source_name, status')
        .in('check_id', [...dates.keys()]).in('status', PROBLEMS);
      if (error) return fail('Could not load the history', error);
      rows = data;
    }
    const byCode = new Map();
    rows.forEach(r => {
      const k = (r.code || '').trim() || r.description;
      const g = byCode.get(k) || { code: r.code, description: r.description, times: 0, days: new Set(), statuses: {}, last: '', sellouts: new Set() };
      g.times++; g.days.add(dates.get(r.check_id)); g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
      if (dates.get(r.check_id) > g.last) g.last = dates.get(r.check_id);
      if (r.source_name) g.sellouts.add(r.source_name);
      byCode.set(k, g);
    });
    const repeat = [...byCode.values()].filter(g => g.days.size >= 2).sort((a, b) => b.days.size - a.days.size || b.last.localeCompare(a.last));
    body.innerHTML = `<div class="card">
      <h3>Items with problems on 2 or more days (last 90 days)</h3>
      ${repeat.length ? `<div class="items-scroll" style="margin-bottom:0;"><table class="items">
        <thead><tr><th>Code</th><th>Description</th><th class="num">Days</th><th>Problems</th><th>Last seen</th><th>Sell-outs / promotions</th></tr></thead>
        <tbody>${repeat.map(g => `<tr>
          <td style="font-family:var(--font-mono);">${esc(g.code)}</td><td style="white-space:normal;">${esc(g.description || '')}</td>
          <td class="num"><b>${g.days.size}</b></td>
          <td>${Object.entries(g.statuses).map(([s, n]) => `<span class="badge ${s === 'out_of_stock' ? 'warn' : 'danger'}">${n}× ${STATUSES[s].label.toLowerCase()}</span>`).join(' ')}</td>
          <td>${esc(fmtDate(g.last))}</td><td style="white-space:normal;">${esc([...g.sellouts].join(', '))}</td>
        </tr>`).join('')}</tbody></table></div>`
        : '<p class="empty-note" style="margin:0;">No item has come back wrong more than once. </p>'}
    </div>`;
  }

  /* ---------------- shell ---------------- */
  function shell() {
    // floorcheck.do: today's check + own checks; floorcheck.manage: everyone's results + repeat problems.
    const tabs = [can('floorcheck.do') && ['today', "Today's check"], can('floorcheck.do', 'floorcheck.manage') && ['results', can('floorcheck.manage') ? 'Results' : 'My checks']]
      .concat(can('floorcheck.manage') ? [['repeats', 'Repeat problems']] : [])
      .concat(can('rentals.spotcheck', 'rentals.contracts') && window.SpotCheck ? [['spots', 'Rented spots']] : []).filter(Boolean);
    if (!tabs.some(([k]) => k === S.tab)) S.tab = tabs[0][0];
    panel.innerHTML = `<div class="filter-row" id="fcTabs">${tabs.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</div><div id="fcBody"></div>`;
    el('fcTabs').onclick = e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; show(); } };
  }
  function render() {
    panel.querySelectorAll('#fcTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    if (S.tab === 'today') renderToday();
    if (S.tab === 'results') renderResults();
    if (S.tab === 'repeats') renderRepeats();
    if (S.tab === 'spots') SpotCheck.render(el('fcBody'));        // js/modules/spotcheck.js
  }
  async function show() {
    if (!S.started) { S.started = true; shell(); }
    if (S.tab === 'today') { Scanner.warmUp(); await loadToday(); }
    if (S.tab === 'results') await loadResults();
    if (S.tab === 'spots') await SpotCheck.load();
    render();
    if (S.tab === 'today' && S.check && !S.check.completed_at) { await syncOpenCheck(); if (S.tab === 'today') renderToday(); }
  }

  // Admin: a bell notification when someone else finishes a check.
  async function notifyFinishedChecks() {
    if (!can('floorcheck.manage')) return;
    const KEY = 'lv:floorSeen';
    let seen = null; try { seen = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
    const since = seen || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb.from('floor_checks').select('id, started_by, completed_at, summary').gt('completed_at', since).neq('started_by', Session.user.id).order('completed_at');
    if (error || !data?.length) return;
    if (!profileNames.size) { const { data: ps } = await sb.from('profiles').select('id, username, display_name'); profileNames = new Map((ps || []).map(p => [p.id, p.display_name || p.username])); }
    data.forEach(c => {
      const s = c.summary || {};
      pushNotification(`Floor check finished by ${whoName(c.started_by)}: ${s.wrong_price || 0} wrong price, ${s.missing_tag || 0} tag missing, ${s.out_of_stock || 0} out of stock${s.pending ? `, ${s.pending} not checked` : ''}.`);
    });
    try { localStorage.setItem(KEY, data[data.length - 1].completed_at); } catch (e) { /* ignore */ }
  }
  function start() {
    if (!can('floorcheck.manage')) return;
    notifyFinishedChecks();
    setInterval(notifyFinishedChecks, 5 * 60 * 1000);
  }

  window.FloorCheck = { show, start };
})();
