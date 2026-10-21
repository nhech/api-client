import { DEFAULT_YAML_LIMITS, type YamlLimits, type YamlResult, type YMap, type YValue } from './types';

/**
 * Reads the YAML subset of the client's files. It is strict on purpose: a file is data from a repository somebody may have
 * cloned, so there are no anchors, aliases, tags, directives, flow collections (but `[]` and `{}`), folded scalars, multi-line
 * plain or quoted scalars, duplicate keys, tabs in indentation or documents. Comments are read and dropped. Every scalar is a
 * string. The work is linear in the size of the text and the nesting, the size and the number of nodes are limited.
 */
class Syntax extends Error {
  constructor(readonly line: number, readonly column: number, message: string) { super(message); }
}

interface Line {
  /** From 1. */
  n: number;
  /** The spaces at the start of the line. */
  indent: number;
  /** The line without them. */
  text: string;
  /** The whole line. */
  raw: string;
}

/** C0 controls except tab, DEL, and the line separators of YAML that an editor would show as line breaks (NEL, LS, PS). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0085\u2028\u2029]/;
/** What cannot start a plain scalar or a plain key. */
const INDICATORS = "-?:,[]{}#&*!|>'\"%@`";
const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', '/': '/', '0': '\0', b: '\b', t: '\t', n: '\n', f: '\f', r: '\r' };

export function parseYaml(text: string, limits: YamlLimits = DEFAULT_YAML_LIMITS): YamlResult {
  try {
    return { ok: true, value: new Parser(text, limits).document() };
  } catch (error) {
    if (error instanceof Syntax) return { ok: false, error: { line: error.line, column: error.column, message: error.message } };
    throw error;
  }
}

