# Vrhl · Blad Converter

Een opgemaakt magazineartikel wordt één verticale kolom. Per pagina, met een
woordindex die elke run nakijkt en typografie die rechtstreeks uit de PDF komt.

## De flow

**Stap 1.** PDF in de dropzone. De browser rendert elke pagina naar een image en
haalt met pdf.js meteen de ingesloten bitmaps eruit, op de resolutie waarop ze in
het blad staan.

**Stap 2.** *Convert*.

```
     Mistral OCR (1 call)              pdf.js ript de bitmaps
  woordindex per pagina                uit de PDF, op 300 dpi
                    \                 /
                     +---------------+
                             |
        Frontmatter-agent          Beeldbeoordeling      <- parallel
   loopt vanaf pagina 1 door    regelfilter gooit strepen
   tot de titel gevonden is     en ornamenten eruit, de rest
   chapeau, titel, auteur,      wordt in een keer beoordeeld:
   fotograaf, datum, intro      hoort dit in het artikel?
                             |
     +-----------------------+-----------------------+
  pagina 1                pagina 2                pagina 3   <- parallel
     |                       |                       |
  AI run 1: schrijft de pagina uit in leesvolgorde,
  inserts, quotes, streamers en images op hun plek,
  streamt live naar de interface
     |
  woordindex-check: staan er woorden in die de pagina niet heeft?
  te veel? dan krijgt run 1 een tweede poging
     |
  AI run 2: styling. Zoekt bold, italic, underline en strikethrough
  en vervangt die woorden in de output van run 1
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

## De regels van run 1

Run 1 is de enige run die tekst schrijft. Alles wat hij moet weten staat in
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
het paginaoppervlak. Wat overblijft gaat in één run naar het model, met formaat,
resolutie en plek erbij. Naast elkaar zien is wat werkt: een logo herken je pas
als logo als er een foto naast ligt.

Alleen wat beide stappen overleeft krijgt run 1 te zien, en die moet ze allemaal
een plek geven.

## De woordindex

Mistral bepaalt welke woorden bestaan. Per pagina bouwen we daaruit een
genormaliseerde woordindex, en daar wordt run 1 tegen afgerekend:

- een woord dat **niet in de index staat** is verzonnen;
- een woord dat **vaker wordt gebruikt dan de pagina het bevat** wijst op
  gedupliceerde tekst. Daar gaat het mis;
- de **dekking** is het percentage uitvoerwoorden dat de OCR dekt.

Staan er te veel onbekende woorden in, dan krijgt run 1 één herkansing. Niet de
hele pagina, niet het hele artikel. Zie het tabblad *Controle*.

## Doorlopende tekst

Zegt run 1 dat een pagina midden in het artikel begint, dan wordt de eerste
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

### Instellingen

Alles in `.env.local`. Mistral leest altijd de pagina's (`mistral-ocr-latest`).
Wie het artikel schrijft kies je per run met de schakelaar naast *Convert*:

| | model | prijs per 1M tokens (in / uit) |
|---|---|---|
| OpenAI | `gpt-5.6-terra` (`OPENAI_MODEL`) | $2 / $12 |
| Mistral | `mistral-medium-2604`, Mistral Medium 3.5 (`MISTRAL_MODEL`) | $1,50 / $7,50 |

`AI_PROVIDER` is de stand waarmee de schakelaar opent; je laatste keuze wordt
onthouden. `OPENAI_REASONING_EFFORT` geldt voor beide: Mistral kent dezelfde
namen (plus `none` en `xhigh`).

Mistral meldt in elk antwoord hoeveel requests per minuut de key mag. De client
leest dat en spreidt de calls daarop, ook als pagina's tegelijk lopen; tot het
eerste antwoord geldt `MISTRAL_REQ_PER_MINUTE`. Staat een model op **0**, dan
stopt de run meteen met een melding: zet dan een limiet aan op
admin.mistral.ai/plateforme/limits. `MAX_CONCURRENCY` bepaalt hoeveel pagina's
tegelijk draaien.

## Prompts tweaken

Alle prompts staan in **`prompts.json`** in de projectmap, niet in de code: vier
runs (`frontmatter`, `imagetriage`, `structure`, `styling`) plus de gedeelde
`rules` die aan iedere run voorafgaat.

Bewerk het bestand en draai opnieuw. Een herstart is niet nodig; het wordt
opnieuw ingelezen zodra het is gewijzigd. Maak je een JSON-fout, dan blijft de
laatst werkende versie in gebruik en staat de fout in de serverlog; je run valt
er dus niet door om.

`effort` is de reasoning-inspanning van die ene run (`minimal` · `low` ·
`medium` · `high`); `null` betekent: neem `OPENAI_REASONING_EFFORT` uit
`.env.local`.

Het tabblad **Prompts** in de app toont wat er op dat moment naar elke run gaat.
De datapayload (OCR, blokken, page image) wordt in code samengesteld en staat
niet in het bestand.

## Structuur

```
app/                UI en API-routes
components/         Stream (live), ArticleView, Checks, Prompts
prompts.json        alle prompts, buiten de code, om te tweaken
lib/agents/         frontmaster, imagetriage, structure (run 1), styling (run 2)
lib/client/images.ts  ript de bitmaps uit de PDF met pdf.js
lib/imagefilter.ts  de regels die strepen en ornamenten meteen wegzetten
lib/prompts.ts      laadt prompts.json en herlaadt bij wijziging
lib/pagemarkup.ts   parst de markers van run 1 naar blokken
lib/patch.ts        legt de styling van run 2 over run 1 heen
lib/wordindex.ts    de woordindex en zijn controle
lib/compile.ts      pagina's naar één artikel
lib/pipeline.ts     de orkestratie, en wat waar parallel loopt
lib/llm/            Mistral OCR, en één chatclient voor OpenAI en Mistral
                    (fetch, geen SDK, streaming, houdt zich aan Mistrals limieten)
.data/jobs/         per job: page images, geripte bitmaps, ocr.json,
                    images.json, pages.json, article.json
```

## Output

Eén artikelobject: `frontmatter` plus een platte `content`-lijst van
`paragraph`, `subheading`, `quote`, `streamer`, `image` en `insert`. Dat is wat
de app intern rondstuurt en wat de MDX-tab laat bewerken.

Naar buiten gaat het als **Vrhl Content Package 1.0**, het canonieke
uitwisselformaat uit `Vrhl-Blad-Canonical/canonical/`. Dat formaat kent geen CMS
en geen opslagtechniek: één `pakket.json` met de artikelen en een aparte
`assets`-lijst waar de content via id's naar verwijst. Vanuit dat ene pakket
lopen de vertaalslagen naar MDX, Word, HTML of Sanity, zonder dat deze converter
van een van die kanten iets hoeft te weten.

De MDX-tab is daar meteen het bewijs van: die tekst wordt niet meer uit het
artikelobject geschreven maar uit het pakket, net zoals een Word- of
Sanity-adapter dat zou doen. Wat je in de MDX ziet staat dus letterlijk in
`pakket.json`.

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
