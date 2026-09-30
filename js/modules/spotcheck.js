/* ============================================================
   Floor check › Rented spots (owner, 2026-09-30): the floor manager
   walks the store and confirms every rented spot (end cap, gondola,
   display, screen…) holds the supplier who pays for it — Right
   supplier / Other supplier (who) / Empty — and can report a free
   spot a supplier uses without a contract. No photos.
   A check freezes the rented spots when it starts (spot_checks.items);
   finishing it keeps a summary; the admin is notified (push-alerts).
   Permission: rentals.spotcheck (floor manager by default); the admin
   sees and can edit every check. Migration 019.
   Public API: window.SpotCheck = { load, render }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const S = { floors: [], objects: [], types: {}, contracts: [], vendors: [], open: null, history: [], view: 'todo', detail: null, missing: false, box: null };
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const STATUS = { ok: ['Right supplier', 'active'], other: ['Other supplier', 'danger'], empty: ['Empty', 'warn'], pending: ['To check', 'inactive'] };

  // "by Frying oil": the section of the nearest shelf, so the spot can be found on the floor.
  function nearLabel(o) {
    if (o.label) return '';
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    let best = null, bd = 260;
    S.objects.forEach(f => {
      if (f.floor_id !== o.floor_id || (S.types[f.type] || {}).kind !== 'fixture') return;
      const dx = Math.max(f.x - cx, 0, cx - (f.x + f.w)), dy = Math.max(f.y - cy, 0, cy - (f.y + f.h)), d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = f; }
    });
    if (!best) return '';
    const horiz = best.w >= best.h, pos = horiz ? cx - best.x : cy - best.y, along = horiz ? best.w : best.h;
    const lane = (best.sections_b && best.sections_b.length && (horiz ? cy > best.y + best.h / 2 : cx > best.x + best.w / 2)) ? best.sections_b : (best.sections_a || []);
    if (!lane.length) return best.label || '';
    const total = lane.reduce((s, x) => s + (Number(x.size) || 1), 0) || 1;
    let acc = 0;
    for (const sec of lane) { acc += along * (Number(sec.size) || 1) / total; if (pos <= acc) return sec.label; }
    return lane[lane.length - 1].label;
  }
  const spotInfo = o => ({ spotId: o.id, type: (S.types[o.type] || {}).name || o.type, label: o.label || '',
    floor: (S.floors.find(f => f.id === o.floor_id) || {}).name || '', near: nearLabel(o) });
  const whereHtml = it => `${esc(it.type)}${it.label ? ' · ' + esc(it.label) : ''}${it.near ? ' · by ' + esc(it.near) : ''}${it.floor ? ` <span class="muted-note">${esc(it.floor)}</span>` : ''}`;

  async function load() {
    const today = beirutToday();
    const [fl, ob, cf, ct, open, hist, vd] = await Promise.all([
      sb.from('store_floors').select('id, name, sort').order('sort'),
      sb.from('store_map_objects').select('id, floor_id, type, x, y, w, h, label, sections_a, sections_b'),
      sb.from('store_map_config').select('types').eq('id', 'singleton').maybeSingle(),
      sb.from('rental_contracts').select('id, spot_id, supplier, start_date, end_date').lte('start_date', today).gte('end_date', today),
      sb.from('spot_checks').select('*').is('completed_at', null).maybeSingle(),
      sb.from('spot_checks').select('*').not('completed_at', 'is', null).order('completed_at', { ascending: false }).limit(12),
      S.vendors.length ? { data: null } : sb.from('vendors').select('name').order('name'),
    ]);
    S.missing = !!(open.error || hist.error);
    S.floors = fl.data || []; S.objects = ob.data || [];
    S.types = Object.assign({}, (window.StoreMap && StoreMap.DEFAULT_TYPES) || {}, (cf.data && cf.data.types) || {});
    S.contracts = ct.data || [];
    S.open = open.data || null; S.history = hist.data || [];
    if (vd.data) S.vendors = [...new Set(vd.data.map(v => String(v.name || '').trim()).filter(Boolean))];
  }

  // Rented spots now = current contracts placed on the map (one line per spot; several suppliers joined).
  function currentRented() {
    const bySpot = new Map();
    S.contracts.forEach(c => { if (c.spot_id) { const l = bySpot.get(c.spot_id) || []; l.push(c); bySpot.set(c.spot_id, l); } });
    const floorSort = new Map(S.floors.map((f, i) => [f.id, i]));
    return S.objects.filter(o => bySpot.has(o.id))
      .sort((a, b) => (floorSort.get(a.floor_id) ?? 9) - (floorSort.get(b.floor_id) ?? 9) || Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x)
      .map(o => ({ ...spotInfo(o), contractId: bySpot.get(o.id)[0].id, supplier: [...new Set(bySpot.get(o.id).map(c => c.supplier))].join(' / '), status: 'pending', found: '', note: '' }));
  }
  const freeSpots = () => {
    const taken = new Set(S.contracts.map(c => c.spot_id));
    const used = new Set((S.open?.extra || []).map(x => x.spotId));
    return S.objects.filter(o => (S.types[o.type] || {}).rentable && !taken.has(o.id) && !used.has(o.id)).map(spotInfo);
  };
  function summaryOf(chk) {
    const c = k => chk.items.filter(i => i.status === k).length;
    return { total: chk.items.length, ok: c('ok'), other: c('other'), empty: c('empty'), pending: c('pending'), extra: (chk.extra || []).length };
  }

  /* ---------------- render ---------------- */
  function render(box) {
    S.box = box || S.box;
    if (S.missing) { S.box.innerHTML = '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> Rented spot checks work once migration 019 is applied.</p></div>'; return; }
    if (S.detail) return renderDetail();
    if (S.open) return renderOpen();
    const rented = currentRented();
    S.box.innerHTML = `
      <div class="card">
        <h3 style="margin:0 0 6px;">Rented spot check</h3>
        <p class="muted-note" style="margin:0 0 14px;">Walk the store and confirm every rented spot holds the supplier who pays for it. ${rented.length} spot${rented.length === 1 ? ' is' : 's are'} rented now.</p>
        ${can('rentals.spotcheck') ? `<button class="btn" id="scStart" ${rented.length ? '' : 'disabled'}>Start a check</button>` : ''}
      </div>
      ${historyHtml()}`;
    S.box.querySelector('#scStart')?.addEventListener('click', start);
    wireHistory();
  }
  function historyHtml() {
    if (!S.history.length) return '';
    return `<div class="card"><h3 style="margin:0 0 10px;">Previous checks</h3><div class="items-scroll" style="margin-bottom:0;"><table class="items">
      <thead><tr><th>Finished</th><th>By</th><th class="num">Right</th><th class="num">Other supplier</th><th class="num">Empty</th><th class="num">No contract</th><th class="num">Not checked</th><th></th></tr></thead>
      <tbody>${S.history.map(h => { const s = h.summary || summaryOf(h); return `<tr>
        <td>${fmt(h.completed_at)}</td><td>${esc(h.started_by_name || '')}</td>
        <td class="num">${s.ok}</td><td class="num" style="color:${s.other ? 'var(--brick)' : 'inherit'}">${s.other}</td>
        <td class="num" style="color:${s.empty ? 'var(--gold)' : 'inherit'}">${s.empty}</td><td class="num" style="color:${s.extra ? 'var(--brick)' : 'inherit'}">${s.extra}</td>
        <td class="num">${s.pending || 0}</td><td><button class="btn ghost small" data-detail="${h.id}">Details</button></td></tr>`; }).join('')}</tbody></table></div></div>`;
  }
  function wireHistory() { S.box.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => { S.detail = S.history.find(h => h.id === b.dataset.detail); render(); }); }

  function itemHtml(it, i, readOnly) {
    const [label, cls] = STATUS[it.status] || STATUS.pending;
    return `<li class="sc-item ${it.status}" data-i="${i}">
      <div class="sc-main"><b>${esc(it.supplier)}</b><div class="sc-where">${whereHtml(it)}</div>
        ${it.status === 'other' ? `<div class="sc-found">Found: <b>${esc(it.found || '?')}</b></div>` : ''}${it.note ? `<div class="muted-note">${esc(it.note)}</div>` : ''}</div>
      ${readOnly ? `<span class="badge ${cls}">${label}</span>` : `<div class="sc-btns">
        <button type="button" class="sc-btn ok ${it.status === 'ok' ? 'on' : ''}" data-set="ok" title="The right supplier is there">✓ Right</button>
        <button type="button" class="sc-btn other ${it.status === 'other' ? 'on' : ''}" data-set="other" title="Another supplier is using it">Other</button>
        <button type="button" class="sc-btn empty ${it.status === 'empty' ? 'on' : ''}" data-set="empty" title="Nobody's products there">Empty</button>
        <button type="button" class="sc-btn note" data-set="note" title="Add a note">✎</button></div>`}
    </li>`;
  }
  function renderOpen() {
    const chk = S.open, s = summaryOf(chk), mine = can('rentals.spotcheck');
    const list = chk.items.map((it, i) => [it, i]).filter(([it]) => S.view === 'all' || (S.view === 'todo' ? it.status === 'pending' : ['other', 'empty'].includes(it.status)));
    const free = freeSpots();
    S.box.innerHTML = `
      <div class="card sc-head">
        <div><h3 style="margin:0;">Rented spot check</h3><span class="muted-note">Started ${fmt(chk.started_at)} by ${esc(chk.started_by_name || '')}</span></div>
        <div class="sc-progress"><div class="sc-bar"><i style="width:${s.total ? Math.round((s.total - s.pending) / s.total * 100) : 0}%"></i></div>
          <span><b>${s.total - s.pending}</b> of ${s.total} checked · <span style="color:var(--brick)">${s.other} other</span> · <span style="color:var(--gold)">${s.empty} empty</span> · ${s.extra} without contract</span></div>
        ${mine ? '<button class="btn small" id="scFinish">Finish check</button>' : ''}
      </div>
      <div class="filter-row" id="scView">
        ${[['todo', `To check (${s.pending})`], ['problems', `Problems (${s.other + s.empty})`], ['all', `All (${s.total})`]].map(([k, l]) => `<button data-view="${k}" class="${S.view === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="card"><ul class="sc-list" id="scList">${list.map(([it, i]) => itemHtml(it, i, !mine)).join('') || `<li class="muted-note" style="padding:10px 0;">${S.view === 'todo' ? 'Everything is checked — finish the check.' : 'Nothing here.'}</li>`}</ul></div>
      <div class="card">
        <h3 style="margin:0 0 4px;">Used without a contract</h3>
        <p class="muted-note" style="margin:0 0 10px;">A supplier's products on a spot nobody rents? Report it here.</p>
        <ul class="sc-list">${(chk.extra || []).map((x, i) => `<li class="sc-item other"><div class="sc-main"><b>${esc(x.found)}</b><div class="sc-where">${whereHtml(x)}</div>${x.note ? `<div class="muted-note">${esc(x.note)}</div>` : ''}</div>
          ${mine ? `<button class="btn ghost small" data-unextra="${i}">Remove</button>` : ''}</li>`).join('')}</ul>
        ${mine ? `<div class="sc-extra-add">
          <select id="scFree"><option value="">Choose the free spot…</option>${free.map(f => `<option value="${esc(f.spotId)}">${esc(f.floor)} · ${esc(f.type)}${f.label ? ' ' + esc(f.label) : ''}${f.near ? ' · by ' + esc(f.near) : ''}</option>`).join('')}</select>
          <input id="scFreeWho" list="scVendors" placeholder="Supplier using it"><datalist id="scVendors">${S.vendors.map(v => `<option value="${esc(v)}">`).join('')}</datalist>
          <button class="btn small secondary" id="scAddExtra">Report</button></div>` : ''}
      </div>`;
    S.box.querySelector('#scView').onclick = e => { const b = e.target.closest('[data-view]'); if (b) { S.view = b.dataset.view; renderOpen(); } };
    S.box.querySelector('#scFinish')?.addEventListener('click', finish);
    S.box.querySelector('#scList').onclick = e => { const b = e.target.closest('[data-set]'); if (b) setStatus(Number(b.closest('[data-i]').dataset.i), b.dataset.set); };
    S.box.querySelector('#scAddExtra')?.addEventListener('click', addExtra);
    S.box.querySelectorAll('[data-unextra]').forEach(b => b.onclick = () => { chk.extra.splice(Number(b.dataset.unextra), 1); save(); renderOpen(); });
  }
  function renderDetail() {
    const h = S.detail, s = h.summary || summaryOf(h);
    S.box.innerHTML = `
      <div class="card sc-head"><div><h3 style="margin:0;">Spot check of ${fmt(h.completed_at)}</h3><span class="muted-note">By ${esc(h.started_by_name || '')} · ${s.ok} right · ${s.other} other supplier · ${s.empty} empty · ${s.extra} without contract${s.pending ? ` · ${s.pending} not checked` : ''}</span></div>
        <button class="btn ghost small" id="scBack">Back</button></div>
      <div class="card"><h3 style="margin:0 0 8px;">Problems</h3><ul class="sc-list">${h.items.map((it, i) => [it, i]).filter(([it]) => it.status !== 'ok').map(([it, i]) => itemHtml(it, i, true)).join('') || '<li class="muted-note">None — every rented spot had the right supplier.</li>'}</ul></div>
      ${(h.extra || []).length ? `<div class="card"><h3 style="margin:0 0 8px;">Used without a contract</h3><ul class="sc-list">${h.extra.map(x => `<li class="sc-item other"><div class="sc-main"><b>${esc(x.found)}</b><div class="sc-where">${whereHtml(x)}</div></div></li>`).join('')}</ul></div>` : ''}`;
    S.box.querySelector('#scBack').onclick = () => { S.detail = null; render(); };
  }

  /* ---------------- actions ---------------- */
  async function start() {
    const items = currentRented();
    const { data, error } = await sb.from('spot_checks').insert({ items, extra: [] }).select().single();
    if (error) { if (/duplicate|unique/i.test(error.message)) { await load(); return render(); } return showToast('Could not start — ' + friendlyError(error), true); }
    S.open = data; S.view = 'todo';
    logActivity('rentals', 'spotcheck_start', { type: 'spot_check', id: data.id }, `Started a rented spot check (${items.length} spots)`);
    render();
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const { error } = await sb.from('spot_checks').update({ items: S.open.items, extra: S.open.extra }).eq('id', S.open.id);
      if (error) showToast('Not saved — ' + friendlyError(error), true);
    }, 300);
  }
  async function setStatus(i, st) {
    const it = S.open.items[i];
    if (st === 'note') {
      const v = await showPrompt(`Note for ${it.supplier} (${it.type}${it.label ? ' ' + it.label : ''}):`, { defaultValue: it.note || '', confirmLabel: 'Save note' });
      if (v === null) return; it.note = v.trim();
    } else if (st === 'other') {
      const v = await showPrompt(`Which supplier is using the ${it.type}${it.label ? ' ' + it.label : ''} instead of ${it.supplier}?`, { defaultValue: it.found || '', confirmLabel: 'Save', placeholder: 'Supplier name' });
      if (v === null) return;
      it.status = 'other'; it.found = v.trim(); it.at = new Date().toISOString();
    } else { it.status = it.status === st ? 'pending' : st; it.found = ''; it.at = new Date().toISOString(); }
    save(); renderOpen();
  }
  function addExtra() {
    const id = document.getElementById('scFree').value, who = document.getElementById('scFreeWho').value.trim();
    if (!id) return showToast('Choose the spot.', true);
    if (!who) return showToast('Type the supplier using it.', true);
    const o = S.objects.find(x => x.id === id);
    S.open.extra = S.open.extra || [];
    S.open.extra.push({ ...spotInfo(o), found: who, note: '', at: new Date().toISOString() });
    save(); renderOpen();
  }
  async function finish() {
    const s = summaryOf(S.open);
    if (s.pending && !(await showConfirm(`${s.pending} spot${s.pending === 1 ? ' is' : 's are'} not checked yet. Finish anyway?`, 'Finish'))) return;
    clearTimeout(saveTimer);
    const summary = summaryOf(S.open);
    const { error } = await sb.from('spot_checks').update({ items: S.open.items, extra: S.open.extra, summary, completed_at: new Date().toISOString() }).eq('id', S.open.id);
    if (error) return showToast('Could not finish — ' + friendlyError(error), true);
    logActivity('rentals', 'spotcheck_finish', { type: 'spot_check', id: S.open.id }, `Rented spot check finished: ${summary.ok} right, ${summary.other} other supplier, ${summary.empty} empty, ${summary.extra} without contract`, summary);
    showToast('Check finished. The admin is notified.');
    await load(); render();
  }

  window.SpotCheck = { load, render, _state: S };
})();
