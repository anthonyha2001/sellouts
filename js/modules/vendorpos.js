/* ============================================================
   Vendors › POs (owner, 2026-10-11): the purchase orders entered in the system on a day, live (lv-dashboard
   pos_of_day). Today by default; ‹ › and a date to go back. One folding group per PO: the supplier (the app's
   vendor when it is linked), the PO number, its lines and units, delivered or not (system_pos, migration 082, when
   synced). Opening a PO reads its lines (po_detail): ordered, price, delivered by its supplier since the PO's day,
   the stock now. Uses Stock control's frame (window.SCUI). Permission: vendors.manage.
   Public API: window.VendorPos = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { day: null, data: null, loading: false, err: '', detail: {}, delivered: {} };
  const U = () => window.SCUI;
  const fq = v => (Math.round(Number(v) * 10) / 10).toLocaleString('en-US');
  const dm = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const nice = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const sk = c => String(c || '').trim().replace(/^0+(?=\d)/, '');
  const vendorOf = code => vendorsList.find(v => (v.systemSuppliers || []).some(s => sk(s.code) === sk(code)));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const errOf = async (data, error) => {
    let msg = data?.error || '';
    if (error && !msg) { try { msg = (await error.context.json()).error || ''; } catch (x) { msg = error.message || ''; } }
    return /Unknown action/i.test(msg) ? 'Deploy the latest lv-dashboard to see the POs.' : msg;
  };

  async function load() {
    const day = S.day;
    S.loading = true; S.err = ''; paint();
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'pos_of_day', day } });
      const msg = await errOf(data, error);
      if (msg || error || !data) throw new Error(msg || 'The system did not answer.');
      if (S.day !== day) return;
      S.data = data;
      // delivered or not: the synced POs (migration 082), when there
      const codes = (data.pos || []).map(p => p.po);
      if (codes.length) {
        const { data: sp, error: e2 } = await sb.from('system_pos').select('po, delivered_on').in('po', codes);
        S.delivered = {}; if (!e2) (sp || []).forEach(p => { S.delivered[p.po] = p.delivered_on || ''; });
      }
    } catch (e) { if (S.day === day) { S.err = e.message || 'The system did not answer.'; S.data = null; } }
    if (S.day !== day) return;
    S.loading = false; paint();
  }
  async function loadDetail(p, body) {
    if (S.detail[p.po] && !S.detail[p.po].error) { body.innerHTML = detailHtml(S.detail[p.po]); return; }
    body.innerHTML = '<div class="sc-empty">Reading the lines…</div>';
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'po_detail', po: p.po, year: p.year, po_date: p.po_date, supplier_code: p.supplier_code } });
      const msg = await errOf(data, error);
      if (msg || error || !data) throw new Error(msg || 'The system did not answer.');
      S.detail[p.po] = data;
    } catch (e) { S.detail[p.po] = { error: e.message || 'The system did not answer.' }; }
    body.innerHTML = detailHtml(S.detail[p.po]);
  }
  function detailHtml(d) {
    if (d.error) return `<div class="sc-empty">${esc(d.error)}</div>`;
    const ls = d.lines || [], got = ls.filter(l => l.received > 0), delivered = got.length > 0;
    const status = !d.receivedRead ? 'Delivery could not be read.'
      : !delivered ? 'Nothing delivered by this supplier yet.'
      : `Delivered ${esc(dm(got.map(l => l.received_on).sort()[0]))}: ${got.length} of ${ls.length} item${ls.length === 1 ? '' : 's'}${ls.length - got.length ? ` · <b class="ls-urgent">${ls.length - got.length} not delivered</b>` : ''}.`;
    return `<p class="muted-note sc-gnote">${status}${d.total ? ` Total ${esc(d.currency || '$')}${(Math.round(d.total * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}.` : ''}</p>`
      + U().table('<th>Item</th><th class="num">Ordered</th><th class="num">Price</th><th>Delivered</th><th class="num">Stock now</th>',
        ls.map(l => {
          const miss = delivered && !(l.received > 0), short = l.received > 0 && l.received < l.qty, out = l.stock !== null && l.stock <= 0;
          return `<tr data-ls-code="${esc(l.code)}" class="${miss && out ? 'ls-nopo' : ''}">${U().item(l.code, l.description)}<td class="num"><b>${fq(l.qty)}</b></td>
            <td class="num">${l.unit_price === null ? '—' : (Math.round(l.unit_price * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            <td>${l.received > 0 ? `<b>${fq(l.received)}</b> <span class="muted-note">${esc(dm(l.received_on))}</span>${short ? ' <span class="ls-po draft">short</span>' : ''}` : miss ? '<span class="ls-po late">not delivered</span>' : '<span class="muted-note">—</span>'}</td>
            <td class="num">${l.stock === null ? '<span class="muted-note">—</span>' : out ? `<span class="rc-zero">${fq(l.stock)}</span>` : fq(l.stock)}</td></tr>`;
        }).join('') || '<tr><td colspan="5" class="empty-note">No line on this PO.</td></tr>');
  }

  function paint() {
    const box = el('vendorPosView'); if (!box || !U()) return;
    const t = todayStr(), day = S.day, pos = S.data?.pos || [];
    const tools = `<button type="button" class="sc-ico" data-vp="prev" title="The day before" aria-label="The day before">‹</button>
      <input type="date" class="vp-day" value="${esc(day)}" max="${esc(t)}" aria-label="Day">
      <button type="button" class="sc-ico" data-vp="next" title="The day after" aria-label="The day after" ${day >= t ? 'disabled' : ''}>›</button>
      ${day !== t ? '<button type="button" class="btn ghost small" data-vp="today">Today</button>' : ''}`;
    const units = pos.reduce((s, p) => s + Number(p.requested || 0), 0), sups = new Set(pos.map(p => sk(p.supplier_code))).size;
    // one row per PO; a double-click opens it (owner: "I don't want accordions, open them on double click")
    const body = S.err ? U().empty(esc(S.err))
      : S.loading && !S.data ? U().loading()
      : !pos.length ? U().empty(`No PO entered on ${esc(nice(day))}.`)
      : `<div class="sc-tbl sc-flat"><table class="items sc-table vp-table"><thead><tr><th>PO</th><th>Supplier</th><th class="num">Lines</th><th class="num">Units</th><th>Status</th><th></th></tr></thead><tbody>${pos.map(p => {
          const v = vendorOf(p.supplier_code), dl = S.delivered[p.po];
          return `<tr data-vp-row="${esc(p.po)}" title="Double-click to open ${esc(p.po)}"><td class="mono"><b>${esc(p.po)}</b></td>
            <td>${esc(v ? v.name : p.supplier_name || 'Unknown supplier')}${v ? '' : ' <span class="sc-meta" title="Link this supplier to a vendor (Edit vendor › supplier in the system)">not linked</span>'}</td>
            <td class="num">${p.lines}</td><td class="num">${fq(p.requested)}</td>
            <td>${dl === undefined ? '<span class="muted-note">—</span>' : dl ? `<span class="ls-po ok">delivered ${esc(dm(dl))}</span>` : '<span class="ls-po draft">not delivered yet</span>'}</td>
            <td class="num">${v ? `<button type="button" class="btn ghost small" data-vp-vendor="${esc(v.id)}">Vendor</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div><p class="sc-quiet">Double-click a PO to open it.</p>`;
    box.innerHTML = U().view({
      title: 'POs',
      sub: `${esc(nice(day))}${day === t ? ' (today)' : ''}${S.loading ? ' · reading…' : pos.length ? ` · <b>${plural(pos.length, 'PO')}</b> · ${fq(units)} units · ${plural(sups, 'supplier')}` : ''}`,
      info: 'The purchase orders entered in the system on that day, read live. Open a PO for its lines: ordered, price, what its supplier delivered since (its PUs) and the stock now. "Not delivered yet" / "delivered" comes from the POs of the week read every 30 minutes (Stock control). Double-click an item for its details.',
      tools, body,
    });
    U().wire(box);
    box.querySelector('[data-vp="prev"]')?.addEventListener('click', () => go(addDaysStr(S.day, -1)));
    box.querySelector('[data-vp="next"]')?.addEventListener('click', () => go(addDaysStr(S.day, 1)));
    box.querySelector('[data-vp="today"]')?.addEventListener('click', () => go(todayStr()));
    box.querySelector('.vp-day')?.addEventListener('change', e => { if (e.target.value) go(e.target.value > t ? t : e.target.value); });
    box.querySelectorAll('[data-vp-vendor]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); openVendorDetail(b.dataset.vpVendor); }));
    box.querySelectorAll('tr[data-vp-row]').forEach(tr => tr.addEventListener('dblclick', () => { const p = pos.find(x => x.po === tr.dataset.vpRow); if (p) openPo(p); }));
  }

  /* ---------------- one PO, in its own window (double-click a row) ---------------- */
  function sheet() {
    let o = el('vpSheet');
    if (o) return o;
    o = document.createElement('div');
    o.id = 'vpSheet'; o.className = 'vp-overlay';
    o.innerHTML = '<div class="vp-dialog" role="dialog" aria-modal="true" aria-label="Purchase order"><header class="vp-head" id="vpHead"></header><div class="vp-body" id="vpBody"></div></div>';
    document.body.appendChild(o);
    o.addEventListener('mousedown', e => { if (e.target === o) closePo(); });
    o.addEventListener('click', e => { if (e.target.closest('[data-vp-close]')) closePo(); const vb = e.target.closest('[data-vp-vendor]'); if (vb) { closePo(); openVendorDetail(vb.dataset.vpVendor); } });
    o.addEventListener('dblclick', e => { const tr = e.target.closest('tr[data-ls-code]'); if (tr && window.ItemDetail) ItemDetail.open(tr.dataset.lsCode); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && o.classList.contains('open')) closePo(); });
    return o;
  }
  function closePo() { el('vpSheet')?.classList.remove('open'); }
  async function openPo(p) {
    const o = sheet(), v = vendorOf(p.supplier_code), dl = S.delivered[p.po];
    el('vpHead').innerHTML = `<div class="vp-title"><h3>${esc(p.po)} <span class="muted-note">· ${esc(nice(p.po_date))}</span></h3>
        <p>${esc(v ? v.name : p.supplier_name || 'Unknown supplier')} · ${plural(p.lines, 'line')} · ${fq(p.requested)} units${dl === undefined ? '' : dl ? ` · <span class="ls-po ok">delivered ${esc(dm(dl))}</span>` : ' · <span class="ls-po draft">not delivered yet</span>'}</p></div>
      <div class="vp-hact">${v ? `<button type="button" class="btn ghost small" data-vp-vendor="${esc(v.id)}">Vendor sheet</button>` : ''}
        <button type="button" class="sc-ico" data-vp-close aria-label="Close" title="Close (Esc)">×</button></div>`;
    o.classList.add('open');
    await loadDetail(p, el('vpBody'));
  }
  function go(day) { S.day = day; S.data = null; S.delivered = {}; load(); }

  function show() {
    if (!S.day) S.day = todayStr();
    if (S.data && !S.loading) paint(); else load();
  }

  window.VendorPos = { show };
})();
