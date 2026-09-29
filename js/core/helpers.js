/* ============================================================
   Shared number helpers (Promotions and Sell-outs).
   ============================================================ */
// Excel's MROUND: nearest multiple (e.g. 0.05). Callers wrap it in round2() to drop float noise.
function mround(value, multiple) {
  if (!multiple) return value;
  return Math.round(value / multiple) * multiple;
}
// Every price and percentage is rounded to 2 decimal places wherever it's shown or saved,
// so numbers with long decimal tails (e.g. 45.9690001) always read clean.
function round2(v) {
  if (v === null || v === undefined || v === '') return v;
  const n = Number(v);
  if (isNaN(n)) return v;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
// A number from a spreadsheet cell or a text box: "1,234.50", " $3.5 ", 7 -> number; blank/garbage -> null.
function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d.,\-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
