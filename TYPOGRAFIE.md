# Typografie uit de PDF

> De opmaak van een gedrukt artikel hoeft niet herkend te worden. Ze staat in het
> bestand.

Dit document beschrijft waarom vet en cursief in deze converter **niet** door een
model worden bepaald, hoe ze wel worden bepaald, en welke vallen daarbij zijn
ingegraven. Bijna elke regel hieronder is geleerd door hem eerst fout te doen.

---

## 1. Het inzicht

Een print-PDF bevat per stukje tekst de **font** waarin het gezet is, en de naam
van dat font zegt wat het is. Uit een echt artikel van Onze Taal:

```
AntoniaText-Regular      de broodtekst
AntoniaText-Bold         de vetgezette interviewvragen
DoverSansText-Italic     De Revisor, Zalven, Modelverhalen
DoverSansText-Bold       Kerndoelen, eindtermen:
AntoniaH2-Heavy          de kaderkop
```

Dat is geen schatting van de typografie. Dat *is* de typografie — dezelfde tabel
waarmee de drukker inkt op papier heeft gezet. Er valt niets aan te herkennen; het
staat er.

De consequentie: waar een PDF een tekstlaag heeft, is opmaakdetectie een
**leesprobleem**, geen herkenningsprobleem. Deterministisch, gratis, en elke keer
hetzelfde antwoord.

## 2. Waarom de voor de hand liggende aanpak faalt

De eerste versies lieten een vision-model naar de page image kijken. Dat werkt
verrassend goed en is toch onbruikbaar, om één reden: **variantie**. Dezelfde
pagina, twee keer bekeken, geeft twee verschillende antwoorden. Nu eens een woord
te veel, dan weer een gemist.

Erger nog is de sóórt fout. Een model dat naar een pagina kijkt markeert wat een
lezer zou *verwachten* dat gemarkeerd is:

- een paginanummer waarnaar verwezen wordt — `zie bladzijden 16 en 24`
- een titel tussen aanhalingstekens — `'Op fietse'`
- de kernterm waar het artikel over gaat — `kerndoelen`
- het woord waar het stuk om draait — `woorden`

Alle vier gemeten op echte pagina's, alle vier in gewone broodtekst gezet. Het
model leest in plaats van te kijken.

Het scherpste voorbeeld: een roze kader met de kop *"Wat zijn de nieuwe kerndoelen
en eindtermen?"*, elf regels tekst en een lijstje van vier. Precies **twee**
woorden staan er vet. Een vision-run meldde er **dertien** — elk opsommingsteken,
elk jaartal, elke kernterm.

Uit het fontregister komen er twee. Altijd twee.

## 3. Hoe het werkt

Vier stappen, alle vier in de browser tijdens het renderen — pdf.js draait daar
toch al, dus het kost geen extra call en geen extra seconde.

**`page.getOperatorList()` eerst.** Zonder die aanroep zijn de fontobjecten niet
geladen en krijg je alleen ids als `g_d0_f4` terug in plaats van namen. Het
resultaat wordt weggegooid; het gaat om het neveneffect.

**Tekst-items groeperen tot runs.** Aaneengesloten stukjes in hetzelfde font zijn
één fragment.

**Elke run tegen de broodtekst houden.** Zie §4.2 — "vet" is geen eigenschap van
een font maar een contrast met wat eromheen staat.

**Het resultaat vorm geven als `StyleFragment`.** Exact hetzelfde formaat als de
vision-run levert, zodat alles erna — de plaatser, de live-voorvertoning, het
Controle-venster — ongewijzigd blijft werken.

Wat eruit komt is het fragment zoals de pagina het drukt (`text`) plus de twee of
drie woorden ervóór (`before`). Die context is nodig omdat run 1 een eigen tekst
schrijft: het fragment moet daarin worden teruggevonden, en `before` bepaalt wélk
vóórkomen bedoeld wordt.

Code: [`lib/client/typography.ts`](lib/client/typography.ts) leest,
[`lib/place.ts`](lib/place.ts) plaatst.