const isSequenceEntry = (text: string): boolean => text === '-' || text.startsWith('- ');
const isBlank = (line: Line): boolean => line.text.trim() === '';
/** The text without a trailing comment (a `#` at the start or after a space), without trailing spaces. */
const withoutComment = (text: string): string => {
  const at = text.search(/(?:^|\s)#/);
  return (at < 0 ? text : text.slice(0, at)).trimEnd();
};

class Parser {
  private readonly lines: Line[] = [];
  private at = 0;
  private nodes = 0;

  constructor(text: string, private readonly limits: YamlLimits) {
    // A UTF-16 unit takes at least one byte, so a text with more units than the limit is too large without encoding it.
    if (text.length > limits.maxBytes || (text.length * 3 > limits.maxBytes && new TextEncoder().encode(text).length > limits.maxBytes)) {
      throw new Syntax(1, 1, `the text is larger than ${limits.maxBytes} bytes`);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raws = text.split('\n');
    // The line break that ends the last line does not start another one.
    if (raws[raws.length - 1] === '') raws.pop();
    for (let index = 0; index < raws.length; index++) {
      let raw = raws[index] ?? '';
      if (raw.endsWith('\r')) raw = raw.slice(0, -1);
      const lone = raw.indexOf('\r');
      if (lone >= 0) throw new Syntax(index + 1, lone + 1, 'a carriage return that is not part of a line break');
      const control = CONTROL.exec(raw);
      if (control) throw new Syntax(index + 1, control.index + 1, 'a control character; write it as an escape in double quotes');
      let indent = 0;
      while (raw.charCodeAt(indent) === 32) indent++;
      if (indent === 0 && /^(?:---|\.\.\.)(?:\s|$)/.test(raw)) throw new Syntax(index + 1, 1, 'document markers are not supported: a file holds one document');
      this.lines.push({ n: index + 1, indent, text: raw.slice(indent), raw });
    }
  }

  document(): YValue {
    this.skipBlank();
    if (this.at >= this.lines.length) return new Map();
    const first = this.structural();
    if (first.indent !== 0) this.fail(first, 0, 'the first line must start at the left margin');
    const lone = withoutComment(first.text);
    let value: YValue;
    if (lone === '{}' || lone === '[]') {
      this.at++;
      value = lone === '{}' ? new Map() : [];
    } else {
      value = this.block(0, 1);
    }
    this.skipBlank();
    if (this.at < this.lines.length) {
      const extra = this.structural();
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
      if (isBlank(line) || line.text.charCodeAt(0) === 35) this.at++;
      else break;
    }
  }

  /** The current line, which must hold structure: tabs cannot indent. */
  private structural(): Line {
    const line = this.lines[this.at] as Line;
    if (line.text.charCodeAt(0) === 9) this.fail(line, 0, 'a tab cannot indent a line; use spaces');
    return line;
  }

  private block(indent: number, depth: number): YValue {
    if (depth > this.limits.maxDepth) this.fail(this.structural(), 0, `nested more than ${this.limits.maxDepth} levels`);
    return isSequenceEntry(this.structural().text) ? this.sequence(indent, depth) : this.mapping(indent, depth);
  }

  private mapping(indent: number, depth: number): YMap {
    const map: YMap = new Map();
    for (;;) {
      this.skipBlank();
      if (this.at >= this.lines.length) break;
      const line = this.structural();
      if (line.indent < indent) break;
      if (line.indent > indent) this.fail(line, 0, 'this line is indented more than the key above it');
      if (isSequenceEntry(line.text)) this.fail(line, 0, 'a list item where a key was expected');
      const entry = this.splitEntry(line);
      if (entry === undefined) this.fail(line, 0, 'expected "key: value"');
      if (map.has(entry.key)) this.fail(line, 0, `the key "${entry.key}" appears twice`);
      this.node(line);
      this.at++;
      map.set(entry.key, this.valueAfterColon(entry.rest, line, entry.restOffset, indent, depth));
    }
    return map;
  }

  private sequence(indent: number, depth: number): YValue[] {
    const items: YValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.at >= this.lines.length) break;
      const line = this.structural();
      if (line.indent !== indent || !isSequenceEntry(line.text)) {
        if (line.indent > indent) this.fail(line, 0, 'this line is indented more than the list item above it');
        break;
      }
      this.node(line);
      const after = line.text === '-' ? '' : line.text.slice(2);
      const spaces = after.length - after.trimStart().length;
      const rest = after.trimStart();
      const column = indent + 2 + spaces;
      this.at++;
      if (rest === '' || rest.charCodeAt(0) === 35) {
        this.skipBlank();
        const next = this.at < this.lines.length ? this.structural() : undefined;
        items.push(next !== undefined && next.indent > indent ? this.block(next.indent, depth + 1) : '');
      } else if (isSequenceEntry(rest)) {
        this.fail(line, column - line.indent, 'a list inside a list is not supported');
      } else if (this.splitEntry({ ...line, indent: column, text: rest }) !== undefined) {
        // `- key: value`: the item is a mapping whose keys start at the column of the first one.
        this.lines[--this.at] = { ...line, indent: column, text: rest, raw: ' '.repeat(column) + rest };
        items.push(this.mapping(column, depth + 1));
      } else {
        items.push(this.inlineScalar(rest, line, column - line.indent));
      }
    }
    return items;
  }

  /** `key: rest`, or undefined when the line is not an entry. */
  private splitEntry(line: Line): { key: string; rest: string; restOffset: number } | undefined {
    const text = line.text;
    const first = text[0] ?? '';
    if (first === '"' || first === "'") {
      const quoted = this.scanQuoted(text, 0, line, line.indent);
      let at = quoted.end;
      while (text[at] === ' ') at++;
      if (text[at] !== ':' || (at + 1 < text.length && text[at + 1] !== ' ')) return undefined;
      return { key: quoted.value, rest: text.slice(at + 1), restOffset: at + 1 };
    }
    if (INDICATORS.includes(first)) return undefined;
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

  private valueAfterColon(rest: string, line: Line, restOffset: number, indent: number, depth: number): YValue {
    const trimmed = rest.trimStart();
    const offset = restOffset + (rest.length - trimmed.length);
    if (trimmed === '' || trimmed.charCodeAt(0) === 35) {
      this.skipBlank();
      const next = this.at < this.lines.length ? this.structural() : undefined;
      if (next !== undefined && next.indent > indent) return this.block(next.indent, depth + 1);
      if (next !== undefined && next.indent === indent && isSequenceEntry(next.text)) return this.sequence(indent, depth + 1);
      return '';
    }
    if (trimmed.charCodeAt(0) === 124) return this.blockScalar(trimmed, line, offset, indent);
    if (isSequenceEntry(trimmed)) this.fail(line, offset, 'a list item cannot follow a key on the same line');
    return this.inlineScalar(trimmed, line, offset);
  }

  /** A `|`, `|-` or `|+` scalar: the lines under the key that are indented more than the key. */
  private blockScalar(header: string, line: Line, offset: number, indent: number): string {
    const parts = /^\|([+-]?)\s*(?:#.*)?$/.exec(header);
    if (parts === null) this.fail(line, offset, 'only "|", "|-" and "|+" block scalars are supported');
    const chomp = parts[1] ?? '';
    const start = this.at;
    let first = start;
    while (first < this.lines.length && isBlank(this.lines[first] as Line)) first++;
    const head = this.lines[first];
    if (head === undefined || head.indent <= indent) {
      this.at = first;
      return chomp === '+' ? '\n'.repeat(first - start) : '';
    }
    const blockIndent = head.indent;
    const content: string[] = [];
    let end = start;
    while (end < this.lines.length) {
      const next = this.lines[end] as Line;
      if (isBlank(next)) content.push('');
      else if (next.indent >= blockIndent) content.push(next.raw.slice(blockIndent));
      else break;
      end++;
    }
    this.at = end;
    this.node(line);
    let trailing = 0;
    while (content.length > 0 && content[content.length - 1] === '') { content.pop(); trailing++; }
    const text = content.join('\n');
    if (chomp === '-') return text;
    return chomp === '+' ? `${text}\n${'\n'.repeat(trailing)}` : `${text}\n`;
  }

  private inlineScalar(text: string, line: Line, offset: number): YValue {
    this.node(line);
    const first = text[0] ?? '';
    if (first === "'" || first === '"') {
      const quoted = this.scanQuoted(text, 0, line, line.indent + offset);
      const after = text.slice(quoted.end);
      if (after.trim() !== '' && !/^\s+#/.test(after)) this.fail(line, offset + quoted.end, 'unexpected text after the closing quote');
      return quoted.value;
    }
    const plain = withoutComment(text);
    if (plain === '[]') return [];
    if (plain === '{}') return new Map();
    const problem = this.plainProblem(first, plain);
    if (problem !== undefined) this.fail(line, offset, problem);
    return plain;
  }

  private plainProblem(first: string, plain: string): string | undefined {
    if (first === '[' || first === '{') return 'flow collections are not supported; write a block (only [] and {} for an empty one)';
    if (first === '&') return 'anchors are not supported';
    if (first === '*') return 'aliases are not supported';
    if (first === '!') return 'tags are not supported';
    if (first === '>') return 'folded block scalars are not supported';
    if (first === '|') return 'a block scalar is supported only as the value of a key';
    if (first === '%' || first === '@' || first === '`') return `a value cannot start with "${first}"; put it in quotes`;
    if (first === '?' || first === ':' || first === ',' || first === ']' || first === '}') return `a value cannot start with "${first}"; put it in quotes`;
    if (plain.includes(': ') || plain.endsWith(':')) return 'a plain value cannot contain ": "; put it in quotes';
    return undefined;
  }

  /** A quoted scalar that starts at `start` and ends on the same line; `column` is where the text starts on the line. */
  private scanQuoted(text: string, start: number, line: Line, column: number): { value: string; end: number } {
    const quote = text[start] as string;
    let value = '';
    let at = start + 1;
    for (;;) {
      if (at >= text.length) throw new Syntax(line.n, column + start + 1, 'a quoted value must end on the same line; use a block scalar for several lines');
      const char = text[at] as string;
      if (char === quote) {
        if (quote === "'" && text[at + 1] === "'") { value += "'"; at += 2; continue; }
        return { value, end: at + 1 };
      }
      if (quote === '"' && char === '\\') {
        const code = text[at + 1];
        if (code === undefined) throw new Syntax(line.n, column + at + 1, 'a backslash at the end of the line');
        const simple = ESCAPES[code];
        if (simple !== undefined) { value += simple; at += 2; continue; }
        const digits = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
        const hex = digits > 0 ? text.slice(at + 2, at + 2 + digits) : '';
        if (digits === 0 || hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) throw new Syntax(line.n, column + at + 1, `unsupported escape \\${code}`);
        const point = parseInt(hex, 16);
        if (point > 0x10ffff) throw new Syntax(line.n, column + at + 1, 'a code point above U+10FFFF');
        value += String.fromCodePoint(point);
        at += 2 + digits;
        continue;
      }
      value += char;
      at++;
    }
  }
}
