import { isHiddenChar } from '../../util/chars';
import type { YMap, YValue } from './types';

/**
 * Writes the YAML subset in one canonical form, so that `parse(emit(x))` is `x` for every value and a file that was written
 * here is written the same way again. Mappings use two spaces per level and a list is indented under its key. A string is
 * plain when that is unambiguous, otherwise in single quotes, otherwise in double quotes with escapes; a string of several
 * lines becomes a `|`, `|-` or `|+` block when it can be one without losing a character, so that a diff shows it line by line.
 */
const KEY = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const PLAIN_START = /^[\p{L}\p{N}_$/.]/u;
const KEYWORDS = /^(?:true|false|yes|no|on|off|y|n|null|nan|inf|infinity)$/i;
/**
 * The files are read by this module, which reads every scalar as a string and leaves its meaning to the schema, so the plain
 * `true`, `false` and whole numbers stay plain: `enabled: false` and `schema: 1` are what a person expects to see. Other
 * strings that another YAML reader would take for something else (null, yes, floats, hexadecimal, dates, minutes and seconds)
 * are quoted, and so is any capitalisation of a boolean.
 */
const READABLE = /^(?:true|false|0|[1-9]\d{0,14})$/;
const LOOKS_LIKE_OTHER_TYPE = [
  KEYWORDS,
  /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?$/,
  /^0[xX][0-9a-fA-F_]+$|^0[oO][0-7_]+$|^0[bB][01_]+$/,
  /^\d{4}-\d\d?-\d\d?(?:[Tt ].*)?$/,
  /^[-+]?\d+(?::[0-5]?\d)+(?:\.\d*)?$/,
  /^[-+]?\.(?:inf|nan)$/i
];

const isLoneSurrogate = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0xd800 && code <= 0xdfff;
};
/** A character that is escaped in double quotes: controls, line breaks, invisible and direction-changing characters, and lone surrogates (they cannot be written as UTF-8). */
const needsEscape = (char: string): boolean => isHiddenChar(char) || isLoneSurrogate(char);

function doubleQuoted(text: string): string {
  let out = '"';
  for (const char of text) {
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\0') out += '\\0';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (needsEscape(char)) {
      const code = char.codePointAt(0) ?? 0;
      out += code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += char;
  }
  return `${out}"`;
}

function isPlain(text: string): boolean {
  if (!PLAIN_START.test(text)) return false;
  if (text !== text.trim() || text.includes(': ') || text.includes(' #') || text.endsWith(':')) return false;
  for (const char of text) if (needsEscape(char)) return false;
  return READABLE.test(text) || !LOOKS_LIKE_OTHER_TYPE.some(pattern => pattern.test(text));
}

/** A string on one line. */
function scalar(text: string): string {
  if (isPlain(text)) return text;
  for (const char of text) if (needsEscape(char)) return doubleQuoted(text);
  return `'${text.replaceAll("'", "''")}'`;
}

const key = (name: string): string => (KEY.test(name) && !KEYWORDS.test(name) ? name : scalar(name));

/** The lines of a `|` block for the text, or undefined when a block would change it. */
function blockLines(text: string): { header: string; lines: string[] } | undefined {
  if (!text.includes('\n')) return undefined;
  for (const char of text) if (char !== '\n' && char !== '\t' && needsEscape(char)) return undefined;
  const body = text.replace(/\n+$/, '');
  const trailing = text.length - body.length;
  if (body === '') return undefined;
  const lines = body.split('\n');
  const first = lines[0] ?? '';
  if (first === '' || first.startsWith(' ')) return undefined;
  if (lines.some(line => line !== '' && (line.trim() === '' || /[ \t]$/.test(line)))) return undefined;
  const header = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
  return { header, lines: [...lines, ...Array<string>(Math.max(0, trailing - 1)).fill('')] };
}

function emitMapping(map: YMap, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const [name, value] of map) {
    const head = `${pad}${key(name)}:`;
    if (typeof value === 'string') {
      const block = blockLines(value);
      if (block === undefined) out.push(`${head} ${scalar(value)}`);
      else {
        out.push(`${head} ${block.header}`);
        for (const line of block.lines) out.push(line === '' ? '' : `${pad}  ${line}`);
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) out.push(`${head} []`);
      else { out.push(head); emitSequence(value, indent + 2, out); }
    } else if (value.size === 0) out.push(`${head} {}`);
    else { out.push(head); emitMapping(value, indent + 2, out); }
  }
}

function emitSequence(items: YValue[], indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  for (const item of items) {
    if (typeof item === 'string') out.push(`${pad}- ${scalar(item)}`);
    else if (Array.isArray(item)) throw new Error('A list inside a list cannot be written.');
    else if (item.size === 0) out.push(`${pad}- {}`);
    else {
      const lines: string[] = [];
      emitMapping(item, indent + 2, lines);
      lines[0] = `${pad}- ${(lines[0] ?? '').slice(indent + 2)}`;
      out.push(...lines);
    }
  }
}

/** The text of a document; its root is a mapping or a list. */
export function emitYaml(value: YValue): string {
  if (typeof value === 'string') throw new Error('The root of a document is a mapping or a list.');
  const out: string[] = [];
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    emitSequence(value, 0, out);
  } else {
    if (value.size === 0) return '{}\n';
    emitMapping(value, 0, out);
  }
  return `${out.join('\n')}\n`;
}
