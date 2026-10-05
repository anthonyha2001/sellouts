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
        1,000,000 of the system's total) and the total.
   Differences grid (accountant / HR — cashcount.view): every count of
   a month, with an Excel export.
   Missing slips: when the count is reconciled, every card (LBP / USD)
   whose slips are short of the system becomes a missing slip, by
   itself (not_found["<card>:<cur>:<n>"] = { type, cur, amount, at });
   Found (found_at) puts the slip back in the count. Older counts kept
   marks by hand (true): still read.
   The Missing slips tab lists them, with Found when one turns up.
   After the margin, the difference goes to the Cash page only when the
   accountant presses "Send to the Cash page" (cash_count_post); a count
   changed after sending shows "send again".
   USD -> LBP: one rate (cash_settings.usd_rate), kept on each count.
   The grid is also a tab of the Cash page (not for cashiers: only with a
   cash count right): CashCount.mountGrid(container, month).
   Public API: window.CashCount = { show, mountGrid }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-cashcount');
  const LBP_BILLS = [100000, 50000, 20000, 10000, 5000, 1000];
  const USD_BILLS = [100, 50, 20, 10, 5, 1];
  const CARDS = [['visa_bankmed', 'Visa Bankmed'], ['master_bankmed', 'Master Bankmed'], ['areeba', 'Areeba'], ['ccm_master', 'CCM Master'],
    ['ccm_visa', 'CCM Visa'], ['on_account', 'On account'], ['amex', 'Amex'], ['voucher', 'Special voucher'], ['points', 'Points']];
  const CARD_LABEL = Object.fromEntries(CARDS);
  const SHIFTS = { am: 'AM', pm: 'PM', full: 'Full day' };
  const S = { ctype: 'visa_bankmed', ccur: 'lbp', ecur: 'lbp', started: false, tab: 'day', date: todayStr(), counts: [], openId: null, cashiers: [], rate: null, month: todayStr().slice(0, 7), monthCounts: [], adding: false, missingList: [] };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const canCount = () => can('cashcount.count'), canRec = () => can('cashcount.reconcile'), canGrid = () => can('cashcount.view', 'cashcount.reconcile');
  const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
  const lbp = v => Math.round(n(v)).toLocaleString('en-US');
  const usd = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const fail = (what, error) => { console.error(error); showToast(`${what} — ${friendlyError(error)}`, true); };
  // "short 50,000" / "over 20,000" / "matches"
  const diffWord = (d, fmt, cur) => Math.abs(d) < 0.005 ? '<span class="ccx-ok">matches</span>' : d < 0 ? `<span class="ccx-short">short ${fmt(-d)} ${cur}</span>` : `<span class="ccx-over">over ${fmt(d)} ${cur}</span>`;

  /* ---------------- slips and expenses, one by one (migration 057) ---------------- */
  // "150k" = 150,000 · "1.5m" = 1,500,000 · "40u" or "$40" = USD.
  function parseAmount(t) {
    const x = String(t || '').trim().toLowerCase().replace(/,/g, '');
    const m = x.match(/^(\$)?(\d+(?:\.\d+)?)\s*([km])?\s*(u|usd|\$)?$/); if (!m) return null;
    const amount = Number(m[2]) * (m[3] === 'k' ? 1e3 : m[3] === 'm' ? 1e6 : 1);
    return { amount, usd: !!(m[1] || m[4]) };
  }
  // The slips of a count (older counts kept only the totals per card: one slip each).
  function cardItems(c) {
    // once the slips were worked with on this screen, an empty list stays empty (the X on the last one)
    if (c._items || (Array.isArray(c.card_items) && c.card_items.length)) return c.card_items || [];
    const out = [];
    CARDS.forEach(([k]) => { const x = c.cards?.[k]; if (n(x?.lbp)) out.push({ type: k, cur: 'lbp', amount: n(x.lbp) }); if (n(x?.usd)) out.push({ type: k, cur: 'usd', amount: n(x.usd) }); });
    return out;
  }
  function expenseItems(c) {
    if (c._items || (Array.isArray(c.expense_items) && c.expense_items.length)) return c.expense_items || [];
    const e = c.expenses || {}, out = [];
    if (n(e.lbp)) out.push({ cur: 'lbp', amount: n(e.lbp), note: e.note || '' });
    if (n(e.usd)) out.push({ cur: 'usd', amount: n(e.usd), note: n(e.lbp) ? '' : e.note || '' });
    return out;
  }
  // Items -> the totals the calculation (and the database's cards / expenses) use.
  function syncTotals(c) {
    c.card_items = cardItems(c); c.expense_items = expenseItems(c); c._items = true;
    const cards = {};
    c.card_items.forEach(i => { cards[i.type] = cards[i.type] || { lbp: 0, usd: 0 }; cards[i.type][i.cur] += n(i.amount); });
    c.cards = cards;
    c.expenses = { lbp: c.expense_items.filter(i => i.cur === 'lbp').reduce((t, i) => t + n(i.amount), 0),
      usd: c.expense_items.filter(i => i.cur === 'usd').reduce((t, i) => t + n(i.amount), 0),
      note: c.expense_items.map(i => i.note).filter(Boolean).join(', ') };
  }

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
    // Older marks by hand (true): a counted slip ("<card>#<n>") or a whole card ("<card>") not found — taken out of the count.
    const legacy = cardItems(c).map((i, idx) => ({ ...i, idx, key: i.type + '#' + idx, label: CARD_LABEL[i.type] || i.type }))
      .filter(i => nf[i.key] === true || nf[i.type] === true);
    // Missing slips marked when reconciled: the shortfall is already in the card's difference; a found one is added back.
    const autos = Object.entries(nf).filter(([, v]) => v && typeof v === 'object' && v.type)
      .map(([key, v]) => ({ key, auto: true, type: v.type, cur: v.cur === 'usd' ? 'usd' : 'lbp', amount: n(v.amount), at: v.at, found_at: v.found_at || null, label: CARD_LABEL[v.type] || v.type }));
    const foundSlips = autos.filter(a => a.found_at);
    const per = (list, k) => list.filter(i => i.type === k).reduce((t, i) => ({ ...t, [i.cur]: t[i.cur] + n(i.amount) }), { lbp: 0, usd: 0 });
    const cards = CARDS.map(([k, label]) => {
      const counted = { lbp: n(c.cards?.[k]?.lbp), usd: n(c.cards?.[k]?.usd) };
      const system = { lbp: n(sys.cards?.[k]?.lbp), usd: n(sys.cards?.[k]?.usd) };
      const miss = per(legacy, k), back = per(foundSlips, k);
      const used = { lbp: counted.lbp - miss.lbp + back.lbp, usd: counted.usd - miss.usd + back.usd };
      return { k, label, counted, system, diff: { lbp: used.lbp - system.lbp, usd: used.usd - system.usd } };
    });
    // Not reconciled yet: the slips that will be marked missing (every card short of the system).
    const toMark = !c.reconciled_at && hasSystem ? cards.flatMap(x => ['lbp', 'usd'].filter(cur => x.diff[cur] < -0.004)
      .map(cur => ({ type: x.k, cur, amount: Math.round(-x.diff[cur] * 100) / 100, label: x.label }))) : [];
    const missing = [...legacy, ...(c.reconciled_at ? autos.filter(a => !a.found_at) : [])];
    const cashDiff = { lbp: cashLbp - n(sys.cash_lbp), usd: cashUsd - n(sys.cash_usd) };
    const notFoundLbp = missing.reduce((t, i) => t + (i.cur === 'usd' ? n(i.amount) * rate : n(i.amount)), 0);
    const cardsDiff = cards.reduce((t, x) => t + x.diff.lbp + x.diff.usd * rate, 0);
    const cashDiffLbpEq = cashDiff.lbp + cashDiff.usd * rate;
    const sysCashLbpEq = n(sys.cash_lbp) + n(sys.cash_usd) * rate;
    const billsLbpEq = billsLbp + billsUsd * rate, cashLbpEq = cashLbp + cashUsd * rate;   // all the cash in LBP (USD at the rate)
    const total = cashDiffLbpEq + cardsDiff;
    // The system's total: cash and every card line (points included), in LBP; and the same for the count.
    const sysTotalLbpEq = sysCashLbpEq + cards.reduce((t, x) => t + x.system.lbp + x.system.usd * rate, 0);
    const countedTotalLbpEq = cashLbpEq + cards.reduce((t, x) => t + x.counted.lbp + x.counted.usd * rate, 0);
    const margin = Math.max(0, Math.round(sysTotalLbpEq / 1e6 * 1000));     // 1,000 LBP allowed per 1,000,000 of the system's total
    // Within the margin: nothing; beyond it: only what is beyond.
    const afterMargin = !hasSystem || Math.abs(total) <= margin ? 0 : Math.round(total - Math.sign(total) * margin);
    const posted = c.posted_at ? Math.round(n(c.posted_amount)) : null;
    return {
      rate, billsLbp, billsUsd, billsLbpEq, cashLbpEq, sysCashLbpEq, sysTotalLbpEq, countedTotalLbpEq, exp, cashLbp, cashUsd, cards, cashDiff, cashDiffLbpEq, notFound: missing, notFoundLbp, cardsDiff, hasSystem, toMark, foundSlips,
      cardsCounted: cards.reduce((t, x) => ({ lbp: t.lbp + x.counted.lbp, usd: t.usd + x.counted.usd }), { lbp: 0, usd: 0 }),
      total, margin, afterMargin, posted, needsResend: posted !== null && posted !== afterMargin,
    };
  }
  // Found: a slip marked when reconciled gets found_at; an older mark by hand is taken off.
  function markFound(c, key) {
    const v = (c.not_found || {})[key];
    if (v && typeof v === 'object') { c.not_found = { ...c.not_found, [key]: { ...v, found_at: new Date().toISOString() } }; return c.not_found; }
    return toggleMissing(c, key, false);
  }
  // Older counts: a slip marked by hand / found again (a whole-card mark becomes one mark per slip first).
  function toggleMissing(c, key, missing) {
    const nf = { ...(c.not_found || {}) }, type = key.split('#')[0];
    if (nf[type]) { delete nf[type]; cardItems(c).forEach((i, idx) => { if (i.type === type) nf[type + '#' + idx] = true; }); }
    if (missing) nf[key] = true; else delete nf[key];
    c.not_found = nf;
    return nf;
  }
  const amt = i => i.cur === 'usd' ? usd(i.amount) + ' USD' : lbp(i.amount) + ' LBP';

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
  // Counts of the last 3 months with a missing slip, or sent and changed since.
  async function loadMissing() {
    const { data, error } = await sb.from('cash_counts').select('*').gte('count_date', addDaysStr(todayStr(), -92)).order('count_date', { ascending: false }).order('pos');
    if (error) return fail('Could not load the counts', error);
    S.missingList = (data || []).filter(c => { const r = calc(c); return r.notFound.length || r.needsResend; });
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
        <div class="filter-row" id="ccTabs" style="margin:0;"><button type="button" data-cctab="day">Counts</button>${canRec() || canGrid() ? '<button type="button" data-cctab="missing">Missing slips</button>' : ''}${canGrid() ? '<button type="button" data-cctab="grid">Differences grid</button>' : ''}</div>
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
    if (S.tab === 'missing') return renderMissing();
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
          <thead><tr><th>POS</th><th>Shift</th><th>Cashier</th><th>Signed</th><th>Reconciled</th><th class="num">Total difference</th><th class="num">After margin</th><th>Cash page</th></tr></thead>
          <tbody>${S.counts.map(c => { const r = calc(c); return `<tr data-cc="${esc(c.id)}" class="${c.id === S.openId ? 'on' : ''}">
            <td><b>POS ${c.pos}</b></td><td>${SHIFTS[c.shift]}</td><td>${esc(c.cashier_name)}</td>
            <td>${c.signed_at ? '<span class="badge active">Signed</span>' : '<span class="badge warn">Not signed</span>'}</td>
            <td>${c.reconciled_at ? '<span class="badge active">Reconciled</span>' : r.hasSystem ? '<span class="badge inactive">In progress</span>' : '<span class="muted-note">—</span>'}</td>
            <td class="num" data-tot>${r.hasSystem ? diffWord(r.total, lbp, 'LBP') : '<span class="muted-note">no system figures yet</span>'}</td>
            <td class="num" data-after>${r.hasSystem ? diffWord(r.afterMargin, lbp, 'LBP') : ''}</td>
            <td>${sentBadge(r)}</td></tr>`; }).join('')}</tbody></table>`
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
        <h4 class="cc-h">Cards and others <span class="cc-h-note">one slip at a time</span></h4>
        ${lock1 ? '' : `<div class="cc-quick">
          <div class="cc-types" id="ccTypes">${CARDS.map(([k, l], i) => `<button type="button" data-ctype="${k}" class="${S.ctype === k ? 'on' : ''}" title="Alt+${i + 1}"><kbd>${i + 1}</kbd>${l}</button>`).join('')}</div>
          <div class="cc-qrow">
            <input type="text" id="ccCardAmt" class="cc-qin" autocomplete="off" placeholder="150k · 3 150k · 7 40u — Enter" title="Amount + Enter. 150k = 150,000 · 3 150k = card 3 (Areeba) · 7 40u = Amex 40 USD" aria-label="Slip amount">
            <div class="cc-cur" id="ccCardCur"><button type="button" data-ccur="lbp" class="${S.ccur === 'lbp' ? 'on' : ''}">LBP</button><button type="button" data-ccur="usd" class="${S.ccur === 'usd' ? 'on' : ''}">USD</button></div>
            <button type="button" class="btn small" id="ccCardAdd">Add</button>
          </div></div>`}
        <div id="ccSlips">${slipsHtml(c, lock1)}</div>
        <h4 class="cc-h">Expenses <span class="cc-h-note">paid from the drawer, one by one — added to the cash</span></h4>
        ${lock1 ? '' : `<div class="cc-quick"><div class="cc-qrow">
            <input type="text" id="ccExpAmt" class="cc-qin" autocomplete="off" placeholder="150k water · 40u taxi — Enter" title="Amount then what for, Enter to add" aria-label="Expense">
            <div class="cc-cur" id="ccExpCur"><button type="button" data-ecur="lbp" class="${S.ecur === 'lbp' ? 'on' : ''}">LBP</button><button type="button" data-ecur="usd" class="${S.ecur === 'usd' ? 'on' : ''}">USD</button></div>
            <button type="button" class="btn small" id="ccExpAdd">Add</button>
          </div></div>`}
        <div id="ccExps">${expensesHtml(c, lock1)}</div>
        <p class="muted-note cc-keys">Keys: Enter = next bill / add · Alt+1…9 = card type · Alt+U = LBP / USD · Backspace in an empty box = remove the last one · Alt+S = sign · Alt+R = reconciled</p>
        <div class="cc-sign">${c.signed_at
          ? `<span class="badge active">Signed</span> <span>${esc(c.cashier_name)} confirmed this count with their PIN · ${esc(fmtTs(c.signed_at))}</span>${adm ? ' <span class="muted-note">(changing it removes the signature)</span>' : ''}`
          : canCount() ? `<button type="button" class="btn" id="ccSign">${esc(c.cashier_name)} signs with their PIN</button><span class="muted-note">Hand the device to the cashier.</span>` : '<span class="badge warn">Not signed yet</span>'}</div>
      </section>
      <section class="card cc-part">
        <div class="cc-part-head"><span class="cc-step">2</span><div><h3>System and reconciliation</h3>
          <p class="muted-note">The figures of the system, for the accountant. USD rate ${r.rate ? lbp(r.rate) : '(not set)'}.</p></div></div>
        <table class="cc-bills cc-sys"><thead><tr><th></th><th class="num">System LBP</th><th class="num">System USD</th><th>Slips</th></tr></thead><tbody>
          <tr><td><b>Cash</b></td><td><input type="text" inputmode="numeric" class="cc-in" data-sys="cash_lbp" value="${sys.cash_lbp !== undefined ? lbp(sys.cash_lbp) : ''}" ${lock2 ? 'disabled' : ''} aria-label="System cash LBP"></td>
            <td><input type="text" inputmode="decimal" class="cc-in" data-sys="cash_usd" value="${sys.cash_usd ?? ''}" ${lock2 ? 'disabled' : ''} aria-label="System cash USD"></td><td></td></tr>
          ${CARDS.map(([k, l]) => `<tr><td>${l}</td>
            <td><input type="text" inputmode="numeric" class="cc-in" data-syscard="${k}" data-cur="lbp" value="${sys.cards?.[k]?.lbp !== undefined ? lbp(sys.cards[k].lbp) : ''}" ${lock2 ? 'disabled' : ''} aria-label="System ${l} LBP"></td>
            <td><input type="text" inputmode="decimal" class="cc-in" data-syscard="${k}" data-cur="usd" value="${sys.cards?.[k]?.usd ?? ''}" ${lock2 ? 'disabled' : ''} aria-label="System ${l} USD"></td>
            <td class="cc-slipcell">${slipToggles(c, k)}</td></tr>`).join('')}
          <tr class="cc-systot"><td><b>Total</b></td><td colspan="3" id="ccSysTot">${sysTotHtml(r)}</td></tr>
        </tbody></table>
        <div class="cc-result" id="ccResult">${resultHtml(c)}</div>
        ${canRec() ? `<div class="cc-rec">${c.reconciled_at
          ? `<span class="badge active">Reconciled</span> <span class="muted-note">${esc(fmtTs(c.reconciled_at))}</span>${adm || canRec() ? ' <button type="button" class="link-btn" id="ccUnrec">Reopen</button>' : ''}`
          : '<button type="button" class="btn" id="ccRec">Mark as reconciled</button>'}</div>` : ''}
      </section>
    </div>`;
  }
  function slipToggles(c, k) {
    const nf = c.not_found || {}, mine = cardItems(c).map((i, idx) => ({ ...i, idx })).filter(i => i.type === k);
    if (!mine.length) return '<span class="muted-note">—</span>';
    return mine.map(i => `<span class="cc-slipbtn ${nf[k + '#' + i.idx] === true || nf[k] === true ? 'no' : ''}">${i.cur === 'usd' ? usd(i.amount) + ' $' : lbp(i.amount)}</span>`).join('');
  }
  // The slips, grouped by card, with their total; and the expenses.
  function slipsHtml(c, lock) {
    const items = cardItems(c);
    if (!items.length) return '<p class="empty-note cc-empty">No slip yet.</p>';
    const r = calc(c);
    return `<div class="cc-slipgroups">${CARDS.filter(([k]) => items.some(i => i.type === k)).map(([k, l]) => {
      const mine = items.map((i, idx) => ({ ...i, idx })).filter(i => i.type === k);
      const t = mine.reduce((a, i) => ({ lbp: a.lbp + (i.cur === 'lbp' ? n(i.amount) : 0), usd: a.usd + (i.cur === 'usd' ? n(i.amount) : 0) }), { lbp: 0, usd: 0 });
      return `<div class="cc-slipgroup"><div class="cc-slip-head"><b>${l}</b><span>${mine.length} slip${mine.length === 1 ? '' : 's'} · ${[t.lbp ? lbp(t.lbp) + ' LBP' : '', t.usd ? usd(t.usd) + ' USD' : ''].filter(Boolean).join(' + ')}</span></div>
        <div class="cc-chips">${mine.map(i => `<span class="cc-chip">${i.cur === 'usd' ? usd(i.amount) + ' $' : lbp(i.amount)}${lock ? '' : `<button type="button" data-rmslip="${i.idx}" aria-label="Remove">×</button>`}</span>`).join('')}</div></div>`;
    }).join('')}</div>
    <div class="cc-slip-total"><span>Total cards and others</span><b>${lbp(r.cardsCounted.lbp)} LBP${r.cardsCounted.usd ? ' + ' + usd(r.cardsCounted.usd) + ' USD' : ''}</b></div>`;
  }
  function expensesHtml(c, lock) {
    const items = expenseItems(c);
    if (!items.length) return '<p class="empty-note cc-empty">No expense.</p>';
    const r = calc(c);
    return `<ul class="cc-explist">${items.map((i, idx) => `<li><span>${esc(i.note || 'Expense')}</span><b>${i.cur === 'usd' ? usd(i.amount) + ' USD' : lbp(i.amount) + ' LBP'}</b>${lock ? '' : `<button type="button" data-rmexp="${idx}" aria-label="Remove">×</button>`}</li>`).join('')}</ul>
      <div class="cc-slip-total"><span>Total expenses</span><b>${[r.exp.lbp ? lbp(r.exp.lbp) + ' LBP' : '', r.exp.usd ? usd(r.exp.usd) + ' USD' : ''].filter(Boolean).join(' + ')}</b></div>`;
  }
  // The system's total: cash, cards, points... LBP + USD at the rate.
  const sysTotHtml = r => `<b>${lbp(r.sysTotalLbpEq)} LBP</b> <span class="cc-h-note">cash, cards and points · USD at ${r.rate ? lbp(r.rate) : '(rate not set)'}</span>`;
  function resultHtml(c) {
    const r = calc(c);
    if (!r.hasSystem) return '<p class="muted-note" style="margin:0;">The differences appear once the system figures are entered.</p>';
    const lines = r.cards.filter(x => Math.abs(x.diff.lbp) >= 0.005 || Math.abs(x.diff.usd) >= 0.005);
    const two = (a, b) => [Math.abs(a) >= 0.005 ? diffWord(a, lbp, 'LBP') : '', Math.abs(b) >= 0.005 ? diffWord(b, usd, 'USD') : ''].filter(Boolean).join(' · ');
    return `
      <div class="cc-res-head">Cash</div>
      ${r.exp.lbp || r.exp.usd ? `<p class="cc-expnote">Includes the expenses: ${[r.exp.lbp ? lbp(r.exp.lbp) + ' LBP' : '', r.exp.usd ? usd(r.exp.usd) + ' USD' : ''].filter(Boolean).join(' + ')}${c.expenses?.note ? ' (' + esc(c.expenses.note) + ')' : ''}</p>` : ''}
      <div class="cc-res-row"><span>Cash LBP</span><span>${diffWord(r.cashDiff.lbp, lbp, 'LBP')}</span></div>
      <div class="cc-res-row"><span>Cash USD</span><span>${diffWord(r.cashDiff.usd, usd, 'USD')}</span></div>
      <div class="cc-res-row cc-res-sub"><span>Cash difference</span><span>${diffWord(r.cashDiffLbpEq, lbp, 'LBP')}</span></div>
      <div class="cc-res-head">Credit cards and others</div>
      ${lines.map(x => `<div class="cc-res-row"><span>${esc(x.label)}</span><span>${two(x.diff.lbp, x.diff.usd)}</span></div>`).join('')
        || '<div class="cc-res-row"><span>Every card</span><span><span class="ccx-ok">matches</span></span></div>'}
      ${r.toMark.length ? `<div class="cc-nf">Marked as missing slips when reconciled: ${r.toMark.map(i => esc(i.label) + ' ' + amt(i)).join(', ')}</div>` : ''}
      ${r.notFound.length ? `<div class="cc-nf">${r.notFound.length} missing slip${r.notFound.length === 1 ? '' : 's'}, charged to the cashier (${lbp(r.notFoundLbp)} LBP):</div>
        <ul class="cc-misslist">${r.notFound.map(i => `<li><span>${esc(i.label)} <b>${amt(i)}</b></span>${canRec() ? `<button type="button" class="btn small secondary" data-foundkey="${esc(i.key)}">Found</button>` : ''}</li>`).join('')}</ul>` : ''}
      ${r.foundSlips.length ? `<p class="cc-expnote">Found later: ${r.foundSlips.map(i => esc(i.label) + ' ' + amt(i) + ' (' + esc(fmtTs(i.found_at)) + ')').join(', ')}</p>` : ''}
      <div class="cc-res-row cc-res-sub"><span>Credit card difference</span><span>${diffWord(r.cardsDiff, lbp, 'LBP')}</span></div>
      <div class="cc-res-row cc-res-sub"><span>Total (cash, cards and points): counted ${lbp(r.countedTotalLbpEq)} · system ${lbp(r.sysTotalLbpEq)}</span><span></span></div>
      <div class="cc-res-row cc-res-total"><span>Total difference</span><span>${diffWord(r.total, lbp, 'LBP')}</span></div>
      <div class="cc-res-row"><span>Allowed margin (1,000 per 1,000,000 of the system's total)</span><span>± ${lbp(r.margin)} LBP</span></div>
      <div class="cc-res-row cc-res-total cc-res-after"><span>Difference after the margin</span><span>${diffWord(r.afterMargin, lbp, 'LBP')}</span></div>
      <div class="cc-post">${postHtml(c, r)}</div>`;
  }
  const sentBadge = r => r.posted === null ? '<span class="muted-note">—</span>'
    : r.needsResend ? '<span class="badge warn">Send again</span>' : '<span class="badge active">Sent</span>';
  // The Cash page gets the difference after the margin only when the accountant sends it.
  function postHtml(c, r) {
    const sent = r.posted !== null ? `Sent to the Cash page: <b>${sign(r.posted, lbp)} LBP</b> · ${esc(fmtTs(c.posted_at))}` : 'Not sent to the Cash page yet.';
    if (!canRec()) return `<span class="muted-note">${sent}</span>`;
    if (!c.reconciled_at) return `<span class="muted-note">${sent} Mark it as reconciled first.</span>`;
    if (r.posted !== null && !r.needsResend) return `<span class="badge active">Sent</span> <span class="muted-note">${sent}</span>`;
    return `${r.needsResend ? `<span class="badge warn">Changed since sent</span> <span class="muted-note">${sent}</span>` : ''}
      <button type="button" class="btn small" data-post="${esc(c.id)}">${r.needsResend ? 'Send again' : 'Send to the Cash page'}</button>`;
  }
  async function sendCount(c) {
    const r = calc(c);
    const what = r.afterMargin ? `${sign(r.afterMargin, lbp)} LBP (${r.afterMargin < 0 ? 'short' : 'over'})` : '0 LBP (within the margin)';
    const ok = await showConfirm(`Send ${what} to the Cash page for ${c.cashier_name}, ${fmtDate(c.count_date)}?`, 'Send');
    if (!ok) return false;
    clearTimeout(timers.get(c.id));
    const { data, error } = await sb.rpc('cash_count_post', { p_count: c.id, p_amount: r.afterMargin });
    if (error) { fail('Not sent', error); return false; }
    c.posted_amount = r.afterMargin; c.posted_at = new Date().toISOString();
    logActivity('cashcount', 'post', { type: 'cash_count', id: c.id }, `Sent the cash count of POS ${c.pos} — ${c.cashier_name}, ${fmtDate(c.count_date)} to the Cash page: ${lbp(r.afterMargin)} LBP`, { amount: r.afterMargin, day_total: data });
    showToast(`Sent. ${c.cashier_name}'s day on the Cash page: ${sign(n(data), lbp)} LBP.`);
    return true;
  }
  function wireSheet(c) {
    const box = el('ccSheet');
    const refreshNumbers = () => {
      const r = calc(c);
      el('ccTotLbp').textContent = lbp(r.billsLbp); el('ccTotUsd').textContent = usd(r.billsUsd); el('ccSysTot').innerHTML = sysTotHtml(r);
      const lock1 = !canCount() || (!!c.signed_at && !isAdmin());
      el('ccSlips').innerHTML = slipsHtml(c, lock1); el('ccExps').innerHTML = expensesHtml(c, lock1);
      el('ccResult').innerHTML = resultHtml(c);
      const tr = el('ccBody').querySelector(`tr[data-cc="${CSS.escape(c.id)}"]`);
      if (tr) {
        tr.querySelector('[data-tot]').innerHTML = r.hasSystem ? diffWord(r.total, lbp, 'LBP') : '<span class="muted-note">no system figures yet</span>';
        tr.querySelector('[data-after]').innerHTML = r.hasSystem ? diffWord(r.afterMargin, lbp, 'LBP') : '';
        tr.lastElementChild.innerHTML = sentBadge(r);
      }
    };
    const saveItems = () => { syncTotals(c); saveSoon(c, { card_items: c.card_items, cards: c.cards, expense_items: c.expense_items, expenses: c.expenses }); refreshNumbers(); };
    const setType = k => { S.ctype = k; box.querySelectorAll('[data-ctype]').forEach(b => b.classList.toggle('on', b.dataset.ctype === k)); };
    const setCur = (which, v) => { S[which] = v; box.querySelectorAll(which === 'ccur' ? '[data-ccur]' : '[data-ecur]').forEach(b => b.classList.toggle('on', (b.dataset.ccur || b.dataset.ecur) === v)); };
    // One slip: "150k", "3 150k" (card 3), "7 40u" (Amex, USD).
    const addSlip = () => {
      const inp = el('ccCardAmt'); let txt = inp.value.trim(); if (!txt) return;
      const m = txt.match(/^([1-9])\s+(.+)$/);
      if (m) { setType(CARDS[Number(m[1]) - 1][0]); txt = m[2]; }
      const a = parseAmount(txt);
      if (!a || !a.amount) return showToast('Type an amount, e.g. 150k or 40u.', true);
      syncTotals(c);
      c.card_items = [...c.card_items, { type: S.ctype, cur: a.usd ? 'usd' : S.ccur, amount: a.amount }];
      inp.value = ''; saveItems(); inp.focus();
    };
    const addExpense = () => {
      const inp = el('ccExpAmt'); const txt = inp.value.trim(); if (!txt) return;
      const m = txt.match(/^(\$?[\d.,]+\s*[km]?\s*(?:u|usd|\$)?)\s*(.*)$/i);
      const a = m && parseAmount(m[1]);
      if (!a || !a.amount) return showToast('Type the amount first, e.g. 150k water.', true);
      syncTotals(c);
      c.expense_items = [...c.expense_items, { cur: a.usd ? 'usd' : S.ecur, amount: a.amount, note: (m[2] || '').trim() }];
      inp.value = ''; saveItems(); inp.focus();
    };
    el('ccCardAdd')?.addEventListener('click', addSlip);
    el('ccExpAdd')?.addEventListener('click', addExpense);
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-ctype], [data-ccur], [data-ecur], [data-rmslip], [data-rmexp]'); if (!b) return;
      if (b.dataset.ctype) { setType(b.dataset.ctype); el('ccCardAmt')?.focus(); }
      if (b.dataset.ccur) { setCur('ccur', b.dataset.ccur); el('ccCardAmt')?.focus(); }
      if (b.dataset.ecur) { setCur('ecur', b.dataset.ecur); el('ccExpAmt')?.focus(); }
      if (b.dataset.rmslip !== undefined) { syncTotals(c); c.card_items = c.card_items.filter((_, i) => i !== Number(b.dataset.rmslip)); saveItems(); }
      if (b.dataset.rmexp !== undefined) { syncTotals(c); c.expense_items = c.expense_items.filter((_, i) => i !== Number(b.dataset.rmexp)); saveItems(); }
    });
    // Keyboard: Enter moves down the bills, then to the slips; Enter adds; Alt+1..9 card; Alt+U currency;
    // Backspace in an empty box removes the last one; Alt+S sign; Alt+R reconciled.
    box.addEventListener('keydown', e => {
      const t = e.target;
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); setType(CARDS[Number(e.code.slice(5)) - 1][0]); el('ccCardAmt')?.focus(); return; }
      if (e.altKey && e.code === 'KeyU') { e.preventDefault(); if (t.id === 'ccExpAmt') setCur('ecur', S.ecur === 'lbp' ? 'usd' : 'lbp'); else setCur('ccur', S.ccur === 'lbp' ? 'usd' : 'lbp'); return; }
      if (e.altKey && e.code === 'KeyS') { e.preventDefault(); el('ccSign')?.click(); return; }
      if (e.altKey && e.code === 'KeyR') { e.preventDefault(); el('ccRec')?.click(); return; }
      if (t.id === 'ccCardAmt' || t.id === 'ccExpAmt') {
        if (e.key === 'Enter') { e.preventDefault(); return t.id === 'ccCardAmt' ? addSlip() : addExpense(); }
        if (e.key === 'Backspace' && !t.value) {
          syncTotals(c);
          const list = t.id === 'ccCardAmt' ? c.card_items : c.expense_items; if (!list.length) return;
          e.preventDefault();
          if (t.id === 'ccCardAmt') c.card_items = c.card_items.slice(0, -1); else c.expense_items = c.expense_items.slice(0, -1);
          saveItems(); showToast('Removed the last one.');
        }
        return;
      }
      const ins = [...box.querySelectorAll('input[data-bill]:not([disabled])')], i = ins.indexOf(t);
      if (i >= 0 && (e.key === 'Enter' || e.key === 'ArrowDown')) { e.preventDefault(); (ins[i + 1] || el('ccCardAmt'))?.focus(); ins[i + 1]?.select(); }
      if (i > 0 && e.key === 'ArrowUp') { e.preventDefault(); ins[i - 1].focus(); ins[i - 1].select(); }
      const sys = [...box.querySelectorAll('input[data-sys]:not([disabled]), input[data-syscard]:not([disabled])')], j = sys.indexOf(t);
      if (j >= 0 && (e.key === 'Enter' || e.key === 'ArrowDown')) { e.preventDefault(); sys[j + 1]?.focus(); sys[j + 1]?.select(); }
      if (j > 0 && e.key === 'ArrowUp') { e.preventDefault(); sys[j - 1].focus(); sys[j - 1].select(); }
    });
    box.addEventListener('focusin', e => { if (e.target.matches?.('input.cc-in')) e.target.select(); });
    box.addEventListener('input', e => {
      const t = e.target;
      if (!t.classList.contains('cc-in')) return;
      // The system's figures can be negative (refunds, returns): a leading minus is kept there and counts as negative.
      const neg = !!(t.dataset.sys || t.dataset.syscard) && /^\s*[-−]/.test(t.value), raw = t.value.replace(/^\s*[-−]/, '');
      const q = parseAmount(raw), abs = raw.trim() === '' ? '' : q ? String(q.amount) : String(raw).replace(/[^\d.]/g, '');
      const v = neg && abs !== '' ? '-' + abs : abs;
      if (t.dataset.bill) {
        const k = t.dataset.bill; c[k] = { ...(c[k] || {}) }; if (n(v)) c[k][t.dataset.b] = Math.round(n(v)); else delete c[k][t.dataset.b];
        box.querySelector(`[data-amt="${k}-${t.dataset.b}"]`).textContent = (k === 'lbp' ? lbp : usd)(Number(t.dataset.b) * n(c[k][t.dataset.b]));
        saveSoon(c, { [k]: c[k] });
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
    box.addEventListener('focusout', e => { const t = e.target; if (!t.classList?.contains('cc-in') || t.dataset.bill || t.dataset.cur === 'usd' || t.dataset.sys === 'cash_usd' || t.dataset.exp === 'usd' || t.value === '') return;
      const neg = /^\s*[-−]/.test(t.value), raw = t.value.replace(/^\s*[-−]/, ''), q = parseAmount(raw), val = q ? q.amount : n(raw);   // "150k" -> 150,000
      t.value = lbp(neg && (t.dataset.sys || t.dataset.syscard) ? -val : val); });
    box.addEventListener('click', async e => {
      const fb = e.target.closest('[data-foundkey]');
      if (fb) {
        clearTimeout(timers.get(c.id));
        const slip = calc(c).notFound.find(i => i.key === fb.dataset.foundkey);
        fb.disabled = true;
        const nf = markFound({ ...c }, fb.dataset.foundkey);
        const { error } = await sb.from('cash_counts').update({ not_found: nf }).eq('id', c.id);
        if (error) { fb.disabled = false; return fail('Not saved', error); }
        c.not_found = nf;
        logActivity('cashcount', 'found', { type: 'cash_count', id: c.id }, `Slip found: ${slip ? slip.label + ' ' + amt(slip) : fb.dataset.foundkey} — POS ${c.pos}, ${c.cashier_name}, ${fmtDate(c.count_date)}`);
        showToast(calc(c).needsResend ? 'Found. The count changed: send it to the Cash page again.' : 'Found. The difference is updated.');
        await loadDay(); return renderDay();
      }
      const p = e.target.closest('[data-post]');
      if (p && await sendCount(c)) { await loadDay(); renderDay(); }
    });
    el('ccSign')?.addEventListener('click', async () => {
      const pin = await showPrompt(`${c.cashier_name}: type your 4-digit PIN to confirm this count.`, { confirmLabel: 'Sign', placeholder: '••••' });
      if (pin === null) return;
      clearTimeout(timers.get(c.id));
      syncTotals(c);
      await sb.from('cash_counts').update({ lbp: c.lbp, usd: c.usd, cards: c.cards, expenses: c.expenses, card_items: c.card_items, expense_items: c.expense_items }).eq('id', c.id);   // the count as shown, first
      const { data, error } = await sb.rpc('cash_count_sign', { p_count: c.id, p_pin: String(pin).trim() });
      if (error) return fail('Not signed', error);
      const [st, left] = String(data).split(':');
      if (st === 'ok') { logActivity('cashcount', 'sign', { type: 'cash_count', id: c.id }, `${c.cashier_name} signed the cash count of POS ${c.pos}`); showToast('Signed.'); }
      else showToast(st === 'wrong' ? `Wrong PIN${left ? ` — ${left} tries left` : ''}.` : st === 'locked' ? 'Too many wrong PINs: try again later.' : st === 'no_pin' ? `${c.cashier_name} has no PIN yet (Staff page).` : 'Not signed.', true);
      await loadDay(); renderDay();
    });
    el('ccRec')?.addEventListener('click', async () => {
      clearTimeout(timers.get(c.id));
      // Every card short of the system becomes a missing slip (the ones marked before and not found are worked out again).
      const at = new Date().toISOString();
      const nf = Object.fromEntries(Object.entries(c.not_found || {}).filter(([, v]) => !(v && typeof v === 'object' && !v.found_at)));
      const marks = calc({ ...c, not_found: nf, reconciled_at: null }).toMark;
      marks.forEach(m => { let i = 1; while (nf[`${m.type}:${m.cur}:${i}`]) i++; nf[`${m.type}:${m.cur}:${i}`] = { type: m.type, cur: m.cur, amount: m.amount, at }; });
      const r = calc({ ...c, not_found: nf, reconciled_at: at });
      const { error } = await sb.from('cash_counts').update({ system: c.system, not_found: nf, usd_rate: c.usd_rate || S.rate, reconciled_at: at }).eq('id', c.id);
      if (error) return fail('Not saved', error);
      if (marks.length) showToast(`Reconciled. ${marks.length} missing slip${marks.length === 1 ? '' : 's'} marked: ${marks.map(m => m.label + ' ' + amt(m)).join(', ')}.`);
      logActivity('cashcount', 'reconcile', { type: 'cash_count', id: c.id }, `Reconciled POS ${c.pos} — ${c.cashier_name}: total difference ${lbp(r.total)} LBP`, { total: r.total, cash: r.cashDiffLbpEq, not_found: r.notFoundLbp });
      await loadDay(); renderDay();
    });
    el('ccUnrec')?.addEventListener('click', async () => {
      const { error } = await sb.from('cash_counts').update({ reconciled_at: null }).eq('id', c.id);
      if (error) return fail('Not saved', error);
      await loadDay(); renderDay();
    });
  }

  /* ---------------- missing slips (accountant) ---------------- */
  function renderMissing() {
    const list = S.missingList.map(c => ({ c, r: calc(c) }));
    const slips = list.flatMap(({ c, r }) => r.notFound.map(i => ({ c, r, i })));
    const resend = list.filter(x => x.r.needsResend);
    const totalLbp = list.reduce((t, x) => t + x.r.notFoundLbp, 0);
    const where = c => `<td class="mono">${esc(fmtDate(c.count_date))}</td><td>POS ${c.pos} · ${SHIFTS[c.shift]}</td><td>${esc(c.cashier_name)}</td>`;
    el('ccBody').innerHTML = `
      <div class="card"><p style="margin:0;">Card slips short of the system, marked missing when the count was reconciled (last 3 months). A missing slip is charged to the cashier; when it turns up, press <b>Found</b> and the count's difference is recalculated.${canRec() ? ' A count already sent to the Cash page then has to be sent again.' : ''}</p></div>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items ccx-grid ccx-missing">
        <thead><tr><th>Date</th><th>Count</th><th>Cashier</th><th>Card</th><th class="num">Amount</th><th class="num">LBP</th><th>Cash page</th><th></th></tr></thead>
        <tbody>${slips.map(({ c, r, i }) => `<tr>${where(c)}<td>${esc(i.label)}</td><td class="num">${amt(i)}</td>
          <td class="num">${lbp(i.cur === 'usd' ? n(i.amount) * r.rate : n(i.amount))}</td><td>${sentBadge(r)}</td>
          <td class="cc-mact">${canRec() ? `<button type="button" class="btn small secondary" data-mfound="${esc(c.id)}" data-key="${esc(i.key)}">Found</button>` : ''}
            <button type="button" class="link-btn" data-mopen="${esc(c.id)}" data-date="${esc(c.count_date)}">Open</button></td></tr>`).join('')
          || '<tr><td colspan="8" class="empty-note">No missing slip.</td></tr>'}</tbody>
        ${slips.length ? `<tfoot><tr><th colspan="5">${slips.length} missing slip${slips.length === 1 ? '' : 's'}</th><th class="num">${lbp(totalLbp)}</th><th colspan="2"></th></tr></tfoot>` : ''}
      </table></div></div>
      ${resend.length ? `<h4 class="cc-h">Changed since sent to the Cash page</h4>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items ccx-grid">
        <thead><tr><th>Date</th><th>Count</th><th>Cashier</th><th class="num">Sent</th><th class="num">Now (after margin)</th><th></th></tr></thead>
        <tbody>${resend.map(({ c, r }) => `<tr>${where(c)}<td class="num">${sign(r.posted, lbp)}</td><td class="num ${cls(r.afterMargin)}"><b>${sign(r.afterMargin, lbp)}</b></td>
          <td class="cc-mact">${canRec() && c.reconciled_at ? `<button type="button" class="btn small" data-msend="${esc(c.id)}">Send again</button>` : ''}
            <button type="button" class="link-btn" data-mopen="${esc(c.id)}" data-date="${esc(c.count_date)}">Open</button></td></tr>`).join('')}</tbody>
      </table></div></div>` : ''}`;
    el('ccBody').querySelectorAll('[data-mfound]').forEach(b => b.onclick = async () => {
      const c = S.missingList.find(x => x.id === b.dataset.mfound); if (!c) return;
      const before = calc(c), slip = before.notFound.find(i => i.key === b.dataset.key);
      b.disabled = true;
      const nf = markFound({ ...c }, b.dataset.key);
      const { error } = await sb.from('cash_counts').update({ not_found: nf }).eq('id', c.id);
      if (error) { b.disabled = false; return fail('Not saved', error); }
      c.not_found = nf;
      const r = calc(c);
      logActivity('cashcount', 'found', { type: 'cash_count', id: c.id }, `Slip found: ${slip ? slip.label + ' ' + amt(slip) : b.dataset.key} — POS ${c.pos}, ${c.cashier_name}, ${fmtDate(c.count_date)}`);
      showToast(r.needsResend ? 'Found. The count changed: send it to the Cash page again.' : 'Found. The difference is updated.');
      S.missingList = S.missingList.filter(x => { const q = calc(x); return q.notFound.length || q.needsResend; });
      renderMissing();
    });
    el('ccBody').querySelectorAll('[data-msend]').forEach(b => b.onclick = async () => {
      const c = S.missingList.find(x => x.id === b.dataset.msend); if (!c) return;
      if (!await sendCount(c)) return;
      S.missingList = S.missingList.filter(x => { const q = calc(x); return q.notFound.length || q.needsResend; });
      renderMissing();
    });
    el('ccBody').querySelectorAll('[data-mopen]').forEach(b => b.onclick = async () => { S.tab = 'day'; S.date = b.dataset.date; S.openId = b.dataset.mopen; await loadDay(); render(); el('ccSheet')?.scrollIntoView({ block: 'start' }); });
  }

  /* ---------------- the differences grid (accountant / HR) ---------------- */
  function renderGrid(host = el('ccBody')) {
    const rows = S.monthCounts.map(c => ({ c, r: calc(c) }));
    const sum = k => rows.filter(x => x.r.hasSystem).reduce((t, x) => t + k(x.r), 0);
    const inCash = host.id !== 'ccBody', canOpen = !inCash || canSee('cashcount');
    host.innerHTML = `
      <div class="card cc-daybar">
        <button type="button" class="icon-btn" data-ccm="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h3 style="margin:0;min-width:160px;text-align:center;">${esc(new Date(S.month + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }))}</h3>
        <button type="button" class="icon-btn" data-ccm="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
        <span style="flex:1"></span>
        <button type="button" class="btn secondary small" id="ccExport" ${rows.length ? '' : 'disabled'}>Export (Excel)</button>
      </div>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;"><table class="items ccx-grid">
        <thead><tr><th>Date</th><th>POS</th><th>Shift</th><th>Cashier</th><th class="num">Expenses</th><th class="num">Cash</th><th class="num">Cards</th><th>Missing slips</th><th class="num">Total</th><th class="num">Margin ±</th><th class="num">After margin</th><th>Cash page</th><th>Status</th></tr></thead>
        <tbody>${rows.map(({ c, r }) => `<tr data-open="${esc(c.id)}" data-date="${esc(c.count_date)}">
          <td class="mono">${esc(fmtDate(c.count_date))}</td><td>${c.pos}</td><td>${SHIFTS[c.shift]}</td><td>${esc(c.cashier_name)}</td>
          <td class="num">${r.exp.lbp || r.exp.usd ? lbp(r.exp.lbp + r.exp.usd * r.rate) : ''}</td>
          ${r.hasSystem ? `<td class="num ${cls(r.cashDiffLbpEq)}" title="LBP ${sign(r.cashDiff.lbp, lbp)} · USD ${sign(r.cashDiff.usd, usd)}">${sign(r.cashDiffLbpEq, lbp)}</td>
          <td class="num ${cls(r.cardsDiff)}">${sign(r.cardsDiff, lbp)}</td>
          <td class="cc-gmiss">${r.notFound.map(i => esc(i.label) + ' ' + amt(i)).join(', ')}</td>
          <td class="num ${cls(r.total)}">${sign(r.total, lbp)}</td>
          <td class="num">${lbp(r.margin)}</td>
          <td class="num ${cls(r.afterMargin)}"><b>${sign(r.afterMargin, lbp)}</b></td>` : '<td colspan="6" class="muted-note">no system figures yet</td>'}
          <td>${r.posted === null ? '<span class="muted-note">—</span>' : `<span class="mono">${sign(r.posted, lbp)}</span>${r.needsResend ? ' <span class="badge warn">Send again</span>' : ''}`}</td>
          <td>${c.reconciled_at ? '<span class="badge active">Reconciled</span>' : c.signed_at ? '<span class="badge inactive">Signed</span>' : '<span class="badge warn">Not signed</span>'}</td></tr>`).join('')
          || '<tr><td colspan="13" class="empty-note">No count this month.</td></tr>'}</tbody>
        ${rows.length ? `<tfoot><tr><th colspan="4">Month</th><th class="num">${lbp(rows.reduce((t, x) => t + x.r.exp.lbp + x.r.exp.usd * x.r.rate, 0))}</th><th class="num">${sign(sum(r => r.cashDiffLbpEq), lbp)}</th><th class="num">${sign(sum(r => r.cardsDiff), lbp)}</th><th class="num">${lbp(sum(r => r.notFoundLbp))}</th><th class="num">${sign(sum(r => r.total), lbp)}</th><th></th><th class="num"><b>${sign(sum(r => r.afterMargin), lbp)}</b></th><th class="num">${sign(rows.reduce((t, x) => t + (x.r.posted || 0), 0), lbp)}</th><th></th></tr></tfoot>` : ''}
      </table></div></div>
      <p class="muted-note" style="margin:8px 0 0;">Negative = short, positive = over.${canOpen ? ' Click a row to open its count.' : ''}</p>`;
    host.querySelectorAll('[data-ccm]').forEach(b => b.onclick = async () => { const [y, m] = S.month.split('-').map(Number), d = new Date(y, m - 1 + Number(b.dataset.ccm), 1); S.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; await loadMonth(); renderGrid(host); });
    host.querySelector('#ccExport').onclick = () => exportGrid(rows);
    if (!canOpen) host.querySelectorAll('tr[data-open]').forEach(tr => { tr.style.cursor = 'default'; });
    else host.querySelectorAll('tr[data-open]').forEach(tr => tr.onclick = async () => {
      S.tab = 'day'; S.date = tr.dataset.date; S.openId = tr.dataset.open;
      if (inCash) { switchTab('cashcount'); return; }      // the Cash count page opens on that count
      await loadDay(); render(); el('ccSheet')?.scrollIntoView({ block: 'start' });
    });
  }
  const cls = d => Math.abs(d) < 0.005 ? '' : d < 0 ? 'ccx-short' : 'ccx-over';
  const sign = (d, fmt) => Math.abs(d) < 0.005 ? '0' : (d < 0 ? '-' : '+') + fmt(Math.abs(d));
  function exportGrid(rows) {
    const aoa = [['Date', 'POS', 'Shift', 'Cashier', 'Expenses LBP', 'Expenses USD', 'Expenses note', 'Cash LBP', 'Cash USD', 'Cash difference (LBP)', ...CARDS.map(([, l]) => l + ' (LBP eq.)'),
      'Credit card difference (LBP)', 'Missing slips', 'Missing slips (LBP)', 'Total (LBP)', 'Allowed ±', 'After margin (LBP)', 'Sent to the Cash page (LBP)', 'Signed', 'Reconciled']];
    rows.forEach(({ c, r }) => { const h = r.hasSystem, R = v => h ? Math.round(v) : '';
      aoa.push([c.count_date, c.pos, SHIFTS[c.shift], c.cashier_name, r.exp.lbp || '', r.exp.usd || '', c.expenses?.note || '',
        R(r.cashDiff.lbp), h ? r.cashDiff.usd : '', R(r.cashDiffLbpEq), ...r.cards.map(x => R(x.diff.lbp + x.diff.usd * r.rate)),
        R(r.cardsDiff), r.notFound.map(i => i.label + ' ' + amt(i)).join(', '), r.notFoundLbp ? Math.round(r.notFoundLbp) : '', R(r.total), r.margin, R(r.afterMargin),
        r.posted === null ? '' : r.posted, c.signed_at ? 'Yes' : 'No', c.reconciled_at ? 'Yes' : 'No']); });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Cash count');
    XLSX.writeFile(wb, `cash-count-${S.month}.xlsx`);
    logActivity('cashcount', 'export', null, `Exported the cash count differences of ${S.month}`);
  }

  async function refresh() {
    if (S.tab === 'grid') { await loadMonth(); S.missing = false; } else if (S.tab === 'missing') { await loadMissing(); S.missing = false; } else await loadDay();
    render();
  }
  async function show() {
    if (!can('cashcount.count', 'cashcount.reconcile', 'cashcount.view')) return;
    if (!S.started) { S.started = true; if (!canCount() && !canRec() && canGrid()) S.tab = 'grid'; shell(); await loadBase(); }
    await refresh();
  }
  // The grid inside the Cash page (its "Cash count" tab), from the Cash page's month.
  async function mountGrid(host, month) {
    if (!canGrid()) { host.innerHTML = ''; return; }
    if (month && !S.gridMounted) S.month = month;
    S.gridMounted = true;
    host.innerHTML = '<p class="muted-note">Loading…</p>';
    if (!S.rate) await loadBase();
    await loadMonth();
    if (host.isConnected) renderGrid(host);
  }
  window.CashCount = { show, mountGrid, _state: S, _calc: calc };
})();
