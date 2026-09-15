# Hoe het systeem werkt

Dit document legt stap voor stap uit wat er gebeurt als je een PDF omzet. Er zijn
twee manieren: **één artikel** (een PDF met één artikel) en **volledig magazine**
(een heel blad, waaruit je artikelen kiest). Tussen haakjes staat steeds de naam
die in de code wordt gebruikt.

## De basisregel

Drie bronnen, elk met een eigen taak:

| Bron | Beslist over |
|---|---|
| **OCR** (Mistral OCR) | welke woorden er bestaan |
| **De PDF zelf** (pdf.js in de browser) | plaats, lettertype (vet/cursief), beeld |
| **LLM-runs** (OpenAI of Mistral) | leesvolgorde, rol van tekst, wat bij elkaar hoort |

Een LLM mag woorden **ordenen en classificeren**, maar nooit toevoegen,
herschrijven of samenvatten. De **woordindex** controleert dat per pagina.
Stappen die tekst kunnen veranderen (parsen, compileren, opschonen) zijn regels in
code, geen model.

---

## Deel 1: één artikel

### Stap 1. Uitlezen in de browser (`renderPdf`, `uploadArticle`)

Je sleept een PDF in de dropzone. De browser doet per pagina:

1. **Renderen**: de pagina wordt een afbeelding (`page image`), plus een thumbnail
   en de pagina in vier stukken (`tiles`) voor als de opmaak van het beeld gelezen
   moet worden.
2. **Beeld rippen** (`ripImages`): de ingesloten bitmaps worden direct uit de PDF
   gehaald, op hun eigen resolutie, met hun plek op de pagina. Per beeld wordt uit
   de tekstlaag ook de tekst ernaast bewaard (`nearby`): de naam onder een
   portret, een bijschrift. Zo zet run 1 elk portret bij de juiste naam.
3. **Mozaïeken samenvoegen** (`findMosaics` in `lib/mosaic.ts`): een kaart of
   infographic die in de PDF in tientallen stukken is geknipt, wordt weer één
   beeld. De stukken krijgen `partOf` en worden nooit los geplaatst.
4. **Typografie lezen** (`readTypography`): uit het fontregister van de PDF komt
   welke tekst vet of cursief is (`styling`), en elk woord zoals het in het bestand
   staat (`words`).

Alles wordt per pagina **in de browser bewaard** (IndexedDB, `lib/client/db.ts`)
als een **job**. Er gaat nog niets naar de server.

### Stap 2. Convert: de run (`runArticle` in `lib/client/run.ts`)

Je kiest de provider (OpenAI of Mistral) en klikt op *Convert*. De browser regelt
de run: elke stap is een eigen kort verzoek aan de server, met alleen wat die stap
nodig heeft. Wat terugkomt, verschijnt meteen op het scherm en wordt bewaard.

**2a. Woordindex** (`woordindex`)
- Mistral OCR leest de PDF **per pagina** (`/api/run/ocr`, `ocrPage`): de browser
  knipt elke pagina los met pdf-lib.
- Waar OCR en PDF alleen een accent anders hebben, wint de PDF (`reconcile`).
- Per pagina wordt een **woordindex** gebouwd (`buildIndex`): de lijst woorden die
  op die pagina mogen voorkomen.

**2b. Frontmatter en beeldbeoordeling, tegelijk**

- **Frontmatter-agent** (`readFrontmatter`, prompt `frontmatter`)
  Leest chapeau, titel, ondertitel, auteurs, fotografen, datum en intro. Begint
  met de **opening**: de eerste twee pagina's (`OPENING_DEFAULT`), omdat een kop
  links en een intro rechts kan staan. Is er geen titel, dan kijkt hij tot pagina
  3 (`FRONTMATTER_REACH`). Hij krijgt ook de `words` uit de PDF, zodat hij ziet
  welke kop getypt is en welke getekend.

- **Beeldbeoordeling** (`triageImages`, prompt `imagetriage`)
  1. Eerst regels (`obviouslyDecorative`): te klein, een streep, een ornament, of
     een stuk van een mozaïek gaat meteen weg.
  2. Daarna een LLM-call **per pagina**, met de hele pagina erbij en de plek van
     elk beeld. Het model beslist: hoort dit beeld bij dit artikel, of bij een
     advertentie, een ander artikel of de vormgeving van het blad?

**2c. Per pagina, alle pagina's parallel** (`processPage`)

1. **Run 1: leesvolgorde** (`writeStructure`, prompt `structure`)
   Schrijft de pagina uit in de volgorde waarin een lezer leest, als platte tekst
   met markers (`## tussenkop`, `> quote`, `~ streamer`, `[image: ...]`,
   `[insert: ...]`). De output streamt live naar het scherm. Een parser
   (`parsePage`) maakt er blokken van.
2. **Woordindex-check** (`checkAgainstIndex`)
   Staan er meer dan 5 woorden in die niet in de index staan (`UNKNOWN_LIMIT`),
   dan krijgt run 1 **één herkansing**.
