/* ============================================================
   Staff schedule (owner, 2026-09-30): the weekly program of cashiers
   and supervisors. Shifts: AM 07:30–14:30, PM 14:30–22:00, Full
   07:30–22:00, Off; cashiers and supervisors work Front or Back.
   Week tab: create a week (copied from last week or empty), assign
   each person per day; under each group (supervisors, cashiers) a
   count of who works each day: AM / PM, Front / Back (owner,
   2026-10-01: no "needed each day"). Publish (then each person sees
   it on the cashier page after their PIN), print.
   Exact times (owner, 2026-10-01): someone arrives late or leaves early —
   right-click a cell (or the "Times…" brush, or T) to set its start / end;
   the cell, the printout and the cashier page show them, hours follow.
   Code: "am:front|08:30-14:30" (the "|…" part only when not the default).
   Staff tab: the staff list (the cashiers table): position, usual
   station, PIN, active.
   Permission: schedule.manage (role HR; admin). Migration 020.
   Public API: window.Schedule = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-schedule');
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const SHIFT = { am: { label: 'AM', time: '07:30–14:30', hours: 7 }, pm: { label: 'PM', time: '14:30–22:00', hours: 7.5 }, full: { label: 'Full', time: '07:30–22:00', hours: 14.5 } };
  const S = { brush: { shift: 'am', station: 'usual' }, started: false, tab: 'week', week: null, staff: [], row: null, prev: null, missing: false };

  const iso = d => d.toLocaleDateString('en-CA');
  const mondayOf = s => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const dayLabel = (s, opts) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', opts);
  const weekTitle = w => `${dayLabel(w, { day: 'numeric', month: 'short' })} – ${dayLabel(addDays(w, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const isSup = p => p.position === 'supervisor';
  // "am:front|08:30-13:00" -> shift, station, and the start / end when they differ from the shift's.
  const DEF = { am: ['07:30', '14:30'], pm: ['14:30', '22:00'], full: ['07:30', '22:00'] };
  const parse = code => {
    const [main, t] = String(code || '').split('|');
    const [shift, station] = main.split(':');
    const [start, end] = (t || '').split('-');
    return { shift: shift || '', station: station || '', start: start || '', end: end || '' };
  };
  const timesOf = code => { const x = parse(code); return SHIFT[x.shift] ? [x.start || DEF[x.shift][0], x.end || DEF[x.shift][1]] : null; };
  const custom = code => { const x = parse(code); return !!(SHIFT[x.shift] && (x.start || x.end)); };
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const hoursOf = code => { const t = timesOf(code); return t ? Math.max(0, mins(t[1]) - mins(t[0])) / 60 : 0; };
  const withTimes = (code, start, end) => {
    const x = parse(code); if (!SHIFT[x.shift]) return code;
    const main = x.shift + (x.station ? ':' + x.station : '');
    return start === DEF[x.shift][0] && end === DEF[x.shift][1] ? main : `${main}|${start}-${end}`;
  };
  // The code a shift gets for this person ("usual" = their usual station; supervisors too).
  const codeFor = (p, shift, station) => {
    if (!SHIFT[shift]) return shift;   // '' (clear) or 'off'
    return `${shift}:${station === 'usual' ? (p.default_station || 'front') : station}`;
  };
  const cellLabel = code => { const { shift, station } = parse(code); if (shift === 'off') return 'Off'; if (!SHIFT[shift]) return '—'; return SHIFT[shift].label + (station ? ' · ' + (station === 'front' ? 'Front' : 'Back') : ''); };
  // The cell: the shift, and its exact times when someone arrives late or leaves early.
  const cellHtml = code => { const t = custom(code) ? timesOf(code) : null; return esc(cellLabel(code)) + (t ? `<small class="sh-time">${t[0]}–${t[1]}</small>` : ''); };
  const KEYS = { a: 'am', p: 'pm', f: 'full', o: 'off', Delete: '', Backspace: '' };
  const BRUSHES = [['am', 'AM'], ['pm', 'PM'], ['full', 'Full'], ['off', 'Off'], ['', 'Clear'], ['time', 'Times…']];
  const STATIONS = [['usual', 'Usual'], ['front', 'Front'], ['back', 'Back']];

  /* ---------------- data ---------------- */
  async function loadStaff() {
    const { data, error } = await sb.from('cashiers').select('id, name, active, sort_order, has_pin, position, default_station').order('sort_order').order('name');
    S.missing = !!error;
    S.staff = data || [];
  }
  async function loadWeek() {
    const [cur, prev] = await Promise.all([
      sb.from('schedule_weeks').select('*').eq('week_start', S.week).maybeSingle(),
      sb.from('schedule_weeks').select('*').eq('week_start', addDays(S.week, -7)).maybeSingle(),
    ]);
    if (cur.error) { S.missing = true; return; }
    S.row = cur.data || null; S.prev = prev.data || null;
  }

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="filter-row" id="shTabs"><button data-tab="week">Week</button><button data-tab="staff">Staff</button></div>
      <div id="shBody"></div>`;
    el('shTabs').onclick = async e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; await refresh(); };
  }
  async function refresh() {
    await loadStaff();
    if (S.tab === 'week' && !S.missing) await loadWeek();
    render();
  }
  function render() {
    panel.querySelectorAll('#shTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    if (S.missing) { el('shBody').innerHTML = '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> The staff schedule works once migration 020 is applied.</p></div>'; return; }
    if (S.tab === 'staff') renderStaff(); else renderWeek();
  }

  /* ---------------- week ---------------- */
  const people = () => {
    const assigned = new Set(Object.keys(S.row?.assignments || {}));
    return S.staff.filter(p => p.active || assigned.has(p.id));
  };
  // Who of a group works that day: AM / PM (a full day counts in both) and by station.
  function groupCount(list, a, day) {
    const c = { am: 0, pm: 0, front: 0, back: 0 };
    list.forEach(p => {
      const { shift, station } = parse((a[p.id] || [])[day]);
      if (!SHIFT[shift]) return;
      if (shift === 'am' || shift === 'full') c.am++;
      if (shift === 'pm' || shift === 'full') c.pm++;
      const st = station || p.default_station;
      if (st === 'front') c.front++; else if (st === 'back') c.back++;
    });
    return c;
  }
  function renderWeek() {
    const w = S.week, row = S.row;
    const nav = `<div class="sh-weeknav">
        <button class="icon-btn" data-w="-7" aria-label="Previous week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3>Week of ${esc(weekTitle(w))}</h3>
        <button class="icon-btn" data-w="7" aria-label="Next week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <button class="btn ghost small" data-w="0">This week</button>
        ${row ? `<span class="badge ${row.published ? 'active' : 'warn'}">${row.published ? 'Published' : 'Draft — not visible to staff'}</span>` : ''}
        <span style="flex:1"></span>
        ${row ? `<button class="btn ghost small" id="shCopy" ${S.prev ? '' : 'disabled'} title="${S.prev ? 'Replace this week with last week’s schedule' : 'Last week has no schedule'}">Copy last week</button>
          <button class="btn secondary small" id="shPrint">Print</button>
          <button class="btn small" id="shPublish">${row.published ? 'Unpublish' : 'Publish'}</button>` : ''}
      </div>`;
    if (!row) {
      el('shBody').innerHTML = `${nav}
        <div class="card"><h3 style="margin:0 0 4px;">Create this week</h3>
          <div class="actions-row" style="justify-content:flex-start;margin-top:12px;">
            ${S.prev ? '<button class="btn" data-create="copy">Create — copy last week</button>' : ''}
            <button class="btn ${S.prev ? 'ghost' : ''}" data-create="empty">Create empty</button>
          </div></div>`;
      wireNav();
      el('shBody').querySelectorAll('[data-create]').forEach(b => b.onclick = () => create(b.dataset.create === 'copy'));
      return;
    }
    const a = row.assignments || {};
    const dates = DAYS.map((_, i) => addDays(w, i));
    const personRow = p => {
      const days = a[p.id] || [];
      const hours = Math.round(days.reduce((t, c) => t + hoursOf(c), 0) * 100) / 100;
      const off = days.filter(c => c === 'off').length;
      return `<tr data-p="${p.id}" data-grp="${isSup(p) ? 'sup' : 'cash'}">
        <th class="sh-name"><span class="sh-drag" data-drag title="Drag to move" aria-label="Drag to move"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg></span>${esc(p.name)}${p.active ? '' : ' <span class="muted-note">(inactive)</span>'}<small>${(isSup(p) ? 'Supervisor' : 'Cashier') + (p.default_station ? ' · ' + (p.default_station === 'front' ? 'Front' : 'Back') : '')}</small></th>
        ${dates.map((d, i) => { const c = days[i] || '', { shift } = parse(c); return `<td class="sh-cell sh-${shift || 'none'}"><button type="button" data-day="${i}" aria-label="${esc(p.name)} ${DAYS[i]}">${cellHtml(c)}</button></td>`; }).join('')}
        <td class="num sh-hours">${hours ? hours + 'h' : '—'}<small>${off} off</small></td></tr>`;
    };
    const sups = people().filter(isSup), cash = people().filter(p => !isSup(p));
    // The count row under a group: how many work each day.
    const countRow = (list, label) => `<tr class="sh-count"><th class="sh-name">${label} working</th>${dates.map((_, i) => {
      const c = groupCount(list, a, i);
      return `<td><b>AM ${c.am} · PM ${c.pm}</b><small>Front ${c.front} · Back ${c.back}</small></td>`; }).join('')}<td></td></tr>`;
    el('shBody').innerHTML = `${nav}
      <div class="card"><div class="sh-brush" id="shBrush">
          <span class="sh-brush-t">Brush</span>
          ${BRUSHES.map(([v, l]) => `<button type="button" class="sh-chip sh-${v || 'none'} ${S.brush.shift === v ? 'on' : ''}" data-bs="${v}">${l}</button>`).join('')}
          <span class="sh-brush-t">Station</span>
          ${STATIONS.map(([v, l]) => `<button type="button" class="sh-chip ${S.brush.station === v ? 'on' : ''}" data-bst="${v}">${l}</button>`).join('')}
          <span class="muted-note">Click or drag across the days. Arrives late / leaves early: right-click the cell (or the Times… brush). On a cell: A = AM, P = PM, F = Full, O = Off, T = times, Delete clears, arrows move.</span>
        </div>
        <div class="items-scroll" style="margin-bottom:0;"><table class="sh-grid">
        <thead><tr><th></th>${dates.map((d, i) => `<th>${DAYS[i]}<small>${dayLabel(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}<th class="num">Week</th></tr></thead>
        <tbody>
          ${sups.length ? `<tr class="sh-group"><td colspan="9">Supervisors</td></tr>${sups.map(personRow).join('')}${countRow(sups, 'Supervisors')}` : ''}
          ${cash.length ? `<tr class="sh-group"><td colspan="9">Cashiers</td></tr>${cash.map(personRow).join('')}${countRow(cash, 'Cashiers')}` : ''}
          ${!people().length ? '<tr><td colspan="9" class="empty-note">No staff yet — add them in the Staff tab.</td></tr>' : ''}
        </tbody>
      </table></div>
      <p class="muted-note" style="margin:10px 0 0;">AM ${SHIFT.am.time} · PM ${SHIFT.pm.time} · Full ${SHIFT.full.time}. Changes save by themselves; staff see the week once it is published.</p></div>`;
    wireNav();
    wireGrid(row);
    wireRowDrag();
    el('shCopy')?.addEventListener('click', copyLast);
    el('shPublish').onclick = togglePublish;
    el('shPrint').onclick = print;
  }
  // Brush painting (click / drag) and keyboard entry on the grid.
  // Drag a row by the handle next to the name: it moves among its own group only (supervisors
  // among supervisors, cashiers among cashiers). The order is the staff list's (sort_order), the
  // same one the Cash grid uses; the other group keeps its places.
  function wireRowDrag() {
    const tbody = el('shBody').querySelector('.sh-grid tbody');
    tbody.addEventListener('pointerdown', e => {
      const h = e.target.closest('[data-drag]'); if (!h || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const row = h.closest('tr'), grp = row.dataset.grp;
      const groupRows = () => [...tbody.querySelectorAll(`tr[data-grp="${grp}"]`)];
      const before = groupRows().map(r => r.dataset.p);
      row.classList.add('sh-dragging'); tbody.classList.add('sh-drag-on');
      const move = ev => {
        const others = groupRows().filter(r => r !== row);
        if (!others.length) return;
        const over = others.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (over) { if (over.previousElementSibling !== row) tbody.insertBefore(row, over); }
        else { const last = others[others.length - 1]; if (last.nextElementSibling !== row) last.after(row); }
      };
      const up = async () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        row.classList.remove('sh-dragging'); tbody.classList.remove('sh-drag-on');
        const after = groupRows().map(r => r.dataset.p);
        if (after.join() === before.join()) return;
        await saveGroupOrder(after, row.dataset.p);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
  }
  // The group's members take the group's slots of the whole list in their new order.
  async function saveGroupOrder(ids, movedId) {
    const list = [...S.staff].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const set = new Set(ids);
    let k = 0;
    const next = list.map(p => { if (!set.has(p.id)) return p; const id = ids[k++]; return S.staff.find(x => x.id === id); });
    const changed = next.map((p, i) => ({ p, i })).filter(({ p, i }) => p.sort_order !== i);
    for (const { p, i } of changed) {
      const { error } = await sb.from('cashiers').update({ sort_order: i }).eq('id', p.id);
      if (error) { showToast('Order not saved — ' + friendlyError(error), true); await loadStaff(); return renderWeek(); }
      p.sort_order = i;
    }
    S.staff.sort((a, b) => a.sort_order - b.sort_order);
    const moved = S.staff.find(x => x.id === movedId);
    if (changed.length) logActivity('schedule', 'reorder_staff', { type: 'cashier', id: movedId }, `Moved ${moved?.name || 'a person'} to place ${ids.indexOf(movedId) + 1} of the ${isSup(moved || {}) ? 'supervisors' : 'cashiers'}`);
    renderWeek();
  }

  function wireGrid(row) {
    el('shBrush').onclick = e => {
      const b = e.target.closest('[data-bs], [data-bst]'); if (!b) return;
      if (b.dataset.bst) S.brush.station = b.dataset.bst; else S.brush.shift = b.dataset.bs;
      el('shBrush').querySelectorAll('[data-bs]').forEach(x => x.classList.toggle('on', x.dataset.bs === S.brush.shift));
      el('shBrush').querySelectorAll('[data-bst]').forEach(x => x.classList.toggle('on', x.dataset.bst === S.brush.station));
    };
    const tbody = el('shBody').querySelector('.sh-grid tbody');
    const set = (btn, shift, station) => {
      if (shift === 'time') return false;   // the Times… brush opens the dialog instead
      const id = btn.closest('tr').dataset.p, p = S.staff.find(x => x.id === id); if (!p) return false;
      const days = (row.assignments[id] = row.assignments[id] || Array(7).fill(''));
      const code = codeFor(p, shift, station), i = Number(btn.dataset.day);
      if ((days[i] || '') === code) return false;
      days[i] = code;
      btn.innerHTML = cellHtml(code);
      btn.parentElement.className = `sh-cell sh-${parse(code).shift || 'none'}`;
      return true;
    };
    let painting = false, changed = false;
    tbody.onpointerdown = e => {
      const b = e.target.closest('button[data-day]'); if (!b || e.button !== 0) return;
      e.preventDefault(); b.focus();
      if (S.brush.shift === 'time') return editTimes(b, row);
      painting = true; changed = set(b, S.brush.shift, S.brush.station) || changed;
    };
    tbody.onpointermove = e => {
      if (!painting) return;
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sh-grid tbody button[data-day]');
      if (b) changed = set(b, S.brush.shift, S.brush.station) || changed;
    };
    const stop = () => { if (!painting) return; painting = false; if (changed) { changed = false; save(); renderWeek(); } };
    window.onpointerup = stop; tbody.onpointercancel = stop;
    tbody.oncontextmenu = e => { const b = e.target.closest('button[data-day]'); if (!b) return; e.preventDefault(); editTimes(b, row); };
    tbody.onkeydown = e => {
      const b = e.target.closest('button[data-day]'); if (!b || e.ctrlKey || e.metaKey || e.altKey) return;
      const ids = [...tbody.querySelectorAll('tr[data-p]')].map(tr => tr.dataset.p);
      let r = ids.indexOf(b.closest('tr').dataset.p), d = Number(b.dataset.day), edit = false;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 't') { e.preventDefault(); return editTimes(b, row); }
      if (key in KEYS) { if (set(b, KEYS[key], S.brush.station)) save(); d = Math.min(6, d + 1); edit = true; }
      else if (key === 'Enter' || key === ' ') { if (set(b, S.brush.shift, S.brush.station)) save(); d = Math.min(6, d + 1); edit = true; }
      else if (key === 'ArrowRight') d = Math.min(6, d + 1);
      else if (key === 'ArrowLeft') d = Math.max(0, d - 1);
      else if (key === 'ArrowDown') r = Math.min(ids.length - 1, r + 1);
      else if (key === 'ArrowUp') r = Math.max(0, r - 1);
      else return;
      e.preventDefault();
      if (edit) renderWeek();
      el('shBody').querySelector(`.sh-grid tr[data-p="${ids[r]}"] button[data-day="${d}"]`)?.focus();
    };
  }
  // Arrives late / leaves early: the cell's shift, station and exact start / end.
  function editTimes(btn, row) {
    const id = btn.closest('tr').dataset.p, p = S.staff.find(x => x.id === id); if (!p) return;
    const i = Number(btn.dataset.day);
    const days = (row.assignments[id] = row.assignments[id] || Array(7).fill(''));
    let x = parse(days[i]);
    if (!SHIFT[x.shift]) {   // empty or Off: start from the brush's shift (or AM)
      const sh = SHIFT[S.brush.shift] ? S.brush.shift : 'am';
      x = parse(codeFor(p, sh, S.brush.station));
    }
    if (!el('shTimeOverlay')) document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="shTimeOverlay">
        <div class="modal-box form-box sh-time-box">
          <h3 id="shTimeTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
          <form id="shTimeForm" autocomplete="off">
            <div class="form-grid">
              <div><label for="shTShift">Shift</label><select id="shTShift"><option value="am">AM</option><option value="pm">PM</option><option value="full">Full day</option></select></div>
              <div><label for="shTStation">Station</label><select id="shTStation"><option value="front">Front</option><option value="back">Back</option></select></div>
              <div><label for="shTFrom">Arrives at</label><input type="time" id="shTFrom" required></div>
              <div><label for="shTTo">Leaves at</label><input type="time" id="shTTo" required></div>
            </div>
            <p class="muted-note" id="shTNote" style="margin:10px 0 0;"></p>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="shTReset" style="margin-right:auto;">Usual times</button>
              <button type="button" class="btn ghost small" id="shTCancel">Cancel</button>
              <button type="submit" class="btn small">Save</button>
            </div>
          </form>
        </div>
      </div>`);
    const ov = el('shTimeOverlay');
    const fill = (shift, keepTimes) => {
      el('shTShift').value = shift;
      if (!keepTimes) { el('shTFrom').value = DEF[shift][0]; el('shTTo').value = DEF[shift][1]; }
      el('shTNote').textContent = `Usual ${SHIFT[shift].label}: ${DEF[shift][0]}–${DEF[shift][1]}.`;
    };
    el('shTimeTitle').textContent = `${p.name} — ${DAYS[i]} ${dayLabel(addDays(S.week, i), { day: 'numeric', month: 'short' })}`;
    el('shTStation').value = x.station || p.default_station || 'front';
    el('shTFrom').value = x.start || DEF[x.shift][0];
    el('shTTo').value = x.end || DEF[x.shift][1];
    fill(x.shift, true);
    el('shTShift').onchange = () => fill(el('shTShift').value, false);
    el('shTReset').onclick = () => fill(el('shTShift').value, false);
    const close = () => { ov.classList.remove('open'); btn.focus(); };
    el('shTCancel').onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    el('shTimeForm').onsubmit = e => {
      e.preventDefault();
      const shift = el('shTShift').value, from = el('shTFrom').value, to = el('shTTo').value;
      if (!from || !to || mins(to) <= mins(from)) return showToast('"Leaves at" must be after "Arrives at".', true);
      days[i] = withTimes(`${shift}:${el('shTStation').value}`, from, to);
      ov.classList.remove('open');
      save(); renderWeek();
      el('shBody').querySelector(`.sh-grid tr[data-p="${id}"] button[data-day="${i}"]`)?.focus();
    };
    ov.classList.add('open');
    setTimeout(() => el('shTFrom').focus(), 30);
  }

  function wireNav() {
    el('shBody').querySelectorAll('[data-w]').forEach(b => b.onclick = async () => { S.week = b.dataset.w === '0' ? mondayOf(beirutToday()) : addDays(S.week, Number(b.dataset.w)); await loadWeek(); render(); });
  }
  // Last week's assignments for the people still active (inactive ones dropped).
  const copied = () => { const out = {}; const active = new Set(S.staff.filter(p => p.active).map(p => p.id)); Object.entries(S.prev?.assignments || {}).forEach(([id, d]) => { if (active.has(id)) out[id] = d.slice(0, 7); }); return out; };
  async function create(copy) {
    const row = { week_start: S.week, assignments: copy ? copied() : {}, published: false };
    const { data, error } = await sb.from('schedule_weeks').insert(row).select().single();
    if (error) return showToast('Could not create the week — ' + friendlyError(error), true);
    S.row = data;
    logActivity('schedule', 'create', { type: 'schedule_week', id: S.week }, `Created the schedule of the week ${weekTitle(S.week)}${copy ? ' (copied from last week)' : ''}`);
    renderWeek();
  }
  async function copyLast() {
    if (!(await showConfirm(`Replace this week's schedule with last week's (${weekTitle(addDays(S.week, -7))})?`, 'Copy'))) return;
    S.row.assignments = copied(); await save(true); renderWeek();
  }
  let timer = null;
  function save(now) {
    clearTimeout(timer);
    const go = async () => {
      const { error } = await sb.from('schedule_weeks').update({ assignments: S.row.assignments, published: S.row.published }).eq('week_start', S.row.week_start);
      if (error) showToast('Not saved — ' + friendlyError(error), true);
    };
    if (now) return go();
    timer = setTimeout(go, 400);
  }
  async function togglePublish() {
    const on = !S.row.published;
    if (on) {
      const empty = people().filter(p => !(S.row.assignments[p.id] || []).some(Boolean)).map(p => p.name);
      if (empty.length && !(await showConfirm(`${empty.length} ${empty.length === 1 ? 'person has' : 'people have'} nothing this week (${empty.slice(0, 5).join(', ')}${empty.length > 5 ? '…' : ''}). Publish anyway?`, 'Publish'))) return;
    }
    S.row.published = on; await save(true);
    logActivity('schedule', on ? 'publish' : 'unpublish', { type: 'schedule_week', id: S.week }, `${on ? 'Published' : 'Unpublished'} the schedule of the week ${weekTitle(S.week)}`);
    showToast(on ? 'Published — staff see it on the cashier page.' : 'Unpublished.');
    renderWeek();
  }
  function print() {
    const w = S.week, a = S.row.assignments || {}, dates = DAYS.map((_, i) => addDays(w, i));
    const cell = (p, i) => { const { shift, station } = parse((a[p.id] || [])[i]); if (shift === 'off') return '<td class="off">Off</td>'; if (!SHIFT[shift]) return '<td></td>'; const code = (a[p.id] || [])[i], t = custom(code) ? timesOf(code) : null; return `<td class="${shift}"><b>${SHIFT[shift].label}</b>${station ? `<br><small>${station === 'front' ? 'Front' : 'Back'}</small>` : ''}${t ? `<br><small class="t">${t[0]}–${t[1]}</small>` : ''}</td>`; };
    const sect = (title, list) => list.length ? `<tr class="g"><td colspan="8">${title}</td></tr>${list.map(p => `<tr><th>${esc(p.name)}</th>${dates.map((_, i) => cell(p, i)).join('')}</tr>`).join('')}` : '';
    const win = window.open('', '_blank'); if (!win) return showToast('Allow pop-ups to print.', true);
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Schedule ${esc(weekTitle(w))}</title><style>
      body{font:13px Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px;color:#1943AF}p{margin:0 0 14px;color:#555}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:center}th{text-align:left;white-space:nowrap}
      thead th{text-align:center;background:#eef1ff}tr.g td{background:#1943AF;color:#fff;text-align:left;font-weight:700}
      small.t{color:#b25b00;font-weight:700}td.am{background:#e6f0ff}td.pm{background:#fff3dc}td.full{background:#e8f6ec}td.off{color:#999}small{color:#555}
      @media print{body{margin:8mm}}</style></head><body>
      <h1>La Valeur — Staff schedule</h1><p>Week of ${esc(weekTitle(w))} · AM ${SHIFT.am.time} · PM ${SHIFT.pm.time} · Full ${SHIFT.full.time}</p>
      <table><thead><tr><th></th>${dates.map((d, i) => `<th>${DAYS[i]}<br><small>${dayLabel(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}</tr></thead>
      <tbody>${sect('Supervisors', people().filter(isSup))}${sect('Cashiers', people().filter(p => !isSup(p)))}</tbody></table>
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    win.document.close();
  }

  /* ---------------- staff ---------------- */
  function renderStaff() {
    el('shBody').innerHTML = `
      <div class="card"><form id="shAdd" class="sh-add">
        <input type="text" id="shName" placeholder="Name" required>
        <select id="shPos"><option value="cashier">Cashier</option><option value="supervisor">Supervisor</option></select>
        <select id="shSt"><option value="front">Front</option><option value="back">Back</option></select>
        <button class="btn small" type="submit">+ Add</button></form></div>
      <div class="card"><div class="items-scroll" style="margin-bottom:0;"><table class="items">
        <thead><tr><th>Name</th><th>Position</th><th>Usual station</th><th>PIN (cashier page)</th><th>Status</th><th></th></tr></thead>
        <tbody id="shStaff">${S.staff.map(p => `<tr data-id="${p.id}">
          <td><b>${esc(p.name)}</b></td>
          <td><select data-f="position"><option value="cashier" ${!isSup(p) ? 'selected' : ''}>Cashier</option><option value="supervisor" ${isSup(p) ? 'selected' : ''}>Supervisor</option></select></td>
          <td>${`<select data-f="default_station"><option value="">—</option><option value="front" ${p.default_station === 'front' ? 'selected' : ''}>Front</option><option value="back" ${p.default_station === 'back' ? 'selected' : ''}>Back</option></select>`}</td>
          <td>${p.has_pin ? '<span class="badge active">Set</span>' : '<span class="badge warn">No PIN</span>'} <button class="btn ghost small" data-act="pin">${p.has_pin ? 'Reset' : 'Set PIN'}</button></td>
          <td>${p.active ? '<span class="badge active">Active</span>' : '<span class="badge inactive">Inactive</span>'}</td>
          <td><button class="btn ghost small" data-act="toggle">${p.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty-note">No staff yet.</td></tr>'}</tbody>
      </table></div><p class="muted-note" style="margin:10px 0 0;">This is the same list as the cashiers in Cash; supervisors keep their cash differences too.</p></div>`;
    el('shAdd').onsubmit = async e => {
      e.preventDefault();
      const name = el('shName').value.trim(); if (!name) return;
      const position = el('shPos').value;
      const sort = Math.max(0, ...S.staff.map(p => p.sort_order || 0)) + 1;
      const { error } = await sb.from('cashiers').insert({ name, sort_order: sort, position, default_station: el('shSt').value });
      if (error) return showToast(/duplicate|unique/i.test(error.message) ? `"${name}" is already on the list.` : 'Could not add — ' + friendlyError(error), true);
      logActivity('schedule', 'add_staff', { type: 'cashier', id: null }, `Added ${position} ${name}`);
      await loadStaff(); renderStaff(); showToast(`${name} added. Set a PIN so they can see their schedule.`);
    };
    el('shStaff').onchange = async e => {
      const f = e.target.dataset.f; if (!f) return;
      const p = S.staff.find(x => x.id === e.target.closest('tr').dataset.id);
      const patch = { [f]: e.target.value || null };
      const { error } = await sb.from('cashiers').update(patch).eq('id', p.id);
      if (error) return showToast('Not saved — ' + friendlyError(error), true);
      Object.assign(p, patch); renderStaff();
    };
    el('shStaff').onclick = async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const p = S.staff.find(x => x.id === b.closest('tr').dataset.id);
      if (b.dataset.act === 'toggle') {
        const { error } = await sb.from('cashiers').update({ active: !p.active }).eq('id', p.id);
        if (error) return showToast('Not saved — ' + friendlyError(error), true);
        p.active = !p.active; logActivity('schedule', p.active ? 'activate_staff' : 'deactivate_staff', { type: 'cashier', id: p.id }, `${p.active ? 'Activated' : 'Deactivated'} ${p.name}`);
        return renderStaff();
      }
      const suggestion = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
      const pin = await showPrompt(`4-digit PIN for ${p.name}:`, { defaultValue: suggestion, confirmLabel: 'Set PIN', placeholder: '4 digits' });
      if (pin === null) return;
      if (!/^\d{4}$/.test(pin.trim())) return showToast('The PIN must be exactly 4 digits.', true);
      const { error } = await sb.rpc('set_cashier_pin', { p_cashier: p.id, p_pin: pin.trim() });
      if (error) return showToast('Could not set the PIN — ' + friendlyError(error), true);
      p.has_pin = true; logActivity('schedule', 'set_pin', { type: 'cashier', id: p.id }, `Set a new PIN for ${p.name}`);
      renderStaff();
      await showConfirm(`PIN set. Give it to ${p.name} privately:\n\n${pin.trim()}\n\nThey open the cashier page, choose their name and type it to see their schedule.`, 'Done');
    };
  }

  window.Schedule = {
    async show() {
      if (!can('schedule.manage')) return;
      if (!S.started) { S.started = true; S.week = mondayOf(beirutToday()); shell(); }
      await refresh();
    },
    _state: S,
  };
})();
