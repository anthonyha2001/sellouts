/* ============================================================
   Item suggestions under a code box (owner, 2026-11-10): typing a code, a barcode or part of a name
   (2 characters at least) lists the matching items from the system (lv-dashboard item_search) right
   under the box. Up / Down to move, Enter or a click to take one, Escape to close. Enter with nothing
   highlighted keeps the box's own behaviour (what was typed is used as the code).
   Public API: window.ItemSuggest = { attach(input, onPick) }   onPick({ code, description, barcodes, stock })
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const fq = v => (Math.round(Number(v || 0) * 100) / 100).toLocaleString('en-US');
  const cache = new Map();   // query (lower case) -> items, so typing back and forth asks once
  let box = null, owner = null;

  function close() { if (box) box.remove(); box = null; owner = null; }
  function place(input) {
    if (!box) return;
    const r = input.getBoundingClientRect(), w = Math.max(r.width, 380);
    box.style.top = (r.bottom + 2) + 'px';
    box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    box.style.width = w + 'px';
  }
  window.addEventListener('scroll', () => owner && place(owner.input), true);
  window.addEventListener('resize', () => owner && place(owner.input));

  function attach(input, onPick) {
    if (!input || input.dataset.suggest) return;
    input.dataset.suggest = '1';
    input.setAttribute('autocomplete', 'off');
    const S = { input, items: [], active: -1, timer: null, seq: 0 };

    const paint = (html) => {
      if (!box || owner !== S) {
        close();
        box = document.createElement('div');
        box.className = 'isg-box';
        box.addEventListener('mousedown', e => e.preventDefault());   // keep the focus in the box
        box.addEventListener('click', e => {
          const b = e.target.closest('[data-isg]'); if (!b || !owner) return;
          const o = owner; pick(o, Number(b.dataset.isg));
        });
        document.body.appendChild(box);
        owner = S;
      }
      box.innerHTML = html;
      place(input);
    };
    const paintItems = () => {
      if (!S.items.length) return paint('<div class="isg-note">Nothing found in the system.</div>');
      paint(S.items.map((i, k) => `<button type="button" class="isg-opt ${k === S.active ? 'on' : ''}" data-isg="${k}">
        <span class="isg-desc">${esc(String(i.description || '').trim() || i.code)}${i.size ? ` <span class="muted-note">${esc(i.size)}</span>` : ''}</span>
        <span class="isg-meta">${esc(i.code)}${(i.barcodes || [])[0] ? ' · ' + esc(i.barcodes[0]) : ''}${i.stock !== null && i.stock !== undefined ? ' · stock ' + fq(i.stock) : ''}</span></button>`).join(''));
      box.querySelector('.isg-opt.on')?.scrollIntoView({ block: 'nearest' });
    };
    const search = async () => {
      const q = input.value.trim(), my = ++S.seq;
      S.active = -1;
      if (q.length < 2) { S.items = []; if (owner === S) close(); return; }
      const k = q.toLowerCase();
      if (cache.has(k)) { S.items = cache.get(k); paintItems(); return; }
      paint('<div class="isg-note">Searching the system…</div>');
      try {
        const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'item_search', search: q } });
        if (error) throw error;
        const items = (data?.items || []).slice(0, 30);
        cache.set(k, items);
        if (my !== S.seq || document.activeElement !== input) return;
        S.items = items; paintItems();
      } catch (e) { if (my === S.seq && document.activeElement === input) paint('<div class="isg-note isg-err">The system did not answer.</div>'); }
    };
    function pick(st, k) {
      const it = st.items[k]; if (!it) return;
      st.seq++; close();
      st.input.value = it.code;
      onPick(it);
    }

    input.addEventListener('input', () => { clearTimeout(S.timer); S.timer = setTimeout(search, 180); });
    input.addEventListener('keydown', e => {
      const open = owner === S && S.items.length;
      if (e.key === 'ArrowDown' && open) { e.preventDefault(); S.active = Math.min(S.items.length - 1, S.active + 1); paintItems(); }
      else if (e.key === 'ArrowUp' && open) { e.preventDefault(); S.active = Math.max(-1, S.active - 1); paintItems(); }
      else if (e.key === 'Enter' && open && S.active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(S, S.active); }
      else if (e.key === 'Escape' && owner === S) { e.preventDefault(); e.stopPropagation(); S.seq++; close(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { clearTimeout(S.timer); S.seq++; if (owner === S) close(); }
    }, true);   // before the box's own Enter handler
    input.addEventListener('blur', () => { clearTimeout(S.timer); S.seq++; if (owner === S) close(); });
  }

  window.ItemSuggest = { attach };
})();
