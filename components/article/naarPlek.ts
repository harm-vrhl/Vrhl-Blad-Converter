"use client";

import { occurrence } from "@/lib/spans";
import { plekken, schoon, vouw } from "@/components/article/zoek";

const VELDEN = "h1, h2, h3, h4, p, li, blockquote, figcaption, .pill";

/**
 * Naar een stuk tekst in de Artikel-tab springen, het selecteren, en het even
 * laten oplichten.
 *
 * Gezocht wordt op tekst en niet op een blok-id. De blokken in de Artikel-tab
 * hebben geen vast id, ze verschuiven als de redacteur sleept, en een melding kan
 * ook over de kop gaan of over iets in een kader. Tekst is wat een melding en het
 * scherm delen.
 *
 * Een melding geeft een stuk tekst mee, niet een blok-id. Dat stuk mag midden
 * in een woord beginnen: een losse "o" levert "sen kan ik soms denken: o shit,
 * waar gaat dit hee" op, afgeknipt uit "mensen" en "heen". Zoeken als eigen
 * woord vindt dat niet, terwijl de zin er gewoon staat. De sprong zoekt het
 * stuk daarom als substring. Alleen een los woord (de chips) en een opmaak-
 * fragment tellen als eigen woord.
 *
 * Direct na het wisselen van tab staat het artikel er nog niet; daarom wordt er
 * een seconde lang opnieuw gekeken. Lukt het niet, dan is de tekst waarschijnlijk
 * al aangepast, en zegt de aanroeper dat.
 */
export function naarPlek(zoek: string, markeer?: string, nth = 0): Promise<boolean> {
  const pin = schoon(zoek);
  const fragment = schoon(markeer || zoek);
  return wachtOp(() => {
    const root = document.querySelector(".reader");
    if (!root) return false;
    // Een los woord (de chips bij de telling) is geen veldtekst. Eerst het
    // woord in leesvolgorde zoeken, anders wint een alinea met "gemeenten"
    // het van "per gemeente" verderop, of de sprong mislukt helemaal.
    const los = pin === fragment && !/\s/.test(fragment);
    const gevonden = los
      ? (vindWoord(root, fragment, nth) ?? vindPlek(root, pin, fragment, nth))
      : (vindPlek(root, pin, fragment, nth) ?? vindWoord(root, fragment, nth));
    if (!gevonden) return false;
    toonPlek(gevonden.element, gevonden.range);
    return true;
  });
}

/**
 * De n-de treffer van een zoekopdracht, in leesvolgorde over het hele artikel.
 * Telt substrings, geen woordgrenzen, zoals ⌘F.
 *
 * Geen selectie en geen focus: een range in een contenteditable pakt de caret
 * van de zoekbalk. Het woord zelf wordt geverfd (CSS Custom Highlight), niet het blok.
 */
export function naarZoek(query: string, index: number, flits = true): Promise<boolean> {
  const needle = query.trim();
  if (!needle) {
    wisZoek();
    return Promise.resolve(false);
  }
  if (index < 0) return Promise.resolve(false);
  return wachtOp(() => {
    const root = document.querySelector(".reader");
    if (!root) return false;
    const alle = treffersIn(root, needle);
    const gevonden = alle[index];
    if (!gevonden) return false;
    const terug = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    verfTreffers(
      alle.map((t) => t.range),
      index
    );
    scrollNaar(gevonden.range, flits);
    if (terug && terug !== document.activeElement) terug.focus({ preventScroll: true });
    return true;
  });
}

const ZOEK = "zoek";
const ZOEK_HUIDIG = "zoek-huidig";

function kanHighlight(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

function verfTreffers(alle: Range[], index: number) {
  wisZoek();
  if (!alle.length) return;
  if (kanHighlight()) {
    const rest = alle.filter((_, i) => i !== index);
    if (rest.length) CSS.highlights.set(ZOEK, new Highlight(...rest));
    const huidig = alle[index];
    if (huidig) CSS.highlights.set(ZOEK_HUIDIG, new Highlight(huidig));
    return;
  }
  overlayRanges = alle;
  overlayIndex = index;
  tekenOverlay();
  koppelOverlay();
}

function wisZoek() {
  if (kanHighlight()) {
    CSS.highlights.delete(ZOEK);
    CSS.highlights.delete(ZOEK_HUIDIG);
  }
  overlayRanges = [];
  overlayIndex = 0;
  document.getElementById("zoek-overlays")?.replaceChildren();
}

let overlayRanges: Range[] = [];
let overlayIndex = 0;
let overlayLuistert = false;

function overlayLaag(): HTMLElement {
  let laag = document.getElementById("zoek-overlays");
  if (!laag) {
    laag = document.createElement("div");
    laag.id = "zoek-overlays";
    laag.setAttribute("aria-hidden", "true");
    document.body.appendChild(laag);
  }
  return laag;
}

function tekenOverlay() {
  const laag = overlayLaag();
  laag.replaceChildren();
  overlayRanges.forEach((range, i) => {
    for (const rect of range.getClientRects()) {
      const stuk = document.createElement("div");
      stuk.className = i === overlayIndex ? "zoek-overlay zoek-overlay-huidig" : "zoek-overlay";
      stuk.style.top = `${rect.top}px`;
      stuk.style.left = `${rect.left}px`;
      stuk.style.width = `${rect.width}px`;
      stuk.style.height = `${rect.height}px`;
      laag.appendChild(stuk);
    }
  });
}

function koppelOverlay() {
  if (overlayLuistert) return;
  overlayLuistert = true;
  window.addEventListener("scroll", tekenOverlay, true);
  window.addEventListener("resize", tekenOverlay);
}

function scrollNaar(range: Range, centreren: boolean) {
  const rect = range.getBoundingClientRect();
  let el: HTMLElement | null =
    range.commonAncestorContainer instanceof HTMLElement
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  while (el) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      const kader = el.getBoundingClientRect();
      const inBeeld = rect.top >= kader.top + 24 && rect.bottom <= kader.bottom - 24;
      if (inBeeld && !centreren) return;
      const doel = centreren ? kader.top + kader.height / 2 : rect.top < kader.top + 24 ? kader.top + 64 : kader.bottom - 64;
      el.scrollBy({ top: rect.top + rect.height / 2 - doel, behavior: "smooth" });
      return;
    }
    el = el.parentElement;
  }
}

