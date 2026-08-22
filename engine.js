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
/* Su molte GPU mobili mediump ha una decina di bit di mantissa. Qui si
   lavora su differenze dell'ordine del millesimo e su coordinate in
   pixel che arrivano a qualche migliaio: in mediump il retino e la
   grana degenerano in strisce. */
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;

uniform sampler2D u_tex;       // dettaglio (piena risoluzione)
uniform sampler2D u_mid;       // livello contorni
uniform sampler2D u_base;      // livello colore
uniform sampler2D u_mask;      // maschera persona/sfondo (1 = persona)
uniform vec2  u_midTexel;      // passo di riferimento: 1/900 del lato lungo
uniform vec2  u_baseTexel;     // 1.0 / dimensione del livello colore
uniform float u_scale;         // lato lungo in uscita / 900: scala i pattern in pixel
uniform float u_amount;        // 0..1 intensita'
uniform float u_clean;         // 1.0 = senza grana/vignetta/retino (uso come reference)
uniform vec3  u_avg;           // colore medio della scena: serve al bilanciamento del bianco
uniform float u_time;

uniform float u_hasMask;       // 1.0 = maschera della persona disponibile
uniform float u_bgFlat;        // 1.0 = sostituisci lo sfondo col fondo piatto
uniform vec3  u_bg;            // colore del fondo piatto

/* Caricatura: misure del volto in coordinate normalizzate. */
uniform float u_hasFace;
uniform float u_car;           // 0 = nessuna caricatura, 1 = massima
uniform vec2  u_eyeL, u_eyeR;  // pupille
uniform vec2  u_brow, u_chin;  // fronte, mento
uniform float u_eyeRad;        // raggio dell'occhio
uniform float u_aspect;        // larghezza/altezza, per misurare distanze vere

vec2 cl(vec2 uv){ return clamp(uv, vec2(0.001), vec2(0.999)); }
vec3 tx(vec2 uv){ return texture2D(u_tex,  cl(uv)).rgb; }
vec3 md(vec2 uv){ return texture2D(u_mid,  cl(uv)).rgb; }
vec3 bs(vec2 uv){ return texture2D(u_base, cl(uv)).rgb; }

float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
/* Senza sin(): con coordinate in pixel l'argomento arriva a 1e6 e la
   funzione perde ogni entropia proprio dove serve. */
float hash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

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

/* Sfumatura sul livello contorni: serve alla differenza di gaussiane. */
float midSoft(vec2 uv, float k){
  vec2 sp = u_midTexel * k;
  float o = lum(md(uv)) * 4.0;
  o += (lum(md(uv + vec2(sp.x, 0.0))) + lum(md(uv - vec2(sp.x, 0.0)))
      + lum(md(uv + vec2(0.0, sp.y))) + lum(md(uv - vec2(0.0, sp.y)))) * 2.0;
  o += lum(md(uv + sp)) + lum(md(uv - sp))
     + lum(md(uv + vec2(sp.x, -sp.y))) + lum(md(uv + vec2(-sp.x, sp.y)));
  return o / 16.0;
}

/* Limitato in ampiezza: senza il clamp un bordo molto contrastato
   (occhiali, denti, capelli sul cielo) genera un alone chiaro/scuro
   che l'AI legge come un tratto del personaggio. */
float relief(vec2 uv){ return clamp(lum(tx(uv)) - lum(md(uv)), -0.14, 0.14); }

/* Linea di inchiostro.

   La differenza di gaussiane classica (XDoG) usa una soglia assoluta,
   che su foto con esposizioni diverse produce ora troppa linea ora
   nessuna. Qui la differenza e' normalizzata sulla luminanza locale:
   "quanto questo punto e' piu' scuro del suo intorno, in proporzione".
   Il risultato e' indipendente dall'esposizione, e la soglia morbida
   da' una linea di spessore variabile invece di un contorno uniforme
   da fotocopia. */
float inkLine(vec2 uv, float k, float soglia, float morbido){
  float a = midSoft(uv, k);
  float b = midSoft(uv, k * 3.0);
  float scuro = (b - a) / max(b, 0.06);
  float ink = smoothstep(soglia, soglia + morbido, scuro);
  // sotto una certa differenza assoluta non c'e' niente da disegnare:
  // senza questa porta la pelle e il rumore JPEG diventano tratteggio
  return ink * smoothstep(0.005, 0.018, b - a);
}

