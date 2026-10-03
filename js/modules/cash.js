/* ============================================================
   Cash differences (PLAN §8): monthly grid (days x cashiers),
   analysis (summary, pattern alerts, 12-month trend), cashiers
   (order, PINs, lock-outs), settings, and import of the old
   monthly Google Sheets (LBP).
   Currency: LBP, whole pounds (owner, 2026-09-29: was USD; migration 015
   converted every amount back to its LBP value). Public API: window.Cash.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-cash');
  const CURRENCY = 'LBP';
  const S = {
    tab: 'grid', month: todayStr().slice(0, 7),
    cashiers: [], settings: { warning_threshold: 895000, danger_threshold: 1790000, alert_short_count: 3, alert_short_streak: 3, reminder_hour: 12 },
    entries: new Map(),          // `${cashierId}|${day}` -> row (selected month)
    recentIds: new Set(),        // cashiers with entries this month or last month (current month only)
    locked: false, lockInfo: null,
    history: [],                 // last 12 months of rows (analysis)
    started: false, trendAsTable: false,
    view: 'grid', person: null,  // Month grid | By cashier (owner, 2026-10-03)
    jump: true,                  // next grid render: scroll to today (set on open / month change)
    importPlan: null,
    pins: null,                  // id -> PIN while "Show PINs" is on (cashier_pins(), migration 036)
  };

  /* ---------------- helpers ---------------- */
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  // LBP, whole pounds: "-1,250,000 LBP" (money) and "-1,250,000" (inside a grid cell).
  const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const lbp = n => num(n) + ' LBP';
  // Short form for small boxes (phone calendar): -1.55m, -293k, 0.
  const short = n => { const v = Math.round(Number(n) || 0), a = Math.abs(v);
    return a >= 1e6 ? (v / 1e6).toFixed(2).replace(/.?0+$/, '') + 'm' : a >= 1000 ? Math.round(v / 1000) + 'k' : String(v); };
  const daysIn = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const monthLabel = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const monthShort = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short' });
  const dayStr = (ym, d) => `${ym}-${String(d).padStart(2, '0')}`;
  const key = (cid, day) => `${cid}|${day}`;
  const level = amt => {
    const a = Math.abs(Number(amt) || 0);
    return a >= S.settings.danger_threshold ? 'danger' : a >= S.settings.warning_threshold ? 'warn' : '';
  };
  const beirutHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut', hour: '2-digit', hour12: false }));
  const CASHIER_COLS = 'id, name, active, sort_order, has_pin, failed_attempts, locked_until';
  // When a cashier last opened the cashier page (migration 039): "today 09:14", "3 days ago", "never".
  const seenLabel = at => {
    if (!at) return 'never';
    const d = new Date(at), days = Math.floor((new Date(todayStr()) - new Date(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' }))) / 86400000);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Beirut' });
    return days <= 0 ? 'today ' + time : days === 1 ? 'yesterday ' + time : days < 30 ? days + ' days ago' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const fail = (what, error) => { console.error(error); showToast(`${what} — ${friendlyError(error)}`, true); };

  /* ---------------- data ---------------- */
  async function loadCashiers() {
    let { data, error } = await sb.from('cashiers').select(CASHIER_COLS + ', position, last_seen_at').order('sort_order').order('name');
    if (error && /last_seen_at/.test(error.message)) ({ data, error } = await sb.from('cashiers').select(CASHIER_COLS + ', position').order('sort_order').order('name'));   // before migration 039
    if (error && /position/.test(error.message)) ({ data, error } = await sb.from('cashiers').select(CASHIER_COLS).order('sort_order').order('name'));   // before migration 020
    if (error) return fail('Could not load cashiers', error);
    // Supervisors are cashiers too (owner, 2026-10-01): they stay in the grid with their differences.
    S.cashiers = data;
  }
  async function loadSettings() {
    const { data, error } = await sb.from('cash_settings').select('*').eq('id', 'app').maybeSingle();
    if (error) return fail('Could not load cash settings', error);
    if (data) S.settings = { ...S.settings, ...data, warning_threshold: Number(data.warning_threshold), danger_threshold: Number(data.danger_threshold) };
  }
  async function loadMonth() {
    const ym = S.month;
    const [rows, lock] = await Promise.all([
      sb.from('cash_differences').select('id, cashier_id, day, amount, note, source_amount, source_currency, source_rate')
        .eq('currency', CURRENCY).gte('day', dayStr(ym, 1)).lte('day', dayStr(ym, daysIn(ym))),
      sb.from('cash_months').select('*').eq('month', ym).maybeSingle(),
    ]);
    if (rows.error) return fail('Could not load the month', rows.error);
    S.entries = new Map(rows.data.map(r => [key(r.cashier_id, r.day), { ...r, amount: Number(r.amount) }]));
    S.locked = !!lock.data?.locked;
    S.lockInfo = lock.data || null;
    S.recentIds = new Set();
    if (ym === todayStr().slice(0, 7)) {
      const { data } = await sb.from('cash_differences').select('cashier_id').eq('currency', CURRENCY)
        .gte('day', dayStr(addMonths(ym, -1), 1)).lte('day', dayStr(ym, daysIn(ym))).limit(5000);
      S.recentIds = new Set((data || []).map(r => r.cashier_id));
    }
  }
  async function loadHistory() {
    const from = addMonths(S.month, -11);
    const out = [];
    for (let page = 0; ; page++) {
      const { data, error } = await sb.from('cash_differences').select('cashier_id, day, amount')
        .eq('currency', CURRENCY).gte('day', dayStr(from, 1)).lte('day', dayStr(S.month, daysIn(S.month)))
        .order('day').range(page * 1000, page * 1000 + 999);
      if (error) return fail('Could not load the history', error);
      out.push(...data.map(r => ({ ...r, amount: Number(r.amount) })));
      if (data.length < 1000) break;
    }
    S.history = out;
  }

  // Columns (owner, 2026-09-29): past months show only the cashiers who have entries in that month;
  // the current (and a future) month shows the active cashiers too, so a new day can be typed in.
  const isPastMonth = () => S.month < todayStr().slice(0, 7);
  function gridCashiers() {
    const used = new Set([...S.entries.values()].map(r => r.cashier_id));
    return S.cashiers.filter(c => used.has(c.id) || (c.active && !isPastMonth()));
  }
  // Active cashiers who are probably no longer working here: nothing this month once a week of it has
  // passed (from the 8th), or nothing this month or last month.
  function idleCashiers() {
    if (S.month !== todayStr().slice(0, 7)) return [];
    const thisMonth = new Set([...S.entries.values()].map(r => r.cashier_id));
    const weekIn = Number(todayStr().slice(8, 10)) >= 8;
    return S.cashiers.filter(c => c.active && !thisMonth.has(c.id) && (weekIn || !S.recentIds.has(c.id)));
  }
  const cashierName = id => S.cashiers.find(c => c.id === id)?.name || '(removed)';

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="filter-row cash-tabs" id="cashTabs">
        <button data-tab="grid">Month grid</button>
        <button data-tab="analysis">Analysis</button>
        ${can('cash.cashiers') ? '<button data-tab="cashiers">Cashiers &amp; settings</button>' : ''}
        ${can('cash.enter') ? '<button data-tab="import">Import old sheets</button>' : ''}
      </div>
      <div class="cash-monthbar" id="cashMonthBar">
        <button class="icon-btn" id="cashPrev" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <input type="month" id="cashMonth" aria-label="Month">
        <button class="icon-btn" id="cashNext" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span class="muted-note" id="cashMonthNote"></span>
        <div class="filter-row cash-views" id="cashViews" style="margin:0;"><button type="button" data-view="grid">Month grid</button><button type="button" data-view="person">By cashier</button></div>
        <span class="cash-monthbar-right" id="cashLockArea"></span>
      </div>
      <div id="cashBody"></div>`;
    el('cashTabs').onclick = e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.tab; S.jump = true; render(); } };
    el('cashViews').onclick = e => { const b = e.target.closest('[data-view]'); if (b) { S.view = b.dataset.view; S.jump = true; render(); } };
    window.addEventListener('resize', fitBox);
    el('cashPrev').onclick = () => setMonth(addMonths(S.month, -1));
    el('cashNext').onclick = () => setMonth(addMonths(S.month, 1));
    el('cashMonth').onchange = e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value); };
  }
  async function setMonth(ym) {
    S.month = ym; S.jump = true;
    await loadMonth();
    if (S.tab === 'analysis') await loadHistory();
    render();
  }

  function render() {
    panel.querySelectorAll('#cashTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    el('cashMonthBar').hidden = !['grid', 'analysis'].includes(S.tab);
    el('cashMonth').value = S.month;
    el('cashMonthNote').textContent = S.month === todayStr().slice(0, 7) ? 'This month' : '';
    el('cashViews').hidden = S.tab !== 'grid';
    el('cashViews').querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
    renderLockArea();
    if (S.tab === 'grid') renderBody();
    if (S.tab === 'analysis') renderAnalysis();
    if (S.tab === 'cashiers') renderCashiers();
    if (S.tab === 'import') renderImport();
  }

  /* ---------------- lock ---------------- */
  function renderLockArea() {
    const area = el('cashLockArea');
    if (S.locked) {
      area.innerHTML = `<span class="badge warn">Locked${S.lockInfo?.locked_at ? ' · ' + esc(fmtTs(S.lockInfo.locked_at)) : ''}</span>
        ${can('cash.unlock') ? '<button class="btn secondary small" id="cashUnlock">Unlock month</button>' : ''}`;
      el('cashUnlock')?.addEventListener('click', () => setLock(false));
    } else {
      area.innerHTML = can('cash.lock') ? '<button class="btn secondary small" id="cashLock">Lock month</button>' : '';
      el('cashLock')?.addEventListener('click', () => setLock(true));
    }
  }
  async function setLock(on) {
    const msg = on
      ? `Lock ${monthLabel(S.month)}? Nobody can change its differences until an admin unlocks it.`
      : `Unlock ${monthLabel(S.month)}? Its differences can be changed again.`;
    if (!(await showConfirm(msg, on ? 'Lock' : 'Unlock'))) return;
    const { error } = await sb.from('cash_months').upsert({ month: S.month, locked: on });
    if (error) return fail(on ? 'Could not lock the month' : 'Could not unlock the month', error);
    logActivity('cash', on ? 'lock_month' : 'unlock_month', { type: 'cash_month', id: S.month }, `${on ? 'Locked' : 'Unlocked'} ${monthLabel(S.month)}`);
    await loadMonth();
    render();
    showToast(`${monthLabel(S.month)} ${on ? 'locked' : 'unlocked'}.`);
  }

  /* ---------------- grid ---------------- */
  // The grid tab shows the month grid or one cashier's month.
  function renderBody() { if (S.view === 'person') renderPerson(); else renderGrid(); }
  // The scrolling box fills the screen down to its bottom edge, so the totals row (frozen at the bottom)
  // is always in sight and the page itself barely scrolls (owner, 2026-10-03).
  function fitBox() {
    const box = el('cashBody')?.querySelector('.cash-grid-wrap'); if (!box || !box.offsetParent) return;
    box.style.maxHeight = Math.max(320, window.innerHeight - box.getBoundingClientRect().top - 14) + 'px';
  }
  function renderGrid() {
    const body = el('cashBody');
    const old = body.querySelector('.cash-grid-wrap'), keep = old && !S.jump ? [old.scrollTop, old.scrollLeft] : null;
    const cols = gridCashiers();
    if (!S.cashiers.length) {
      body.innerHTML = `<div class="empty-state"><p class="big">No cashiers yet</p><p>Add them under <b>Cashiers &amp; settings</b>, or bring in your old sheets under <b>Import old sheets</b>.</p></div>`;
      return;
    }
    const n = daysIn(S.month), today = todayStr();
    const idle = idleCashiers();
    const colTotals = cols.map(() => 0);
    let grand = 0;
    const rowsHtml = [];
    for (let d = 1; d <= n; d++) {
      const day = dayStr(S.month, d);
      let rowTotal = 0, any = false;
      const cells = cols.map((c, ci) => {
        const e = S.entries.get(key(c.id, day));
        if (e) { rowTotal += e.amount; colTotals[ci] += e.amount; any = true; }
        const lv = e ? level(e.amount) : '';
        const title = e?.source_currency ? 'Imported from the old sheets' : '';
        return `<td class="cash-cell ${lv ? 'lv-' + lv : ''}">
          <input type="text" inputmode="numeric" data-c="${c.id}" data-day="${day}" data-row="${d}" data-col="${ci}"
            value="${e ? num(e.amount) : ''}" ${S.locked || !can('cash.enter') ? 'readonly' : ''} aria-label="${esc(c.name)}, ${day}" ${title ? `title="${esc(title)}"` : ''}>
          ${e ? `<button type="button" class="cash-note ${e.note ? 'has-note' : ''}" data-note="${esc(key(c.id, day))}" title="${e.note ? esc(e.note) : 'Add a note'}" tabindex="-1">${e.note ? '●' : '+'}</button>` : ''}
        </td>`;
      }).join('');
      grand += rowTotal;
      const isToday = day === today, weekday = new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
      rowsHtml.push(`<tr class="${isToday ? 'is-today' : ''}" data-d="${d}"><th class="cash-day">${d} <span>${weekday}</span></th>${cells}<td class="cash-total cash-daytot ${any ? 'lv-' + (level(rowTotal) || 'none') : ''}">${any ? lbp(rowTotal) : ''}</td></tr>`);
    }
    body.innerHTML = `
      ${S.locked ? `<div class="cash-banner"><b>${esc(monthLabel(S.month))} is locked.</b> Differences can't be changed${can('cash.unlock') ? ' until you unlock it' : '; ask the admin if something must be corrected'}.</div>` : ''}
      ${!S.locked && !can('cash.enter') ? `<div class="cash-banner">View only: you can't enter or change differences.</div>` : ''}
      ${idle.length && can('cash.cashiers') ? `<div class="cash-banner cash-idle"><span><b>${idle.length} cashier${idle.length === 1 ? ' has' : 's have'} no entries in ${esc(monthLabel(S.month))}:</b> ${idle.map(c => esc(c.name)).join(', ')}. Still working here? If not, mark them inactive and they leave the grid.</span>
        <button class="btn secondary small" id="cashIdleOff">Mark them inactive</button></div>` : ''}
      <div class="cash-legend">
        <span><i class="lv-warn"></i> ${lbp(S.settings.warning_threshold)} or more over/short</span>
        <span><i class="lv-danger"></i> ${lbp(S.settings.danger_threshold)} or more</span>
        <span class="muted-note">In LBP. Negative = short, positive = over. Arrows move between cells, Enter moves down. Paste a block from Excel into any cell.</span>
      </div>
      <div class="items-scroll cash-grid-wrap">
        <table class="cash-grid">
          <thead><tr><th class="cash-day">Day</th>${cols.map(c => `<th>${esc(c.name)}${c.active ? '' : ' <span class="muted-note">(inactive)</span>'}</th>`).join('')}<th class="cash-total cash-daytot">Day total</th></tr></thead>
          <tbody>${rowsHtml.join('')}</tbody>
          <tfoot><tr><th class="cash-day">Total</th>${colTotals.map(t => `<td class="cash-total">${lbp(t)}</td>`).join('')}<td class="cash-total cash-daytot"><b>${lbp(grand)}</b></td></tr></tfoot>
        </table>
      </div>`;
    if (!cols.length) body.querySelector('.cash-grid-wrap').outerHTML = `<div class="empty-state"><p class="big">No entries in ${esc(monthLabel(S.month))}</p><p>Nobody has a difference recorded for this month.</p></div>`;
    el('cashIdleOff')?.addEventListener('click', () => deactivateIdle(idle));
    wireGrid(body);
    fitBox();
    const box = body.querySelector('.cash-grid-wrap');
    if (box && keep) { box.scrollTop = keep[0]; box.scrollLeft = keep[1]; }
    else if (box && S.jump) {
      // Opens on today (this month): its row a couple of rows below the frozen names.
      const row = S.month === today.slice(0, 7) ? box.querySelector(`tr[data-d="${Number(today.slice(8, 10))}"]`) : null;
      box.scrollTop = row ? Math.max(0, row.offsetTop - box.querySelector('thead').offsetHeight - row.offsetHeight * 2) : 0;
    }
    S.jump = false;
  }

  /* ---------------- by cashier: one cashier's month as a calendar ---------------- */
  function renderPerson() {
    const body = el('cashBody');
    const list = gridCashiers().length ? gridCashiers() : S.cashiers.filter(c => c.active);
    if (!list.length) { body.innerHTML = '<div class="empty-state"><p class="big">No cashiers yet</p><p>Add them under <b>Cashiers &amp; settings</b>.</p></div>'; return; }
    if (!list.some(c => c.id === S.person)) S.person = list[0].id;
    const c = list.find(x => x.id === S.person), idx = list.indexOf(c);
    const n = daysIn(S.month), today = todayStr(), ro = S.locked || !can('cash.enter');
    const rows = [];
    for (let d = 1; d <= n; d++) { const e = S.entries.get(key(c.id, dayStr(S.month, d))); if (e) rows.push(e); }
    const total = rows.reduce((t, r) => t + r.amount, 0);
    const shorts = rows.filter(r => r.amount < 0), overs = rows.filter(r => r.amount > 0);
    const worst = shorts.slice().sort((a, b) => a.amount - b.amount)[0];
    const sum = list => list.reduce((t, r) => t + r.amount, 0);
    const lastDay = S.month === today.slice(0, 7) ? Number(today.slice(8, 10)) : S.month < today.slice(0, 7) ? n : 0;
    const blank = Array.from({ length: lastDay }, (_, i) => i + 1).filter(d => !S.entries.has(key(c.id, dayStr(S.month, d)))).length;
    const lead = (new Date(dayStr(S.month, 1) + 'T00:00:00').getDay() + 6) % 7;   // Monday first
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cc-cell cc-out"></div>');
    for (let d = 1; d <= n; d++) {
      const day = dayStr(S.month, d), e = S.entries.get(key(c.id, day)), lv = e ? level(e.amount) : '';
      cells.push(`<div class="cc-cell ${lv ? 'lv-' + lv : ''} ${day === today ? 'cc-today' : ''} ${e ? '' : 'cc-empty'}">
        <span class="cc-d">${d}</span>
        ${e ? `<span class="cc-short" aria-hidden="true">${short(e.amount)}</span>` : ''}
        <input type="text" inputmode="numeric" data-c="${c.id}" data-day="${day}" data-row="${d}" data-col="0" value="${e ? num(e.amount) : ''}" ${ro ? 'readonly' : ''} aria-label="${esc(c.name)}, ${day}">
        ${e ? `<button type="button" class="cash-note ${e.note ? 'has-note' : ''}" data-note="${esc(key(c.id, day))}" title="${e.note ? esc(e.note) : 'Add a note'}" tabindex="-1">${e.note ? '●' : '+'}</button>` : ''}
      </div>`);
    }
    const stat = (label, value, cls = '') => `<div class="cc-stat ${cls}"><span>${label}</span><b>${value}</b></div>`;
    body.innerHTML = `
      ${S.locked ? `<div class="cash-banner"><b>${esc(monthLabel(S.month))} is locked.</b> Differences can't be changed.</div>` : ''}
      <div class="cash-person">
        <button type="button" class="icon-btn" data-pstep="-1" ${idx <= 0 ? 'disabled' : ''} aria-label="Previous cashier"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <select id="cashPerson" aria-label="Cashier">${list.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : ' (inactive)'}</option>`).join('')}</select>
        <button type="button" class="icon-btn" data-pstep="1" ${idx >= list.length - 1 ? 'disabled' : ''} aria-label="Next cashier"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span class="muted-note">${idx + 1} of ${list.length}</span>
      </div>
      <div class="cc-stats">
        ${stat('Month total', lbp(total), total < 0 ? 'neg' : total > 0 ? 'pos' : '')}
        ${stat('Short', `${shorts.length} day${shorts.length === 1 ? '' : 's'} · ${lbp(sum(shorts))}`, shorts.length ? 'neg' : '')}
        ${stat('Over', `${overs.length} day${overs.length === 1 ? '' : 's'} · ${lbp(sum(overs))}`, overs.length ? 'pos' : '')}
        ${stat('Biggest short', worst ? `${lbp(worst.amount)} · ${fmtDate(worst.day)}` : '—')}
        ${lastDay ? stat('Not entered', `${blank} day${blank === 1 ? '' : 's'}`, blank ? 'warn' : '') : ''}
      </div>
      <div class="card cc-card">
        <div class="cc-grid cc-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<span>${w}</span>`).join('')}</div>
        <div class="cc-grid cash-cal">${cells.join('')}</div>
        <p class="muted-note" style="margin:10px 0 0;">In LBP. Negative = short, positive = over. Arrows move between days (up / down = a week), Enter goes to the next day. Empty = not entered.</p>
      </div>`;
    const cal = body.querySelector('.cash-cal');
    const go = d => { const t = cal.querySelector(`input[data-row="${d}"]`); if (t) { t.focus(); t.select(); return true; } return false; };
    cal.addEventListener('keydown', e => {
      const inp = e.target.closest('input[data-c]'); if (!inp) return;
      const d = Number(inp.dataset.row), len = inp.value.length, all = inp.selectionStart === 0 && inp.selectionEnd === len;
      const step = { Enter: 1, ArrowDown: 7, ArrowUp: -7, ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (e.key === 'ArrowLeft' && !all && inp.selectionStart > 0) return;
      if (e.key === 'ArrowRight' && !all && inp.selectionEnd < len) return;
      if (step && !e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (!go(d + step) && e.key === 'Enter') inp.blur(); }
      if (e.key === 'Escape') { const r = S.entries.get(key(inp.dataset.c, inp.dataset.day)); inp.value = r ? num(r.amount) : ''; inp.blur(); }
    });
    cal.addEventListener('focusin', e => { if (e.target.matches('input[data-c]')) e.target.select(); });
    cal.addEventListener('change', e => { const inp = e.target.closest('input[data-c]'); if (inp) saveCell(inp); });
    cal.addEventListener('click', e => { const b = e.target.closest('[data-note]'); if (b) editNote(b.dataset.note); });
    body.querySelectorAll('[data-pstep]').forEach(b => b.onclick = () => { const x = list[idx + Number(b.dataset.pstep)]; if (x) { S.person = x.id; renderPerson(); } });
    el('cashPerson').onchange = e => { S.person = e.target.value; renderPerson(); };
    S.jump = false;
  }
  async function deactivateIdle(list) {
    if (!(await showConfirm(`Mark ${list.length} cashier${list.length === 1 ? '' : 's'} inactive?\n\n${list.map(c => c.name).join(', ')}\n\nTheir past differences stay. They can be switched back on under Cashiers & settings.`, 'Mark inactive'))) return;
    const { error } = await sb.from('cashiers').update({ active: false }).in('id', list.map(c => c.id));
    if (error) return fail('Could not change the cashiers', error);
    list.forEach(c => { c.active = false; });
    logActivity('cash', 'deactivate_cashier', null, `Marked ${list.length} cashiers inactive (no entries for two months): ${list.map(c => c.name).join(', ')}`, { ids: list.map(c => c.id) });
    renderGrid();
    showToast(`${list.length} cashier${list.length === 1 ? '' : 's'} marked inactive.`);
  }

  function wireGrid(body) {
    const table = body.querySelector('.cash-grid');
    if (!table) return;
    table.addEventListener('keydown', e => {
      const inp = e.target.closest('input[data-c]'); if (!inp) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = table.querySelector(`input[data-col="${inp.dataset.col}"][data-row="${Number(inp.dataset.row) + (e.shiftKey ? -1 : 1)}"]`);
        if (next) { next.focus(); next.select(); } else inp.blur();
      }
      // Arrows move between cells like a spreadsheet; Left/Right only at the start/end of the text
      // (the whole value is selected on focus, so they move straight away until you edit).
      const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (moves[e.key] && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const len = inp.value.length, all = inp.selectionStart === 0 && inp.selectionEnd === len;
        if (e.key === 'ArrowLeft' && !all && inp.selectionStart > 0) return;
        if (e.key === 'ArrowRight' && !all && inp.selectionEnd < len) return;
        const [dr, dc] = moves[e.key];
        const next = table.querySelector(`input[data-col="${Number(inp.dataset.col) + dc}"][data-row="${Number(inp.dataset.row) + dr}"]`);
        if (next) { e.preventDefault(); next.focus(); next.select(); }
      }
      if (e.key === 'Escape') { const r = S.entries.get(key(inp.dataset.c, inp.dataset.day)); inp.value = r ? num(r.amount) : ''; inp.blur(); }
    });
    table.addEventListener('focusin', e => { if (e.target.matches('input[data-c]')) e.target.select(); });
    table.addEventListener('change', e => { const inp = e.target.closest('input[data-c]'); if (inp) saveCell(inp); });
    table.addEventListener('paste', e => { const inp = e.target.closest('input[data-c]'); if (inp) pasteBlock(e, inp); });
    table.addEventListener('click', e => { const b = e.target.closest('[data-note]'); if (b) editNote(b.dataset.note); });
  }

  async function saveCell(inp) {
    if (S.locked || !can('cash.enter')) return;
    const cid = inp.dataset.c, day = inp.dataset.day, k = key(cid, day);
    const before = S.entries.get(k);
    const raw = inp.value.trim();
    if (raw === '') {
      if (!before) return;
      const { error } = await sb.from('cash_differences').delete().eq('id', before.id);
      if (error) { inp.value = before.amount; return fail('Could not clear that cell', error); }
      S.entries.delete(k);
      logActivity('cash', 'clear', { type: 'cash_difference', id: before.id }, `Cleared ${cashierName(cid)} on ${fmtDate(day)} (was ${lbp(before.amount)})`, { cashier_id: cid, day, from: before.amount });
    } else {
      const amount = parseNum(raw);
      if (amount === null) { showToast('Numbers only, in LBP: e.g. -250000 for short or 100000 for over.', true); inp.value = before ? num(before.amount) : ''; return; }
      const v = Math.round(amount);
      if (before && before.amount === v) { inp.value = num(v); return; }
      const { data, error } = await sb.from('cash_differences')
        .upsert({ cashier_id: cid, day, currency: CURRENCY, amount: v, note: before?.note ?? null }, { onConflict: 'cashier_id,day,currency' })
        .select('id, cashier_id, day, amount, note, source_amount, source_currency, source_rate').single();
      if (error) { inp.value = before ? before.amount : ''; return fail('Could not save that cell', error); }
      S.entries.set(k, { ...data, amount: Number(data.amount) });
      logActivity('cash', before ? 'edit' : 'enter', { type: 'cash_difference', id: data.id },
        `${cashierName(cid)} ${fmtDate(day)}: ${before ? lbp(before.amount) + ' → ' : ''}${lbp(v)}`, { cashier_id: cid, day, from: before?.amount ?? null, to: v });
    }
    const focusRow = document.activeElement?.dataset?.row, focusCol = document.activeElement?.dataset?.col;
    renderBody();
    if (focusRow) el('cashBody').querySelector(`input[data-row="${focusRow}"][data-col="${focusCol}"]`)?.focus();
  }

  // Paste a block copied from Excel: rows -> days, columns -> cashiers, starting at the cell.
  async function pasteBlock(e, inp) {
    const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
    const lines = text.replace(/\r/g, '').split('\n'); while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const grid = lines.map(l => l.split('\t'));
    if (grid.length === 1 && grid[0].length === 1) return;        // single value: normal paste
    e.preventDefault();
    if (S.locked || !can('cash.enter')) return;
    const cols = gridCashiers(), n = daysIn(S.month);
    const r0 = Number(inp.dataset.row), c0 = Number(inp.dataset.col);
    const rows = [], bad = [];
    grid.forEach((line, i) => line.forEach((cell, j) => {
      const d = r0 + i, c = cols[c0 + j];
      if (d > n || !c || String(cell).trim() === '') return;
      const v = parseNum(cell);
      if (v === null) { bad.push(cell); return; }
      const day = dayStr(S.month, d);
      rows.push({ cashier_id: c.id, day, currency: CURRENCY, amount: Math.round(v), note: S.entries.get(key(c.id, day))?.note ?? null });
    }));
    if (!rows.length) { showToast('Nothing to paste: no numbers found.', true); return; }
    const { error } = await sb.from('cash_differences').upsert(rows, { onConflict: 'cashier_id,day,currency' });
    if (error) return fail('Could not paste those values', error);
    logActivity('cash', 'paste', { type: 'cash_month', id: S.month }, `Pasted ${rows.length} values into ${monthLabel(S.month)}`, { cells: rows.length, skipped: bad.length });
    await loadMonth();
    renderBody();
    showToast(`Pasted ${rows.length} value${rows.length === 1 ? '' : 's'}` + (bad.length ? ` — ${bad.length} cell${bad.length === 1 ? '' : 's'} skipped (not a number).` : '.'));
  }

  async function editNote(k) {
    const e = S.entries.get(k); if (!e) return;
    if (S.locked || !can('cash.enter')) { if (e.note) showConfirm(e.note, 'OK'); return; }
    const v = await showPrompt(`Note for ${cashierName(e.cashier_id)} on ${fmtDate(e.day)} (${lbp(e.amount)}):`, { defaultValue: e.note || '', confirmLabel: 'Save note', placeholder: 'e.g. Counted twice, confirmed by manager' });
    if (v === null) return;
    const note = v.trim() || null;
    const { error } = await sb.from('cash_differences').update({ note }).eq('id', e.id);
    if (error) return fail('Could not save the note', error);
    e.note = note;
    logActivity('cash', 'note', { type: 'cash_difference', id: e.id }, `Note on ${cashierName(e.cashier_id)} ${fmtDate(e.day)}: ${note || '(removed)'}`);
    renderBody();
  }

  /* ---------------- analysis ---------------- */
  function monthStats(rows, cashierId) {
    const mine = rows.filter(r => r.cashier_id === cashierId).sort((a, b) => a.day.localeCompare(b.day));
    const over = mine.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const short = mine.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0);
    const shortDays = mine.filter(r => r.amount < 0).length;
    const biggest = mine.reduce((b, r) => (!b || Math.abs(r.amount) > Math.abs(b.amount) ? r : b), null);
    // longest run of consecutive calendar days that were short
    let streak = 0, run = 0, prev = null;
    mine.forEach(r => {
      const consecutive = prev && daysBetween(prev, r.day) === 1;
      run = r.amount < 0 ? (consecutive && run ? run + 1 : 1) : 0;
      streak = Math.max(streak, run);
      prev = r.day;
    });
    const bigShorts = mine.filter(r => r.amount <= -S.settings.warning_threshold).length;
    return { entries: mine.length, over: round2(over), short: round2(short), net: round2(over + short), shortDays, biggest, streak, bigShorts };
  }
  function alertsFor(st) {
    const a = [];
    const s = S.settings;
    if (st.bigShorts >= s.alert_short_count) a.push(`${st.bigShorts} shortages of ${lbp(s.warning_threshold)} or more`);
    if (st.streak >= s.alert_short_streak) a.push(`short ${st.streak} days in a row`);
    if (st.net <= -s.danger_threshold) a.push(`net shortage of ${lbp(-st.net)} for the month`);
    return a;
  }

  function renderAnalysis() {
    const body = el('cashBody');
    const monthRows = S.history.filter(r => r.day.startsWith(S.month));
    const people = S.cashiers.filter(c => c.active || monthRows.some(r => r.cashier_id === c.id));
    const stats = people.map(c => ({ c, st: monthStats(monthRows, c.id) }));
    const alerts = stats.flatMap(({ c, st }) => alertsFor(st).map(t => ({ c, t })));
    body.innerHTML = `
      <div class="card">
        <h3>${esc(monthLabel(S.month))} — per cashier</h3>
        <div class="items-scroll" style="margin-bottom:0;">
          <table class="items cash-summary">
            <thead><tr><th>Cashier</th><th class="num">Days entered</th><th class="num">Total over</th><th class="num">Total short</th><th class="num">Net</th><th class="num">Short days</th><th class="num">Biggest single</th></tr></thead>
            <tbody>${stats.map(({ c, st }) => `<tr class="${alertsFor(st).length ? 'has-alert' : ''}">
              <td><b>${esc(c.name)}</b></td><td class="num">${st.entries}</td>
              <td class="num">${lbp(st.over)}</td><td class="num">${lbp(st.short)}</td>
              <td class="num"><b>${lbp(st.net)}</b></td><td class="num">${st.shortDays}</td>
              <td class="num">${st.biggest ? `${lbp(st.biggest.amount)} <span class="muted-note">${fmtDate(st.biggest.day)}</span>` : '—'}</td></tr>`).join('')
              || '<tr><td colspan="7" class="empty-note">No cashiers yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h3>Pattern alerts</h3>
        ${alerts.length ? `<ul class="cash-alerts">${alerts.map(a => `<li><span class="cash-alert-icon" aria-hidden="true">!</span><span class="badge danger">Check</span><span><b>${esc(a.c.name)}</b>: ${esc(a.t)}</span></li>`).join('')}</ul>`
          : '<p class="empty-note" style="margin:0;">No alerts this month.</p>'}
        <p class="muted-note" style="margin:10px 0 0;">Rules (change them under Cashiers &amp; settings): ${S.settings.alert_short_count}+ shortages of ${lbp(S.settings.warning_threshold)} or more · short ${S.settings.alert_short_streak} days in a row · net monthly shortage of ${lbp(S.settings.danger_threshold)} or more.</p>
      </div>
      <div class="card">
        <div class="cash-trend-head">
          <h3 style="margin:0;">Net difference, last 12 months</h3>
          <div class="filter-row" style="margin:0;">
            <button class="${S.trendAsTable ? '' : 'active'}" data-trend="chart">Chart</button>
            <button class="${S.trendAsTable ? 'active' : ''}" data-trend="table">Table</button>
          </div>
        </div>
        <div id="cashTrend"></div>
      </div>`;
    body.querySelectorAll('[data-trend]').forEach(b => b.onclick = () => { S.trendAsTable = b.dataset.trend === 'table'; renderAnalysis(); });
    renderTrend(people);
  }

  // Small multiples: one 12-bar chart per cashier. Bars grow up (over) or down (short) from zero.
  function renderTrend(people) {
    const box = el('cashTrend');
    const months = Array.from({ length: 12 }, (_, i) => addMonths(S.month, i - 11));
    const series = people.map(c => ({
      c, vals: months.map(m => {
        const rows = S.history.filter(r => r.cashier_id === c.id && r.day.startsWith(m));
        return rows.length ? round2(rows.reduce((s, r) => s + r.amount, 0)) : null;
      }),
    }));
    if (!series.length) { box.innerHTML = '<p class="empty-note">No cashiers yet.</p>'; return; }
    if (S.trendAsTable) {
      box.innerHTML = `<div class="items-scroll" style="margin:14px 0 0;"><table class="items cash-summary">
        <thead><tr><th>Cashier</th>${months.map(m => `<th class="num">${monthShort(m)} ${m.slice(2, 4)}</th>`).join('')}</tr></thead>
        <tbody>${series.map(s => `<tr><td><b>${esc(s.c.name)}</b></td>${s.vals.map(v => `<td class="num">${v === null ? '—' : lbp(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      return;
    }
    // One shared scale so cashiers can be compared at a glance.
    const maxAbs = Math.max(1, ...series.flatMap(s => s.vals.map(v => Math.abs(v || 0))));
    const W = 300, H = 96, padX = 4, mid = H / 2, slot = (W - padX * 2) / 12, bw = Math.min(16, slot - 6), r = 3;
    const bar = (v, i) => {
      if (v === null || v === 0) return '';
      const h = Math.max(2, (Math.abs(v) / maxAbs) * (mid - 6));
      const x = padX + i * slot + (slot - bw) / 2;
      // rounded at the data end, square on the zero line
      const d = v > 0
        ? `M${x},${mid} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`
        : `M${x},${mid} v${h - r} a${r},${r} 0 0 0 ${r},${r} h${bw - 2 * r} a${r},${r} 0 0 0 ${r},${-r} v${-(h - r)} z`;
      return `<path class="${v > 0 ? 'bar-over' : 'bar-short'}" d="${d}"/>`;
    };
    box.innerHTML = `<div class="cash-trend-grid">${series.map(s => {
      const total = round2(s.vals.reduce((a, v) => a + (v || 0), 0));
      return `<figure class="cash-trend" data-cashier="${esc(s.c.id)}">
        <figcaption><b>${esc(s.c.name)}</b><span>net ${lbp(total)} · 12 months</span></figcaption>
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.c.name)}: monthly net difference, last 12 months">
          <line class="zero" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/>
          ${s.vals.map(bar).join('')}
          ${s.vals.map((v, i) => `<rect class="hit" x="${padX + i * slot}" y="0" width="${slot}" height="${H}" data-i="${i}"/>`).join('')}
        </svg>
        <div class="cash-trend-axis"><span>${monthShort(months[0])}</span><span>${monthShort(months[11])}</span></div>
      </figure>`;
    }).join('')}</div><div class="cash-tip" id="cashTip" hidden></div>`;
    const tip = el('cashTip');
    box.querySelectorAll('.cash-trend').forEach(fig => {
      const s = series.find(x => x.c.id === fig.dataset.cashier);
      fig.querySelectorAll('.hit').forEach(h => {
        h.addEventListener('mouseenter', () => {
          const i = Number(h.dataset.i), v = s.vals[i];
          tip.innerHTML = `<b>${esc(s.c.name)}</b><br>${esc(monthLabel(months[i]))}: ${v === null ? 'no entries' : `${lbp(v)} ${v < 0 ? 'short' : v > 0 ? 'over' : ''}`}`;
          tip.hidden = false;
          const rb = h.getBoundingClientRect(), pb = box.getBoundingClientRect();
          tip.style.left = `${rb.left - pb.left + rb.width / 2}px`;
          tip.style.top = `${rb.top - pb.top - 8}px`;
          fig.querySelectorAll('.hit').forEach(x => x.classList.toggle('on', x === h));
        });
        h.addEventListener('mouseleave', () => { tip.hidden = true; h.classList.remove('on'); });
      });
    });
  }

  /* ---------------- cashiers & settings ---------------- */
  function renderCashiers() {
    const body = el('cashBody');
    const pageUrl = new URL('cashier.html', location.href).href;
    const now = Date.now();
    const s = S.settings;
    body.innerHTML = `
      <div class="card">
        <div class="cash-card-head"><h3 style="margin:0;">Cashiers</h3><span class="muted-note">The grid shows active cashiers in this order. Drag a row by its handle (⋮⋮) to move it.</span></div>
        ${isAdmin() ? `<div class="cash-pin-bar">
          <button type="button" class="btn secondary small" id="cashShowPins">${S.pins ? 'Hide PINs' : 'Show PINs'}</button>
          <button type="button" class="btn secondary small" id="cashExportPins">Export PINs (Excel)</button>
          ${S.pins && S.cashiers.some(c => c.active && !S.pins.get(c.id)) ? `<button type="button" class="btn small" id="cashNewPins">New PINs for the ${S.cashiers.filter(c => c.active && !S.pins.get(c.id)).length} without a visible one</button>` : ''}
          <span class="muted-note">Only you (admin) can see PINs. PINs set before 3 Oct 2026 can't be shown — set them again (or use the button). Cashiers can change their own PIN on the cashier page.</span>
        </div>` : ''}
        <form id="cashAddForm" class="cash-add">
          <input type="text" id="cashNewName" placeholder="New cashier's name" required>
          <button class="btn small" type="submit">+ Add cashier</button>
        </form>
        <div class="items-scroll" style="margin-bottom:0;">
          <table class="items">
            <thead><tr><th></th><th>Name</th><th>Position</th><th>Status</th><th>PIN</th><th>Last opened the cashier page</th><th></th></tr></thead>
            <tbody>${S.cashiers.map((c, i) => {
              const locked = c.locked_until && new Date(c.locked_until).getTime() > now;
              return `<tr data-id="${esc(c.id)}">
                <td>${RowDrag.handle()}</td>
                <td><b>${esc(c.name)}</b></td>
                <td><select data-f="position" aria-label="Position of ${esc(c.name)}" style="width:auto;padding:5px 8px;">
                  <option value="cashier" ${!['supervisor', 'picker', 'delivery_supervisor'].includes(c.position) ? 'selected' : ''}>Cashier</option>
                  <option value="supervisor" ${c.position === 'supervisor' ? 'selected' : ''}>Supervisor</option>
                  <option value="picker" ${c.position === 'picker' ? 'selected' : ''}>Picker</option>
                  <option value="delivery_supervisor" ${c.position === 'delivery_supervisor' ? 'selected' : ''}>Delivery supervisor</option></select></td>
                <td>${c.active ? '<span class="badge active">Active</span>' : '<span class="badge inactive">Inactive</span>'}</td>
                <td>${locked ? `<span class="badge danger">Locked out</span>` : c.has_pin ? '<span class="badge active">Set</span>' : '<span class="badge warn">Not set</span>'}${S.pins && c.has_pin ? (S.pins.get(c.id) ? ` <code class="cash-pin">${esc(S.pins.get(c.id))}</code>` : ' <span class="muted-note">not visible</span>') : ''}</td>
                <td class="muted-note" style="white-space:nowrap;">${esc(seenLabel(c.last_seen_at))}</td>
                <td><div class="icon-actions" style="justify-content:flex-end;">
                  <button class="btn secondary small" data-act="pin">${c.has_pin ? 'Reset PIN' : 'Set PIN'}</button>
                  ${locked ? '<button class="btn secondary small" data-act="unlock">Unlock</button>' : ''}
                  <button class="btn ghost small" data-act="rename">Rename</button>
                  <button class="btn ghost small" data-act="toggle">${c.active ? 'Deactivate' : 'Activate'}</button>
                </div></td></tr>`;
            }).join('') || '<tr><td colspan="7" class="empty-note">No cashiers yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h3>Cashier page</h3>
        <p style="margin:0 0 10px;">Cashiers see their own differences (this month and last month) by choosing their name and typing their 4-digit PIN. Nothing else is shown to them.</p>
        <div class="cash-link"><code id="cashPageUrl">${esc(pageUrl)}</code><button class="btn secondary small" id="cashCopyUrl">Copy link</button></div>
      </div>
      <div class="card">
        <h3>Colours, alerts and reminder</h3>
        <form id="cashSettingsForm">
          <div class="form-grid cash-settings-grid">
            <div><label for="csWarn">Orange from (LBP, over or short)</label><input type="text" inputmode="numeric" id="csWarn" value="${num(s.warning_threshold)}"></div>
            <div><label for="csDanger">Red from (LBP)</label><input type="text" inputmode="numeric" id="csDanger" value="${num(s.danger_threshold)}"></div>
            <div><label for="csCount">Alert: shortages of the orange amount or more, per month</label><input type="text" inputmode="numeric" id="csCount" value="${s.alert_short_count}"></div>
            <div><label for="csStreak">Alert: short this many days in a row</label><input type="text" inputmode="numeric" id="csStreak" value="${s.alert_short_streak}"></div>
            <div><label for="csHour">Remind me if yesterday is still empty at (hour, Beirut)</label><input type="text" inputmode="numeric" id="csHour" value="${s.reminder_hour}"></div>
          </div>
          <div class="actions-row"><button class="btn small" type="submit">Save settings</button></div>
        </form>
      </div>`;

    el('cashShowPins')?.addEventListener('click', togglePins);
    el('cashExportPins')?.addEventListener('click', exportPins);
    el('cashNewPins')?.addEventListener('click', renewPins);
    el('cashAddForm').onsubmit = async e => {
      e.preventDefault();
      const name = el('cashNewName').value.trim(); if (!name) return;
      const sort = Math.max(0, ...S.cashiers.map(c => c.sort_order)) + 1;
      const { data, error } = await sb.from('cashiers').insert({ name, sort_order: sort }).select(CASHIER_COLS + ', position').single();
      if (error) return fail(/duplicate|unique/i.test(error.message) ? `"${name}" already exists` : 'Could not add the cashier', error);
      S.cashiers.push(data);
      logActivity('cash', 'add_cashier', { type: 'cashier', id: data.id }, `Added cashier ${name}`);
      renderCashiers();
      showToast(`${name} added. Set a PIN so they can open the cashier page.`);
    };
    el('cashCopyUrl').onclick = async () => showToast((await copyTextToClipboard(pageUrl)) ? 'Link copied.' : 'Could not copy — select the link and copy it.', false);
    wireDrag(body.querySelector('tbody'));
    body.querySelector('tbody').onclick = e => { const b = e.target.closest('[data-act]'); if (b) cashierAction(b.dataset.act, b.closest('tr').dataset.id); };
    // Cashier / Supervisor (the Staff schedule uses it; both keep their cash differences).
    body.querySelector('tbody').onchange = async e => {
      const sel = e.target.closest('select[data-f="position"]'); if (!sel) return;
      const c = S.cashiers.find(x => x.id === sel.closest('tr').dataset.id); if (!c) return;
      const patch = { position: sel.value };
      const { error } = await sb.from('cashiers').update(patch).eq('id', c.id);
      if (error) { sel.value = c.position || 'cashier'; return fail('Could not change the position', error); }
      c.position = sel.value;
      logActivity('cash', 'cashier_position', { type: 'cashier', id: c.id }, `${c.name} is now ${sel.value === 'supervisor' ? 'a supervisor' : 'a cashier'}`);
      showToast(`${c.name} is now ${sel.value === 'supervisor' ? 'a supervisor' : 'a cashier'}.`);
    };
    el('cashSettingsForm').onsubmit = saveSettings;
  }

  // Saves sort_order for the rows whose place changed (the grid and the Staff schedule follow it).
  async function saveOrder(summary) {
    const updates = S.cashiers.map((x, k) => ({ x, k })).filter(({ x, k }) => x.sort_order !== k);
    renderCashiers();
    for (const { x, k } of updates) {
      const { error } = await sb.from('cashiers').update({ sort_order: k }).eq('id', x.id);
      if (error) { await loadCashiers(); renderCashiers(); return fail('Could not reorder', error); }
      x.sort_order = k;
    }
    if (updates.length) logActivity('cash', 'reorder_cashiers', null, summary, { order: S.cashiers.map(x => x.name) });
  }

  // Drag by the handle: the row follows the pointer; dropped, it takes that place.
  function wireDrag(tbody) {
    RowDrag.attach(tbody, { rows: 'tr[data-id]', onDrop: (order, id) => {
      const c = S.cashiers.find(x => x.id === id);
      S.cashiers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      saveOrder(`Moved ${c.name} to place ${order.indexOf(id) + 1}`);
    } });
  }

  async function cashierAction(act, id) {
    const c = S.cashiers.find(x => x.id === id); if (!c) return;
    if (act === 'rename') {
      const v = await showPrompt(`New name for ${c.name}:`, { defaultValue: c.name, confirmLabel: 'Rename' });
      if (v === null || !v.trim() || v.trim() === c.name) return;
      const { error } = await sb.from('cashiers').update({ name: v.trim() }).eq('id', id);
      if (error) return fail(/duplicate|unique/i.test(error.message) ? `"${v.trim()}" already exists` : 'Could not rename', error);
      logActivity('cash', 'rename_cashier', { type: 'cashier', id }, `Renamed cashier ${c.name} to ${v.trim()}`);
      c.name = v.trim();
      return renderCashiers();
    }
    if (act === 'toggle') {
      const on = !c.active;
      if (!on && !(await showConfirm(`Deactivate ${c.name}? Their past differences stay; they disappear from new months and can no longer open the cashier page.`, 'Deactivate'))) return;
      const { error } = await sb.from('cashiers').update({ active: on }).eq('id', id);
      if (error) return fail('Could not change the cashier', error);
      c.active = on;
      logActivity('cash', on ? 'activate_cashier' : 'deactivate_cashier', { type: 'cashier', id }, `${on ? 'Activated' : 'Deactivated'} cashier ${c.name}`);
      return renderCashiers();
    }
    if (act === 'unlock') {
      const { error } = await sb.from('cashiers').update({ failed_attempts: 0, locked_until: null }).eq('id', id);
      if (error) return fail('Could not unlock', error);
      c.failed_attempts = 0; c.locked_until = null;
      logActivity('cash', 'unlock_cashier_pin', { type: 'cashier', id }, `Cleared the PIN lock-out of ${c.name}`);
      return renderCashiers();
    }
    if (act === 'pin') {
      const suggestion = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
      const pin = await showPrompt(`4-digit PIN for ${c.name}:`, { defaultValue: suggestion, confirmLabel: 'Set PIN', placeholder: '4 digits' });
      if (pin === null) return;
      if (!/^\d{4}$/.test(pin.trim())) { showToast('The PIN must be exactly 4 digits.', true); return; }
      const { error } = await sb.rpc('set_cashier_pin', { p_cashier: id, p_pin: pin.trim() });
      if (error) return fail('Could not set the PIN', error);
      c.has_pin = true; c.failed_attempts = 0; c.locked_until = null;
      logActivity('cash', 'set_cashier_pin', { type: 'cashier', id }, `Set a new PIN for ${c.name}`);   // never the PIN itself
      renderCashiers();
      if (S.pins) S.pins.set(id, pin.trim());
      await showConfirm(`PIN set. Give it to ${c.name} privately:\n\n${pin.trim()}\n\n${isAdmin() ? 'You can see it again with Show PINs or Export PINs.' : 'Only the admin can look it up later. The cashier can change it on the cashier page.'}`, 'Done');
    }
  }

  /* ---------------- PINs: show, export, renew (migration 036) ---------------- */
  async function loadPins() {
    const { data, error } = await sb.rpc('cashier_pins');
    if (error) { fail('Could not load the PINs', error); return null; }
    return new Map((data || []).map(r => [r.id, r.pin || '']));
  }
  async function togglePins() {
    if (S.pins) { S.pins = null; return renderCashiers(); }
    S.pins = await loadPins(); if (!S.pins) return;
    logActivity('cash', 'view_cashier_pins', { type: 'cashier', id: 'all' }, 'Looked at the cashier PINs');
    renderCashiers();
  }
  async function exportPins() {
    const pins = await loadPins(); if (!pins) return;
    const aoa = [['Name', 'Position', 'Status', 'PIN']];
    S.cashiers.forEach(c => aoa.push([c.name, c.position === 'supervisor' ? 'Supervisor' : 'Cashier', c.active ? 'Active' : 'Inactive',
      pins.get(c.id) || (c.has_pin ? 'set before 3 Oct 2026 — set it again to see it' : 'no PIN')]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 10 }, { wch: 18 }];
    // The PIN column as text, so 0042 keeps its zeros.
    for (let r = 1; r < aoa.length; r++) { const cell = ws[XLSX.utils.encode_cell({ r, c: 3 })]; if (cell) { cell.t = 's'; cell.z = '@'; } }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'PINs');
    XLSX.writeFile(wb, `cashier-pins-${todayStr()}.xlsx`);
    logActivity('cash', 'export_cashier_pins', { type: 'cashier', id: 'all' }, 'Exported the cashier PINs');
  }
  // Active cashiers whose PIN can't be shown (set before 036, or none): a new random PIN each.
  async function renewPins() {
    const list = S.cashiers.filter(c => c.active && !S.pins?.get(c.id));
    if (!list.length) return;
    if (!(await showConfirm(`Give a new PIN to ${list.length} cashier${list.length === 1 ? '' : 's'} (${list.map(c => c.name).join(', ')})? Their old PIN stops working — give them the new one.`, 'New PINs'))) return;
    let done = 0;
    for (const c of list) {
      const pin = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
      const { error } = await sb.rpc('set_cashier_pin', { p_cashier: c.id, p_pin: pin });
      if (error) { fail(`Could not set the PIN of ${c.name}`, error); break; }
      c.has_pin = true; c.failed_attempts = 0; c.locked_until = null; done++;
    }
    logActivity('cash', 'renew_cashier_pins', { type: 'cashier', id: 'all' }, `Set new PINs for ${done} cashier${done === 1 ? '' : 's'}`);
    S.pins = await loadPins();
    renderCashiers();
    showToast(`${done} new PIN${done === 1 ? '' : 's'} set — export them to hand them out.`);
  }

  async function saveSettings(e) {
    e.preventDefault();
    const n = id => parseNum(el(id).value);
    const next = {
      warning_threshold: n('csWarn'), danger_threshold: n('csDanger'),
      alert_short_count: Math.round(n('csCount')), alert_short_streak: Math.round(n('csStreak')), reminder_hour: Math.round(n('csHour')),
    };
    if (Object.values(next).some(v => v === null || isNaN(v) || v < 0)) { showToast('Fill every setting with a number.', true); return; }
    if (next.danger_threshold < next.warning_threshold) { showToast('The red amount must be at least the orange amount.', true); return; }
    if (next.reminder_hour > 23) { showToast('The reminder hour is 0 to 23.', true); return; }
    const { error } = await sb.from('cash_settings').update(next).eq('id', 'app');
    if (error) return fail('Could not save the settings', error);
    const changed = {};
    Object.keys(next).forEach(k => { if (Number(S.settings[k]) !== next[k]) changed[k] = { from: S.settings[k], to: next[k] }; });
    Object.assign(S.settings, next);
    if (Object.keys(changed).length) logActivity('cash', 'settings', null, 'Changed the cash settings', { changed });
    showToast('Settings saved.');
  }

  /* ---------------- import old monthly sheets (LBP) ---------------- */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  function monthFromSheetName(name) {
    const s = name.trim().toLowerCase();
    let m = s.match(/^([a-z]+)[\s\-_.\/]*(\d{4})$/);
    if (m && MONTHS[m[1]]) return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}`;
    m = s.match(/^(\d{4})[\-\/_.](\d{1,2})$/) || s.match(/^(\d{1,2})[\-\/_.](\d{4})$/);
    if (m) { const [y, mo] = m[1].length === 4 ? [m[1], m[2]] : [m[2], m[1]]; if (+mo >= 1 && +mo <= 12) return `${y}-${String(mo).padStart(2, '0')}`; }
    return null;
  }
  const colLetter = i => XLSX.utils.encode_col(i);

  function parseSheet(ws, sheetName) {
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
    const hr = aoa.findIndex(r => r.some(v => /day\s*of\s*the\s*month/i.test(String(v))));
    const out = { sheet: sheetName, month: monthFromSheetName(sheetName), current: /current/i.test(sheetName), cashierCols: [], cells: [], problems: [] };
    if (hr < 0) { out.problems.push('No "Day of the month" header found; sheet skipped.'); out.skip = true; return out; }
    const header = aoa[hr].map(v => String(v).trim());
    const dayCol = header.findIndex(v => /day\s*of\s*the\s*month/i.test(v));
    header.forEach((h, i) => { if (i !== dayCol && h && !/^total/i.test(h)) out.cashierCols.push({ i, name: h }); });
    const byCol = new Map(out.cashierCols.map(c => [c.i, c.name]));
    for (let r = hr + 1; r < aoa.length; r++) {
      const row = aoa[r];
      const day = parseInt(String(row[dayCol]).trim(), 10);
      if (!(day >= 1 && day <= 31) || String(row[dayCol]).trim() !== String(day)) continue;   // totals, blanks, notes
      row.forEach((v, i) => {
        if (i === dayCol || String(v).trim() === '') return;
        const ref = `${colLetter(i)}${r + 1}`;
        if (/^total/i.test(header[i] || '')) return;
        if (!byCol.has(i)) { out.problems.push(`${ref}: "${v}" is outside a cashier column (no name above it)`); return; }
        const n = parseNum(v);
        if (n === null) { out.problems.push(`${ref}: could not read "${v}" as a number`); return; }
        out.cells.push({ name: byCol.get(i), day, lbp: n });
      });
    }
    return out;
  }

  function renderImport() {
    const body = el('cashBody');
    const p = S.importPlan;
    body.innerHTML = `
      <div class="card">
        <h3>Import the old monthly sheets</h3>
        <p style="margin:0 0 12px;">Download the Google Sheet as Excel (File → Download → .xlsx) and choose it here. Each tab is one month (e.g. <code>AUG-2026</code>); the header row has <b>Day of the month</b> and the cashiers' names. The amounts are in LBP, like the app.</p>
        <div class="form-grid">
          <div><label for="cashImportFile">Excel file</label><input type="file" id="cashImportFile" accept=".xlsx,.xls"></div>
        </div>
      </div>
      <div id="cashImportPreview"></div>`;
    el('cashImportFile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
        S.importPlan = { file: f.name, sheets: wb.SheetNames.map(n => parseSheet(wb.Sheets[n], n)), skipExisting: true };
      } catch (err) { showToast('Could not read that file as Excel.', true); return; }
      renderImportPreview();
    };
    if (p) renderImportPreview();
  }

  function renderImportPreview() {
    const box = el('cashImportPreview'), p = S.importPlan;
    const known = new Map(S.cashiers.map(c => [c.name.trim().toLowerCase(), c]));
    const sheets = p.sheets.filter(s => !s.skip);
    const newNames = [...new Set(sheets.flatMap(s => s.cashierCols.map(c => c.name)).filter(n => !known.has(n.trim().toLowerCase())))];
    p.createNames = p.createNames || new Set(newNames);
    box.innerHTML = `
      <div class="card">
        <h3>Preview — ${esc(p.file)}</h3>
        ${newNames.length ? `<div class="cash-banner">These names are not cashiers yet. Ticked ones will be created (inactive ones can be switched on later):
          <div class="cash-newnames">${newNames.map(n => `<label><input type="checkbox" data-newname="${esc(n)}" ${p.createNames.has(n) ? 'checked' : ''}> ${esc(n)}</label>`).join('')}</div></div>` : ''}
        <div class="items-scroll" style="margin-bottom:12px;">
          <table class="items">
            <thead><tr><th>Tab</th><th>Month</th><th>Cashiers</th><th class="num">Values</th><th class="num">Total (LBP)</th><th>Problems</th></tr></thead>
            <tbody>${p.sheets.map((s, i) => {
              const total = s.cells.reduce((a, c) => a + c.lbp, 0);
              return `<tr class="${s.skip ? 'is-skipped' : ''}">
                <td><b>${esc(s.sheet)}</b></td>
                <td>${s.skip ? '—' : `<input type="month" data-month="${i}" value="${s.month || ''}" class="cash-import-month">${!s.month ? ' <span class="badge warn">Pick the month</span>' : ''}`}</td>
                <td style="white-space:normal;">${s.cashierCols.map(c => esc(c.name)).join(', ') || '—'}</td>
                <td class="num">${s.cells.length}</td>
                <td class="num">${num(total)}</td>
                <td style="white-space:normal;">${s.problems.length ? `<details><summary>${s.problems.length} to check</summary><ul class="cash-problems">${s.problems.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : '<span class="muted-note">None</span>'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink);"><input type="checkbox" id="cashSkipExisting" ${p.skipExisting ? 'checked' : ''} style="width:auto;"> Keep values already in the app (only fill empty cells)</label>
        <div class="actions-row">
          <button class="btn ghost small" id="cashImportCancel">Cancel</button>
          <button class="btn small" id="cashImportGo">Import</button>
        </div>
      </div>`;
    box.querySelectorAll('[data-month]').forEach(inp => inp.onchange = () => { p.sheets[inp.dataset.month].month = /^\d{4}-\d{2}$/.test(inp.value) ? inp.value : null; renderImportPreview(); });
    box.querySelectorAll('[data-newname]').forEach(cb => cb.onchange = () => { cb.checked ? p.createNames.add(cb.dataset.newname) : p.createNames.delete(cb.dataset.newname); });
    el('cashSkipExisting').onchange = e => { p.skipExisting = e.target.checked; };
    el('cashImportCancel').onclick = () => { S.importPlan = null; renderImport(); };
    el('cashImportGo').onclick = runImport;
  }

  async function runImport() {
    const p = S.importPlan;
    const sheets = p.sheets.filter(s => !s.skip && s.month && s.cells.length);
    const noMonth = p.sheets.filter(s => !s.skip && !s.month && s.cells.length);
    if (!sheets.length) { showToast('Nothing to import: pick the month of each tab first.', true); return; }
    if (noMonth.length && !(await showConfirm(`${noMonth.length} tab${noMonth.length === 1 ? ' has' : 's have'} no month and will be skipped: ${noMonth.map(s => s.sheet).join(', ')}. Continue?`, 'Continue'))) return;
    const months = [...new Set(sheets.map(s => s.month))];
    if (months.length !== sheets.length) { showToast('Two tabs are set to the same month. Fix the months first.', true); return; }
    const { data: locks } = await sb.from('cash_months').select('month').in('month', months).eq('locked', true);
    const lockedMonths = new Set((locks || []).map(l => l.month));
    const btn = el('cashImportGo'); btn.disabled = true; btn.textContent = 'Importing…';
    try {
      // 1. create ticked new cashiers
      const known = new Map(S.cashiers.map(c => [c.name.trim().toLowerCase(), c]));
      let sort = Math.max(0, ...S.cashiers.map(c => c.sort_order));
      for (const name of p.createNames) {
        if (known.has(name.trim().toLowerCase())) continue;
        const { data, error } = await sb.from('cashiers').insert({ name: name.trim(), sort_order: ++sort }).select(CASHIER_COLS).single();
        if (error) throw error;
        S.cashiers.push(data); known.set(name.trim().toLowerCase(), data);
      }
      // 2. values
      const rows = [];
      let skippedNames = 0, skippedLocked = 0, skippedDays = 0;
      sheets.forEach(s => {
        if (lockedMonths.has(s.month)) { skippedLocked += s.cells.length; return; }
        s.cells.forEach(c => {
          const cashier = known.get(c.name.trim().toLowerCase());
          if (!cashier) { skippedNames++; return; }
          if (c.day > daysIn(s.month)) { skippedDays++; return; }
          rows.push({ cashier_id: cashier.id, day: dayStr(s.month, c.day), currency: CURRENCY, amount: Math.round(c.lbp),
            source_amount: c.lbp, source_currency: 'LBP', source_rate: null });
        });
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('cash_differences').upsert(rows.slice(i, i + 500), { onConflict: 'cashier_id,day,currency', ignoreDuplicates: p.skipExisting });
        if (error) throw error;
      }
      logActivity('cash', 'import', null, `Imported ${rows.length} cash differences from ${p.file} (${months.length} month${months.length === 1 ? '' : 's'}, LBP)`,
        { file: p.file, months, values: rows.length, skippedLocked, skippedNames, skippedDays, created_cashiers: [...p.createNames] });
      S.importPlan = null;
      const notes = [skippedLocked && `${skippedLocked} in locked months`, skippedNames && `${skippedNames} for unticked names`, skippedDays && `${skippedDays} on days the month doesn't have`].filter(Boolean);
      await showConfirm(`Imported ${rows.length} values.${notes.length ? '\n\nSkipped: ' + notes.join(', ') + '.' : ''}`, 'OK');
      S.month = months.sort().slice(-1)[0];
      S.tab = 'grid';
      await loadMonth();
      render();
    } catch (err) {
      fail('The import stopped', err);
      await loadCashiers();
      btn.disabled = false; btn.textContent = 'Import';
    }
  }

  /* ---------------- reminder: yesterday still empty ---------------- */
  async function checkReminder() {
    if (beirutHour() < S.settings.reminder_hour) return;
    const yesterday = addDaysStr(todayStr(), -1);
    const flag = 'lv:cashReminder';
    try { if (localStorage.getItem(flag) === yesterday) return; } catch (e) { /* storage blocked */ }
    if (!S.cashiers.some(c => c.active)) return;
    const { count, error } = await sb.from('cash_differences').select('id', { count: 'exact', head: true }).eq('day', yesterday);
    if (error || count) return;
    pushNotification(`No cash differences entered yet for yesterday (${fmtDate(yesterday)}).`);
    try { localStorage.setItem(flag, yesterday); } catch (e) { /* ignore */ }
  }

  /* ---------------- public ---------------- */
  async function start() {
    if (S.started) return;
    S.started = true;
    shell();
    await Promise.all([loadCashiers(), loadSettings()]);
    await loadMonth();
    render();
    checkReminder();
    setInterval(checkReminder, 30 * 60 * 1000);
  }
  async function show() {
    if (!S.started) await start();
    if (S.tab === 'analysis') { await loadHistory(); render(); }
  }
  // Analysis needs 12 months of history: load it when that tab opens.
  panel.addEventListener('click', async e => {
    const b = e.target.closest('#cashTabs button');
    if (b && b.dataset.tab === 'analysis') { await loadHistory(); if (S.tab === 'analysis') render(); }
  });

  // Live updates (js/core/live.js): someone else changed differences, the month lock or the settings.
  async function refresh() {
    if (!S.started) return;
    await Promise.all([loadCashiers(), loadSettings()]);
    await loadMonth();
    if (S.tab === 'analysis') await loadHistory();
    render();
  }
  window.Cash = { start, show, refresh, _state: S };
})();
