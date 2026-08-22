# 🎨 Cartoon Cam

Web app che trasforma una foto o il flusso della fotocamera in **cartoon, anime,
disegno a matita, fumetto, acquerello o neon**, e che sa preparare le immagini di
**riferimento per far costruire un personaggio a un'AI** — per libri illustrati e
fumetti.

Tutto avviene nel browser con WebGL: **nessuna immagine lascia il telefono**.

Online: `https://gdome81.github.io/avatar/`

## La cosa importante, se l'immagine serve a un'AI

**Non dare a un modello generativo una foto già "cartoonizzata" come riferimento
di identità.** I meccanismi di riferimento (Midjourney `--oref`, i reference di
Gemini, `input_fidelity` di GPT-image, IP-Adapter / InstantID) trasferiscono
l'immagine intera: retino, grana della carta, vignettatura e contorni neri spessi
vengono appresi come **tratti del personaggio**, non come stile. E i pattern
periodici, riscalati su inquadrature diverse, producono moiré non rimovibile.

La divisione corretta è:

| Cosa | Come si dichiara |
|---|---|
| **identità** (chi è) | una foto pulita, bonificata, ritagliata |
| **stile** (come è disegnato) | a parole nel prompt, o in uno slot di stile separato (`--sref`) |

Per questo lo scatto in modo foto produce una **coppia**: `identità` (foto
bonificata, senza stilizzazione) e `stile` (la versione disegnata, da usare solo
come indicazione del look). Il pulsante *Testo per l'AI* genera il prompt già
scritto, con la lista dei negativi e la "bibbia del personaggio" da riusare
identica in ogni prompt successivo.

### Come dovrebbe essere la foto di partenza

- **una sola persona** nel fotogramma (con due volti il modello ne sceglie uno o li fonde)
- **occhi visibili e nitidi**: gli occhiali da sole togliono la regione con più informazione identitaria
- **volto sul 40-60% del fotogramma**, con margine sopra la fronte — un taglio a filo fa fallire il rilevamento dei tratti
- **luce frontale morbida**: un controluce lascia il viso in ombra e il bordo luminoso viene letto come un tratto del personaggio
- sfondo semplice e uniforme: quello che c'è dietro rientra come palette e ambientazione in tutte le tavole

### Il passaggio che fa la differenza

Genera **un solo** design del personaggio dalla foto, iteralo finché non convince,
e da quel momento usa come riferimento **quel disegno**, mai più la foto. È così
che il personaggio resta lo stesso per tutte le tavole del libro.

## Come si usa

Tre modi di partire:

- **Parti da una foto** — galleria, elaborata alla risoluzione della foto
- **Scatta con la fotocamera del telefono** — apre la fotocamera di sistema, quindi la piena risoluzione del sensore (12-48 MP), non i 2 MP che dà il browser
- **Anteprima dal vivo** — per provare gli effetti in tempo reale e registrare video

In modo foto:

- **🎯 Ritaglio** — trascina il riquadro, pizzica per ridimensionarlo. Le guide tratteggiate indicano dove mettere la testa e la linea degli occhi
- **Uscita** — 1024 / 1536 / 2048 px, oppure piena. Il default 1536 è voluto: oltre i 2048 px l'identità non migliora, perché i modelli ricampionano su griglie fisse. Si guadagna **ritagliando**, non ingrandendo
- **🤖 Pulito per l'AI** — spegne grana, retino, tratteggio e vignettatura
- **🧩 Coppia identità + stile** — un solo scatto, due file

## Gli effetti

