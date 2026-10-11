/* ============================================================
   Price check (owner, 2026-10-11): for the floor managers and the shelf workers.
   Scan a barcode with the camera (or type a barcode, a code or part of a name) and see at once what the system
   says: the price now, the normal price, if it is on promotion, the pack, the stock, the supplier.
   Then type what the SHELF TAG says: the page tells right or wrong (and by how much, and if the tag shows the
   normal price while the item is on promotion). The last checks of the session stay in a list.
   Live from the system (lv-dashboard items_lookup / item_search). Read only.
   Permission: floorcheck.do, floorcheck.manage, labels.scan or labels.print.
   Public API: window.PriceCheck = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { built: false, busy: false, item: null, tag: '', tagCur: '', recent: [], choices: null, msg: '', rate: 0 };

  const fmt = (v, cur) => {
    if (v === null || v === undefined || v === '') return '—';
    const x = Number(v); if (!Number.isFinite(x)) return '—';
    return cur === 'LBP' ? Math.round(x).toLocaleString('en-US') + ' LBP' : '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  // the other currency, at the shop's rate (cash settings): LBP to $ with cents, $ to LBP to the nearest 1,000
  const conv = (v, cur) => { const x = Number(v), r = S.rate; if (!Number.isFinite(x) || !r) return null; return cur === 'LBP' ? x / r : Math.round(x * r / 1000) * 1000; };
  const other = cur => cur === 'LBP' ? '$' : 'LBP';
  const dual = (v, cur) => v === null || v === undefined ? '—' : `${esc(fmt(v, cur))}${S.rate ? `<small class="pc-alt">${esc(fmt(conv(v, cur), other(cur)))}</small>` : ''}`;
  async function loadRate() { try { const { data } = await sb.rpc('get_usd_rate'); S.rate = Number(data) > 0 ? Number(data) : 89500; } catch (e) { S.rate = 89500; } }
  async function call(body) {
    const { data, error } = await sb.functions.invoke('lv-dashboard', { body });
    if (error || !data || data.error) throw new Error(data?.error || 'The system did not answer.');
    return data;
  }

  function build() {
    const box = el('panel-pricecheck'); if (!box || S.built) return;
    S.built = true;
    box.innerHTML = `
      <div class="card pc-bar">
        <div class="pc-inputrow">
          <input type="search" id="pcQ" inputmode="search" placeholder="Barcode, item code or name…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button type="button" class="btn" id="pcGo">Check</button>
          <button type="button" class="btn secondary" id="pcScan">Scan</button>
        </div>
        <p class="muted-note" style="margin:6px 0 0;">Scan the item, or type its barcode. Then enter the price on the shelf tag to compare.</p>
      </div>
      <div id="pcBody"></div>
      <div id="pcRecent"></div>`;
    el('pcGo').onclick = () => lookup(el('pcQ').value);
    el('pcQ').addEventListener('keydown', e => { if (e.key === 'Enter') lookup(el('pcQ').value); });
    el('pcScan').onclick = () => {
      let stop = null;
      stop = Scanner.open({ title: 'Scan an item to check its price', continuous: false, onCode: code => { setTimeout(() => stop && stop(), 0); el('pcQ').value = code; lookup(code); } });
    };
    box.addEventListener('click', e => {
      const t = e.target.closest('[data-pc]'); if (!t) return;
      if (t.dataset.pc === 'pick') lookup(t.dataset.code, true);
      if (t.dataset.pc === 'recent') { const it = S.recent.find(x => x.code === t.dataset.code); if (it) { S.item = it; S.tag = ''; S.choices = null; paint(); } }
      if (t.dataset.pc === 'clear') { S.recent = []; paint(); }
      if (t.dataset.pc === 'scan') el('pcScan').click();
      if (t.dataset.pc === 'cur') { S.tagCur = t.dataset.c; paint(); setTimeout(() => el('pcTag')?.focus(), 30); }
    });
    box.addEventListener('input', e => { if (e.target.id === 'pcTag') { S.tag = e.target.value; paintVerdict(); } });
  }

  async function lookup(raw, byCode) {
    const q = String(raw || '').trim(); if (!q || S.busy) return;
    S.busy = true; S.msg = ''; S.choices = null; paint('Checking…');
    try {
      let token = q;
      // a name: choose the item first
      if (!byCode && !/^[\d\s.-]{5,}$/.test(q) && !/^[A-Za-z]{0,3}\d{3,}$/.test(q)) {
        const r = await call({ action: 'item_search', search: q });
        const items = r.items || [];
        if (!items.length) { S.item = null; S.msg = `Nothing found for "${q}".`; }
        else if (items.length > 1) { S.choices = items.slice(0, 10); S.item = null; S.busy = false; return paint(); }
        else token = items[0].code;
      }
      if (!S.msg) {
        const r = await call({ action: 'items_lookup', tokens: [token] });
        const it = r.items && r.items[token];
        if (!it) { S.item = null; S.msg = `Not found in the system: ${token}`; }
        else { S.item = it; S.tag = ''; S.tagCur = ''; S.recent = [it, ...S.recent.filter(x => x.code !== it.code)].slice(0, 15); }
      }
    } catch (e) { S.item = null; S.msg = e.message; }
    S.busy = false;
    paint();
    if (S.item) setTimeout(() => el('pcTag')?.focus(), 50);
  }

  // what the tag shows is typed in the currency chosen next to it (LBP or $); it is brought to the item's currency
  // at the shop's rate before it is compared (a converted tag is allowed the rounding of the shelf: 500 LBP / 1 cent)
  const tagCur = () => S.tagCur || (S.item && S.item.currency) || '$';
  function verdictHtml() {
    const it = S.item; if (!it) return '';
    const cur = it.currency || '$', tc = tagCur();
    const tagTxt = String(S.tag || '').replace(/,/g, '').trim();
    if (tagTxt === '') return '<p class="muted-note" style="margin:6px 0 0;">Type the price on the tag to compare it with the system.</p>';
    const typed = Number(tagTxt);
    if (!Number.isFinite(typed)) return '<p class="pc-v warn">Type a number.</p>';
    let tag = typed;
    if (tc !== cur) {
      if (!S.rate) return '<p class="pc-v warn">The USD rate is not available: type the tag in the item\'s currency.</p>';
      tag = cur === 'LBP' ? typed * S.rate : typed / S.rate;
    }
    const tol = tc !== cur ? (cur === 'LBP' ? 1000 : 0.02) : (cur === 'LBP' ? 0.5 : 0.005);
    const eq = (a, b) => a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= tol;
    const now = it.price, normal = it.salePrice;
    const typedTxt = fmt(typed, tc);
    if (eq(now, tag)) return `<p class="pc-v ok">✓ The tag is right <span>${esc(typedTxt)} = ${esc(fmt(now, cur))}</span></p>`;
    if (it.promoted && eq(normal, tag)) return `<p class="pc-v bad">✗ The tag shows the normal price ${esc(typedTxt)}, but the item is on promotion at <b>${esc(fmt(now, cur))}</b>${S.rate ? ' <span>(' + esc(fmt(conv(now, cur), other(cur))) + ')</span>' : ''}.</p>`;
    if (now === null || now === undefined) return '<p class="pc-v warn">The system has no price for this item.</p>';
    const d = tag - Number(now);
    return `<p class="pc-v bad">✗ Wrong tag: it says ${esc(typedTxt)}, the system says <b>${esc(fmt(now, cur))}</b>${S.rate ? ' <span>(' + esc(fmt(conv(now, cur), other(cur))) + ')</span>' : ''} <span>— the tag is ${esc(fmt(Math.abs(d), cur))} ${d > 0 ? 'higher' : 'lower'}</span></p>`;
  }
  function paintVerdict() { const v = el('pcVerdict'); if (v) v.innerHTML = verdictHtml(); }

  function paint(loading) {
    build();
    const body = el('pcBody'); if (!body) return;
    const it = S.item, cur = it?.currency || '$';
    if (loading) body.innerHTML = `<div class="card"><p class="muted-note vs-loading" style="margin:0;">${esc(loading)}</p></div>`;
    else if (S.choices) body.innerHTML = `<div class="card"><h4 style="margin:0 0 8px;">Which one?</h4><div class="pc-choices">${S.choices.map(c => `<button type="button" class="pc-choice" data-pc="pick" data-code="${esc(c.code)}"><b>${esc(c.description || c.code)}</b><span class="muted-note">${esc(c.size || '')} · ${esc(c.code)}${c.barcodes && c.barcodes[0] ? ' · ' + esc(c.barcodes[0]) : ''} · stock <b>${c.stock === null || c.stock === undefined ? '—' : esc(Math.round(Number(c.stock) * 10) / 10)}</b></span></button>`).join('')}</div></div>`;
    else if (S.msg) body.innerHTML = `<div class="card"><p class="vs-warn" style="margin:0;">${esc(S.msg)}</p></div>`;
    else if (it) body.innerHTML = `
      <div class="card pc-item">
        <div class="pc-name"><h3>${esc(it.description || it.code)}</h3>
          <span class="muted-note">${[it.brand, it.group].filter(Boolean).map(esc).join(' · ')}</span></div>
        <div class="pc-prices">
          <div class="pc-stock ${it.stock === null || it.stock === undefined ? '' : Number(it.stock) <= 0 ? 'out' : Number(it.stock) < 6 ? 'low' : ''}"><span>In stock</span><b>${it.stock === null || it.stock === undefined ? '—' : esc(Math.round(Number(it.stock) * 10) / 10)}</b><small>${it.stock !== null && it.stock !== undefined && Number(it.stock) <= 0 ? 'out of stock' : it.stock !== null && it.stock !== undefined && Number(it.stock) < 6 ? 'low' : ''}</small></div>
          <div class="pc-now ${it.promoted ? 'promo' : ''}"><span>Price now ${it.promoted ? '<em>PROMOTION</em>' : ''}</span><b>${dual(it.price, cur)}</b></div>
          <div class="pc-normal"><span>Normal price</span><b>${dual(it.salePrice, cur)}</b></div>
        </div>
        <div class="pc-tag"><label for="pcTag">Price on the shelf tag</label>
          <div class="pc-tagrow"><input type="text" id="pcTag" inputmode="decimal" autocomplete="off" placeholder="e.g. ${tagCur() === 'LBP' ? '89000' : '2.50'}" value="${esc(S.tag)}">
            <div class="filter-row pc-cur" style="margin:0;"><button type="button" data-pc="cur" data-c="LBP" class="${tagCur() === 'LBP' ? 'active' : ''}">LBP</button><button type="button" data-pc="cur" data-c="$" class="${tagCur() === '$' ? 'active' : ''}">$ USD</button></div></div>${S.rate ? `<span class="muted-note">Rate: 1 $ = ${S.rate.toLocaleString('en-US')} LBP</span>` : ''}</div>
        <div id="pcVerdict">${verdictHtml()}</div>
        <div class="pc-next"><button type="button" class="btn" data-pc="scan">Scan next</button></div>
        <dl class="pc-facts">
          <div><dt>Code</dt><dd class="mono">${esc(it.code)}</dd></div>
          <div><dt>Barcode</dt><dd class="mono">${esc(it.barcode || '—')}</dd></div>
          <div><dt>Pack</dt><dd>${it.pack ? esc(it.pack) : '—'}</dd></div>
          <div><dt>Stock</dt><dd>${it.stock === null || it.stock === undefined ? '—' : esc(Math.round(Number(it.stock) * 10) / 10)}</dd></div>
          <div><dt>Supplier</dt><dd>${esc(it.supplier || '—')}</dd></div>
        </dl>
      </div>`;
    else body.innerHTML = '';
    const rec = el('pcRecent');
    if (rec) rec.innerHTML = S.recent.length ? `<div class="card"><div class="pc-rh"><h4 style="margin:0;">Checked in this session</h4><button type="button" class="link-btn" data-pc="clear">Clear</button></div>
      <ul class="pc-list">${S.recent.map(x => `<li><button type="button" data-pc="recent" data-code="${esc(x.code)}"><b>${esc(x.description || x.code)}</b><span>${esc(fmt(x.price, x.currency || '$'))}${x.promoted ? ' · promo' : ''}</span></button></li>`).join('')}</ul></div>` : '';
  }

  function show() { build(); loadRate().then(() => { if (S.item) paint(); }); paint(); setTimeout(() => el('pcQ')?.focus(), 50); }
  window.PriceCheck = { show };
})();
