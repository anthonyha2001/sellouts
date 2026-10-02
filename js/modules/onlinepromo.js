/* ============================================================
   Online promotion (owner, 2026-10-02).
   Every item of the online-only sell-outs (sellouts.online, migration 032) that
   are running or coming up: code, description, price before / promo price,
   the sell-out and its due date (last day). One search box (code, barcode,
   description, sell-out, supplier). The delivery team gets a push when a
   sell-out is marked online (push-alerts).
   Public API: window.OnlinePromo = { show }.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-onlinepromo');
  const S = { started: false, sellouts: [], q: '' };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  const money = n => n === null || n === undefined || n === '' || isNaN(Number(n)) ? '—' : Number(n).toFixed(2);
  // Every barcode of the item (a code can have several, kept when the file is merged by code).
  const barcodesOf = p => [...new Set([...(p.barcodes || []), p.barcode].filter(Boolean).map(String))];
  const norm = v => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function shell() {
    panel.innerHTML = `
      <div class="op-bar">
        <input type="search" id="opSearch" placeholder="Search code, barcode, item, sell-out or supplier…" autocomplete="off" aria-label="Search the online promotion">
        <span class="muted-note" id="opCount"></span>
      </div>
      <div id="opBody"></div>`;
    el('opSearch').addEventListener('input', e => { S.q = e.target.value; render(); });
  }

  async function load() {
    const { data, error } = await sb.from('sellouts')
      .select('id, name, supplier, from, to, active, archived, online, items, priced_items, price_column')
      .eq('online', true).eq('archived', false).gte('to', todayStr());
    if (error) { console.error(error); showToast('Could not load the online promotion — ' + friendlyError(error), true); S.sellouts = []; return; }
    S.sellouts = (data || []).map(s => ({ id: s.id, name: s.name, supplier: s.supplier || '', from: s.from, to: s.to, active: !!s.active,
      items: s.items || [], pricedItems: Array.isArray(s.priced_items) ? s.priced_items : null, priceColumn: s.price_column }))
      .sort((a, b) => a.to.localeCompare(b.to) || a.name.localeCompare(b.name));
  }

  // Due date: the sell-out's last day (To is included).
  function dueHtml(so) {
    const today = todayStr();
    const d = Math.round((new Date(so.to + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    const left = d === 0 ? 'last day today' : d === 1 ? 'ends tomorrow' : `${d} days left`;
    const starts = so.from > today ? `<small>starts ${esc(fmtDate(so.from))}</small>` : '';
    return `<b>${esc(fmtDate(so.to))}</b><span class="op-left ${d <= 1 ? 'soon' : ''}">${left}</span>${starts}`;
  }

  function render() {
    const words = norm(S.q).split(/\s+/).filter(Boolean);
    let total = 0, shown = 0;
    const groups = S.sellouts.map(so => {
      const rows = pricedRowsOf(so).filter(p => p.code);
      total += rows.length;
      const head = norm(`${so.name} ${so.supplier}`);
      const hit = rows.filter(p => { const t = head + ' ' + norm(`${p.code} ${barcodesOf(p).join(' ')} ${p.description || ''}`); return words.every(w => t.includes(w)); });
      shown += hit.length;
      return { so, rows: hit };
    }).filter(g => g.rows.length);
    el('opCount').textContent = S.sellouts.length
      ? (words.length ? `${shown} of ${total} items` : `${total} item${total === 1 ? '' : 's'} · ${S.sellouts.length} online sell-out${S.sellouts.length === 1 ? '' : 's'}`)
      : '';
    if (!S.sellouts.length) {
      el('opBody').innerHTML = '<div class="empty-state"><p class="big">No online promotion right now</p><p>Items show here when a sell-out is marked “Online only”.</p></div>';
      return;
    }
    if (!groups.length) { el('opBody').innerHTML = '<div class="empty-state"><p class="big">Nothing matches</p><p>Try a code, a few letters of the item, or the supplier.</p></div>'; return; }
    el('opBody').innerHTML = groups.map(({ so, rows }) => `
      <div class="card op-group">
        <div class="op-head">
          <span class="online-ic" title="Online only" aria-hidden="true">${ONLINE_ICON}</span>
          <div class="op-who"><b>${esc(so.name)}</b>${so.supplier ? `<small>${esc(so.supplier)}</small>` : ''}</div>
          <div class="op-due"><span class="muted-note">Due date</span>${dueHtml(so)}</div>
        </div>
        <div class="items-scroll" style="margin-bottom:0;"><table class="items op-table">
          <thead><tr><th>Code</th><th class="op-bc">Barcode</th><th>Item</th><th class="num">Before</th><th class="num">Promo price</th><th class="op-due-col">Due date</th></tr></thead>
          <tbody>${rows.map(p => `<tr><td class="mono">${esc(p.code)}${barcodesOf(p).length ? `<small class="op-bc-inline">${barcodesOf(p).map(esc).join('<br>')}</small>` : ''}</td><td class="mono op-bc">${barcodesOf(p).map(esc).join('<br>') || '<span class="muted-note">—</span>'}</td><td>${esc(p.description || '')}</td>
            <td class="num op-before">${money(p.oldPrice)}</td><td class="num op-promo">${money(p.newPrice)}</td><td class="mono op-due-col">${esc(fmtDate(so.to))}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('');
  }

  async function show() {
    if (!canSee('onlinepromo')) return;
    if (!S.started) { S.started = true; shell(); }
    await load();
    render();
  }

  window.OnlinePromo = { show };
})();
