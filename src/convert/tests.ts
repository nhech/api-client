import type { ImpAssertion, ImpCapture } from '../model/ir';
import type { TcTest } from '../model/source';
import type { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import { token } from './body';

/**
 * The tests of a request become assertions and captures of the directive grammar (spec 5.8 and 6.2a). A test that has no
 * equivalent is left out and named in `unsupported` by its type and action (words from Thunder's own lists, or a placeholder).
 */
export interface TestConversion {
  assertions: ImpAssertion[];
  captures: ImpCapture[];
  unsupported: string[];
  /** JSON queries that had no `json.` prefix and were read as paths anyway (TC-JSONPATH-GUESS). */
  jsonPathGuesses: number;
}

const COMPARE: Readonly<Record<string, string>> = { equal: '==', notequal: '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' };
const TEXTUAL: Readonly<Record<string, string>> = { ...COMPARE, contains: 'includes', notcontains: 'excludes', regex: 'matches' };
const TYPE_OPS: Readonly<Record<string, string>> = { string: 'isString', number: 'isNumber', boolean: 'isBoolean', bool: 'isBoolean', array: 'isArray' };
const HEADER_TYPES: ReadonlySet<string> = new Set(['Content-Type', 'Content-Length', 'Content-Encoding']);

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Thunder's JSON query (`json.data.items[0].id`) as a JSONPath (`$.data.items[0].id`). A key that is not an identifier goes
 * in brackets, a number between dots is an index, `*` a wildcard; bracket groups are kept as written.
 */
export function toJsonPath(query: string): { path: string; guessed: boolean } {
  const text = query.trim();
  let rest = text;
  let guessed = false;
  if (text.startsWith('$')) return { path: text, guessed };
  if (text === 'json') rest = '';
  else if (text.startsWith('json.')) rest = text.slice(5);
  else if (text.startsWith('json[')) rest = text.slice(4);
  else guessed = true;

  let path = '$';
  let i = 0;
  while (i < rest.length) {
    const char = rest[i];
    if (char === '.') { i++; continue; }
    if (char === '[') {
      const end = closingBracket(rest, i);
      path += rest.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < rest.length && rest[j] !== '.' && rest[j] !== '[') j++;
    const name = rest.slice(i, j);
    if (identifier.test(name)) path += `.${name}`;
    else if (/^\d+$/.test(name)) path += `[${name}]`;
    else if (name === '*') path += '[*]';
    else path += `['${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}']`;
    i = j;
  }
  return { path, guessed };
}

/** The index of the `]` that closes the `[` at `open`, looking past quotes; the last index when there is none. */
function closingBracket(text: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i];
    if (quote !== '') { if (char === '\\') i++; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') return i;
  }
  return text.length - 1;
}

const VARIABLE_TARGET = /^\{\{\s*([^{},]+?)\s*(?:,\s*(local|global)\s*)?\}\}$/;

function captureOf(custom: string, value: string): ImpCapture | undefined {
  const target = VARIABLE_TARGET.exec(value.trim());
  const variable = target?.[1] ?? '';
  const source = custom.trim();
  if (variable === '' || /[\s=:]/.test(variable) || source === '') return undefined;
  const scope = target?.[2] === 'local' ? 'local' : target?.[2] === 'global' ? 'global' : 'active';
  let from: string;
  if (source === 'text') from = 'body';
  else if (source === 'null' || source === 'delete') from = source;
  else if (source === 'json' || source.startsWith('json.') || source.startsWith('json[')) from = `json ${toJsonPath(source).path}`;
  else if (source.startsWith('header.') && source.length > 7) from = `header ${source.slice(7)}`;
  else if (source.startsWith('cookie.') && source.length > 7) from = `cookie ${source.slice(7)}`;
  else from = `value ${source}`;
  return { variable, scope, source: from };
}

export function convertTests(tests: readonly TcTest[], coerce: Coercions): TestConversion {
  const result: TestConversion = { assertions: [], captures: [], unsupported: [], jsonPathGuesses: 0 };
  for (const item of tests) {
    if (!isRecord(item)) continue;
    const type = coerce.string(item['type']);
    const action = coerce.string(item['action']);
    const custom = coerce.string(item['custom']);
    const value = coerce.string(item['value']);
    const reject = (): void => { result.unsupported.push(`${token(type)} | ${token(action)}`); };

    if (type === 'set-env-var') {
      const capture = action === 'setto' ? captureOf(custom, value) : undefined;
      if (capture === undefined) reject(); else result.captures.push(capture);
      continue;
    }

    const op = TEXTUAL[action];
    if (type === 'res-code') {
      if (op === undefined) reject(); else result.assertions.push({ target: 'status', op, expected: value });
    } else if (type === 'res-time') {
      const compare = COMPARE[action];
      if (compare === undefined) reject(); else result.assertions.push({ target: 'time', op: compare, expected: value });
    } else if (type === 'res-body') {
      if (action === 'isjson') result.assertions.push({ target: 'body', op: 'isJson', expected: '' });
      else if (op === undefined || action === '<' || action === '<=' || action === '>' || action === '>=') reject();
      else result.assertions.push({ target: 'body', op, expected: value });
    } else if (HEADER_TYPES.has(type) || type === 'custom-header') {
      const name = type === 'custom-header' ? custom.trim() : type;
      if (op === undefined || name === '') reject(); else result.assertions.push({ target: 'header', name, op, expected: value });
    } else if (type === 'json-query') {
      const query = toJsonPath(custom);
      if (custom.trim() === '') { reject(); continue; }
      if (action === 'count') result.assertions.push({ target: 'json', name: query.path, op: 'count ==', expected: value });
      else if (action === 'istype') {
        const typeOp = TYPE_OPS[value.trim().toLowerCase()];
        if (typeOp === undefined) { reject(); continue; }
        result.assertions.push({ target: 'json', name: query.path, op: typeOp, expected: '' });
      } else if (op === undefined) { reject(); continue; }
      else result.assertions.push({ target: 'json', name: query.path, op, expected: value });
      if (query.guessed) result.jsonPathGuesses++;
    } else {
      reject();
    }
  }
  return result;
}
