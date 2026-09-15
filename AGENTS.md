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
  Frontmatter-agent          Beeldbeoordeling        <- parallel
                             (per pagina met beelden, met de page image)
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

De beeldbeoordeling is zo'n geval. Die ging eerst in één call voor het hele
document, met alleen thumbnails; een foto uit een advertentiebalk kwam daardoor in
het artikel, want los ziet hij eruit als elke andere foto. Nu is het één call per
pagina met beelden, met de pagina erbij en de plek van elk beeld. Zet dat niet
terug naar losse thumbnails.

## Magazinestand

Naast één artikel kan er een heel magazine in. Dat is een **losse run** die
alleen uitzoekt waar de artikelen staan (`lib/magazine/analyze.ts`); hij deelt
niets met de artikel-run behalve de chatclient.

1. `paginascan` per pagina, parallel, met het goedkope model (`magazineModelFor`).
   Krijgt de vorige, deze en de volgende page image en de tekstlaag, geen OCR,
   en zegt welke buur tegenover deze pagina ligt (`facing`).
2. `stitch` in `lib/magazine/stitch.ts`: regels. Offset uit de gelezen
   paginanummers per meerderheid, spreads (`pairSpreads`: twee pagina's die het
   van elkaar zeggen; bij onenigheid beslist het even nummer links), fotopagina's
   zonder tekst bij de pagina ertegenover, artikelen van begin tot begin, sprongen
   ("lees verder op pagina 64"), advertenties overslaan, inhoudsopgave ernaast.
3. `grenscontrole` per overgang, parallel. Beslist op inhoud. Bij `onduidelijk`
   één tweede blik met het gewone model (`strongModelFor`). Alle invoer wordt
   gebouwd voordat er iets wordt toegepast.

**Denk in spreads, niet in pagina's.** Een opening loopt vaak over twee pagina's
(kop links, intro rechts). `MapArticle.opening` zegt welke pagina's dat zijn en
reist als `Job.opening` mee naar de artikel-run. De frontmatter-agent begint met
zoveel pagina's, en zonder die kennis met twee (`OPENING_DEFAULT` in
`lib/pipeline.ts`). Begin nooit weer met één pagina en stop bij de eerste kop: dan
mist hij een intro op de pagina ernaast en schrijft run 1 die in de body.

