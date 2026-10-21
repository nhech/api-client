import { parseSetCookie } from './cookies';
import { evaluateJsonPath, parseJsonPath, type ParsedPath } from './jsonpath';
import { CompiledRegex, RegexError, splitRegexLiteral } from './regex';
import { compareCodePoints } from '../util/chars';

/**
 * The tests and the captures of a request, written as one line each: `status == 200`, `json $.id exists`, `header content-type includes json`;
 * `token = json $.access_token`. They are read and run here, by code that knows the whole grammar and nothing else: a line that is not
 * in the grammar is a failed test with the reason, never something that is run. A regular expression goes through the engine of
 * src/core/regex.ts, which cannot take exponential time.
 */
export const ASSERT_LIMITS = { expressionChars: 2000, bodyChars: 5 * 1024 * 1024, shown: 80 } as const;

export type Compare = '==' | '!=' | '<' | '<=' | '>' | '>=';
type TextOperator = 'includes' | 'excludes' | 'startsWith' | 'endsWith' | 'matches';
type ShapeOperator = 'exists' | 'notExists' | 'isNumber' | 'isString' | 'isBoolean' | 'isArray' | 'isJson';
export type Operator = Compare | TextOperator | ShapeOperator | 'count';

export type Subject =
  | { kind: 'status' }
  | { kind: 'duration' }
  | { kind: 'body' }
  | { kind: 'header'; name: string }
  | { kind: 'json'; path: ParsedPath };

export interface ParsedAssertion {
  source: string;
  subject: Subject;
  op: Operator;
  /** For `count`: how the count is compared. */
  compare: Compare | undefined;
  /** The rest of the line; may hold {{variables}}. */
  expected: string;
}

const EXAMPLES: Record<Subject['kind'], string> = { status: 'status == 200', duration: 'duration < 500', body: 'body includes ok', header: 'header content-type includes json', json: 'json $.id exists' };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const COMPARES: readonly string[] = ['==', '!=', '<=', '>=', '<', '>'];
const TEXT_OPERATORS: readonly string[] = ['includes', 'excludes', 'startsWith', 'endsWith', 'matches'];
const SHAPE_OPERATORS: readonly string[] = ['exists', 'notExists', 'isNumber', 'isString', 'isBoolean', 'isArray', 'isJson'];

const ALLOWED: Record<Subject['kind'], readonly string[]> = {
  status: COMPARES,
  duration: COMPARES,
  body: [...COMPARES.filter(op => op === '==' || op === '!='), 'includes', 'excludes', 'startsWith', 'endsWith', 'matches', 'isJson'],
  header: [...COMPARES, ...TEXT_OPERATORS, 'exists', 'notExists'],
  json: [...COMPARES, ...TEXT_OPERATORS, 'exists', 'notExists', 'isNumber', 'isString', 'isBoolean', 'isArray', 'count']
};

/** The next word of the text from `at`; for a JSON path a word may hold spaces inside quotes and brackets. */
function word(text: string, at: number, path = false): { text: string; next: number } {
  let start = at;
  while (text[start] === ' ' || text[start] === '\t') start++;
  let end = start;
  let quote = '';
  let depth = 0;
  while (end < text.length) {
    const c = text[end] as string;
    if (quote !== '') { if (c === '\\') end++; else if (c === quote) quote = ''; }
    else if (path && (c === "'" || c === '"') && depth > 0) quote = c;
    else if (path && c === '[') depth++;
    else if (path && c === ']') depth = Math.max(0, depth - 1);
    else if ((c === ' ' || c === '\t') && depth === 0) break;
    end++;
  }
  return { text: text.slice(start, end), next: end };
}

