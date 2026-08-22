/* =========================================================
   Cartoon Cam — applicazione
   Il motore di stilizzazione sta in engine.js.

   L'uscita di questa app e' pensata per essere data in pasto a un
   modello generativo che deve costruire un personaggio. Da qui due
   scelte non ovvie:

   1. l'identita' si dichiara con una FOTO BONIFICATA, non con una
      foto stilizzata: i modelli trattano gli artefatti dello stile
      (retino, grana, contorni spessi) come tratti della persona;
   2. lo stile si dichiara a parole o con un riferimento separato.

   Per questo lo scatto produce una COPPIA di immagini, identita' e
   stile, piu' un testo pronto da incollare.
   ========================================================= */

const $ = (s) => document.querySelector(s);
const intro = $('#intro'), errorScreen = $('#error'), stage = $('#stage'), preview = $('#preview');
const video = $('#video'), canvas = $('#canvas'), overlay = $('#cropOverlay');
const amountInput = $('#amount'), effectsBar = $('#effects'), effectName = $('#effectName');
const filePick = $('#filePick'), fileShot = $('#fileShot');

const PREVIEW_MAX = 900;
const CROP_RATIO = 4 / 5;              // fotogramma verticale: piu' pixel sul viso

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

let renderer = null, stream = null, track = null, raf = 0;
let mode = 'fotocamera';
let photo = null;
let facing = store.get('facing', 'user');
let effect = FRAG[store.get('effect', '')] ? store.get('effect', 'inchiostro') : 'inchiostro';
let lastStyle = effect === 'ritratto' ? 'cartoon' : effect;
let amount = Number(store.get('amount', 70)) / 100;
let clean = store.get('clean', '1') === '1';
let pairOn = store.get('pair', '0') === '1';
let bgOn = store.get('bg', '0') === '1';
let carOn = store.get('car', '0') === '1';
let car = Number(store.get('carAmt', 50)) / 100;
let analisi = null;                   // volto e maschera dell'anteprima
let frozen = false, hasFrame = false, startTime = 0, quality = 1;
let recorder = null, recChunks = [], recTimer = 0, recStart = 0;
let results = [];
const crop = { on: false, rect: null };
const detailCanvas = document.createElement('canvas');
const midCanvas = document.createElement('canvas');
const baseCanvas = document.createElement('canvas');

/* ---------------------------------------------------------
   Effetti e comandi
   --------------------------------------------------------- */

EFFECTS.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'chip' + (e.id === 'ritratto' ? ' chip-id' : '');
  b.type = 'button';
  b.dataset.id = e.id;
  b.setAttribute('aria-pressed', String(e.id === effect));
  b.innerHTML = `<span class="em">${e.emoji}</span>${e.name}`;
  b.addEventListener('click', () => { setEffect(e.id); redrawIfPhoto(); });
  effectsBar.appendChild(b);
});

function setEffect(id) {
  effect = id;
  if (id !== 'ritratto') lastStyle = id;
  store.set('effect', id);
  const meta = EFFECTS.find((e) => e.id === id);
  effectName.textContent = meta ? `${meta.emoji} ${meta.name}` : id;
  effectsBar.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.id === id)));
  const active = effectsBar.querySelector('[aria-pressed="true"]');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

amountInput.value = String(Math.round(amount * 100));
amountInput.addEventListener('input', () => {
  amount = Number(amountInput.value) / 100;
  store.set('amount', amountInput.value);
  redrawIfPhoto();
});

const cleanBtn = $('#btnClean');
function syncClean() {
  cleanBtn.setAttribute('aria-pressed', String(clean));
  cleanBtn.title = clean ? 'Senza grana, retino e vignettatura' : 'Con grana, retino e vignettatura';
}
cleanBtn.addEventListener('click', () => {
  clean = !clean;
  store.set('clean', clean ? '1' : '0');
  syncClean();
  showToast(clean ? 'Superfici pulite: pronte per l’AI' : 'Grana e retino attivi: bello da vedere, non da dare all’AI', 2800);
  redrawIfPhoto();
});
syncClean();

const pairBtn = $('#btnPair');
function syncPair() { pairBtn.setAttribute('aria-pressed', String(pairOn)); }
pairBtn.addEventListener('click', () => {
  pairOn = !pairOn;
  store.set('pair', pairOn ? '1' : '0');
  syncPair();
  showToast(pairOn ? 'Lo scatto produce identità + stile' : 'Lo scatto produce solo l’immagine mostrata', 2600);
});
syncPair();