function wachtOp(poging: () => boolean): Promise<boolean> {
  return new Promise((klaar) => {
    let n = 0;
    const kijk = () => {
      if (poging()) {
        klaar(true);
        return;
      }
      if (++n < 20) window.setTimeout(kijk, 50);
      else klaar(false);
    };
    requestAnimationFrame(kijk);
  });
}

function toonPlek(element: HTMLElement, range: Range) {
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  if (element.isContentEditable) element.focus({ preventScroll: true });
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  element.classList.remove("controle-flits");
  void element.offsetWidth;
  element.classList.add("controle-flits");
  window.setTimeout(() => element.classList.remove("controle-flits"), 2600);
}

function veldenVan(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(VELDEN)];
}

function treffersIn(root: Element, needle: string): Array<{ element: HTMLElement; range: Range }> {
  const out: Array<{ element: HTMLElement; range: Range }> = [];
  for (const element of veldenVan(root)) {
    const hay = element.textContent ?? "";
    for (const at of plekken(hay, needle)) {
      const range = bereikVan(element, at, needle.length);
      if (range) out.push({ element, range });
    }
  }
  return out;
}

const WOORDTEKEN = /[\p{L}\p{N}]/u;

/**
 * Het woord in leesvolgorde, als eigen woord. "gemeente" in "per gemeente"
 * telt; het begin van "gemeenten" niet.
 */
function vindWoord(
  root: Element,
  woord: string,
  nth: number
): { element: HTMLElement; range: Range } | null {
  const needle = woord.trim();
  if (!needle) return null;
  const hits: Array<{ element: HTMLElement; range: Range }> = [];
  for (const element of veldenVan(root)) {
    const hay = element.textContent ?? "";
    for (const at of plekken(hay, needle)) {
      if (!eigenWoord(hay, at, needle.length)) continue;
      const range = bereikVan(element, at, needle.length);
      if (range) hits.push({ element, range });
    }
  }
  return hits[nth] ?? hits[0] ?? null;
}

function eigenWoord(hay: string, at: number, lengte: number): boolean {
  const einde = at + lengte;
  if (at > 0 && WOORDTEKEN.test(hay[at - 1]!)) return false;
  if (einde < hay.length && WOORDTEKEN.test(hay[einde]!)) return false;
  return true;
}

function vindPlek(
  root: Element,
  pin: string,
  fragment: string,
  nth: number
): { element: HTMLElement; range: Range } | null {
  const kandidaten = veldenVan(root);
  const schoonHay = (el: HTMLElement) => schoon(el.textContent ?? "");
  const exact = kandidaten.filter((el) => schoonHay(el) === pin);
  const via = exact.length ? exact : kandidaten.filter((el) => indexIn(schoonHay(el), pin) >= 0);
  via.sort((a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0));

  for (const element of via) {
    const range = selecteer(element, pin, fragment, nth);
    if (range) return { element, range };
  }
  return null;
}

function selecteer(element: HTMLElement, pin: string, fragment: string, nth: number): Range | null {
  const hay = element.textContent ?? "";
  if (pin && pin !== fragment) {
    if (schoon(hay) === pin) {
      return bereikIn(element, hay, fragment, nth);
    }
    const pinAt = indexIn(hay, pin);
    if (pinAt < 0) return null;
    const rel = woordOfStuk(pin, fragment, nth);
    return rel >= 0 ? bereikVan(element, pinAt + rel, fragment.length) : null;
  }
  return bereikIn(element, hay, fragment, nth);
}

/** Opmaak: eigen woord. Anders het stuk zoals het in de melding staat. */
function bereikIn(element: HTMLElement, hay: string, fragment: string, nth: number): Range | null {
  const at = woordOfStuk(hay, fragment, nth);
  return at >= 0 ? bereikVan(element, at, fragment.length) : null;
}

function woordOfStuk(hay: string, needle: string, nth: number): number {
  const alsWoord = occurrence(hay, needle, nth);
  if (alsWoord >= 0) return alsWoord;
  return plekken(hay, needle)[nth] ?? plekken(hay, needle)[0] ?? -1;
}

function bereikVan(root: Node, start: number, length: number): Range | null {
  if (length <= 0 || start < 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  let left = length;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    if (!startNode) {
      if (start >= seen + len) {
        seen += len;
        continue;
      }
      startNode = node;
      startOff = start - seen;
      const take = Math.min(len - startOff, left);
      left -= take;
      if (left === 0) {
        endNode = node;
        endOff = startOff + take;
        break;
      }
      seen += len;
      continue;
    }
    const take = Math.min(len, left);
    left -= take;
    if (left === 0) {
      endNode = node;
      endOff = take;
      break;
    }
    seen += len;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOff);
  range.setEnd(endNode, endOff);
  return range;
}

function indexIn(hay: string, needle: string): number {
  const n = vouw(needle);
  if (!n) return -1;
  return vouw(hay).indexOf(n);
}