/* Spessore variabile del tratto. Non si cambia il raggio del
   rilevatore, si sposta la SOGLIA: piu' bassa dove un inchiostratore
   calcherebbe (in ombra), piu' alta sul dettaglio fine, cosi' occhi e
   denti restano aperti invece di riempirsi. */
float inkVar(vec2 uv, float k, float base, float morbido){
  float tono = lum(bsSoft(uv, 2.0));
  float ombra = smoothstep(0.55, 0.12, tono);
  float fine  = smoothstep(0.02, 0.10, abs(relief(uv)));
  float soglia = base * (1.0 - 0.45 * ombra + 0.55 * fine);
  return inkLine(uv, k, max(soglia, 0.012), morbido);
}

/* Contorno esterno del personaggio, preso dal bordo della maschera.
   E' la linea che un disegnatore traccia per prima: chiusa, continua,
   e indipendente dal contrasto della foto. */
float maskEdge(vec2 uv, float k){
  if (u_hasMask < 0.5) return 0.0;
  vec2 sp = u_midTexel * k;
  float gx = texture2D(u_mask, cl(uv + vec2(sp.x, 0.0))).r
           - texture2D(u_mask, cl(uv - vec2(sp.x, 0.0))).r;
  float gy = texture2D(u_mask, cl(uv + vec2(0.0, sp.y))).r
           - texture2D(u_mask, cl(uv - vec2(0.0, sp.y))).r;
  return length(vec2(gx, gy));
}

/* ---- caricatura ----
   Warp per feature in mappatura inversa: per INGRANDIRE una zona, la
   coordinata di campionamento si sposta VERSO il centro della zona.
   Il peso segue una smoothstep sul raggio, cosi' non si vedono
   gradini, e la somma degli spostamenti svanisce ai bordi
   dell'inquadratura, altrimenti lo sfondo appare stirato. */
vec2 lente(vec2 uv, vec2 c, float r, float forza){
  vec2 d = (uv - c) * vec2(u_aspect, 1.0);
  float len = length(d);
  if (len >= r) return uv;
  float t = 1.0 - len / r;
  float w = t * t * (3.0 - 2.0 * t);
  return c + (uv - c) / (1.0 + forza * w);
}

vec2 warp(vec2 uv0){
  if (u_hasFace < 0.5 || u_car < 0.01) return uv0;
  float k = u_car;
  vec2 uv = uv0;

  /* Tutte le misure sono ancorate alla distanza interoculare: e' la
     grandezza piu' stabile del volto, non cambia con l'inquadratura
     ne' con la posa come farebbero l'altezza del viso o il ritaglio. */
  float d = max(length((u_eyeR - u_eyeL) * vec2(u_aspect, 1.0)), 0.001);

  // occhi piu' grandi: al massimo del 18%
  uv = lente(uv, u_eyeL, d * 0.95, 0.18 * k);
  uv = lente(uv, u_eyeR, d * 0.95, 0.18 * k);

  /* Cranio piu' alto. Uno stiramento verticale sopra la linea delle
     sopracciglia, non una bolla radiale: la bolla gonfia anche lo
     sfondo attorno alla testa e si vede subito. */
  float browY = u_brow.y;
  if (uv.y < browY) {
    float t = clamp((browY - uv.y) / max(browY, 0.001), 0.0, 1.0);
    float win = smoothstep(0.0, 0.30, t) * (1.0 - smoothstep(0.80, 1.0, t));
    uv.y = browY - (browY - uv.y) / (1.0 + 0.10 * k * win);
  }

  /* Mandibola piu' stretta, verso l'asse del volto. */
  float jawY = mix(u_brow.y, u_chin.y, 0.72);
  if (uv.y > jawY) {
    float t = clamp((uv.y - jawY) / max(u_chin.y - jawY, 0.001), 0.0, 1.0);
    float win = smoothstep(0.0, 0.45, t);
    uv.x = u_chin.x + (uv.x - u_chin.x) / (1.0 - 0.09 * k * win);
  }

  /* Lo spostamento totale svanisce ai bordi dell'inquadratura,
     altrimenti si vede lo sfondo stirato contro la cornice. */
  vec2 disp = uv - uv0;
  float bordo = min(min(uv0.x, 1.0 - uv0.x), min(uv0.y, 1.0 - uv0.y));
  return uv0 + disp * smoothstep(0.0, 0.08, bordo);
}