/* ---------------------------------------------------------
   Fotocamera (anteprima dal vivo)
   --------------------------------------------------------- */

async function startCamera() {
  if (!window.isSecureContext) {
    return fail('La fotocamera funziona solo su indirizzi sicuri (https://) oppure su localhost.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return fail('Questo browser non permette l’accesso alla fotocamera. Prova con Chrome o Safari aggiornati.');
  }
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: facing === 'user' ? { ideal: 'user' } : { ideal: 'environment' },
        width: { ideal: 2560 }, height: { ideal: 1440 },
      },
    });
  } catch (err) {
    return fail(describeError(err));
  }
  track = stream.getVideoTracks()[0] || null;

  video.srcObject = stream;
  try { await video.play(); } catch (e) {}

  showStage();
  if (!ensureRenderer()) return;
  setMode('fotocamera');
  setEffect(effect);
  if (!store.get('hintSeen', '')) {
    showToast('Tocca il video per nascondere i comandi', 3600);
    store.set('hintSeen', '1');
  }
  frozen = false; hasFrame = false; quality = 1;
  startTime = performance.now();
  loop();
}

function ensureRenderer() {
  if (renderer) return true;
  try { renderer = new Renderer(canvas); return true; }
  catch (err) { fail(err.message); return false; }
}

function showStage() {
  intro.classList.add('hidden');
  errorScreen.classList.add('hidden');
  stage.classList.remove('hidden');
}

function describeError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'Permesso negato. Tocca il lucchetto (o “aA”) nella barra degli indirizzi, consenti la fotocamera e riprova.';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Nessuna fotocamera trovata su questo dispositivo.';
  if (n === 'NotReadableError') return 'La fotocamera è occupata da un’altra app. Chiudila e riprova.';
  return 'Errore: ' + (err && err.message ? err.message : 'sconosciuto');
}

function fail(msg) {
  cancelAnimationFrame(raf);
  stopStream();
  stage.classList.add('hidden');
  intro.classList.add('hidden');
  errorScreen.classList.remove('hidden');
  $('#errorMsg').textContent = msg;
}

function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; track = null;
}

let frames = 0, fpsMark = 0;

function loop() {
  raf = requestAnimationFrame(loop);
  if (mode !== 'fotocamera') return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;

  const k = Math.min(1, (PREVIEW_MAX * quality) / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * k)), h = Math.max(2, Math.round(vh * k));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  if (!frozen) { renderer.load(video, vw, vh, { midCanvas, baseCanvas, detailCanvas, outSide: Math.max(canvas.width, canvas.height) }); hasFrame = true; }
  if (!hasFrame) return;

  renderer.draw(effect, {
    width: canvas.width, height: canvas.height, amount, clean,
    time: (performance.now() - startTime) / 1000, flip: facing === 'user',
    useMask: false, car: 0,          // dal vivo servirebbe il rilevamento a ogni frame
  });

  frames++;
  const now = performance.now();
  if (!fpsMark) fpsMark = now;
  if (now - fpsMark > 2000) {
    const fps = (frames * 1000) / (now - fpsMark);
    if (fps < 24 && quality > 0.55) quality = Math.max(0.55, quality - 0.15);
    else if (fps > 52 && quality < 1) quality = Math.min(1, quality + 0.1);
    frames = 0; fpsMark = now;
  }
}

/* ---------------------------------------------------------
   Modo foto
   --------------------------------------------------------- */

function setMode(m) {
  mode = m;
  stage.classList.toggle('photo-mode', m === 'foto');
  $('#modeLabel').textContent = m === 'foto' ? 'Foto' : '';
  if (m !== 'foto') { crop.on = false; syncCrop(); }
}

[filePick, fileShot].forEach((input) => {
  input.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    await loadPhoto(file);
  });
});

