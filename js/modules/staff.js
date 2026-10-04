/* ============================================================
   Staff (owner, 2026-10-03): one list of every employee — name, job,
   and optionally phone, start date, salary and a note; active or left.
   Jobs: the store's own list (migration 041); shelf workers have their
   Sections. Cashiers and cashier supervisors are kept in step with the cashiers list
   (cash differences, schedule, cashier page) by the database
   (migration 040), so they are entered once, here or there.
   From a person, the admin creates their app login (admin-users
   function) with a username, a role that fits their job and a
   temporary password; the login is linked to them.
   Export: the list (as filtered) to Excel.
   Permission: staff.manage (salaries included). Public API: window.Staff.
   ============================================================ */
(function () {
  const panel = document.getElementById('panel-staff');
  const S = { started: false, list: [], users: new Map(), q: '', show: 'active', missing: false };
  const el = id => document.getElementById(id);
  const esc = escapeHtml;
  // The store's jobs (owner, 2026-10-03; migration 041). Cashier and Cashier supervisor are also in the cashiers list.
  const JOBS = ['Cashier', 'Cashier supervisor', 'Delivery supervisor', 'Picker', 'Deli counter', 'Meat counter', 'Fish counter', 'Fruits & vegetables',
    'Bakery', 'Warehouse keeper', 'Warehouse worker', 'Shelf worker', 'Floor manager', 'Cleaning', 'Parking', 'Purchasing', 'Senior accountant', 'Accountant',
    'Data entry', 'HR'];
  // The app role a job usually gets (the admin can change it when creating the login).
  const ROLE_OF = { 'senior accountant': 'accountant', accountant: 'accountant', 'delivery supervisor': 'delivery', 'floor manager': 'floor_manager', hr: 'hr' };
  const roleFor = job => ROLE_OF[String(job || '').trim().toLowerCase()] || 'shelf';
  const inCashList = job => ['cashier', 'cashier supervisor', 'supervisor', 'picker', 'delivery supervisor'].includes(String(job || '').trim().toLowerCase());
  // Front / Back at the tills: cashiers and cashier supervisors.
  const atTills = job => ['cashier', 'cashier supervisor', 'supervisor'].includes(String(job || '').trim().toLowerCase());
  // Break (migration 052): everyone but the cashiers and cashier supervisors.
  const breakFor = job => !atTills(job);
  const breakText = p => p.break_start ? `Break ${p.break_start} · ${p.break_minutes || 30} min` : '';
  const isShelf = job => String(job || '').trim().toLowerCase() === 'shelf worker';
  const salaryText = n => n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('en-US');

  async function callAdmin(action, payload) {
    const { data, error } = await sb.functions.invoke('admin-users', { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const body = await error.context.json(); if (body?.error) msg = body.error; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function randomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(10)), b => chars[b % chars.length]).join('');
  }
  // "Rami Khoury" -> "rami.khoury" (letters, digits and dots only).
  const usernameFor = name => String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32) || 'user';

  /* ---------------- data ---------------- */
  async function load() {
    const { data, error } = await sb.from('staff').select('*').order('active', { ascending: false }).order('sort_order').order('name');
    S.missing = !!error;
    if (error) { console.warn('Staff: not set up (migration 040?)', error.message); S.list = []; return; }
    S.list = data || [];
    // PIN and usual station live in the cashiers list (migration 045: readable with staff.manage).
    const { data: cs } = await sb.from('cashiers').select('id, has_pin, default_station, locked_until');
    S.cash = new Map((cs || []).map(c => [c.id, c]));
    if (isAdmin() && !S.users.size) {
      try { const { users } = await callAdmin('list', {}); S.users = new Map(users.map(u => [u.id, u])); } catch (e) { /* logins column stays short */ }
    }
  }

  /* ---------------- page ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="st-bar">
        <input type="search" id="stSearch" placeholder="Search name, job, section, phone…" autocomplete="off" aria-label="Search staff">
        <div class="filter-row" id="stShow" style="margin:0;">
          <button type="button" data-show="active">Working</button><button type="button" data-show="left">Left</button><button type="button" data-show="all">All</button>
        </div>
        <span style="flex:1"></span>
        <button type="button" class="btn secondary small" id="stExport">Export (Excel)</button>
        <button type="button" class="btn small" id="stAdd">+ Add person</button>
      </div>
      <div id="stBody"></div>`;
    el('stSearch').oninput = e => { S.q = e.target.value.trim().toLowerCase(); render(); };
    el('stShow').onclick = e => { const b = e.target.closest('[data-show]'); if (b) { S.show = b.dataset.show; render(); } };
    el('stAdd').onclick = () => openForm(null);
    el('stExport').onclick = exportList;
    el('stBody').onclick = onAction;
  }
  const shown = () => S.list.filter(p => (S.show === 'all' || (S.show === 'active' ? p.active : !p.active)) &&
    (!S.q || [p.name, p.job, p.sections, p.phone, p.note, loginName(p)].join(' ').toLowerCase().includes(S.q)));
  const loginName = p => p.user_id ? (S.users.get(p.user_id)?.username || 'yes') : '';

  function render() {
    panel.querySelectorAll('#stShow [data-show]').forEach(b => b.classList.toggle('active', b.dataset.show === S.show));
    if (S.missing) { el('stBody').innerHTML = '<div class="card"><p style="margin:0;"><b>Not set up yet.</b> The staff list works once migration 040 is applied.</p></div>'; return; }
    const list = shown();
    const jobs = {}; S.list.filter(p => p.active).forEach(p => { jobs[p.job] = (jobs[p.job] || 0) + 1; });
    el('stBody').innerHTML = `
      <p class="muted-note st-count">${S.list.filter(p => p.active).length} working · ${Object.entries(jobs).sort((a, b) => b[1] - a[1]).map(([j, n]) => `${n} ${esc(j)}`).join(' · ')}</p>
      <div class="card" style="padding:0;"><div class="items-scroll" style="margin:0;border:0;">
        <table class="items st-table">
          <thead><tr><th></th><th>Name</th><th>Job</th><th>Phone</th><th>Started</th><th class="num">Salary</th><th>PIN</th><th>App login</th><th></th></tr></thead>
          <tbody>${list.map(p => `<tr data-id="${esc(p.id)}" class="${p.active ? '' : 'st-left'}">
            <td class="st-drag">${canDrag() ? RowDrag.handle() : ''}</td>
            <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge inactive">Left</span>'}${p.note ? `<small class="st-note">${esc(p.note)}</small>` : ''}</td>
            <td>${esc(p.job)}${inCashList(p.job) ? ` <span class="muted-note" title="Also on the Cash page and the cashier page${String(p.job).toLowerCase() === 'picker' ? '' : ', and in the staff schedule'}">· cash</span>` : ''}${p.sections ? `<small class="st-note">Sections: ${esc(p.sections)}</small>` : ''}${breakFor(p.job) && p.break_start ? `<small class="st-note">${esc(breakText(p))}</small>` : ''}</td>
            <td class="mono">${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : ''}</td>
            <td class="mono">${p.start_date ? esc(fmtDate(p.start_date)) : ''}</td>
            <td class="num mono">${esc(salaryText(p.salary))}</td>
            <td>${pinCell(p)}</td>
            <td>${p.user_id ? `<span class="badge active">${esc(loginName(p))}</span>` : isAdmin() && p.active ? '<button type="button" class="btn secondary small" data-act="login">Create login</button>' : '<span class="muted-note">—</span>'}</td>
            <td><div class="icon-actions" style="justify-content:flex-end;">
              <button type="button" class="btn ghost small" data-act="edit">Edit</button>
              <button type="button" class="btn ghost small" data-act="toggle">${p.active ? 'Left' : 'Back'}</button>
            </div></td></tr>`).join('') || `<tr><td colspan="9" class="empty-note">${S.list.length ? 'Nobody matches.' : 'No staff yet — add the first person.'}</td></tr>`}</tbody>
        </table></div></div>
      ${canDrag() ? '<p class="muted-note" style="margin:8px 0 0;">Drag a row by its handle (⋮⋮) to change the order.</p>' : ''}`;
    if (canDrag()) RowDrag.attach(el('stBody').querySelector('.st-table tbody'), { onDrop: saveOrder });
  }
  // Reorder: the Working list without a search, so the order is the whole list's (migration 044).
  const canDrag = () => S.show === 'active' && !S.q;
  async function saveOrder(ids, movedId) {
    const { error } = await sb.rpc('staff_reorder', { p_ids: ids });
    if (error) showToast('Order not saved — ' + friendlyError(error), true);
    else { const p = S.list.find(x => x.id === movedId); logActivity('staff', 'reorder', { type: 'staff', id: movedId }, `Moved ${p?.name || 'a person'} to place ${ids.indexOf(movedId) + 1}`); }
    await load(); render();
  }

  // PIN for the cashier page: cashiers, cashier supervisors, pickers and delivery supervisors.
  function pinCell(p) {
    const c = p.cashier_id && S.cash?.get(p.cashier_id);
    if (!c) return inCashList(p.job) && p.active ? '<span class="muted-note">saving…</span>' : '';
    const locked = c.locked_until && new Date(c.locked_until) > new Date();
    return `${locked ? '<span class="badge danger">Locked out</span>' : c.has_pin ? '<span class="badge active">Set</span>' : '<span class="badge warn">No PIN</span>'}
      ${p.active ? `<button type="button" class="btn ghost small" data-act="pin">${c.has_pin ? 'Reset' : 'Set PIN'}</button>` : ''}`;
  }
  async function setPin(p) {
    const suggestion = String(crypto.getRandomValues(new Uint16Array(1))[0] % 10000).padStart(4, '0');
    const pin = await showPrompt(`4-digit PIN for ${p.name} (cashier page):`, { defaultValue: suggestion, confirmLabel: 'Set PIN', placeholder: '4 digits' });
    if (pin === null) return;
    if (!/^\d{4}$/.test(pin.trim())) return showToast('The PIN must be exactly 4 digits.', true);
    const { error } = await sb.rpc('set_cashier_pin', { p_cashier: p.cashier_id, p_pin: pin.trim() });
    if (error) return showToast('Could not set the PIN — ' + friendlyError(error), true);
    logActivity('staff', 'set_pin', { type: 'cashier', id: p.cashier_id }, `Set a new PIN for ${p.name}`);   // never the PIN itself
    await load(); render();
    await showConfirm(`PIN set. Give it to ${p.name} privately:\n\n${pin.trim()}\n\nThey open the cashier page, choose their name and type it.${isAdmin() ? '' : ' Only the admin can look it up later.'}`, 'Done');
  }

  /* ---------------- add / edit ---------------- */
  function ensureForm() {
    if (el('stOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="stOverlay">
        <div class="modal-box form-box">
          <h3 id="stTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
          <form id="stForm" autocomplete="off">
            <div class="form-grid">
              <div class="full"><label for="stName">Name</label><input type="text" id="stName" required></div>
              <div><label for="stJob">Job</label><select id="stJob" required></select></div>
              <div class="full" id="stSectionsW" hidden><label for="stSections">Sections <span style="opacity:.6;">(what they look after)</span></label><input type="text" id="stSections" placeholder="e.g. Detergents, Pasta, Rice"></div>
              <div><label for="stPhone">Phone <span style="opacity:.6;">(optional)</span></label><input type="text" id="stPhone" inputmode="tel" placeholder="e.g. 70 123 456"></div>
              <div><label for="stStart">Start date <span style="opacity:.6;">(optional)</span></label><input type="date" id="stStart"></div>
              <div><label for="stSalary">Monthly salary <span style="opacity:.6;">(optional)</span></label><input type="text" id="stSalary" inputmode="decimal" placeholder="e.g. 600"></div>
              <div class="full"><label for="stNote">Note <span style="opacity:.6;">(optional)</span></label><textarea id="stNote"></textarea></div>
              <div id="stBreakW" hidden><label for="stBreakAt">Break at <span style="opacity:.6;">(optional)</span></label><div style="display:flex;gap:8px;"><input type="time" id="stBreakAt"><select id="stBreakLen" style="width:auto;" aria-label="Break length">${[15, 20, 30, 45, 60, 90, 120].map(m => `<option value="${m}">${m < 60 ? m + ' min' : m === 60 ? '1 hour' : (m / 60) + ' hours'}</option>`).join('')}</select></div></div>
              <div id="stStationW" hidden><label for="stStation">Usual station</label><select id="stStation"><option value="">—</option><option value="front">Front</option><option value="back">Back</option></select></div>
              <div class="full" id="stUserWrap" hidden><label for="stUser">App login</label><select id="stUser"></select></div>
            </div>
            <p class="muted-note" id="stHint" style="margin:10px 0 0;">Cashiers, cashier supervisors, pickers and delivery supervisors also appear on the Cash page and the cashier page (with a PIN).</p>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="stCancel">Cancel</button>
              <button type="submit" class="btn small" id="stSave">Save</button>
            </div>
          </form>
        </div>
      </div>`);
    el('stCancel').onclick = () => el('stOverlay').classList.remove('open');
    el('stOverlay').onclick = e => { if (e.target.id === 'stOverlay') el('stOverlay').classList.remove('open'); };
  }
  function openForm(p) {
    ensureForm();
    el('stTitle').textContent = p ? `Edit ${p.name}` : 'Add a person';
    el('stName').value = p?.name || '';
    // An older job not in the list (e.g. typed before) stays selectable.
    const jobs = p?.job && !JOBS.includes(p.job) ? [p.job, ...JOBS] : JOBS;
    el('stJob').innerHTML = '<option value="">Choose…</option>' + jobs.map(j => `<option ${j === p?.job ? 'selected' : ''}>${esc(j)}</option>`).join('');
    el('stSections').value = p?.sections || '';
    el('stStation').value = (p?.cashier_id && S.cash?.get(p.cashier_id)?.default_station) || '';
    el('stBreakAt').value = p?.break_start || ''; el('stBreakLen').value = String(p?.break_minutes || 30);
    const syncSections = () => { el('stSectionsW').hidden = !isShelf(el('stJob').value); el('stStationW').hidden = !atTills(el('stJob').value); el('stBreakW').hidden = !el('stJob').value || !breakFor(el('stJob').value); };
    el('stJob').onchange = syncSections; syncSections();
    el('stPhone').value = p?.phone || ''; el('stStart').value = p?.start_date || '';
    el('stSalary').value = p?.salary ?? ''; el('stNote').value = p?.note || '';
    // Admin: link (or unlink) an existing login.
    el('stUserWrap').hidden = !isAdmin() || !S.users.size;
    if (isAdmin() && S.users.size) {
      const taken = new Set(S.list.filter(x => x.user_id && x.id !== p?.id).map(x => x.user_id));
      el('stUser').innerHTML = '<option value="">— none —</option>' + [...S.users.values()].filter(u => !taken.has(u.id))
        .sort((a, b) => a.username.localeCompare(b.username))
        .map(u => `<option value="${esc(u.id)}" ${u.id === p?.user_id ? 'selected' : ''}>${esc(u.username)}${u.display_name ? ' — ' + esc(u.display_name) : ''}</option>`).join('');
    }
    el('stForm').onsubmit = e => { e.preventDefault(); save(p); };
    el('stOverlay').classList.add('open');
    setTimeout(() => el('stName').focus(), 30);
  }
  async function save(p) {
    const salaryRaw = el('stSalary').value.trim().replace(/,/g, '');
    if (salaryRaw && isNaN(Number(salaryRaw))) return showToast('Salary: numbers only, e.g. 600.', true);
    const row = {
      name: el('stName').value.trim(), job: el('stJob').value,
      sections: isShelf(el('stJob').value) ? el('stSections').value.trim() || null : null,
      break_start: breakFor(el('stJob').value) && el('stBreakAt').value ? el('stBreakAt').value : null,
      break_minutes: breakFor(el('stJob').value) && el('stBreakAt').value ? Number(el('stBreakLen').value) : null,
      phone: el('stPhone').value.trim() || null, start_date: el('stStart').value || null,
      salary: salaryRaw ? Number(salaryRaw) : null, note: el('stNote').value.trim() || null,
    };
    if (!row.name) return showToast('Type the name.', true);
    if (!row.job) return showToast('Choose the job.', true);
    if (isAdmin() && S.users.size) row.user_id = el('stUser').value || null;
    el('stSave').disabled = true;
    const q = p ? sb.from('staff').update(row).eq('id', p.id) : sb.from('staff').insert({ ...row, sort_order: S.list.length });
    const { error } = await q;
    el('stSave').disabled = false;
    if (error) return showToast((/duplicate|unique/i.test(error.message) ? 'Someone with that name (or that login) is already in the list — ' : 'Not saved — ') + friendlyError(error), true);
    el('stOverlay').classList.remove('open');
    // Usual station (cashiers list): for someone already there; a new cashier gets it on the next edit.
    if (p?.cashier_id && atTills(row.job)) {
      const st = el('stStation').value || null;
      if ((S.cash?.get(p.cashier_id)?.default_station || null) !== st) await sb.from('cashiers').update({ default_station: st }).eq('id', p.cashier_id);
    }
    logActivity('staff', p ? 'edit' : 'add', { type: 'staff', id: p?.id || null }, `${p ? 'Edited' : 'Added'} ${row.name} (${row.job})`);   // salary not logged
    await load(); render();
    showToast(p ? 'Saved.' : `${row.name} added.`);
  }

  /* ---------------- actions ---------------- */
  async function onAction(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const p = S.list.find(x => x.id === b.closest('tr').dataset.id); if (!p) return;
    if (b.dataset.act === 'edit') return openForm(p);
    if (b.dataset.act === 'toggle') {
      const on = !p.active;
      if (!on && !(await showConfirm(`${p.name} left? They move to "Left"${inCashList(p.job) ? ', leave the cash grid, the schedule and the cashier page' : ''}${p.user_id ? '. Their app login stays — disable it in Users if needed' : ''}.`, 'Mark as left'))) return;
      const { error } = await sb.from('staff').update({ active: on }).eq('id', p.id);
      if (error) return showToast('Not saved — ' + friendlyError(error), true);
      logActivity('staff', on ? 'back' : 'left', { type: 'staff', id: p.id }, `${p.name} ${on ? 'is back' : 'left'}`);
      await load(); return render();
    }
    if (b.dataset.act === 'login') return createLogin(p);
    if (b.dataset.act === 'pin') return setPin(p);
  }
  // The person's app login: username from their name, role from their job, a temporary password.
  function askLogin(p) {
    if (!el('stLoginOverlay')) document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="stLoginOverlay">
        <div class="modal-box form-box">
          <h3 id="stLoginTitle" style="margin:0 0 14px;font-family:var(--font-head);"></h3>
          <form id="stLoginForm" autocomplete="off">
            <div class="form-grid">
              <div class="full"><label for="stLoginUser">Username <span style="opacity:.6;">(what they type to sign in)</span></label><input type="text" id="stLoginUser" autocapitalize="none" spellcheck="false" required></div>
              <div class="full"><label for="stLoginRole">Role</label><select id="stLoginRole"></select></div>
            </div>
            <p class="muted-note" style="margin:10px 0 0;">A temporary password is made for them. Fine-tune what they can do afterwards in Users &gt; Permissions.</p>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="stLoginCancel">Cancel</button>
              <button type="submit" class="btn small">Create login</button>
            </div>
          </form>
        </div>
      </div>`);
    return new Promise(resolve => {
      const ov = el('stLoginOverlay'), done = v => { ov.classList.remove('open'); resolve(v); };
      el('stLoginTitle').textContent = `App login for ${p.name}`;
      el('stLoginUser').value = usernameFor(p.name);
      el('stLoginRole').innerHTML = Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k === roleFor(p.job) ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
      el('stLoginCancel').onclick = () => done(null);
      ov.onclick = e => { if (e.target === ov) done(null); };
      el('stLoginForm').onsubmit = e => { e.preventDefault(); done({ username: el('stLoginUser').value.trim().toLowerCase(), role: el('stLoginRole').value }); };
      ov.classList.add('open');
      setTimeout(() => el('stLoginUser').select(), 30);
    });
  }
  async function createLogin(p) {
    if (!isAdmin()) return;
    const ask = await askLogin(p);
    if (!ask) return;
    const { username, role } = ask;
    const password = randomPassword();
    try {
      const { user } = await callAdmin('create', { username, display_name: p.name, role, password });
      S.users.set(user.id, user);
      const { error } = await sb.from('staff').update({ user_id: user.id }).eq('id', p.id);
      if (error) showToast('Login created, but not linked to the person — ' + friendlyError(error), true);
      logActivity('users', 'create', { type: 'user', id: user.id }, `Created ${ROLES[user.role].label.toLowerCase()} user ${user.username} for ${p.name}`, { role: user.role, staff_id: p.id });
      await load(); render();
      await showConfirm(`Login created. Give ${p.name} these sign-in details:\n\nUsername: ${user.username}\nPassword: ${password}\n\nAdjust what they can do in Users > Permissions.`, 'Done');
    } catch (err) { showToast(err.message, true); }
  }

  /* ---------------- export ---------------- */
  function exportList() {
    const list = shown();
    const aoa = [['Name', 'Job', 'Sections', 'Break', 'Phone', 'Start date', 'Monthly salary', 'Status', 'App login', 'Note']];
    list.forEach(p => aoa.push([p.name, p.job, p.sections || '', breakText(p), p.phone || '', p.start_date || '', p.salary ?? '', p.active ? 'Working' : 'Left', loginName(p), p.note || '']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 28 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 }];
    for (let r = 1; r < aoa.length; r++) { const c = ws[XLSX.utils.encode_cell({ r, c: 4 })]; if (c) { c.t = 's'; c.z = '@'; } }   // phones as text
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Staff');
    XLSX.writeFile(wb, `staff-${todayStr()}.xlsx`);
    logActivity('staff', 'export', { type: 'staff', id: 'all' }, `Exported the staff list (${list.length} people)`);
  }

  async function show() {
    if (!can('staff.manage')) return;
    if (!S.started) { S.started = true; shell(); }
    await load(); render();
  }
  window.Staff = { show };
})();
