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
        <input type="text" data-k="note" value="${esc(m.note || '')}" placeholder="Applies to (e.g. beans)" aria-label="Applies to" class="vc-note">
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
    el('vcSigned').value = c.signed || ''; el('vcStatus').value = c.status || '';
    el('vcText').value = c.text || ''; el('vcStrategy').value = c.strategy || '';
    el('vcAdd').onclick = () => { margins.push(blankMargin()); paintMargins(); el('vcMargins').querySelector('.vc-row:last-child [data-k="value"]')?.focus(); };
    paintMargins();
  }
  function readForm() {
    const clean = margins.filter(m => n(m.value) > 0).map(m => ({ type: m.type, value: n(m.value), unit: m.unit === '$' ? '$' : '%', basis: m.basis === 'invoice' ? 'invoice' : 'statement',
      freq: m.basis === 'invoice' ? '' : (m.freq || ''), note: String(m.note || '').trim() }));
    const pay = el('vcPayDays').value.trim(), min = el('vcMinOrder').value.trim();
    return { contract: { margins: clean, paymentDays: pay === '' ? null : n(pay), expiredReturns: el('vcExpired').value || '', minOrder: min === '' ? null : n(min),
      from: el('vcFrom').value || '', to: el('vcTo').value || '', notes: el('vcNotes').value.trim(),
      signed: el('vcSigned').value.trim(), status: el('vcStatus').value.trim(), text: el('vcText').value.trim(), strategy: el('vcStrategy').value.trim() } };
  }

  // the totals: % on invoice, % on statement, fixed amounts
  function summary(c) {
    const M = Array.isArray(c?.margins) ? c.margins : [];
    const pct = b => M.filter(m => m.basis === b && m.unit !== '$').reduce((t, m) => t + n(m.value), 0);
    return { invoicePct: pct('invoice'), statementPct: pct('statement'), fixed: M.filter(m => m.unit === '$'), margins: M,
      paymentDays: c?.paymentDays ?? null, expiredReturns: c?.expiredReturns || '', minOrder: c?.minOrder ?? null, from: c?.from || '', to: c?.to || '', notes: c?.notes || '',
      signed: c?.signed || '', status: c?.status || '', text: c?.text || '', strategy: c?.strategy || '',
      expired: !!(c?.to && c.to < todayStr()) };
  }
  // the vendor linked to a supplier of the system (Vendors › Supplier in the system)
  function forSupplier(code) {
    const list = typeof vendorsList !== 'undefined' ? vendorsList : [];
    const k = String(code || '').replace(/^0+(?=\d)/, '');
    return list.find(v => (v.systemSuppliers || []).some(s => String(s.code || '').replace(/^0+(?=\d)/, '') === k)) || null;
  }
  const fmt = v => (Math.round(n(v) * 100) / 100).toLocaleString('en-US');
  // a back margin as a tag: its own rate and what it applies to (never added to the others)
  const marginLabel = m => `${fmt(m.value)}${m.unit === '$' ? ' $' : '%'} ${m.basis === 'invoice' ? 'invoice' : 'statement'}${m.basis !== 'invoice' && m.freq ? ' ' + m.freq : ''}${m.note ? ' · ' + m.note : ''}`;
  // the tags: one per back margin, plus one "Contract" tag (the contract as written, the pricing strategy and the
  // other terms on hover). opts.editable: the margin tags open the editor (data-vc-i).
  function chip(c, opts = {}) {
    const s = summary(c);
    const head = [].concat(s.text ? ['Contract' + (s.signed ? ' (' + s.signed + ')' : '') + ': ' + s.text] : [], s.strategy ? ['Pricing strategy: ' + s.strategy] : [], s.status ? ['Status: ' + s.status] : []);
    const other = [].concat(s.paymentDays ? [`Payment: ${s.paymentDays} days`] : [], s.expiredReturns ? [`Expired goods: ${s.expiredReturns === 'yes' ? 'taken back' : 'not taken back'}`] : [],
      s.minOrder ? [`Minimum order: $${fmt(s.minOrder)}`] : [], s.from || s.to ? [`Contract: ${s.from || '…'} to ${s.to || '…'}${s.expired ? ' (ended)' : ''}`] : [], s.notes ? [s.notes] : []);
    const ended = s.expired ? ' vc-ended' : '';
    const tags = s.margins.map((m, i) => `<span class="vc-chip${ended}${opts.editable ? ' vc-edit' : ''}"${opts.editable ? ` data-vc-i="${i}" role="button" tabindex="0"` : ''} title="${esc(m.type + ': ' + marginLabel(m) + (opts.editable ? '\nClick to change or remove it' : ''))}">${esc(marginLabel(m))}</span>`);
    const info = head.concat(other);
    if (info.length) tags.push(`<span class="vc-chip vc-info${ended}" title="${esc(info.join('\n'))}">Contract${s.signed ? ' ' + esc(s.signed) : ''}${s.expired ? ' · ended' : ''}</span>`);
    return tags.join('');
  }

  // add / change / remove one back margin of a vendor, from anywhere (Pricing): saved in its contract at once
  function editMargin(vendor, index, onSaved) {
    if (!vendor) return showToast('This supplier is not linked to a vendor yet: Vendors › edit › Supplier in the system.', true);
    if (!can('vendors.manage')) return showToast('Only managers of vendors can change contracts.', true);
    const c = vendor.contract || {}, list = Array.isArray(c.margins) ? c.margins.slice() : [];
    const m = index === null || index === undefined ? blankMargin() : { ...blankMargin(), ...list[index] };
    document.getElementById('vcEdit')?.remove();
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-overlay open" id="vcEdit"><div class="modal-box vc-edit-box" role="dialog" aria-modal="true" aria-labelledby="vcEditTitle">
      <h3 id="vcEditTitle">${index === null || index === undefined ? 'Add a back margin' : 'Back margin'} · ${esc(vendor.name)}</h3>
      <div class="vc-edit-grid">
        <label>Value<div class="vc-edit-val"><input type="text" inputmode="decimal" id="vceValue" value="${esc(String(m.value ?? ''))}" placeholder="10">
          <select id="vceUnit"><option value="%" ${m.unit !== '$' ? 'selected' : ''}>%</option><option value="$" ${m.unit === '$' ? 'selected' : ''}>$</option></select></div></label>
        <label>Basis<select id="vceBasis"><option value="invoice" ${m.basis === 'invoice' ? 'selected' : ''}>On invoice</option><option value="statement" ${m.basis !== 'invoice' ? 'selected' : ''}>On statement</option></select></label>
        <label id="vceFreqBox">How often<select id="vceFreq"><option value="">—</option>${FREQ.map(([k, l]) => `<option value="${k}" ${m.freq === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Type<select id="vceType">${TYPES.map(t => `<option ${t === m.type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="vc-edit-wide">Applies to<input type="text" id="vceNote" value="${esc(m.note || '')}" placeholder="e.g. beans, vacuum, all items"></label>
      </div>
      <div class="actions-row">
        ${index === null || index === undefined ? '' : '<button type="button" class="btn ghost small danger" id="vceDel">Remove</button>'}
        <span style="flex:1"></span>
        <button type="button" class="btn ghost small" id="vceCancel">Cancel</button>
        <button type="button" class="btn small" id="vceSave">Save</button>
      </div></div></div>`);
    const box = document.getElementById('vcEdit'), g = id => document.getElementById(id);
    const sync = () => { g('vceFreqBox').hidden = g('vceBasis').value === 'invoice'; };
    sync(); g('vceBasis').onchange = sync;
    const close = () => box.remove();
    g('vceCancel').onclick = close; box.addEventListener('click', e => { if (e.target === box) close(); });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') close(); if (e.key === 'Enter' && e.target.tagName !== 'SELECT') g('vceSave').click(); });
    const save = async margins => {
      const contract = { ...c, margins };
      const { error } = await sb.from('vendors').update({ contract }).eq('id', vendor.id);
      if (error) { showToast('Could not save: ' + error.message, true); return; }
      vendor.contract = contract; close();
      if (typeof logActivity === 'function') logActivity('vendors', 'contract_margin', { type: 'vendor', id: vendor.id }, `Back margins of ${vendor.name}: ${margins.map(marginLabel).join(', ') || 'none'}`);
      onSaved && onSaved();
    };
    g('vceSave').onclick = () => {
      const v = n(g('vceValue').value);
      if (!(v > 0)) { showToast('Type the value of the back margin.', true); g('vceValue').focus(); return; }
      const nm = { type: g('vceType').value, value: v, unit: g('vceUnit').value === '$' ? '$' : '%', basis: g('vceBasis').value === 'invoice' ? 'invoice' : 'statement',
        freq: g('vceBasis').value === 'invoice' ? '' : g('vceFreq').value, note: g('vceNote').value.trim() };
      const next = list.slice(); if (index === null || index === undefined) next.push(nm); else next[index] = nm;
      save(next);
    };
    g('vceDel')?.addEventListener('click', async () => { if (!(await showConfirm('Remove this back margin from ' + vendor.name + '\'s contract?', 'Remove'))) return; save(list.filter((_, i) => i !== index)); });
    g('vceValue').focus(); g('vceValue').select();
  }
  window.VendorContract = { wireForm, readForm, summary, forSupplier, chip, editMargin, marginLabel };
})();
