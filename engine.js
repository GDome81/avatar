/* =========================================================
   Cartoon Cam — motore di stilizzazione
   =========================================================
   Il look di un disegno dipende da grandezze RELATIVE
   all'immagine (spessore della linea, ampiezza delle campiture,
   passo del retino), non dal numero di pixel. Se i parametri
   restano in texel, la stessa scena a 900 px sembra un cartone
   e a 3000 px una foto posterizzata.

   Per questo il motore lavora su tre livelli della stessa
   immagine:
     u_tex  dettaglio, a piena risoluzione  -> occhi, denti, capelli
     u_mid  lato lungo ~900 px              -> contorni (spessore costante)
     u_base lato lungo ~250 px              -> masse di colore piatte
   I livelli sono prodotti per riduzioni successive a metà, che
   danno un ricampionamento pulito, e campionati in coordinate
   normalizzate: il risultato è identico a ogni risoluzione.
   ========================================================= */

const MID_SIDE  = 900;   // riferimento per lo spessore dei contorni
const BASE_SIDE = 250;   // riferimento per l'appiattimento del colore

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

uniform sampler2D u_tex;       // dettaglio (piena risoluzione)
uniform sampler2D u_mid;       // livello contorni
uniform sampler2D u_base;      // livello colore
uniform vec2  u_midTexel;      // 1.0 / dimensione del livello contorni
uniform vec2  u_baseTexel;     // 1.0 / dimensione del livello colore
uniform float u_scale;         // lato lungo in uscita / 900: scala i pattern in pixel
uniform float u_amount;        // 0..1 intensita'
uniform float u_clean;         // 1.0 = senza grana/vignetta/retino (uso come reference)
uniform float u_time;

vec2 cl(vec2 uv){ return clamp(uv, vec2(0.001), vec2(0.999)); }
vec3 tx(vec2 uv){ return texture2D(u_tex,  cl(uv)).rgb; }
vec3 md(vec2 uv){ return texture2D(u_mid,  cl(uv)).rgb; }
vec3 bs(vec2 uv){ return texture2D(u_base, cl(uv)).rgb; }

float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

/* Ammorbidisce ulteriormente il livello colore. k e' in texel del
   livello colore, quindi in frazione dell'immagine: invariante. */
vec3 bsSoft(vec2 uv, float k){
  vec2 s = u_baseTexel * k;
  vec3 o = bs(uv) * 4.0;
  o += (bs(uv + vec2(s.x, 0.0)) + bs(uv - vec2(s.x, 0.0))
      + bs(uv + vec2(0.0, s.y)) + bs(uv - vec2(0.0, s.y))) * 2.0;
  o += bs(uv + s) + bs(uv - s) + bs(uv + vec2(s.x, -s.y)) + bs(uv + vec2(-s.x, s.y));
  return o / 16.0;
}

float sobelAt(sampler2D t, vec2 uv, vec2 texel, float k){
  vec2 s = texel * k;
  float tl = lum(texture2D(t, cl(uv + vec2(-s.x,-s.y))).rgb);
  float tc = lum(texture2D(t, cl(uv + vec2( 0.0,-s.y))).rgb);
  float tr = lum(texture2D(t, cl(uv + vec2( s.x,-s.y))).rgb);
  float ml = lum(texture2D(t, cl(uv + vec2(-s.x, 0.0))).rgb);
  float mr = lum(texture2D(t, cl(uv + vec2( s.x, 0.0))).rgb);
  float bl = lum(texture2D(t, cl(uv + vec2(-s.x, s.y))).rgb);
  float bc = lum(texture2D(t, cl(uv + vec2( 0.0, s.y))).rgb);
  float br = lum(texture2D(t, cl(uv + vec2( s.x, s.y))).rgb);
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
  return length(vec2(gx, gy));
}
float edgeMid(vec2 uv, float k){ return sobelAt(u_mid, uv, u_midTexel, k); }

/* Microcontrasto: quanto il dettaglio si discosta dal livello
   contorni. Serve a non perdere occhi, denti e montature quando
   il colore viene appiattito. */
float relief(vec2 uv){ return lum(tx(uv)) - lum(md(uv)); }

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

/* Satura solo cio' che ha gia' un colore: bianchi e grigi restano
   neutri, altrimenti una camicia bianca con un filo di azzurro
   diventa viola. */
