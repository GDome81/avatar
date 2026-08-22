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
let bgOn = store.get('bg', '1') === '1';   // togliere lo sfondo e' il comportamento normale
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

/* L'altezza della barra dei comandi cambia (la riga della serie
   appare e sparisce): viene misurata e passata al CSS, cosi' l'immagine
   occupa esattamente lo spazio che resta invece di lasciare un vuoto. */
function misuraBarra() {
  const bb = document.querySelector('.bottombar');
  if (!bb) return;
  const h = Math.round(bb.getBoundingClientRect().height);
  if (h > 0) document.documentElement.style.setProperty('--bar', h + 'px');
  drawOverlay();
}

function setMode(m) {
  mode = m;
  stage.classList.toggle('photo-mode', m === 'foto');
  if (m !== 'foto') { crop.on = false; syncCrop(); }
  requestAnimationFrame(misuraBarra);
}

/* Coda di foto in attesa. Selezionando piu' file (o scattando piu'
   volte) si prepara una serie senza tornare ogni volta alla galleria:
   dopo ogni "＋ Serie" la foto successiva si carica da sola. */
let coda = [];

[filePick, fileShot].forEach((input) => {
  input.addEventListener('change', async (ev) => {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    if (!files.length) return;
    coda = coda.concat(files.slice(1));
    await loadPhoto(files[0]);
    syncSerie();
    if (files.length > 1) {
      showToast(`${files.length} foto in coda: dopo ogni “＋ Serie” passo alla prossima`, 4600);
    }
  });
});

async function prossimaDallaCoda() {
  if (!coda.length) return false;
  const f = coda.shift();
  await loadPhoto(f);
  syncSerie();
  return true;
}

async function loadPhoto(file) {
  showToast('Carico la foto…', 1600);
  let src = null;
  try {
    src = await createImageBitmap(file);            // Safari ignora le opzioni: non ci contiamo
  } catch (e) {
    try { src = await loadViaImg(file); } catch (e2) { src = null; }
  }
  if (!src) return showToast('Non riesco a leggere questa immagine. Se è un HEIC, riprova salvandola come JPEG.', 4200);

  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  // fra scatti della stessa fotocamera l'inquadratura si conserva: e'
  // quello che serve quando si prepara una serie di pose
  const stessaMisura = photo && photo.w === w0 && photo.h === h0 && crop.rect;
  if (photo && photo.source && photo.source.close) photo.source.close();
  photo = { source: src, w: w0, h: h0 };

  showStage();
  cancelAnimationFrame(raf);
  stopStream();
  if (!ensureRenderer()) return;
  setMode('foto');
  analisi = null;
  renderer.setFace(null);
  renderer.setMask(null);
  if (!stessaMisura) resetCrop();
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
  renderer.draw(effect, { width: w, height: h, amount, clean, time: 3, flip: false, car: carOn ? car : 0, useMask: bgOn, bg: [0.88, 0.88, 0.90] });
  drawOverlay();
}

function redrawIfPhoto() { if (mode === 'foto') drawPhoto(); }

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

