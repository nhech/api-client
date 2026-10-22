import { ROUTE_LIMITS } from './types';

/**
 * The reading of a source file as text, in one linear pass: the comments are blanked (a route in a comment is not a route), the inside of the strings
 * is blanked in a second view (so that a brace or a parenthesis in a string is not structure), and the partner of every bracket is found once, so that
 * no search ever runs to the end of a file more than one time. All the views have the length of the text, and the same line breaks, so that an offset
 * found in one is the offset in all.
 */
export type Lang = 'js' | 'java' | 'csharp' | 'python' | 'php' | 'go' | 'rust';

export interface Prepared {
  /** The text with the comments blanked. */
  clean: string;
  /** `clean` with the inside of the strings blanked too: what is left is the structure. */
  masked: string;
  /** For the offset of `(`, `[` or `{`, the offset of its partner; else -1. */
  close: Int32Array;
  /** For the offset of `)`, `]` or `}`, the offset of its partner; else -1. */
  open: Int32Array;
  /** The offset where each line starts. */
  lineStarts: number[];
  /** How many lines were skipped for being longer than the limit (a minified file). */
  longLines: number;
}

const BLANK = /[^\n\r]/g;

/** The text with every line longer than the limit replaced by spaces: a minified bundle is not a controller. */
function dropLongLines(text: string): { text: string; count: number } {
  let count = 0;
  let parts: string[] | undefined;
  let last = 0;
  let start = 0;
  for (;;) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end - start > ROUTE_LIMITS.lineChars) {
      count++;
      parts ??= [];
      parts.push(text.slice(last, start), ' '.repeat(end - start));
      last = end;
    }
    if (end >= text.length) break;
    start = end + 1;
  }
  if (parts === undefined) return { text, count: 0 };
  parts.push(text.slice(last));
  return { text: parts.join(''), count };
}

/** Where the comments and the strings are, as flat lists of [start, end) pairs in the order of the text. */
function scan(text: string, lang: Lang): { comments: number[]; all: number[] } {
  const n = text.length;
  const comments: number[] = [];
  const all: number[] = [];
  const slash = lang !== 'python';
  const hash = lang === 'python' || lang === 'php';
  let blockMissing = false;
  const tripleMissing = new Set<string>();
  /** The closers of a raw string of Rust (a quote and some hashes) that the rest of the text does not have: once it is known, it is not searched for again. */
  const rawMissing = new Set<number>();
  /** The depth of the braces of each open `${` of a template literal. */
  const holes: number[] = [];

  const comment = (from: number, to: number): void => { comments.push(from, to); all.push(from, to); };
  const text_ = (from: number, to: number): void => { if (to > from) all.push(from, to); };
  const lineEnd = (from: number): number => { const at = text.indexOf('\n', from); return at < 0 ? n : at; };

  /** The text of a template literal from `from` (after the backtick or after the brace that ends a hole): returns where code goes on. */
  const template = (from: number): number => {
    let at = from;
    while (at < n) {
      const c = text.charCodeAt(at);
      if (c === 92) { at += 2; continue; }
      if (c === 96) { text_(from, at); return at + 1; }
      if (c === 36 && text.charCodeAt(at + 1) === 123) { text_(from, at); holes.push(1); return at + 2; }
      at++;
    }
    text_(from, n);
    return n;
  };

  const quoted = (start: number, quote: number): number => {
    const next = text.charCodeAt(start + 1);
    if (quote !== 39 || lang === 'python') {
      // Triple quotes: a docstring in Python (blanked like a comment), a text block in Java and Kotlin, a raw string in C#.
      const triple = lang === 'python' || ((lang === 'java' || lang === 'csharp') && quote === 34);
      if (triple && next === quote && text.charCodeAt(start + 2) === quote) {
        const mark = String.fromCharCode(quote).repeat(3);
        if (!tripleMissing.has(mark)) {
          const end = text.indexOf(mark, start + 3);
          if (end >= 0) {
            if (lang === 'python') comment(start, end + 3);
            else text_(start + 3, end);
            return end + 3;
          }
          tripleMissing.add(mark);
        }
      }
    }
    if (lang === 'csharp' && quote === 34 && text.charCodeAt(start - 1) === 64) {
      // Verbatim: a quote is written twice, and a line break is part of the text.
      let at = start + 1;
      while (at < n) {
        if (text.charCodeAt(at) === 34) {
          if (text.charCodeAt(at + 1) === 34) { at += 2; continue; }
          text_(start + 1, at);
          return at + 1;
        }
        at++;
      }
      return n;
    }
    if (lang === 'rust' && quote === 34) {
      let back = start - 1;
      let hashes = 0;
      while (back >= 0 && text.charCodeAt(back) === 35) { hashes++; back--; }
      if (back >= 0 && text.charCodeAt(back) === 114 && (back === 0 || !/\w/.test(text[back - 1] ?? ''))) {
        if (!rawMissing.has(hashes)) {
          const end = text.indexOf(`"${'#'.repeat(hashes)}`, start + 1);
          if (end >= 0) { text_(start + 1, end); return end + 1 + hashes; }
          rawMissing.add(hashes);
        }
      }
    }
    if (lang === 'rust' && quote === 39) {
      // A character, or the start of a lifetime: only a character has a closing quote right after it.
      const body = text.charCodeAt(start + 1) === 92 ? text.indexOf("'", start + 3) : (text.charCodeAt(start + 2) === 39 ? start + 2 : -1);
      if (body < 0 || body - start > 12) return start + 1;
      return body + 1;
    }
    let at = start + 1;
    while (at < n) {
      const c = text.charCodeAt(at);
      if (c === 92) { at += 2; continue; }
      if (c === quote) { text_(start + 1, at); return at + 1; }
      if (c === 10) { text_(start + 1, at); return at; }
      at++;
    }
    text_(start + 1, n);
    return n;
  };

  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (holes.length > 0) {
      if (c === 123) { holes[holes.length - 1] = (holes[holes.length - 1] ?? 0) + 1; i++; continue; }
      if (c === 125) {
        const depth = (holes[holes.length - 1] ?? 1) - 1;
        if (depth === 0) { holes.pop(); i = template(i + 1); continue; }
        holes[holes.length - 1] = depth;
        i++;
        continue;
      }
    }
    if (slash && c === 47) {
      const d = text.charCodeAt(i + 1);
      const before = i > 0 ? text.charCodeAt(i - 1) : 0;
      if (d === 47 && before !== 92) { const end = lineEnd(i); comment(i, end); i = end; continue; }
      if (d === 42 && before !== 92 && !blockMissing) {
        const end = text.indexOf('*/', i + 2);
        if (end >= 0) { comment(i, end + 2); i = end + 2; continue; }
        blockMissing = true;
      }
      i++;
      continue;
    }
    if (hash && c === 35) {
      if (lang === 'php' && text.charCodeAt(i + 1) === 91) { i++; continue; }
      const end = lineEnd(i);
      comment(i, end);
      i = end;
      continue;
    }
    if (c === 34 || c === 39) { i = quoted(i, c); continue; }
    if (c === 96 && lang === 'js') { i = template(i + 1); continue; }
    if (c === 96 && lang === 'go') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) { text_(i + 1, n); i = n; continue; }
      text_(i + 1, end);
      i = end + 1;
      continue;
    }
    i++;
  }
  return { comments, all };
}

