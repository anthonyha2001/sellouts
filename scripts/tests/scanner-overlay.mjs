// End to end: a fake camera shows barcode images one after another; the scanner must beep and show
// each read in the big card at the bottom (green for a good read), the previous ones listed under it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export default async function (page, { log }) {
  const codes = JSON.parse(readFileSync(process.env.CODES_FILE || join(tmpdir(), 'codes.json'), 'utf8')).filter(c => c.b === 'ean13').slice(0, 2);
  await page.evaluate(async codes => {
    const imgs = await Promise.all(codes.map(async c => createImageBitmap(await (await fetch('data:image/png;base64,' + c.png)).blob())));
    const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
    const ctx = cv.getContext('2d'); let i = 0;
    const draw = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 480); const im = imgs[Math.min(i, imgs.length - 1)]; ctx.drawImage(im, (640 - im.width) / 2, (480 - im.height) / 2); };
    setInterval(draw, 50); draw();
    setTimeout(() => { i = 1; }, 2500);
    const stream = cv.captureStream(20);
    navigator.mediaDevices.getUserMedia = async () => stream;
    window.__beeps = [];
    // count beeps by watching oscillators
    const O = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { window.__beeps.push(Date.now()); return O.call(this); };
    Labels.show();
  }, codes);
  await page.waitForTimeout(800);
  await page.click('#lbScan');
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => ({
    last: document.getElementById('scanLast').textContent.replace(/\s+/g, ' ').trim(),
    hidden: document.getElementById('scanLast').hidden,
    flash: document.getElementById('scanLast').className,
    history: [...document.querySelectorAll('#scanHistory li')].map(l => l.textContent.replace(/\s+/g, ' ').trim()),
    oscillators: window.__beeps.length,
  }));
  log('big card:', r.last, '| visible:', !r.hidden, '|', r.flash);
  log('previous:', JSON.stringify(r.history));
  log('beep tones played:', r.oscillators);
}
