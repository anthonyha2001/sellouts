/* ============================================================
   Expiries (owner, 2026-10-12): the items on the shelves that expire soon.
   Rebuilt the same day (owner: "more professional, more simple and faster"): one table.
   Floor manager (expiry.manage):
     - the entry row on top, always there: scan (camera or barcode gun) or type the item, Enter; its month,
       day (optional) and quantity; "+ date" for another date of the same item; the shelf and the shelf
       worker are kept for the next item (keys 1–9 pick a worker); Enter adds it;
     - then one table: filters open / expired / this week / this month / later / done, a search, the
       supplier and the shelf worker; each row edited, given another date or deleted on its own; "Send to
       the admin" sends the open rows not sent yet; Export puts the rows shown in Excel (choose a supplier
       to send them their list).
   Admin (expiry.decide): the same table, deciding on each row (return, repricing, merchandiser, sales),
   marking done, and ticking rows to decide / give / mark done / delete them together.
   Shelf worker (expiry.work): only theirs, and big buttons to mark each one done.
   Table public.expiries (migrations 084, 085); shelf workers from expiry_workers(). Items from the system:
   lv-dashboard items_lookup / item_search.
   Public API: window.Expiries = { show, start, refresh }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // what was done on the shelf; a new price ("discount") only after the admin decided repricing (owner, 2026-10-12: the
  // floor manager only sends the request, the admin decides)
  const OUT = { removed: 'Removed', discount: 'Repriced', returned: 'Returned', sold: 'Sold out' };
  const OUT_LONG = { removed: 'Removed from the shelf', discount: 'New price on the shelf', returned: 'Returned to the supplier', sold: 'Sold before it expired', other: 'Done' };
  // the ways to close an item: what the admin decided first; "Repriced" only when the admin decided repricing
  const outsFor = r => r.decision === 'reprice' ? ['discount', 'removed', 'sold'] : r.decision === 'return' ? ['returned', 'removed', 'sold'] : ['removed', 'returned', 'sold'];
  // the admin's decision on an expiry sent (migration 085)
  const DEC = { return: 'Return to supplier', reprice: 'Repricing', merchandiser: 'Merchandiser will handle', sales: 'Request to the sales' };
  const S = { rows: null, workers: [], loading: false, err: '', month: null, who: 'all', status: 'open', lastWorker: '', lastLoc: '', lastYm: '', folds: {}, flash: new Set(),
    view: 'months', dStatus: 'todo', dGroup: 'supplier', lp: {}, lpBusy: false, justDecided: new Set(), decGroups: {} };
  const Q = { look: null, item: null, choices: null, msg: '', sugg: '', saving: false, dates: [], cam: false, picked: false, mounted: false };
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
    xls: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
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
    paint();
    return data;
  }
  function flash(ids) {
    ids.forEach(id => S.flash.add(id));
    setTimeout(() => { ids.forEach(id => S.flash.delete(id)); document.querySelectorAll('#panel-expiries .flash').forEach(x => { if (!S.flash.has(x.dataset.id)) x.classList.remove('flash'); }); }, 2600);
  }
  // an item from the system: a code / barcode, or a name (then the choices)
  const plainItem = c => ({ code: c, description: '', barcode: /^\d{8,}$/.test(c) ? c : '', supplier: '', group: '' });
  // a name (to search, maybe several answers), not a code or a barcode
  const looksLikeName = (q, byCode) => !byCode && !/^[\d\s.-]{4,}$/.test(q) && !/^[A-Za-z]{0,3}\d{3,}$/.test(q);
  async function lookupItem(raw, byCode) {
    const q = String(raw || '').trim();
    const isName = looksLikeName(q, byCode);
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

  /* ---------------- the page (owner, 2026-10-12: "more professional, more simple and faster"): the entry row, then ONE table ----------------
     Filters: open / expired / this week / this month / later / done, a search, the supplier, the shelf worker. Each row: the date and
     how far it is, the item, the supplier, the quantity, the shelf, the worker, where it stands (to send, sent, the admin's decision,
     done) and its own edit / another date / delete. The floor manager changes one row at a time and sends to the admin; the admin
     decides on the row (or ticks rows and does it for all of them: decide, give, mark done, delete). Export: the rows shown, to Excel
     (one supplier = the list to send them). The shelf worker keeps the big buttons (their own items only). */
  const F = { when: 'open', q: '', sup: '', who: 'all', sel: new Set() };
  const decChip = r => r.decision ? `<span class="ex-dec k-${r.decision}" title="${esc((r.decided_by_name ? 'Decided by ' + r.decided_by_name : '') + (r.decision_note ? ' — ' + r.decision_note : ''))}">${esc(DEC[r.decision] || r.decision)}</span>`
    : r.submitted_at ? '<span class="ex-dec k-sent">Sent to the admin</span>' : '<span class="ex-dec k-none">Not sent yet</span>';
  const decOpts = sel => Object.entries(DEC).map(([k, l]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${l}</option>`).join('');
  const supOf = r => String(r.supplier || '').replace(/\s+\d+\s*$/, '').trim();
  const WHEN = [['open', 'All open'], ['expired', 'Expired'], ['week', 'This week'], ['month', 'This month'], ['later', 'Later'], ['done', 'Done']];
  function inWhen(r, w) {
    if (w === 'done') return r.status === 'done';
    if (r.status !== 'open') return false;
    const n = daysTo(r.expiry_date);
    return w === 'open' ? true : w === 'expired' ? n < 0 : w === 'week' ? n >= 0 && n <= 7 : w === 'month' ? n >= 0 && ymOf(r.expiry_date) === curYm() : w === 'later' ? ymOf(r.expiry_date) > curYm() : true;
  }
  const baseRows = () => (S.rows || []).filter(r => (F.who === 'all' ? true : F.who === 'none' ? !rowKey(r) : rowKey(r) === F.who)
    && (!F.sup || supOf(r) === F.sup)
    && (!F.q.trim() || [r.description, r.code, r.barcode, r.supplier, r.location, r.note].some(v => String(v || '').toLowerCase().includes(F.q.trim().toLowerCase()))));
  const shownRows = () => baseRows().filter(r => inWhen(r, F.when)).sort(F.when === 'done' ? (a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')) : byDate);
  // the vendor of the app for a supplier name (its contract: does it take back expired goods)
  const norm = s => String(s || '').toUpperCase().replace(/\s+\d+\s*$/, '').replace(/[^A-Z0-9؀-ۿ]/g, '');
  function vendorOf(name) {
    const list = typeof vendorsList !== 'undefined' ? vendorsList : [], k = norm(name);
    if (!k || !list.length) return null;
    return list.find(x => norm(x.name) === k || (x.systemSuppliers || []).some(s => norm(s.name) === k)) || null;
  }
  function contractHtml(v) {
    if (!v) return '<span class="ex-k">Not linked to a vendor: no contract to show</span>';
    const c = window.VendorContract ? VendorContract.summary(v.contract) : null;
    if (!c) return '<span class="ex-k">No contract recorded</span>';
    const ret = c.expiredReturns === 'yes' ? '<span class="ex-k ok">Takes back expired goods</span>'
      : c.expiredReturns === 'no' ? '<span class="ex-k bad">Does not take back expired goods</span>' : '<span class="ex-k">Expired goods: not in the contract</span>';
    return [ret, c.paymentDays !== null && c.paymentDays !== '' ? `<span class="ex-k">Payment ${esc(c.paymentDays)} days</span>` : '',
      c.to ? `<span class="ex-k ${c.expired ? 'bad' : ''}">Contract ${c.expired ? 'ended' : 'until'} ${esc(fmtDate(c.to))}</span>` : ''].filter(Boolean).join('');
  }

  function paint() {
    const box = el('panel-expiries'); if (!box) return;
    if (!el('exBody')) { box.innerHTML = '<div id="exQuickBox"></div><div id="exBar"></div><div id="exBody"></div>'; Q.mounted = false; }
    const body = el('exBody');
    if (!S.rows) { el('exBar').innerHTML = ''; body.innerHTML = `<div class="card"><p class="${S.err ? 'empty-note' : 'muted-note'}" style="margin:0;">${esc(S.err || 'Loading the expiries…')}</p></div>`; return; }
    mountQuick();
    if (!isMgr()) return paintWorker(body);
    paintBar(); paintTable();
  }
  // the bar: the filters (kept while typing in the search)
  function paintBar() {
    const bar = el('exBar'), a = document.activeElement, typing = a && a.id === 'exSearch', pos = typing ? a.selectionStart : 0;
    const base = baseRows(), open = base.filter(r => r.status === 'open');
    const cnt = w => base.filter(r => inWhen(r, w)).length;
    const sups = [...new Set((S.rows || []).filter(r => r.status === 'open' || F.when === 'done').map(supOf).filter(Boolean))].sort();
    const toSend = open.filter(r => !r.submitted_at).length, toDecide = open.filter(r => r.submitted_at && !r.decision).length;
    bar.innerHTML = `<div class="ex-bar2">
      <div class="filter-row ex-when">${WHEN.map(([k, l]) => `<button type="button" data-when="${k}" class="${F.when === k ? 'active' : ''} ${k === 'expired' && cnt(k) ? 'hot' : ''}">${l} <span class="ex-n">${cnt(k)}</span></button>`).join('')}</div>
      <div class="ex-tools">
        <input type="search" id="exSearch" placeholder="Find an item, a code, a shelf…" value="${esc(F.q)}" aria-label="Find">
        <select id="exSup" aria-label="Supplier"><option value="">All suppliers</option>${sups.map(s => `<option value="${esc(s)}" ${s === F.sup ? 'selected' : ''}>${esc(s)}</option>`).join('')}${F.sup && !sups.includes(F.sup) ? `<option selected value="${esc(F.sup)}">${esc(F.sup)}</option>` : ''}</select>
        <select id="exWho" aria-label="Shelf worker">${[['all', 'All workers'], ['none', 'Not given yet'], ...S.workers.map(w => [wKey(w), w.name])].map(([v, l]) => `<option value="${esc(v)}" ${F.who === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <span class="ex-sp"></span>
        ${S.loading ? '<span class="muted-note">updating…</span>' : ''}
        ${isDec() && toDecide ? `<span class="ex-k">${toDecide} to decide</span>` : ''}
        ${toSend ? `<button type="button" class="btn small" data-ex="send" title="Send the open rows not sent yet (as filtered) to the admin, who decides">Send ${toSend} to the admin</button>` : ''}
        <button type="button" class="icon-btn" data-ex="export" title="Export the rows shown to Excel (choose a supplier first to send them their list)" aria-label="Export to Excel">${ICON.xls}</button>
      </div>
      ${F.sup ? `<div class="ex-supbar"><b>${esc(F.sup)}</b>${contractHtml(vendorOf(F.sup))}${vendorOf(F.sup) ? `<button type="button" class="btn ghost small" data-ex-vendor="${esc(vendorOf(F.sup).id)}">Vendor sheet</button>` : ''}</div>` : ''}
    </div>`;
    if (typing) { const s = el('exSearch'); s.focus(); s.setSelectionRange(pos, pos); }
  }
  function whenText(r) {
    if (r.status === 'done') return `<span class="ex-done-t">${esc(OUT[r.outcome] || 'Done')}${r.done_at ? ' · ' + esc(shortDay(r.done_at)) : ''}</span>`;
    const n = daysTo(r.expiry_date);
    return `<span class="ex-when-t u-${urg(r)}">${n < 0 ? `expired ${-n}d ago` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : n <= 31 ? `in ${n} days` : `in ${Math.round(n / 30)} months`}</span>`;
  }
  function trHtml(r) {
    const done = r.status === 'done', adm = isDec();
    const date = r.day_known ? fmtDate(r.expiry_date) : `${monthName(ymOf(r.expiry_date))} ${r.expiry_date.slice(0, 4)}`;
    const stat = done ? `${decChip(r)}${adm ? `<button type="button" class="ex-undo" data-ex-undo="${r.id}" title="Back to open">Undo</button>` : ''}`
      : adm && r.submitted_at ? `<select class="ex-decsel${r.decision ? ' k-' + r.decision : ''}" data-ex-dec="${r.id}" aria-label="Decision"><option value="">Decide…</option>${decOpts(r.decision)}</select>`
      : decChip(r);
    return `<tr data-id="${r.id}" class="u-${done ? 'done' : urg(r)}${S.flash.has(r.id) ? ' flash' : ''}${F.sel.has(r.id) ? ' sel' : ''}">
      ${adm ? `<td class="ex-ck"><input type="checkbox" data-ex-ck="${r.id}" ${F.sel.has(r.id) ? 'checked' : ''} aria-label="Select"></td>` : ''}
      <td class="ex-c-date"><b>${esc(date)}</b>${whenText(r)}</td>
      <td class="ex-c-item"><b>${esc(r.description || r.code)}</b><small><span class="mono">${esc(r.code)}</span>${r.location ? ' · shelf ' + esc(r.location) : ''}${r.note ? ' · ' + esc(r.note) : ''}</small></td>
      <td class="ex-c-sup">${esc(supOf(r)) || '<span class="muted-note">—</span>'}</td>
      <td class="num">${r.qty !== null && r.qty !== undefined ? fq(r.qty) : '<span class="muted-note">—</span>'}</td>
      <td><select class="ex-give" data-ex-give="${r.id}" aria-label="Shelf worker" ${done ? 'disabled' : ''}>${workerOpts(rowKey(r), r)}</select></td>
      <td class="ex-c-stat">${stat}</td>
      <td class="ex-c-act">${done ? '' : adm ? `<select class="ex-outsel" data-ex-out="${r.id}" aria-label="Mark done" title="Mark done"><option value="">Done…</option>${outsFor(r).map(o => `<option value="${o}">${OUT[o]}</option>`).join('')}</select>` : ''}
        <button type="button" class="vb-ico" data-ex-again="${r.id}" aria-label="Another date for this item" data-tip="Another date">${ICON.plus}</button><button type="button" class="vb-ico" data-ex-edit="${r.id}" aria-label="Edit" data-tip="Edit">${ICON.edit}</button><button type="button" class="vb-ico vb-x" data-ex-del="${r.id}" aria-label="Delete" data-tip="Delete">${ICON.del}</button></td>
    </tr>`;
  }
  function paintTable() {
    const body = el('exBody'), list = shownRows(), adm = isDec();
    F.sel.forEach(id => { if (!list.some(r => r.id === id)) F.sel.delete(id); });
    const units = list.reduce((t, r) => t + Number(r.qty || 0), 0);
    const bulk = adm && F.sel.size ? `<div class="ex-bulk"><b>${F.sel.size} selected</b>
        <select data-ex="bdec" aria-label="Decide for the selected"><option value="">Decide…</option>${decOpts('')}</select>
        ${S.workers.length ? `<select data-ex="bgive" aria-label="Give the selected to"><option value="">Give to…</option><option value="-">Nobody</option>${S.workers.map(w => `<option value="${esc(wKey(w))}">${esc(w.name)}</option>`).join('')}</select>` : ''}
        <select data-ex="bdone" aria-label="Mark the selected done"><option value="">Mark done…</option>${Object.entries(OUT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <button type="button" class="vb-ico vb-x" data-ex="bdel" data-tip="Delete the selected" aria-label="Delete the selected">${ICON.del}</button>
        <button type="button" class="btn ghost small" data-ex="bclear">Clear</button></div>` : '';
    body.innerHTML = `${bulk}<div class="card ex-tcard"><div class="items-scroll ex-scroll"><table class="items ex-tbl"><thead><tr>
        ${adm ? `<th class="ex-ck"><input type="checkbox" data-ex="ckall" ${list.length && list.every(r => F.sel.has(r.id)) ? 'checked' : ''} aria-label="Select all shown"></th>` : ''}
        <th>Expires</th><th>Item</th><th>Supplier</th><th class="num">Qty</th><th>Worker</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map(trHtml).join('') || `<tr><td colspan="${adm ? 8 : 7}" class="empty-note">${F.when === 'done' ? 'Nothing done in the last 90 days.' : 'Nothing here.'}</td></tr>`}</tbody></table></div>
      <p class="muted-note ex-foot">${list.length} row${list.length === 1 ? '' : 's'}${units ? ` · ${fq(units)} pcs` : ''}. A month without a day counts as its last day. ${adm ? 'Tick rows to decide, give, mark done or delete them together.' : 'Edit or delete a row with its icons; send the new ones to the admin.'}</p></div>`;
  }
  // the shelf worker: their items, big buttons
  function paintWorker(body) {
    el('exBar').innerHTML = `<div class="filter-row ex-when">${[['open', 'To do'], ['done', 'Done']].map(([k, l]) => `<button type="button" data-when="${k}" class="${(F.when === 'done' ? 'done' : 'open') === k ? 'active' : ''}">${l} <span class="ex-n">${(S.rows || []).filter(r => inWhen(r, k)).length}</span></button>`).join('')}</div>`;
    const list = (S.rows || []).filter(r => inWhen(r, F.when === 'done' ? 'done' : 'open')).sort(byDate);
    body.innerHTML = list.length ? `<div class="ex-list">${list.map(cardHtml).join('')}</div>` : `<p class="empty-note ex-empty">${F.when === 'done' ? 'Nothing done yet.' : 'Nothing to do ✓'}</p>`;
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
          : `<div class="ex-outs">${outsFor(r).map(o => `<button type="button" class="ex-out" data-ex-done="${r.id}" data-o="${o}">${OUT[o]}</button>`).join('')}</div>`}</div>
      </div>
    </article>`;
  }

  // the floor manager sends the open rows not sent yet (as filtered) to the admin
  async function send() {
    const ids = baseRows().filter(r => r.status === 'open' && !r.submitted_at).map(r => r.id);
    if (!ids.length) return;
    const out = await patch(ids, { submitted_at: new Date().toISOString() });
    if (!out) return;
    flash(ids); paint();
    showToast(`${out.length} expir${out.length === 1 ? 'y' : 'ies'} sent to the admin.`);
    logActivity('expiries', 'send', { type: 'expiry', id: ids[0] }, `${out.length} expiries sent to the admin`);
  }
  // the rows shown, to Excel (a supplier chosen = the list to send them)
  function exportXls() {
    const list = shownRows();
    if (!list.length) return showToast('Nothing to export.', true);
    const aoa = [['Supplier', 'Code', 'Barcode', 'Item', 'Expires', 'Quantity', 'Shelf', 'Note', 'Status']];
    list.forEach(r => aoa.push([supOf(r), String(r.code), String(r.barcode || ''), r.description || '', r.day_known ? r.expiry_date.split('-').reverse().join('-') : `${monthName(ymOf(r.expiry_date))} ${r.expiry_date.slice(0, 4)}`,
      r.qty === null || r.qty === undefined ? '' : Number(r.qty), r.location || '', r.note || '', r.status === 'done' ? OUT_LONG[r.outcome] || 'Done' : r.decision ? DEC[r.decision] : r.submitted_at ? 'Sent to the admin' : 'Open']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (let i = 2; i <= aoa.length; i++) ['B', 'C'].forEach(col => { const c = ws[col + i]; if (c) { c.t = 's'; c.v = String(c.v); } });
    ws['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 15 }, { wch: 40 }, { wch: 14 }, { wch: 9 }, { wch: 10 }, { wch: 24 }, { wch: 20 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Expiries');
    XLSX.writeFile(wb, `Expiries${F.sup ? ' ' + F.sup.replace(/[\\/:*?"<>|]+/g, ' ') : ''} ${todayStr()}.xlsx`);
  }

  async function markDone(row, outcome) {
    const out = await patch([row.id], { status: 'done', outcome });
    if (!out) return;
    showToast(`${row.description || row.code}: ${OUT_LONG[outcome].toLowerCase()}.`);
    logActivity('expiries', 'done', { type: 'expiry', id: row.id }, `Expiry ${OUT_LONG[outcome].toLowerCase()}: ${row.description || row.code} (${row.expiry_date})`);
  }
  async function delRows(rows) {
    const one = rows.length === 1 ? rows[0] : null;
    const msg = one ? `Delete the expiry of "${one.description || one.code}" (${one.day_known ? fmtDate(one.expiry_date) : monthName(ymOf(one.expiry_date)) + ' ' + one.expiry_date.slice(0, 4)})?` : `Delete these ${rows.length} expiries?`;
    if (!(await showConfirm(msg, 'Delete'))) return;
    const ids = rows.map(r => r.id);
    const { error } = await sb.from('expiries').delete().in('id', ids);
    if (error) return showToast(friendlyError(error), true);
    S.rows = S.rows.filter(x => !ids.includes(x.id)); ids.forEach(id => F.sel.delete(id)); pill(); paint();
    logActivity('expiries', 'delete', { type: 'expiry', id: ids[0] }, one ? `Deleted the expiry of ${one.description || one.code} (${one.expiry_date})` : `Deleted ${ids.length} expiries`);
  }

  function wire() {
    const box = el('panel-expiries'); if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('click', async e => {
      if (e.target.closest('#exQuickBox')) return;   // the entry row has its own
      const w = e.target.closest('[data-when]'); if (w) { F.when = w.dataset.when; return paint(); }
      const t = e.target.closest('[data-ex], [data-ex-done], [data-ex-undo], [data-ex-edit], [data-ex-del], [data-ex-again], [data-ex-vendor]'); if (!t) return;
      const a = t.dataset.ex;
      if (a === 'send') return send();
      if (a === 'export') return exportXls();
      if (a === 'bclear') { F.sel.clear(); return paintTable(); }
      if (a === 'bdel') return delRows(S.rows.filter(r => F.sel.has(r.id)));
      if (t.dataset.exVendor) return typeof openVendorDetail === 'function' && openVendorDetail(t.dataset.exVendor);
      const row = S.rows.find(x => x.id === (t.dataset.exDone || t.dataset.exUndo || t.dataset.exEdit || t.dataset.exDel || t.dataset.exAgain)); if (!row) return;
      if (t.dataset.exDone) return markDone(row, t.dataset.o);
      if (t.dataset.exUndo) { const out = await patch([row.id], { status: 'open' }); if (out) logActivity('expiries', 'undo', { type: 'expiry', id: row.id }, `Expiry back to do: ${row.description || row.code}`); return; }
      if (t.dataset.exAgain) return quickAgain(row);
      if (t.dataset.exEdit) return openEdit(row);
      if (t.dataset.exDel) return delRows([row]);
    });
    box.addEventListener('input', e => { if (e.target.id === 'exSearch') { F.q = e.target.value; paintBar(); paintTable(); } });
    box.addEventListener('change', async e => {
      const t = e.target;
      if (t.closest('#exQuickBox')) return;
      if (t.id === 'exSup') { F.sup = t.value; return paint(); }
      if (t.id === 'exWho') { F.who = t.value; return paint(); }
      if (t.dataset.ex === 'ckall') { shownRows().forEach(r => t.checked ? F.sel.add(r.id) : F.sel.delete(r.id)); return paintTable(); }
      if (t.dataset.exCk) { t.checked ? F.sel.add(t.dataset.exCk) : F.sel.delete(t.dataset.exCk); return paintTable(); }
      // the admin, on the selected rows
      if (['bdec', 'bgive', 'bdone'].includes(t.dataset.ex) && t.value) {
        const ids = [...F.sel]; if (!ids.length) return;
        const change = t.dataset.ex === 'bdec' ? { decision: t.value } : t.dataset.ex === 'bgive' ? keyPatch(t.value === '-' ? '' : t.value) : { status: 'done', outcome: t.value };
        const out = await patch(ids, change);
        if (out) { flash(ids); F.sel.clear(); paint(); showToast(`${out.length} row${out.length === 1 ? '' : 's'} changed.`); logActivity('expiries', 'bulk', { type: 'expiry', id: ids[0] }, `${out.length} expiries: ${t.dataset.ex === 'bdec' ? DEC[t.value] : t.dataset.ex === 'bgive' ? 'given to ' + (out[0].assigned_name || 'nobody') : OUT_LONG[t.value]}`); }
        return;
      }
      if (t.dataset.exDec) {
        const row = S.rows.find(x => x.id === t.dataset.exDec); if (!row) return;
        const out = await patch([row.id], { decision: t.value || null });
        if (out && out[0]) logActivity('expiries', 'decide', { type: 'expiry', id: row.id }, `Expiry of ${row.description || row.code} (${row.expiry_date}): ${DEC[t.value] || 'no decision'}`);
        return;
      }
      if (t.dataset.exOut) { const row = S.rows.find(x => x.id === t.dataset.exOut); if (row && t.value) markDone(row, t.value); return; }
      if (t.dataset.exGive !== undefined) {
        const row = S.rows.find(x => x.id === t.dataset.exGive); if (!row) return;
        const out = await patch([row.id], keyPatch(t.value));
        if (out && out[0]) {
          flash([row.id]); paint();
          showToast(out[0].assigned_name ? `Given to ${out[0].assigned_name}.` : 'Not given to anyone now.');
          logActivity('expiries', 'give', { type: 'expiry', id: row.id }, `Expiry of ${row.description || row.code} given to ${out[0].assigned_name || 'nobody'}`);
        }
      }
    });
  }

  /* ---------------- the entry row ---------------- */
  const defaultYm = () => S.lastYm || curYm();
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
    // typing another item drops the one looked up before
    item.addEventListener('input', () => { Q.cam = false; if (Q.look || Q.item || Q.choices || Q.msg) { Q.look = null; Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = ''; paintFound(); } });
    // leaving the field starts the look-up, in the background
    item.addEventListener('change', () => { if (!Q.item) startLookup(item.value); });
    q.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (e.target.closest('button')) return;   // a focused button does its own thing
        e.preventDefault();
        if ((e.ctrlKey || e.metaKey) && e.target !== item) return qSave();   // Ctrl+Enter: add now
        // the item: its look-up starts in the background and the cursor goes on to the month at once (no waiting)
        if (e.target === item) { if (!item.value.trim()) return; if (!Q.item) startLookup(item.value); firstDate()?.focus(); return; }
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
      if (b.dataset.pick) { startLookup(b.dataset.pick, true); firstDate()?.focus(); return; }
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
    Scanner.open({ title: 'Scan the item', continuous: false, onCode: code => {
      Q.cam = true; el('exQItem').value = code; startLookup(code, true);
      setTimeout(() => firstDate()?.focus(), 0);   // on to the month while the item loads
      return code;
    } });
  }
  // the item is looked up in the background (owner, 2026-10-12: "don't make the floor manager wait"): the month, day,
  // qty, shelf and worker can be filled meanwhile, and Add saves at once
  function startLookup(raw, byCode) {
    const text = String(raw || '').trim(); if (!text) return null;
    if (Q.look && Q.look.text === text) return Q.look;
    const look = { text, name: looksLikeName(text, byCode), done: false, result: null };
    look.promise = lookupItem(text, byCode).then(r => { look.done = true; look.result = r; if (Q.look === look) applyLookup(look); return r; });
    Q.look = look; Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = '';
    paintFound(look.name ? 'Searching…' : 'Looking it up… keep filling, it saves anyway');
    return look;
  }
  function applyLookup(look) {
    const r = look.result || {};
    Q.item = r.item || null; Q.choices = r.choices || null; Q.msg = r.msg || '';
    if (Q.item) {
      el('exQItem').value = Q.item.description ? `${Q.item.description} · ${Q.item.code}` : Q.item.code;
      Q.sugg = suggestFor(Q.item);
      if (Q.sugg && !Q.picked) el('exQWho').value = Q.sugg;
    }
    paintFound();
  }
  function qClear() {
    Q.look = null; Q.item = null; Q.choices = null; Q.msg = ''; Q.sugg = ''; Q.picked = false;
    el('exQItem').value = '';
    Q.dates = [{ ym: Q.dates[0]?.ym || defaultYm(), day: 0, qty: '' }];
    paintQDates(); paintFound();
  }
  // "another date" on an item already entered: the entry row takes that item, its shelf and its worker
  function quickAgain(r) {
    if (!Q.mounted) return;
    Q.look = null;
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
    if (Q.saving) return;
    const input = el('exQItem');
    let it = Q.item, later = null;
    if (!it) {
      const look = Q.look || startLookup(input.value);
      if (!look) return bad(input, 'Scan or type the item first.');
      // a name has to be found first (it can have several answers); a code or a barcode never waits
      if (look.name && !look.done) { await look.promise; if (Q.look !== look) return; }
      if (look.done) {
        const r = look.result || {};
        if (r.choices) return bad(input, 'Pick the item in the list first.');
        if (!r.item) return bad(input, r.msg || 'Item not found.');
        it = r.item;
      } else { it = plainItem(look.text); later = look; }   // saved now with the code as typed; its name is filled when it arrives
    }
    if (!Q.dates.length) return showToast('Choose the month it expires in.', true);
    const loc = el('exQLoc').value.trim(), who = el('exQWho').value;
    const rows = Q.dates.map(d => rowFrom(it, d, loc, who));
    Q.saving = true; el('exQuick').classList.add('saving');
    const { data, error } = await sb.from('expiries').insert(rows).select();
    Q.saving = false; el('exQuick')?.classList.remove('saving');
    if (error) return showToast(friendlyError(error), true);
    (data || []).forEach(replaceRow);
    S.lastWorker = who; S.lastLoc = loc; S.lastYm = Q.dates[0].ym;
    const ids = (data || []).map(r => r.id); flash(ids);
    if (later) fillLater(later, ids);
    const name = data?.[0]?.assigned_name || '';
    showToast(`Added: ${it.description || it.code} · ${rows.length} date${rows.length === 1 ? '' : 's'}${name ? ' → ' + name : ''}`);
    logActivity('expiries', 'add', { type: 'expiry', id: ids[0] }, `Expiry: ${it.description || it.code} — ${rows.map(r => r.day_known ? r.expiry_date : r.expiry_date.slice(0, 7)).join(', ')}${name ? ' · given to ' + name : ''}`);
    qClear(); pill(); paint();
    if (Q.cam) qScan(); else if (pointerFine()) input.focus();
  }
  // an item saved before its look-up came back: its code, name, supplier and group are written on its rows when it does
  function fillLater(look, ids) {
    look.promise.then(async r => {
      const it = r && r.item;
      if (!it || (!it.description && it.code === look.text)) return;   // not found in the system: it stays as typed
      const { data, error } = await sb.from('expiries').update({ code: it.code, description: it.description || null, barcode: it.barcode || null,
        supplier: it.supplier || null, item_group: it.group || null }).in('id', ids).select();
      if (error || !data) return;
      data.forEach(replaceRow);
      const a = document.activeElement;
      if (!(a && el('exBody')?.contains(a))) paint();   // never under a field in use
    });
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