export function parseAssertion(expression: string): Parsed<ParsedAssertion> {
  const source = expression.trim();
  const fail = (error: string): Parsed<ParsedAssertion> => ({ ok: false, error });
  if (source === '') return fail('a test cannot be empty');
  if (source.length > ASSERT_LIMITS.expressionChars) return fail(`a test is limited to ${ASSERT_LIMITS.expressionChars} characters`);
  const first = word(source, 0);
  let subject: Subject;
  let at = first.next;
  switch (first.text) {
    case 'status': subject = { kind: 'status' }; break;
    case 'duration': subject = { kind: 'duration' }; break;
    case 'body': subject = { kind: 'body' }; break;
    case 'header': {
      const name = word(source, at);
      if (name.text === '') return fail('header needs the name of a header: header content-type includes json');
      subject = { kind: 'header', name: name.text };
      at = name.next;
      break;
    }
    case 'json': {
      const raw = word(source, at, true);
      if (raw.text === '') return fail('json needs a path: json $.id exists');
      const path = parseJsonPath(raw.text);
      if (!path.ok) return fail(`json path: ${path.error}`);
      subject = { kind: 'json', path: path.value };
      at = raw.next;
      break;
    }
    default: return fail(`"${first.text.slice(0, 40)}" is not something to test: use status, duration, header NAME, body or json PATH`);
  }
  const operator = word(source, at);
  if (operator.text === '') return fail(`what should ${first.text} be? Add an operator, for example: ${EXAMPLES[subject.kind]}`);
  if (!ALLOWED[subject.kind].includes(operator.text)) return fail(`${subject.kind === 'header' ? 'header' : subject.kind} cannot be tested with "${operator.text.slice(0, 30)}": use ${ALLOWED[subject.kind].join(', ')}`);
  let compare: Compare | undefined;
  let rest = operator.next;
  if (operator.text === 'count') {
    const comparison = word(source, rest);
    if (!COMPARES.includes(comparison.text)) return fail('count needs a comparison: json $.items count == 3');
    compare = comparison.text as Compare;
    rest = comparison.next;
  }
  const expected = source.slice(rest).trim();
  const needsValue = !SHAPE_OPERATORS.includes(operator.text);
  if (needsValue && expected === '') return fail(`${operator.text === 'count' ? `count ${compare}` : operator.text} needs a value to compare with`);
  if (!needsValue && expected !== '') return fail(`${operator.text} takes no value, but "${expected.slice(0, 30)}" follows it`);
  const value: ParsedAssertion = { source, subject, op: operator.text as Operator, compare, expected };
  if (operator.text === 'matches' && !expected.includes('{{')) {
    try { const literal = splitRegexLiteral(expected); CompiledRegex.compile(literal.pattern, literal.flags); } catch (error) { return fail(error instanceof RegexError ? error.message : 'the pattern cannot be read'); }
  }
  return { ok: true, value };
}

// ---- running them ----

/** What a test can see of a response. */
export interface TestSubject {
  status: number;
  durationMs: number;
  headers: readonly (readonly [string, string])[];
  /** The body as text; undefined when there is none to read (not text, or too large), with `bodyNote` saying why. */
  body: string | undefined;
  bodyNote?: string;
}

export type Resolver = (text: string) => { text: string; unresolved: readonly string[] };

export interface TestResult {
  expr: string;
  /** Where the test is written: "request", or the name of a folder or collection. */
  from: string;
  ok: boolean;
  /** Why it failed, or empty. */
  message: string;
}

const numeric = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !/^\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s*$/.test(value)) return undefined;
  return Number(value);
};

function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index], depth + 1));
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key], depth + 1));
}

