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
const EDGE = /^[.\s]+|[.\s]+$/g;

const codePoints = (text: string): string[] => Array.from(text);
const cut = (text: string, max: number): string => codePoints(text).slice(0, Math.max(0, max)).join('');

export function slugify(name: string, max: number = LIMITS.maxSlugChars): Slug {
  let slug = codePoints(name.normalize('NFC')).map(char => (isUnsafeInName(char) ? '-' : char)).join('')
    .replace(/\.{2,}/g, '-').replace(/-{2,}/g, '-').replace(EDGE, '');
  const dot = slug.indexOf('.');
  const base = dot === -1 ? slug : slug.slice(0, dot);
  if (RESERVED.test(base)) slug = `${base}_${slug.slice(base.length)}`;
  // A leading hyphen would make the name look like an option to a shell (`rm -x`), and "../x" is more useful as "x" than as "-x".
  slug = cut(slug, max).replace(EDGE, '').replace(/^-+/, '');
  // Empty, or nothing left but the hyphens that cleaning put in place of unsafe characters ("..", "/", "---").
  if (/^-*$/.test(slug)) slug = 'unnamed';
  return { slug, changed: slug !== name };
}

/** Names that are unique as they are, exactly (not ignoring case): a repeat gets `-2`, `-3`... Used for keys of a JSON object. */
export function uniqueNames(names: readonly string[]): { name: string; collided: boolean }[] {
  const used = new Set<string>();
  return names.map(original => {
    let name = original === '' ? 'Environment' : original;
    let collided = false;
    for (let n = 2; used.has(name); n++) { collided = true; name = `${original === '' ? 'Environment' : original}-${n}`; }
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
  return names.map(name => {
    const { slug } = slugify(name, max);
    let candidate = slug;
    let collided = false;
    for (let n = 2; taken(candidate); n++) {
      collided = true;
      const suffix = `-${n}`;
      candidate = cut(slug, max - suffix.length).replace(EDGE, '') + suffix;
    }
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
  const text = folded.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cut(text, 60).replace(/_+$/g, '') || 'request';
}

/** Identifiers that are unique ignoring letter case within one file: a repeat gets `_2`, `_3`... */
export function uniqueIdentifiers(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map(original => {
    const base = identifier(original);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}_${n}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
