import { parseSetCookie } from '../core/cookies';
import type { KV, Request } from '../core/model';
import { isSecretName, redactValues } from '../core/redact';
import type { VariableSnapshot } from '../core/vars';
import type { WireRequest, WireResponse } from '../engine/types';
import type { LogLevel, RequestChanges, ScriptInput, ScriptOutput } from '../script/outcome';
import { printable } from '../util/chars';
import { describeBody, type SavedView } from './response';

/**
 * Between the scripts of a request and the page: what a script is given (the request as it is written, or as it went out, the answer
 * and the variables), what its changes to the request are, and what is shown of a run (the console, the tests, what went wrong). Plain
 * data in, plain data out; the scripts themselves run elsewhere (src/script/).
 */

/** The most of a body a script is given; a larger one is not, and the script is told why. */
export const SCRIPT_BODY_LIMIT = 1024 * 1024;
const MAX_HEADERS = 500;
const SAVED_VALUE_CHARS = 200;
const MAX_LOG_CHARS = 64 * 1024;

export type ScriptPhase = 'pre' | 'post';

export interface ScriptLogView { phase: ScriptPhase; level: LogLevel; text: string }
export interface ScriptTestView { phase: ScriptPhase; name: string; passed: boolean; message: string; skipped: boolean }
export interface ScriptErrorView { phase: ScriptPhase; from: string; name: string; message: string }

/** What the scripts of one send did, for the response pane. */
export interface ScriptReport {
  /** Lines about the scripts as a whole: that they did not run and why, that one skipped the request, that the console was cut. */
  notes: string[];
  logs: ScriptLogView[];
  tests: ScriptTestView[];
  errors: ScriptErrorView[];
  /** Variables the scripts set or removed, shown like the ones a capture saved. */
  saved: SavedView[];
  /** A script before the request asked not to send it. */
  skipped: boolean;
  /** The request a script asked to run next (for the runner); null means none, undefined means no opinion. */
  nextRequest?: string | null;
}

export const emptyReport = (): ScriptReport => ({ notes: [], logs: [], tests: [], errors: [], saved: [], skipped: false });

/** Whether there is anything to show. */
export const hasReport = (report: ScriptReport): boolean => report.notes.length > 0 || report.logs.length > 0 || report.tests.length > 0 || report.errors.length > 0 || report.saved.length > 0 || report.skipped;

const clean = (text: string, secrets: readonly string[]): string => printable(redactValues(text, secrets));

/** Adds what a stage of scripts gave back. Text that reaches the page is made printable and has the secret values taken out. */
export function addOutput(report: ScriptReport, phase: ScriptPhase, output: ScriptOutput, given: readonly string[]): void {
  // What the scripts set under the name of a secret is a secret from then on, in what they write as well.
  const secrets = [...given];
  for (const scope of SCOPES) for (const [name, value] of output.variables[scope]?.set ?? []) if (isSecretName(name)) secrets.push(value);
  let chars = report.logs.reduce((total, entry) => total + entry.text.length, 0);
  for (const entry of output.logs) {
    if (chars >= MAX_LOG_CHARS) { if (!report.notes.includes(LOG_CUT_NOTE)) report.notes.push(LOG_CUT_NOTE); break; }
    const text = clean(entry.text, secrets);
    chars += text.length;
    report.logs.push({ phase, level: entry.level, text });
  }
  if (output.logsCut && !report.notes.includes(LOG_CUT_NOTE)) report.notes.push(LOG_CUT_NOTE);
  for (const test of output.tests) report.tests.push({ phase, name: clean(test.name, secrets), passed: test.passed, message: clean(test.message, secrets), skipped: test.skipped });
  if (output.error !== null) report.errors.push({ phase, from: clean(output.error.from, secrets), name: clean(output.error.name, secrets), message: clean(output.error.message, secrets) });
  for (const message of output.asyncErrors) report.errors.push({ phase, from: 'later', name: 'Error', message: clean(message, secrets) });
  for (const scope of SCOPES) {
    const changes = output.variables[scope];
    if (changes === undefined) continue;
    for (const [name, value] of changes.set) report.saved.push(savedView(phase, scope, name, 'set', value));
    for (const name of changes.unset) report.saved.push(savedView(phase, scope, name, 'delete', ''));
  }
  if (output.skip) report.skipped = true;
  if (output.nextRequest !== undefined) report.nextRequest = output.nextRequest;
}

const SCOPES = ['active', 'local', 'global'] as const;
const LOG_CUT_NOTE = 'The console was cut: a script wrote more than is kept.';

function savedView(phase: ScriptPhase, scope: 'active' | 'local' | 'global', variable: string, action: 'set' | 'delete', value: string): SavedView {
  const secret = isSecretName(variable);
  return {
    expr: variable, from: phase === 'pre' ? 'script before the request' : 'script after the answer', ok: true, variable, scope, action,
    value: secret || action === 'delete' ? '' : printable(value.length > SAVED_VALUE_CHARS ? value.slice(0, SAVED_VALUE_CHARS) : value), secret, message: ''
  };
}

// ---- what a script is given ----

const rowsOf = (rows: readonly KV[]): [string, string][] => rows.filter(row => row.enabled && row.name !== '').map(row => [row.name, row.value]);