function blanked(text: string, spans: readonly number[]): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let last = 0;
  for (let k = 0; k + 1 < spans.length; k += 2) {
    const from = spans[k] as number;
    const to = spans[k + 1] as number;
    parts.push(text.slice(last, from), text.slice(from, to).replace(BLANK, ' '));
    last = to;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

const CLOSER = new Map<number, number>([[40, 41], [91, 93], [123, 125]]);

export function prepare(source: string, lang: Lang): Prepared {
  // A byte order mark in front of the first line would keep the patterns that start a line from matching it; a space has its place.
  const { text, count } = dropLongLines(source.charCodeAt(0) === 0xfeff ? ` ${source.slice(1)}` : source);
  const marks = scan(text, lang);
  const clean = blanked(text, marks.comments);
  const masked = blanked(text, marks.all);
  const n = masked.length;
  const close = new Int32Array(n).fill(-1);
  const open = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let at = 0; at < n; at++) {
    const c = masked.charCodeAt(at);
    if (c === 40 || c === 91 || c === 123) stack.push(at);
    else if (c === 41 || c === 93 || c === 125) {
      // The closer goes with the nearest opener of its own kind among the last few; the ones above it (a parenthesis in a regular expression that was
      // not seen as one) stay without a partner. A closer with none to go with is left alone.
      for (let depth = 1; depth <= 8 && depth <= stack.length; depth++) {
        const top = stack[stack.length - depth] as number;
        if (CLOSER.get(masked.charCodeAt(top)) !== c) continue;
        stack.length -= depth;
        close[top] = at;
        open[at] = top;
        break;
      }
    }
  }
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  return { clean, masked, close, open, lineStarts, longLines: count };
}

/** The line of an offset, counted from 1. */
export function lineOf(prepared: Prepared, offset: number): number {
  const starts = prepared.lineStarts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] as number) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export const isSpace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
export const isIdentStart = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
export const isIdentChar = (code: number): boolean => isIdentStart(code) || (code >= 48 && code <= 57);

