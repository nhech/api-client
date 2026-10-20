import { DEFAULT_TARGET } from '../model/target';
import type { Target } from '../model/target';
import { splitVariables } from './text';

/**
 * Thunder's dynamic variables are written `{{#name}}` (spec 5.7). The ones with an exact equivalent in the tool the files are
 * written for are rewritten; every other one is left as it is, so that it shows up unresolved, and is listed (by name, from
 * Thunder's own list) in the report.
 *
 * What Thunder does (read from the code of 3.0.0, nothing run):
 *  - `#guid`: a random UUID v4;
 *  - `#number`, `#number, a`, `#number, a, b`: a random integer from `a` to `b` INCLUDING both, `a` 1 and `b` 1,000,000 when
 *    missing, `a` at or above 990,000 taken as 1, `b` above 1,000,000 taken as 1,000,000;
 *  - `#date`: the time now in milliseconds; `#dateISO`: the time now as `toISOString()` (UTC, milliseconds).
 *
 * What the tools do (tried for real: REST Client 0.25.1, httpYac 6.16.7, JetBrains ijhttp 263.7031): `{{$guid}}` works in
 * REST Client and httpYac and not in JetBrains, which has `{{$uuid}}`; `{{$randomInt a b}}` (REST Client, httpYac) and
 * `{{$random.integer(a, b)}}` (JetBrains, httpYac) give a number from `a` up to but NOT including `b`, so Thunder's inclusive `b`
 * is written as `b + 1`; JetBrains ignores the range of `$randomInt`. `{{$datetime iso8601}}` is the same instant text as Thunder's
 * (REST Client, httpYac), JetBrains has `{{$isoTimestamp}}` (nanoseconds instead of milliseconds). `{{$timestamp}}` is
 * milliseconds in httpYac and seconds in the other two, so `#date` is mapped for httpYac only.
 */
const KNOWN: ReadonlySet<string> = new Set(['guid', 'name', 'string', 'number', 'email', 'bool', 'enum', 'date', 'dateISO']);

interface Spelling {
  guid: string;
  /** From `min` up to but not including `upper`. */
  integer: (min: number, upper: number) => string;
  isoNow: string;
  epochMs: string | undefined;
}

const SPELLINGS: Readonly<Record<Target, Spelling>> = {
  'rest-client': { guid: '{{$guid}}', integer: (min, upper) => `{{$randomInt ${min} ${upper}}}`, isoNow: '{{$datetime iso8601}}', epochMs: undefined },
  httpyac: { guid: '{{$guid}}', integer: (min, upper) => `{{$randomInt ${min} ${upper}}}`, isoNow: '{{$datetime iso8601}}', epochMs: '{{$timestamp}}' },
  jetbrains: { guid: '{{$uuid}}', integer: (min, upper) => `{{$random.integer(${min}, ${upper})}}`, isoNow: '{{$isoTimestamp}}', epochMs: undefined }
};

const DEFAULT_MAX = 1_000_000;
const SAFE_MIN_LIMIT = 990_000;

/** The range Thunder really uses for `#number`, or undefined when the arguments are not whole numbers or there are too many. */
export function thunderRange(args: readonly string[]): { min: number; max: number } | undefined {
  if (args.length > 2) return undefined;
  const [a, b] = args.map(arg => arg.trim());
  const whole = (text: string): boolean => /^-?\d{1,15}$/.test(text);
  if ((a !== undefined && a !== '' && !whole(a)) || (b !== undefined && b !== '' && !whole(b))) return undefined;
  const min = a === undefined || a === '' ? 1 : Number(a) >= SAFE_MIN_LIMIT ? 1 : Number(a);
  const max = b === undefined || b === '' ? DEFAULT_MAX : Number(b) > DEFAULT_MAX ? DEFAULT_MAX : Number(b);
  return max < min ? undefined : { min, max };
}

function mapOne(variable: string, unmapped: Set<string>, spelling: Spelling): string {
  const inner = variable.slice(2, -2).trim();
  const found = /^#([A-Za-z]+)(?:\s*,\s*([\s\S]*))?$/.exec(inner);
  if (found === null) return variable;
  const name = found[1] ?? '';
  const args = found[2];
  if (name === 'guid' && args === undefined) return spelling.guid;
  if (name === 'number') {
    const range = thunderRange(args === undefined ? [] : args.split(','));
    if (range !== undefined) return spelling.integer(range.min, range.max + 1);
  }
  if (name === 'dateISO' && args === undefined) return spelling.isoNow;
  if (name === 'date' && args === undefined && spelling.epochMs !== undefined) return spelling.epochMs;
  unmapped.add(KNOWN.has(name) ? name : '<other>');
  return variable;
}

/** The text with its dynamic variables rewritten where there is an equivalent; the names of the others are added to `unmapped`. */
export function mapSystemVariables(text: string, unmapped: Set<string>, target: Target = DEFAULT_TARGET): string {
  if (!text.includes('{{#') && !/\{\{\s*#/.test(text)) return text;
  const spelling = SPELLINGS[target];
  return splitVariables(text).map(piece => (piece.variable ? mapOne(piece.text, unmapped, spelling) : piece.text)).join('');
}
