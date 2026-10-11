/* ============================================================
   Floor check › Today (owner, 2026-10-11): the simple page for the floor managers. No walk, no scanning, no
   statuses: a reference of what changed on the shelves, and one small button per item.
     New today   : promotions and sell-outs that started (and are switched on): the new price, the old one
     Ended       : promotions and sell-outs that ended or were switched off: back to the normal price
     Prices      : prices that changed in the system (the nightly price watch)
   Each item has "Needs label": the floor manager taps it where the shelf needs a new promo paper (a promotion
   starting) or a new label (a price back to normal or changed). "Send to the accountant" then makes one list per
   type in the accountant's Shelf labels > To print, named "Name (floor check DD/MM)" (RPC floor_send_promo_papers,
   migration 080). What was marked or sent is kept on this phone for the day.
   Data: js/modules/floorcheck.js (todaysSources / itemsFor, the same rules as the full check).
   Public API: window.FloorRef = { load, render }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const S = { data: null, q: '', loading: false, busy: false, marked: {}, sent: {}, err: '' };
  const SECTIONS = [
    { reason: 'starts', title: 'New today', note: 'Started: put the promo paper and check the price.', kind: 'promo', mark: 'Needs promo paper' },
    { reason: 'ends', title: 'Ended — back to the normal price', note: 'Ended or switched off: the shelf goes back to the normal price.', kind: 'label', mark: 'Needs label' },
    { reason: 'price_changed', title: 'Price changed in the system', note: 'The system price changed: check the tag.', kind: 'label', mark: 'Needs label' },
  ];
  const day = () => todayStr();
  const key = () => `lv:floorref:${Session.user && Session.user.id}:${day()}`;
  function loadLocal() {
    try { const d = JSON.parse(localStorage.getItem(key())) || {}; S.marked = d.marked || {}; S.sent = d.sent || {}; }
    catch (e) { S.marked = {}; S.sent = {}; }
  }
  function saveLocal() { try { localStorage.setItem(key(), JSON.stringify({ marked: S.marked, sent: S.sent })); } catch (e) { /* storage blocked */ } }
  const num = v => v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  // the label of an item: its first barcode, else its code (what the shelf-label list is made of)
  const labelCode = it => (String(it.barcode || '').split(',')[0] || String(it.code || '')).trim();

  async function load() {
    loadLocal();
    S.loading = true; S.err = '';
    try {
      const since = new Date(Date.now() - 2 * 864e5).toLocaleDateString('en-CA');   // the last two days: nothing is missed
      S.data = await FloorCheck.refItems('changes', since);
    } catch (e) { console.error(e); S.err = e.message || String(e); S.data = null; }
    S.loading = false;
  }

  function itemsOf(reason) {
    const q = S.q.trim().toLowerCase();
    const list = (S.data?.items || []).filter(i => i.reason === reason);
    // one line per code (the same item can come from a sell-out and a promotion)
    const seen = new Set();
    return list.filter(i => { const k = String(i.code || i.item_key); if (seen.has(k)) return false; seen.add(k); return true; })
      .filter(i => !q || String(i.description || '').toLowerCase().includes(q) || String(i.code || '').toLowerCase().includes(q) || String(i.source_name || '').toLowerCase().includes(q));
  }

  function rowHtml(i, sec) {
    const k = i.item_key, sent = !!S.sent[k], marked = !!S.marked[k];
    const up = i.expected_price !== null && i.old_price !== null && Number(i.expected_price) > Number(i.old_price);
    return `<div class="fr-row ${marked ? 'marked' : ''} ${sent ? 'sent' : ''}">
      <div class="fr-main"><b>${esc(i.description || i.code)}</b>
        <span class="muted-note">${esc(i.source_name || '')}${i.category ? ' · ' + esc(i.category) : ''} · ${esc(i.code || '')}</span></div>
      <div class="fr-price"><b class="${sec.reason === 'starts' ? 'fr-new' : ''}">${esc(num(i.expected_price))}</b>
        ${i.old_price !== null && i.old_price !== undefined ? `<span class="muted-note">was ${esc(num(i.old_price))}${up ? ' ↑' : ''}</span>` : ''}</div>
      ${sent ? '<span class="badge active fr-btn">Sent ✓</span>'
        : `<button type="button" class="fr-btn fr-mark ${marked ? 'on' : ''}" data-fr-mark="${esc(k)}" aria-pressed="${marked}">${marked ? '✓ ' + esc(sec.mark) : esc(sec.mark)}</button>`}
    </div>`;
  }

  function render(box) {
    box = box || document.getElementById('fcBody'); if (!box) return;
    if (!S.data && !S.err) { box.innerHTML = '<div class="card"><p class="muted-note vs-loading" style="margin:0;">Loading what changed…</p></div>'; return; }
    if (S.err) { box.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const secs = SECTIONS.map(sec => ({ sec, list: itemsOf(sec.reason) }));
    const total = secs.reduce((n, x) => n + x.list.length, 0);
    const pending = secs.flatMap(x => x.list.filter(i => S.marked[i.item_key] && !S.sent[i.item_key]).map(i => ({ i, sec: x.sec })));
    const nPromo = pending.filter(p => p.sec.kind === 'promo').length, nLabel = pending.length - nPromo;
    box.innerHTML = `
      <div class="card fr-head">
        <div><h3 style="margin:0;">What changed on the shelves</h3>
          <span class="muted-note">${esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))} · the last 2 days</span></div>
        <div class="fr-counts">${secs.map(x => `<span><b>${x.list.length}</b> ${esc({ starts: 'new', ends: 'ended', price_changed: 'prices' }[x.sec.reason])}</span>`).join('')}</div>
      </div>
      <input type="search" id="frQ" class="fr-find" placeholder="Find an item, a promotion or a code…" value="${esc(S.q)}" autocomplete="off">
      ${total ? secs.filter(x => x.list.length).map(({ sec, list }) => `
        <section class="card fr-sec"><h4>${esc(sec.title)} <span class="vc-count">${list.length}</span></h4>
          <p class="muted-note" style="margin:0 0 6px;">${esc(sec.note)}</p>
          ${list.map(i => rowHtml(i, sec)).join('')}</section>`).join('')
        : `<div class="card"><p class="muted-note" style="margin:0;">${S.q ? 'Nothing matches your search.' : 'Nothing changed in the last 2 days: no promotion started or ended, no price changed.'}</p></div>`}
      <div class="fr-stick ${pending.length ? 'show' : ''}">
        <button type="button" class="btn fr-send" id="frSend" ${S.busy ? 'disabled' : ''}>Send to the accountant · ${nPromo ? nPromo + ' promo paper' + (nPromo === 1 ? '' : 's') : ''}${nPromo && nLabel ? ' + ' : ''}${nLabel ? nLabel + ' label' + (nLabel === 1 ? '' : 's') : ''}</button>
      </div>`;
    box.querySelector('#frQ').oninput = e => { S.q = e.target.value; const pos = e.target.selectionStart; render(box); const q = box.querySelector('#frQ'); q.focus(); q.setSelectionRange(pos, pos); };
    box.querySelectorAll('[data-fr-mark]').forEach(b => b.onclick = () => {
      const k = b.dataset.frMark;
      if (S.marked[k]) delete S.marked[k]; else S.marked[k] = 1;
      saveLocal(); render(box);
    });
    box.querySelector('#frSend')?.addEventListener('click', () => send(box, pending));
  }

  async function send(box, pending) {
    if (!pending.length || S.busy) return;
    S.busy = true; render(box);
    try {
      let made = 0;
      for (const kind of ['promo', 'label']) {
        const part = pending.filter(p => p.sec.kind === kind);
        if (!part.length) continue;
        const items = [...new Map(part.map(p => [labelCode(p.i), { code: labelCode(p.i) }])).values()].filter(x => x.code);
        const { data, error } = await sb.rpc('floor_send_promo_papers', { p_items: items, p_kind: kind });
        if (error) throw error;
        if (Number(data) > 0) made += Number(data);
        part.forEach(p => { S.sent[p.i.item_key] = 1; delete S.marked[p.i.item_key]; });
      }
      saveLocal();
      showToast(made ? `Sent to the accountant: ${made} item${made === 1 ? '' : 's'}.` : 'Nothing valid to send.');
      if (made && typeof logActivity === 'function') logActivity('floorcheck', 'send_labels', null, `Sent ${made} item${made === 1 ? '' : 's'} to the accountant for printing (floor check)`);
    } catch (e) {
      console.error(e);
      showToast('Not sent — ' + (typeof friendlyError === 'function' ? friendlyError(e) : (e.message || e)), true);
    }
    S.busy = false; render(box);
  }

  window.FloorRef = { load, render };
})();
