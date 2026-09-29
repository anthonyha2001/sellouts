/* ============================================================
   Rentals (PLAN §7): yearly contracts (one annual amount, billed once)
   and other rentals tracked month by month, year over year.
   Gondola, side gondola, basket side and pillar can be either;
   screens (wall / island) are monthly only (owner, 2026-09-29).
   Shared state (rentalsList, editingRentalId, expandedRentalIds) is
   declared in app.js; initVendors() loads and renders this page.
   ============================================================ */

const EQUIPMENT_LABELS = {
  gondola: 'Gondola', side_gondola: 'Side gondola', basket_side: 'Basket side', pillar: 'Pillar',
  screen_wall: 'Screen · wall', screen_island: 'Screen · island',
};
const TERM_EQUIPMENT = {
  yearly: ['gondola', 'side_gondola', 'basket_side', 'pillar'],
  other: ['gondola', 'side_gondola', 'basket_side', 'pillar', 'screen_wall', 'screen_island'],
};
const RENEWAL_WARNING_DAYS = 30;
const RENTAL_NOTIFY_LOG_KEY = 'lv:rentalNotifyLog';

const rentalView = { term: 'yearly', type: 'all', screen: '' };   // type: 'all' | equipment | 'screens'

const RENTAL_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAME_TO_IDX = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};
function monthlyKey(year, monthIdx) { return year + '-' + String(monthIdx + 1).padStart(2, '0'); }
function parseMonthYearHeader(h) {
  const s = String(h).trim().toLowerCase();
  const m = s.match(/^([a-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const monIdx = MONTH_NAME_TO_IDX[m[1]];
  if (monIdx === undefined) return null;
  return monthlyKey(Number(m[2]), monIdx);
}
function buildMonthGridHtml(year) {
  return RENTAL_MONTH_NAMES.map((m, i) => `
    <div class="rm-cell">
      <label>${m} ${year}</label>
      <input type="text" inputmode="decimal" class="rental-month-input" data-mkey="${monthlyKey(year, i)}" placeholder="0">
    </div>
  `).join('');
}
function rentalYearTotal(rental, year) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(rental.monthly[monthlyKey(year, i)] || 0);
  return sum;
}
function rentalSignal(prevTotal, curTotal) {
  if (!prevTotal) return curTotal > 0 ? { label: 'New', cls: 'warn' } : { label: 'No activity', cls: '' };
  const pct = Math.round(((curTotal - prevTotal) / prevTotal) * 100);
  if (pct >= 0) return { label: `+${pct}% · Recommend renewal`, cls: 'active' };
  if (pct <= -15) return { label: `${pct}% · Review`, cls: 'danger' };
  return { label: `${pct}%`, cls: 'warn' };
}
const rentalYear = () => Number(todayStr().slice(0, 4));
const money2 = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

/* ---------------- data ---------------- */
async function loadRentalsData() {
  const { data, error } = await sb.from('vendor_rentals').select('*').order('supplier', { ascending: true });
  if (error) { console.error(error); showToast('Could not load rentals — ' + sbErrText(error), true); return; }
  rentalsList = (data || []).map(r => ({
    id: r.id, supplier: r.supplier || '', gondola: r.gondola || '',
    dateFrom: r.date_from || '', dateTo: r.date_to || '', monthly: r.monthly || {},
    term: r.rental_term || 'other', equipment: r.equipment_type || 'gondola',
    annual: r.annual_amount === null || r.annual_amount === undefined ? null : Number(r.annual_amount),
    billed: !!r.billed, billedAt: r.billed_at || '', note: r.note || '',
  }));
}
function rentalRow(r) {
  return {
    id: r.id, supplier: r.supplier, gondola: r.gondola || null,
    date_from: r.dateFrom || null, date_to: r.dateTo || null, monthly: r.monthly || {},
    rental_term: r.term, equipment_type: r.equipment,
    annual_amount: r.term === 'yearly' ? r.annual : null,
    billed: r.term === 'yearly' ? !!r.billed : false,
    billed_at: r.term === 'yearly' && r.billed ? (r.billedAt || null) : null,
    note: r.note || null,
  };
}
async function saveRentalRemote(r) {
  const { error } = await sb.from('vendor_rentals').upsert(rentalRow(r));
  if (error) { console.error(error); showToast('Could not save that rental — ' + sbErrText(error), true); return false; }
  return true;
}
async function deleteRentalRemote(id) {
  const { error } = await sb.from('vendor_rentals').delete().eq('id', id);
  if (error) { console.error(error); showToast('Could not delete that rental — ' + sbErrText(error), true); return false; }
  return true;
}

/* ---------------- yearly helpers ---------------- */
function daysToEnd(r) { return r.dateTo ? daysBetween(todayStr(), r.dateTo) : null; }
function endingSoon(r) { const d = daysToEnd(r); return r.term === 'yearly' && d !== null && d >= 0 && d <= RENEWAL_WARNING_DAYS; }
// The same supplier's previous yearly contract for the same equipment (latest one that started earlier).
function previousContract(r) {
  const key = x => x.supplier.trim().toLowerCase();
  return rentalsList
    .filter(x => x.id !== r.id && x.term === 'yearly' && x.equipment === r.equipment && key(x) === key(r) && x.dateFrom && r.dateFrom && x.dateFrom < r.dateFrom)
    .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom))[0] || null;
}

