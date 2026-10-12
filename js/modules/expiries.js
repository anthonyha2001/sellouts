/* ============================================================
   Expiries (owner, 2026-10-12): the items on the shelves that expire soon, one card per month.
   Floor manager (expiry.manage), made to be fast (owner: "add the items in a row like the delivery system"):
     - one entry row on top, always there: scan (camera or barcode gun) or type the item, Enter; its month, day
       (optional) and quantity; "+ date" for another date of the same item; the shelf and the shelf worker are
       kept for the next item (the worker is suggested from the sections they look after; keys 1–9 pick one);
       Enter adds it. After a camera scan the camera opens again for the next item.
     - a month opens on folders, one per shelf worker (and "Not given yet", with "Give all to…"); each item is
       one row: date, item, quantity, the worker (change it to move the item), Mark done, another date, edit,
       delete.
   Shelf worker (expiry.work): only theirs, and big buttons to mark each one done: removed, on discount,
   returned, sold out. Table public.expiries; shelf workers from expiry_workers() (migration 084). Items from
   the system: lv-dashboard items_lookup / item_search.
   Public API: window.Expiries = { show, start, refresh }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const OUT = { removed: 'Removed', discount: 'On discount', returned: 'Returned', sold: 'Sold out' };
  const OUT_LONG = { removed: 'Removed from the shelf', discount: 'Put on discount', returned: 'Returned to the supplier', sold: 'Sold before it expired', other: 'Done' };
  // the admin's decision on an expiry sent (migration 085)
  const DEC = { return: 'Return to supplier', reprice: 'Repricing', merchandiser: 'Merchandiser will handle', sales: 'Request to the sales' };
  const S = { rows: null, workers: [], loading: false, err: '', month: null, who: 'all', status: 'open', lastWorker: '', lastLoc: '', lastYm: '', folds: {}, flash: new Set(),
    view: 'months', dStatus: 'todo', dGroup: 'supplier', lp: {}, lpBusy: false, justDecided: new Set(), decGroups: {} };
  const Q = { item: null, choices: null, msg: '', sugg: '', busy: false, saving: false, dates: [], cam: false, picked: false, mounted: false };
  const isMgr = () => can('expiry.manage');
  const isDec = () => can('expiry.decide');
  const call = async body => { const { data, error } = await sb.functions.invoke('lv-dashboard', { body }); if (error) throw error; if (data?.error) throw new Error(data.error); return data; };
  const fq = v => (Math.round(Number(v) * 100) / 100).toLocaleString('en-US');
  const ymOf = d => String(d || '').slice(0, 7);
  const curYm = () => ymOf(todayStr());
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5)) - Number(a.slice(5));
  const lastDay = ym => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const monthName = ym => MONTH[Number(ym.slice(5)) - 1];
  const monShort = d => MON[Number(String(d).slice(5, 7)) - 1];
  const daysTo = d => Math.round((new Date(d + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 864e5);
  const urg = r => { const n = daysTo(r.expiry_date); return n < 0 ? 'past' : n <= 7 ? 'week' : n <= 31 ? 'soon' : 'later'; };
  const shortDay = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const byDate = (a, b) => a.expiry_date.localeCompare(b.expiry_date) || String(a.description || '').localeCompare(String(b.description || ''));
  const pointerFine = () => window.matchMedia('(pointer:fine)').matches;
  // a shelf worker: from Staff (staff_id) or an app user with the Shelf worker role (u:<user id>)
  const wKey = w => w.staff_id || (w.user_id ? 'u:' + w.user_id : '');
  const rowKey = r => r.assigned_staff || (r.assigned_user ? 'u:' + r.assigned_user : '');
  const keyPatch = k => !k ? { assigned_staff: null, assigned_user: null } : k.startsWith('u:') ? { assigned_staff: null, assigned_user: k.slice(2) } : { assigned_staff: k, assigned_user: null };
  const workerName = k => S.workers.find(w => wKey(w) === k)?.name || '';
  const ICON = {
    scan: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chev: '<svg class="ex-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    folder: '<svg class="ex-folder" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
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
  // the menu badge: for the admin, what was sent and waits for a decision; for the others, what is expired or
  // expires within 7 days, still open
  const toDecide = () => (S.rows || []).filter(r => r.submitted_at && !r.decision && r.status === 'open');
  function pill() {
    const p = el('expiriesPill'); if (!p) return;
    const n = isDec() ? toDecide().length : (S.rows || []).filter(r => r.status === 'open' && daysTo(r.expiry_date) <= 7).length;
    p.textContent = n; p.hidden = !n;
    p.title = isDec() ? 'Expiries sent to you, waiting for your decision' : 'Expired or expiring within 7 days';
  }
  const whoRows = () => (S.rows || []).filter(r => S.who === 'all' ? true : S.who === 'none' ? !rowKey(r) : rowKey(r) === S.who);
  const monthRows = k => whoRows().filter(r => k === 'past' ? ymOf(r.expiry_date) < curYm() && r.status === 'open' : ymOf(r.expiry_date) === k);
  function replaceRow(row) { const i = S.rows.findIndex(x => x.id === row.id); if (i >= 0) S.rows[i] = row; else S.rows.push(row); }
  async function patch(ids, change, quiet) {
    const { data, error } = await sb.from('expiries').update(change).in('id', ids).select();
    if (error) {
      const m = friendlyError(error);
      showToast(/submitted_at|decision/i.test(m) && /column|schema/i.test(m) ? 'Run migration 085 in Supabase first.' : m, true);
      load(); return null;
    }
    (data || []).forEach(replaceRow);
    pill();
    if (quiet) paintTabs(); else paint();   // quiet: the admin is going down the list, nothing moves under the mouse
    return data;
  }
  function flash(ids) {
    ids.forEach(id => S.flash.add(id));
    setTimeout(() => { ids.forEach(id => S.flash.delete(id)); document.querySelectorAll('#panel-expiries .flash').forEach(x => { if (!S.flash.has(x.dataset.id)) x.classList.remove('flash'); }); }, 2600);
  }
  // an item from the system: a code / barcode, or a name (then the choices)
  const plainItem = c => ({ code: c, description: '', barcode: /^\d{8,}$/.test(c) ? c : '', supplier: '', group: '' });
  async function lookupItem(raw, byCode) {
    const q = String(raw || '').trim();
    const isName = !byCode && !/^[\d\s.-]{4,}$/.test(q) && !/^[A-Za-z]{0,3}\d{3,}$/.test(q);
    try {
      let token = q;
      if (isName) {
        const r = await call({ action: 'item_search', search: q });
        const items = r.items || [];
        if (!items.length) return { msg: `Nothing found for "${q}".` };
        if (items.length > 1) return { choices: items.slice(0, 12) };
        token = items[0].code;
      }
      const r = await call({ action: 'items_lookup', tokens: [token] });
      const it = r.items && r.items[token];
      if (it) return { item: { code: it.code, description: it.description, barcode: it.barcode, supplier: it.supplier, group: it.group, stock: it.stock } };
      return { item: plainItem(token), msg: 'Not in the system: saved with this code' };
    } catch (e) {
      return isName ? { msg: 'The system did not answer: type the code instead.' } : { item: plainItem(q), msg: 'The system did not answer: saved with this code' };
    }
  }
  // the shelf worker who looks after the item's group (Staff › sections), when there is exactly one
  function suggestFor(item) {
    const g = String(item?.group || '').toLowerCase(); if (!g) return '';
    const hits = S.workers.filter(w => String(w.sections || '').toLowerCase().split(/[,;/\n]+/).map(s => s.trim()).filter(s => s.length > 2).some(s => g.includes(s) || s.includes(g)));
    return hits.length === 1 ? wKey(hits[0]) : '';
  }
  const monthOpts = sel => {
    const list = Array.from({ length: 25 }, (_, i) => addMonths(curYm(), i));
    if (sel && !list.includes(sel)) list.unshift(sel);
    return list.map(ym => `<option value="${ym}" ${ym === sel ? 'selected' : ''}>${MON[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}</option>`).join('');
  };
  const dayOpts = d => '<option value="0">No day</option>' + Array.from({ length: lastDay(d.ym) }, (_, k) => `<option value="${k + 1}" ${d.day === k + 1 ? 'selected' : ''}>${k + 1}</option>`).join('');
  function workerOpts(sel, r) {
    const list = S.workers.map(w => [wKey(w), w.name]);
    if (sel && !list.some(([k]) => k === sel) && r?.assigned_name) list.push([sel, r.assigned_name]);
    return `<option value="">Not given yet</option>${list.map(([k, n], i) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${i < 9 && !r ? (i + 1) + ' · ' : ''}${esc(n)}</option>`).join('')}`;
  }
  const rowFrom = (it, d, loc, who, note) => ({
    code: it.code, description: it.description || null, barcode: it.barcode || null, supplier: it.supplier || null, item_group: it.group || null,
    expiry_date: `${d.ym}-${String(d.day || lastDay(d.ym)).padStart(2, '0')}`, day_known: !!d.day,
    qty: d.qty === '' || d.qty === null || d.qty === undefined || !Number.isFinite(Number(String(d.qty).replace(',', '.'))) ? null : Number(String(d.qty).replace(',', '.')),
    location: loc || null, note: note || null, ...keyPatch(who),
  });

  /* ---------------- the page: the entry row (kept between repaints), then the months or one month ---------------- */
  function paint() {
    const box = el('panel-expiries'); if (!box) return;
    if (!el('exBody')) { box.innerHTML = '<div id="exTabs"></div><div id="exHead"></div><div id="exQuickBox"></div><div id="exBody"></div>'; Q.mounted = false; }
    const head = el('exHead'), body = el('exBody');
    if (!S.rows) { head.innerHTML = ''; body.innerHTML = `<div class="card"><p class="${S.err ? 'empty-note' : 'muted-note'}" style="margin:0;">${esc(S.err || 'Loading the expiries…')}</p></div>`; return; }
    const deciding = isDec() && S.view === 'decide';
    paintTabs();
    mountQuick();
    el('exQuickBox').hidden = deciding;
    if (deciding) paintDecide(head, body);
    else if (S.month) paintMonth(head, body); else paintMonths(head, body);
  }

  // the admin: the months, or what was sent to decide
  function paintTabs() {
    const box = el('exTabs'); if (!box) return;
    const deciding = isDec() && S.view === 'decide', n = toDecide().length;
    box.innerHTML = isDec() ? `<div class="filter-row group-tabs ex-tabs">
        <button type="button" data-ex-view="months" class="${deciding ? '' : 'active'}">Months</button>
        <button type="button" data-ex-view="decide" class="${deciding ? 'active' : ''}">To decide <span class="sc-cnt ${n ? 'hot' : 'zero'}">${n}</span></button></div>` : '';
  }

  function whoSelect() {
    if (!isMgr()) return '';
    const opts = [['all', 'Everyone'], ['none', 'Not given yet'], ...S.workers.map(w => [wKey(w), w.name])];
    return `<select class="ex-who" data-ex="who" aria-label="Shelf worker">${opts.map(([v, l]) => `<option value="${esc(v)}" ${S.who === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  // the floor manager sends what is not sent yet to the admin (who decides: return, repricing, merchandiser, sales)
  function sendBtn(list) {
    if (!isMgr()) return '';
    const n = list.filter(r => r.status === 'open' && !r.submitted_at).length;
    return n ? `<button type="button" class="btn ex-send" data-ex="send" title="The admin decides what happens to them">Send ${n} to the admin</button>` : '';
  }
  async function send(list) {
    const ids = list.filter(r => r.status === 'open' && !r.submitted_at).map(r => r.id);
    if (!ids.length) return;
    const out = await patch(ids, { submitted_at: new Date().toISOString() });
    if (!out) return;
    flash(ids); paint();
    showToast(`${out.length} expir${out.length === 1 ? 'y' : 'ies'} sent to the admin.`);
    logActivity('expiries', 'send', { type: 'expiry', id: ids[0] }, `${out.length} expiries sent to the admin`);
  }
  // where an expiry stands with the admin: sent, then the decision
  const decChip = r => r.decision ? `<span class="ex-dec k-${r.decision}" title="${esc((r.decided_by_name ? 'Decided by ' + r.decided_by_name : '') + (r.decision_note ? ' — ' + r.decision_note : ''))}">${esc(DEC[r.decision] || r.decision)}</span>`
    : r.submitted_at ? '<span class="ex-dec k-sent">Sent to the admin</span>' : '';

  function paintMonths(head, body) {
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
    head.innerHTML = isMgr() ? '' : '<p class="muted-note ex-intro">The expiries given to you. Open a month and mark each item when it is done.</p>';
    const waiting = open.filter(r => r.submitted_at && !r.decision).length;
    body.innerHTML = `<div class="ex-sum">
        <span><b>${open.length}</b> to deal with</span>
        ${expired ? `<span class="ex-s-past"><b>${expired}</b> expired</span>` : ''}
        ${week ? `<span class="ex-s-week"><b>${week}</b> within 7 days</span>` : ''}
        ${isMgr() && notGiven ? `<button type="button" class="ex-s-none" data-ex="filternone"><b>${notGiven}</b> not given yet</button>` : ''}
        ${isMgr() && waiting ? `<span><b>${waiting}</b> waiting for the admin</span>` : ''}
        ${S.loading ? '<span class="muted-note ex-s-plain">updating…</span>' : ''}
        <span class="ex-sp"></span>${whoSelect()}${sendBtn(open)}
      </div>
      <div class="ex-months">${earlier.length ? monthCard('past', earlier) : ''}${[...keys].sort().map(k => monthCard(k, rows.filter(r => ymOf(r.expiry_date) === k))).join('')}</div>`;
  }

  function monthCard(k, list) {
    const cur = curYm(), open = list.filter(r => r.status === 'open').sort(byDate), done = list.length - open.length;
    const diff = k === 'past' ? -1 : monthsBetween(cur, k);
    const tone = k === 'past' ? 'past' : diff === 0 ? 'now' : diff === 1 ? 'next' : 'later';
    const rel = k === 'past' ? 'expired' : diff === 0 ? 'this month' : diff === 1 ? 'next month' : `in ${diff} months`;
    const units = open.reduce((s, r) => s + Number(r.qty || 0), 0);
    let lines;
    if (isMgr()) {   // the folders in it: each shelf worker and how many they have
      const by = new Map(); open.forEach(r => { const n = r.assigned_name || ''; by.set(n, (by.get(n) || 0) + 1); });
      lines = [...by.entries()].sort((a, b) => (a[0] === '' ? 0 : 1) - (b[0] === '' ? 0 : 1) || b[1] - a[1]).slice(0, 4)
        .map(([n, c]) => `<li class="${n ? '' : 'ex-wl-none'}">${ICON.folder}<span class="ex-desc">${esc(n || 'Not given yet')}</span><b>${c}</b></li>`).join('');
      if (by.size > 4) lines += `<li class="ex-wl-more">+${by.size - 4} more</li>`;
    } else {
      lines = open.slice(0, 3).map(r => `<li><span class="ex-d u-${urg(r)}">${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</span><span class="ex-desc">${esc(r.description || r.code)}</span></li>`).join('');
      if (open.length > 3) lines += `<li class="ex-wl-more">+${open.length - 3} more</li>`;
    }
    return `<button type="button" class="ex-month t-${tone}" data-ex-month="${k}">
      <div class="ex-mh"><div class="ex-mt"><b>${k === 'past' ? 'Expired' : monthName(k)}</b><span>${k === 'past' ? 'before ' + monthName(cur) : k.slice(0, 4)}</span></div><em>${rel}</em></div>
      <div class="ex-mn"><strong>${open.length}</strong><span>${open.length === 1 ? 'item' : 'items'} to deal with${units ? `<br>${fq(units)} pcs` : ''}</span></div>
      ${list.length ? `<div class="ex-bar" title="${done} of ${list.length} done"><i style="width:${Math.round(done / list.length * 100)}%"></i></div>` : ''}
      <ul class="ex-mlist">${lines || `<li class="ex-none">${list.length ? 'All done ✓' : 'Nothing yet'}</li>`}</ul>
    </button>`;
  }

  function paintMonth(head, body) {
    const k = S.month;
    const all = monthRows(k);
    const nOpen = all.filter(r => r.status === 'open').length, nDone = all.length - nOpen;
    head.innerHTML = `<div class="ex-top"><button type="button" class="btn ghost small" data-ex="back">‹ All months</button>
      <h3 class="ex-title">${k === 'past' ? 'Expired' : `${monthName(k)} <span>${k.slice(0, 4)}</span>`}</h3><span class="ex-sp"></span>
      <div class="filter-row ex-seg">${[['open', `To do · ${nOpen}`], ['done', `Done · ${nDone}`], ['all', 'All']].map(([v, l]) => `<button type="button" data-ex-status="${v}" class="${S.status === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${whoSelect()}${sendBtn(all)}</div>`;
    const shown = (S.status === 'all' ? all : all.filter(r => r.status === S.status)).sort(byDate);
    if (!shown.length) { body.innerHTML = `<p class="empty-note ex-empty">${S.status === 'done' ? 'Nothing done yet in this month.' : nOpen || nDone ? 'Everything here is done ✓' : 'Nothing expires in this month yet.'}</p>`; return; }
    if (!isMgr()) { body.innerHTML = `<div class="ex-list">${shown.map(cardHtml).join('')}</div>`; return; }
    // one folder per shelf worker; "Not given yet" first
    const groups = new Map([['', { key: '', name: 'Not given yet', sections: '', rows: [] }]]);
    S.workers.forEach(w => groups.set(wKey(w), { key: wKey(w), name: w.name, sections: w.sections || '', rows: [] }));
    all.forEach(r => { const g = rowKey(r); if (!groups.has(g)) groups.set(g, { key: g, name: r.assigned_name || 'Someone', sections: '', rows: [] }); groups.get(g).rows.push(r); });
    const list = [...groups.values()].map(g => Object.assign(g, { shown: shown.filter(r => g.rows.includes(r)) })).filter(g => g.shown.length);
    body.innerHTML = `<div class="ex-folds">${list.map(g => folderHtml(g, k, list.length)).join('')}</div>`;
  }

  function folderHtml(g, k, count) {
    const fk = `${k}|${g.key}`;
    const open = S.folds[fk] ?? (count <= 4 || !g.key);
    const nOpen = g.rows.filter(r => r.status === 'open').length, nDone = g.rows.length - nOpen;
    const soon = g.rows.filter(r => r.status === 'open' && daysTo(r.expiry_date) <= 7).length;
    return `<section class="ex-fold ${open ? 'open' : ''} ${g.key ? '' : 'ex-fold-none'}">
      <div class="ex-fold-h">
        <button type="button" class="ex-fold-t" data-fold="${esc(fk)}" aria-expanded="${open}">${ICON.chev}${ICON.folder}
          <b>${esc(g.name)}</b>${g.sections ? `<span class="ex-fold-s">${esc(g.sections)}</span>` : ''}
          <span class="ex-fold-n"><b>${nOpen}</b> to do${nDone ? ` · ${nDone} done` : ''}${soon ? ` · <em>${soon} within 7 days</em>` : ''}</span></button>
        ${!g.key && nOpen && S.workers.length ? `<select class="ex-giveall" data-ex="giveall" aria-label="Give them all to a shelf worker"><option value="">Give all ${nOpen} to…</option>${S.workers.map(w => `<option value="${esc(wKey(w))}">${esc(w.name)}</option>`).join('')}</select>` : ''}
      </div>
      ${open ? `<div class="ex-fold-b">${g.shown.map(rowHtml).join('')}</div>` : ''}
    </section>`;
  }

  // one item in a folder (floor manager)
  function rowHtml(r) {
    const done = r.status === 'done', n = daysTo(r.expiry_date);
    const when = done ? '' : n < 0 ? `expired ${-n}d ago` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 7 ? `in ${n} days` : '';
    return `<div class="ex-r u-${done ? 'done' : urg(r)}${S.flash.has(r.id) ? ' flash' : ''}" data-id="${r.id}">
      <span class="ex-r-date"><b>${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</b>${monShort(r.expiry_date)}</span>
      <span class="ex-r-item"><b>${esc(r.description || r.code)}</b>${decChip(r) ? `<span class="ex-r-chips">${decChip(r)}</span>` : ""}<small><span class="mono">${esc(r.code)}</span>${r.location ? ' · ' + esc(r.location) : ''}${when ? ` · <em>${when}</em>` : ''}${r.note ? ' · ' + esc(r.note) : ''}</small></span>
      <span class="ex-r-qty">${r.qty !== null && r.qty !== undefined ? `${fq(r.qty)}<small> pcs</small>` : '<small>—</small>'}</span>
      <select class="ex-give" data-ex-give="${r.id}" aria-label="Shelf worker" ${done ? 'disabled' : ''}>${workerOpts(rowKey(r), r)}</select>
      ${done ? `<span class="ex-r-done">✓ ${esc(OUT[r.outcome] || 'Done')}<button type="button" class="ex-undo" data-ex-undo="${r.id}">Undo</button></span>`
        : `<select class="ex-outsel" data-ex-out="${r.id}" aria-label="Mark done"><option value="">Mark done…</option>${Object.entries(OUT).map(([o, l]) => `<option value="${o}">${l}</option>`).join('')}</select>`}
      <span class="ex-r-icons"><button type="button" class="vb-ico" data-ex-again="${r.id}" aria-label="Another date for this item" data-tip="Another date">${ICON.plus}</button><button type="button" class="vb-ico" data-ex-edit="${r.id}" aria-label="Edit" data-tip="Edit">${ICON.edit}</button><button type="button" class="vb-ico vb-x" data-ex-del="${r.id}" aria-label="Delete" data-tip="Delete">${ICON.del}</button></span>
    </div>`;
  }

  // one item for the shelf worker: big buttons
  function cardHtml(r) {
    const done = r.status === 'done', n = daysTo(r.expiry_date);
    const when = done ? '' : n < 0 ? `Expired ${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'Expires today' : n === 1 ? 'Expires tomorrow'
      : r.day_known ? `In ${n} days` : `By the end of ${monthName(ymOf(r.expiry_date))}`;
    const meta = [`<span class="mono">${esc(r.code)}</span>`, r.qty !== null && r.qty !== undefined ? `<b>${fq(r.qty)}</b> pcs` : '', r.location ? `Shelf ${esc(r.location)}` : ''].filter(Boolean).join(' · ');
    return `<article class="ex-item u-${done ? 'done' : urg(r)}" data-id="${r.id}">
      <div class="ex-date"><b>${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</b><span>${monShort(r.expiry_date)}</span></div>
      <div class="ex-body">
        <div class="ex-name">${esc(r.description || r.code)}</div>
        <div class="ex-meta">${meta}</div>
        ${when ? `<div class="ex-when">${when}</div>` : ''}
        ${r.note ? `<div class="ex-note">${esc(r.note)}</div>` : ''}
        ${r.decision ? `<div class="ex-decline">${decChip(r)}${r.decision_note ? ` <span>${esc(r.decision_note)}</span>` : ''}</div>` : ''}
        <div class="ex-acts">${done
          ? `<div class="ex-doneline">✓ ${esc(OUT_LONG[r.outcome] || 'Done')}${r.done_at ? ' · ' + esc(shortDay(r.done_at)) : ''}<button type="button" class="ex-undo" data-ex-undo="${r.id}">Undo</button></div>`
          : `<div class="ex-outs">${Object.entries(OUT).map(([o, l]) => `<button type="button" class="ex-out" data-ex-done="${r.id}" data-o="${o}">${l}</button>`).join('')}</div>`}</div>
      </div>
    </article>`;
  }

  /* ---------------- the admin: what was sent, with the supplier, the last purchase and the contract ---------------- */
  const norm = s => String(s || '').toUpperCase().replace(/\s+\d+\s*$/, '').replace(/[^A-Z0-9؀-ۿ]/g, '');
  const supName = s => String(s || '').replace(/\s+\d+\s*$/, '').trim();         // "G.VINCENTI &SONS S.A.L 132002" -> the name
  const supCode = s => (/(\d{3,})\s*$/.exec(String(s || '')) || [])[1] || '';     // … and its account number
  const lpSup = r => { const lp = S.lp[r.code]; return lp && typeof lp === 'object' ? (lp.docs || [])[0]?.supplier || '' : ''; };
  const supplierOf = r => r.supplier || supName(lpSup(r));
  // the vendor of the app: by the supplier's number on the last purchase, else by the name
  function vendorFor(r) {
    const list = typeof vendorsList !== 'undefined' ? vendorsList : [];
    if (!list.length) return null;
    const det = lpSup(r), code = supCode(det);
    let v = code && window.VendorContract ? VendorContract.forSupplier(code) : null;
    if (!v) {
      const keys = [norm(r.supplier), norm(det)].filter(Boolean);
      if (keys.length) v = list.find(x => keys.includes(norm(x.name)) || (x.systemSuppliers || []).some(s => keys.includes(norm(s.name)))) || null;
    }
    return v;
  }
  const decOpts = sel => Object.entries(DEC).map(([k, l]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${l}</option>`).join('');
  const curSym = c => /lbp|l\.?l/i.test(String(c || '')) ? 'LBP ' : '$';
  const lpDay = d => new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  function lpCell(code) {
    const lp = S.lp[code];
    if (lp === undefined || lp === 'loading') return '<span class="muted-note">reading…</span>';
    if (!lp) return '<span class="muted-note">No purchase in 2 years</span>';
    const d = (lp.docs || [])[0];
    if (!d) return `<span class="muted-note">${lp.date ? esc(lpDay(lp.date)) + ' · ' : ''}could not be read</span>`;
    return `<b>${esc(lpDay(lp.date))}</b> <span class="mono">${esc(d.doc)}</span><small>${fq(d.paidQty)}${d.freeQty ? ' + ' + fq(d.freeQty) + ' free' : ''} pcs${d.realCost !== null && d.realCost !== undefined ? ' · ' + curSym(d.currency) + fq(d.realCost) + ' each' : ''}</small>`;
  }
  // the last purchase of each item (lv-dashboard last_cost: the day, the PU, the quantity, the real cost, the supplier)
  async function loadLp(codes) {
    const need = [...new Set(codes)].filter(c => S.lp[c] === undefined);
    if (!need.length || S.lpBusy) return;
    S.lpBusy = true;
    need.forEach(c => { S.lp[c] = 'loading'; });
    for (let i = 0; i < need.length; i += 40) {
      const part = need.slice(i, i + 40);
      try { const r = await call({ action: 'last_cost', codes: part }); part.forEach(c => { S.lp[c] = (r.costs || {})[c] ?? null; }); }
      catch (e) { part.forEach(c => { S.lp[c] = { failed: true, date: null, docs: [] }; }); }
      refreshDecide();
    }
    S.lpBusy = false;
    const more = (S.rows || []).filter(r => r.submitted_at && S.lp[r.code] === undefined).map(r => r.code);
    if (more.length && isDec() && S.view === 'decide') loadLp(more);
  }
  // the last purchases arrive: a full repaint (the supplier groups may change), unless a field is in use
  function refreshDecide() {
    if (!(isDec() && S.view === 'decide')) return;
    const a = document.activeElement, box = el('panel-expiries');
    if (box && a && box.contains(a) && a.matches('input, select, textarea')) document.querySelectorAll('#exBody [data-lp]').forEach(x => { x.innerHTML = lpCell(x.dataset.lp); });
    else paint();
  }
  function contractHtml(v) {
    if (!v) return '<span class="ex-k">Not linked to a vendor: no contract to show</span>';
    const c = window.VendorContract ? VendorContract.summary(v.contract) : null;
    if (!c) return '';
    const ret = c.expiredReturns === 'yes' ? '<span class="ex-k ok">Takes back expired goods</span>'
      : c.expiredReturns === 'no' ? '<span class="ex-k bad">Does not take back expired goods</span>' : '<span class="ex-k">Expired goods: not in the contract</span>';
    return [ret, VendorContract.chip(v.contract) || '<span class="ex-k">No back margin</span>',
      c.paymentDays !== null && c.paymentDays !== '' ? `<span class="ex-k">Payment ${esc(c.paymentDays)} days</span>` : '',
      c.to ? `<span class="ex-k ${c.expired ? 'bad' : ''}">Contract ${c.expired ? 'ended' : 'until'} ${esc(fmtDate(c.to))}</span>` : ''].filter(Boolean).join('');
  }

  function paintDecide(head, body) {
    const sent = (S.rows || []).filter(r => r.submitted_at);
    const todo = sent.filter(r => !r.decision && r.status === 'open'), decided = sent.filter(r => r.decision);
    // what was decided a moment ago stays in the list until the view changes
    const list = (S.dStatus === 'todo' ? sent.filter(r => (!r.decision && r.status === 'open') || S.justDecided.has(r.id)) : S.dStatus === 'decided' ? decided : sent).slice().sort(byDate);
    head.innerHTML = `<div class="ex-top">
      <div class="filter-row ex-seg">${[['todo', `To decide · ${todo.length}`], ['decided', `Decided · ${decided.length}`], ['all', 'All sent']].map(([v, l]) => `<button type="button" data-ex-dstatus="${v}" class="${S.dStatus === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <span class="ex-sp"></span>
      <div class="filter-row ex-seg">${[['supplier', 'By supplier'], ['date', 'By expiry date']].map(([v, l]) => `<button type="button" data-ex-dgroup="${v}" class="${S.dGroup === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>`;
    if (!list.length) {
      body.innerHTML = `<p class="empty-note ex-empty">${S.dStatus === 'todo' ? (sent.length ? 'Everything sent is decided ✓' : 'Nothing was sent to you yet: the floor manager sends the expiries from the Months tab.') : 'Nothing here.'}</p>`;
      return;
    }
    loadLp(list.map(r => r.code));
    S.decGroups = {};
    if (S.dGroup === 'date') { body.innerHTML = `<div class="ex-folds"><section class="ex-fold open"><div class="ex-fold-b">${list.map(r => decRowHtml(r, true)).join('')}</div></section></div>`; return; }
    const groups = new Map();
    list.forEach(r => {
      const v = vendorFor(r), name = v ? v.name : supplierOf(r) || 'Supplier not known', key = v ? 'v:' + v.id : 's:' + (norm(name) || '?');
      if (!groups.has(key)) groups.set(key, { key, name, v, rows: [] });
      groups.get(key).rows.push(r);
    });
    const gl = [...groups.values()].sort((a, b) => a.rows[0].expiry_date.localeCompare(b.rows[0].expiry_date));   // the most urgent supplier first
    gl.forEach(g => { S.decGroups[g.key] = g.rows.map(r => r.id); });
    body.innerHTML = `<div class="ex-folds">${gl.map(supGroupHtml).join('')}</div>`;
  }
  function supGroupHtml(g) {
    const fk = 'dec|' + g.key, open = S.folds[fk] ?? true;
    const undecided = g.rows.filter(r => !r.decision).length;
    const units = g.rows.reduce((s, r) => s + Number(r.qty || 0), 0);
    return `<section class="ex-fold ex-sup ${open ? 'open' : ''}">
      <div class="ex-fold-h">
        <button type="button" class="ex-fold-t" data-fold="${esc(fk)}" aria-expanded="${open}">${ICON.chev}${ICON.folder}<b>${esc(g.name)}</b>
          <span class="ex-fold-n"><b>${g.rows.length}</b> item${g.rows.length === 1 ? '' : 's'}${units ? ` · ${fq(units)} pcs` : ''}${undecided ? ` · <em>${undecided} to decide</em>` : ''}</span></button>
        ${g.v ? `<button type="button" class="btn ghost small" data-ex-vendor="${esc(g.v.id)}">Vendor sheet</button>` : ''}
        ${undecided ? `<select class="ex-giveall" data-ex-decall="${esc(g.key)}" aria-label="Decide for all of them"><option value="">Decide all ${undecided}…</option>${decOpts('')}</select>` : ''}
      </div>
      ${open ? `<div class="ex-sup-info">${contractHtml(g.v)}</div><div class="ex-fold-b">${g.rows.map(r => decRowHtml(r)).join('')}</div>` : ''}
    </section>`;
  }
  function decRowHtml(r, showSup) {
    const n = daysTo(r.expiry_date), done = r.status === 'done';
    const when = done ? (OUT[r.outcome] || 'done') : n < 0 ? `expired ${-n}d ago` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 31 ? `in ${n} days` : '';
    const meta = [`<span class="mono">${esc(r.code)}</span>`, showSup && supplierOf(r) ? esc(supplierOf(r)) : '', r.location ? esc(r.location) : '', when ? `<em>${esc(when)}</em>` : '',
      r.submitted_by_name ? 'sent by ' + esc(r.submitted_by_name) : '', r.assigned_name ? '→ ' + esc(r.assigned_name) : ''].filter(Boolean).join(' · ');
    return `<div class="ex-r ex-dr u-${done ? 'done' : urg(r)}${S.flash.has(r.id) ? ' flash' : ''}${r.decision ? ' decided' : ''}" data-id="${r.id}">
      <span class="ex-r-date"><b>${r.day_known ? Number(r.expiry_date.slice(8)) : '–'}</b>${monShort(r.expiry_date)}</span>
      <span class="ex-r-item"><b>${esc(r.description || r.code)}</b><small>${meta}</small>${r.note ? `<small class="ex-r-note">${esc(r.note)}</small>` : ''}</span>
      <span class="ex-r-qty">${r.qty !== null && r.qty !== undefined ? `${fq(r.qty)}<small> pcs</small>` : '<small>—</small>'}</span>
      <span class="ex-r-lp" data-lp="${esc(r.code)}" title="The last purchase: day, PU, quantity, real cost">${lpCell(r.code)}</span>
      <select class="ex-decsel${r.decision ? ' k-' + r.decision : ''}" data-ex-dec="${r.id}" aria-label="Decision"><option value="">Decide…</option>${decOpts(r.decision)}</select>
      <input type="text" class="ex-decnote" data-ex-decnote="${r.id}" value="${esc(r.decision_note || '')}" placeholder="Note (optional)" aria-label="Note" autocomplete="off">
    </div>`;
  }

  async function markDone(row, outcome) {
    const out = await patch([row.id], { status: 'done', outcome });
    if (!out) return;
    showToast(`${row.description || row.code}: ${OUT_LONG[outcome].toLowerCase()}.`);
    logActivity('expiries', 'done', { type: 'expiry', id: row.id }, `Expiry ${OUT_LONG[outcome].toLowerCase()}: ${row.description || row.code} (${row.expiry_date})`);
  }

  function wire() {
    const box = el('panel-expiries'); if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('click', async e => {
      if (e.target.closest('#exQuickBox')) return;   // the entry row has its own
      const t = e.target.closest('[data-ex], [data-ex-month], [data-ex-status], [data-fold], [data-ex-done], [data-ex-undo], [data-ex-edit], [data-ex-del], [data-ex-again], [data-ex-view], [data-ex-dstatus], [data-ex-dgroup], [data-ex-vendor]'); if (!t) return;
      const a = t.dataset.ex;
      if (a === 'back') { S.month = null; quickMonth(); return paint(); }
      if (a === 'filternone') { S.who = 'none'; return paint(); }
      if (a === 'send') return send(S.month ? monthRows(S.month) : whoRows());
      if (t.dataset.exView) { S.view = t.dataset.exView; S.justDecided.clear(); return paint(); }
      if (t.dataset.exDstatus) { S.dStatus = t.dataset.exDstatus; S.justDecided.clear(); return paint(); }
      if (t.dataset.exDgroup) { S.dGroup = t.dataset.exDgroup; return paint(); }
      if (t.dataset.exVendor) return typeof openVendorDetail === 'function' && openVendorDetail(t.dataset.exVendor);
      if (t.dataset.exMonth) { S.month = t.dataset.exMonth; S.status = 'open'; quickMonth(); paint(); return window.scrollTo({ top: 0 }); }
      if (t.dataset.exStatus) { S.status = t.dataset.exStatus; return paint(); }
      if (t.dataset.fold) { S.folds[t.dataset.fold] = !t.closest('.ex-fold').classList.contains('open'); return paint(); }
      const row = S.rows.find(x => x.id === (t.dataset.exDone || t.dataset.exUndo || t.dataset.exEdit || t.dataset.exDel || t.dataset.exAgain)); if (!row) return;
      if (t.dataset.exDone) return markDone(row, t.dataset.o);
      if (t.dataset.exUndo) { const out = await patch([row.id], { status: 'open' }); if (out) logActivity('expiries', 'undo', { type: 'expiry', id: row.id }, `Expiry back to do: ${row.description || row.code}`); return; }
      if (t.dataset.exAgain) return quickAgain(row);
      if (t.dataset.exEdit) return openEdit(row);
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
      if (t.closest('#exQuickBox')) return;
      if (t.dataset.ex === 'who') { S.who = t.value; return paint(); }
      // the admin's decision: one item, its note, or all the undecided of a supplier
      if (t.dataset.exDec) {
        const row = S.rows.find(x => x.id === t.dataset.exDec); if (!row) return;
        S.justDecided.add(row.id);
        const out = await patch([row.id], { decision: t.value || null }, true);
        if (out && out[0]) {
          t.className = 'ex-decsel' + (t.value ? ' k-' + t.value : '');
          t.closest('.ex-dr')?.classList.toggle('decided', !!t.value);
          logActivity('expiries', 'decide', { type: 'expiry', id: row.id }, `Expiry of ${row.description || row.code} (${row.expiry_date}): ${DEC[t.value] || 'no decision'}`);
        }
        return;
      }
      if (t.dataset.exDecnote) {
        const row = S.rows.find(x => x.id === t.dataset.exDecnote); if (!row || (row.decision_note || '') === t.value.trim()) return;
        S.justDecided.add(row.id);
        await patch([row.id], { decision_note: t.value.trim() || null }, true);
        return;
      }
      if (t.dataset.exDecall && t.value) {
        const ids = (S.decGroups[t.dataset.exDecall] || []).filter(id => { const r = S.rows.find(x => x.id === id); return r && !r.decision; });
        if (!ids.length) return;
        ids.forEach(id => S.justDecided.add(id));
        const out = await patch(ids, { decision: t.value });
        if (out) { flash(ids); paint(); showToast(`${out.length} item${out.length === 1 ? '' : 's'}: ${DEC[t.value].toLowerCase()}.`); logActivity('expiries', 'decide', { type: 'expiry', id: ids[0] }, `${out.length} expiries: ${DEC[t.value]}`); }
        return;
      }
      if (t.dataset.exOut) { const row = S.rows.find(x => x.id === t.dataset.exOut); if (row && t.value) markDone(row, t.value); return; }
      if (t.dataset.exGive !== undefined) {
        const row = S.rows.find(x => x.id === t.dataset.exGive); if (!row) return;
        const out = await patch([row.id], keyPatch(t.value));
        if (out && out[0]) {
          flash([row.id]); if (S.month) S.folds[`${S.month}|${t.value}`] = true; paint();
          showToast(out[0].assigned_name ? `Moved to ${out[0].assigned_name}.` : 'Not given to anyone now.');
          logActivity('expiries', 'give', { type: 'expiry', id: row.id }, `Expiry of ${row.description || row.code} given to ${out[0].assigned_name || 'nobody'}`);
        }
        return;
      }
      if (t.dataset.ex === 'giveall' && t.value) {
        const ids = monthRows(S.month).filter(r => r.status === 'open' && !rowKey(r)).map(r => r.id);
        if (!ids.length) return;
        const out = await patch(ids, keyPatch(t.value));
        if (out && out[0]) {
          S.folds[`${S.month}|${t.value}`] = true; flash(ids); paint();
          showToast(`${out.length} item${out.length === 1 ? '' : 's'} given to ${out[0].assigned_name}.`);
          logActivity('expiries', 'give', { type: 'expiry', id: S.month }, `${out.length} expiries of ${S.month} given to ${out[0].assigned_name}`);
        }
      }
    });
  }

  /* ---------------- the entry row ---------------- */
  const defaultYm = () => S.month && S.month !== 'past' ? S.month : S.lastYm || curYm();
  function mountQuick() {
    const box = el('exQuickBox'); if (!box) return;
    if (!isMgr()) { box.innerHTML = ''; return; }
    if (!Q.mounted) {
      if (!Q.dates.length) Q.dates = [{ ym: defaultYm(), day: 0, qty: '' }];
      box.innerHTML = `<div class="ex-quick" id="exQuick">
        <div class="ex-q-cell ex-q-itemcell"><label class="ex-q-lbl" for="exQItem">Item</label>
          <div class="ex-q-find"><input type="search" id="exQItem" placeholder="Scan or type: code, barcode or name" autocomplete="off" enterkeyhint="next">
            <button type="button" class="ex-q-scan" data-q="scan" title="Scan with the camera" aria-label="Scan with the camera">${ICON.scan}<span>Scan</span></button></div>
          <div class="ex-q-found" id="exQFound"></div></div>
        <div class="ex-q-cell ex-q-datecell"><span class="ex-q-lbl">Expires <span>month · day · qty</span></span><div id="exQDates"></div></div>
        <div class="ex-q-cell ex-q-loccell"><label class="ex-q-lbl" for="exQLoc">Shelf</label><input type="text" id="exQLoc" list="exQLocs" placeholder="optional" autocomplete="off"><datalist id="exQLocs"></datalist></div>
        <div class="ex-q-cell ex-q-whocell"><label class="ex-q-lbl" for="exQWho">Shelf worker</label><select id="exQWho" title="Keys 1–9 pick a shelf worker"></select></div>
        <div class="ex-q-cell ex-q-addcell"><button type="button" class="btn ex-q-add" data-q="add">Add</button></div>
      </div>`;
      el('exQLoc').value = S.lastLoc;
      wireQuick();
      Q.mounted = true;
      paintQDates(); paintFound();
      if (pointerFine() && box.closest('.panel')?.classList.contains('active')) setTimeout(() => el('exQItem')?.focus(), 30);   // a barcode gun: ready to scan
    }
    // the lists that change: shelf workers and the shelves already used
    const who = el('exQWho'), keep = who.options.length ? who.value : S.lastWorker;
    who.innerHTML = workerOpts(keep);
    who.value = S.workers.some(w => wKey(w) === keep) ? keep : '';
    el('exQLocs').innerHTML = [...new Set((S.rows || []).map(r => r.location).filter(Boolean))].sort().map(l => `<option value="${esc(l)}">`).join('');
  }
  // opening a month (or going back): the entry row takes that month, unless something is being typed
  function quickMonth() {
    if (!Q.mounted || Q.item || Q.dates.length !== 1 || Q.dates[0].qty !== '' || Q.dates[0].day) return;
    Q.dates[0].ym = defaultYm(); paintQDates();
  }
  function paintQDates(focusIdx, field) {
    const box = el('exQDates'); if (!box) return;
    box.innerHTML = Q.dates.map((d, i) => `<div class="ex-q-date">
        <select data-qi="${i}" data-qf="ym" aria-label="Month">${monthOpts(d.ym)}</select>
        <select data-qi="${i}" data-qf="day" aria-label="Day">${dayOpts(d)}</select>
        <input type="text" data-qi="${i}" data-qf="qty" inputmode="decimal" placeholder="Qty" value="${esc(d.qty)}" autocomplete="off" aria-label="Quantity">
        ${Q.dates.length > 1 ? `<button type="button" class="ex-q-rm" data-q="rm" data-i="${i}" title="Remove this date" aria-label="Remove this date">${ICON.close}</button>` : ''}
      </div>`).join('') + '<button type="button" class="ex-q-plus" data-q="plus" title="Another date for the same item">+ date</button>';
    if (focusIdx !== undefined) box.querySelector(`[data-qi="${focusIdx}"][data-qf="${field || 'ym'}"]`)?.focus();
  }
  function paintFound(busy) {
    const box = el('exQFound'); if (!box) return;
    if (busy) { box.innerHTML = `<span class="muted-note">${esc(busy)}</span>`; return; }
    if (Q.choices) { box.innerHTML = `<div class="ex-q-choices">${Q.choices.map(c => `<button type="button" data-pick="${esc(c.code)}"><b>${esc(c.description)}</b><span class="mono">${esc(c.code)}${c.size ? ' · ' + esc(c.size) : ''}</span></button>`).join('')}</div>`; return; }
    const it = Q.item;
    if (!it) { box.innerHTML = Q.msg ? `<span class="ex-bad">${esc(Q.msg)}</span>` : ''; return; }
    const same = (S.rows || []).filter(r => r.status === 'open' && r.code === it.code).sort(byDate);
    const sug = Q.sugg ? workerName(Q.sugg) : '';
    box.innerHTML = [
      it.supplier ? esc(it.supplier) : '', it.stock !== undefined && it.stock !== null ? `stock ${fq(it.stock)}` : '',
      Q.msg ? `<span class="ex-warnt">${esc(Q.msg)}</span>` : '',
      same.length ? `<span class="ex-warnt">already entered: ${same.map(r => r.day_known ? shortDay(r.expiry_date + 'T00:00:00') : monShort(r.expiry_date) + ' ' + r.expiry_date.slice(2, 4)).join(', ')}</span>` : '',
      sug ? `→ ${esc(sug)} (${esc(it.group)})` : '',
    ].filter(Boolean).join(' · ');
  }
  function bad(input, msg) { input.classList.add('ex-err'); setTimeout(() => input.classList.remove('ex-err'), 1300); showToast(msg, true); input.focus(); }
  const firstDate = () => el('exQDates')?.querySelector('[data-qi="0"][data-qf="ym"]');

  function wireQuick() {
    const q = el('exQuick'), item = el('exQItem');
    item.addEventListener('input', () => { Q.cam = false; if (Q.item || Q.choices || Q.msg) { Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = ''; paintFound(); } });
    q.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (e.target.closest('button')) return;   // a focused button does its own thing
        e.preventDefault();
        if ((e.ctrlKey || e.metaKey) && e.target !== item) return qSave();   // Ctrl+Enter: add now
        if (e.target === item) { if (Q.item) firstDate()?.focus(); else qFind(item.value); return; }
        // Enter goes to the next field (month → day → qty → shelf → worker, like the delivery row); on the last one it adds
        const fields = [...q.querySelectorAll('input, select')].filter(f => !f.disabled && f.offsetParent !== null);
        const next = fields[fields.indexOf(e.target) + 1];
        if (next) { next.focus(); if (next.select && next.tagName === 'INPUT') next.select(); return; }
        return qSave();
      }
      if (e.key === 'Escape') { e.preventDefault(); qClear(); item.focus(); return; }
      if (e.target.id === 'exQWho' && /^[1-9]$/.test(e.key)) { const w = S.workers[Number(e.key) - 1]; if (w) { e.target.value = wKey(w); Q.picked = true; } e.preventDefault(); }
    });
    q.addEventListener('click', e => {
      const b = e.target.closest('[data-q], [data-pick]'); if (!b) return;
      if (b.dataset.pick) return qFind(b.dataset.pick, true);
      const a = b.dataset.q;
      if (a === 'scan') return qScan();
      if (a === 'add') return qSave();
      if (a === 'plus') { const last = Q.dates[Q.dates.length - 1]; Q.dates.push({ ym: last ? last.ym : defaultYm(), day: 0, qty: '' }); return paintQDates(Q.dates.length - 1, 'ym'); }
      if (a === 'rm') { Q.dates.splice(Number(b.dataset.i), 1); return paintQDates(); }
    });
    q.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'exQWho') { Q.picked = true; return; }
      if (t.dataset.qi === undefined) return;
      const i = Number(t.dataset.qi), d = Q.dates[i]; if (!d) return;
      if (t.dataset.qf === 'ym') { d.ym = t.value; if (d.day > lastDay(d.ym)) d.day = 0; paintQDates(i, 'day'); }
      else if (t.dataset.qf === 'day') d.day = Number(t.value) || 0;
    });
    q.addEventListener('input', e => { const t = e.target; if (t.dataset.qf === 'qty') { const d = Q.dates[Number(t.dataset.qi)]; if (d) d.qty = t.value; } });
  }

  function qScan() {
    if (!window.Scanner) return el('exQItem')?.focus();
    Scanner.open({ title: 'Scan the item', continuous: false, onCode: code => { Q.cam = true; el('exQItem').value = code; qFind(code, true); return code; } });
  }
  async function qFind(raw, byCode) {
    const text = String(raw || '').trim(); if (!text || Q.busy) return null;
    Q.busy = true; Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = ''; paintFound('Looking for it…');
    const r = await lookupItem(text, byCode);
    Q.busy = false;
    Q.item = r.item || null; Q.choices = r.choices || null; Q.msg = r.msg || '';
    if (Q.item) {
      el('exQItem').value = Q.item.description ? `${Q.item.description} · ${Q.item.code}` : Q.item.code;
      Q.sugg = suggestFor(Q.item);
      if (Q.sugg && !Q.picked) el('exQWho').value = Q.sugg;
    }
    paintFound();
    if (Q.item) firstDate()?.focus();
    return Q.item;
  }
  function qClear() {
    Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = ''; Q.picked = false;
    el('exQItem').value = '';
    Q.dates = [{ ym: Q.dates[0]?.ym || defaultYm(), day: 0, qty: '' }];
    paintQDates(); paintFound();
  }
  // "another date" on an item already entered: the entry row takes that item, its shelf and its worker
  function quickAgain(r) {
    if (!Q.mounted) return;
    Q.item = { code: r.code, description: r.description || '', barcode: r.barcode || '', supplier: r.supplier || '', group: r.item_group || '' };
    Q.choices = null; Q.msg = ''; Q.sugg = ''; Q.picked = true; Q.cam = false;
    el('exQItem').value = r.description ? `${r.description} · ${r.code}` : r.code;
    Q.dates = [{ ym: ymOf(r.expiry_date), day: 0, qty: '' }];
    el('exQLoc').value = r.location || '';
    el('exQWho').value = rowKey(r);
    paintQDates(0, 'ym'); paintFound();
    el('exQuick').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  async function qSave() {
    if (Q.saving || Q.busy) return;
    const input = el('exQItem');
    if (!Q.item) {
      if (!input.value.trim()) return bad(input, 'Scan or type the item first.');
      if (!(await qFind(input.value))) return;
    }
    if (!Q.dates.length) return showToast('Choose the month it expires in.', true);
    const loc = el('exQLoc').value.trim(), who = el('exQWho').value, it = Q.item;
    const rows = Q.dates.map(d => rowFrom(it, d, loc, who));
    Q.saving = true; el('exQuick').classList.add('saving');
    const { data, error } = await sb.from('expiries').insert(rows).select();
    Q.saving = false; el('exQuick')?.classList.remove('saving');
    if (error) return showToast(friendlyError(error), true);
    (data || []).forEach(replaceRow);
    S.lastWorker = who; S.lastLoc = loc; S.lastYm = Q.dates[0].ym;
    const ids = (data || []).map(r => r.id); flash(ids);
    if (S.month) S.folds[`${S.month}|${who}`] = true;
    const name = data?.[0]?.assigned_name || '';
    showToast(`Added: ${it.description || it.code} · ${rows.length} date${rows.length === 1 ? '' : 's'}${name ? ' → ' + name : ''}`);
    logActivity('expiries', 'add', { type: 'expiry', id: ids[0] }, `Expiry: ${it.description || it.code} — ${rows.map(r => r.day_known ? r.expiry_date : r.expiry_date.slice(0, 7)).join(', ')}${name ? ' · given to ' + name : ''}`);
    qClear(); pill(); paint();
    if (Q.cam) qScan(); else if (pointerFine()) input.focus();
  }

  /* ---------------- edit one item ---------------- */
  function openEdit(r) {
    el('exEditOv')?.remove();
    const d = { ym: ymOf(r.expiry_date), day: r.day_known ? Number(r.expiry_date.slice(8)) : 0 };
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="exEditOv"><div class="modal-box ex-add" role="dialog" aria-modal="true" aria-label="Edit expiry">
      <div class="ex-addhead"><h3>Edit expiry</h3><button type="button" class="icon-btn" data-x="close" aria-label="Close" title="Close (Esc)">${ICON.close}</button></div>
      <div class="ex-addbody">
        <div class="ex-picked"><b>${esc(r.description || r.code)}</b><span class="mono">${esc(r.code)}${r.supplier ? ' · ' + esc(r.supplier) : ''}</span></div>
        <div class="ex-edit-grid">
          <label>Month<select id="exEYm">${monthOpts(d.ym)}</select></label>
          <label>Day<select id="exEDay">${dayOpts(d)}</select></label>
          <label>Quantity<input type="text" id="exEQty" inputmode="decimal" value="${esc(r.qty ?? '')}" autocomplete="off"></label>
          <label>Shelf<input type="text" id="exELoc" value="${esc(r.location || '')}" autocomplete="off"></label>
          <label class="full">Shelf worker<select id="exEWho">${workerOpts(rowKey(r), r)}</select></label>
          <label class="full">Note<input type="text" id="exENote" value="${esc(r.note || '')}" autocomplete="off"></label>
        </div>
      </div>
      <div class="ex-addfoot"><button type="button" class="btn ghost" data-x="close">Cancel</button><button type="button" class="btn" data-x="save">Save</button></div>
    </div></div>`);
    const ov = el('exEditOv');
    const onKey = e => { if (e.key === 'Escape') close(); else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); save(); } };
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    el('exEYm').addEventListener('change', () => { d.ym = el('exEYm').value; d.day = Number(el('exEDay').value) || 0; if (d.day > lastDay(d.ym)) d.day = 0; el('exEDay').innerHTML = dayOpts(d); });
    ov.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === 'close') close(); else save(); });
    let saving = false;
    async function save() {
      if (saving) return; saving = true;
      d.ym = el('exEYm').value; d.day = Number(el('exEDay').value) || 0; d.qty = el('exEQty').value.trim();
      const it = { code: r.code, description: r.description, barcode: r.barcode, supplier: r.supplier, group: r.item_group };
      const change = rowFrom(it, d, el('exELoc').value.trim(), el('exEWho').value, el('exENote').value.trim());
      const { data, error } = await sb.from('expiries').update(change).eq('id', r.id).select().single();
      saving = false;
      if (error) return showToast(friendlyError(error), true);
      replaceRow(data); flash([r.id]); close(); pill(); paint();
      showToast('Saved.');
      logActivity('expiries', 'edit', { type: 'expiry', id: r.id }, `Changed the expiry of ${r.description || r.code} (${change.expiry_date})`);
    }
  }

  function show() {
    wire();
    if (!S.rows) load(); else { paint(); load(); }
    if (isMgr() && pointerFine()) setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) el('exQItem')?.focus(); }, 60);   // a computer with a barcode gun: ready to scan
  }
  // after sign-in: the menu badge (expired or within 7 days)
  function start() { if (!S.rows) load(); }
  function refresh() { return load(); }

  window.Expiries = { show, start, refresh };
})();