/* Composizione finale: dove c'e' la maschera, lo sfondo diventa un
   fondo piatto. Un design di personaggio su fondo uniforme e' anche
   cio' che serve a un modello generativo: lo sfondo di una foto
   rientrerebbe come palette e ambientazione in tutte le tavole. */
vec4 finishCol(vec3 c, vec2 uv, vec3 fondo){
  if (u_bgFlat > 0.5) {
    float m = texture2D(u_mask, cl(uv)).r;
    c = mix(fondo, c, smoothstep(0.30, 0.62, m));
  }
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}

/* Il fondo non e' lo stesso per tutti: su un disegno a matita un
   rettangolo grigio attorno al foglio si vede, quindi ogni effetto
   passa il proprio. */
vec4 finish(vec3 c, vec2 uv){ return finishCol(c, uv, u_bg); }

/* Microcontrasto: quanto il dettaglio si discosta dal livello
   contorni. Serve a non perdere occhi, denti e montature quando
   il colore viene appiattito. */

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

/* Bonifica tonale: la stessa correzione dell'effetto ritratto, ma a
   forza fissa e moderata, applicata anche sotto gli stili. Un cartone
   con la dominante arancione del controluce resta un cartone
   arancione, e quella dominante finisce nel personaggio. */
vec3 fixTone(vec3 c){
  const float k = 0.75;
  vec3 gain = clamp(vec3(lum(u_avg)) / max(u_avg, vec3(0.05)), vec3(0.78), vec3(1.30));
  c *= mix(vec3(1.0), gain, k);
  vec3 lifted = pow(clamp(c, 0.0, 1.0), vec3(1.0 / (1.0 + 0.55 * k)));
  return clamp(mix(c, lifted, smoothstep(0.55, 0.04, lum(c))), 0.0, 1.0);
}

/* Campitura: tinta e saturazione da un livello molto sfumato,
   luminosita' da uno piu' vicino al dettaglio.

   E' il motivo per cui la pelle nei cartoni e' di un colore solo: se
   si quantizza il colore cosi' com'e', una luce irregolare su un viso
   diventa una mappa di chiazze che non seguono nessun tratto. */
