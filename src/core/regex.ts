/**
 * A regular expression engine that cannot take exponential time. The patterns of a test come from a collection that may be somebody
 * else's, and the engine of Node has no time limit, so a pattern such as (a+)+$ on a long enough text would freeze the editor. This
 * one reads a subset of the syntax of JavaScript (literals, ., classes, \d \w \s and their negations, \b, ^ $, groups, alternation and
 * the quantifiers * + ? {n} {n,} {n,m}) and runs it as a Thompson automaton: the time is the size of the text times the size of the
 * pattern, whatever the pattern. What cannot be run in that time (a back-reference, a look-around) is refused with a message.
 *
 * It answers one question: does the pattern match somewhere in the text. Flags: i (ignore case), m (^ and $ at every line), s (. matches
 * a line break).
 */
export interface RegexFlags {
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
}

export const REGEX_LIMITS = { patternChars: 2000, programSize: 20_000, textChars: 2 * 1024 * 1024, repeatCount: 1000 } as const;

type Node =
  | { t: 'char'; c: number }
  | { t: 'any' }
  | { t: 'class'; negate: boolean; ranges: [number, number][] }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'boundary'; negate: boolean }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number };

export class RegexError extends Error {}

const DIGIT: [number, number][] = [[0x30, 0x39]];
const WORD: [number, number][] = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
const SPACE: [number, number][] = [[0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];

const complement = (ranges: [number, number][]): [number, number][] => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0x10ffff) out.push([next, 0x10ffff]);
  return out;
};

class Parser {
  private at = 0;
  private readonly points: number[];
  constructor(private readonly source: string) {
    this.points = Array.from(source, char => char.codePointAt(0) ?? 0);
  }

