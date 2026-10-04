/* ============================================================
   Admin pages: Users (via the admin-users edge function) and the
   Activity log (read straight from activity_log; RLS = admin only).
   Public API: window.UsersPage = { show }, window.ActivityPage = { show }.
   ============================================================ */
(function () {
  const ROLE_OPTIONS = Object.entries(ROLES).map(([value, r]) => [value, r.label]);
  const roleBadge = role => {
    const cls = { admin: 'danger', accountant: 'warn', delivery: 'active', floor_manager: 'inactive' }[role] || 'inactive';
    return `<span class="badge ${cls}">${escapeHtml(ROLES[role]?.label || role)}</span>`;
  };
  const fmtWhen = iso => iso
    ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Beirut', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
  const options = (list, sel) => list.map(([v, l]) => `<option value="${escapeHtml(v)}" ${v === sel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');

  // Calls the admin-users edge function; returns data or throws an Error with a readable message.
  async function callAdmin(action, payload) {
    const { data, error } = await sb.functions.invoke('admin-users', { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const body = await error.context.json(); if (body?.error) msg = body.error; } catch (e) { /* not JSON */ }
      if (/Failed to send a request|FunctionsFetchError|not found/i.test(msg) || error.context?.status === 404)
        msg = 'The user-management service is not set up yet (the admin-users function is not deployed).';
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  function randomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }

  /* ================= Users ================= */
  const usersPanel = document.getElementById('panel-users');
  let users = [], usersReady = false, serviceMissing = false;

  function usersShell() {
    usersPanel.innerHTML = `
      <div class="filter-row" style="justify-content:space-between;">
        <span class="muted-note" id="usersCount"></span>
        <button class="btn small" id="addUserBtn">+ Add user</button>
      </div>
      <div class="card" id="usersNotice" hidden></div>
      <div class="card" id="addUserCard" hidden>
        <h3>Add user</h3>
        <form id="addUserForm" autocomplete="off">
          <div class="form-grid">
            <div>
              <label for="nuUsername">Username <span style="opacity:.6;">(what they type to sign in)</span></label>
              <input type="text" id="nuUsername" placeholder="e.g. rami.k" autocapitalize="none" spellcheck="false" required>
            </div>
            <div>
              <label for="nuName">Full name</label>
              <input type="text" id="nuName" placeholder="e.g. Rami Khoury">
            </div>
            <div>
              <label for="nuRole">Role</label>
              <select id="nuRole">${options(ROLE_OPTIONS, 'delivery')}</select>
            </div>
            <div>
              <label for="nuPassword">Temporary password <span style="opacity:.6;">(8+ characters)</span></label>
              <div style="display:flex;gap:8px;">
                <input type="text" id="nuPassword" required>
                <button type="button" class="btn ghost small" id="nuGenerate">Generate</button>
              </div>
            </div>
          </div>
          <div class="actions-row">
            <button type="button" class="btn ghost small" id="nuCancel">Cancel</button>
            <button type="submit" class="btn small" id="nuSave">Create user</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="items-scroll" style="margin-bottom:0;">
          <table class="items">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Phone / app</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody id="usersBody"><tr><td colspan="7" class="empty-note">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>`;
    const el = id => document.getElementById(id);
    el('addUserBtn').onclick = () => {
      el('addUserCard').hidden = false;
      el('nuPassword').value = randomPassword();
      el('nuUsername').focus();
    };
    el('nuCancel').onclick = () => { el('addUserForm').reset(); el('addUserCard').hidden = true; };
    el('nuGenerate').onclick = () => { el('nuPassword').value = randomPassword(); };
    el('addUserForm').onsubmit = createUser;
    el('usersBody').onclick = onUserAction;
  }

  /* ---------- permissions (per user overrides on top of the role, migration 014) ---------- */
  let overrides = {};          // user_id -> { perm: true|false }
  let permsTableMissing = false;
  async function loadOverrides() {
    const { data, error } = await sb.from('user_permissions').select('user_id, perm, allowed');
    permsTableMissing = !!error;
    overrides = {};
    (data || []).forEach(r => { (overrides[r.user_id] = overrides[r.user_id] || {})[r.perm] = r.allowed; });
  }
  // A permission that needs the group's "see" permission first.
  const REQUIRES = {};
  PERMISSIONS.forEach(([k]) => {
    const [sec, act] = k.split('.');
    if (act !== 'view' && PERMISSION_KEYS.includes(sec + '.view')) REQUIRES[k] = sec + '.view';
  });
  function overrideBadge(u) {
    const o = overrides[u.id]; if (!o || u.role === 'admin') return '';
    const plus = Object.values(o).filter(Boolean).length, minus = Object.values(o).length - plus;
    return ` <span class="badge inactive" title="Permissions changed for this user">${plus ? '+' + plus : ''}${plus && minus ? ' ' : ''}${minus ? '−' + minus : ''} custom</span>`;
  }

  function ensurePermModal() {
    if (document.getElementById('userPermOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="userPermOverlay">
        <div class="modal-box form-box perm-box">
          <h3 id="upTitle" style="margin:0 0 4px;font-family:var(--font-head);"></h3>
          <p class="muted-note" id="upSub" style="margin:0 0 14px;"></p>
          <div id="upBody" class="perm-groups"></div>
          <div class="actions-row">
            <button type="button" class="btn ghost small" id="upReset" style="margin-right:auto;">Reset to role</button>
            <button type="button" class="btn ghost small" id="upCancel">Cancel</button>
            <button type="button" class="btn small" id="upSave">Save permissions</button>
          </div>
        </div>
      </div>`);
  }

  async function openPermissions(u) {
    ensurePermModal();
    await loadOverrides();
    if (permsTableMissing) { showToast('Per-user permissions are not set up yet: apply migration 014 first.', true); return; }
    const el = id => document.getElementById(id);
    const overlay = el('userPermOverlay');
    const base = rolePermissions(u.role);
    let current = effectivePermissions(u.role, overrides[u.id]);
    el('upTitle').textContent = `Permissions — ${u.display_name || u.username}`;
    el('upSub').textContent = `Role: ${ROLES[u.role]?.label || u.role}. The role gives the ticked boxes by default; change any box for this user only.`;
    const draw = () => {
      el('upBody').innerHTML = PERMISSION_GROUPS.map(g => `
        <fieldset class="perm-group"><legend>${escapeHtml(g)}</legend>
          ${PERMISSIONS.filter(p => p[1] === g).map(([k, , label]) => {
            const on = current.has(k), custom = on !== base.has(k);
            return `<label class="perm-row ${custom ? 'is-custom' : ''}"><input type="checkbox" data-perm="${k}" ${on ? 'checked' : ''}>
              <span>${escapeHtml(label)}</span>${custom ? `<span class="badge ${on ? 'active' : 'danger'}">${on ? 'added' : 'removed'}</span>` : ''}</label>`;
          }).join('')}
        </fieldset>`).join('');
    };
    draw();
    el('upBody').onchange = e => {
      const k = e.target.dataset.perm; if (!k) return;
      if (e.target.checked) { current.add(k); if (REQUIRES[k]) current.add(REQUIRES[k]); }
      else { current.delete(k); Object.entries(REQUIRES).forEach(([dep, req]) => { if (req === k) current.delete(dep); }); }
      draw();
    };
    el('upReset').onclick = () => { current = new Set(base); draw(); };
    const close = () => { overlay.classList.remove('open'); el('upSave').onclick = null; };
    el('upCancel').onclick = close;
    overlay.onclick = ev => { if (ev.target === overlay) close(); };
    el('upSave').onclick = async () => {
      // Store only what differs from the role; the rest follows the role (also when the role changes later).
      const rows = PERMISSION_KEYS.filter(k => current.has(k) !== base.has(k)).map(k => ({ user_id: u.id, perm: k, allowed: current.has(k) }));
      el('upSave').disabled = true;
      try {
        const { error: delErr } = await sb.from('user_permissions').delete().eq('user_id', u.id);
        if (delErr) throw delErr;
        if (rows.length) { const { error } = await sb.from('user_permissions').insert(rows); if (error) throw error; }
        const before = overrides[u.id] || {};
        overrides[u.id] = Object.fromEntries(rows.map(r => [r.perm, r.allowed]));
        logActivity('users', 'permissions', { type: 'user', id: u.id },
          `Permissions of ${u.username}: ${rows.length ? rows.map(r => (r.allowed ? '+' : '−') + r.perm).join(', ') : 'back to the role defaults'}`,
          { before, after: overrides[u.id] });
        renderUsers();
        close();
        showToast(`Permissions saved. ${u.display_name || u.username} gets them the next time they open the app.`);
      } catch (err) {
        showToast('Could not save the permissions — ' + friendlyError(err), true);
      } finally { el('upSave').disabled = false; }
    };
    overlay.classList.add('open');
  }

  // Notifications and installed app (migration 049): two small pills.
  const usagePills = u => !u ? '' : `<span class="badge ${u.devices ? 'active' : 'inactive'}" title="${u.devices ? `Notifications on ${u.devices} device${u.devices === 1 ? '' : 's'}` : 'Notifications not turned on'}">${u.devices ? 'Notifications on' + (u.devices > 1 ? ' · ' + u.devices : '') : 'No notifications'}</span>
      <span class="badge ${u.installed_at ? 'active' : 'inactive'}" title="${u.installed_at ? 'Opened from the home-screen icon since ' + new Date(u.installed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Not opened as an installed app yet'}">${u.installed_at ? 'App installed' : 'Not installed'}</span>`;
  let usage = new Map();
  async function loadUsers() {
    const notice = document.getElementById('usersNotice');
    try {
      users = (await callAdmin('list')).users;
      serviceMissing = false;
      notice.hidden = true;
    } catch (e) {
      // Without the function we can still show who exists (admins can read profiles through RLS).
      serviceMissing = true;
      const { data } = await sb.from('profiles').select('*').order('created_at');
      users = (data || []).map(p => ({ ...p, email: null, last_sign_in_at: null }));
      notice.hidden = false;
      notice.innerHTML = `<p style="margin:0;"><b>Read-only for now.</b> ${escapeHtml(e.message)}</p>`;
    }
    await loadOverrides();
    const { data: us } = await sb.rpc('staff_app_usage');
    usage = new Map((us || []).map(r => [r.user_id, r]));
    renderUsers();
  }

  function renderUsers() {
    const body = document.getElementById('usersBody');
    document.getElementById('usersCount').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
    document.getElementById('addUserBtn').disabled = serviceMissing;
    body.innerHTML = users.map(u => {
      const me = u.id === Session.user.id;
      const login = u.email && !u.email.endsWith('@' + LOGIN_DOMAIN) ? u.email : u.username;
      return `<tr data-id="${escapeHtml(u.id)}">
        <td><b>${escapeHtml(u.display_name || u.username)}</b>${me ? ' <span class="muted-note">(you)</span>' : ''}</td>
        <td style="font-family:var(--font-mono);">${escapeHtml(login)}</td>
        <td>${roleBadge(u.role)}${overrideBadge(u)}</td>
        <td>${u.active ? '<span class="badge active">Active</span>' : '<span class="badge inactive">Disabled</span>'}</td>
        <td class="usage-cell">${usagePills(usage.get(u.id))}</td>
        <td style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(fmtWhen(u.last_sign_in_at))}</td>
        <td>${serviceMissing ? '' : `<div class="icon-actions" style="justify-content:flex-end;">
          <button class="btn secondary small" data-act="edit">Edit</button>
          ${u.role === 'admin' ? '' : '<button class="btn secondary small" data-act="perms">Permissions</button>'}
          <button class="btn secondary small" data-act="password">Reset password</button>
          ${me ? '' : `<button class="btn ghost small" data-act="${u.active ? 'disable' : 'enable'}">${u.active ? 'Disable' : 'Enable'}</button>`}
        </div>`}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty-note">No users yet.</td></tr>';
  }

  async function createUser(e) {
    e.preventDefault();
    const el = id => document.getElementById(id);
    const payload = {
      username: el('nuUsername').value.trim().toLowerCase(),
      display_name: el('nuName').value.trim(),
      role: el('nuRole').value,
      password: el('nuPassword').value,
    };
    el('nuSave').disabled = true;
    try {
      const { user } = await callAdmin('create', payload);
      users.push(user);
      renderUsers();
      el('addUserForm').reset();
      el('addUserCard').hidden = true;
      logActivity('users', 'create', { type: 'user', id: user.id }, `Created ${ROLES[user.role].label.toLowerCase()} user ${user.username}`, { role: user.role });
      await showConfirm(`User created. Give ${payload.display_name || payload.username} these sign-in details:\n\nUsername: ${payload.username}\nPassword: ${payload.password}`, 'Done');
    } catch (err) {
      showToast(err.message, true);
    } finally {
      el('nuSave').disabled = false;
    }
  }

  async function onUserAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const u = users.find(x => x.id === btn.closest('tr').dataset.id);
    const act = btn.dataset.act;
    try {
      if (act === 'edit') return openEdit(u);
      if (act === 'perms') return openPermissions(u);
      if (act === 'password') {
        const pw = await showPrompt(`New password for ${u.display_name || u.username} (8+ characters):`, { defaultValue: randomPassword(), confirmLabel: 'Set password' });
        if (pw === null) return;
        await callAdmin('reset_password', { id: u.id, password: pw });
        logActivity('users', 'reset_password', { type: 'user', id: u.id }, `Reset the password of ${u.username}`);
        await showConfirm(`Password changed. New sign-in details:\n\nUsername: ${u.username}\nPassword: ${pw}`, 'Done');
      }
      if (act === 'disable' || act === 'enable') {
        const on = act === 'enable';
        if (!on && !(await showConfirm(`Disable ${u.display_name || u.username}? They will not be able to sign in until you enable them again.`, 'Disable'))) return;
        const { user } = await callAdmin('update', { id: u.id, active: on });
        Object.assign(u, user);
        renderUsers();
        logActivity('users', on ? 'enable' : 'disable', { type: 'user', id: u.id }, `${on ? 'Enabled' : 'Disabled'} ${u.username}`);
        showToast(`${u.username} ${on ? 'enabled' : 'disabled'}.`);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // Edit name + role in the shared form modal.
  function openEdit(u) {
    const overlay = document.getElementById('userEditOverlay');
    const el = id => document.getElementById(id);
    el('ueTitle').textContent = `Edit ${u.display_name || u.username}`;
    el('ueName').value = u.display_name || '';
    el('ueRole').innerHTML = options(ROLE_OPTIONS, u.role);
    el('ueRole').disabled = u.id === Session.user.id;   // can't change your own role
    overlay.classList.add('open');
    el('ueName').focus();
    const close = () => { overlay.classList.remove('open'); el('ueForm').onsubmit = null; };
    el('ueCancel').onclick = close;
    overlay.onclick = ev => { if (ev.target === overlay) close(); };
    el('ueForm').onsubmit = async ev => {
      ev.preventDefault();
      const patch = { id: u.id, display_name: el('ueName').value.trim() };
      if (!el('ueRole').disabled) patch.role = el('ueRole').value;
      try {
        const { user } = await callAdmin('update', patch);
        const changed = {};
        if ((u.display_name || '') !== (user.display_name || '')) changed.display_name = { from: u.display_name, to: user.display_name };
        if (u.role !== user.role) changed.role = { from: u.role, to: user.role };
        Object.assign(u, user);
        renderUsers();
        close();
        if (Object.keys(changed).length) logActivity('users', 'edit', { type: 'user', id: u.id }, `Edited ${u.username}${changed.role ? ` (role: ${changed.role.from} → ${changed.role.to})` : ''}`, { changed });
        showToast('User saved.');
      } catch (err) {
        showToast(err.message, true);
      }
    };
  }

  function ensureEditModal() {
    if (document.getElementById('userEditOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="userEditOverlay">
        <div class="modal-box form-box">
          <h3 id="ueTitle" style="margin:0 0 16px;font-family:var(--font-head);"></h3>
          <form id="ueForm">
            <div class="form-grid">
              <div><label for="ueName">Full name</label><input type="text" id="ueName"></div>
              <div><label for="ueRole">Role</label><select id="ueRole"></select></div>
            </div>
            <div class="actions-row">
              <button type="button" class="btn ghost small" id="ueCancel">Cancel</button>
              <button type="submit" class="btn small">Save</button>
            </div>
          </form>
        </div>
      </div>`);
  }

  window.UsersPage = {
    show() {
      if (!isAdmin()) return;
      if (!usersReady) { usersReady = true; usersShell(); ensureEditModal(); }
      loadUsers();
    },
  };

  /* ================= Activity log ================= */
  const actPanel = document.getElementById('panel-activity');
  const PAGE_SIZE = 100;
  let entries = [], actReady = false, moreAvailable = false;
  const actFilter = { module: '', q: '' };

  function activityShell() {
    actPanel.innerHTML = `
      <div class="filter-row" id="actModules" style="flex-wrap:wrap;"></div>
      <div class="card">
        <input type="text" id="actSearch" placeholder="Search by person, action or description…">
        <div class="items-scroll" style="margin:14px 0 0;">
          <table class="items">
            <thead><tr><th>When</th><th>Who</th><th>Module</th><th>Action</th><th>What happened</th></tr></thead>
            <tbody id="actBody"><tr><td colspan="5" class="empty-note">Loading…</td></tr></tbody>
          </table>
        </div>
        <div class="actions-row" id="actMoreRow" hidden><button class="btn secondary small" id="actMore">Load older entries</button></div>
      </div>`;
    document.getElementById('actSearch').oninput = e => { actFilter.q = e.target.value.trim().toLowerCase(); renderActivity(); };
    document.getElementById('actMore').onclick = () => loadActivity(true);
    document.getElementById('actModules').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      actFilter.module = b.dataset.module; renderActivity();
    };
    document.getElementById('actBody').onclick = e => {
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('act-details')) next.hidden = !next.hidden;
    };
  }

  async function loadActivity(older) {
    let q = sb.from('activity_log').select('*').order('at', { ascending: false }).limit(PAGE_SIZE);
    if (older && entries.length) q = q.lt('at', entries[entries.length - 1].at);
    const { data, error } = await q;
    if (error) { showToast('Could not load the activity log — ' + friendlyError(error), true); return; }
    entries = older ? entries.concat(data) : data;
    moreAvailable = data.length === PAGE_SIZE;
    renderActivity();
  }

  // cashier_page (migration 039): what cashiers do on the cashier page, under their own name.
  const MODULE_LABEL = { cashier_page: 'Cashier page' };
  function renderActivity() {
    const modules = [...new Set(entries.map(e => e.module).concat('cashier_page'))].sort();
    document.getElementById('actModules').innerHTML = [['', 'All'], ...modules.map(m => [m, MODULE_LABEL[m] || m])]
      .map(([v, l]) => `<button data-module="${escapeHtml(v)}" class="${actFilter.module === v ? 'active' : ''}">${escapeHtml(l)}</button>`).join('');
    const list = entries.filter(e => (!actFilter.module || e.module === actFilter.module) &&
      (!actFilter.q || [e.username, e.action, e.summary, e.entity_type].join(' ').toLowerCase().includes(actFilter.q)));
    document.getElementById('actBody').innerHTML = list.map((e, i) => `
      <tr data-i="${i}" style="cursor:${e.details ? 'pointer' : 'default'};">
        <td style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(fmtWhen(e.at))}</td>
        <td>${escapeHtml(e.username || '—')}${e.role ? ` <span class="muted-note">${escapeHtml(ROLES[e.role]?.label || ({ cashier: 'Cashier', supervisor: 'Supervisor' })[e.role] || e.role)}</span>` : ''}</td>
        <td><span class="badge ${e.module === 'cashier_page' ? 'warn' : 'inactive'}">${escapeHtml(MODULE_LABEL[e.module] || e.module)}</span></td>
        <td style="font-family:var(--font-mono);font-size:12px;">${escapeHtml(e.action)}</td>
        <td style="white-space:normal;">${escapeHtml(e.summary || '')}</td>
      </tr>
      ${e.details ? `<tr class="act-details" hidden><td colspan="5" style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;color:var(--ink-soft);">${escapeHtml(JSON.stringify(e.details, null, 2))}</td></tr>` : ''}`).join('')
      || '<tr><td colspan="5" class="empty-note">Nothing logged yet.</td></tr>';
    document.getElementById('actMoreRow').hidden = !moreAvailable;
  }

  window.ActivityPage = {
    show() {
      if (!can('activity.view')) return;
      if (!actReady) { actReady = true; activityShell(); }
      loadActivity(false);
    },
  };
})();