/** The request as it is written, before the variables are replaced: its own enabled headers, and the text of a body that is text. */
export function requestForScripts(request: Request): ScriptInput['request'] {
  const body = request.body;
  const common = { method: request.method, url: request.url, headers: rowsOf(request.headers) };
  switch (body.kind) {
    case 'none': return { ...common, body: null };
    case 'text': case 'json': case 'xml': return { ...common, body: { mode: 'raw', raw: body.text.length > SCRIPT_BODY_LIMIT ? '' : body.text } };
    case 'form': return { ...common, body: { mode: 'urlencoded' } };
    case 'multipart': return { ...common, body: { mode: 'formdata' } };
    case 'graphql': return { ...common, body: { mode: 'graphql' } };
    case 'binary': return { ...common, body: { mode: 'file' } };
  }
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

/** The request as it went out, for the scripts after the answer. */
export function sentForScripts(sent: WireRequest): ScriptInput['request'] {
  const headers = sent.headers.slice(0, MAX_HEADERS).map(([name, value]): [string, string] => [name, value]);
  const body = sent.body;
  if (body === undefined) return { method: sent.method, url: sent.url, headers, body: null };
  if (body.kind === 'file') return { method: sent.method, url: sent.url, headers, body: { mode: 'file' } };
  if (body.kind === 'multipart') return { method: sent.method, url: sent.url, headers, body: { mode: 'formdata' } };
  if (body.bytes.length > SCRIPT_BODY_LIMIT) return { method: sent.method, url: sent.url, headers, body: { mode: 'raw' } };
  try { return { method: sent.method, url: sent.url, headers, body: { mode: 'raw', raw: fatalUtf8.decode(body.bytes) } }; } catch { return { method: sent.method, url: sent.url, headers, body: { mode: 'raw' } }; }
}

/** The answer as the scripts see it; the body is text only when it is text and small enough, and the note says why when it is not. */
export function responseForScripts(response: WireResponse, bytes: Uint8Array): NonNullable<ScriptInput['response']> {
  const contentType = response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const view = describeBody(bytes, response.size, contentType, []);
  let body: string | null = null;
  let bodyNote: string | undefined;
  if (view.kind === 'empty') body = '';
  else if (view.kind !== 'text') bodyNote = 'The body is not text, so a script cannot read it.';
  else if (response.truncated || view.cut || view.raw.length > SCRIPT_BODY_LIMIT) bodyNote = `The body is larger than a script is given (${SCRIPT_BODY_LIMIT} characters).`;
  else body = view.raw;
  const cookies: { name: string; value: string }[] = [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') continue;
    const cookie = parseSetCookie(value);
    if (cookie !== undefined && cookies.length < MAX_HEADERS) cookies.push({ name: cookie.name, value: cookie.value });
  }
  return {
    code: response.status, status: response.statusText, headers: response.headers.slice(0, MAX_HEADERS).map(([name, value]): [string, string] => [name, value]),
    body, ...(bodyNote === undefined ? {} : { bodyNote }), responseTime: Math.round(response.timings.totalMs), size: response.size, cookies
  };
}

export interface ScriptInputParts {
  phase: ScriptInput['phase'];
  requestId: string;
  requestName: string;
  environmentName: string;
  variables: VariableSnapshot;
  request: ScriptInput['request'];
  response: ScriptInput['response'];
  cookies: { name: string; value: string }[];
  scripts: { code: string; from: string }[];
  /** A run of a collection: which pass this is, how many there are, and the row of the data file. */
  iteration?: { index: number; count: number; data: Record<string, string> };
}

export function scriptInput(parts: ScriptInputParts): ScriptInput {
  return {
    phase: parts.phase,
    info: { requestName: parts.requestName, requestId: parts.requestId, iteration: parts.iteration?.index ?? 0, iterationCount: parts.iteration?.count ?? 1 },
    environmentName: parts.environmentName,
    variables: parts.variables,
    request: parts.request,
    response: parts.response,
    cookies: parts.cookies,
    iterationData: parts.iteration?.data ?? {},
    scripts: parts.scripts
  };
}

// ---- what a script changed in the request ----

/**
 * The request with what the scripts before it changed: the method and the address, the headers of the request itself (the rows that
 * are switched off stay as they were, after the new ones) and the text of a body that is text. The request on the disk is not touched;
 * this copy is only what is sent.
 */
export function withRequestChanges(request: Request, changes: RequestChanges): Request {
  const next: Request = { ...request };
  if (changes.method !== undefined) next.method = changes.method;
  if (changes.url !== undefined) next.url = changes.url;
  if (changes.headers !== undefined) {
    const unused = request.headers.filter(row => row.enabled && row.name !== '');
    const rows: KV[] = changes.headers.map(([name, value]) => {
      const at = unused.findIndex(row => row.name === name && row.value === value);
      const [same] = at < 0 ? [] : unused.splice(at, 1);
      return same ?? { name, value, enabled: true, description: '' };
    });
    next.headers = [...rows, ...request.headers.filter(row => !(row.enabled && row.name !== ''))];
  }
  if (changes.bodyRaw !== undefined) {
    const body = request.body;
    if (body.kind === 'text' || body.kind === 'json' || body.kind === 'xml') next.body = { ...body, text: changes.bodyRaw };
  }
  return next;
}