/* Solo limiti di dimensione e di bordo: le proporzioni sono libere. */
function clampCrop() {
  const r = crop.rect; if (!r || !photo) return;
  r.w = Math.max(photo.w * 0.05, Math.min(photo.w, r.w));
  r.h = Math.max(photo.h * 0.05, Math.min(photo.h, r.h));
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

  /* Le guide si disegnano solo se il riquadro e' abbastanza grande:
     su un riquadro piccolo diventano un groviglio illeggibile. */
  const grande = Math.min(rw, rh) > 110;
  if (grande) {
  g.setLineDash([6, 6]);
  g.strokeStyle = 'rgba(255,255,255,.75)';
  g.lineWidth = 1.5;
  const headH = rh * 0.60, headW = Math.min(headH * 0.72, rw * 0.78);
  g.beginPath();
  g.ellipse(rx + rw / 2, ry + rh * 0.08 + headH / 2, headW / 2, headH / 2, 0, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(rx + rw * 0.12, ry + rh * 0.34);
  g.lineTo(rx + rw * 0.88, ry + rh * 0.34);
  g.stroke();
  g.setLineDash([]);

  // maniglie: grandi, perche' si prendono col dito
  const attiva = gesto && gesto.tipo === 'maniglia' ? gesto.ang : null;
  const raggio = Math.max(6, Math.min(12, Math.min(rw, rh) * 0.22));
  const punti = { tl: [rx, ry], tr: [rx + rw, ry], bl: [rx, ry + rh], br: [rx + rw, ry + rh] };
  for (const k in punti) {
    const [x, y] = punti[k];
    g.beginPath();
    g.arc(x, y, attiva === k ? raggio + 3 : raggio, 0, Math.PI * 2);
    g.fillStyle = attiva === k ? '#9ef7c5' : '#ffffff';
    g.fill();
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.lineWidth = 1.5;
    g.stroke();
  }

  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = '600 12px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('occhi qui', rx + rw / 2, ry + rh * 0.31);
  }
}

/* ---- gesti sul riquadro ----

   Tre modi, deciso una volta sola al tocco iniziale:
     maniglia  trascinando un angolo si ridimensiona, ancorati
               all'angolo opposto, mantenendo le proporzioni
     pan       trascinando altrove si sposta
     pizzico   con due dita si ridimensiona attorno al centro

   Gli spostamenti si calcolano dalla posizione INIZIALE del dito, non
   sommando le differenze fra un evento e l'altro: se un evento viene
   perso, il riquadro non ci resta storto. */

const pointers = new Map();
const RAGGIO_MANIGLIA = 34;      // px sullo schermo: un dito non e' preciso
let gesto = null;

/* Il raggio di presa va limitato a una frazione del riquadro. Con un
   raggio fisso, su un riquadro piccolo le quattro zone d'angolo
   coprivano tutta l'area: il dito appoggiato al centro afferrava
   sempre un angolo e il riquadro non si spostava mai. */
function raggioPresa() {
  const { s } = scalaSchermo();
  const latoMinore = Math.min(crop.rect.w, crop.rect.h) * s;
  return Math.max(14, Math.min(RAGGIO_MANIGLIA, latoMinore * 0.28));
}

function scalaSchermo() {
  const c = contentRect();
  return { s: c.w / photo.w, c };
}

function schermoDaSorgente(px, py) {
  const { s, c } = scalaSchermo();
  return { x: c.x + px * s, y: c.y + py * s };
}

function maniglia(cx, cy) {
  const r = crop.rect;
  if (!r) return null;
  const ang = {
    tl: schermoDaSorgente(r.x, r.y),
    tr: schermoDaSorgente(r.x + r.w, r.y),
    bl: schermoDaSorgente(r.x, r.y + r.h),
    br: schermoDaSorgente(r.x + r.w, r.y + r.h),
  };
  let vinta = null, minima = raggioPresa();
  for (const k in ang) {
    const d = Math.hypot(cx - ang[k].x, cy - ang[k].y);
    if (d < minima) { minima = d; vinta = k; }
  }
  return vinta;
}

function pinchDistance() {
  const p = [...pointers.values()];
  if (p.length < 2) return 0;
  return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
}

overlay.addEventListener('pointerdown', (ev) => {
  if (!crop.on || !crop.rect || !photo) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (pointers.size === 2) {
    gesto = { tipo: 'pizzico', d0: pinchDistance(), rect0: Object.assign({}, crop.rect) };
  } else {
    const ang = maniglia(ev.clientX, ev.clientY);
    gesto = {
      tipo: ang ? 'maniglia' : 'pan', ang, pid: ev.pointerId,
      x0: ev.clientX, y0: ev.clientY, rect0: Object.assign({}, crop.rect),
    };
    try { overlay.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  drawOverlay();
  ev.preventDefault();
});

overlay.addEventListener('pointermove', (ev) => {
  if (!gesto || !pointers.has(ev.pointerId) || !crop.rect) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  const { s } = scalaSchermo();
  const r0 = gesto.rect0;

  if (gesto.tipo === 'pizzico') {
    const d = pinchDistance();
    if (d > 0 && gesto.d0 > 0) {
      const k = gesto.d0 / d;
      const cx = r0.x + r0.w / 2, cy = r0.y + r0.h / 2;
      crop.rect.w = r0.w * k;
      crop.rect.h = r0.h * k;        // scala la forma corrente, non la impone
      clampCrop();
      crop.rect.x = cx - crop.rect.w / 2;
      crop.rect.y = cy - crop.rect.h / 2;
      clampCrop();
    }
  } else if (gesto.tipo === 'maniglia') {
    /* Ogni angolo e' libero: muove il proprio vertice nelle due
       direzioni, l'opposto resta fermo. Il riquadro non ha piu'
       proporzioni fisse. */
    const fisso = {
      tl: { x: r0.x + r0.w, y: r0.y + r0.h },
      tr: { x: r0.x,        y: r0.y + r0.h },
      bl: { x: r0.x + r0.w, y: r0.y },
      br: { x: r0.x,        y: r0.y },
    }[gesto.ang];
    const { c } = scalaSchermo();
    const px = Math.max(0, Math.min(photo.w, (ev.clientX - c.x) / s));
    const py = Math.max(0, Math.min(photo.h, (ev.clientY - c.y) / s));
    const minW = photo.w * 0.05, minH = photo.h * 0.05;

    const w = Math.max(minW, Math.abs(px - fisso.x));
    const h = Math.max(minH, Math.abs(py - fisso.y));
    crop.rect.w = w;
    crop.rect.h = h;
    crop.rect.x = (px < fisso.x) ? fisso.x - w : fisso.x;
    crop.rect.y = (py < fisso.y) ? fisso.y - h : fisso.y;
    clampCrop();
  } else {
    crop.rect.x = r0.x + (ev.clientX - gesto.x0) / s;
    crop.rect.y = r0.y + (ev.clientY - gesto.y0) / s;
    clampCrop();
  }
  drawOverlay();
  ev.preventDefault();
});

['pointerup', 'pointercancel', 'pointerleave'].forEach((t) =>
  overlay.addEventListener(t, (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) gesto = null;
    else if (gesto && gesto.tipo === 'pizzico') {
      // tolto un dito: si riparte da capo come trascinamento
      const resta = [...pointers.entries()][0];
      gesto = { tipo: 'pan', pid: resta[0], x0: resta[1].x, y0: resta[1].y,
                rect0: Object.assign({}, crop.rect) };
    }
    drawOverlay();
  })
);

const cropBtn = $('#btnCrop');
function syncCrop() {
  cropBtn.setAttribute('aria-pressed', String(crop.on));
  drawOverlay();
}
cropBtn.addEventListener('click', () => {
  if (mode !== 'foto') return showToast('Il ritaglio vale sulle foto', 2600);
  crop.on = !crop.on;
  if (crop.on && !crop.rect) resetCrop();
  syncCrop();
  showToast(crop.on ? 'Trascina il riquadro, pizzica per stringere' : 'Ritaglio spento: esporti l’immagine intera', 3000);
});

window.addEventListener('resize', () => { misuraBarra(); if (mode === 'foto') drawOverlay(); });
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

/* Le impostazioni di resa vengono passate esplicitamente invece di
   essere lette dai comandi: la serie deve poter usare quelle bloccate
   al primo scatto anche se poi l'utente cambia effetto. */
function impostazioni() {
  return { effect, amount, clean, car: carOn ? car : 0, useMask: bgOn, bg: [0.88, 0.88, 0.90] };
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
  r.draw(opts.effect, {
    width: ow, height: oh, amount: opts.amount, clean: opts.clean, time: 3, flip: opts.flip,
    car: opts.car || 0, useMask: !!opts.useMask, bg: opts.bg || [0.88, 0.88, 0.90],
  });
  if (r.uploadError) showToast('Questo telefono non regge questa risoluzione: prova 1024 px', 4200);
  // il contesto va liberato SOLO dopo la lettura del canvas: perderlo
  // svuota il drawing buffer e il file uscirebbe vuoto
  return { canvas: out, release: () => { r.dispose(); out.width = out.height = 0; } };
}

function toBlob(cv, type, q) {
  return new Promise((res) => cv.toBlob((b) => res(b), type, q));
}

async function exportOne(effectId, source, w, h, flip, volto, maschera, set) {
  const cfg = Object.assign({}, set || impostazioni(), { effect: effectId, flip });
  const job = renderFull(source, w, h, cfg, volto, maschera);
  const long = Math.max(job.canvas.width, job.canvas.height);
  // PNG fino a 2048 px (nessun artefatto sui tratti fini); oltre, JPEG,
  // perche' un PNG da 12 Mpx supera i 40 MB e su iOS non si codifica.
  const type = long <= 2048 ? 'image/png' : 'image/jpeg';
  const ow = job.canvas.width, oh = job.canvas.height;
  const size = `${ow}×${oh}`;
  const blob = await toBlob(job.canvas, type, 0.92);
  job.release();          // azzera il canvas: le misure si leggono prima
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

/* Ritaglio, riduzione e analisi: il pezzo comune fra lo scatto singolo
   e l'aggiunta alla serie. L'analisi va fatta sul RITAGLIO, perche' i
   punti del volto e la maschera sono in coordinate normalizzate
   sull'inquadratura, non sulla foto intera. */
async function sorgentePronta(set) {
  let src, flip = false;
  if (mode === 'foto') src = photo;
  else { src = await cameraStill(); flip = facing === 'user'; }
  if (!src) return null;

  const rect = (mode === 'foto' && crop.on && crop.rect)
    ? crop.rect : { x: 0, y: 0, w: src.w, h: src.h };
  const fitted = cropAndFit(src, rect, targetLong());

  let volto = null, maschera = null;
  if ((set.useMask || set.car > 0) && Face.stato === 'pronto') {
    const a = await Face.analizza(fitted, fitted.width, fitted.height);
    volto = a.volto; maschera = a.maschera;
    if (!volto && set.car > 0) showToast('Nel ritaglio non trovo il volto: esporto senza caricatura', 3600);
  }
  return { fitted, volto, maschera, flip };
}

async function shoot() {
  const flash = $('#flash');
  flash.classList.add('on');
  requestAnimationFrame(() => flash.classList.remove('on'));

  const set = impostazioni();
  showToast('Elaboro a piena risoluzione…', 2500);
  const src = await sorgentePronta(set);
  if (!src) return;

  const list = (mode === 'foto' && pairOn)
    ? ['ritratto', effect === 'ritratto' ? lastStyle : effect]
    : [effect];

  const out = [];
  for (const id of list) {
    const r = await exportOne(id, src.fitted, src.fitted.width, src.fitted.height,
                             src.flip, src.volto, src.maschera, set);
    if (r) out.push(r);
  }
  src.fitted.width = src.fitted.height = 0;
  if (!out.length) return showToast('Esportazione non riuscita: prova una risoluzione più bassa', 4000);
  ultimaTavola = false;
  showResults(out);
}

/* ---------------------------------------------------------
   Serie: fino a cinque scatti in una sola tavola

   Un personaggio regge le tavole successive se il modello ne vede la
   struttura da piu' angoli, non una sola proiezione. Le pose vengono
   rese TUTTE con le impostazioni del primo scatto: se cambiassero
   effetto o intensita' da un pannello all'altro, il modello leggerebbe
   le differenze di stile come differenze del personaggio.
   --------------------------------------------------------- */

const SERIE_MAX = 5;
const SERIE_POSE = ['di fronte, sguardo in camera', 'tre quarti verso destra',
                    'tre quarti verso sinistra', 'di profilo', 'espressione diversa (sorriso)'];
let serie = [];
let serieSet = null;
let ultimaTavola = false;

function syncSerie() {
  $('#serieLabel').textContent = `${serie.length}/${SERIE_MAX}`;
  $('#btnSerie').setAttribute('aria-pressed', String(serie.length > 0));
  $('#serieRow').classList.toggle('hidden', serie.length === 0 && coda.length === 0);
  $('#btnComponi').classList.toggle('hidden', serie.length === 0);
  $('#btnSvuota').classList.toggle('hidden', serie.length === 0 && coda.length === 0);
  const inAttesa = coda.length ? ` · ${coda.length} in attesa` : '';
  $('#seriePros').textContent = serie.length < SERIE_MAX
    ? `Prossima: ${SERIE_POSE[serie.length]}${inAttesa}`
    : `Serie completa${inAttesa}`;
  requestAnimationFrame(misuraBarra);
}

$('#btnSerie').addEventListener('click', async () => {
  if (mode !== 'foto') return showToast('La serie si compone partendo dalle foto', 3200);
  if (serie.length >= SERIE_MAX) return showToast('Cinque pose sono il massimo', 3000);

  const set = serieSet || impostazioni();
  if (serieSet) showToast('Uso le impostazioni del primo scatto, per coerenza', 2600);
  else showToast('Elaboro il primo pannello…', 2200);

  const src = await sorgentePronta(set);
  if (!src) return;
  const r = await exportOne(set.effect, src.fitted, src.fitted.width, src.fitted.height,
                            src.flip, src.volto, src.maschera, set);
  src.fitted.width = src.fitted.height = 0;
  if (!r) return showToast('Non riesco a preparare questo pannello', 3200);

  serieSet = set;
  serie.push({ blob: r.blob, posa: SERIE_POSE[serie.length], size: r.size, w: r.w, h: r.h });
  syncSerie();

  if (await prossimaDallaCoda()) {
    showToast(`Pannello ${serie.length} aggiunto. Ecco la foto successiva`, 3400);
  } else if (serie.length === 1 && !set.useMask) {
    showToast('Pannello 1 aggiunto. Per una tavola coerente conviene il fondo neutro', 4600);
  } else if (serie.length < SERIE_MAX) {
    showToast(`Pannello ${serie.length} aggiunto. Aggiungi altre foto o scatta`, 3800);
  } else {
    showToast('Cinque pose: puoi comporre la tavola', 3400);
  }
});

$('#btnSvuota').addEventListener('click', () => {
  serie = []; serieSet = null; coda = []; syncSerie();
  showToast('Serie svuotata', 2000);
});

$('#btnAltraFoto').addEventListener('click', () => filePick.click());
$('#btnAltroScatto').addEventListener('click', () => fileShot.click());

$('#btnComponi').addEventListener('click', () => componiSerie());

async function componiSerie() {
  const n = serie.length;
  if (!n) return;
  showToast('Compongo la tavola…', 2600);

  const cols = n <= 2 ? n : (n === 4 ? 2 : 3);
  const rows = Math.ceil(n / cols);
  const LIM = 2048, g = 18;

  // i ritagli hanno forme libere: la cella prende la forma media, e i
  // pannelli che non la riempiono restano centrati sul fondo
  const forme = serie.map((sp) => (sp.w && sp.h) ? sp.w / sp.h : CROP_RATIO);
  const forma = Math.max(0.4, Math.min(2.2, forme.reduce((a, b) => a + b, 0) / forme.length));

  let cw = Math.floor((LIM - g * (cols + 1)) / cols);
  let ch = Math.round(cw / forma);
  if (rows * ch + g * (rows + 1) > LIM) {
    ch = Math.floor((LIM - g * (rows + 1)) / rows);
    cw = Math.round(ch * forma);
  }
  const W = cols * cw + g * (cols + 1), H = rows * ch + g * (rows + 1);
  if (!canvasFits(W, H)) return showToast('Tavola troppo grande per questo telefono', 3600);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // stesso grigio del fondo neutro: la tavola si legge come un foglio unico
  ctx.fillStyle = '#e0e0e6';
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i < n; i++) {
    let bmp;
    try { bmp = await createImageBitmap(serie[i].blob); } catch (e) { continue; }
    const x = g + (i % cols) * (cw + g), y = g + Math.floor(i / cols) * (ch + g);
    const k = Math.min(cw / bmp.width, ch / bmp.height);
    const dw = Math.round(bmp.width * k), dh = Math.round(bmp.height * k);
    ctx.drawImage(bmp, x + (cw - dw) / 2, y + (ch - dh) / 2, dw, dh);
    if (bmp.close) bmp.close();
  }

  const blob = await toBlob(cv, 'image/png');
  const dim = `${W}×${H}`;
  cv.width = cv.height = 0;
  if (!blob) return showToast('Composizione non riuscita', 3200);

  // La tavola unica serve a chi accetta una sola immagine (Midjourney);
  // i pannelli separati a chi ne accetta piu' di una (Gemini).
  const cards = [{
    blob, size: dim, kind: 'tavola', label: `Tavola — ${n} pose`,
    note: 'Una sola immagine con tutte le pose: per i modelli che accettano un solo riferimento.',
    tipo: blob.type, peso: Math.round(blob.size / 1024),
    name: `personaggio-tavola-${n}pose.png`,
  }];
  serie.forEach((sp, i) => cards.push({
    blob: sp.blob, size: sp.size || '', kind: 'posa', label: `Posa ${i + 1}`,
    note: sp.posa + ' — utile per i modelli che accettano più riferimenti.',
    tipo: sp.blob.type, peso: Math.round(sp.blob.size / 1024),
    name: `personaggio-posa-${i + 1}.png`,
  }));
  ultimaTavola = true;
  showResults(cards);
}
syncSerie();

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
      <figcaption>${r.note}<br><span class="meta">${r.size ? r.size + ' · ' : ''}${r.tipo.indexOf('png') >= 0 ? 'PNG' : 'JPEG'} · ${r.peso} KB</span></figcaption>
      <button class="ghost-btn small" data-i="${i}">Salva / Condividi</button>`;
    card.querySelector('button').addEventListener('click', () => saveResult(i));
    box.appendChild(card);
  });

  $('#saveHint').textContent = results.length > 1
    ? 'La foto reale resta un’opzione tua: per l’AI basta il disegno più il testo.'
    : 'Su iPhone puoi anche tenere premuto sull’immagine per salvarla in Foto.';
  apriSheet(false);
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

/* Campi della "bibbia del personaggio". Sono tutti facoltativi: quelli
   lasciati vuoti non compaiono nel prompt. Servono a dichiarare a
   parole cio' che la stilizzazione ha perso o falsato — il colore vero
   degli occhi, dei capelli, dell'incarnato. */
const CAMPI = [
  { k: 'age',    en: 'age',                  label: 'Età',                ph: '42' },
  { k: 'face',   en: 'face shape',           label: 'Forma del viso',     ph: 'ovale, mascella marcata' },
  { k: 'hair',   en: 'hair',                 label: 'Capelli',            ph: 'castano scuro, corti, ciuffo alto' },
  { k: 'eyes',   en: 'eyes',                 label: 'Occhi',              ph: 'marroni' },
  { k: 'skin',   en: 'skin tone',            label: 'Incarnato',          ph: 'olivastro' },
  { k: 'build',  en: 'build',                label: 'Corporatura',        ph: 'asciutta, spalle larghe' },
  { k: 'marks',  en: 'distinctive features', label: 'Tratti distintivi',  ph: 'barba corta, sopracciglia folte' },
  { k: 'outfit', en: 'outfit palette',       label: 'Colori dell’abito',  ph: 'maglia verde salvia' },
];

function leggiValori() {
  try { return JSON.parse(store.get('bibbia', '{}')) || {}; } catch (e) { return {}; }
}
function salvaValori(v) { store.set('bibbia', JSON.stringify(v)); }

/* Solo il prompt: e' questo che finisce negli appunti. */
function buildPrompt(vals) {
  const styleId = effect === 'ritratto' ? lastStyle : effect;
  const words = STYLE_WORDS[styleId] || STYLE_WORDS.inchiostro;
  const righe = CAMPI
    .filter((c) => (vals[c.k] || '').trim())
    .map((c) => `- ${c.en}: ${vals[c.k].trim()}`);

  const p = [];
  p.push(ultimaTavola
    ? 'The attached sheet shows the same person in several poses. Treat all panels as ONE single character, not as different people.'
    : 'Use the attached image as the starting point for ONE character.');

  p.push("Design that character for a children's picture book and comic, keeping the same face structure, proportions and distinctive features as the reference. Then produce, as separate images:");

  p.push(`1) A CHARACTER TURNAROUND — the same character from several angles:
   front view, three-quarter left, three-quarter right, profile, and back view.
   Same outfit, same scale, same eye line across all views, neutral pose,
   plain light grey background.

2) AN EXPRESSION SHEET — the same character, front view, same scale:
   neutral, smile, open-mouth laugh, surprise, anger, sadness.
   Head and shoulders only.`);

  p.push(`STYLE: ${words}. Flat colours, clean lineart, soft frontal lighting, plain light grey background, no scenery.`);

  if (righe.length) {
    p.push('CHARACTER BIBLE — reuse these exact tokens in every future prompt:\n' + righe.join('\n'));
  }

  p.push('Every panel must read as the exact same person: same face, same hairstyle, same distinctive features. Do not restyle the face between panels.');
  p.push('NEGATIVE: no halftone, no Ben-Day dots, no paper grain, no newsprint texture, no vignette, no film grain, no posterization banding, no watermark, no text, no labels.');
  return p.join('\n\n');
}

/* Istruzioni: restano a schermo, non vengono copiate. */
function buildGuida() {
  const pesoRif = 'Midjourney V7:  --oref <immagine> --ow 150-300\n' +
    '  Peso alto: il riferimento e\u2019 gia\u2019 un disegno, quindi conviene fedelta\u2019 alta.\n' +
    '  Partendo da una foto servirebbe il contrario (--ow 25-50), perche\u2019 li\u2019 il\n' +
    '  modello deve anche cambiare dominio.\n' +
    '  --cw 100 se capelli e vestiario fanno parte del personaggio, --cw 0 se no.';
  return `COME CARICARLA
