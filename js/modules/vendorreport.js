/* ============================================================
   Weekly report (owner, 2026-10-11): the Vendors › Weekly report tab. One week (Monday to Sunday) at a glance:
   what was due, what was sent, what arrived (on time or late, how many days it took), what was cancelled, the
   "no order" entries and the order days that were missed (due, nothing sent and no "no order" logged).
   Then the problems first (missed, late, cancelled) and one row per vendor.
   Reads the vendor page's data (js/app.js: vendorsList, ordersList, skipsList, isVendorDueOn...).
   Public API: window.VendorReport = { render }.
   ============================================================ */
(function () {
  const esc = escapeHtml;
  const el = id => document.getElementById(id);
  const S = { start: null };
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dmy = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const day10 = s => String(s || '').slice(0, 10);
  const diff = (a, b) => Math.round((Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00')) / 864e5);
  const mondayOf = t => { const d = new Date(t + 'T00:00:00'); return addDaysStr(t, -((d.getDay() + 6) % 7)); };
  const longDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const cancelDay = o => { const m = /Cancelled (\d{4}-\d{2}-\d{2})/.exec(o.receiveNote || ''); return m ? m[1] : day10(o.orderDate); };
  const vName = (id, fb) => (vendorsList.find(v => v.id === id) || {}).name || fb || 'Unknown vendor';

  // the tracking starts with the first order or "no order" logged (owner, 2026-10-11: the orders were emptied to start
  // clean): an order day before it is not "missed", there was nothing to compare with. Nothing logged yet = today.
  function trackStart() {
    let s = todayStr();
    ordersList.forEach(o => { const d = day10(o.orderDate); if (d && d < s) s = d; });
    skipsList.forEach(x => { if (x.skipDate && x.skipDate < s) s = x.skipDate; });
    return s;
  }

  function build(a) {
    const b = addDaysStr(a, 6), t = todayStr(), days = WD.map((_, i) => addDaysStr(a, i)), since = trackStart();
    const inW = d => !!d && day10(d) >= a && day10(d) <= b;
    const rows = new Map();
    const row = (id, name) => {
      if (!rows.has(id)) rows.set(id, { id, name, due: [], missed: [], sent: [], drafts: [], delivered: [], cancelled: [], skips: [], waiting: [] });
      return rows.get(id);
    };

    // order days of the week, and the ones nobody answered (no order sent, none cancelled, no "no order" logged
    // between 6 days before and the day after)
    vendorsList.forEach(v => days.forEach(d => {
      if (!isVendorDueOn(v, d)) return;
      const r = row(v.id, v.name); r.due.push(d);
      if (d >= t || d < since) return;
      const lo = addDaysStr(d, -6), hi = addDaysStr(d, 1);
      const answered = ordersList.some(o => o.vendorId === v.id && o.orderDate && day10(o.orderDate) >= lo && day10(o.orderDate) <= hi)
        || skipsList.some(s => s.vendorId === v.id && s.skipDate >= lo && s.skipDate <= hi);
      if (!answered) r.missed.push(d);
    }));

    // a draft cancelled before it was sent (VendorOrder.cancelDraft) was never sent
    const wasSent = o => ['pending', 'delivered', 'cancelled'].includes(o.status) && !/^Draft cancelled/.test(o.receiveNote || '');
    ordersList.forEach(o => {
      const r = () => row(o.vendorId, vName(o.vendorId, o.vendorName));
      if (o.status === 'not_sent' && inW(o.orderDate)) r().drafts.push(o);
      if (wasSent(o) && inW(o.orderDate)) r().sent.push(o);
      if (o.status === 'delivered' && inW(o.deliveredDate)) {
        const took = o.orderDate ? Math.max(0, diff(day10(o.orderDate), day10(o.deliveredDate))) : null;
        const lateBy = o.expectedDelivery ? diff(day10(o.expectedDelivery), day10(o.deliveredDate)) : null;
        r().delivered.push({ o, took, lateBy });
      }
      if (o.status === 'cancelled' && inW(cancelDay(o))) r().cancelled.push(o);
      // still waiting for an order expected this week (and, in the current week, the older ones too)
      const ex = day10(o.expectedDelivery);
      if (o.status === 'pending' && ex && ex < t && (inW(ex) || (a === mondayOf(t) && ex < a))) r().waiting.push(o);
    });
    skipsList.forEach(s => { if (inW(s.skipDate)) row(s.vendorId, vName(s.vendorId, s.vendorName)).skips.push(s); });

    const list = [...rows.values()].filter(r => r.sent.length || r.drafts.length || r.delivered.length || r.cancelled.length || r.skips.length || r.missed.length || r.waiting.length);
    const all = k => list.reduce((s, r) => s + r[k].length, 0);
    const dels = list.flatMap(r => r.delivered);
    const judged = dels.filter(x => x.lateBy !== null), late = judged.filter(x => x.lateBy > 0);
    const took = dels.filter(x => x.took !== null);
    const perDay = days.map(d => ({
      d,
      sent: ordersList.filter(o => wasSent(o) && day10(o.orderDate) === d).length,
      recv: ordersList.filter(o => o.status === 'delivered' && day10(o.deliveredDate) === d).length,
      no: skipsList.filter(s => s.skipDate === d).length,
      missed: list.filter(r => r.missed.includes(d)).length,
    }));
    return {
      a, b, t, days, list, perDay, since,
      k: {
        due: all('due'), sent: all('sent'), drafts: all('drafts'), delivered: dels.length, onTime: judged.length - late.length, judged: judged.length,
        late: late.length, waiting: all('waiting'), cancelled: all('cancelled'), skips: all('skips'), missed: all('missed'),
        avg: took.length ? Math.round(took.reduce((s, x) => s + x.took, 0) / took.length * 10) / 10 : null,
      },
    };
  }

  function render() {
    const box = el('vendorReport'); if (!box) return;
    wire();
    const t = todayStr();
    if (!S.start) S.start = mondayOf(t);
    const R = build(S.start), k = R.k, cur = S.start === mondayOf(t);
    el('vrLabel').textContent = `${cur ? 'This week' : 'Week'} · ${longDate(R.a)} – ${longDate(R.b)}`;
    el('vrThisWeek').style.display = cur ? 'none' : '';

    const tile = (n, label, sub, cls) => `<div class="vr-kpi ${cls || ''}"><b>${n}</b><span>${label}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
    const kpis = `<div class="vr-kpis">
      ${tile(k.sent, 'Orders sent', k.drafts ? `${k.drafts} still not sent` : `${k.due} order day${k.due === 1 ? '' : 's'} this week`)}
      ${tile(k.delivered, 'Delivered', k.avg !== null ? `avg ${k.avg} days` : '')}
      ${tile(k.judged ? `${k.onTime}/${k.judged}` : '—', 'On time', k.late ? `${k.late} late` : '', k.judged && k.late ? 'warn' : k.judged ? 'ok' : '')}
      ${tile(k.waiting, 'Still waiting', 'expected, not arrived', k.waiting ? 'bad' : '')}
      ${tile(k.missed, 'Missed orders', 'due, nothing done', k.missed ? 'bad' : '')}
      ${tile(k.cancelled, 'Cancelled', '', k.cancelled ? 'warn' : '')}
      ${tile(k.skips, 'No order', '')}
    </div>`;

    const strip = `<div class="vr-days">${R.perDay.map((p, i) => `<div class="vr-day ${p.d === t ? 'today' : ''} ${p.d > t ? 'future' : ''}">
        <div class="vr-dname">${WD[i]} <span>${dmy(p.d)}</span></div>
        <div><i class="dot sent"></i>${p.sent} sent</div><div><i class="dot recv"></i>${p.recv} received</div>
        ${p.no ? `<div><i class="dot no"></i>${p.no} no order</div>` : ''}${p.missed ? `<div class="bad"><i class="dot miss"></i>${p.missed} missed</div>` : ''}
      </div>`).join('')}</div>`;

    // what needs attention: missed order days, deliveries still waiting or late, cancellations
    const issues = [];
    R.list.forEach(r => {
      r.missed.forEach(d => issues.push({ r, w: 0, html: `<span class="badge danger">Missed</span> due ${WD[R.days.indexOf(d)]} ${dmy(d)}, no order sent and no "no order" logged` }));
      r.waiting.forEach(o => issues.push({ r, w: 1, html: `<span class="badge danger">Not arrived</span> sent ${dmy(o.orderDate)}, expected ${dmy(o.expectedDelivery)} (${diff(day10(o.expectedDelivery), t)}d late)` }));
      r.delivered.filter(x => x.lateBy > 0).forEach(x => issues.push({ r, w: 2, html: `<span class="badge warn">Late</span> sent ${dmy(x.o.orderDate)}, arrived ${dmy(x.o.deliveredDate)}: ${x.lateBy}d after the expected ${dmy(x.o.expectedDelivery)}` }));
      r.cancelled.forEach(o => issues.push({ r, w: 3, html: `<span class="badge danger">Cancelled</span> ${esc(o.receiveNote || '')}` }));
    });
    issues.sort((x, y) => x.w - y.w || x.r.name.localeCompare(y.r.name));
    const attention = `<div class="card"><h3 style="margin:0 0 10px;">Needs attention <span class="vb-n ${issues.length ? 'hot' : ''}">${issues.length}</span></h3>
      ${issues.length ? `<ul class="vr-issues">${issues.map(x => `<li><button type="button" class="vendor-link" data-vr-open="${esc(x.r.id)}">${esc(x.r.name)}</button><span>${x.html}</span></li>`).join('')}</ul>`
        : '<p class="muted-note" style="margin:0;">Nothing missed, late or cancelled this week.</p>'}</div>`;

    const bad = r => r.missed.length * 4 + r.waiting.length * 3 + r.cancelled.length * 2 + r.delivered.filter(x => x.lateBy > 0).length;
    const rows = R.list.slice().sort((x, y) => bad(y) - bad(x) || x.name.localeCompare(y.name));
    const dates = arr => arr.map(dmy).join(', ');
    const table = `<div class="card"><h3 style="margin:0 0 10px;">Vendors this week <span class="vb-n">${rows.length}</span></h3>
      ${rows.length ? `<div class="items-scroll"><table class="items vr-table"><thead><tr><th>Vendor</th><th>Due</th><th>Sent</th><th>Received</th><th>No order</th><th>Result</th></tr></thead><tbody>${rows.map(r => {
        const recv = r.delivered.map(x => `${dmy(x.o.deliveredDate)}${x.took !== null ? ` <span class="muted-note">${x.took}d</span>` : ''}${x.lateBy > 0 ? ` <em class="vr-late">+${x.lateBy}d</em>` : x.lateBy !== null ? ' <em class="vr-ok">✓</em>' : ''}`).join('<br>');
        const res = r.missed.length ? '<span class="badge danger">Missed</span>' : r.waiting.length ? '<span class="badge danger">Not arrived</span>' : r.cancelled.length ? '<span class="badge danger">Cancelled</span>'
          : r.delivered.some(x => x.lateBy > 0) ? '<span class="badge warn">Late</span>' : r.drafts.length ? '<span class="badge inactive">Not sent</span>'
          : r.delivered.length ? '<span class="badge active">Received</span>' : r.sent.length ? '<span class="badge warn">Awaiting</span>' : r.skips.length ? '<span class="badge inactive">No order</span>' : '<span class="muted-note">Upcoming</span>';
        return `<tr><td><button type="button" class="vendor-link" data-vr-open="${esc(r.id)}">${esc(r.name)}</button></td>
          <td class="mono">${dates(r.due) || '—'}</td>
          <td class="mono">${dates(r.sent.map(o => o.orderDate)) || '—'}${r.drafts.length ? ` <span class="muted-note">(${r.drafts.length} draft)</span>` : ''}</td>
          <td class="mono">${recv || '—'}</td>
          <td class="mono">${dates(r.skips.map(s => s.skipDate)) || '—'}</td>
          <td>${res}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted-note" style="margin:0;">No vendor activity this week.</p>'}</div>`;

    const since = R.since > R.a ? `<p class="muted-note" style="margin:10px 0 0;">Missed orders are counted from ${longDate(R.since)}, the first order or "no order" logged.</p>` : '';
    box.innerHTML = `<div class="card">${kpis}${strip}${since}</div>${attention}${table}`;
    box.querySelectorAll('[data-vr-open]').forEach(b => b.addEventListener('click', () => openVendorDetail(b.dataset.vrOpen)));
  }

  function wire() {
    const p = el('vrPrev'); if (!p || p.dataset.wired) return;
    p.dataset.wired = '1';
    p.addEventListener('click', () => { S.start = addDaysStr(S.start, -7); render(); });
    el('vrNext').addEventListener('click', () => { S.start = addDaysStr(S.start, 7); render(); });
    el('vrThisWeek').addEventListener('click', () => { S.start = mondayOf(todayStr()); render(); });
  }

  window.VendorReport = { render };
})();
