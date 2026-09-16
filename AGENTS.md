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
     leesvolgorde  schrijft de pagina uit in leesvolgorde,
                   inserts, quotes, streamers en images op hun plek
     woordindex-check -> te veel onbekende woorden? één herkansing
     opmaak        bold/italic/underline/strikethrough
                   (start tegelijk met de leesvolgorde-run)
  |
  compileren tot één artikel
```

**Twee AI-runs per pagina: leesvolgorde en opmaak.** Niet meer. Ze heetten
"run 1" en "run 2"; die nummers zijn eruit, want ze suggereerden een volgorde die
er niet meer is. Er is een versie geweest met zeven
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
alleen uitzoekt waar de artikelen staan (`lib/client/analyze.ts`); hij deelt
niets met de artikel-run behalve de chatclient.

**De inhoudsopgave is leidend.** Wat de redactie in de inhoudsopgave een artikel
noemt, is een artikel; wat de paginascan als losse stukken ziet, is dat niet
vanzelf. Zet dit nooit terug naar "elk stuk met een kop is een artikel": dan
wordt Personalia een artikel per persoon.

1. `paginascan` per pagina, parallel, met het goedkope model (`magazineModelFor`).
   Krijgt de vorige, deze en de volgende page image en de tekstlaag, geen OCR,
   en zegt welke buur tegenover deze pagina ligt (`facing`).
2. `stitch` in `lib/magazine/stitch.ts`: regels. Offset uit de gelezen
   paginanummers per meerderheid, spreads (`pairSpreads`: twee pagina's die het
   van elkaar zeggen; bij onenigheid beslist het even nummer links). Dan:
   - **met inhoudsopgave** (`byContents`, `map.basis = 'inhoudsopgave'`, vanaf 3
     bruikbare regels): elke regel een artikel, van zijn pagina tot de volgende
     regel, zonder advertenties en colofon. Een stuk dat doorloopt of dezelfde
     rubriek of kop heeft (`belongsTo`) hoort erbij. Een stuk met een eigen kop
     en een andere rubriek wordt een `ContentQuestion`. Een kop en zijn
     beschrijving die als twee regels zijn gelezen, worden één.
   - **zonder** (`byPages`): artikelen van begin tot begin uit de pagina's,
     sprongen gevolgd, fotopagina's bij de pagina ertegenover, en korte berichten
     onder een rubriek die als geheel opende (`section`) bij die rubriek.
3. Met inhoudsopgave `inhoudscontrole` per vraag (`checkContent`,
   `/api/magazine/content`): hoort-erbij, deels, hoort-er-niet-bij. Wat er niet
   bij hoort wordt een eigen artikel met de notitie "Staat niet in de
   inhoudsopgave". Antwoorden worden pas na afloop en op paginavolgorde toegepast
   (`applyContent`). Zonder inhoudsopgave `grenscontrole` per overgang. Bij
   `onduidelijk` in beide gevallen één tweede blik met het gewone model
   (`strongModelFor`).

**Denk in spreads, niet in pagina's.** Een opening loopt vaak over twee pagina's
(kop links, intro rechts). `MapArticle.opening` zegt welke pagina's dat zijn en
reist als `Job.opening` mee naar de artikel-run. De frontmatter-agent begint met
zoveel pagina's, en zonder die kennis met twee (`OPENING_DEFAULT` in
`lib/client/run/opening.ts`). Begin nooit weer met één pagina en stop bij de eerste kop: dan
mist hij een intro op de pagina ernaast en schrijft de leesvolgorde-run die in
de body.

Daarna knipt de browser per gekozen artikel de hele pagina's uit het magazine
(`cutArticle` in `lib/client/magazine.ts`) en gaat die PDF door de gewone upload
en run. **Knip nooit binnen een pagina** (geen CropBox, geen regio's): een
gedeelde pagina gaat heel mee.

De analyse is te hervatten: elke paginascan, inhoudscontrole en grenscontrole
wordt apart bewaard, dus een analyse die halverwege stopt kost bij "Verder waar
het stopte" alleen nog wat er niet gelukt was. Het rijgen gebeurt wel elke keer
opnieuw; dat zijn regels en die kosten niets.

Omzetten gebeurt op de achtergrond in `components/magazine/useMagazine.ts`: uitlezen
(renderen, rippen, opslaan) één artikel tegelijk, want dat is zwaar in het
tabblad; de runs lopen naast elkaar, `MAGAZINE_ARTICLE_CONCURRENCY` tegelijk.
De interface springt niet naar een artikel; de gebruiker opent het zelf.

`page`/`pdf` is overal de plek in het bestand. Het gedrukte nummer (`folio`)
volgt uit de offset en is alleen weergave. Een magazine staat in IndexedDB naast
de jobs (store `magazines`), met `scans.json` en `map.json` in de store `data`.
Het rijgen is te controleren zonder tokens: roep `stitch` aan op een opgeslagen
`scans.json`.

Een `Ledger` kan een eigen model en prijs dragen (`newLedger(provider, model)`);
zonder dat geldt het model uit `.env.local`, zoals voorheen.

## De server onthoudt niets

De app draait op Vercel. Elk verzoek kan op een andere machine landen, er is geen
blijvende schijf, een verzoek duurt hooguit 800 seconden en is hooguit 4,5 MB.
Daaruit volgen vaste regels:

1. **Geen opslag op de server.** Alles staat in de browser, in IndexedDB
   (`lib/client/db.ts`): `jobs`, `magazines`, `files` (Blobs) en `data` (JSON),
   bestanden onder `<eigenaar>/<naam>` met de namen die de job ze geeft. Schrijf
   nooit weer naar `fs` vanuit een route.
2. **De browser regelt, de server doet één stap.** `lib/client/run.ts` en
   `lib/client/analyze.ts` bepalen volgorde en parallellisme en leveren dezelfde
   `RunEvent`s en `MagazineEvent`s als de oude server-pipeline. Een route onder
   `app/api/run/`, `app/api/magazine/` of `app/api/sanity/` krijgt alles wat hij
   nodig heeft in het verzoek: JSON in `input`, beelden als `file:<naam>`.
   Agents vragen beeld op via `ctx.image(naam)` (`lib/server/run.ts`).
3. **Nooit een verzoek boven 4,4 MB.** Bouw verzoeken altijd met `runForm`
   (`lib/client/post.ts`), die houdt het tegen. De PDF gaat per pagina naar de
   OCR (valt terug op de render als een pagina-PDF te groot is); render en tiles
   gaan in aparte verzoeken; Sanity-beeld één foto per verzoek.
4. **Het tempo zit in de browser.** `lib/client/limiter.ts` houdt het maximum
   tegelijk en Mistrals één start per seconde, gedeeld door alle runs in het
   tabblad. `lib/llm/ratelimit.ts` op de server ziet maar één instantie.
5. **Elke stap wordt bewaard voor hij telt.** Resultaten staan onder
   `data/<id>/run/...`, gezet door `onceIn` in `lib/client/once.ts`. Zowel
   `runArticle(id, provider, { resume: true })` als
   `analyzeMagazine(id, provider, { resume: true })` slaat over wat er al is; zonder
   `resume` wordt `run/` eerst gewist en begint het schoon. Alleen een geslaagde
   stap wordt bewaard, dus een mislukte pagina gaat bij het hervatten opnieuw.
   Zet elke betaalde stap die je toevoegt in `once`. Let op: de sleutel zegt niet
   wie het geschreven heeft, dus hervatten na het wisselen van aanbieder of na een
   promptwijziging levert een gemengde uitkomst.
6. **Een slot op de deur.** `middleware.ts` met `APP_PASSWORD`; zonder die
   variabele staat alles open (lokaal). Raden wordt afgeremd in
   `lib/server/loginlimit.ts`: de Firewall-regel `inloggen` telt over alle
   machines, een teller in het geheugen per machine. Tel altijd vóór het
   wachtwoord wordt nagekeken, anders krijgt wie raadt het antwoord alsnog. Een
   wachttijd per poging alleen remt op Vercel niets.

## Harde invarianten

Breek deze niet. Ze staan er allemaal omdat het een keer misging.

1. **Een pagina heeft niets van zijn buren nodig.** Daarom mogen pagina's
   parallel; de context die een pagina van zijn buren krijgt komt uit de OCR,
   niet uit hun output. Binnen een pagina starten de leesvolgorde-run en de
   opmaak-run tegelijk: de opmaak-run citeert de pagina in plaats van naar
   blok-ids te wijzen, dus hij heeft de leesvolgorde niet nodig. `placeFragments`
   is de enige plek waar de twee elkaar tegenkomen. Laat de opmaak-run nooit
   naar blok-ids van de leesvolgorde-run vragen: dan moet hij weer wachten en
   ziet de gebruiker de opmaak pas na de tekst.
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
   creditregel en intro horen bovenaan, niet in de lopende tekst. Zowel de
   leesvolgorde-run (prompt) als de compiler (regel) bewaken dat.
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
lib/client/run.ts     de orkestratie in de browser: wat draait wanneer, wat parallel
lib/client/run/       de fases van één run, op volgorde: context (tempo, bon, once),
                      words (OCR), opening (frontmatter en beeld, kopcontrole),
                      page (leesvolgorde en opmaak per pagina)
lib/client/db.ts      IndexedDB: jobs, magazines, bestanden, tussenresultaten
lib/client/once.ts    een betaalde stap één keer betalen: bewaren en bij hervatten
                      lezen. Gedeeld door de artikel-run en de magazine-analyse
lib/client/post.ts    verzoeken bouwen (runForm, 4,4 MB-grens) en SSE lezen
lib/client/limiter.ts het tempo: maximum tegelijk, Mistral 1 start per seconde
lib/client/exports.ts elke export (JSON, HTML, MDX, Word, PDF, pakket-ZIP) uit hetzelfde
                      pakket, in de browser; Sanity in stappen. PDF is de HTML-export,
                      geprint via een iframe: geen PDF in code, want de lettertypen
                      in een PDF kennen ■, pijlen en andere schriften niet
lib/server/run.ts     wat elke route deelt: verzoek lezen, kosten, streamen
app/api/run/          check, ocr, frontmatter, images, page (leesvolgorde), styling (opmaak)
app/api/magazine/     scan (per pagina), boundary (per overgang)
app/api/sanity/       asset (één beeld), push (pakket als concept)
lib/auth.ts, middleware.ts  het wachtwoordslot
lib/agents/           frontmaster, imagetriage, structure (leesvolgorde), styling (opmaak)
lib/pagemarkup.ts     parst de markers van de leesvolgorde-run naar blokken
lib/patch.ts          legt de opmaak over de leesvolgorde heen
lib/wordindex.ts      de woordindex en zijn controle
lib/compile.ts        pagina's naar één artikel: naden, quotes, ruis
lib/canonical.ts      het artikel als Vrhl Content Package 1.0. De enige plek
                      die dat formaat kent; weet niets van Sanity, MDX of Word
lib/zip.ts            pakket.json plus het beeld als ZIP, zonder dependency en
                      zonder compressie, zodat het in de browser draait
lib/mdx.ts            schrijft MDX, en leest daarvoor het PAKKET, niet het
                      artikelobject: het pakket is de bron, MDX een consument
lib/html.ts           het artikel als één HTML-bestand, ook een consument van het pakket;
                      het beeld komt via een functie binnen (data-URL of pad). Het
                      print-deel van het stijlblad ís de PDF: @page zonder marge, anders
                      zet Chrome zijn kop- en voettekst met een blob:-adres erop
lib/docx.ts           het artikel als Word-document, zonder dependency, op lib/zip.ts.
                      De volgorde van elementen in de XML ligt vast in het schema
lib/pakketlezen.ts    wat HTML en Word allebei uit het pakket lezen: tekstdelen,
                      creditregel, bijschrift, alleen veilige links
components/BlockDrag.tsx  blokken verslepen in de Artikel-tab, ook een kader in en uit: greep bij hover,
                      pointer-events (geen HTML-drag-and-drop), pijltjes, Escape
lib/client/edit.ts    leest een correctie uit de Artikel-tab terug naar
                      tekst plus styles, met dezelfde telling als spans.ts
lib/studio.ts         hoe het CMS heet voor de gebruiker: Vrhl-Blad-Studio. Alles wat een
                      redacteur leest gebruikt STUDIO; code, routes en SANITY_* heten Sanity
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
lib/magazine/         stitch (regels: inhoudsopgave leidend, anders pagina's), types
lib/agents/contentcheck.ts  magazine: hoort dit bij het artikel uit de inhoudsopgave
lib/nearby.ts         de tekst naast een beeld (naam onder een portret), uit de tekstlaag
lib/controle.ts       wat de Controle-tab meldt en hoe erg: oplossen, nakijken, info, plus
                      het oordeel. Rekenen, geen React, en staat in npm run golden
lib/pictures.ts       welk beeld het artikel haalde en welk niet, in vier groepen voor
                      de Controle-tab. Rekenen, geen React, en staat in npm run golden
lib/client/analyze.ts    magazine: de analyse geregisseerd vanuit de browser
lib/client/magazine.ts   magazine klein renderen, en een artikel eruit knippen
lib/client/article.ts    een artikel-PDF inlezen en opslaan, en een run volgen, zonder
                      interface: de losse upload en de magazine-wachtrij delen de code
lib/llm/chat.ts       één client voor OpenAI en Mistral: fetch, geen SDK, streaming
lib/llm/ratelimit.ts  houdt zich aan de limieten die Mistral in elk antwoord meldt
lib/llm/mistral.ts    OCR, alleen woorden, één pagina per call
app/                  UI en API-routes
components/           Workflow (de zijbalk), ArticleView, MagazineView, Checks (de
                      Controle-tab: oordeel, kaarten per bevinding, afvinken; tekent
                      alleen wat lib/controle.ts uitrekent),
                      PageThumbs, StoredImage
components/article/   het artikelscherm uit app/page.tsx: useArticleRun (alle state van
                      een run en de vier resets, die bewust verschillen), useSettings,
                      useSidebar, useExports, en de stukken scherm (AppHeader,
                      StartScreen, WorkflowSidebar, ExportToolbar, Earlier). steps.ts
                      en preview.ts zijn rekenen zonder React en staan in npm run golden
components/magazine/  de magazinestand uit MagazineView: useMagazine (state, analyse,
                      omzetten op de achtergrond), MagazineSidebar, MagazineStart,
                      PageGrid, ArticleRow; labels.ts rekent en staat in npm run golden
scripts/golden.ts     het vangnet: rekent de vaste stappen door op .data/jobs en vergelijkt
.data/jobs/<id>/      alleen nog oude jobs van vóór de browseropslag; niets leest
                      of schrijft hier meer
```

