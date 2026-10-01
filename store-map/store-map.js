/* ============================================================
   Store Map — interactive floor map for rentals
   ------------------------------------------------------------
   Vanilla JS, no build step, no dependencies.

   Usage:
     const map = StoreMap.mount(document.getElementById('rentalsMap'), {
       adapter,                 // data layer (see WIRING.md) — LocalAdapter or SupabaseAdapter
       canEdit: true,           // may use Edit layout (admin)
       canManageRentals: true,  // may create / edit / delete contracts (admin)
       currency: '$',
       today: () => '2026-09-29',   // optional; defaults to the browser's local date
       toast: (msg, isError) => {}, // optional; defaults to a built-in toast
       confirm: (msg, okLabel) => Promise<boolean>, // optional
       onActivity: (action, summary, details) => {}, // optional; hook for activity_log
       onLoad: () => {},            // optional; after every (re)load from the adapter
       suppliers: () => ['…']       // optional; names offered in the contract form (e.g. the Vendors list)
     });
     await map.ready;        // first load finished
     map.refresh();          // reload everything from the adapter
     map.focusSpot(id);      // switch floor, zoom to and select a spot
     map.destroy();
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- defaults: object types & categories ----------------
     kind:
       fixture → gondolas / shelves / wall fridges: drawn with category sections
       spot    → rentable place (end cap, display, screen…)
       fixed   → checkout, entrance… (grey, not rentable)
       wall    → solid wall segment
       text    → free text label on the map                              */
  const DEFAULT_TYPES = {
    // LV Ajaltoun rents whole gondolas too (owner, 2026-09-29), so gondolas are rentable fixtures.
    gondola:        { name: 'Gondola',                 kind: 'fixture', rentable: true,  lanes: 2, w: 600, h: 110, std: true },
    shelf:          { name: 'Shelf',                   kind: 'fixture', rentable: false, lanes: 1, w: 300, h: 30 },
    fridge_wall:    { name: 'Wall fridge',             kind: 'fixture', rentable: false, lanes: 1, w: 300, h: 60 },
    freezer_island: { name: 'Island freezer',          kind: 'fixture', rentable: false, lanes: 2, w: 400, h: 200 },
    endcap:         { name: 'End cap',                 kind: 'spot', rentable: true, w: 80,  h: 60,  std: true },
    side_gondola:   { name: 'Side gondola',            kind: 'spot', rentable: true, w: 80,  h: 25,  std: true },
    basket_side:    { name: 'Basket side',             kind: 'spot', rentable: true, w: 50,  h: 80,  std: true },
    display:        { name: 'Stand-alone display',     kind: 'spot', rentable: true, w: 110, h: 110, std: true },
    display_side:   { name: 'Display side',            kind: 'spot', rentable: true, w: 110, h: 25,  std: true },
    freezer:        { name: 'Supplier fridge/freezer', kind: 'spot', rentable: true, w: 80,  h: 55,  std: true },
    fridge_door:    { name: 'Fridge door',             kind: 'spot', rentable: true, w: 60,  h: 80,  std: true },
    wall_spot:      { name: 'Wall spot',               kind: 'spot', rentable: true, w: 55,  h: 55 },
    pillar:         { name: 'Pillar',                  kind: 'spot', rentable: true, w: 60,  h: 60 },
    screen_wall:    { name: 'Screen — wall',           kind: 'spot', rentable: true, w: 140, h: 22, screen: true },
    screen_island:  { name: 'Screen — island',         kind: 'spot', rentable: true, w: 70,  h: 70, screen: true },
    promo_table:    { name: 'Promo table',             kind: 'spot', rentable: true, w: 160, h: 40,  std: true },
    promo_zone:     { name: 'Promo zone',              kind: 'spot', rentable: true, w: 160, h: 60 },
    checkout:       { name: 'Checkout',                kind: 'fixed', rentable: false, w: 136, h: 27 },
    entrance:       { name: 'Entrance / door',         kind: 'fixed', rentable: false, w: 300, h: 60 },
    fixed:          { name: 'Other fixed element',     kind: 'fixed', rentable: false, w: 120, h: 60 },
    wall:           { name: 'Wall',                    kind: 'wall', rentable: false, w: 300, h: 10 },
    note:           { name: 'Text label',              kind: 'text', rentable: false, w: 220, h: 40 },
    zone:           { name: 'Zone name (big label)',   kind: 'text', look: 'zone', rentable: false, w: 520, h: 70 },
    aisle:          { name: 'Aisle number',            kind: 'text', look: 'aisle', rentable: false, w: 150, h: 36 }
  };
  const DEFAULT_CATS = {
    grocery: { name: 'Grocery', color: '#CFDDF5' },
    oils: { name: 'Oils & ghee', color: '#F2E3B0' },
    canned: { name: 'Canned food', color: '#D9D2F0' },
    sauces: { name: 'Sauces & spices', color: '#F6CDBF' },
    pasta: { name: 'Pasta', color: '#F5D9B3' },
    snacks: { name: 'Snacks', color: '#F4C6C6' },
    breakfast: { name: 'Breakfast & cereal', color: '#E6D6BC' },
    hotdrinks: { name: 'Coffee & tea', color: '#DCC7B4' },
    beverage: { name: 'Beverages', color: '#C4E3EE' },
    dairy: { name: 'Dairy & cheese', color: '#D9EAF7' },
    frozen: { name: 'Frozen', color: '#BFE0E6' },
    baking: { name: 'Baking & desserts', color: '#EDD5E6' },
    spreads: { name: 'Spreads & jams', color: '#E5D3EE' },
    confectionery: { name: 'Confectionery', color: '#F1C9D9' },
    healthy: { name: 'Healthy food', color: '#CDE8C4' },
    bakery: { name: 'Bakery', color: '#EEDCC2' },
    fresh: { name: 'Fresh & eggs', color: '#D6ECCF' },
    ethnic: { name: 'World food', color: '#F0D8C0' },
    alcohol: { name: 'Wines & spirits', color: '#DCCCE0' },
    other: { name: 'Other', color: '#E1E3DE' }
  };
  /* ---------------- icons (24×24, drawn as strokes) ----------------
     Department icons go on shelf sections, type icons on rentable spots.
     A department or type can pick any icon by name with an "icon" field. */
  const ICONS = {
    grocery: 'M6 8h12l1.5 13h-15Z M9 8V6a3 3 0 0 1 6 0v2 M9 13h6',
    oils: 'M10 2h4v3l2 3v13a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8l2-3Z M8 12h8 M12 15.5c-1 1.2-1 2.5 0 3 1-.5 1-1.8 0-3Z',
    canned: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3v12c0 1.7-3.1 3-7 3s-7-1.3-7-3Z M5 6c0 1.7 3.1 3 7 3s7-1.3 7-3 M5 11.5c0 1.7 3.1 3 7 3s7-1.3 7-3',
    sauces: 'M13 8c3.5 0 5.5 2.5 5 6-.6 4.2-5 7-11 7 2.5-2 3.5-5 3.5-8.5C10.5 9.6 11 8 13 8Z M13 8c0-2.2 1-4 3.5-4.5 M11.5 8.5 10 7',
    pasta: 'M12 22V9 M12 9c-2.2-.6-3.4-2.4-3.4-5.2 2.2.4 3.4 2.2 3.4 5.2Zm0 0c2.2-.6 3.4-2.4 3.4-5.2-2.2.4-3.4 2.2-3.4 5.2Z M12 14.5c-2.4-.5-4-2-4-4.6 2.4.2 4 1.8 4 4.6Zm0 0c2.4-.5 4-2 4-4.6-2.4.2-4 1.8-4 4.6Z',
    snacks: 'M6 3h12l-1 3 1 3-1 3 1 3-1 3 1 3H6l1-3-1-3 1-3-1-3 1-3Z M9.5 10.5l5 3 M14.5 10.5l-5 3',
    breakfast: 'M3 11h18a9 9 0 0 1-18 0Z M8 8.5c.5-1.3 1.6-2 3-2 M13 8c.4-1.6 1.7-2.6 3.5-2.5',
    hotdrinks: 'M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z M17 10h1.5a2.5 2.5 0 0 1 0 5H17 M8 2.5c-.8 1 .8 2 0 3 M12 2.5c-.8 1 .8 2 0 3 M5 22h11',
    beverage: 'M6.5 8h11L16 21.5H8Z M12 8l2.5-6H17 M7 13h10',
    dairy: 'M8 2h8v3l2 3v14H6V8l2-3Z M8 5h8 M6 11h12 M12 14.5a2 2 0 1 0 0 4 2 2 0 1 0 0-4',
    frozen: 'M12 2v20 M3.3 7l17.4 10 M3.3 17 20.7 7 M9 3.5l3 2.5 3-2.5 M9 20.5l3-2.5 3 2.5',
    baking: 'M4 21h16 M5 21v-7h14v7 M5 17c2.3 1.2 4.7-1.2 7 0s4.7 1.2 7 0 M12 14v-3 M12 7.5c-1 1-1 2.3 0 3.5 1-1.2 1-2.5 0-3.5Z',
    spreads: 'M7 3h10v3H7Z M6 6h12v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z M6 11h12 M6 17h12',
    confectionery: 'M8.5 12a3.5 3.5 0 1 0 7 0 3.5 3.5 0 1 0-7 0 M8.5 12 3.5 8.5v7Z M15.5 12l5-3.5v7Z',
    healthy: 'M5 21c0-9.5 5.5-15.5 16-16 0 10-6 16-16 16Z M5 21l8.5-8.5',
    bakery: 'M5 11a4 4 0 0 1 0-8h14a4 4 0 0 1 0 8v9H5Z M9.5 6.5l-1 3 M14.5 6.5l-1 3',
    fresh: 'M12 3c4 0 7 6 7 11a7 7 0 0 1-14 0c0-5 3-11 7-11Z',
    ethnic: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M3 12h18 M12 3c3.2 3.2 3.2 14.8 0 18 M12 3c-3.2 3.2-3.2 14.8 0 18',
    alcohol: 'M7 3h10v4.5a5 5 0 0 1-10 0Z M7 6h10 M12 12.5V20 M8 21h8',
    other: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5Z M3 7.5l9 4.5 9-4.5 M12 12v9',
    /* spot types */
    endcap: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z',
    side_gondola: 'M4 4v16 M20 4v16 M4 8h16 M4 13h16 M4 18h16',
    pillar: 'M8 3h8 M8 21h8 M9 3v18 M15 3v18 M12 6v12',
    basket_side: 'M3 10h18l-2.2 10.5H5.2Z M7.5 10 11 4 M16.5 10 13 4 M9 13.5v4 M12 13.5v4 M15 13.5v4',
    display: 'M5 9h14l-2-5H7Z M7 9v11h10V9 M5 21h14 M10 13h4',
    display_side: 'M3 12V3h9l9 9-9 9Z M7.5 7.5h.01',
    freezer: 'M12 2v20 M3.3 7l17.4 10 M3.3 17 20.7 7',
    fridge_door: 'M6 2h12v20H6Z M6 10h12 M15 5v2 M15 13v4',
    wall_spot: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5',
    screen: 'M3 4h18v12H3Z M8 21h8 M12 16v5',
    promo_table: 'M3 12V3h9l9 9-9 9Z M7.5 7.5a.5.5 0 1 0 0 .01 M15 9l-6 6',
    promo_zone: 'M3 10v4h4l8 5V5l-8 5Z M18 9a4 4 0 0 1 0 6 M7 14l1.5 6'
  };
  const iconSvg = (name, x, y, s, cls = 'sm-icon', extra = '') => {
    const d = ICONS[name] || ICONS.other;
    return `<g transform="translate(${(+x).toFixed(1)} ${(+y).toFixed(1)}) scale(${(s / 24).toFixed(4)})"${extra}><path class="${cls}" d="${d}"/></g>`;
  };
  const iconHtml = (name, color) => `<svg class="sm-ic sm-dept-ic" viewBox="0 0 24 24" aria-hidden="true" style="stroke:${color}"><path d="${ICONS[name] || ICONS.other}"/></svg>`;

  const STATUS = {
    rented:     { label: 'Rented',               order: 1 },
    ending:     { label: 'Ending in 30 days',    order: 2 },
    expired:    { label: 'Expired, not renewed', order: 3 },
    unbilled:   { label: 'Not billed yet',       order: 4 },
    nocontract: { label: 'Occupied, no contract', order: 5 },
    upcoming:   { label: 'Starts soon',          order: 6 },
    free:       { label: 'Free',                 order: 7 }
  };
  const ENDING_DAYS = 30;

  /* ---------------- small helpers ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p = 'o') => p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseD = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return localDate(d); };
  const addYears = (s, n) => { const d = parseD(s); d.setFullYear(d.getFullYear() + n); return localDate(d); };
  const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000);
  const fmtD = (s) => s ? parseD(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const normRot = (r) => ((Number(r) || 0) % 360 + 360) % 360;
  const ICON = {
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>', up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>', redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 19h14"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>', history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', check: '<path d="M20 6 9 17l-5-5"/>'
  };
  const ic = (n) => `<svg class="sm-ic" viewBox="0 0 24 24" aria-hidden="true">${ICON[n] || ''}</svg>`;

  /* Fit a label into a w×h box: picks 1–3 lines and the biggest size that fits. */
  function fitText(str, w, h, max = 26, min = 7, horizOnly = false) {
    str = String(str || '').trim();
    if (!str) return null;
    const vertical = !horizOnly && h > w * 1.25;
    let W = vertical ? h : w, H = vertical ? w : h;
    const pad = Math.max(2, Math.min(W, H) * 0.14); W -= pad * 2; H -= pad * 2;
    const words = str.split(/\s+/);
    let best = null;
    for (let n = 1; n <= Math.min(3, words.length); n++) {
      const lines = splitBalanced(words, n);
      const longest = Math.max(...lines.map(l => l.length));
      const size = Math.min(max, H / (n * 1.18), W / (longest * 0.6));
      if (!best || size > best.size + 0.3) best = { lines, size, vertical };
    }
    if (best.size < min) {
      // too small even in three lines: keep one line, cut with an ellipsis
      const chars = Math.max(3, Math.floor(W / (min * 0.6)));
      best = { lines: [str.length > chars ? str.slice(0, chars - 1) + '…' : str], size: min, vertical };
    }
    return best;
  }
  function splitBalanced(words, n) {
    if (n === 1) return [words.join(' ')];
    const total = words.join(' ').length, target = total / n, lines = [];
    let cur = [];
    words.forEach((w, i) => {
      const candidate = [...cur, w].join(' ');
      const remainingLines = n - lines.length - 1;
      const remainingWords = words.length - i;
      if (cur.length && candidate.length > target * 1.05 && remainingLines > 0 && remainingWords > remainingLines - 1) {
        lines.push(cur.join(' ')); cur = [w];
      } else cur.push(w);
    });
    if (cur.length) lines.push(cur.join(' '));
    return lines;
  }
  function textSvg(str, x, y, w, h, opts = {}) {
    const f = fitText(str, w, h, opts.max || 26, opts.min || 7, !!opts.horizOnly);
    if (!f) return '';
    const cx = x + w / 2, cy = y + h / 2;
    let rot = f.vertical ? -90 : 0;
    if (opts.flip) rot += 180;
    const lh = f.size * 1.15, start = cy - (lh * (f.lines.length - 1)) / 2;
    const spans = f.lines.map((l, i) => `<tspan x="${cx.toFixed(1)}" y="${(start + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join('');
    return `<text class="${opts.cls || ''}" font-size="${f.size.toFixed(1)}"${rot ? ` transform="rotate(${rot} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ''}>${spans}</text>`;
  }
  function hsl(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || ''); if (!m) return null;
    const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let hh = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh /= 6; }
    return { h: hh * 360, s: s * 100, l: l * 100 };
  }
  // a stronger version of a pastel department colour, for the shelf-edge strip
  function shade(hex, light, sat) { const c = hsl(hex); return c ? `hsl(${Math.round(c.h)} ${Math.round(Math.min(78, c.s * sat))}% ${light}%)` : hex; }
  /* An icon followed by a label, centred together in a w×h box.
     Tall boxes are drawn turned -90° (reading bottom to top), like the plain labels. */
  function iconLabel(label, icon, x, y, w, h, opts = {}) {
    const vertical = h > w * 1.25;
    const cx = x + w / 2, cy = y + h / 2;
    let rot = vertical ? -90 : 0; if (opts.flip) rot += 180;
    const W = vertical ? h : w, H = vertical ? w : h;
    const bx = cx - W / 2;
    const s = Math.min(opts.maxIcon || 24, H * 0.6, W * 0.4);
    const textOnly = () => textSvg(label, bx, cy - H / 2, W, H, { max: opts.max, flip: false, cls: opts.cls, horizOnly: true });
    let body;
    if (opts.stack && label && H >= 46 && W >= 46) {
      // icon on top, name underneath (end caps, displays, baskets)
      const si = Math.min(opts.maxIcon || 20, H * 0.3), top = cy - H / 2, gap = H * 0.04;
      const iy = top + H * 0.1;
      body = iconSvg(icon, cx - si / 2, iy, si, opts.iconCls || 'sm-icon') +
        textSvg(label, bx, iy + si + gap, W, top + H - (iy + si + gap) - H * 0.04, { max: opts.max, cls: opts.cls, horizOnly: true });
    } else if (s < 8) body = textOnly();
    else {
      const gap = s * 0.38, padX = Math.max(2, Math.min(W, H) * 0.12);
      const f = label ? fitText(label, W - s - gap - padX, H, opts.max || 22, 6.5, true) : null;
      if (!f || f.size < 7.5) {
        // not enough room for both: the name matters more than the icon
        const alone = label ? fitText(label, W, H, opts.max || 22, 6.5, true) : null;
        body = alone && alone.size >= 7 ? textOnly() : iconSvg(icon, cx - s / 2, cy - s / 2, s, opts.iconCls || 'sm-icon');
      } else {
        const tw = Math.max(...f.lines.map(l => l.length)) * 0.6 * f.size;
        const x0 = cx - (s + gap + tw) / 2, tx = x0 + s + gap, lh = f.size * 1.15, start = cy - (lh * (f.lines.length - 1)) / 2;
        body = iconSvg(icon, x0, cy - s / 2, s, opts.iconCls || 'sm-icon') +
          `<text class="${opts.cls || ''}" font-size="${f.size.toFixed(1)}" style="text-anchor:start">${f.lines.map((l, i) => `<tspan x="${tx.toFixed(1)}" y="${(start + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join('')}</text>`;
      }
    }
    return rot ? `<g transform="rotate(${rot} ${cx.toFixed(1)} ${cy.toFixed(1)})">${body}</g>` : body;
  }
  function darken(hex) { // for dark mode: same hue, low lightness
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || ''); if (!m) return hex;
    let [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let hh = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh /= 6; }
    return `hsl(${Math.round(hh * 360)} ${Math.round(s * 45)}% 26%)`;
  }

  /* ============================================================ */
  class StoreMapApp {
    constructor(root, opts) {
      this.root = root;
      this.opts = Object.assign({ canEdit: false, canManageRentals: false, currency: '$' }, opts || {});
      this.adapter = this.opts.adapter;
      if (!this.adapter) throw new Error('StoreMap: an adapter is required');
      this.types = clone(DEFAULT_TYPES);
      this.cats = clone(DEFAULT_CATS);
      this.floors = []; this.layouts = {}; this.contracts = [];
      this.floorId = null; this.mode = 'rentals'; this.q = '';
      this.statusFilter = new Set(); this.typeFilter = '';
      this.selSet = new Set(); this.guides = []; this.box = null;
      this.sel = null; this.editing = false; this.draft = null; this.undoStack = []; this.redoStack = [];
      this.dirty = false; this.grid = 5; this.views = {}; this.panelView = null; this.contractForm = null;
      this.assignFor = null; this.legendCollapsed = global.innerWidth < 640; this.pid = 'sm' + Math.random().toString(36).slice(2, 7); this.pointers = new Map();
      this.build();
      this.ready = this.refresh();   // map.ready resolves once the first load is done
    }

    /* ---------------- plumbing ---------------- */
    today() { return this.opts.today ? this.opts.today() : localDate(new Date()); }
    money(n) { return this.opts.currency + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
    toast(msg, err) {
      if (this.opts.toast) return this.opts.toast(msg, err);
      let s = document.querySelector('.sm-toasts');
      if (!s) { s = document.createElement('div'); s.className = 'sm-toasts'; document.body.appendChild(s); }
      const t = document.createElement('div'); t.className = 'sm-toast' + (err ? ' err' : ''); t.textContent = msg;
      s.appendChild(t); setTimeout(() => t.remove(), 3200);
    }
    confirm(msg, ok = 'Confirm') {
      if (this.opts.confirm) return this.opts.confirm(msg, ok);
      return this.modal({ title: 'Please confirm', message: msg, ok }).then(r => !!r);
    }
    modal({ title, message = '', html = '', ok = 'OK', cancel = 'Cancel', wide = false, onOpen, collect }) {
      return new Promise(resolve => {
        const wrap = document.createElement('div');
        wrap.className = 'sm-modal';
        wrap.innerHTML = `<div class="sm-modal-box ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}${html}
          <div class="sm-modal-actions">${cancel ? `<button class="sm-btn" data-x>${esc(cancel)}</button>` : ''}${ok ? `<button class="sm-btn primary" data-ok>${esc(ok)}</button>` : ''}</div></div>`;
        // keep dark/light tokens: attach inside the map root's .sm so CSS variables resolve
        this.el.appendChild(wrap);
        const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const onKey = (e) => { if (e.key === 'Escape') done(null); };
        document.addEventListener('keydown', onKey);
        wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
        wrap.querySelector('[data-x]')?.addEventListener('click', () => done(null));
        wrap.querySelector('[data-ok]')?.addEventListener('click', () => done(collect ? collect(wrap) : true));
        if (onOpen) onOpen(wrap, done);
        (wrap.querySelector('input,select,textarea') || wrap.querySelector('[data-ok]'))?.focus();
      });
    }
    activity(action, summary, details) { try { this.opts.onActivity && this.opts.onActivity(action, summary, details || {}); } catch (e) { /* never block the UI */ } }
    async call(fn, errMsg) {
      try { return await fn(); }
      catch (e) { console.error(e); this.toast(`${errMsg} — ${e && e.message ? e.message : e}`, true); throw e; }
    }

    /* ---------------- data ---------------- */
    async refresh() {
      this.canvasEl.insertAdjacentHTML('beforeend', '<div class="sm-loading">Loading map…</div>');
      try {
        const cfg = this.adapter.loadConfig ? await this.adapter.loadConfig() : null;
        if (cfg && cfg.types) this.types = Object.assign(clone(DEFAULT_TYPES), cfg.types);
        if (cfg && cfg.cats) this.cats = Object.assign(clone(DEFAULT_CATS), cfg.cats);
        this.floors = (await this.adapter.listFloors()).sort((a, b) => (a.sort || 0) - (b.sort || 0));
        this.layouts = {};
        for (const f of this.floors) this.layouts[f.id] = await this.adapter.listObjects(f.id);
        this.contracts = await this.adapter.listContracts();
        if (!this.floorId || !this.floors.find(f => f.id === this.floorId)) this.floorId = this.floors[0]?.id || null;
      } catch (e) {
        console.error(e); this.toast('Could not load the store map — ' + (e.message || e), true);
      }
      this.canvasEl.querySelector('.sm-loading')?.remove();
      this.injectCatStyles();
      this.renderAll();
      requestAnimationFrame(() => this.fit(true));
      try { this.opts.onLoad && this.opts.onLoad(); } catch (e) { /* never block the UI */ }
    }
    get floor() { return this.floors.find(f => f.id === this.floorId) || null; }
    get objects() { return this.editing ? this.draft : (this.layouts[this.floorId] || []); }
    allObjects() { return this.floors.flatMap(f => (f.id === this.floorId && this.editing ? this.draft : this.layouts[f.id] || []).map(o => Object.assign({ _floor: f.id }, o))); }
    typeOf(o) { return this.types[o.type] || { name: o.type, kind: 'fixed', rentable: false }; }
    isRentable(o) { return !!this.typeOf(o).rentable; }
    findObject(id) { for (const f of this.floors) { const o = (f.id === this.floorId && this.editing ? this.draft : this.layouts[f.id] || []).find(x => x.id === id); if (o) return { o, floorId: f.id }; } return null; }

    contractsFor(spotId) { return this.contracts.filter(c => c.spotId === spotId).sort((a, b) => (b.start || '').localeCompare(a.start || '')); }
    activeContract(spotId) { const t = this.today(); return this.contractsFor(spotId).find(c => c.start <= t && c.end >= t) || null; }
    statusOf(o) {
      if (!this.isRentable(o)) return null;
      const t = this.today(), list = this.contractsFor(o.id);
      const active = list.find(c => c.start <= t && c.end >= t);
      if (active) {
        if (daysBetween(t, active.end) <= ENDING_DAYS && !list.some(c => c.start > active.end)) return 'ending';
        if (!active.billed) return 'unbilled';
        return 'rented';
      }
      if (list.some(c => c.start > t)) return 'upcoming';
      if (list.length && list[0].end < t) return 'expired';
      if ((o.occupant || '').trim()) return 'nocontract';
      return 'free';
    }
    displayName(o) {
      const c = this.isRentable(o) ? this.activeContract(o.id) : null;
      return (c && c.supplier) || (o.occupant || '').trim() || (o.label || '').trim() || '';
    }
    // "Frying oil" for the corner spot next to the frying-oil gondola: a human hint for lists
    nearLabel(o) {
      if (o.label) return '';
      const list = o._floor ? (this.layouts[o._floor] || []) : this.objects;
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      let best = null, bd = 260;
      list.forEach(f => {
        if (this.typeOf(f).kind !== 'fixture') return;
        const dx = Math.max(f.x - cx, 0, cx - (f.x + f.w)), dy = Math.max(f.y - cy, 0, cy - (f.y + f.h)), d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = f; }
      });
      if (!best) return '';
      const secs = [...(best.sectionsA || []), ...(best.sectionsB || [])];
      if (!secs.length) return best.label || '';
      // the section closest to this spot along the fixture
      const horiz = best.w >= best.h, pos = horiz ? cx - best.x : cy - best.y, along = horiz ? best.w : best.h;
      const lane = (best.sectionsB && best.sectionsB.length && (horiz ? cy > best.y + best.h / 2 : cx > best.x + best.w / 2)) ? best.sectionsB : (best.sectionsA || []);
      const total = lane.reduce((s, x) => s + (Number(x.size) || 1), 0) || 1;
      let acc = 0;
      for (const sec of lane) { acc += along * (Number(sec.size) || 1) / total; if (pos <= acc) return sec.label; }
      return lane.length ? lane[lane.length - 1].label : '';
    }
    matches(o, q) {
      if (!q) return true;
      const hay = [o.label, o.occupant, this.typeOf(o).name, ...(o.sectionsA || []).map(s => s.label), ...(o.sectionsB || []).map(s => s.label),
        ...(this.isRentable(o) ? this.contractsFor(o.id).map(c => c.supplier) : [])].join(' ').toLowerCase();
      return q.split(/\s+/).every(t => hay.includes(t));
    }
    revenueInYear(c, year) {
      const y0 = `${year}-01-01`, y1 = `${year}-12-31`;
      if (!c.start || !c.end || c.end < y0 || c.start > y1) return 0;
      if (c.term === 'yearly' || c.term === 'contract') return c.start.slice(0, 4) === String(year) ? Number(c.amount) || 0 : 0;
      const s = c.start > y0 ? c.start : y0, e = c.end < y1 ? c.end : y1;
      const months = (parseD(e).getFullYear() - parseD(s).getFullYear()) * 12 + parseD(e).getMonth() - parseD(s).getMonth() + 1;
      return Math.max(0, months) * (Number(c.amount) || 0);
    }

    /* ---------------- skeleton ---------------- */
    build() {
      this.root.innerHTML = `
      <div class="sm">
        <div class="sm-top">
          <div class="sm-floors" role="tablist" aria-label="Floors"></div>
          <div class="sm-seg" data-role="mode">
            <button data-mode="rentals" class="on">Rentals</button><button data-mode="categories">Categories</button>
          </div>
          <input class="sm-search" type="search" placeholder="Search supplier or category…" aria-label="Search the map">
          <div class="sm-spacer"></div>
          <div class="sm-menu-wrap">
            <button class="sm-btn" data-role="export">${ic('download')} Export</button>
            <div class="sm-menu" hidden>
              <button data-exp="print">Print this floor</button>
              <button data-exp="png">Download image (PNG)</button>
              <button data-exp="svg">Download drawing (SVG)</button>
              <button data-exp="csv">Contracts list (CSV)</button>
            </div>
          </div>
          ${this.opts.canEdit ? `<button class="sm-btn" data-role="edit">${ic('edit')} Edit layout</button>` : ''}
        </div>
        <div class="sm-bar" data-role="bar"></div>
        <div class="sm-body">
          <div class="sm-canvas">
            <svg xmlns="http://www.w3.org/2000/svg" aria-label="Store map"><g class="sm-vp"></g></svg>
            <div class="sm-zoom">
              <button data-z="in" title="Zoom in" aria-label="Zoom in">${ic('plus')}</button>
              <button data-z="out" title="Zoom out" aria-label="Zoom out">${ic('minus')}</button>
              <button data-z="fit" title="Fit the floor" aria-label="Fit the floor">${ic('fit')}</button>
            </div>
            <div class="sm-legend"></div>
            <div class="sm-banner"></div>
          </div>
          <aside class="sm-panel" aria-live="polite"></aside>
        </div>
      </div>`;
      this.el = this.root.querySelector('.sm');
      this.canvasEl = this.root.querySelector('.sm-canvas');
      this.svg = this.root.querySelector('.sm-canvas > svg');
      this.vp = this.root.querySelector('.sm-vp');
      this.panel = this.root.querySelector('.sm-panel');
      this.bar = this.root.querySelector('[data-role="bar"]');
      this.bindStatic();
    }
    injectCatStyles() {
      let st = this.root.querySelector('style[data-sm-cats]');
      if (!st) { st = document.createElement('style'); st.setAttribute('data-sm-cats', ''); this.root.appendChild(st); }
      const light = Object.entries(this.cats).map(([k, c]) => `--cat-${k}:${c.color};--catx-${k}:${shade(c.color, 42, 1.25)};`).join('');
      const dark = Object.entries(this.cats).map(([k, c]) => `--cat-${k}:${darken(c.color)};--catx-${k}:${shade(c.color, 64, 1.1)};`).join('');
      st.textContent = `.sm{${light}}
        @media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .sm{${dark}}}
        :root[data-theme="dark"] .sm{${dark}}`;
    }

    /* ---------------- events that never change ---------------- */
    bindStatic() {
      const r = this.root;
      r.querySelector('[data-role="mode"]').addEventListener('click', e => {
        const b = e.target.closest('[data-mode]'); if (!b) return;
        this.mode = b.dataset.mode;
        r.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
        this.renderBar(); this.renderSvg(); this.renderLegend();
      });
      const search = r.querySelector('.sm-search');
      search.addEventListener('input', () => {
        this.q = search.value.trim().toLowerCase();
        if (this.q && !this.editing) { this.sel = null; this.contractForm = null; }
        this.renderFloors(); this.renderSvg(); if (!this.editing) this.renderPanel();
      });
      search.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || !this.q) return;
        e.preventDefault();
        // jump to the first floor that has results and zoom to them
        let hits = this.objects.filter(o => this.matches(o, this.q));
        if (!hits.length && !this.editing) {
          const f = this.floors.find(fl => (this.layouts[fl.id] || []).some(o => this.matches(o, this.q)));
          if (f) { this.floorId = f.id; this.renderAll(); hits = this.objects.filter(o => this.matches(o, this.q)); }
        }
        if (hits.length) this.fitTo(hits); else this.toast('Nothing matches on any floor.', true);
      });
      const expBtn = r.querySelector('[data-role="export"]'), menu = expBtn.nextElementSibling;
      expBtn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
      menu.addEventListener('click', e => { const b = e.target.closest('[data-exp]'); if (!b) return; menu.hidden = true; this.exportAs(b.dataset.exp); });
      this._docClick = (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== expBtn) menu.hidden = true; };
      document.addEventListener('click', this._docClick);
      r.querySelector('[data-role="edit"]')?.addEventListener('click', () => this.startEdit());
      r.querySelector('.sm-zoom').addEventListener('click', e => {
        const b = e.target.closest('[data-z]'); if (!b) return;
        if (b.dataset.z === 'fit') return this.fit();
        const rect = this.svg.getBoundingClientRect();
        this.zoomAt(rect.width / 2, rect.height / 2, b.dataset.z === 'in' ? 1.3 : 1 / 1.3);
      });
      r.querySelector('.sm-floors').addEventListener('click', e => {
        const b = e.target.closest('[data-floor]'); if (!b) return;
        if (this.editing && b.dataset.floor !== this.floorId) return this.toast('Save or cancel your layout changes first.', true);
        this.floorId = b.dataset.floor; this.sel = null;
        this.userMoved = !!this.views[this.floorId];
        this.renderAll(); if (!this.views[this.floorId]) this.fit(true);
      });
      this.legendEl = r.querySelector('.sm-legend');
      this.legendEl.addEventListener('click', e => { if (e.target.closest('.sm-legend-head')) { this.legendCollapsed = !this.legendCollapsed; this.renderLegend(); } });

      // pointer interaction on the map
      this.svg.addEventListener('pointerdown', e => this.onDown(e));
      this.svg.addEventListener('pointermove', e => this.onMove(e));
      this.svg.addEventListener('pointerup', e => this.onUp(e));
      this.svg.addEventListener('pointercancel', e => this.onUp(e));
      this.svg.addEventListener('wheel', e => {
        e.preventDefault();
        const rect = this.svg.getBoundingClientRect();
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
      }, { passive: false });
      this.svg.addEventListener('keydown', e => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.id) { e.preventDefault(); this.select(e.target.dataset.id); }
      });
      this._onKey = (e) => this.onKey(e);
      document.addEventListener('keydown', this._onKey);
      this._onResize = () => { if (this.floor) this.applyView(); };
      window.addEventListener('resize', this._onResize);
      // fit the floor the first time the map becomes visible (e.g. when its tab is opened), and on resize until the user pans/zooms
      if (global.ResizeObserver) {
        this._ro = new ResizeObserver(() => {
          const r = this.canvasEl.getBoundingClientRect(), last = this._lastSize;
          this._lastSize = { w: r.width, h: r.height };
          if (!this.floor || !r.width) return;
          if (!this.userMoved || !last || !last.w) return this.fit(true);
          // keep whatever was in the middle of the map in the middle after a resize
          const v = this.view(); v.x += (r.width - last.w) / 2; v.y += (r.height - last.h) / 2; this.applyView();
        });
        this._ro.observe(this.canvasEl);
      }
      this._beforeUnload = (e) => { if (this.editing && this.dirty) { e.preventDefault(); e.returnValue = ''; } };
      window.addEventListener('beforeunload', this._beforeUnload);
    }
    destroy() {
      document.removeEventListener('click', this._docClick);
      document.removeEventListener('keydown', this._onKey);
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('beforeunload', this._beforeUnload);
      if (this._ro) this._ro.disconnect();
      this.root.innerHTML = '';
    }

    /* ---------------- render ---------------- */
    // Selection: `sel` is the main element (resize handles, properties panel); `selSet` holds every
    // selected element (Ctrl / Cmd / Shift + click, or Ctrl + drag on the floor, in Edit layout).
    // Setting `sel` selects that one element only.
    get sel() { return this._sel || null; }
    set sel(v) { this._sel = v || null; this.selSet = v ? new Set([v]) : new Set(); }
    selectedObjs() { return this.editing && this.draft ? this.draft.filter(o => this.selSet.has(o.id)) : []; }
    // Axis-aligned box of an element on the floor (rotation included).
    abox(o) {
      const r = normRot(o.rot) * Math.PI / 180, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      const ex = Math.abs(o.w / 2 * Math.cos(r)) + Math.abs(o.h / 2 * Math.sin(r));
      const ey = Math.abs(o.w / 2 * Math.sin(r)) + Math.abs(o.h / 2 * Math.cos(r));
      return { x0: cx - ex, x1: cx + ex, y0: cy - ey, y1: cy + ey };
    }
    bounds(list) {
      const bs = list.map(o => this.abox(o));
      return { x0: Math.min(...bs.map(b => b.x0)), x1: Math.max(...bs.map(b => b.x1)), y0: Math.min(...bs.map(b => b.y0)), y1: Math.max(...bs.map(b => b.y1)) };
    }
    // Smart guides: while dragging, snap the moving group's left / centre / right (top / middle / bottom)
    // to the same line of another element when it is within a few pixels, and show that line.
    guideSnap(moving, k) {
      const B = this.bounds(moving), thr = 7 / k, ids = new Set(moving.map(o => o.id));
      const mx = [B.x0, (B.x0 + B.x1) / 2, B.x1], my = [B.y0, (B.y0 + B.y1) / 2, B.y1];
      const others = (this.draft || []).filter(o => !ids.has(o.id) && this.typeOf(o).kind !== 'text').map(o => this.abox(o));
      let bx = null, by = null;
      others.forEach(b => {
        [b.x0, (b.x0 + b.x1) / 2, b.x1].forEach(c => mx.forEach(a => { const d = c - a; if (Math.abs(d) <= thr && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, at: c }; }));
        [b.y0, (b.y0 + b.y1) / 2, b.y1].forEach(c => my.forEach(a => { const d = c - a; if (Math.abs(d) <= thr && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, at: c }; }));
      });
      const lines = [];
      const near = (v, c) => Math.abs(v - c) < 0.75;
      if (bx) {
        const hit = others.filter(b => [b.x0, (b.x0 + b.x1) / 2, b.x1].some(c => near(c, bx.at)));
        const ys = [B.y0 + (by ? by.d : 0), B.y1 + (by ? by.d : 0), ...hit.flatMap(b => [b.y0, b.y1])];
        lines.push({ x1: bx.at, x2: bx.at, y1: Math.min(...ys) - 30, y2: Math.max(...ys) + 30 });
      }
      if (by) {
        const hit = others.filter(b => [b.y0, (b.y0 + b.y1) / 2, b.y1].some(c => near(c, by.at)));
        const xs = [B.x0 + (bx ? bx.d : 0), B.x1 + (bx ? bx.d : 0), ...hit.flatMap(b => [b.x0, b.x1])];
        lines.push({ y1: by.at, y2: by.at, x1: Math.min(...xs) - 30, x2: Math.max(...xs) + 30 });
      }
      return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, lines };
    }

    renderAll() { this.renderFloors(); this.renderBar(); this.renderSvg(); this.renderLegend(); this.renderPanel(); }

    renderFloors() {
      const el = this.root.querySelector('.sm-floors');
      el.innerHTML = this.floors.map(f => {
        const n = this.q ? (this.layouts[f.id] || []).filter(o => this.matches(o, this.q)).length : 0;
        return `<button class="sm-floor-tab ${f.id === this.floorId ? 'on' : ''}" role="tab" aria-selected="${f.id === this.floorId}" data-floor="${esc(f.id)}">${esc(f.name)}${this.q ? `<span class="sm-count">${n}</span>` : ''}</button>`;
      }).join('') + (this.floors.length ? '' : '<span class="sm-empty" style="padding:6px 10px">No floors yet</span>');
    }

    renderBar() {
      const bar = this.bar;
      if (this.editing) {
        const typeOpts = Object.entries(this.types).map(([k, t]) => `<option value="${k}">${esc(t.name)}${t.rentable ? ' (rentable)' : ''}</option>`).join('');
        bar.className = 'sm-bar sm-editbar';
        bar.innerHTML = `
          <span class="sm-label">Editing ${esc(this.floor?.name || '')}</span>
          <select class="sm-select" data-e="type" aria-label="Type to add">${typeOpts}</select>
          <button class="sm-btn" data-e="add">${ic('plus')} Add</button>
          <span class="sm-sep"></span>
          <button class="sm-btn icon" data-e="dup" title="Duplicate (Ctrl+D)" ${this.selSet.size ? '' : 'disabled'}>${ic('copy')}</button>
          <button class="sm-btn icon" data-e="rot" title="Rotate 90°" ${this.selSet.size ? '' : 'disabled'}>${ic('rotate')}</button>
          <button class="sm-btn" data-e="std" title="Give the selected element — or every gondola, end cap, side, basket and display on this floor — its standard size">${ic('fit')} Standard size</button>
          <button class="sm-btn icon danger" data-e="del" title="Delete (Del)" ${this.selSet.size ? '' : 'disabled'}>${ic('trash')}</button>
          <span class="sm-sep"></span>
          <button class="sm-btn icon" data-e="undo" title="Undo (Ctrl+Z)" ${this.undoStack.length ? '' : 'disabled'}>${ic('undo')}</button>
          <button class="sm-btn icon" data-e="redo" title="Redo (Ctrl+Y)" ${this.redoStack.length ? '' : 'disabled'}>${ic('redo')}</button>
          <label class="sm-hint" style="display:flex;align-items:center;gap:5px">Snap
            <select class="sm-select" data-e="grid">${[0, 5, 10, 20, 50].map(g => `<option value="${g}" ${g === this.grid ? 'selected' : ''}>${g ? g : 'off'}</option>`).join('')}</select></label>
          <span class="sm-sep"></span>
          <button class="sm-btn" data-e="types">${ic('layers')} Types</button>
          <button class="sm-btn" data-e="versions">${ic('history')} Versions</button>
          <div class="sm-spacer"></div>
          <button class="sm-btn" data-e="cancel">Cancel</button>
          <button class="sm-btn primary" data-e="save">${ic('check')} Save layout</button>`;
        bar.onclick = (e) => { const b = e.target.closest('[data-e]'); if (b && b.tagName === 'BUTTON') this.editAction(b.dataset.e); };
        bar.querySelector('[data-e="grid"]').onchange = (e) => { this.grid = Number(e.target.value); };
        return;
      }
      bar.className = 'sm-bar';
      bar.onclick = null;
      if (this.mode === 'categories') {
        bar.innerHTML = `<span class="sm-hint">Gondolas and shelves are coloured by department. Click any gondola to see its sections.</span>`;
        return;
      }
      const spots = this.objects.filter(o => this.isRentable(o));
      const counts = {}; spots.forEach(o => { const s = this.statusOf(o); counts[s] = (counts[s] || 0) + 1; });
      const spotTypes = [...new Set(spots.map(o => o.type))];
      bar.innerHTML = Object.entries(STATUS).map(([k, s]) => `
        <button class="sm-chip ${this.statusFilter.has(k) ? 'on' : ''}" data-st="${k}" aria-pressed="${this.statusFilter.has(k)}">
          <i style="background:var(--st-${k});border-color:var(--st-${k}-s)"></i>${esc(s.label)} <b>${counts[k] || 0}</b></button>`).join('') + `
        <select class="sm-select" data-role="typefilter" aria-label="Spot type">
          <option value="">All spot types</option>
          ${spotTypes.map(t => `<option value="${t}" ${t === this.typeFilter ? 'selected' : ''}>${esc(this.types[t]?.name || t)}</option>`).join('')}
        </select>
        ${this.statusFilter.size || this.typeFilter ? '<button class="sm-btn" data-role="clearf">Clear filters</button>' : ''}`;
      bar.onclick = (e) => {
        const c = e.target.closest('[data-st]');
        if (c) { const k = c.dataset.st; this.statusFilter.has(k) ? this.statusFilter.delete(k) : this.statusFilter.add(k); this.renderBar(); this.renderSvg(); return; }
        if (e.target.closest('[data-role="clearf"]')) { this.statusFilter.clear(); this.typeFilter = ''; this.renderBar(); this.renderSvg(); }
      };
      bar.querySelector('[data-role="typefilter"]').onchange = (e) => { this.typeFilter = e.target.value; this.renderBar(); this.renderSvg(); };
    }

    renderLegend() {
      const L = this.legendEl;
      L.classList.toggle('collapsed', this.legendCollapsed);
      if (!this.floor) { L.hidden = true; return; }
      L.hidden = false;
      let items;
      if (this.mode === 'rentals') {
        items = Object.entries(STATUS).map(([k, s]) => `<span><i style="background:var(--st-${k});border-color:var(--st-${k}-s)"></i>${esc(s.label)}</span>`).join('');
      } else {
        const used = new Set(this.objects.flatMap(o => [...(o.sectionsA || []), ...(o.sectionsB || [])].map(s => s.cat || 'other')));
        items = Object.entries(this.cats).filter(([k]) => used.has(k)).map(([k, c]) => `<span>${iconHtml(c.icon || (ICONS[k] ? k : 'other'), `var(--catx-${k})`)}${esc(c.name)}</span>`).join('');
      }
      L.innerHTML = `<div class="sm-legend-head"><span>${this.mode === 'rentals' ? 'Rental status' : 'Departments'}</span><span>${this.legendCollapsed ? 'Show' : 'Hide'}</span></div><div class="sm-legend-items">${items}</div>`;
    }

    objSvg(o) {
      const t = this.typeOf(o), kind = t.kind, rot = normRot(o.rot);
      const flip = rot > 90 && rot <= 270;
      const w = Math.max(1, o.w), h = Math.max(1, o.h);
      const tr = `translate(${o.x} ${o.y})${rot ? ` rotate(${rot} ${w / 2} ${h / 2})` : ''}`;
      const q = this.q;
      const hit = q && this.matches(o, q);
      let dim = false;
      if (q && !hit) dim = true;
      const status = this.statusOf(o);
      if (!this.editing && this.mode === 'rentals') {
        if (this.statusFilter.size && (!status || !this.statusFilter.has(status))) dim = true;
        if (this.typeFilter && o.type !== this.typeFilter) dim = true;
      }
      const look = t.look || (kind === 'fixture' ? (/fridge|freezer/.test(o.type) ? 'cold' : 'shelf') : o.type);
      const cls = ['sm-o', `sm-k-${kind}`, `sm-look-${look}`, dim ? 'dim' : '', hit ? 'hit' : '', (this.editing ? this.selSet.has(o.id) : this.sel === o.id) ? 'sel' : ''];
      const P = this.pid;
      const f1 = (n) => (+n).toFixed(1);
      const shadow = (rx, d = Math.min(8, Math.max(2.5, Math.min(w, h) * 0.08))) =>
        `<rect class="sm-shadow" x="${f1(d * 0.5)}" y="${f1(d)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"/>`;
      let inner = '';

      if (kind === 'fixture') {
        const lanes = (o.sectionsB && o.sectionsB.length) ? [o.sectionsA || [], o.sectionsB] : [o.sectionsA || []];
        const horiz = w >= h, across = horiz ? h : w, along = horiz ? w : h;
        const rx = Math.min(12, across * 0.16);
        const cold = look === 'cold';
        const spine = lanes.length === 2 ? Math.max(3, Math.min(9, across * 0.07)) : 0;
        const laneT = (across - spine) / lanes.length;
        const accentT = Math.max(2.5, Math.min(7, laneT * 0.13));
        inner += shadow(rx);
        inner += `<rect class="sm-fixbase ${cold ? 'sm-cold' : ''}" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"${cold ? ` style="fill:url(#${P}-ice)"` : ''}/>`;
        inner += `<clipPath id="${P}-c-${esc(o.id)}"><rect x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"/></clipPath><g clip-path="url(#${P}-c-${esc(o.id)})">`;
        lanes.forEach((secs, li) => {
          const total = secs.reduce((s2, x) => s2 + (Number(x.size) || 1), 0) || 1;
          const lane0 = li === 0 ? 0 : laneT + spine;               // where this lane starts across the fixture
          const outerEdge = li === 0 ? 0 : across - accentT;           // the customer-facing edge of the lane
          let pos = 0;
          secs.forEach((sec, si) => {
            const len = along * (Number(sec.size) || 1) / total, cat = esc(sec.cat || 'other');
            const R = (a, b, c, d) => horiz ? [a, b, c, d] : [b, a, d, c]; // (along, across) → (x, y)
            const [x, y, sw, sh] = R(pos, lane0, len, laneT);
            inner += `<rect class="sm-sec" x="${f1(x)}" y="${f1(y)}" width="${f1(sw)}" height="${f1(sh)}" style="fill:var(--cat-${cat}, var(--cat-other))"/>`;
            // department accent strip on the aisle side, like a shelf-edge label rail
            const [ax, ay, aw, ah] = R(pos, outerEdge, len, accentT);
            inner += `<rect class="sm-accent" x="${f1(ax)}" y="${f1(ay)}" width="${f1(aw)}" height="${f1(ah)}" style="fill:var(--catx-${cat}, var(--catx-other))"/>`;
            // shelf bays (≈ 1 m) or glass doors for fridges
            const bay = cold ? 58 : 92;
            for (let b = bay; b < len - bay * 0.35; b += bay) {
              const [lx1, ly1] = R(pos + b, lane0 + (li === 0 ? accentT : 0), 0, 0), [lx2, ly2] = R(pos + b, lane0 + laneT - (li === 0 ? 0 : accentT), 0, 0);
              inner += `<line class="${cold ? 'sm-door' : 'sm-bay'}" x1="${f1(lx1)}" y1="${f1(ly1)}" x2="${f1(lx2)}" y2="${f1(ly2)}"/>`;
            }
            if (si > 0) { const [dx1, dy1] = R(pos, lane0, 0, 0), [dx2, dy2] = R(pos, lane0 + laneT, 0, 0); inner += `<line class="sm-secdiv" x1="${f1(dx1)}" y1="${f1(dy1)}" x2="${f1(dx2)}" y2="${f1(dy2)}"/>`; }
            const [tx, ty, tw, th] = R(pos, lane0 + (li === 0 ? accentT : 0), len, laneT - accentT);
            const catIcon = (this.cats[sec.cat] && this.cats[sec.cat].icon) || (ICONS[sec.cat] ? sec.cat : 'other');
            inner += `<g class="sm-secgrp" style="--ic:var(--catx-${cat}, var(--catx-other))">${iconLabel(sec.label, catIcon, tx, ty, tw, th, { max: 21, flip, cls: 'sm-sectext', maxIcon: 26 })}</g>`;
            pos += len;
          });
        });
        if (spine) inner += horiz ? `<rect class="sm-spine" x="0" y="${f1(laneT)}" width="${f1(w)}" height="${f1(spine)}"/>` : `<rect class="sm-spine" x="${f1(laneT)}" y="0" width="${f1(spine)}" height="${f1(h)}"/>`;
        if (cold) inner += `<rect class="sm-glare" x="0" y="0" width="${f1(w)}" height="${f1(h)}" style="fill:url(#${P}-glare)"/>`;
        inner += `</g><rect class="sm-fixedge" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"/>`;
        if (status && this.mode === 'rentals') {
          cls.push('sm-fixrent', `sm-st-${status}`);
          inner += `<rect class="sm-fixstatus" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"/>`;
          const who = this.displayName(o);
          if (who && who !== o.label) {
            const bw = Math.min(w * 0.7, Math.max(90, who.length * 13 + 24)), bh = Math.min(28, h * 0.32);
            inner += `<g class="sm-fixtag"><rect class="sm-sb" x="${f1((w - bw) / 2)}" y="${f1((h - bh) / 2)}" width="${f1(bw)}" height="${f1(bh)}" rx="${f1(bh / 2)}"/>${textSvg(who, (w - bw) / 2, (h - bh) / 2, bw, bh, { max: 15, flip })}</g>`;
          }
        }
        if (!(o.sectionsA || []).length && o.label) inner += textSvg(o.label, 0, 0, w, h, { max: 22, flip, cls: 'sm-sectext' });

      } else if (kind === 'spot') {
        const st = this.mode === 'rentals' && status ? status : 'neutral';
        cls.push('sm-spot', `sm-st-${st}`, 'sm-rentable');
        const name = this.displayName(o), m = Math.min(w, h);
        const round = look === 'display' ? Math.min(18, m * 0.28) : look === 'promo_zone' ? Math.min(20, m * 0.35) : Math.min(8, m * 0.2);
        inner += shadow(round);
        inner += `<rect class="sm-sb" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(round)}"/>`;
        if (look === 'basket_side') inner += `<rect x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(round)}" style="fill:url(#${P}-mesh)" pointer-events="none"/>`;
        if (look === 'display' && m > 40) inner += `<rect class="sm-ring" x="${f1(m * 0.08)}" y="${f1(m * 0.08)}" width="${f1(w - m * 0.16)}" height="${f1(h - m * 0.16)}" rx="${f1(Math.max(2, round - m * 0.08))}"/>`;
        if (t.screen) {
          const b = Math.max(2.5, m * 0.12);
          inner += `<rect class="sm-bezel" x="${f1(b)}" y="${f1(b)}" width="${f1(w - b * 2)}" height="${f1(h - b * 2)}" rx="${f1(Math.max(1, round - b))}"/>`;
        }
        if (look === 'fridge_door' || look === 'freezer') {
          const hl = look === 'fridge_door' ? [w * 0.82, h * 0.3, w * 0.82, h * 0.7] : [w * 0.3, h * 0.18, w * 0.7, h * 0.18];
          inner += `<line class="sm-handleline" x1="${f1(hl[0])}" y1="${f1(hl[1])}" x2="${f1(hl[2])}" y2="${f1(hl[3])}"/>`;
        }
        // small status pip in the corner, readable even when the name is long
        if (this.mode === 'rentals' && m >= 30 && st !== 'free') inner += `<circle class="sm-pip" cx="${f1(w - Math.min(10, m * 0.2))}" cy="${f1(Math.min(10, m * 0.2))}" r="${f1(Math.min(4.5, m * 0.08))}"/>`;
        const tw = t.screen ? w * 0.8 : w, th = t.screen ? h * 0.8 : h;
        const spotIcon = t.icon || (t.screen ? 'screen' : (ICONS[o.type] ? o.type : 'endcap'));
        const roomy = Math.min(w, h) >= 38;                     // end caps, displays, baskets, fridge doors…
        if (name) inner += roomy
          ? iconLabel(name, spotIcon, (w - tw) / 2, (h - th) / 2, tw, th, { max: 24, flip, cls: 'sm-spottext', iconCls: 'sm-icon sm-spoticon', maxIcon: 22, stack: true })
          : textSvg(name, (w - tw) / 2, (h - th) / 2, tw, th, { max: 24, flip, cls: 'sm-spottext' });
        else if (this.editing) inner += textSvg(t.name, 0, 0, w, h, { max: 20, flip, cls: 'sm-free-plus' });
        else if (this.mode === 'rentals') inner += roomy
          ? iconLabel('Free', spotIcon, 0, 0, w, h, { max: 15, flip, cls: 'sm-free-plus', iconCls: 'sm-icon sm-spoticon', maxIcon: 20, stack: true })
          : textSvg('+', 0, 0, w, h, { max: 22, flip, cls: 'sm-free-plus' });
        else if (roomy) inner += iconSvg(spotIcon, w / 2 - 10, h / 2 - 10, 20, 'sm-icon sm-spoticon');

      } else if (kind === 'wall') {
        cls.push('sm-wall'); inner += `<rect x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(Math.min(w, h) / 2)}"/>`;

      } else if (kind === 'text') {
        if (look === 'aisle') {
          inner += `<rect class="sm-aislepill" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(h / 2)}"/>` + textSvg(o.label || 'Aisle', 0, 0, w, h, { max: 22, flip, cls: 'sm-aisletext' });
        } else if (look === 'zone') {
          inner += `<rect x="0" y="0" width="${f1(w)}" height="${f1(h)}" fill="transparent"/>` + textSvg((o.label || 'Zone').toUpperCase(), 0, 0, w, h, { max: 56, flip, cls: 'sm-zonetext' });
        } else {
          inner += `<rect x="0" y="0" width="${f1(w)}" height="${f1(h)}" fill="transparent"/>` + textSvg(o.label || 'Label', 0, 0, w, h, { max: 40, flip });
        }

      } else {
        cls.push('sm-fixed');
        const rx = Math.min(8, Math.min(w, h) * 0.25);
        inner += shadow(rx) + `<rect class="sm-fixedbase" x="0" y="0" width="${f1(w)}" height="${f1(h)}" rx="${f1(rx)}"/>`;
        if (look === 'checkout') inner += `<rect class="sm-belt" x="${f1(w * 0.06)}" y="${f1(h * 0.28)}" width="${f1(w * 0.52)}" height="${f1(h * 0.44)}" rx="${f1(h * 0.2)}"/>` + textSvg(o.label || t.name, w * 0.6, 0, w * 0.4, h, { max: 18, cls: 'sm-fixedtext' });
        else if (look === 'entrance') inner += `<path class="sm-arrow" d="M ${f1(w / 2 - 28)} ${f1(h * 0.28)} L ${f1(w / 2)} ${f1(h * 0.1)} L ${f1(w / 2 + 28)} ${f1(h * 0.28)}"/>` + textSvg(o.label || t.name, 0, h * 0.3, w, h * 0.7, { max: 26, cls: 'sm-fixedtext' });
        else inner += textSvg(o.label || t.name, 0, 0, w, h, { max: 20, flip, cls: 'sm-fixedtext' });
      }
      const rentLike = kind === 'spot' || (kind === 'fixture' && t.rentable);
      const focusable = !this.editing && rentLike;
      const aria = rentLike ? ` role="button" aria-label="${esc(`${t.name}: ${this.displayName(o) || 'free'}${status ? ', ' + STATUS[status].label : ''}`)}"` : '';
      return `<g class="${cls.filter(Boolean).join(' ')}" data-id="${esc(o.id)}" transform="${tr}"${focusable ? ' tabindex="0"' : ''}${aria}>${inner}</g>`;
    }

    defsSvg() {
      const P = this.pid;
      return `<defs>
        <pattern id="${P}-tiles" width="120" height="120" patternUnits="userSpaceOnUse">
          <rect width="120" height="120" class="sm-tile"/><path d="M120 0H0V120" class="sm-tileline"/></pattern>
        <pattern id="${P}-mesh" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="10" class="sm-meshline"/><line x1="0" y1="0" x2="10" y2="0" class="sm-meshline"/></pattern>
        <linearGradient id="${P}-ice" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="sm-ice-a"/><stop offset="1" class="sm-ice-b"/></linearGradient>
        <linearGradient id="${P}-glare" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".45" stop-color="#fff" stop-opacity=".0"/>
          <stop offset=".5" stop-color="#fff" stop-opacity=".22"/><stop offset=".6" stop-color="#fff" stop-opacity=".0"/></linearGradient>
      </defs>`;
    }

    renderSvg() {
      const f = this.floor;
      this.canvasEl.classList.toggle('editing', this.editing);
      this.svg.classList.toggle('sm-mode-rentals', this.mode === 'rentals');
      this.svg.classList.toggle('sm-mode-categories', this.mode === 'categories');
      if (!f) { this.vp.innerHTML = ''; return; }
      let html = this.defsSvg() + `<rect class="sm-floor-rect" x="0" y="0" width="${f.width}" height="${f.height}" rx="18"/>
        <rect x="0" y="0" width="${f.width}" height="${f.height}" rx="18" style="fill:url(#${this.pid}-tiles)" pointer-events="none"/>
        <rect class="sm-outerwall" x="0" y="0" width="${f.width}" height="${f.height}" rx="18"/>`;
      if (this.editing && this.grid) {
        const step = 100; let lines = '';
        for (let x = step; x < f.width; x += step) lines += `<line class="sm-gridline" x1="${x}" y1="0" x2="${x}" y2="${f.height}"/>`;
        for (let y = step; y < f.height; y += step) lines += `<line class="sm-gridline" x1="0" y1="${y}" x2="${f.width}" y2="${y}"/>`;
        html += `<g>${lines}</g>`;
      }
      const tr = f.trace;
      if (tr && tr.src && tr.visible !== false) {
        html += `<image class="sm-trace" href="${esc(tr.src)}" x="${tr.x || 0}" y="${tr.y || 0}" width="${tr.w || f.width}" height="${tr.h || f.height}" opacity="${tr.opacity ?? 0.35}" preserveAspectRatio="none"/>`;
      }
      // fixtures first, spots on top so they stay clickable
      const order = (o) => ({ wall: 0, fixed: 1, fixture: 2, text: 4, spot: 3 }[this.typeOf(o).kind] ?? 2);
      const objs = [...this.objects].sort((a, b) => order(a) - order(b));
      html += `<g class="sm-objs">${objs.map(o => this.objSvg(o)).join('')}</g><g class="sm-overlay">${this.overlaySvg()}</g>`;
      this.vp.innerHTML = html;
      let empty = this.canvasEl.querySelector('.sm-emptyfloor');
      if (!objs.length && !this.editing) {
        if (!empty) { empty = document.createElement('div'); empty.className = 'sm-emptyfloor'; this.canvasEl.appendChild(empty); }
        empty.innerHTML = `<p class="big">${esc(f.name)} has no layout yet</p><p>${this.opts.canEdit ? 'Open <b>Edit layout</b>, upload a picture of the plan as a tracing image, then draw the gondolas and spots over it.' : 'An admin needs to draw this floor first.'}</p>`;
      } else if (empty) empty.remove();
      this.applyView();
    }
    overlaySvg() {
      if (!this.editing) return '';
      const k = this.view().k;
      let out = (this.guides || []).map(g => `<line class="sm-guide" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke-width="${1.5 / k}"/>`).join('');
      if (this.box) out += `<rect class="sm-boxsel" x="${this.box.x}" y="${this.box.y}" width="${this.box.w}" height="${this.box.h}" stroke-width="${1.5 / k}"/>`;
      const sel = this.selectedObjs();
      if (sel.length > 1) {
        out += sel.map(o => { const r = normRot(o.rot); return `<g transform="translate(${o.x} ${o.y})${r ? ` rotate(${r} ${o.w / 2} ${o.h / 2})` : ''}"><rect class="sm-selbox" x="${-3 / k}" y="${-3 / k}" width="${o.w + 6 / k}" height="${o.h + 6 / k}" stroke-width="${2 / k}"/></g>`; }).join('');
        const b = this.bounds(sel), p = 10 / k;
        return out + `<rect class="sm-groupbox" x="${b.x0 - p}" y="${b.y0 - p}" width="${b.x1 - b.x0 + 2 * p}" height="${b.y1 - b.y0 + 2 * p}" stroke-width="${1.5 / k}"/>`;
      }
      if (!this.sel) return out;
      const o = this.draft.find(x => x.id === this.sel); if (!o) return out;
      const rot = normRot(o.rot), hs = 6 / k;
      const tr = `translate(${o.x} ${o.y})${rot ? ` rotate(${rot} ${o.w / 2} ${o.h / 2})` : ''}`;
      const hd = (name, x, y) => `<rect class="sm-handle" data-h="${name}" x="${x - hs}" y="${y - hs}" width="${hs * 2}" height="${hs * 2}" rx="${hs * 0.3}" stroke-width="${2 / k}"/>`;
      return out + `<g transform="${tr}"><rect class="sm-selbox" x="${-4 / k}" y="${-4 / k}" width="${o.w + 8 / k}" height="${o.h + 8 / k}" stroke-width="${2 / k}"/>
        ${hd('e', o.w, o.h / 2)}${hd('s', o.w / 2, o.h)}${hd('se', o.w, o.h)}</g>`;
    }

    /* ---------------- view: pan & zoom ---------------- */
    view() { return this.views[this.floorId] || (this.views[this.floorId] = { x: 0, y: 0, k: 0.3 }); }
    applyView() { const v = this.view(); this.vp.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`); }
    fit(initial) {
      const f = this.floor; if (!f) return;
      const r = this.svg.getBoundingClientRect(); if (!r.width) return;
      const pad = 16, k = Math.min((r.width - pad * 2) / f.width, (r.height - pad * 2) / f.height);
      this.views[this.floorId] = { k, x: (r.width - f.width * k) / 2, y: (r.height - f.height * k) / 2 };
      this.applyView(); if (this.editing && !initial) this.renderOverlay();
    }
    fitTo(objs) {
      const r = this.svg.getBoundingClientRect(); if (!r.width || !objs.length) return;
      const x0 = Math.min(...objs.map(o => o.x)), y0 = Math.min(...objs.map(o => o.y));
      const x1 = Math.max(...objs.map(o => o.x + o.w)), y1 = Math.max(...objs.map(o => o.y + o.h));
      const pad = 220, k = clamp(Math.min(r.width / (x1 - x0 + pad * 2), r.height / (y1 - y0 + pad * 2)), 0.05, 0.9);
      this.views[this.floorId] = { k, x: r.width / 2 - ((x0 + x1) / 2) * k, y: r.height / 2 - ((y0 + y1) / 2) * k };
      this.userMoved = true; this.applyView(); if (this.editing) this.renderOverlay();
    }
    zoomAt(sx, sy, factor) {
      const v = this.view(), f = this.floor; if (!f) return;
      const r = this.svg.getBoundingClientRect();
      const minK = Math.min(r.width / f.width, r.height / f.height) * 0.5, maxK = 4;
      const k = clamp(v.k * factor, minK, maxK);
      this.userMoved = true;
      v.x = sx - (sx - v.x) * (k / v.k); v.y = sy - (sy - v.y) * (k / v.k); v.k = k;
      this.applyView(); if (this.editing) this.renderOverlay();
    }
    toWorld(cx, cy) { const r = this.svg.getBoundingClientRect(), v = this.view(); return { x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k }; }
    centerOn(o) {
      const r = this.svg.getBoundingClientRect(), v = this.view();
      const k = Math.max(v.k, Math.min(r.width / 900, r.height / 650));
      this.views[this.floorId] = { k, x: r.width / 2 - (o.x + o.w / 2) * k, y: r.height / 2 - (o.y + o.h / 2) * k };
      this.applyView();
    }
    renderOverlay() { const g = this.vp.querySelector('.sm-overlay'); if (g) g.innerHTML = this.overlaySvg(); }

    /* ---------------- pointer handling ---------------- */
    onDown(e) {
      this.svg.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) { // pinch
        const [a, b] = [...this.pointers.values()];
        this.gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
      const handle = e.target.closest('.sm-handle');
      const g = e.target.closest('.sm-o');
      const start = { x: e.clientX, y: e.clientY };
      if (this.editing && handle && this.sel && this.selSet.size === 1) {
        const o = this.draft.find(x => x.id === this.sel);
        this.gesture = { type: 'resize', h: handle.dataset.h, start, orig: clone(o), snap: JSON.stringify(this.draft), moved: false };
        return;
      }
      const add = e.ctrlKey || e.metaKey || e.shiftKey;
      if (this.editing && g) {
        const id = g.dataset.id;
        if (add) {                               // add to / remove from the selection
          if (this.selSet.has(id)) { this.selSet.delete(id); if (this._sel === id) this._sel = [...this.selSet].pop() || null; }
          else { this.selSet.add(id); this._sel = id; }
          this.renderBar(); this.renderSvg(); this.renderPanel();
          if (!this.selSet.has(id)) return;
        } else if (!this.selSet.has(id)) { this.sel = id; this.renderBar(); this.renderSvg(); this.renderPanel(); }
        else this._sel = id;                     // a member of the group: keep the group, it moves together
        const origs = new Map(this.selectedObjs().map(o => [o.id, { x: o.x, y: o.y }]));
        this.gesture = { type: 'drag', id, start, origs, add, snap: JSON.stringify(this.draft), moved: false };
        return;
      }
      if (this.editing && !g && add) {           // Ctrl + drag on the floor: select everything in the box
        this.gesture = { type: 'box', start, w0: this.toWorld(e.clientX, e.clientY), keep: new Set(this.selSet), moved: false };
        return;
      }
      const v = this.view();
      this.gesture = { type: 'pan', start, orig: { x: v.x, y: v.y }, moved: false, target: g ? g.dataset.id : null };
    }
    onMove(e) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const G = this.gesture; if (!G) return;
      if (G.type === 'pinch' && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), r = this.svg.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.zoomAt(mid.x - r.left, mid.y - r.top, d / G.d);
        const v = this.view(); v.x += mid.x - G.mid.x; v.y += mid.y - G.mid.y; this.applyView();
        G.d = d; G.mid = mid; return;
      }
      const dx = e.clientX - G.start.x, dy = e.clientY - G.start.y;
      if (!G.moved && Math.hypot(dx, dy) < 4) return;
      G.moved = true;
      const k = this.view().k;
      if (G.type === 'pan') {
        this.userMoved = true;
        this.canvasEl.classList.add('panning');
        const v = this.view(); v.x = G.orig.x + dx; v.y = G.orig.y + dy; this.applyView();
      } else if (G.type === 'box') {
        const w = this.toWorld(e.clientX, e.clientY);
        this.box = { x: Math.min(w.x, G.w0.x), y: Math.min(w.y, G.w0.y), w: Math.abs(w.x - G.w0.x), h: Math.abs(w.y - G.w0.y) };
        this.renderOverlay();
      } else if (G.type === 'drag') {
        const po = G.origs.get(G.id);
        let ddx = this.snapV(po.x + dx / k) - po.x, ddy = this.snapV(po.y + dy / k) - po.y;
        const sel = this.selectedObjs();
        this.guides = [];
        if (!e.altKey) {                         // Alt: move freely, no guides
          const g2 = this.guideSnap(sel.map(o => { const O = G.origs.get(o.id); return Object.assign({}, o, { x: O.x + ddx, y: O.y + ddy }); }), k);
          ddx += g2.dx; ddy += g2.dy; this.guides = g2.lines;
        }
        sel.forEach(o => {
          const O = G.origs.get(o.id); if (!O) return;
          o.x = Math.round((O.x + ddx) * 10) / 10; o.y = Math.round((O.y + ddy) * 10) / 10;
          const el = this.vp.querySelector(`.sm-o[data-id="${CSS.escape(o.id)}"]`);
          const rot = normRot(o.rot);
          if (el) el.setAttribute('transform', `translate(${o.x} ${o.y})${rot ? ` rotate(${rot} ${o.w / 2} ${o.h / 2})` : ''}`);
        });
        this.renderOverlay();
      } else if (G.type === 'resize') {
        const o = this.draft.find(x => x.id === this.sel), O = G.orig, rot = normRot(O.rot) * Math.PI / 180;
        const ldx = (dx * Math.cos(rot) + dy * Math.sin(rot)) / k, ldy = (-dx * Math.sin(rot) + dy * Math.cos(rot)) / k;
        let w = O.w, h = O.h;
        if (G.h.includes('e')) w = Math.max(8, this.snapV(O.w + ldx));
        if (G.h.includes('s')) h = Math.max(8, this.snapV(O.h + ldy));
        // keep the object's own top-left corner fixed on screen while it rotates around its centre
        const R = (px, py) => [px * Math.cos(rot) - py * Math.sin(rot), px * Math.sin(rot) + py * Math.cos(rot)];
        const [ax, ay] = R(-O.w / 2, -O.h / 2), [bx, by] = R(-w / 2, -h / 2);
        o.w = w; o.h = h;
        o.x = Math.round((O.x + O.w / 2 + ax) - (w / 2 + bx)); o.y = Math.round((O.y + O.h / 2 + ay) - (h / 2 + by));
        const el = this.vp.querySelector(`.sm-o[data-id="${CSS.escape(o.id)}"]`);
        if (el) el.outerHTML = this.objSvg(o);
        this.renderOverlay();
      }
    }
    onUp(e) {
      this.pointers.delete(e.pointerId);
      const G = this.gesture;
      if (this.pointers.size) { if (G && G.type === 'pinch') this.gesture = null; return; }
      this.gesture = null;
      this.canvasEl.classList.remove('panning');
      if (!G) return;
      if (G.type === 'box') {
        const B = this.box; this.box = null;
        if (G.moved && B) {
          const inBox = this.draft.filter(o => { const b = this.abox(o); return b.x1 >= B.x && b.x0 <= B.x + B.w && b.y1 >= B.y && b.y0 <= B.y + B.h; });
          this.selSet = new Set([...G.keep, ...inBox.map(o => o.id)]);
          this._sel = inBox.length ? inBox[inBox.length - 1].id : (this._sel && this.selSet.has(this._sel) ? this._sel : [...this.selSet].pop() || null);
        }
        this.renderBar(); this.renderSvg(); this.renderPanel(); return;
      }
      if (G.type === 'drag') this.guides = [];
      if ((G.type === 'drag' || G.type === 'resize') && G.moved) {
        this.pushUndo(G.snap); this.dirty = true; this.renderSvg(); this.renderPanel(); this.renderBar(); return;
      }
      // A plain click on one member of a group selects just that one.
      if (G.type === 'drag' && !G.add && this.selSet.size > 1) { this.sel = G.id; this.renderBar(); this.renderSvg(); this.renderPanel(); return; }
      if (G.type === 'drag') { this.renderOverlay(); return; }
      if (G.type === 'pan' && !G.moved) {
        if (this.editing) { if (this.sel) { this.sel = null; this.renderBar(); this.renderSvg(); this.renderPanel(); } return; }
        if (this.assignFor && G.target) return this.finishAssign(G.target);
        if (G.target) this.select(G.target); else if (this.sel) { this.sel = null; this.renderSvg(); this.renderPanel(); }
      }
    }
    snapV(v) { return this.grid ? Math.round(v / this.grid) * this.grid : Math.round(v); }

    onKey(e) {
      if (!this.root.isConnected) return;
      const inField = e.target.closest && e.target.closest('input, select, textarea, [contenteditable="true"]');
      if (document.querySelector('.sm-modal')) return;
      if (!this.editing) {
        if (e.key === 'Escape' && (this.sel || this.assignFor)) { this.cancelAssign(); this.sel = null; this.renderSvg(); this.renderPanel(); }
        return;
      }
      if (inField) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); return this.editAction('undo'); }
      if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); return this.editAction('redo'); }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); return this.editAction('dup'); }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return this.editAction('save'); }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.selSet = new Set(this.draft.map(o => o.id)); this._sel = this.draft.length ? this.draft[this.draft.length - 1].id : null;
        this.renderBar(); this.renderSvg(); this.renderPanel(); return;
      }
      if (!this.sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return this.editAction('del'); }
      if (e.key === 'Escape') { this.sel = null; this.renderBar(); this.renderSvg(); this.renderPanel(); return; }
      const step = e.shiftKey ? 20 : 2;
      const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (mv) {
        e.preventDefault();
        this.pushUndo(); this.selectedObjs().forEach(o => { o.x += mv[0]; o.y += mv[1]; });
        this.dirty = true; this.renderSvg(); this.renderPanel();
      }
    }

    /* ---------------- selection ---------------- */
    select(id) {
      this.sel = id; this.contractForm = null;
      this.renderSvg(); this.renderPanel();
    }
    focusSpot(id) {
      const found = this.findObject(id); if (!found) return this.toast('That spot is not on the map.', true);
      if (this.editing && found.floorId !== this.floorId) return this.toast('Save or cancel your layout changes first.', true);
      this.floorId = found.floorId; this.sel = id; this.contractForm = null;
      this.renderAll(); this.centerOn(found.o);
    }

    /* ---------------- side panel ---------------- */
    renderPanel() {
      const P = this.panel;
      P.onclick = null;
      this.root.classList.toggle('sm-has-sel', !!this.sel && !this.editing);
      if (this.editing) return this.renderEditPanel();
      const o = this.sel ? this.objects.find(x => x.id === this.sel) : null;
      if (!o) return this.renderOverview();
      const t = this.typeOf(o);
      if (!t.rentable || (t.kind !== 'spot' && t.kind !== 'fixture')) {
        const lanes = [['Side A', o.sectionsA || []], ['Side B', o.sectionsB || []]].filter(([, s]) => s.length);
        P.innerHTML = `
          <div class="sm-p-head"><h3>${esc(o.label || t.name)}<button class="sm-close" data-p="close" aria-label="Close">${ic('close')}</button></h3>
          <div class="sm-sub">${esc(t.name)} · ${esc(this.floor.name)}</div></div>
          ${lanes.map(([name, secs]) => `<div class="sm-p-sec"><h4>${lanes.length > 1 ? name : 'Sections'}</h4><div class="sm-sec-list">
            ${secs.map(s => `<div>${iconHtml(this.cats[s.cat]?.icon || (ICONS[s.cat] ? s.cat : 'other'), `var(--catx-${esc(s.cat || 'other')})`)}${esc(s.label)} <span class="sm-hint">· ${esc(this.cats[s.cat]?.name || 'Other')}</span></div>`).join('')}</div></div>`).join('')
            || '<div class="sm-p-sec"><p class="sm-empty">Nothing recorded for this element.</p></div>'}
          ${this.opts.canEdit ? '<div class="sm-p-sec"><p class="sm-hint">Use <b>Edit layout</b> to rename, recolour or rearrange its sections.</p></div>' : ''}`;
        P.querySelector('[data-p="close"]').onclick = () => { this.sel = null; this.renderSvg(); this.renderPanel(); };
        return;
      }
      const status = this.statusOf(o), active = this.activeContract(o.id), list = this.contractsFor(o.id);
      const upcoming = list.filter(c => c.start > this.today());
      const can = this.opts.canManageRentals;
      const badge = `<span class="sm-badge" style="background:var(--st-${status});border-color:var(--st-${status}-s);color:var(--st-${status}-t)">${esc(STATUS[status].label)}</span>`;
      let body = '';
      if (this.contractForm) body = this.contractFormHtml();
      else {
        const shown = active || upcoming[upcoming.length - 1] || null;
        if (shown) {
          const left = daysBetween(this.today(), shown.end);
          if (active) body += `<div class="sm-left ${left <= 30 ? 'soon' : ''}"><b>${left}</b> day${left === 1 ? '' : 's'} left<span>ends ${fmtD(shown.end)}</span></div>`;
          body += `<div class="sm-p-sec"><h4>${active ? 'Current contract' : 'Next contract'}</h4>
            <dl class="sm-kv">
              <dt>Supplier</dt><dd>${esc(shown.supplier)}</dd>
              <dt>Period</dt><dd>${fmtD(shown.start)} → ${fmtD(shown.end)}</dd>
              <dt>${shown.term === 'contract' ? 'Contract amount' : shown.term === 'yearly' ? 'Yearly amount' : 'Monthly amount'}</dt><dd>${this.money(shown.amount)}${shown.term === 'contract' ? ' <span class="sm-hint">for the whole period</span>' : ''}</dd>
              ${active ? `<dt>Time left</dt><dd>${left} day${left === 1 ? '' : 's'}</dd>` : ''}
              <dt>Billed</dt><dd>${shown.billed ? `Yes${shown.billedAt ? ' · ' + fmtD(shown.billedAt) : ''}` : '<span style="color:var(--st-unbilled-s)">Not yet</span>'}</dd>
              <dt>Paid</dt><dd>${shown.paid ? `Yes${shown.paidAt ? ' · ' + fmtD(shown.paidAt) : ''}` : 'Not yet'}</dd>
              ${shown.note ? `<dt>Note</dt><dd style="font-weight:400">${esc(shown.note)}</dd>` : ''}
            </dl>
            ${can ? `<div class="sm-actions">
              <button class="sm-btn" data-c="edit" data-id="${shown.id}">${ic('edit')} Edit</button>
              ${!shown.billed ? `<button class="sm-btn" data-c="billed" data-id="${shown.id}">Mark billed</button>` : ''}
              ${!shown.paid ? `<button class="sm-btn" data-c="paid" data-id="${shown.id}">Mark paid</button>` : ''}
              ${active && !upcoming.length ? `<button class="sm-btn primary" data-c="renew" data-id="${shown.id}">Renew</button>` : ''}
              ${active ? `<button class="sm-btn" data-c="endnow" data-id="${shown.id}">End today</button>` : ''}
            </div>` : ''}</div>`;
        } else {
          const last = list[0];
          body += `<div class="sm-p-sec"><h4>Contract</h4>
            <p class="sm-hint" style="margin:0 0 8px">${status === 'expired' ? `The last contract (${esc(last.supplier)}) ended on ${fmtD(last.end)} and was not renewed.`
              : status === 'nocontract' ? `The map shows <b>${esc(o.occupant)}</b> here, but there is no contract on file.` : 'This spot is free.'}</p>
            ${can ? `<div class="sm-actions">
              ${status === 'expired' ? `<button class="sm-btn primary" data-c="renew" data-id="${last.id}">Renew for ${esc(last.supplier)}</button>` : ''}
              <button class="sm-btn ${status === 'expired' ? '' : 'primary'}" data-c="new">${status === 'nocontract' ? `Add contract for ${esc(o.occupant)}` : 'Rent this spot'}</button>
            </div>` : ''}</div>`;
        }
        body += `<div class="sm-p-sec"><h4>History</h4>${list.length ? `<ul class="sm-list sm-hist">${list.map(c => `
          <li><span class="sm-dot" style="background:var(--st-${c.end < this.today() ? 'expired' : c.start > this.today() ? 'upcoming' : 'rented'});border-color:var(--st-${c.end < this.today() ? 'expired' : c.start > this.today() ? 'upcoming' : 'rented'}-s)"></span>
            <div class="sm-li-main"><div>${esc(c.supplier)} · ${this.money(c.amount)}${c.term === 'monthly' ? '/mo' : c.term === 'contract' ? ' contract' : '/yr'}</div><div class="sm-li-sub">${fmtD(c.start)} → ${fmtD(c.end)}${c.billed ? ' · billed' : ''}${c.paid ? ' · paid' : ''}</div></div>
            ${can ? `<button class="sm-mini" data-c="edit" data-id="${c.id}" title="Edit" aria-label="Edit contract">${ic('edit')}</button><button class="sm-mini" data-c="del" data-id="${c.id}" title="Delete" aria-label="Delete contract">${ic('trash')}</button>` : ''}
          </li>`).join('')}</ul>` : '<p class="sm-empty">No contracts yet.</p>'}</div>`;
      }
      P.innerHTML = `
        <div class="sm-p-head"><h3>${esc(this.displayName(o) || 'Free spot')}<button class="sm-close" data-p="close" aria-label="Close">${ic('close')}</button></h3>
          <div class="sm-sub">${esc(t.name)}${o.label && o.label !== this.displayName(o) ? ' · ' + esc(o.label) : ''} · ${esc(this.floor.name)}</div>
          <div style="margin-top:8px">${badge}</div></div>${body}${t.kind === 'fixture' ? this.sectionsHtml(o) : ''}`;
      P.querySelector('[data-p="close"]').onclick = () => { this.sel = null; this.contractForm = null; this.renderSvg(); this.renderPanel(); };
      P.onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) this.contractAction(b.dataset.c, b.dataset.id, o); };
      if (this.contractForm) this.bindContractForm(o);
    }

    sectionsHtml(o) {
      const lanes = [['Side A', o.sectionsA || []], ['Side B', o.sectionsB || []]].filter(([, s]) => s.length);
      return lanes.map(([name, secs]) => `<div class="sm-p-sec"><h4>${lanes.length > 1 ? name : 'Sections'}</h4><div class="sm-sec-list">
        ${secs.map(s => `<div>${iconHtml(this.cats[s.cat]?.icon || (ICONS[s.cat] ? s.cat : 'other'), `var(--catx-${esc(s.cat || 'other')})`)}${esc(s.label)} <span class="sm-hint">· ${esc(this.cats[s.cat]?.name || 'Other')}</span></div>`).join('')}</div></div>`).join('');
    }

    renderOverview() {
      const P = this.panel, t = this.today(), year = Number(t.slice(0, 4));
      const all = this.allObjects().filter(o => this.isRentable(o));
      const here = all.filter(o => o._floor === this.floorId);
      const st = (o) => this.statusOf(o);
      const occupied = here.filter(o => st(o) !== 'free').length;
      const revenue = this.contracts.reduce((s, c) => s + this.revenueInYear(c, year), 0);
      const lastRevenue = this.contracts.reduce((s, c) => s + this.revenueInYear(c, year - 1), 0);
      const floorName = (id) => this.floors.find(f => f.id === id)?.name || '';
      const item = (o, sub) => `<li data-go="${esc(o.id)}"><span class="sm-dot" style="background:var(--st-${st(o)});border-color:var(--st-${st(o)}-s)"></span>
        <div class="sm-li-main"><div>${esc(this.displayName(o) || this.typeOf(o).name)}</div><div class="sm-li-sub">${esc(sub)}</div></div></li>`;
      this.expanded = this.expanded || new Set();
      const group = (key, title, list, subFn, emptyText) => {
        const open = this.expanded.has(key), shown = open ? list : list.slice(0, 6);
        return `<div class="sm-p-sec"><h4>${title} <span>${list.length}</span></h4>${list.length
          ? `<ul class="sm-list">${shown.map(o => item(o, subFn(o))).join('')}</ul>${list.length > 6 ? `<button class="sm-btn" data-more="${key}" style="margin-top:4px">${open ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`
          : `<p class="sm-empty">${emptyText}</p>`}</div>`;
      };
      const where = (o) => `${this.typeOf(o).name}${this.nearLabel(o) ? ' by ' + this.nearLabel(o) : ''} · ${floorName(o._floor)}`;

      let searchBlock = '';
      if (this.q) {
        const hits = this.allObjects().filter(o => this.matches(o, this.q));
        searchBlock = `<div class="sm-p-sec"><h4>Search results <span>${hits.length}</span></h4>${hits.length ? `<ul class="sm-list">${hits.slice(0, 60).map(o => item(o, where(o))).join('')}</ul>` : '<p class="sm-empty">Nothing matches on any floor.</p>'}</div>`;
      }
      const unplaced = this.contracts.filter(c => !this.findObject(c.spotId) && c.end >= t);
      P.innerHTML = `
        <div class="sm-p-head"><h3>${esc(this.floor ? this.floor.name : 'Store map')}</h3><div class="sm-sub">Click any spot on the map to see or add its contract.</div></div>
        ${searchBlock}
        <div class="sm-p-sec"><div class="sm-stats">
          <div class="sm-stat"><span>Rentable spots</span><b>${here.length}</b></div>
          <div class="sm-stat"><span>Occupancy</span><b>${here.length ? Math.round(occupied / here.length * 100) : 0}%</b></div>
          <div class="sm-stat"><span>Rental income ${year}</span><b>${this.money(revenue)}</b></div>
          <div class="sm-stat"><span>${year - 1}</span><b>${this.money(lastRevenue)}</b></div>
        </div><p class="sm-hint" style="margin:8px 0 0">Income covers all floors: yearly contracts count in the year they start, monthly ones for each month in the year.</p></div>
        ${unplaced.length ? `<div class="sm-p-sec"><h4>Contracts not placed on the map <span>${unplaced.length}</span></h4><ul class="sm-list">${unplaced.map(c => `
          <li><div class="sm-li-main"><div>${esc(c.supplier)}</div><div class="sm-li-sub">${fmtD(c.start)} → ${fmtD(c.end)}${c.legacyLabel ? ' · ' + esc(c.legacyLabel) : ''}</div></div>
          ${this.opts.canManageRentals ? `<button class="sm-btn" data-assign="${esc(c.id)}">Place</button>` : ''}</li>`).join('')}</ul></div>` : ''}
        ${group('ending', 'Ending in 30 days', all.filter(o => st(o) === 'ending'), o => `Ends ${fmtD(this.activeContract(o.id)?.end)} · ${where(o)}`, 'No contracts ending soon.')}
        ${group('expired', 'Expired, not renewed', all.filter(o => st(o) === 'expired'), o => `Ended ${fmtD(this.contractsFor(o.id)[0]?.end)} · ${where(o)}`, 'Nothing expired.')}
        ${group('unbilled', 'Not billed yet', all.filter(o => st(o) === 'unbilled'), where, 'Everything active is billed.')}
        ${group('nocontract', 'Occupied, no contract', all.filter(o => st(o) === 'nocontract'), where, 'Every occupied spot has a contract.')}
        ${group('free', 'Free spots', all.filter(o => st(o) === 'free'), where, 'No free spots.')}`;
      P.onclick = (e) => {
        const a = e.target.closest('[data-assign]'); if (a) { e.stopPropagation(); return this.startAssign(a.dataset.assign); }
        const m = e.target.closest('[data-more]'); if (m) { const k = m.dataset.more; this.expanded.has(k) ? this.expanded.delete(k) : this.expanded.add(k); return this.renderOverview(); }
        const li = e.target.closest('[data-go]'); if (li) this.focusSpot(li.dataset.go);
      };
    }

    /* ---------------- contracts ---------------- */
    contractFormHtml() {
      const c = this.contractForm;
      // opts.suppliers (e.g. the app's Vendors list) wins; otherwise the names already on the map.
      const fromOpts = this.supplierList();
      const suppliers = fromOpts || [...new Set([...this.contracts.map(x => x.supplier), ...this.allObjects().map(o => o.occupant)].filter(Boolean))].sort();
      return `<div class="sm-p-sec"><h4>${c.id ? 'Edit contract' : 'New contract'}</h4>
        <form class="sm-form" data-role="cform">
          <label class="full">Supplier${fromOpts ? ' <span class="sm-hint">(from Vendors — type to search)</span>' : ''}<input class="sm-input" name="supplier" list="sm-suppliers" required autocomplete="off" value="${esc(c.supplier || '')}" placeholder="${fromOpts ? 'Choose a vendor…' : ''}"></label>
          <datalist id="sm-suppliers">${suppliers.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
          <p class="sm-hint full" data-role="supwarn" hidden style="margin:-4px 0 0;color:var(--st-ending-s)">Not in the Vendors list. Pick a vendor, or keep this name if it is right.</p>
          <label class="full">Billing
            <select class="sm-select" name="term"><option value="yearly" ${c.term === 'yearly' ? 'selected' : ''}>Yearly — one amount, billed once</option><option value="monthly" ${c.term === 'monthly' ? 'selected' : ''}>Monthly — amount each month</option><option value="contract" ${c.term === 'contract' ? 'selected' : ''}>Contractual — one amount for the whole contract</option></select></label>
          <label>Start<input class="sm-input" type="date" name="start" required value="${esc(c.start || '')}"></label>
          <label>End<input class="sm-input" type="date" name="end" required value="${esc(c.end || '')}"></label>
          <label class="full" data-role="amountlbl">${c.term === 'monthly' ? 'Amount per month' : c.term === 'contract' ? 'Amount for the whole contract' : 'Amount for the year'}<input class="sm-input" name="amount" inputmode="decimal" required value="${c.amount ?? ''}"></label>
          <label class="chk"><input type="checkbox" name="billed" ${c.billed ? 'checked' : ''}> Billed</label>
          <label class="chk"><input type="checkbox" name="paid" ${c.paid ? 'checked' : ''}> Paid</label>
          <label class="full">Note<input class="sm-input" name="note" value="${esc(c.note || '')}"></label>
          <div class="full sm-actions" style="justify-content:flex-end;margin-top:0">
            <button type="button" class="sm-btn" data-role="cancelc">Cancel</button>
            <button class="sm-btn primary">Save contract</button></div>
        </form></div>`;
    }
    supplierList() {
      try { const l = this.opts.suppliers && this.opts.suppliers(); return Array.isArray(l) && l.length ? l : null; }
      catch (e) { return null; }
    }
    bindContractForm(o) {
      const f = this.panel.querySelector('[data-role="cform"]');
      const list = this.supplierList();
      if (list) {
        const known = new Set(list.map(s => s.trim().toLowerCase()));
        const warn = f.querySelector('[data-role="supwarn"]');
        const check = () => { const v = f.supplier.value.trim(); warn.hidden = !v || known.has(v.toLowerCase()); };
        f.supplier.addEventListener('input', check); f.supplier.addEventListener('change', check); check();
      }
      f.term.onchange = () => { f.querySelector('[data-role="amountlbl"]').firstChild.textContent = f.term.value === 'monthly' ? 'Amount per month' : f.term.value === 'contract' ? 'Amount for the whole contract' : 'Amount for the year'; };
      f.start.onchange = () => { if (f.start.value && (!f.end.value || f.end.value < f.start.value)) f.end.value = addDays(addYears(f.start.value, 1), -1); };
      f.querySelector('[data-role="cancelc"]').onclick = () => { this.contractForm = null; this.renderPanel(); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const amount = Number(String(f.amount.value).replace(/[^0-9.\-]/g, ''));
        if (!f.supplier.value.trim()) return this.toast('Enter the supplier.', true);
        if (!f.start.value || !f.end.value || f.end.value < f.start.value) return this.toast('Check the dates — the end must be after the start.', true);
        if (isNaN(amount)) return this.toast('Enter a valid amount.', true);
        const prev = this.contractForm;
        const c = Object.assign({}, prev, {
          id: prev.id || uid('rc'), spotId: prev.spotId || o.id, supplier: f.supplier.value.trim(), term: f.term.value,
          start: f.start.value, end: f.end.value, amount, note: f.note.value.trim(),
          billed: f.billed.checked, billedAt: f.billed.checked ? (prev.billedAt || this.today()) : null,
          paid: f.paid.checked, paidAt: f.paid.checked ? (prev.paidAt || this.today()) : null
        });
        const overlap = this.contractsFor(c.spotId).find(x => x.id !== c.id && x.start <= c.end && x.end >= c.start);
        if (overlap && !(await this.confirm(`This overlaps ${overlap.supplier}'s contract (${fmtD(overlap.start)} → ${fmtD(overlap.end)}) on the same spot. Save anyway?`, 'Save anyway'))) return;
        const saved = await this.call(() => this.adapter.saveContract(c), 'Could not save the contract');
        const i = this.contracts.findIndex(x => x.id === c.id);
        if (i > -1) this.contracts[i] = saved || c; else this.contracts.push(saved || c);
        this.activity(prev.id ? 'contract_update' : 'contract_create', `${c.supplier} · ${this.displayName(o) || this.typeOf(o).name}`, c);
        this.contractForm = null; this.toast('Contract saved.');
        this.renderBar(); this.renderSvg(); this.renderPanel();
      };
      f.supplier.focus();
    }
    async contractAction(act, id, o) {
      const c = this.contracts.find(x => x.id === id);
      const t = this.today();
      if (act === 'new') {
        this.contractForm = { spotId: o.id, supplier: o.occupant || '', term: 'yearly', start: t, end: addDays(addYears(t, 1), -1), amount: '', billed: false, paid: false };
        return this.renderPanel();
      }
      if (!c) return;
      if (act === 'edit') { this.contractForm = clone(c); return this.renderPanel(); }
      if (act === 'renew') {
        const len = daysBetween(c.start, c.end);
        const start = c.end < t ? t : addDays(c.end, 1);
        this.contractForm = { spotId: c.spotId, supplier: c.supplier, term: c.term, start, end: addDays(start, len), amount: c.amount, billed: false, paid: false, note: '' };
        return this.renderPanel();
      }
      const save = async (patch, msg, action) => {
        const n = Object.assign({}, c, patch);
        const saved = await this.call(() => this.adapter.saveContract(n), 'Could not update the contract');
        Object.assign(c, saved || n);
        this.activity(action, `${c.supplier} · ${msg}`, c); this.toast(msg);
        this.renderBar(); this.renderSvg(); this.renderPanel();
      };
      if (act === 'billed') return save({ billed: true, billedAt: t }, 'Marked as billed.', 'contract_billed');
      if (act === 'paid') return save({ paid: true, paidAt: t }, 'Marked as paid.', 'contract_paid');
      if (act === 'endnow') {
        if (!(await this.confirm(`End ${c.supplier}'s contract today (${fmtD(t)})? The spot becomes free tomorrow.`, 'End today'))) return;
        return save({ end: t }, 'Contract ended.', 'contract_end');
      }
      if (act === 'del') {
        if (!(await this.confirm(`Delete ${c.supplier}'s contract (${fmtD(c.start)} → ${fmtD(c.end)})? This can't be undone.`, 'Delete'))) return;
        await this.call(() => this.adapter.deleteContract(c.id), 'Could not delete the contract');
        this.contracts = this.contracts.filter(x => x.id !== c.id);
        this.activity('contract_delete', `${c.supplier}`, c); this.toast('Contract deleted.');
        this.renderBar(); this.renderSvg(); this.renderPanel();
      }
    }
    startAssign(contractId) {
      this.assignFor = contractId;
      const c = this.contracts.find(x => x.id === contractId);
      const b = this.root.querySelector('.sm-banner');
      b.innerHTML = `Click the spot where <b>&nbsp;${esc(c?.supplier || '')}&nbsp;</b> belongs <button data-x>Cancel</button>`;
      b.classList.add('show'); this.canvasEl.classList.add('assigning');
      b.querySelector('[data-x]').onclick = () => this.cancelAssign();
    }
    cancelAssign() { this.assignFor = null; this.root.querySelector('.sm-banner').classList.remove('show'); this.canvasEl.classList.remove('assigning'); }
    async finishAssign(spotId) {
      const found = this.findObject(spotId), c = this.contracts.find(x => x.id === this.assignFor);
      if (!found || !c) return this.cancelAssign();
      if (!this.isRentable(found.o)) return this.toast('Pick a rentable spot (gondola, end cap, display, screen…).', true);
      const n = Object.assign({}, c, { spotId });
      const saved = await this.call(() => this.adapter.saveContract(n), 'Could not place the contract');
      Object.assign(c, saved || n);
      this.activity('contract_place', `${c.supplier} placed on ${this.typeOf(found.o).name}`, c);
      this.cancelAssign(); this.toast(`${c.supplier} placed on the map.`); this.select(spotId); this.renderBar();
    }

    /* ---------------- edit mode ---------------- */
    startEdit() {
      if (!this.floor) return this.toast('Add a floor first.', true);
      this.editing = true; this.draft = clone(this.layouts[this.floorId] || []);
      this.undoStack = []; this.redoStack = []; this.dirty = false; this.sel = null; this.contractForm = null; this.cancelAssign();
      this.root.querySelector('[data-role="edit"]').hidden = true;
      this.renderAll();
    }
    async stopEdit(save) {
      if (save) {
        const bad = this.draft.find(o => !this.types[o.type]);
        if (bad) return this.toast(`"${bad.label || bad.id}" has an unknown type.`, true);
        const note = await this.modal({ title: 'Save layout', html: '<form class="sm-form"><label class="full">What changed? (optional)<input class="sm-input" name="note" placeholder="e.g. moved Kazzi display near the entrance"></label></form>', ok: 'Save', collect: w => w.querySelector('[name=note]').value.trim() });
        if (note === null) return;
        await this.call(() => this.adapter.saveLayout(this.floorId, this.draft, { note }), 'Could not save the layout');
        this.layouts[this.floorId] = clone(this.draft);
        this.activity('layout_save', `${this.floor.name}: layout saved${note ? ' — ' + note : ''}`, { floorId: this.floorId, count: this.draft.length });
        this.toast('Layout saved.');
        // spots that were deleted but still hold contracts show up as "not placed on the map"
      } else if (this.dirty && !(await this.confirm('Discard your unsaved layout changes?', 'Discard'))) return;
      this.editing = false; this.draft = null; this.sel = null; this.dirty = false;
      this.root.querySelector('[data-role="edit"]').hidden = false;
      this.renderAll();
    }
    pushUndo(snap) { this.undoStack.push(snap || JSON.stringify(this.draft)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    async editAction(a) {
      const o = this.sel ? this.draft.find(x => x.id === this.sel) : null;
      const many = this.selectedObjs();
      const rerender = () => { this.dirty = true; this.renderBar(); this.renderSvg(); this.renderPanel(); };
      if (many.length > 1 && /^(dup|rot|del|std)$/.test(a)) return this.groupAction(a, many, rerender);
      if (/^(al-|dist-|same-)/.test(a)) return this.alignAction(a, many, rerender);
      switch (a) {
        case 'add': {
          const type = this.bar.querySelector('[data-e="type"]').value, t = this.types[type];
          const r = this.svg.getBoundingClientRect(), c = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
          const w = t.w || 120, h = t.h || 60;
          const n = { id: uid('obj'), type, x: this.snapV(c.x - w / 2), y: this.snapV(c.y - h / 2), w, h, rot: 0, label: t.kind === 'fixture' || t.kind === 'spot' ? '' : t.name, occupant: '' };
          if (t.kind === 'fixture') { n.sectionsA = [{ label: 'Section', size: 1, cat: 'other' }]; if ((t.lanes || 1) > 1) n.sectionsB = [{ label: 'Section', size: 1, cat: 'other' }]; }
          this.pushUndo(); this.draft.push(n); this.sel = n.id; return rerender();
        }
        case 'dup': if (!o) return; { this.pushUndo(); const n = clone(o); n.id = uid('obj'); n.x += 20; n.y += 20; this.draft.push(n); this.sel = n.id; return rerender(); }
        case 'rot': if (!o) return; this.pushUndo(); o.rot = (normRot(o.rot) + 90) % 360; return rerender();
        case 'std': {
          const std = (x) => { const t = this.types[x.type]; return t && t.std && t.w && t.h; };
          const fix = (x) => { const t = this.types[x.type], cx = x.x + x.w / 2, cy = x.y + x.h / 2; x.w = t.w; x.h = t.h; x.x = Math.round(cx - t.w / 2); x.y = Math.round(cy - t.h / 2); };
          if (o) {
            if (!std(o)) return this.toast(`${this.typeOf(o).name} has no standard size.`, true);
            this.pushUndo(); fix(o); return rerender();
          }
          const list = this.draft.filter(x => std(x) && (x.w !== this.types[x.type].w || x.h !== this.types[x.type].h));
          if (!list.length) return this.toast('Everything on this floor already has its standard size.');
          if (!(await this.confirm(`Resize ${list.length} element${list.length > 1 ? 's' : ''} on this floor to their standard size? Each one stays centred where it is. You can undo this.`, 'Resize'))) return;
          this.pushUndo(); list.forEach(fix); return rerender();
        }
        case 'del': if (!o) return; {
          const held = this.contracts.filter(c => c.spotId === o.id && c.end >= this.today());
          if (held.length && !(await this.confirm(`This spot has ${held.length} current or future contract${held.length > 1 ? 's' : ''} (${held.map(c => c.supplier).join(', ')}). Delete the spot anyway? The contracts stay and appear under "not placed on the map".`, 'Delete spot'))) return;
          this.pushUndo(); this.draft = this.draft.filter(x => x !== o); this.sel = null; return rerender();
        }
        case 'undo': if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.draft)); this.draft = JSON.parse(this.undoStack.pop()); this.pruneSel(); return rerender();
        case 'redo': if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.draft)); this.draft = JSON.parse(this.redoStack.pop()); this.pruneSel(); return rerender();
        case 'save': return this.stopEdit(true);
        case 'cancel': return this.stopEdit(false);
        case 'types': return this.editTypes();
        case 'versions': return this.showVersions();
      }
    }

    pruneSel() {
      const ids = new Set(this.draft.map(o => o.id));
      this.selSet = new Set([...this.selSet].filter(id => ids.has(id)));
      if (this._sel && !ids.has(this._sel)) this._sel = [...this.selSet].pop() || null;
    }
    async groupAction(a, many, rerender) {
      if (a === 'dup') {
        this.pushUndo();
        const copies = many.map(o => { const n = clone(o); n.id = uid('obj'); n.x += 20; n.y += 20; return n; });
        this.draft.push(...copies);
        this.selSet = new Set(copies.map(n => n.id)); this._sel = copies[copies.length - 1].id;
        return rerender();
      }
      if (a === 'rot') { this.pushUndo(); many.forEach(o => { o.rot = (normRot(o.rot) + 90) % 360; }); return rerender(); }
      if (a === 'std') {
        const list = many.filter(x => { const t = this.types[x.type]; return t && t.std && t.w && t.h; });
        if (!list.length) return this.toast('None of the selected elements has a standard size.', true);
        this.pushUndo();
        list.forEach(x => { const t = this.types[x.type], cx = x.x + x.w / 2, cy = x.y + x.h / 2; x.w = t.w; x.h = t.h; x.x = Math.round(cx - t.w / 2); x.y = Math.round(cy - t.h / 2); });
        return rerender();
      }
      if (a === 'del') {
        const ids = new Set(many.map(o => o.id));
        const held = this.contracts.filter(c => ids.has(c.spotId) && c.end >= this.today());
        const msg = `Delete ${many.length} elements?${held.length ? ` ${held.length} current or future contract${held.length > 1 ? 's' : ''} (${[...new Set(held.map(c => c.supplier))].join(', ')}) stay and appear under "not placed on the map".` : ''}`;
        if (!(await this.confirm(msg, 'Delete'))) return;
        this.pushUndo(); this.draft = this.draft.filter(x => !ids.has(x.id)); this.sel = null;
        return rerender();
      }
    }
    // Align the selection to its own edges / centre lines, spread it evenly, or give it the main element's size.
    alignAction(a, many, rerender) {
      if (many.length < 2) return this.toast('Select two or more elements first (Ctrl + click).', true);
      if (a.startsWith('dist-') && many.length < 3) return this.toast('Select three or more elements to spread them evenly.', true);
      this.pushUndo();
      const B = this.bounds(many), mid = { x: (B.x0 + B.x1) / 2, y: (B.y0 + B.y1) / 2 };
      const shift = (o, dx, dy) => { o.x = Math.round((o.x + dx) * 10) / 10; o.y = Math.round((o.y + dy) * 10) / 10; };
      const boxes = new Map(many.map(o => [o.id, this.abox(o)]));
      const bx = o => boxes.get(o.id);
      switch (a) {
        case 'al-left':   many.forEach(o => shift(o, B.x0 - bx(o).x0, 0)); break;
        case 'al-hc':     many.forEach(o => shift(o, mid.x - (bx(o).x0 + bx(o).x1) / 2, 0)); break;
        case 'al-right':  many.forEach(o => shift(o, B.x1 - bx(o).x1, 0)); break;
        case 'al-top':    many.forEach(o => shift(o, 0, B.y0 - bx(o).y0)); break;
        case 'al-vc':     many.forEach(o => shift(o, 0, mid.y - (bx(o).y0 + bx(o).y1) / 2)); break;
        case 'al-bottom': many.forEach(o => shift(o, 0, B.y1 - bx(o).y1)); break;
        case 'dist-h': case 'dist-v': {
          const H = a === 'dist-h', lo = H ? 'x0' : 'y0', hi = H ? 'x1' : 'y1';
          const list = many.slice().sort((p, q) => (bx(p)[lo] + bx(p)[hi]) - (bx(q)[lo] + bx(q)[hi]));
          const total = list.reduce((t, o) => t + bx(o)[hi] - bx(o)[lo], 0);
          const gap = ((H ? B.x1 - B.x0 : B.y1 - B.y0) - total) / (list.length - 1);
          let at = H ? B.x0 : B.y0;
          list.forEach(o => { const b = bx(o), d = at - b[lo]; shift(o, H ? d : 0, H ? 0 : d); at += b[hi] - b[lo] + gap; });
          break;
        }
        case 'same-w': case 'same-h': {
          const ref = this.draft.find(x => x.id === this.sel) || many[many.length - 1];
          many.forEach(o => {
            if (o === ref) return;
            const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
            if (a === 'same-w') o.w = ref.w; else o.h = ref.h;
            o.x = Math.round(cx - o.w / 2); o.y = Math.round(cy - o.h / 2);
          });
          break;
        }
      }
      return rerender();
    }

    renderEditPanel() {
      const P = this.panel, o = this.sel ? this.draft.find(x => x.id === this.sel) : null;
      const many = this.selectedObjs();
      if (many.length > 1) {
        const AL = {"al-left":"M4 3v18M8 7h11v4H8zM8 14h6v4H8z","al-hc":"M12 3v18M5 7h14v4H5zM8 14h8v4H8z","al-right":"M20 3v18M5 7h11v4H5zM10 14h6v4h-6z","al-top":"M3 4h18M7 8v11h4V8zM14 8v6h4V8z","al-vc":"M3 12h18M7 5v14h4V5zM14 8v8h4V8z","al-bottom":"M3 20h18M7 5v11h4V5zM14 10v6h4v-6z","dist-h":"M4 3v18M20 3v18M9 8h6v8H9z","dist-v":"M3 4h18M3 20h18M8 9h8v6H8z","same-w":"M4 8v8M20 8v8M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3","same-h":"M8 4h8M8 20h8M12 4v16M9 8l3-4 3 4M9 16l3 4 3-4"};
        const btn = (k, label) => `<button class="sm-btn sm-al" data-al="${k}" title="${label}"><svg viewBox="0 0 24 24" class="sm-ic"><path d="${AL[k]}"/></svg><span>${label}</span></button>`;
        const main = this.draft.find(x => x.id === this.sel);
        P.innerHTML = `
          <div class="sm-p-head"><h3>${many.length} elements selected<button class="sm-close" data-p="close" aria-label="Clear the selection">${ic('close')}</button></h3>
            <div class="sm-sub">Drag any of them to move them together · arrows nudge them · Ctrl + click adds or removes one · Esc clears</div></div>
          <div class="sm-p-sec"><h4>Align</h4><div class="sm-al-grid">
            ${btn('al-left', 'Left')}${btn('al-hc', 'Centre')}${btn('al-right', 'Right')}
            ${btn('al-top', 'Top')}${btn('al-vc', 'Middle')}${btn('al-bottom', 'Bottom')}</div></div>
          <div class="sm-p-sec"><h4>Spread evenly</h4><div class="sm-al-grid">
            ${btn('dist-h', 'Across')}${btn('dist-v', 'Down')}</div>
            ${many.length < 3 ? '<p class="sm-hint" style="margin:6px 0 0">Needs three or more elements.</p>' : ''}</div>
          <div class="sm-p-sec"><h4>Same size as ${esc(main ? (main.label || this.typeOf(main).name) : 'the last one')}</h4><div class="sm-al-grid">
            ${btn('same-w', 'Width')}${btn('same-h', 'Height')}</div>
            <p class="sm-hint" style="margin:6px 0 0">The last element you clicked is the reference.</p></div>
          <div class="sm-p-sec"><h4>Selected</h4><ul class="sm-list">${many.map(x => `
            <li><div class="sm-li-main"><div>${esc(x.label || x.occupant || this.typeOf(x).name)}${x.id === this.sel ? ' <span class="sm-hint">· reference</span>' : ''}</div><div class="sm-li-sub">${esc(this.typeOf(x).name)}</div></div>
            <button class="sm-mini" data-unsel="${esc(x.id)}" title="Remove from the selection" aria-label="Remove from the selection">${ic('close')}</button></li>`).join('')}</ul></div>
          <div class="sm-p-sec"><div class="sm-actions">
            <button class="sm-btn" data-e2="dup">${ic('copy')} Duplicate</button>
            <button class="sm-btn" data-e2="rot">${ic('rotate')} Rotate 90°</button>
            <button class="sm-btn" data-e2="std">${ic('fit')} Standard size</button>
            <button class="sm-btn danger" data-e2="del">${ic('trash')} Delete</button></div></div>`;
        P.querySelector('[data-p="close"]').onclick = () => { this.sel = null; this.renderBar(); this.renderSvg(); this.renderPanel(); };
        P.onclick = (e) => {
          const al = e.target.closest('[data-al]'); if (al) return this.editAction(al.dataset.al);
          const ac = e.target.closest('[data-e2]'); if (ac) return this.editAction(ac.dataset.e2);
          const un = e.target.closest('[data-unsel]');
          if (un) { this.selSet.delete(un.dataset.unsel); if (this._sel === un.dataset.unsel) this._sel = [...this.selSet].pop() || null; this.renderBar(); this.renderSvg(); this.renderPanel(); }
        };
        return;
      }
      if (!o) {
        const f = this.floor, tr = f.trace || {};
        P.innerHTML = `
          <div class="sm-p-head"><h3>Layout editor</h3><div class="sm-sub">Nothing is saved until you press Save layout.</div></div>
          <div class="sm-p-sec"><h4>How to</h4><p class="sm-hint" style="margin:0">
            • Click an element to select it; drag to move; drag the square handles to resize.<br>
            • <b>Ctrl + click</b> (Cmd on a Mac) adds elements to the selection; <b>Ctrl + drag</b> on the floor selects everything in a box; Ctrl+A selects all. Then align, spread or move them together.<br>
            • While dragging, pink guide lines show when edges or centres line up with another element, and it snaps to them (hold <b>Alt</b> to move freely).<br>
            • Pick a type in the bar and press <b>Add</b> to place a new element in the middle of the view.<br>
            • Arrows nudge (Shift = bigger steps) · Del deletes · Ctrl+D duplicates · Ctrl+Z / Ctrl+Y undo / redo.<br>
            • Drag the empty floor to pan, scroll or pinch to zoom.</p></div>
          <div class="sm-p-sec"><h4>This floor</h4><form class="sm-form" data-role="floorform">
            <label class="full">Name<input class="sm-input" name="name" value="${esc(f.name)}"></label>
            <label>Width<input class="sm-input" name="width" inputmode="numeric" value="${f.width}"></label>
            <label>Height<input class="sm-input" name="height" inputmode="numeric" value="${f.height}"></label>
          </form></div>
          <div class="sm-p-sec"><h4>Tracing image</h4>
            <p class="sm-hint" style="margin:0 0 8px">Put a picture of the floor plan behind the map to trace over it (a screenshot or photo of the PDF works). It is only a guide, and you can hide it.</p>
            <div class="sm-actions" style="margin-top:0">
              <label class="sm-btn">${ic('image')} ${tr.src ? 'Replace image' : 'Upload image'}<input type="file" accept="image/*" data-role="traceimg" hidden></label>
              ${tr.src ? `<button class="sm-btn" data-role="tracetoggle">${tr.visible === false ? 'Show' : 'Hide'}</button><button class="sm-btn danger" data-role="traceremove">Remove</button>` : ''}
            </div>
            ${tr.src ? `<label class="sm-hint" style="display:block;margin-top:10px">Opacity <input type="range" min="0.05" max="1" step="0.05" value="${tr.opacity ?? 0.35}" data-role="traceop" style="width:100%"></label>` : ''}
          </div>
          <div class="sm-p-sec"><h4>Floors</h4><div class="sm-actions" style="margin-top:0"><button class="sm-btn" data-role="addfloor">${ic('plus')} Add a floor</button></div></div>`;
        const ff = P.querySelector('[data-role="floorform"]');
        ff.onchange = async () => {
          const el = ff.elements;
          const n = { name: el.name.value.trim() || f.name, width: Math.max(200, Number(el.width.value) || f.width), height: Math.max(200, Number(el.height.value) || f.height) };
          Object.assign(f, n); await this.call(() => this.adapter.saveFloor(f), 'Could not save the floor');
          this.renderFloors(); this.renderSvg(); this.renderBar();
        };
        P.querySelector('[data-role="traceimg"]').onchange = (e) => {
          const file = e.target.files[0]; if (!file) return;
          if (file.size > 6 * 1024 * 1024) return this.toast('That image is over 6 MB — please use a smaller one.', true);
          const rd = new FileReader();
          rd.onload = async () => {
            const img = new Image();
            img.onload = async () => {
              // fit the picture to the floor's width, keeping its proportions
              const w = f.width, h = Math.round(f.width * img.height / img.width);
              f.trace = { src: rd.result, x: 0, y: 0, w, h, opacity: 0.35, visible: true };
              if (h > f.height) f.height = h;
              await this.call(() => this.adapter.saveFloor(f), 'Could not save the tracing image');
              this.renderSvg(); this.renderPanel(); this.fit();
            };
            img.src = rd.result;
          };
          rd.readAsDataURL(file);
        };
        P.querySelector('[data-role="tracetoggle"]')?.addEventListener('click', async () => { f.trace.visible = f.trace.visible === false; await this.call(() => this.adapter.saveFloor(f), 'Could not save'); this.renderSvg(); this.renderPanel(); });
        P.querySelector('[data-role="traceremove"]')?.addEventListener('click', async () => { delete f.trace; await this.call(() => this.adapter.saveFloor(f), 'Could not save'); this.renderSvg(); this.renderPanel(); });
        const op = P.querySelector('[data-role="traceop"]');
        if (op) { op.oninput = () => { f.trace.opacity = Number(op.value); const im = this.vp.querySelector('.sm-trace'); if (im) im.setAttribute('opacity', op.value); }; op.onchange = () => this.call(() => this.adapter.saveFloor(f), 'Could not save'); }
        P.querySelector('[data-role="addfloor"]').onclick = () => this.addFloor();
        return;
      }
      const t = this.typeOf(o);
      const catOpts = (cur) => Object.entries(this.cats).map(([k, c]) => `<option value="${k}" ${k === (cur || 'other') ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      const secEditor = (key, title) => `<div class="sm-p-sec"><h4>${title}<button type="button" class="sm-mini" data-sec-add="${key}" title="Add a section" aria-label="Add a section">${ic('plus')}</button></h4>
        <div class="sm-sections">${(o[key] || []).map((s, i) => `<div class="sm-sec-row">
          <input class="sm-input" data-sec="${key}" data-i="${i}" data-f="label" value="${esc(s.label)}" aria-label="Section name">
          <input class="sm-input" data-sec="${key}" data-i="${i}" data-f="size" value="${s.size}" inputmode="decimal" title="Relative length" aria-label="Relative length">
          <select class="sm-select" data-sec="${key}" data-i="${i}" data-f="cat" aria-label="Department">${catOpts(s.cat)}</select>
          <span style="display:flex;gap:2px"><button type="button" class="sm-mini" data-sec-mv="${key}" data-i="${i}" data-d="-1" aria-label="Move up">${ic('up')}</button><button type="button" class="sm-mini" data-sec-mv="${key}" data-i="${i}" data-d="1" aria-label="Move down">${ic('down')}</button><button type="button" class="sm-mini" data-sec-del="${key}" data-i="${i}" aria-label="Remove section">${ic('close')}</button></span>
        </div>`).join('') || '<p class="sm-empty">No sections.</p>'}</div>
        <p class="sm-hint" style="margin:6px 0 0">Length is relative: 2 is twice as long as 1.</p></div>`;
      P.innerHTML = `
        <div class="sm-p-head"><h3>${esc(o.label || o.occupant || t.name)}<button class="sm-close" data-p="close" aria-label="Close">${ic('close')}</button></h3><div class="sm-sub">${esc(t.name)}</div></div>
        <div class="sm-p-sec"><form class="sm-form" data-role="props" onsubmit="return false">
          <label class="full">Type<select class="sm-select" name="type">${Object.entries(this.types).map(([k, x]) => `<option value="${k}" ${k === o.type ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          <label class="full">${t.kind === 'spot' ? 'Label (optional, e.g. category or number)' : 'Label'}<input class="sm-input" name="label" value="${esc(o.label || '')}"></label>
          ${t.kind === 'spot' ? `<label class="full">Occupant shown on the map<input class="sm-input" name="occupant" value="${esc(o.occupant || '')}" placeholder="Supplier physically there"></label>
            <p class="sm-hint full" style="margin:-4px 0 0">When a contract is active, its supplier is shown instead.</p>` : ''}
          <label>X<input class="sm-input" name="x" inputmode="numeric" value="${Math.round(o.x)}"></label>
          <label>Y<input class="sm-input" name="y" inputmode="numeric" value="${Math.round(o.y)}"></label>
          <label>Width<input class="sm-input" name="w" inputmode="numeric" value="${Math.round(o.w)}"></label>
          <label>Height<input class="sm-input" name="h" inputmode="numeric" value="${Math.round(o.h)}"></label>
          <label class="full">Rotation (degrees)<input class="sm-input" name="rot" inputmode="numeric" value="${normRot(o.rot)}"></label>
        </form></div>
        ${t.kind === 'fixture' ? secEditor('sectionsA', (t.lanes || 1) > 1 || (o.sectionsB || []).length ? 'Side A sections' : 'Sections') : ''}
        ${t.kind === 'fixture' && ((t.lanes || 1) > 1 || (o.sectionsB || []).length) ? secEditor('sectionsB', 'Side B sections') : ''}
        <div class="sm-p-sec"><div class="sm-actions" style="margin-top:0">
          <button class="sm-btn" data-p="dup">${ic('copy')} Duplicate</button><button class="sm-btn" data-p="rot">${ic('rotate')} Rotate</button>
          <button class="sm-btn danger" data-p="del">${ic('trash')} Delete</button></div></div>`;
      P.querySelector('[data-p="close"]').onclick = () => { this.sel = null; this.renderBar(); this.renderSvg(); this.renderPanel(); };
      ['dup', 'rot', 'del'].forEach(k => P.querySelector(`[data-p="${k}"]`).onclick = () => this.editAction(k));
      const pf = P.querySelector('[data-role="props"]');
      pf.onchange = (e) => {
        const n = e.target.name; if (!n) return;
        this.pushUndo();
        if (['x', 'y', 'w', 'h', 'rot'].includes(n)) { const v = Number(e.target.value); if (!isNaN(v)) o[n] = n === 'rot' ? normRot(v) : (n === 'w' || n === 'h' ? Math.max(4, v) : v); }
        else if (n === 'type') {
          o.type = e.target.value; const nt = this.types[o.type];
          if (nt.kind === 'fixture' && !(o.sectionsA || []).length) o.sectionsA = [{ label: o.label || 'Section', size: 1, cat: 'other' }];
        } else o[n] = e.target.value;
        this.dirty = true; this.renderSvg();
        if (n === 'type') this.renderPanel(); else P.querySelector('.sm-p-head h3').firstChild.textContent = o.label || o.occupant || this.typeOf(o).name;
      };
      P.querySelectorAll('[data-sec]').forEach(inp => inp.onchange = () => {
        const s = o[inp.dataset.sec][Number(inp.dataset.i)]; this.pushUndo();
        s[inp.dataset.f] = inp.dataset.f === 'size' ? Math.max(0.05, Number(inp.value) || 1) : inp.value;
        this.dirty = true; this.renderSvg();
      });
      P.querySelectorAll('[data-sec-add]').forEach(b => b.onclick = () => { const k = b.dataset.secAdd; this.pushUndo(); o[k] = o[k] || []; o[k].push({ label: 'Section', size: 1, cat: 'other' }); this.dirty = true; this.renderSvg(); this.renderPanel(); });
      P.querySelectorAll('[data-sec-del]').forEach(b => b.onclick = () => { const k = b.dataset.secDel; this.pushUndo(); o[k].splice(Number(b.dataset.i), 1); this.dirty = true; this.renderSvg(); this.renderPanel(); });
      P.querySelectorAll('[data-sec-mv]').forEach(b => b.onclick = () => {
        const k = b.dataset.secMv, i = Number(b.dataset.i), j = i + Number(b.dataset.d), arr = o[k];
        if (j < 0 || j >= arr.length) return; this.pushUndo(); [arr[i], arr[j]] = [arr[j], arr[i]]; this.dirty = true; this.renderSvg(); this.renderPanel();
      });
    }

    async addFloor() {
      const r = await this.modal({ title: 'Add a floor', html: `<form class="sm-form">
        <label class="full">Name<input class="sm-input" name="name" placeholder="e.g. Mezzanine"></label>
        <label>Width<input class="sm-input" name="width" value="${this.floor?.width || 3000}"></label>
        <label>Height<input class="sm-input" name="height" value="${this.floor?.height || 2000}"></label></form>
        <p class="sm-hint" style="margin-top:10px">Then upload a picture of its plan as a tracing image and draw over it.</p>`, ok: 'Add floor',
        collect: w => ({ name: w.querySelector('[name=name]').value.trim(), width: Number(w.querySelector('[name=width]').value) || 3000, height: Number(w.querySelector('[name=height]').value) || 2000 }) });
      if (!r || !r.name) return;
      if (this.dirty && !(await this.confirm('You have unsaved changes on this floor. Discard them and switch?', 'Discard & switch'))) return;
      const f = { id: uid('floor'), name: r.name, width: r.width, height: r.height, sort: this.floors.length + 1 };
      await this.call(() => this.adapter.saveFloor(f), 'Could not add the floor');
      this.floors.push(f); this.layouts[f.id] = [];
      this.floorId = f.id; this.draft = []; this.undoStack = []; this.redoStack = []; this.dirty = false; this.sel = null;
      this.activity('floor_create', `Floor added: ${f.name}`, f);
      this.renderAll(); this.fit();
    }

    async editTypes() {
      const rows = () => Object.entries(this.types).map(([k, t]) => `<tr><td><input class="sm-input" data-k="${k}" data-f="name" value="${esc(t.name)}"></td>
        <td>${esc({ fixture: 'Gondola / shelf', spot: 'Spot', fixed: 'Fixed', wall: 'Wall', text: 'Text' }[t.kind] || t.kind)}</td>
        <td style="text-align:center"><input type="checkbox" data-k="${k}" data-f="rentable" ${t.rentable ? 'checked' : ''} ${t.kind !== 'spot' && t.kind !== 'fixture' ? 'disabled' : ''}></td>
        <td>${t.std ? `<span style="display:flex;gap:4px;align-items:center"><input class="sm-input" style="width:62px" data-k="${k}" data-f="w" value="${t.w}" inputmode="numeric" aria-label="Standard width"> × <input class="sm-input" style="width:62px" data-k="${k}" data-f="h" value="${t.h}" inputmode="numeric" aria-label="Standard height"></span>` : '<span class="sm-hint">—</span>'}</td></tr>`).join('');
      const res = await this.modal({ title: 'Element types', wide: true, ok: 'Save types',
        html: `<p>Rename types, choose which ones can be rented, or add new ones (for example “Fridge door” or “Checkout screen”).</p>
          <table class="sm-table"><thead><tr><th>Name</th><th>Kind</th><th>Rentable</th><th>Standard size</th></tr></thead><tbody data-role="rows">${rows()}</tbody></table>
          <form class="sm-form" style="margin-top:12px" data-role="newtype">
            <label>New type name<input class="sm-input" name="name" placeholder="e.g. Fridge door"></label>
            <label>Kind<select class="sm-select" name="kind"><option value="spot">Rentable spot</option><option value="fixture">Gondola / shelf with sections</option><option value="fixed">Fixed element</option></select></label>
          </form>`,
        collect: (w) => {
          const types = clone(this.types);
          w.querySelectorAll('[data-k]').forEach(i => {
            const t = types[i.dataset.k], f = i.dataset.f;
            if (f === 'name') t.name = i.value.trim() || t.name;
            else if (f === 'w' || f === 'h') { const v = Math.round(Number(i.value)); if (v >= 8) t[f] = v; }
            else t.rentable = i.checked;
          });
          const nf = w.querySelector('[data-role="newtype"]').elements, nm = nf.name.value.trim();
          if (nm) {
            let key = nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'type'; while (types[key]) key += '_x';
            const kind = nf.kind.value;
            types[key] = { name: nm, kind, rentable: kind === 'spot', lanes: kind === 'fixture' ? 2 : undefined, w: kind === 'fixture' ? 600 : 80, h: kind === 'fixture' ? 110 : 60, std: true };
          }
          return types;
        } });
      if (!res) return;
      this.types = res;
      if (this.adapter.saveConfig) await this.call(() => this.adapter.saveConfig({ types: this.types, cats: this.cats }), 'Could not save the types');
      this.activity('types_save', 'Map element types updated', {});
      this.renderAll();
    }

    async showVersions() {
      if (!this.adapter.listLayoutVersions) return this.toast('Layout history is not available.', true);
      const list = await this.call(() => this.adapter.listLayoutVersions(this.floorId), 'Could not load the history');
      const pick = await this.modal({ title: `Layout history — ${this.floor.name}`, wide: true, ok: null, cancel: 'Close',
        html: list.length ? `<table class="sm-table"><thead><tr><th>Saved</th><th>By</th><th>Note</th><th></th></tr></thead><tbody>${list.map(v => `
          <tr><td>${esc(new Date(v.createdAt).toLocaleString())}</td><td>${esc(v.by || '—')}</td><td>${esc(v.note || '')}</td>
          <td><button class="sm-btn" data-v="${esc(v.id)}">Load</button></td></tr>`).join('')}</tbody></table>` : '<p>No saved versions yet.</p>',
        onOpen: (w, done) => w.querySelectorAll('[data-v]').forEach(b => b.onclick = () => done(b.dataset.v)) });
      if (!pick) return;
      const objs = await this.call(() => this.adapter.restoreLayoutVersion(pick), 'Could not load that version');
      this.pushUndo(); this.draft = clone(objs); this.sel = null; this.dirty = true;
      this.toast('Version loaded into the editor — press Save layout to keep it.');
      this.renderAll();
    }

    /* ---------------- export ---------------- */
    standaloneSvg() {
      const f = this.floor; if (!f) return '';
      const clone2 = this.svg.cloneNode(true);
      const vp = clone2.querySelector('.sm-vp'); vp.removeAttribute('transform');
      vp.querySelector('.sm-overlay')?.remove(); vp.querySelector('.sm-trace')?.remove();
      // inline computed colours so the file looks right outside the app
      const src = this.svg.querySelectorAll('.sm-vp *'), dst = vp.querySelectorAll('*');
      let di = 0;
      src.forEach(s => {
        if (s.closest('.sm-overlay') || s.classList.contains('sm-trace')) return;
        const d = dst[di++]; if (!d) return;
        const cs = getComputedStyle(s);
        ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-opacity', 'opacity', 'fill-opacity', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'stop-color', 'stop-opacity', 'color'].forEach(p => { const v = cs.getPropertyValue(p); if (v) d.style.setProperty(p, v); });
      });
      clone2.setAttribute('viewBox', `0 0 ${f.width} ${f.height}`); clone2.setAttribute('width', f.width); clone2.setAttribute('height', f.height);
      clone2.removeAttribute('class'); clone2.removeAttribute('style');
      return new XMLSerializer().serializeToString(clone2);
    }
    download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
    exportAs(kind) {
      const f = this.floor; if (!f && kind !== 'csv') return;
      const base = `${(f?.name || 'store').replace(/[^\w-]+/g, '-')}-${this.today()}`;
      if (kind === 'svg') return this.download(base + '.svg', new Blob([this.standaloneSvg()], { type: 'image/svg+xml' }));
      if (kind === 'png') {
        const img = new Image(), svg = this.standaloneSvg();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = f.width; c.height = f.height;
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
          c.toBlob(b => this.download(base + '.png', b), 'image/png');
        };
        img.onerror = () => this.toast('Could not create the image in this browser.', true);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        return;
      }
      if (kind === 'print') {
        let root = document.querySelector('.sm-print-root');
        if (!root) { root = document.createElement('div'); root.className = 'sm-print-root'; document.body.appendChild(root); }
        root.innerHTML = `<h2>${esc(f.name)} — ${this.mode === 'rentals' ? 'rentals' : 'departments'} · ${fmtD(this.today())}</h2>${this.standaloneSvg()}`;
        const s = root.querySelector('svg'); s.removeAttribute('width'); s.removeAttribute('height');
        document.body.classList.add('sm-printing');
        const after = () => { document.body.classList.remove('sm-printing'); window.removeEventListener('afterprint', after); };
        window.addEventListener('afterprint', after);
        window.print();
        return;
      }
      if (kind === 'csv') {
        const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [['Floor', 'Spot type', 'Spot', 'Supplier', 'Billing', 'Start', 'End', 'Amount', 'Billed', 'Paid', 'Note']];
        this.contracts.forEach(c => {
          const found = this.findObject(c.spotId);
          rows.push([found ? this.floors.find(x => x.id === found.floorId)?.name : 'Not placed', found ? this.typeOf(found.o).name : '', found ? (found.o.label || found.o.id) : '',
            c.supplier, c.term, c.start, c.end, c.amount, c.billed ? 'Yes' : 'No', c.paid ? 'Yes' : 'No', c.note || '']);
        });
        this.download(`rental-contracts-${this.today()}.csv`, new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv' }));
      }
    }
  }

  global.StoreMap = {
    mount: (root, opts) => new StoreMapApp(root, opts),
    DEFAULT_TYPES, DEFAULT_CATS, STATUS, ICONS,
    utils: { localDate, addDays, addYears, daysBetween }
  };
})(window);
