import type { YamlError } from './types';

/**
 * A reader for the YAML that other people's files are written in (an OpenAPI description, for one): block mappings and lists, flow collections
 * (`[a, b]`, `{a: 1}`), quoted and plain scalars that continue over several lines, literal and folded block scalars, comments, and the types of the
 * plain scalars (`true`, `null`, `10`, `1.5`). It is for files that are only read, never for the files of the client (those use the strict subset in
 * parse.ts). It is just as careful: there are no anchors, aliases, tags, merge keys or complex keys (a file that uses them is refused with the reason,
 * so nothing can grow when it is read), the text, the nesting and the number of values are limited, the work is linear in the size of the text, and
 * what it returns is plain data: objects without a prototype (a key such as `__proto__` is a key like any other), lists, strings, numbers, flags and
 * null. Only the first document of a file is read.
 */
export type LooseValue = null | boolean | number | string | LooseValue[] | { [key: string]: LooseValue };

export interface LooseLimits {
  /** The size of the text in UTF-16 units. */
  maxChars: number;
  /** Nesting of mappings, lists and flow collections. */
  maxDepth: number;
  /** Entries, items and scalars together. */
  maxNodes: number;
}

export const DEFAULT_LOOSE_LIMITS: LooseLimits = { maxChars: 32 * 1024 * 1024, maxDepth: 100, maxNodes: 2_000_000 };

export type LooseResult = { ok: true; value: LooseValue; duplicates: number } | { ok: false; error: YamlError };

class Syntax extends Error {
  constructor(readonly line: number, readonly column: number, message: string) { super(message); }
}

