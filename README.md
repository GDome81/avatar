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

### Se non vuoi dare la foto vera

È una strada legittima, non un compromesso: Midjourney dichiara che il
riferimento di personaggio *«eccelle con immagini generate»* e non è ottimizzato
per le foto reali, perché questi meccanismi sono tarati su input che stanno già
nel dominio dell'illustrazione. Quindi dai il **disegno** — meglio ancora una
**tavola con più pose** — e dichiara a parole i colori veri. In questo caso il
peso del riferimento va **alto** (`--ow 150-300`), al contrario di quando si
parte da una foto (`--ow 25-50`), dove serve basso perché il modello deve anche
cambiare dominio.

Due limiti da sapere: un disegno derivato da una foto eredita i limiti di quella
foto (se il viso era di tre quarti, il modello inventerà la metà che non vede, e
la inventerà diversa ogni volta); e gli artefatti dello stile locale vengono
ereditati e a volte amplificati — per questo esiste l'interruttore *Pulito per
l'AI*.

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
Sopra l'immagine stanno solo gli effetti e lo scatto. Tutto il resto — intensità,
fondo neutro, caricatura, ritaglio, risoluzione — vive nel pannello **⚙ Regola**,
che si apre a metà schermo lasciando l'immagine visibile sopra di sé, così le
regolazioni si fanno guardando il risultato.

- **Riquadro di ritaglio** — il dito **dentro** il riquadro lo sposta, un
  **angolo** lo ridimensiona liberamente (ogni angolo muove il proprio vertice,
  nessuna proporzione imposta), due dita lo scalano. La zona di presa degli angoli
  si restringe con il riquadro: con un raggio fisso, su un riquadro piccolo le
  quattro zone coprivano tutta l'area e il dito al centro non spostava mai nulla
- **Fondo neutro** — attivo per default: lo sfondo viene sostituito da un fondo
  piatto in **tutti** gli effetti, ognuno col proprio (grigio per i disegni a
  colori, carta per matita e acquerello, scuro per il neon)
- **Caricatura** — occhi più grandi, cranio più alto, mandibola più stretta
- **＋ Serie** — fino a cinque pose in una sola tavola

## La serie: fino a cinque pose

Un personaggio regge le tavole successive se il modello ne vede la struttura da
più angoli, non una sola proiezione. Quindi:

1. scegli **più foto in una volta** (o scattane una), inquadra e tocca **＋ Serie**
2. la foto successiva della coda si carica da sola; l'app suggerisce la posa
   (di fronte, tre quarti destro, tre quarti sinistro, di profilo, sorriso).
   Con *Altre foto* e *Scatta* puoi aggiungerne quando vuoi
3. tocca **Componi**

Fra scatti della stessa fotocamera il ritaglio si conserva: quando le foto hanno
la stessa misura non si riparte da zero ogni volta.

Escono **due cose**: la tavola unica, per i modelli che accettano un solo
riferimento (Midjourney), e i **pannelli separati**, per quelli che ne accettano
più di uno (Gemini ne prende fino a cinque per la coerenza del personaggio).
Prepararne solo uno dei due taglierebbe fuori metà dei modelli.

Tutti i pannelli vengono resi con le **impostazioni del primo scatto**, anche se
poi cambi effetto: differenze di stile fra un pannello e l'altro verrebbero lette
come differenze del personaggio.

## Il testo per l'AI

Il prompt non chiede una sola immagine: chiede al modello di produrre **due
tavole** — il *turnaround* (fronte, tre quarti destro e sinistro, profilo, retro)
e il *foglio delle espressioni* (neutra, sorriso, risata, sorpresa, rabbia,
tristezza). Il turnaround dà al modello la struttura della testa invece di una
sola proiezione; le espressioni fissano come si deforma quel viso. Sono i due
documenti che tengono il personaggio identico da una tavola all'altra.

Il pulsante apre un modulo con i campi della **bibbia del
personaggio** — età, forma del viso, capelli, occhi, incarnato, corporatura,
tratti distintivi, colori dell'abito. Sono tutti **facoltativi**: quelli lasciati
vuoti vengono **tolti** dal prompt, non compaiono come segnaposto. Servono a
dichiarare a parole ciò che la stilizzazione ha perso o falsato: il colore vero
degli occhi e dei capelli, per esempio, che un disegno a toni piatti non conserva.

Il pulsante **Copia il prompt** copia **soltanto il prompt**. Le istruzioni su
come caricare l'immagine e le avvertenze restano a schermo, sotto *Come caricarla*:
sono per te, non per il modello. I valori inseriti restano salvati sul telefono
per la volta dopo.

## Gli effetti

| Effetto | Che cosa fa | Come riferimento |
|---|---|---|
| 🪪 **Ritratto** | nessuna stilizzazione: bilanciamento del bianco, recupero delle ombre, microcontrasto | **è questo** il file per lo slot identità |
| 🎨 **Cartoon** | campiture piatte, contorno marcato | buono come riferimento di stile |
| ✨ **Anime** | cel shading a fasce, colori saturi, luce soffusa | buono come riferimento di stile |
| ✏️ **Matita** | grafite su carta, tratteggio nelle ombre | stile |
| 💥 **Fumetto** | inchiostro di spessore variabile, tre toni piatti, neri pieni, contorno del personaggio dalla maschera | **il migliore** come design di personaggio |
| 🔘 **Retino** | mezzatinta alla vecchia maniera | solo stile: i pattern periodici l'AI li copia come materia |
| 🖌️ **Acquerello** | macchie morbide, bordi umidi | stile |
| 🌈 **Neon** | solo contorni luminosi | da non usare come riferimento |

## Rilevamento del volto, in locale

Fondo neutro e caricatura usano **MediaPipe Tasks Vision**, vendorizzato nel repo
(`vendor/`) e servito dal sito stesso: nessuna CDN, nessuna immagine che esce dal
telefono. Prima di adottarlo è stato verificato che funziona con
`crossOriginIsolated = false`, cioè **senza** gli header COOP/COEP: su GitHub
Pages non sono impostabili, quindi se li avesse richiesti questa strada era
chiusa.

- **478 punti del volto** → la caricatura è guidata dai landmark: occhi fino al
  +18%, cranio più alto, mandibola più stretta. Le misure sono ancorate alla
  **distanza interoculare**, che non cambia con l'inquadratura, e lo spostamento
  svanisce ai bordi per non stirare lo sfondo contro la cornice.
- **maschera persona/sfondo (243 KB)** → fondo grigio piatto, e il **contorno
  esterno** del personaggio: chiuso, continuo e indipendente dal contrasto della
  foto. La polarità della maschera cambia tra le versioni del modello, quindi
  viene rilevata dai dati campionandola dove il volto è stato trovato.

I 16 MB di modelli si scaricano **solo** quando accendi una di queste funzioni, e
solo la prima volta. Funzionano sulle foto, non sull'anteprima dal vivo: lì
servirebbe il rilevamento a ogni fotogramma.

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
face.js               rilevamento volto e maschera, in locale
app.js                fotocamera, ritaglio, serie, esportazione, testo per l'AI
vendor/               MediaPipe e modelli (16 MB, caricati su richiesta)
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
