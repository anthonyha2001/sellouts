/* ============================================================
   Sell-outs › Trend (owner, 2026-10-06): next to each sell-out that has
   started, a small line of its daily units (the days before it in grey,
   its own days in colour) and an arrow with the change: units per day
   during the sell-out against the same number of days before it (at most
   30 + 30 days). Live from the system (lv-dashboard sales_daily), kept 30
   minutes. Read only.
   Public API: window.SelloutTrend = { fill(container) }.
   ============================================================ */
(function () {
  const cache = new Map();      // sell-out id + dates -> { at, html }
  const busy = new Set();
  const addDays = (s, k) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + k); return d.toLocaleDateString('en-CA'); };
  const span = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5) + 1;

  function svgLine(before, during) {
    const all = [...before, ...during], max = Math.max(1, ...all), W = 84, H = 22, step = all.length > 1 ? W / (all.length - 1) : W;
    const pt = (v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 4)).toFixed(1)}`;
    const pre = before.map((v, i) => pt(v, i)).join(' ');
    const post = during.map((v, i) => pt(v, i + before.length)).join(' ');
    const join = before.length && during.length ? `${pt(before[before.length - 1], before.length - 1)} ` : '';
    return `<svg class="st-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      ${before.length ? `<polyline points="${pre}" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-linejoin="round"/>` : ''}
      ${during.length ? `<polyline points="${join}${post}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
      ${before.length ? `<line x1="${((before.length - 0.5) * step).toFixed(1)}" y1="1" x2="${((before.length - 0.5) * step).toFixed(1)}" y2="${H - 1}" stroke="var(--line-strong)" stroke-dasharray="2 2"/>` : ''}
    </svg>`;
  }

  async function one(el, so) {
    const t = todayStr(), from = String(so.from || '').slice(0, 10), end = String(so.to || '').slice(0, 10);
    if (!from || from > t) { el.innerHTML = ''; return; }
    const to = end && end < t ? end : t;
    const len = Math.min(30, span(from, to)), dFrom = addDays(to, -(len - 1)) < from ? from : addDays(to, -(len - 1));
    const bTo = addDays(from, -1), bFrom = addDays(from, -len);
    const k = `${so.id}|${from}|${to}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 30 * 60e3) { el.innerHTML = hit.html; return; }
    if (busy.has(k)) return;
    const codes = [...new Set(pricedRowsOf(so).map(p => String(p.code || '').trim()).filter(Boolean))];
    if (!codes.length) { el.innerHTML = ''; return; }
    busy.add(k);
    el.innerHTML = '<span class="st-wait" title="Reading the sales…"></span>';
    try {
      const { data, error } = await sb.functions.invoke('lv-dashboard', { body: { action: 'sales_daily', codes, from: bFrom, to } });
      if (error || !data?.days) throw error || new Error('no answer');
      const series = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(Number(data.days[d]?.qty || 0)); return out; };
      const before = series(bFrom, bTo), during = series(dFrom, to);
      const avgB = before.reduce((s, v) => s + v, 0) / (before.length || 1), avgD = during.reduce((s, v) => s + v, 0) / (during.length || 1);
      const pct = avgB > 0 ? Math.round((avgD - avgB) / avgB * 100) : avgD > 0 ? null : 0;
      const tone = pct === null || pct >= 15 ? 'up' : pct <= -15 ? 'down' : 'flat';
      const arrow = tone === 'up' ? '<path d="M6 15l6-6 6 6"/>' : tone === 'down' ? '<path d="M6 9l6 6 6-6"/>' : '<path d="M5 12h14"/>';
      const fmt = v => (Math.round(v * 10) / 10).toLocaleString('en-US');
      const title = `${fmt(avgD)} units a day during the sell-out, ${fmt(avgB)} before it (same number of days)`;
      const html = `<span class="st-trend ${tone}" title="${title}">${svgLine(before, during)}
        <svg class="st-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${arrow}</svg>
        <b>${pct === null ? 'new' : (pct > 0 ? '+' : '') + pct + '%'}</b></span>`;
      cache.set(k, { at: Date.now(), html });
      document.querySelectorAll(`[data-trend="${CSS.escape(String(so.id))}"]`).forEach(x => { x.innerHTML = html; });
    } catch (e) { console.warn('trend', e); el.innerHTML = ''; }
    finally { busy.delete(k); }
  }

  // Every card of the list that shows a trend box (archived ones are left out: no point).
  function fill(container) {
    (container || document).querySelectorAll('[data-trend]').forEach(el => {
      const so = (typeof sellouts !== 'undefined' ? sellouts : []).find(s => String(s.id) === el.dataset.trend);
      if (so && !so.archived) one(el, so);
    });
  }
  window.SelloutTrend = { fill };
})();