interface Line {
  /** From 1. */
  n: number;
  indent: number;
  /** The line without its indent. */
  text: string;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', '0': '\0', a: '\u0007', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001b', ' ': ' ', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' };

export function parseLooseYaml(text: string, limits: LooseLimits = DEFAULT_LOOSE_LIMITS): LooseResult {
  try {
    const parser = new Parser(text, limits);
    const value = parser.document();
    return { ok: true, value, duplicates: parser.duplicates };
  } catch (error) {
    if (error instanceof Syntax) return { ok: false, error: { line: error.line, column: error.column, message: error.message } };
    throw error;
  }
}

const isSequenceEntry = (text: string): boolean => text === '-' || text.startsWith('- ');
const blank = (line: Line): boolean => line.text.trim() === '';
const comment = (line: Line): boolean => line.text.charCodeAt(0) === 35;
const object = (): { [key: string]: LooseValue } => Object.create(null) as { [key: string]: LooseValue };

/** The text without a comment (a `#` at the start or after a space) and without trailing spaces. */
function withoutComment(text: string): string {
  const at = text.search(/(?:^|\s)#/);
  return (at < 0 ? text : text.slice(0, at)).trimEnd();
}

/** What a plain scalar is: null, a flag, a number, or the text. A number that is not exact (too large) and one with a leading zero stay text. */
export function plainValue(text: string): LooseValue {
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (text === 'true' || text === 'True' || text === 'TRUE') return true;
  if (text === 'false' || text === 'False' || text === 'FALSE') return false;
  const first = text.charCodeAt(0);
  // Only a text that can be a number is looked at with the patterns below.
  if (!((first >= 48 && first <= 57) || first === 45 || first === 43 || first === 46)) return text;
  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(text)) {
    const number = Number(text);
    return Number.isSafeInteger(number) ? number : text;
  }
  if (/^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*|[0-9]+(?=[eE]))(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (/^0x[0-9a-fA-F]+$/.test(text)) { const number = parseInt(text, 16); return Number.isSafeInteger(number) ? number : text; }
  if (/^0o[0-7]+$/.test(text)) { const number = parseInt(text.slice(2), 8); return Number.isSafeInteger(number) ? number : text; }
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (text === '.nan' || text === '.NaN' || text === '.NAN') return NaN;
  return text;
}

/** The pieces of a quoted scalar that is read line by line: what it holds so far, and whether the line ended in a backslash (a join with no space). */
interface Quoted { value: string; glue: boolean }

class Parser {
  duplicates = 0;
  private readonly lines: Line[] = [];
  private at = 0;
  private nodes = 0;

  constructor(text: string, private readonly limits: LooseLimits) {
    if (text.length > limits.maxChars) throw new Syntax(1, 1, `the text is larger than ${limits.maxChars} characters`);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raws = text.split('\n');
    if (raws[raws.length - 1] === '') raws.pop();
    let content = false;
    let started = false;
    for (let index = 0; index < raws.length; index++) {
      let raw = raws[index] ?? '';
      if (raw.endsWith('\r')) raw = raw.slice(0, -1);
      const control = CONTROL.exec(raw);
      if (control) throw new Syntax(index + 1, control.index + 1, 'a control character; write it as an escape in double quotes');
      let indent = 0;
      while (raw.charCodeAt(indent) === 32) indent++;
      if (indent === 0) {
        if (/^---(?:\s|$)/.test(raw)) {
          // The second document is not read: a marker after the first one, with or without text in between, ends the first (an empty one, if it had none).
          if (content || started) break;
          started = true;
          // `--- text` or `--- # comment`: what follows the marker is the first line of the document.
          const rest = raw.slice(3).trimStart();
          if (rest !== '' && rest.charCodeAt(0) !== 35) { this.lines.push({ n: index + 1, indent: 0, text: rest }); content = true; }
          continue;
        }
        if (/^\.\.\.(?:\s|$)/.test(raw)) break;
        if (!content && raw.charCodeAt(0) === 37) continue;
      }
      const text = raw.slice(indent);
      if (text.trim() !== '' && text.charCodeAt(0) !== 35) content = true;
      this.lines.push({ n: index + 1, indent, text });
    }
  }

  document(): LooseValue {
    this.skipBlank();
    if (this.at >= this.lines.length) return null;
    const value = this.block((this.lines[this.at] as Line).indent, 1);
    this.skipBlank();
    if (this.at < this.lines.length) {
      const extra = this.lines[this.at] as Line;
      this.fail(extra, 0, extra.indent === 0 ? 'unexpected content after the end of the document' : 'this line is indented differently from the lines above it');
    }
    return value;
  }

  private fail(line: Line, offset: number, message: string): never {
    throw new Syntax(line.n, line.indent + offset + 1, message);
  }

  private node(line: Line): void {
    if (++this.nodes > this.limits.maxNodes) this.fail(line, 0, `more than ${this.limits.maxNodes} entries, items and values`);
  }

  private skipBlank(): void {
    while (this.at < this.lines.length) {
      const line = this.lines[this.at] as Line;
      if (blank(line) || comment(line)) this.at++;
      else break;
    }
  }

  /** The current line, which must hold structure: a tab cannot indent. */
  private current(): Line {
    const line = this.lines[this.at] as Line;
    if (line.text.charCodeAt(0) === 9) this.fail(line, 0, 'a tab cannot indent a line; use spaces');
    return line;
  }

  /** The block that starts at the current line, whose lines are indented `indent`. */
  private block(indent: number, depth: number): LooseValue {
    if (depth > this.limits.maxDepth) this.fail(this.current(), 0, `nested more than ${this.limits.maxDepth} levels`);
    const line = this.current();
    if (isSequenceEntry(line.text)) return this.sequence(indent, depth);
    if (this.splitEntry(line) !== undefined) return this.mapping(indent, depth);
    // A value on its own: a flow collection, a quoted or plain scalar.
    this.at++;
    return this.inline(line.text, line, 0, indent - 1, depth);
  }

  private mapping(indent: number, depth: number): LooseValue {
    const map = object();
    for (;;) {
      this.skipBlank();
      if (this.at >= this.lines.length) break;
      const line = this.current();
      if (line.indent < indent) break;
      if (line.indent > indent) this.fail(line, 0, 'this line is indented more than the key above it');
      if (isSequenceEntry(line.text)) this.fail(line, 0, 'a list item where a key was expected');
      const entry = this.splitEntry(line);
      if (entry === undefined) this.fail(line, 0, 'expected "key: value"');
      if (entry.key === '<<') this.fail(line, 0, 'merge keys (<<) are not supported; write the keys out');
      this.node(line);
      this.at++;
      const value = this.valueAfterColon(entry.rest, line, entry.restOffset, indent, depth);
      if (Object.hasOwn(map, entry.key)) this.duplicates++;
      map[entry.key] = value;
    }
    return map;
  }

  private sequence(indent: number, depth: number): LooseValue {
    const items: LooseValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.at >= this.lines.length) break;
      const line = this.current();
      if (line.indent !== indent || !isSequenceEntry(line.text)) {
        if (line.indent > indent) this.fail(line, 0, 'this line is indented more than the list item above it');
        break;
      }
      this.node(line);
      const after = line.text === '-' ? '' : line.text.slice(2);
      const rest = after.trimStart();
      const column = indent + 2 + (after.length - rest.length);
      this.at++;
      if (rest === '' || rest.charCodeAt(0) === 35) {
        this.skipBlank();
        const next = this.at < this.lines.length ? this.current() : undefined;
        items.push(next !== undefined && next.indent > indent ? this.block(next.indent, depth + 1) : null);
      } else if (isSequenceEntry(rest) || this.splitEntry({ n: line.n, indent: column, text: rest }) !== undefined) {
        // `- key: value` and `- - item`: what follows the dash is a block whose lines start at that column.
        this.lines[--this.at] = { n: line.n, indent: column, text: rest };
        items.push(this.block(column, depth + 1));
      } else {
        items.push(this.inline(rest, line, column - line.indent, indent, depth));
      }
    }
    return items;
  }