function show(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'nothing' : JSON.stringify(value) ?? String(value);
  return text.length > ASSERT_LIMITS.shown ? `${text.slice(0, ASSERT_LIMITS.shown - 3)}...` : text;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

function equal(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected;
  if (typeof actual === 'number') return numeric(expected) === actual;
  if (typeof actual === 'boolean') return expected === String(actual);
  if (actual === null) return expected === 'null';
  try { return deepEqual(actual, JSON.parse(expected)); } catch { return false; }
}

function ordered(actual: unknown, compare: Compare, expected: string): boolean | undefined {
  const left = numeric(actual);
  const right = numeric(expected);
  let order: number;
  if (left !== undefined && right !== undefined) order = left < right ? -1 : left > right ? 1 : 0;
  else if (left === undefined && right === undefined && typeof actual === 'string') order = compareCodePoints(actual, expected);
  // A number against a text that is not one: there is no order to speak of.
  else return undefined;
  return compare === '<' ? order < 0 : compare === '<=' ? order <= 0 : compare === '>' ? order > 0 : order >= 0;
}

const regexCache = new Map<string, CompiledRegex>();
function regexFor(text: string): CompiledRegex {
  let compiled = regexCache.get(text);
  if (compiled === undefined) {
    const literal = splitRegexLiteral(text);
    compiled = CompiledRegex.compile(literal.pattern, literal.flags);
    if (regexCache.size > 200) regexCache.clear();
    regexCache.set(text, compiled);
  }
  return compiled;
}

/** Whether one value passes a test of the text operators and comparisons; a sentence when it cannot be judged. */
function judge(actual: unknown, op: Operator, expected: string): { ok: boolean; note: string } {
  const verdict = (ok: boolean): { ok: boolean; note: string } => ({ ok, note: ok ? '' : `got ${show(actual)}` });
  switch (op) {
    case '==': return verdict(equal(actual, expected));
    case '!=': return verdict(!equal(actual, expected));
    case '<': case '<=': case '>': case '>=': {
      const result = ordered(actual, op, expected);
      return result === undefined ? { ok: false, note: `cannot compare ${show(actual)} with ${show(expected)}` } : verdict(result);
    }
    case 'includes': case 'excludes': {
      let found: boolean;
      if (Array.isArray(actual)) found = actual.some(item => equal(item, expected));
      else if (typeof actual === 'object' && actual !== null) found = Object.hasOwn(actual, expected);
      else found = textOf(actual).includes(expected);
      return verdict(op === 'includes' ? found : !found);
    }
    case 'startsWith': return verdict(textOf(actual).startsWith(expected));
    case 'endsWith': return verdict(textOf(actual).endsWith(expected));
    case 'matches': {
      try { return verdict(regexFor(expected).test(textOf(actual))); } catch (error) { return { ok: false, note: error instanceof RegexError ? error.message : 'the pattern cannot be run' }; }
    }
    case 'isNumber': return verdict(typeof actual === 'number');
    case 'isString': return verdict(typeof actual === 'string');
    case 'isBoolean': return verdict(typeof actual === 'boolean');
    case 'isArray': return verdict(Array.isArray(actual));
    default: return { ok: false, note: `${op} cannot be judged here` };
  }
}

export class Evaluator {
  private document: { ok: true; value: unknown } | { ok: false; error: string } | undefined;

  constructor(private readonly subject: TestSubject) {}

  private json(): { ok: true; value: unknown } | { ok: false; error: string } {
    if (this.document !== undefined) return this.document;
    const { body } = this.subject;
    if (body === undefined) this.document = { ok: false, error: this.subject.bodyNote ?? 'the response has no body to read' };
    else if (body.length > ASSERT_LIMITS.bodyChars) this.document = { ok: false, error: 'the body is too large to read as JSON' };
    else {
      try { this.document = { ok: true, value: JSON.parse(body) as unknown }; } catch { this.document = { ok: false, error: 'the body is not valid JSON' }; }
    }
    return this.document;
  }

  private header(name: string): string | undefined {
    const lower = name.toLowerCase();
    const values = this.subject.headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
    return values.length === 0 ? undefined : values.join(', ');
  }

  assertion(parsed: ParsedAssertion, resolve: Resolver, from: string): TestResult {
    const result = (ok: boolean, message = ''): TestResult => ({ expr: parsed.source, from, ok, message });
    const resolved = resolve(parsed.expected);
    if (resolved.unresolved.length > 0) return result(false, `the variable ${resolved.unresolved.join(', ')} has no value`);
    const expected = resolved.text;
    const { subject, op } = parsed;
    if (subject.kind === 'status' || subject.kind === 'duration') {
      const actual = subject.kind === 'status' ? this.subject.status : this.subject.durationMs;
      if (numeric(expected) === undefined) return result(false, `${show(expected)} is not a number`);
      const judged = judge(actual, op, expected);
      return result(judged.ok, judged.note);
    }
    if (subject.kind === 'header') {
      const actual = this.header(subject.name);
      if (op === 'exists') return result(actual !== undefined, actual === undefined ? `no header named ${subject.name}` : '');
      if (op === 'notExists') return result(actual === undefined, actual === undefined ? '' : `the header ${subject.name} is there`);
      if (actual === undefined) return result(false, `no header named ${subject.name}`);
      const judged = judge(actual, op, expected);
      return result(judged.ok, judged.note);
    }
    if (subject.kind === 'body') {
      if (this.subject.body === undefined) return result(false, this.subject.bodyNote ?? 'the response has no body to read');
      if (op === 'isJson') { const document = this.json(); return result(document.ok, document.ok ? '' : document.error); }
      const judged = judge(this.subject.body, op, expected);
      return result(judged.ok, judged.note);
    }
    const document = this.json();
    if (!document.ok) return result(false, document.error);
    const found = evaluateJsonPath(document.value, subject.path.source);
    if (!found.ok) return result(false, found.error);
    const matches = found.value;
    if (op === 'exists') return result(matches.length > 0, matches.length > 0 ? '' : `nothing at ${subject.path.source}`);
    if (op === 'notExists') return result(matches.length === 0, matches.length === 0 ? '' : `${subject.path.source} is there`);
    if (op === 'count') {
      const count = matches.length === 1 && Array.isArray(matches[0]) ? (matches[0] as unknown[]).length : matches.length;
      const judged = judge(count, parsed.compare as Compare, expected);
      return result(judged.ok, judged.note);
    }
    if (matches.length === 0) return result(false, `nothing at ${subject.path.source}`);
    for (const value of matches) {
      const judged = judge(value, op, expected);
      if (!judged.ok) return result(false, judged.note);
    }
    return result(true);
  }

  /** The text at a JSON path, a header, a cookie or the whole body, for a capture. */
  read(source: CaptureSource): { ok: true; value: string } | { ok: false; error: string } {
    if (source.kind === 'body') return this.subject.body === undefined ? { ok: false, error: this.subject.bodyNote ?? 'the response has no body to read' } : { ok: true, value: this.subject.body };
    if (source.kind === 'header') {
      const value = this.header(source.name);
      return value === undefined ? { ok: false, error: `no header named ${source.name}` } : { ok: true, value };
    }
    if (source.kind === 'cookie') {
      for (const [name, value] of this.subject.headers) {
        if (name.toLowerCase() !== 'set-cookie') continue;
        const cookie = parseSetCookie(value);
        if (cookie !== undefined && cookie.name === source.name) return { ok: true, value: cookie.value };
      }
      return { ok: false, error: `the response sets no cookie named ${source.name}` };
    }
    if (source.kind === 'json') {
      const document = this.json();
      if (!document.ok) return { ok: false, error: document.error };
      const found = evaluateJsonPath(document.value, source.path.source);
      if (!found.ok) return { ok: false, error: found.error };
      const first = found.value[0];
      if (found.value.length === 0) return { ok: false, error: `nothing at ${source.path.source}` };
      return { ok: true, value: first === null ? 'null' : textOf(first) };
    }
    return { ok: false, error: 'there is nothing to read here' };
  }
}

// ---- captures ----

export type CaptureScope = 'active' | 'local' | 'global';
export type CaptureSource =
  | { kind: 'json'; path: ParsedPath }
  | { kind: 'body' }
  | { kind: 'header'; name: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'value'; text: string }
  | { kind: 'null' }
  | { kind: 'delete' };

export interface ParsedCapture {
  source: string;
  scope: CaptureScope;
  variable: string;
  from: CaptureSource;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseCapture(expression: string): Parsed<ParsedCapture> {
  const source = expression.trim();
  const fail = (error: string): Parsed<ParsedCapture> => ({ ok: false, error });
  if (source === '') return fail('a capture cannot be empty');
  if (source.length > ASSERT_LIMITS.expressionChars) return fail(`a capture is limited to ${ASSERT_LIMITS.expressionChars} characters`);
  const match = /^(?:(active|local|global)\s*:\s*)?([^\s=:]+)\s*=\s*([\s\S]*)$/.exec(source);
  if (match === null) return fail('a capture is written name = source, for example token = json $.access_token');
  const variable = match[2] as string;
  if (!VARIABLE_NAME.test(variable)) return fail(`"${variable.slice(0, 40)}" is not a name a variable can have (letters, digits, _ . -, not starting with a digit)`);
  const rest = (match[3] as string).trim();
  const first = word(rest, 0);
  const scope = (match[1] ?? 'active') as CaptureScope;
  const done = (from: CaptureSource): Parsed<ParsedCapture> => ({ ok: true, value: { source, scope, variable, from } });
  switch (first.text) {
    case 'json': {
      const raw = word(rest, first.next, true);
      if (raw.text === '' || rest.slice(raw.next).trim() !== '') return fail('json needs one path: token = json $.access_token');
      const path = parseJsonPath(raw.text);
      return path.ok ? done({ kind: 'json', path: path.value }) : fail(`json path: ${path.error}`);
    }
    case 'body': return rest.slice(first.next).trim() === '' ? done({ kind: 'body' }) : fail('body takes nothing after it');
    case 'header': case 'cookie': {
      const name = word(rest, first.next);
      if (name.text === '' || rest.slice(name.next).trim() !== '') return fail(`${first.text} needs one name: ${variable} = ${first.text} NAME`);
      return done({ kind: first.text, name: name.text });
    }
    case 'value': return done({ kind: 'value', text: rest.slice(first.next).trim() });
    case 'null': return rest.slice(first.next).trim() === '' ? done({ kind: 'null' }) : fail('null takes nothing after it');
    case 'delete': return rest.slice(first.next).trim() === '' ? done({ kind: 'delete' }) : fail('delete takes nothing after it');
    default: return fail('the source is json PATH, body, header NAME, cookie NAME, value TEXT, null or delete');
  }
}

export interface CaptureResult {
  expr: string;
  from: string;
  ok: boolean;
  variable: string;
  scope: CaptureScope;
  action: 'set' | 'delete';
  value: string;
  message: string;
}

export function runCapture(parsed: ParsedCapture, evaluator: Evaluator, resolve: Resolver, from: string): CaptureResult {
  const base = { expr: parsed.source, from, variable: parsed.variable, scope: parsed.scope };
  const failed = (message: string): CaptureResult => ({ ...base, ok: false, action: 'set', value: '', message });
  if (parsed.from.kind === 'delete') return { ...base, ok: true, action: 'delete', value: '', message: '' };
  if (parsed.from.kind === 'null') return { ...base, ok: true, action: 'set', value: '', message: '' };
  if (parsed.from.kind === 'value') {
    const resolved = resolve(parsed.from.text);
    return resolved.unresolved.length > 0 ? failed(`the variable ${resolved.unresolved.join(', ')} has no value`) : { ...base, ok: true, action: 'set', value: resolved.text, message: '' };
  }
  const read = evaluator.read(parsed.from);
  return read.ok ? { ...base, ok: true, action: 'set', value: read.value, message: '' } : failed(read.error);
}

/** Runs tests: those that cannot be read are failed tests that say why. */
export function runTests(tests: readonly { expr: string; from: string }[], subject: TestSubject, resolve: Resolver): TestResult[] {
  const evaluator = new Evaluator(subject);
  return tests.map(test => {
    const parsed = parseAssertion(test.expr);
    return parsed.ok ? evaluator.assertion(parsed.value, resolve, test.from) : { expr: test.expr.trim(), from: test.from, ok: false, message: parsed.error };
  });
}

export function runCaptures(captures: readonly { expr: string; from: string }[], subject: TestSubject, resolve: Resolver): CaptureResult[] {
  const evaluator = new Evaluator(subject);
  return captures.map(capture => {
    const parsed = parseCapture(capture.expr);
    return parsed.ok
      ? runCapture(parsed.value, evaluator, resolve, capture.from)
      : { expr: capture.expr.trim(), from: capture.from, ok: false, variable: '', scope: 'active' as CaptureScope, action: 'set' as const, value: '', message: parsed.error };
  });
}
