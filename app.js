/* =========================================================
   Cartoon Cam — effetti cartoon / anime / disegno in tempo
   reale sul flusso della fotocamera, via WebGL.
   Tutto gira nel browser: nessun frame viene inviato altrove.
   ========================================================= */

/* ---------------------------------------------------------
   1. Shader
   --------------------------------------------------------- */

const VERT = `
attribute vec2 a_pos;
uniform float u_flip;      // 1.0 = specchia (fotocamera frontale)
varying vec2 v_uv;
void main(){
  vec2 uv = a_pos * 0.5 + 0.5;
  uv.y = 1.0 - uv.y;
  uv.x = mix(uv.x, 1.0 - uv.x, u_flip);
  v_uv = uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const PRELUDE = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2  u_texel;     // 1.0 / risoluzione
uniform float u_amount;    // 0..1 intensita'
uniform float u_time;

vec3 tx(vec2 uv){ return texture2D(u_tex, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 posterize(vec3 c, float n){ return floor(c * n + 0.5) / n; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 blur3(vec2 uv, float k){
  vec2 s = u_texel * k;
  vec3 o = tx(uv) * 4.0;
  o += (tx(uv + vec2(s.x, 0.0)) + tx(uv - vec2(s.x, 0.0))
      + tx(uv + vec2(0.0, s.y)) + tx(uv - vec2(0.0, s.y))) * 2.0;
  o += tx(uv + s) + tx(uv - s)
     + tx(uv + vec2(s.x, -s.y)) + tx(uv + vec2(-s.x, s.y));
  return o / 16.0;
}

/* appiattisce i dettagli conservando le forme: la base del look "disegnato" */
vec3 smooth13(vec2 uv, float k){
  vec2 s = u_texel * k;
  vec3 o = tx(uv) * 3.0;
  o += tx(uv + vec2( s.x, 0.0)) + tx(uv + vec2(-s.x, 0.0));
  o += tx(uv + vec2( 0.0, s.y)) + tx(uv + vec2( 0.0,-s.y));
  o += tx(uv + s * 0.75) + tx(uv - s * 0.75);
  o += tx(uv + vec2( s.x,-s.y) * 0.75) + tx(uv + vec2(-s.x, s.y) * 0.75);
  o += tx(uv + vec2( s.x * 2.0, 0.0)) + tx(uv + vec2(-s.x * 2.0, 0.0));
  o += tx(uv + vec2( 0.0, s.y * 2.0)) + tx(uv + vec2( 0.0,-s.y * 2.0));
  return o / 15.0;
}

float sobel(vec2 uv, float k){
  vec2 s = u_texel * k;
  float tl = lum(tx(uv + vec2(-s.x,-s.y)));
  float tc = lum(tx(uv + vec2( 0.0,-s.y)));
  float tr = lum(tx(uv + vec2( s.x,-s.y)));
  float ml = lum(tx(uv + vec2(-s.x, 0.0)));
  float mr = lum(tx(uv + vec2( s.x, 0.0)));
  float bl = lum(tx(uv + vec2(-s.x, s.y)));
  float bc = lum(tx(uv + vec2( 0.0, s.y)));
  float br = lum(tx(uv + vec2( s.x, s.y)));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return length(vec2(gx, gy));
}

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

/* Satura solo cio' che ha gia' un colore: bianchi e grigi restano neutri,
   altrimenti una camicia bianca con un filo di azzurro diventa viola. */
vec3 satBoost(vec3 c, float k){
  vec3 hsv = rgb2hsv(c);
  hsv.y = clamp(hsv.y * (1.0 + k * smoothstep(0.05, 0.28, hsv.y)), 0.0, 1.0);
  return hsv2rgb(hsv);
}

/* Riduce i toni a pochi livelli lavorando su luminosita' e saturazione:
   quantizzare in RGB sposterebbe le tinte. */
vec3 quantize(vec3 c, float levels){
  vec3 hsv = rgb2hsv(c);
  hsv.z = floor(hsv.z * levels + 0.5) / levels;
  float sl = max(levels * 0.8, 3.0);
  hsv.y = floor(hsv.y * sl + 0.5) / sl;
  return hsv2rgb(hsv);
}
`;

