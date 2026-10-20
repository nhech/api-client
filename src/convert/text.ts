import { isHiddenChar } from '../util/chars';

/**
 * Text helpers for the conversion: `{{variables}}` are opaque to everything that edits text, and a value that goes on one
 * line of a .http file can never carry a line break into the file.
 */

/** The [start, end) spans of the `{{...}}` variables of a text. Braces inside may nest (`{{#date, {year: -1}}}`); an unclosed `{{` is plain text. */
export function variableSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  if (!text.includes('{{')) return spans;
  // One pass pairs every `}` with the `{` it closes. Looking for the end of each `{{` on its own is quadratic on a text such as
  // 200,000 opening braces (found by a test: it took 90 seconds).
  const closes = new Int32Array(text.length).fill(-1);
  const open: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const code = text.charCodeAt(k);
    if (code === 0x7b) open.push(k);
    else if (code === 0x7d) { const at = open.pop(); if (at !== undefined) closes[at] = k; }
  }
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x7b && text.charCodeAt(i + 1) === 0x7b) {
      const end = closes[i] ?? -1;
      if (end !== -1) { spans.push([i, end + 1]); i = end + 1; continue; }
    }
    i++;
  }
  return spans;
}

/** The text cut into pieces that are variables and pieces that are not, in order. */
export function splitVariables(text: string): { variable: boolean; text: string }[] {
  const pieces: { variable: boolean; text: string }[] = [];
  let at = 0;
  for (const [start, end] of variableSpans(text)) {
    if (start > at) pieces.push({ variable: false, text: text.slice(at, start) });
    pieces.push({ variable: true, text: text.slice(start, end) });
    at = end;
  }
  if (at < text.length) pieces.push({ variable: false, text: text.slice(at) });
  return pieces;
}

/** Applies `edit` to the text between variables and leaves the variables as they are. */
export function mapLiteral(text: string, edit: (literal: string) => string): string {
  return splitVariables(text).map(piece => (piece.variable ? piece.text : edit(piece.text))).join('');
}

/** The text split at every `separator` that is not inside a variable. An empty text gives one empty piece. */
export function splitOutsideVariables(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const piece of splitVariables(text)) {
    if (piece.variable) { current += piece.text; continue; }
    const cut = piece.text.split(separator);
    current += cut[0] ?? '';
    for (let i = 1; i < cut.length; i++) { parts.push(current); current = cut[i] ?? ''; }
  }
  parts.push(current);
  return parts;
}

/** Index of the first `char` outside a variable, from `from`, or -1. */
export function indexOutsideVariables(text: string, char: string, from = 0): number {
  const spans = variableSpans(text);
  let next = 0;
  for (let i = from; i < text.length; i++) {
    while (next < spans.length && (spans[next]?.[1] ?? 0) <= i) next++;
    const span = spans[next];
    if (span !== undefined && i >= span[0] && i < span[1]) { i = span[1] - 1; continue; }
    if (text[i] === char) return i;
  }
  return -1;
}

/** True when something other than variables and white space is in the text: a literal, such as a typed-in token. */
export function hasLiteral(text: string): boolean {
  return splitVariables(text).some(piece => !piece.variable && piece.text.trim() !== '');
}

export interface OneLine {
  text: string;
  /** A carriage return or line feed was replaced. */
  lineBreak: boolean;
}

/**
 * Makes a value fit on one line: line breaks become a space, other control and direction-changing characters become "?".
 * A value is never allowed to start another line of the file.
 */
export function oneLine(text: string): OneLine {
  let lineBreak = false;
  const out = Array.from(text, char => {
    if (char === '\r' || char === '\n') { lineBreak = true; return ' '; }
    if (char === '\t') return ' ';
    return isHiddenChar(char) ? '?' : char;
  }).join('');
  return { text: out, lineBreak };
}

/** The text without its leading and trailing white space, as one line. */
export function cleanLine(text: string): OneLine {
  const line = oneLine(text);
  return { text: line.text.trim(), lineBreak: line.lineBreak };
}