vec3 flatten(vec2 uv, float kLuma, float kCroma){
  vec3 hsvL = rgb2hsv(fixTone(bsSoft(uv, kLuma)));
  vec3 hsvC = rgb2hsv(fixTone(bsSoft(uv, kCroma)));
  return hsv2rgb(vec3(hsvC.x, hsvC.y, hsvL.z));
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

  /* ------- Ritratto: nessuna stilizzazione, solo bonifica -------
     Non viene deformato: e' la versione fedele. */
  ritratto: `
  void main(){
    float a = u_amount;
    vec3 c = tx(v_uv);
    vec3 gain = vec3(lum(u_avg)) / max(u_avg, vec3(0.05));
    gain = clamp(gain, vec3(0.72), vec3(1.45));
    c *= mix(vec3(1.0), gain, a);
    vec3 lifted = pow(clamp(c, 0.0, 1.0), vec3(1.0 / (1.0 + 0.75 * a)));
    c = mix(c, lifted, smoothstep(0.60, 0.03, lum(c)));
    c += relief(v_uv) * 0.35 * a;
    c = mix(vec3(lum(c)), c, 1.0 + 0.12 * a);
    c = (c - 0.5) * (1.0 + 0.10 * a) + 0.5;
    gl_FragColor = finish(c, v_uv);
  }`,

  /* ------- Cartoon: campiture piatte + contorno marcato ------- */
  cartoon: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    vec3 c = quantize(flatten(uv, 0.6 + a * 1.1, 4.0 + a * 3.0), mix(14.0, 6.0, a));
    c = satBoost(c, a * 0.7);
    c = clamp(c * 1.06 + 0.02, 0.0, 1.0);
    c += relief(uv) * (0.55 - a * 0.15);
    float e = edgeMid(uv, 1.0 + a);
    float edge = smoothstep(mix(0.60, 0.16, a), mix(0.90, 0.44, a), e);
    c = mix(c, vec3(0.06, 0.05, 0.09), edge);
    gl_FragColor = finish(c, uv);
  }`,

  /* ------- Fumetto: inchiostro XDoG su tre toni piatti -------
     E' la modalita' pensata come "design del personaggio": linea di
     spessore variabile, neri pieni nelle ombre, nessuna texture
     periodica che un modello generativo copierebbe come materia. */
  inchiostro: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;

    /* Tre toni piatti, con le soglie riferite alla luminanza media
       della scena: soglie assolute darebbero un viso tutto bianco su
       una foto chiara e tutto in ombra su una scura. */
    vec3 hsv = rgb2hsv(flatten(uv, 0.5, 9.0));
    float lVera = hsv.z;                     // luminanza prima della quantizzazione
    float m = clamp(lum(u_avg), 0.20, 0.80);
    float t1 = m * mix(1.20, 1.08, a);
    float t2 = m * mix(0.80, 0.66, a);
    hsv.z = 0.58
      + 0.20 * smoothstep(t2 - 0.04, t2 + 0.04, lVera)
      + 0.22 * smoothstep(t1 - 0.04, t1 + 0.04, lVera);
    hsv.y = clamp(hsv.y * (1.0 + 0.55 * a), 0.0, 1.0);
    vec3 c = hsv2rgb(hsv);

    /* Una sola passata di linea, fine. Una seconda passata a raggio
       largo riempiva di nero occhi, naso e bocca: rispondeva all'intera
       zona in ombra, non al suo bordo. */
    float ink = inkVar(uv, 3.0, mix(0.10, 0.030, a), 0.05);
    ink = max(ink, smoothstep(0.12, 0.45, maskEdge(uv, 2.0)));   // contorno del personaggio

    /* Neri pieni nelle ombre profonde, misurati sulle luminanze vere e
       non sui toni gia' appiattiti; e non dentro gli occhi, che sono
       scuri e sono la parte che regge la somiglianza. */
    float macchia = smoothstep(m * 0.58, m * 0.30, lVera) * 0.78;
    if (u_hasFace > 0.5) {
      float dOcc = max(length((u_eyeR - u_eyeL) * vec2(u_aspect, 1.0)), 0.001);
      float dist = min(length((uv - u_eyeL) * vec2(u_aspect, 1.0)),
                       length((uv - u_eyeR) * vec2(u_aspect, 1.0)));
      macchia *= 1.0 - 0.80 * smoothstep(dOcc * 0.60, dOcc * 0.25, dist);
    }
    ink = clamp(max(ink, macchia), 0.0, 1.0);

    c = mix(c, vec3(0.05, 0.045, 0.07), ink);
    gl_FragColor = finish(c, uv);
  }`,

  /* ------- Anime: cel shading, colori saturi, luce soffusa ------- */
  anime: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    vec3 hsv = rgb2hsv(flatten(uv, 0.8 + a * 1.4, 6.0 + a * 4.0));
    float bands = mix(9.0, 4.0, a);
    float v = floor(hsv.z * bands + 0.5) / bands;
    hsv.z = clamp(mix(hsv.z, v, 0.2 + a * 0.8) * 1.12 + 0.05, 0.0, 1.0);
    hsv.y = clamp(hsv.y * (1.0 + a * 0.7 * smoothstep(0.05, 0.28, hsv.y)), 0.0, 1.0);
    vec3 c = hsv2rgb(hsv);

    c += max(bsSoft(uv, 3.0) - 0.70, 0.0) * 1.1 * a;
    float sh = smoothstep(0.35, 0.0, lum(c));
    c = mix(c, c * vec3(0.90, 0.94, 1.10), sh * 0.35 * a);
    c += relief(uv) * (0.5 - a * 0.15);

    float e = edgeMid(uv, 0.9);
    float edge = smoothstep(mix(0.62, 0.22, a), mix(0.92, 0.52, a), e);
    c = mix(c, vec3(0.15, 0.10, 0.19), edge * 0.94);
    gl_FragColor = finish(c, uv);
  }`,

  /* ------- Matita: grafite su carta ------- */
  matita: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    float g = lum(fixTone(tx(uv)));
    float b = lum(fixTone(bsSoft(uv, 0.7 + a * 1.6)));
    float dodge = clamp(g / max(b, 0.004), 0.0, 1.0);
    float ink = pow(1.0 - dodge, mix(1.25, 0.5, a)) * mix(1.3, 2.6, a);
    ink += smoothstep(0.18, 0.68, edgeMid(uv, 1.1)) * mix(0.35, 0.9, a);

    vec2 px = uv / (u_midTexel * u_scale);
    float shade = smoothstep(0.42, 0.04, lum(md(uv))) * 0.55 * a;
    float hatch = smoothstep(0.30, 0.70, abs(fract((px.x + px.y) / 7.0) - 0.5) * 2.0);
    ink += shade * mix(mix(0.45, 1.0, hatch), 0.8, u_clean);
    ink = clamp(ink, 0.0, 1.0);

    float grain = hash(floor(px / 2.0)) * 0.07 * (1.0 - u_clean);
    vec3 paper = vec3(0.965, 0.950, 0.925) - grain;
    vec3 lead  = vec3(0.11, 0.10, 0.13) + grain * 0.5;
    gl_FragColor = finishCol(mix(paper, lead, ink), uv, vec3(0.965, 0.950, 0.925));
  }`,

  /* ------- Retino: mezzatinta alla vecchia maniera ------- */
  fumetto: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    vec3 base = flatten(uv, 0.5, 4.0);
    float g = clamp(pow(lum(base), 0.70) * 1.35, 0.0, 1.0);

    float cell = mix(12.0, 8.0, a) * u_scale;
    vec2 px = uv / u_midTexel * u_scale;
    float ang = 0.7853981;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * px / cell;
    vec2 f = fract(q) - 0.5;
    float radius = sqrt(clamp(1.0 - g, 0.0, 1.0)) * 0.52;
    float dots = 1.0 - smoothstep(radius - 0.10, radius + 0.10, length(f));
    dots *= 1.0 - u_clean;

    float edge = smoothstep(0.22, 0.58, edgeMid(uv, 1.2));
    float ink = clamp(max(dots, edge), 0.0, 1.0);

    vec3 flatc = clamp(satBoost(quantize(base, 4.0), 0.8) * 1.10 + 0.04, 0.0, 1.0);
    flatc += relief(uv) * 0.35 * u_clean;
    vec3 paper = mix(flatc, vec3(1.0, 0.99, 0.96), a * 0.45 * (1.0 - u_clean * 0.6));
    gl_FragColor = finish(mix(paper, vec3(0.07, 0.06, 0.09), ink), uv);
  }`,

  /* ------- Acquerello ------- */
  acquerello: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    vec3 c = flatten(uv, 1.0 + a * 1.5, 3.0 + a * 2.0);
    c = quantize(c, mix(16.0, 8.0, a));
    c = satBoost(c, 0.65 * a);
    c = clamp(c * 1.08 + 0.05, 0.0, 1.0);
    c += relief(uv) * 0.35;

    float edge = smoothstep(0.22, 0.85, edgeMid(uv, 1.3));
    c *= 1.0 - edge * 0.55 * a;
    vec2 px = uv / u_midTexel * u_scale;
    c += (hash(floor(px / 3.0)) - 0.5) * 0.10 * a * (1.0 - u_clean);
    float vg = smoothstep(1.15, 0.35, length(uv - 0.5) * 1.4);
    c = mix(vec3(0.99, 0.98, 0.95), c, mix(1.0, vg, 0.55 * a * (1.0 - u_clean)));
    gl_FragColor = finishCol(c, uv, vec3(0.99, 0.98, 0.95));
  }`,

  /* ------- Neon ------- */
  neon: `
  void main(){
    vec2 uv = warp(v_uv);
    float a = u_amount;
    float g    = smoothstep(0.15, 0.90, edgeMid(uv, 1.0 + a * 1.5));
    float glow = smoothstep(0.05, 0.80, edgeMid(uv, 3.0 + a * 4.0)) * 0.65;
    float hue  = fract(uv.y * 0.6 + uv.x * 0.2 + u_time * 0.06);
    vec3 neon  = hsv2rgb(vec3(hue, 0.85, 1.0));
    vec3 dark  = md(uv) * mix(0.40, 0.06, a);
    gl_FragColor = finishCol(dark + neon * (g * 1.3 + glow * 0.7), uv, vec3(0.03, 0.03, 0.05));
  }`,
};

