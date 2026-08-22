/* =========================================================
   Cartoon Cam — applicazione
   Il motore di stilizzazione sta in engine.js.

   Due modi di lavoro:
     fotocamera  anteprima dal vivo, per scegliere effetto e posa
     foto        una immagine dalla galleria, elaborata a piena
                 risoluzione: e' il percorso da usare quando
                 l'immagine servira' come riferimento per l'AI
   ========================================================= */

const $ = (s) => document.querySelector(s);
const intro = $('#intro'), errorScreen = $('#error'), stage = $('#stage'), preview = $('#preview');
const video = $('#video'), canvas = $('#canvas');
const amountInput = $('#amount'), effectsBar = $('#effects'), effectName = $('#effectName');
const previewImg = $('#previewImg'), previewVid = $('#previewVid');
const filePick = $('#filePick');

const PREVIEW_MAX = 900;          // risoluzione dell'anteprima dal vivo
const CANVAS_AREA_MAX = 16 * 1024 * 1024;  // Safari iOS rifiuta canvas oltre ~16.7 Mpx

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

let renderer = null, stream = null, track = null, imageCapture = null, raf = 0;
let mode = 'fotocamera';
let photo = null;                  // { source, w, h } immagine importata
let facing = store.get('facing', 'user');
let effect = FRAG[store.get('effect', '')] ? store.get('effect', 'cartoon') : 'cartoon';
let amount = Number(store.get('amount', 70)) / 100;
let clean = store.get('clean', '1') === '1';
let frozen = false, hasFrame = false, startTime = 0, quality = 1;
let recorder = null, recChunks = [], recTimer = 0, recStart = 0;
let lastBlob = null, lastKind = 'image', lastName = '';
const midCanvas = document.createElement('canvas');
const baseCanvas = document.createElement('canvas');

/* ---------------------------------------------------------
   Barra degli effetti e controlli
   --------------------------------------------------------- */

EFFECTS.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.dataset.id = e.id;
  b.setAttribute('aria-pressed', String(e.id === effect));
  b.innerHTML = `<span class="em">${e.emoji}</span>${e.name}`;
  b.addEventListener('click', () => { setEffect(e.id); redrawIfPhoto(); });
  effectsBar.appendChild(b);
});

function setEffect(id) {
  effect = id;
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
  cleanBtn.title = clean
    ? 'Modo reference: senza grana, retino e vignettatura'
    : 'Modo pittorico: con grana, retino e vignettatura';
}
cleanBtn.addEventListener('click', () => {
  clean = !clean;
  store.set('clean', clean ? '1' : '0');
  syncClean();
  showToast(clean ? 'Modo reference: superfici pulite, adatte all’AI' : 'Modo pittorico: grana e retino attivi', 2600);
  redrawIfPhoto();
});
syncClean();

/* ---------------------------------------------------------
   Fotocamera
   --------------------------------------------------------- */

async function startCamera() {
  if (!window.isSecureContext) {
    return fail('La fotocamera funziona solo su indirizzi sicuri (https://) oppure su localhost. Apri il sito con https.');
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
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
    });
  } catch (err) {
    return fail(describeError(err));
  }

  track = stream.getVideoTracks()[0] || null;
  imageCapture = null;
  if (window.ImageCapture && track) {
    try { imageCapture = new ImageCapture(track); } catch (e) { imageCapture = null; }
  }

  video.srcObject = stream;
  try { await video.play(); } catch (e) {}

  intro.classList.add('hidden');
  errorScreen.classList.add('hidden');
  stage.classList.remove('hidden');

  if (!renderer) {
    try { renderer = new Renderer(canvas); } catch (err) { return fail(err.message); }
  }
  setMode('fotocamera');
  setEffect(effect);
  if (!store.get('hintSeen', '')) {
    showToast('Tocca il video per nascondere i comandi', 3800);
    store.set('hintSeen', '1');
  }
  frozen = false;
  hasFrame = false;
  quality = 1;
  startTime = performance.now();
  loop();
}

