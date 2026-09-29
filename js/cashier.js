/* ============================================================
   Public cashier page (PLAN §8.5). No login, no database access:
   everything goes through the cashier-view edge function, which
   checks the PIN and returns only this cashier's data.
   The PIN is kept in memory only while the page shows the data,
   and forgotten after 2 minutes without activity.
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
  let session = null, idleTimer = null;   // { cashier_id, pin, name, data }

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
  function touch() { clearTimeout(idleTimer); if (session) idleTimer = setTimeout(forget, IDLE_MS); }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, touch, { passive: true }));

  function render() {
    const d = session.data, lv = d.levels;
    currency = lv.currency || 'LBP';
    const level = a => Math.abs(a) >= lv.danger ? 'lv-danger' : Math.abs(a) >= lv.warning ? 'lv-warn' : '';
    $('cpWho').textContent = d.cashier.name;
    $('cpMonthLabel').textContent = monthLabel(d.month);
    $('cpMonths').innerHTML = d.months.map((m, i) => `<button type="button" data-m="${m}" class="${m === d.month ? 'active' : ''}">${i === 0 ? 'This month' : 'Last month'}</button>`).join('');
    const short = d.entries.filter(e => e.amount < 0).length;
    $('cpTotal').innerHTML = `<span>Total for ${esc(monthLabel(d.month))}</span><b class="${d.total < 0 ? 'neg' : ''}">${money(d.total)}</b>
      <small>${d.entries.length} day${d.entries.length === 1 ? '' : 's'} entered · ${short} short</small>`;
    $('cpList').innerHTML = d.entries.length ? d.entries.map(e => `
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
  $('cpDone').addEventListener('click', forget);

  (async function boot() {
    try {
      const { cashiers } = await call({ action: 'cashiers' });
      $('cpName').innerHTML = '<option value="">Choose…</option>' + cashiers.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      $('cpBoot').hidden = true;
      $('cpLogin').hidden = false;
      try { const last = localStorage.getItem('lv:cashierName'); if (last && cashiers.some(c => c.id === last)) $('cpName').value = last; } catch (e) { /* storage blocked */ }
    } catch (err) {
      $('cpBoot').textContent = 'This page is not available right now. Try again later.';
    }
  })();
  // Remember only which name was picked on this device (never the PIN).
  $('cpName').addEventListener('change', () => { try { localStorage.setItem('lv:cashierName', $('cpName').value); } catch (e) { /* ignore */ } });
})();