Daarna knipt de browser per gekozen artikel de hele pagina's uit het magazine
(`cutArticle` in `lib/client/magazine.ts`) en gaat die PDF door de gewone upload
en run. **Knip nooit binnen een pagina** (geen CropBox, geen regio's): een
gedeelde pagina gaat heel mee.

Omzetten gebeurt op de achtergrond in `components/MagazineView.tsx`: uitlezen
(renderen, rippen, uploaden) één artikel tegelijk, want dat is zwaar in het
tabblad; de runs lopen naast elkaar, `MAGAZINE_ARTICLE_CONCURRENCY` tegelijk.
De interface springt niet naar een artikel; de gebruiker opent het zelf.

`page`/`pdf` is overal de plek in het bestand. Het gedrukte nummer (`folio`)
volgt uit de offset en is alleen weergave. Een magazine staat in
`.data/jobs/<id>/` naast de jobs, herkenbaar aan `magazine.json`, met
`scans.json` en `map.json`. Het rijgen is te controleren zonder tokens: roep
`stitch` aan op een opgeslagen `scans.json`.

Een `Ledger` kan een eigen model en prijs dragen (`newLedger(provider, model)`);
zonder dat geldt het model uit `.env.local`, zoals voorheen.

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
lib/canonical.ts      het artikel als Vrhl Content Package 1.0. De enige plek
                      die dat formaat kent; weet niets van Sanity, MDX of Word
lib/zip.ts            pakket.json plus het beeld als ZIP, zonder dependency
lib/mdx.ts            schrijft MDX, en leest daarvoor het PAKKET, niet het
                      artikelobject: het pakket is de bron, MDX een consument
lib/client/edit.ts    leest een correctie uit de Artikel-tab terug naar
                      tekst plus styles, met dezelfde telling als spans.ts
lib/sanity/client.ts  de drie endpoints van Sanity, met fetch en zonder SDK
lib/sanity/documents.ts  pakket -> Sanity-documenten. Rekenen, geen I/O, zodat
                      het te controleren is zonder iets te versturen
lib/sanity/push.ts    de importstappen op volgorde: assets, credits en tags
                      opzoeken of aanmaken, dan pas schrijven
lib/cleanup.ts        afbreekstreepjes, regelafbrekingen, whitespace
lib/imagefilter.ts    de regels die strepen en ornamenten meteen wegzetten
lib/mosaic.ts         opgeknipte beelden terugvinden en als één blok aanwijzen
lib/client/render.ts  rasteriseren in de browser
lib/client/images.ts  de bitmaps uit de PDF rippen met pdf.js
lib/agents/pagescan.ts   magazine: wat staat er op deze ene pagina
lib/agents/boundary.ts   magazine: waar houdt het vorige artikel op
lib/magazine/         analyze (orkestratie), stitch (regels), store, types
lib/client/magazine.ts   magazine klein renderen, en een artikel eruit knippen
lib/client/article.ts    een artikel-PDF uploaden en een run volgen, zonder interface:
                      de losse upload en de magazine-wachtrij gebruiken dezelfde code
lib/llm/chat.ts       één client voor OpenAI en Mistral: fetch, geen SDK, streaming
lib/llm/ratelimit.ts  houdt zich aan de limieten die Mistral in elk antwoord meldt
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

- **Een beeld kan uit honderd bitmaps bestaan.** Plaats nooit losse stukken van
  een opgeknipt beeld; `lib/mosaic.ts` voegt ze samen tot één render van de
  pagina, of laat ze allemaal weg. Pixels onderscheiden een kaderschaduw niet van
  de rand van een kaart; de tekstlaag doet dat wel. **Test mosaïeken tegen een
  pdf.js-render**, niet tegen `sips` of een andere renderer: die legt de pagina
  een paar punten anders neer en dan kloppen de uitkomsten niet met de browser.

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
- **Twee providers, één client.** Wie het artikel schrijft kiest de gebruiker
  per run (OpenAI of Mistral); Mistral doet altijd de OCR. De provider reist mee
  op de `Ledger`, omdat de prijs per token ervan afhangt, dus agents hoeven hem
  niet te kennen. Voeg nooit een providerspecifieke aanroep toe in een agent.
- **Mistral weigert velden die het niet kent.** Stuur alleen wat in hun eigen
  API-spec staat: `max_tokens` (niet `max_completion_tokens`), geen
  `stream_options`. De veldnamen zijn nagekeken in de officiële SDK
  (`mistralai/client-python`, `src/mistralai/client/models/`), niet in de docs.
- **Mistral kan `content` als lijst van chunks sturen**, en als het model redeneert
  zitten daar `{"type":"thinking"}`-chunks tussen. Alleen de `text`-chunks zijn
  antwoord. Redenering mag nooit in een artikel belanden; `textOf` in
  `lib/llm/chat.ts` bewaakt dat en is getest met nagemaakte chunks.
- **Mistral-limieten.** Chat op Medium 3.5 mag 1 aanvraag per seconde. Dat is
  `MISTRAL_REQ_PER_MINUTE=60`: `lib/llm/ratelimit.ts` start calls nooit sneller,
  gedeeld over alle pagina's die tegelijk lopen. Een limiet van **0** in de
  headers betekent dat de key dat model niet mag gebruiken: dan stopt de client
  meteen met een melding in plaats van te blijven proberen. Instellen gebeurt op
  admin.mistral.ai/plateforme/limits. Een 429 eert `Retry-After`.
- **Niet elk Mistral-model ondersteunt dezelfde `reasoning_effort`-waarden.** De
  docs noemen de volle enum (`none|minimal|low|medium|high|xhigh`), maar een
  model kan een deelverzameling afdwingen (`mistral-medium-2604` weigerde
  `medium` met code `3051`, en noemde alleen `none` en `high` als geldig). De
  default is daarom `MISTRAL_REASONING_EFFORT=high`: dezelfde kwaliteit als het
  eerdere remap van `medium`, zonder de mislukte eerste call. Zet dit alsnog
  nooit hard per model in de client: `lib/llm/chat.ts` leest geweigerde waarden
  uit de foutmelding, kiest de dichtstbijzijnde op de schaal, cachet dat per
  model/proces en herhaalt de aanroep één keer.
- **Mistral telt thinking mee in `max_tokens`.** High effort schrijft eerst een
  thinking-trace; die gaat van hetzelfde budget af als de pagina. 16000 was
  genoeg voor de tekst en niet voor het denken, dus run 1 stierf midden in een
  zin (`finish_reason: length`). De Mistral-standaard is daarom 48000, en bij
  afkappen verdubbelt de client het budget één keer (tot 65536) in plaats van
  de pagina om te leggen.