# 🎨 Cartoon Cam

Sito web che apre la fotocamera del telefono e ti mostra **in tempo reale** in stile
cartoon, anime, disegno a matita, fumetto, acquerello o neon.

Niente app da installare, niente server: l'elaborazione avviene tutta nel browser
con WebGL, e **nessun fotogramma esce dal telefono**.

## Effetti

| Effetto | Come funziona |
|---|---|
| 🎨 **Cartoon** | colori appiattiti a pochi livelli + contorni neri marcati |
| ✨ **Anime** | cel shading a fasce, colori saturi, luce soffusa, ombre freddine, linea fine |
| ✏️ **Matita** | schizzo a grafite su carta (color dodge sul grigio sfocato) + grana |
| 💥 **Fumetto** | retino a mezzatinta a 45° + inchiostro sui bordi + colori pop |
| 🖌️ **Acquerello** | macchie morbide, bordi umidi, grana della carta, vignettatura |
| 🌈 **Neon** | solo i contorni, luminosi e con tinta che scorre, su fondo scuro |

## Comandi

- **Cerchio bianco** — scatta la foto (poi *Salva / Condividi*: va in galleria o su WhatsApp)
- **⏺** — registra un video dell'effetto (max 60 s)
- **⏸** — congela l'immagine, utile per regolare l'effetto con calma
- **🔄** — passa da fotocamera frontale a posteriore
- **⛶** — schermo intero (dove il browser lo permette)
- **Intensità** — quanto è spinto l'effetto
- **Tocco sul video** — nasconde/mostra i comandi

Effetto e intensità scelti vengono ricordati alla riapertura.

## Pubblicarlo online usando solo il telefono

La fotocamera funziona **solo su `https://`** (o su `localhost`), quindi il sito va
pubblicato. Nel repo c'è già il workflow `.github/workflows/pages.yml`: serve solo
accendere GitHub Pages, una volta.

Dal browser del telefono:

1. apri il repo su **github.com** → **Settings** (in alto, potrebbe essere nel menu `⋯`)
2. voce **Pages**
3. in *Build and deployment* → **Source**: scegli **GitHub Actions**
4. torna nella tab **Actions**: il workflow *Deploy su GitHub Pages* parte da solo al
   push successivo, oppure avvialo a mano con **Run workflow**
5. finito il workflow, l'indirizzo è `https://<utente>.github.io/<repo>/`

Apri quel link, tocca **Attiva la fotocamera** e consenti l'accesso.

> Suggerimento: dal menu di condivisione del browser scegli **Aggiungi alla schermata
> Home**. Grazie al manifest si apre a schermo pieno, come un'app.

### Alternativa senza GitHub Pages

Va bene qualunque hosting statico raggiungibile in https, per esempio
[Netlify Drop](https://app.netlify.com/drop) o Vercel: caricando i file si ottiene
subito un indirizzo https, anche dal telefono.

## Compatibilità

- **iPhone**: Safari 15+ (anche Chrome su iOS, che usa lo stesso motore). La
  registrazione video è disponibile solo dove il browser supporta `MediaRecorder`;
  se manca, il pulsante ⏺ non compare.
- **Android**: Chrome, Edge, Firefox, Samsung Internet recenti.
- Se il telefono fa fatica, la risoluzione di render si abbassa da sola per restare
  fluida (e risale quando può).

## Struttura

```
index.html            interfaccia
styles.css            stile mobile-first, con aree sicure per il notch
app.js                shader GLSL degli effetti + logica fotocamera/scatto/registrazione
manifest.webmanifest  per "Aggiungi alla schermata Home"
icon.svg              icona
```

Per provarlo su computer: `npx http-server -p 8080` e apri `http://localhost:8080`
(su localhost la fotocamera è consentita anche senza https).