function runRentalNotificationCheck() {
  let log = {};
  try { log = JSON.parse(localStorage.getItem(RENTAL_NOTIFY_LOG_KEY)) || {}; } catch (e) { /* storage blocked */ }
  const today = todayStr();
  let changed = false;
  rentalsList.filter(endingSoon).forEach(r => {
    if (log[r.id] === today) return;             // at most once per rental per day
    log[r.id] = today; changed = true;
    const d = daysToEnd(r);
    pushNotification(`Rental contract "${r.supplier}" (${EQUIPMENT_LABELS[r.equipment]}) ends ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`} (${fmtDate(r.dateTo)}) — time to review the renewal.`);
  });
  if (changed) try { localStorage.setItem(RENTAL_NOTIFY_LOG_KEY, JSON.stringify(log)); } catch (e) { /* ignore */ }
}
setInterval(() => { if (canSee('rentals')) runRentalNotificationCheck(); }, 60 * 60 * 1000);

/* ---------------- tabs ---------------- */
function visibleRentals() {
  const list = rentalsList.filter(r => r.term === rentalView.term);
  if (rentalView.type === 'all') return list;
  if (rentalView.type === 'screens') return list.filter(r => r.equipment.startsWith('screen_') && (!rentalView.screen || r.equipment === rentalView.screen));
  return list.filter(r => r.equipment === rentalView.type);
}
document.getElementById('rentalTermTabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  rentalView.term = b.dataset.term;
  if (rentalView.term === 'yearly' && rentalView.type === 'screens') rentalView.type = 'all';
  renderRentalsPage();
});
document.getElementById('rentalTypeTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-type]'); if (!b) return;
  rentalView.type = b.dataset.type;
  renderRentalsPage();
});
document.getElementById('rentalScreenSelect').addEventListener('change', e => { rentalView.screen = e.target.value; renderRentalsPage(); });

/* ---------------- render ---------------- */
function renderRentalTotals(list) {
  const box = document.getElementById('rentalTotals');
  const cur = rentalYear();
  if (rentalView.term === 'yearly') {
    const thisYear = list.filter(r => r.dateFrom && Number(r.dateFrom.slice(0, 4)) === cur);
    const sum = xs => xs.reduce((s, r) => s + (r.annual || 0), 0);
    const billed = thisYear.filter(r => r.billed), notBilled = thisYear.filter(r => !r.billed);
    const soon = list.filter(endingSoon).length;
    box.innerHTML = `<div class="rental-summary">
      <span class="rs-item">Contracts starting in ${cur}: <strong>${thisYear.length}</strong> · <strong>${money2(sum(thisYear))}</strong></span>
      <span class="rs-item">Billed: <strong>${billed.length}</strong> · <strong>${money2(sum(billed))}</strong></span>
      <span class="rs-item">Not billed: <strong style="color:${notBilled.length ? 'var(--brick)' : 'inherit'}">${notBilled.length}</strong> · <strong>${money2(sum(notBilled))}</strong></span>
      ${soon ? `<span class="badge warn">${soon} ending within ${RENEWAL_WARNING_DAYS} days</span>` : ''}
    </div>`;
  } else {
    const prevT = list.reduce((s, r) => s + rentalYearTotal(r, cur - 1), 0);
    const curT = list.reduce((s, r) => s + rentalYearTotal(r, cur), 0);
    const sig = rentalSignal(prevT, curT);
    box.innerHTML = `<div class="rental-summary">
      <span class="rs-item">${list.length} rental${list.length === 1 ? '' : 's'}</span>
      <span class="rs-item">${cur - 1}: <strong>${money2(prevT)}</strong></span>
      <span class="rs-item">${cur}: <strong>${money2(curT)}</strong></span>
      <span class="badge ${sig.cls}">${sig.label}</span>
    </div>`;
  }
}

const RENTAL_ICON = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
};

function yearlyCardHtml(r) {
  const open = expandedRentalIds.has(r.id);
  const prev = previousContract(r);
  const sig = prev ? rentalSignal(prev.annual || 0, r.annual || 0) : null;
  const d = daysToEnd(r);
  const status = endingSoon(r) ? `<span class="badge warn">Ending soon</span>` : (d !== null && d < 0 ? '<span class="badge inactive">Ended</span>' : '');
  return `
    <div class="sellout ${open ? 'open' : ''} ${endingSoon(r) ? 'needs-action flag-warn' : ''}" data-rental-id="${escapeHtml(r.id)}">
      <div class="sellout-head" data-role="toggle-rental">
        <span class="chev">${RENTAL_ICON.chev}</span>
        <div class="who">
          <div class="name">${escapeHtml(r.supplier)}${r.gondola ? ' — ' + escapeHtml(r.gondola) : ''}</div>
          <div class="dates">${r.dateFrom ? fmtDate(r.dateFrom) : '—'} → ${r.dateTo ? fmtDate(r.dateTo) : '—'}</div>
        </div>
        <div class="rental-summary">
          <span class="badge inactive">${EQUIPMENT_LABELS[r.equipment]}</span>
          ${status}
          <span class="rs-item">Annual: <strong>${r.annual === null ? '—' : money2(r.annual)}</strong></span>
          ${sig ? `<span class="badge ${sig.cls}" title="Compared with the ${fmtDate(prev.dateFrom)} contract (${money2(prev.annual)})">${sig.label}</span>` : ''}
        </div>
        <label class="switch" title="${r.billed ? 'Billed' + (r.billedAt ? ' on ' + fmtDate(r.billedAt) : '') : 'Not billed yet'}">
          <input type="checkbox" data-role="billed-toggle" ${r.billed ? 'checked' : ''}>
          <span class="track"></span>
        </label>
        <span class="rental-billed-label ${r.billed ? 'is-billed' : ''}">${r.billed ? 'Billed' : 'Not billed'}</span>
        <div class="icon-actions">
          <button class="icon-btn" data-role="edit-rental" title="Edit" aria-label="Edit">${RENTAL_ICON.edit}</button>
          <button class="icon-btn danger" data-role="delete-rental" title="Delete" aria-label="Delete">${RENTAL_ICON.del}</button>
        </div>
      </div>
      <div class="sellout-body">
        <table class="rental-year-table rental-details">
          <tbody>
            <tr><td>Equipment</td><td>${EQUIPMENT_LABELS[r.equipment]}</td></tr>
            <tr><td>Contract</td><td>${r.dateFrom ? fmtDate(r.dateFrom) : '—'} → ${r.dateTo ? fmtDate(r.dateTo) : '—'}${d !== null && d >= 0 ? ` (${d} day${d === 1 ? '' : 's'} left)` : ''}</td></tr>
            <tr><td>Annual amount</td><td>${r.annual === null ? '—' : money2(r.annual)}</td></tr>
            <tr><td>Billed</td><td>${r.billed ? 'Yes' + (r.billedAt ? ', on ' + fmtDate(r.billedAt) : '') : 'Not yet'}</td></tr>
            <tr><td>Previous contract</td><td>${prev ? `${fmtDate(prev.dateFrom)} → ${prev.dateTo ? fmtDate(prev.dateTo) : '—'} · ${money2(prev.annual)}` : 'None on record'}</td></tr>
          </tbody>
        </table>
        ${r.note ? `<p class="rental-note">${escapeHtml(r.note)}</p>` : ''}
      </div>
    </div>`;
}

function otherCardHtml(r) {
  const open = expandedRentalIds.has(r.id);
  const cur = rentalYear(), prevYear = cur - 1;
  const prevTotal = rentalYearTotal(r, prevYear), curTotal = rentalYearTotal(r, cur);
  const signal = rentalSignal(prevTotal, curTotal);
  const yearTable = y => `
    <table class="rental-year-table">
      <thead><tr><th>${y}</th>${RENTAL_MONTH_NAMES.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
      <tbody><tr><td>Amount</td>${RENTAL_MONTH_NAMES.map((m, i) => `<td>${money2(r.monthly[monthlyKey(y, i)])}</td>`).join('')}<td><strong>${money2(rentalYearTotal(r, y))}</strong></td></tr></tbody>
    </table>`;
  const screenBadge = r.equipment === 'screen_wall' ? '<span class="badge inactive">Wall</span>' : r.equipment === 'screen_island' ? '<span class="badge inactive">Island</span>'
    : `<span class="badge inactive">${EQUIPMENT_LABELS[r.equipment]}</span>`;
  return `
    <div class="sellout ${open ? 'open' : ''}" data-rental-id="${escapeHtml(r.id)}">
      <div class="sellout-head" data-role="toggle-rental">
        <span class="chev">${RENTAL_ICON.chev}</span>
        <div class="who">
          <div class="name">${escapeHtml(r.supplier)}${r.gondola ? ' — ' + escapeHtml(r.gondola) : ''}</div>
          <div class="dates">${r.dateFrom ? fmtDate(r.dateFrom) : '—'} → ${r.dateTo ? fmtDate(r.dateTo) : '—'}</div>
        </div>
        <div class="rental-summary">
          ${screenBadge}
          <span class="rs-item">${prevYear}: <strong>${money2(prevTotal)}</strong></span>
          <span class="rs-item">${cur}: <strong>${money2(curTotal)}</strong></span>
          <span class="badge ${signal.cls}">${signal.label}</span>
        </div>
        <div class="icon-actions">
          <button class="icon-btn" data-role="edit-rental" title="Edit" aria-label="Edit">${RENTAL_ICON.edit}</button>
          <button class="icon-btn danger" data-role="delete-rental" title="Delete" aria-label="Delete">${RENTAL_ICON.del}</button>
        </div>
      </div>
      <div class="sellout-body">
        ${yearTable(prevYear)}
        ${yearTable(cur)}
        ${r.note ? `<p class="rental-note">${escapeHtml(r.note)}</p>` : ''}
      </div>
    </div>`;
}

function renderRentalsPage() {
  document.querySelectorAll('#rentalTermTabs button').forEach(b => b.classList.toggle('active', b.dataset.term === rentalView.term));
  document.querySelectorAll('#rentalTypeTabs button[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === rentalView.type));
  document.querySelectorAll('#rentalTypeTabs [data-only-term]').forEach(b => { b.hidden = b.dataset.onlyTerm !== rentalView.term; });
  document.getElementById('rentalScreenFilter').hidden = !(rentalView.term === 'other' && rentalView.type === 'screens');
  document.getElementById('rentalScreenSelect').value = rentalView.screen;

  const list = visibleRentals().slice().sort((a, b) =>
    (rentalView.term === 'yearly' ? (endingSoon(b) - endingSoon(a)) : 0) || a.supplier.localeCompare(b.supplier) || (b.dateFrom || '').localeCompare(a.dateFrom || ''));
  renderRentalTotals(list);

  const container = document.getElementById('rentalList');
  container.innerHTML = list.map(r => rentalView.term === 'yearly' ? yearlyCardHtml(r) : otherCardHtml(r)).join('');
  document.getElementById('rentalEmpty').style.display = list.length ? 'none' : 'block';
  document.getElementById('rentalEmptyTitle').textContent = rentalsList.length ? 'No rentals in this tab' : 'No rentals yet';

  container.querySelectorAll('[data-rental-id]').forEach(el => {
    const id = el.dataset.rentalId;
    const r = rentalsList.find(x => x.id === id);
    el.querySelector('[data-role="toggle-rental"]').addEventListener('click', ev => {
      if (ev.target.closest('.icon-actions') || ev.target.closest('.switch')) return;
      if (expandedRentalIds.has(id)) expandedRentalIds.delete(id); else expandedRentalIds.add(id);
      renderRentalsPage();
    });
    el.querySelector('[data-role="edit-rental"]').addEventListener('click', ev => { ev.stopPropagation(); openRentalForm(id); });
    el.querySelector('[data-role="delete-rental"]').addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!(await showConfirm(`Delete the rental for "${r.supplier}"?`, 'Delete'))) return;
      if (!(await deleteRentalRemote(id))) return;
      rentalsList = rentalsList.filter(x => x.id !== id);
      logActivity('rentals', 'delete', { type: 'rental', id }, `Deleted ${r.term} rental "${r.supplier}"${r.gondola ? ' — ' + r.gondola : ''}`, rentalRow(r));
      renderRentalsPage();
      showToast('Rental deleted.');
    });
    el.querySelector('[data-role="billed-toggle"]')?.addEventListener('change', async ev => {
      ev.stopPropagation();
      const on = ev.target.checked;
      const before = { billed: r.billed, billedAt: r.billedAt };
      r.billed = on;
      r.billedAt = on ? (r.billedAt || todayStr()) : '';
      if (!(await saveRentalRemote(r))) { Object.assign(r, before); renderRentalsPage(); return; }
      logActivity('rentals', on ? 'billed' : 'unbilled', { type: 'rental', id }, `${r.supplier} (${EQUIPMENT_LABELS[r.equipment]}) marked ${on ? 'billed' : 'not billed'}`, { annual: r.annual, billed_at: r.billedAt || null });
      renderRentalsPage();
      showToast(on ? `Marked billed on ${fmtDate(r.billedAt)}.` : 'Marked not billed.');
    });
  });
}

/* ---------------- form ---------------- */
function syncRentalFormTerm() {
  const term = document.getElementById('rentalTerm').value;
  const eq = document.getElementById('rentalEquipment');
  const keep = eq.value;
  eq.innerHTML = TERM_EQUIPMENT[term].map(v => `<option value="${v}">${EQUIPMENT_LABELS[v]}</option>`).join('');
  eq.value = TERM_EQUIPMENT[term].includes(keep) ? keep : TERM_EQUIPMENT[term][0];
  document.querySelectorAll('#rentalFormCard [data-term-only]').forEach(x => { x.hidden = x.dataset.termOnly !== term; });
  document.getElementById('rentalDateFromLabel').textContent = term === 'yearly' ? 'Contract start' : 'Date from';
  document.getElementById('rentalDateToLabel').textContent = term === 'yearly' ? 'Contract end' : 'Date to';
  document.getElementById('rentalBilledAt').disabled = !document.getElementById('rentalBilled').checked;
}
document.getElementById('rentalTerm').addEventListener('change', syncRentalFormTerm);
document.getElementById('rentalBilled').addEventListener('change', e => {
  const at = document.getElementById('rentalBilledAt');
  if (e.target.checked && !at.value) at.value = todayStr();
  syncRentalFormTerm();
});

function openRentalForm(id) {
  editingRentalId = id || null;
  const r = id ? rentalsList.find(x => x.id === id) : null;
  const cur = rentalYear(), prevYear = cur - 1;
  const el = x => document.getElementById(x);
  el('rentalFormTitle').textContent = r ? 'Edit rental' : 'Add rental';
  el('saveRentalBtn').textContent = r ? 'Save changes' : 'Add rental';
  el('rentalTerm').value = r ? r.term : rentalView.term;
  el('rentalEquipment').innerHTML = '';
  syncRentalFormTerm();
  const defaultType = rentalView.type === 'screens' ? (rentalView.screen || 'screen_wall') : rentalView.type === 'all' ? 'gondola' : rentalView.type;
  el('rentalEquipment').value = r ? r.equipment : (TERM_EQUIPMENT[el('rentalTerm').value].includes(defaultType) ? defaultType : TERM_EQUIPMENT[el('rentalTerm').value][0]);
  el('rentalSupplier').value = r ? r.supplier : '';
  el('rentalGondola').value = r ? r.gondola : '';
  el('rentalDateFrom').value = r ? r.dateFrom : '';
  el('rentalDateTo').value = r ? r.dateTo : '';
  el('rentalAnnual').value = r && r.annual !== null ? String(r.annual) : '';
  el('rentalBilled').checked = r ? r.billed : false;
  el('rentalBilledAt').value = r ? r.billedAt : '';
  el('rentalNote').value = r ? r.note : '';
  el('rentalPrevYearLabel').textContent = 'Monthly amount — ' + prevYear;
  el('rentalCurYearLabel').textContent = 'Monthly amount — ' + cur;
  el('rentalPrevYearGrid').innerHTML = buildMonthGridHtml(prevYear);
  el('rentalCurYearGrid').innerHTML = buildMonthGridHtml(cur);
  if (r) {
    document.querySelectorAll('#rentalPrevYearGrid .rental-month-input, #rentalCurYearGrid .rental-month-input').forEach(inp => {
      const v = r.monthly[inp.dataset.mkey];
      inp.value = v ? String(v) : '';
    });
  }
  syncRentalFormTerm();
  el('rentalFormCard').style.display = 'block';
  el('rentalFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  el('rentalSupplier').focus();
}
function closeRentalForm() {
  editingRentalId = null;
  document.getElementById('rentalFormCard').style.display = 'none';
}
document.getElementById('addRentalBtn').addEventListener('click', () => openRentalForm(null));
document.getElementById('cancelRentalFormBtn').addEventListener('click', closeRentalForm);

document.getElementById('saveRentalBtn').addEventListener('click', async () => {
  const el = x => document.getElementById(x);
  const supplier = el('rentalSupplier').value.trim();
  if (!supplier) { showToast('Enter a supplier name.', true); return; }
  const term = el('rentalTerm').value;
  const dateFrom = el('rentalDateFrom').value || '';
  const dateTo = el('rentalDateTo').value || '';
  if (dateFrom && dateTo && dateTo < dateFrom) { showToast('The end date is before the start date.', true); return; }
  const existing = editingRentalId ? rentalsList.find(x => x.id === editingRentalId) : null;
  const monthly = existing ? Object.assign({}, existing.monthly) : {};
  let annual = null;
  if (term === 'yearly') {
    if (!dateFrom || !dateTo) { showToast('A yearly contract needs a start and an end date.', true); return; }
    annual = parseNum(el('rentalAnnual').value);
    if (annual === null || annual < 0) { showToast('Enter the annual amount.', true); return; }
  } else {
    document.querySelectorAll('#rentalPrevYearGrid .rental-month-input, #rentalCurYearGrid .rental-month-input').forEach(inp => {
      monthly[inp.dataset.mkey] = parseNum(inp.value) ?? 0;
    });
  }
  const billed = term === 'yearly' && el('rentalBilled').checked;
  const rental = {
    id: editingRentalId || uid(), supplier, term,
    equipment: el('rentalEquipment').value,
    gondola: el('rentalGondola').value.trim(),
    dateFrom, dateTo, monthly, annual,
    billed, billedAt: billed ? (el('rentalBilledAt').value || todayStr()) : '',
    note: el('rentalNote').value.trim(),
  };
  const wasEditing = editingRentalId;
  if (!(await saveRentalRemote(rental))) return;
  if (wasEditing) {
    const changed = {};
    ['supplier', 'term', 'equipment', 'gondola', 'dateFrom', 'dateTo', 'annual', 'billed', 'billedAt', 'note'].forEach(k => {
      if (String(existing[k] ?? '') !== String(rental[k] ?? '')) changed[k] = { from: existing[k] ?? null, to: rental[k] ?? null };
    });
    if (term === 'other' && JSON.stringify(existing.monthly) !== JSON.stringify(rental.monthly)) changed.monthly = true;
    if (Object.keys(changed).length) logActivity('rentals', 'edit', { type: 'rental', id: rental.id }, `Edited rental "${supplier}"`, { changed });
    const idx = rentalsList.findIndex(x => x.id === wasEditing);
    if (idx > -1) rentalsList[idx] = rental; else rentalsList.push(rental);
  } else {
    rentalsList.push(rental);
    logActivity('rentals', 'create', { type: 'rental', id: rental.id }, `Added ${term} rental "${supplier}" (${EQUIPMENT_LABELS[rental.equipment]})`, rentalRow(rental));
  }
  // Show the tab the rental lives in.
  rentalView.term = term;
  if (rentalView.type !== 'all') rentalView.type = rental.equipment.startsWith('screen_') ? 'screens' : rental.equipment;
  closeRentalForm();
  renderRentalsPage();
  showToast(wasEditing ? 'Rental updated.' : 'Rental added.');
});

/* ---------------- Excel import ---------------- */
// Optional "Term" and "Type" columns; anything missing or unknown -> other + gondola (PLAN §7.2).
function parseRentalTerm(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /year|annual|annuel/.test(s) ? 'yearly' : 'other';
}
function parseRentalType(v, term) {
  const s = String(v ?? '').trim().toLowerCase();
  let t = 'gondola';
  if (/island/.test(s)) t = 'screen_island';
  else if (/wall|screen/.test(s)) t = 'screen_wall';
  else if (/basket/.test(s)) t = 'basket_side';
  else if (/pillar/.test(s)) t = 'pillar';
  else if (/side/.test(s)) t = 'side_gondola';
  return TERM_EQUIPMENT[term].includes(t) ? t : 'gondola';
}

document.getElementById('importRentalsBtn').addEventListener('click', () => document.getElementById('rentalFileInput').click());
document.getElementById('rentalFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  let wb;
  try { wb = XLSX.read(buf, { type: 'array' }); }
  catch (err) { showToast('Could not read that file — check the format.', true); e.target.value = ''; return; }

  const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'rentals') || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  if (!rows.length) { showToast('That sheet has no rows.', true); e.target.value = ''; return; }

  const headerKeys = Object.keys(rows[0]);
  const supplierKey = findVendorHeaderKey(headerKeys, ['supplier', 'vendor', 'name']);
  const gondolaKey = findVendorHeaderKey(headerKeys, ['gondola', 'description', 'item']);
  const fromKey = findVendorHeaderKey(headerKeys, ['date from', 'from', 'start date', 'contract start', 'start']);
  const toKey = findVendorHeaderKey(headerKeys, ['date to', 'to', 'end date', 'contract end', 'end']);
  const termKey = findVendorHeaderKey(headerKeys, ['term', 'rental term']);
  const typeKey = findVendorHeaderKey(headerKeys, ['type', 'equipment']);
  const annualKey = findVendorHeaderKey(headerKeys, ['annual amount', 'annual', 'yearly amount']);
  const noteKey = findVendorHeaderKey(headerKeys, ['note', 'notes', 'remark']);
  if (!supplierKey) { showToast('Could not find a supplier column in that file.', true); e.target.value = ''; return; }

  const monthKeysByHeader = {};
  headerKeys.forEach(h => { const mk = parseMonthYearHeader(h); if (mk) monthKeysByHeader[h] = mk; });
  const toDate = raw => (raw && !isNaN(Date.parse(raw))) ? localDateStr(new Date(raw)) : '';

  const parsed = [];
  rows.forEach(row => {
    const supplier = String(row[supplierKey] ?? '').trim();
    if (!supplier) return;
    const term = termKey ? parseRentalTerm(row[termKey]) : 'other';
    const monthly = {};
    Object.keys(monthKeysByHeader).forEach(h => { monthly[monthKeysByHeader[h]] = parseNum(row[h]) ?? 0; });
    parsed.push({
      id: uid(), supplier, term,
      equipment: typeKey ? parseRentalType(row[typeKey], term) : 'gondola',
      gondola: gondolaKey ? String(row[gondolaKey] ?? '').trim() : '',
      dateFrom: fromKey ? toDate(String(row[fromKey] ?? '').trim()) : '',
      dateTo: toKey ? toDate(String(row[toKey] ?? '').trim()) : '',
      monthly, annual: term === 'yearly' && annualKey ? parseNum(row[annualKey]) : null,
      billed: false, billedAt: '', note: noteKey ? String(row[noteKey] ?? '').trim() : '',
    });
  });

  if (!parsed.length) { showToast('No rental rows found to import.', true); e.target.value = ''; return; }

  for (let i = 0; i < parsed.length; i += 500) {
    const { error } = await sb.from('vendor_rentals').insert(parsed.slice(i, i + 500).map(rentalRow));
    if (error) { console.error(error); showToast('Rental import failed partway — ' + sbErrText(error), true); e.target.value = ''; await loadRentalsData(); renderRentalsPage(); return; }
  }
  const yearly = parsed.filter(r => r.term === 'yearly').length;
  logActivity('rentals', 'import', { type: 'rental', id: null }, `Imported ${parsed.length} rentals from ${file.name}`, { yearly, other: parsed.length - yearly });
  e.target.value = '';
  await loadRentalsData();
  renderRentalsPage();
  showToast(`Imported ${parsed.length} rental${parsed.length === 1 ? '' : 's'}` + (yearly ? ` (${yearly} yearly).` : '.'));
});