const EFFECTS = [
  { id: 'ritratto',   name: 'Ritratto',   emoji: '🪪', ref: 'identita' },
  { id: 'inchiostro', name: 'Fumetto',    emoji: '💥', ref: 'ottimo'  },
  { id: 'cartoon',    name: 'Cartoon',    emoji: '🎨', ref: 'ottimo'  },
  { id: 'anime',      name: 'Anime',      emoji: '✨', ref: 'ottimo'  },
  { id: 'matita',     name: 'Matita',     emoji: '✏️', ref: 'buono'   },
  { id: 'fumetto',    name: 'Retino',     emoji: '🔘', ref: 'medio'   },
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

/* soglia: oltre quante volte di riduzione si passa per un dimezzamento
   intermedio. Due da' la qualita' migliore ed e' quella dell'export;
   dal vivo si usa tre, dove un passaggio in meno vale piu' di un filo
   di aliasing su un'anteprima. */
function downscale(source, sw, sh, longSide, reuse, soglia) {
  const lim = soglia || 2;
  const k = Math.min(1, longSide / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * k));
  const th = Math.max(1, Math.round(sh * k));

  // I canvas intermedi vengono riusati: nell'anteprima questa
  // funzione gira trenta volte al secondo.
  let src = source, cw = sw, ch = sh, step = 0;
  while (cw > tw * lim && ch > th * lim) {
    const nw = Math.max(tw, cw >> 1);
    const nh = Math.max(th, ch >> 1);
    const tmp = scratch(step++);
    // assegnare width/height ricrea il buffer del canvas anche con lo
    // stesso valore: a trenta fotogrammi al secondo e' spazzatura da
    // raccogliere che si accumula, ed e' una delle ragioni per cui
    // l'anteprima peggiora col passare dei secondi
    if (tmp.width !== nw || tmp.height !== nh) { tmp.width = nw; tmp.height = nh; }
    const c2 = tmp.getContext('2d');
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh);
    src = tmp; cw = nw; ch = nh;
  }
  const out = reuse || document.createElement('canvas');
  if (out.width !== tw || out.height !== th) { out.width = tw; out.height = th; }
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cw, ch, 0, 0, tw, th);
  return out;
}

