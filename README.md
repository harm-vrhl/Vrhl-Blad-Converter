# Vrhl · Blad Converter

Een opgemaakt magazineartikel wordt één verticale kolom. Per pagina, met een
woordindex die elke run nakijkt en typografie die rechtstreeks uit de PDF komt.

## De flow

**Stap 1.** PDF in de dropzone. De browser rendert elke pagina naar een image en
haalt met pdf.js meteen de ingesloten bitmaps eruit, op de resolutie waarop ze in
het blad staan.

**Stap 2.** *Convert*.

```
     Mistral OCR (per pagina)          pdf.js ript de bitmaps
  woordindex per pagina                uit de PDF, op 300 dpi
                    \                 /
                     +---------------+
                             |
        Frontmatter-agent          Beeldbeoordeling      <- parallel
   begint met de opening (de    regelfilter gooit strepen
   eerste twee pagina's)        en ornamenten eruit, de rest
   chapeau, titel, auteur,      per pagina met de pagina erbij:
   fotograaf, datum, intro      hoort dit in dit artikel?
                             |
     +-----------------------+-----------------------+
  pagina 1                pagina 2                pagina 3   <- parallel
     |                       |                       |
  leesvolgorde: schrijft de pagina uit in leesvolgorde,
  inserts, quotes, streamers en images op hun plek,
  streamt live naar de interface
     |
  woordindex-check: staan er woorden in die de pagina niet heeft?
  te veel? dan een tweede poging, mét de misgeschreven woorden erbij
     |
  opmaak: zoekt bold, italic, underline en strikethrough en legt die
  over de leesvolgorde heen (start tegelijk, wacht niet)
     |
     +-----------------------+-----------------------+
                             |
                    Compileren tot één artikel
```

Eén AI-run per pagina die tekst schrijft, plus de frontmatter-agent voor het hele
artikel. Pagina's lopen parallel, en binnen een pagina loopt de opmaak gelijk op
met het schrijven: de tekst verschijnt dus meteen mét zijn vet en cursief.

De opmaak komt niet uit een model maar **uit het fontregister van de PDF zelf**.
Alleen voor pagina's zonder tekstlaag (een scan, een advertentie die als beeld is
geëxporteerd) kijkt er alsnog een run naar de page image. Zie
[TYPOGRAFIE.md](TYPOGRAFIE.md) voor het waarom en de vallen.

## De regels van de leesvolgorde-run

De leesvolgorde-run is de enige run die tekst schrijft. Alles wat hij moet weten staat in
`prompts.json`, samengevat:

- Bepaal waar de lezer begint. Daar begint de output.
- Geef alles behalve footers, kopregels bovenaan en paginanummering. En behalve
  wat de frontmatter al bevat: chapeau, titel, ondertitel, creditregel, intro.
- Een kader met achtergrondinformatie over het hoofdartikel komt **tussen** de
  alinea's. Gaat het over iets anders, dan komt het **achteraan** de pagina, na
  de lopende tekst. Een kader blijft altijd heel.
- Een quote mag nooit vóór de alinea staan waarin die tekst voorkomt. Weet je
  het niet zeker, dan komt hij na de laatste volledig leesbare alinea.
- Een afbeelding komt op de meest logische plek tussen de alinea's, nooit midden
  in een zin.
- Woorden letterlijk uit de OCR. Regels aan elkaar tot lopende zinnen, en
  woorden die door een regel- of kolomafbreking gesplitst zijn weer heel.

De output is platte tekst met een handvol markers, zodat hij live kan streamen
en daarna deterministisch te parsen is:

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

Wat de parser niet herkent, valt terug op een gewone alinea. Er gaat dus nooit
tekst verloren doordat een marker misgaat.

## Beeld

De afbeeldingen komen niet uit de OCR maar uit de PDF zelf. pdf.js loopt de
tekenopdrachten van elke pagina langs, haalt de ingesloten bitmap op en berekent
uit de transformatiematrix waar hij staat en hoe groot hij gedrukt is. Een
magazinefoto is zo 2275x2988 pixels op 300 dpi in plaats van een her-gecodeerde
uitsnede.