  /** `key: rest`, or undefined when the line is not an entry. */
  private splitEntry(line: Line): { key: string; rest: string; restOffset: number } | undefined {
    const text = line.text;
    const first = text[0] ?? '';
    if (first === '"' || first === "'") {
      const acc: Quoted = { value: '', glue: false };
      const end = this.scanQuoted(text, 1, first, acc, line, 0);
      if (end < 0) return undefined;
      let at = end;
      while (text[at] === ' ') at++;
      if (text[at] !== ':' || (at + 1 < text.length && text[at + 1] !== ' ')) return undefined;
      return { key: acc.value, rest: text.slice(at + 1), restOffset: at + 1 };
    }
    if ('[{#&*!|>%@`'.includes(first) && first !== '') return undefined;
    if (first === '?' && (text.length === 1 || text[1] === ' ')) this.fail(line, 0, 'complex keys (?) are not supported');
    for (let at = 0; at < text.length; at++) {
      const char = text[at];
      if (char === '#' && at > 0 && text[at - 1] === ' ') return undefined;
      if (char === ':' && (at + 1 === text.length || text[at + 1] === ' ')) {
        const key = text.slice(0, at).trimEnd();
        return key === '' ? undefined : { key, rest: text.slice(at + 1), restOffset: at + 1 };
      }
    }
    return undefined;
  }

  private valueAfterColon(rest: string, line: Line, restOffset: number, indent: number, depth: number): LooseValue {
    const trimmed = rest.trimStart();
    const offset = restOffset + (rest.length - trimmed.length);
    if (trimmed === '' || trimmed.charCodeAt(0) === 35) {
      this.skipBlank();
      const next = this.at < this.lines.length ? this.current() : undefined;
      if (next !== undefined && next.indent > indent) return this.block(next.indent, depth + 1);
      if (next !== undefined && next.indent === indent && isSequenceEntry(next.text)) return this.sequence(indent, depth + 1);
      return null;
    }
    if (isSequenceEntry(trimmed)) this.fail(line, offset, 'a list item cannot follow a key on the same line');
    return this.inline(trimmed, line, offset, indent, depth);
  }

  /**
   * A value that starts on the line `line` at `offset` (the line is already consumed): a block scalar, a flow collection, or a quoted or plain scalar
   * that may go on over the lines that are indented more than `parent`.
   */
  private inline(text: string, line: Line, offset: number, parent: number, depth: number): LooseValue {
    this.node(line);
    const first = text[0] ?? '';
    if (first === '|' || first === '>') return this.blockScalar(text, line, offset, parent);
    if (first === '&') this.fail(line, offset, 'anchors (&) are not supported');
    if (first === '*') this.fail(line, offset, 'aliases (*) are not supported');
    if (first === '!') this.fail(line, offset, 'tags (!) are not supported');
    if (first === '[' || first === '{') return this.flowValue(text, line, offset, depth);
    if (first === '"' || first === "'") return this.quotedValue(text, first, line, offset);
    if (first === '%' || first === '@' || first === '`') this.fail(line, offset, `a value cannot start with "${first}"; put it in quotes`);
    return this.plainScalar(text, parent);
  }