## De Controle-tab

`lib/controle.ts` rekent uit wat er gemeld wordt, `components/Checks.tsx` tekent
het, `components/article/useControle.ts` laadt de OCR en onthoudt het afvinken
(onder `run/nagekeken`, zodat een nieuwe run zonder hervatten het wist).

- **Indelen naar wat de redacteur moet doen**, niet naar waar het vandaan komt:
  *oplossen* (tekst ontbreekt, pagina mislukt), *nakijken* (kan kloppen, kan fout
  zijn), *info* (telt niet mee). Het oordeel bovenaan en de teller op het tabblad
  volgen daaruit, en Vrhl-Blad-Studio vraagt bevestiging zolang er iets openstaat.
- **Een nieuwe regel meet je eerst op de oude jobs** voor hij erin komt. Een melding
  die bij de helft van de artikelen afgaat, wordt genegeerd; dan is de controle
  niet foolproof maar stil. Zo is "vaker gebruikt dan de pagina bevat" (301 keer,
  vooral pull quotes) een dubbele passage van acht woorden geworden, en zijn losse
  letters in de lopende tekst info (alle gevallen waren terecht) maar in de kop
  nakijken.
- **Tekst ontbreekt** is het omgekeerde van woorddekking: hoeveel van de OCR terugkomt
  in het artikel. Onder de 50% op een pagina met 80+ woorden. Op 316 tekstpagina's
  waren dat precies de 4 kapotte.