async function loadPhoto(file) {
  showToast('Carico la foto…', 1600);
  let src = null;
  try {
    src = await createImageBitmap(file);            // Safari ignora le opzioni: non ci contiamo
  } catch (e) {
    try { src = await loadViaImg(file); } catch (e2) { src = null; }
  }
  if (!src) return showToast('Non riesco a leggere questa immagine. Se è un HEIC, riprova salvandola come JPEG.', 4200);

  if (photo && photo.source && photo.source.close) photo.source.close();
  photo = { source: src, w: src.width || src.naturalWidth, h: src.height || src.naturalHeight };

  showStage();
  cancelAnimationFrame(raf);
  stopStream();
  if (!ensureRenderer()) return;
  setMode('foto');
  analisi = null;
  renderer.setFace(null);
  renderer.setMask(null);
  resetCrop();
  crop.on = true; syncCrop();
  drawPhoto();
  showToast(`Foto ${photo.w}×${photo.h}. Sposta il riquadro su una sola persona.`, 4600);
  if (bgOn || carOn) { if (await preparaVolto()) await analizzaAnteprima(); }
}

function loadViaImg(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { res(im); setTimeout(() => URL.revokeObjectURL(url), 5000); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('immagine illeggibile')); };
    im.src = url;
  });
}

function drawPhoto() {
  if (!photo || !renderer) return;
  const k = Math.min(1, PREVIEW_MAX / Math.max(photo.w, photo.h));
  const w = Math.max(2, Math.round(photo.w * k)), h = Math.max(2, Math.round(photo.h * k));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  renderer.load(photo.source, photo.w, photo.h, { outSide: Math.max(w, h) });
  renderer.draw(effect, Object.assign({ width: w, height: h, amount, clean, time: 3, flip: false }, extra()));
  drawOverlay();
}

function redrawIfPhoto() { if (mode === 'foto') drawPhoto(); }

/* Opzioni che valgono sia per l'anteprima sia per l'esportazione. */
function extra() {
  return { useMask: bgOn, bg: [0.88, 0.88, 0.90], car: carOn ? car : 0 };
}

/* ---------------------------------------------------------
   Rilevamento del volto e dello sfondo

   Gira in locale: i modelli sono serviti dal sito stesso e pesano
   circa 16 MB, quindi si caricano solo quando servono davvero.
   --------------------------------------------------------- */

async function preparaVolto() {
  if (Face.stato === 'pronto') return true;
  showToast('Carico il rilevatore del volto: 16 MB, solo la prima volta…', 8000);
  const ok = await Face.prepara();
  if (!ok) showToast('Rilevatore non disponibile su questo browser' + (Face.errore ? ': ' + Face.errore : ''), 5000);
  return ok;
}

/* Analisi per l'ANTEPRIMA: sull'immagine intera, che e' quella
   mostrata. Il ritaglio viene analizzato a parte al momento
   dell'esportazione, perche' i punti sono in coordinate normalizzate
   e cambiano con l'inquadratura. */
async function analizzaAnteprima() {
  if (!photo || Face.stato !== 'pronto') return;
  const piccolo = downscale(photo.source, photo.w, photo.h, 512);
  const r = await Face.analizza(piccolo, piccolo.width, piccolo.height);
  analisi = r;
  renderer.setFace(r.volto);
  renderer.setMask(r.maschera);
  if (!r.volto && carOn) showToast('Non trovo un volto: la caricatura resta spenta', 3600);
  drawPhoto();
}

const bgBtn = $('#btnBg'), carBtn = $('#btnCar'), carRow = $('#carRow'), carInput = $('#carAmount');

function syncExtra() {
  bgBtn.setAttribute('aria-pressed', String(bgOn));
  carBtn.setAttribute('aria-pressed', String(carOn));
  carRow.classList.toggle('hidden', !carOn);
}

bgBtn.addEventListener('click', async () => {
  if (mode !== 'foto') return showToast('Funziona sulle foto, non sull’anteprima dal vivo', 3000);
  bgOn = !bgOn;
  store.set('bg', bgOn ? '1' : '0');
  syncExtra();
  if (bgOn && !(await preparaVolto())) { bgOn = false; syncExtra(); return; }
  if (bgOn && !analisi) await analizzaAnteprima(); else drawPhoto();
});

carBtn.addEventListener('click', async () => {
  if (mode !== 'foto') return showToast('Funziona sulle foto, non sull’anteprima dal vivo', 3000);
  carOn = !carOn;
  store.set('car', carOn ? '1' : '0');
  syncExtra();
  if (carOn && !(await preparaVolto())) { carOn = false; syncExtra(); return; }
  if (carOn && !analisi) await analizzaAnteprima(); else drawPhoto();
});

