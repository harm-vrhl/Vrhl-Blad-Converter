import { styleableTexts } from './patch';
import type { Block, StylePatch } from './types';
import type { StyleFragment } from './agents/styling';

/**
 * Putting a mark where it belongs.
 *
 * The styling run never sees the reading-order run's text, so it quotes the page instead: the words as
 * printed, and the words just before them. Neither side spells things quite the
 * same - the page breaks words over lines, the reading-order run mends them, and the two disagree
 * about hyphens and quotation marks - so they are matched on their bare letters
 * rather than character for character.
 *
 * What makes this more than a search is the position. A word can appear twice in
 * one block, and painting the first one is right about half the time; a sidebar
 * that opens on a bold "Kerndoelen" and mentions the kerndoelen again three
 * paragraphs down is the case that taught us so. The words BEFORE the fragment
 * pick out which occurrence was meant, and the patch carries that as `nth`.
 *
 * Twee regels die daaruit volgen. De woorden ervoor kunnen over een alineagrens
 * lopen ("het rapport." sluit de ene alinea, "Hoe laat je" opent de volgende), en
 * de leesvolgorde-run zet elke alinea in een eigen blok; dan telt het laatste stuk van die
 * woorden, dat wel in de alinea staat. En een plek die een eerder fragment al
 * heeft, is geen kandidaat meer: dezelfde woorden die twee keer cursief staan zijn
 * twee markeringen, niet één die twee keer op dezelfde plek wordt gezet.
 */

export interface Placed {
  patches: StylePatch[];
  /** Fragments that are nowhere in the reading-order run's page. Reported, never guessed at. */
  unplaced: StyleFragment[];
}

const LETTER = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/gu;
/** Below this a fragment is only placed where its context says it belongs. */
const ANYWHERE_MIN = 4;
/** Zo kort mag het laatste stuk van de woorden ervoor worden, en niet korter. */
const ANCHOR_MIN = 4;

export function placeFragments(blocks: Block[], fragments: StyleFragment[]): Placed {
  const patches: StylePatch[] = [];
  const unplaced: StyleFragment[] = [];
  /** Waar al een fragment ligt: blok en plek in de letterstroom. */
  const taken = new Set<string>();

  // A heading or a pull quote is set apart because of what it is, and the
  // applier refuses inline styling on those blocks anyway.
  const texts = fragments.filter((fragment) => fragment.kind === 'text');
  const hits = new Array<Hit | null>(texts.length).fill(null);

  // Eerst wat zijn context terugvindt, daarna pas de rest. Anders pakt een fragment
  // dat nergens past (het staat in de intro, niet in de lopende tekst) via "waar
  // het ook staat" de plek van het fragment dat er met zoveel woorden bij hoort.
  texts.forEach((fragment, i) => {
    const hit = anchored(blocks, fragment, taken);
    if (hit) {
      hits[i] = hit;
      taken.add(spot(hit.id, hit.at));
    }
  });
  texts.forEach((fragment, i) => {
    if (hits[i]) return;
    const hit = fallback(blocks, fragment, taken);
    if (hit) {
      hits[i] = hit;
      taken.add(spot(hit.id, hit.at));
    }
  });

  texts.forEach((fragment, i) => {
    const hit = hits[i];
    if (!hit) {
      unplaced.push(fragment);
      return;
    }
    patches.push({ op: 'style', target: hit.id, find: hit.find, nth: hit.nth, style: [...fragment.style] });
  });

  return { patches, unplaced };
}

interface Hit {
  id: string;
  find: string;
  /** Which occurrence of `find`, counted over the block's styleable text. */
  nth: number;
  /** Where the fragment starts in the block's stream of letters. */
  at: number;
}

const spot = (id: string, at: number) => `${id}:${at}`;

/**
 * Where this fragment sits in the reading-order run's page, quoted in the reading-order run's own spelling.
 *
 * A block is searched as one stream of letters over the strings that can carry a
 * mark, in printed order. A box's own title is not one of them: it is the first
 * thing a plain search hits and the last thing that can ever be painted.
 */
