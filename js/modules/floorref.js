/* ============================================================
   Floor check (owner, 2026-10-11): the simple pages for the floor managers. Everything is divided by GROUP
   (the system's Group › Sub-group), the way the shelves are.
   Today (tab "Today"): what changed on the shelves in the last 2 days, per group, with the stock next to each item:
     - "New" promotions / sell-outs that started, "Ended" ones that are back to the normal price, and prices that
       changed in the system. Each item has a small "Needs promo paper / label" toggle; "Send to the accountant"
       makes the accountant's list (Shelf labels > To print, named "Name (floor check DD/MM)", migration 080).
     - "Mark the group checked": every label of the group is placed. Who and when is kept (migration 081). When
       every group of a promotion / sell-out is checked, the admin is told that all its labels are placed
       correctly (push-alerts) and the record stays (floor_ref_done).
   Full list (tab "Full list"): every item of every promotion and sell-out running today, per group, with the
     price and the stock. Read only: no buttons.
   Placed labels (admin, tab "Placed labels"): the record of who checked what, and when.
   Stock: the nightly snapshot when there is one (migration 076), else asked from the system for what is missing.
   Data: js/modules/floorcheck.js (todaysSources / itemsFor, the same rules as the full check).
   Public API: window.FloorRef = { load, render, loadFull, renderFull, loadHistory, renderHistory }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const S = { data: null, checks: [], stock: {}, q: '', busy: false, marked: {}, sent: {}, err: '', full: null, fullErr: '', hist: null, open: {} };
  const KIND_OF = { starts: 'promo', ends: 'label', price_changed: 'label' };
  const REASON = { starts: ['New', 'active'], ends: ['Back to normal', 'warn'], price_changed: ['Price changed', 'warn'], running: ['Running', 'inactive'] };
  const MARK = { promo: 'Needs promo paper', label: 'Needs label' };
  const day = () => todayStr();
  const lkey = () => `lv:floorref:${Session.user && Session.user.id}:${day()}`;
  function loadLocal() { try { const d = JSON.parse(localStorage.getItem(lkey())) || {}; S.marked = d.marked || {}; S.sent = d.sent || {}; } catch (e) { S.marked = {}; S.sent = {}; } }
  function saveLocal() { try { localStorage.setItem(lkey(), JSON.stringify({ marked: S.marked, sent: S.sent })); } catch (e) { /* storage blocked */ } }
  const num = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const labelCode = it => (String(it.barcode || '').split(',')[0] || String(it.code || '')).trim();
  const groupOf = i => String(i.category || '').trim() || 'No group';
  const srcKind = i => i.source === 'promotion' ? 'promotion' : 'sellout';
  const srcId = i => String(i.source === 'promotion' ? i.promotion_id : i.sellout_id);
  const pairKey = (i, reason) => `${srcKind(i)}|${srcId(i)}|${reason || i.reason}`;
  const hhmm = ts => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  /* ---------------- stock: the snapshot first, then what is missing ---------------- */
  async function loadStock(codes) {
    const want = [...new Set(codes.map(c => String(c || '').trim()).filter(Boolean))].filter(c => !(c in S.stock));
    if (!want.length) return;
    try {
      const { data: run } = await sb.from('stock_snapshot_runs').select('day').not('finished_at', 'is', null).order('day', { ascending: false }).limit(1).maybeSingle();
      if (run && run.day) {
        for (let i = 0; i < want.length; i += 300) {
          const { data } = await sb.from('stock_snapshots').select('code, stock').eq('day', run.day).in('code', want.slice(i, i + 300));
          (data || []).forEach(r => { if (r.stock !== null && r.stock !== undefined) S.stock[String(r.code)] = Number(r.stock); });
        }
      }
    } catch (e) { /* no snapshot yet */ }
    const missing = want.filter(c => !(c in S.stock)).slice(0, 150);
    if (missing.length) {
      try {
        const { data } = await sb.functions.invoke('lv-dashboard', { body: { action: 'items_stock', codes: missing } });
        Object.entries((data && data.stock) || {}).forEach(([c, v]) => { if (v !== null && v !== undefined) S.stock[c] = Number(v); });
      } catch (e) { console.warn('floor ref stock', e); }
    }
    want.forEach(c => { if (!(c in S.stock)) S.stock[c] = null; });
  }
  const stockHtml = code => {
    const v = S.stock[String(code || '').trim()];
    if (v === undefined) return '<span class="fr-stock">…</span>';
    if (v === null) return '<span class="fr-stock">—</span>';
    return `<span class="fr-stock ${v <= 0 ? 'out' : v < 6 ? 'low' : ''}" title="Stock in the system">${esc(Math.round(v * 10) / 10)} in stock</span>`;
  };

  /* ---------------- Today ---------------- */
  async function load() {
    loadLocal(); S.err = '';
    try {
      const since = new Date(Date.now() - 2 * 864e5).toLocaleDateString('en-CA');
      S.data = await FloorCheck.refItems('changes', since);
      const { data } = await sb.from('floor_ref_checks').select('*').eq('check_date', day());
      S.checks = data || [];
      loadStock(S.data.items.map(i => i.code)).then(() => { if (document.getElementById('frQ') || document.querySelector('.fr-group')) render(); });
    } catch (e) { console.error(e); S.err = e.message || String(e); S.data = null; }
  }
  // the groups of today's list: [{ name, items, pairs }]
  function groups() {
    const q = S.q.trim().toLowerCase();
    const seen = new Set(), map = new Map();
    (S.data?.items || []).filter(i => ['starts', 'ends', 'price_changed'].includes(i.reason)).forEach(i => {
      const k = `${i.code || i.item_key}|${i.reason}`; if (seen.has(k)) return; seen.add(k);
      if (q && !String(i.description || '').toLowerCase().includes(q) && !String(i.code || '').toLowerCase().includes(q) && !String(i.source_name || '').toLowerCase().includes(q) && !groupOf(i).toLowerCase().includes(q)) return;
      const g = groupOf(i); if (!map.has(g)) map.set(g, []); map.get(g).push(i);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, items]) => ({ name, items }));
  }
  // every promotion / sell-out (and reason) of today's list, with how many groups it has: when all are checked it is done
  function sourceTotals() {
    const m = new Map();
    (S.data?.items || []).filter(i => ['starts', 'ends', 'price_changed'].includes(i.reason)).forEach(i => {
      const k = pairKey(i);
      const s = m.get(k) || { kind: srcKind(i), id: srcId(i), name: i.source_name || '', reason: i.reason, groups: new Set(), items: 0 };
      s.groups.add(groupOf(i)); s.items++; m.set(k, s);
    });
    return m;
  }
  const groupChecks = (g, items) => {
    const pairs = [...new Set(items.map(i => pairKey(i)))];
    const rows = pairs.map(p => { const [kind, id, reason] = p.split('|'); return S.checks.find(c => c.group_name === g && c.source_kind === kind && String(c.source_id) === id && c.reason === reason); });
    return { all: rows.length > 0 && rows.every(Boolean), rows: rows.filter(Boolean) };
  };

  function itemRow(i) {
    const k = i.item_key, kind = KIND_OF[i.reason] || 'label', sent = !!S.sent[k], marked = !!S.marked[k];
    const up = i.expected_price !== null && i.old_price !== null && Number(i.expected_price) > Number(i.old_price);
    const r = REASON[i.reason] || REASON.running;
    return `<div class="fr-row ${marked ? 'marked' : ''} ${sent ? 'sent' : ''}">
      <div class="fr-main"><b>${esc(i.description || i.code)}</b>
        <span class="muted-note"><span class="badge ${r[1]}">${esc(r[0])}</span> ${esc(i.source_name || '')} · ${esc(i.code || '')}</span></div>
      <div class="fr-price"><b class="${i.reason === 'starts' ? 'fr-new' : ''}">${esc(num(i.expected_price))}</b>
        ${i.old_price !== null && i.old_price !== undefined ? `<span class="muted-note">was ${esc(num(i.old_price))}${up ? ' ↑' : ''}</span>` : ''}${stockHtml(i.code)}</div>
      ${sent ? '<span class="badge active fr-btn">Sent ✓</span>'
        : `<button type="button" class="fr-btn fr-mark ${marked ? 'on' : ''}" data-fr-mark="${esc(k)}" aria-pressed="${marked}">${marked ? '✓ ' : ''}${esc(MARK[kind])}</button>`}
    </div>`;
  }

  function render(box) {
    box = box || document.getElementById('fcBody'); if (!box) return;
    if (!S.data && !S.err) { box.innerHTML = '<div class="card"><p class="muted-note vs-loading" style="margin:0;">Loading what changed…</p></div>'; return; }
    if (S.err) { box.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const gs = groups();
    const total = gs.reduce((n, g) => n + g.items.length, 0);
    const pending = gs.flatMap(g => g.items.filter(i => S.marked[i.item_key] && !S.sent[i.item_key]));
    const nPromo = pending.filter(i => KIND_OF[i.reason] === 'promo').length, nLabel = pending.length - nPromo;
    const nDone = gs.filter(g => groupChecks(g.name, g.items).all).length;
    box.innerHTML = `
      <div class="card fr-head">
        <div><h3 style="margin:0;">What changed on the shelves</h3>
          <span class="muted-note">${esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))} · the last 2 days · by group</span></div>
        <div class="fr-counts"><span><b>${gs.length}</b> groups</span><span><b>${total}</b> items</span><span><b>${nDone}</b> checked</span></div>
      </div>
      <input type="search" id="frQ" class="fr-find" placeholder="Find an item, a group, a promotion or a code…" value="${esc(S.q)}" autocomplete="off">
      ${gs.length ? gs.map(g => {
        const c = groupChecks(g.name, g.items), open = S.open[g.name] !== false;
        const who = c.rows[0];
        return `<section class="card fr-group ${c.all ? 'done' : ''}">
          <div class="fr-ghead" data-fr-toggle="${esc(g.name)}">
            <div><h4>${esc(g.name)} <span class="vc-count">${g.items.length}</span></h4>
              ${c.all ? `<span class="fr-who">✓ Checked by ${esc(who?.checked_by_name || '—')} · ${esc(who ? hhmm(who.checked_at) : '')}</span>` : ''}</div>
            <span class="chev">${open ? '▾' : '▸'}</span>
          </div>
          ${open ? `${g.items.map(itemRow).join('')}
          <button type="button" class="btn ${c.all ? 'ghost' : ''} fr-gbtn" data-fr-group="${esc(g.name)}">${c.all ? 'Undo: the group is not checked' : '✓ Mark the group checked: every label is placed'}</button>` : ''}
        </section>`; }).join('')
        : `<div class="card"><p class="muted-note" style="margin:0;">${S.q ? 'Nothing matches your search.' : 'Nothing changed in the last 2 days: no promotion started or ended, no price changed.'}</p></div>`}
      <div class="fr-stick ${pending.length ? 'show' : ''}">
        <button type="button" class="btn fr-send" id="frSend" ${S.busy ? 'disabled' : ''}>Send to the accountant · ${nPromo ? nPromo + ' promo paper' + (nPromo === 1 ? '' : 's') : ''}${nPromo && nLabel ? ' + ' : ''}${nLabel ? nLabel + ' label' + (nLabel === 1 ? '' : 's') : ''}</button>
      </div>`;
    box.querySelector('#frQ').oninput = e => { S.q = e.target.value; const pos = e.target.selectionStart; render(box); const q = box.querySelector('#frQ'); q.focus(); q.setSelectionRange(pos, pos); };
    box.querySelectorAll('[data-fr-toggle]').forEach(h => h.onclick = () => { const g = h.dataset.frToggle; S.open[g] = S.open[g] === false; render(box); });
    box.querySelectorAll('[data-fr-mark]').forEach(b => b.onclick = () => { const k = b.dataset.frMark; if (S.marked[k]) delete S.marked[k]; else S.marked[k] = 1; saveLocal(); render(box); });
    box.querySelectorAll('[data-fr-group]').forEach(b => b.onclick = () => toggleGroup(box, b.dataset.frGroup));
    box.querySelector('#frSend')?.addEventListener('click', () => send(box, pending));
  }

  async function toggleGroup(box, name) {
    if (S.busy) return;
    const g = groups().find(x => x.name === name); if (!g) return;
    const totals = sourceTotals();
    const sources = [...new Set(g.items.map(i => pairKey(i)))].map(p => { const t = totals.get(p); return { kind: t.kind, id: t.id, name: t.name, reason: t.reason,
      items: g.items.filter(i => pairKey(i) === p).length, groups_total: t.groups.size }; });
    const c = groupChecks(name, g.items);
    S.busy = true;
    try {
      if (c.all) {
        const { error } = await sb.rpc('floor_ref_uncheck_group', { p_group: name, p_sources: sources });
        if (error) throw error;
      } else {
        const { data, error } = await sb.rpc('floor_ref_check_group', { p_group: name, p_sources: sources });
        if (error) throw error;
        const done = Array.isArray(data) ? data : [];
        showToast(done.length ? `All the labels of ${done.map(d => '"' + d.name + '"').join(', ')} are placed. The admin was told.` : `${name}: checked.`);
      }
      const { data: rows } = await sb.from('floor_ref_checks').select('*').eq('check_date', day());
      S.checks = rows || [];
    } catch (e) { console.error(e); showToast('Not saved — ' + (typeof friendlyError === 'function' ? friendlyError(e) : (e.message || e)), true); }
    S.busy = false; render(box);
  }

  async function send(box, pending) {
    if (!pending.length || S.busy) return;
    S.busy = true; render(box);
    try {
      let made = 0;
      for (const kind of ['promo', 'label']) {
        const part = pending.filter(i => (KIND_OF[i.reason] || 'label') === kind);
        if (!part.length) continue;
        const items = [...new Set(part.map(labelCode).filter(Boolean))].map(code => ({ code }));
        const { data, error } = await sb.rpc('floor_send_promo_papers', { p_items: items, p_kind: kind });
        if (error) throw error;
        if (Number(data) > 0) made += Number(data);
        part.forEach(i => { S.sent[i.item_key] = 1; delete S.marked[i.item_key]; });
      }
      saveLocal();
      showToast(made ? `Sent to the accountant: ${made} item${made === 1 ? '' : 's'}.` : 'Nothing valid to send.');
    } catch (e) {
      console.error(e);
      showToast('Not sent — ' + (typeof friendlyError === 'function' ? friendlyError(e) : (e.message || e)), true);
    }
    S.busy = false; render(box);
  }

  /* ---------------- Full list: read only, by group ---------------- */
  async function loadFull() {
    S.fullErr = '';
    try {
      const src = await FloorCheck.refItems('full', null);
      const seen = new Set();
      S.full = src.items.filter(i => { const k = `${i.code || i.item_key}|${i.source_name}`; if (seen.has(k)) return false; seen.add(k); return true; });
      loadStock(S.full.map(i => i.code)).then(() => { if (document.querySelector('.fr-full')) renderFull(); });
    } catch (e) { console.error(e); S.fullErr = e.message || String(e); S.full = null; }
  }
  function renderFull(box) {
    box = box || document.getElementById('fcBody'); if (!box) return;
    if (S.fullErr) { box.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(S.fullErr)}</p></div>`; return; }
    if (!S.full) { box.innerHTML = '<div class="card"><p class="muted-note vs-loading" style="margin:0;">Loading everything that runs today…</p></div>'; return; }
    const q = S.q.trim().toLowerCase(), map = new Map();
    S.full.filter(i => !q || String(i.description || '').toLowerCase().includes(q) || String(i.code || '').toLowerCase().includes(q) || String(i.source_name || '').toLowerCase().includes(q) || groupOf(i).toLowerCase().includes(q))
      .forEach(i => { const g = groupOf(i); if (!map.has(g)) map.set(g, []); map.get(g).push(i); });
    const gs = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    box.innerHTML = `<div class="fr-full">
      <div class="card fr-head"><div><h3 style="margin:0;">Everything that runs today</h3>
        <span class="muted-note">promotions and sell-outs · by group · price and stock · for reference</span></div>
        <div class="fr-counts"><span><b>${gs.length}</b> groups</span><span><b>${gs.reduce((n, g) => n + g[1].length, 0)}</b> items</span></div></div>
      <input type="search" id="frQ" class="fr-find" placeholder="Find an item, a group, a promotion or a code…" value="${esc(S.q)}" autocomplete="off">
      ${gs.map(([name, items]) => `<section class="card fr-group"><div class="fr-ghead" data-fr-toggle="${esc(name)}"><div><h4>${esc(name)} <span class="vc-count">${items.length}</span></h4></div><span class="chev">${S.open['f:' + name] ? '▾' : '▸'}</span></div>
        ${S.open['f:' + name] ? items.slice().sort((a, b) => String(a.description).localeCompare(String(b.description))).map(i => `<div class="fr-row"><div class="fr-main"><b>${esc(i.description || i.code)}</b>
          <span class="muted-note">${esc(i.source_name || '')} · ${esc(i.code || '')}</span></div>
          <div class="fr-price"><b>${esc(num(i.expected_price))}</b>${i.old_price !== null && i.old_price !== undefined ? `<span class="muted-note">was ${esc(num(i.old_price))}</span>` : ''}${stockHtml(i.code)}</div></div>`).join('') : ''}
      </section>`).join('') || '<div class="card"><p class="muted-note" style="margin:0;">Nothing is running today.</p></div>'}</div>`;
    box.querySelector('#frQ').oninput = e => { S.q = e.target.value; const pos = e.target.selectionStart; renderFull(box); const el = box.querySelector('#frQ'); el.focus(); el.setSelectionRange(pos, pos); };
    box.querySelectorAll('[data-fr-toggle]').forEach(h => h.onclick = () => { const k = 'f:' + h.dataset.frToggle; S.open[k] = !S.open[k]; renderFull(box); });
  }

  /* ---------------- Placed labels: the record (admin) ---------------- */
  async function loadHistory() {
    const from = new Date(Date.now() - 14 * 864e5).toLocaleDateString('en-CA');
    const [d, c] = await Promise.all([
      sb.from('floor_ref_done').select('*').gte('check_date', from).order('completed_at', { ascending: false }),
      sb.from('floor_ref_checks').select('*').gte('check_date', from).order('checked_at', { ascending: false }),
    ]);
    S.hist = { done: d.error ? null : d.data || [], checks: c.error ? [] : c.data || [], err: d.error ? 'Could not be read (migration 081 not run yet?).' : '' };
  }
  function renderHistory(box) {
    box = box || document.getElementById('fcBody'); if (!box) return;
    const h = S.hist;
    if (!h) { box.innerHTML = '<div class="card"><p class="muted-note vs-loading" style="margin:0;">Loading…</p></div>'; return; }
    if (h.err) { box.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(h.err)}</p></div>`; return; }
    const R = r => (REASON[r] || REASON.running)[0];
    box.innerHTML = `<div class="card"><h3 style="margin:0 0 4px;">Labels placed correctly</h3>
      <p class="muted-note" style="margin:0 0 10px;">Every group of the promotion or sell-out was checked on the shelves. The last 14 days.</p>
      ${h.done.length ? `<div class="items-scroll"><table class="items"><thead><tr><th>Day</th><th>Promotion / sell-out</th><th>What</th><th class="num">Groups</th><th class="num">Items</th><th>Completed by</th><th>At</th></tr></thead><tbody>
        ${h.done.map(d => `<tr><td>${esc(d.check_date.split('-').reverse().join('/'))}</td><td><b>${esc(d.source_name || '')}</b> <span class="muted-note">${d.source_kind === 'promotion' ? 'promotion' : 'sell-out'}</span></td><td>${esc(R(d.reason))}</td>
          <td class="num">${d.groups}</td><td class="num">${d.items}</td><td>${esc(d.completed_by_name || '—')}</td><td>${esc(hhmm(d.completed_at))}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted-note" style="margin:0;">Nothing completed yet.</p>'}</div>
      <div class="card"><h3 style="margin:0 0 4px;">Groups checked</h3>
      ${h.checks.length ? `<div class="items-scroll"><table class="items"><thead><tr><th>Day</th><th>Group</th><th>Promotion / sell-out</th><th>What</th><th class="num">Items</th><th>Checked by</th><th>At</th></tr></thead><tbody>
        ${h.checks.slice(0, 300).map(c => `<tr><td>${esc(c.check_date.split('-').reverse().join('/'))}</td><td>${esc(c.group_name)}</td><td>${esc(c.source_name || '')}</td><td>${esc(R(c.reason))}</td>
          <td class="num">${c.items}</td><td>${esc(c.checked_by_name || '—')}</td><td>${esc(hhmm(c.checked_at))}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted-note" style="margin:0;">No group checked yet.</p>'}</div>`;
  }

  window.FloorRef = { load, render, loadFull, renderFull, loadHistory, renderHistory };
})();
