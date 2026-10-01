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