function anchored(blocks: Block[], fragment: StyleFragment, taken: Set<string>): Hit | null {
  const letters = flat(fragment.text);
  const before = flat(fragment.before);
  // One letter is not enough to find a place by, unless the words in front of it
  // say where it is - which is exactly the case for the italic "d" in "d's".
  if (letters.length < 2 && before.length < 6) return null;
  if (!letters.length) return null;

  // The words before it first, because they are what makes the place unique.
  //
  // No words before it is not nothing: the run was told to leave that empty only
  // when the fragment OPENS its paragraph, so a match at the head of a paragraph
  // is what it meant. Without that a box opening on a bold "Kerndoelen" loses its
  // mark to the same word halfway down the column before it, which is where the
  // reader will notice it and we will not.
  if (before) {
    const anchored = search(blocks, letters, before, false, 'exact', taken);
    if (anchored) return anchored;
    // De woorden ervoor kunnen in de alinea ervoor beginnen. Het laatste stuk
    // ervan staat dan wel in dezelfde alinea: probeer korter, woord voor woord.
    for (const tail of tails(fragment.before)) {
      const shorter = search(blocks, letters, tail, false, 'exact', taken);
      if (shorter) return shorter;
    }
  } else {
    const opening = search(blocks, letters, '', true, 'exact', taken);
    if (opening) return opening;
  }
  return null;
}

/** Wat overblijft als de context nergens past: een accent rechtgezet, of waar het staat. */
function fallback(blocks: Block[], fragment: StyleFragment, taken: Set<string>): Hit | null {
  const letters = flat(fragment.text);
  const before = flat(fragment.before);
  if (letters.length < 2 && before.length < 6) return null;
  if (!letters.length) return null;

  // Folding the accents away is a repair for one thing only: the OCR and the file
  // disagreeing about a diacritic. The proof that this is that case is that the
  // word, spelt as the file spells it, is nowhere on the page at all. Where it IS
  // there, the accents were never the problem - the anchor was - and folding would
  // only offer "een" for "één", which is a different word.
  const bare = folded(fragment.text);
  const bareBefore = folded(fragment.before);
  const speltThatWay = search(blocks, letters, '') !== null;

  if (!speltThatWay && (bare !== letters || bareBefore !== before)) {
    const repaired = onlyOne(blocks, bare, bareBefore, !before, taken) ?? onlyOne(blocks, bare, '', false, taken);
    if (repaired) return repaired;
  }

  // Then anywhere at all - but only for a fragment long enough that "anywhere"
  // means somewhere. A page holds a dozen standalone "in"s and picking the first
  // is a coin toss, so a short fragment whose context did not match is left
  // unplaced and said so, rather than set in bold in the wrong sentence.
  if (letters.length < ANYWHERE_MIN) return null;

  // Failing that, near enough: the reading-order run sometimes tidies what the page prints - it
  // wrote "The Pursuit of Happiness" where the film is spelt "Happyness" - and a
  // mark should not be lost over a letter.
  return search(blocks, letters, '', false, 'exact', taken) ?? nearly(blocks, letters, taken);
}

/**
 * De woorden ervoor steeds korter, van voren af: "het rapport. Hoe laat je" wordt
 * "rapport hoe laat je", "hoe laat je", "laat je". Nooit korter dan een paar
 * letters, want "je" staat overal.
 */
function tails(before: string): string[] {
  const words = before.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const tail = flat(words.slice(i).join(' '));
    if (tail.length < ANCHOR_MIN) break;
    out.push(tail);
  }
  return out;
}

