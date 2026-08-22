/* =========================================================
   Analisi del volto, in locale
   =========================================================
   MediaPipe Tasks Vision, servito dal sito stesso: nessuna CDN,
   nessuna chiamata di rete verso terzi, nessuna immagine che esce
   dal telefono. Verificato che non serve l'isolamento cross-origin
   (crossOriginIsolated = false), altrimenti su GitHub Pages non si
   potrebbe fare: gli header COOP/COEP non sono impostabili.

   I file pesano circa 16 MB, quindi vengono caricati solo quando
   l'utente accende una funzione che li richiede.
   ========================================================= */

const Face = {
  stato: 'spento',            // spento | carico | pronto | errore
  vision: null,
  landmarker: null,
  segmenter: null,
  errore: null,

  async prepara(onStato) {
    if (this.stato === 'pronto') return true;
    if (this.stato === 'carico') return false;
    this.stato = 'carico';
    if (onStato) onStato('carico');
    try {
      const mod = await import('./vendor/mediapipe/vision_bundle.mjs');
      const { FilesetResolver, FaceLandmarker, ImageSegmenter } = mod;
      this.vision = await FilesetResolver.forVisionTasks('./vendor/mediapipe/wasm');

      // delegate GPU dove c'e', con ricaduta su CPU
      const crea = async (delegate) => {
        this.landmarker = await FaceLandmarker.createFromOptions(this.vision, {
          baseOptions: { modelAssetPath: './vendor/models/face_landmarker.task', delegate },
          runningMode: 'IMAGE', numFaces: 1, outputFaceBlendshapes: false,
        });
        this.segmenter = await ImageSegmenter.createFromOptions(this.vision, {
          baseOptions: { modelAssetPath: './vendor/models/selfie_segmenter.tflite', delegate },
          runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: false,
        });
      };
      try { await crea('GPU'); } catch (e) { await crea('CPU'); }

      this.stato = 'pronto';
      if (onStato) onStato('pronto');
      return true;
    } catch (e) {
      this.stato = 'errore';
      this.errore = e && e.message ? e.message : String(e);
      if (onStato) onStato('errore', this.errore);
      return false;
    }
  },

  /* Indici dei punti che servono, sui 478 di MediaPipe. */
  PUNTI: {
    pupillaSx: 468, pupillaDx: 473,
    occhioSxEst: 33, occhioSxInt: 133, occhioDxInt: 362, occhioDxEst: 263,
    occhioSxSu: 159, occhioSxGiu: 145, occhioDxSu: 386, occhioDxGiu: 374,
    naso: 4, nasoBase: 1, nasoSx: 234, nasoDx: 454,
    boccaSx: 61, boccaDx: 291, boccaSu: 13, boccaGiu: 14,
    mento: 152, fronte: 10, guanciaSx: 234, guanciaDx: 454,
  },

  /* Misure normalizzate (0..1) utili al warp caricaturale. */
  misura(punti) {
    const P = this.PUNTI;
    const p = (i) => ({ x: punti[i].x, y: punti[i].y });
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const occhioSx = p(P.pupillaSx), occhioDx = p(P.pupillaDx);
    const mento = p(P.mento), fronte = p(P.fronte);
    const inter = dist(occhioSx, occhioDx);
    return {
      occhioSx, occhioDx, mento, fronte,
      naso: p(P.naso), boccaSx: p(P.boccaSx), boccaDx: p(P.boccaDx),
      centro: { x: (occhioSx.x + occhioDx.x) / 2, y: (occhioSx.y + occhioDx.y) / 2 },
      interoculare: inter,
      altezzaVolto: dist(fronte, mento),
      raggioOcchio: Math.max(dist(p(P.occhioSxEst), p(P.occhioSxInt)),
                             dist(p(P.occhioDxInt), p(P.occhioDxEst))) * 0.75,
      // inclinazione: serve a capire se il volto e' di tre quarti
      asimmetria: Math.abs(dist(occhioSx, p(P.naso)) - dist(occhioDx, p(P.naso))) / Math.max(inter, 1e-4),
    };
  },

  /* Maschera persona/sfondo, resa come canvas in scala di grigi.
     Viene disegnata a risoluzione ridotta e riportata in scala: il
     ricampionamento bilineare fa da sfumatura sul bordo, che serve a
     non lasciare un contorno tagliato con l'accetta. */
  mascheraCanvas(maschera, w, h, centro) {
    const arr = maschera.getAsUint8Array();
    const mw = maschera.width, mh = maschera.height;

    /* La polarita' della maschera non e' la stessa in tutte le versioni
       del modello: a seconda dell'ordine delle categorie, la persona
       puo' essere lo zero o l'uno. Invece di fidarsi, si campiona la
       maschera dove SAPPIAMO che c'e' la persona — il centro del volto
       rilevato, o il centro dell'immagine se il volto manca — e se li'
       risulta vuota, si inverte. */
    const cx = Math.round(Math.min(0.98, Math.max(0.02, centro ? centro.x : 0.5)) * (mw - 1));
    const cy = Math.round(Math.min(0.98, Math.max(0.02, centro ? centro.y : 0.5)) * (mh - 1));
    let dentro = 0, campioni = 0;
    const r = Math.max(2, Math.round(Math.min(mw, mh) * 0.04));
    for (let y = Math.max(0, cy - r); y <= Math.min(mh - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(mw - 1, cx + r); x++) {
        dentro += arr[y * mw + x] > 0 ? 1 : 0; campioni++;
      }
    }
    const inverti = campioni > 0 && (dentro / campioni) < 0.5;

    const piccolo = document.createElement('canvas');
    piccolo.width = mw; piccolo.height = mh;
    const id = piccolo.getContext('2d').createImageData(mw, mh);
    for (let i = 0; i < arr.length; i++) {
      let v = arr[i] > 0 ? 255 : 0;
      if (inverti) v = 255 - v;
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    piccolo.getContext('2d').putImageData(id, 0, 0);

    // Ridotta un poco: il ricampionamento bilineare della GPU la riporta
    // in scala con un bordo sfumato, che e' cio' che evita il contorno
    // tagliato con l'accetta attorno alla persona.
    const out = document.createElement('canvas');
    out.width = Math.max(48, Math.round(mw / 1.5));
    out.height = Math.max(48, Math.round(mh / 1.5));
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(piccolo, 0, 0, out.width, out.height);
    piccolo.width = piccolo.height = 0;
    return out;
  },

  /* Analizza un canvas o un ImageBitmap. Non lancia: se il volto non
     viene trovato restituisce misure nulle e l'app degrada da sola. */
  async analizza(sorgente, w, h) {
    if (this.stato !== 'pronto') return { ok: false, motivo: 'motore non pronto' };
    const res = { ok: true, volto: null, maschera: null };
    try {
      const out = this.landmarker.detect(sorgente);
      if (out.faceLandmarks && out.faceLandmarks[0]) {
        res.volto = this.misura(out.faceLandmarks[0]);
        res.punti = out.faceLandmarks[0].length;
      }
    } catch (e) { res.erroreVolto = String(e && e.message); }
    try {
      const s = this.segmenter.segment(sorgente);
      if (s.categoryMask) {
        const centro = res.volto ? res.volto.centro : null;
        res.maschera = this.mascheraCanvas(s.categoryMask, w, h, centro);
        s.categoryMask.close();
      }
    } catch (e) { res.erroreMaschera = String(e && e.message); }
    return res;
  },
};
