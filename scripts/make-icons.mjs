// Builds the app icons from the La Valeur logo (square JPG, white logo on blue):
//   node scripts/make-icons.mjs <logo.jpg>
// Writes icons/: icon-192.png, icon-512.png, maskable-512.png (logo inside the safe zone),
// apple-touch-icon.png (180), favicon-32.png, badge-96.png (white mark on transparent, for
// notification badges), logo.png (512, for the login screen). Prints the logo's blue.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/make-icons.mjs <logo.jpg>'); process.exit(1); }
const out = resolve('icons'); mkdirSync(out, { recursive: true });
const dataUrl = 'data:image/jpeg;base64,' + readFileSync(src).toString('base64');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
const res = await page.evaluate(async url => {
  const img = new Image(); img.src = url; await img.decode();
  const probe = document.createElement('canvas'); probe.width = img.width; probe.height = img.height;
  const p = probe.getContext('2d'); p.drawImage(img, 0, 0);
  // the blue: average of the four corners
  const px = [[4, 4], [img.width - 5, 4], [4, img.height - 5], [img.width - 5, img.height - 5]].map(([x, y]) => p.getImageData(x, y, 1, 1).data);
  const avg = i => Math.round(px.reduce((s, d) => s + d[i], 0) / px.length);
  const hex = '#' + [0, 1, 2].map(i => avg(i).toString(16).padStart(2, '0')).join('').toUpperCase();
  const make = (size, scale = 1, bg = hex) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.fillStyle = bg; g.fillRect(0, 0, size, size);
    const s = size * scale; g.drawImage(img, (size - s) / 2, (size - s) / 2, s, s);
    return c.toDataURL('image/png');
  };
  // Badge: white parts of the logo only (the sun mark), on transparent.
  const badge = (() => {
    const size = 96, c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    // the mark sits in the top ~55% of the square; crop it
    g.drawImage(img, img.width * 0.18, img.height * 0.17, img.width * 0.64, img.height * 0.40, 0, size * 0.1, size, size * 0.62);
    const d = g.getImageData(0, 0, size, size);
    for (let i = 0; i < d.data.length; i += 4) { const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3; const a = Math.max(0, Math.min(255, (lum - 140) * 2.2)); d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; d.data[i + 3] = a; }
    g.putImageData(d, 0, 0); return c.toDataURL('image/png');
  })();
  return { hex, files: {
    'icon-192.png': make(192), 'icon-512.png': make(512), 'maskable-512.png': make(512, 0.78),
    'apple-touch-icon.png': make(180), 'favicon-32.png': make(32), 'logo.png': make(512), 'badge-96.png': badge,
  } };
}, dataUrl);
for (const [name, url] of Object.entries(res.files)) writeFileSync(resolve(out, name), Buffer.from(url.split(',')[1], 'base64'));
await browser.close();
console.log('logo blue:', res.hex, '→', Object.keys(res.files).join(', '));
