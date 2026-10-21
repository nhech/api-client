import { promises as disk } from 'node:fs';
import { join } from 'node:path';
import { runCaptures, runTests, type CaptureResult, type TestResult } from '../../src/core/assert';
import type { Request } from '../../src/core/model';
import { isSecretName, redactValues } from '../../src/core/redact';
import type { RuntimeContext } from '../../src/core/runtime';
import { resolveText, secretValues, snapshotVariables, type VarValue } from '../../src/core/vars';
import { confinedFile } from '../../src/engine/files';
import { locate, prepareSend, type Prepared } from '../../src/engine/prepare';
import { send } from '../../src/engine/send';
import { EngineError, type WireResponse } from '../../src/engine/types';
import { scriptKey, type ScriptToRun } from '../../src/script/consent';
import { runScripts, type ScriptRun } from '../../src/script/run';
import { printable } from '../../src/util/chars';
import { testSubject, VIEW_READ_BYTES } from '../../src/view/response';
import { addOutput, emptyReport, hasReport, requestForScripts, responseForScripts, scriptInput, sentForScripts, withRequestChanges, type ScriptPhase, type ScriptReport } from '../../src/view/scripts';
import { realClock } from './clientWorkspace';
import { scriptOperations } from './scriptOps';
import type { SendEnvironment } from './sender';

/**
 * One request, from the file to the answer, without a page: the scripts before it, the access token, the request, the tests and captures, the scripts
 * after it. The editor shows the result as a response; the collection runner keeps what it needs of each. Nothing here posts a message or draws
 * anything: the outcome is data.
 */

/** The most tests and captures one send runs: more than that is a request somebody made to be slow. */
const MAX_TESTS = 500;
const MAX_CAPTURES = 100;

export interface ExecuteOptions {
  signal: AbortSignal;
  /** The data of one pass of a run: variables for this request, weaker than what a script sets. */
  iteration?: { index: number; count: number; data: Readonly<Record<string, string>> };
}

/** What was attempted when a request went out: what the history says about it. */
export interface Attempt {
  method: string;
  /** The address as it was first sent, with the variables replaced (the secrets are still in it: whoever writes it down covers them). */
  url: string;
  environment: string;
  redactions: string[];
}

export type Execution =
  | {
    kind: 'sent';
    response: WireResponse;
    /** The beginning of the body (up to what the view reads). */
    bytes: Uint8Array;
    tests: TestResult[];
    captures: CaptureResult[];
    report: ScriptReport;
    warnings: string[];
    /** Values to hide in whatever is written down about the request. */
    redactions: string[];
    request: Request;
    attempt: Attempt;
  }
  | { kind: 'failed'; code: string; message: string; hint: string; warnings: string[]; report?: ScriptReport; attempt?: Attempt }
  | { kind: 'cancelled' };

/** The scripts that would run for a request, each with the place that its consent is kept under. */
function scriptsToRun(prepared: Prepared): ScriptToRun[] {
  const list: ScriptToRun[] = [];
  for (const source of prepared.effective.preScripts) list.push({ key: scriptKey('pre', source.id), phase: 'pre', from: source.from, code: source.code });
  for (const source of prepared.effective.postScripts) list.push({ key: scriptKey('post', source.id), phase: 'post', from: source.from, code: source.code });
  return list;
}