function describeError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'Permesso negato. Tocca l’icona del lucchetto (o “aA”) nella barra degli indirizzi, consenti la fotocamera e riprova.';
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
  stream = null; track = null; imageCapture = null;
}

/* ---------------------------------------------------------
   Anteprima dal vivo
   --------------------------------------------------------- */

let frames = 0, fpsMark = 0;

function fitCanvas(vw, vh) {
  const k = Math.min(1, (PREVIEW_MAX * quality) / Math.max(vw, vh));
  const w = Math.max(2, Math.round(vw * k));
  const h = Math.max(2, Math.round(vh * k));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (mode !== 'fotocamera') return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;

  fitCanvas(vw, vh);
  if (!frozen) {
    renderer.load(video, vw, vh, { midCanvas, baseCanvas });
    hasFrame = true;
  }
  if (!hasFrame) return;

  renderer.draw(effect, {
    width: canvas.width, height: canvas.height,
    amount, clean,
    time: (performance.now() - startTime) / 1000,
    flip: facing === 'user',
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
   Modo foto: immagine dalla galleria, elaborata a piena risoluzione
   --------------------------------------------------------- */

function setMode(m) {
  mode = m;
  stage.classList.toggle('photo-mode', m === 'foto');
  $('#modeLabel').textContent = m === 'foto' ? 'Foto' : '';
}

filePick.addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  showToast('Carico la foto…', 1500);
  let src = null;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    try { src = await createImageBitmap(file); } catch (e2) { src = await loadViaImg(file); }
  }
  if (!src) return showToast('Non riesco a leggere questa immagine', 3000);

  photo = { source: src, w: src.width || src.naturalWidth, h: src.height || src.naturalHeight };
  intro.classList.add('hidden');
  errorScreen.classList.add('hidden');
  stage.classList.remove('hidden');
  cancelAnimationFrame(raf);
  stopStream();
  if (!renderer) { try { renderer = new Renderer(canvas); } catch (err) { return fail(err.message); } }
  setMode('foto');
  drawPhoto();
  showToast(`Foto ${photo.w}×${photo.h} — lo scatto esporta a questa risoluzione`, 4200);
});

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
  renderer.load(photo.source, photo.w, photo.h, {});
  renderer.draw(effect, { width: w, height: h, amount, clean, time: 3, flip: false });
}

function redrawIfPhoto() { if (mode === 'foto') drawPhoto(); }

$('#btnCamera').addEventListener('click', () => {
  photo = null;
  setMode('fotocamera');
  startCamera();
});

/* ---------------------------------------------------------
   Esportazione a piena risoluzione
   --------------------------------------------------------- */

/* Prende il fotogramma alla risoluzione nativa: dove esiste
   ImageCapture si ottiene lo scatto del sensore, altrimenti il
   frame del video, che e' comunque piu' grande dell'anteprima. */
async function cameraStill() {
  if (imageCapture && imageCapture.takePhoto) {
    try {
      const blob = await imageCapture.takePhoto();
      const bmp = await createImageBitmap(blob);
      return { source: bmp, w: bmp.width, h: bmp.height };
    } catch (e) { /* molti browser non lo implementano: si continua */ }
  }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return { source: c, w: c.width, h: c.height };
}

function exportSize(w, h, maxTexture) {
  let k = Math.min(1, maxTexture / Math.max(w, h));
  const area = (w * k) * (h * k);
  if (area > CANVAS_AREA_MAX) k *= Math.sqrt(CANVAS_AREA_MAX / area);
  return [Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k))];
}

/* Renderizza la sorgente a piena risoluzione in un canvas fuori
   schermo, con un contesto WebGL dedicato.

   Il contesto va liberato SOLO dopo aver letto il canvas: perdere il
   contesto svuota il drawing buffer, e il PNG uscirebbe vuoto. */
