/* ============================================================
   Who can see what (PLAN §3, §10c). Roles are templates: their
   `sections`/`delivery` lists are the role's usual pages and `home`
   its landing page; what a user may really open and do comes from
   their permissions (js/core/permissions.js). This only shapes the
   UI; the real rules are the RLS policies and triggers in the database.
   ============================================================ */
const ROLES = {
  admin: {
    label: 'Admin',
    sections: ['dashboard', 'sellouts', 'onlinepromo', 'creditnotes', 'promotions', 'vendors', 'performance', 'pricing', 'rentals', 'delivery', 'cash', 'cashcount', 'floorcheck', 'promoladies', 'schedule', 'staff', 'labels', 'tools', 'users', 'activity'],
    delivery: ['orders', 'settle', 'reports', 'customers', 'drivers', 'settings'],
    home: 'dashboard',
  },
  accountant: {
    label: 'Accountant',
    sections: ['sellouts', 'onlinepromo', 'promotions', 'cash', 'delivery', 'labels'],
    delivery: ['settle'],
    home: 'sellouts',
  },
  delivery: {
    label: 'Delivery',
    sections: ['delivery', 'onlinepromo'],
    delivery: ['orders', 'settle', 'customers'],
    home: 'delivery',
  },
  floor_manager: {
    label: 'Floor manager',
    sections: ['floorcheck', 'promoladies', 'rentals'],
    delivery: [],
    home: 'floorcheck',
  },
  // HR makes the weekly schedule of cashiers and supervisors (owner, 2026-09-30).
  hr: {
    label: 'HR',
    sections: ['schedule'],
    delivery: [],
    home: 'schedule',
  },
  // Shelf workers scan items that need a new shelf label (Phase 7).
  shelf: {
    label: 'Shelf worker',
    sections: ['labels'],
    delivery: [],
    home: 'labels',
  },
};

// Set by auth.js once the profile is loaded.
const Session = { user: null, profile: null, role: null, perms: null };

const SECTION_ORDER = ['dashboard', 'sellouts', 'onlinepromo', 'creditnotes', 'promotions', 'vendors', 'performance', 'pricing', 'rentals', 'delivery', 'cash', 'cashcount', 'floorcheck', 'promoladies', 'schedule', 'staff', 'labels', 'tools', 'users', 'activity'];
function roleInfo() {
  const r = ROLES[Session.role] || { label: '', sections: [], delivery: [], home: null };
  // Landing page: the role's usual one, or the first section this user can open.
  const home = r.home && canSee(r.home) ? r.home : SECTION_ORDER.find(canSee) || null;
  return Object.assign({}, r, { home });
}
function canSee(section) {
  if (section === 'users' || section === 'dashboard') return isAdmin();   // the dashboard: admin only (owner, 2026-10-04)
  const perms = SECTION_PERMS[section];
  return !!perms && can(...perms);
}
const DELIVERY_PAGE_PERMS = {
  orders: ['delivery.orders', 'delivery.manage'], settle: ['delivery.settle'], customers: ['delivery.customers'],
  reports: ['delivery.reports'], drivers: ['delivery.manage'], settings: ['delivery.manage'],
};
function canSeeDeliveryPage(page) { return can(...(DELIVERY_PAGE_PERMS[page] || [])); }
function isAdmin() { return Session.role === 'admin'; }
// Sell-outs and promotions: which controls show is decided per permission (css: body.no-<perm>).
function canEditSellouts() { return can('sellouts.edit'); }
// Turning a sell-out on / off: editors, and the accountant (sellouts.activate, migration 033).
function canToggleSellouts() { return can('sellouts.edit', 'sellouts.activate'); }
function canEditPromotions() { return can('promotions.edit'); }
function canArchiveSellouts() { return can('sellouts.archive'); }
// One body class per permission the user does NOT have, e.g. body.no-sellouts-delete hides Delete.
// ro-sellouts / ro-promotions: no add/edit (the pages become view-only, apart from what is allowed).
function applyEditClasses() {
  PERMISSION_KEYS.forEach(k => document.body.classList.toggle('no-' + k.replace('.', '-'), !can(k)));
  document.body.classList.toggle('ro-sellouts', !canEditSellouts());
  document.body.classList.toggle('ro-promotions', !canEditPromotions());
}