  /** A plain scalar and the lines under it that are indented more than `parent`: they continue it, joined with a space (an empty line is a line break). */
  private plainScalar(first: string, parent: number): LooseValue {
    let text = withoutComment(first);
    // A comment ends the scalar: nothing continues it.
    let open = text.length === first.trimEnd().length;
    while (open) {
      let pending = 0;
      let next = this.lines[this.at];
      while (next !== undefined && blank(next)) next = this.lines[this.at + ++pending];
      if (next === undefined || next.indent <= parent || comment(next)) break;
      const more = withoutComment(next.text);
      // A line that is indented more and says "key: value" is a key at the wrong indentation, not the rest of the text (YAML refuses it as well).
      if (/:(?:\s|$)/.test(more)) this.fail(next, 0, 'a key where a value continues: this line is indented more than the key above it');
      text += (pending > 0 ? '\n'.repeat(pending) : ' ') + more;
      this.at += pending + 1;
      open = more.length === next.text.trimEnd().length;
    }
    return plainValue(text);
  }

  /** A quoted scalar that starts on `line` and may go on over the next lines: each is joined with a space, an empty line being a line break. */
  private quotedValue(first: string, quote: string, line: Line, offset: number): string {
    const acc: Quoted = { value: '', glue: false };
    let text = first;
    let start = 1;
    let from = line;
    let end = this.scanQuoted(text, start, quote, acc, line, offset);
    while (end < 0) {
      let pending = 0;
      let next = this.lines[this.at];
      while (next !== undefined && blank(next)) next = this.lines[this.at + ++pending];
      if (next === undefined) this.fail(line, offset, 'a quoted value is never closed');
      this.at += pending + 1;
      acc.value += pending > 0 ? '\n'.repeat(pending) : acc.glue ? '' : ' ';
      acc.glue = false;
      text = next.text.trim();
      start = 0;
      from = next;
      end = this.scanQuoted(text, start, quote, acc, next, 0);
      if (acc.value.length > this.limits.maxChars) this.fail(line, offset, 'a quoted value is too long');
    }
    const after = text.slice(end);
    if (after.trim() !== '' && !/^\s+#/.test(after)) this.fail(from, end, 'unexpected text after the closing quote');
    return acc.value;
  }

  /**
   * Reads a quoted scalar from `start` (after the opening quote) into `acc`: returns the index after the closing quote, or -1 when the line ends
   * first (the scalar goes on over the next line).
   */
  private scanQuoted(text: string, start: number, quote: string, acc: Quoted, line: Line, column: number): number {
    let at = start;
    while (at < text.length) {
      const char = text[at] as string;
      if (char === quote) {
        if (quote === "'" && text[at + 1] === "'") { acc.value += "'"; at += 2; continue; }
        return at + 1;
      }
      if (quote === '"' && char === '\\') {
        const code = text[at + 1];
        if (code === undefined) { acc.glue = true; return -1; }
        const simple = ESCAPES[code];
        if (simple !== undefined) { acc.value += simple; at += 2; continue; }
        const digits = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
        const hex = digits > 0 ? text.slice(at + 2, at + 2 + digits) : '';
        if (digits === 0 || hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) throw new Syntax(line.n, line.indent + column + at + 1, `unsupported escape \\${code}`);
        const point = parseInt(hex, 16);
        if (point > 0x10ffff) throw new Syntax(line.n, line.indent + column + at + 1, 'a code point above U+10FFFF');
        acc.value += String.fromCodePoint(point);
        at += 2 + digits;
        continue;
      }
      acc.value += char;
      at++;
    }
    return -1;
  }

  /** A `|` or `>` scalar: the lines under the key that are indented more than `parent`. */
  private blockScalar(header: string, line: Line, offset: number, parent: number): string {
    const parts = /^([|>])([-+]?)([1-9]?)([-+]?)\s*(?:#.*)?$/.exec(header);
    if (parts === null) this.fail(line, offset, 'a block scalar header is "|" or ">", with at most a chomping sign and an indent digit');
    const folded = parts[1] === '>';
    const chomp = parts[2] !== '' ? parts[2] : parts[4];
    const start = this.at;
    let first = start;
    while (first < this.lines.length && blank(this.lines[first] as Line)) first++;
    const head = this.lines[first];
    const explicit = parts[3] !== '' ? (parts[3] as string).charCodeAt(0) - 48 : 0;
    const blockIndent = explicit > 0 ? Math.max(parent, 0) + explicit : head === undefined ? 0 : head.indent;
    if (head === undefined || head.indent <= parent || blockIndent <= parent) {
      this.at = first;
      return chomp === '+' ? '\n'.repeat(first - start) : '';
    }
    const content: string[] = [];
    let end = start;
    while (end < this.lines.length) {
      const next = this.lines[end] as Line;
      if (blank(next)) content.push(next.indent > blockIndent ? ' '.repeat(next.indent - blockIndent) : '');
      else if (next.indent >= blockIndent) content.push(' '.repeat(next.indent - blockIndent) + next.text);
      else break;
      end++;
    }
    this.at = end;
    let trailing = 0;
    while (content.length > 0 && (content[content.length - 1] as string).trim() === '') { content.pop(); trailing++; }
    let text = '';
    if (!folded) text = content.join('\n');
    else {
      // Lines are joined with a space, an empty line is a line break, and a line that is indented more keeps its breaks (and the break before the empty
      // lines that come before it, and after it: folding does not apply around a line that begins with white space).
      for (let index = 0; index < content.length; index++) {
        const current = content[index] as string;
        if (current === '') { text += '\n'; continue; }
        if (index === 0) { text = current; continue; }
        const previous = content[index - 1] as string;
        if (previous === '') {
          let back = index - 1;
          while (back >= 0 && content[back] === '') back--;
          const before = back >= 0 ? (content[back] as string) : undefined;
          text += before !== undefined && (current.startsWith(' ') || before.startsWith(' ')) ? `\n${current}` : current;
        } else text += current.startsWith(' ') || previous.startsWith(' ') ? `\n${current}` : ` ${current}`;
      }
    }
    if (chomp === '-') return text;
    if (text === '' && chomp !== '+') return '';
    return chomp === '+' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`;
  }

  /** A flow collection that starts on `line` and may go on over the next lines until its brackets are closed. */
  private flowValue(first: string, line: Line, offset: number, depth: number): LooseValue {
    let source = '';
    let state: FlowState = { depth: 0, quote: '', escaped: false };
    let text = first;
    for (;;) {
      const scanned = scanFlowLine(text, state);
      source += (source === '' ? '' : '\n') + scanned.text;
      state = scanned.state;
      if (state.depth === 0 && state.quote === '') {
        if (scanned.after.trim() !== '' && !/^\s*#/.test(scanned.after)) this.fail(line, offset, 'unexpected text after the end of the collection');
        break;
      }
      let next = this.lines[this.at];
      while (next !== undefined && (blank(next) || comment(next))) next = this.lines[++this.at];
      if (next === undefined) this.fail(line, offset, 'a collection is never closed');
      text = next.text;
      this.at++;
      if (source.length > this.limits.maxChars) this.fail(line, offset, 'a collection is too long');
    }
    const flow = new Flow(source, line, offset, depth, this.limits, () => this.node(line));
    const value = flow.value();
    this.duplicates += flow.duplicates;
    return value;
  }
}

/** What a flow collection that is read line by line has open at the end of a line: how deep, and whether it is inside a quote. */
interface FlowState { depth: number; quote: '' | '"' | "'"; escaped: boolean }

/** One line of a flow collection: its text without the comment, what follows the closing bracket, and what the line leaves open. */
function scanFlowLine(text: string, from: FlowState): { text: string; after: string; state: FlowState } {
  let { depth, quote, escaped } = from;
  let end = text.length;
  let after = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string;
    if (quote !== '') {
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (char === quote) {
        if (quote === "'" && text[at + 1] === "'") { at++; continue; }
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      // A quote opens a quoted scalar only at the start of a scalar, not inside a plain one (`it's`).
      const before = at === 0 ? ' ' : (text[at - 1] as string);
      if (/[\s,[\]{}:]/.test(before)) quote = char;
    } else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) { end = at + 1; after = text.slice(at + 1); break; }
    } else if (char === '#' && (at === 0 || /\s/.test(text[at - 1] as string))) { end = at; break; }
  }
  return { text: text.slice(0, end), after, state: { depth, quote, escaped } };
}