vec3 satBoost(vec3 c, float k){
  vec3 hsv = rgb2hsv(c);
  hsv.y = clamp(hsv.y * (1.0 + k * smoothstep(0.05, 0.28, hsv.y)), 0.0, 1.0);
  return hsv2rgb(hsv);
}

/* Riduce i toni a pochi livelli lavorando su luminosita' e
   saturazione: quantizzare in RGB sposterebbe le tinte. */
vec3 quantize(vec3 c, float levels){
  vec3 hsv = rgb2hsv(c);
  hsv.z = floor(hsv.z * levels + 0.5) / levels;
  float sl = max(levels * 0.8, 3.0);
  hsv.y = floor(hsv.y * sl + 0.5) / sl;
  return hsv2rgb(hsv);
}
`;

const FRAG = {

  /* ------- Cartoon: campiture piatte + contorno marcato ------- */
  cartoon: `
  void main(){
    float a = u_amount;
    vec3 c = quantize(bsSoft(v_uv, 0.6 + a * 1.1), mix(14.0, 6.0, a));
    c = satBoost(c, a * 0.7);
    c = clamp(c * 1.06 + 0.02, 0.0, 1.0);
    c += relief(v_uv) * (0.55 - a * 0.15);                  // tiene occhi e denti leggibili
    float e = edgeMid(v_uv, 1.0 + a);
    float edge = smoothstep(mix(0.60, 0.16, a), mix(0.90, 0.44, a), e);
    c = mix(c, vec3(0.06, 0.05, 0.09), edge);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Anime: cel shading, colori saturi, luce soffusa ------- */
  anime: `
  void main(){
    float a = u_amount;
    vec3 hsv = rgb2hsv(bsSoft(v_uv, 0.8 + a * 1.4));
    float bands = mix(9.0, 4.0, a);
    float v = floor(hsv.z * bands + 0.5) / bands;
    hsv.z = clamp(mix(hsv.z, v, 0.2 + a * 0.8) * 1.12 + 0.05, 0.0, 1.0);
    hsv.y = clamp(hsv.y * (1.0 + a * 0.7 * smoothstep(0.05, 0.28, hsv.y)), 0.0, 1.0);
    vec3 c = hsv2rgb(hsv);

    c += max(bsSoft(v_uv, 3.0) - 0.70, 0.0) * 1.1 * a;       // luce soffusa
    float sh = smoothstep(0.35, 0.0, lum(c));
    c = mix(c, c * vec3(0.90, 0.94, 1.10), sh * 0.35 * a);   // ombre appena freddine
    c += relief(v_uv) * (0.5 - a * 0.15);

    float e = edgeMid(v_uv, 0.9);
    float edge = smoothstep(mix(0.62, 0.22, a), mix(0.92, 0.52, a), e);
    c = mix(c, vec3(0.15, 0.10, 0.19), edge * 0.94);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Matita: grafite su carta ------- */
  matita: `
  void main(){
    float a = u_amount;
    float g = lum(tx(v_uv));
    float b = lum(bsSoft(v_uv, 0.7 + a * 1.6));
    float dodge = clamp(g / max(b, 0.004), 0.0, 1.0);
    float ink = pow(1.0 - dodge, mix(1.25, 0.5, a)) * mix(1.3, 2.6, a);
    ink += smoothstep(0.18, 0.68, edgeMid(v_uv, 1.1)) * mix(0.35, 0.9, a);

    vec2 px = v_uv / (u_midTexel * u_scale);                 // pixel del livello contorni
    float shade = smoothstep(0.42, 0.04, lum(md(v_uv))) * 0.55 * a;
    float hatch = smoothstep(0.30, 0.70, abs(fract((px.x + px.y) / 7.0) - 0.5) * 2.0);
    ink += shade * mix(mix(0.45, 1.0, hatch), 0.8, u_clean); // niente tratteggio in modo pulito
    ink = clamp(ink, 0.0, 1.0);

    float grain = hash(floor(px / 2.0)) * 0.07 * (1.0 - u_clean);
    vec3 paper = vec3(0.965, 0.950, 0.925) - grain;
    vec3 lead  = vec3(0.11, 0.10, 0.13) + grain * 0.5;
    gl_FragColor = vec4(mix(paper, lead, ink), 1.0);
  }`,

  /* ------- Fumetto: retino a mezzatinta + inchiostro ------- */
  fumetto: `
  void main(){
    float a = u_amount;
    vec3 base = bsSoft(v_uv, 0.5);
    float g = clamp(pow(lum(base), 0.70) * 1.35, 0.0, 1.0);

    float cell = mix(12.0, 8.0, a) * u_scale;
    vec2 px = v_uv / u_midTexel * u_scale;
    float ang = 0.7853981;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * px / cell;
    vec2 f = fract(q) - 0.5;
    float radius = sqrt(clamp(1.0 - g, 0.0, 1.0)) * 0.52;
    float dots = 1.0 - smoothstep(radius - 0.10, radius + 0.10, length(f));
    dots *= 1.0 - u_clean;                                   // in modo pulito: campiture piatte

    float edge = smoothstep(0.22, 0.58, edgeMid(v_uv, 1.2));
    float ink = clamp(max(dots, edge), 0.0, 1.0);

    vec3 flatc = clamp(satBoost(quantize(base, 4.0), 0.8) * 1.10 + 0.04, 0.0, 1.0);
    flatc += relief(v_uv) * 0.35 * u_clean;
    vec3 paper = mix(flatc, vec3(1.0, 0.99, 0.96), a * 0.45 * (1.0 - u_clean * 0.6));
    gl_FragColor = vec4(clamp(mix(paper, vec3(0.07, 0.06, 0.09), ink), 0.0, 1.0), 1.0);
  }`,

  /* ------- Acquerello: macchie morbide, bordi umidi ------- */
  acquerello: `
  void main(){
    float a = u_amount;
    vec3 c = bsSoft(v_uv, 1.0 + a * 1.5);
    c = quantize(c, mix(16.0, 8.0, a));
    c = satBoost(c, 0.65 * a);
    c = clamp(c * 1.08 + 0.05, 0.0, 1.0);
    c += relief(v_uv) * 0.35;

    float edge = smoothstep(0.22, 0.85, edgeMid(v_uv, 1.3));
    c *= 1.0 - edge * 0.55 * a;                              // bordo bagnato
    vec2 px = v_uv / u_midTexel * u_scale;
    c += (hash(floor(px / 3.0)) - 0.5) * 0.10 * a * (1.0 - u_clean);
    float vg = smoothstep(1.15, 0.35, length(v_uv - 0.5) * 1.4);
    c = mix(vec3(0.99, 0.98, 0.95), c, mix(1.0, vg, 0.55 * a * (1.0 - u_clean)));
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`,

  /* ------- Neon: solo contorni luminosi ------- */
  neon: `
  void main(){
    float a = u_amount;
    float g    = smoothstep(0.15, 0.90, edgeMid(v_uv, 1.0 + a * 1.5));
    float glow = smoothstep(0.05, 0.80, edgeMid(v_uv, 3.0 + a * 4.0)) * 0.65;
    float hue  = fract(v_uv.y * 0.6 + v_uv.x * 0.2 + u_time * 0.06);
    vec3 neon  = hsv2rgb(vec3(hue, 0.85, 1.0));
    vec3 dark  = md(v_uv) * mix(0.40, 0.06, a);
    gl_FragColor = vec4(clamp(dark + neon * (g * 1.3 + glow * 0.7), 0.0, 1.0), 1.0);
  }`,
};

const EFFECTS = [
  { id: 'cartoon',    name: 'Cartoon',    emoji: '🎨', ref: 'ottimo'  },
  { id: 'anime',      name: 'Anime',      emoji: '✨', ref: 'ottimo'  },
  { id: 'matita',     name: 'Matita',     emoji: '✏️', ref: 'buono'   },
  { id: 'fumetto',    name: 'Fumetto',    emoji: '💥', ref: 'buono'   },
  { id: 'acquerello', name: 'Acquerello', emoji: '🖌️', ref: 'medio'   },
  { id: 'neon',       name: 'Neon',       emoji: '🌈', ref: 'scarso'  },
];

/* ---------------------------------------------------------
   Riduzioni progressive: dimezzare piu' volte costa poco e
   non produce aliasing come un singolo salto 3000 -> 250.
   --------------------------------------------------------- */

const scratchPool = [];
function scratch(i) {
  if (!scratchPool[i]) scratchPool[i] = document.createElement('canvas');
  return scratchPool[i];
}

function downscale(source, sw, sh, longSide, reuse) {
  const k = Math.min(1, longSide / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * k));
  const th = Math.max(1, Math.round(sh * k));

  // I canvas intermedi vengono riusati: nell'anteprima questa
  // funzione gira trenta volte al secondo.
  let src = source, cw = sw, ch = sh, step = 0;
  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(tw, cw >> 1);
    const nh = Math.max(th, ch >> 1);
    const tmp = scratch(step++);
    tmp.width = nw; tmp.height = nh;
    const c2 = tmp.getContext('2d');
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh);
    src = tmp; cw = nw; ch = nh;
  }
  const out = reuse || document.createElement('canvas');
  out.width = tw; out.height = th;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cw, ch, 0, 0, tw, th);
  return out;
}

/* ---------------------------------------------------------
   Renderer
   --------------------------------------------------------- */

class Renderer {
  constructor(canvas) {
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
    this.gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!this.gl) throw new Error('WebGL non disponibile su questo browser.');
    const gl = this.gl;
    this.canvas = canvas;
    this.programs = {};
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texDetail = this.makeTexture();
    this.texMid    = this.makeTexture();
    this.texBase   = this.makeTexture();
    this.sizes = { detail: [1, 1], mid: [1, 1], base: [1, 1] };
  }

  makeTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    return sh;
  }

  program(id) {
    if (this.programs[id]) return this.programs[id];
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, PRELUDE + FRAG[id]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    const u = (n) => gl.getUniformLocation(p, n);
    this.programs[id] = {
      p, a_pos: gl.getAttribLocation(p, 'a_pos'),
      u_tex: u('u_tex'), u_mid: u('u_mid'), u_base: u('u_base'),
      u_midTexel: u('u_midTexel'), u_baseTexel: u('u_baseTexel'),
      u_scale: u('u_scale'), u_amount: u('u_amount'), u_clean: u('u_clean'),
      u_time: u('u_time'), u_flip: u('u_flip'),
    };
    return this.programs[id];
  }

  put(tex, source, w, h, slot) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    this.sizes[slot] = [w, h];
  }

  /* Carica i tre livelli a partire da una sorgente (video, immagine
     o canvas). mid/base possono essere gia' pronti per evitare di
     ricalcolarli a ogni frame. */
  load(source, sw, sh, opts) {
    const o = opts || {};
    this.put(this.texDetail, source, sw, sh, 'detail');
    const mid = o.mid || (Math.max(sw, sh) <= MID_SIDE * 1.25 ? null : downscale(source, sw, sh, MID_SIDE, o.midCanvas));
    if (mid) this.put(this.texMid, mid, mid.width, mid.height, 'mid');
    else { this.put(this.texMid, source, sw, sh, 'mid'); }
    const base = o.base || downscale(mid || source, mid ? mid.width : sw, mid ? mid.height : sh, BASE_SIDE, o.baseCanvas);
    this.put(this.texBase, base, base.width, base.height, 'base');
  }

  draw(effectId, o) {
    const gl = this.gl;
    const s = this.program(effectId);
    const w = o.width, h = o.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(s.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(s.a_pos);
    gl.vertexAttribPointer(s.a_pos, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texDetail); gl.uniform1i(s.u_tex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texMid);    gl.uniform1i(s.u_mid, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texBase);   gl.uniform1i(s.u_base, 2);

    gl.uniform2f(s.u_midTexel,  1 / this.sizes.mid[0],  1 / this.sizes.mid[1]);
    gl.uniform2f(s.u_baseTexel, 1 / this.sizes.base[0], 1 / this.sizes.base[1]);
    gl.uniform1f(s.u_scale,  Math.max(w, h) / MID_SIDE);
    gl.uniform1f(s.u_amount, o.amount);
    gl.uniform1f(s.u_clean,  o.clean ? 1 : 0);
    gl.uniform1f(s.u_time,   o.time || 0);
    gl.uniform1f(s.u_flip,   o.flip ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    [this.texDetail, this.texMid, this.texBase].forEach((t) => gl.deleteTexture(t));
    Object.values(this.programs).forEach((s) => gl.deleteProgram(s.p));
    this.programs = {};
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
