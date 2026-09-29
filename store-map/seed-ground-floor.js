/* ============================================================
   Ground floor seed — based on "ajaltoun Ground floor.pdf"
   ------------------------------------------------------------
   Same aisles, order, sections and suppliers as the PDF, redrawn
   on an even grid with ONE standard size per element:
     gondola        600 × 110   (double-sided, side A on top)
     end column      80 wide:   side gondola 25 · end cap 60 · side gondola 25
     basket side     50 × 80
     display        110 × 110   (+ display sides 110 × 25)
     fridge door     60 × 80
     promo table    160 × 40
   Aisles are 100 wide. Coordinates are map units (floor 3670 × 2500).
   Used ONCE to fill an empty database; after that, edit in the app.
   ============================================================ */
(function (global) {
  const S = { L: 600, D: 110, E: 80, SIDE: 25, CAP: 60, BW: 50, BH: 80, AISLE: 100, DISP: 110, DSIDE: 25 };
  const PITCH = S.D + S.AISLE;             // 210 between gondola rows
  const objects = [];
  const add = (o) => { objects.push(Object.assign({ rot: 0, label: '', occupant: '' }, o)); };
  const secs = (list) => list.map(([label, size, cat]) => ({ label, size, cat }));

  /* A standard gondola with its end columns.
     x = left edge of the LEFT end column (always reserved so rows line up).
     ends: undefined → no spot · '' → free spot · 'Name' → occupied by that supplier */
  function gondola(id, x, y, top, bottom, ends = {}, opts = {}) {
    const gx = x + S.E;
    add({ id, type: 'gondola', x: gx, y, w: S.L, h: S.D, sectionsA: secs(top), sectionsB: bottom && bottom.length ? secs(bottom) : undefined });
    const col = (cx, keys) => {
      const [kt, kc, kb] = keys;
      if (ends[kt] !== undefined) add({ id: `${id}-${kt}`, type: 'side_gondola', x: cx, y, w: S.E, h: S.SIDE, occupant: ends[kt] });
      if (ends[kc] !== undefined) add({ id: `${id}-${kc}`, type: 'endcap', x: cx, y: y + S.SIDE, w: S.E, h: S.CAP, occupant: ends[kc] });
      if (ends[kb] !== undefined) add({ id: `${id}-${kb}`, type: 'side_gondola', x: cx, y: y + S.SIDE + S.CAP, w: S.E, h: S.SIDE, occupant: ends[kb] });
    };
    col(x, ['tl', 'l', 'bl']);
    col(gx + S.L, ['tr', 'r', 'br']);
    if (opts.aisleAfter) add({ id: `aisle-${opts.aisleAfter}`, type: 'aisle', label: `Aisle ${opts.aisleAfter}`, x: gx + S.L / 2 - 75, y: y + S.D + S.AISLE / 2 - 18, w: 150, h: 36 });
  }
  // basket side standing in the aisle below a row, at the left or right end column
  const basket = (id, label, x, rowY, where = 'below') =>
    add({ id, type: 'basket_side', label, x, y: where === 'below' ? rowY + S.D + (S.AISLE - S.BH) / 2 : rowY - S.AISLE + (S.AISLE - S.BH) / 2, w: S.BW, h: S.BH });
  // a stand-alone display with optional rentable sides (top and right)
  function display(id, who, x, y, top, right) {
    add({ id, type: 'display', x, y, w: S.DISP, h: S.DISP, occupant: who });
    if (top !== undefined) add({ id: `${id}-top`, type: 'display_side', x, y: y - S.DSIDE - 3, w: S.DISP, h: S.DSIDE, occupant: top });
    // right side = a standard display side turned 90° (rotation is around its centre)
    if (right !== undefined) add({ id: `${id}-right`, type: 'display_side', rot: 90,
      x: x + S.DISP + 3 + S.DSIDE / 2 - S.DISP / 2, y: y + S.DISP / 2 - S.DSIDE / 2, w: S.DISP, h: S.DSIDE, occupant: right });
  }

  /* ================= Grocery block (left) ================= */
  const GX = 110, G = [440, 440 + PITCH, 440 + PITCH * 2, 440 + PITCH * 3, 440 + PITCH * 4];
  const GR = GX + S.E + S.L;                               // right end column x
  gondola('g1', GX, G[0],
    [['Frying oil', 402, 'oils'], ['Coconut oil + thyme + ghee', 134, 'oils'], ['Olive oil', 133, 'oils']],
    [['Grain and rice', 670, 'grocery']],
    { tl: '', l: 'Transmed', bl: '', tr: 'UD', r: 'Najjar', br: '' }, { aisleAfter: 1 });
  gondola('g2', GX, G[1],
    [['Blossom water + lupin + chips + mouloukhieh', 135, 'grocery'], ['Grain and rice', 535, 'grocery']],
    [['Zwan', 80, 'canned'], ['Tuna', 187, 'canned'], ['Vegetable cans', 400, 'canned']],
    { tl: '', l: 'Halwany', bl: '', tr: 'Halwany', r: 'Halwany', br: '' }, { aisleAfter: 2 });
  gondola('g3', GX, G[2],
    [['Canned meat', 80, 'canned'], ['Pickles and vinegar', 322, 'sauces'], ['Spices', 266, 'sauces']],
    [['Other sauces', 133, 'sauces'], ['Chilli sauce', 107, 'sauces'], ['Tomato paste', 241, 'sauces'], ['Mayo + ketchup', 186, 'sauces']],
    { tl: 'Meptico', l: 'Bellvie', bl: 'Ipk' }, { aisleAfter: 3 });
  add({ id: 'g3-ext', type: 'shelf', x: GR, y: G[2] + S.SIDE, w: S.E, h: S.CAP, sectionsA: secs([['Ketchup', 1, 'sauces']]) });
  gondola('g4', GX, G[3],
    [['Pasta sauce', 107, 'pasta'], ['Pasta', 561, 'pasta']],
    [['Pringles', 80, 'snacks'], ['Nachos', 295, 'snacks'], ['Salty crackers', 293, 'snacks']],
    { tl: '', l: 'Hanilor', bl: '', tr: 'Meptico', r: 'Nassif', br: 'PDN' }, { aisleAfter: 4 });
  gondola('g5', GX, G[4],
    [['Chips', 670, 'snacks']],
    [['Eggs', 270, 'fresh'], ['Chinese food', 265, 'ethnic'], ['Maggi', 133, 'ethnic']],
    { tl: '', l: 'EAM', bl: 'Moussallem', tr: '', r: 'Golden Food', br: '' }, { aisleAfter: 5 });

  const GRB = GR + S.E - S.BW;                              // basket x on the right end
  basket('b-oil', 'Oil & ghee', GRB, G[0], 'above');
  basket('b-grain', 'Grain & rice', GRB, G[0]);
  basket('b-can-l', 'Canned food & vinegar', GX, G[1]);
  basket('b-can-r', 'Canned food & vinegar', GRB, G[1]);
  basket('b-pasta-l', 'Pasta & condiments', GX, G[2]);
  basket('b-pasta-r', 'Pasta & condiments', GRB, G[2]);
  basket('b-salty-l', 'Salty snacks', GX, G[3]);
  basket('b-salty-r', 'Salty snacks', GRB, G[3]);
  basket('b-ethnic', 'Ethnic food & eggs', GRB, G[4]);

  /* ================= Middle block: breakfast, drinks, bakery, healthy ================= */
  const MX = 1000, M = [120, 120 + PITCH, 120 + PITCH * 2, 120 + PITCH * 3, 120 + PITCH * 4, 120 + PITCH * 5, 120 + PITCH * 6];
  const MR = MX + S.E + S.L;
  gondola('m1', MX, M[0],
    [['Beverage', 458, 'beverage'], ['Water', 146, 'beverage']],
    [['Tea', 496, 'hotdrinks'], ['Beverage', 108, 'beverage']],
    { tl: 'Maatouk', l: 'Hanilor', bl: 'Golden Food', r: 'Transmed' }, { aisleAfter: 6 });
  gondola('m2', MX, M[1],
    [['Capsules', 179, 'hotdrinks'], ['Coffee', 601, 'hotdrinks']],
    [['Cereal bars', 179, 'breakfast'], ['Corn flakes', 601, 'breakfast']],
    { tl: '', l: 'Obegi', bl: '', tr: 'Super Brasil', r: 'EAM', br: 'Ipk' }, { aisleAfter: 7 });
  gondola('m3', MX, M[2],
    [['Milk powder', 323, 'dairy'], ['Liquid milk', 146, 'dairy'], ['Hot chocolate', 141, 'hotdrinks'], ['Soya milk', 171, 'dairy']],
    [['Cake ready to mix', 323, 'baking'], ['Jello + custard', 287, 'baking'], ['Syrup', 171, 'baking']],
    { tl: 'Ipk', l: 'Meptico', bl: 'Abboud', tr: 'Transmed', r: 'Nestle' }, { aisleAfter: 8 });
  gondola('m4', MX, M[3],
    [['Spread cheese', 179, 'dairy'], ['Powder juice', 292, 'beverage']],
    [['Tahini', 179, 'spreads'], ['Halawa', 81, 'spreads'], ['Honey', 62, 'spreads'], ['Jams', 149, 'spreads'], ['Peanut butter + chocolate', 110, 'spreads']],
    { tl: '', l: 'Obegi', bl: 'Ipk' }, { aisleAfter: 9 });
  gondola('l1', MX, M[4],
    [['Croissant', 125, 'bakery'], ['Biscuit box', 82, 'confectionery']],
    [['English cake', 125, 'bakery']],
    { tl: 'Manyfood', l: 'U-food', bl: 'Bocti' }, { aisleAfter: 10 });
  gondola('l2', MX, M[5],
    [['Cake', 181, 'confectionery'], ['Jelly + candy bags', 342, 'confectionery']],
    [['Sugar-free biscuits', 523, 'healthy']],
    { tl: 'Ipk', l: 'Uflco', bl: 'Casapa', r: 'Obegi', br: 'EAM' }, { aisleAfter: 11 });
  gondola('l3', MX, M[6],
    [['Rice cakes', 181, 'healthy'], ['Nabat', 143, 'healthy'], ['Biomass + Naturalia', 120, 'healthy'], ['Protein bars', 79, 'healthy']],
    [['Gift boxes', 181, 'confectionery'], ['Chocolate', 342, 'confectionery']],
    { tl: '', l: 'Nestle', bl: 'Golden Food', r: 'Transmed' }, { aisleAfter: 12 });

  const MRB = MR + S.E - S.BW;
  add({ id: 'b-bev', type: 'basket_side', label: 'Beverage', x: MR - S.BW - 20, y: 20, w: S.BW, h: S.BH });
  basket('b-coffee', 'Coffee & Tea', MX, M[0]);
  basket('b-milk', 'Milk & Cereal', MX, M[1]);
  basket('b-baking', 'Baking mix & supplies', MX, M[2]);
  basket('b-conf-1', 'Confectionery', MX, M[4]);
  basket('b-healthy-l', 'Healthy food', MX, M[5]);
  basket('b-healthy-r', 'Healthy food', MRB, M[5]);
  basket('b-conf-2', 'Confectionery', MX, M[6]);

  add({ id: 'bread', type: 'shelf', x: MR + S.E + 40, y: M[1], w: 30, h: PITCH + S.D, sectionsA: secs([['Bread', 1, 'bakery']]) });
  display('d-kallassi', 'Kallassi', MR + S.E + 100, M[3], 'Dano', 'Dano');

  /* ================= Right block: sweets & biscuits ================= */
  const RX = 1860, RR = RX + S.E + S.L, RRB = RR + S.E - S.BW;
  gondola('r1', RX, M[5],
    [['Jelly + candy bags', 250, 'confectionery'], ['Gum', 131, 'confectionery']],
    [['Biscuits', 381, 'confectionery']],
    { tl: 'Castania', l: 'Vincenti', bl: 'Manyfood', tr: 'Transmed', r: 'Rifai', br: 'Ipk' }, { aisleAfter: 13 });
  gondola('r2', RX, M[6],
    [['Biscuits', 381, 'confectionery']],
    [['Chocolate', 381, 'confectionery']],
    { tl: '', l: 'Ipk', bl: 'Golden Food', tr: '', r: 'Najjar', br: 'Hakim Doueik' }, { aisleAfter: 14 });
  basket('b-conf-3', 'Confectionery', RRB, M[5], 'above');
  basket('b-conf-4', 'Confectionery', RX, M[5]);
  basket('b-conf-5', 'Confectionery', RRB, M[5]);
  basket('b-conf-6', 'Confectionery', RRB, M[6]);

  /* ================= Frozen & chilled ================= */
  add({ id: 'wall-top-left', type: 'fridge_wall', x: 28, y: 20, w: 262, h: 60, sectionsA: secs([['Beverage', 1, 'beverage']]) });
  add({ id: 'wall-top', type: 'fridge_wall', x: 318, y: 5, w: 580, h: 80,
    sectionsA: secs([['Beverage', 212, 'beverage'], ['Frozen poultry', 162, 'frozen'], ['Frozen appetizers', 212, 'frozen']]) });
  [['fd-dolsi', 'Dolsi + Bonjus'], ['fd-iceberg', 'Iceberg'], ['fd-ezzedine', 'Ezzedine'], ['fd-hakim', 'Hakim Doueik'], ['fd-transmed', 'Transmed']]
    .forEach(([id, who], i) => add({ id, type: 'fridge_door', x: 905 + i * 62, y: 5, w: 60, h: 80, occupant: who }));

  add({ id: 'wall-left-a', type: 'fridge_wall', x: 5, y: 95, w: 55, h: 950,
    sectionsA: secs([['White cheese', 195, 'dairy'], ['Block cheese', 110, 'dairy'], ['Yogurt', 130, 'dairy'], ['Butter', 105, 'dairy'], ['Crème fraîche', 55, 'dairy'], ['French cheese', 365, 'dairy']]) });
  add({ id: 'ws-puck', type: 'wall_spot', x: 5, y: 1050, w: 55, h: 55, occupant: 'Puck' });
  add({ id: 'ws-picon', type: 'wall_spot', x: 5, y: 1108, w: 55, h: 55, occupant: 'Picon' });
  add({ id: 'wall-left-b', type: 'fridge_wall', x: 5, y: 1168, w: 55, h: 470,
    sectionsA: secs([['Slices', 232, 'dairy'], ['Spreads', 235, 'dairy']]) });

  [['fz-nestle', 'Nestle'], ['fz-master', 'Master'], ['fz-snips', 'Snips'], ['fz-obegi', 'Obegi']]
    .forEach(([id, who], i) => add({ id, type: 'freezer', x: 318 + i * 84, y: 92, w: 80, h: 55, occupant: who }));

  add({ id: 'arla', type: 'freezer', label: 'Fridge', x: 760, y: 120, w: 80, h: 55, occupant: 'Arla' });
  add({ id: 'arla-top', type: 'side_gondola', x: 760, y: 92, w: 80, h: 25, occupant: 'Puck' });
  add({ id: 'arla-right', type: 'side_gondola', rot: 90, x: 843 + 12.5 - 40, y: 147.5 - 12.5, w: 80, h: 25, occupant: 'Puck' });

  add({ id: 'island', type: 'freezer_island', x: 220, y: 200, w: 440, h: 180,
    sectionsA: secs([['Fries', 106, 'frozen'], ['Frozen vegetables', 324, 'frozen']]),
    sectionsB: secs([['Mozzarella shredded', 106, 'frozen'], ['Seafood', 214, 'frozen'], ['Shrimps', 110, 'frozen']]) });
  // island end caps: standard end caps (80 × 60) turned 90°
  add({ id: 'island-l', type: 'endcap', rot: 90, x: 220 - 3 - 30 - 40, y: 290 - 30, w: S.E, h: S.CAP, occupant: 'UFICO' });
  add({ id: 'island-r', type: 'endcap', rot: 90, x: 660 + 3 + 30 - 40, y: 290 - 30, w: S.E, h: S.CAP, occupant: 'Halwany' });

  /* ================= Displays & promotions ================= */
  display('d-kazzi', 'Kazzi', 2200, 860);
  add({ id: 'pt-fdc', type: 'promo_table', label: 'FDC + promo', x: 2380, y: 895, w: 160, h: 40, occupant: 'FDC' });
  add({ id: 'pt-abiramia', type: 'promo_table', x: 2580, y: 895, w: 160, h: 40, occupant: 'Abi Ramia' });
  display('d-golden', 'Golden Food', 2420, 1740, 'Santiveri', 'Tchibo + Lotus');
  add({ id: 'promo-zone', type: 'promo_zone', label: 'Promo zone', x: 2776, y: 1727, w: 160, h: 60 });

  /* ================= Wines & spirits ================= */
  const SX = 2840, SY = [1100, 1100 + PITCH, 1100 + PITCH * 2];
  display('d-glenfiddich', 'Glenfiddich', 3080, 860);
  add({ id: 'sh-arak', type: 'shelf', x: 3280, y: 995, w: 302, h: 28, sectionsA: secs([['Arak', 1, 'alcohol']]) });
  add({ id: 'sh-spirits-wall', type: 'shelf', x: 3585, y: 995, w: 30, h: 720, sectionsA: secs([['Wines & spirits', 1, 'alcohol']]) });
  [['bg1', 'Tanqueray', 'Beer'], ['bg2', 'Johnnie Walker', 'Spirits'], ['bg3', 'Gia', 'Spirits']]
    .forEach(([id, who, cat], i) => gondola(id, SX, SY[i], [[cat, 1, 'alcohol']], null, { l: who }, { aisleAfter: i < 2 ? 15 + i : 0 }));
  add({ id: 'sh-nuts', type: 'shelf', x: SX + S.E, y: 1680, w: S.L, h: 28, sectionsA: secs([['Nuts', 1, 'snacks']]) });

  /* ================= Checkout area ================= */
  add({ id: 'q-nutella', type: 'side_gondola', x: 2776, y: 1897, w: 80, h: 25, occupant: 'Nutella' });
  add({ id: 'q-pain', type: 'side_gondola', x: 2858, y: 1897, w: 80, h: 25, occupant: 'Pain de Valeur' });
  add({ id: 'q-mentos', type: 'display_side', x: 2940, y: 1897, w: 110, h: 25, occupant: 'Mentos' });
  add({ id: 'q-shelf', type: 'shelf', x: 2858, y: 1925, w: 80, h: 430, sectionsA: secs([['Queue shelf', 1, 'confectionery']]) });
  [1951, 2058, 2166, 2272].forEach((y, i) => add({ id: `co-${i + 1}`, type: 'checkout', label: `Checkout ${i + 1}`, x: 3341, y, w: 136, h: 27 }));
  add({ id: 'entrance', type: 'entrance', label: 'Entrance', x: 3208, y: 2378, w: 459, h: 112 });

  /* ================= Zone names (rename freely in Edit layout) ================= */
  [['zone-grocery', 'Grocery', 150, G[4] + S.D + S.AISLE + 20, 700],
   ['zone-breakfast', 'Breakfast & drinks', 1880, 160, 560],
   ['zone-sweets', 'Sweets & biscuits', 1860, M[6] + S.D + S.AISLE + 20, 760],
   ['zone-spirits', 'Wines & spirits', 2880, 770, 520],
   ['zone-promo', 'Promotions', 2330, 770, 460],
   ['zone-checkout', 'Checkouts', 3180, 1860, 440]]
    .forEach(([id, label, x, y, w]) => add({ id, type: 'zone', label, x, y, w, h: 70 }));

  global.STORE_MAP_SEED = global.STORE_MAP_SEED || {};
  global.STORE_MAP_SEED.ground = {
    floor: { id: 'ground', name: 'Ground floor', width: 3670, height: 2500, sort: 1 },
    objects
  };
})(window);
