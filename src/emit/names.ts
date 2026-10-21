import { LIMITS } from '../reader/limits';
import { isUnsafeInName } from '../util/chars';

/**
 * Names for the files and folders the emitter writes (spec 6.1). A name from the data becomes a "slug" that is valid on
 * Windows, macOS and Linux, can never leave its folder, and is the same on every run.
 *
 * Refinements found while implementing the spec: Windows treats a file as reserved by the part before the FIRST dot
 * (`aux.txt` is as reserved as `aux`), so the underscore goes right after that part; and characters that reorder or hide
 * text (bidirectional controls, zero-width characters) are replaced like the other unsafe ones.
 *
 * Invisible and direction-changing characters are written here as numbers, never as characters: they must not appear
 * in this source.
 */
export interface Slug {
  slug: string;
  /** The slug differs from the original name (TC-NAME-SANITIZED). */
  changed: boolean;
}

export interface UniqueSlug extends Slug {
  name: string;
  /** A suffix was added because the slug was already taken, ignoring letter case (TC-NAME-COLLISION). */
  collided: boolean;
}

const SUPERSCRIPT_DIGITS = String.fromCodePoint(0xb9, 0xb2, 0xb3);
const RESERVED = new RegExp(`^(?:con|prn|aux|nul|conin\\$|conout\\$|com[1-9${SUPERSCRIPT_DIGITS}]|lpt[1-9${SUPERSCRIPT_DIGITS}])$`, 'i');
const WHITESPACE = /\s/;

/** Takes dots and white space off both ends. A regular expression for this (`[.\s]+$`) is quadratic on a long run of spaces, so the ends are walked by hand. */
function stripEdges(text: string): string {
  const isEdge = (char: string): boolean => char === '.' || WHITESPACE.test(char);
  let start = 0;
  let end = text.length;
  while (start < end && isEdge(text.charAt(start))) start++;
  while (end > start && isEdge(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/** Takes the character `edge` off both ends, by hand for the same reason as above. */
function stripChar(text: string, edge: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charAt(start) === edge) start++;
  while (end > start && text.charAt(end - 1) === edge) end--;
  return text.slice(start, end);
}

const codePoints = (text: string): string[] => Array.from(text);
const cut = (text: string, max: number): string => codePoints(text).slice(0, Math.max(0, max)).join('');

export function slugify(name: string, max: number = LIMITS.maxSlugChars): Slug {
  let slug = stripEdges(codePoints(name.normalize('NFC')).map(char => (isUnsafeInName(char) ? '-' : char)).join('')
    .replace(/\.{2,}/g, '-').replace(/-{2,}/g, '-'));
  const dot = slug.indexOf('.');
  const base = dot === -1 ? slug : slug.slice(0, dot);
  if (RESERVED.test(base)) slug = `${base}_${slug.slice(base.length)}`;
  // A leading hyphen would make the name look like an option to a shell (`rm -x`), and "../x" is more useful as "x" than as "-x".
  slug = stripEdges(cut(slug, max)).replace(/^-+/, '');
  // Empty, or nothing left but the hyphens that cleaning put in place of unsafe characters ("..", "/", "---").
  if (/^-*$/.test(slug)) slug = 'unnamed';
  return { slug, changed: slug !== name };
}

/** Names that are unique as they are, exactly (not ignoring case): a repeat gets `-2`, `-3`... Used for keys of a JSON object. */
export function uniqueNames(names: readonly string[]): { name: string; collided: boolean }[] {
  const used = new Set<string>();
  // The next suffix to try for each base name: the ones before it are taken, so a thousand repeats do not each count up from 2 again.
  const next = new Map<string, number>();
  return names.map(original => {
    const base = original === '' ? 'Environment' : original;
    let name = base;
    let collided = false;
    let n = next.get(base) ?? 2;
    for (; used.has(name); n++) { collided = true; name = `${base}-${n}`; }
    if (collided) next.set(base, n);
    used.add(name);
    return { name, collided };
  });
}

/**
 * Slugs for a list of names, in the order given (the caller sorts them by N5 first). A repeat, ignoring letter case, gets
 * `-2`, `-3`... and the suffix fits inside the limit.
 */
export function uniqueSlugs(
  names: readonly string[],
  max: number = LIMITS.maxSlugChars,
  reserved: readonly string[] = [],
  /** Every name in the folder that a slug takes up (a folder takes up `x` and `x.http`); defaults to the slug alone. */
  occupies: (slug: string) => readonly string[] = slug => [slug]
): UniqueSlug[] {
  const used = new Set<string>(reserved.map(name => name.toLowerCase()));
  const taken = (slug: string): boolean => occupies(slug).some(entry => used.has(entry.toLowerCase()));
  // The next suffix to try for each slug: the ones before it are taken, so a thousand repeats do not each count up from 2 again.
  const next = new Map<string, number>();
  return names.map(name => {
    const { slug } = slugify(name, max);
    let candidate = slug;
    let collided = false;
    const key = slug.toLowerCase();
    let n = next.get(key) ?? 2;
    for (; taken(candidate); n++) {
      collided = true;
      const suffix = `-${n}`;
      candidate = stripEdges(cut(slug, max - suffix.length)) + suffix;
    }
    if (collided) next.set(key, n);
    for (const entry of occupies(candidate)) used.add(entry.toLowerCase());
    return { name, slug: candidate, changed: candidate !== name, collided };
  });
}

/**
 * A name usable after `# @name` in a .http file: ASCII letters, digits and underscore only, because REST Client reads
 * `\w+`. Accents are removed, other characters become `_`. Empty becomes `request`.
 */
export function identifier(name: string): string {
  const marks = new RegExp(`[${String.fromCodePoint(0x300)}-${String.fromCodePoint(0x36f)}]`, 'g');
  const folded = name.normalize('NFKD').replace(marks, '')
    .replaceAll(String.fromCodePoint(0x110), 'D').replaceAll(String.fromCodePoint(0x111), 'd');
  const text = stripChar(folded.replace(/[^A-Za-z0-9_]+/g, '_'), '_');
  return stripChar(cut(text, 60), '_') || 'request';
}

/** Identifiers that are unique ignoring letter case within one file: a repeat gets `_2`, `_3`... */
export function uniqueIdentifiers(names: readonly string[]): string[] {
  const used = new Set<string>();
  // The next suffix to try for each identifier: the ones before it are taken (50,000 requests called "New Request" took four minutes without this).
  const next = new Map<string, number>();
  return names.map(original => {
    const base = identifier(original);
    let candidate = base;
    const key = base.toLowerCase();
    let n = next.get(key) ?? 2;
    let collided = false;
    for (; used.has(candidate.toLowerCase()); n++) { collided = true; candidate = `${base}_${n}`; }
    if (collided) next.set(key, n);
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
