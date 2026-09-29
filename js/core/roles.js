/* ============================================================
   Who can see what (PLAN §3). This only shapes the UI; the real
   rules are the RLS policies and triggers in the database.
   ============================================================ */
const ROLES = {
  admin: {
    label: 'Admin',
    sections: ['sellouts', 'creditnotes', 'promotions', 'vendors', 'rentals', 'delivery', 'cash', 'floorcheck', 'labels', 'users', 'activity'],
    delivery: ['orders', 'settle', 'reports', 'customers', 'drivers', 'settings'],
    home: 'sellouts',
  },
  accountant: {
    label: 'Accountant',
    sections: ['sellouts', 'promotions', 'cash', 'delivery', 'labels'],
    delivery: ['settle'],
    home: 'sellouts',
  },
  delivery: {
    label: 'Delivery',
    sections: ['delivery'],
    delivery: ['orders', 'settle', 'customers'],
    home: 'delivery',
  },
  floor_manager: {
    label: 'Floor manager',
    sections: ['floorcheck'],
    delivery: [],
    home: 'floorcheck',
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
const Session = { user: null, profile: null, role: null };

function roleInfo() { return ROLES[Session.role] || { label: '', sections: [], delivery: [], home: null }; }
function canSee(section) { return roleInfo().sections.includes(section); }
function canSeeDeliveryPage(page) { return roleInfo().delivery.includes(page); }
function isAdmin() { return Session.role === 'admin'; }
// Sell-outs and promotions: only the admin creates or changes them. The accountant views, downloads
// and exports them, and archives / unarchives sell-outs (their confirmation that it left the system).
function canEditSellouts() { return isAdmin(); }
function canEditPromotions() { return isAdmin(); }
function canArchiveSellouts() { return ['admin', 'accountant'].includes(Session.role); }
// Body classes that switch the two pages to view-only (css: body.ro-sellouts, body.ro-promotions).
function applyEditClasses() {
  document.body.classList.toggle('ro-sellouts', !canEditSellouts());
  document.body.classList.toggle('ro-promotions', !canEditPromotions());
}