${pesoRif}
Gemini / Nano Banana:  allega l\u2019immagine come reference del personaggio.
  Accetta piu\u2019 riferimenti: se hai composto una tavola, puoi passare anche i
  singoli pannelli.
GPT-image:  input_fidelity="high".

PERCHE\u2019 IL DISEGNO E NON LA FOTO
Midjourney dichiara che il riferimento di personaggio "eccelle con immagini
generate" e non e\u2019 ottimizzato per le foto reali: questi meccanismi sono
tarati su input che stanno gia\u2019 nel dominio dell\u2019illustrazione. Dare il
disegno non e\u2019 un compromesso.

DUE AVVERTENZE ONESTE
1. Un disegno derivato da una foto porta con se\u2019 i limiti di quella foto. Se
   il viso era in ombra o di tre quarti, il modello inventera\u2019 la parte che
   non vede, e la inventera\u2019 diversa ogni volta.
2. Gli artefatti dello stile locale (contorni spessi, campiture piatte) vengono
   ereditati e a volte amplificati. Per questo l\u2019interruttore "Pulito per
   l\u2019AI" spegne grana, retino e vignettatura.

COSA CHIEDE IL PROMPT
Due tavole: il TURNAROUND (fronte, tre quarti destro e sinistro, profilo,
retro) e il FOGLIO DELLE ESPRESSIONI (neutra, sorriso, risata, sorpresa,
rabbia, tristezza). Il turnaround da\u2019 al modello la struttura della testa
invece di una sola proiezione; le espressioni fissano COME si deforma quel
viso. Sono i due documenti che tengono il personaggio identico fra le tavole.