/** The reader of the text of a flow collection that has been gathered: comments taken off, the lines joined with line breaks. */
class Flow {
  duplicates = 0;
  private at = 0;

  constructor(private readonly text: string, private readonly line: Line, private readonly offset: number, private readonly depthStart: number, private readonly limits: LooseLimits, private readonly count: () => void) {}

  private fail(message: string): never {
    throw new Syntax(this.line.n, this.line.indent + this.offset + this.at + 1, message);
  }

  private skip(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at] as string)) this.at++;
  }

  value(): LooseValue {
    const result = this.node(this.depthStart + 1);
    this.skip();
    if (this.at < this.text.length) this.fail('unexpected text after the end of the collection');
    return result;
  }

  private node(depth: number): LooseValue {
    if (depth > this.limits.maxDepth) this.fail(`nested more than ${this.limits.maxDepth} levels`);
    this.skip();
    this.count();
    const char = this.text[this.at];
    if (char === '[') return this.sequence(depth);
    if (char === '{') return this.mapping(depth);
    return this.scalar(false);
  }

  /** Whether the colon at `at` ends a key: it is followed by a space, a line break, a flow indicator or the end. */
  private colonEnds(at: number): boolean {
    const next = this.text[at + 1];
    return next === undefined || /[\s,\]}]/.test(next);
  }

  private sequence(depth: number): LooseValue {
    this.at++;
    const items: LooseValue[] = [];
    for (;;) {
      this.skip();
      const char = this.text[this.at];
      if (char === undefined) this.fail('a list is never closed');
      if (char === ']') { this.at++; return items; }
      if (char === ',') this.fail('an item is missing before the comma');
      let item = this.node(depth + 1);
      this.skip();
      // `[a: 1]` is a list with one mapping of one entry.
      if (this.text[this.at] === ':' && this.colonEnds(this.at)) {
        this.at++;
        const map = object();
        this.skip();
        map[String(item)] = this.node(depth + 1);
        item = map;
      }
      items.push(item);
      this.skip();
      if (this.text[this.at] === ',') this.at++;
      else if (this.text[this.at] !== ']') this.fail('expected "," or "]"');
    }
  }

  private mapping(depth: number): LooseValue {
    this.at++;
    const map = object();
    for (;;) {
      this.skip();
      const char = this.text[this.at];
      if (char === undefined) this.fail('a mapping is never closed');
      if (char === '}') { this.at++; return map; }
      if (char === ',') this.fail('an entry is missing before the comma');
      if (char === '[' || char === '{') this.fail('a collection cannot be a key');
      this.count();
      const name = String(this.scalar(true));
      this.skip();
      let value: LooseValue = null;
      if (this.text[this.at] === ':') {
        this.at++;
        this.skip();
        const next = this.text[this.at];
        if (next !== ',' && next !== '}') value = this.node(depth + 1);
      }
      if (Object.hasOwn(map, name)) this.duplicates++;
      map[name] = value;
      this.skip();
      if (this.text[this.at] === ',') this.at++;
      else if (this.text[this.at] !== '}') this.fail('expected "," or "}"');
    }
  }

  /** A quoted or a plain scalar of a flow collection; a key (`asKey`) is the text as it is, not a number or a flag. */
  private scalar(asKey: boolean): LooseValue {
    const first = this.text[this.at];
    if (first === '"' || first === "'") return this.quoted(first);
    if (first === '&') this.fail('anchors (&) are not supported');
    if (first === '*') this.fail('aliases (*) are not supported');
    if (first === '!') this.fail('tags (!) are not supported');
    const start = this.at;
    while (this.at < this.text.length) {
      const char = this.text[this.at] as string;
      if (char === ',' || char === ']' || char === '}' || char === '[' || char === '{') break;
      if (char === ':' && this.colonEnds(this.at)) break;
      this.at++;
    }
    const raw = this.text.slice(start, this.at).replace(/\s*\n\s*/g, ' ').trim();
    return asKey ? raw : plainValue(raw);
  }

  private quoted(quote: string): string {
    let value = '';
    this.at++;
    for (;;) {
      const char = this.text[this.at];
      if (char === undefined) this.fail('a quoted value is never closed');
      if (char === quote) {
        if (quote === "'" && this.text[this.at + 1] === "'") { value += "'"; this.at += 2; continue; }
        this.at++;
        return value;
      }
      if (quote === '"' && char === '\\') {
        const code = this.text[this.at + 1];
        if (code === undefined) this.fail('a backslash at the end');
        const simple = ESCAPES[code];
        if (simple !== undefined) { value += simple; this.at += 2; continue; }
        const digits = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
        const hex = digits > 0 ? this.text.slice(this.at + 2, this.at + 2 + digits) : '';
        if (digits === 0 || hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) this.fail(`unsupported escape \\${code}`);
        const point = parseInt(hex, 16);
        if (point > 0x10ffff) this.fail('a code point above U+10FFFF');
        value += String.fromCodePoint(point);
        this.at += 2 + digits;
        continue;
      }
      // A line break inside a quote is folded to a space.
      value += char === '\n' ? ' ' : char;
      this.at++;
    }
  }
}