carInput.value = String(Math.round(car * 100));
carInput.addEventListener('input', () => {
  car = Number(carInput.value) / 100;
  store.set('carAmt', carInput.value);
  redrawIfPhoto();
});
syncExtra();

/* ---------------------------------------------------------
   Ritaglio guidato

   Il riquadro e' verticale e fisso di proporzioni: si sposta e si
   ridimensiona sull'immagine ferma. Le guide interne indicano dove
   mettere la testa: un riferimento utile ha il volto sul 40-60% del
   fotogramma e un margine sopra la fronte, altrimenti il rilevamento
   dei tratti facciali dei modelli di identita' fallisce.
   --------------------------------------------------------- */

function resetCrop() {
  if (!photo) return;
  const w = Math.min(photo.w, photo.h * CROP_RATIO) * 0.62;
  const h = w / CROP_RATIO;
  crop.rect = { x: (photo.w - w) / 2, y: (photo.h - h) / 2, w, h };
  clampCrop();
}

function clampCrop() {
  const r = crop.rect; if (!r || !photo) return;
  const maxW = Math.min(photo.w, photo.h * CROP_RATIO);
  r.w = Math.max(maxW * 0.18, Math.min(maxW, r.w));
  r.h = r.w / CROP_RATIO;
  r.x = Math.max(0, Math.min(photo.w - r.w, r.x));
  r.y = Math.max(0, Math.min(photo.h - r.h, r.y));
}

/* Rettangolo occupato dal contenuto del canvas dentro l'elemento
   (in modo foto il canvas usa object-fit: contain). */
function contentRect() {
  const el = canvas.getBoundingClientRect();
  const ca = canvas.width / canvas.height, ea = el.width / el.height;
  let w = el.width, h = el.height, x = 0, y = 0;
  if (ca > ea) { h = el.width / ca; y = (el.height - h) / 2; }
  else { w = el.height * ca; x = (el.width - w) / 2; }
  return { x: el.left + x, y: el.top + y, w, h };
}

function drawOverlay() {
  if (mode !== 'foto' || !crop.on || !photo || !crop.rect) {
    overlay.classList.add('hidden');
    return;
  }
  overlay.classList.remove('hidden');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = overlay.getBoundingClientRect();
  const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }

  const g = overlay.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, box.width, box.height);

  const c = contentRect();
  const s = c.w / photo.w;                       // pixel schermo per pixel sorgente
  const rx = c.x - box.left + crop.rect.x * s;
  const ry = c.y - box.top + crop.rect.y * s;
  const rw = crop.rect.w * s, rh = crop.rect.h * s;

  g.fillStyle = 'rgba(6,6,12,.62)';
  g.fillRect(0, 0, box.width, ry);
  g.fillRect(0, ry + rh, box.width, box.height - ry - rh);
  g.fillRect(0, ry, rx, rh);
  g.fillRect(rx + rw, ry, box.width - rx - rw, rh);

  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.strokeRect(rx, ry, rw, rh);

  // zona della testa e linea degli occhi
  g.setLineDash([6, 6]);
  g.strokeStyle = 'rgba(255,255,255,.75)';
  g.lineWidth = 1.5;
  const headH = rh * 0.60, headW = headH * 0.72;
  g.beginPath();
  g.ellipse(rx + rw / 2, ry + rh * 0.08 + headH / 2, headW / 2, headH / 2, 0, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(rx + rw * 0.12, ry + rh * 0.34);
  g.lineTo(rx + rw * 0.88, ry + rh * 0.34);
  g.stroke();
  g.setLineDash([]);

  // maniglie agli angoli
  g.fillStyle = '#fff';
  const hs = 9;
  [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(([x, y]) => {
    g.fillRect(x - hs / 2, y - hs / 2, hs, hs);
  });

  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = '600 12px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('occhi qui', rx + rw / 2, ry + rh * 0.31);
}

const pointers = new Map();
let pinchStart = 0, rectStart = null;

overlay.addEventListener('pointerdown', (ev) => {
  if (!crop.on) return;
  overlay.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  rectStart = Object.assign({}, crop.rect);
  if (pointers.size === 2) pinchStart = pinchDistance();
  ev.preventDefault();
});

overlay.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId) || !crop.rect) return;
  const prev = pointers.get(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  const c = contentRect();
  const s = c.w / photo.w;

  if (pointers.size >= 2) {
    const d = pinchDistance();
    if (pinchStart > 0 && d > 0) {
      const cx = crop.rect.x + crop.rect.w / 2, cy = crop.rect.y + crop.rect.h / 2;
      crop.rect.w = rectStart.w * (pinchStart / d);
      clampCrop();
      crop.rect.x = cx - crop.rect.w / 2;
      crop.rect.y = cy - crop.rect.h / 2;
      clampCrop();
    }
  } else {
    crop.rect.x += (ev.clientX - prev.x) / s;
    crop.rect.y += (ev.clientY - prev.y) / s;
    clampCrop();
  }
  drawOverlay();
  ev.preventDefault();
});

