/* ============================================================
   Public cashier page (PLAN §8.5). No login, no database access:
   everything goes through the cashier-view edge function, which
   checks the PIN and returns only this cashier's data.
   With "Remember me on this phone" (owner, 2026-09-30) the name and
   PIN are kept in this browser, so the page opens straight on the
   person's schedule, until they press Log out. Without it the PIN is
   kept in memory only, and forgotten after 2 minutes without activity.
   ============================================================ */
(function () {
  const FN_URL = 'https://sezjqcbkiydckhirycjb.supabase.co/functions/v1/cashier-view';
  const PUBLISHABLE_KEY = 'sb_publishable_LRI-MmDPYE_IjrHG-LZ7Xg_mQovg24F';
  const IDLE_MS = 2 * 60 * 1000;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Amounts in the app's cash currency (settings): LBP in whole pounds, USD with cents.
  let currency = 'LBP';
  const money = n => currency === 'USD'
    ? (n < 0 ? '-' : '') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(Number(n) || 0).toLocaleString('en-US') + ' LBP';
  const monthLabel = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const SHIFTS = { am: ['AM', '07:30 – 14:30'], pm: ['PM', '14:30 – 22:00'], full: ['Full day', '07:30 – 22:00'] };
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d; };
  let session = null, idleTimer = null;
  // Notifications on this phone (migration 023): the push-alerts function sends them, cashier-view registers the phone.
  const VAPID_PUBLIC_KEY = 'BMG7Z2phSxCqVWAVaXv0Al16YLNNwbBXMZYfrkFc7FmYkcM9FTxqIzhxTcDpnM7BO-_qDILf0m-7pys_XnAbd4o';
  const PUSH_KEY = 'lv:cashierPush';   // which cashier this phone gets notifications for
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushFor = () => { try { return localStorage.getItem(PUSH_KEY); } catch (e) { return null; } };
  const setPushFor = v => { try { v ? localStorage.setItem(PUSH_KEY, v) : localStorage.removeItem(PUSH_KEY); } catch (e) { /* ignore */ } };
  const b64uBytes = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), c => c.charCodeAt(0));
  const SAVED = 'lv:cashierLogin';
  const saved = () => { try { const v = JSON.parse(localStorage.getItem(SAVED)); return v && v.cashier_id && v.pin ? v : null; } catch (e) { return null; } };
  const setSaved = v => { try { v ? localStorage.setItem(SAVED, JSON.stringify(v)) : localStorage.removeItem(SAVED); } catch (e) { /* storage blocked */ } };   // { cashier_id, pin, name, data }

  async function call(body) {
    const res = await fetch(FN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    if (!res.ok) { const err = new Error(data.error || 'Something went wrong. Try again.'); Object.assign(err, data, { status: res.status }); throw err; }
    return data;
  }

  function forget() {
    session = null;
    clearTimeout(idleTimer);
    $('cpPin').value = '';
    $('cpView').hidden = true;
    $('cpLogin').hidden = false;
    $('cpPin').focus();
  }
  function touch() { clearTimeout(idleTimer); if (session && !saved()) idleTimer = setTimeout(forget, IDLE_MS); }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, touch, { passive: true }));

  // The person's shifts for this week and next (published weeks only).
  // "am:front|08:30-13:00": shift, station, and the exact times when someone arrives late / leaves early.
  const parseCode = code => {
    const [main, t] = String(code || '').split('|');
    const [shift, station] = main.split(':');
    const [start, end] = (t || '').split('-');
    return { shift: shift || '', station: station || '', times: start && end ? `${start} – ${end}` : '' };
  };
  function renderSchedule(weeks) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const cell = (code, date) => {
      const { shift, station, times } = parseCode(code);
      const iso = date.toLocaleDateString('en-CA'), day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const what = shift === 'off' ? '<b>Off</b>' : SHIFTS[shift] ? `<b>${SHIFTS[shift][0]}${station ? ' · ' + (station === 'front' ? 'Front' : 'Back') : ''}</b><small class="${times ? 'cp-custom' : ''}">${times || SHIFTS[shift][1]}</small>` : '<span class="muted-note">—</span>';
      return `<li class="cp-day cp-${shift || 'none'}${iso === today ? ' today' : ''}${iso < today ? ' past' : ''}"><span>${DAYS[(date.getDay() + 6) % 7]}<small>${day}</small></span><div>${what}</div></li>`;
    };
    $('cpSchedule').innerHTML = '<h3 class="cp-sec">My schedule</h3>' + (weeks && weeks.length
      ? weeks.map((w, i) => `<div class="card cp-week"><p class="cp-week-t">${w.week_start <= today ? 'This week' : 'Next week'} · from ${addDays(w.week_start, 0).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
          <ul>${DAYS.map((_, d) => cell(w.days[d], addDays(w.week_start, d))).join('')}</ul></div>`).join('')
      : '<div class="card"><p class="empty-note" style="margin:0;">No schedule published yet.</p></div>');
  }

  // Supervisors: the whole team's published week as a calendar (owner, 2026-10-01):
  // week tabs, a strip of 7 days, and who works that day — AM, PM, Full day, Off.
  const team = { weeks: [], w: 0, d: null };
  function renderTeam(weeks) {
    const box = $('cpTeam');
    if (weeks !== undefined) {
      team.weeks = weeks || [];
      if (team.w >= team.weeks.length) team.w = 0;
    }
    if (!team.weeks.length) { box.innerHTML = ''; return; }
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const w = team.weeks[team.w];
    const dates = DAYS.map((_, i) => addDays(w.week_start, i));
    const isoOf = d => d.toLocaleDateString('en-CA');
    if (team.d === null || team.d > 6) { const t = dates.findIndex(d => isoOf(d) === today); team.d = t >= 0 ? t : 0; }
    const day = team.d;
    const groups = { am: [], pm: [], full: [], off: [] };
    w.people.forEach(p => {
      const x = parseCode(p.days[day]);
      if (SHIFTS[x.shift]) groups[x.shift].push({ ...p, ...x });
      else if (x.shift === 'off') groups.off.push(p);
    });
    const sortSup = list => list.sort((x, y) => (y.position === 'supervisor') - (x.position === 'supervisor'));
    const person = p => `<li><span class="cp-cal-name">${esc(p.name)}${p.position === 'supervisor' ? '<em>Supervisor</em>' : ''}</span>
        ${p.times ? `<span class="cp-custom">${p.times}</span>` : ''}
        ${p.station ? `<span class="cp-st cp-st-${p.station}">${p.station === 'front' ? 'Front' : 'Back'}</span>` : ''}</li>`;
    const section = (key, title, time) => groups[key].length ? `<div class="cp-cal-sec cp-cal-${key}">
        <div class="cp-cal-head"><b>${title}</b><span>${time}</span><i>${groups[key].length}</i></div>
        <ul>${sortSup(groups[key]).map(person).join('')}</ul></div>` : '';
    const dLabel = dates[day].toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    box.innerHTML = `<h3 class="cp-sec">Full schedule</h3>
      <div class="card cp-cal">
        ${team.weeks.length > 1 ? `<div class="cp-cal-weeks">${team.weeks.map((x, i) => `<button type="button" data-tw="${i}" class="${i === team.w ? 'on' : ''}">${x.week_start <= today ? 'This week' : 'Next week'}</button>`).join('')}</div>` : ''}
        <div class="cp-cal-strip">${dates.map((d, i) => `<button type="button" data-td="${i}" class="${i === day ? 'on' : ''}${isoOf(d) === today ? ' today' : ''}"><span>${DAYS[i]}</span><b>${d.getDate()}</b></button>`).join('')}</div>
        <p class="cp-cal-date">${dLabel}</p>
        ${section('am', 'AM', '07:30 – 14:30')}${section('full', 'Full day', '07:30 – 22:00')}${section('pm', 'PM', '14:30 – 22:00')}
        ${groups.off.length ? `<p class="cp-cal-off"><b>Off:</b> ${groups.off.map(p => esc(p.name)).join(', ')}</p>` : ''}
        ${!groups.am.length && !groups.pm.length && !groups.full.length ? '<p class="empty-note" style="margin:6px 0;">Nobody is scheduled this day.</p>' : ''}
      </div>`;
  }
  // ---- Supervisors: the shared draft (cashier-view draft_*; migration 024). All supervisors edit the
  // same unpublished week, one cell at a time; "Send to HR", and HR publishes it in the app.
  const draft = { on: false, weeks: [], week: null, staff: [], canCopy: false, w: null, d: 0, busy: false };
  const WEEK_NAMES = ['This week', 'Next week', 'In 2 weeks', 'In 3 weeks'];
  const STATUS = { none: 'Not started', draft: 'Draft', sent: 'Sent to HR', published: 'Published' };
  async function loadDraft(week) {
    if (!session) return;
    try {
      const ask = w => call({ action: 'draft_get', cashier_id: session.cashier_id, pin: session.pin, week_start: w });
      let r = await ask(week || draft.w || undefined);
      if (!week && !draft.w) {     // first time: open the first week that is not published yet
        const first = r.weeks.find(x => x.status !== 'published') || r.weeks[0];
        draft.w = first.week_start;
        if (first.week_start !== r.weeks[0].week_start) r = await ask(draft.w);
      }
      draft.on = true; draft.weeks = r.weeks; draft.week = r.week; draft.staff = r.staff; draft.canCopy = r.can_copy;
      renderDraft();
    } catch (err) { draft.on = false; $('cpDraft').innerHTML = ''; }
  }
  // Same rules as the HR page: a shift keeps the station (or takes the usual one); Front / Back keep the shift and times.
  function applyTool(p, cur, tool) {
    const x = parseCode(cur), main = String(cur || '').split('|'), times = main[1] ? '|' + main[1] : '';
    if (tool === 'front' || tool === 'back') return SHIFTS[x.shift] ? `${x.shift}:${tool}${times}` : cur;
    if (!SHIFTS[tool]) return tool;
    if (x.shift === tool) return cur;
    const st = x.station || p.default_station || '';
    return tool + (st ? ':' + st : '');
  }
  function renderDraft() {
    const box = $('cpDraft');
    if (!draft.on) { box.innerHTML = ''; return; }
    const info = draft.weeks.find(x => x.week_start === draft.w) || draft.weeks[0];
    const tabs = `<div class="cp-dr-weeks">${draft.weeks.map((x, i) => `<button type="button" data-dw="${x.week_start}" class="${x.week_start === draft.w ? 'on' : ''}"><b>${WEEK_NAMES[i]}</b><span class="cp-dr-st cp-dr-${x.status}">${STATUS[x.status]}</span></button>`).join('')}</div>`;
    let body = '';
    if (info.status === 'published') {
      body = '<p class="muted-note cp-dr-note">HR has published this week — staff can see it. To change it, ask HR to unpublish it.</p>';
    } else if (!draft.week) {
      body = `<p class="muted-note cp-dr-note">Nobody has started this week yet.</p>
        <div class="cp-dr-start">${draft.canCopy ? '<button type="button" class="btn small" data-dstart="copy">Start — copy the week before</button>' : ''}
        <button type="button" class="btn ${draft.canCopy ? 'ghost' : ''} small" data-dstart="empty">Start empty</button></div>`;
    } else {
      const wk = draft.week, a = wk.assignments || {};
      const dates = DAYS.map((_, i) => addDays(draft.w, i));
      const day = draft.d;
      const cnt = { am: 0, pm: 0, front: 0, back: 0 };
      draft.staff.forEach(p => { const x = parseCode((a[p.id] || [])[day]); if (!SHIFTS[x.shift]) return; if (x.shift !== 'pm') cnt.am++; if (x.shift !== 'am') cnt.pm++; const st = x.station || p.default_station; if (st === 'front') cnt.front++; else if (st === 'back') cnt.back++; });
      const row = p => {
        const code = (a[p.id] || [])[day] || '', x = parseCode(code), working = !!SHIFTS[x.shift];
        const seg = [['', '—'], ['am', 'AM'], ['pm', 'PM'], ['full', 'Full'], ['off', 'Off']].map(([v, l]) => `<button type="button" data-dset="${v}" class="${x.shift === v ? 'on' : ''} cp-dr-${v || 'none'}">${l}</button>`).join('');
        const st = [['front', 'Front'], ['back', 'Back']].map(([v, l]) => `<button type="button" data-dset="${v}" class="${working && x.station === v ? 'on' : ''}" ${working ? '' : 'disabled'}>${l}</button>`).join('');
        return `<li data-pid="${p.id}"><div class="cp-dr-who"><b>${esc(p.name)}</b>${p.position === 'supervisor' ? '<em>Supervisor</em>' : ''}${x.times ? `<span class="cp-custom">${x.times}</span>` : ''}</div>
          <div class="cp-dr-seg">${seg}</div><div class="cp-dr-seg cp-dr-stn">${st}</div></li>`;
      };
      const sups = draft.staff.filter(p => p.position === 'supervisor'), cash = draft.staff.filter(p => p.position !== 'supervisor');
      body = `<p class="muted-note cp-dr-note">${info.status === 'sent' ? `Sent to HR by ${esc(info.submitted_by || '')} — you can still change it until HR publishes it.` : 'Draft — staff cannot see it yet.'}${wk.last_editor ? ` Last change by ${esc(wk.last_editor)}.` : ''}</p>
        <div class="cp-cal-strip">${dates.map((d, i) => `<button type="button" data-dd="${i}" class="${i === day ? 'on' : ''}"><span>${DAYS[i]}</span><b>${d.getDate()}</b></button>`).join('')}</div>
        <p class="cp-dr-count">${dates[day].toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · <b>AM ${cnt.am} · PM ${cnt.pm}</b> · Front ${cnt.front} · Back ${cnt.back}</p>
        ${sups.length ? `<p class="cp-dr-grp">Supervisors</p><ul class="cp-dr-list">${sups.map(row).join('')}</ul>` : ''}
        ${cash.length ? `<p class="cp-dr-grp">Cashiers</p><ul class="cp-dr-list">${cash.map(row).join('')}</ul>` : ''}
        <div class="cp-dr-send"><button type="button" class="btn" id="cpDraftSend">${info.status === 'sent' ? 'Send to HR again' : 'Send to HR'}</button>
          <span class="muted-note">HR reviews it and publishes it to everyone.</span></div>`;
    }
    box.innerHTML = `<h3 class="cp-sec">Draft schedule <span class="muted-note">(supervisors)</span></h3><div class="card cp-dr">${tabs}${body}<p class="login-err" id="cpDraftErr"></p></div>`;
  }
  $('cpDraft').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t || draft.busy) return;
    const err = m => { const p = $('cpDraftErr'); if (p) p.textContent = m || ''; };
    if (t.dataset.dw) { draft.w = t.dataset.dw; draft.d = 0; return loadDraft(draft.w); }
    if (t.dataset.dd) { draft.d = Number(t.dataset.dd); return renderDraft(); }
    if (t.dataset.dstart) {
      draft.busy = true;
      try { await call({ action: 'draft_create', cashier_id: session.cashier_id, pin: session.pin, week_start: draft.w, copy: t.dataset.dstart === 'copy' }); }
      catch (x) { err(x.message); } finally { draft.busy = false; }
      return loadDraft(draft.w);
    }
    if (t.id === 'cpDraftSend') {
      if (!confirm('Send this week to HR? They review it and publish it to everyone.')) return;
      draft.busy = true;
      try { await call({ action: 'draft_submit', cashier_id: session.cashier_id, pin: session.pin, week_start: draft.w }); }
      catch (x) { err(x.message); } finally { draft.busy = false; }
      return loadDraft(draft.w);
    }
    if (t.dataset.dset !== undefined) {
      const li = t.closest('li[data-pid]'), p = draft.staff.find(x => x.id === li.dataset.pid);
      const a = draft.week.assignments, days = (a[p.id] = a[p.id] || ['', '', '', '', '', '', '']);
      const before = days[draft.d] || '', code = applyTool(p, before, t.dataset.dset);
      if (code === before) return;
      days[draft.d] = code; renderDraft();          // right away; the server confirms
      try {
        const r = await call({ action: 'draft_set', cashier_id: session.cashier_id, pin: session.pin, week_start: draft.w, staff_id: p.id, day: draft.d, code });
        if (Array.isArray(r.days)) a[p.id] = r.days;
      } catch (x) { days[draft.d] = before; renderDraft(); err(x.message); }
    }
  });

  $('cpTeam').addEventListener('click', e => {
    const b = e.target.closest('[data-tw], [data-td]'); if (!b) return;
    if (b.dataset.tw !== undefined) { team.w = Number(b.dataset.tw); team.d = null; }
    else team.d = Number(b.dataset.td);
    renderTeam();
  });

  function renderNotify() {
    const box = $('cpNotify');
    if (!session) { box.hidden = true; return; }
    box.hidden = false;
    if (!pushSupported()) {
      box.innerHTML = isIOS && !isStandalone()
        ? '<p class="muted-note">To get notifications on iPhone, install the app first (steps at the bottom), then open it from the home screen.</p>'
        : '';
      box.hidden = !box.innerHTML;
      return;
    }
    const on = pushFor() === session.cashier_id && Notification.permission === 'granted';
    box.innerHTML = Notification.permission === 'denied'
      ? '<p class="muted-note">Notifications are blocked for this page. Allow them in the phone settings to be told about your schedule and differences.</p>'
      : on
        ? `<span class="cp-notify-on">🔔 Notifications on</span><span class="muted-note">You are told when your schedule is out and when a difference is entered.</span><button type="button" class="link-btn" id="cpPushOff">Turn off</button>`
        : `<button type="button" class="btn secondary small" id="cpPushOn">🔔 Turn on notifications</button><span class="muted-note">Get told when your schedule is out and when a difference is entered.</span>`;
    $('cpPushOn')?.addEventListener('click', pushOn);
    $('cpPushOff')?.addEventListener('click', async () => { await pushOff(); renderNotify(); });
  }
  async function pushOn() {
    try {
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted') return renderNotify();
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(VAPID_PUBLIC_KEY) });
      const j = sub.toJSON();
      await call({ action: 'subscribe', cashier_id: session.cashier_id, pin: session.pin, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
      setPushFor(session.cashier_id);
    } catch (err) {
      $('cpNotify').insertAdjacentHTML('beforeend', `<p class="login-err">Could not turn notifications on: ${esc(err.message || err)}</p>`);
      return;
    }
    renderNotify();
  }
  // Turned off, or Log out: this phone stops getting this person's notifications.
  async function pushOff() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (sub) { await call({ action: 'unsubscribe', endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    } catch (e) { /* ignore */ }
    setPushFor(null);
  }

  function render() {
    const d = session.data, lv = d.levels;
    renderNotify();
    renderSchedule(d.schedule);
    renderTeam(d.team);
    if (d.cashier.position === 'supervisor') loadDraft(); else { draft.on = false; $('cpDraft').innerHTML = ''; }
    currency = lv.currency || 'LBP';
    const level = a => Math.abs(a) >= lv.danger ? 'lv-danger' : Math.abs(a) >= lv.warning ? 'lv-warn' : '';
    $('cpWho').textContent = d.cashier.name;
    $('cpMonthLabel').textContent = monthLabel(d.month);
    $('cpMonths').innerHTML = d.months.map((m, i) => `<button type="button" data-m="${m}" class="${m === d.month ? 'active' : ''}">${i === 0 ? 'This month' : 'Last month'}</button>`).join('');
    const short = d.entries.filter(e => e.amount < 0).length;
    $('cpTotal').innerHTML = `<span>Total for ${esc(monthLabel(d.month))}</span><b class="${d.total < 0 ? 'neg' : ''}">${money(d.total)}</b>
      <small>${d.entries.length} day${d.entries.length === 1 ? '' : 's'} entered · ${short} short</small>`;
    // Newest day first, so the latest difference is on top (owner, 2026-09-30).
    $('cpList').innerHTML = d.entries.length ? [...d.entries].sort((a, b) => b.day.localeCompare(a.day)).map(e => `
      <tr class="${level(e.amount)}">
        <td>${esc(new Date(e.day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))}</td>
        <td class="num">${money(e.amount)}</td>
      </tr>${e.note ? `<tr class="cp-note"><td colspan="2">${esc(e.note)}</td></tr>` : ''}`).join('')
      : '<tr><td colspan="2" class="empty-note">Nothing entered for this month yet.</td></tr>';
    $('cpLogin').hidden = true;
    $('cpView').hidden = false;
    touch();
  }

  async function load(month) {
    const data = await call({ action: 'view', cashier_id: session.cashier_id, pin: session.pin, month });
    session.data = data;
    render();
  }

  $('cpLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const cashier_id = $('cpName').value, pin = $('cpPin').value.trim();
    $('cpErr').textContent = '';
    if (!cashier_id) { $('cpErr').textContent = 'Choose your name.'; return; }
    if (!/^\d{4}$/.test(pin)) { $('cpErr').textContent = 'Type your 4-digit PIN.'; return; }
    $('cpGo').disabled = true;
    session = { cashier_id, pin };
    try {
      await load();
      setSaved($('cpRemember').checked ? { cashier_id, pin } : null);
      touch();
    } catch (err) {
      session = null;
      $('cpPin').value = '';
      $('cpErr').textContent = err.status === 401 && err.attempts_left != null
        ? `Wrong PIN. ${err.attempts_left} tr${err.attempts_left === 1 ? 'y' : 'ies'} left before a 15-minute lock.`
        : err.status === 423 && err.locked_until
          ? `Too many wrong PINs. Try again after ${new Date(err.locked_until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
          : err.message;
      $('cpPin').focus();
    } finally {
      $('cpGo').disabled = false;
    }
  });
  $('cpMonths').addEventListener('click', async e => {
    const b = e.target.closest('button[data-m]');
    if (!b || !session || b.dataset.m === session.data.month) return;
    try { await load(b.dataset.m); } catch (err) { forget(); $('cpErr').textContent = err.message; }
  });
  $('cpDone').addEventListener('click', async () => { if (pushFor()) await pushOff(); setSaved(null); forget(); });
  // Remembered: refresh when the page comes back to the screen (new week published, new entries).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && session.data && saved()) load(session.data.month).catch(() => {});
  });

  // Opens straight on the remembered person; a changed PIN or removed name goes back to the login.
  async function autoLogin(cashiers) {
    const s = saved();
    if (!s) return false;
    if (!cashiers.some(c => c.id === s.cashier_id)) { setSaved(null); return false; }
    session = { cashier_id: s.cashier_id, pin: s.pin };
    try { await load(); return true; }
    catch (err) {
      session = null;
      if ([401, 403, 404, 423].includes(err.status)) { setSaved(null); $('cpErr').textContent = 'Please log in again.'; }
      else $('cpErr').textContent = err.message;
      return false;
    }
  }

  (async function boot() {
    try {
      const { cashiers } = await call({ action: 'cashiers' });
      $('cpName').innerHTML = '<option value="">Choose…</option>' + cashiers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      $('cpBoot').hidden = true;
      if (await autoLogin(cashiers)) return;
      $('cpLogin').hidden = false;
      try { const last = localStorage.getItem('lv:cashierName'); if (last && cashiers.some(c => c.id === last)) $('cpName').value = last; } catch (e) { /* storage blocked */ }
    } catch (err) {
      $('cpBoot').textContent = 'This page is not available right now. Try again later.';
    }
  })();
  // Install as an app (owner, 2026-10-01): its own manifest (LV Cashier, opens on this page) and the
  // app's service worker (sw.js: installable, opens without a connection).
  (function install() {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
    if (standalone) return;
    let evt = null;
    const box = $('cpInstall');
    if (isIOS) { box.hidden = false; $('cpInstallBtn').hidden = true; $('cpInstallIos').hidden = false; }
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); evt = e; box.hidden = false; });
    window.addEventListener('appinstalled', () => { box.hidden = true; });
    $('cpInstallBtn').addEventListener('click', async () => {
      if (!evt) return;
      evt.prompt();
      const r = await evt.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') box.hidden = true;
      evt = null;
    });
  })();

  // Remember only which name was picked on this device (never the PIN).
  $('cpName').addEventListener('change', () => { try { localStorage.setItem('lv:cashierName', $('cpName').value); } catch (e) { /* ignore */ } });
})();
