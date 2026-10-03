/* ============================================================
   Drag and drop to reorder rows (owner, 2026-10-04) — the same
   handle and behaviour everywhere: Staff schedule, Cash cashiers,
   Staff page. Hold the handle (⋮⋮), move, drop: the row takes that
   place. With groups, a row only moves among its own group.
     RowDrag.handle()            -> the handle's HTML (data-drag)
     RowDrag.attach(container, {
       rows:   'tr[data-id]',    // the movable rows
       id:     row => row.dataset.id,
       group:  row => '',        // optional: rows only move within their group
       onDrop: (ids, movedId) => {}   // the group's ids in the new order (only when it changed)
     })
   ============================================================ */
const RowDrag = (function () {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
  const handle = (label = 'Drag to move') => `<span class="row-drag" data-drag title="${label}" aria-label="${label}">${ICON}</span>`;

  function attach(container, opts) {
    const o = Object.assign({ rows: 'tr[data-id]', id: r => r.dataset.id, group: () => '', onDrop: () => {} }, opts || {});
    container.addEventListener('pointerdown', e => {
      const h = e.target.closest('[data-drag]'); if (!h || e.button !== 0 || !container.contains(h)) return;
      const row = h.closest(o.rows); if (!row) return;
      e.preventDefault(); e.stopPropagation();
      const grp = o.group(row);
      const groupRows = () => [...container.querySelectorAll(o.rows)].filter(r => o.group(r) === grp);
      const before = groupRows().map(o.id);
      row.classList.add('row-dragging'); document.body.classList.add('row-drag-on');
      const move = ev => {
        const others = groupRows().filter(r => r !== row);
        if (!others.length) return;
        const over = others.find(r => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
        if (over) { if (over.previousElementSibling !== row) over.parentNode.insertBefore(row, over); }
        else { const last = others[others.length - 1]; if (last.nextElementSibling !== row) last.after(row); }
      };
      const up = () => {
        // On the window: the row moves in the page while dragging, so the handle would lose the pointer.
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        row.classList.remove('row-dragging'); document.body.classList.remove('row-drag-on');
        const after = groupRows().map(o.id);
        if (after.join('\u0001') !== before.join('\u0001')) o.onDrop(after, o.id(row), grp);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
  }
  return { handle, attach, ICON };
})();