Beoordelen gebeurt in twee stappen. Een regel gooit eerst weg wat geen oordeel
verdient: bitmaps kleiner dan 20 pixels, iets dat als minder dan 8pt op de pagina
staat, verhoudingen boven 20:1 (strepen en kaderlijnen) en alles onder 0,15% van
het paginaoppervlak. Wat overblijft gaat per pagina naar het model: de hele page
image, de beelden van die pagina als thumbnail, en per beeld waar het staat. Waar
de magazinescan het weet, krijgt het ook mee waar het artikel over gaat.

Het beeld zelf zegt niet genoeg. Een foto in een advertentiebalk onderaan de
pagina ziet er precies zo uit als een foto in het verhaal erboven; wat hem verraadt
is waar hij staat, naast een logo, een slogan en een webadres. Daarom zoekt het
model elk beeld op in de pagina en beoordeelt het daar: een beeld in een
advertentie, een banner of een ander artikel op dezelfde pagina gaat eruit. De
leesvolgorde-run heeft dezelfde regel als vangnet: een beeld dat zichtbaar in een advertentie
staat, plaatst hij niet.

Alleen wat beide stappen overleeft krijgt de leesvolgorde-run te zien, en die
moet ze allemaal
een plek geven.

**Wie staat erop.** Bij het rippen wordt uit de tekstlaag van de PDF gehaald welke
tekst direct onder, boven of naast elk beeld staat (`nearby`, `lib/nearby.ts`):
de naam onder een portret, een bijschrift, of het woord ADVERTENTIE. Die tekst
gaat mee naar de beeldbeoordeling en naar de leesvolgorde-run. Op een pagina met
zes portretten op een rij hoeft niemand dan te raden welk gezicht bij welke naam
hoort: die run zet elk portret bij de persoon die de tekstlaag ernaast noemt. Een portret naast
een naam in een rij mensen (personalia, benoemingen) is altijd inhoud, hoe klein
ook.

### Opgeknipte beelden

Een kaart, infographic of illustratie zit vaak niet als één bitmap in de PDF. De
export knipt hem in stroken en blokken, soms honderd stuks, en elk stuk wordt
apart geript. Los in een artikel zijn dat scherven.

Tijdens het uitlezen zoekt de browser die mozaïeken op (`lib/mosaic.ts`):

- stukken die elkaar raken horen bij elkaar; een groep waarin geen stuk het blok
  domineert is een opgeknipt beeld, geen foto met een logo erop;
- stukken die tegen lopende tekst aan liggen doen niet mee: dat zijn het vlak en
  de schaduw van een kader, en die zien er in pixels hetzelfde uit als de rand
  van een kaart;
- vanaf de stukken wordt gevolgd wat er op de gerenderde pagina aan vastzit (de
  titel, de legenda, een getekende cirkel), tot aan tekstkaders, koppen en de
  paginamarges; een schaduw of lijn langs de rand gaat eraf;
- dat blok wordt op 300 dpi van de pagina gerenderd als één beeld, en de stukken
  krijgen de reden *stuk van een opgeknipt beeld*.

Zou het blok toch een tekstkader meenemen, dan wordt er niet samengevoegd en gaan
de stukken eruit. Liever geen kaart dan een kaart met een half kader. Wat daarna
nog als los fragment doorkomt, gooit de beeldbeoordeling weg. Werkt op nieuwe
uploads; een oude job moet opnieuw worden geupload.

## De woordindex

Mistral bepaalt welke woorden bestaan. Per pagina bouwen we daaruit een
genormaliseerde woordindex, en daar wordt de leesvolgorde-run tegen afgerekend:

- een woord dat **niet in de index staat** is verzonnen;
- een woord dat **vaker wordt gebruikt dan de pagina het bevat** wijst op
  gedupliceerde tekst. Daar gaat het mis;
- de **dekking** is het percentage uitvoerwoorden dat de OCR dekt.

Staan er te veel onbekende woorden in, dan volgt één herkansing van die ene
pagina. Niet het hele artikel. Zie het tabblad *Controle*.

## Doorlopende tekst

Zegt de leesvolgorde-run dat een pagina midden in het artikel begint, dan wordt de eerste
alinea zonder regelafbreking direct aan de laatste alinea van de vorige pagina
geplakt, ook als daar nog een quote of een afbeelding onder hing.

## Aan de praat

```bash
npm install
```