export async function readPrefix(body: WireResponse['body'], limit: number): Promise<Uint8Array> {
  if (body.kind === 'memory') return body.bytes.subarray(0, limit);
  const handle = await disk.open(body.path, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const failed = (code: string, message: string, hint = '', warnings: string[] = [], report?: ScriptReport, attempt?: Attempt): Execution => ({ kind: 'failed', code, message: printable(message), hint: printable(hint), warnings, ...(report === undefined || !hasReport(report) ? {} : { report }), ...(attempt === undefined ? {} : { attempt }) });

const attemptOf = (prepared: Prepared): Attempt => ({ method: prepared.built.wire.method, url: prepared.built.wire.url, environment: prepared.environment?.environment.name ?? '', redactions: prepared.built.redactions });

/** What to say about a request that cannot be sent: the problems in the words for the person, with the warnings that came before. */
function refused(prepared: Prepared, report?: ScriptReport): Execution {
  const warnings = [...prepared.built.warnings];
  if (prepared.built.unresolved.length > 0) warnings.push(`These variables have no value, so they were sent as written: ${prepared.built.unresolved.join(', ')}.`);
  return failed('invalid-request', prepared.problems.join(' '), '', warnings, report);
}

/** Runs the scripts of one stage and applies what they asked for to the variables; the request and the report are the caller's to use. */
async function runStage(env: SendEnvironment, phase: ScriptPhase, input: { prepared: Prepared; request: Request; answer: { wire: WireResponse; bytes: Uint8Array } | undefined; report: ScriptReport; signal: AbortSignal; context: RuntimeContext; iteration: ExecuteOptions['iteration'] }): Promise<ScriptRun> {
  const { prepared, report } = input;
  const sources = phase === 'pre' ? prepared.effective.preScripts : prepared.effective.postScripts;
  const response = input.answer === undefined ? null : responseForScripts(input.answer.wire, input.answer.bytes);
  const run = await runScripts(env.scripts.engine, scriptInput({
    phase: phase === 'pre' ? 'prerequest' : 'test', requestId: input.request.id, requestName: input.request.name, environmentName: prepared.environment?.environment.name ?? '',
    variables: snapshotVariables(prepared.scopeInput, env.runtime.snapshot(input.context)),
    request: input.answer === undefined ? requestForScripts(input.request) : sentForScripts(input.answer.wire.sent), response, cookies: response?.cookies ?? [],
    scripts: sources.map(source => ({ code: source.code, from: source.from })),
    ...(input.iteration === undefined ? {} : { iteration: { index: input.iteration.index, count: input.iteration.count, data: { ...input.iteration.data } } })
  }), scriptOperations({ options: prepared.options, signal: input.signal, proxy: env.proxy(), jar: prepared.effective.settings.cookies ? env.jar : undefined }), { signal: input.signal });
  if (!run.ok) {
    if (run.kind !== 'cancelled') report.errors.push({ phase, from: 'scripts', name: 'Error', message: printable(redactValues(run.message, [...prepared.built.redactions, ...secretValues(prepared.scopes)])) });
    return run;
  }
  addOutput(report, phase, run.output, [...prepared.built.redactions, ...secretValues(prepared.scopes)]);
  let changed = false;
  for (const scope of ['active', 'local', 'global'] as const) {
    const changes = run.output.variables[scope];
    if (changes === undefined) continue;
    env.runtime.change(scope, changes, input.context);
    changed = true;
  }
  if (changed) env.announceVariables();
  return run;
}

export async function executeRequest(env: SendEnvironment, path: string, request: Request, options: ExecuteOptions): Promise<Execution> {
  const { signal } = options;
  const loaded = env.workspace.loaded;
  if (loaded === undefined) return failed('invalid-request', 'No folder is open, so there are no collections to send from.');
  const collectionPath = locate(loaded, path)?.collection.path ?? '';
  const context = env.contextOf(collectionPath);
  /** What the iteration gives is the weakest of what is set while requests run: a script or a capture beats it. */
  const runtimeScope = (): Map<string, VarValue> => {
    const merged = new Map<string, VarValue>();
    for (const [name, value] of Object.entries(options.iteration?.data ?? {})) merged.set(name, { value, secret: isSecretName(name) });
    for (const [name, value] of env.runtime.scope(context)) merged.set(name, value);
    return merged;
  };
  const prepare = (current: Request, oauthToken?: { accessToken: string; tokenType: string }): Prepared | undefined => prepareSend({
    loaded, path, request: current, environmentId: env.workspace.activeEnvironmentId, clock: realClock, runtime: runtimeScope(),
    ...(oauthToken === undefined ? {} : { oauthToken }),
    resolveFile: (collection, relative) => {
      const folder = env.workspace.folder();
      return folder === undefined ? undefined : confinedFile(join(folder.uri.fsPath, ...collection.split('/')), relative);
    }
  });
  let prepared = prepare(request);
  if (prepared === undefined) return failed('invalid-request', 'This file is not in a collection that is loaded, so its folders, variables and settings are not known.', 'Open it from the Collections view, or check that the collection has no problem listed there.');
  const scripted = prepared.effective.preScripts.length > 0 || prepared.effective.postScripts.length > 0;
  // A script before the request can fix what is wrong with it (set the address, the variable it uses), so the problems wait for the scripts.
  if (!scripted && prepared.problems.length > 0) return refused(prepared);

  const report = emptyReport();
  let current = request;
  let allowed = false;
  if (scripted) {
    const permission = await env.scripts.permit(env.collectionKey(prepared.collection.path), scriptsToRun(prepared));
    if (permission.kind === 'cancel') return { kind: 'cancelled' };
    if (permission.kind === 'skip') report.notes.push(permission.note);
    else allowed = true;
  }
  if (allowed && prepared.effective.preScripts.length > 0) {
    const before = await runStage(env, 'pre', { prepared, request: current, answer: undefined, report, signal, context, iteration: options.iteration });
    if (!before.ok) return signal.aborted ? { kind: 'cancelled' } : failed('script-error', redactValues(before.message, [...prepared.built.redactions, ...secretValues(prepared.scopes)]), 'The request was not sent. Fix the script, or turn scripts off in the settings (apiClient.scripts.enabled) to send without them.', [], report);
    if (before.output.error !== null) return failed('script-error', 'A script failed before the request was sent.', 'The request was not sent. What the script said is below.', [], report);
    if (before.output.skip) return failed('skipped', 'A script asked not to send this request.', '', [], report);
    if (before.output.request !== undefined) current = withRequestChanges(current, before.output.request);
    const again = prepare(current);
    if (again === undefined) return failed('invalid-request', 'The request is not in a collection that is loaded any more.', '', [], report);
    prepared = again;
  }
  // OAuth 2.0: the access token that is kept, a refreshed one or a new one (which may need the person in the browser); the request is built again with it.
  if (prepared.effective.auth.kind === 'oauth2' && prepared.problems.length === 0) {
    const outcome = await env.oauth.token({ collection: env.collectionKey(prepared.collection.path), auth: prepared.effective.auth, scopes: prepared.scopes, signal, proxy: env.proxy(), tls: prepared.options.tls });
    if (outcome.kind === 'cancelled') return { kind: 'cancelled' };
    if (outcome.kind === 'failed') return failed('oauth', outcome.message, outcome.hint, [], report);
    const withToken = prepare(current, outcome.token);
    if (withToken === undefined) return failed('invalid-request', 'The request is not in a collection that is loaded any more.', '', [], report);
    prepared = withToken;
  }
  if (prepared.problems.length > 0) return refused(prepared, report);
  const warnings = [...prepared.built.warnings];
  if (prepared.built.unresolved.length > 0) warnings.push(`These variables have no value, so they were sent as written: ${prepared.built.unresolved.join(', ')}.`);

  const attempt = attemptOf(prepared);
  try {
    const response = await send(prepared.built.wire, {
      ...prepared.options, signal, spill: env.spill(), proxy: env.proxy(),
      ...(prepared.effective.settings.cookies ? { cookies: env.jar } : {})
    });
    const bytes = await readPrefix(response.body, VIEW_READ_BYTES);
    // The tests are judged first, with the variables as they were when the request went out; then the captures save what they read.
    const scopes = prepared.scopes;
    const resolve = (text: string): { text: string; unresolved: readonly string[] } => { const resolved = resolveText(text, scopes, { clock: realClock }); return { text: resolved.text, unresolved: resolved.unresolved }; };
    const subject = testSubject(response, bytes);
    const tests = runTests(prepared.effective.tests.slice(0, MAX_TESTS), subject, resolve);
    const captures = runCaptures(current.captures.filter(item => item.enabled && item.expr.trim() !== '').slice(0, MAX_CAPTURES).map(item => ({ expr: item.expr, from: 'request' })), subject, resolve);
    for (const capture of captures) env.runtime.apply(capture, context);
    if (captures.some(capture => capture.ok)) env.announceVariables();
    if (allowed && prepared.effective.postScripts.length > 0) await runStage(env, 'post', { prepared, request: current, answer: { wire: response, bytes }, report, signal, context, iteration: options.iteration });
    return { kind: 'sent', response, bytes, tests, captures, report, warnings, redactions: prepared.built.redactions, request: current, attempt };
  } catch (error) {
    if (error instanceof EngineError && error.code === 'aborted') return { kind: 'cancelled' };
    if (error instanceof EngineError) return failed(error.code, error.message, error.hint, warnings, report, attempt);
    return failed('network', error instanceof Error ? error.message : 'The request failed.', '', warnings, report, attempt);
  }
}