3. **Opmaak**
   - Heeft de PDF een leesbare tekstlaag, dan komt vet/cursief uit het
     fontregister (`opmaak uit de PDF`). Geen model nodig.
   - Zo niet (scan, fonts zonder naam), dan leest **run 2** (`detectStyling`,
     prompt `styling`) de opmaak van het beeld.
   - `placeFragments` zoekt die fragmenten op in de tekst van run 1, en
     `applyStyles` legt de opmaak eroverheen.

**2d. Compileren** (`compileArticle` in `lib/compile.ts`)

Regels, geen model:
- pagina's aan elkaar; een zin die over de pagina doorloopt wordt weer één
  alinea (de **naad**);
- wat in de frontmatter staat, gaat uit de body;
- kopregels die op elke pagina terugkomen, gaan eruit;
- een quote staat nooit vóór de alinea waar hij uit komt;
- de openingsfoto wordt de header (`liftHero`).

Het resultaat is een **artikelobject** (`ArticleDocument`): `frontmatter` plus een
platte `content`-lijst.

### Stap 3. Nakijken en exporteren

- **Workflow-zijbalk**: de stappen staan in een zwevend eiland links. Met de knop
  naast "Vrhl Blad" klap je het weg; het werkgebied wordt dan breder. De keuze
  wordt onthouden. Op een smal scherm ligt het eiland over het werkgebied heen en
  sluit het met Escape of een klik ernaast.

- **Tabbladen**: *Pagina's*, *Artikel* (live voorbeeld, tekst direct te
  corrigeren, blokken te verslepen met de greep links van elk blok, ook een kader
  in en uit, met een knop
  terug naar het AI-resultaat), *JSON* (de canonieke
  `pakket.json`, alleen-lezen), *Controle* (woorddekking per pagina,
  beeldoordelen, waarschuwingen).
- **Pakket**: het artikel als **Vrhl Content Package** (`toPackage`, `pakket.json`
  plus beeld in een ZIP). MDX is alleen nog een export, uit dat pakket geschreven (`toMdx`).
- **Sanity**: het pakket gaat als **concept** naar het CMS, nooit live.

---

## Deel 2: volledig magazine

Het magazine heeft twee fases: eerst **analyseren** (waar staan de artikelen?),
daarna **omzetten** (per gekozen artikel precies deel 1).

### Stap 1. Uitlezen in de browser (`scanMagazine`)

Elke pagina wordt een kleinere afbeelding (1400 px) plus de tekstlaag. Geen
beeld rippen, geen typografie: dat is voor de analyse niet nodig. Het magazine
en de PDF worden in de browser bewaard.

### Stap 2. Analyseren (`analyzeMagazine` in `lib/client/analyze.ts`)

Deze run gebruikt een **goedkoop model** (`magazineModelFor`, standaard
`gpt-5.6-luna`). Geen OCR.

**2a. Paginascan** (`scanPage`, prompt `paginascan`), per pagina, parallel

Het model krijgt drie images (vorige, deze en volgende pagina) en de tekstlaag.
Het geeft per pagina terug:
- **soort**: omslag, inhoudsopgave, artikel, advertentie, colofon, overig;
- **facing**: welke buurpagina ertegenover ligt (voor spreads);
- **folio**: het gedrukte paginanummer;
- **stukken** (`pieces`): begint hier een artikel of loopt het door, titel,
  rubriek, één zin waar het over gaat, verwijzingen ("lees verder op pagina 64");
- de regels van de **inhoudsopgave** (`toc`).

**2b. Rijgen** (`stitch` in `lib/magazine/stitch.ts`), regels, geen model

1. **Offset** (`fitOffsets`): het verschil tussen PDF-pagina en gedrukt nummer,
   per meerderheid. Eén verkeerd gelezen nummer telt niet mee.
2. **Spreads** (`pairSpreads`): twee pagina's die van elkaar zeggen dat ze
   tegenover elkaar liggen. Zijn ze het oneens, dan beslist het even nummer links.
3. **Artikelen, met inhoudsopgave** (`byContents`): de **inhoudsopgave is
   leidend**. Elke regel is een artikel, vanaf de pagina die hij noemt tot de
   volgende regel. Advertenties en colofon ertussen worden overgeslagen.
   Doorlopende tekst en stukken met dezelfde rubriek of kop horen er zonder vragen
   bij: Personalia wordt één artikel met alle namen. Staat er een stuk met een
   eigen kop en een andere rubriek, dan wordt die pagina een **vraag**.
4. **Artikelen, zonder inhoudsopgave** (`byPages`): van begin tot begin uit de
   pagina's zelf. Sprongen worden gevolgd, een fotopagina zonder tekst gaat mee
   met de pagina ertegenover, en korte berichten onder één rubriek blijven bij
   elkaar.
5. **Opening**: per artikel de beginpagina, of de spread als het op een
   linkerpagina begint.

**2c. Inhoudscontrole** (`checkContent`, prompt `inhoudscontrole`), per vraag