Vul je tokens in `.env.local` (staat klaar, is gitignored):

```
MISTRAL_API_KEY=...
OPENAI_API_KEY=...
```

```bash
npm run dev
```

http://localhost:3210 · PDF erin · *Convert*.

## Opslag, en hosten op Vercel

De app draait op Vercel. Daar bewaart de server niets: elk verzoek kan op een
andere machine landen en een schijf blijft niet bestaan. Daarom:

- **De browser bewaart alles**, in IndexedDB (`lib/client/db.ts`): de job, de
  renders en foto's, de tussenresultaten van elke stap, het artikel en de
  correcties. Op het startscherm staat wat er eerder is omgezet, met hoeveel
  ruimte het inneemt. Het staat op die ene computer in die ene browser; het
  archief is Sanity.
- **De browser regelt de run** (`lib/client/run.ts`, magazine:
  `lib/client/analyze.ts`). De server krijgt per stap één kort verzoek met alleen
  wat die stap nodig heeft (`app/api/run/*`, `app/api/magazine/*`,
  `app/api/sanity/*`) en roept OpenAI, Mistral of Sanity aan met de sleutels die
  op de server blijven.
- **Elke stap wordt meteen bewaard.** Stopt een run halverwege (tabblad dicht,
  netwerk weg), dan gaat *Verder waar het stopte* verder zonder de OCR en de
  klaargezette pagina's opnieuw te betalen. Hetzelfde geldt voor de analyse van
  een heel magazine: pagina's die al bekeken zijn gaan niet nog een keer langs
  het model.

Twee grenzen van Vercel bepalen hoe dat is opgeknipt:

1. **Een verzoek mag niet eindeloos duren.** Standaard 5 minuten, op Pro
   maximaal 800 seconden. Een heel magazine in één verzoek past daar nooit in;
   één pagina per verzoek duurt 10 seconden tot 2 minuten.
2. **Een verzoek mag hooguit 4,5 MB zijn**, heen en terug. Een magazine-PDF is
   50 MB, dus gaat de PDF per pagina naar de OCR, en gaan de render en de tiles
   van een pagina in aparte verzoeken. `runForm` in `lib/client/post.ts` houdt
   alles boven 4,4 MB al in de browser tegen, met een melding die zegt wat te
   groot was.

**Toegang.** Elke API-route gebruikt de sleutels van de redactie, dus op Vercel
hoort er een slot op. Zet `APP_PASSWORD` en `AUTH_SECRET` (bv. `openssl rand -hex
32`) in de omgevingsvariabelen van het project; `middleware.ts` stuurt iedereen
zonder geldige cookie naar `/login`. Zonder `APP_PASSWORD` staat alles open, wat
lokaal handig is.

**Wachtwoord raden wordt afgeremd:** tien pogingen per tien minuten per IP, goed
of fout. Op Vercel telt de Firewall dat over alle machines samen, maar alleen als
de regel bestaat. Maak hem één keer aan in het dashboard: **Firewall > Configure >
New Rule**, If `@vercel/firewall`, Rate limit ID `inloggen`, Fixed window **10
minuten**, **10** verzoeken, sleutel **IP**, Then **Default (429)**, en daarna
**Review Changes > Publish**. Ontbreekt de regel, dan remt elke machine alleen
voor zichzelf en staat er bij elke poging een melding in de log.

Op Vercel verder: alle sleutels uit `.env.example` als omgevingsvariabelen. Fluid
compute staat standaard aan. `prompts.json` gaat via
`outputFileTracingIncludes` in `next.config.mjs` mee in de functies.

Een tweede build naast een lopende dev-server, zonder elkaars `.next` te raken:

```bash
NEXT_DIST_DIR=.next-test npm run build
```

### Instellingen

Alles in `.env.local`. Mistral leest altijd de pagina's (`mistral-ocr-latest`).
Wie het artikel schrijft kies je per run met de schakelaar naast *Convert*:

| | model | prijs per 1M tokens (in / uit) |
|---|---|---|
| OpenAI | `gpt-5.6-terra` (`OPENAI_MODEL`) | $2 / $12 |
| Mistral | `mistral-medium-2604`, Mistral Medium 3.5 (`MISTRAL_MODEL`) | $1,50 / $7,50 |

