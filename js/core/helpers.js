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

/* ---------------- barcodes ---------------- */
// Header names that mean "barcode" (compared lower-case, letters/digits only).
const BARCODE_HEADERS = ['barcode', 'barcodes', 'ean', 'eancode', 'ean13', 'upc', 'upccode', 'gtin'];

// A barcode cell as text. Excel often stores barcodes as numbers: use the exact integer, never the
// display text (which can turn into "5.28102E+12"). Text cells are kept as typed (leading zeros).
function barcodeCellText(ws, r, c) {
  if (c < 0) return '';
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'n' && Number.isFinite(cell.v)) return Number.isInteger(cell.v) ? String(cell.v) : String(Math.round(cell.v));
  return String(cell.v);
}

// "6221234567890 / 6221234567891; 0123..." -> ['6221234567890', '6221234567891', '0123...'] (digits only).
function splitBarcodes(text) {
  return String(text ?? '').split(/[\/,;|\s]+/).map(s => s.replace(/\D/g, '')).filter(s => s.length >= 6);
}

// Check digit for EAN-8, UPC-A (12), EAN-13 and GTIN-14. Other lengths: false.
function isValidBarcode(code) {
  const s = String(code ?? '');
  if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  // Weights 3,1,3,1... from the digit next to the check digit, going left.
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