function search(
  blocks: Block[],
  letters: string,
  before: string,
  opensParagraph = false,
  accents: 'exact' | 'folded' = 'exact',
  taken: Set<string> = new Set()
): Hit | null {
  if (!before && letters.length < 2) return null;
  const needle = before + letters;

  for (const block of blocks) {
    const texts = styleableTexts(block);
    const stream = flatten(texts);

    for (const found of hits(stream, needle, accents)) {
      // The match covers the leading context too; the fragment starts after it.
      const at = found + before.length;
      if (taken.has(spot(block.id, at))) continue;
      // Not merely the first letter of a word - the first letter of the string.
      if (opensParagraph && (at > 0 ? stream.text[at] === stream.text[at - 1] : false)) continue;
      const find = quote(texts, stream, at, letters.length);
      if (!find?.trim()) continue;
      return { id: block.id, find, nth: countBefore(texts, find, stream, at), at };
    }
  }
  return null;
}

/** Longer fragments may be matched approximately; short ones never. */
const FUZZY_MIN = 8;
const FUZZY_SHARE = 0.12;

/**
 * The closest thing to this fragment in the reading-order run's text, when nothing matches it
 * exactly. Anchored on the first letters so the whole page is not scanned
 * character by character, and held to a handful of edits so "Happyness" can find
 * "Happiness" without "kerndoelen" finding "eindtermen".
 */
function nearly(blocks: Block[], letters: string, taken: Set<string>): Hit | null {
  if (letters.length < FUZZY_MIN) return null;
  const budget = Math.max(1, Math.round(letters.length * FUZZY_SHARE));
  const anchor = letters.slice(0, 5);

  let best: Hit | null = null;
  let fewest = budget + 1;

  for (const block of blocks) {
    const texts = styleableTexts(block);
    const stream = flatten(texts);
    for (let at = stream.letters.indexOf(anchor); at >= 0; at = stream.letters.indexOf(anchor, at + 1)) {
      // The tidied word may be a letter shorter or longer than the printed one.
      for (let span = letters.length - budget; span <= letters.length + budget; span++) {
        const end = at + span;
        if (span < FUZZY_MIN || end > stream.letters.length) continue;
        if (stream.text[at] !== stream.text[end - 1]) continue;
        if (taken.has(spot(block.id, at))) continue;
        // A near match is still a match on whole words. Without this "Rijker vak"
        // finds "rijker mak" inside "rijker maken", one edit away and half a word.
        if (!onWords(stream, at, end)) continue;
        const edits = distance(stream.letters.slice(at, end), letters, fewest - 1);
        if (edits >= fewest) continue;
        const find = quote(texts, stream, at, span);
        if (!find?.trim()) continue;
        fewest = edits;
        best = { id: block.id, find, nth: countBefore(texts, find, stream, at), at };
      }
    }
  }
  return best;
}

/** Levenshtein, abandoned as soon as it passes `cap`. */
function distance(a: string, b: string, cap: number): number {
  if (cap < 0) return cap + 1;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;

  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + cost);
      least = Math.min(least, next[j]);
    }
    if (least > cap) return cap + 1;
    row = next;
  }
  return row[b.length];
}

/**
 * The one place these letters occur once their accents are off - and nothing at
 * all if there is more than one.
 *
 * Folding is a repair, not a search: it exists because the OCR and the file
 * disagreed about a diacritic, and a repair may only be applied where there is
 * one thing to repair. Dutch has "een" beside "één" and "voor" beside "vóór";
 * where both are on the page, the accents were the only thing telling them apart
 * and guessing between them is worse than leaving the mark off.
 */
function onlyOne(
  blocks: Block[],
  letters: string,
  before: string,
  opensParagraph: boolean,
  taken: Set<string>
): Hit | null {
  if (!before && letters.length < 2) return null;
  const needle = before + letters;
  let only: Hit | null = null;

  for (const block of blocks) {
    const texts = styleableTexts(block);
    const stream = flatten(texts);

    for (const found of hits(stream, needle, 'folded')) {
      const at = found + before.length;
      if (taken.has(spot(block.id, at))) continue;
      if (opensParagraph && at > 0 && stream.text[at] === stream.text[at - 1]) continue;
      const find = quote(texts, stream, at, letters.length);
      if (!find?.trim()) continue;
      if (only) return null; // two candidates is no candidate
      only = { id: block.id, find, nth: countBefore(texts, find, stream, at), at };
    }
  }
  return only;
}