`AI_PROVIDER` is de stand waarmee de schakelaar opent; je laatste keuze wordt
onthouden. `OPENAI_REASONING_EFFORT` is voor OpenAI (`medium`). Mistral heeft
zijn eigen `MISTRAL_REASONING_EFFORT` (`high`): Medium 3.5 accepteert geen
`medium`, en `high` is dezelfde kwaliteit als het eerdere stille remap.

Mistral start chat-calls aan 1 per seconde (`MISTRAL_REQ_PER_MINUTE=60`) en
nooit sneller, ook als pagina's tegelijk lopen. Staat een model op **0**, dan
stopt de run meteen met een melding: zet dan een limiet aan op
admin.mistral.ai/plateforme/limits. `MAX_CONCURRENCY` bepaalt hoeveel pagina's
tegelijk mogen nadenken; de starts blijven 1 per seconde.

## Een volledig magazine

Met de schakelaar **Eén artikel / Volledig magazine** boven de dropzone zet je
een heel blad erin. Dan wordt eerst uitgezocht waar de artikelen staan, en kies
je daarna welke je omzet.

```
magazine.pdf
  |
  browser: per pagina een image van 1400 px en de tekstlaag (pdf.js)
  |
  Pagina's bekijken, per pagina, parallel          <- goedkoop model
     ziet de pagina tussen zijn twee buren:
     welke buur ligt ertegenover (spread), wat voor pagina,
     gedrukt paginanummer, welke stukken
     (begint hier of loopt door, titel, rubriek, waar het over gaat),
     verwijzingen, en de regels van een inhoudsopgave
  |
  Aan elkaar rijgen                                 <- regels, geen model
     spreads: twee pagina's die het van elkaar zeggen, bij onenigheid
     beslist het even paginanummer links;
     offset uit de paginanummers (een misser telt niet mee,
     een bijlage met eigen nummering wel).
     MET INHOUDSOPGAVE (de gewone situatie): die is leidend.
       elke regel is een artikel, vanaf de pagina die hij noemt
       tot de volgende regel; advertenties ertussen overgeslagen;
       doorlopende tekst en stukken met dezelfde rubriek horen erbij
       (Personalia is één artikel, niet één per persoon)
     ZONDER: artikelen van begin tot begin uit de pagina's zelf
  |
  Inhoudscontrole, per twijfelpagina               <- goedkoop model
     staat er een stuk met een eigen kop en een andere rubriek?
     hoort het bij het artikel uit de inhoudsopgave, deels, of niet?
     (zonder inhoudsopgave: grenscontrole per overgang)
     twijfel? dan kijkt het gewone model nog een keer
  |
  een lijst artikelen: aanvinken en Omzetten
  |
  per artikel knipt de browser de hele pagina's eruit (pdf-lib)
  en die PDF gaat door precies dezelfde artikel-run als hierboven,
  op de achtergrond: uitlezen één voor één in de browser, de runs
  naast elkaar (MAGAZINE_ARTICLE_CONCURRENCY, standaard 3)
```

Het magazinemodel staat in `.env.local`: `OPENAI_MAGAZINE_MODEL`
(`gpt-5.6-luna`, $0,20 in / $1,20 uit) of `MISTRAL_MAGAZINE_MODEL`. Er gaat geen
OCR overheen; die draait pas in de artikel-run, op alleen de pagina's van dat
artikel.

Een opening kan over twee pagina's lopen: de kop links en de intro rechts, of een
foto links en de kop rechts. Het systeem kijkt daarom in spreads. Begint een
artikel op een linkerpagina die tegenover een pagina van hetzelfde artikel ligt,
dan krijgt de frontmatter-agent in de artikel-run die twee pagina's. Begint het op
een rechterpagina, dan alleen die ene. Een losse artikel-PDF krijgt altijd de
eerste twee, en de prompt bewaakt dat de eerste alinea van de lopende tekst geen
intro wordt.

