/* ============================================================
   Staff (owner, 2026-10-03): one list of every employee — name, job,
   and optionally phone, start date, salary and a note; active or left.
   Cashiers and supervisors are kept in step with the cashiers list
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
  const JOBS = ['Cashier', 'Supervisor', 'Shelf worker', 'Floor manager', 'Accountant', 'HR', 'Delivery', 'Butcher', 'Fishmonger',
    'Vegetables', 'Deli counter', 'Bakery', 'Storekeeper', 'Security', 'Cleaner', 'Manager'];
  // The app role a job usually gets (the admin can change it when creating the login).
  const ROLE_OF = { accountant: 'accountant', delivery: 'delivery', 'floor manager': 'floor_manager', hr: 'hr', manager: 'admin' };
  const roleFor = job => ROLE_OF[String(job || '').trim().toLowerCase()] || 'shelf';
  const inCashList = job => ['cashier', 'supervisor'].includes(String(job || '').trim().toLowerCase());
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
    if (isAdmin() && !S.users.size) {
      try { const { users } = await callAdmin('list', {}); S.users = new Map(users.map(u => [u.id, u])); } catch (e) { /* logins column stays short */ }
    }
  }

  /* ---------------- page ---------------- */
  function shell() {
    panel.innerHTML = `
      <div class="st-bar">
        <input type="search" id="stSearch" placeholder="Search name, job, phone…" autocomplete="off" aria-label="Search staff">
        <div class="filter-row" id="stShow" style="margin:0;">
          <button type="button" data-show="active">Working</button><button type="button" data-show="left">Left</button><button type="button" data-show="all">All</button>
        </div>
        <span style="flex:1"></span>
        <button type="button" class="btn secondary small" id="stExport">Export (Excel)</button>
        <button type="button" class="btn small" id="stAdd">+ Add person</button>
      </div>
      <div id="stBody"></div>
      <datalist id="stJobs">${JOBS.map(j => `<option value="${esc(j)}">`).join('')}</datalist>`;
    el('stSearch').oninput = e => { S.q = e.target.value.trim().toLowerCase(); render(); };
    el('stShow').onclick = e => { const b = e.target.closest('[data-show]'); if (b) { S.show = b.dataset.show; render(); } };
    el('stAdd').onclick = () => openForm(null);
    el('stExport').onclick = exportList;
    el('stBody').onclick = onAction;
  }
  const shown = () => S.list.filter(p => (S.show === 'all' || (S.show === 'active' ? p.active : !p.active)) &&
    (!S.q || [p.name, p.job, p.phone, p.note, loginName(p)].join(' ').toLowerCase().includes(S.q)));
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
          <thead><tr><th>Name</th><th>Job</th><th>Phone</th><th>Started</th><th class="num">Salary</th><th>App login</th><th></th></tr></thead>
          <tbody>${list.map(p => `<tr data-id="${esc(p.id)}" class="${p.active ? '' : 'st-left'}">
            <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge inactive">Left</span>'}${p.note ? `<small class="st-note">${esc(p.note)}</small>` : ''}</td>
            <td>${esc(p.job)}${inCashList(p.job) ? ' <span class="muted-note" title="Also in the cashiers list: cash differences, schedule, cashier page">· cashiers list</span>' : ''}</td>
            <td class="mono">${p.phone ? `<a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a>` : ''}</td>
            <td class="mono">${p.start_date ? esc(fmtDate(p.start_date)) : ''}</td>
            <td class="num mono">${esc(salaryText(p.salary))}</td>
            <td>${p.user_id ? `<span class="badge active">${esc(loginName(p))}</span>` : isAdmin() && p.active ? '<button type="button" class="btn secondary small" data-act="login">Create login</button>' : '<span class="muted-note">—</span>'}</td>
            <td><div class="icon-actions" style="justify-content:flex-end;">
              <button type="button" class="btn ghost small" data-act="edit">Edit</button>
              <button type="button" class="btn ghost small" data-act="toggle">${p.active ? 'Left' : 'Back'}</button>
            </div></td></tr>`).join('') || `<tr><td colspan="7" class="empty-note">${S.list.length ? 'Nobody matches.' : 'No staff yet — add the first person.'}</td></tr>`}</tbody>
        </table></div></div>`;
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
              <div><label for="stJob">Job</label><input type="text" id="stJob" list="stJobs" placeholder="e.g. Cashier, Shelf worker" required></div>
              <div><label for="stPhone">Phone <span style="opacity:.6;">(optional)</span></label><input type="text" id="stPhone" inputmode="tel" placeholder="e.g. 70 123 456"></div>
              <div><label for="stStart">Start date <span style="opacity:.6;">(optional)</span></label><input type="date" id="stStart"></div>
              <div><label for="stSalary">Monthly salary <span style="opacity:.6;">(optional)</span></label><input type="text" id="stSalary" inputmode="decimal" placeholder="e.g. 600"></div>
              <div class="full"><label for="stNote">Note <span style="opacity:.6;">(optional)</span></label><textarea id="stNote"></textarea></div>
              <div class="full" id="stUserWrap" hidden><label for="stUser">App login</label><select id="stUser"></select></div>
            </div>
            <p class="muted-note" id="stHint" style="margin:10px 0 0;">Cashiers and supervisors also appear in the cash differences, the staff schedule and the cashier page.</p>
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
    el('stName').value = p?.name || ''; el('stJob').value = p?.job || '';
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
      name: el('stName').value.trim(), job: el('stJob').value.trim() || 'Cashier',
      phone: el('stPhone').value.trim() || null, start_date: el('stStart').value || null,
      salary: salaryRaw ? Number(salaryRaw) : null, note: el('stNote').value.trim() || null,
    };
    if (!row.name) return showToast('Type the name.', true);
    if (isAdmin() && S.users.size) row.user_id = el('stUser').value || null;
    el('stSave').disabled = true;
    const q = p ? sb.from('staff').update(row).eq('id', p.id) : sb.from('staff').insert({ ...row, sort_order: S.list.length });
    const { error } = await q;
    el('stSave').disabled = false;
    if (error) return showToast((/duplicate|unique/i.test(error.message) ? 'Someone with that name (or that login) is already in the list — ' : 'Not saved — ') + friendlyError(error), true);
    el('stOverlay').classList.remove('open');
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
  }
  // The person's app login: username from their name, role from their job, a temporary password.
  async function createLogin(p) {
    if (!isAdmin()) return;
    const username = await showPrompt(`Username for ${p.name} (what they type to sign in):`, { defaultValue: usernameFor(p.name), confirmLabel: 'Next' });
    if (username === null) return;
    const roles = Object.entries(ROLES).map(([k, r]) => `${k} = ${r.label}`).join(', ');
    const role = await showPrompt(`Role for ${p.name} (${p.job}). One of: ${roles}`, { defaultValue: roleFor(p.job), confirmLabel: 'Create login' });
    if (role === null) return;
    if (!ROLES[role.trim()]) return showToast('Unknown role: ' + role, true);
    const password = randomPassword();
    try {
      const { user } = await callAdmin('create', { username: username.trim().toLowerCase(), display_name: p.name, role: role.trim(), password });
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
    const aoa = [['Name', 'Job', 'Phone', 'Start date', 'Monthly salary', 'Status', 'App login', 'Note']];
    list.forEach(p => aoa.push([p.name, p.job, p.phone || '', p.start_date || '', p.salary ?? '', p.active ? 'Working' : 'Left', loginName(p), p.note || '']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 16 }, { wch: 40 }];
    for (let r = 1; r < aoa.length; r++) { const c = ws[XLSX.utils.encode_cell({ r, c: 2 })]; if (c) { c.t = 's'; c.z = '@'; } }   // phones as text
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
