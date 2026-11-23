/* ============================================================
   Payment appointments (owner, 2026-11-23; migration 106): the day (and
   time) a supplier comes to be paid. Any day, any time.
   Calendar: a month; click a day to see its appointments in time order
   and mark each one Paid / Didn't come, or Move it to another day (the
   old one stays as "Moved", the new one is booked). List: what needs a
   status (a past day still "booked"), the upcoming ones, and the past.
   Who booked it and who set the status (and when) come from the database.
   Permission: payments.appointments (accountant, admin).
   Public API: window.PayAppts = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-payappts');
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const today = () => beirutToday();
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1 + n, 1).toLocaleDateString('en-CA').slice(0, 7); };
  const monthLabel = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const fmtLong = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const hm = t => t ? String(t).slice(0, 5) : '';
  const stamp = ts => ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const STATUS = { booked: 'Booked', paid: 'Paid', no_show: "Didn't come", moved: 'Moved' };
  const IC = {
    prev: '<path d="M15 18l-6-6 6-6"/>', next: '<path d="M9 18l6-6-6-6"/>', check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', move: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>', undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  };
  const svg = k => `<svg class="ui-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[k]}</svg>`;
  const S = { started: false, tab: 'calendar', month: null, day: null, rows: [], vendors: [], when: 'todo', missing: false };

  /* ---------------- data ---------------- */
  async function load() {
    const [{ data, error }, v] = await Promise.all([
      sb.from('payment_appointments').select('*').order('day').order('at_time', { nullsFirst: true }),
      S.vendors.length ? { data: null } : sb.from('vendors').select('name').order('name'),
    ]);
    S.missing = !!error;
    if (error) { console.warn('Payment appointments not available (migration 106?)', error.message); S.rows = []; }
    else S.rows = data || [];
    if (v.data) { const seen = new Set(); S.vendors = v.data.map(x => String(x.name || '').trim()).filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())); }
  }
  const byTime = (a, b) => a.day.localeCompare(b.day) || (a.at_time || '').localeCompare(b.at_time || '') || a.supplier.localeCompare(b.supplier);
  const onDay = d => S.rows.filter(r => r.day === d).sort(byTime);
  const late = r => r.status === 'booked' && r.day < today();          // a past day still waiting for its status
  const shown = r => r.status !== 'moved';                              // the calendar shows where it is now

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="filter-row pa-top" style="justify-content:space-between;flex-wrap:wrap;">
        <div id="paTabs" style="display:flex;gap:8px;">
          <button data-tab="calendar">Calendar</button>
          <button data-tab="list">List <span class="sh-tab-n" id="paTodoN" hidden></span></button>
        </div>
        <button class="btn small" id="paAdd">+ Book appointment</button>
      </div>
      <div id="paNotice"></div>
      <div id="paBody"></div>`;
    el('paTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; render(); } };
    el('paAdd').onclick = () => openForm(null, { day: S.tab === 'calendar' && S.day && S.day >= today() ? S.day : today() });
    panel.addEventListener('click', bodyClick);
    ensureModal();
  }
  function render() {
    panel.querySelectorAll('#paTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    const todo = S.rows.filter(late).length;
    el('paTodoN').hidden = !todo; el('paTodoN').textContent = todo;
    el('paNotice').innerHTML = S.missing ? '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> Payment appointments can be saved once migration 106 is applied.</p></div>' : '';
    if (S.tab === 'calendar') renderCalendar(); else renderList();
  }

  /* ---------------- calendar ---------------- */
  function renderCalendar() {
    const ym = S.month, first = new Date(ym + '-01T00:00:00');
    const gridStart = addDays(ym + '-01', -((first.getDay() + 6) % 7));   // weeks start on Monday
    const days = [...Array(42).keys()].map(i => addDays(gridStart, i));
    const lastRow = days.findLastIndex(d => d.startsWith(ym));
    const cells = days.slice(0, Math.ceil((lastRow + 1) / 7) * 7);
    const t = today();
    if (!S.day || !S.day.startsWith(ym)) S.day = t.startsWith(ym) ? t : ym + '-01';
    const month = S.rows.filter(r => r.day.startsWith(ym) && shown(r));
    const n = k => month.filter(r => r.status === k).length;
    el('paBody').innerHTML = `
      <div class="card pl-cal-card">
        <div class="pl-cal-head">
          <button class="icon-btn" data-m="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC.prev}</svg></button>
          <h3>${esc(monthLabel(ym))}</h3>
          <button class="icon-btn" data-m="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC.next}</svg></button>
          <button class="btn ghost small" data-m="0">Today</button>
          <span class="pl-cal-sum">${month.length} appointment${month.length === 1 ? '' : 's'} · ${n('paid')} paid · ${n('booked')} booked${n('no_show') ? ` · ${n('no_show')} didn't come` : ''}</span>
        </div>
        <div class="pl-cal">
          ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="pl-dow">${d}</div>`).join('')}
          ${cells.map(d => {
            const list = onDay(d).filter(shown);
            return `<div class="pl-day ${d.startsWith(ym) ? '' : 'out'} ${d === t ? 'today' : ''} ${d === S.day ? 'sel' : ''}" data-day="${d}">
              <div class="pl-dnum">${Number(d.slice(8))}</div>
              ${list.slice(0, 4).map(r => `<button type="button" class="pl-chip pa-chip pa-${late(r) ? 'late' : r.status}" data-edit="${r.id}" title="${esc(`${hm(r.at_time) || 'Any time'} · ${r.supplier} · ${late(r) ? 'no status yet' : STATUS[r.status]}${r.note ? ' · ' + r.note : ''}`)}">${r.at_time ? `<b>${hm(r.at_time)}</b> ` : ''}${esc(r.supplier)}</button>`).join('')}
              ${list.length > 4 ? `<span class="pl-more">+${list.length - 4} more</span>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="pl-legend pa-legend"><span><i class="pa-booked"></i> Booked</span><span><i class="pa-paid"></i> Paid</span><span><i class="pa-no_show"></i> Didn't come</span><span><i class="pa-late"></i> Past, no status yet</span>
          <span class="muted-note">Click a day to see its appointments; click a name to edit.</span></div>
      </div>
      <div class="card" id="paDayCard">${dayHtml(S.day)}</div>`;
  }
  // One day: its appointments in time order, each with its status buttons.
  function dayHtml(d) {
    const list = onDay(d);
    return `<div class="pl-dayhead"><h3>${esc(fmtLong(d))}</h3>
        ${d >= today() ? `<button class="btn small secondary" data-add="${d}">+ Book on this day</button>` : ''}</div>
      ${list.length ? `<ul class="pl-daylist pa-list">${list.map(itemHtml).join('')}</ul>` : '<p class="muted-note" style="margin:6px 0 0;">No appointment on this day.</p>'}`;
  }
  function itemHtml(r) {
    const moved = r.status === 'moved' ? S.rows.find(x => x.id === r.moved_to) : null;
    const who = r.status !== 'booked' && r.status_by_name ? ` · ${esc(r.status_by_name)}, ${esc(stamp(r.status_at))}` : '';
    return `<li class="pa-item pa-st-${late(r) ? 'late' : r.status}" data-id="${r.id}">
      <span class="pa-time">${r.at_time ? hm(r.at_time) : '<span class="muted-note">Any time</span>'}</span>
      <div class="pl-dl-main"><b>${esc(r.supplier)}</b>
        <span class="pa-badge pa-${late(r) ? 'late' : r.status}">${late(r) ? 'No status yet' : STATUS[r.status]}</span>
        <div class="muted-note">${moved ? `Moved to ${esc(fmt(moved.day))}${moved.at_time ? ' ' + hm(moved.at_time) : ''}` : ''}${r.note ? (moved ? ' · ' : '') + esc(r.note) : ''}${r.created_by_name ? `${moved || r.note ? ' · ' : ''}booked by ${esc(r.created_by_name)}` : ''}${who}</div></div>
      <div class="pa-acts">
        ${r.status === 'booked' ? `<button type="button" class="sc-btn ok" data-st="paid" title="They came and were paid">${svg('check')} Paid</button>
          <button type="button" class="sc-btn other" data-st="no_show" title="They did not come">${svg('x')} Didn't come</button>
          <button type="button" class="btn ghost small" data-move="${r.id}" title="Give them another day">${svg('move')} Move</button>`
        : r.status !== 'moved' || !moved ? `<button type="button" class="btn ghost small" data-st="booked" title="Back to booked">${svg('undo')} Undo</button>` : ''}
        ${r.status !== 'moved' ? `<button type="button" class="btn ghost small" data-edit="${r.id}">Edit</button>` : ''}
      </div></li>`;
  }

  /* ---------------- list ---------------- */
  function renderList() {
    const t = today();
    const sets = {
      todo: S.rows.filter(late).sort(byTime),
      upcoming: S.rows.filter(r => r.status === 'booked' && r.day >= t).sort(byTime),
      past: S.rows.filter(r => r.status !== 'booked').sort((a, b) => byTime(b, a)),
    };
    const list = sets[S.when];
    el('paBody').innerHTML = `
      <div class="filter-row">
        <div id="paWhen" style="display:flex;gap:8px;flex-wrap:wrap;">
          ${[['todo', 'Needs a status'], ['upcoming', 'Upcoming'], ['past', 'Done']].map(([k, l]) => `<button data-when="${k}" class="${S.when === k ? 'active' : ''}">${l} <span class="sh-tab-n">${sets[k].length}</span></button>`).join('')}
        </div>
      </div>
      <div class="card">${list.length ? `<ul class="pl-daylist pa-list pa-biglist">${list.map(r => `<li class="pa-dayrow"><span class="pa-date">${esc(fmt(r.day))}</span></li>${itemHtml(r)}`).join('')}</ul>`
        : `<p class="empty-note" style="margin:0;">${S.when === 'todo' ? 'Every past appointment has its status.' : S.when === 'upcoming' ? 'No appointment booked ahead — use “+ Book appointment”.' : 'Nothing yet.'}</p>`}</div>`;
  }

  /* ---------------- clicks ---------------- */
  async function bodyClick(e) {
    const t = e.target;
    const m = t.closest('[data-m]');
    if (m) { S.month = m.dataset.m === '0' ? today().slice(0, 7) : addMonths(S.month, Number(m.dataset.m)); S.day = m.dataset.m === '0' ? today() : null; return renderCalendar(); }
    const w = t.closest('[data-when]'); if (w) { S.when = w.dataset.when; return renderList(); }
    const add = t.closest('[data-add]'); if (add) return openForm(null, { day: add.dataset.add });
    const ed = t.closest('[data-edit]'); if (ed) { e.stopPropagation(); return openForm(ed.dataset.edit); }
    const mv = t.closest('[data-move]'); if (mv) { const r = S.rows.find(x => x.id === mv.dataset.move); return openForm(null, { day: addDays(r.day < today() ? today() : r.day, 1), at_time: r.at_time, supplier: r.supplier, note: r.note, moveFrom: r }); }
    const st = t.closest('[data-st]'); if (st) return setStatus(S.rows.find(x => x.id === st.closest('[data-id]').dataset.id), st.dataset.st);
    const day = t.closest('.pl-cal [data-day]');
    if (day) {
      S.day = day.dataset.day;
      if (!S.day.startsWith(S.month)) { S.month = S.day.slice(0, 7); return renderCalendar(); }
      panel.querySelectorAll('.pl-day.sel').forEach(x => x.classList.remove('sel')); day.classList.add('sel');
      el('paDayCard').innerHTML = dayHtml(S.day);
    }
  }
  async function setStatus(r, status) {
    if (!r || r.status === status) return;
    const { data, error } = await sb.from('payment_appointments').update({ status }).eq('id', r.id).select().single();
    if (error) return showToast('Not saved — ' + friendlyError(error), true);
    Object.assign(r, data);
    logActivity('payappts', 'status', { type: 'payment_appointment', id: r.id }, `${r.supplier} · ${fmt(r.day)}${r.at_time ? ' ' + hm(r.at_time) : ''}: ${STATUS[status]}`);
    render();
  }

  /* ---------------- book / edit / move ---------------- */
  function ensureModal() {
    if (el('paOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="paOverlay">
        <div class="modal-box form-box">
          <h3 id="paTitle" style="margin:0 0 16px;font-family:var(--font-head);"></h3>
          <form id="paForm" autocomplete="off">
            <div class="form-grid">
              <div class="full"><label for="paSupplier">Supplier</label>
                <input type="text" id="paSupplier" list="paVendors" required placeholder="Choose a vendor…"><datalist id="paVendors"></datalist>
                <p class="muted-note" id="paSupWarn" hidden style="margin:4px 0 0;color:var(--gold);">Not in the Vendors list — pick a vendor, or keep this name if it is right.</p></div>
              <div><label for="paDay">Day</label><input type="date" id="paDay" required></div>
              <div><label for="paTime">Time <span style="opacity:.6;">(optional)</span></label><input type="time" id="paTime"></div>
              <div class="full"><label for="paNote">Note <span style="opacity:.6;">(optional)</span></label><input type="text" id="paNote" placeholder="e.g. invoices of October, cheque ready"></div>
            </div>
            <p class="muted-note" id="paClash" hidden style="margin:10px 0 0;color:var(--gold);"></p>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="paDelete" style="margin-right:auto;color:var(--brick);">Delete</button>
              <button type="button" class="btn ghost small" id="paCancel">Cancel</button>
              <button type="submit" class="btn small" id="paSave">Save</button>
            </div>
          </form>
        </div>
      </div>`);
    const ov = el('paOverlay');
    ov.onclick = e => { if (e.target === ov) closeForm(); };
    el('paCancel').onclick = closeForm;
    el('paDelete').onclick = removeRow;
    el('paSupplier').oninput = checkForm;
    el('paDay').onchange = checkForm;
    el('paTime').onchange = checkForm;
    el('paForm').onsubmit = submit;
  }
  let editing = null, moveFrom = null;
  function openForm(id, pre = {}) {
    if (S.missing) return showToast('Payment appointments can be saved once migration 106 is applied.', true);
    const r = id ? S.rows.find(x => x.id === id) : null;
    editing = r; moveFrom = pre.moveFrom || null;
    el('paTitle').textContent = r ? `Edit — ${r.supplier}` : moveFrom ? `Move — ${moveFrom.supplier}` : 'Book a payment appointment';
    const names = [...new Set([...S.vendors, ...S.rows.map(x => x.supplier)])].sort((a, b) => a.localeCompare(b));
    el('paVendors').innerHTML = names.map(v => `<option value="${esc(v)}">`).join('');
    el('paSupplier').value = r ? r.supplier : pre.supplier || '';
    el('paDay').value = r ? r.day : pre.day || today();
    el('paTime').value = hm(r ? r.at_time : pre.at_time);
    el('paNote').value = r ? r.note || '' : pre.note || '';
    el('paDelete').hidden = !r;
    el('paSave').textContent = moveFrom ? 'Move' : 'Save';
    checkForm();
    el('paOverlay').classList.add('open');
    (moveFrom ? el('paDay') : el('paSupplier')).focus();
  }
  const closeForm = () => { el('paOverlay').classList.remove('open'); editing = null; moveFrom = null; };
  // Not a known vendor; and who else is booked that day (at that time).
  function checkForm() {
    const v = el('paSupplier').value.trim().toLowerCase();
    el('paSupWarn').hidden = !v || !S.vendors.length || S.vendors.some(x => x.toLowerCase() === v);
    const d = el('paDay').value, tm = el('paTime').value;
    const same = S.rows.filter(r => r.day === d && r.status === 'booked' && r !== editing && r !== moveFrom);
    const clash = tm ? same.filter(r => hm(r.at_time) === tm) : [];
    const p = el('paClash');
    p.hidden = !same.length;
    p.textContent = clash.length ? `Already at ${tm}: ${clash.map(r => r.supplier).join(', ')}.`
      : same.length ? `Also booked that day: ${same.map(r => (r.at_time ? hm(r.at_time) + ' ' : '') + r.supplier).join(', ')}.` : '';
  }
  async function submit(e) {
    e.preventDefault();
    const supplier = el('paSupplier').value.trim(), day = el('paDay').value;
    if (!supplier) return showToast('Choose the supplier.', true);
    if (!day) return showToast('Pick the day.', true);
    const row = { supplier, day, at_time: el('paTime').value || null, note: el('paNote').value.trim() || null };
    const when = `${fmt(day)}${row.at_time ? ' ' + row.at_time : ''}`;
    el('paSave').disabled = true;
    try {
      if (editing) {
        const { data, error } = await sb.from('payment_appointments').update(row).eq('id', editing.id).select().single();
        if (error) return showToast('Could not save — ' + friendlyError(error), true);
        Object.assign(editing, data);
        logActivity('payappts', 'edit', { type: 'payment_appointment', id: data.id }, `Edited payment appointment: ${supplier} · ${when}`);
      } else {
        const { data, error } = await sb.from('payment_appointments').insert(row).select().single();
        if (error) return showToast('Could not save — ' + friendlyError(error), true);
        S.rows.push(data);
        if (moveFrom) {   // the old one stays, marked "Moved" and pointing to the new one
          const { data: old, error: e2 } = await sb.from('payment_appointments').update({ status: 'moved', moved_to: data.id }).eq('id', moveFrom.id).select().single();
          if (e2) showToast('The new appointment is booked, but the old one could not be marked moved — ' + friendlyError(e2), true);
          else Object.assign(moveFrom, old);
          logActivity('payappts', 'move', { type: 'payment_appointment', id: data.id }, `Moved ${supplier}'s payment appointment from ${fmt(moveFrom.day)} to ${when}`);
        } else logActivity('payappts', 'create', { type: 'payment_appointment', id: data.id }, `Booked payment appointment: ${supplier} · ${when}`);
      }
    } finally { el('paSave').disabled = false; }
    const wasMove = !!moveFrom;
    S.tab = S.tab === 'list' && !wasMove ? S.tab : 'calendar';
    S.month = day.slice(0, 7); S.day = day;
    closeForm(); render();
    showToast(wasMove ? `Moved to ${when}.` : 'Saved.');
  }
  async function removeRow() {
    const r = editing; if (!r) return;
    if (!(await showConfirm(`Delete ${r.supplier}'s payment appointment of ${fmt(r.day)}${r.at_time ? ' ' + hm(r.at_time) : ''}?`, 'Delete'))) return;
    const { error } = await sb.from('payment_appointments').delete().eq('id', r.id);
    if (error) return showToast('Could not delete — ' + friendlyError(error), true);
    S.rows = S.rows.filter(x => x !== r);
    logActivity('payappts', 'delete', { type: 'payment_appointment', id: r.id }, `Deleted payment appointment: ${r.supplier} · ${fmt(r.day)}`);
    closeForm(); render();
    showToast('Deleted.');
  }

  window.PayAppts = {
    async show() {
      if (!can('payments.appointments')) return;
      if (!S.started) { S.started = true; S.month = today().slice(0, 7); shell(); }
      await load();
      render();
    },
    _state: S,
  };
})();
