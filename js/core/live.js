/* ============================================================
   Live updates (owner, 2026-10-01): when someone else changes data,
   the page that shows it reloads by itself — no page refresh.
   One Realtime channel listens to the tables of the sections this
   user can see (migration 021; Delivery has its own channel).
   - Only the open section reloads; another section that changed
     reloads when it is opened.
   - Never while you work: it waits while you type in that page, use
     a dialog, or have just clicked / typed (2.5 s), so a reload never
     takes a cell from under you.
   - Back on screen after a while (phone asleep, tab hidden), or the
     connection came back: the open section reloads once.
   Started by startMainModules() after sign-in. Public: Live.start(), Live.shown(name).
   ============================================================ */
const Live = (function () {
  // Section -> the tables it shows, and how it reloads (all global functions / modules).
  const SECTIONS = {
    sellouts:    { tables: ['sellouts'],                                          refresh: () => loadAll() },
    onlinepromo: { tables: ['sellouts'],                                          refresh: () => window.OnlinePromo && OnlinePromo.show() },
    creditnotes: { tables: ['credit_notes'],                                      refresh: () => loadAll() },
    promotions:  { tables: ['promotions', 'promotion_rows', 'catalog_items'],     refresh: () => refreshPromotions() },
    vendors:     { tables: ['vendors', 'vendor_orders', 'vendor_skips'],          refresh: () => refreshVendors() },
    rentals:     { tables: ['rental_contracts', 'rental_supplier_sales'],         refresh: () => Rentals.refresh() },
    cash:        { tables: ['cash_differences', 'cash_months', 'cash_settings'],  refresh: () => window.Cash && Cash.refresh() },
    cashcount:   { tables: ['cash_counts'],                                       refresh: () => window.CashCount && CashCount.show() },
    floorcheck:  { tables: ['floor_checks', 'floor_check_items', 'spot_checks'],  refresh: () => window.FloorCheck && FloorCheck.show() },
    labels:      { tables: ['label_lists', 'label_items'],                        refresh: () => window.Labels && Labels.show() },
    promoladies: { tables: ['promo_ladies', 'promo_lady_attendance'],             refresh: () => window.PromoLadies && PromoLadies.show() },
    schedule:    { tables: ['schedule_weeks', 'schedule_requests', 'schedule_changes'],                                    refresh: () => window.Schedule && Schedule.show() },
    staff:       { tables: ['staff'],                                             refresh: () => window.Staff && Staff.show() },
    users:       { tables: ['profiles', 'user_permissions'],                      refresh: () => window.UsersPage && UsersPage.show() },
    activity:    { tables: ['activity_log'],                                      refresh: () => window.ActivityPage && ActivityPage.show() },
  };
  const QUIET_MS = 2500;      // after your last click / key in the app
  const DEBOUNCE_MS = 700;    // a burst of changes (an import) reloads once
  const dirty = new Set();
  let timer = null, lastActivity = 0, hiddenAt = 0, started = false, running = false;

  const activeSection = () => (document.querySelector('.panel.active')?.id || '').replace(/^panel-/, '');
  const editing = el => el && el.matches && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), textarea, select, [contenteditable="true"]');

  function busy(name) {
    const panel = document.getElementById('panel-' + name);
    if (panel && panel.contains(document.activeElement) && editing(document.activeElement)) return true;
    if (document.querySelector('.modal-overlay.open')) return true;
    return Date.now() - lastActivity < QUIET_MS;
  }

  function schedule(ms = DEBOUNCE_MS) { clearTimeout(timer); timer = setTimeout(flush, ms); }

  async function flush() {
    const name = activeSection();
    if (!dirty.has(name) || !SECTIONS[name]) return;
    if (running || busy(name)) return schedule(1000);
    dirty.delete(name);
    running = true;
    try { await SECTIONS[name].refresh(); }
    catch (e) { console.warn('Live: could not reload ' + name, e); }
    finally { running = false; }
  }

  function changed(table) {
    let hit = false;
    for (const [name, s] of Object.entries(SECTIONS)) if (s.tables.includes(table) && canSee(name)) { dirty.add(name); hit = true; }
    if (hit) schedule();
  }
  // Everything this user can see may be stale (back from sleep, reconnected).
  function allStale() {
    Object.keys(SECTIONS).forEach(n => { if (canSee(n)) dirty.add(n); });
    schedule(300);
  }

  function start() {
    if (started) return;
    started = true;
    const tables = new Set();
    Object.entries(SECTIONS).forEach(([n, s]) => { if (canSee(n)) s.tables.forEach(t => tables.add(t)); });
    if (!tables.size) return;
    const ch = sb.channel('lv-live');
    tables.forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => changed(t)));
    let wasUp = false;
    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { if (wasUp) allStale(); wasUp = true; }   // a reconnect may have missed changes
    });
    ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60 * 1000) allStale();
    });
  }

  // switchTab: a section that changed while closed reloads when it opens.
  function shown(name) { if (dirty.has(name)) schedule(300); }

  return { start, shown, _dirty: dirty, _changed: changed };
})();