  private peek(): number | undefined { return this.points[this.at]; }
  private is(char: string): boolean { return this.points[this.at] === char.codePointAt(0); }
  private take(): number { return this.points[this.at++] as number; }

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.points.length) throw new RegexError(this.is(')') ? 'there is a ) with no ( before it' : 'the pattern could not be read');
    return node;
  }

  private alternation(): Node {
    const items: Node[] = [this.sequence()];
    while (this.is('|')) { this.at++; items.push(this.sequence()); }
    return items.length === 1 ? (items[0] as Node) : { t: 'alt', items };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.at < this.points.length && !this.is('|') && !this.is(')')) items.push(this.quantified());
    return items.length === 1 ? (items[0] as Node) : { t: 'cat', items };
  }

  private quantified(): Node {
    const atom = this.atom();
    let node = atom;
    for (;;) {
      const c = this.peek();
      let min: number;
      let max: number;
      if (c === 0x2a) { min = 0; max = Infinity; this.at++; }
      else if (c === 0x2b) { min = 1; max = Infinity; this.at++; }
      else if (c === 0x3f) { min = 0; max = 1; this.at++; }
      else if (c === 0x7b) {
        const range = this.braces();
        if (range === undefined) return node;
        [min, max] = range;
      } else return node;
      if (node.t === 'bol' || node.t === 'eol' || node.t === 'boundary') throw new RegexError('an anchor cannot be repeated');
      if (this.is('?')) this.at++; // lazy: the same answer to "does it match"
      node = { t: 'rep', node, min, max };
    }
  }

  /** {n}, {n,} or {n,m}; undefined (and nothing consumed) when what follows the brace is not a count, so that it is a plain brace. */
  private braces(): [number, number] | undefined {
    const rest = this.points.slice(this.at).map(point => String.fromCodePoint(point)).join('');
    const match = /^\{(\d{1,4})(?:(,)(\d{0,4}))?\}/.exec(rest);
    if (match === null) return undefined;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
    if (min > REGEX_LIMITS.repeatCount || (max !== Infinity && max > REGEX_LIMITS.repeatCount)) throw new RegexError(`a repeat count is limited to ${REGEX_LIMITS.repeatCount}`);
    if (max < min) throw new RegexError('a repeat count that goes from more to less');
    this.at += match[0].length;
    return [min, max];
  }

  private atom(): Node {
    const c = this.take();
    if (c === 0x28) return this.group();
    if (c === 0x5b) return this.characterClass();
    if (c === 0x2e) return { t: 'any' };
    if (c === 0x5e) return { t: 'bol' };
    if (c === 0x24) return { t: 'eol' };
    if (c === 0x5c) return this.escape(false);
    if (c === 0x2a || c === 0x2b || c === 0x3f) throw new RegexError('a quantifier with nothing before it');
    return { t: 'char', c };
  }

  private group(): Node {
    if (this.is('?')) {
      this.at++;
      if (this.is(':')) this.at++;
      else throw new RegexError('look-around, named groups and the like are not supported (they cannot be run in bounded time)');
    }
    const inner = this.alternation();
    if (!this.is(')')) throw new RegexError('a ( that is never closed');
    this.at++;
    // A group is a node of its own: a group around an anchor can be repeated, an anchor alone cannot.
    return { t: 'cat', items: [inner] };
  }

  /** What follows a backslash, inside a class or outside. */
  private escape(inClass: boolean): Node {
    if (this.at >= this.points.length) throw new RegexError('a pattern cannot end with a backslash');
    const c = this.take();
    const letter = String.fromCodePoint(c);
    switch (letter) {
      case 'd': return { t: 'class', negate: false, ranges: DIGIT };
      case 'D': return { t: 'class', negate: true, ranges: DIGIT };
      case 'w': return { t: 'class', negate: false, ranges: WORD };
      case 'W': return { t: 'class', negate: true, ranges: WORD };
      case 's': return { t: 'class', negate: false, ranges: SPACE };
      case 'S': return { t: 'class', negate: true, ranges: SPACE };
      case 'b': return inClass ? { t: 'char', c: 0x08 } : { t: 'boundary', negate: false };
      case 'B': if (inClass) throw new RegexError('\\B inside a class'); return { t: 'boundary', negate: true };
      case 'n': return { t: 'char', c: 0x0a };
      case 'r': return { t: 'char', c: 0x0d };
      case 't': return { t: 'char', c: 0x09 };
      case 'f': return { t: 'char', c: 0x0c };
      case 'v': return { t: 'char', c: 0x0b };
      case '0': return { t: 'char', c: 0 };
      case 'x': return this.hex(2);
      case 'u': return this.unicode();
      case 'p': case 'P': case 'k': throw new RegexError(`\\${letter} is not supported`);
      default:
        if (c >= 0x31 && c <= 0x39) throw new RegexError('a back-reference cannot be run in bounded time, so it is not supported');
        return { t: 'char', c };
    }
  }

  private hex(count: number): Node {
    let value = 0;
    for (let index = 0; index < count; index++) {
      const digit = this.at < this.points.length ? parseInt(String.fromCodePoint(this.take()), 16) : Number.NaN;
      if (Number.isNaN(digit)) throw new RegexError('a hexadecimal escape that is not complete');
      value = value * 16 + digit;
    }
    return { t: 'char', c: value };
  }

  private unicode(): Node {
    if (this.is('{')) {
      this.at++;
      let value = 0;
      let digits = 0;
      while (this.at < this.points.length && !this.is('}')) {
        const digit = parseInt(String.fromCodePoint(this.take()), 16);
        if (Number.isNaN(digit) || ++digits > 6) throw new RegexError('a unicode escape that is not valid');
        value = value * 16 + digit;
      }
      if (!this.is('}') || digits === 0 || value > 0x10ffff) throw new RegexError('a unicode escape that is not valid');
      this.at++;
      return { t: 'char', c: value };
    }
    return this.hex(4);
  }

  private characterClass(): Node {
    let negate = false;
    if (this.is('^')) { negate = true; this.at++; }
    const ranges: [number, number][] = [];
    for (;;) {
      if (this.at >= this.points.length) throw new RegexError('a [ that is never closed');
      if (this.is(']')) { this.at++; break; }
      const low = this.classMember();
      if (low.kind === 'set') { ranges.push(...low.ranges); continue; }
      if (this.is('-') && this.points[this.at + 1] !== undefined && this.points[this.at + 1] !== 0x5d) {
        this.at++;
        const high = this.classMember();
        if (high.kind === 'set') { ranges.push([low.c, low.c], [0x2d, 0x2d], ...high.ranges); continue; }
        if (high.c < low.c) throw new RegexError('a range in a class that goes from more to less');
        ranges.push([low.c, high.c]);
      } else ranges.push([low.c, low.c]);
    }
    return { t: 'class', negate, ranges };
  }

  private classMember(): { kind: 'char'; c: number } | { kind: 'set'; ranges: [number, number][] } {
    const c = this.take();
    if (c !== 0x5c) return { kind: 'char', c };
    const node = this.escape(true);
    if (node.t === 'char') return { kind: 'char', c: node.c };
    if (node.t === 'class') return { kind: 'set', ranges: node.negate ? complement(node.ranges) : node.ranges };
    throw new RegexError('that escape cannot be used in a class');
  }
}

