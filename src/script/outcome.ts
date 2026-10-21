/**
 * What goes into a run of scripts and what comes out. The output is written by the scripts' own code, in an engine that a hostile script
 * has full control of, so it is read as untrusted data: every field is checked, text is cut at a size, counts are limited, names are
 * checked against what the extension accepts, and a key the format does not have is dropped. Nothing in it is ever run.
 */
export const OUTPUT_LIMITS = {
  logs: 500, logChars: 4000, tests: 500, testNameChars: 300, testMessageChars: 1000, variablesPerScope: 1000, variableNameChars: 200, variableValueChars: 256 * 1024,
  headers: 200, headerNameChars: 200, headerValueChars: 8192, urlChars: 16 * 1024, bodyChars: 1024 * 1024, errorChars: 1000, asyncErrors: 5, nextRequestChars: 300
} as const;

export interface ScriptInput {
  /** `prerequest` runs before the request is built from the request, `test` after the answer has come. */
  phase: 'prerequest' | 'test';
  info: { requestName: string; requestId: string; iteration: number; iterationCount: number };
  environmentName: string;
  /** The variables by scope as they are now, and all of them as a request would see them. */
  variables: { environment: Record<string, string>; collection: Record<string, string>; globals: Record<string, string>; merged: Record<string, string> };
  /** The request as the scripts see it: unresolved, with the headers and the body it would be built from. */
  request: { method: string; url: string; headers: [string, string][]; body: { mode: string; raw?: string } | null };
  response: null | { code: number; status: string; headers: [string, string][]; body: string | null; bodyNote?: string; responseTime: number; size: number; cookies: { name: string; value: string }[] };
  cookies: { name: string; value: string }[];
  iterationData: Record<string, string>;
  scripts: { code: string; from: string }[];
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
const LEVELS: readonly string[] = ['log', 'info', 'warn', 'error', 'debug'];

export interface ScriptTest { name: string; passed: boolean; message: string; skipped: boolean }
export interface ScriptLog { level: LogLevel; text: string }
/** Pairs, not an object: a name such as `__proto__` is a name like any other. */
export interface VariableChanges { set: [string, string][]; unset: string[] }
export interface RequestChanges { method?: string; url?: string; headers?: [string, string][]; bodyRaw?: string }

export interface ScriptOutput {
  logs: ScriptLog[];
  logsCut: boolean;
  tests: ScriptTest[];
  variables: { active?: VariableChanges; local?: VariableChanges; global?: VariableChanges };
  skip: boolean;
  /** A name, null for "stop", or absent for "no opinion". */
  nextRequest?: string | null;
  /** The script that threw, with its message; the rest of the scripts did not run. */
  error: { from: string; name: string; message: string } | null;
  asyncErrors: string[];
  request?: RequestChanges;
}

export type OutputResult = { ok: true; value: ScriptOutput } | { ok: false; error: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const cut = (value: unknown, limit: number): string => (typeof value === 'string' ? (value.length > limit ? value.slice(0, limit) : value) : '');
/** The control characters that could end a header or a line of a request. */
const hasLineBreak = (value: string): boolean => /[\r\n\u0000]/.test(value);

function readChanges(value: unknown): VariableChanges | undefined {
  if (!isRecord(value)) return undefined;
  const set: [string, string][] = [];
  const setting = own(value, 'set');
  if (Array.isArray(setting)) {
    for (const pair of setting) {
      if (set.length >= OUTPUT_LIMITS.variablesPerScope) break;
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
      const name = pair[0];
      if (!NAME.test(name) || name.length > OUTPUT_LIMITS.variableNameChars) continue;
      set.push([name, cut(pair[1], OUTPUT_LIMITS.variableValueChars)]);
    }
  }
  const unset: string[] = [];
  const removing = own(value, 'unset');
  if (Array.isArray(removing)) {
    for (const name of removing) {
      if (unset.length >= OUTPUT_LIMITS.variablesPerScope) break;
      if (typeof name === 'string' && NAME.test(name) && name.length <= OUTPUT_LIMITS.variableNameChars) unset.push(name);
    }
  }
  return set.length === 0 && unset.length === 0 ? undefined : { set, unset };
}

function readRequest(value: unknown): RequestChanges | undefined {
  if (!isRecord(value)) return undefined;
  const changes: RequestChanges = {};
  const method = own(value, 'method');
  if (typeof method === 'string' && /^[A-Z]{1,20}$/.test(method)) changes.method = method;
  const url = own(value, 'url');
  if (typeof url === 'string' && url.length <= OUTPUT_LIMITS.urlChars && !hasLineBreak(url)) changes.url = url;
  const headers = own(value, 'headers');
  if (Array.isArray(headers)) {
    const list: [string, string][] = [];
    for (const pair of headers) {
      if (list.length >= OUTPUT_LIMITS.headers) break;
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
      const name = pair[0];
      const given = pair[1];
      if (!TOKEN.test(name) || name.length > OUTPUT_LIMITS.headerNameChars || given.length > OUTPUT_LIMITS.headerValueChars || hasLineBreak(given)) continue;
      list.push([name, given]);
    }
    changes.headers = list;
  }
  const body = own(value, 'bodyRaw');
  if (typeof body === 'string' && body.length <= OUTPUT_LIMITS.bodyChars) changes.bodyRaw = body;
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/** Reads the text a run gave back. A text that is not what the API writes is refused; what is wrong inside it is dropped. */
export function parseOutput(text: string): OutputResult {
  if (text === '') return { ok: true, value: { logs: [], logsCut: false, tests: [], variables: {}, skip: false, error: null, asyncErrors: [] } };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'the scripts gave back something that is not JSON' }; }
  if (!isRecord(raw)) return { ok: false, error: 'the scripts gave back something that is not an object' };
  const logs: ScriptLog[] = [];
  const given = own(raw, 'logs');
  if (Array.isArray(given)) {
    for (const entry of given) {
      if (logs.length >= OUTPUT_LIMITS.logs) break;
      if (!isRecord(entry)) continue;
      const level = own(entry, 'level');
      logs.push({ level: typeof level === 'string' && LEVELS.includes(level) ? (level as LogLevel) : 'log', text: cut(own(entry, 'text'), OUTPUT_LIMITS.logChars) });
    }
  }
  const tests: ScriptTest[] = [];
  const results = own(raw, 'tests');
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (tests.length >= OUTPUT_LIMITS.tests) break;
      if (!isRecord(entry)) continue;
      tests.push({ name: cut(own(entry, 'name'), OUTPUT_LIMITS.testNameChars), passed: own(entry, 'passed') === true, message: cut(own(entry, 'message'), OUTPUT_LIMITS.testMessageChars), skipped: own(entry, 'skipped') === true });
    }
  }
  const variables: ScriptOutput['variables'] = {};
  const sets = own(raw, 'variables');
  if (isRecord(sets)) {
    for (const kind of ['active', 'local', 'global'] as const) {
      const changes = readChanges(own(sets, kind));
      if (changes !== undefined) variables[kind] = changes;
    }
  }
  const failure = own(raw, 'error');
  const error = isRecord(failure) ? { from: cut(own(failure, 'from'), 200), name: cut(own(failure, 'name'), 100), message: cut(own(failure, 'message'), OUTPUT_LIMITS.errorChars) } : null;
  const asyncErrors: string[] = [];
  const later = own(raw, 'asyncErrors');
  if (Array.isArray(later)) for (const item of later) if (asyncErrors.length < OUTPUT_LIMITS.asyncErrors && typeof item === 'string') asyncErrors.push(cut(item, OUTPUT_LIMITS.errorChars));
  const value: ScriptOutput = { logs, logsCut: own(raw, 'logsCut') === true, tests, variables, skip: own(raw, 'skip') === true, error, asyncErrors };
  const next = own(raw, 'nextRequest');
  if (next === null) value.nextRequest = null;
  else if (typeof next === 'string') value.nextRequest = cut(next, OUTPUT_LIMITS.nextRequestChars);
  const request = readRequest(own(raw, 'request'));
  if (request !== undefined) value.request = request;
  return { ok: true, value };
}
