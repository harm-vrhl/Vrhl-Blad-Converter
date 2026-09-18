/**
 * Where the OCR read a letter wrong and the file knows better.
 *
 * The OCR reads the page from a picture of it, and a picture is where a
 * circumflex can look like a diaeresis: the Frisian for pastor is "dûmny" and
 * that is what the PDF says, while Mistral came back with "dümny". The file is
 * not guessing - it holds the character - so where the two disagree about a mark
 * and about nothing else, the file wins.
 *
 * That last clause carries all the weight. A word is only ever swapped for one
 * with THE SAME LETTERS and THE SAME NUMBER OF MARKS, so the swap can change
 * which accent a letter carries and nothing else. Two things follow, and both
 * matter:
 *
 * - "een" is never turned into "één", nor "cafe" into "café". Those differ in how
 *   many marks they carry, which means one side is missing information rather
 *   than misreading it, and in Dutch they are usually different words anyway.
 * - Reading words out of a PDF is not perfect - a compound broken over a column
 *   break can come back in halves - but a half word has no twin with the same
 *   letters, so a flawed word list cannot cause a swap. It can only fail to
 *   offer one.
 *
 * Everything here is deterministic and the words are never invented: a swap is
 * only ever between two spellings that both exist.
 */

const WORD = /[\p{L}\p{N}]+/gu;
const MARK = /\p{M}/u;
/** Below this a word is too small to be sure about. */
const MIN = 3;

export interface Swap {
  from: string;
  to: string;
  count: number;
}

export interface Spelling {
  text: string;
  swaps: Swap[];
}

/**
 * `text` as the OCR wrote it, with the accents the file disagreed about put
 * right. An empty word list, or one from a page with no text layer, changes
 * nothing.
 */
export function reconcile(text: string, words: readonly string[]): Spelling {
  if (!text || !words.length) return { text, swaps: [] };

  // Which spellings the file holds, indexed by the letters they are made of.
  const spelt = new Set<string>();
  const byLetters = new Map<string, Set<string>>();
  for (const word of words) {
    if (word.length < MIN) continue;
    spelt.add(word.toLowerCase());
    const key = bare(word);
    const forms = byLetters.get(key) ?? new Set<string>();
    forms.add(word);
    byLetters.set(key, forms);
  }

  const swaps = new Map<string, Swap>();
  const out = text.replace(WORD, (found) => {
    const better = correction(found, spelt, byLetters);
    if (!better) return found;
    const seen = swaps.get(found) ?? { from: found, to: better, count: 0 };
    seen.count++;
    swaps.set(found, seen);
    return better;
  });

  return { text: out, swaps: [...swaps.values()] };
}

function correction(word: string, spelt: Set<string>, byLetters: Map<string, Set<string>>): string | null {
  if (word.length < MIN) return null;
  // The file spells it that way too: nothing to settle.
  if (spelt.has(word.toLowerCase())) return null;
  if (!MARK.test(word.normalize('NFD'))) {
    // No mark of its own. It could still be the file that carries one, and that
    // is exactly the case this must not touch.
    return null;
  }

  const forms = byLetters.get(bare(word));
  if (!forms || forms.size !== 1) return null;

  const better = [...forms][0];
  if (better === word || marks(better) !== marks(word)) return null;
  // Whatever case the OCR used is the case the sentence needs.
  return matchCase(word, better);
}

/** The word with every mark taken off, which is what makes two spellings twins. */
function bare(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function marks(word: string): number {
  return [...word.normalize('NFD')].filter((ch) => MARK.test(ch)).length;
}

/** "Dûmny" where the sentence had "Dümny"; the file only settles the accents. */
function matchCase(had: string, better: string): string {
  const same = [...better];
  const original = [...had];
  if (original.length !== same.length) return better;

  return same
    .map((ch, i) => (original[i] === original[i].toUpperCase() && original[i] !== original[i].toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

/**
 * Losse letters die geen woord zijn.
 *
 * De woordindex komt uit de OCR, dus wat de OCR verkeerd leest wordt daarmee tot
 * waarheid verklaard - er is geen tweede bron die "dit woord bestaat niet" kan
 * zeggen. Voor één soort schade is dat wel te zien zonder woordenboek: een losse
 * letter midden in een zin. Een kop las "Mama, weet j mama" waar "je" stond, en
 * die achtergebleven "j" is geen Nederlands woord.
 *
 * Dit corrigeert niets. Wat er had moeten staan valt niet af te leiden, alleen
 * dát er iets mist - en juist bij koppen, die in displayletter over illustraties
 * staan, is dat het waard om te melden.
 */
const LOSSE_LETTER = /(?<![\p{L}\p{N}'’.-])(\p{Ll})(?![\p{L}\p{N}'’.-])/gu;
/** De enige Nederlandse woorden van één letter, plus de losse a van "a 4". */
const ECHT = new Set(['u', 'a']);

export function strayLetters(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LOSSE_LETTER)) {
    const letter = match[1];
    if (ECHT.has(letter)) continue;
    const at = match.index ?? 0;
    out.push(stukRond(text, at));
  }
  return out;
}

/**
 * Een stuk rond de letter, tot aan woordgrenzen. Anders begint de melding
 * midden in "mensen" en houdt hij op midden in "heen", en is hij in het
 * artikel niet meer als eigen woord te vinden.
 */
function stukRond(text: string, at: number, straal = 24): string {
  let begin = Math.max(0, at - straal);
  let einde = Math.min(text.length, at + straal + 1);
  while (begin > 0 && WOORDTEKEN.test(text[begin]!)) begin--;
  if (begin > 0 && !WOORDTEKEN.test(text[begin]!)) begin++;
  while (einde < text.length && WOORDTEKEN.test(text[einde - 1]!)) einde++;
  return text.slice(begin, einde).replace(/\s+/g, ' ').trim();
}

const WOORDTEKEN = /[\p{L}\p{N}'’.-]/u;