// ---- the automaton ----

type Instruction =
  | { op: 'char'; c: number }
  | { op: 'any' }
  | { op: 'class'; negate: boolean; ranges: [number, number][] }
  | { op: 'split'; a: number; b: number }
  | { op: 'jump'; to: number }
  | { op: 'bol' }
  | { op: 'eol' }
  | { op: 'boundary'; negate: boolean }
  | { op: 'match' };

function compile(root: Node): Instruction[] {
  const program: Instruction[] = [];
  const emit = (instruction: Instruction): number => {
    if (program.length >= REGEX_LIMITS.programSize) throw new RegexError('the pattern is too large');
    program.push(instruction);
    return program.length - 1;
  };
  const build = (node: Node): void => {
    switch (node.t) {
      case 'char': emit({ op: 'char', c: node.c }); break;
      case 'any': emit({ op: 'any' }); break;
      case 'class': emit({ op: 'class', negate: node.negate, ranges: node.ranges }); break;
      case 'bol': emit({ op: 'bol' }); break;
      case 'eol': emit({ op: 'eol' }); break;
      case 'boundary': emit({ op: 'boundary', negate: node.negate }); break;
      case 'cat': for (const item of node.items) build(item); break;
      case 'alt': {
        const jumps: number[] = [];
        for (let index = 0; index < node.items.length; index++) {
          if (index < node.items.length - 1) {
            const split = emit({ op: 'split', a: 0, b: 0 });
            (program[split] as { a: number }).a = program.length;
            build(node.items[index] as Node);
            jumps.push(emit({ op: 'jump', to: 0 }));
            (program[split] as { b: number }).b = program.length;
          } else build(node.items[index] as Node);
        }
        for (const jump of jumps) (program[jump] as { to: number }).to = program.length;
        break;
      }
      case 'rep': {
        for (let index = 0; index < node.min; index++) build(node.node);
        if (node.max === Infinity) {
          const split = emit({ op: 'split', a: 0, b: 0 });
          (program[split] as { a: number }).a = program.length;
          build(node.node);
          emit({ op: 'jump', to: split });
          (program[split] as { b: number }).b = program.length;
        } else {
          const splits: number[] = [];
          for (let index = node.min; index < node.max; index++) {
            const split = emit({ op: 'split', a: 0, b: 0 });
            (program[split] as { a: number }).a = program.length;
            splits.push(split);
            build(node.node);
          }
          for (const split of splits) (program[split] as { b: number }).b = program.length;
        }
        break;
      }
    }
  };
  build(root);
  emit({ op: 'match' });
  return program;
}

const isWordChar = (c: number | undefined): boolean => c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a));
const isLineBreak = (c: number | undefined): boolean => c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;

const foldCase = (c: number): number => {
  const lower = String.fromCodePoint(c).toLowerCase();
  return lower.length === String.fromCodePoint(c).length && lower.codePointAt(0) !== undefined ? (lower.codePointAt(0) as number) : c;
};
const upperCase = (c: number): number => {
  const upper = String.fromCodePoint(c).toUpperCase();
  return upper.length === String.fromCodePoint(c).length ? (upper.codePointAt(0) as number) : c;
};

export class CompiledRegex {
  private constructor(private readonly program: Instruction[], private readonly flags: RegexFlags) {}

