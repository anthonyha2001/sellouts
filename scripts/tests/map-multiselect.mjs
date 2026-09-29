// Store map › Edit layout: Ctrl+click group selection, group drag with smart guides, box select,
// align / spread / same size, group duplicate / delete, undo. Tables served from memory (seeded plan).
export default async function (page, { log }) {
  const T = { store_floors: [], store_map_objects: [], store_layout_versions: [], store_map_config: [], rental_contracts: [], rental_supplier_sales: [] };
  await page.route(/\/rest\/v1\/(store_floors|store_map_objects|store_layout_versions|store_map_config|rental_contracts|rental_supplier_sales)(\?|$)/, async route => {
    const r = route.request(), url = new URL(r.url()), t = url.pathname.split('/').pop();
    const single = (r.headers()['accept'] || '').includes('vnd.pgrst.object');
    let rows = T[t];
    for (const [k, v] of url.searchParams) if (v.startsWith('eq.')) rows = rows.filter(x => String(x[k]) === v.slice(3));
    if (r.method() === 'GET') return route.fulfill({ status: 200, json: single ? rows[0] ?? null : rows });
    if (r.method() === 'POST') { let b = JSON.parse(r.postData() || '[]'); b = Array.isArray(b) ? b : [b]; b.forEach(x => { const i = T[t].findIndex(y => y.id === x.id); if (i > -1) T[t][i] = x; else T[t].push(x); }); return route.fulfill({ status: 201, json: single ? b[0] : b }); }
    return route.fulfill({ status: 200, json: [] });
  });
  await page.evaluate(() => switchTab('rentals'));
  await page.waitForFunction(() => Rentals.map && Rentals.map.floors && Rentals.map.floors.length, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.click('#rentalsMap [data-role="edit"]'); await page.waitForTimeout(500);
  const m = 'Rentals.map';
  const at = id => page.evaluate(id => { const el = document.querySelector(`#rentalsMap .sm-o[data-id="${id}"]`); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  const ids = await page.evaluate(() => Rentals.map.draft.filter(o => o.type === 'basket_side' || o.type === 'display').slice(0, 3).map(o => o.id));
  // 1. click the first, Ctrl+click the other two
  let p = await at(ids[0]); await page.mouse.click(p.x, p.y);
  for (const id of ids.slice(1)) { p = await at(id); await page.keyboard.down('Control'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Control'); }
  log('selected:', await page.evaluate(() => Rentals.map.selSet.size), '| panel:', (await page.textContent('#rentalsMap .sm-panel h3')).trim());
  // 2. group drag: all three move by the same amount
  const before = await page.evaluate(ids => ids.map(id => { const o = Rentals.map.draft.find(x => x.id === id); return [o.x, o.y]; }), ids);
  p = await at(ids[0]);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 40, p.y + 25, { steps: 6 });
  const guides = await page.evaluate(() => Rentals.map.guides.length);
  await page.mouse.up();
  const after = await page.evaluate(ids => ids.map(id => { const o = Rentals.map.draft.find(x => x.id === id); return [o.x, o.y]; }), ids);
  const deltas = after.map((a, i) => [Math.round(a[0] - before[i][0]), Math.round(a[1] - before[i][1])].join(','));
  log('group drag deltas (same for all):', deltas.join(' | '), '| guides shown while dragging:', guides);
  // 3. align left, then spread down, then same width
  await page.click('#rentalsMap [data-al="al-left"]');
  const lefts = await page.evaluate(ids => ids.map(id => Math.round(Rentals.map.abox(Rentals.map.draft.find(x => x.id === id)).x0)), ids);
  log('after Align left, left edges:', lefts.join(', '));
  await page.click('#rentalsMap [data-al="dist-v"]');
  const gaps = await page.evaluate(ids => { const bs = ids.map(id => Rentals.map.abox(Rentals.map.draft.find(x => x.id === id))).sort((a, b) => a.y0 - b.y0); return bs.slice(1).map((b, i) => Math.round(b.y0 - bs[i].y1)); }, ids);
  log('after Spread down, gaps:', gaps.join(', '));
  await page.click('#rentalsMap [data-al="same-w"]');
  log('after Same width, widths:', (await page.evaluate(ids => ids.map(id => Rentals.map.draft.find(x => x.id === id).w), ids)).join(', '));
  // 4. duplicate the group, then undo; delete the group, then undo
  const n0 = await page.evaluate(() => Rentals.map.draft.length);
  await page.keyboard.press('Control+d'); const n1 = await page.evaluate(() => Rentals.map.draft.length);
  await page.keyboard.press('Control+z'); const n2 = await page.evaluate(() => Rentals.map.draft.length);
  log('duplicate group:', n0, '->', n1, '| undo ->', n2);
  // 5. box select with Ctrl + drag on empty floor
  await page.keyboard.press('Escape');
  const box = await page.evaluate(() => { const r = document.querySelector('#rentalsMap .sm-canvas').getBoundingClientRect(); return { x: r.left + 12, y: r.top + 12, w: r.width * 0.35, h: r.height * 0.35 }; });
  await page.keyboard.down('Control'); await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + box.w, box.y + box.h, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Control');
  log('box select picked:', await page.evaluate(() => Rentals.map.selSet.size), 'elements');
  await page.keyboard.press('Control+a');
  log('Ctrl+A:', await page.evaluate(() => Rentals.map.selSet.size), 'of', await page.evaluate(() => Rentals.map.draft.length));
  await page.keyboard.press('Escape');
  // leave a group selected for the screenshot
  p = await at(ids[0]); await page.mouse.click(p.x, p.y);
  for (const id of ids.slice(1)) { p = await at(id); await page.keyboard.down('Control'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Control'); }
}
