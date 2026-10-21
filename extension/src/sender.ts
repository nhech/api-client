import { promises as disk } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { runCaptures, runTests } from '../../src/core/assert';
import { CookieJar } from '../../src/core/cookies';
import type { Request } from '../../src/core/model';
import { RuntimeVariables, type RuntimeContext } from '../../src/core/runtime';
import { resolveText, secretValues, snapshotVariables } from '../../src/core/vars';
import { confinedFile } from '../../src/engine/files';
import { locate, prepareSend, type Prepared } from '../../src/engine/prepare';
import { proxyConfigFromEnv, type ProxyConfig } from '../../src/engine/proxy';
import { send } from '../../src/engine/send';
import { EngineError, type WireResponse } from '../../src/engine/types';
import { scriptKey, type ScriptToRun } from '../../src/script/consent';
import { runScripts, type ScriptRun } from '../../src/script/run';
import type { ToView } from '../../src/view/request-protocol';
import { buildResponseView, decodeBodyText, formatJson, formatXml, testSubject, VIEW_READ_BYTES, type ResponseView } from '../../src/view/response';
import { printable } from '../../src/util/chars';
import { addOutput, emptyReport, hasReport, requestForScripts, responseForScripts, scriptInput, sentForScripts, withRequestChanges, type ScriptPhase, type ScriptReport } from '../../src/view/scripts';
import { realClock, type ClientWorkspace } from './clientWorkspace';
import { OAuthService, type TokenRequestInput } from './oauth';
import { scriptOperations } from './scriptOps';
import { ScriptService } from './scripts';

/** A response whose body goes to a file when it is larger than the memory limit of the settings is kept up to this size. */
const SPILL_LIMIT_BYTES = 256 * 1024 * 1024;
/** The most of a body that is opened in an editor tab; a larger one can be saved. */
const OPEN_LIMIT_BYTES = 32 * 1024 * 1024;

/** The most tests and captures one send runs: more than that is a request somebody made to be slow. */
const MAX_TESTS = 500;
const MAX_CAPTURES = 100;

/** What every request editor shares when it sends: the files, the cookie jar, the variables that requests have set, and where large responses are put. */
export class SendEnvironment implements vscode.Disposable {
  readonly jar = new CookieJar(() => Date.now());
  /** What the captures of the responses saved; the editors are told when it changes. */
  readonly runtime = new RuntimeVariables();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeVariables = this.changed.event;
  /** Whether scripts may run, and the engine they run in. */
  readonly scripts: ScriptService;
  /** The access tokens of the requests that use OAuth 2.0. */
  readonly oauth: OAuthService;
  private readonly spillDir: string;