Alleen met een inhoudsopgave. Voor elke twijfelpagina: hoort het stuk bij het
artikel uit de inhoudsopgave? Antwoorden: `hoort-erbij`, `deels`,
`hoort-er-niet-bij`, `onduidelijk`. Wat er niet bij hoort (een partnerpagina, een
los stuk) wordt een eigen artikel met de notitie *staat niet in de inhoudsopgave*.

**2c'. Grenscontrole** (`checkBoundary`, prompt `grenscontrole`), per overgang

Alleen zonder inhoudsopgave. Voor elke overgang van artikel A naar B: waar houdt A
echt op? Antwoorden: `eindigt-ervoor`, `eindigt-op-beginpagina`, `loopt-verder`,
`onduidelijk`. Bij `onduidelijk` kijkt in beide controles het gewone model nog een
keer (`strongModelFor`).

Het resultaat is de **kaart** (`MagazineMap`, `map.json`): een lijst artikelen
(`MapArticle`) met pagina's, gedrukte nummers, opening, gedeelde pagina's en
opmerkingen.

### Stap 3. Kiezen en omzetten (`MagazineView`)

1. Je vinkt artikelen aan in de lijst en klikt *Omzetten*.
2. De browser **knipt** per artikel de hele pagina's uit het magazine
   (`cutArticle`, pdf-lib). Nooit binnen een pagina.
3. Elk artikel gaat door **deel 1**, op de achtergrond:
   - **uitlezen** (`uploadArticle`) één artikel tegelijk, want dat is zwaar voor
     de browser;
   - **runs** (`streamRun`) naast elkaar, standaard 3
     (`MAGAZINE_ARTICLE_CONCURRENCY`).
4. Het artikel neemt twee dingen mee uit de kaart:
   - **opening** (`Job.opening`): hoeveel pagina's de frontmatter-agent eerst
     bekijkt;
   - **context** (`Job.context`): titel en onderwerp, zodat de beeldbeoordeling
     weet welke beelden bij dit artikel horen.
5. Je blijft op het overzicht en ziet per artikel de voortgang en de kosten. Met
   *Openen* bekijk je een artikel dat klaar is.

---

## Opslag en hosting

De app draait op **Vercel**. Daar onthoudt de server niets tussen twee
verzoeken, een verzoek duurt hooguit 800 seconden en is hooguit 4,5 MB. Daarom:

- **Alles staat in de browser** (IndexedDB): pagina's, foto's, tussenresultaten,
  het artikel en je correcties. Op het startscherm zie je wat er eerder is
  omgezet en hoeveel ruimte het inneemt. Het staat op die computer, in die
  browser; het archief is Sanity.
- **Elke stap is een kort verzoek**, per pagina of per overgang. De browser
  houdt het tempo bij (maximaal `MAX_CONCURRENCY` tegelijk, Mistral één start per
  seconde) en houdt verzoeken boven 4,4 MB tegen.
- **Afgebroken? Verder waar het stopte.** Wat klaar was, wordt niet opnieuw
  betaald.
- **Een wachtwoord** (`APP_PASSWORD`) schermt de app af, want elke stap gebruikt
  de sleutels van de redactie.

## Modellen en kosten

| Taak | Model (instelling in `.env.local`) |
|---|---|
| OCR | `mistral-ocr-latest` (`MISTRAL_OCR_MODEL`) |
| Artikel schrijven (frontmatter, beeld, run 1, run 2) | `gpt-5.6-terra` (`OPENAI_MODEL`) of Mistral Medium (`MISTRAL_MODEL`) |
| Magazine analyseren (paginascan, inhouds- of grenscontrole) | `gpt-5.6-luna` (`OPENAI_MAGAZINE_MODEL`) |
| Inhouds- of grenscontrole bij twijfel | het gewone schrijfmodel |

Elke run telt tokens in een **ledger** (`Ledger`). Aan het eind zie je tijd,
tokens en kosten. Alle prompts staan in `prompts.json` en zijn aan te passen
zonder herstart.

## Waar staat wat

| Onderdeel | Bestand |
|---|---|
| Regie van een run (browser) | `lib/client/run.ts`, `lib/client/analyze.ts` |
| Opslag (browser) | `lib/client/db.ts` |
| Korte stappen (server) | `app/api/run/`, `app/api/magazine/`, `app/api/sanity/` |
| Agents (LLM-runs) | `lib/agents/` |
| Magazine-regels | `lib/magazine/stitch.ts` |
| Wachtwoordslot | `middleware.ts`, `lib/auth.ts` |
| Uitlezen in de browser | `lib/client/` |
| Mozaïeken | `lib/mosaic.ts` |
| Compileren | `lib/compile.ts` |
| Pakket, MDX, Sanity | `lib/canonical.ts`, `lib/mdx.ts`, `lib/sanity/` |
| Prompts | `prompts.json` |
| Regels voor wie aan de code werkt | `AGENTS.md` |