- **Een pagina die mislukt, zegt dat met `PageResult.failed`.** Raad het niet uit een
  lege pagina: een fotopagina is ook leeg. Oude jobs vallen terug op de waarschuwing.
- **Reken op het artikel zoals het nu is** (`current`, met correcties), waar het kan.
  Een woord dat de redacteur weghaalt, laat zijn melding verdwijnen.
- **Naar de plek zoekt op tekst** (`naarPlek`), niet op blok-id: blokken hebben geen
  vast id en verschuiven bij slepen. Geef een bevinding een `zoek` die letterlijk
  in de Artikel-tab staat.
- **Een beeld in het artikel draagt het id van zijn blok** (`p3-02`), niet dat van de
  bitmap. Koppel op `file`.

## Tijdelijk uitgezet, niet weggehaald

Iets wat nu niet nodig is maar later terug kan komen, haal je niet weg en zet je
niet in commentaar. Commentaar veroudert zonder dat de typecheck het merkt, en
verwijderde code komt uit git nooit meer precies terug in een codebase die
intussen verder is. Zet het uit met een schakelaar:

1. een getter in `lib/env.ts` die standaard **uit** staat, met in het commentaar
   waarom;
2. de stand mee in `/api/settings`, zodat de interface het onderdeel niet toont;
3. **de server dwingt het af.** Verbergen alleen is geen uitzetten: een tabblad
   met een onthouden keuze, of een oud tabblad tijdens een deploy, stuurt hem
   gewoon nog mee;
