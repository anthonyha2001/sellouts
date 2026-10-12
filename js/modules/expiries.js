/* ============================================================
   Expiries (owner, 2026-10-12): the items on the shelves that expire soon, one card per month.
   The floor manager (expiry.manage) adds them fast, made for the phone: scan (or type) the item, tap the month(s)
   it expires in — one entry can have several dates, each with its day and quantity if wanted — the shelf, and
   the shelf worker (suggested from the sections they look after). "Save & next item" keeps the shelf and the
   worker for the next scan. In a month, each item is given (or given again) to a shelf worker right in the list,
   or all the ones not given yet at once. The shelf worker (expiry.work) sees only theirs and marks each one done:
   removed, on discount, returned, sold out. Table public.expiries; shelf workers from expiry_workers()
   (migration 084). Items from the system: lv-dashboard items_lookup / item_search.
   Public API: window.Expiries = { show, start, refresh }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const OUT = { removed: 'Removed', discount: 'On discount', returned: 'Returned', sold: 'Sold out' };
  const OUT_LONG = { removed: 'Removed from the shelf', discount: 'Put on discount', returned: 'Returned to the supplier', sold: 'Sold before it expired', other: 'Done' };
  const S = { rows: null, workers: [], loading: false, err: '', month: null, who: 'all', status: 'open', lastWorker: '', lastLoc: '' };
  const isMgr = () => can('expiry.manage');
  const call = async body => { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error) throw error; if (data?.error) throw new Error(data.error); return data; };
  const fq = v => (Math.round(Number(v) * 100) / 100).toLocaleString('en-US');
  const ymOf = d => String(d || '').slice(0, 7);
  const curYm = () => ymOf(todayStr());
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5)) - Number(a.slice(5));
  const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const monthName = ym => MONTH[Number(ym.slice(5)) - 1];
  const daysTo = d => Math.round((new Date(d + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5);
  const urg = r => { const n = daysTo(r.expiry_date); return n < 0 ? 'past' : n <= 7 ? 'week' : n <= 31 ? 'soon' : 'later'; };
  const initials = n => String(n || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  const shortDay = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const byDate = (a, b) => a.expiry_date.localeCompare(b.expiry_date) || String(a.description || '').localeCompare(String(b.description || ''));
  // a shelf worker: from Staff (staff_id) or an app user with the Shelf worker role (u:<user id>)
  const wKey = w => w.staff_id || (w.user_id ? 'u:' + w.user_id : '');
  const rowKey = r => r.assigned_staff || (r.assigned_user ? 'u:' + r.assigned_user : '');
  const keyPatch = k => !k ? { assigned_staff: null, assigned_user: null } : k.startsWith('u:') ? { assigned_staff: null, assigned_user: k.slice(2) } : { assigned_staff: k, assigned_user: null };
  const ICON = {
    scan: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  /* ---------------- data ---------------- */
  async function load() {
    S.loading = true; S.err = '';
    if (!S.rows) paint();
    try {
      // what is still open, and what was done in the last 90 days
      const since = addDaysStr(todayStr(), -90);
      const [r, w] = await Promise.all([
        sb.from('expiries').select('*').or(`status.eq.open,done_at.gte.${since}`).order('expiry_date').limit(5000),
        isMgr() ? sb.rpc('expiry_workers') : Promise.resolve({ data: [] }),
      ]);
      if (r.error) throw r.error;
      S.rows = r.data || [];
      S.workers = w.error ? [] : (w.data || []);
    } catch (e) {
      const m = friendlyError(e);
      S.err = /expiries|relation|does not exist|schema cache/i.test(m) ? 'The expiries are not set up yet: run migration 084 in Supabase.' : m;
    }
    S.loading = false;
    pill(); paint();
  }
  // the menu badge: what is expired or expires within 7 days, still open
  function pill() {
    const p = el('expiriesPill'); if (!p) return;
    const n = (S.rows || []).filter(r => r.status === 'open' && daysTo(r.expiry_date) <= 7).length;
    p.textContent = n; p.hidden = !n;
  }
  const whoRows = () => (S.rows || []).filter(r => S.who === 'all' ? true : S.who === 'none' ? !rowKey(r) : rowKey(r) === S.who);
  function replaceRow(row) { const i = S.rows.findIndex(x => x.id === row.id); if (i >= 0) S.rows[i] = row; else S.rows.push(row); }
  async function patch(ids, change) {
    const { data, error } = await sb.from('expiries').update(change).in('id', ids).select();
    if (error) { showToast(friendlyError(error), true); return load(); }
    (data || []).forEach(replaceRow);
    pill(); paint();
    return data;
  }

  /* ---------------- the page ---------------- */
  function paint() {
    const box = el('panel-expiries'); if (!box) return;
    if (S.err && !S.rows) { box.innerHTML = `<div class="card"><p class="empty-note" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    if (!S.rows) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading the expiries…</p></div>'; return; }
    if (S.month) paintMonth(box); else paintMonths(box);
  }

  function whoSelect() {
    if (!isMgr()) return '';
    const opts = [['all', 'Everyone'], ['none', 'Not given yet'], ...S.workers.map(w => [wKey(w), w.name])];
    return `<select class="ex-who" data-ex="who" aria-label="Shelf worker">${opts.map(([v, l]) => `<option value="${esc(v)}" ${S.who === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  function topBar() {
    return isMgr()
      ? `<div class="ex-top"><button type="button" class="btn ex-addbtn" data-ex="add">+ Add expiry</button>
          <button type="button" class="btn secondary ex-scanbtn" data-ex="scan">${ICON.scan}<span>Scan</span></button><span class="ex-sp"></span>${whoSelect()}</div>`
      : '<p class="muted-note ex-intro">The expiries given to you. Open a month and mark each item when it is done.</p>';
  }

  function paintMonths(box) {
    const rows = whoRows(), cur = curYm();
    const open = rows.filter(r => r.status === 'open');
    const expired = open.filter(r => daysTo(r.expiry_date) < 0).length;
    const week = open.filter(r => { const n = daysTo(r.expiry_date); return n >= 0 && n <= 7; }).length;
    const notGiven = open.filter(r => !rowKey(r)).length;
    const earlier = rows.filter(r => ymOf(r.expiry_date) < cur && r.status === 'open');
    // the months: this one and the next 5 always (the manager's frame), then any later month that has items
    const keys = new Set([0, 1, 2, 3, 4, 5].map(n => addMonths(cur, n)));
    rows.forEach(r => { const k = ymOf(r.expiry_date); if (k >= cur) keys.add(k); });
    if (!isMgr()) [...keys].forEach(k => { if (k !== cur && !rows.some(r => ymOf(r.expiry_date) === k)) keys.delete(k); });
    box.innerHTML = `${topBar()}
      <div class="ex-sum">
        <span><b>${open.length}</b> to deal with</span>
        ${expired ? `<span class="ex-s-past"><b>${expired}</b> expired</span>` : ''}
        ${week ? `<span class="ex-s-week"><b>${week}</b> within 7 days</span>` : ''}
        ${isMgr() && notGiven ? `<button type="button" class="ex-s-none" data-ex="filternone"><b>${notGiven}</b> not given yet</button>` : ''}
        ${S.loading ? '<span class="muted-note">updating…</span>' : ''}
      </div>
      <div class="ex-months">${earlier.length ? monthCard('past', earlier) : ''}${[...keys].sort().map(k => monthCard(k, rows.filter(r => ymOf(r.expiry_date) === k))).join('')}</div>
      ${!rows.length && isMgr() ? '<p class="muted-note ex-hint">Tap <b>+ Add expiry</b> (or <b>Scan</b>), then the month it expires in. That is all it needs.</p>' : ''}`;
  }

  function monthCard(k, list) {
    const cur = curYm(), open = list.filter(r => r.status === 'open').sort(byDate), done = list.length - open.length;
    const diff = k === 'past' ? -1 : monthsBetween(cur, k);
    const tone = k === 'past' ? 'past' : diff === 0 ? 'now' : diff === 1 ? 'next' : 'later';
    const rel = k === 'past' ? 'expired' : diff === 0 ? 'this month' : diff === 1 ? 'next month' : `in ${diff} months`;
    const units = open.reduce((s, r) => s + Number(r.qty || 0), 0);
    const notGiven = open.filter(r => !rowKey(r)).length;
    return `<button type="button" class="ex-month t-${tone}" data-ex-month="${k}">
      <div class="ex-mh"><div class="ex-mt"><b>${k === 'past' ? 'Expired' : monthName(k)}</b><span>${k === 'past' ? 'before ' + monthName(cur) : k.slice(0, 4)}</span></div><em>${rel}</em></div>
      <div class="ex-mn"><strong>${open.length}</strong><span>${open.length === 1 ? 'item' : 'items'} to deal with${units ? `<br>${fq(units)} pcs` : ''}</span></div>
      ${list.length ? `<div class="ex-bar" title="${done} of ${list.length} done"><i style="width:${Math.round(done / list.length * 100)}%"></i></div>` : ''}
      <ul class="ex-mlist">${open.slice(0, 3).map(r => `<li><span class="ex-d u-${urg(r)}">${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</span><span class="ex-desc">${esc(r.description || r.code)}</span>${r.assigned_name && isMgr() ? `<i title="${esc(r.assigned_name)}">${esc(initials(r.assigned_name))}</i>` : ''}</li>`).join('')
        || `<li class="ex-none">${list.length ? 'All done ✓' : 'Nothing yet'}</li>`}</ul>
      <div class="ex-mf">${open.length > 3 ? `<span>+${open.length - 3} more</span>` : ''}${isMgr() && notGiven ? `<span class="ex-warn">${notGiven} not given</span>` : ''}${done ? `<span class="ex-ok">${done} done</span>` : ''}</div>
    </button>`;
  }

  function workerOpts(sel, r) {
    const list = S.workers.map(w => [wKey(w), w.name]);
    if (sel && !list.some(([k]) => k === sel) && r?.assigned_name) list.push([sel, r.assigned_name]);
    return `<option value="">Not given yet</option>${list.map(([k, n]) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  }

  function paintMonth(box) {
    const k = S.month, cur = curYm();
    let list = whoRows().filter(r => k === 'past' ? ymOf(r.expiry_date) < cur && r.status === 'open' : ymOf(r.expiry_date) === k);
    const nOpen = list.filter(r => r.status === 'open').length, nDone = list.length - nOpen;
    if (S.status !== 'all') list = list.filter(r => r.status === S.status);
    list.sort(byDate);
    const notGiven = list.filter(r => r.status === 'open' && !rowKey(r));
    const title = k === 'past' ? 'Expired' : `${monthName(k)} <span>${k.slice(0, 4)}</span>`;
    box.innerHTML = `<div class="ex-top"><button type="button" class="btn ghost small" data-ex="back">‹ All months</button>
        <h3 class="ex-title">${title}</h3><span class="ex-sp"></span>
        ${isMgr() ? `<button type="button" class="btn secondary ex-scanbtn" data-ex="scan">${ICON.scan}<span>Scan</span></button><button type="button" class="btn ex-addbtn" data-ex="add">+ Add expiry</button>` : ''}</div>
      <div class="ex-tools">
        <div class="filter-row ex-seg">${[['open', `To deal with · ${nOpen}`], ['done', `Done · ${nDone}`], ['all', 'All']].map(([v, l]) => `<button type="button" data-ex-status="${v}" class="${S.status === v ? 'active' : ''}">${l}</button>`).join('')}</div>
        ${whoSelect()}
        ${isMgr() && notGiven.length && S.workers.length ? `<select class="ex-giveall" data-ex="giveall" aria-label="Give the items not given yet"><option value="">Give the ${notGiven.length} not given to…</option>${S.workers.map(w => `<option value="${esc(wKey(w))}">${esc(w.name)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="ex-list">${list.map(itemHtml).join('') || `<p class="empty-note ex-empty">${S.status === 'done' ? 'Nothing done yet in this month.' : nOpen || nDone ? 'Everything here is done ✓' : 'Nothing expires in this month yet.'}</p>`}</div>`;
  }

  function itemHtml(r) {
    const done = r.status === 'done', n = daysTo(r.expiry_date);
    const when = done ? '' : n < 0 ? `Expired ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'Expires today' : n === 1 ? 'Expires tomorrow'
      : r.day_known ? `In ${n} days` : `By the end of ${monthName(ymOf(r.expiry_date))}`;
    const meta = [`<span class="mono">${esc(r.code)}</span>`, r.qty !== null && r.qty !== undefined ? `<b>${fq(r.qty)}</b> pcs` : '', r.location ? `Shelf ${esc(r.location)}` : '', r.supplier ? esc(r.supplier) : ''].filter(Boolean).join(' · ');
    const who = isMgr()
      ? `<select class="ex-give" data-ex-give="${r.id}" aria-label="Shelf worker" ${done ? 'disabled' : ''}>${workerOpts(rowKey(r), r)}</select>`
      : '';
    const acts = done
      ? `<div class="ex-doneline">✓ ${esc(OUT_LONG[r.outcome] || 'Done')}${r.done_by_name ? ' · ' + esc(r.done_by_name) : ''}${r.done_at ? ' · ' + esc(shortDay(r.done_at)) : ''}<button type="button" class="ex-undo" data-ex-undo="${r.id}">Undo</button></div>`
      : `<div class="ex-outs">${Object.entries(OUT).map(([o, l]) => `<button type="button" class="ex-out" data-ex-done="${r.id}" data-o="${o}">${l}</button>`).join('')}</div>`;
    return `<article class="ex-item u-${done ? 'done' : urg(r)}" data-id="${r.id}">
      <div class="ex-date"><b>${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</b><span>${MON[Number(r.expiry_date.slice(5, 7)) - 1]}</span></div>
      <div class="ex-body">
        <div class="ex-name">${esc(r.description || r.code)}</div>
        <div class="ex-meta">${meta}</div>
        ${when ? `<div class="ex-when">${when}</div>` : ''}
        ${r.note ? `<div class="ex-note">${esc(r.note)}</div>` : ''}
        <div class="ex-acts">${who}${acts}</div>
      </div>
      ${isMgr() ? `<div class="ex-icons"><button type="button" class="vb-ico" data-ex-edit="${r.id}" aria-label="Edit" data-tip="Edit">${ICON.edit}</button><button type="button" class="vb-ico vb-x" data-ex-del="${r.id}" aria-label="Delete" data-tip="Delete">${ICON.del}</button></div>` : ''}
    </article>`;
  }

  function wire() {
    const box = el('panel-expiries'); if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('click', async e => {
      const t = e.target.closest('[data-ex], [data-ex-month], [data-ex-status], [data-ex-done], [data-ex-undo], [data-ex-edit], [data-ex-del]'); if (!t) return;
      const a = t.dataset.ex;
      if (a === 'add') return openAdd({ month: S.month });
      if (a === 'scan') return openAdd({ month: S.month, scan: true });
      if (a === 'back') { S.month = null; return paint(); }
      if (a === 'filternone') { S.who = 'none'; return paint(); }
      if (t.dataset.exMonth) { S.month = t.dataset.exMonth; S.status = 'open'; paint(); return window.scrollTo({ top: 0 }); }
      if (t.dataset.exStatus) { S.status = t.dataset.exStatus; return paint(); }
      const row = S.rows.find(x => x.id === (t.dataset.exDone || t.dataset.exUndo || t.dataset.exEdit || t.dataset.exDel)); if (!row) return;
      if (t.dataset.exDone) {
        const out = await patch([row.id], { status: 'done', outcome: t.dataset.o });
        if (out) { showToast(`${row.description || row.code}: ${OUT_LONG[t.dataset.o].toLowerCase()}.`); logActivity('expiries', 'done', { type: 'expiry', id: row.id }, `Expiry ${OUT_LONG[t.dataset.o].toLowerCase()}: ${row.description || row.code} (${row.expiry_date})`); }
        return;
      }
      if (t.dataset.exUndo) { const out = await patch([row.id], { status: 'open' }); if (out) logActivity('expiries', 'undo', { type: 'expiry', id: row.id }, `Expiry back to do: ${row.description || row.code}`); return; }
      if (t.dataset.exEdit) return openAdd({ edit: row });
      if (t.dataset.exDel) {
        if (!(await showConfirm(`Delete the expiry of "${row.description || row.code}" (${row.day_known ? fmtDate(row.expiry_date) : monthName(ymOf(row.expiry_date)) + ' ' + row.expiry_date.slice(0, 4)})?`, 'Delete'))) return;
        const { error } = await sb.from('expiries').delete().eq('id', row.id);
        if (error) return showToast(friendlyError(error), true);
        S.rows = S.rows.filter(x => x.id !== row.id); pill(); paint();
        logActivity('expiries', 'delete', { type: 'expiry', id: row.id }, `Deleted the expiry of ${row.description || row.code} (${row.expiry_date})`);
      }
    });
    box.addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.ex === 'who') { S.who = t.value; return paint(); }
      if (t.dataset.exGive !== undefined) {
        const row = S.rows.find(x => x.id === t.dataset.exGive); if (!row) return;
        const out = await patch([row.id], keyPatch(t.value));
        if (out && out[0]) { showToast(out[0].assigned_name ? `Given to ${out[0].assigned_name}.` : 'Not given to anyone now.'); logActivity('expiries', 'give', { type: 'expiry', id: row.id }, `Expiry of ${row.description || row.code} given to ${out[0].assigned_name || 'nobody'}`); }
        return;
      }
      if (t.dataset.ex === 'giveall' && t.value) {
        const cur = curYm(), k = S.month;
        const ids = whoRows().filter(r => r.status === 'open' && !rowKey(r) && (k === 'past' ? ymOf(r.expiry_date) < cur : ymOf(r.expiry_date) === k)).map(r => r.id);
        if (!ids.length) return;
        const out = await patch(ids, keyPatch(t.value));
        if (out && out[0]) { showToast(`${out.length} item${out.length === 1 ? '' : 's'} given to ${out[0].assigned_name}.`); logActivity('expiries', 'give', { type: 'expiry', id: k }, `${out.length} expiries of ${k} given to ${out[0].assigned_name}`); }
      }
    });
  }

  /* ---------------- add / edit: scan, tap the month(s), tap the worker, save ---------------- */
  let F = null;
  function openAdd(opts = {}) {
    const ed = opts.edit || null;
    F = {
      ed,
      item: ed ? { code: ed.code, description: ed.description || '', barcode: ed.barcode || '', supplier: ed.supplier || '', group: ed.item_group || '' } : null,
      dates: ed ? [{ ym: ymOf(ed.expiry_date), day: ed.day_known ? Number(ed.expiry_date.slice(8)) : 0, qty: ed.qty ?? '' }]
        : opts.month && opts.month !== 'past' ? [{ ym: opts.month, day: 0, qty: '' }] : [],
      worker: ed ? rowKey(ed) : S.lastWorker, picked: !!ed, suggested: '',
      choices: null, msg: '', busy: false, saving: false,
    };
    el('exAddOv')?.remove();
    const locs = [...new Set((S.rows || []).map(r => r.location).filter(Boolean))].sort();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="exAddOv"><div class="modal-box ex-add" role="dialog" aria-modal="true" aria-label="${ed ? 'Edit expiry' : 'Add expiry'}">
      <div class="ex-addhead"><h3>${ed ? 'Edit expiry' : 'Add expiry'}</h3><button type="button" class="icon-btn" data-x="close" aria-label="Close" title="Close (Esc)">${ICON.close}</button></div>
      <div class="ex-addbody">
        <section><label for="exQ">Item</label>
          ${ed ? '' : `<div class="ex-find"><input type="search" id="exQ" placeholder="Scan, or type a barcode, code or name" autocomplete="off" enterkeyhint="search">
            <button type="button" class="btn ex-scan" data-x="scan">${ICON.scan}<span>Scan</span></button></div>`}
          <div id="exItem"></div></section>
        <section><label>Expires in <span class="muted-note">${ed ? 'tap the month' : 'tap each month it has — several dates are fine'}</span></label>
          <div class="ex-chips ex-mchips" id="exMonthChips"></div>
          <div id="exDates"></div></section>
        <section><label for="exLoc">Shelf <span class="muted-note">(optional)</span></label>
          <input type="text" id="exLoc" list="exLocs" placeholder="e.g. Aisle 4" value="${esc(ed ? ed.location || '' : S.lastLoc)}" autocomplete="off">
          <datalist id="exLocs">${locs.map(l => `<option value="${esc(l)}">`).join('')}</datalist></section>
        <section><label>Give to <span class="muted-note" id="exSugg"></span></label><div class="ex-chips ex-wchips" id="exWorkers"></div></section>
        <section><label for="exNote">Note <span class="muted-note">(optional)</span></label>
          <input type="text" id="exNote" placeholder="e.g. 3 packs damaged" value="${esc(ed ? ed.note || '' : '')}" autocomplete="off"></section>
      </div>
      <div class="ex-addfoot">${ed ? '<button type="button" class="btn ghost" data-x="close">Cancel</button><button type="button" class="btn" data-x="save">Save</button>'
        : '<button type="button" class="btn secondary" data-x="saveclose">Save & close</button><button type="button" class="btn" data-x="savenext">Save & next item</button>'}</div>
    </div></div>`);
    const ov = el('exAddOv');
    ov.addEventListener('mousedown', e => { if (e.target === ov) closeAdd(); });
    ov.addEventListener('click', e => {
      const t = e.target.closest('[data-x], [data-ym], [data-w], [data-pick], [data-rm]'); if (!t) return;
      if (t.dataset.x === 'close') return closeAdd();
      if (t.dataset.x === 'scan') return scan();
      if (t.dataset.x === 'save' || t.dataset.x === 'saveclose') return save(false);
      if (t.dataset.x === 'savenext') return save(true);
      if (t.dataset.x === 'more') { F.more = true; return paintMonthChips(); }
      if (t.dataset.ym) return addDate(t.dataset.ym);
      if (t.dataset.rm !== undefined) { F.dates.splice(Number(t.dataset.rm), 1); return paintDates(); }
      if (t.dataset.w !== undefined) { F.worker = F.worker === t.dataset.w && t.dataset.w ? '' : t.dataset.w; F.picked = true; return paintWorkers(); }
      if (t.dataset.pick) return find(t.dataset.pick, true);
    });
    ov.addEventListener('input', e => {
      const i = e.target.closest('[data-di]'); if (!i) return;
      const d = F.dates[Number(i.dataset.di)]; if (!d) return;
      if (i.dataset.f === 'day') d.day = Number(i.value) || 0; else d.qty = i.value;
    });
    el('exQ')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); find(e.target.value); } });
    document.addEventListener('keydown', onKey);
    paintItem(); paintMonthChips(); paintDates(); paintWorkers();
    if (opts.scan) scan();
    else if (!ed && window.matchMedia('(pointer:fine)').matches) setTimeout(() => el('exQ')?.focus(), 30);   // a desktop with a barcode gun: ready to scan
  }
  const onKey = e => { if (e.key === 'Escape' && el('exAddOv') && !(window.Scanner && Scanner.isOpen())) closeAdd(); };
  function closeAdd() { el('exAddOv')?.remove(); document.removeEventListener('keydown', onKey); F = null; }

  function scan() {
    if (!window.Scanner) return el('exQ')?.focus();
    Scanner.open({ title: 'Scan the item', continuous: false, onCode: code => { if (el('exQ')) el('exQ').value = code; find(code, true); return code; } });
  }

  async function find(raw, byCode) {
    const q = String(raw || '').trim(); if (!q || !F || F.busy) return;
    F.busy = true; F.msg = ''; F.choices = null; paintItem('Looking for it…');
    try {
      let token = q;
      if (!byCode && !/^[\d\s.-]{4,}$/.test(q) && !/^[A-Za-z]{0,3}\d{3,}$/.test(q)) {   // a name: choose the item first
        const r = await call({ action: 'item_search', search: q });
        const items = r.items || [];
        if (!items.length) { F.msg = `Nothing found for "${q}".`; F.item = null; }
        else if (items.length > 1) { F.choices = items.slice(0, 12); F.item = null; }
        else token = items[0].code;
      }
      if (!F.msg && !F.choices) {
        const r = await call({ action: 'items_lookup', tokens: [token] });
        const it = r.items && r.items[token];
        F.item = it ? { code: it.code, description: it.description, barcode: it.barcode, supplier: it.supplier, group: it.group, stock: it.stock }
          : { code: token, description: '', barcode: /^\d{8,}$/.test(token) ? token : '', supplier: '', group: '' };
        if (!it) F.msg = 'Not found in the system: it will be saved with this code.';
      }
    } catch (e) {
      if (!F) return;   // the window was closed meanwhile
      F.item = { code: q, description: '', barcode: /^\d{8,}$/.test(q) ? q : '', supplier: '', group: '' };
      F.msg = 'The system did not answer: it will be saved with this code.';
    }
    if (!F) return;
    F.busy = false;
    if (F.item) { if (el('exQ')) { el('exQ').value = ''; el('exQ').blur(); } suggest(); }
    paintItem(); paintWorkers();
  }
  // the shelf worker who looks after the item's group (Staff › sections), when there is exactly one
  function suggest() {
    F.suggested = '';
    const g = String(F.item?.group || '').toLowerCase(); if (!g) return;
    const hits = S.workers.filter(w => String(w.sections || '').toLowerCase().split(/[,;/\n]+/).map(s => s.trim()).filter(s => s.length > 2).some(s => g.includes(s) || s.includes(g)));
    if (hits.length !== 1) return;
    F.suggested = wKey(hits[0]);
    if (!F.picked) F.worker = F.suggested;
  }

  function paintItem(busyMsg) {
    const box = el('exItem'); if (!box || !F) return;
    if (busyMsg) { box.innerHTML = `<p class="muted-note ex-msg">${esc(busyMsg)}</p>`; return; }
    if (F.choices) { box.innerHTML = `<p class="muted-note ex-msg">Which one?</p><div class="ex-choices">${F.choices.map(c => `<button type="button" data-pick="${esc(c.code)}"><b>${esc(c.description)}</b><span class="mono">${esc(c.code)}${c.size ? ' · ' + esc(c.size) : ''}</span></button>`).join('')}</div>`; return; }
    const it = F.item;
    const same = it ? (S.rows || []).filter(r => r.status === 'open' && r.code === it.code && (!F.ed || r.id !== F.ed.id)).sort(byDate) : [];
    box.innerHTML = (F.msg ? `<p class="ex-msg ${it ? 'muted-note' : 'ex-bad'}">${esc(F.msg)}</p>` : '')
      + (it ? `<div class="ex-picked"><div><b>${esc(it.description || 'Item ' + it.code)}</b><span class="mono">${esc(it.code)}${it.supplier ? ' · ' + esc(it.supplier) : ''}${it.stock !== undefined && it.stock !== null ? ' · stock ' + fq(it.stock) : ''}</span></div></div>
        ${same.length ? `<p class="muted-note ex-msg">Already entered: ${same.map(r => r.day_known ? shortDay(r.expiry_date + 'T00:00:00') : MON[Number(r.expiry_date.slice(5, 7)) - 1] + ' ' + r.expiry_date.slice(2, 4)).join(', ')}</p>` : ''}`
        : F.msg ? '' : '<p class="muted-note ex-msg">Scan the barcode with the camera, use a barcode gun, or type and press Enter.</p>');
  }

  function paintMonthChips() {
    const box = el('exMonthChips'); if (!box || !F) return;
    // a year of months; "More" shows the year after (a month already picked further away shows too)
    const cur = curYm(), far = F.dates.reduce((m, d) => Math.max(m, monthsBetween(cur, d.ym)), 0);
    const list = Array.from({ length: F.more || far > 12 ? Math.max(25, far + 1) : 13 }, (_, i) => addMonths(cur, i));
    const count = ym => F.dates.filter(d => d.ym === ym).length;
    box.innerHTML = list.map((ym, i) => { const n = count(ym); return `<button type="button" data-ym="${ym}" class="${n ? 'on' : ''}"><b>${i === 0 ? 'This month' : MON[Number(ym.slice(5)) - 1]}</b><span>${i === 0 ? MON[Number(ym.slice(5)) - 1] + ' ' + ym.slice(2, 4) : ym.slice(0, 4)}</span>${n > 1 ? `<i>×${n}</i>` : ''}</button>`; }).join('')
      + (list.length === 13 ? '<button type="button" class="ex-more" data-x="more"><b>More…</b><span>next year</span></button>' : '');
  }
  function addDate(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    if (F.ed) F.dates = [{ ym, day: F.dates[0]?.day && F.dates[0].day <= lastDay(ym) ? F.dates[0].day : 0, qty: F.dates[0]?.qty ?? '' }];
    else F.dates.push({ ym, day: 0, qty: '' });
    paintDates();
  }
  function paintDates() {
    const box = el('exDates'); if (!box || !F) return;
    F.dates.sort((a, b) => a.ym.localeCompare(b.ym) || a.day - b.day);
    box.innerHTML = F.dates.length ? `<div class="ex-dates">${F.dates.map((d, i) => `<div class="ex-drow">
        <span class="ex-dm"><b>${MON[Number(d.ym.slice(5)) - 1]}</b> ${d.ym.slice(0, 4)}</span>
        <select data-di="${i}" data-f="day" aria-label="Day">${['<option value="0">Month only</option>', ...Array.from({ length: lastDay(d.ym) }, (_, k) => `<option value="${k + 1}" ${d.day === k + 1 ? 'selected' : ''}>Day ${k + 1}</option>`)].join('')}</select>
        <input type="number" data-di="${i}" data-f="qty" inputmode="decimal" min="0" step="any" placeholder="Qty" value="${esc(d.qty)}" aria-label="Quantity">
        ${F.ed ? '' : `<button type="button" class="ex-rm" data-rm="${i}" aria-label="Remove this date" title="Remove">${ICON.close}</button>`}
      </div>`).join('')}</div>` : '';
    paintMonthChips();
  }
  function paintWorkers() {
    const box = el('exWorkers'); if (!box || !F) return;
    if (!S.workers.length) { box.innerHTML = '<p class="muted-note" style="margin:0;">No shelf worker yet: add them in Staff with the job "Shelf worker".</p>'; return; }
    box.innerHTML = [`<button type="button" data-w="" class="${!F.worker ? 'on' : ''}"><b>Nobody yet</b></button>`, ...S.workers.map(w => { const k = wKey(w); return `<button type="button" data-w="${esc(k)}" class="${F.worker === k ? 'on' : ''}${F.suggested === k ? ' sugg' : ''}"><b>${esc(w.name)}</b>${w.sections ? `<span>${esc(w.sections)}</span>` : ''}${F.suggested === k ? '<i>suggested</i>' : ''}</button>`; })].join('');
    const sg = el('exSugg'); if (sg) sg.textContent = F.suggested ? '— suggested from the item\'s group' : '';
  }

  async function save(next) {
    if (!F || F.saving) return;
    if (!F.item) { showToast('Scan or type the item first.', true); el('exQ')?.focus(); return; }
    if (!F.dates.length) { showToast('Tap the month it expires in.', true); return; }
    const loc = el('exLoc').value.trim(), note = el('exNote').value.trim(), it = F.item;
    const rows = F.dates.map(d => ({
      code: it.code, description: it.description || null, barcode: it.barcode || null, supplier: it.supplier || null, item_group: it.group || null,
      expiry_date: `${d.ym}-${String(d.day || lastDay(d.ym)).padStart(2, '0')}`, day_known: !!d.day,
      qty: d.qty === '' || d.qty === null || d.qty === undefined || !Number.isFinite(Number(d.qty)) ? null : Number(d.qty),
      location: loc || null, note: note || null, ...keyPatch(F.worker),
    }));
    F.saving = true;
    const ed = F.ed, worker = F.worker;
    try {
      if (ed) {
        const { data, error } = await sb.from('expiries').update(rows[0]).eq('id', ed.id).select().single();
        if (error) throw error;
        replaceRow(data);
        logActivity('expiries', 'edit', { type: 'expiry', id: ed.id }, `Changed the expiry of ${it.description || it.code} (${rows[0].expiry_date})`);
      } else {
        const { data, error } = await sb.from('expiries').insert(rows).select();
        if (error) throw error;
        (data || []).forEach(replaceRow);
        logActivity('expiries', 'add', { type: 'expiry', id: data?.[0]?.id }, `Expiry: ${it.description || it.code} — ${rows.map(r => r.day_known ? r.expiry_date : r.expiry_date.slice(0, 7)).join(', ')}${data?.[0]?.assigned_name ? ' · given to ' + data[0].assigned_name : ''}`);
      }
    } catch (e) { if (F) F.saving = false; return showToast(friendlyError(e), true); }
    S.lastWorker = worker; S.lastLoc = loc;
    showToast(ed ? 'Saved.' : `Saved: ${it.description || it.code} · ${rows.length} date${rows.length === 1 ? '' : 's'}.`);
    pill(); paint();
    if (!F) return;   // the window was closed meanwhile
    if (!next || ed) return closeAdd();
    // next item: the shelf and the worker stay, the rest is cleared
    F.item = null; F.dates = []; F.msg = ''; F.choices = null; F.suggested = ''; F.picked = false; F.saving = false; F.worker = S.lastWorker;
    el('exNote').value = '';
    paintItem(); paintDates(); paintWorkers();
    el('exAddOv')?.querySelector('.ex-addbody')?.scrollTo({ top: 0 });
    if (window.matchMedia('(pointer:fine)').matches) el('exQ')?.focus(); else scan();
  }

  function show() {
    wire();
    if (!S.rows) load(); else { paint(); load(); }
  }
  // after sign-in: the menu badge (expired or within 7 days)
  function start() { if (!S.rows) load(); }
  function refresh() { return load(); }

  window.Expiries = { show, start, refresh };
})();
