// Makes test inputs for the PDF / photo to Excel tool: a digital 2-page PDF of a supplier price
// list, and a "photo" (PNG, slightly rotated, grey background) of the same table.
//   node scripts/tests/make-table-files.mjs  ->  <tmp>/lv-pricelist.pdf, <tmp>/lv-pricelist-photo.jpg
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rows = [
  ['0012345678905', 'Olive oil extra virgin 1L', '12.50', '10'],
  ['5281018709276', 'Tahini 454g', '4.25', '24'],
  ['96385074', 'Pasta spaghetti 500g', '1.10', '48'],
  ['6221155045678', 'Tuna chunks in oil 160g', '2.75', '36'],
  ['5287654321098', 'Basmati rice 5kg', '14.90', '6'],
  ['7613035678901', 'Instant coffee 200g', '9.60', '12'],
];
const table = rs => `<table><thead><tr><th>Item code</th><th>Description</th><th>Price USD</th><th>Qty</th></tr></thead>
  <tbody>${rs.map(r => `<tr>${r.map((c, i) => `<td class="${i >= 2 ? 'n' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const css = `body{font-family:Arial,sans-serif;margin:40px;color:#111} h1{font-size:22px;margin:0 0 4px} p{margin:0 0 18px;color:#444}
  table{border-collapse:collapse;width:100%} th,td{padding:8px 10px;text-align:left;font-size:15px} th{border-bottom:2px solid #333}
  td{border-bottom:1px solid #ccc} td.n{text-align:right} .pb{page-break-before:always}`;

const exe = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage();
await page.setContent(`<style>${css}</style><h1>Golden Food S.A.L — Price list September 2026</h1><p>Prices in USD, VAT excluded.</p>${table(rows.slice(0, 4))}
  <div class="pb"></div><h1>Golden Food S.A.L — Price list September 2026</h1>${table(rows.slice(4))}`);
const pdf = join(tmpdir(), 'lv-pricelist.pdf');
await page.pdf({ path: pdf, format: 'A4' });

await page.setViewportSize({ width: 1100, height: 700 });
await page.setContent(`<style>${css} body{background:#d9d6cf;margin:0;padding:40px} .sheet{background:#fbfaf6;padding:36px;transform:rotate(-1.2deg);box-shadow:0 6px 24px rgba(0,0,0,.25)}</style>
  <div class="sheet"><h1>Golden Food S.A.L — Price list</h1><p>Prices in USD.</p>${table(rows)}</div>`);
const photo = join(tmpdir(), 'lv-pricelist-photo.jpg');
await page.screenshot({ path: photo, type: 'jpeg', quality: 80, fullPage: true });
await browser.close();
console.log(pdf); console.log(photo);