## 4. De vallen

Dit is de waardevolle helft van dit document.

### 4.1 pdf.js geeft alleen de naam

Er is **geen** `italic`-vlag, geen `ItalicAngle`, geen ForceBold — ook niet met
`fontExtraProperties: true`, dat voegt enkel `isMonospace`, `isSerifFont` en
`isSymbolicFont` toe. Die informatie zit wél in de font descriptor van de PDF,
maar komt niet door de tekstlaag heen.

Gevolg: alles hangt aan de fontnaam. Waar een producent `AntoniaText-Bold`
wegschrijft weet je alles; waar iemand `F1` schrijft weet je niets. Die twee
moeten uit elkaar gehouden worden — zie §5.

### 4.2 "Vet" is relatief, niet absoluut

Binnenlands Bestuur zet zijn kolommen in `PublicoHeadline-Light`. Daarnaast staan
`-Roman` en `-Medium` in het bestand. Geen van beide heet "Bold", en tegen een
Light-broodtekst zijn het allebei de zware.

Daarom een **gewichtsladder**:

```
Thin 10 · Light 30 · Roman/Regular 40 · Medium 50 · DemiBold 60 · Bold 70 · Black 90
```

Een snede telt als vet wanneer hij hoger op de ladder staat dan de broodtekst van
díe pagina — mits **dezelfde familie** en **dezelfde korpsgrootte**. Die twee
voorwaarden dragen alles: een andere familie is de snede van een ander blok, een
andere korpsgrootte is een kop of een colofon. Geen van beide is nadruk binnen een
zin.

```
broodtekst = PublicoHeadline-Light @8.5
   Roman  @8.5  -> vet          Medium @8.5  -> vet
   Roman  @7    -> niets        (colofon)
   Roman  @18   -> niets        (pull quote)
   GaramondClassico @8.5 -> niets  (andere familie)
```

Let op: `Medium` telt **niet** als vet op naam alleen. In tijdschriftzetsel is een
Medium-gewicht meestal geen vet, en dat als vet lezen was een echte bron van
valse positieven.

### 4.3 Breken op fontnaam, niet op stijl

Een tussenkop en de vraag eronder kunnen allebei vet zijn en tóch verschillende
fonts — `DoverSansText-Bold` boven `AntoniaText-Bold`. Breek je op stijl, dan
plakken ze aan elkaar tot `"VeiligJe bent je loopbaan niet begonnen..."`, wat
nergens in het artikel staat en dus nergens geplaatst kan worden.

### 4.4 Tussenkoppen herkennen aan hun buren

Een tussenkop is echt vet, maar het is geen inline nadruk: hij ontleent zijn
gewicht aan wat hij ís. Markeer je hem inline, dan landt het vet op de eerste
alinea die toevallig hetzelfde woord bevat.

De eerste poging — *staat de run alleen op zijn regel?* — werkt niet. In drie
kolommen deelt élke tussenkop zijn baseline met broodtekst uit de kolom ernaast.

Wat wel werkt: **staat er iets direct náást**, binnen 1,2× de korpsgrootte
(`ABUTS`)? Een woordspatie is smaller, een kolomgoot breder. Een vette lead-in
waar de zin op doorloopt heeft een buurman; een tussenkop niet.

Voorwaarde erbij: de korpsgrootte of de familie moet afwijken van de broodtekst.
Anders wordt een hele vetgezette alinea — een interviewvraag — ook als kop
aangemerkt, want die heeft zijn regels net zo goed voor zichzelf.

### 4.5 Marges weglaten

Paginakoppen en folio's staan buiten het tekstkader en zijn vaak in hetzelfde vet
gezet als iets in de body. *Onze Taal* is zowel de naam in de hoek van elke pagina
als een woord in het artikel. Boven en onder 5,5% van de pagina wordt genegeerd.

### 4.6 Kapotte encodings

