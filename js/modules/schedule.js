/* ============================================================
   Staff schedule (owner, 2026-09-30): the weekly program of cashiers
   and supervisors. Shifts: AM 07:30–14:30, PM 14:30–22:00, Full
   07:30–22:00, Off; cashiers and supervisors work Front or Back.
   Week tab: create a week (copied from last week or empty), assign
   each person per day; under each group (supervisors, cashiers) a
   count of who works each day: AM / PM, Front / Back (owner,
   2026-10-01: no "needed each day"). Publish (then each person sees
   it on the cashier page after their PIN), print.
   Filling (owner, 2026-10-01): step 1 paint the shifts (AM / PM / Full /
   Off), step 2 paint Front or Back over them — one tool at a time.
   Exact times (owner, 2026-10-01): someone arrives late or leaves early —
   right-click a cell (or the "Times…" brush, or T) to set its start / end;
   the cell, the printout and the cashier page show them, hours follow.
   Code: "am:front|08:30-14:30" (the "|…" part only when not the default).
   Full day split (owner, 2026-10-02): "full:front/back" = AM at the front, PM at the back.
   Staff tab: the staff list (the cashiers table): position, usual
   station, PIN, active.
   Everyone (owner, 2026-10-03/04; migration 043): the people come from the Staff list only, one
   tab per department. Cashiers (cashier supervisors + cashiers) is the full schedule — stations,
   By day / By person, requests, publish for the cashier page. The others (Floor & shelves,
   Warehouse, Delivery, Deli, Meat, Fish, Vegetables, Bakery, Office) are a basic grid: shifts,
   times, print. PINs and usual stations are on the Staff page (the Staff tab here is gone). A person's key in
   the week is their cashiers-list id (cashiers, supervisors, pickers) or their staff id (others).
   Permission: schedule.manage (role HR; admin). Migration 020.
   Public API: window.Schedule = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-schedule');
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const SHIFT = { am: { label: 'AM', time: '07:30–14:30', hours: 7 }, pm: { label: 'PM', time: '14:30–22:00', hours: 7.5 }, full: { label: 'Full', time: '07:30–22:00', hours: 14.5 } };
  const S = { brush: { tool: 'am' }, view: 'grid', vday: null, vperson: null, started: false, tab: 'tills', week: null, staff: [], row: null, prev: null, missing: false };

  const iso = d => d.toLocaleDateString('en-CA');
  const mondayOf = s => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
  const dayLabel = (s, opts) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', opts);
  const weekTitle = w => `${dayLabel(w, { day: 'numeric', month: 'short' })} – ${dayLabel(addDays(w, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const isSup = p => p.position === 'supervisor';
  // Departments (owner, 2026-10-03), by job on the Staff page.
  const DEPTS = [
    ['sup', 'Cashier supervisors', ['cashier supervisor', 'supervisor']], ['cash', 'Cashiers', ['cashier']],
    ['floor', 'Floor & shelves', ['floor manager', 'shelf worker']], ['wh', 'Warehouse', ['warehouse keeper', 'warehouse worker']],
    ['delivery', 'Delivery', ['delivery supervisor', 'picker']], ['deli', 'Deli counter', ['deli counter']],
    ['meat', 'Meat counter', ['meat counter']], ['fish', 'Fish counter', ['fish counter']], ['veg', 'Fruits & vegetables', ['fruits & vegetables', 'vegetables']], ['bakery', 'Bakery', ['bakery']],
    ['cleaning', 'Cleaning', ['cleaning']], ['parking', 'Parking', ['parking']],
    ['office', 'Office', ['purchasing', 'senior accountant', 'accountant', 'data entry', 'hr']], ['other', 'Other', []]];
  const deptOf = p => DEPTS.find(([, , jobs]) => jobs.includes(String(p.job || '').trim().toLowerCase()))?.[0] || 'other';
  const DEPT_LABEL = Object.fromEntries(DEPTS.map(([k, l]) => [k, l]));
  // Front / Back: cashiers and cashier supervisors only.
  const hasStation = p => p.dept === 'sup' || p.dept === 'cash';
  // Break (migration 052): everyone but the cashiers and cashier supervisors — time and length, every working day.
  const hasBreak = p => !hasStation(p);
  const breakText = p => p.breakStart ? `Break ${p.breakStart} · ${p.breakMin || 30} min` : '';
  const breakBtn = p => hasBreak(p) ? `<button type="button" class="sh-break ${p.breakStart ? '' : 'none'}" data-break="${p.id}" title="Break time and length">${p.breakStart ? breakText(p) : 'Set break'}</button>` : '';
  // The tabs: Cashiers holds two departments; every other department is its own tab.
  const TABS = [['tills', 'Cashiers', ['sup', 'cash']], ...DEPTS.filter(([k]) => k !== 'sup' && k !== 'cash').map(([k, l]) => [k, l, [k]])];
  const tabOf = k => TABS.find(t => t[0] === k) || TABS[0];
  const isTills = () => S.tab === 'tills';
  const inTab = p => tabOf(S.tab)[2].includes(p.dept);
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
  // Stations: "front", "back", or for a full day "front/back" (AM half / PM half).
  const ST = s => s === 'front' ? 'Front' : s === 'back' ? 'Back' : '';
  const halves = st => { const [a, b] = String(st || '').split('/'); return [a || '', b || a || '']; };
  const isSplit = st => { const [a, b] = halves(st); return !!a && a !== b; };
  const joinSt = (a, b) => a === b ? a : `${a}/${b}`;
  const stLabel = st => isSplit(st) ? `AM ${ST(halves(st)[0])} · PM ${ST(halves(st)[1])}` : ST(halves(st)[0]);
  const stationsOf = st => [...new Set(halves(st).filter(Boolean))];   // for the Front / Back counts
  const cellLabel = code => { const { shift, station } = parse(code); if (shift === 'off') return 'Off'; if (!SHIFT[shift]) return '—'; return SHIFT[shift].label + (station && !isSplit(station) ? ' · ' + ST(station) : ''); };
  // The cell: the shift, its two stations when a full day is split, and its exact times when someone arrives late or leaves early.
  const cellHtml = code => { const t = custom(code) ? timesOf(code) : null, st = parse(code).station;
    return esc(cellLabel(code)) + (isSplit(st) ? `<small class="sh-split">${esc(stLabel(st))}</small>` : '') + (t ? `<small class="sh-time">${t[0]}–${t[1]}</small>` : ''); };
  // What a tool does to a cell. A shift keeps the cell's station (or takes the person's usual one);
  // Front / Back only change the station of a cell that already has a shift (and keep its times).
  const applyTool = (p, cur, tool) => {
    const x = parse(cur);
    if (tool === 'front' || tool === 'back') {
      if (!SHIFT[x.shift] || (p.dept && !hasStation(p))) return cur;
      const t = x.start || x.end ? `|${x.start || DEF[x.shift][0]}-${x.end || DEF[x.shift][1]}` : '';
      return `${x.shift}:${tool}${t}`;
    }
    if (!SHIFT[tool]) return tool;               // 'off', or '' to clear
    if (x.shift === tool) return cur;            // same shift: keep station and times
    let st = p.dept && !hasStation(p) ? '' : x.station || p.default_station || '';
    if (isSplit(st) && tool !== 'full') st = halves(st)[tool === 'am' ? 0 : 1];
    return tool + (st ? ':' + st : '');
  };
  // What someone asked for on a day ('' = nothing asked), and the small "asked PM" tag (green when the cell matches).
  const askOf = (id, day) => ((S.reqs || []).find(r => r.cashier_id === id)?.days || [])[day] || '';
  const ASK_LABEL = { am: 'AM', pm: 'PM', full: 'Full', off: 'Off' };
  const askTag = (id, day, code) => { const q = askOf(id, day); return q ? `<span class="sh-ask ${parse(code).shift === q ? 'ok' : ''}" title="Asked for ${ASK_LABEL[q]}">asked ${ASK_LABEL[q]}</span>` : ''; };
  const KEYS = { a: 'am', p: 'pm', f: 'full', o: 'off', 1: 'front', 2: 'back', Delete: '', Backspace: '' };
  const SHIFT_TOOLS = [['am', 'AM'], ['pm', 'PM'], ['full', 'Full'], ['off', 'Off']];
  const STATION_TOOLS = [['front', 'Front'], ['back', 'Back']];
  const OTHER_TOOLS = [['', 'Clear'], ['time', 'Times…']];

  /* ---------------- data ---------------- */
  // The people: the Staff list only (schedule_staff(), migration 043). id = their key in the week.
  async function loadStaff() {
    const { data, error } = await sb.rpc('schedule_staff');
    S.missing = !!error;
    S.staff = (data || []).map(r => ({ id: r.key, staffId: r.staff_id, cashierId: r.cashier_id, name: r.name, job: r.job, active: r.active,
      sort_order: r.sort_order, position: r.pos || null, default_station: r.default_station, has_pin: r.has_pin,
      fixed: Array.isArray(r.fixed_days) ? r.fixed_days.slice(0, 7) : [], breakStart: r.break_start || '', breakMin: r.break_minutes || null }));
    S.staff.forEach(p => { p.dept = deptOf(p); });
  }
  // The groups shown, in department order, with who is in them this week.
  const groups = () => DEPTS.map(([k, label]) => ({ k, label, list: people().filter(p => p.dept === k) })).filter(g => g.list.length);
  // Staff tab: the cashiers list part (cashiers and cashier supervisors: usual station, PIN).
  const tillStaff = () => S.staff.filter(p => p.cashierId && hasStation(p));
  // Who may do what: HR (schedule.manage) everything; supervisors (schedule.edit) edit, not publish.
  const isHR = () => can('schedule.manage');
  const dayPast = i => addDays(S.week, i) < beirutToday();
  // A published week is locked until "Unlock to edit" (per week); days already past never change.
  // Publishing (the cashier page) is for the Cashiers and Delivery tabs only — the people with a PIN
  // (owner, 2026-10-04). The other departments are planning and printing: never locked, never published.
  const isPublishable = () => S.tab === 'tills' || S.tab === 'delivery';
  // HR and admin are never locked out (owner, 2026-10-04): published weeks and past days stay editable for
  // them. Supervisors (schedule.edit) still unlock a published week first and cannot change past days.
  const locked = () => !isHR() && !!(isPublishable() && S.row && S.row.published && S.unlocked !== S.week);
  const dayLocked = i => !isHR() && dayPast(i);
  const editableDay = i => !locked() && !dayLocked(i);
  const weekRel = w => {
    const n = Math.round((new Date(w + 'T00:00:00') - new Date(mondayOf(beirutToday()) + 'T00:00:00')) / 604800000);
    return n === 0 ? 'This week' : n === 1 ? 'Next week' : n === -1 ? 'Last week' : n > 1 ? `In ${n} weeks` : `${-n} weeks ago`;
  };
  const SH_LABEL = c => { const x = parse(c); if (x.shift === 'off') return 'Off'; if (!SHIFT[x.shift]) return '—'; return SHIFT[x.shift].label + (x.station ? ' ' + stLabel(x.station) : '') + (x.start ? ` ${x.start}–${x.end}` : ''); };

  async function loadWeek() {
    const [cur, prev] = await Promise.all([
      sb.from('schedule_weeks').select('*').eq('week_start', S.week).maybeSingle(),
      sb.from('schedule_weeks').select('*').eq('week_start', addDays(S.week, -7)).maybeSingle(),
    ]);
    if (cur.error) { S.missing = true; return; }
    S.row = cur.data || null; S.prev = prev.data || null;
    // The cashiers' requests for this week (cashier page; migration 027). None before the migration.
    const { data: reqs } = await sb.from('schedule_requests').select('cashier_id, days, note, updated_at').eq('week_start', S.week);
    S.reqs = reqs || [];
    // What supervisors changed on this published week (migration 031).
    const { data: chg } = await sb.from('schedule_changes').select('*').eq('week_start', S.week).order('updated_at', { ascending: false }).limit(20);
    S.changes = chg || [];
  }
  // The lock banner and, for a published week, what supervisors changed on it.
  function topHtml(row) {
    if (!row || !isPublishable()) return '';
    let h = '';
    if (row.published) h += isHR()
      ? `<div class="sh-lock open"><span><svg class="sh-lock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/></svg><b>Published</b> — cashiers and the delivery team see this week; your changes reach them straight away.</span></div>`
      : locked()
        ? `<div class="sh-lock"><span><svg class="sh-lock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><b>Published — staff can see this week.</b> Unlock it to make a change — HR is told about every change you make.</span><button type="button" class="btn small" id="shUnlock">Unlock to edit</button></div>`
        : `<div class="sh-lock open"><span><svg class="sh-lock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.8-1.3"/></svg><b>Unlocked</b> — changes reach staff straight away and HR is told about them.</span><button type="button" class="btn ghost small" id="shRelock">Lock again</button></div>`;
    if (row.published && (S.changes || []).length) h += `<div class="card sh-changes"><b>Changes by supervisors since it was published</b><ul>${S.changes.map(c => {
      const items = Object.values(c.details || {}).sort((a, b) => a.name.localeCompare(b.name) || a.dayIndex - b.dayIndex);
      return `<li><span class="muted-note">${esc(c.by_name || 'A supervisor')} · ${new Date(c.updated_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${c.notified_at ? ' · HR told' : ''}</span>
        ${items.map(i => `<span class="sh-chg">${esc(i.name)} ${esc(i.day)}: <s>${esc(SH_LABEL(i.from))}</s> → <b>${esc(SH_LABEL(i.to))}</b></span>`).join('')}</li>`; }).join('')}</ul></div>`;
    return h;
  }

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="filter-row sh-dept-tabs" id="shTabs"></div>
      <div id="shBody"></div>`;
    el('shTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; render(); };
    el('shBody').addEventListener('click', e => { const b = e.target.closest('[data-break]'); if (!b) return; e.stopPropagation(); editBreak(S.staff.find(x => x.id === b.dataset.break)); });
  }
  async function refresh() {
    await Promise.all([loadStaff(), loadDeptShifts()]);
    if (!S.missing) await loadWeek();
    render();
  }
  function render() {
    // A tab per department that has someone (Cashiers always), with how many people.
    const tabs = TABS.map(([k, l, ds]) => [k, l, S.staff.filter(p => ds.includes(p.dept) && p.active).length]).filter(([k, , n]) => k === 'tills' || n);
    if (!tabs.some(([k]) => k === S.tab)) S.tab = 'tills';
    el('shTabs').innerHTML = tabs.map(([k, l, n]) => `<button type="button" data-tab="${k}" class="${k === S.tab ? 'active' : ''}">${esc(l)} <span class="sh-tab-n">${n}</span></button>`).join('');
    if (S.missing) { el('shBody').innerHTML = '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> The staff schedule works once migration 020 is applied.</p></div>'; return; }
    renderWeek();
  }

  /* ---------------- week ---------------- */
  const peopleAll = () => {
    const assigned = new Set(Object.keys(S.row?.assignments || {}));
    return S.staff.filter(p => p.active || assigned.has(p.id));
  };
  const people = () => peopleAll().filter(inTab);
  // Who of a group works that day: AM / PM (a full day counts in both) and by station.
  function groupCount(list, a, day) {
    const c = { am: 0, pm: 0, front: 0, back: 0 };
    list.forEach(p => {
      const { shift, station } = parse((a[p.id] || [])[day]);
      if (!SHIFT[shift]) return;
      if (shift === 'am' || shift === 'full') c.am++;
      if (shift === 'pm' || shift === 'full') c.pm++;
      if (hasStation(p)) stationsOf(station || p.default_station).forEach(st => { if (st === 'front') c.front++; else if (st === 'back') c.back++; });
    });
    return c;
  }
  function renderWeek() {
    if (!isPublishable()) return renderFixed();   // the other departments: a fixed week
    const w = S.week, row = S.row;
    const view = isTills() ? S.view : 'grid';   // the other tabs: the basic grid only
    const nav = `<div class="sh-weeknav">
        <button class="icon-btn" data-w="-7" aria-label="Previous week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3><span class="sh-rel sh-rel-${weekRel(w).toLowerCase().replace(/\s+/g, '-')}">${weekRel(w)}</span> Week of ${esc(weekTitle(w))}</h3>
        <button class="icon-btn" data-w="7" aria-label="Next week"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <button class="btn ghost small" data-w="0">This week</button>
        ${row && isPublishable() ? `<span class="badge ${row.published ? 'active' : 'warn'}">${row.published ? 'Published' : row.submitted_at ? 'Sent by ' + esc(row.submitted_by || 'a supervisor') + ' for review' : 'Draft — not visible to staff'}</span>` : ''}
        ${row && !isPublishable() ? '<span class="muted-note">Planning only — not published</span>' : ''}
        ${row && row.last_editor && !row.published && isPublishable() ? `<span class="muted-note">Last change by ${esc(row.last_editor)}</span>` : ''}
        <span style="flex:1"></span>
        ${row ? `<button class="btn ghost small" id="shCopy" ${S.prev ? '' : 'disabled'} title="${S.prev ? 'Replace this week with last week’s schedule' : 'Last week has no schedule'}">Copy last week</button>
          <button class="btn ghost small sh-empty-btn" id="shEmpty" title="Clear every shift of this week">Empty table</button>
          <button class="btn secondary small" id="shPrint">Print</button>
          ${!isPublishable() ? '' : isHR() ? `<button class="btn small" id="shPublish" title="Cashiers and the delivery team see the week on the cashier page">${row.published ? 'Unpublish' : 'Publish'}</button>`
            : !row.published ? `<button class="btn small" id="shSend">${row.submitted_at ? 'Send to HR again' : 'Send to HR'}</button>` : ''}` : ''}
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
      return `<tr data-p="${p.id}" data-grp="${p.dept}">
        <th class="sh-name">${RowDrag.handle()}${esc(p.name)}${p.active ? '' : ' <span class="muted-note">(inactive)</span>'}<small>${esc(p.job || '') + (hasStation(p) && p.default_station ? ' · ' + (p.default_station === 'front' ? 'Front' : 'Back') : '')}</small>${breakBtn(p)}</th>
        ${dates.map((d, i) => { const c = days[i] || '', { shift } = parse(c); const q = askOf(p.id, i); return `<td class="sh-cell sh-${shift || 'none'}${editableDay(i) ? '' : ' sh-ro'}"><button type="button" data-day="${i}" ${editableDay(i) ? '' : 'disabled'} aria-label="${esc(p.name)} ${DAYS[i]}" ${q ? `title="Asked for ${ASK_LABEL[q]}"` : ''}>${cellHtml(c)}${q ? `<i class="sh-ask-dot ${shift === q ? 'ok' : ''}">${ASK_LABEL[q]}</i>` : ''}</button></td>`; }).join('')}
        <td class="num sh-hours">${hours ? hours + 'h' : '—'}<small>${off} off</small></td></tr>`;
    };
    const gs = groups();
    // The count row under a group: how many work each day (Front / Back for the tills).
    const countRow = g => `<tr class="sh-count"><th class="sh-name">${esc(g.label)} working</th>${dates.map((_, i) => {
      const c = groupCount(g.list, a, i);
      return `<td><b>AM ${c.am} · PM ${c.pm}</b>${g.k === 'sup' || g.k === 'cash' ? `<small>Front ${c.front} · Back ${c.back}</small>` : ''}</td>`; }).join('')}<td></td></tr>`;
    const tabName = tabOf(S.tab)[1];
    // Fill the week: the whole grid, one day for everyone, or one person's 7 days.
    const viewSwitch = !isTills() ? '' : `<div class="filter-row sh-views" id="shViews">
        ${[['grid', 'Week grid'], ['day', 'By day'], ['person', 'By person'], ['requests', `Requests (${(S.reqs || []).length})`]].map(([v, l]) => `<button type="button" data-view="${v}" class="${S.view === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
    if (view === 'requests') {
      el('shBody').innerHTML = `${nav}${topHtml(row)}${viewSwitch}<div class="card">${requestsHtml(dates, gs)}</div>`;
      wireNav(); wireViews();
      el('shCopy')?.addEventListener('click', copyLast);
      el('shEmpty')?.addEventListener('click', emptyWeek);
      if (el('shPublish')) el('shPublish').onclick = togglePublish;
      el('shPrint').onclick = print;
      return;
    }
    if (view !== 'grid') {
      el('shBody').innerHTML = `${nav}${topHtml(row)}${viewSwitch}<div class="card">${listEditorHtml(row, dates, gs)}</div>`;
      wireNav(); wireViews(); wireListEditor(row);
      el('shCopy')?.addEventListener('click', copyLast);
      el('shEmpty')?.addEventListener('click', emptyWeek);
      if (el('shPublish')) el('shPublish').onclick = togglePublish;
      el('shPrint').onclick = print;
      return;
    }
    el('shBody').innerHTML = `${nav}${topHtml(row)}${viewSwitch}
      <div class="card"><div class="sh-brush" id="shBrush">
          <span class="sh-step">1</span><span class="sh-brush-t">Shift</span>
          ${SHIFT_TOOLS.map(([v, l]) => `<button type="button" class="sh-chip sh-${v || 'none'} ${S.brush.tool === v ? 'on' : ''}" data-tool="${v}">${l}</button>`).join('')}
          ${isTills() ? `<span class="sh-step">2</span><span class="sh-brush-t">Station</span>
          ${STATION_TOOLS.map(([v, l]) => `<button type="button" class="sh-chip sh-${v || 'none'} ${S.brush.tool === v ? 'on' : ''}" data-tool="${v}">${l}</button>`).join('')}` : ''}
          <span class="sh-brush-sep"></span>
          ${OTHER_TOOLS.map(([v, l]) => `<button type="button" class="sh-chip sh-${v || 'none'} ${S.brush.tool === v ? 'on' : ''}" data-tool="${v}">${l}</button>`).join('')}
          <span class="muted-note">${isTills() ? '1 — pick a shift and click or drag across the days. 2 — pick Front or Back and go over the same days.' : `${esc(tabName)}: pick a shift and click or drag across the days.`}${isTills() ? ' Right-click a cell for exact times (arrives late / leaves early) or, on a full day, a different station for the AM and the PM. Keys on a cell: A P F O, 1 = Front, 2 = Back, T = times, Delete.' : ' Right-click a cell for exact times (arrives late / leaves early). Keys on a cell: A P F O, T = times, Delete.'}</span>
        </div>
        <div class="items-scroll" style="margin-bottom:0;"><table class="sh-grid">
        <thead><tr><th></th>${dates.map((d, i) => `<th>${DAYS[i]}<small>${dayLabel(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}<th class="num">Week</th></tr></thead>
        <tbody>
          ${gs.map(g => `<tr class="sh-group"><td colspan="9">${esc(g.label)}</td></tr>${g.list.map(personRow).join('')}${countRow(g)}`).join('')}
          ${!people().length ? `<tr><td colspan="9" class="empty-note">Nobody in ${esc(tabName)} yet — add them on the Staff page with that job.</td></tr>` : ''}
        </tbody>
      </table></div>
      <p class="muted-note" style="margin:10px 0 0;">AM ${SHIFT.am.time} · PM ${SHIFT.pm.time} · Full ${SHIFT.full.time}. Changes save by themselves${isPublishable() ? '; they see the week on the cashier page once it is published' : ' (this team does not use the app: print the week for them)'}.</p></div>`;
    wireNav();
    wireViews();
    wireGrid(row);
    wireRowDrag();
    el('shCopy')?.addEventListener('click', copyLast);
    el('shEmpty')?.addEventListener('click', emptyWeek);
    if (el('shPublish')) el('shPublish').onclick = togglePublish;
    el('shPrint').onclick = print;
  }
  // Brush painting (click / drag) and keyboard entry on the grid.
  // Drag a row by the handle next to the name: it moves among its own group only (supervisors
  // among supervisors, cashiers among cashiers). The order is the staff list's (sort_order), the
  // same one the Cash grid uses; the other group keeps its places.
  function wireRowDrag() {
    RowDrag.attach(el('shBody').querySelector('.sh-grid tbody'), { rows: 'tr[data-p]', id: r => r.dataset.p, group: r => r.dataset.grp, onDrop: saveGroupOrder });
  }
  // The group's members take the group's slots of the whole list in their new order.
  async function saveGroupOrder(ids, movedId) {
    const moved = S.staff.find(x => x.id === movedId);
    // Other departments (and pickers): the Staff list order (migration 044).
    if (!hasStation(moved || {})) {
      const staffIds = ids.map(id => S.staff.find(x => x.id === id)?.staffId).filter(Boolean);
      const { error } = await sb.rpc('staff_reorder', { p_ids: staffIds });
      if (error) showToast('Order not saved — ' + friendlyError(error), true);
      else logActivity('schedule', 'reorder_staff', { type: 'staff', id: moved?.staffId || null }, `Moved ${moved?.name || 'a person'} to place ${ids.indexOf(movedId) + 1} of ${DEPT_LABEL[moved?.dept] || 'the list'}`);
      await loadStaff(); return renderWeek();
    }
    const list = S.staff.filter(p => p.cashierId && hasStation(p)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const set = new Set(ids);
    let k = 0;
    const next = list.map(p => { if (!set.has(p.id)) return p; const id = ids[k++]; return S.staff.find(x => x.id === id); });
    const changed = next.map((p, i) => ({ p, i })).filter(({ p, i }) => p.sort_order !== i);
    for (const { p, i } of changed) {
      const { error } = await sb.from('cashiers').update({ sort_order: i }).eq('id', p.cashierId);
      if (error) { showToast('Order not saved — ' + friendlyError(error), true); await loadStaff(); return renderWeek(); }
      p.sort_order = i;
    }
    S.staff.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    if (changed.length) logActivity('schedule', 'reorder_staff', { type: 'cashier', id: movedId }, `Moved ${moved?.name || 'a person'} to place ${ids.indexOf(movedId) + 1} of the ${isSup(moved || {}) ? 'supervisors' : 'cashiers'}`);
    renderWeek();
  }

  function wireGrid(row) {
    el('shBrush').onclick = e => {
      const b = e.target.closest('[data-tool]'); if (!b) return;
      S.brush.tool = b.dataset.tool;
      el('shBrush').querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === S.brush.tool));
    };
    const tbody = el('shBody').querySelector('.sh-grid tbody');
    const set = (btn, tool) => {
      if (tool === 'time') return false;   // the Times… tool opens the dialog instead
      if (!editableDay(Number(btn.dataset.day))) return false;   // locked week or a day already past
      const id = btn.closest('tr').dataset.p, p = S.staff.find(x => x.id === id); if (!p) return false;
      const days = (row.assignments[id] = row.assignments[id] || Array(7).fill(''));
      const i = Number(btn.dataset.day), code = applyTool(p, days[i] || '', tool);
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
      if (S.brush.tool === 'time') return editTimes(b, row);
      painting = true; changed = set(b, S.brush.tool) || changed;
    };
    tbody.onpointermove = e => {
      if (!painting) return;
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sh-grid tbody button[data-day]');
      if (b) changed = set(b, S.brush.tool) || changed;
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
      if (key in KEYS) { if (set(b, KEYS[key])) save(); d = Math.min(6, d + 1); edit = true; }
      else if (key === 'Enter' || key === ' ') { if (set(b, S.brush.tool)) save(); d = Math.min(6, d + 1); edit = true; }
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
  // Everyone's requests for the week in one table (what used to come on WhatsApp), with their notes.
  function requestsHtml(dates, gs) {
    const reqs = S.reqs || [];
    if (!reqs.length) return '<div class="empty-state" style="padding:26px 16px;"><p class="big">No requests for this week yet</p><p>Cashiers send them from the cashier page (My requests), after their PIN.</p></div>';
    const a = S.row?.assignments || {};
    const rowOf = p => {
      const q = reqs.find(r => r.cashier_id === p.id);
      if (!q) return '';
      return `<tr><th class="sh-name">${esc(p.name)}<small>${q.updated_at ? 'sent ' + new Date(q.updated_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</small></th>
        ${dates.map((_, i) => { const v = (q.days || [])[i] || '', cur = parse((a[p.id] || [])[i]).shift;
          return `<td class="sh-rq sh-rq-${v || 'any'} ${v && cur === v ? 'ok' : ''}" title="${v ? (cur === v ? 'Given' : 'Not given yet') : ''}">${v ? ASK_LABEL[v] : '<span class="muted-note">any</span>'}</td>`; }).join('')}
        <td class="sh-rq-note">${q.note ? esc(q.note) : ''}</td></tr>`;
    };
    const waiting = gs.filter(g => g.k === 'sup' || g.k === 'cash').flatMap(g => g.list).filter(p => !reqs.some(r => r.cashier_id === p.id));
    return `<div class="items-scroll" style="margin-bottom:0;"><table class="sh-grid sh-rq-table">
        <thead><tr><th></th>${dates.map((d, i) => `<th>${DAYS[i]}<small>${dayLabel(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}<th>Note</th></tr></thead>
        <tbody>${gs.filter(g => g.list.some(p => reqs.some(r => r.cashier_id === p.id))).map(g => `<tr class="sh-group"><td colspan="9">${esc(g.label)}</td></tr>` + g.list.map(rowOf).join('')).join('')}</tbody>
      </table></div>
      <p class="muted-note" style="margin:10px 0 0;">Outlined = already given in the schedule. ${waiting.length ? `No request yet from: ${waiting.map(p => esc(p.name)).join(', ')}.` : 'Everyone sent a request.'}</p>`;
  }
  function wireViews() {
    if (!el('shViews')) return;   // the basic tabs have no views
    el('shViews').onclick = e => { const b = e.target.closest('[data-view]'); if (!b) return; S.view = b.dataset.view; renderWeek(); };
  }
  // By day: everyone on one day. By person: one person's 7 days. Same buttons as the cashier page.
  function listEditorHtml(row, dates, gs) {
    const a = row.assignments || {};
    const today = beirutToday();
    if (S.vday === null) { const t = dates.findIndex(d => d === today); S.vday = t >= 0 ? t : 0; }
    const everyone = gs.flatMap(g => g.list);
    if (!S.vperson || !everyone.some(p => p.id === S.vperson)) S.vperson = everyone[0]?.id || null;
    const seg = (code, p, day) => {
      const x = parse(code), working = !!SHIFT[x.shift], t = custom(code) ? timesOf(code) : null, ro = !editableDay(day);
      return `<div class="sh-seg">${[['', '—'], ['am', 'AM'], ['pm', 'PM'], ['full', 'Full'], ['off', 'Off']].map(([v, l]) => `<button type="button" data-set="${v}" class="sh-seg-${v || 'none'} ${x.shift === v ? 'on' : ''}" ${ro ? 'disabled' : ''}>${l}</button>`).join('')}</div>
        ${!hasStation(p) ? '' : x.shift === 'full' ? ['am', 'pm'].map((h, k) => `<div class="sh-seg sh-seg-st sh-seg-half"><span>${h.toUpperCase()}</span>${[['front', 'Front'], ['back', 'Back']].map(([v, l]) => `<button type="button" data-set="half:${h}:${v}" class="${halves(x.station || p.default_station)[k] === v ? 'on' : ''}" ${ro ? 'disabled' : ''}>${l}</button>`).join('')}</div>`).join('')
          : `<div class="sh-seg sh-seg-st">${[['front', 'Front'], ['back', 'Back']].map(([v, l]) => `<button type="button" data-set="${v}" class="${working && x.station === v ? 'on' : ''}" ${working && !ro ? '' : 'disabled'}>${l}</button>`).join('')}</div>`}
        <button type="button" class="btn ghost small sh-le-time ${t ? 'has' : ''}" data-set="time" ${working && !ro ? '' : 'disabled'} title="Arrives late / leaves early">${t ? `${t[0]}–${t[1]}` : 'Times…'}</button>`;
    };
    if (S.view === 'day') {
      const d = S.vday;
      // Counted per group (owner, 2026-10-01): "Supervisors 1 AM · 1 PM | Cashiers 3 AM · 3 PM".
      const counts = gs.map(g => ({ g, c: groupCount(g.list, a, d) }));
      const till = counts.filter(x => x.g.k === 'sup' || x.g.k === 'cash').reduce((t, x) => ({ front: t.front + x.c.front, back: t.back + x.c.back }), { front: 0, back: 0 });
      const grp = (label, k) => `<span class="sh-le-grpcount"><b>${esc(label)}</b> ${k.am} AM · ${k.pm} PM</span>`;
      const line = p => `<li data-pid="${p.id}" data-day="${d}"><div class="sh-le-who"><b>${esc(p.name)} ${askTag(p.id, d, (a[p.id] || [])[d])}</b><small>${esc(p.job || '')}${hasStation(p) && p.default_station ? ' · usually ' + (p.default_station === 'front' ? 'Front' : 'Back') : ''}</small></div>${seg((a[p.id] || [])[d], p, d)}</li>`;
      return `<div class="sh-le-strip">${dates.map((dt, i) => `<button type="button" data-vday="${i}" class="${i === d ? 'on' : ''}${dt === today ? ' today' : ''}"><span>${DAYS[i]}</span><b>${Number(dt.slice(8))}</b></button>`).join('')}</div>
        <p class="sh-le-count"><b>${dayLabel(dates[d], { weekday: 'long', day: 'numeric', month: 'long' })}</b></p>
        <p class="sh-le-counts">${counts.map(x => grp(x.g.label, x.c)).join('')}${till.front + till.back ? `<span class="sh-le-grpcount">Tills: Front ${till.front} · Back ${till.back}</span>` : ''}</p>
        ${gs.map(g => `<p class="sh-le-grp">${esc(g.label)}</p><ul class="sh-le">${g.list.map(line).join('')}</ul>`).join('')}`;
    }
    const p = everyone.find(x => x.id === S.vperson);
    if (!p) return '<p class="empty-note">No staff yet — add them in the Staff tab.</p>';
    const days = a[p.id] || [];
    const hours = Math.round(days.reduce((t, c) => t + hoursOf(c), 0) * 100) / 100;
    const idx = everyone.indexOf(p);
    return `<div class="sh-le-person">
        <button type="button" class="icon-btn" data-vstep="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Previous person"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <select id="shVPerson" aria-label="Person">${gs.map(g => `<optgroup label="${esc(g.label)}">${g.list.map(x => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select>
        <button type="button" class="icon-btn" data-vstep="1" ${idx >= everyone.length - 1 ? 'disabled' : ''} aria-label="Next person"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span class="muted-note">${hours ? hours + 'h this week' : 'Nothing yet this week'} · ${days.filter(c => c === 'off').length} off</span>
      </div>
      ${weekSummaryHtml(days, p)}
      ${(() => { const q = (S.reqs || []).find(r => r.cashier_id === p.id); return q?.note ? `<p class="sh-ask-note">${esc(p.name)} wrote: “${esc(q.note)}”</p>` : ''; })()}
      <ul class="sh-le">${dates.map((dt, i) => `<li data-pid="${p.id}" data-day="${i}" class="${dt === today ? 'today' : ''}"><div class="sh-le-who"><b>${DAYS[i]} ${askTag(p.id, i, days[i])}</b><small>${dayLabel(dt, { day: 'numeric', month: 'short' })}</small></div>${seg(days[i], p, i)}</li>`).join('')}</ul>`;
  }
  // By person: what the week already has, e.g. 2 AM · 1 PM · 1 Full · 2 Off | 3 Front · 1 Back (owner, 2026-10-01).
  function weekSummaryHtml(days, p) {
    const n = { am: 0, pm: 0, full: 0, off: 0, front: 0, back: 0, none: 0 };
    for (let i = 0; i < 7; i++) {
      const x = parse(days[i]);
      if (SHIFT[x.shift]) { n[x.shift]++; if (hasStation(p)) stationsOf(x.station || p.default_station).forEach(st => { if (st in n) n[st]++; }); }
      else if (x.shift === 'off') n.off++; else n.none++;
    }
    const chip = (k, label) => `<span class="sh-sum-chip sh-sum-${k} ${n[k] ? '' : 'zero'}"><b>${n[k]}</b> ${label}</span>`;
    return `<div class="sh-sum">${chip('am', 'AM')}${chip('pm', 'PM')}${chip('full', 'Full')}${chip('off', 'Off')}${hasStation(p) ? `<span class="sh-sum-sep"></span>${chip('front', 'Front')}${chip('back', 'Back')}` : ''}${n.none ? `<span class="sh-sum-left">${n.none} day${n.none === 1 ? '' : 's'} not set</span>` : ''}</div>`;
  }
  function wireListEditor(row) {
    const box = el('shBody').querySelector('.card:last-child');
    box.onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.vday !== undefined) { S.vday = Number(b.dataset.vday); return renderWeek(); }
      if (b.dataset.vstep) {
        const all = groups().flatMap(g => g.list);
        const i = all.findIndex(x => x.id === S.vperson) + Number(b.dataset.vstep);
        if (all[i]) { S.vperson = all[i].id; renderWeek(); }
        return;
      }
      if (b.dataset.set === undefined) return;
      const li = b.closest('li[data-pid]'), id = li.dataset.pid, i = Number(li.dataset.day);
      const p = S.staff.find(x => x.id === id); if (!p) return;
      if (b.dataset.set === 'time') return editTimesAt(id, i, row);
      if (!editableDay(i)) return;
      const days = (row.assignments[id] = row.assignments[id] || Array(7).fill(''));
      const code = b.dataset.set.startsWith('half:') ? setHalf(p, days[i] || '', ...b.dataset.set.split(':').slice(1)) : applyTool(p, days[i] || '', b.dataset.set);
      if ((days[i] || '') === code) return;
      days[i] = code; save(); renderWeek();
    };
    const sel = el('shVPerson');
    if (sel) sel.onchange = () => { S.vperson = sel.value; renderWeek(); };
  }

  // A full day's AM or PM station (the other half keeps its own).
  function setHalf(p, cur, half, st) {
    const x = parse(cur); if (x.shift !== 'full') return cur;
    const [a, b] = halves(x.station || p.default_station || st);
    const t = x.start || x.end ? `|${x.start || DEF.full[0]}-${x.end || DEF.full[1]}` : '';
    return `full:${half === 'am' ? joinSt(st, b) : joinSt(a, st)}${t}`;
  }
  // Arrives late / leaves early: the cell's shift, station and exact start / end.
  function editTimes(btn, row) { editTimesAt(btn.closest('tr').dataset.p, Number(btn.dataset.day), row, btn); }
  function editTimesAt(id, i, row, btn) {
    if (!editableDay(i)) return showToast(locked() ? 'This week is published — press Unlock to edit first.' : 'That day is already past.', true);
    const p = S.staff.find(x => x.id === id); if (!p) return;
    const days = (row.assignments[id] = row.assignments[id] || Array(7).fill(''));
    let x = parse(days[i]);
    if (!SHIFT[x.shift]) {   // empty or Off: start from the brush's shift (or AM)
      const sh = SHIFT[S.brush.tool] ? S.brush.tool : 'am';
      x = parse(applyTool(p, '', sh));
      if (!x.station && hasStation(p)) x.station = p.default_station || 'front';
    }
    if (!el('shTimeOverlay')) document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="shTimeOverlay">
        <div class="modal-box form-box sh-time-box">
          <h3 id="shTimeTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
          <form id="shTimeForm" autocomplete="off">
            <div class="form-grid">
              <div><label for="shTShift">Shift</label><select id="shTShift"><option value="am">AM</option><option value="pm">PM</option><option value="full">Full day</option></select></div>
              <div><label for="shTStation" id="shTStationL">Station</label><select id="shTStation"><option value="front">Front</option><option value="back">Back</option></select></div>
              <div id="shTStation2W" hidden><label for="shTStation2">PM station</label><select id="shTStation2"><option value="front">Front</option><option value="back">Back</option></select></div>
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
      // A full day: one station for the AM half, one for the PM half.
      el('shTStation2W').hidden = shift !== 'full' || !hasStation(p);
      el('shTStation').parentElement.hidden = !hasStation(p);
      el('shTStationL').textContent = shift === 'full' ? 'AM station' : 'Station';
    };
    el('shTimeTitle').textContent = `${p.name} — ${DAYS[i]} ${dayLabel(addDays(S.week, i), { day: 'numeric', month: 'short' })}`;
    el('shTStation').value = halves(x.station || p.default_station || 'front')[0] || 'front';
    el('shTStation2').value = halves(x.station || p.default_station || 'front')[1] || 'front';
    el('shTFrom').value = x.start || DEF[x.shift][0];
    el('shTTo').value = x.end || DEF[x.shift][1];
    fill(x.shift, true);
    el('shTShift').onchange = () => fill(el('shTShift').value, false);
    el('shTReset').onclick = () => fill(el('shTShift').value, false);
    const close = () => { ov.classList.remove('open'); btn?.focus(); };
    el('shTCancel').onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    el('shTimeForm').onsubmit = e => {
      e.preventDefault();
      const shift = el('shTShift').value, from = el('shTFrom').value, to = el('shTTo').value;
      if (!from || !to || mins(to) <= mins(from)) return showToast('"Leaves at" must be after "Arrives at".', true);
      const st = !hasStation(p) ? '' : shift === 'full' ? joinSt(el('shTStation').value, el('shTStation2').value) : el('shTStation').value;
      days[i] = withTimes(`${shift}${st ? ':' + st : ''}`, from, to);
      ov.classList.remove('open');
      save(); renderWeek();
      el('shBody').querySelector(`.sh-grid tr[data-p="${id}"] button[data-day="${i}"]`)?.focus();
    };
    ov.classList.add('open');
    setTimeout(() => el('shTFrom').focus(), 30);
  }

  function wireNav() {
    el('shUnlock')?.addEventListener('click', async () => {
      if (!(await showConfirm(`Unlock the published week of ${weekTitle(S.week)}? Staff see your changes straight away${isHR() ? '' : ', and HR is told about them'}.`, 'Unlock'))) return;
      S.unlocked = S.week; renderWeek();
    });
    el('shRelock')?.addEventListener('click', () => { S.unlocked = null; renderWeek(); });
    el('shSend')?.addEventListener('click', async () => {
      const who = (typeof Session !== 'undefined' && (Session.profile?.display_name || Session.profile?.username)) || 'A supervisor';
      const { error } = await sb.from('schedule_weeks').update({ submitted_at: new Date().toISOString(), submitted_by: who }).eq('week_start', S.week);
      if (error) return showToast('Not sent — ' + friendlyError(error), true);
      S.row.submitted_at = new Date().toISOString(); S.row.submitted_by = who;
      logActivity('schedule', 'submit', { type: 'schedule_week', id: S.week }, `Sent the schedule of the week ${weekTitle(S.week)} to HR`);
      showToast('Sent to HR — they review it and publish it.'); renderWeek();
    });
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
  // Empty table (owner, 2026-10-01): clears every shift of the week (the week itself stays).
  // The open tab's people only (the other departments keep their week).
  async function emptyWeek() {
    if (locked()) return showToast('This week is published — press Unlock to edit first.', true);
    const ids = new Set(S.staff.filter(inTab).map(p => p.id)), tabName = tabOf(S.tab)[1];
    const n = Object.entries(S.row.assignments || {}).filter(([id]) => ids.has(id)).reduce((t, [, d]) => t + (d || []).filter(Boolean).length, 0);
    if (!n) return showToast(`${tabName}: this week is already empty.`);
    const what = `${n} shift${n === 1 ? '' : 's'} will be removed.`;
    const msg = S.row.published && isPublishable()
      ? `Empty ${tabName} for the week of ${weekTitle(S.week)}? It is PUBLISHED — they will see an empty schedule. ${what}`
      : `Empty ${tabName} for the week of ${weekTitle(S.week)}? ${what}`;
    if (!(await showConfirm(msg, 'Empty table'))) return;
    // days already past keep what they had
    const kept = {};
    Object.entries(S.row.assignments || {}).forEach(([id, d]) => { if (!ids.has(id)) { kept[id] = d; return; } const k = (d || []).map((c, i) => dayLocked(i) ? c : ''); if (k.some(Boolean)) kept[id] = k; });
    S.row.assignments = kept;
    await save(true);
    logActivity('schedule', 'empty', { type: 'schedule_week', id: S.week }, `Emptied the schedule of the week ${weekTitle(S.week)} (${n} shifts)`);
    renderWeek();
    showToast(`${tabName} is empty for this week.`);
  }
  async function copyLast() {
    if (locked()) return showToast('This week is published — press Unlock to edit first.', true);
    const ids = new Set(S.staff.filter(inTab).map(p => p.id));
    if (!(await showConfirm(`Replace ${tabOf(S.tab)[1]} for this week with last week's (${weekTitle(addDays(S.week, -7))})?`, 'Copy'))) return;
    const all = copied(), cur = S.row.assignments || {};
    // this tab from last week, the other departments as they are
    const cp = {};
    Object.entries(cur).forEach(([id, d]) => { if (!ids.has(id)) cp[id] = d; });
    Object.entries(all).forEach(([id, d]) => { if (ids.has(id)) cp[id] = d; });
    // days already past keep what they had
    [...new Set([...Object.keys(cp), ...Object.keys(cur)])].filter(id => ids.has(id)).forEach(id => { const n = (cp[id] || Array(7).fill('')).slice(); for (let i = 0; i < 7; i++) if (dayLocked(i)) n[i] = (cur[id] || [])[i] || ''; cp[id] = n; });
    S.row.assignments = cp; await save(true); renderWeek();
  }
  let timer = null;
  function save(now) {
    clearTimeout(timer);
    const go = async () => {
      const { error } = await sb.from('schedule_weeks').update({ assignments: S.row.assignments, published: S.row.published, last_editor: (typeof Session !== 'undefined' && (Session.profile?.display_name || Session.profile?.username)) || 'HR' }).eq('week_start', S.row.week_start);
      if (error) showToast('Not saved — ' + friendlyError(error), true);
    };
    if (now) return go();
    timer = setTimeout(go, 400);
  }
  async function togglePublish() {
    const on = !S.row.published;
    if (on) {
      const empty = peopleAll().filter(p => p.active && (hasStation(p) || p.dept === 'delivery') && !(S.row.assignments[p.id] || []).some(Boolean)).map(p => p.name);
      if (empty.length && !(await showConfirm(`${empty.length} ${empty.length === 1 ? 'person (cashiers or delivery) has' : 'people (cashiers or delivery) have'} nothing this week (${empty.slice(0, 5).join(', ')}${empty.length > 5 ? '…' : ''}). Publish anyway?`, 'Publish'))) return;
    }
    S.row.published = on; await save(true);
    logActivity('schedule', on ? 'publish' : 'unpublish', { type: 'schedule_week', id: S.week }, `${on ? 'Published' : 'Unpublished'} the schedule of the week ${weekTitle(S.week)}`);
    showToast(on ? 'Published — cashiers and the delivery team see it on the cashier page.' : 'Unpublished.');
    renderWeek();
  }
  /* ---------------- fixed schedules (owner, 2026-10-04; migration 050) ----------------
     Every department but Cashiers and Delivery works the same week every week, with its own shift
     times. One grid Mon -> Sun per department, edited any time, never published — printed for the team. */
  async function loadDeptShifts() {
    const { data } = await sb.from('schedule_dept_shifts').select('dept, shifts');
    S.deptShifts = new Map((data || []).map(r => [r.dept, r.shifts || {}]));
  }
  const deptDef = dept => { const d = S.deptShifts?.get(dept) || {}; return { am: d.am || DEF.am, pm: d.pm || DEF.pm, full: d.full || DEF.full }; };
  const fixedTimes = (code, def) => { const x = parse(code); return SHIFT[x.shift] ? [x.start || def[x.shift][0], x.end || def[x.shift][1]] : null; };
  const fixedHours = (code, def) => { const t = fixedTimes(code, def); return t ? Math.max(0, mins(t[1]) - mins(t[0])) / 60 : 0; };
  const fixedCell = (code, def) => {
    const x = parse(code);
    if (x.shift === 'off') return 'Off';
    if (!SHIFT[x.shift]) return '—';
    const t = fixedTimes(code, def);
    return `${SHIFT[x.shift].label}<small class="sh-time${x.start ? ' sh-time-own' : ''}">${t[0]}–${t[1]}</small>`;
  };
  const fixedSaveTimers = new Map();
  function saveFixed(p) {
    clearTimeout(fixedSaveTimers.get(p.id));
    fixedSaveTimers.set(p.id, setTimeout(async () => {
      const days = Array.from({ length: 7 }, (_, i) => p.fixed[i] || '');
      const { error } = await sb.rpc('staff_set_fixed', { p_staff: p.staffId, p_days: days.some(Boolean) ? days : null });
      if (error) showToast('Not saved — ' + friendlyError(error), true);
    }, 400));
  }
  function renderFixed() {
    const dept = S.tab, def = deptDef(dept), name = tabOf(S.tab)[1];
    const list = people();
    const tools = [...SHIFT_TOOLS, ...OTHER_TOOLS];
    el('shBody').innerHTML = `
      <div class="card sh-fixed-head">
        <div class="sh-fixed-title"><h3>${esc(name)} <span class="muted-note">— fixed schedule, the same every week</span></h3>
          <p class="muted-note">Not published (this team does not use the app): print it for them. Changes save by themselves.</p></div>
        <div class="sh-fixed-times"><span class="sh-fixed-t">Shift times</span>${['am', 'pm', 'full'].map(k => `<span><b>${SHIFT[k].label}</b> ${def[k][0]}–${def[k][1]}</span>`).join('')}
          <button type="button" class="btn ghost small" id="shDeptTimes">Change</button></div>
        <button type="button" class="btn secondary small" id="shPrint">Print</button>
      </div>
      <div class="card"><div class="sh-brush" id="shBrush">
          <span class="sh-brush-t">Shift</span>
          ${tools.map(([v, l]) => `<button type="button" class="sh-chip sh-${v || 'none'} ${S.brush.tool === v ? 'on' : ''}" data-tool="${v}">${l}</button>`).join('')}
          <span class="muted-note">Pick a shift and click or drag across the days. Right-click a cell (or T) for other times. Keys on a cell: A P F O, Delete.</span>
        </div>
        <div class="items-scroll" style="margin-bottom:0;"><table class="sh-grid sh-fixed">
          <thead><tr><th></th>${DAYS.map(d => `<th>${d}</th>`).join('')}<th class="num">Week</th></tr></thead>
          <tbody>${list.map(p => {
            const hours = Math.round(p.fixed.reduce((t, c) => t + fixedHours(c, def), 0) * 100) / 100;
            return `<tr data-p="${p.id}" data-grp="${p.dept}">
              <th class="sh-name">${RowDrag.handle()}${esc(p.name)}<small>${esc(p.job || '')}</small>${breakBtn(p)}</th>
              ${DAYS.map((_, i) => { const c = p.fixed[i] || ''; return `<td class="sh-cell sh-${parse(c).shift || 'none'}"><button type="button" data-day="${i}" aria-label="${esc(p.name)} ${DAYS[i]}">${fixedCell(c, def)}</button></td>`; }).join('')}
              <td class="num sh-hours">${hours ? hours + 'h' : '—'}<small>${p.fixed.filter(c => c === 'off').length} off</small></td></tr>`; }).join('')
            || `<tr><td colspan="9" class="empty-note">Nobody in ${esc(name)} yet — add them on the Staff page with that job.</td></tr>`}</tbody>
        </table></div></div>`;
    el('shPrint').onclick = printFixed;
    el('shDeptTimes').onclick = () => editDeptTimes(dept);
    el('shBrush').onclick = e => {
      const b = e.target.closest('[data-tool]'); if (!b) return;
      S.brush.tool = b.dataset.tool;
      el('shBrush').querySelectorAll('[data-tool]').forEach(x => x.classList.toggle('on', x.dataset.tool === S.brush.tool));
    };
    const tbody = el('shBody').querySelector('.sh-fixed tbody');
    RowDrag.attach(tbody, { rows: 'tr[data-p]', id: r => r.dataset.p, group: r => r.dataset.grp, onDrop: saveGroupOrder });
    const personOf = btn => S.staff.find(x => x.id === btn.closest('tr').dataset.p);
    const set = (btn, tool) => {
      if (tool === 'time') return false;
      const p = personOf(btn); if (!p) return false;
      const i = Number(btn.dataset.day), cur = p.fixed[i] || '';
      const code = SHIFT[tool] && parse(cur).shift === tool ? cur : tool;   // same shift: keep its own times
      if (cur === code) return false;
      p.fixed[i] = code;
      btn.innerHTML = fixedCell(code, def);
      btn.parentElement.className = `sh-cell sh-${parse(code).shift || 'none'}`;
      saveFixed(p);
      return true;
    };
    let painting = false, changed = false;
    tbody.onpointerdown = e => {
      const b = e.target.closest('button[data-day]'); if (!b || e.button !== 0) return;
      e.preventDefault(); b.focus();
      if (S.brush.tool === 'time') return fixedTimesAt(personOf(b), Number(b.dataset.day), def);
      painting = true; changed = set(b, S.brush.tool) || changed;
    };
    tbody.onpointermove = e => {
      if (!painting) return;
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sh-fixed tbody button[data-day]');
      if (b) changed = set(b, S.brush.tool) || changed;
    };
    window.onpointerup = () => { if (!painting) return; painting = false; if (changed) { changed = false; renderFixed(); } };
    tbody.oncontextmenu = e => { const b = e.target.closest('button[data-day]'); if (!b) return; e.preventDefault(); fixedTimesAt(personOf(b), Number(b.dataset.day), def); };
    tbody.onkeydown = e => {
      const b = e.target.closest('button[data-day]'); if (!b || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 't') { e.preventDefault(); return fixedTimesAt(personOf(b), Number(b.dataset.day), def); }
      const tool = { a: 'am', p: 'pm', f: 'full', o: 'off', Delete: '', Backspace: '' }[key];
      if (tool === undefined) return;
      e.preventDefault();
      const id = b.closest('tr').dataset.p, d = Number(b.dataset.day);
      set(b, tool); renderFixed();
      el('shBody').querySelector(`.sh-fixed tr[data-p="${id}"] button[data-day="${Math.min(6, d + 1)}"]`)?.focus();
    };
  }
  // A person's break: when, and how long (every working day).
  function editBreak(p) {
    if (!p) return;
    if (!el('shBreakOverlay')) document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="shBreakOverlay"><div class="modal-box form-box">
        <h3 id="shBreakTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
        <form id="shBreakForm" autocomplete="off"><div class="form-grid">
          <div><label for="shBreakAt">Break at</label><input type="time" id="shBreakAt"></div>
          <div><label for="shBreakLen">How long</label><select id="shBreakLen">${[15, 20, 30, 45, 60, 90, 120].map(m => `<option value="${m}">${m < 60 ? m + ' min' : m === 60 ? '1 hour' : (m / 60) + ' hours'}</option>`).join('')}</select></div>
        </div>
        <p class="muted-note" style="margin:10px 0 0;">The same every day they work.</p>
        <div class="actions-row"><button type="button" class="btn ghost small" id="shBreakClear" style="margin-right:auto;">No break</button>
          <button type="button" class="btn ghost small" id="shBreakCancel">Cancel</button><button type="submit" class="btn small">Save</button></div>
        </form></div></div>`);
    const ov = el('shBreakOverlay'), close = () => ov.classList.remove('open');
    el('shBreakTitle').textContent = `Break — ${p.name}`;
    el('shBreakAt').value = p.breakStart || '13:00';
    el('shBreakLen').value = String(p.breakMin || 30);
    const save = async (start, minutes) => {
      const { error } = await sb.rpc('staff_set_break', { p_staff: p.staffId, p_start: start, p_minutes: minutes });
      if (error) return showToast('Not saved — ' + friendlyError(error), true);
      p.breakStart = start || ''; p.breakMin = minutes;
      logActivity('schedule', 'break', { type: 'staff', id: p.staffId }, start ? `Break of ${p.name}: ${start}, ${minutes} min` : `No break for ${p.name}`);
      close(); renderWeek();
    };
    el('shBreakCancel').onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    el('shBreakClear').onclick = () => save('', null);
    el('shBreakForm').onsubmit = e => { e.preventDefault(); if (!el('shBreakAt').value) return showToast('Pick the break time.', true); save(el('shBreakAt').value, Number(el('shBreakLen').value)); };
    ov.classList.add('open');
  }
  // One day's own times (arrives late / leaves early, or a different shift length).
  async function fixedTimesAt(p, i, def) {
    if (!p) return;
    const x = parse(p.fixed[i] || '');
    const shift = SHIFT[x.shift] ? x.shift : SHIFT[S.brush.tool] ? S.brush.tool : 'am';
    const t = fixedTimes(p.fixed[i] && SHIFT[x.shift] ? p.fixed[i] : shift, def);
    const v = await showPrompt(`${p.name} — ${DAYS[i]} (${SHIFT[shift].label}). Times, e.g. 06:00-13:00 (empty = the usual ${def[shift][0]}–${def[shift][1]}):`,
      { defaultValue: x.start ? `${t[0]}-${t[1]}` : '', confirmLabel: 'Save', placeholder: `${def[shift][0]}-${def[shift][1]}` });
    if (v === null) return;
    const m = v.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/);
    if (v.trim() && !m) return showToast('Type the times like 06:00-13:00.', true);
    const hhmm = (h, mi) => `${String(h).padStart(2, '0')}:${mi}`;
    const from = m ? hhmm(m[1], m[2]) : '', to = m ? hhmm(m[3], m[4]) : '';
    if (m && mins(to) <= mins(from)) return showToast('The end must be after the start.', true);
    p.fixed[i] = !m || (from === def[shift][0] && to === def[shift][1]) ? shift : `${shift}|${from}-${to}`;
    saveFixed(p); renderFixed();
  }
  // The department's AM / PM / Full times.
  async function editDeptTimes(dept) {
    const def = deptDef(dept), name = tabOf(dept)[1];
    if (!el('shDeptOverlay')) document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="shDeptOverlay"><div class="modal-box form-box">
        <h3 id="shDeptTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
        <form id="shDeptForm" autocomplete="off"><div class="sh-dept-form" id="shDeptRows"></div>
          <div class="actions-row"><button type="button" class="btn ghost small" id="shDeptCancel">Cancel</button><button type="submit" class="btn small">Save</button></div>
        </form></div></div>`);
    el('shDeptTitle').textContent = `${name} — shift times`;
    el('shDeptRows').innerHTML = ['am', 'pm', 'full'].map(k => `<label>${SHIFT[k].label}</label>
      <input type="time" data-k="${k}" data-e="0" value="${def[k][0]}" required><span>to</span><input type="time" data-k="${k}" data-e="1" value="${def[k][1]}" required>`).join('');
    const ov = el('shDeptOverlay'), close = () => ov.classList.remove('open');
    el('shDeptCancel').onclick = close;
    ov.onclick = e => { if (e.target === ov) close(); };
    el('shDeptForm').onsubmit = async e => {
      e.preventDefault();
      const shifts = {};
      for (const k of ['am', 'pm', 'full']) {
        const a = el('shDeptRows').querySelector(`[data-k="${k}"][data-e="0"]`).value, b = el('shDeptRows').querySelector(`[data-k="${k}"][data-e="1"]`).value;
        if (!a || !b || mins(b) <= mins(a)) return showToast(`${SHIFT[k].label}: the end must be after the start.`, true);
        shifts[k] = [a, b];
      }
      const { error } = await sb.from('schedule_dept_shifts').upsert({ dept, shifts, updated_at: new Date().toISOString() });
      if (error) return showToast('Not saved — ' + friendlyError(error), true);
      S.deptShifts.set(dept, shifts);
      logActivity('schedule', 'dept_shifts', { type: 'department', id: dept }, `Shift times of ${name}: AM ${shifts.am.join('–')}, PM ${shifts.pm.join('–')}, Full ${shifts.full.join('–')}`);
      close(); renderFixed();
    };
    ov.classList.add('open');
  }
  function printFixed() {
    const dept = S.tab, def = deptDef(dept), name = tabOf(dept)[1], list = people();
    const cell = c => { const x = parse(c); if (x.shift === 'off') return '<td class="off">Off</td>'; if (!SHIFT[x.shift]) return '<td></td>'; const t = fixedTimes(c, def); return `<td class="${x.shift}"><b>${SHIFT[x.shift].label}</b><br><small class="${x.start ? 't' : ''}">${t[0]}–${t[1]}</small></td>`; };
    const win = window.open('', '_blank'); if (!win) return showToast('Allow pop-ups to print.', true);
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} schedule</title><style>
      body{font:13px Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px;color:#1943AF}p{margin:0 0 14px;color:#555}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:center}th{text-align:left;white-space:nowrap}
      thead th{text-align:center;background:#eef1ff}small.t{color:#b25b00;font-weight:700}td.am{background:#e6f0ff}td.pm{background:#fff3dc}td.full{background:#e8f6ec}td.off{color:#999}small{color:#555}
      @media print{body{margin:8mm}}</style></head><body>
      <h1>La Valeur — ${esc(name)} schedule</h1><p>The same every week · AM ${def.am.join('–')} · PM ${def.pm.join('–')} · Full ${def.full.join('–')}</p>
      <table><thead><tr><th></th>${DAYS.map(d => `<th>${d}</th>`).join('')}</tr></thead>
      <tbody>${list.map(p => `<tr><th>${esc(p.name)}${p.breakStart ? `<br><small>${esc(breakText(p))}</small>` : ''}</th>${DAYS.map((_, i) => cell(p.fixed[i] || '')).join('')}</tr>`).join('')}</tbody></table>
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    win.document.close();
  }

  function print() {
    const w = S.week, a = S.row.assignments || {}, dates = DAYS.map((_, i) => addDays(w, i));
    const cell = (p, i) => { const { shift, station } = parse((a[p.id] || [])[i]); if (shift === 'off') return '<td class="off">Off</td>'; if (!SHIFT[shift]) return '<td></td>'; const code = (a[p.id] || [])[i], t = custom(code) ? timesOf(code) : null; return `<td class="${shift}"><b>${SHIFT[shift].label}</b>${station ? `<br><small>${esc(stLabel(station))}</small>` : ''}${t ? `<br><small class="t">${t[0]}–${t[1]}</small>` : ''}</td>`; };
    const sect = (title, list) => list.length ? `<tr class="g"><td colspan="8">${title}</td></tr>${list.map(p => `<tr><th>${esc(p.name)}${hasBreak(p) && p.breakStart ? `<br><small>${esc(breakText(p))}</small>` : ''}</th>${dates.map((_, i) => cell(p, i)).join('')}</tr>`).join('')}` : '';
    const win = window.open('', '_blank'); if (!win) return showToast('Allow pop-ups to print.', true);
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(tabOf(S.tab)[1])} schedule ${esc(weekTitle(w))}</title><style>
      body{font:13px Arial,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px;color:#1943AF}p{margin:0 0 14px;color:#555}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px;text-align:center}th{text-align:left;white-space:nowrap}
      thead th{text-align:center;background:#eef1ff}tr.g td{background:#1943AF;color:#fff;text-align:left;font-weight:700}
      small.t{color:#b25b00;font-weight:700}td.am{background:#e6f0ff}td.pm{background:#fff3dc}td.full{background:#e8f6ec}td.off{color:#999}small{color:#555}
      @media print{body{margin:8mm}}</style></head><body>
      <h1>La Valeur — ${esc(tabOf(S.tab)[1])} schedule</h1><p>Week of ${esc(weekTitle(w))} · AM ${SHIFT.am.time} · PM ${SHIFT.pm.time} · Full ${SHIFT.full.time}</p>
      <table><thead><tr><th></th>${dates.map((d, i) => `<th>${DAYS[i]}<br><small>${dayLabel(d, { day: 'numeric', month: 'short' })}</small></th>`).join('')}</tr></thead>
      <tbody>${groups().map(g => sect(esc(g.label), g.list)).join('')}</tbody></table>
      <script>setTimeout(()=>print(),300)<\/script></body></html>`);
    win.document.close();
  }

  window.Schedule = {
    async show() {
      if (!can('schedule.manage', 'schedule.edit')) return;
      let first = false;
      if (!S.started) { S.started = true; S.week = mondayOf(beirutToday()); shell(); first = true; }
      await refresh();
      // First open: this week is already published -> the week to plan is next week.
      if (first && S.row && S.row.published) { S.week = addDays(S.week, 7); await loadWeek(); render(); }
    },
    _state: S,
  };
})();