/* Colore medio, letto sul livello piu' piccolo: 250x333 pixel bastano
   per stimare la dominante e costa niente.

   La media e' pesata verso il centro. Su un controluce al tramonto la
   media dell'intera scena e' dominata dal cielo arancione: il
   bilanciamento del bianco sovracorregge e il viso vira al ciano,
   cioe' peggiora esattamente il caso che deve risolvere. */
function averageColor(cv) {
  try {
    const w = cv.width, h = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const x0 = w * 0.18, x1 = w * 0.82, y0 = h * 0.18, y1 = h * 0.82;
    let r = 0, g = 0, b = 0, tot = 0;
    for (let y = 0; y < h; y++) {
      const inY = y >= y0 && y <= y1;
      for (let x = 0; x < w; x++) {
        const wgt = (inY && x >= x0 && x <= x1) ? 1 : 0.2;
        const i = (y * w + x) * 4;
        r += d[i] * wgt; g += d[i + 1] * wgt; b += d[i + 2] * wgt; tot += wgt;
      }
    }
    return [r / tot / 255, g / tot / 255, b / tot / 255];
  } catch (e) {
    return [0.5, 0.5, 0.5];   // canvas non leggibile: si resta neutri
  }
}

/* Il canvas 2D di iOS non lancia eccezioni quando l'area richiesta
   e' troppo grande: alloca e resta vuoto. L'unico modo di saperlo e'
   scrivere e rileggere un pixel nell'angolo opposto. */