/** The offset of `needle` between `from` and `to`, or -1: a search that never runs to the end of a file, so that a hostile file cannot make many of them cost much. */
export function indexWithin(text: string, needle: string, from: number, to: number): number {
  const at = text.slice(from, Math.max(from, to)).indexOf(needle);
  return at < 0 ? -1 : from + at;
}

/** The offset of the first character that is not white space, from `from`. */
export function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && isSpace(text.charCodeAt(at))) at++;
  return at;
}

/** The identifier that starts at `from` (letters, digits, `_` and `$`), or ''. */
export function identAt(text: string, from: number): string {
  if (!isIdentStart(text.charCodeAt(from))) return '';
  let at = from + 1;
  while (at < text.length && isIdentChar(text.charCodeAt(at))) at++;
  return text.slice(from, at);
}

/** The identifier that ends just before `to` (white space skipped), with the offset where it starts, or undefined. */
export function identBefore(text: string, to: number): { name: string; start: number } | undefined {
  let end = to;
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--;
  let start = end;
  while (start > 0 && isIdentChar(text.charCodeAt(start - 1))) start--;
  if (start === end || !isIdentStart(text.charCodeAt(start))) return undefined;
  return { name: text.slice(start, end), start };
}

export interface Literal {
  value: string;
  /** The offset after the closing quote. */
  end: number;
}

const MOST_LITERAL = 1000;

/**
 * The plain string that starts at `at` in the clean text: one quote kind, no interpolation (`${` in a template, `$"` in C#, `f"` in Python), on one
 * line (a template and a triple quote may have several, up to a limit). A backslash takes the next character as it is. Undefined when it is not one.
 */
export function literalAt(clean: string, at: number): Literal | undefined {
  let start = at;
  let prefix = '';
  // A prefix of Python (r, b, u, f), of C# ($, @) or of Rust (r, b) before the quote.
  while (start < clean.length && /[rRbBuUfF$@]/.test(clean[start] ?? '') && start - at < 3) { prefix += clean[start]; start++; }
  const quote = clean[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  if (/[fF$]/.test(prefix)) return undefined;
  let value = '';
  let index = start + 1;
  const limit = Math.min(clean.length, start + MOST_LITERAL);
  while (index < limit) {
    const c = clean[index];
    if (c === quote) {
      if (prefix.includes('@') && clean[index + 1] === '"') { value += '"'; index += 2; continue; }
      return { value, end: index + 1 };
    }
    if (c === '\\' && !prefix.includes('@')) { value += clean[index + 1] ?? ''; index += 2; continue; }
    if (c === '\n' && quote !== '`') return undefined;
    if (c === '$' && quote === '`' && clean[index + 1] === '{') return undefined;
    value += c;
    index++;
  }
  return undefined;
}

export interface ArgOptions {
  /** The most arguments to find. */
  max?: number;
  /** The most characters to read: the rest of a long list is not looked at. */
  scan?: number;
  /** Count `<` and `>` as brackets (the generics of Java, Kotlin and C#). */
  angles?: boolean;
}

/** The [start, end) ranges of the arguments between the bracket at `openAt` and its partner, trimmed, split at the commas that are not inside another bracket. */
export function argRanges(prepared: Prepared, openAt: number, options: ArgOptions = {}): [number, number][] {
  const closeAt = prepared.close[openAt] ?? -1;
  if (closeAt < 0) return [];
  const max = options.max ?? 8;
  const stop = Math.min(closeAt, openAt + 1 + (options.scan ?? 800));
  const masked = prepared.masked;
  const found: [number, number][] = [];
  let depth = 0;
  let from = openAt + 1;
  for (let at = openAt + 1; at < stop; at++) {
    const c = masked.charCodeAt(at);
    if (c === 40 || c === 91 || c === 123) depth++;
    else if (c === 41 || c === 93 || c === 125) depth--;
    else if (options.angles === true && c === 60) depth++;
    else if (options.angles === true && c === 62 && masked.charCodeAt(at - 1) !== 45 && masked.charCodeAt(at - 1) !== 61) depth--;
    else if (c === 44 && depth === 0) {
      found.push(trimmed(prepared.clean, from, at));
      if (found.length >= max) return found;
      from = at + 1;
    }
  }
  const last = trimmed(prepared.clean, from, stop === closeAt ? closeAt : stop);
  if (last[1] > last[0] || found.length > 0) found.push(last);
  return found;
}

function trimmed(text: string, from: number, to: number): [number, number] {
  let start = from;
  let end = to;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return [start, end];
}

/** The plain string that is the whole of an argument (or the part of it that starts at its first quote), or undefined. */
export function stringArg(prepared: Prepared, range: readonly [number, number]): string | undefined {
  const literal = literalAt(prepared.clean, range[0]);
  if (literal === undefined) return undefined;
  const rest = prepared.clean.slice(literal.end, range[1]).trim();
  return rest === '' ? literal.value : undefined;
}
