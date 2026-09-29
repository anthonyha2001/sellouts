/* ============================================================
   Camera barcode scanner, shared by Labels and the floor check.
   Continuous and fast: every code read fires onCode at once with a
   beep + vibration; no button press per item. The same code held in
   front of the camera is not repeated until it has left the view.
   Uses the browser's BarcodeDetector (Android Chrome); where it is
   missing (iPhone Safari, desktops) the same API is loaded from the
   CDN (barcode-detector, ZXing WebAssembly), only when first needed.
   Public API: Scanner.open({ title, onCode, continuous }) -> close().
   ============================================================ */
const Scanner = (function () {
  const PONYFILL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/ponyfill/+esm';
  const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'];
  const REPEAT_GAP_MS = 1200;       // same code again only after it has been out of view this long
  let detectorPromise = null, audioCtx = null;
  let S = null;                      // the open session

  async function getDetector() {
    if (!detectorPromise) detectorPromise = (async () => {
      let Detector = window.BarcodeDetector;
      if (Detector) {
        try {
          const supported = await Detector.getSupportedFormats();
          if (!supported.includes('ean_13')) Detector = null;
        } catch (e) { Detector = null; }
      }
      if (!Detector) Detector = (await import(PONYFILL)).BarcodeDetector;
      const detector = new Detector({ formats: FORMATS });
      // The first detect() loads the decoder (~1-2 s on the CDN version): do it now, not on the first scan.
      try { await detector.detect(new ImageData(8, 8)); } catch (e) { /* warm-up only */ }
      return detector;
    })().catch(e => { detectorPromise = null; throw e; });
    return detectorPromise;
  }

  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 1760; o.type = 'square';
      g.gain.setValueAtTime(0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.09);
      o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.1);
    } catch (e) { /* no sound */ }
    try { navigator.vibrate && navigator.vibrate(60); } catch (e) { /* no vibration */ }
  }

  function ensureOverlay() {
    let ov = document.getElementById('scanOverlay');
    if (ov) return ov;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="scan-overlay" id="scanOverlay" role="dialog" aria-label="Barcode scanner">
        <video id="scanVideo" playsinline muted></video>
        <div class="scan-frame" aria-hidden="true"><span></span></div>
        <div class="scan-top">
          <b id="scanTitle"></b>
          <div class="scan-top-actions">
            <button type="button" class="scan-btn" id="scanTorch" hidden aria-label="Flashlight">Light</button>
            <button type="button" class="scan-btn" id="scanClose">Done</button>
          </div>
        </div>
        <div class="scan-bottom"><div id="scanStatus">Starting the camera…</div><div id="scanLast"></div></div>
      </div>`);
    ov = document.getElementById('scanOverlay');
    document.getElementById('scanClose').onclick = () => close();
    return ov;
  }

  async function open({ title = 'Scan', onCode, continuous = true, lastHtml = null } = {}) {
    if (S) close();
    const ov = ensureOverlay();
    S = { onCode, continuous, lastHtml, stream: null, running: true, seen: new Map(), busy: false };
    document.getElementById('scanTitle').textContent = title;
    document.getElementById('scanLast').innerHTML = '';
    ov.classList.add('open');
    const status = document.getElementById('scanStatus');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera. Use Chrome or Safari, or type the barcode.');
      const [stream, detector] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }),
        getDetector(),
      ]);
      if (!S || !S.running) { stream.getTracks().forEach(t => t.stop()); return; }
      S.stream = stream; S.detector = detector;
      const video = document.getElementById('scanVideo');
      video.srcObject = stream;
      await video.play();
      status.textContent = continuous ? 'Point the camera at barcodes' : 'Point the camera at the barcode';
      setupTorch(stream);
      loop(video);
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      status.textContent = denied ? 'Camera permission was refused. Allow the camera for this site in the browser settings.'
        : (e && e.message) || 'Could not start the camera.';
    }
  }

  function setupTorch(stream) {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const btn = document.getElementById('scanTorch');
    if (!caps.torch) { btn.hidden = true; return; }
    let on = false;
    btn.hidden = false;
    btn.onclick = async () => { on = !on; try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle('on', on); } catch (e) { /* not available */ } };
  }

  async function loop(video) {
    if (!S || !S.running) return;
    if (!S.busy && video.readyState >= 2) {
      S.busy = true;
      try {
        const codes = await S.detector.detect(video);
        const now = Date.now();
        for (const c of codes) {
          const value = String(c.rawValue || '').trim();
          if (!value) continue;
          const last = S.seen.get(value);
          S.seen.set(value, now);
          if (last && now - last < REPEAT_GAP_MS) continue;   // still the same item in view
          beep();
          const html = await S.onCode(value, c.format);
          if (!S) return;
          document.getElementById('scanLast').innerHTML = html || `<span class="scan-code">${escapeHtml(value)}</span>`;
          if (!S.continuous) { close(); return; }
        }
      } catch (e) { /* a frame that could not be read: keep going */ }
      if (S) S.busy = false;
    }
    requestAnimationFrame(() => loop(video));
  }

  function close() {
    if (!S) return;
    S.running = false;
    if (S.stream) S.stream.getTracks().forEach(t => t.stop());
    const video = document.getElementById('scanVideo');
    if (video) video.srcObject = null;
    document.getElementById('scanOverlay')?.classList.remove('open');
    S = null;
  }

  // Pages that scan call this when they open, so the first scan is instant.
  const warmUp = () => { getDetector().catch(() => {}); };
  return { open, close, getDetector, warmUp, isOpen: () => !!S };
})();