POI, IL PASSAGGIO CHE FA LA DIFFERENZA
Fatti generare UN SOLO personaggio e iteralo finche\u2019 non convince. Da quel
momento il riferimento e\u2019 quel turnaround approvato, non piu\u2019 la foto.

Se la persona ritratta non sei tu, chiedile il consenso prima di pubblicare un
personaggio che le somiglia: una caricatura riconoscibile resta una somiglianza.`;
}

/* ---- pannello: campi, anteprima del prompt, copia ---- */

function apriTesto() {
  const vals = leggiValori();
  const box = $('#campi');
  box.innerHTML = '';
  CAMPI.forEach((c) => {
    const wrap = document.createElement('label');
    wrap.className = 'campo';
    wrap.innerHTML = `<span>${c.label}</span>
      <input type="text" data-k="${c.k}" placeholder="${c.ph}" value="${(vals[c.k] || '').replace(/"/g, '&quot;')}">`;
    box.appendChild(wrap);
  });
  box.querySelectorAll('input').forEach((i) => i.addEventListener('input', aggiornaPrompt));
  $('#guidaTesto').textContent = buildGuida();
  aggiornaPrompt();
  $('#textPanel').classList.remove('hidden');
}

function valoriDaiCampi() {
  const v = {};
  $('#campi').querySelectorAll('input').forEach((i) => { v[i.dataset.k] = i.value; });
  return v;
}