  constructor(context: vscode.ExtensionContext, readonly workspace: ClientWorkspace) {
    this.scripts = new ScriptService(context);
    this.oauth = new OAuthService(context);
    this.spillDir = join(context.globalStorageUri.fsPath, 'spill');
    // A response that was spilled to a file belongs to a page that is gone when the extension starts again.
    void disk.rm(this.spillDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** What a collection is called in what is kept on this computer about it (what scripts and servers were allowed): the workspace folder and the folder of the collection. */
  collectionKey(collectionPath: string): string {
    return `${this.workspace.folder()?.uri.toString() ?? ''}#${collectionPath}`;
  }

  /** What the OAuth service needs to know about a request: its collection, the authentication that applies to it (its own or inherited), the variables, and how to connect. */
  oauthInput(path: string, request: Request): Omit<TokenRequestInput, 'signal'> | undefined {
    const loaded = this.workspace.loaded;
    if (loaded === undefined) return undefined;
    const collection = locate(loaded, path)?.collection.path ?? '';
    const prepared = prepareSend({ loaded, path, request, environmentId: this.workspace.activeEnvironmentId, clock: realClock, runtime: this.runtime.scope(this.contextOf(collection)), resolveFile: () => undefined });
    return prepared === undefined ? undefined : { collection: this.collectionKey(prepared.collection.path), auth: prepared.effective.auth, scopes: prepared.scopes, proxy: this.proxy(), tls: prepared.options.tls };
  }

  /** The context a request is in, for the variables that were saved: the active environment and the collection it is in. */
  contextOf(collection: string): RuntimeContext {
    return { environmentId: this.workspace.activeEnvironmentId, collection };
  }

  /** Forgets every variable that a response saved. */
  clearVariables(): void {
    this.runtime.clear();
    this.changed.fire();
  }

  announceVariables(): void {
    this.changed.fire();
  }

  spill(): { dir: string; maxBytes: number } {
    return { dir: this.spillDir, maxBytes: SPILL_LIMIT_BYTES };
  }

  /** VS Code's own proxy setting wins over the variables of the environment, as it does for the rest of VS Code. */
  proxy(): ProxyConfig {
    const settings = vscode.workspace.getConfiguration('http');
    const fromEnvironment = proxyConfigFromEnv(process.env);
    const noProxy = [...settings.get<string[]>('noProxy', []), ...(fromEnvironment.noProxy === undefined ? [] : [fromEnvironment.noProxy])].join(',');
    const chosen = settings.get<string>('proxy', '').trim();
    const base: ProxyConfig = chosen !== '' ? { all: chosen } : { ...fromEnvironment };
    delete base.noProxy;
    return noProxy === '' ? base : { ...base, noProxy };
  }

  dispose(): void {
    this.changed.dispose();
    this.scripts.dispose();
  }
}

/** The scripts that would run for a request, each with the place that its consent is kept under. */
function scriptsToRun(prepared: Prepared): ScriptToRun[] {
  const list: ScriptToRun[] = [];
  for (const source of prepared.effective.preScripts) list.push({ key: scriptKey('pre', source.id), phase: 'pre', from: source.from, code: source.code });
  for (const source of prepared.effective.postScripts) list.push({ key: scriptKey('post', source.id), phase: 'post', from: source.from, code: source.code });
  return list;
}

async function readPrefix(body: WireResponse['body'], limit: number): Promise<Uint8Array> {
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

const EXTENSIONS: Readonly<Record<string, string>> = {
  json: 'json', xml: 'xml', html: 'html', javascript: 'js', text: 'txt'
};
const LANGUAGES: Readonly<Record<string, string>> = { json: 'json', xml: 'xml', html: 'html', javascript: 'javascript', text: 'plaintext' };

/**
 * Sends the request of one editor and keeps its last response: it prepares the request from the files and the active environment,
 * sends it through the engine, turns the answer into what the page shows, and can save or open the body. One send at a time.
 */
export class RequestRunner implements vscode.Disposable {
  private nextId = 1;
  private running: { id: number; controller: AbortController } | undefined;
  private last: { response: WireResponse; view: ResponseView } | undefined;

  constructor(private readonly env: SendEnvironment, private readonly post: (message: ToView) => void) {}

  get isRunning(): boolean {
    return this.running !== undefined;
  }

  private fail(id: number, code: string, message: string, hint = '', warnings: string[] = [], scripts?: ScriptReport): void {
    this.post({ type: 'failed', id, code, message: printable(message), hint: printable(hint), warnings, ...(scripts === undefined ? {} : { scripts }) });
  }

  /** What to say about a request that cannot be sent: the problems in the words for the person, with the warnings that came before. */
  private refuse(id: number, prepared: Prepared, report?: ScriptReport): void {
    const warnings = [...prepared.built.warnings];
    if (prepared.built.unresolved.length > 0) warnings.push(`These variables have no value, so they were sent as written: ${prepared.built.unresolved.join(', ')}.`);
    this.fail(id, 'invalid-request', prepared.problems.join(' '), '', warnings, report);
  }

  /** Runs the scripts of one stage and applies what they asked for to the variables; the request and the report are the caller's to use. */
  private async runStage(phase: ScriptPhase, input: { prepared: Prepared; request: Request; answer: { wire: WireResponse; bytes: Uint8Array } | undefined; report: ScriptReport; signal: AbortSignal; context: RuntimeContext }): Promise<ScriptRun> {
    const { prepared, report } = input;
    const sources = phase === 'pre' ? prepared.effective.preScripts : prepared.effective.postScripts;
    const response = input.answer === undefined ? null : responseForScripts(input.answer.wire, input.answer.bytes);
    const run = await runScripts(this.env.scripts.engine, scriptInput({
      phase: phase === 'pre' ? 'prerequest' : 'test', requestId: input.request.id, requestName: input.request.name, environmentName: prepared.environment?.environment.name ?? '',
      variables: snapshotVariables(prepared.scopeInput, this.env.runtime.snapshot(input.context)),
      request: input.answer === undefined ? requestForScripts(input.request) : sentForScripts(input.answer.wire.sent), response, cookies: response?.cookies ?? [],
      scripts: sources.map(source => ({ code: source.code, from: source.from }))
    }), scriptOperations({ options: prepared.options, signal: input.signal, proxy: this.env.proxy(), jar: prepared.effective.settings.cookies ? this.env.jar : undefined }), { signal: input.signal });
    if (!run.ok) {
      if (run.kind !== 'cancelled') report.errors.push({ phase, from: 'scripts', name: 'Error', message: printable(run.message) });
      return run;
    }
    addOutput(report, phase, run.output, [...prepared.built.redactions, ...secretValues(prepared.scopes)]);
    let changed = false;
    for (const scope of ['active', 'local', 'global'] as const) {
      const changes = run.output.variables[scope];
      if (changes === undefined) continue;
      this.env.runtime.change(scope, changes, input.context);
      changed = true;
    }
    if (changed) this.env.announceVariables();
    return run;
  }

  /** Prepares and sends; resolves when the answer, the failure or the cancellation has been posted. */
  async start(path: string, request: Request): Promise<void> {
    if (this.running !== undefined) return;
    const id = this.nextId++;
    const loaded = this.env.workspace.loaded;
    if (loaded === undefined) { this.fail(id, 'invalid-request', 'No folder is open, so there are no collections to send from.'); return; }
    const collectionPath = locate(loaded, path)?.collection.path ?? '';
    const context = this.env.contextOf(collectionPath);
    const prepare = (current: Request, oauthToken?: { accessToken: string; tokenType: string }): Prepared | undefined => prepareSend({
      loaded, path, request: current, environmentId: this.env.workspace.activeEnvironmentId, clock: realClock, runtime: this.env.runtime.scope(context),
      ...(oauthToken === undefined ? {} : { oauthToken }),
      resolveFile: (collection, relative) => {
        const folder = this.env.workspace.folder();
        return folder === undefined ? undefined : confinedFile(join(folder.uri.fsPath, ...collection.split('/')), relative);
      }
    });
    let prepared = prepare(request);
    if (prepared === undefined) {
      this.fail(id, 'invalid-request', 'This file is not in a collection that is loaded, so its folders, variables and settings are not known.', 'Open it from the Collections view, or check that the collection has no problem listed there.');
      return;
    }
    const scripted = prepared.effective.preScripts.length > 0 || prepared.effective.postScripts.length > 0;
    // A script before the request can fix what is wrong with it (set the address, the variable it uses), so the problems wait for the scripts.
    if (!scripted && prepared.problems.length > 0) { this.refuse(id, prepared); return; }

    await this.forget();
    const controller = new AbortController();
    this.running = { id, controller };
    this.post({ type: 'sending', id });
    const report = emptyReport();
    try {
      let current = request;
      let allowed = false;
      if (scripted) {
        const permission = await this.env.scripts.permit(this.env.collectionKey(prepared.collection.path), scriptsToRun(prepared));
        if (permission.kind === 'cancel') { this.post({ type: 'cancelled', id }); return; }
        if (permission.kind === 'skip') report.notes.push(permission.note);
        else allowed = true;
      }
      if (allowed && prepared.effective.preScripts.length > 0) {
        const before = await this.runStage('pre', { prepared, request: current, answer: undefined, report, signal: controller.signal, context });
        if (!before.ok) {
          if (controller.signal.aborted) this.post({ type: 'cancelled', id });
          else this.fail(id, 'script-error', before.message, 'The request was not sent. Fix the script, or turn scripts off in the settings (apiClient.scripts.enabled) to send without them.', [], report);
          return;
        }
        if (before.output.error !== null) { this.fail(id, 'script-error', 'A script failed before the request was sent.', 'The request was not sent. What the script said is below.', [], report); return; }
        if (before.output.skip) { this.fail(id, 'skipped', 'A script asked not to send this request.', '', [], report); return; }
        if (before.output.request !== undefined) current = withRequestChanges(current, before.output.request);
        const again = prepare(current);
        if (again === undefined) { this.fail(id, 'invalid-request', 'The request is not in a collection that is loaded any more.', '', [], report); return; }
        prepared = again;
      }
      // OAuth 2.0: the access token that is kept, a refreshed one or a new one (which may need the person in the browser); the request is built again with it.
      if (prepared.effective.auth.kind === 'oauth2' && prepared.problems.length === 0) {
        const outcome = await this.env.oauth.token({ collection: this.env.collectionKey(prepared.collection.path), auth: prepared.effective.auth, scopes: prepared.scopes, signal: controller.signal, proxy: this.env.proxy(), tls: prepared.options.tls });
        if (outcome.kind === 'cancelled') { this.post({ type: 'cancelled', id }); return; }
        if (outcome.kind === 'failed') { this.fail(id, 'oauth', outcome.message, outcome.hint, [], hasReport(report) ? report : undefined); return; }
        const withToken = prepare(current, outcome.token);
        if (withToken === undefined) { this.fail(id, 'invalid-request', 'The request is not in a collection that is loaded any more.', '', [], hasReport(report) ? report : undefined); return; }
        prepared = withToken;
      }
      if (prepared.problems.length > 0) { this.refuse(id, prepared, hasReport(report) ? report : undefined); return; }
      const warnings = [...prepared.built.warnings];
      if (prepared.built.unresolved.length > 0) warnings.push(`These variables have no value, so they were sent as written: ${prepared.built.unresolved.join(', ')}.`);

      try {
        const response = await send(prepared.built.wire, {
          ...prepared.options, signal: controller.signal, spill: this.env.spill(), proxy: this.env.proxy(),
          ...(prepared.effective.settings.cookies ? { cookies: this.env.jar } : {})
        });
        const bytes = await readPrefix(response.body, VIEW_READ_BYTES);
        // The tests are judged first, with the variables as they were when the request went out; then the captures save what they read.
        const scopes = prepared.scopes;
        const resolve = (text: string): { text: string; unresolved: readonly string[] } => { const resolved = resolveText(text, scopes, { clock: realClock }); return { text: resolved.text, unresolved: resolved.unresolved }; };
        const subject = testSubject(response, bytes);
        const tests = runTests(prepared.effective.tests.slice(0, MAX_TESTS), subject, resolve);
        const captures = runCaptures(current.captures.filter(item => item.enabled && item.expr.trim() !== '').slice(0, MAX_CAPTURES).map(item => ({ expr: item.expr, from: 'request' })), subject, resolve);
        for (const capture of captures) this.env.runtime.apply(capture, context);
        if (captures.some(capture => capture.ok)) this.env.announceVariables();
        if (allowed && prepared.effective.postScripts.length > 0) await this.runStage('post', { prepared, request: current, answer: { wire: response, bytes }, report, signal: controller.signal, context });
        const view = buildResponseView({ response, bytes, redactions: prepared.built.redactions, warnings, tests, captures, ...(hasReport(report) ? { scripts: report } : {}) });
        this.last = { response, view };
        this.post({ type: 'response', id, response: view });
      } catch (error) {
        const scripts = hasReport(report) ? report : undefined;
        if (error instanceof EngineError && error.code === 'aborted') this.post({ type: 'cancelled', id });
        else if (error instanceof EngineError) this.fail(id, error.code, error.message, error.hint, warnings, scripts);
        else this.fail(id, 'network', error instanceof Error ? error.message : 'The request failed.', '', warnings, scripts);
      }
    } finally {
      this.running = undefined;
    }
  }

  cancel(): void {
    this.running?.controller.abort();
  }

  /** Lets go of the last response, and of the file it was in. */
  private async forget(): Promise<void> {
    const old = this.last;
    this.last = undefined;
    if (old?.response.body.kind === 'file') await disk.rm(old.response.body.path, { force: true }).catch(() => undefined);
  }

  /** The whole body as bytes, or undefined when there is none or it is too large to hold. */
  private async wholeBody(limit: number): Promise<Uint8Array | undefined> {
    const body = this.last?.response.body;
    if (body === undefined) return undefined;
    if (body.kind === 'memory') return body.bytes;
    const stats = await disk.stat(body.path);
    return stats.size > limit ? undefined : new Uint8Array(await disk.readFile(body.path));
  }

  async save(): Promise<void> {
    const last = this.last;
    if (last === undefined) return;
    const subtype = last.view.body.mediaType.split('/')[1] ?? '';
    const extension = last.view.body.kind === 'image' && /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : last.view.body.kind === 'text' ? EXTENSIONS[last.view.body.language] ?? 'txt' : 'bin';
    const folder = this.env.workspace.folder();
    const target = await vscode.window.showSaveDialog({ ...(folder === undefined ? {} : { defaultUri: vscode.Uri.joinPath(folder.uri, `response.${extension}`) }), title: 'Save the body of the response' });
    if (target === undefined) return;
    if (last.response.body.kind === 'file') await disk.copyFile(last.response.body.path, target.fsPath);
    else await vscode.workspace.fs.writeFile(target, last.response.body.bytes);
  }

  /** The whole body as text, formatted when asked and possible; undefined (after telling the person why) when it is not text or is too large. */
  private async wholeText(pretty: boolean, what: string): Promise<string | undefined> {
    const last = this.last;
    if (last === undefined || last.view.body.kind === 'empty') return undefined;
    const bytes = await this.wholeBody(OPEN_LIMIT_BYTES);
    if (last.view.body.kind !== 'text' || bytes === undefined) {
      void vscode.window.showInformationMessage(last.view.body.kind === 'text' ? `The body is too large to ${what}. Save it instead.` : 'The body is not text. Save it instead.');
      return undefined;
    }
    const text = decodeBodyText(bytes, last.view.body.charset).text;
    if (!pretty) return text;
    return (last.view.body.language === 'json' ? formatJson(text) : last.view.body.language === 'xml' ? formatXml(text) : undefined) ?? text;
  }

  async copy(pretty: boolean): Promise<void> {
    const text = await this.wholeText(pretty, 'copy');
    if (text === undefined) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('API Client: the body is copied.', 2500);
  }

  async open(): Promise<void> {
    const last = this.last;
    const text = await this.wholeText(true, 'open in an editor');
    if (last === undefined || text === undefined) return;
    const document = await vscode.workspace.openTextDocument({ language: LANGUAGES[last.view.body.language] ?? 'plaintext', content: text });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  dispose(): void {
    this.running?.controller.abort();
    void this.forget();
  }
}