const FRAG = {

  /* ------- Cartoon: colori piatti + contorno marcato ------- */
  cartoon: `
  void main(){
    float a = u_amount;
    vec3 base = smooth13(v_uv, 1.6 + a * 2.6);
    vec3 c = quantize(base, mix(14.0, 6.0, a));
    c = satBoost(c, a * 0.7);
    c = clamp(c * 1.06 + 0.02, 0.0, 1.0);
    float e = sobel(v_uv, 1.0 + a);
    float edge = smoothstep(mix(0.60, 0.16, a), mix(0.90, 0.44, a), e);
    c = mix(c, vec3(0.06, 0.05, 0.09), edge);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Anime: cel shading, colori saturi, luce soffusa ------- */
  anime: `
  void main(){
    float a = u_amount;
    vec3 base = smooth13(v_uv, 2.0 + a * 3.2);
    vec3 hsv = rgb2hsv(base);
    float bands = mix(9.0, 4.0, a);
    float v = floor(hsv.z * bands + 0.5) / bands;
    hsv.z = clamp(mix(hsv.z, v, 0.2 + a * 0.8) * 1.12 + 0.05, 0.0, 1.0);   // volti luminosi
    hsv.y = clamp(hsv.y * (1.0 + a * 0.7 * smoothstep(0.05, 0.28, hsv.y)), 0.0, 1.0);
    vec3 c = hsv2rgb(hsv);

    vec3 bl = blur3(v_uv, 6.0);
    c += max(bl - 0.70, 0.0) * 1.1 * a;                        // bloom sulle luci
    float sh = smoothstep(0.35, 0.0, lum(c));
    c = mix(c, c * vec3(0.90, 0.94, 1.10), sh * 0.35 * a);      // ombre appena freddine

    float e = sobel(v_uv, 0.9);
    float edge = smoothstep(mix(0.62, 0.22, a), mix(0.92, 0.52, a), e);
    c = mix(c, vec3(0.15, 0.10, 0.19), edge * 0.94);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Matita: schizzo a grafite su carta, con tratteggio nelle ombre ------- */
  matita: `
  void main(){
    float a = u_amount;
    vec3 src = tx(v_uv);
    float g = lum(src);
    float b = lum(blur3(v_uv, 3.0 + a * 7.0));
    float dodge = clamp(g / max(b, 0.004), 0.0, 1.0);            // color dodge
    float ink = pow(1.0 - dodge, mix(1.25, 0.5, a)) * mix(1.3, 2.6, a);
    ink += smoothstep(0.18, 0.68, sobel(v_uv, 1.2)) * mix(0.35, 0.9, a);

    vec2 px = v_uv / u_texel;
    float hatch = smoothstep(0.30, 0.70, abs(fract((px.x + px.y) / 7.0) - 0.5) * 2.0);
    float shade = smoothstep(0.42, 0.04, g) * 0.55 * a;          // tratteggio nelle ombre
    ink += shade * mix(0.45, 1.0, hatch);
    ink = clamp(ink, 0.0, 1.0);

    float grain = hash(floor(px / 2.0)) * 0.07;
    vec3 paper = vec3(0.965, 0.950, 0.925) - grain;
    vec3 lead  = vec3(0.11, 0.10, 0.13) + grain * 0.5;
    gl_FragColor = vec4(mix(paper, lead, ink), 1.0);
  }`,

  /* ------- Fumetto: retino a mezzatinta + inchiostro ------- */
  fumetto: `
  void main(){
    float a = u_amount;
    vec3 base = smooth13(v_uv, 2.0);
    float g = clamp(pow(lum(base), 0.70) * 1.35, 0.0, 1.0);      // schiarisce i mezzi toni

    float cell = mix(12.0, 8.0, a);
    vec2 p = v_uv / u_texel;
    float ang = 0.7853981;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p / cell;
    vec2 f = fract(q) - 0.5;
    float radius = sqrt(clamp(1.0 - g, 0.0, 1.0)) * 0.52;
    float dots = 1.0 - smoothstep(radius - 0.10, radius + 0.10, length(f));

    float edge = smoothstep(0.22, 0.58, sobel(v_uv, 1.2));       // inchiostro spesso
    float ink = clamp(max(dots, edge), 0.0, 1.0);

    vec3 flatc = satBoost(quantize(base, 4.0), 0.8);
    flatc = clamp(flatc * 1.10 + 0.04, 0.0, 1.0);
    vec3 paper = mix(flatc, vec3(1.0, 0.99, 0.96), a * 0.45);
    gl_FragColor = vec4(mix(paper, vec3(0.07, 0.06, 0.09), ink), 1.0);
  }`,

  /* ------- Acquerello: macchie morbide, bordi umidi, grana ------- */
  acquerello: `
  void main(){
    float a = u_amount;
    vec3 c = mix(smooth13(v_uv, 2.5 + a * 3.5), blur3(v_uv, 5.0 + a * 7.0), 0.35);
    c = quantize(c, mix(16.0, 8.0, a));
    c = satBoost(c, 0.65 * a);
    c = clamp(c * 1.08 + 0.05, 0.0, 1.0);

    float edge = smoothstep(0.22, 0.85, sobel(v_uv, 1.3));
    c *= 1.0 - edge * 0.55 * a;                                  // contorno bagnato
    vec2 px = v_uv / u_texel;
    c += (hash(floor(px / 3.0)) - 0.5) * 0.10 * a;               // grana carta
    float vg = smoothstep(1.15, 0.35, length(v_uv - 0.5) * 1.4);
    c = mix(vec3(0.99, 0.98, 0.95), c, mix(1.0, vg, 0.55 * a));
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Neon: solo contorni luminosi su fondo scuro ------- */
  neon: `
  void main(){
    float a = u_amount;
    float g    = smoothstep(0.15, 0.90, sobel(v_uv, 1.0 + a * 1.5));
    float glow = smoothstep(0.05, 0.80, sobel(v_uv, 3.0 + a * 4.0)) * 0.65;
    float hue  = fract(v_uv.y * 0.6 + v_uv.x * 0.2 + u_time * 0.06);
    vec3 neon  = hsv2rgb(vec3(hue, 0.85, 1.0));
    vec3 dark  = tx(v_uv) * mix(0.40, 0.06, a);
    gl_FragColor = vec4(clamp(dark + neon * (g * 1.3 + glow * 0.7), 0.0, 1.0), 1.0);
  }`,
};

const EFFECTS = [
  { id: 'cartoon',    name: 'Cartoon',    emoji: '🎨' },
  { id: 'anime',      name: 'Anime',      emoji: '✨' },
  { id: 'matita',     name: 'Matita',     emoji: '✏️' },
  { id: 'fumetto',    name: 'Fumetto',    emoji: '💥' },
  { id: 'acquerello', name: 'Acquerello', emoji: '🖌️' },
  { id: 'neon',       name: 'Neon',       emoji: '🌈' },
];

/* ---------------------------------------------------------
   2. Renderer WebGL
   --------------------------------------------------------- */

class Renderer {
  constructor(canvas) {
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
    this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('WebGL non disponibile su questo browser.');
    const gl = this.gl;

    this.programs = {};
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  program(id) {
    if (this.programs[id]) return this.programs[id];
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, PRELUDE + FRAG[id]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Link: ' + gl.getProgramInfoLog(p));
    }
    const info = {
      p,
      a_pos:    gl.getAttribLocation(p, 'a_pos'),
      u_tex:    gl.getUniformLocation(p, 'u_tex'),
      u_texel:  gl.getUniformLocation(p, 'u_texel'),
      u_amount: gl.getUniformLocation(p, 'u_amount'),
      u_time:   gl.getUniformLocation(p, 'u_time'),
      u_flip:   gl.getUniformLocation(p, 'u_flip'),
    };
    this.programs[id] = info;
    return info;
  }

  upload(video) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  }

  draw(effectId, { width, height, amount, time, flip }) {
    const gl = this.gl;
    const s = this.program(effectId);
    gl.viewport(0, 0, width, height);
    gl.useProgram(s.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(s.a_pos);
    gl.vertexAttribPointer(s.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(s.u_tex, 0);
    gl.uniform2f(s.u_texel, 1 / width, 1 / height);
    gl.uniform1f(s.u_amount, amount);
    gl.uniform1f(s.u_time, time);
    gl.uniform1f(s.u_flip, flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/* ---------------------------------------------------------
   3. App
   --------------------------------------------------------- */

const $ = (s) => document.querySelector(s);
const intro = $('#intro'), errorScreen = $('#error'), stage = $('#stage'), preview = $('#preview');
const video = $('#video'), canvas = $('#canvas');
const amountInput = $('#amount'), effectsBar = $('#effects'), effectName = $('#effectName');
const previewImg = $('#previewImg'), previewVid = $('#previewVid');

const MAX_SIDE = 900;                 // limite risoluzione di render (perf su telefono)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

let renderer = null, stream = null, raf = 0;
let facing = store.get('facing', 'user');
let effect = FRAG[store.get('effect', '')] ? store.get('effect', 'cartoon') : 'cartoon';
let amount = Number(store.get('amount', 70)) / 100;
let frozen = false, hasFrame = false, startTime = 0, scale = 1;
let recorder = null, recChunks = [], recTimer = 0, recStart = 0;
let lastBlob = null, lastKind = 'image';

/* ---- barra effetti ---- */
EFFECTS.forEach((e) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.type = 'button';
  b.dataset.id = e.id;
  b.setAttribute('aria-pressed', String(e.id === effect));
  b.innerHTML = `<span class="em">${e.emoji}</span>${e.name}`;
  b.addEventListener('click', () => setEffect(e.id));
  effectsBar.appendChild(b);
});

function setEffect(id) {
  effect = id;
  store.set('effect', id);
  const meta = EFFECTS.find((e) => e.id === id);
  effectName.textContent = meta ? `${meta.emoji} ${meta.name}` : id;
  effectsBar.querySelectorAll('.chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(c.dataset.id === id));
  });
  const active = effectsBar.querySelector('[aria-pressed="true"]');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

amountInput.value = String(Math.round(amount * 100));
amountInput.addEventListener('input', () => {
  amount = Number(amountInput.value) / 100;
  store.set('amount', amountInput.value);
});

/* ---- avvio fotocamera ---- */
async function startCamera() {
  if (!window.isSecureContext) {
    return fail('La fotocamera funziona solo su indirizzi sicuri (https://) oppure su localhost. Apri il sito con https.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return fail('Questo browser non permette l\'accesso alla fotocamera. Prova con Chrome o Safari aggiornati.');
  }

  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: facing === 'user' ? { ideal: 'user' } : { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch (err) {
    return fail(describeError(err));
  }

  video.srcObject = stream;
  try { await video.play(); } catch (e) { /* alcuni browser risolvono al primo frame */ }

  intro.classList.add('hidden');
  errorScreen.classList.add('hidden');
  stage.classList.remove('hidden');

  if (!renderer) {
    try { renderer = new Renderer(canvas); } catch (err) { return fail(err.message); }
  }
  setEffect(effect);
  if (!store.get('hintSeen', '')) {
    showToast('Tocca il video per nascondere i comandi', 3800);
    store.set('hintSeen', '1');
  }
  frozen = false;
  hasFrame = false;
  scale = 1;
  startTime = performance.now();
  loop();
}

function describeError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'Permesso negato. Tocca l\'icona del lucchetto (o “aA”) nella barra degli indirizzi, consenti la fotocamera e riprova.';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Nessuna fotocamera trovata su questo dispositivo.';
  if (n === 'NotReadableError') return 'La fotocamera è occupata da un\'altra app. Chiudila e riprova.';
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
  stream = null;
}

/* ---- loop di rendering, con auto-riduzione se il telefono soffre ---- */
let frames = 0, fpsMark = 0;

function resizeTo(vw, vh) {
  const long = Math.max(vw, vh);
  const k = Math.min(1, (MAX_SIDE * scale) / long);
  const w = Math.max(2, Math.round(vw * k));
  const h = Math.max(2, Math.round(vh * k));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function loop() {
  raf = requestAnimationFrame(loop);
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.readyState < 2) return;

  resizeTo(vw, vh);
  if (!frozen) { renderer.upload(video); hasFrame = true; }
  if (!hasFrame) return;

  renderer.draw(effect, {
    width: canvas.width,
    height: canvas.height,
    amount,
    time: (performance.now() - startTime) / 1000,
    flip: facing === 'user',
  });

  // adattamento qualita': se scendiamo sotto ~24 fps, riduciamo la risoluzione
  frames++;
  const now = performance.now();
  if (!fpsMark) fpsMark = now;
  if (now - fpsMark > 2000) {
    const fps = (frames * 1000) / (now - fpsMark);
    if (fps < 24 && scale > 0.55) scale = Math.max(0.55, scale - 0.15);
    else if (fps > 52 && scale < 1) scale = Math.min(1, scale + 0.1);
    frames = 0; fpsMark = now;
  }
}

/* ---- comandi ---- */
$('#btnStart').addEventListener('click', startCamera);
$('#btnRetry').addEventListener('click', startCamera);

$('#btnFlip').addEventListener('click', () => {
  facing = facing === 'user' ? 'environment' : 'user';
  store.set('facing', facing);
  cancelAnimationFrame(raf);
  startCamera();
});

$('#btnFreeze').addEventListener('click', (ev) => {
  frozen = !frozen;
  ev.currentTarget.textContent = frozen ? '▶️' : '⏸';
  ev.currentTarget.classList.toggle('active', frozen);
});

$('#btnShot').addEventListener('click', () => {
  const flash = $('#flash');
  flash.classList.add('on');
  requestAnimationFrame(() => flash.classList.remove('on'));
  canvas.toBlob((blob) => { if (blob) showPreview(blob, 'image'); }, 'image/jpeg', 0.94);
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
  if (recorder && recorder.state === 'recording') return stopRecording();
  const mime = pickMime();
  if (!mime) return;
  try {
    recChunks = [];
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  } catch (e) { return; }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || 'video/mp4' });
    if (blob.size) showPreview(blob, 'video');
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

/* ---- anteprima, salvataggio, condivisione ---- */
function showPreview(blob, kind) {
  if (lastBlob) URL.revokeObjectURL(previewImg.src);
  lastBlob = blob; lastKind = kind;
  const url = URL.createObjectURL(blob);
  if (kind === 'image') {
    previewImg.src = url; previewImg.classList.remove('hidden');
    previewVid.classList.add('hidden'); previewVid.removeAttribute('src');
    $('#saveHint').textContent = 'Su iPhone: tieni premuto sull\'immagine e scegli “Aggiungi a Foto”.';
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
  const ext = lastKind === 'image' ? 'jpg' : (lastBlob.type.includes('mp4') ? 'mp4' : 'webm');
  const name = `cartooncam-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  const file = new File([lastBlob], name, { type: lastBlob.type });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Cartoon Cam' }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastBlob);
  a.download = name;
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

/* ---- suggerimento iniziale (una volta sola) ---- */
function showToast(text, ms) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

/* ---- risparmio batteria: fermiamo il render fuori schermo ---- */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
    if (recorder && recorder.state === 'recording') stopRecording();
  } else if (stream) {
    loop();
  }
});
