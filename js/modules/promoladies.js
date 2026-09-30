/* ============================================================
   Promo ladies (owner, 2026-09-30): in-store promoters booked by
   suppliers. A booking: supplier (from Vendors), paid or free
   (amount in USD when paid), the item promoted, the dates.
   Two tabs: a month calendar (who is in the store on which day)
   and the list (search, current / upcoming / past, totals).
   Permission: promoladies.manage (admin, floor manager by default).
   Table: promo_ladies (supabase/migrations/018_promo_ladies.sql).
   Public API: window.PromoLadies = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-promoladies');
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const today = () => beirutToday();
  const fmt = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const fmtShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };
  const monthLabel = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return d.toLocaleDateString('en-CA').slice(0, 7); };
  const S = { started: false, tab: 'calendar', month: null, rows: [], vendors: [], q: '', when: 'current', day: null, missing: false };

  /* ---------------- data ---------------- */
  async function load() {
    const [{ data, error }, v] = await Promise.all([
      sb.from('promo_ladies').select('*').order('start_date', { ascending: false }),
      S.vendors.length ? { data: null } : sb.from('vendors').select('name').order('name'),
    ]);
    S.missing = !!error;
    if (error) { console.warn('Promo ladies not available (migration 018?)', error.message); S.rows = []; }
    else S.rows = (data || []).map(r => ({ ...r, amount: r.amount === null ? null : Number(r.amount) }));
    if (v.data) { const seen = new Set(); S.vendors = v.data.map(x => String(x.name || '').trim()).filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).sort((a, b) => a.localeCompare(b)); }
  }
  const onDay = (r, d) => r.start_date <= d && r.end_date >= d;
  const statusOf = r => r.end_date < today() ? 'past' : r.start_date > today() ? 'upcoming' : 'now';

  /* ---------------- shell ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="filter-row pl-top" style="justify-content:space-between;flex-wrap:wrap;">
        <div id="plTabs" style="display:flex;gap:8px;">
          <button data-tab="calendar">Calendar</button>
          <button data-tab="list">List</button>
        </div>
        <button class="btn small" id="plAdd">+ Add promo lady</button>
      </div>
      <div id="plNotice"></div>
      <div id="plBody"></div>`;
    el('plTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { S.tab = b.dataset.tab; render(); } };
    el('plAdd').onclick = () => openForm(null, S.tab === 'calendar' && S.day ? S.day : null);
    ensureModal();
  }
  function render() {
    panel.querySelectorAll('#plTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    el('plNotice').innerHTML = S.missing ? '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> Promo ladies can be saved once migration 018 is applied.</p></div>' : '';
    if (S.tab === 'calendar') renderCalendar(); else renderList();
  }

  /* ---------------- calendar ---------------- */
  function renderCalendar() {
    const ym = S.month, first = new Date(ym + '-01T00:00:00');
    const startOffset = (first.getDay() + 6) % 7;                     // weeks start on Monday
    const gridStart = addDays(ym + '-01', -startOffset);
    const days = [...Array(42).keys()].map(i => addDays(gridStart, i));
    const lastRow = days.findLastIndex(d => d.startsWith(ym));
    const shown = days.slice(0, Math.ceil((lastRow + 1) / 7) * 7);
    const t = today();
    const inMonth = S.rows.filter(r => r.start_date <= shown[shown.length - 1] && r.end_date >= shown[0]);
    const monthRows = S.rows.filter(r => r.start_date <= ym + '-31' && r.end_date >= ym + '-01');
    const paidMonth = monthRows.filter(r => r.paid).reduce((s, r) => s + (r.amount || 0), 0);
    if (!S.day || !S.day.startsWith(ym)) S.day = t.startsWith(ym) ? t : ym + '-01';
    el('plBody').innerHTML = `
      <div class="card pl-cal-card">
        <div class="pl-cal-head">
          <button class="icon-btn" data-m="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
          <h3>${esc(monthLabel(ym))}</h3>
          <button class="icon-btn" data-m="1" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
          <button class="btn ghost small" data-m="0">Today</button>
          <span class="pl-cal-sum">${monthRows.length} booking${monthRows.length === 1 ? '' : 's'} · paid ${money(paidMonth)}</span>
        </div>
        <div class="pl-cal">
          ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="pl-dow">${d}</div>`).join('')}
          ${shown.map(d => {
            const list = inMonth.filter(r => onDay(r, d));
            return `<div class="pl-day ${d.startsWith(ym) ? '' : 'out'} ${d === t ? 'today' : ''} ${d === S.day ? 'sel' : ''}" data-day="${d}">
              <div class="pl-dnum">${Number(d.slice(8))}${list.length ? `<span class="pl-count">${list.length}</span>` : ''}</div>
              ${list.slice(0, 3).map(r => `<button type="button" class="pl-chip ${r.paid ? 'paid' : 'free'}" data-id="${r.id}" title="${esc(r.supplier + (r.item ? ' — ' + r.item : '') + (r.paid ? ' · ' + money(r.amount) : ' · free'))}">${esc(r.supplier)}</button>`).join('')}
              ${list.length > 3 ? `<span class="pl-more">+${list.length - 3} more</span>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="pl-legend"><span><i class="paid"></i> Paid</span><span><i class="free"></i> Free</span><span class="muted-note">Click a day to see who is in the store; click a name to edit.</span></div>
      </div>
      <div class="card" id="plDayCard">${dayHtml(S.day)}</div>`;
    const body = el('plBody');
    body.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { S.month = b.dataset.m === '0' ? today().slice(0, 7) : addMonths(S.month, Number(b.dataset.m)); S.day = null; renderCalendar(); });
    body.querySelector('.pl-cal').onclick = e => {
      const chip = e.target.closest('[data-id]'); if (chip) return openForm(chip.dataset.id);
      const day = e.target.closest('[data-day]'); if (!day) return;
      S.day = day.dataset.day;
      if (!S.day.startsWith(S.month)) { S.month = S.day.slice(0, 7); return renderCalendar(); }
      body.querySelectorAll('.pl-day.sel').forEach(x => x.classList.remove('sel')); day.classList.add('sel');
      el('plDayCard').innerHTML = dayHtml(S.day);
    };
    el('plDayCard').onclick = dayCardClick;
  }
  function dayHtml(d) {
    const list = S.rows.filter(r => onDay(r, d)).sort((a, b) => a.supplier.localeCompare(b.supplier));
    return `<div class="pl-dayhead"><h3>${esc(new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
        <button class="btn small secondary" data-add="${d}">+ Add on this day</button></div>
      ${list.length ? `<ul class="pl-daylist">${list.map(r => `<li data-id="${r.id}">
          <span class="badge ${r.paid ? 'active' : 'inactive'}">${r.paid ? 'Paid' : 'Free'}</span>
          <div class="pl-dl-main"><b>${esc(r.supplier)}</b>${r.item ? ` · ${esc(r.item)}` : ''}<div class="muted-note">${fmtShort(r.start_date)} → ${fmtShort(r.end_date)}${r.paid ? ' · ' + money(r.amount) : ''}${r.note ? ' · ' + esc(r.note) : ''}</div></div>
          <button class="btn ghost small" data-edit="${r.id}">Edit</button></li>`).join('')}</ul>`
        : '<p class="muted-note" style="margin:6px 0 0;">No promo lady on this day.</p>'}`;
  }
  function dayCardClick(e) {
    const a = e.target.closest('[data-add]'); if (a) return openForm(null, a.dataset.add);
    const ed = e.target.closest('[data-edit]'); if (ed) return openForm(ed.dataset.edit);
  }

  /* ---------------- list ---------------- */
  function renderList() {
    const t = today(), q = S.q.toLowerCase();
    const list = S.rows.filter(r => (S.when === 'all' || (S.when === 'current' ? r.end_date >= t : r.end_date < t))
        && (!q || [r.supplier, r.item, r.note].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => S.when === 'past' ? b.start_date.localeCompare(a.start_date) : a.start_date.localeCompare(b.start_date));
    const paid = list.filter(r => r.paid);
    el('plBody').innerHTML = `
      <div class="filter-row" style="justify-content:space-between;flex-wrap:wrap;">
        <div id="plWhen" style="display:flex;gap:8px;flex-wrap:wrap;">
          ${[['current', 'Now and upcoming'], ['past', 'Past'], ['all', 'All']].map(([k, l]) => `<button data-when="${k}" class="${S.when === k ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        <input type="search" id="plSearch" placeholder="Search supplier or item…" value="${esc(S.q)}" style="max-width:240px;">
      </div>
      <div class="card rental-totals"><div class="rental-summary">
        <span class="rs-item">Bookings: <strong>${list.length}</strong></span>
        <span class="rs-item">Paid: <strong>${paid.length}</strong> · <strong>${money(paid.reduce((s, r) => s + (r.amount || 0), 0))}</strong></span>
        <span class="rs-item">Free: <strong>${list.length - paid.length}</strong></span>
        <span class="rs-item">In the store today: <strong>${S.rows.filter(r => onDay(r, t)).length}</strong></span>
      </div></div>
      <div class="card"><div class="items-scroll" style="margin-bottom:0;"><table class="items pl-table">
        <thead><tr><th>Supplier</th><th>Item promoted</th><th>Dates</th><th>Days</th><th>Paid / free</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map(r => {
          const st = statusOf(r), days = Math.round((new Date(r.end_date) - new Date(r.start_date)) / 86400000) + 1;
          return `<tr data-id="${r.id}">
            <td><b>${esc(r.supplier)}</b>${r.note ? `<div class="muted-note">${esc(r.note)}</div>` : ''}</td>
            <td>${esc(r.item || '—')}</td>
            <td style="white-space:nowrap;">${fmt(r.start_date)} → ${fmt(r.end_date)}</td>
            <td class="num">${days}</td>
            <td><span class="badge ${r.paid ? 'active' : 'inactive'}">${r.paid ? 'Paid' : 'Free'}</span></td>
            <td class="num">${r.paid ? money(r.amount) : '—'}</td>
            <td><span class="badge ${st === 'now' ? 'warn' : st === 'upcoming' ? 'active' : 'inactive'}">${st === 'now' ? 'In the store' : st === 'upcoming' ? 'Upcoming' : 'Done'}</span></td>
            <td><div class="icon-actions" style="justify-content:flex-end;"><button class="btn ghost small" data-edit="${r.id}">Edit</button></div></td>
          </tr>`;
        }).join('') || `<tr><td colspan="8" class="empty-note">${S.rows.length ? 'Nothing matches.' : 'No promo ladies yet — use “+ Add promo lady”.'}</td></tr>`}</tbody>
      </table></div></div>`;
    el('plWhen').onclick = e => { const b = e.target.closest('[data-when]'); if (b) { S.when = b.dataset.when; renderList(); } };
    el('plSearch').oninput = e => { S.q = e.target.value; const pos = e.target.selectionStart; renderList(); const i = el('plSearch'); i.focus(); i.setSelectionRange(pos, pos); };
    el('plBody').querySelector('tbody').onclick = e => { const b = e.target.closest('[data-edit]'); if (b) openForm(b.dataset.edit); };
  }

  /* ---------------- add / edit ---------------- */
  function ensureModal() {
    if (el('plOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="plOverlay">
        <div class="modal-box form-box">
          <h3 id="plTitle" style="margin:0 0 16px;font-family:var(--font-head);"></h3>
          <form id="plForm" autocomplete="off">
            <div class="form-grid">
              <div class="full"><label for="plSupplier">Supplier <span style="opacity:.6;">(from Vendors — type to search)</span></label>
                <input type="text" id="plSupplier" list="plVendors" required placeholder="Choose a vendor…"><datalist id="plVendors"></datalist>
                <p class="muted-note" id="plSupWarn" hidden style="margin:4px 0 0;color:var(--gold);">Not in the Vendors list — pick a vendor, or keep this name if it is right.</p></div>
              <div class="full"><label>Paid or free</label>
                <div class="pl-seg" id="plPaidSeg"><button type="button" data-paid="0">Free</button><button type="button" data-paid="1">Paid</button></div></div>
              <div id="plAmountWrap"><label for="plAmount">Amount paid (USD)</label><input type="text" inputmode="decimal" id="plAmount" placeholder="e.g. 300"></div>
              <div class="full"><label for="plItem">Item promoted</label><input type="text" id="plItem" placeholder="e.g. Nescafé 3-in-1 · tasting"></div>
              <div><label for="plFrom">From</label><input type="date" id="plFrom" required></div>
              <div><label for="plTo">To</label><input type="date" id="plTo" required></div>
              <div class="full"><label for="plNote">Note <span style="opacity:.6;">(optional)</span></label><input type="text" id="plNote" placeholder="e.g. promoter name, hours, stand near aisle 4"></div>
            </div>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="plDelete" style="margin-right:auto;color:var(--brick);">Delete</button>
              <button type="button" class="btn ghost small" id="plCancel">Cancel</button>
              <button type="submit" class="btn small" id="plSave">Save</button>
            </div>
          </form>
        </div>
      </div>`);
  }
  let editing = null, paidChoice = false;
  function setPaid(on) {
    paidChoice = on;
    el('plPaidSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.paid === '1') === on));
    el('plAmountWrap').hidden = !on;
  }
  function openForm(id, day) {
    if (S.missing) return showToast('Promo ladies can be saved once migration 018 is applied.', true);
    const r = id ? S.rows.find(x => x.id === id) : null;
    editing = r;
    el('plTitle').textContent = r ? `Edit — ${r.supplier}` : 'Add promo lady';
    el('plVendors').innerHTML = S.vendors.map(v => `<option value="${esc(v)}">`).join('');
    el('plSupplier').value = r ? r.supplier : '';
    el('plItem').value = r ? r.item : '';
    el('plFrom').value = r ? r.start_date : (day || today());
    el('plTo').value = r ? r.end_date : (day || today());
    el('plAmount').value = r && r.amount ? String(r.amount) : '';
    el('plNote').value = r ? (r.note || '') : '';
    setPaid(r ? r.paid : false);
    el('plDelete').hidden = !r;
    checkSupplier();
    el('plOverlay').classList.add('open');
    el('plSupplier').focus();
  }
  const closeForm = () => { el('plOverlay').classList.remove('open'); editing = null; };
  function checkSupplier() {
    const v = el('plSupplier').value.trim().toLowerCase();
    el('plSupWarn').hidden = !v || !S.vendors.length || S.vendors.some(x => x.toLowerCase() === v);
  }
  document.addEventListener('click', e => {
    if (!el('plOverlay')) return;
    if (e.target.id === 'plOverlay' || e.target.id === 'plCancel') return closeForm();
    const p = e.target.closest('#plPaidSeg [data-paid]'); if (p) { setPaid(p.dataset.paid === '1'); if (paidChoice) el('plAmount').focus(); }
    if (e.target.id === 'plDelete') return removeRow();
  });
  document.addEventListener('input', e => { if (e.target.id === 'plSupplier') checkSupplier(); });
  document.addEventListener('change', e => { if (e.target.id === 'plFrom' && el('plTo').value < e.target.value) el('plTo').value = e.target.value; });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'plForm') return;
    e.preventDefault();
    const supplier = el('plSupplier').value.trim(), from = el('plFrom').value, to = el('plTo').value;
    if (!supplier) return showToast('Choose the supplier.', true);
    if (!from || !to) return showToast('Set both dates.', true);
    if (to < from) return showToast('The end date is before the start date.', true);
    let amount = null;
    if (paidChoice) {
      amount = parseNum(el('plAmount').value);
      if (amount === null || amount <= 0) return showToast('Enter the amount paid.', true);
    }
    const row = { supplier, paid: paidChoice, amount, item: el('plItem').value.trim(), start_date: from, end_date: to, note: el('plNote').value.trim() || null, updated_at: new Date().toISOString() };
    el('plSave').disabled = true;
    const q = editing ? sb.from('promo_ladies').update(row).eq('id', editing.id).select().single() : sb.from('promo_ladies').insert(row).select().single();
    const { data, error } = await q;
    el('plSave').disabled = false;
    if (error) return showToast('Could not save — ' + friendlyError(error), true);
    const summary = `${supplier}${row.item ? ' · ' + row.item : ''} · ${fmt(from)} → ${fmt(to)} · ${paidChoice ? money(amount) : 'free'}`;
    if (editing) { Object.assign(editing, data, { amount: data.amount === null ? null : Number(data.amount) }); logActivity('promoladies', 'edit', { type: 'promo_lady', id: data.id }, `Edited promo lady: ${summary}`); }
    else { S.rows.unshift({ ...data, amount: data.amount === null ? null : Number(data.amount) }); logActivity('promoladies', 'create', { type: 'promo_lady', id: data.id }, `Added promo lady: ${summary}`); }
    if (S.tab === 'calendar') { S.month = from.slice(0, 7); S.day = from; }
    closeForm(); render();
    showToast('Saved.');
  });
  async function removeRow() {
    const r = editing; if (!r) return;
    if (!(await showConfirm(`Delete the promo lady of ${r.supplier} (${fmt(r.start_date)} → ${fmt(r.end_date)})?`, 'Delete'))) return;
    const { error } = await sb.from('promo_ladies').delete().eq('id', r.id);
    if (error) return showToast('Could not delete — ' + friendlyError(error), true);
    S.rows = S.rows.filter(x => x !== r);
    logActivity('promoladies', 'delete', { type: 'promo_lady', id: r.id }, `Deleted promo lady: ${r.supplier} · ${fmt(r.start_date)} → ${fmt(r.end_date)}`);
    closeForm(); render();
    showToast('Deleted.');
  }

  window.PromoLadies = {
    async show() {
      if (!can('promoladies.manage')) return;
      if (!S.started) { S.started = true; S.month = today().slice(0, 7); shell(); }
      await load();
      render();
    },
    _state: S,
  };
})();