['pointerup', 'pointercancel'].forEach((t) => overlay.addEventListener(t, (ev) => {
  pointers.delete(ev.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  rectStart = crop.rect ? Object.assign({}, crop.rect) : null;
}));

function pinchDistance() {
  const p = [...pointers.values()];
  if (p.length < 2) return 0;
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}

const cropBtn = $('#btnCrop');
function syncCrop() {
  cropBtn.setAttribute('aria-pressed', String(crop.on));
  drawOverlay();
}
cropBtn.addEventListener('click', () => {
  if (mode !== 'foto') return;
  crop.on = !crop.on;
  if (crop.on && !crop.rect) resetCrop();
  syncCrop();
  showToast(crop.on ? 'Trascina il riquadro, pizzica per ridimensionarlo' : 'Ritaglio disattivato: esporta l’immagine intera', 3000);
});

window.addEventListener('resize', () => { if (mode === 'foto') drawOverlay(); });
window.addEventListener('orientationchange', () => setTimeout(drawOverlay, 300));

/* ---------------------------------------------------------
   Esportazione
   --------------------------------------------------------- */

function targetLong() {
  const v = $('#exportSize').value;
  return v === 'max' ? Infinity : Number(v);
}

/* Ritaglia e riduce con una piramide di dimezzamenti: un solo
   drawImage con fattore alto salta pixel e produce aliasing. */
function cropAndFit(src, rect, longSide) {
  const rw = Math.round(rect.w), rh = Math.round(rect.h);
  if (!canvasFits(rw, rh)) {
    // sorgente troppo grande per questo dispositivo: si riduce subito
    const k = Math.sqrt((12 * 1024 * 1024) / (rw * rh));
    return drawCrop(src, rect, Math.round(rw * k), Math.round(rh * k));
  }
  const inter = drawCrop(src, rect, rw, rh);
  const want = Math.min(longSide, Math.max(rw, rh));
  if (want >= Math.max(rw, rh)) return inter;
  const out = downscale(inter, rw, rh, want);
  inter.width = inter.height = 0;
  return out;
}

function drawCrop(src, rect, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src.source, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return cv;
}

function renderFull(source, w, h, opts, volto, maschera) {
  const cap = renderer ? renderer.maxTexture : 4096;
  let ow = w, oh = h;
  const k = Math.min(1, cap / Math.max(w, h));
  ow = Math.max(2, Math.round(w * k)); oh = Math.max(2, Math.round(h * k));
  while (!canvasFits(ow, oh) && ow > 512) { ow = Math.round(ow * 0.75); oh = Math.round(oh * 0.75); }

  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const r = new Renderer(out);
  r.load(source, w, h, { outSide: Math.max(ow, oh) });
  r.setFace(volto || null);
  r.setMask(maschera || null);
  r.draw(opts.effect, Object.assign({
    width: ow, height: oh, amount: opts.amount, clean: opts.clean, time: 3, flip: opts.flip,
  }, extra()));
  if (r.uploadError) showToast('Questo telefono non regge questa risoluzione: prova 1024 px', 4200);
  // il contesto va liberato SOLO dopo la lettura del canvas: perderlo
  // svuota il drawing buffer e il file uscirebbe vuoto
  return { canvas: out, release: () => { r.dispose(); out.width = out.height = 0; } };
}

function toBlob(cv, type, q) {
  return new Promise((res) => cv.toBlob((b) => res(b), type, q));
}

async function exportOne(effectId, source, w, h, flip, volto, maschera) {
  const job = renderFull(source, w, h, { effect: effectId, amount, clean, flip }, volto, maschera);
  const long = Math.max(job.canvas.width, job.canvas.height);
  // PNG fino a 2048 px (nessun artefatto sui tratti fini); oltre, JPEG,
  // perche' un PNG da 12 Mpx supera i 40 MB e su iOS non si codifica.
  const type = long <= 2048 ? 'image/png' : 'image/jpeg';
  const size = `${job.canvas.width}×${job.canvas.height}`;
  const blob = await toBlob(job.canvas, type, 0.92);
  job.release();
  if (!blob) return null;
  const meta = EFFECTS.find((e) => e.id === effectId) || { name: effectId };
  const kind = effectId === 'ritratto' ? 'identita' : 'stile';
  return {
    blob, size, kind,
    label: effectId === 'ritratto' ? 'Ritratto (foto vera)' : `Personaggio — ${meta.name}`,
    note: effectId === 'ritratto'
      ? 'È la foto reale, solo bonificata. Dalla all’AI soltanto se ti sta bene che la riceva.'
      : 'È il disegno del personaggio: questo è il file da dare all’AI se non vuoi passare la foto.',
    name: `personaggio-${kind}-${effectId}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${blob.type.indexOf('png') >= 0 ? 'png' : 'jpg'}`,
    tipo: blob.type, peso: Math.round(blob.size / 1024),
  };
}

async function shoot() {
  const flash = $('#flash');
  flash.classList.add('on');
  requestAnimationFrame(() => flash.classList.remove('on'));

  let src, flip = false;
  if (mode === 'foto') src = photo;
  else { src = await cameraStill(); flip = facing === 'user'; }
  if (!src) return;

  const rect = (mode === 'foto' && crop.on && crop.rect)
    ? crop.rect : { x: 0, y: 0, w: src.w, h: src.h };

  showToast('Elaboro a piena risoluzione…', 2500);
  const fitted = cropAndFit(src, rect, targetLong());

  const list = (mode === 'foto' && pairOn)
    ? ['ritratto', effect === 'ritratto' ? lastStyle : effect]
    : [effect];

  // Il ritaglio va analizzato a parte: i punti del volto e la maschera
  // sono in coordinate normalizzate sull'inquadratura.
  let volto = null, maschera = null;
  if ((bgOn || carOn) && Face.stato === 'pronto') {
    const a = await Face.analizza(fitted, fitted.width, fitted.height);
    volto = a.volto; maschera = a.maschera;
    if (!volto && carOn) showToast('Nel ritaglio non trovo il volto: esporto senza caricatura', 3600);
  }

  const out = [];
  for (const id of list) {
    const r = await exportOne(id, fitted, fitted.width, fitted.height, flip, volto, maschera);
    if (r) out.push(r);
  }
  fitted.width = fitted.height = 0;
  if (!out.length) return showToast('Esportazione non riuscita: prova una risoluzione più bassa', 4000);
  showResults(out);
}

$('#btnShot').addEventListener('click', () => { shoot(); });

/* Lo scatto dal vivo usa il frame alla risoluzione nativa del video.
   ImageCapture non e' una strada affidabile: su iOS non esiste e su
   Android restituisce spesso la stessa risoluzione dello stream. Per
   la piena risoluzione del sensore si usa il pulsante che apre la
   fotocamera di sistema. */
async function cameraStill() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return { source: c, w: c.width, h: c.height };
}

