/* ============================================================
   Store map › Sales (owner, 2026-10-12; migration 088).
   Each labelled part of a shelf (per side) and each counter / area of
   the map is linked to system categories (map_links, the whole path:
   the system reuses its codes under other parents). In the map's Sales
   mode every linked part takes a colour by its sales for the period
   (today live, yesterday, 7 days, this month) and shows its figure;
   grey = not linked. The side panel lists a shelf's parts with their
   figures and links; the Link assistant suggests a category for every
   part of every floor by name.
   Sales from lv-dashboard (map_sales): amounts for vendors.manage, else
   each line's share of the period (the floor manager sees no money).
   Linking: rentals.layout or vendors.manage.
   Public API: window.MapSales = { hooks }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const el = id => document.getElementById(id);
  const S = { period: 'today', rows: null, money: false, at: null, links: [], linksLoaded: false, cats: null, nodes: null, busy: false, err: '', timer: null, on: false, getMap: null, memo: new Map(), maxMemo: new Map(), barEl: null, openPick: null };
  const canLink = () => can('rentals.layout') || can('vendors.manage');
  const showMoney = () => S.money && can('vendors.manage');
  const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['month', 'This month']];
  const addD = (d, k) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
  function range(p) {
    const t = todayStr();
    if (p === 'yesterday') return [addD(t, -1), addD(t, -1)];
    if (p === '7d') return [addD(t, -6), t];
    if (p === 'month') return [t.slice(0, 8) + '01', t];
    return [t, t];
  }
  const money = v => '$' + (n(v) >= 1000 ? (Math.round(n(v) / 100) / 10).toLocaleString('en-US') + 'k' : Math.round(n(v)).toLocaleString('en-US'));
  const moneyFull = v => '$' + Math.round(n(v)).toLocaleString('en-US');
  const pctS = v => (Math.round(n(v) * 1000) / 10).toLocaleString('en-US') + '%';
  const keyOf = (id, side, label) => `${id}|${side || ''}|${label || ''}`;
  const map = () => S.getMap && S.getMap();
  function repaint() { const m = map(); if (!m) return; S.memo.clear(); S.maxMemo.clear(); m.renderSvg(); m.renderLegend(); m.renderPanel(); paintBar(); }

  /* ---------------- data ---------------- */
  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    let msg = data?.error || '';
    if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
    if (msg || error || !data) throw new Error(msg || 'no answer');
    return data;
  }
  async function loadLinks() {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('map_links').select('*').range(from, from + 999);
      if (error) throw new Error(/map_links/.test(error.message) ? 'The map links are not set up yet (migration 088).' : error.message);
      all.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    S.links = all; S.linksLoaded = true;
  }
  async function loadCats() {
    if (S.cats) return;
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('sys_categories').select('dep, dep_desc, sec, sec_desc, grp, grp_desc, sub, sub_desc, sales_12m').range(from, from + 999);
      if (error) throw new Error(error.message);
      all.push(...(data || [])); if (!data || data.length < 1000) break;
    }
    S.cats = all;
    // the nodes one can link to: departments, sections, groups (in their section), sub-groups (in their group)
    const nodes = new Map();
    const add = (level, k, o) => { const x = nodes.get(level + '|' + k) || { level, ...o, sales: 0 }; x.sales += n(o._s); nodes.set(level + '|' + k, x); };
    all.forEach(r => {
      add('department', r.dep, { dep: r.dep, sec: '', grp: '', sub: '', name: r.dep_desc || r.dep, path: '', _s: r.sales_12m });
      add('section', r.sec, { dep: '', sec: r.sec, grp: '', sub: '', name: r.sec_desc || r.sec, path: r.dep_desc || '', _s: r.sales_12m });
      add('group', r.sec + '|' + r.grp, { dep: '', sec: r.sec, grp: r.grp, sub: '', name: r.grp_desc || r.grp, path: r.sec_desc || '', _s: r.sales_12m });
      add('subgroup', r.sec + '|' + r.grp + '|' + r.sub, { dep: '', sec: r.sec, grp: r.grp, sub: r.sub, name: r.sub_desc || r.sub, path: `${r.sec_desc || ''} › ${r.grp_desc || ''}`, _s: r.sales_12m });
    });
    S.nodes = [...nodes.values()].map(x => { delete x._s; return x; });
  }
  async function loadSales() {
    if (S.busy) return; S.busy = true; paintBar();
    const [f, t] = range(S.period);
    try { const d = await call({ action: 'map_sales', from: f, to: t }); S.rows = d.rows || []; S.money = !!d.money; S.at = new Date(); S.err = ''; }
    catch (e) { S.err = e.message === 'no answer' ? 'The system did not answer.' : e.message; }
    finally { S.busy = false; }
    repaint();
  }

  /* ---------------- figures per part ---------------- */
  const matches = (r, l) => l.level === 'department' ? r.dep === l.dep
    : r.sec === l.sec && (l.level === 'section' || (r.grp === l.grp && (l.level === 'group' || r.sub === l.sub)));
  const linksAt = key => S.links.filter(l => keyOf(l.object_id, l.side, l.part_label) === key);
  // a category linked in more than one place (Biscuits on two gondolas): its sales show on each, said so, counted once in totals
  const pathOf = l => [l.level, l.dep, l.sec, l.grp, l.sub].join('|');
  const placesOf = l => new Set(S.links.filter(x => pathOf(x) === pathOf(l)).map(x => keyOf(x.object_id, x.side, x.part_label))).size;
  function valueAt(key) {
    if (S.memo.has(key)) return S.memo.get(key);
    const ls = linksAt(key); let v = null, qty = 0;
    if (ls.length && S.rows) {
      v = 0;
      S.rows.forEach(r => { if (ls.some(l => matches(r, l))) { v += n(showMoney() ? r.sales : (r.share ?? r.sales)); qty += n(r.qty); } });
    }
    const out = ls.length ? { v, qty, links: ls } : null;
    S.memo.set(key, out); return out;
  }
  // the parts of a floor: every labelled part of every shelf, every counter / area (no rented spots, walls, labels, checkouts)
  const WHOLE = new Set(['fishery', 'butchery', 'vegetables', 'deli_counter', 'fixed']);
  function partsOf(objs, m) {
    const out = [];
    objs.forEach(o => {
      const k = m.typeOf(o).kind;
      if (k === 'fixture') [['A', o.sectionsA], ['B', o.sectionsB]].forEach(([side, secs]) => (secs || []).forEach(s => { if (s.label && s.label !== 'Section') out.push({ o, side, label: s.label }); }));
      else if (k === 'fixed' && WHOLE.has(o.type)) out.push({ o, side: '', label: '' });
    });
    return out;
  }
  function floorMax() {
    const m = map(); if (!m) return 1;
    const fid = m.floorId; if (S.maxMemo.has(fid)) return S.maxMemo.get(fid);
    const mx = Math.max(0, ...partsOf(m.objects, m).map(p => n(valueAt(keyOf(p.o.id, p.side, p.label))?.v)));
    S.maxMemo.set(fid, mx || 1); return mx || 1;
  }
  const fillOf = t => `color-mix(in srgb, var(--pine, #1943AF) ${Math.round(8 + 77 * Math.max(0, Math.min(1, t)))}%, var(--paper-raised, #ffffff))`;
  function part(o, side, label) {
    const key = keyOf(o.id, side, label), x = valueAt(key);
    if (!x) return null;
    if (!S.rows) return { fill: 'color-mix(in srgb, var(--pine, #1943AF) 6%, #ffffff)', sub: '…', title: `${label || o.label || ''}: reading the sales…` };
    const t = Math.sqrt(n(x.v) / floorMax());   // square root: the small parts stay visible next to the big ones
    const fig = showMoney() ? money(x.v) : pctS(x.v);
    const shared = x.links.some(l => placesOf(l) > 1);
    return { fill: fillOf(t), sub: fig, dark: t > 0.62,
      title: `${label || o.label || ''}: ${showMoney() ? moneyFull(x.v) : pctS(x.v) + ' of the store’s sales'} · ${Math.round(x.qty).toLocaleString('en-US')} units\n${x.links.map(l => l.name + (placesOf(l) > 1 ? ` (shared by ${placesOf(l)} places)` : '')).join(', ')}${shared ? '\nThe same category is in more than one place: these are its sales, shown on each place.' : ''}` };
  }
  function legend() {
    const [f, t] = range(S.period);
    const per = PERIODS.find(p => p[0] === S.period)[1];
    if (S.err) return `<span>${esc(S.err)}</span>`;
    return `<span class="ms-scale"><i style="background:${fillOf(0)}"></i><i style="background:${fillOf(0.35)}"></i><i style="background:${fillOf(0.65)}"></i><i style="background:${fillOf(1)}"></i></span>
      <span>${esc(per)}${S.period === 'today' ? ' (live)' : ''}: light = little, dark = a lot${showMoney() ? ` · up to ${moneyFull(floorMax())} on this floor` : ''}</span>
      <span><i style="background:var(--sm-unlinked, #eceee8);border:1px dashed #b9bdb3"></i>not linked</span>
      <span class="ms-dates">${esc(f === t ? f.split('-').reverse().join('-') : f.split('-').reverse().join('-') + ' → ' + t.split('-').reverse().join('-'))}</span>`;
  }

  /* ---------------- the bar above the map ---------------- */
  function paintBar() {
    const b = S.barEl; if (!b || !S.on) return;
    const linked = new Set(S.links.map(l => keyOf(l.object_id, l.side, l.part_label))).size;
    b.innerHTML = `<div class="sm-seg ms-periods">${PERIODS.map(([k, l]) => `<button data-ms-p="${k}" class="${k === S.period ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="sm-btn" data-ms="reload" title="Read the sales again" aria-label="Read again">${S.busy ? '…' : '↻'}</button>
      <span class="ms-at">${S.busy ? 'reading…' : S.at ? 'updated ' + S.at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      ${canLink() ? `<button class="sm-btn" data-ms="assist" title="Link the map's parts to the system's categories">Link the map${linked ? ` <span class="ms-n">${linked}</span>` : ''}</button>` : ''}`;
    b.onclick = e => {
      const p = e.target.closest('[data-ms-p]'); if (p) { S.period = p.dataset.msP; S.rows = null; S.memo.clear(); loadSales(); return; }
      const a = e.target.closest('[data-ms]'); if (!a) return;
      if (a.dataset.ms === 'reload') loadSales();
      if (a.dataset.ms === 'assist') openAssistant();
    };
  }
  async function onMode(on, barEl) {
    S.on = on; S.barEl = barEl;
    clearInterval(S.timer); S.timer = null;
    if (!on) return;
    paintBar();
    try { if (!S.linksLoaded) { await loadLinks(); repaint(); } } catch (e) { S.err = e.message; repaint(); return; }
    loadSales();
    // live: today again every 5 minutes while the Sales mode is open and the page visible
    S.timer = setInterval(() => { if (S.on && S.period === 'today' && document.visibilityState === 'visible') loadSales(); }, 5 * 60 * 1000);
  }

  /* ---------------- suggestions (by name) ---------------- */
  const norm = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const sing = w => w.length > 3 && w.endsWith('S') && !w.endsWith('SS') ? w.slice(0, -1) : w;
  const words = s => norm(s).split(' ').filter(w => w && !['AND', 'THE', 'OF', 'WITH', 'FOR'].includes(w)).map(sing);
  const PRESET = { fishery: 'FRESH FISHERY', butchery: 'MEAT', vegetables: 'PRODUCE', deli_counter: 'DELI MEAT' };
  // A suggestion per piece of the label ("Mayo + ketchup" = two). Scored: same words (any order, "Icecream" = "Ice cream") 100,
  // the label inside the name 62 less 12 per extra word ("Grain" is not "Roasted coffee grains"), a word that starts the other
  // ("Mayo" / "Mayonnaise"), the label's other words found in the category's path ("Laundry gel" = gel under laundry detergent),
  // a freezer prefers frozen categories (Shrimps in the island freezer), then the categories that sell most.
  // sure = the same name and clearly ahead of the next different name; else the candidates are shown to choose from.
  function candidates(piece, type) {
    const pw = words(piece); if (!pw.length) return [];
    const pj = pw.join(' '), flat = pj.replace(/ /g, ''), pset = [...pw].sort().join(' ');
    const freezer = /freezer/.test(type || '');
    const wmatch = (a, b) => a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));
    const out = [];
    S.nodes.forEach(x => {
      if (x.level === 'department') return;
      const nw = words(x.name), nj = nw.join(' ');
      let s = 0;
      const exact = nj === pj || nj.replace(/ /g, '') === flat || [...nw].sort().join(' ') === pset;
      if (exact) s = 100;
      else if ((' ' + nj + ' ').includes(' ' + pj + ' ')) s = 62 - 12 * (nw.length - pw.length);
      else if ((' ' + pj + ' ').includes(' ' + nj + ' ')) s = 45 - 6 * (pw.length - nw.length);
      else { const hit = pw.filter(w => nw.some(v => wmatch(w, v))).length; s = hit ? 40 * hit / Math.max(pw.length, nw.length) : 0; }
      if (s <= 0) return;
      const path = words(x.path); s += 12 * pw.filter(w => !nw.includes(w) && path.includes(w)).length;
      s += { group: 8, subgroup: 4, section: 6 }[x.level] || 0;
      const frozen = /FROZEN|FRZ/.test(nj + ' ' + norm(x.path));
      if (freezer && frozen) s += 20; else if (frozen && !/FROZEN|FRZ/.test(pj)) s -= 15;
      if (freezer && !frozen && /FRESH/.test(nj)) s -= 15;
      s += Math.log10(n(x.sales) + 1) * 2.5;
      out.push({ x, s, exact });
    });
    return out.sort((a, b) => b.s - a.s);
  }
  function suggestFull(label, type) {
    if (!S.nodes) return [];
    if (!label && PRESET[type]) { const s = S.nodes.find(x => x.level === 'section' && norm(x.name) === PRESET[type]); return s ? [{ best: s, sure: true, alts: [] }] : []; }
    const pieces = String(label || '').split(/\s*\+\s*|\s+&\s+|\s+and\s+/i).map(x => x.trim()).filter(Boolean);
    return pieces.map(p => {
      const c = candidates(p, type).filter(c => c.s >= 40); if (!c.length) return null;
      const next = c.find(o => norm(o.x.name) !== norm(c[0].x.name));
      // sure only for the same name (any word order): a looser match ("Beverage" in "Alcoholic beverages") is always a choice
      return { best: c[0].x, sure: c[0].exact && (!next || c[0].s - next.s >= 6), alts: c.slice(1).filter(o => c[0].s - o.s < 12).slice(0, 3).map(o => o.x) };
    }).filter(Boolean);
  }
  // the sure suggestions only (what "Accept" links without asking)
  const suggest = (label, type) => suggestFull(label, type).filter(s => s.sure).map(s => s.best);
  async function addLinks(o, side, label, nodes) {
    const rows = nodes.map(x => ({ object_id: o.id, side: side || '', part_label: label || '', level: x.level, dep: x.dep || '', sec: x.sec || '', grp: x.grp || '', sub: x.sub || '', name: x.name }));
    if (!rows.length) return;
    const { error } = await sb.from('map_links').upsert(rows, { onConflict: 'object_id,side,part_label,level,dep,sec,grp,sub', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    await loadLinks();
  }
  async function removeLink(id) {
    const { error } = await sb.from('map_links').delete().eq('id', id);
    if (error) throw new Error(error.message);
    await loadLinks();
  }

  /* ---------------- the side panel ---------------- */
  function panel(P, o, close) {
    const m = map();
    if (!o) return overview(P);
    const t = m.typeOf(o);
    const parts = t.kind === 'fixture' ? [['A', o.sectionsA], ['B', o.sectionsB]].flatMap(([side, secs]) => (secs || []).filter(s => s.label && s.label !== 'Section').map(s => ({ side, label: s.label, lanes: (o.sectionsB || []).length ? 2 : 1 })))
      : WHOLE.has(o.type) ? [{ side: '', label: '' }] : [];
    const row = p => {
      const key = keyOf(o.id, p.side, p.label), x = valueAt(key);
      const fig = !x ? '<span class="sm-hint">not linked</span>' : !S.rows ? '…' : `<b>${showMoney() ? moneyFull(x.v) : pctS(x.v)}</b> <span class="sm-hint">${Math.round(x.qty).toLocaleString('en-US')} u.</span>`;
      const chips = (x ? x.links : []).map(l => `<span class="ms-chip" title="${esc(l.level)}">${esc(l.name || '')}${canLink() ? `<button type="button" data-unlink="${esc(l.id)}" aria-label="Remove this link" title="Remove this link">×</button>` : ''}</span>`).join('');
      const open = S.openPick === key;
      return `<div class="ms-part" data-key="${esc(key)}">
        <div class="ms-part-head"><span>${p.label ? `${p.lanes === 2 ? `<span class="sm-hint">${p.side}</span> ` : ''}${esc(p.label)}` : esc(o.label || t.name)}</span><span>${fig}</span></div>
        <div class="ms-chips">${chips}${canLink() ? `<button type="button" class="ms-add" data-pick="${esc(key)}" data-side="${esc(p.side)}" data-label="${esc(p.label)}" title="Link to a system category" aria-label="Link to a system category">+</button>` : ''}</div>
        ${open ? `<div class="ms-pick"><input type="search" class="ms-q" placeholder="Find a category (Coffee, Pasta, Fresh fish…)" aria-label="Find a category"><div class="ms-res"></div></div>` : ''}</div>`;
    };
    P.innerHTML = `<div class="sm-p-head"><h3>${esc(o.label || t.name)}<button class="sm-close" data-p="close" aria-label="Close">×</button></h3><div class="sm-sub">${esc(t.name)} · ${esc(m.floor ? m.floor.name : '')}</div></div>
      <div class="sm-p-sec">${parts.map(row).join('') || '<p class="sm-empty">Nothing to link on this element.</p>'}</div>
      <div class="sm-p-sec"><p class="sm-hint">${canLink() ? 'Link each part to what it holds in the system (a section, group or sub-group). ' : ''}The figures are the period chosen above${S.period === 'today' ? ', live (every 5 minutes)' : ''}.</p></div>`;
    P.querySelector('[data-p="close"]').onclick = close;
    P.onclick = async e => {
      const u = e.target.closest('[data-unlink]');
      if (u) { try { await removeLink(u.dataset.unlink); repaint(); } catch (err) { showToast(err.message, true); } return; }
      const pk = e.target.closest('[data-pick]');
      if (pk) { S.openPick = S.openPick === pk.dataset.pick ? null : pk.dataset.pick; try { await loadCats(); } catch (err) { showToast(err.message, true); } panel(P, o, close); const q = P.querySelector('.ms-q'); if (q) { q.focus(); paintPick(P, o, pk.dataset.side, pk.dataset.label); } return; }
      const r = e.target.closest('[data-node]');
      if (r) { const box = r.closest('.ms-part'); const [, side, label] = box.dataset.key.split('|');
        try { await addLinks(o, side, label, [S.nodes[Number(r.dataset.node)]]); S.openPick = null; repaint(); } catch (err) { showToast(err.message, true); } }
    };
    P.oninput = e => { if (e.target.classList.contains('ms-q')) { const box = e.target.closest('.ms-part'); const [, side, label] = box.dataset.key.split('|'); paintPick(P, o, side, label); } };
  }
  function paintPick(P, o, side, label) {
    const q = P.querySelector('.ms-q'), res = P.querySelector('.ms-res'); if (!q || !res || !S.nodes) return;
    const qq = norm(q.value);
    const list = qq ? S.nodes.filter(x => norm(x.name).includes(qq) || norm(x.path).includes(qq)).sort((a, b) => n(b.sales) - n(a.sales)).slice(0, 30)
      : [...new Set(suggestFull(label, o.type).flatMap(s => [s.best, ...s.alts]))];
    res.innerHTML = (qq ? '' : list.length ? '<div class="sm-hint">Suggested</div>' : '<div class="sm-hint">Type to find a category.</div>') + list.map(x => `<button type="button" class="ms-node" data-node="${S.nodes.indexOf(x)}">
      <b>${esc(x.name)}</b> <span class="sm-hint">${esc(x.level)}${x.path ? ' · ' + esc(x.path) : ''}</span></button>`).join('');
  }
  function overview(P) {
    const m = map(), parts = partsOf(m.objects, m);
    const linked = parts.filter(p => valueAt(keyOf(p.o.id, p.side, p.label)));
    const total = S.rows ? S.rows.reduce((t, r) => t + n(showMoney() ? r.sales : (r.share ?? r.sales)), 0) : 0;
    // what the floor's linked parts cover (a category linked in two places is counted once here)
    const covered = S.rows ? S.rows.filter(r => linked.some(p => valueAt(keyOf(p.o.id, p.side, p.label)).links.some(l => matches(r, l)))).reduce((t, r) => t + n(showMoney() ? r.sales : (r.share ?? r.sales)), 0) : 0;
    // best parts: one line per set of categories (a category in two places is one line, said shared)
    const seen = new Map();
    linked.forEach(p => { const x = valueAt(keyOf(p.o.id, p.side, p.label)), k = x.links.map(pathOf).sort().join(';'), y = seen.get(k);
      if (y) y.k++; else seen.set(k, { p, v: n(x.v), k: 1 }); });
    const top = [...seen.values()].sort((a, b) => b.v - a.v).slice(0, 8);
    P.innerHTML = `<div class="sm-p-head"><h3>Sales on the map</h3><div class="sm-sub">${esc(m.floor ? m.floor.name : '')} · ${esc(PERIODS.find(p => p[0] === S.period)[1])}</div></div>
      <div class="sm-p-sec"><dl class="sm-kv"><dt>Parts linked</dt><dd>${linked.length} / ${parts.length}</dd>
        ${S.rows ? `<dt>Store</dt><dd>${showMoney() ? moneyFull(total) : '100%'}</dd><dt>On this floor's links</dt><dd>${showMoney() ? moneyFull(covered) : ''} ${total ? `(${pctS(covered / total)})` : ''}</dd>` : ''}</dl></div>
      <div class="sm-p-sec"><h4>Best parts</h4>${top.map(({ p, v, k }) => `<div class="ms-part-head"><span>${esc(p.label || p.o.label || '')}${k > 1 ? ` <span class="sm-hint">· shared by ${k} places</span>` : ''}</span><b>${showMoney() ? moneyFull(v) : pctS(v)}</b></div>`).join('') || '<p class="sm-empty">Nothing linked yet.</p>'}</div>
      <div class="sm-p-sec"><p class="sm-hint">Click a shelf or a counter for its parts${canLink() ? ' and to link them' : ''}.${canLink() ? ' <b>Link the map</b> (above) suggests a category for every part.' : ''}</p></div>`;
  }

  /* ---------------- the Link assistant: every part of every floor, with a suggestion ---------------- */
  async function openAssistant() {
    const m = map(); if (!m) return;
    let dlg = el('msAssist');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'msAssist'; dlg.className = 'ms-dlg'; document.body.appendChild(dlg); dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); }); }
    dlg.innerHTML = '<p class="muted-note">Reading the system’s categories…</p>'; if (!dlg.open) dlg.showModal();
    try { await loadCats(); await loadLinks(); } catch (e) { dlg.innerHTML = `<p class="login-err">${esc(e.message)}</p>`; return; }
    const all = [];
    m.floors.forEach(f => partsOf((m.layouts[f.id] || []), m).forEach(p => all.push({ ...p, floor: f.name })));
    let onlyOpen = true;
    const paint = () => {
      const rows = all.map(p => { const key = keyOf(p.o.id, p.side, p.label), ls = linksAt(key), full = ls.length ? [] : suggestFull(p.label, p.o.type);
        return { p, key, ls, full, sug: full.filter(s => s.sure).map(s => s.best), unsure: full.filter(s => !s.sure) }; });
      const shown = rows.filter(r => !onlyOpen || !r.ls.length);
      const withSug = rows.filter(r => !r.ls.length && r.sug.length);
      const nodeIx = x => S.nodes.indexOf(x);
      dlg.innerHTML = `<div class="ms-dlg-head"><h3>Link the map</h3><span class="muted-note">${rows.filter(r => r.ls.length).length} of ${rows.length} parts linked</span>
          <label class="ms-only"><input type="checkbox" ${onlyOpen ? 'checked' : ''} data-only> not linked only</label>
          ${withSug.length ? `<button type="button" class="btn small" data-all>Accept ${withSug.length} suggestion${withSug.length === 1 ? '' : 's'}</button>` : ''}
          <button type="button" class="icon-btn" data-close title="Close" aria-label="Close">×</button></div>
        <div class="items-scroll ms-dlg-body"><table class="items"><thead><tr><th>Floor</th><th>Shelf / counter</th><th>Side</th><th>Part</th><th>Linked to</th><th>Suggestion</th><th></th></tr></thead>
          <tbody>${shown.map(r => `<tr data-key="${esc(r.key)}"><td>${esc(r.p.floor)}</td><td>${esc(r.p.o.label || m.typeOf(r.p.o).name)}</td><td>${esc(r.p.side)}</td><td><b>${esc(r.p.label || '(whole)')}</b></td>
            <td>${r.ls.map(l => `<span class="ms-chip">${esc(l.name || '')}</span>`).join(' ') || '<span class="muted-note">—</span>'}</td>
            <td>${r.sug.map(x => `<span class="ms-chip ms-sug" title="${esc(x.level + (x.path ? ' · ' + x.path : ''))}">${esc(x.name)} <span class="muted-note">${esc(x.level)}</span></span>`).join(' ')}
              ${r.unsure.map(u => `<div class="ms-choose"><span class="muted-note">choose:</span> ${[u.best, ...u.alts].map(x => `<button type="button" class="ms-chip ms-opt" data-pickone="${nodeIx(x)}" title="${esc(x.level + (x.path ? ' · ' + x.path : ''))}">${esc(x.name)} <span class="muted-note">${esc(x.path ? x.path.split(' › ').pop() : x.level)}</span></button>`).join(' ')}</div>`).join('')}
              ${!r.ls.length && !r.full.length ? '<span class="muted-note">no match: link it on the map</span>' : ''}</td>
            <td>${r.sug.length ? `<button type="button" class="btn ghost small" data-accept>Accept${r.unsure.length ? ' sure ones' : ''}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-note">Every part is linked.</td></tr>'}</tbody></table></div>
        <p class="muted-note" style="margin:8px 0 0;">Suggestions come from the names on the map and the system's categories (the ones that sell most first). Check each one; a wrong link is removed with × in the map's side panel. Parts with no match are linked by hand: click the shelf on the map, then +.</p>`;
    };
    paint();
    dlg.onchange = e => { if (e.target.matches('[data-only]')) { onlyOpen = e.target.checked; paint(); } };
    dlg.onclick = async e => {
      if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
      const pick = e.target.closest('[data-pickone]');
      if (pick) {   // one of the close candidates, chosen by hand
        const p = all.find(q => keyOf(q.o.id, q.side, q.label) === pick.closest('tr').dataset.key);
        pick.disabled = true;
        try { await addLinks(p.o, p.side, p.label, [S.nodes[Number(pick.dataset.pickone)]]); paint(); repaint(); } catch (err) { showToast(err.message, true); pick.disabled = false; }
        return;
      }
      const one = e.target.closest('[data-accept]'), every = e.target.closest('[data-all]');
      if (!one && !every) return;
      const todo = every ? all.filter(p => !linksAt(keyOf(p.o.id, p.side, p.label)).length) : [all.find(p => keyOf(p.o.id, p.side, p.label) === one.closest('tr').dataset.key)];
      if (every && !(await showConfirm(`Link ${todo.filter(p => suggest(p.label, p.o.type).length).length} parts to their suggested category? You can still change each one on the map.`, 'Link them'))) return;
      (every || one).disabled = true;
      try {
        for (const p of todo) { const s = suggest(p.label, p.o.type); if (s.length) await addLinks(p.o, p.side, p.label, s); }
        showToast(every ? 'The suggestions are linked.' : 'Linked.'); paint(); repaint();
      } catch (err) { showToast(err.message, true); (every || one).disabled = false; }
    };
  }

  window.MapSales = { hooks: getMap => { S.getMap = getMap; return { onMode, part, legend, panel }; }, _suggest: (l, t) => suggest(l, t), _load: loadCats };
})();
