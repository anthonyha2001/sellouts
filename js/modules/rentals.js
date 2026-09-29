/* ============================================================
   Rentals (store-map/WIRING.md, replaces the list-only PLAN §7):
   the store map is the place where rentals live. Every contract sits
   on a spot of the map (gondola, end cap, basket side, pillar, screen…);
   the List view is a recap per supplier of what is assigned on the map
   (owner, 2026-09-29): "Halwani — 1 End cap · 1 Freezer — $21,000 / year".
   - Map view: store-map/store-map.js, data through the Supabase adapter.
   - List view: one card per supplier (their spots, total, billing, ending
     soon), the contracts with "Show on map" / "Place on map", and the
     supplier's monthly sales (performance, rental_supplier_sales) with the
     renew / review signal.
   - Renewal reminders on the bell, once a day per contract.
   Admin only (RLS in supabase/migrations/012_store_map.sql).
   ============================================================ */
const Rentals = (function () {
  const RENEWAL_WARNING_DAYS = 30;
  const NOTIFY_LOG_KEY = 'lv:rentalNotifyLog';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const S = { adapter: null, map: null, view: 'map', showAll: false, q: '', expanded: new Set(), contracts: [], vendorNames: [],
    sales: new Map(), salesMissing: false };   // sales: supplier key -> { supplier, monthly_sales }
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
    if (!S.map) await Promise.all([mountMap(), loadSales()]);
    renderList();
  }
  const keyOf = name => String(name || '').trim().toLowerCase();
  async function loadSales() {
    const { data, error } = await sb.from('rental_supplier_sales').select('supplier_key, supplier, monthly_sales');
    S.salesMissing = !!error;
    if (error) { console.warn('Rentals: supplier sales not available (migration 016?)', error.message); return; }
    S.sales = new Map((data || []).map(r => [r.supplier_key, r]));
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
      // The traced plan's supplier names are left out: the map starts with every spot free (owner, 2026-09-29).
      const seed = Object.fromEntries(Object.entries(window.STORE_MAP_SEED || {}).map(([k, s]) =>
        [k, { floor: s.floor, objects: s.objects.map(o => ({ ...o, occupant: '' })) }]));
      if (can('rentals.layout')) await adapter().seedIfEmpty(seed, [{ id: 'mezzanine', name: 'Mezzanine', width: 3000, height: 2000, sort: 2 }]);
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
  el('rentalShowTabs').addEventListener('click', e => { const b = e.target.closest('[data-show]'); if (b) { S.showAll = b.dataset.show === 'all'; renderList(); } });
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
  const salesTotal = (sales, year) => { let s = 0; for (let i = 0; i < 12; i++) s += Number((sales || {})[`${year}-${String(i + 1).padStart(2, '0')}`] || 0); return s; };
  const hasSales = sales => sales && Object.values(sales).some(v => Number(v));
  function salesSignal(prev, cur) {
    if (!prev) return cur > 0 ? { label: 'New', cls: 'warn' } : null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct >= 0) return { label: `Sales +${pct}% · Recommend renewal`, cls: 'active' };
    if (pct <= -15) return { label: `Sales ${pct}% · Review`, cls: 'danger' };
    return { label: `Sales ${pct}%`, cls: 'warn' };
  }

  /* ---------------- list: a recap per supplier ---------------- */
  // One entry per supplier: their contracts (current ones, or all with "All, with ended contracts").
  function recap() {
    const t = today();
    const groups = new Map();
    S.contracts.forEach(c => {
      if (!S.showAll && c.end < t) return;
      const k = keyOf(c.supplier);
      if (!groups.has(k)) groups.set(k, { key: k, name: c.supplier.trim(), contracts: [] });
      groups.get(k).contracts.push(c);
    });
    return [...groups.values()].map(g => {
      g.contracts.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
      const live = g.contracts.filter(c => c.end >= t);
      // "1 End cap · 2 Side gondolas · 1 not placed"
      const byType = new Map();
      live.forEach(c => { const sp = spotOf(c); const n = sp ? sp.type.name : 'not placed on the map'; byType.set(n, (byType.get(n) || 0) + 1); });
      g.items = [...byType.entries()].sort((a, b) => (a[0].startsWith('not placed')) - (b[0].startsWith('not placed')) || a[0].localeCompare(b[0]));
      g.yearly = live.filter(c => c.term === 'yearly').reduce((s, c) => s + (Number(c.amount) || 0), 0);
      g.monthly = live.filter(c => c.term === 'monthly').reduce((s, c) => s + (Number(c.amount) || 0), 0);
      g.ending = live.filter(c => statusOf(c) === 'ending').length;
      g.unbilled = live.filter(c => c.start <= t && !c.billed).length;
      g.unplaced = live.filter(c => !spotOf(c)).length;
      g.sales = S.sales.get(g.key)?.monthly_sales || null;
      return g;
    });
  }

  function renderList() {
    if (el('rentalListView').hidden && S.view !== 'list') return;
    document.querySelectorAll('#rentalShowTabs [data-show]').forEach(b => b.classList.toggle('active', (b.dataset.show === 'all') === S.showAll));
    const cur = Number(today().slice(0, 4)), t = today();
    const all = recap();
    const list = all.filter(g => !S.q || g.name.toLowerCase().includes(S.q) || g.contracts.some(c => (spotOf(c)?.o.label || '').toLowerCase().includes(S.q)))
      .sort((a, b) => (b.ending > 0) - (a.ending > 0) || a.name.localeCompare(b.name));

    const live = S.contracts.filter(c => c.end >= t && c.start <= t);
    const income = y => S.contracts.reduce((s, c) => s + (S.map ? S.map.revenueInYear(c, y) : 0), 0);
    const ending = S.contracts.filter(c => statusOf(c) === 'ending').length;
    el('rentalTotals').innerHTML = `<div class="rental-summary">
      <span class="rs-item">Suppliers: <strong>${all.filter(g => g.contracts.some(c => c.end >= t)).length}</strong></span>
      <span class="rs-item">Spots rented now: <strong>${live.filter(c => spotOf(c)).length}</strong></span>
      <span class="rs-item">Rental income ${cur}: <strong>${money(income(cur))}</strong></span>
      <span class="rs-item">${cur - 1}: <strong>${money(income(cur - 1))}</strong></span>
      <span class="rs-item">Not billed: <strong style="color:${live.some(c => !c.billed) ? 'var(--brick)' : 'inherit'}">${live.filter(c => !c.billed).length}</strong></span>
      ${ending ? `<span class="badge warn">${ending} ending within ${RENEWAL_WARNING_DAYS} days</span>` : ''}
    </div>`;

    el('rentalList').innerHTML = list.map(cardHtml).join('');
    el('rentalEmpty').style.display = list.length ? 'none' : 'block';
    el('rentalEmptyTitle').textContent = all.length ? 'No supplier matches' : 'Nothing assigned yet';
  }

  // "1 End cap", "2 Side gondolas", "3 not placed on the map"
  const plural = (n, word) => n === 1 || /^not placed/.test(word) || /s$/i.test(word) ? `${n} ${word}` : `${n} ${word}s`;
  function totalHtml(g) {
    const parts = [];
    if (g.yearly || !g.monthly) parts.push(`<strong>${money(g.yearly)}</strong> / year`);
    if (g.monthly) parts.push(`<strong>${money(g.monthly)}</strong> / month`);
    return parts.join(' + ');
  }
  function cardHtml(g) {
    const open = S.expanded.has(g.key), cur = Number(today().slice(0, 4));
    const sig = hasSales(g.sales) ? salesSignal(salesTotal(g.sales, cur - 1), salesTotal(g.sales, cur)) : null;
    const editable = can('rentals.contracts') && !S.salesMissing;
    return `
    <div class="sellout ${open ? 'open' : ''} ${g.ending ? 'needs-action flag-warn' : ''}" data-supplier="${esc(g.key)}">
      <div class="sellout-head" data-role="toggle">
        <span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>
        <div class="who">
          <div class="name">${esc(g.name)}</div>
          <div class="dates">${g.items.length ? g.items.map(([n, k]) => esc(plural(k, n))).join(' · ') : '<span class="muted-note">no current contract</span>'}</div>
        </div>
        <div class="rental-summary">
          <span class="rs-item">${totalHtml(g)}</span>
          ${g.ending ? `<span class="badge warn">${g.ending} ending soon</span>` : ''}
          ${g.unbilled ? `<span class="badge danger">${g.unbilled} not billed</span>` : ''}
          ${g.unplaced ? `<span class="badge inactive">${g.unplaced} not placed</span>` : ''}
          ${sig ? `<span class="badge ${sig.cls}" title="Sales ${cur - 1}: ${money2s(salesTotal(g.sales, cur - 1))} · ${cur}: ${money2s(salesTotal(g.sales, cur))}">${sig.label}</span>` : ''}
        </div>
      </div>
      <div class="sellout-body">
        <div class="items-scroll"><table class="items rental-recap-table">
          <thead><tr><th>Spot</th><th>Period</th><th class="num">Amount</th><th>Billing</th><th>Status</th><th></th></tr></thead>
          <tbody>${g.contracts.map(c => {
            const sp = spotOf(c), st = statusOf(c);
            const where = sp ? `<b>${esc(sp.type.name)}</b>${sp.o.label ? ' · ' + esc(sp.o.label) : ''}${sp.near ? ' · by ' + esc(sp.near) : ''} <span class="muted-note">${esc(sp.floor?.name || '')}</span>`
              : '<span style="color:var(--brick)">Not placed on the map</span>';
            return `<tr data-contract="${esc(c.id)}">
              <td>${where}</td>
              <td>${fmtDate(c.start)} → ${fmtDate(c.end)}</td>
              <td class="num">${money(c.amount)}${c.term === 'monthly' ? '/mo' : '/yr'}</td>
              <td>${c.billed ? 'Billed' : '<span style="color:var(--brick)">Not billed</span>'} · ${c.paid ? 'Paid' : 'Not paid'}</td>
              <td><span class="badge ${STATUS[st].cls}">${STATUS[st].label}</span></td>
              <td>${sp ? '<button class="btn ghost small" data-role="show">Show on map</button>'
                : can('rentals.contracts') && c.end >= today() ? '<button class="btn small" data-role="place">Place on map</button>' : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
        <p class="muted-note" style="margin:12px 0 6px;">Performance — ${esc(g.name)}'s monthly sales (for the renew / review decision)${editable ? ': type the figures, then Save sales' : ''}. Change the contracts themselves on the map.</p>
        ${S.salesMissing ? '<p class="muted-note" style="color:var(--brick)">Sales can be saved once migration 016 is applied.</p>' : ''}
        ${[cur - 1, cur].map(y => `
          <table class="rental-year-table">
            <thead><tr><th>${y}</th>${MONTHS.map(m => `<th>${m}</th>`).join('')}<th>Total</th></tr></thead>
            <tbody><tr><td>Sales</td>${MONTHS.map((m, i) => {
              const k = `${y}-${String(i + 1).padStart(2, '0')}`, v = (g.sales || {})[k];
              return `<td>${editable ? `<input type="text" inputmode="decimal" class="rental-sales-input" data-mkey="${k}" value="${v ? esc(String(v)) : ''}" placeholder="0">` : money2s(v)}</td>`;
            }).join('')}<td><strong>${money2s(salesTotal(g.sales, y))}</strong></td></tr></tbody>
          </table>`).join('')}
        ${editable ? '<div class="actions-row" style="justify-content:flex-start;"><button class="btn small secondary" data-role="save-sales">Save sales</button></div>' : ''}
      </div>
    </div>`;
  }
  const money2s = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

  el('rentalList').addEventListener('click', async e => {
    const card = e.target.closest('[data-supplier]'); if (!card) return;
    const row = e.target.closest('tr[data-contract]');
    const c = row ? S.contracts.find(x => x.id === row.dataset.contract) : null;
    if (c && e.target.closest('[data-role="show"]')) return goToMap(() => S.map.focusSpot(c.spotId));
    if (c && e.target.closest('[data-role="place"]')) return goToMap(() => S.map.startAssign(c.id));
    if (e.target.closest('[data-role="save-sales"]')) return saveSales(card);
    if (e.target.closest('[data-role="toggle"]')) {
      const k = card.dataset.supplier;
      S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k);
      renderList();
    }
  });
  function goToMap(then) {
    // (keeps full screen as it is)
    S.view = 'map';
    renderTabs();
    requestAnimationFrame(() => { then(); el('rentalMapView').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  async function saveSales(card) {
    const g = recap().find(x => x.key === card.dataset.supplier); if (!g) return;
    const sales = Object.assign({}, g.sales || {});
    for (const inp of card.querySelectorAll('.rental-sales-input')) {
      const raw = inp.value.trim();
      const n = raw === '' ? 0 : parseNum(raw);
      if (n === null || n < 0) { showToast('Sales must be numbers.', true); inp.focus(); return; }
      if (n) sales[inp.dataset.mkey] = n; else delete sales[inp.dataset.mkey];
    }
    const row = { supplier_key: g.key, supplier: g.name, monthly_sales: sales, updated_at: new Date().toISOString() };
    const { error } = await sb.from('rental_supplier_sales').upsert(row, { onConflict: 'supplier_key' });
    if (error) { console.error(error); showToast('Could not save the sales — ' + friendlyError(error), true); return; }
    S.sales.set(g.key, row);
    logActivity('rentals', 'sales', { type: 'supplier', id: g.key }, `Updated the sales figures of ${g.name}`);
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
