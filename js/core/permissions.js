/* ============================================================
   Per-user permissions (PLAN §10c). Each role is a starting template;
   the admin can add or remove single permissions for one user (Users
   page). Admins always have every permission.
   The database decides for real: public.has_perm() in
   supabase/migrations/014_user_permissions.sql, seeded with exactly
   the PERMISSIONS list below (scripts/tests check they match).
   ============================================================ */
// [key, group, label, roles that have it by default]
const PERMISSIONS = [
  ['sellouts.view',      'Sell-outs',     'See sell-outs, download and export',                 ['accountant']],
  ['sellouts.edit',      'Sell-outs',     'Add, edit, duplicate, turn on / off',                []],
  ['sellouts.price',     'Sell-outs',     'Set new prices',                                     []],
  ['sellouts.archive',   'Sell-outs',     'Archive / unarchive',                                ['accountant']],
  ['sellouts.delete',    'Sell-outs',     'Delete',                                             []],
  ['creditnotes.view',   'Credit notes',  'See credit notes',                                   []],
  ['creditnotes.edit',   'Credit notes',  'Add, edit, change status, delete',                   []],
  ['promotions.view',    'Promotions',    'See promotions, export, download files',             ['accountant']],
  ['promotions.edit',    'Promotions',    'Create promotions, edit rows, import, catalog',      []],
  ['promotions.audit',   'Promotions',    'Set Type and Note in Audit',                         []],
  ['promotions.archive', 'Promotions',    'Archive / unarchive',                                []],
  ['promotions.delete',  'Promotions',    'Delete promotions',                                  []],
  ['vendors.manage',     'Vendors',       'See and manage vendors and orders',                  []],
  ['rentals.view',       'Rentals',       'See the store map and contracts',                    []],
  ['rentals.contracts',  'Rentals',       'Add and change contracts, billing, sales',           []],
  ['rentals.layout',     'Rentals',       'Edit the map layout',                                []],
  ['rentals.spotcheck',  'Rentals',       'Check rented spots on the floor',                    ['floor_manager']],
  ['delivery.orders',    'Delivery',      "Add and edit today's orders",                        ['delivery']],
  ['delivery.settle',    'Delivery',      'Driver payments (mark paid)',                        ['delivery', 'accountant']],
  ['delivery.customers', 'Delivery',      'Customers',                                          ['delivery']],
  ['delivery.reports',   'Delivery',      'Reports',                                            []],
  ['delivery.manage',    'Delivery',      'Drivers, settings, edit or delete any order, backup', []],
  ['cash.view',          'Cash',          'See cash differences and summaries',                 ['accountant']],
  ['cash.enter',         'Cash',          'Enter and edit differences',                         ['accountant']],
  ['cash.lock',          'Cash',          'Lock a month',                                       ['accountant']],
  ['cash.unlock',        'Cash',          'Unlock a month',                                     []],
  ['cash.cashiers',      'Cash',          'Cashiers, PINs and warning levels',                  ['accountant']],
  ['floorcheck.do',      'Floor check',   'Do the floor check (own checks)',                    ['floor_manager']],
  ['floorcheck.manage',  'Floor check',   'All results, repeat problems, resolve, reopen',      []],
  ['labels.scan',        'Labels',        'Scan items for labels',                              ['shelf']],
  ['labels.print',       'Labels',        'Print labels (export to Excel)',                     ['accountant']],
  ['activity.view',      'Activity log',  'See the activity log',                               []],
  ['tools.convert',      'Tools',         'PDF / photo to Excel',                               []],
  ['promoladies.manage', 'Promo ladies',  'See and manage promo ladies',                        ['floor_manager']],
];
const PERMISSION_KEYS = PERMISSIONS.map(p => p[0]);

// Which permissions open which section of the app (any one of them is enough).
const SECTION_PERMS = {
  sellouts: ['sellouts.view'], creditnotes: ['creditnotes.view'], promotions: ['promotions.view'],
  vendors: ['vendors.manage'], rentals: ['rentals.view'],
  delivery: ['delivery.orders', 'delivery.settle', 'delivery.customers', 'delivery.reports', 'delivery.manage'],
  cash: ['cash.view'], floorcheck: ['floorcheck.do', 'floorcheck.manage', 'rentals.spotcheck'],
  labels: ['labels.scan', 'labels.print'], activity: ['activity.view'], tools: ['tools.convert'], promoladies: ['promoladies.manage'],
};
// Within a group, the first permission ("view") is needed by the others (the Users editor keeps that true).
const PERMISSION_GROUPS = [...new Set(PERMISSIONS.map(p => p[1]))];

function rolePermissions(role) {
  if (role === 'admin') return new Set(PERMISSION_KEYS);
  return new Set(PERMISSIONS.filter(p => p[3].includes(role)).map(p => p[0]));
}
// Effective permissions: role template + this user's overrides ({ perm: true|false }).
function effectivePermissions(role, overrides) {
  const set = rolePermissions(role);
  if (role === 'admin') return set;
  Object.entries(overrides || {}).forEach(([k, on]) => { if (on) set.add(k); else set.delete(k); });
  return set;
}

// Loads the signed-in user's permissions (auth.js calls this before starting the app).
// Before migration 014 is applied, falls back to the role template.
async function loadMyPermissions() {
  Session.perms = rolePermissions(Session.role);
  if (Session.role === 'admin') return;
  const { data, error } = await sb.rpc('my_permissions');
  if (error) { console.warn('Permissions: using the role defaults', error.message); return; }
  if (Array.isArray(data)) Session.perms = new Set(data);
}

// can('sellouts.edit') — any of several: can('floorcheck.do', 'floorcheck.manage')
function can(...perms) { return Session.role === 'admin' || perms.some(p => Session.perms && Session.perms.has(p)); }