4. meldingen die naar het onderdeel verwijzen ("kies de andere aanbieder") alleen
   als het aan staat;
5. de variabele in `.env.example`, met hoe je hem terugzet.

Nu uitgezet:

| variabele | standaard | wat | waarom |
|---|---|---|---|
| `AI_PROVIDER_CHOICE` | `false` | de keuze tussen OpenAI en Mistral per run | Mistral Medium 3.5 is niet goed genoeg voor deze workflow; `AI_PROVIDER` schrijft alles. De server negeert wat de browser vraagt (`readRun`). De onthouden keuze in de browser blijft bewaard en telt weer zodra dit aan staat. |

## Prompts wijzigen

Prompts staan in `prompts.json`, met per run `titel`, `wanneer`, `krijgt`,
`levert`, `instructions`, `effort` en `maxOutputTokens`. Het bestand wordt per
run opnieuw ingelezen zodra het gewijzigd is; een herstart is niet nodig.

- Zet **nooit** promptteksten terug in de TypeScript.
- De datapayload (OCR, blokken, page image) wordt in code samengesteld en hoort
  niet in het bestand.
- Prompts zijn in het Engels, alles wat de gebruiker leest is in het Nederlands.
- `effort` is `null` (neem `.env.local`) of `minimal|low|medium|high`.