/* ---------------------------------------------------------
   Risultati
   --------------------------------------------------------- */

function showResults(list) {
  results.forEach((r) => { if (r.url) URL.revokeObjectURL(r.url); });
  results = list.map((r) => Object.assign({}, r, { url: URL.createObjectURL(r.blob) }));

  const box = $('#results');
  box.innerHTML = '';
  results.forEach((r, i) => {
    const card = document.createElement('figure');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="badge ${r.kind === 'identita' ? 'badge-id' : ''}">${r.label}</div>
      <img src="${r.url}" alt="${r.label}">
      <figcaption>${r.note}<br><span class="meta">${r.size} · ${r.tipo.indexOf('png') >= 0 ? 'PNG' : 'JPEG'} · ${r.peso} KB</span></figcaption>
      <button class="ghost-btn small" data-i="${i}">Salva / Condividi</button>`;
    card.querySelector('button').addEventListener('click', () => saveResult(i));
    box.appendChild(card);
  });

  $('#saveHint').textContent = results.length > 1
    ? 'La foto reale resta un’opzione tua: per l’AI basta il disegno più il testo.'
    : 'Su iPhone puoi anche tenere premuto sull’immagine per salvarla in Foto.';
  preview.classList.remove('hidden');
}

async function saveResult(i) {
  const r = results[i];
  if (!r) return;
  const file = new File([r.blob], r.name, { type: r.blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: r.label }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = r.url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

$('#btnClose').addEventListener('click', () => preview.classList.add('hidden'));

/* ---------------------------------------------------------
   Testo per l'AI
   --------------------------------------------------------- */

const STYLE_WORDS = {
  inchiostro: 'comic book character design, clean black ink lineart, flat colours, three-tone cel shading',
  cartoon:    'flat colour cartoon illustration, bold clean outlines, simple shapes, cel shading',
  anime:      'modern anime illustration, cel shading, clean lineart, soft rim light, expressive eyes',
  matita:     'graphite pencil drawing, visible hatching, warm white paper, monochrome',
  fumetto:    'classic comic book art, bold black inks, flat spot colours',
  acquerello: "children's picture book watercolour illustration, soft washes",
  neon:       'neon outline illustration on a dark background',
  ritratto:   'flat colour illustration, clean lineart',
};

function buildPrompt() {
  const styleId = effect === 'ritratto' ? lastStyle : effect;
  const words = STYLE_WORDS[styleId] || STYLE_WORDS.inchiostro;
  const conCar = carOn ? '\n• La caricatura è già applicata nel disegno: non chiedere al modello di esagerare\n  ulteriormente i tratti, o il personaggio diventa una macchietta.' : '';
  return `SENZA DARE LA FOTO VERA

Questa immagine è già il DISEGNO del personaggio, non una fotografia. È il
percorso giusto anche tecnicamente: Midjourney dichiara che il riferimento
di personaggio "eccelle con immagini generate" e non è ottimizzato per le
foto reali, perché questi meccanismi sono tarati su input che stanno già nel
dominio dell'illustrazione.

Quello che il disegno ha perso — il colore vero di occhi, capelli e
incarnato, l'età, la corporatura — lo dichiari a parole qui sotto.${conCar}

COME CARICARLA
• Midjourney V7:  --oref <immagine> --ow 150-300
    (peso alto: il riferimento è già nello stile giusto, quindi conviene
     fedeltà alta, al contrario di quando si parte da una foto)
    --cw 100 se capelli e vestiario fanno parte del personaggio, --cw 0 se
    vuoi poterli cambiare
• Gemini / Nano Banana:  allegala come reference del personaggio
• GPT-image:  input_fidelity="high"

PROMPT (in inglese: è la lingua in cui questi modelli rendono meglio)

Use the attached image as the canonical character design. Redraw and refine it
in a consistent style for a children's picture book and comic, keeping the same
face structure, proportions and distinctive features.

STYLE: ${words}. Plain light grey background, soft frontal lighting, flat
colours, clean lineart.

CHARACTER BIBLE — reuse these exact tokens in every future prompt:
- age: [età]
- face shape: [forma del viso]
- hair: [colore e taglio reali]
- eyes: [colore reale]
- skin tone: [incarnato reale]
- build: [corporatura]
- distinctive features: [2-3 tratti riconoscibili]
- outfit palette: [colori dell'abito]

This is the same character in every image. Do not restyle the face.

NEGATIVE: no halftone, no Ben-Day dots, no paper grain, no newsprint texture,
no vignette, no film grain, no posterization banding, no watermark, no text.

DUE AVVERTENZE ONESTE
1. Un disegno derivato da una foto porta con sé i limiti di quella foto. Se il
   viso era in ombra o di tre quarti, il modello inventerà la parte che non
   vede, e la inventerà diversa ogni volta. Conviene partire da un disegno
   frontale, con gli occhi ben visibili.
2. Gli artefatti dello stile locale (contorni spessi, campiture piatte)
   vengono ereditati e a volte amplificati. Per questo l'interruttore
   "Pulito per l'AI" spegne grana, retino e vignettatura: sono le texture che
   un modello copia come materia del personaggio.

E POI, IL PASSAGGIO CHE FA LA DIFFERENZA
Fatti generare UN SOLO personaggio e iteralo finché non convince. Da quel
momento il riferimento è quel disegno approvato: è così che resta lo stesso
per tutte le tavole del libro.

Se la persona ritratta non sei tu, chiedile il consenso prima di pubblicare un
personaggio che le somiglia: una caricatura riconoscibile resta una
somiglianza, anche se non è più una fotografia.`;
}

$('#btnText').addEventListener('click', () => {
  $('#promptText').value = buildPrompt();
  $('#textPanel').classList.remove('hidden');
});
$('#btnTextClose').addEventListener('click', () => $('#textPanel').classList.add('hidden'));
$('#btnCopy').addEventListener('click', async () => {
  const ta = $('#promptText');
  try {
    await navigator.clipboard.writeText(ta.value);
    $('#btnCopy').textContent = 'Copiato';
    setTimeout(() => { $('#btnCopy').textContent = 'Copia'; }, 1800);
  } catch (e) {
    ta.removeAttribute('readonly');
    ta.select();
    document.execCommand && document.execCommand('copy');
    ta.setAttribute('readonly', '');
  }
});

/* ---------------------------------------------------------
   Comandi vari
   --------------------------------------------------------- */

$('#btnStart').addEventListener('click', startCamera);
$('#btnRetry').addEventListener('click', startCamera);
$('#btnPick').addEventListener('click', () => filePick.click());
$('#btnStartPick').addEventListener('click', () => filePick.click());
$('#btnStartShot').addEventListener('click', () => fileShot.click());

$('#btnFlip').addEventListener('click', () => {
  facing = facing === 'user' ? 'environment' : 'user';
  store.set('facing', facing);
  cancelAnimationFrame(raf);
  startCamera();
});

$('#btnCamera').addEventListener('click', () => { photo = null; setMode('fotocamera'); startCamera(); });

$('#btnFreeze').addEventListener('click', (ev) => {
  if (mode !== 'fotocamera') return;
  frozen = !frozen;
  ev.currentTarget.textContent = frozen ? '▶️' : '⏸';
  ev.currentTarget.classList.toggle('active', frozen);
});

const fullBtn = $('#btnFull');
const canFullscreen = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
if (!canFullscreen) fullBtn.classList.add('hidden');
fullBtn.addEventListener('click', () => {
  const el = document.documentElement;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
});

/* ---- registrazione video ---- */
const recBtn = $('#btnRec');
function pickMime() {
  if (!window.MediaRecorder) return null;
  const list = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || null;
}
if (!pickMime() || !canvas.captureStream) recBtn.classList.add('hidden');

recBtn.addEventListener('click', () => {
  if (mode !== 'fotocamera') return;
  if (recorder && recorder.state === 'recording') return stopRecording();
  const mime = pickMime();
  if (!mime) return;
  try {
    recChunks = [];
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6000000 });
  } catch (e) { return; }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'video/mp4' });
    if (!blob.size) return;
    showResults([{
      blob, size: `${canvas.width}×${canvas.height}`, kind: 'video', label: 'Video',
      note: 'Anteprima animata dell’effetto.', tipo: blob.type,
      peso: Math.round(blob.size / 1024),
      name: `cartooncam-${Date.now()}.${blob.type.indexOf('mp4') >= 0 ? 'mp4' : 'webm'}`,
    }]);
  };
  recorder.start(250);
  recStart = performance.now();
  recBtn.classList.add('active');
  recBtn.textContent = '⏹';
  $('#recBadge').classList.remove('hidden');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 60) stopRecording();
  }, 250);
});

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  clearInterval(recTimer);
  recBtn.classList.remove('active');
  recBtn.textContent = '⏺';
  $('#recBadge').classList.add('hidden');
}

/* ---- tocco sul video: mostra/nascondi i comandi ---- */
let uiHidden = false;
canvas.addEventListener('click', () => {
  if (mode === 'foto' && crop.on) return;      // in ritaglio il tocco serve al riquadro
  uiHidden = !uiHidden;
  stage.classList.toggle('ui-hidden', uiHidden);
});

function showToast(text, ms) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), ms);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state === 'recording') stopRecording();
  } else if (stream && mode === 'fotocamera') {
    loop();
  }
});
