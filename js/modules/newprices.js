/* ============================================================
   Floor check › New prices (owner, 2026-10-06; migration 067): the new sale
   prices sent from Pricing. Each is a "ghost price" (dashed) while the
   system does not have it yet; lv-dashboard checks the system's sale price
   (every 15 minutes in the day, and "Check now") and marks it in the system
   (solid) when it equals the new price. The floor manager ticks the shelf
   label done. Mobile first: one card per item.
   Public API: window.NewPrices = { render(box), load() }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const S = { rows: [], loaded: false, filter: 'todo', q: '', busy: false };
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const price = (v, cur) => v === null || v === undefined ? '—' : (n(v) >= 1000 || /lbp|l\.?l/i.test(String(cur || '')))
    ? Math.round(n(v)).toLocaleString('en-US') : (Math.round(n(v) * 1000) / 1000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const canTick = () => can('floorcheck.do', 'floorcheck.manage', 'vendors.manage');
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_SYNC = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>';

  async function load() {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data, error } = await sb.from('price_changes').select('*').neq('status', 'cancelled')
      .or(`status.eq.pending,synced_at.gte.${since},floor_done_at.is.null`).order('submitted_at', { ascending: false }).limit(500);
    if (error) { console.warn('new prices', error); showToast('Could not load the new prices.', true); return; }
    S.rows = data || []; S.loaded = true;
  }
  const counts = () => ({ todo: S.rows.filter(r => !r.floor_done_at).length, ghost: S.rows.filter(r => r.status === 'pending').length,
    synced: S.rows.filter(r => r.status === 'synced').length, all: S.rows.length });
  const shown = () => {
    const q = S.q.trim().toLowerCase();
    return S.rows.filter(r => S.filter === 'todo' ? !r.floor_done_at : S.filter === 'ghost' ? r.status === 'pending' : S.filter === 'synced' ? r.status === 'synced' : true)
      .filter(r => !q || [r.description, r.code, r.barcode, r.supplier, r.doc].some(v => String(v || '').toLowerCase().includes(q)));
  };

  async function render(box) {
    if (!S.loaded) { box.innerHTML = '<div class="card"><p class="muted-note" style="margin:0;">Loading the new prices…</p></div>'; await load(); }
    const c = counts(), L = shown();
    box.innerHTML = `
      <div class="card np-head">
        <div class="filter-row" id="npFilter" style="margin:0;">
          ${[['todo', 'Label to do', c.todo], ['ghost', 'Waiting for the system', c.ghost], ['synced', 'In the system', c.synced], ['all', 'All', c.all]]
            .map(([k, l, k2]) => `<button type="button" data-f="${k}" class="${S.filter === k ? 'active' : ''}">${l} <span class="np-count">${k2}</span></button>`).join('')}
        </div>
        <span style="flex:1"></span>
        <input type="search" id="npQ" placeholder="Find an item, a barcode, a supplier" value="${esc(S.q)}" aria-label="Find">
        <button type="button" class="icon-btn" id="npSync" title="Check the system's prices now" aria-label="Check the system's prices now">${ICON_SYNC}</button>
      </div>
      <p class="muted-note np-note">A <b>ghost price</b> (dashed) is sent from Pricing but not in the system yet: the till still sells at the old price. It turns solid when the system has it (checked every 15 minutes in the day). Tick <b>Label done</b> once the shelf shows the new price.</p>
      <div class="np-list">${L.map(card).join('') || `<div class="card"><p class="empty-note" style="margin:0;">${S.filter === 'todo' ? 'No label to change.' : 'Nothing here.'}</p></div>`}</div>`;
    box.querySelector('#npFilter').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; render(box); } };
    const q = box.querySelector('#npQ'); q.oninput = () => { S.q = q.value; const pos = q.selectionStart; render(box).then(() => { const x = box.querySelector('#npQ'); x.focus(); x.setSelectionRange(pos, pos); }); };
    box.querySelector('#npSync').onclick = async e => {
      const b = e.currentTarget; b.disabled = true; b.classList.add('ls-spin');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'price_changes_sync' } });
        if (error || data?.error) throw new Error(data?.error || 'no answer');
        showToast(data.pending ? `${data.checked} checked: ${data.synced} now in the system.` : 'Nothing is waiting for the system.');
      } catch (err) { showToast('The system did not answer.', true); }
      await load(); render(box);
    };
    box.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => {
      const r = S.rows.find(x => x.id === b.dataset.done); if (!r) return;
      b.disabled = true;
      const { data, error } = await sb.from('price_changes').update({ floor_done_at: r.floor_done_at ? null : new Date().toISOString() }).eq('id', r.id).select().single();
      if (error) { showToast('Could not save.', true); b.disabled = false; return; }
      Object.assign(r, data); render(box);
    });
    box.querySelectorAll('[data-code]').forEach(x => x.ondblclick = () => window.ItemDetail && ItemDetail.open(x.dataset.code));
  }

  function card(r) {
    const ghost = r.status === 'pending', up = n(r.new_price) > n(r.old_price);
    const pct = r.old_price ? Math.round((n(r.new_price) - n(r.old_price)) / n(r.old_price) * 1000) / 10 : null;
    const sysDiff = ghost && r.system_price !== null && r.system_price !== undefined && Math.abs(n(r.system_price) - n(r.old_price)) > 0.005;
    return `<div class="card np-card ${ghost ? 'np-ghost' : 'np-synced'}${r.floor_done_at ? ' np-done' : ''}" data-code="${esc(r.code)}">
      <div class="np-item">
        <b>${r.vat ? '<span class="pr-vat">VAT</span> ' : ''}${esc(r.description || r.code)}</b>
        <span class="np-sub mono">${esc(r.code)}${r.barcode ? ' · ' + esc(r.barcode) : ''}</span>
        <span class="np-sub">${esc(r.supplier || '')}${r.doc ? ' · ' + esc(r.doc) : ''}${r.day ? ' · ' + esc(dmy(r.day)) : ''}</span>
      </div>
      <div class="np-prices">
        <span class="np-old">${price(r.old_price, r.currency)}</span>
        <span class="np-arrow" aria-hidden="true">→</span>
        <span class="np-new">${price(r.new_price, r.currency)}</span>
        <span class="np-cur">${esc(r.currency || '$')}</span>
        ${pct !== null ? `<span class="np-pct ${up ? 'up' : 'down'}">${up ? '+' : ''}${pct}%</span>` : ''}
      </div>
      <div class="np-state">
        ${ghost ? `<span class="np-chip ghost">Waiting for the system</span>${sysDiff ? `<span class="np-sub">system now ${price(r.system_price, r.currency)}</span>` : ''}`
          : `<span class="np-chip synced">${ICON_CHECK}In the system ${esc(when(r.synced_at))}</span>`}
        <span class="np-sub">sent by ${esc(r.submitted_by_name || '—')} ${esc(when(r.submitted_at))}</span>
        ${canTick() ? `<button type="button" class="btn small ${r.floor_done_at ? 'secondary' : ''} np-done-btn" data-done="${esc(r.id)}">${ICON_CHECK}${r.floor_done_at ? `Label done${r.floor_done_by_name ? ' · ' + esc(r.floor_done_by_name) : ''}` : 'Label done'}</button>` : ''}
      </div>
    </div>`;
  }
  window.NewPrices = { render, load };
})();
