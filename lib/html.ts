import { datumWeergave, type Asset, type Blok, type LijstItem, type Pakket, type Tekst, type Titel } from './canonical';
import { altTekst, bijschrift, creditRegel, delen, eersteArtikel, kaal, veiligeLink, type Deel } from './pakketlezen';

/**
 * Het artikel als één HTML-bestand, geschreven vanuit het pakket.
 *
 * Een consument zoals MDX en Word: dit bestand kent `ArticleDocument` niet, alleen
 * het pakket. Het levert een compleet document dat in elke browser opengaat, met
 * een eigen stijlblad erin, zodat het er zonder de app ook als artikel uitziet.
 *
 * Waar een beeld vandaan komt, beslist de aanroeper met `bron`: de browser geeft
 * het beeld als data-URL mee, zodat het bestand op zichzelf staat; `npm run
 * golden` geeft het pad in het pakket, zodat de uitvoer herhaalbaar is en klein
 * blijft. Geeft `bron` niets, dan wordt het beeld overgeslagen in plaats van een
 * kapotte afbeelding te tonen.
 */

export type BeeldBron = (asset: Asset) => string | null;

export function toHtml(pakket: Pakket, bron: BeeldBron): string {
  const gelezen = eersteArtikel(pakket);
  if (!gelezen) return '';
  const { artikel, assets } = gelezen;
  const blok = (b: Blok) => block(b, assets, bron, 2);

  const kop = [
    artikel.rubriek ? `<p class="rubriek">${titel(artikel.rubriek)}</p>` : '',
    `<h1>${titel(artikel.titel)}</h1>`,
    artikel.ondertitel ? `<p class="ondertitel">${titel(artikel.ondertitel)}</p>` : '',
    meta(creditRegel(artikel), datumWeergave(artikel.datum))
  ].filter(Boolean);

  const header = artikel.header?.asset ? assets.get(artikel.header.asset) : undefined;
  const headerSrc = header ? bron(header) : null;
  const headerBeeld =
    header && headerSrc
      ? `<figure class="header"><img src="${attr(headerSrc)}" alt="${attr(artikel.header?.alt ?? header.alt ?? '')}"${maat(header)}></figure>`
      : '';

  const intro = (artikel.intro ?? []).map(blok).filter(Boolean);
  const body = (artikel.body ?? []).map(blok).filter(Boolean);

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(kaal(artikel.titel) || 'Artikel')}</title>
<style>${STIJL}</style>
</head>
<body>
<article>
<header>
${kop.join('\n')}
</header>
${headerBeeld}
${intro.length ? `<div class="intro">\n${intro.join('\n')}\n</div>` : ''}
${body.join('\n')}
</article>
</body>
</html>
`.replace(/\n{2,}/g, '\n');
}

function meta(credits: string | null, datum: string | null): string {
  const regel = [credits, datum].filter(Boolean).map((deel) => escape(deel as string));
  return regel.length ? `<p class="meta">${regel.join(' · ')}</p>` : '';
}

// ─── Blokken ────────────────────────────────────────────────────────────────

function block(blok: Blok, assets: Map<string, Asset>, bron: BeeldBron, kopNiveau: number): string {
  switch (blok.soort) {
    case 'alinea':
      return `<p>${inline(blok.inhoud)}</p>`;
    case 'kop':
      return `<h${kopNiveau}>${inline(blok.inhoud)}</h${kopNiveau}>`;
    case 'quote':
      return `<blockquote><p>${inline(blok.inhoud)}</p></blockquote>`;
    case 'lijst': {
      const tag = blok.stijl === 'nummering' ? 'ol' : 'ul';
      return `<${tag}>${blok.items.map((item) => listItem(item, tag)).join('')}</${tag}>`;
    }
    case 'afbeelding': {
      const item = assets.get(blok.asset);
      const src = item ? bron(item) : null;
      if (!item || !src) return '';
      const onder = bijschrift(blok, item);
      return (
        `<figure class="${attr(blok.grootte ?? 'normaal')}"><img src="${attr(src)}" alt="${attr(altTekst(blok, item))}"${maat(item)}>` +
        `${onder ? `<figcaption>${escape(onder)}</figcaption>` : ''}</figure>`
      );
    }
    case 'video': {
      // De converter levert geen video; een ander pakket kan dat wel.
      const href = veiligeLink(blok.url);
      const label = escape(blok.onderschrift ?? blok.url);
      return `<p class="video">${href ? `<a href="${attr(href)}">${label}</a>` : label}</p>`;
    }
    case 'tekstkader': {
      const kleur = [
        blok.achtergrondKleur ? `background:${css(blok.achtergrondKleur)}` : '',
        blok.tekstKleur ? `color:${css(blok.tekstKleur)}` : ''
      ].filter(Boolean);
      const binnen = blok.inhoud.map((kind) => block(kind, assets, bron, kopNiveau + 1)).filter(Boolean);
      return `<aside class="kader"${kleur.length ? ` style="${kleur.join(';')}"` : ''}>\n${binnen.join('\n')}\n</aside>`;
    }
  }
}

function listItem(item: LijstItem, tag: 'ol' | 'ul'): string {
  const genest = item.items?.length ? `<${tag}>${item.items.map((kind) => listItem(kind, tag)).join('')}</${tag}>` : '';
  return `<li>${inline(item.inhoud)}${genest}</li>`;
}

// ─── Inline ─────────────────────────────────────────────────────────────────

function inline(waarde: Tekst): string {
  return delen(waarde).map(deel).join('');
}

function titel(waarde: Titel | undefined): string {
  return delen(waarde).map(deel).join('');
}

/** Opmaak om de tekst heen, en de spaties erbuiten, zodat "<em>woord </em>" niet ontstaat. */
function deel({ tekst, stijlen, link }: Deel): string {
  const kern = tekst.trim();
  if (!kern) return escape(tekst);
  const voor = tekst.slice(0, tekst.indexOf(kern));
  const na = tekst.slice(tekst.indexOf(kern) + kern.length);
  let uit = escape(kern);
  if (stijlen.includes('klein')) uit = `<small>${uit}</small>`;
  if (stijlen.includes('onderstreept')) uit = `<u>${uit}</u>`;
  if (stijlen.includes('cursief')) uit = `<em>${uit}</em>`;
  if (stijlen.includes('vet')) uit = `<strong>${uit}</strong>`;
  if (link) uit = `<a href="${attr(link)}">${uit}</a>`;
  return `${escape(voor)}${uit}${escape(na)}`;
}

// ─── Tekens ─────────────────────────────────────────────────────────────────

function escape(tekst: string): string {
  return tekst.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(tekst: string): string {
  return escape(tekst.replace(/\s*\n\s*/g, ' ')).replace(/"/g, '&quot;');
}

/** Alleen een kleur zoals het pakket hem schrijft; niets wat uit de stijl kan breken. */
function css(kleur: string): string {
  return /^#[0-9a-f]{3,8}$/i.test(kleur.trim()) ? kleur.trim() : 'inherit';
}

/** Breedte en hoogte erbij, zodat de pagina niet verspringt als het beeld laadt. */
function maat(item: Asset): string {
  return item.breedte && item.hoogte ? ` width="${item.breedte}" height="${item.hoogte}"` : '';
}

const STIJL = `
:root{color-scheme:light;--tekst:#1c1b1a;--zacht:#6b6760;--lijn:#e4e0da;--kader:#ebe8e4}
*{box-sizing:border-box}
body{margin:0;background:#fbfaf8;color:var(--tekst);font:18px/1.6 Georgia,"Times New Roman",serif}
article{max-width:40rem;margin:0 auto;padding:3rem 1.25rem 5rem}
header{margin-bottom:2rem}
.rubriek{margin:0 0 .5rem;font:600 .8rem/1.2 -apple-system,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--zacht)}
h1{margin:0;font-size:2.4rem;line-height:1.15;font-weight:700}
.ondertitel{margin:.75rem 0 0;font-size:1.25rem;line-height:1.4;color:var(--zacht)}
.meta{margin:1rem 0 0;font:.85rem/1.4 -apple-system,system-ui,sans-serif;color:var(--zacht)}
.intro{font-size:1.15rem;font-weight:600;margin-bottom:2rem}
h2{font-size:1.3rem;margin:2.2rem 0 .5rem}
h3,h4{font-size:1.1rem;margin:1.6rem 0 .4rem}
p{margin:0 0 1rem}
a{color:inherit}
blockquote{margin:2rem 0;padding:0 0 0 1.25rem;border-left:3px solid var(--tekst);font-size:1.35rem;line-height:1.4;font-style:italic}
blockquote p{margin:0}
figure{margin:2rem 0}
figure.klein{max-width:50%}
figure.groot,figure.extraGroot,figure.header{margin-left:-1.25rem;margin-right:-1.25rem}
img{display:block;width:100%;height:auto}
figcaption{margin-top:.5rem;font:.8rem/1.4 -apple-system,system-ui,sans-serif;color:var(--zacht)}
.kader{margin:2rem 0;padding:1.25rem 1.5rem;background:var(--kader);border-radius:4px}
.kader>:first-child{margin-top:0}
.kader>:last-child{margin-bottom:0}
ul,ol{margin:0 0 1rem;padding-left:1.4rem}
li{margin:.2rem 0}
@media print{body{background:none}article{padding:0}}
`.trim();
