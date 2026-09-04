# AGENTS.md

Read this before changing anything. It is written for AI agents working in this
repository and it exists because most of the rules below were learned by getting
them wrong first.

## Wat dit project doet

Een opgemaakt magazineartikel (PDF, meerdere pagina's, kolommen, kaders, quotes,
foto's) wordt omgezet naar **één betrouwbare verticale artikelstructuur**: een
JSON-object met `frontmatter` en een platte `content`-lijst. Daaruit volgen MDX,
HTML, Portable Text of het Vrhl-Blad-formaat.

Betrouwbaar is het sleutelwoord. Een converter die 95% goed doet en 5% verzint is
onbruikbaar, want je weet niet welke 5%. Alles in dit project is gebouwd om die
5% zichtbaar en meetbaar te maken in plaats van hem te verbergen.

## Het uitgangspunt

Drie soorten waarheid, en geen enkele run mag ze alle drie zelf bepalen:

| | bron | bepaalt |
|---|---|---|
| tekst | Mistral OCR | welke woorden bestaan |
| visueel | de page image + pdf.js | positie, opmaak, layout, plaatsing |
| semantisch | de redeneer-runs | leesvolgorde, rol, samenhang |

Daaruit volgt de belangrijkste regel van het hele project:

> **Een AI-run mag woorden herordenen en classificeren. Nooit toevoegen,
> herschrijven, vertalen, samenvatten of aanvullen.**

De woordindex bewijst dat, per pagina. Zie `lib/wordindex.ts`.

## De flow

```
PDF in de dropzone
  |
  browser: pdf.js rendert elke pagina naar een image
           en ript de ingesloten bitmaps eruit op 300 dpi
  |
Convert
  |
  Mistral OCR (1 call) -> woordindex per pagina
  |
  Frontmatter-agent          Beeldbeoordeling        <- parallel, document-niveau
  |
  per pagina, parallel:
     AI run 1  schrijft de pagina uit in leesvolgorde,
               inserts, quotes, streamers en images op hun plek
     woordindex-check -> te veel onbekende woorden? één herkansing
     AI run 2  styling: bold/italic/underline/strikethrough
  |
  compileren tot één artikel
```

**Twee AI-runs per pagina.** Niet meer. Er is een versie geweest met zeven
gespecialiseerde runs per pagina; die was duurder (37 runs / 161k tokens tegen
14 / 69k op hetzelfde artikel van zes pagina's) zonder beter te zijn. Voeg geen
run per pagina toe zonder een aantoonbaar probleem dat je er alleen zo mee
oplost.

## Harde invarianten

Breek deze niet. Ze staan er allemaal omdat het een keer misging.

1. **Run 2 wacht op run 1.** Binnen een pagina is de volgorde strikt. Pagina's
   onderling draaien wel parallel, en dat kan alleen omdat een pagina niets van
   de uitkomst van zijn buren nodig heeft; de context die hij van ze krijgt komt
   uit de OCR, niet uit hun output.
2. **Deterministische stappen blijven deterministisch.** Parsen, patchen,
   opschonen en compileren zijn regels, geen model. Een stap die tekstinhoud kan
   veranderen mag geen model zijn.
3. **Een quote staat nooit vóór de alinea waarin die zin voorkomt.** Dit wordt
   afgedwongen over het hele artikel in `lib/compile.ts`, ná het aan elkaar
   rijgen van de pagina's, niet per pagina. De bron staat vaak op de volgende
   pagina.
4. **Een doorlopende pagina loopt naadloos door.** De tekst beslist, niet de
   continuïteitsvlag van het model: eindigt de vorige op een afbreekstreepje, of
   begint de volgende met een kleine letter, dan is het één zin. Een tussenkop is
   de harde grens.
5. **Frontmatter komt niet terug in de body.** Chapeau, titel, ondertitel,
   creditregel en intro horen bovenaan, niet in de lopende tekst. Zowel run 1
   (prompt) als de compiler (regel) bewaken dat.
6. **Eén mislukte run legt de job niet om.** Een pagina die faalt levert een lege
   pagina plus een waarschuwing; de rest compileert door. Idem per run binnen een
   pagina.
7. **Een leeg antwoord van een tekst-run is geldig.** Een pagina kan één
   paginagrote foto zijn zonder lopende tekst. Alleen een afgekapt model is een
   fout.
8. **Geen lange streepjes.** Niet in code, comments, README, prompts of
   UI-teksten. In artikeltekst blijven ze staan: die komt letterlijk uit het
   blad.

## Waar wat staat

```
prompts.json          alle prompts, buiten de code. Data, geen code.
lib/prompts.ts        laadt prompts.json, herlaadt bij wijziging,
                      houdt bij een JSON-fout de laatst werkende versie
lib/pipeline.ts       de orkestratie: wat draait wanneer, wat parallel
lib/agents/           frontmaster, imagetriage, structure (run 1), styling (run 2)
lib/pagemarkup.ts     parst de markers van run 1 naar blokken
lib/patch.ts          legt de styling van run 2 over run 1 heen
lib/wordindex.ts      de woordindex en zijn controle
lib/compile.ts        pagina's naar één artikel: naden, quotes, ruis
lib/cleanup.ts        afbreekstreepjes, regelafbrekingen, whitespace
lib/imagefilter.ts    de regels die strepen en ornamenten meteen wegzetten
lib/client/render.ts  rasteriseren in de browser
lib/client/images.ts  de bitmaps uit de PDF rippen met pdf.js
lib/llm/openai.ts     fetch-client, geen SDK, met streaming
lib/llm/mistral.ts    OCR, alleen woorden
app/                  UI en API-routes
components/           Stream (live), ArticleView, Checks, Prompts
.data/jobs/<id>/      per job: source.pdf, page images, geripte bitmaps,
                      ocr.json, images.json, pages.json, article.json
```

## Prompts wijzigen

Prompts staan in `prompts.json`, met per run `titel`, `wanneer`, `krijgt`,
`levert`, `instructions`, `effort` en `maxOutputTokens`. Het bestand wordt per
run opnieuw ingelezen zodra het gewijzigd is; een herstart is niet nodig.

- Zet **nooit** promptteksten terug in de TypeScript.
- De datapayload (OCR, blokken, page image) wordt in code samengesteld en hoort
  niet in het bestand.
- Prompts zijn in het Engels, alles wat de gebruiker leest is in het Nederlands.
- `effort` is `null` (neem `.env.local`) of `minimal|low|medium|high`.

Het tabblad **Prompts** en `GET /api/prompts` tonen wat er op dat moment naar
elke run gaat.

## Het formaat van run 1

Run 1 schrijft platte tekst met een handvol markers. Platte tekst omdat het live
moet kunnen streamen; markers omdat het daarna deterministisch geparst moet
worden.

```
[continues-from-previous: nee]
Gewone alinea.

## Een tussenkop
> Een pull quote
~ Een streamer
[image: img-3-01 | bijschrift | credit]
[insert: Titel van het kader]
alinea van het kader
[/insert]
[continues-on-next: ja]
```

Wat de parser niet herkent valt terug op een gewone alinea. Er gaat dus nooit
tekst verloren doordat een marker misgaat. Houd dat zo als je markers toevoegt.

## Verifiëren

```bash
npx tsc --noEmit
npm run build
```

Een volledige run kost geld: ongeveer 14 runs en 69k tokens voor een artikel van
zes pagina's. Doe dat alleen als het nodig is.

**Voor deterministische wijzigingen** (compile, patch, parse, cleanup): draai
niet opnieuw. In `.data/jobs/<id>/pages.json` staat de opgeslagen output van run
1 en 2. Zet tijdelijk een route neer die `compileArticle` op dat bestand
loslaat, controleer, en haal de route weer weg. Zo zijn de naden en de
quote-volgorde geverifieerd zonder één token.

**Invarianten die je na een wijziging kunt narekenen**, allemaal op het
gecompileerde artikel:

- geen enkele alinea begint met een kleine letter (dan is er een zin doormidden
  geknipt);
- elke quote/streamer waarvan de tekst letterlijk in een alinea voorkomt, staat
  ná die alinea;
- de woorddekking per pagina ligt rond de 100% en `unknown` is leeg;
- niets uit de frontmatter komt terug in de body.

## Valkuilen

- **pdf.js rendert via `requestAnimationFrame`**, en een achtergrondtab bevriest
  dat. Daarom `intent: 'print'` in `lib/client/render.ts`. Haal dat niet weg,
  anders hangt het renderen zodra de gebruiker wegklikt.
- **Prettier herschrijft `app/page.tsx`** (quotes, JSX-indentatie). Exacte
  string-vervangingen kunnen daardoor missen. Lees het bestand voor je patcht.
- **Stop de dev-server voor je `.next` weggooit.** Anders krijg je
  `Cannot find module './873.js'`, een stale chunk-cache, geen codefout.
- **Het model heet `gpt-5.6-terra`.** "medium" is de reasoning-effort, een aparte
  parameter, geen deel van de model-id. Een `model_not_found` wordt apart
  afgevangen en niet opnieuw geprobeerd.
- **De woordindex controleert de geparste blokken, niet de ruwe output.** Anders
  tellen de markers (`image`, `insert`, `crop`, `ja`) als woorden die de pagina
  niet heeft, en doet elke pagina onnodig een tweede poging.
- **Vrijstaande foto's hebben transparantie.** Die als JPEG opslaan geeft een
  zwarte achtergrond. Er zit een alfa-check op; laat die staan.
- **De client kent de job zoals die bij het aanmaken was.** De geripte bitmaps
  komen er per pagina bij op de server, dus de job wordt na het uploaden opnieuw
  opgehaald.

## Stijl

- Kleine, vaste dependency-set: `next`, `react`, `pdfjs-dist`. Voeg er geen toe
  zonder sterke reden; de LLM-clients zijn met `fetch` geschreven, zonder SDK.
- Comments leggen uit **waarom**, niet wat. Een comment die de regel eronder
  navertelt is ruis.
- De UI is Calvinistisch: papier, inkt, haarlijnen. Geen radius, geen schaduw,
  geen gradiënt, geen animatie. Mono voor de interface, serif voor het artikel.
- Het runlog en de Live-view tonen wat er echt gebeurt, inclusief wat is
  afgekeurd. Verberg geen verworpen patch of afgekeurde afbeelding; die
  zichtbaarheid is de helft van het product.

## Wat je moet melden

Als je iets aanpast wat de output verandert, controleer het op een echt artikel
en rapporteer wat je zag, niet wat je verwacht. Faalt er iets, zeg dat met de
output erbij. Weet je iets niet zeker, zeg dat er expliciet bij in plaats van
het glad te strijken.
