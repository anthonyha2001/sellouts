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
  function renderSchedule(weeks) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Beirut' });
    const cell = (code, date) => {
      const [shift, station] = String(code || '').split(':');
      const iso = date.toLocaleDateString('en-CA'), day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const what = shift === 'off' ? '<b>Off</b>' : SHIFTS[shift] ? `<b>${SHIFTS[shift][0]}${station ? ' · ' + (station === 'front' ? 'Front' : 'Back') : ''}</b><small>${SHIFTS[shift][1]}</small>` : '<span class="muted-note">—</span>';
      return `<li class="cp-day cp-${shift || 'none'}${iso === today ? ' today' : ''}${iso < today ? ' past' : ''}"><span>${DAYS[(date.getDay() + 6) % 7]}<small>${day}</small></span><div>${what}</div></li>`;
    };
    $('cpSchedule').innerHTML = '<h3 class="cp-sec">My schedule</h3>' + (weeks && weeks.length
      ? weeks.map((w, i) => `<div class="card cp-week"><p class="cp-week-t">${w.week_start <= today ? 'This week' : 'Next week'} · from ${addDays(w.week_start, 0).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</p>
          <ul>${DAYS.map((_, d) => cell(w.days[d], addDays(w.week_start, d))).join('')}</ul></div>`).join('')
      : '<div class="card"><p class="empty-note" style="margin:0;">No schedule published yet.</p></div>');
  }

  function render() {
    const d = session.data, lv = d.levels;
    renderSchedule(d.schedule);
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
  $('cpDone').addEventListener('click', () => { setSaved(null); forget(); });
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
