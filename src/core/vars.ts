import type { Clock } from './clock';
import type { Environment, Var, WorkspaceFile } from './model';
import type { Level } from './inherit';
import { compareCodePoints } from '../util/chars';
import { isSecretName } from './redact';

/**
 * Variables. `{{name}}` is replaced by the value of the nearest scope that has it, `{{$guid}}` and the other `{{$...}}` words
 * make a value, and anything else between double braces stays as it is and is reported. Nothing is ever evaluated: a name is
 * a name and a dynamic word is looked up in a fixed table, so a request that came from somebody else's repository cannot run
 * code or read the machine through a variable. Time and randomness come from the injected clock.
 */
export interface VarValue {
  value: string;
  secret: boolean;
}
/** Names to values. The scopes of a resolution are listed from the strongest to the weakest. */
export type Scope = ReadonlyMap<string, VarValue>;

export interface ResolveOptions {
  clock: Clock;
  /** How many variables may be inside variables. */
  maxDepth?: number;
  /** The size of the result; past it the rest of the text is left as it was. */
  maxBytes?: number;
  /** How many replacements one resolution makes (a variable that names itself twice, ten levels deep, would otherwise make a thousand). */
  maxReplacements?: number;
}

export interface Resolved {
  text: string;
  /** Names with no value in any scope, and `{{...}}` text that is neither a name nor a known dynamic word; each once, in order of appearance. */
  unresolved: string[];
  /** Names that lead back to themselves; their `{{name}}` is left in the text. */
  cycles: string[];
  /** The names of the secret variables whose values went into the text. */
  secrets: string[];
  /** The size or the replacement limit was reached. */
  truncated: boolean;
}

export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_REPLACEMENTS = 10_000;

export type TokenKind = 'variable' | 'dynamic' | 'invalid';
export interface Token {
  kind: TokenKind;
  /** The text between the braces, trimmed. */
  name: string;
  /** The span of the whole `{{...}}` in the text. */
  start: number;
  end: number;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The `{{...}}` spans of a text and what each is. An unclosed `{{` is plain text. Linear in the size of the text. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const lastClose = text.lastIndexOf('}}');
  let at = 0;
  for (;;) {
    const open = text.indexOf('{{', at);
    if (open < 0 || open + 2 > lastClose) break;
    const close = text.indexOf('}}', open + 2);
    const name = text.slice(open + 2, close).trim();
    tokens.push({ kind: name.startsWith('$') ? 'dynamic' : NAME.test(name) ? 'variable' : 'invalid', name, start: open, end: close + 2 });
    at = close + 2;
  }
  return tokens;
}

// ---- dynamic variables ----

const HEX = '0123456789abcdef';
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function integerIn(clock: Clock, min: number, max: number): number {
  return min + Math.min(max - min, Math.floor(clock.random() * (max - min + 1)));
}

function guid(clock: Clock): string {
  let out = '';
  for (let index = 0; index < 32; index++) {
    if (index === 8 || index === 12 || index === 16 || index === 20) out += '-';
    out += index === 12 ? '4' : index === 16 ? HEX[8 + integerIn(clock, 0, 3)] : HEX[integerIn(clock, 0, 15)];
  }
  return out;
}

