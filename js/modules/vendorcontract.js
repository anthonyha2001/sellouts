/* ============================================================
   Vendors › Contract terms (owner, 2026-10-06; migration 068 vendors.contract):
   the back margins a supplier gives — each one a type, a % or a fixed
   amount, ON INVOICE (deducted on every PU) or ON STATEMENT (credited on the
   account statement, monthly / quarterly / yearly) — plus payment days,
   returns of expired goods, minimum order, the contract's dates and notes.
   Pricing shows them on the supplier's PUs: the net-net cost (net minus the
   on-statement %) and a flag when an on-invoice % is missing from a PU line.
   Public API: window.VendorContract = { wireForm(v), readForm(), summary(contract), forSupplier(code), chip(contract) }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const n = v => { const x = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(x) ? x : 0; };
  const TYPES = ['Annual rebate', 'Display / gondola', 'Listing', 'Promotion support', 'Logistics / distribution', 'Expiry & damages', 'Growth bonus', 'Other'];
  const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']];
  let margins = [];

  function blankMargin() { return { type: TYPES[0], value: '', unit: '%', basis: 'statement', freq: 'quarterly', note: '' }; }

  function paintMargins() {
    const box = el('vcMargins'); if (!box) return;
    box.innerHTML = margins.length ? margins.map((m, i) => `<div class="vc-row" data-i="${i}">
        <select data-k="type" aria-label="Type">${TYPES.map(t => `<option ${t === m.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <input type="text" inputmode="decimal" data-k="value" value="${esc(String(m.value ?? ''))}" placeholder="0" aria-label="Value" class="vc-val">
        <select data-k="unit" aria-label="Percent or amount" class="vc-unit"><option value="%" ${m.unit === '%' ? 'selected' : ''}>%</option><option value="$" ${m.unit === '$' ? 'selected' : ''}>$</option></select>
        <select data-k="basis" aria-label="On invoice or on statement"><option value="invoice" ${m.basis === 'invoice' ? 'selected' : ''}>On invoice</option><option value="statement" ${m.basis === 'statement' ? 'selected' : ''}>On statement</option></select>
        <select data-k="freq" aria-label="How often" ${m.basis === 'invoice' ? 'hidden' : ''}>${FREQ.map(([k, l]) => `<option value="${k}" ${m.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="text" data-k="note" value="${esc(m.note || '')}" placeholder="Note (optional)" aria-label="Note" class="vc-note">
        <button type="button" class="icon-btn" data-del="${i}" title="Remove this margin" aria-label="Remove this margin"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join('') : '<p class="muted-note" style="margin:0;">No back margin yet.</p>';
    box.querySelectorAll('.vc-row').forEach(row => {
      const m = margins[Number(row.dataset.i)];
      row.querySelectorAll('[data-k]').forEach(inp => {
        inp.oninput = inp.onchange = () => { m[inp.dataset.k] = inp.value; if (inp.dataset.k === 'basis') paintMargins(); paintTotal(); };
      });
    });
    box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { margins.splice(Number(b.dataset.del), 1); paintMargins(); paintTotal(); });
    paintTotal();
  }
  function paintTotal() { const t = el('vcTotal'); if (t) t.innerHTML = chip({ margins }) || ''; }

  function wireForm(v) {
    const c = v?.contract || {};
    margins = (Array.isArray(c.margins) ? c.margins : []).map(m => ({ ...blankMargin(), ...m }));
    el('vcPayDays').value = c.paymentDays ?? '';
    el('vcExpired').value = c.expiredReturns || '';
    el('vcMinOrder').value = c.minOrder ?? '';
    el('vcFrom').value = c.from || '';
    el('vcTo').value = c.to || '';
    el('vcNotes').value = c.notes || '';
    el('vcAdd').onclick = () => { margins.push(blankMargin()); paintMargins(); el('vcMargins').querySelector('.vc-row:last-child [data-k="value"]')?.focus(); };
    paintMargins();
  }
  function readForm() {
    const clean = margins.filter(m => n(m.value) > 0).map(m => ({ type: m.type, value: n(m.value), unit: m.unit === '$' ? '$' : '%', basis: m.basis === 'invoice' ? 'invoice' : 'statement',
      freq: m.basis === 'invoice' ? '' : (m.freq || 'quarterly'), note: String(m.note || '').trim() }));
    const pay = el('vcPayDays').value.trim(), min = el('vcMinOrder').value.trim();
    return { contract: { margins: clean, paymentDays: pay === '' ? null : n(pay), expiredReturns: el('vcExpired').value || '', minOrder: min === '' ? null : n(min),
      from: el('vcFrom').value || '', to: el('vcTo').value || '', notes: el('vcNotes').value.trim() } };
  }

  // the totals: % on invoice, % on statement, fixed amounts
  function summary(c) {
    const M = Array.isArray(c?.margins) ? c.margins : [];
    const pct = b => M.filter(m => m.basis === b && m.unit !== '$').reduce((t, m) => t + n(m.value), 0);
    return { invoicePct: pct('invoice'), statementPct: pct('statement'), fixed: M.filter(m => m.unit === '$'), margins: M,
      paymentDays: c?.paymentDays ?? null, expiredReturns: c?.expiredReturns || '', minOrder: c?.minOrder ?? null, from: c?.from || '', to: c?.to || '', notes: c?.notes || '',
      expired: !!(c?.to && c.to < todayStr()) };
  }
  // the vendor linked to a supplier of the system (Vendors › Supplier in the system)
  function forSupplier(code) {
    const list = typeof vendorsList !== 'undefined' ? vendorsList : [];
    const k = String(code || '').replace(/^0+(?=\d)/, '');
    return list.find(v => (v.systemSuppliers || []).some(s => String(s.code || '').replace(/^0+(?=\d)/, '') === k)) || null;
  }
  const fmt = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US');
  function chip(c) {
    const s = summary(c); const parts = [];
    if (s.invoicePct) parts.push(`<b>${fmt(s.invoicePct)}%</b> on invoice`);
    if (s.statementPct) parts.push(`<b>${fmt(s.statementPct)}%</b> on statement`);
    if (s.fixed.length) parts.push(`${s.fixed.length} fixed amount${s.fixed.length === 1 ? '' : 's'} ($${fmt(s.fixed.reduce((t, m) => t + n(m.value), 0))})`);
    // the hover: every term of the contract (a tag to know it, never used in the prices)
    const lines = s.margins.map(m => `${m.type}: ${fmt(m.value)}${m.unit === '$' ? ' $' : '%'} ${m.basis === 'invoice' ? 'on invoice' : 'on statement, ' + m.freq}${m.note ? ' (' + m.note + ')' : ''}`)
      .concat(s.paymentDays ? [`Payment: ${s.paymentDays} days`] : [], s.expiredReturns ? [`Expired goods: ${s.expiredReturns === 'yes' ? 'taken back' : 'not taken back'}`] : [],
        s.minOrder ? [`Minimum order: $${fmt(s.minOrder)}`] : [], s.from || s.to ? [`Contract: ${s.from || '…'} to ${s.to || '…'}${s.expired ? ' (ended)' : ''}`] : [], s.notes ? [s.notes] : []);
    if (!lines.length) return '';
    return `<span class="vc-chip${s.expired ? ' vc-ended' : ''}" title="${esc(lines.join('\n'))}">${parts.length ? 'Back margin ' + parts.join(' · ') : 'Contract'}${s.expired ? ' · ended' : ''}</span>`;
  }
  window.VendorContract = { wireForm, readForm, summary, forSupplier, chip };
})();
