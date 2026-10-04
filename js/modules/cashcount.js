/* ============================================================
   Cash count (owner, 2026-10-04; migration 055): the paper count
   sheet of a cashier's drawer, in the app.
   One count = a POS (1-8), a cashier, a shift, a date. The sheet is
   split in two:
     1. Count (cashier supervisors / accountant — cashcount.count):
        LBP bills, USD bills, card lines in LBP and USD; the cashier
        signs with their cashier-page PIN.
     2. System & reconciliation (accountant — cashcount.reconcile):
        the system's figures, each card line found / not found; the
        differences, line by line ("Visa Bankmed: short 50,000 LBP"),
        the cash difference, the allowed margin (1,000 LBP per
        1,000,000 of cash, shown only) and the total.
   Differences grid (accountant / HR — cashcount.view): every count of
   a month, with an Excel export.
   USD -> LBP: one rate (cash_settings.usd_rate), kept on each count.
   Public API: window.CashCount = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-cashcount');
  const LBP_BILLS = [100000, 50000, 20000, 10000, 5000, 1000];
  const USD_BILLS = [100, 50, 20, 10, 5, 1];
  const CARDS = [['visa_bankmed', 'Visa Bankmed'], ['master_bankmed', 'Master Bankmed'], ['areeba', 'Areeba'], ['ccm_master', 'CCM Master'],
    ['ccm_visa', 'CCM Visa'], ['on_account', 'On account'], ['amex', 'Amex'], ['voucher', 'Special voucher'], ['points', 'Points']];
  const CARD_LABEL = Object.fromEntries(CARDS);
  const SHIFTS = { am: 'AM', pm: 'PM', full: 'Full day' };
  const S = { started: false, tab: 'day', date: todayStr(), counts: [], openId: null, cashiers: [], rate: null, month: todayStr().slice(0, 7), monthCounts: [], adding: false };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const canCount = () => can('cashcount.count'), canRec = () => can('cashcount.reconcile'), canGrid = () => can('cashcount.view', 'cashcount.reconcile');
  const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
  const lbp = v => Math.round(n(v)).toLocaleString('en-US');
  const usd = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const fail = (what, error) => { console.error(error); showToast(`${what} — ${friendlyError(error)}`, true); };
  // "short 50,000" / "over 20,000" / "matches"
  const diffWord = (d, fmt, cur) => Math.abs(d) < 0.005 ? '<span class="ccx-ok">matches</span>' : d < 0 ? `<span class="ccx-short">short ${fmt(-d)} ${cur}</span>` : `<span class="ccx-over">over ${fmt(d)} ${cur}</span>`;

  /* ---------------- the numbers ---------------- */
  function calc(c) {
    const rate = n(c.usd_rate) || n(S.rate);
    const billsLbp = LBP_BILLS.reduce((t, b) => t + b * n(c.lbp?.[b]), 0);
    const billsUsd = USD_BILLS.reduce((t, b) => t + b * n(c.usd?.[b]), 0);
    // Expenses paid out of the drawer (migration 056): the system does not know them, so they count as cash.
    const exp = { lbp: n(c.expenses?.lbp), usd: n(c.expenses?.usd) };
    const cashLbp = billsLbp + exp.lbp, cashUsd = billsUsd + exp.usd;
    const sys = c.system || {}, nf = c.not_found || {};
    const hasSystem = sys.cash_lbp !== undefined || sys.cash_usd !== undefined || Object.keys(sys.cards || {}).length > 0;
    const cards = CARDS.map(([k, label]) => {
      const counted = { lbp: n(c.cards?.[k]?.lbp), usd: n(c.cards?.[k]?.usd) };
      const system = { lbp: n(sys.cards?.[k]?.lbp), usd: n(sys.cards?.[k]?.usd) };
      const found = !nf[k];
      // A card not found: its slip does not count — the cashier owes it (charged to their cash).
      const used = found ? counted : { lbp: 0, usd: 0 };
      return { k, label, counted, system, found, diff: { lbp: used.lbp - system.lbp, usd: used.usd - system.usd } };
    });
    const cashDiff = { lbp: cashLbp - n(sys.cash_lbp), usd: cashUsd - n(sys.cash_usd) };
    const notFound = cards.filter(x => !x.found && (x.counted.lbp || x.counted.usd));
    const notFoundLbp = notFound.reduce((t, x) => t + x.counted.lbp + x.counted.usd * rate, 0);
    const cardsDiff = cards.reduce((t, x) => t + x.diff.lbp + x.diff.usd * rate, 0);
    const cashDiffLbpEq = cashDiff.lbp + cashDiff.usd * rate;
    const cashTotalLbpEq = cashLbp + cashUsd * rate;
    return {
      rate, billsLbp, billsUsd, exp, cashLbp, cashUsd, cards, cashDiff, cashDiffLbpEq, notFound, notFoundLbp, cardsDiff, hasSystem,
      cardsCounted: cards.reduce((t, x) => ({ lbp: t.lbp + x.counted.lbp, usd: t.usd + x.counted.usd }), { lbp: 0, usd: 0 }),
      total: cashDiffLbpEq + cardsDiff,
      margin: Math.round(cashTotalLbpEq / 1e6 * 1000),     // 1,000 LBP allowed per 1,000,000 of cash (shown only)
    };
  }

  /* ---------------- data ---------------- */
  async function loadBase() {
    const [{ data: cs }, { data: rate }] = await Promise.all([
      sb.from('cashiers').select('id, name, active, position, sort_order').order('sort_order').order('name'),
      sb.rpc('get_usd_rate'),
    ]);
    S.cashiers = cs || [];
    S.rate = rate || null;
  }
  async function loadDay() {
    const { data, error } = await sb.from('cash_counts').select('*').eq('count_date', S.date).order('pos').order('shift');
    if (error) { S.missing = true; S.counts = []; return; }
    S.missing = false; S.counts = data || [];
  }
  async function loadMonth() {
    const [y, m] = S.month.split('-').map(Number), last = new Date(y, m, 0).toLocaleDateString('en-CA');
    const { data, error } = await sb.from('cash_counts').select('*').gte('count_date', S.month + '-01').lte('count_date', last).order('count_date').order('pos');
    if (error) return fail('Could not load the counts', error);
    S.monthCounts = data || [];
  }
  const timers = new Map();
  function saveSoon(c, patch) {
    Object.assign(c, patch);
    clearTimeout(timers.get(c.id));
    timers.set(c.id, setTimeout(async () => {
      const { error } = await sb.from('cash_counts').update(patch.__all ? { lbp: c.lbp, usd: c.usd, cards: c.cards } : patch).eq('id', c.id);
      if (error) fail('Not saved', error);
    }, 500));
  }

  /* ---------------- page ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="cc-top">
        <div class="filter-row" id="ccTabs" style="margin:0;"><button type="button" data-cctab="day">Counts</button>${canGrid() ? '<button type="button" data-cctab="grid">Differences grid</button>' : ''}</div>
        <span style="flex:1"></span>
        <span class="cc-rate" id="ccRate"></span>
      </div>
      <div id="ccBody"></div>`;
    el('ccTabs').onclick = async e => { const b = e.target.closest('[data-cctab]'); if (!b) return; S.tab = b.dataset.cctab; await refresh(); };
  }
  function renderRate() {
    el('ccRate').innerHTML = `USD rate <b>${S.rate ? lbp(S.rate) : 'not set'}</b>${can('cashcount.reconcile', 'cash.cashiers') ? ' <button type="button" class="link-btn" id="ccRateBtn">Change</button>' : ''}`;
    el('ccRateBtn')?.addEventListener('click', async () => {
      const v = await showPrompt('USD rate (LBP for 1 USD):', { defaultValue: S.rate ? String(S.rate) : '89500', confirmLabel: 'Save' });
      if (v === null) return;
      const r = n(v); if (!r) return showToast('Type the rate, e.g. 89500.', true);
      const { error } = await sb.rpc('set_usd_rate', { p_rate: r });
      if (error) return fail('Rate not saved', error);
      logActivity('cashcount', 'rate', null, `USD rate set to ${lbp(r)} LBP`);
      S.rate = r; renderRate(); render();
    });
  }
  function render() {
    panel.querySelectorAll('#ccTabs [data-cctab]').forEach(b => b.classList.toggle('active', b.dataset.cctab === S.tab));
    renderRate();
    if (S.missing) { el('ccBody').innerHTML = '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> The cash count works once migration 055 is applied.</p></div>'; return; }
    if (S.tab === 'grid') return renderGrid();
    renderDay();
  }

  /* ---------------- one day: the counts, and the open sheet ---------------- */
  function renderDay() {
    const open = S.counts.find(c => c.id === S.openId) || null;
    const cashierOpts = S.cashiers.filter(c => c.active).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    el('ccBody').innerHTML = `
      <div class="card cc-daybar">
        <button type="button" class="icon-btn" data-ccd="-1" aria-label="Previous day"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <input type="date" id="ccDate" value="${S.date}" aria-label="Date">
        <button type="button" class="icon-btn" data-ccd="1" aria-label="Next day"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <button type="button" class="btn ghost small" data-ccd="0">Today</button>
        <span style="flex:1"></span>
        ${canCount() ? '<button type="button" class="btn small" id="ccNew">+ New count</button>' : ''}
      </div>
      ${S.adding ? `<div class="card cc-new"><form id="ccNewForm" class="cc-new-form">
          <label>POS<select id="ccPos">${[1, 2, 3, 4, 5, 6, 7, 8].map(p => `<option value="${p}">POS ${p}</option>`).join('')}</select></label>
          <label>Shift<select id="ccShift">${Object.entries(SHIFTS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
          <label>Cashier<select id="ccCashier" required><option value="">Choose…</option>${cashierOpts}</select></label>
          <div class="cc-new-actions"><button type="button" class="btn ghost small" id="ccNewCancel">Cancel</button><button type="submit" class="btn small">Start the count</button></div>
        </form></div>` : ''}
      <div class="card cc-list">${S.counts.length ? `<table class="items cc-table">
          <thead><tr><th>POS</th><th>Shift</th><th>Cashier</th><th>Signed</th><th>Reconciled</th><th class="num">Total difference</th></tr></thead>
          <tbody>${S.counts.map(c => { const r = calc(c); return `<tr data-cc="${esc(c.id)}" class="${c.id === S.openId ? 'on' : ''}">
            <td><b>POS ${c.pos}</b></td><td>${SHIFTS[c.shift]}</td><td>${esc(c.cashier_name)}</td>
            <td>${c.signed_at ? '<span class="badge active">Signed</span>' : '<span class="badge warn">Not signed</span>'}</td>
            <td>${c.reconciled_at ? '<span class="badge active">Reconciled</span>' : r.hasSystem ? '<span class="badge inactive">In progress</span>' : '<span class="muted-note">—</span>'}</td>
            <td class="num">${r.hasSystem ? diffWord(r.total, lbp, 'LBP') : '<span class="muted-note">no system figures yet</span>'}</td></tr>`; }).join('')}</tbody></table>`
        : `<p class="empty-note" style="margin:0;">No count on ${esc(fmtDate(S.date))} yet.${canCount() ? ' Tap "+ New count".' : ''}</p>`}</div>
      ${open ? sheetHtml(open) : ''}`;
    el('ccBody').querySelectorAll('[data-ccd]').forEach(b => b.onclick = async () => { const d = Number(b.dataset.ccd); S.date = d ? addDaysStr(S.date, d) : todayStr(); S.openId = null; await loadDay(); render(); });
    el('ccDate').onchange = async e => { if (!e.target.value) return; S.date = e.target.value; S.openId = null; await loadDay(); render(); };
    el('ccNew')?.addEventListener('click', () => { S.adding = true; renderDay(); });
    el('ccNewCancel')?.addEventListener('click', () => { S.adding = false; renderDay(); });
    el('ccNewForm')?.addEventListener('submit', createCount);
    el('ccBody').querySelectorAll('tr[data-cc]').forEach(tr => tr.onclick = () => { S.openId = S.openId === tr.dataset.cc ? null : tr.dataset.cc; renderDay(); el('ccSheet')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    if (open) wireSheet(open);
  }
  async function createCount(e) {
    e.preventDefault();
    const cashier = S.cashiers.find(c => c.id === el('ccCashier').value);
    if (!cashier) return showToast('Choose the cashier.', true);
    const row = { count_date: S.date, pos: Number(el('ccPos').value), shift: el('ccShift').value, cashier_id: cashier.id, cashier_name: cashier.name, usd_rate: S.rate };
    const { data, error } = await sb.from('cash_counts').insert(row).select().single();
    if (error) return showToast(/duplicate|unique/i.test(error.message) ? `POS ${row.pos} already has a ${SHIFTS[row.shift]} count on this day.` : 'Not saved — ' + friendlyError(error), true);
    logActivity('cashcount', 'start', { type: 'cash_count', id: data.id }, `Started the cash count of ${cashier.name} — POS ${row.pos}, ${SHIFTS[row.shift]}, ${fmtDate(S.date)}`);
    S.adding = false; S.openId = data.id;
    await loadDay(); renderDay();
  }

  // The sheet: 1. the count (left), 2. the system and the differences (right).
  function sheetHtml(c) {
    const r = calc(c), adm = isAdmin();
    const lock1 = !canCount() || (!!c.signed_at && !adm);
    const lock2 = !canRec() || (!!c.reconciled_at && !adm);
    const sys = c.system || {};
    const billRows = (bills, key, fmt) => bills.map(b => `<tr><td class="num">${fmt(b)}</td>
      <td><input type="text" inputmode="numeric" class="cc-in" data-bill="${key}" data-b="${b}" value="${n(c[key]?.[b]) || ''}" ${lock1 ? 'disabled' : ''} aria-label="${fmt(b)} bills"></td>
      <td class="num" data-amt="${key}-${b}">${fmt(b * n(c[key]?.[b]))}</td></tr>`).join('');
    return `<div class="cc-sheet" id="ccSheet">
      <section class="card cc-part">
        <div class="cc-part-head"><span class="cc-step">1</span><div><h3>Count</h3>
          <p class="muted-note">POS ${c.pos} · ${esc(c.cashier_name)} · ${SHIFTS[c.shift]} · ${esc(fmtDate(c.count_date))}${c.counted_by_name ? ' · counted by ' + esc(c.counted_by_name) : ''}</p></div></div>
        <h4 class="cc-h">Cash LBP</h4>
        <table class="cc-bills"><thead><tr><th class="num">Bill</th><th>How many</th><th class="num">Amount</th></tr></thead><tbody>${billRows(LBP_BILLS, 'lbp', lbp)}</tbody>
          <tfoot><tr><th colspan="2">Total LBP</th><th class="num" id="ccTotLbp">${lbp(r.billsLbp)}</th></tr></tfoot></table>
        <h4 class="cc-h">Cash USD</h4>
        <table class="cc-bills"><thead><tr><th class="num">Bill</th><th>How many</th><th class="num">Amount</th></tr></thead><tbody>${billRows(USD_BILLS, 'usd', usd)}</tbody>
          <tfoot><tr><th colspan="2">Total USD</th><th class="num" id="ccTotUsd">${usd(r.billsUsd)}</th></tr></tfoot></table>
        <h4 class="cc-h">Expenses <span class="cc-h-note">paid from the drawer — added to the cash</span></h4>
        <div class="cc-exp">
          <label>LBP<input type="text" inputmode="numeric" class="cc-in" data-exp="lbp" value="${r.exp.lbp ? lbp(r.exp.lbp) : ''}" ${lock1 ? 'disabled' : ''}></label>
          <label>USD<input type="text" inputmode="decimal" class="cc-in" data-exp="usd" value="${r.exp.usd || ''}" ${lock1 ? 'disabled' : ''}></label>
          <label class="cc-exp-note">What for<input type="text" data-exp="note" value="${esc(c.expenses?.note || '')}" placeholder="e.g. Water delivery, receipt kept" ${lock1 ? 'disabled' : ''}></label>
        </div>
        <h4 class="cc-h">Cards and others</h4>
        <table class="cc-bills cc-cards"><thead><tr><th></th><th class="num">LBP</th><th class="num">USD</th></tr></thead><tbody>${CARDS.map(([k, l]) => `<tr><td>${l}</td>
          <td><input type="text" inputmode="numeric" class="cc-in" data-card="${k}" data-cur="lbp" value="${n(c.cards?.[k]?.lbp) ? lbp(c.cards[k].lbp) : ''}" ${lock1 ? 'disabled' : ''} aria-label="${l} LBP"></td>
          <td><input type="text" inputmode="decimal" class="cc-in" data-card="${k}" data-cur="usd" value="${n(c.cards?.[k]?.usd) || ''}" ${lock1 ? 'disabled' : ''} aria-label="${l} USD"></td></tr>`).join('')}</tbody>
          <tfoot><tr><th>Total</th><th class="num" id="ccCardsLbp">${lbp(r.cardsCounted.lbp)}</th><th class="num" id="ccCardsUsd">${usd(r.cardsCounted.usd)}</th></tr></tfoot></table>
        <div class="cc-sign">${c.signed_at
          ? `<span class="badge active">Signed</span> <span>${esc(c.cashier_name)} confirmed this count with their PIN · ${esc(fmtTs(c.signed_at))}</span>${adm ? ' <span class="muted-note">(changing it removes the signature)</span>' : ''}`
          : canCount() ? `<button type="button" class="btn" id="ccSign">${esc(c.cashier_name)} signs with their PIN</button><span class="muted-note">Hand the device to the cashier.</span>` : '<span class="badge warn">Not signed yet</span>'}</div>
      </section>
      <section class="card cc-part">
        <div class="cc-part-head"><span class="cc-step">2</span><div><h3>System and reconciliation</h3>
          <p class="muted-note">The figures of the system, for the accountant. USD rate ${r.rate ? lbp(r.rate) : '(not set)'}.</p></div></div>
        <table class="cc-bills cc-sys"><thead><tr><th></th><th class="num">System LBP</th><th class="num">System USD</th><th>Slip</th></tr></thead><tbody>
          <tr><td><b>Cash</b></td><td><input type="text" inputmode="numeric" class="cc-in" data-sys="cash_lbp" value="${sys.cash_lbp !== undefined ? lbp(sys.cash_lbp) : ''}" ${lock2 ? 'disabled' : ''} aria-label="System cash LBP"></td>
            <td><input type="text" inputmode="decimal" class="cc-in" data-sys="cash_usd" value="${sys.cash_usd ?? ''}" ${lock2 ? 'disabled' : ''} aria-label="System cash USD"></td><td></td></tr>
          ${CARDS.map(([k, l]) => `<tr><td>${l}</td>
            <td><input type="text" inputmode="numeric" class="cc-in" data-syscard="${k}" data-cur="lbp" value="${sys.cards?.[k]?.lbp !== undefined ? lbp(sys.cards[k].lbp) : ''}" ${lock2 ? 'disabled' : ''} aria-label="System ${l} LBP"></td>
            <td><input type="text" inputmode="decimal" class="cc-in" data-syscard="${k}" data-cur="usd" value="${sys.cards?.[k]?.usd ?? ''}" ${lock2 ? 'disabled' : ''} aria-label="System ${l} USD"></td>
            <td><button type="button" class="cc-found ${c.not_found?.[k] ? 'no' : 'yes'}" data-found="${k}" ${lock2 ? 'disabled' : ''}>${c.not_found?.[k] ? 'Not found' : 'Found'}</button></td></tr>`).join('')}
        </tbody></table>
        <div class="cc-result" id="ccResult">${resultHtml(c)}</div>
        ${canRec() ? `<div class="cc-rec">${c.reconciled_at
          ? `<span class="badge active">Reconciled</span> <span class="muted-note">${esc(fmtTs(c.reconciled_at))}</span>${adm || canRec() ? ' <button type="button" class="link-btn" id="ccUnrec">Reopen</button>' : ''}`
          : '<button type="button" class="btn" id="ccRec">Mark as reconciled</button>'}</div>` : ''}
      </section>
    </div>`;
  }
  function resultHtml(c) {
    const r = calc(c);
    if (!r.hasSystem) return '<p class="muted-note" style="margin:0;">The differences appear once the system figures are entered.</p>';
    const lines = r.cards.filter(x => Math.abs(x.diff.lbp) >= 0.005 || Math.abs(x.diff.usd) >= 0.005);
    return `
      ${r.exp.lbp || r.exp.usd ? `<p class="cc-expnote">Cash includes the expenses: ${[r.exp.lbp ? lbp(r.exp.lbp) + ' LBP' : '', r.exp.usd ? usd(r.exp.usd) + ' USD' : ''].filter(Boolean).join(' + ')}${c.expenses?.note ? ' (' + esc(c.expenses.note) + ')' : ''}</p>` : ''}
      <div class="cc-res-row"><span>Cash LBP</span><span>${diffWord(r.cashDiff.lbp, lbp, 'LBP')}</span></div>
      <div class="cc-res-row"><span>Cash USD</span><span>${diffWord(r.cashDiff.usd, usd, 'USD')}</span></div>
      ${lines.map(x => `<div class="cc-res-row"><span>${esc(x.label)}${x.found ? '' : ' <span class="badge danger">not found</span>'}</span><span>${[
        Math.abs(x.diff.lbp) >= 0.005 ? diffWord(x.diff.lbp, lbp, 'LBP') : '', Math.abs(x.diff.usd) >= 0.005 ? diffWord(x.diff.usd, usd, 'USD') : ''].filter(Boolean).join(' · ')}</span></div>`).join('')
        || '<div class="cc-res-row"><span>Cards and others</span><span><span class="ccx-ok">all match</span></span></div>'}
      ${r.notFound.length ? `<p class="cc-nf">Not found, charged to the cashier's cash: ${r.notFound.map(x => `${esc(x.label)} ${x.counted.lbp ? lbp(x.counted.lbp) + ' LBP' : ''}${x.counted.lbp && x.counted.usd ? ' + ' : ''}${x.counted.usd ? usd(x.counted.usd) + ' USD' : ''}`).join(', ')}</p>` : ''}
      <div class="cc-res-row cc-res-sub"><span>Cash difference (LBP and USD, in LBP)</span><span>${diffWord(r.cashDiffLbpEq, lbp, 'LBP')}</span></div>
      <div class="cc-res-row cc-res-sub"><span>Allowed margin (1,000 per 1,000,000 of cash)</span><span>± ${lbp(r.margin)} LBP</span></div>
      <div class="cc-res-row cc-res-total"><span>Total difference</span><span>${diffWord(r.total, lbp, 'LBP')}</span></div>`;
  }
  function wireSheet(c) {
    const box = el('ccSheet');
    const refreshNumbers = () => {
      const r = calc(c);
      el('ccTotLbp').textContent = lbp(r.billsLbp); el('ccTotUsd').textContent = usd(r.billsUsd);
      el('ccCardsLbp').textContent = lbp(r.cardsCounted.lbp); el('ccCardsUsd').textContent = usd(r.cardsCounted.usd);
      el('ccResult').innerHTML = resultHtml(c);
      const row = el('ccBody').querySelector(`tr[data-cc="${CSS.escape(c.id)}"] td.num`);
      if (row) row.innerHTML = r.hasSystem ? diffWord(r.total, lbp, 'LBP') : '<span class="muted-note">no system figures yet</span>';
    };
    box.addEventListener('input', e => {
      const t = e.target;
      if (t.dataset.exp) {
        c.expenses = { ...(c.expenses || {}) };
        if (t.dataset.exp === 'note') c.expenses.note = t.value.trim(); else c.expenses[t.dataset.exp] = n(String(t.value).replace(/[^\d.]/g, ''));
        saveSoon(c, { expenses: c.expenses });
        return refreshNumbers();
      }
      if (!t.classList.contains('cc-in')) return;
      const v = String(t.value).replace(/[^\d.]/g, '');
      if (t.dataset.bill) {
        const k = t.dataset.bill; c[k] = { ...(c[k] || {}) }; if (n(v)) c[k][t.dataset.b] = Math.round(n(v)); else delete c[k][t.dataset.b];
        box.querySelector(`[data-amt="${k}-${t.dataset.b}"]`).textContent = (k === 'lbp' ? lbp : usd)(Number(t.dataset.b) * n(c[k][t.dataset.b]));
        saveSoon(c, { [k]: c[k] });
      } else if (t.dataset.card) {
        const k = t.dataset.card; c.cards = { ...(c.cards || {}) }; c.cards[k] = { ...(c.cards[k] || {}), [t.dataset.cur]: n(v) };
        saveSoon(c, { cards: c.cards });
      } else if (t.dataset.sys) {
        c.system = { ...(c.system || {}) }; if (v === '') delete c.system[t.dataset.sys]; else c.system[t.dataset.sys] = n(v);
        saveSoon(c, { system: c.system, usd_rate: c.usd_rate || S.rate });
      } else if (t.dataset.syscard) {
        const k = t.dataset.syscard; c.system = { ...(c.system || {}) }; c.system.cards = { ...(c.system.cards || {}) };
        c.system.cards[k] = { ...(c.system.cards[k] || {}), [t.dataset.cur]: n(v) };
        saveSoon(c, { system: c.system, usd_rate: c.usd_rate || S.rate });
      }
      refreshNumbers();
    });
    // Big LBP amounts read better with separators: 2,710,000 (when leaving the box).
    box.addEventListener('focusout', e => { const t = e.target; if (!t.classList?.contains('cc-in') || t.dataset.bill || t.dataset.cur === 'usd' || t.dataset.sys === 'cash_usd' || t.dataset.exp === 'usd' || t.value === '') return; t.value = lbp(t.value); });
    box.querySelectorAll('[data-found]').forEach(b => b.onclick = () => {
      const k = b.dataset.found; c.not_found = { ...(c.not_found || {}) };
      if (c.not_found[k]) delete c.not_found[k]; else c.not_found[k] = true;
      b.classList.toggle('no', !!c.not_found[k]); b.classList.toggle('yes', !c.not_found[k]); b.textContent = c.not_found[k] ? 'Not found' : 'Found';
      saveSoon(c, { not_found: c.not_found });
      refreshNumbers();
    });
    el('ccSign')?.addEventListener('click', async () => {
      const pin = await showPrompt(`${c.cashier_name}: type your 4-digit PIN to confirm this count.`, { confirmLabel: 'Sign', placeholder: '••••' });
      if (pin === null) return;
      clearTimeout(timers.get(c.id));
      await sb.from('cash_counts').update({ lbp: c.lbp, usd: c.usd, cards: c.cards, expenses: c.expenses || {} }).eq('id', c.id);   // the count as shown, first
      const { data, error } = await sb.rpc('cash_count_sign', { p_count: c.id, p_pin: String(pin).trim() });
      if (error) return fail('Not signed', error);
      const [st, left] = String(data).split(':');
      if (st === 'ok') { logActivity('cashcount', 'sign', { type: 'cash_count', id: c.id }, `${c.cashier_name} signed the cash count of POS ${c.pos}`); showToast('Signed.'); }
      else showToast(st === 'wrong' ? `Wrong PIN${left ? ` — ${left} tries left` : ''}.` : st === 'locked' ? 'Too many wrong PINs: try again later.' : st === 'no_pin' ? `${c.cashier_name} has no PIN yet (Staff page).` : 'Not signed.', true);
      await loadDay(); renderDay();
    });
    el('ccRec')?.addEventListener('click', async () => {
      clearTimeout(timers.get(c.id));
      const r = calc(c);
      const { error } = await sb.from('cash_counts').update({ system: c.system, not_found: c.not_found, usd_rate: c.usd_rate || S.rate, reconciled_at: new Date().toISOString() }).eq('id', c.id);
      if (error) return fail('Not saved', error);
      logActivity('cashcount', 'reconcile', { type: 'cash_count', id: c.id }, `Reconciled POS ${c.pos} — ${c.cashier_name}: total difference ${lbp(r.total)} LBP`, { total: r.total, cash: r.cashDiffLbpEq, not_found: r.notFoundLbp });
      await loadDay(); renderDay();
    });
    el('ccUnrec')?.addEventListener('click', async () => {
      const { error } = await sb.from('cash_counts').update({ reconciled_at: null }).eq('id', c.id);
      if (error) return fail('Not saved', error);
      await loadDay(); renderDay();
    });
  }

  /* ---------------- the differences grid (accountant / HR) ---------------- */
  function renderGrid() {
    const rows = S.monthCounts.map(c => ({ c, r: calc(c) }));
    const sum = k => rows.filter(x => x.r.hasSystem).reduce((t, x) => t + k(x.r), 0);
    el('ccBody').innerHTML = `
      <div class="card cc-daybar">
        <button type="button" class="icon-btn" data-ccm="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0;min-width:160px;text-align:center;">${esc(new Date(S.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}</h3>
        <button type="button" class="icon-btn" data-ccm="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span style="flex:1"></span>
        <button type="button" class="btn secondary small" id="ccExport" ${rows.length ? '' : 'disabled'}>Export (Excel)</button>
      </div>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items cc-grid">
        <thead><tr><th>Date</th><th>POS</th><th>Shift</th><th>Cashier</th><th class="num">Expenses (LBP)</th><th class="num">Cash LBP</th><th class="num">Cash USD</th><th class="num">Cards</th><th>Not found</th><th class="num">Total (LBP)</th><th class="num">Allowed ±</th><th>Status</th></tr></thead>
        <tbody>${rows.map(({ c, r }) => `<tr data-open="${esc(c.id)}" data-date="${esc(c.count_date)}">
          <td class="mono">${esc(fmtDate(c.count_date))}</td><td>${c.pos}</td><td>${SHIFTS[c.shift]}</td><td>${esc(c.cashier_name)}</td>
          <td class="num">${r.exp.lbp || r.exp.usd ? lbp(r.exp.lbp + r.exp.usd * r.rate) : ''}</td>
          ${r.hasSystem ? `<td class="num ${cls(r.cashDiff.lbp)}">${sign(r.cashDiff.lbp, lbp)}</td><td class="num ${cls(r.cashDiff.usd)}">${sign(r.cashDiff.usd, usd)}</td>
          <td class="num ${cls(r.cardsDiff)}">${sign(r.cardsDiff, lbp)}</td><td>${r.notFound.map(x => esc(x.label)).join(', ')}</td>
          <td class="num ${cls(r.total)}"><b>${sign(r.total, lbp)}</b></td>` : '<td colspan="5" class="muted-note">no system figures yet</td>'}
          <td class="num">${lbp(r.margin)}</td>
          <td>${c.reconciled_at ? '<span class="badge active">Reconciled</span>' : c.signed_at ? '<span class="badge inactive">Signed</span>' : '<span class="badge warn">Not signed</span>'}</td></tr>`).join('')
          || '<tr><td colspan="12" class="empty-note">No count this month.</td></tr>'}</tbody>
        ${rows.length ? `<tfoot><tr><th colspan="4">Month</th><th class="num">${lbp(rows.reduce((t, x) => t + x.r.exp.lbp + x.r.exp.usd * x.r.rate, 0))}</th><th class="num">${sign(sum(r => r.cashDiff.lbp), lbp)}</th><th class="num">${sign(sum(r => r.cashDiff.usd), usd)}</th><th class="num">${sign(sum(r => r.cardsDiff), lbp)}</th><th></th><th class="num"><b>${sign(sum(r => r.total), lbp)}</b></th><th></th><th></th></tr></tfoot>` : ''}
      </table></div></div>
      <p class="muted-note" style="margin:8px 0 0;">Negative = short, positive = over. Click a row to open its count.</p>`;
    el('ccBody').querySelectorAll('[data-ccm]').forEach(b => b.onclick = async () => { const [y, m] = S.month.split('-').map(Number), d = new Date(y, m - 1 + Number(b.dataset.ccm), 1); S.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; await loadMonth(); renderGrid(); });
    el('ccExport').onclick = () => exportGrid(rows);
    el('ccBody').querySelectorAll('tr[data-open]').forEach(tr => tr.onclick = async () => { S.tab = 'day'; S.date = tr.dataset.date; S.openId = tr.dataset.open; await loadDay(); render(); el('ccSheet')?.scrollIntoView({ block: 'start' }); });
  }
  const cls = d => Math.abs(d) < 0.005 ? '' : d < 0 ? 'ccx-short' : 'ccx-over';
  const sign = (d, fmt) => Math.abs(d) < 0.005 ? '0' : (d < 0 ? '-' : '+') + fmt(Math.abs(d));
  function exportGrid(rows) {
    const aoa = [['Date', 'POS', 'Shift', 'Cashier', 'Expenses LBP', 'Expenses USD', 'Expenses note', 'Cash LBP', 'Cash USD', ...CARDS.map(([, l]) => l + ' (LBP eq.)'), 'Not found', 'Total (LBP)', 'Allowed ±', 'Signed', 'Reconciled']];
    rows.forEach(({ c, r }) => aoa.push([c.count_date, c.pos, SHIFTS[c.shift], c.cashier_name, r.exp.lbp || '', r.exp.usd || '', c.expenses?.note || '',
      r.hasSystem ? Math.round(r.cashDiff.lbp) : '', r.hasSystem ? r.cashDiff.usd : '',
      ...r.cards.map(x => r.hasSystem ? Math.round(x.diff.lbp + x.diff.usd * r.rate) : ''),
      r.notFound.map(x => x.label).join(', '), r.hasSystem ? Math.round(r.total) : '', r.margin, c.signed_at ? 'Yes' : 'No', c.reconciled_at ? 'Yes' : 'No']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cash count');
    XLSX.writeFile(wb, `cash-count-${S.month}.xlsx`);
    logActivity('cashcount', 'export', null, `Exported the cash count differences of ${S.month}`);
  }

  async function refresh() {
    if (S.tab === 'grid') { await loadMonth(); S.missing = false; } else await loadDay();
    render();
  }
  async function show() {
    if (!can('cashcount.count', 'cashcount.reconcile', 'cashcount.view')) return;
    if (!S.started) { S.started = true; if (!canCount() && !canRec() && canGrid()) S.tab = 'grid'; shell(); await loadBase(); }
    await refresh();
  }
  window.CashCount = { show, _state: S, _calc: calc };
})();