| Effetto | Che cosa fa | Come riferimento |
|---|---|---|
| 🪪 **Ritratto** | nessuna stilizzazione: bilanciamento del bianco, recupero delle ombre, microcontrasto | **è questo** il file per lo slot identità |
| 🎨 **Cartoon** | campiture piatte, contorno marcato | buono come riferimento di stile |
| ✨ **Anime** | cel shading a fasce, colori saturi, luce soffusa | buono come riferimento di stile |
| ✏️ **Matita** | grafite su carta, tratteggio nelle ombre | stile |
| 💥 **Fumetto** | retino a mezzatinta e inchiostro | solo stile: col retino spento somiglia a Cartoon |
| 🖌️ **Acquerello** | macchie morbide, bordi umidi | stile |
| 🌈 **Neon** | solo contorni luminosi | da non usare come riferimento |

## Come è fatto dentro

Il look di un disegno dipende da grandezze **relative** all'immagine — spessore
della linea, ampiezza delle campiture, passo del retino — non dal numero di pixel.
Con i parametri in texel, la stessa scena a 900 px sembra un cartone e a 3000 px
una foto posterizzata: è il primo difetto che è emerso provando gli shader a
risoluzione piena.

Il motore lavora quindi su **tre livelli** della stessa immagine, ottenuti per
riduzioni successive a metà:

| livello | dimensione | a cosa serve |
|---|---|---|
| `u_tex` | risoluzione di uscita | microcontrasto: occhi, denti, montature |
| `u_mid` | lato lungo 900 px | contorni, di spessore costante |
| `u_base` | lato lungo 250 px | masse di colore piatte |

Essendo campionati in coordinate normalizzate, il risultato è lo stesso a ogni
risoluzione. Misurato: fra un render a 900 px e uno a 3072 px riportato a 900, lo
scarto medio è 0,8/255 su cartoon, 0,6 su anime, 0,9 su fumetto.

Due dettagli che cambiano molto il risultato sui volti:

- **la croma viene presa da un livello molto più sfumato della luminanza.** È il
  motivo per cui la pelle nei cartoni è di un colore solo: quantizzando il colore
  così com'è, una luce irregolare su un viso diventa una mappa di chiazze che non
  segue nessun tratto.
- **la riduzione dei toni avviene su luminosità e saturazione, non in RGB.**
  Posterizzare in RGB sposta le tinte: le camicie bianche con un filo di azzurro
  diventavano viola.

## Compatibilità e limiti dei telefoni

- **iPhone** Safari 15+; **Android** Chrome/Edge/Firefox/Samsung recenti
- il livello di dettaglio viene ridotto alla risoluzione di uscita e comunque sotto
  `MAX_TEXTURE_SIZE`: un upload oltre il limite non lancia eccezioni, la texture
  resta vuota e l'immagine uscirebbe **nera** (verificato simulando limiti di 4096
  e 2048)
- prima di allocare un canvas grande si scrive e rilegge un pixel nell'angolo: iOS
  supera silenziosamente il limite di area senza segnalare nulla
- l'`accept` dell'input file elenca esplicitamente `image/jpeg,image/png,image/webp`:
  includere `image/heic` farebbe **convertire in HEIC** su Safari 17+, cioè
  produrrebbe il file che gli altri browser non leggono
- se il telefono fatica, l'anteprima abbassa la risoluzione da sola e la rialza
  quando può

## Struttura

```
index.html            interfaccia
styles.css            stile mobile-first, con aree sicure per il notch
engine.js             shader GLSL, piramide di riduzione, renderer WebGL
app.js                fotocamera, ritaglio guidato, esportazione, testo per l'AI
manifest.webmanifest  per "Aggiungi alla schermata Home"
```

Per provarlo su computer: `npx http-server -p 8080` e apri `http://localhost:8080`
(su localhost la fotocamera è consentita anche senza https).

## Pubblicazione

Il workflow `.github/workflows/pages.yml` pubblica su GitHub Pages a ogni push.
Serve solo, una volta: **Settings → Pages → Source: GitHub Actions**.

## Una nota che non è tecnica

Se la persona ritratta non sei tu, chiedile il consenso prima di pubblicare un
personaggio che le somiglia: l'obiettivo qui è proprio creare una somiglianza
riconoscibile e riutilizzabile.