Tijdens het omzetten blijf je op de lijst. Per artikel zie je hoe ver het is
(uitlezen, pagina's klaar, kosten) en met *Openen* kijk je in een artikel dat
klaar is; *Magazine* in de kop brengt je terug, en wat nog loopt gaat door.

Wat de lijst niet zeker weet, zegt hij: *nakijken* als de controle twijfelde of
een stuk niet in de inhoudsopgave staat (zoals een partnerpagina tussen twee
artikelen), *deelt een pagina* als twee artikelen op dezelfde pagina staan. Leest
de paginascan één regel van de inhoudsopgave als twee (een kop en de beschrijving
eronder), dan wordt dat weer één artikel. Een gedeelde pagina gaat nu nog in zijn geheel mee met
beide artikelen.

## Prompts tweaken

Alle prompts staan in **`prompts.json`** in de projectmap, niet in de code: vier
runs (`frontmatter`, `imagetriage`, `structure`, `styling`) plus de gedeelde
`rules` die aan iedere run voorafgaat.

Bewerk het bestand en draai opnieuw. Een herstart is niet nodig; het wordt
opnieuw ingelezen zodra het is gewijzigd. Maak je een JSON-fout, dan blijft de
laatst werkende versie in gebruik en staat de fout in de serverlog; je run valt
er dus niet door om. Dat herladen werkt alleen lokaal: op Vercel staat
`prompts.json` vast in de deploy, dus daar gaat een wijziging mee met de volgende
deploy.

`effort` is de reasoning-inspanning van die ene run (`minimal` · `low` ·
`medium` · `high`); `null` betekent: neem `OPENAI_REASONING_EFFORT` of
`MISTRAL_REASONING_EFFORT` uit `.env.local`, afhankelijk van wie schrijft.

De datapayload (OCR, blokken, page image) wordt in code samengesteld en staat
niet in het bestand.

## Structuur

```
app/                UI en API-routes
components/         Workflow, ArticleView, MagazineView, Checks (Controle-tab)
prompts.json        alle prompts, buiten de code, om te tweaken
lib/agents/         frontmaster, imagetriage, structure (leesvolgorde), styling (opmaak)
lib/client/images.ts  ript de bitmaps uit de PDF met pdf.js
lib/imagefilter.ts  de regels die strepen en ornamenten meteen wegzetten
lib/prompts.ts      laadt prompts.json en herlaadt bij wijziging
lib/pagemarkup.ts   parst de markers van de leesvolgorde-run naar blokken
lib/patch.ts        legt de opmaak over de leesvolgorde heen
lib/wordindex.ts    de woordindex en zijn controle
lib/compile.ts      pagina's naar één artikel
lib/client/run.ts   de regie van een run, in de browser: wat wanneer, wat parallel
lib/client/db.ts    de opslag in de browser (IndexedDB): jobs, beeld, tussenstappen
lib/client/post.ts  praten met de server, en de 4,5 MB-grens bewaken
lib/server/run.ts   wat elke run-route deelt: verzoek lezen, kosten, streamen
app/api/run/        één korte stap per verzoek: ocr, frontmatter, images, page, styling
lib/llm/            Mistral OCR, en één chatclient voor OpenAI en Mistral
                    (fetch, geen SDK, streaming, houdt zich aan Mistrals limieten)
middleware.ts       het wachtwoordslot (APP_PASSWORD)
lib/server/loginlimit.ts  hoe vaak het wachtwoord geprobeerd mag worden
```

## Output

Eén artikelobject: `frontmatter` plus een platte `content`-lijst van
`paragraph`, `subheading`, `quote`, `streamer`, `image` en `insert`. Dat is wat
de app intern rondstuurt, en wat je in de Artikel-tab corrigeert.

Naar buiten gaat het als **Vrhl Content Package 1.0**, het canonieke
uitwisselformaat uit `Vrhl-Blad-Canonical/canonical/`. Dat formaat kent geen CMS
en geen opslagtechniek: één `pakket.json` met de artikelen en een aparte
`assets`-lijst waar de content via id's naar verwijst. Vanuit dat ene pakket
lopen de vertaalslagen naar MDX, Word, HTML of Sanity, zonder dat deze converter
van een van die kanten iets hoeft te weten.

De JSON-tab laat dat pakket zien zoals het naar Sanity en in de ZIP gaat,
alleen-lezen. Correcties doe je in de Artikel-tab: klik in de tekst, ⌘B/⌘I/⌘U
voor opmaak, een blok leegmaken haalt het weg. De volgorde verander je met de greep
die links van een blok verschijnt als je eroverheen beweegt (slepen, of de greep in
focus en dan pijltjes omhoog en omlaag). Een blok kan ook een kader in of uit: sleep
het midden in een kader (dat kleurt oranje met "In dit kader zetten") of sleep het
eruit (de lijn zegt dan "Uit het kader halen"). Met de pijltjes gaat een blok dat
tegen een kader aan schuift erin, en het eerste of laatste blok van een kader eruit.
Een kader kan niet in een ander kader, en een kader dat leeg raakt verdwijnt. De kop
van een kader is een blok als elk ander: net als in het canonieke formaat heeft een
kader geen vaste titel, dus ook die kop kun je verplaatsen. *Terug naar AI-resultaat* zet
alles terug. MDX is alleen nog een export, uit het pakket geschreven zoals een
Word-adapter dat ook zou doen.

*Download pakket* levert een ZIP met `pakket.json` en het beeld ernaast. Zo
uitgepakt is het te controleren met de validator van het formaat zelf:

```bash
node canonical/validate.mjs pakket.json --bestanden
```

Wat de converter meestuurt en waarom het er staat:

| Veld | Wat erin komt |
|---|---|
| `bron.betrouwbaarheid` | De **laagste** woorddekking van alle pagina's. Een artikel is zo goed als zijn slechtste pagina; wegmiddelen verbergt precies wat je wilt zien. |
| `bron.controleren` | Waar een mens naar moet kijken, bijvoorbeeld `woorden` als een pagina iets buiten de index schreef. |
| `bron.paginas` | Uit welke pagina's van de PDF dit komt. |
| `externeId` | `pdf:<hash van de bestandsnaam>#p1-6`. Stabiel, zodat een tweede run bijwerkt in plaats van dupliceert. |
| `publicatie.klaar` | Altijd `false`. Een machinale extractie is niet nagekeken, dus de importer hoort hem als concept te behandelen. |

Wat de PDF niet kan weten (tags, editie, SEO, video) blijft weg in plaats van
verzonnen te worden. Alt-teksten ook: staat er geen bijschrift bij het beeld, dan
komt er geen alt, en meldt de validator dat als waarschuwing.

## Naar Sanity

*Push naar Sanity* zet het pakket als **concept** in het CMS. Concept, altijd:
deze converter zet `publicatie.klaar` nooit op `true`, dus een import kan niet
meteen live staan. De redactie publiceert zelf.

Vul hiervoor drie dingen in `.env.local`:

```
NEXT_PUBLIC_SANITY_PROJECT_ID=
NEXT_PUBLIC_SANITY_DATASET=production
SANITY_API_TOKEN=
```

Het token heeft schrijfrechten nodig en blijft op de server; de interface hoort
alleen of er een token is. De browser stuurt het beeld één foto per verzoek
(`/api/sanity/asset`) en daarna het pakket met de id's die Sanity teruggaf
(`/api/sanity/push`), zodat geen verzoek boven de 4,5 MB komt. Zonder deze drie werkt de converter gewoon door en
blijft alleen de knop uit.

Wat de import doet, in de volgorde die `canonical/sanity/mapping.json`
voorschrijft: eerst het beeld uploaden, dan auteurs, fotografen, illustratoren en
tags op naam opzoeken en aanmaken als ze er nog niet zijn, en pas daarna het
artikel schrijven. Het document-id wordt afgeleid uit de `externeId`, dus een
tweede run werkt hetzelfde concept bij in plaats van er een tweede naast te
zetten.

### Eerst kijken, dan pas duwen

Er is een droogloop die niets verstuurt en geen token nodig heeft. Die rekent
alleen uit wat er geschreven zou worden, zodat je het kunt nakijken met de
validator van de opslagvorm zelf:

Download eerst de JSON van het artikel (knop *JSON*, dat is `pakket.json`), en dan:

```bash
curl -s -X POST http://localhost:3210/api/sanity/push \
  --form-string "input={\"dryRun\":true,\"bare\":true,\"pakket\":$(cat pakket.json)}" > documenten.json
node canonical/sanity/validate.mjs documenten.json
```

De afbeeldingsverwijzingen zijn in een droogloop nog niet echt, want er is niets
geupload; de rest van de vorm is wel precies wat er anders naar Sanity zou gaan.
