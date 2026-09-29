/* ============================================================
   Rentals (store-map/WIRING.md, replaces the list-only PLAN §7):
   the store map is the place where rentals live. Every contract sits
   on a spot of the map (gondola, end cap, basket side, pillar, screen…);
   the List view shows the same contracts as a list, read from the map.
   - Map view: store-map/store-map.js, data through the Supabase adapter.
   - List view: filters by billing term and spot type, sales history with
     the renew / review signal (old rentals' monthly figures are the
     supplier's sales, owner 2026-09-29), "Show on map" / "Place on map".
   - Renewal reminders on the bell, once a day per contract.
   Admin only (RLS in supabase/migrations/012_store_map.sql).
   ============================================================ */
const Rentals = (function () {
  const RENEWAL_WARNING_DAYS = 30;
  const NOTIFY_LOG_KEY = 'lv:rentalNotifyLog';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const S = { adapter: null, map: null, view: 'map', term: 'all', type: 'all', q: '', expanded: new Set(), contracts: [], vendorNames: [] };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const money = n => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const today = () => beirutToday();

  function adapter() {
    if (!S.adapter) S.adapter = StoreMapSupabaseAdapter(sb, { userName: Session.profile?.display_name || Session.profile?.username || null, bucket: 'store-maps' });
    return S.adapter;
  }

  /* ---------------- start (after sign-in) and show ---------------- */
  // Reminders need only the contracts, so they run without opening the page.
  async function start() {
    try { S.contracts = await adapter().listContracts(); }
    catch (e) { console.error('Rentals: could not load contracts', e); return; }
    runReminders();
    setInterval(async () => {
      try { if (!S.map) S.contracts = await adapter().listContracts(); runReminders(); } catch (e) { /* next time */ }
    }, 60 * 60 * 1000);
  }

  async function show() {
    renderTabs();
    if (!S.map) await mountMap();
    renderList();
  }

  // Supplier names offered in the contract form: the Vendors list (owner, 2026-09-29).
  async function loadVendorNames() {
    const { data, error } = await sb.from('vendors').select('name').order('name');
    if (error) { console.warn('Rentals: vendors list not available', error.message); return; }
    const seen = new Set();
    S.vendorNames = (data || []).map(v => String(v.name || '').trim())
      .filter(n => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  }

  async function mountMap() {
    const box = el('rentalsMap');
    await loadVendorNames();
    try {
      // Only someone who may edit the layout fills an empty map from the traced plan.
      if (can('rentals.layout')) await adapter().seedIfEmpty(window.STORE_MAP_SEED, [{ id: 'mezzanine', name: 'Mezzanine', width: 3000, height: 2000, sort: 2 }]);
    } catch (e) {
      console.error(e);
      box.innerHTML = `<div class="empty-state"><p class="big">The store map is not set up yet</p><p>${esc(friendlyError(e))}</p></div>`;
      return;
    }
    S.map = StoreMap.mount(box, {
      adapter: adapter(),
      canEdit: can('rentals.layout'),
      canManageRentals: can('rentals.contracts'),
      currency: '$',
      today,
      toast: (msg, isError) => showToast(msg, isError),
      confirm: (msg, okLabel) => showConfirm(msg, okLabel),
      onActivity: (action, summary, details) => {
        const { sales, ...rest } = details || {};                 // keep the log light
        logActivity('rentals', action, { type: 'rental', id: rest.id || null }, summary, rest);
        S.contracts = S.map.contracts;
        renderList();
      },
      onLoad: () => { S.contracts = S.map.contracts; renderList(); },
      suppliers: () => S.vendorNames,
    });
    await S.map.ready;
  }

  /* ---------------- full screen map ---------------- */
  // The map view covers the whole page (sidebar and header included); Esc or the button closes it.
  function setExpanded(on) {
    document.body.classList.toggle('rentals-map-expanded', on);
    const btn = el('rentalMapExpand');
    btn.setAttribute('aria-pressed', String(on));
    btn.querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
    btn.title = on ? 'Back to the page (Esc)' : 'Show the map on the whole screen (Esc to close)';
    if (S.map) requestAnimationFrame(() => S.map.fit());
  }
  el('rentalMapExpand').addEventListener('click', () => setExpanded(!document.body.classList.contains('rentals-map-expanded')));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !document.body.classList.contains('rentals-map-expanded')) return;
    if (document.querySelector('#modalOverlay.open')) return;   // a confirm dialog is open: leave full screen alone
    setExpanded(false);
  });

  /* ---------------- tabs ---------------- */
  function renderTabs() {
    document.querySelectorAll('#rentalViewTabs [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
    el('rentalMapView').hidden = S.view !== 'map';
    if (S.view !== 'map' && document.body.classList.contains('rentals-map-expanded')) setExpanded(false);
    el('rentalListView').hidden = S.view !== 'list';
  }
  el('rentalViewTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    S.view = b.dataset.view;
    renderTabs();
    if (S.view === 'list') renderList();
  });
  el('rentalTermTabs').addEventListener('click', e => { const b = e.target.closest('[data-term]'); if (b) { S.term = b.dataset.term; renderList(); } });
  el('rentalTypeTabs').addEventListener('click', e => { const b = e.target.closest('[data-type]'); if (b) { S.type = b.dataset.type; renderList(); } });
  el('rentalSearch').addEventListener('input', e => { S.q = e.target.value.trim().toLowerCase(); renderList(); });

  /* ---------------- contract facts ---------------- */
  function spotOf(c) {
    if (!S.map || !c.spotId) return null;
    const f = S.map.findObject(c.spotId);
    if (!f) return null;
    const floor = S.map.floors.find(x => x.id === f.floorId);
    return { o: f.o, type: S.map.typeOf(f.o), floor, near: S.map.nearLabel(Object.assign({ _floor: f.floorId }, f.o)) };
  }
  // A later contract on the same spot (or, when not placed, for the same supplier) = already renewed.
  function renewed(c) {
    return S.contracts.some(x => x.id !== c.id && x.start > c.end &&
      (c.spotId ? x.spotId === c.spotId : x.supplier.trim().toLowerCase() === c.supplier.trim().toLowerCase()));
  }
  function statusOf(c) {
    const t = today();
    if (c.end < t) return renewed(c) ? 'renewed' : 'expired';
    if (c.start > t) return 'upcoming';
    if (daysBetween(t, c.end) <= RENEWAL_WARNING_DAYS && !renewed(c)) return 'ending';
    if (!c.billed) return 'unbilled';
    return 'rented';
  }
  const STATUS = {
    ending: { label: 'Ending soon', cls: 'warn' }, unbilled: { label: 'Not billed', cls: 'danger' }, rented: { label: 'Active', cls: 'active' },
    upcoming: { label: 'Starts later', cls: 'inactive' }, expired: { label: 'Ended, not renewed', cls: 'danger' }, renewed: { label: 'Ended · renewed', cls: 'inactive' },
  };
  const salesTotal = (c, year) => { let s = 0; for (let i = 0; i < 12; i++) s += Number((c.sales || {})[`${year}-${String(i + 1).padStart(2, '0')}`] || 0); return s; };
  const hasSales = c => c.sales && Object.values(c.sales).some(v => Number(v));
  function salesSignal(prev, cur) {
    if (!prev) return cur > 0 ? { label: 'New', cls: 'warn' } : null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct >= 0) return { label: `Sales +${pct}% · Recommend renewal`, cls: 'active' };
    if (pct <= -15) return { label: `Sales ${pct}% · Review`, cls: 'danger' };
    return { label: `Sales ${pct}%`, cls: 'warn' };
  }

  /* ---------------- list ---------------- */
  function typeKeyOf(c) { const s = spotOf(c); return s ? s.o.type : 'unplaced'; }
  function renderList() {
    if (el('rentalListView').hidden && S.view !== 'list') return;
    const all = S.contracts.slice();
    const cur = Number(today().slice(0, 4));
    // Type chips: the spot types that have contracts, plus "Not placed".
    const counts = {};
    all.forEach(c => { const k = typeKeyOf(c); counts[k] = (counts[k] || 0) + 1; });
    const typeName = k => k === 'unplaced' ? 'Not placed on the map' : (S.map?.types[k]?.name || k);
    if (S.type !== 'all' && !counts[S.type]) S.type = 'all';
    el('rentalTypeTabs').innerHTML = `<button data-type="all" class="${S.type === 'all' ? 'active' : ''}">All types <span class="muted-note">${all.length}</span></button>` +
      Object.keys(counts).sort((a, b) => (a === 'unplaced') - (b === 'unplaced') || typeName(a).localeCompare(typeName(b)))
        .map(k => `<button data-type="${esc(k)}" class="${S.type === k ? 'active' : ''}">${esc(typeName(k))} <span class="muted-note">${counts[k]}</span></button>`).join('');
    document.querySelectorAll('#rentalTermTabs [data-term]').forEach(b => b.classList.toggle('active', b.dataset.term === S.term));

    const list = all.filter(c => (S.term === 'all' || c.term === S.term) && (S.type === 'all' || typeKeyOf(c) === S.type)
      && (!S.q || [c.supplier, c.legacyLabel, c.note, spotOf(c)?.o.label].join(' ').toLowerCase().includes(S.q)));
    const rank = { ending: 0, unbilled: 1, expired: 2, rented: 3, upcoming: 4, renewed: 5 };
    list.sort((a, b) => rank[statusOf(a)] - rank[statusOf(b)] || a.supplier.localeCompare(b.supplier) || (b.start || '').localeCompare(a.start || ''));

    // Totals for what is shown.
    const t = today();
    const active = list.filter(c => c.start <= t && c.end >= t);
    const income = y => list.reduce((s, c) => s + (S.map ? S.map.revenueInYear(c, y) : 0), 0);
    const unplaced = list.filter(c => !spotOf(c) && c.end >= t).length;
    el('rentalTotals').innerHTML = `<div class="rental-summary">
      <span class="rs-item">Active contracts: <strong>${active.length}</strong></span>
      <span class="rs-item">Rental income ${cur}: <strong>${money(income(cur))}</strong></span>
      <span class="rs-item">${cur - 1}: <strong>${money(income(cur - 1))}</strong></span>
      <span class="rs-item">Not billed: <strong style="color:${active.some(c => !c.billed) ? 'var(--brick)' : 'inherit'}">${active.filter(c => !c.billed).length}</strong></span>
      ${list.some(c => statusOf(c) === 'ending') ? `<span class="badge warn">${list.filter(c => statusOf(c) === 'ending').length} ending within ${RENEWAL_WARNING_DAYS} days</span>` : ''}
      ${unplaced ? `<span class="badge inactive">${unplaced} not placed on the map</span>` : ''}
    </div>`;

    el('rentalList').innerHTML = list.map(cardHtml).join('');
    el('rentalEmpty').style.display = list.length ? 'none' : 'block';
    el('rentalEmptyTitle').textContent = all.length ? 'No contracts match' : 'No rental contracts yet';
  }

  function cardHtml(c) {
    const open = S.expanded.has(c.id);
    const spot = spotOf(c), st = statusOf(c), cur = Number(today().slice(0, 4));
    const where = spot
      ? `${esc(spot.type.name)}${spot.o.label ? ' · ' + esc(spot.o.label) : ''}${spot.near ? ' · by ' + esc(spot.near) : ''} · ${esc(spot.floor?.name || '')}`
      : `<span style="color:var(--brick)">Not placed on the map</span>${c.legacyLabel ? ' · ' + esc(c.legacyLabel) : ''}`;
    const sig = hasSales(c) ? salesSignal(salesTotal(c, cur - 1), salesTotal(c, cur)) : null;
    const left = daysBetween(today(), c.end);
    const salesYears = [cur - 1, cur];
    return `
    <div class="sellout ${open ? 'open' : ''} ${st === 'ending' ? 'needs-action flag-warn' : ''}" data-contract="${esc(c.id)}">
      <div class="sellout-head" data-role="toggle">
        <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
        <div class="who">
          <div class="name">${esc(c.supplier)}</div>
          <div class="dates">${where}</div>
        </div>
        <div class="rental-summary">
          <span class="badge ${STATUS[st].cls}">${STATUS[st].label}</span>
          <span class="rs-item">${fmtDate(c.start)} → ${fmtDate(c.end)}</span>
          <span class="rs-item"><strong>${money(c.amount)}</strong>${c.term === 'monthly' ? '/mo' : '/yr'}</span>
          ${sig ? `<span class="badge ${sig.cls}" title="Supplier sales ${cur - 1}: ${money2s(salesTotal(c, cur - 1))} · ${cur}: ${money2s(salesTotal(c, cur))}">${sig.label}</span>` : ''}
        </div>
        <div class="icon-actions">
          ${spot ? `<button class="btn ghost small" data-role="show">Show on map</button>`
            : can('rentals.contracts') && c.end >= today() ? `<button class="btn small" data-role="place">Place on map</button>` : ''}
        </div>
      </div>
      <div class="sellout-body">
        <table class="rental-year-table rental-details"><tbody>
          <tr><td>Spot</td><td>${where}</td></tr>
          <tr><td>Billing</td><td>${c.term === 'yearly' ? 'Yearly — one amount, billed once' : 'Monthly — amount each month'}: <strong>${money(c.amount)}</strong>${c.amount ? '' : ' <span style="color:var(--brick)">(amount not set yet)</span>'}</td></tr>
          <tr><td>Period</td><td>${fmtDate(c.start)} → ${fmtDate(c.end)}${left >= 0 && c.start <= today() ? ` (${left} day${left === 1 ? '' : 's'} left)` : ''}</td></tr>
          <tr><td>Billed / paid</td><td>${c.billed ? 'Billed' + (c.billedAt ? ' ' + fmtDate(c.billedAt) : '') : 'Not billed'} · ${c.paid ? 'Paid' + (c.paidAt ? ' ' + fmtDate(c.paidAt) : '') : 'Not paid'}</td></tr>
          ${c.note ? `<tr><td>Note</td><td>${esc(c.note)}</td></tr>` : ''}
        </tbody></table>
        <p class="muted-note" style="margin:10px 0 6px;">Supplier sales (for the renew / review decision)${can('rentals.contracts') ? ' — type the figures, then Save sales' : ''}. Edit the contract itself on the map.</p>
        ${salesYears.map(y => `
          <table class="rental-year-table">
            <thead><tr><th>${y}</th>${MONTHS.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody><tr><td>Sales</td>${MONTHS.map((m, i) => {
              const k = `${y}-${String(i + 1).padStart(2, '0')}`, v = (c.sales || {})[k];
              return `<td>${can('rentals.contracts') ? `<input type="text" inputmode="decimal" class="rental-sales-input" data-mkey="${k}" value="${v ? esc(String(v)) : ''}" placeholder="0">` : money2s(v)}</td>`;
            }).join('')}<td><strong>${money2s(salesTotal(c, y))}</strong></td></tr></tbody>
          </table>`).join('')}
        ${can('rentals.contracts') ? `<div class="actions-row" style="justify-content:flex-start;"><button class="btn small secondary" data-role="save-sales">Save sales</button></div>` : ''}
      </div>
    </div>`;
  }
  const money2s = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

  el('rentalList').addEventListener('click', async e => {
    const card = e.target.closest('[data-contract]'); if (!card) return;
    const c = S.contracts.find(x => x.id === card.dataset.contract); if (!c) return;
    if (e.target.closest('[data-role="show"]')) { e.stopPropagation(); return goToMap(() => S.map.focusSpot(c.spotId)); }
    if (e.target.closest('[data-role="place"]')) { e.stopPropagation(); return goToMap(() => S.map.startAssign(c.id)); }
    if (e.target.closest('[data-role="save-sales"]')) return saveSales(c, card);
    if (e.target.closest('[data-role="toggle"]') && !e.target.closest('.icon-actions')) {
      S.expanded.has(c.id) ? S.expanded.delete(c.id) : S.expanded.add(c.id);
      renderList();
    }
  });
  function goToMap(then) {
    // (keeps full screen as it is)
    S.view = 'map';
    renderTabs();
    requestAnimationFrame(() => { then(); el('rentalMapView').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  async function saveSales(c, card) {
    const sales = Object.assign({}, c.sales || {});
    for (const inp of card.querySelectorAll('.rental-sales-input')) {
      const raw = inp.value.trim();
      const n = raw === '' ? 0 : parseNum(raw);
      if (n === null || n < 0) { showToast('Sales must be numbers.', true); inp.focus(); return; }
      if (n) sales[inp.dataset.mkey] = n; else delete sales[inp.dataset.mkey];
    }
    const { error } = await sb.from('rental_contracts').update({ monthly_sales: Object.keys(sales).length ? sales : null, updated_at: new Date().toISOString() }).eq('id', c.id);
    if (error) { console.error(error); showToast('Could not save the sales — ' + friendlyError(error), true); return; }
    c.sales = Object.keys(sales).length ? sales : null;
    logActivity('rentals', 'sales', { type: 'rental', id: c.id }, `Updated sales figures for ${c.supplier}`);
    renderList();
    showToast('Sales saved.');
  }

  /* ---------------- renewal reminders (bell) ---------------- */
  function runReminders() {
    let log = {};
    try { log = JSON.parse(localStorage.getItem(NOTIFY_LOG_KEY)) || {}; } catch (e) { /* storage blocked */ }
    const t = today();
    let changed = false;
    S.contracts.forEach(c => {
      const d = daysBetween(t, c.end);
      if (c.start > t || d < 0 || d > RENEWAL_WARNING_DAYS || renewed(c)) return;
      if (log[c.id] === t) return;                 // at most once per contract per day
      log[c.id] = t; changed = true;
      const spot = spotOf(c);
      pushNotification(`Contract for ${c.supplier}${spot ? ` on ${spot.type.name}${spot.o.label ? ' ' + spot.o.label : ''}` : ''} ends ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`} (${fmtDate(c.end)}) — time to review the renewal.`);
    });
    if (changed) try { localStorage.setItem(NOTIFY_LOG_KEY, JSON.stringify(log)); } catch (e) { /* ignore */ }
  }

  return { start, show, get map() { return S.map; }, _state: S };
})();
