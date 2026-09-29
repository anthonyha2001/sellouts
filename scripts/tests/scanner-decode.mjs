// Decodes generated barcode images with the app's scanner detector (native BarcodeDetector or the CDN ponyfill).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export default async function (page, { log }) {
  const codes = JSON.parse(readFileSync(process.env.CODES_FILE || join(tmpdir(), 'codes.json'), 'utf8'));
  const out = await page.evaluate(async codes => {
    const native = !!window.BarcodeDetector;
    const t0 = performance.now();
    const det = await Scanner.getDetector();
    const loadMs = Math.round(performance.now() - t0);
    const results = [];
    for (const c of codes) {
      const blob = await (await fetch('data:image/png;base64,' + c.png)).blob();
      const bmp = await createImageBitmap(blob);
      const t = performance.now();
      const found = await det.detect(bmp);
      results.push(`${c.b} ${c.t} -> ${found.map(f => f.rawValue + ' (' + f.format + ')').join(', ') || 'NOT READ'} in ${Math.round(performance.now() - t)} ms`);
    }
    return { native, loadMs, results };
  }, codes);
  log(`built-in BarcodeDetector: ${out.native ? 'yes' : 'no (CDN ponyfill used)'}; detector ready in ${out.loadMs} ms`);
  out.results.forEach(r => log(r));
}
