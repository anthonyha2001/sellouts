/* ============================================================
   Notification monitor (owner, 2026-10-25): why a cashier isn't getting notifications.
   Shows, per active cashier, whether a phone is registered for push, when a push last succeeded, whether any of their
   devices are failing (an expired/blocked subscription — very common on iPhone), and a feed of the last pushes actually
   sent to cashiers. Reads public.cashier_push_status() (migration 100; admin or cash.view). Read only.
   Permission: cash.view (admin always). Public API: window.CashNotify = { show }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { built: false, busy: false, data: null, err: '' };
  const STALE_DAYS = 14;   // a device whose last success is older than this is probably expired

  // a human label for a push key (sched:… cashdiff:… signreq:…)
  function label(key) {
    const k = String(key || '');
    if (k.startsWith('sched:')) return 'Schedule';
    if (k.startsWith('cashdiff')) return 'Cash difference';
    if (k.startsWith('signreq:') || k.startsWith('ccsign:')) return 'Cash-count signature';
    const head = k.split(':')[0] || k;
    return head.charAt(0).toUpperCase() + head.slice(1);
  }
  const ago = ts => {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    if (ms < 0) return 'just now';
    const m = Math.floor(ms / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60); if (h < 24) return h + ' h ago';
    const d = Math.floor(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
  };
  const when = ts => { try { return typeof fmtDate === 'function' ? fmtDate(String(ts).slice(0, 10)) : String(ts).slice(0, 10); } catch (e) { return String(ts).slice(0, 10); } };
  const stale = ts => ts && (Date.now() - new Date(ts).getTime()) > STALE_DAYS * 864e5;

  // a cashier's push health -> {cls, text}
  function status(c) {
    if (!c.devices) return { cls: 'bad', text: 'No phone registered' };
    if (!c.last_ok_at) return { cls: 'warn', text: 'Registered, never delivered' };
    if (c.failing) return { cls: 'bad', text: 'Device failing (likely expired)' };
    if (stale(c.last_ok_at)) return { cls: 'warn', text: 'No delivery in ' + STALE_DAYS + '+ days' };
    return { cls: 'ok', text: 'OK' };
  }

  function build() {
    const box = el('panel-cashnotify'); if (!box || S.built) return;
    S.built = true;
    box.innerHTML = `
      <div class="card nt-bar">
        <p class="muted-note" style="margin:0;">Who can receive notifications, and what was sent. If a cashier isn't getting them, it is almost always "No phone registered" (they never opened the cashier page and allowed notifications on <b>their own phone</b>) or "Device failing" (the subscription expired — common on iPhone; they re-open the cashier page to refresh it).</p>
        <button type="button" class="btn small" id="ntReload">Refresh</button>
      </div>
      <div id="ntBody"></div>`;
    el('ntReload').onclick = load;
  }

  async function load() {
    build();
    const body = el('ntBody'); if (!body) return;
    if (S.busy) return;
    S.busy = true; S.err = '';
    body.innerHTML = `<div class="card"><p class="muted-note" style="margin:0;">Loading…</p></div>`;
    try {
      const push = await sb.rpc('cashier_push_status');
      if (push.error) throw new Error(/cashier_push_status|function/.test(push.error.message) ? 'Not set up yet (run migration 100).' : push.error.message);
      const bio = await sb.rpc('cashier_biometric_status');   // migration 101; ignored if not set up yet
      const bmap = {}; if (!bio.error) (bio.data || []).forEach(x => { bmap[x.cashier_id] = x.passkeys; });
      (push.data.cashiers || []).forEach(c => { c.passkeys = bmap[c.id] || 0; });
      S.data = push.data;
    } catch (e) { S.err = e.message; S.data = null; }
    S.busy = false;
    paint();
  }

  function paint() {
    const body = el('ntBody'); if (!body) return;
    if (S.err) { body.innerHTML = `<div class="card"><p class="login-err" style="margin:0;">${esc(S.err)}</p></div>`; return; }
    const d = S.data; if (!d) { body.innerHTML = ''; return; }
    const cashiers = (d.cashiers || []), recent = (d.recent || []);
    const noPhone = cashiers.filter(c => !c.devices).length;
    const failing = cashiers.filter(c => c.devices && (c.failing || !c.last_ok_at || stale(c.last_ok_at))).length;
    const okN = cashiers.length - noPhone - failing;
    body.innerHTML = `
      <div class="pf-tiles nt-tiles">
        <div class="pf-tile"><span>Can receive</span><b>${okN}</b><small>of ${cashiers.length} cashiers</small></div>
        <div class="pf-tile"><span>No phone registered</span><b class="${noPhone ? 'nt-red' : ''}">${noPhone}</b><small>never enabled notifications</small></div>
        <div class="pf-tile"><span>Failing / stale</span><b class="${failing ? 'nt-amber' : ''}">${failing}</b><small>subscription likely expired</small></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 10px;">Cashiers</h3>
        <div class="items-scroll"><table class="items nt-table"><thead><tr><th>Cashier</th><th>Status</th><th>Phones</th><th>Last delivered</th><th>Biometric</th><th>Registered</th></tr></thead>
          <tbody>${cashiers.map(c => { const s = status(c); return `<tr>
            <td>${esc(c.name)}${c.position === 'supervisor' ? ' <span class="muted-note">(supervisor)</span>' : ''}</td>
            <td><span class="nt-dot ${s.cls}"></span>${esc(s.text)}</td>
            <td class="num">${c.devices}${c.failing ? ` <span class="muted-note">(${c.failing} failing)</span>` : ''}</td>
            <td>${c.last_ok_at ? `${esc(ago(c.last_ok_at))} <span class="muted-note">${esc(when(c.last_ok_at))}</span>` : '<span class="muted-note">never</span>'}</td>
            <td>${c.passkeys ? `<span class="nt-dot ok"></span>On${isAdmin() ? ` <button type="button" class="link-btn" data-bioreset="${esc(c.id)}" data-name="${esc(c.name)}">Reset</button>` : ''}` : '<span class="muted-note">—</span>'}</td>
            <td>${c.registered_at ? esc(when(c.registered_at)) : '—'}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty-note">No active cashiers.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 4px;">Recently sent</h3>
        <p class="muted-note" style="margin:0 0 10px;">The last pushes queued to cashiers' phones. "Sent" means it was handed to the phone's push service — a phone that is off or has an expired subscription still won't show it; check the cashier's status above.</p>
        <div class="items-scroll"><table class="items nt-table"><thead><tr><th>When</th><th>Cashier</th><th>Notification</th></tr></thead>
          <tbody>${recent.map(x => `<tr><td>${esc(ago(x.sent_at))} <span class="muted-note">${esc(when(x.sent_at))}</span></td><td>${esc(x.cashier || '—')}</td><td>${esc(label(x.key))}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-note">Nothing sent yet.</td></tr>'}</tbody>
        </table></div>
      </div>
      <p class="muted-note" style="margin:10px 0 0;">Read live from the system. Updated ${esc(ago(d.generated_at))}.</p>`;
    // admin: reset a cashier's biometric (lost / replaced phone) so they fall back to PIN and can enrol again
    body.querySelectorAll('[data-bioreset]').forEach(b => b.onclick = async () => {
      const id = b.dataset.bioreset, name = b.dataset.name;
      if (!confirm(`Reset biometric for ${name}?\n\nThey will sign in with their PIN and can set up Face ID again on their phone. Use this for a lost or replaced phone.`)) return;
      b.disabled = true;
      try {
        const { error } = await sb.rpc('cashier_reset_biometric', { p_cashier: id });
        if (error) throw error;
        if (typeof showToast === 'function') showToast(`Biometric reset for ${name}.`);
        load();
      } catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not reset.', true); b.disabled = false; }
    });
  }

  function show() { build(); load(); }
  window.CashNotify = { show };
})();