function canvasFits(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  let ok = false;
  try {
    const x = c.getContext('2d');
    if (x) {
      x.fillStyle = '#ff0000';
      x.fillRect(w - 1, h - 1, 1, 1);
      ok = x.getImageData(w - 1, h - 1, 1, 1).data[0] === 255;
    }
  } catch (e) { ok = false; }
  c.width = c.height = 0;      // libera subito il backing store
  return ok;
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
    // MAX_TEXTURE_SIZE e' dichiarato dal driver e non vincola il
    // bersaglio di render: contano anche renderbuffer e viewport.
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [4096, 4096];
    this.maxTexture = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE),
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 4096,
      dims[0], dims[1]
    );

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.texDetail = this.makeTexture();
    this.texMid    = this.makeTexture();
    this.texBase   = this.makeTexture();
    this.texMask   = this.makeTexture();
    this.sizes = { detail: [1, 1], mid: [1, 1], base: [1, 1], mask: [1, 1] };
    this.hasMask = false;
    this.face = null;
    this.checkErrors = true;    // l'anteprima dal vivo lo spegne
  }

  makeTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // un pixel bianco: campionare una texture mai caricata da risultati
    // indefiniti, e la maschera puo' non esserci
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
                  new Uint8Array([255, 255, 255]));
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
      u_avg: u('u_avg'), u_time: u('u_time'), u_flip: u('u_flip'),
      u_mask: u('u_mask'), u_hasMask: u('u_hasMask'), u_bgFlat: u('u_bgFlat'), u_bg: u('u_bg'),
      u_hasFace: u('u_hasFace'), u_car: u('u_car'), u_aspect: u('u_aspect'),
      u_eyeL: u('u_eyeL'), u_eyeR: u('u_eyeR'), u_brow: u('u_brow'),
      u_chin: u('u_chin'), u_eyeRad: u('u_eyeRad'),
    };
    return this.programs[id];
  }

  put(tex, source, w, h, slot) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    /* Se la misura non e' cambiata si aggiorna il contenuto della
       texture invece di riallocarla: texImage2D butta via il buffer sulla
       scheda grafica e ne chiede un altro a ogni fotogramma. */
    const prec = this.sizes[slot];
    if (prec && prec[0] === w && prec[1] === h && prec[2] === true) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
    }
    /* Un upload oltre MAX_TEXTURE_SIZE non lancia eccezioni: la texture
       resta vuota e l'immagine esce nera. L'unico modo di accorgersene e'
       leggere l'errore subito dopo — ma getError obbliga a un giro di
       andata e ritorno col processo grafico, quindi nell'anteprima dal
       vivo, dove gira trenta volte al secondo, si salta: li' le
       dimensioni sono piccole e sicure. */
    if (this.checkErrors) {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) this.uploadError = { slot, err, w, h };
    }
    this.sizes[slot] = [w, h, true];
  }

  /* Carica i tre livelli a partire da una sorgente (video, immagine
     o canvas). mid/base possono essere gia' pronti per evitare di
     ricalcolarli a ogni frame. */
  load(source, sw, sh, opts) {
    const o = opts || {};
    this.uploadError = null;
    const outSide = Math.min(o.outSide || MID_SIDE, this.maxTexture);

    /* Livello di DETTAGLIO, ridotto alla risoluzione di uscita.

       Misurato: caricare il <video> nativo direttamente come texture
       costa piu' che ridurlo prima — sono megabyte di upload a ogni
       fotogramma invece di poche centinaia di kilobyte, e il
       ridimensionamento su canvas e' accelerato. Vale anche la ragione
       di correttezza: minificare una texture senza mipmap campiona per
       punti, e il microcontrasto arriverebbe come rumore aliasato. */
    let det = source, dw = sw, dh = sh;
    const soglia = o.live ? 3 : 2;
    if (Math.max(sw, sh) > outSide * 1.25) {
      det = downscale(source, sw, sh, outSide, o.detailCanvas, soglia);
      dw = det.width; dh = det.height;
    }
    this.put(this.texDetail, det, dw, dh, 'detail');

    /* Livello dei CONTORNI: si costruisce piccolo, perche' il passo di
       ricerca e' normalizzato sull'immagine e non sui suoi texel. Serve
       anche come termine di confronto per il microcontrasto, quindi deve
       restare piu' morbido del dettaglio. */
    const midSide = Math.max(320, Math.round(outSide * 0.6));
    const mid = downscale(det, dw, dh, midSide, o.midCanvas, soglia);
    this.put(this.texMid, mid, mid.width, mid.height, 'mid');

    /* Livello del COLORE: dal livello dei contorni, che e' gia' piccolo. */
    const base = o.base || downscale(mid, mid.width, mid.height, BASE_SIDE, o.baseCanvas, soglia);
    this.put(this.texBase, base, base.width, base.height, 'base');
    this.avg = averageColor(base);
  }

  /* Maschera persona/sfondo. Passare null la disattiva. */
  setMask(cv) {
    if (!cv) { this.hasMask = false; return; }
    this.put(this.texMask, cv, cv.width, cv.height, 'mask');
    this.hasMask = true;
  }

  /* Misure del volto per la caricatura. */
  setFace(m) { this.face = m || null; }

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
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.texMask);   gl.uniform1i(s.u_mask, 3);

    /* Il passo con cui si cercano i contorni e' una FRAZIONE
       DELL'IMMAGINE, non un texel del livello: 1/900 del lato lungo.
       Cosi' quel livello puo' essere costruito a qualunque risoluzione
       — e conviene costruirlo piccolo, perche' e' il pezzo piu' caro di
       tutta l'elaborazione — senza che lo spessore della linea cambi. */
    const asp = w / h;
    const rw = asp >= 1 ? MID_SIDE : MID_SIDE * asp;
    const rh = asp >= 1 ? MID_SIDE / asp : MID_SIDE;
    gl.uniform2f(s.u_midTexel, 1 / rw, 1 / rh);
    gl.uniform2f(s.u_baseTexel, 1 / this.sizes.base[0], 1 / this.sizes.base[1]);
    gl.uniform1f(s.u_scale,  Math.max(w, h) / MID_SIDE);
    gl.uniform1f(s.u_amount, o.amount);
    gl.uniform1f(s.u_clean,  o.clean ? 1 : 0);
    const avg = this.avg || [0.5, 0.5, 0.5];
    gl.uniform3f(s.u_avg, avg[0], avg[1], avg[2]);
    gl.uniform1f(s.u_time,   o.time || 0);
    gl.uniform1f(s.u_flip,   o.flip ? 1 : 0);

    const bg = o.bg || [0.88, 0.88, 0.90];
    // la maschera serve al contorno del personaggio anche quando lo
    // sfondo non viene sostituito: sono due cose distinte
    gl.uniform1f(s.u_hasMask, this.hasMask ? 1 : 0);
    gl.uniform1f(s.u_bgFlat, (this.hasMask && o.useMask) ? 1 : 0);
    gl.uniform3f(s.u_bg, bg[0], bg[1], bg[2]);

    const f = (o.car > 0.01) ? this.face : null;
    gl.uniform1f(s.u_hasFace, f ? 1 : 0);
    gl.uniform1f(s.u_car, o.car || 0);
    gl.uniform1f(s.u_aspect, w / h);
    if (f) {
      gl.uniform2f(s.u_eyeL, f.occhioSx.x, f.occhioSx.y);
      gl.uniform2f(s.u_eyeR, f.occhioDx.x, f.occhioDx.y);
      gl.uniform2f(s.u_brow, f.fronte.x, f.fronte.y + f.altezzaVolto * 0.18);
      gl.uniform2f(s.u_chin, f.mento.x, f.mento.y);
      gl.uniform1f(s.u_eyeRad, f.raggioOcchio);
    } else {
      gl.uniform2f(s.u_eyeL, 0.5, 0.5); gl.uniform2f(s.u_eyeR, 0.5, 0.5);
      gl.uniform2f(s.u_brow, 0.5, 0.5); gl.uniform2f(s.u_chin, 0.5, 0.9);
      gl.uniform1f(s.u_eyeRad, 0.05);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose() {
    const gl = this.gl;
    [this.texDetail, this.texMid, this.texBase, this.texMask].forEach((t) => gl.deleteTexture(t));
    Object.values(this.programs).forEach((s) => gl.deleteProgram(s.p));
    this.programs = {};
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