function renderFull(src, opts) {
  const probe = renderer ? renderer.maxTexture : 4096;
  const [w, h] = exportSize(src.w, src.h, probe);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const r = new Renderer(out);
  r.load(src.source, src.w, src.h, {});
  r.draw(opts.effect, {
    width: w, height: h, amount: opts.amount, clean: opts.clean,
    time: 3, flip: opts.flip,
  });
  return { canvas: out, release: () => r.dispose() };
}

function toBlob(cv, type, q) {
  return new Promise((res) => cv.toBlob((b) => res(b), type, q));
}

async function shoot() {
  const flash = $('#flash');
  flash.classList.add('on');
  requestAnimationFrame(() => flash.classList.remove('on'));

  let src;
  if (mode === 'foto') src = photo;
  else src = await cameraStill();
  if (!src) return;

  const job = renderFull(src, {
    effect, amount, clean,
    flip: mode === 'fotocamera' && facing === 'user',
  });
  // PNG: nessuna compressione, cosi' i contorni restano netti quando
  // l'immagine viene data in pasto a un modello generativo.
  const blob = await toBlob(job.canvas, 'image/png');
  const size = `${job.canvas.width}×${job.canvas.height}`;
  job.release();
  if (!blob) return showToast('Esportazione non riuscita', 3000);
  showPreview(blob, 'image', size);
}

$('#btnShot').addEventListener('click', () => { shoot(); });

/* ---------------------------------------------------------
   Comandi vari
   --------------------------------------------------------- */

$('#btnStart').addEventListener('click', startCamera);
$('#btnRetry').addEventListener('click', startCamera);
$('#btnPick').addEventListener('click', () => filePick.click());
$('#btnStartPick').addEventListener('click', () => filePick.click());

$('#btnFlip').addEventListener('click', () => {
  facing = facing === 'user' ? 'environment' : 'user';
  store.set('facing', facing);
  cancelAnimationFrame(raf);
  startCamera();
});

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
    if (blob.size) showPreview(blob, 'video', '');
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

/* ---------------------------------------------------------
   Anteprima dello scatto, salvataggio, condivisione
   --------------------------------------------------------- */

function showPreview(blob, kind, sizeLabel) {
  if (previewImg.src) URL.revokeObjectURL(previewImg.src);
  lastBlob = blob; lastKind = kind;
  const ext = kind === 'image' ? 'png' : (blob.type.indexOf('mp4') >= 0 ? 'mp4' : 'webm');
  const eff = (EFFECTS.find((e) => e.id === effect) || {}).name || effect;
  lastName = `personaggio-${eff.toLowerCase()}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;

  const url = URL.createObjectURL(blob);
  if (kind === 'image') {
    previewImg.src = url; previewImg.classList.remove('hidden');
    previewVid.classList.add('hidden'); previewVid.removeAttribute('src');
    const kb = Math.round(blob.size / 1024);
    $('#saveHint').textContent = `PNG ${sizeLabel} — ${kb} KB. Su iPhone tieni premuto sull’immagine per salvarla in Foto.`;
  } else {
    previewVid.src = url; previewVid.classList.remove('hidden');
    previewImg.classList.add('hidden'); previewImg.removeAttribute('src');
    $('#saveHint').textContent = 'Usa “Salva / Condividi” per mandarlo in galleria o su WhatsApp.';
  }
  preview.classList.remove('hidden');
}

$('#btnClose').addEventListener('click', () => {
  preview.classList.add('hidden');
  previewVid.pause();
});

$('#btnSave').addEventListener('click', async () => {
  if (!lastBlob) return;
  const file = new File([lastBlob], lastName, { type: lastBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Cartoon Cam' }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastBlob);
  a.download = lastName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

/* ---- tocco sul video: mostra/nascondi i comandi ---- */
let uiHidden = false;
canvas.addEventListener('click', () => {
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

/* ---- risparmio batteria: fermiamo il render fuori schermo ---- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state === 'recording') stopRecording();
  } else if (stream && mode === 'fotocamera') {
    loop();
  }
});