Een font met een eigen encoding en zonder ToUnicode-tabel geeft de glyph-codes
terug in plaats van de karakters. Uit Beijing Review:

```
",QVSLULQJ ,QYHVWRU &RQÀGHQFH"   =   "Inspiring Investor Confidence"
```

Elk teken 29 posities verschoven, met de woordspaties als stuurtekens. Onbruikbaar
— maar herkenbaar aan die stuurtekens, dus filterbaar.

### 4.7 De `before`-context is chirurgisch werk

Drie afzonderlijke fouten, alle drie stil:

**Volgorde.** Eerst het venster nemen, dán op een woordgrens knippen. Andersom zet
je opnieuw een half woord vooraan (`"erd door de lage landen"`, uit
"georganiseerd") en dan anchort het niets.

**Alleen knippen als het nodig is.** Trim je onvoorwaardelijk, dan gooi je bij een
context van één woord (`"In "`) alles weg.

**Een kop wist de context erna.** Wat na een tussenkop komt begint een nieuw blok.
Anders wordt een fragment verankerd aan een kop die in een ander blok staat en
raakt het onplaatsbaar.

**Een alineagrens wist de context níet.** De PDF weet niet waar run 1 een alinea
begint, dus `before` kan over twee alinea's lopen: `"het rapport. Hoe laat je"`,
waarvan "het rapport." de vorige alinea sluit. Vindt de plaatser de hele context
niet, dan probeert hij het laatste stuk ervan, woord voor woord korter (nooit
onder vier letters). Anders viel zo'n fragment terug op "waar het ook staat" en
belandde de cursief van "digitale policy entrepreneurs" op de eerdere
"Digitale policy entrepreneurs", die al cursief was.

**Eén plek, één markering, en context gaat voor.** De plaatser werkt in twee
rondes: eerst alle fragmenten die hun context terugvinden, daarna pas de terugval
voor de rest, en een plek die al bezet is telt niet meer mee. Anders pakt een
fragment dat in de intro staat (en dus nergens in de lopende tekst) de plek van
hetzelfde woord dat er wél met context bij hoort. Nagerekend op 172 opgeslagen
pagina's: dubbel geplaatste markeringen van 20 naar 7, en zes fragmenten die
eerder op de verkeerde plek of nergens landden, staan nu goed.

### 4.8 Woorden staan niet netjes in de PDF

Voor de opmaak maakt dit niet uit — daar tellen letters en worden spaties
genegeerd. Voor spelling (§6) wél:

- **Afbreekstrepen** staan vaak als **apart tekst-item** aan het eind van de regel
  (`vernieu` · `-` · `wing`), en er kan een spatie vóór komen te staan.
- **Accenten** kunnen losse glyphs zijn: `gáát` is `g` + `áá` + `t`, drie items.
  Plak je items met spaties, dan breek je het woord op.
- Over kolomgrenzen kan een samenstelling in helften terugkomen.

De les: een woordenlijst uit een PDF is lokaal onvolledig, en elke regel die erop
leunt moet daar immuun voor zijn.

## 5. Wanneer het niet geldt

Drie toestanden, en het verschil is essentieel:

| toestand | wat het betekent | wat er gebeurt |
|---|---|---|
| `read` | de tekstlaag is gelezen | de PDF beslist — **ook als het antwoord "geen opmaak" is** |
| `no-text-layer` | geen tekst, of onoplosbare fonts | vision-run |
| `unnamed-fonts` | fonts zonder herkenbaar snede-woord | vision-run, mét waarschuwing |

Die eerste rij is een fout die makkelijk te maken is. Sta de conditie op *"heeft de
PDF fragmenten opgeleverd"* in plaats van *"was de PDF leesbaar"*, dan krijgt elke
opmaakloze pagina alsnog een vision-run — die er dan markeringen bij kan verzinnen
waarvan het bestand bewijst dat ze er niet zijn.