/** An ISO 8601 UTC time with milliseconds, from civil-date arithmetic (the pure code does not use Date). */
export function isoTime(epochMs: number): string {
  const days = Math.floor(epochMs / 86_400_000);
  const inDay = epochMs - days * 86_400_000;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}T${two(Math.floor(inDay / 3_600_000))}:${two(Math.floor(inDay / 60_000) % 60)}:${two(Math.floor(inDay / 1000) % 60)}.${String(inDay % 1000).padStart(3, '0')}Z`;
}

/** `-1 d`, `+30 m`, `2 h`: an offset for the time words, or undefined when the arguments are not one. */
function offsetOf(args: string[]): number | undefined {
  if (args.length === 0) return 0;
  const amount = args[0];
  const unit = args[1];
  if (args.length !== 2 || amount === undefined || unit === undefined || !/^[-+]?\d{1,9}$/.test(amount) || UNIT_MS[unit] === undefined) return undefined;
  return Number(amount) * (UNIT_MS[unit] as number);
}

/** The names the editor can offer after `{{$`. */
export const DYNAMIC_WORDS = ['$guid', '$uuid', '$timestamp', '$isoTimestamp', '$randomInt', '$randomBoolean', '$randomString', '$randomEmail'] as const;

/** The value of a dynamic word such as `$randomInt 1 6`, or undefined when it is not one of the fixed words or its arguments are wrong. */
export function dynamicValue(expression: string, clock: Clock): string | undefined {
  const [word, ...args] = expression.trim().split(/\s+/);
  switch (word) {
    case '$guid':
    case '$uuid':
      return args.length === 0 ? guid(clock) : undefined;
    case '$timestamp': {
      const offset = offsetOf(args);
      return offset === undefined ? undefined : String(Math.floor((clock.now() + offset) / 1000));
    }
    case '$isoTimestamp': {
      const offset = offsetOf(args);
      return offset === undefined ? undefined : isoTime(Math.floor(clock.now() + offset));
    }
    case '$randomInt': {
      if (args.length === 0) return String(integerIn(clock, 0, 1000));
      const [low, high] = args;
      if (args.length !== 2 || low === undefined || high === undefined || !/^-?\d{1,9}$/.test(low) || !/^-?\d{1,9}$/.test(high) || Number(low) > Number(high)) return undefined;
      return String(integerIn(clock, Number(low), Number(high)));
    }
    case '$randomBoolean':
      return args.length === 0 ? (clock.random() < 0.5 ? 'false' : 'true') : undefined;
    case '$randomString': {
      const length = args.length === 0 ? 12 : args.length === 1 && /^\d{1,4}$/.test(args[0] ?? '') ? Number(args[0]) : -1;
      if (length < 0 || length > 1024) return undefined;
      let out = '';
      for (let index = 0; index < length; index++) out += ALPHANUMERIC[integerIn(clock, 0, ALPHANUMERIC.length - 1)];
      return out;
    }
    case '$randomEmail': {
      if (args.length !== 0) return undefined;
      let name = '';
      for (let index = 0; index < 10; index++) name += LOWER[integerIn(clock, 0, 25)];
      return `${name}@example.com`;
    }
    default:
      return undefined;
  }
}

// ---- resolution ----

export function resolveText(text: string, scopes: readonly Scope[], options: ResolveOptions): Resolved {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let replacements = options.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
  const unresolved: string[] = [];
  const cycles: string[] = [];
  const secrets: string[] = [];
  let truncated = false;
  let size = 0;

  // Each list keeps its order of first sight, and a set says whether a name is in it: a list that is searched for every name is quadratic in the number of names (80,000 names took 9 seconds).
  const sets = new Map<string[], Set<string>>();
  const note = (list: string[], name: string): void => {
    let seen = sets.get(list);
    if (seen === undefined) { seen = new Set(list); sets.set(list, seen); }
    if (!seen.has(name)) { seen.add(name); list.push(name); }
  };
  const lookup = (name: string): VarValue | undefined => {
    for (const scope of scopes) {
      const found = scope.get(name);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  // `stack` is the chain of variable names being expanded, so that a name that reaches itself is a cycle and not an endless walk.
  const expand = (source: string, depth: number, stack: readonly string[]): string => {
    if (!source.includes('{{')) { size += source.length; return source; }
    let out = '';
    let at = 0;
    const keep = (piece: string): void => { out += piece; size += piece.length; };
    for (const token of tokenize(source)) {
      keep(source.slice(at, token.start));
      at = token.end;
      const whole = source.slice(token.start, token.end);
      if (size > maxBytes || replacements <= 0) { truncated = true; keep(whole); continue; }
      if (token.kind === 'variable') {
        const found = stack.includes(token.name) ? undefined : lookup(token.name);
        if (stack.includes(token.name)) note(cycles, token.name);
        else if (found === undefined) note(unresolved, token.name);
        else if (depth >= maxDepth) truncated = true;
        else {
          replacements--;
          if (found.secret) note(secrets, token.name);
          out += expand(found.value, depth + 1, [...stack, token.name]);
          continue;
        }
        keep(whole);
      } else {
        const value = token.kind === 'dynamic' ? dynamicValue(token.name, options.clock) : undefined;
        if (value === undefined) { note(unresolved, whole); keep(whole); }
        else { replacements--; keep(value); }
      }
    }
    keep(source.slice(at));
    return out;
  };

  const result = expand(text, 0, []);
  return { text: result, unresolved, cycles, secrets, truncated };
}

// ---- building the scopes of a request ----

/** The enabled variables as a scope; when a name appears twice the last one wins, as in the files the importer reads. */
export function scopeOf(vars: readonly Var[]): Scope {
  const scope = new Map<string, VarValue>();
  for (const variable of vars) if (variable.enabled && variable.name !== '') scope.set(variable.name, { value: variable.value, secret: variable.secret });
  return scope;
}

export interface ScopeInput {
  /** Values set while the request runs (captured from a response, set by a script): the strongest. */
  runtime?: ReadonlyMap<string, VarValue>;
  /** The collection and folders above the request, outermost first. */
  levels: readonly Level[];
  environment?: Environment;
  /** Variables of a `.env` file the person chose to use. */
  dotenv?: ReadonlyMap<string, VarValue>;
  workspace: WorkspaceFile;
}

/**
 * The scopes in the order they are searched: what the request has set while running, the folders and the collection from the
 * nearest outwards, the active environment, a `.env` file, and the variables of the whole workspace.
 */
export function variableScopes(input: ScopeInput): Scope[] {
  const scopes: Scope[] = [];
  if (input.runtime !== undefined) scopes.push(input.runtime);
  for (let index = input.levels.length - 1; index >= 0; index--) scopes.push(scopeOf((input.levels[index] as Level).container.vars));
  if (input.environment !== undefined) scopes.push(scopeOf(input.environment.vars));
  if (input.dotenv !== undefined) scopes.push(input.dotenv);
  scopes.push(scopeOf(input.workspace.vars));
  return scopes;
}

// ---- what the editor shows about variables ----

/** A variable as the editor shows it: where it comes from, and its value unless it is a secret (the value of a secret never leaves the extension). */
export interface VariableInfo {
  name: string;
  value: string;
  secret: boolean;
  /** "collection Shop", "folder Orders", "environment Dev", "workspace". */
  source: string;
}

const CONSTANT_CLOCK: Clock = { now: () => 0, random: () => 0 };

/** Whether the text between the braces is a dynamic word that makes a value ("$guid", "$randomInt 1 6"). */
export const isKnownDynamic = (expression: string): boolean => dynamicValue(expression, CONSTANT_CLOCK) !== undefined;

/** Every variable a request can use, once each (the strongest definition), with where it comes from, in the order of the names. */
export function describeVariables(input: ScopeInput): VariableInfo[] {
  const found = new Map<string, VariableInfo>();
  const take = (vars: readonly Var[], source: string): void => {
    for (const [name, value] of scopeOf(vars)) if (!found.has(name)) found.set(name, { name, value: value.secret ? '' : value.value, secret: value.secret, source });
  };
  if (input.runtime !== undefined) for (const [name, value] of input.runtime) found.set(name, { name, value: value.secret ? '' : value.value, secret: value.secret, source: 'this run' });
  for (let index = input.levels.length - 1; index >= 0; index--) {
    const level = input.levels[index] as Level;
    take(level.container.vars, `${level.kind} ${level.name}`);
  }
  if (input.environment !== undefined) take(input.environment.vars, `environment ${input.environment.name}`);
  take(input.workspace.vars, 'workspace');
  return [...found.values()].sort((a, b) => compareCodePoints(a.name, b.name));
}

// ---- what a script sees ----

/** The values of every secret variable of these scopes, and of the variables whose names look like secrets: what is hidden in whatever scripts write. */
export function secretValues(scopes: readonly Scope[]): string[] {
  const values = new Set<string>();
  for (const scope of scopes) for (const [name, entry] of scope) if ((entry.secret || isSecretName(name)) && entry.value !== '') values.add(entry.value);
  return [...values];
}

/** The variables a script is given: by the scopes it can write to, and all of them as a request would see them. Plain data: no prototype, so a name is only a name. */
export interface VariableSnapshot {
  environment: Record<string, string>;
  collection: Record<string, string>;
  globals: Record<string, string>;
  merged: Record<string, string>;
}

/** What the requests have set so far, by scope (`RuntimeVariables.snapshot`). */
export interface SnapshotRuntime {
  active: ReadonlyMap<string, string>;
  local: ReadonlyMap<string, string>;
  global: ReadonlyMap<string, string>;
}

const record = (): Record<string, string> => Object.create(null) as Record<string, string>;

/**
 * `environment` is the active environment and what was set in it, `collection` the variables of the folders and the collection and what
 * was set there, `globals` the workspace and what was set everywhere. `merged` is what a request resolves a name to: the same order as
 * `variableScopes`, with what scripts and captures set beating everything and, among those, the nearest scope winning.
 */
export function snapshotVariables(input: Omit<ScopeInput, 'runtime'>, runtime: SnapshotRuntime): VariableSnapshot {
  const environment = record();
  const collection = record();
  const globals = record();
  const merged = record();
  const copy = (target: Record<string, string>, values: Iterable<[string, string]>): void => { for (const [name, value] of values) { target[name] = value; merged[name] = value; } };
  const plain = (scope: Scope): [string, string][] => [...scope].map(([name, entry]) => [name, entry.value]);
  copy(globals, plain(scopeOf(input.workspace.vars)));
  if (input.dotenv !== undefined) copy(environment, plain(input.dotenv));
  if (input.environment !== undefined) copy(environment, plain(scopeOf(input.environment.vars)));
  for (const level of input.levels) copy(collection, plain(scopeOf(level.container.vars)));
  copy(globals, runtime.global);
  copy(environment, runtime.active);
  copy(collection, runtime.local);
  return { environment, collection, globals, merged };
}