  static compile(pattern: string, flags: Partial<RegexFlags> = {}): CompiledRegex {
    if (pattern.length > REGEX_LIMITS.patternChars) throw new RegexError(`a pattern is limited to ${REGEX_LIMITS.patternChars} characters`);
    const full: RegexFlags = { ignoreCase: flags.ignoreCase === true, multiline: flags.multiline === true, dotAll: flags.dotAll === true };
    return new CompiledRegex(compile(new Parser(pattern).parse()), full);
  }

  private inClass(instruction: Extract<Instruction, { op: 'class' }>, c: number): boolean {
    const test = (value: number): boolean => instruction.ranges.some(([low, high]) => value >= low && value <= high);
    const found = test(c) || (this.flags.ignoreCase && (test(foldCase(c)) || test(upperCase(c))));
    return found !== instruction.negate;
  }

  /** Whether the pattern matches anywhere in the text. */
  test(text: string): boolean {
    if (text.length > REGEX_LIMITS.textChars) throw new RegexError(`a text of more than ${REGEX_LIMITS.textChars} characters is not searched`);
    const input = Array.from(text, char => char.codePointAt(0) as number);
    const { program } = this;
    const size = program.length;
    let current = new Uint32Array(size);
    let next = new Uint32Array(size);
    let currentCount = 0;
    let nextCount = 0;
    const seen = new Int32Array(size).fill(-1);

    const add = (list: Uint32Array, count: number, pc: number, position: number): number => {
      // An explicit stack: a program of tens of thousands of instructions must not overflow the stack of the language.
      const stack = [pc];
      while (stack.length > 0) {
        const at = stack.pop() as number;
        if (seen[at] === position) continue;
        seen[at] = position;
        const instruction = program[at] as Instruction;
        if (instruction.op === 'jump') stack.push(instruction.to);
        else if (instruction.op === 'split') { stack.push(instruction.b); stack.push(instruction.a); }
        else if (instruction.op === 'bol') {
          if (position === 0 || (this.flags.multiline && isLineBreak(input[position - 1]))) stack.push(at + 1);
        } else if (instruction.op === 'eol') {
          if (position === input.length || (this.flags.multiline && isLineBreak(input[position]))) stack.push(at + 1);
        } else if (instruction.op === 'boundary') {
          const edge = isWordChar(input[position - 1]) !== isWordChar(input[position]);
          if (edge !== instruction.negate) stack.push(at + 1);
        } else list[count++] = at;
      }
      return count;
    };

    for (let position = 0; position <= input.length; position++) {
      // A new attempt can begin at every position (the match may be anywhere).
      currentCount = add(current, currentCount, 0, position);
      nextCount = 0;
      const c = input[position];
      for (let index = 0; index < currentCount; index++) {
        const instruction = program[current[index] as number] as Instruction;
        if (instruction.op === 'match') return true;
        if (c === undefined) continue;
        let advance = false;
        if (instruction.op === 'char') advance = instruction.c === c || (this.flags.ignoreCase && foldCase(instruction.c) === foldCase(c));
        else if (instruction.op === 'any') advance = this.flags.dotAll || !isLineBreak(c);
        else if (instruction.op === 'class') advance = this.inClass(instruction, c);
        if (advance) nextCount = add(next, nextCount, (current[index] as number) + 1, position + 1);
      }
      [current, next] = [next, current];
      currentCount = nextCount;
    }
    return false;
  }
}

/** The pattern and flags of a value written as /pattern/flags, or the whole text as the pattern when it is not written that way. */
export function splitRegexLiteral(text: string): { pattern: string; flags: Partial<RegexFlags> } {
  const match = /^\/([\s\S]*)\/([a-z]*)$/.exec(text);
  if (match === null) return { pattern: text, flags: {} };
  const letters = match[2] as string;
  for (const letter of letters) if (!'ims'.includes(letter)) throw new RegexError(`the flag "${letter}" is not supported (use i, m or s)`);
  if (new Set(letters).size !== letters.length) throw new RegexError('a flag is repeated');
  return { pattern: match[1] as string, flags: { ignoreCase: letters.includes('i'), multiline: letters.includes('m'), dotAll: letters.includes('s') } };
}