function aggiornaPrompt() {
  const v = valoriDaiCampi();
  salvaValori(v);
  $('#promptText').value = buildPrompt(v);
  const vuoti = CAMPI.filter((c) => !(v[c.k] || '').trim()).length;
  $('#btnCopy').textContent = vuoti === CAMPI.length ? 'Copia senza dettagli' : 'Copia il prompt';
}

$('#btnText').addEventListener('click', apriTesto);
$('#btnCopy').addEventListener('click', async () => {
  const testo = $('#promptText').value;
  try {
    await navigator.clipboard.writeText(testo);
    $('#btnCopy').textContent = 'Copiato';
  } catch (e) {
    const ta = $('#promptText');
    ta.removeAttribute('readonly');
    ta.select();
    ta.setSelectionRange(0, testo.length);
    const ok = document.execCommand && document.execCommand('copy');
    ta.setAttribute('readonly', '');
    $('#btnCopy').textContent = ok ? 'Copiato' : 'Copia a mano dal riquadro';
  }
  setTimeout(aggiornaPrompt, 1800);
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
  etichettaRec('⏹', 'Stop');
  $('#recBadge').classList.remove('hidden');
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 60) stopRecording();
  }, 250);
});

function etichettaRec(em, testo) {
  const spans = recBtn.querySelectorAll('span');
  if (spans[0]) spans[0].textContent = em;
  if (spans[1]) spans[1].textContent = testo;
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  clearInterval(recTimer);
  recBtn.classList.remove('active');
  etichettaRec('⏺', 'Video');
  $('#recBadge').classList.add('hidden');
}

/* ---------------------------------------------------------
   Pannello delle regolazioni

   Si apre a meta' schermo e l'immagine si ritira sopra di esso:
   intensita' e caricatura si regolano guardando il risultato, non a
   memoria.
   --------------------------------------------------------- */

const sheet = $('#sheet'), backdrop = $('#backdrop');

function apriSheet(apri) {
  sheet.classList.toggle('open', apri);
  backdrop.classList.toggle('open', apri);
  stage.classList.toggle('sheet-open', apri);
  // la geometria del canvas cambia: il riquadro va ridisegnato
  setTimeout(drawOverlay, 280);
}

$('#btnSheet').addEventListener('click', () => apriSheet(!sheet.classList.contains('open')));
$('#btnSheetClose').addEventListener('click', () => apriSheet(false));
backdrop.addEventListener('click', () => apriSheet(false));

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