`unnamed-fonts` bestaat omdat "de namen zeggen niks" niet te onderscheiden is van
"deze pagina heeft geen opmaak". Zonder dat onderscheid lees je geruisloos nul
opmaak van een pagina die er vol mee staat. In de geteste documenten is deze
toestand nog nooit voorgekomen; de waarschuwing staat klaar en zwijgt.

## 6. Tweede oogst: spelling

De tekstlaag is ook betrouwbaarder dan de OCR voor de **tekens zelf**. Het Friese
woord voor dominee is `dûmny` met een circumflex; Mistral las er een trema van en
maakte `dümny`.

[`lib/spelling.ts`](lib/spelling.ts) corrigeert dat vóór de woordindex wordt
gebouwd — de index is waar elke run op afgerekend wordt, dus die moet de juiste
spelling bevatten.

Eén woord wordt alleen vervangen bij **dezelfde letters én evenveel accenten**:

```
dümny  ->  dûmny    1 vs 1 accent  ->  SWAP         de OCR las een teken verkeerd
gáát   vs  gaat     2 vs 0         ->  laat staan   de PDF-lijst mist ze (§4.8)
een    vs  één      0 vs 2         ->  laat staan   ander woord
café   vs  cafe     1 vs 0         ->  laat staan
```

Die accenttelling is het hele punt. Gelijk aantal betekent dat één kant een teken
verkéérd las; ongelijk betekent dat één kant informatie kwíjt is. Alleen het
eerste is veilig. Zonder die regel had de eerste meting `gáát → gaat` voorgesteld
en daarmee een correcte Nederlandse nadruksspelling kapotgemaakt.

De eis van identieke letters maakt de regel bovendien immuun voor §4.8: een half
woord uit een kolomafbreking heeft geen tweeling met dezelfde letters, dus een
onvolledige lijst kan alleen een correctie *missen*, nooit er een verzinnen.

## 7. Gemeten

Vijf documenten, waarvan drie extern en niet zelf gekozen.

| document | pagina's | resultaat |
|---|---|---|
| Onze Taal — Lin An Phoa | 6 | 34 fragmenten, 33 geplaatst, 1 waarschuwing |
| Onze Taal — kerndoelen | 4 | 10 fragmenten, 8 geplaatst |
| Onze Taal — voorpublicatie | 2 | 31 fragmenten |
| Onze Taal — Friese aanspreekvormen | 2 | 23 fragmenten, 1 spellingcorrectie |
| Beijing Review | 5 | 4× `read`, 1× `no-text-layer` (advertentie) |
| Binnenlands Bestuur | 7 | 7× `read` |

De enige overgebleven waarschuwing bij Lin An Phoa is `Interview` — de chapeau,
die naar de frontmatter gaat en niet in de body hoort. Terecht dus.

Spelling: **1 correctie op 2305 unieke woorden**, de juiste.

Kosten: de opmaak-call per pagina is verdwenen. Zes pagina's gingen van USD 0,238
naar USD 0,187; vier pagina's draaien op 6 runs in plaats van 10.

## 8. Wat dit niet oplost

- **Scans en platgeslagen exports** hebben geen tekstlaag. Daar blijft de
  vision-run staan, met alle variantie van dien.
- **Nep-vet en nep-cursief** — waar een opmaker geen echte snede gebruikt maar de
  letters laat scheeftrekken of dubbel laat afdrukken — zit in de tekenoperatoren,
  niet in de fontnaam. Niet gezien in de geteste documenten.
- **Fonts zonder betekenisvolle naam.** Voor dat geval bestaat het idee om een
  model één keer per document de fonts te laten classificeren: negen tot veertien
  fonts per document, en één oordeel dekt élk vóórkomen. Niet gebouwd, omdat het in
  geen enkel getest document zou afgaan. De `unnamed-fonts`-melding is er om te
  zien wanneer dat verandert.
- **Inhoudsopgaven en colofons** leveren veel correcte fragmenten op die nergens in
  het artikel landen — een colofon zet `Editors:` en `Tel:` echt vet. Dat wordt
  ruis in de waarschuwingen, geen foute opmaak in de output.
