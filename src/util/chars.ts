/**
 * Small text helpers shared by the reader and the emitter.
 *
 * Invisible and direction-changing characters are written as numbers, never as characters: they must not appear in this
 * source (see test/unit/hygiene.test.ts).
 */

/** Code point ranges of characters that hide text or change its order: controls, zero-width and other invisible characters, bidirectional controls, byte order mark. */
const HIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], // C0 controls, DEL, C1 controls
  [0x200b, 0x200f], // zero-width characters and direction marks
  [0x2028, 0x2029], // line separator and paragraph separator: an editor shows them as a line break that the tools do not
  [0x202a, 0x202e], [0x2066, 0x2069], // bidirectional embeddings, overrides and isolates
  [0xfeff, 0xfeff], // byte order mark, zero-width no-break space
  // Characters that draw nothing, so that they can hide text in a name or spell one that looks like another:
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], // soft hyphen, combining grapheme joiner, Arabic letter mark
  [0x115f, 0x1160], [0x3164, 0x3164], [0xffa0, 0xffa0], // Hangul fillers
  [0x180e, 0x180e], [0x2060, 0x2064], [0x206a, 0x206f], // Mongolian vowel separator, word joiner and invisible operators, deprecated format characters
  [0xfff9, 0xfffb], // interlinear annotation marks
  [0xe0000, 0xe007f] // the tag characters: a whole message can be written in them and stay invisible
];

/** The characters Windows does not allow in a file name. */
const NAME_PUNCTUATION = '<>:"/\\|?*';

export function isHiddenChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code < 0x7f) return false; // printable ASCII, by far the usual case
  return HIDDEN_RANGES.some(([from, to]) => code >= from && code <= to);
}

/** Anything but printable ASCII: the only text that can hold a hidden character. */
const NOT_PRINTABLE_ASCII = /[^ -~]/;

/** A character a file or folder name made from data must not keep (spec 6.1). */
export const isUnsafeInName = (char: string): boolean => NAME_PUNCTUATION.includes(char) || isHiddenChar(char);

/** Text safe to show in a report: hidden and direction-changing characters become "?". */
export function printable(text: string): string {
  if (!NOT_PRINTABLE_ASCII.test(text)) return text;
  return Array.from(text, char => (isHiddenChar(char) ? '?' : char)).join('');
}

/** Every kind of line break: CR LF, CR, NEL and the separators of Unicode. */
const LINE_BREAKS = new RegExp(`\\r\\n?|[${String.fromCodePoint(0x85, 0x2028, 0x2029)}]`, 'g');

/**
 * Text that has lines (a body, a script, a description): the line breaks (every kind is one `\n`) and the tabs stay, and every other hidden or
 * direction-changing character becomes "?". `printable` is for one line: it would turn the line breaks into "?" as well.
 */
export function printableText(text: string): string {
  const lines = text.replace(LINE_BREAKS, '\n');
  if (!NOT_PRINTABLE_ASCII.test(lines)) return lines;
  return Array.from(lines, char => (char === '\n' || char === '\t' ? char : isHiddenChar(char) ? '?' : char)).join('');
}

/**
 * A name from the data as it may appear in a report: hidden characters made visible, cut to `max` characters, and a
 * placeholder when there is no name. Names are shown; values never are.
 */
export function displayLabel(name: unknown, max = 80): string {
  if (typeof name !== 'string') return '<unnamed>';
  // Only the start of a long name can be shown, so only the start is read (a name of a few megabytes is not walked character by character
  // for every request that sits below it). Four units per character wanted is more than enough, an astral character being two.
  const head = name.length > max * 4 ? name.slice(0, max * 4) : name;
  const text = printable(head).trim();
  if (text === '') return '<unnamed>';
  const points = Array.from(text);
  return points.length <= max && head === name ? text : `${points.slice(0, max - 3).join('')}...`;
}

/** Orders strings by code point, the same on every machine and locale (UTF-16 order would put astral characters before U+FFFF). */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}