## Het formaat van de leesvolgorde-run

De leesvolgorde-run schrijft platte tekst met een handvol markers. Platte tekst omdat het live
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
npm run golden
npm run build
```

`npm run golden` rekent compileren, het pakket, MDX, HTML, Word, de beeldregels en `stitch`
door op de oude jobs en magazines in `.data/jobs/` en vergelijkt de uitkomst met
de hashes in `scripts/golden.json`. Het kost geen tokens. Wijkt er iets af, dan
staat de nieuwe uitkomst in `.data/golden-diff/`. Is dat verschil de bedoeling,
leg het dan vast met `npm run golden -- --update`, in dezelfde commit als de
wijziging. Bij verhuizen of opsplitsen van code mag er niets afwijken.

Een volledige run kost geld: ongeveer 14 runs en 69k tokens voor een artikel van
zes pagina's. Doe dat alleen als het nodig is.

**Voor deterministische wijzigingen** (compile, patch, parse, cleanup): draai
niet opnieuw. De opgeslagen output van beide runs staat in IndexedDB onder
`<job-id>/pages.json` (store `data`), en voor oude jobs nog in
`.data/jobs/<id>/pages.json`. Zet tijdelijk een route neer die `compileArticle` op dat bestand
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

- **Vercel breekt een functie hard af na zijn `maxDuration`.** Dan komt er geen
  fout terug, alleen een afgebroken verbinding, en zijn de tokens van de lopende
  aanroep wel betaald. Geef daarom in elke route met een model `maxDuration` door
  aan `readRun(request, maxDuration)`, en aan `sse(werk, maxDuration)` als hij
  streamt. Dat zet een deadline op de `Ledger` (`lib/deadline.ts`): de modelclient
  begint geen poging meer met minder dan 60 seconden over, en kapt een lopende af
  30 seconden vóór Vercel, met een melding die zegt dat de tijd op was. Een stream
  eindigt met `{ type: 'end' }`; komt die niet, dan zegt `postStream` of het de
  tijd van Vercel was of de verbinding. Vergeet je `maxDuration` door te geven,
  dan werkt alles nog, maar zonder die bescherming.
- **Een Word-export controleer je zonder Word.** Word zegt alleen "onleesbare
  inhoud" en niet waarom. Controleer daarom de XML tegen de OOXML-schema's (lxml
  met `wml.xsd` uit ISO/IEC 29500 transitional), en kijk hoe het eruitziet met
  `qlmanage -t -s 1400 -o <map> bestand.docx`, dat macOS zelf heeft. `textutil
  -convert txt` laat zien of een andere lezer de tekst eruit krijgt. Let op: een
  `\u0000` in een regex moet als escape in de bron staan, niet als echt teken, anders
  ziet git het bestand als binair.
- **pdf.js rendert via `requestAnimationFrame`**, en een achtergrondtab bevriest
  dat. Daarom `intent: 'print'` in `lib/client/render.ts`. Haal dat niet weg,
  anders hangt het renderen zodra de gebruiker wegklikt.
- **Prettier herschrijft `app/page.tsx` en `components/`** (quotes, JSX-indentatie). Exacte
  string-vervangingen kunnen daardoor missen. Lees het bestand voor je patcht.
- **Stop de dev-server voor je `.next` weggooit.** Anders krijg je
  `Cannot find module './873.js'`, een stale chunk-cache, geen codefout. Wil je
  bouwen terwijl er een dev-server draait: `NEXT_DIST_DIR=.next-test npm run
  build`.
- **Het model heet `gpt-5.6-terra`.** "medium" is de reasoning-effort, een aparte
  parameter, geen deel van de model-id. Een `model_not_found` wordt apart
  afgevangen en niet opnieuw geprobeerd.
- **Twee providers, één client.** Wie het artikel schrijft is `AI_PROVIDER`;
  de keuze per run in de interface staat uit (`AI_PROVIDER_CHOICE`, zie "Tijdelijk
  uitgezet"). Mistral doet altijd de OCR. De provider reist mee
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
  genoeg voor de tekst en niet voor het denken, dus de leesvolgorde-run stierf
midden in een
  zin (`finish_reason: length`). De Mistral-standaard is daarom 48000, en bij
  afkappen verdubbelt de client het budget één keer (tot 65536) in plaats van
  de pagina om te leggen.