/** Every place `needle` occurs in the stream, beginning and ending on a word. */
function hits(stream: Stream, needle: string, accents: 'exact' | 'folded' = 'exact'): number[] {
  if (!needle) return [];
  const hay = accents === 'folded' ? stream.folded : stream.letters;
  const out: number[] = [];
  for (let from = 0; ; ) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return out;
    const end = at + needle.length;
    // A match may not straddle two strings: those are two places, not one.
    if (onWords(stream, at, end) && stream.text[at] === stream.text[end - 1]) out.push(at);
    from = at + 1;
  }
}

/** Does the span from `at` to `end` begin and end where a word does? */
function onWords(stream: Stream, at: number, end: number): boolean {
  const opens = at === 0 || stream.text[at] !== stream.text[at - 1] || stream.at[at] - stream.at[at - 1] > 1;
  const closes =
    end === stream.letters.length ||
    stream.text[end] !== stream.text[end - 1] ||
    stream.at[end] - stream.at[end - 1] > 1;
  return opens && closes;
}

/** The fragment as the reading-order run spells it, cut out of the string it was found in. */
function quote(texts: string[], stream: Stream, at: number, length: number): string | null {
  const which = stream.text[at];
  const text = texts[which];
  if (text === undefined || stream.text[at + length - 1] !== which) return null;
  return text.slice(stream.at[at], stream.at[at + length - 1] + 1);
}

/** How many times this exact fragment occurs before this one, in printed order. */
function countBefore(texts: string[], find: string, stream: Stream, at: number): number {
  const which = stream.text[at];
  const from = stream.at[at];
  let seen = 0;
  for (let i = 0; i < which; i++) seen += occurrences(texts[i], find);
  for (let k = texts[which].indexOf(find); k >= 0 && k < from; k = texts[which].indexOf(find, k + 1)) seen++;
  return seen;
}

function occurrences(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) n++;
  return n;
}

interface Stream {
  /** Letters and digits only, lowercased, run together over all the strings. */
  letters: string;
  /**
   * The same letters with their accents taken off, one for one.
   *
   * The PDF and the OCR do not always agree about a diacritic. The Frisian for
   * pastor is "dûmny" and that is what the file says; the OCR read the circumflex
   * as a diaeresis and the reading-order run wrote "dümny". One character apart is no match at
   * all, and a five-letter word is too short for the tolerant pass. Stripped of
   * accents both are "dumny", so the mark survives an OCR that slipped.
   *
   * Only ever a second attempt: "één" and "een" are different words, and the
   * exact letters are tried first so that a page holding both is not confused.
   */
  folded: string;
  /** Where each letter sat in the string it came from. */
  at: number[];
  /** Which of the block's strings that was. */
  text: number[];
}

/** The block's styleable strings as one stream, in printed order. */
function flatten(texts: string[]): Stream {
  const out: Stream = { letters: '', folded: '', at: [], text: [] };
  texts.forEach((text, index) => {
    for (let i = 0; i < text.length; i++) {
      if (!LETTER.test(text[i])) continue;
      // A lowercase mapping that grows ("İ") would slide every index after it.
      const lower = text[i].toLowerCase();
      const letter = lower.length === 1 ? lower : text[i];
      out.letters += letter;
      out.folded += fold(letter);
      out.at.push(i);
      out.text.push(index);
    }
  });
  return out;
}

/** One letter without its accent, or the letter itself where that is not one. */
function fold(letter: string): string {
  const bare = letter.normalize('NFD').replace(MARK, '');
  return bare.length === 1 ? bare : letter;
}

/** The bare letters of a fragment with their accents taken off. */
export function folded(text: string): string {
  let out = '';
  for (const ch of flat(text)) out += fold(ch);
  return out;
}

/** The bare letters of a fragment, the way the stream holds them. */
export function flat(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}
