import { promises as disk } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { runCaptures, runTests } from '../../src/core/assert';
import { CookieJar } from '../../src/core/cookies';
import type { Request } from '../../src/core/model';
import { RuntimeVariables, type RuntimeContext } from '../../src/core/runtime';
import { resolveText } from '../../src/core/vars';
import { confinedFile } from '../../src/engine/files';
import { locate, prepareSend } from '../../src/engine/prepare';
import { proxyConfigFromEnv, type ProxyConfig } from '../../src/engine/proxy';
import { send } from '../../src/engine/send';
import { EngineError, type WireResponse } from '../../src/engine/types';
import type { ToView } from '../../src/view/request-protocol';
import { buildResponseView, decodeBodyText, formatJson, formatXml, testSubject, VIEW_READ_BYTES, type ResponseView } from '../../src/view/response';
import { printable } from '../../src/util/chars';
import { realClock, type ClientWorkspace } from './clientWorkspace';

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
  private readonly spillDir: string;

  constructor(context: vscode.ExtensionContext, readonly workspace: ClientWorkspace) {
    this.spillDir = join(context.globalStorageUri.fsPath, 'spill');
    // A response that was spilled to a file belongs to a page that is gone when the extension starts again.
    void disk.rm(this.spillDir, { recursive: true, force: true }).catch(() => undefined);
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
  }
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

  private fail(id: number, code: string, message: string, hint = '', warnings: string[] = []): void {
    this.post({ type: 'failed', id, code, message: printable(message), hint: printable(hint), warnings });
  }

  /** Prepares and sends; resolves when the answer, the failure or the cancellation has been posted. */
  async start(path: string, request: Request): Promise<void> {
    if (this.running !== undefined) return;
    const id = this.nextId++;
    const loaded = this.env.workspace.loaded;
    if (loaded === undefined) { this.fail(id, 'invalid-request', 'No folder is open, so there are no collections to send from.'); return; }
    const collectionPath = locate(loaded, path)?.collection.path ?? '';
    const prepared = prepareSend({
      loaded, path, request, environmentId: this.env.workspace.activeEnvironmentId, clock: realClock, runtime: this.env.runtime.scope(this.env.contextOf(collectionPath)),
      resolveFile: (collectionPath, relative) => {
        const folder = this.env.workspace.folder();
        return folder === undefined ? undefined : confinedFile(join(folder.uri.fsPath, ...collectionPath.split('/')), relative);
      }
    });
    if (prepared === undefined) {
      this.fail(id, 'invalid-request', 'This file is not in a collection that is loaded, so its folders, variables and settings are not known.', 'Open it from the Collections view, or check that the collection has no problem listed there.');
      return;
    }
    const warnings = [...prepared.built.warnings];
    if (prepared.built.unresolved.length > 0) warnings.push(`These variables have no value, so they were sent as written: ${prepared.built.unresolved.join(', ')}.`);
    if (prepared.problems.length > 0) { this.fail(id, 'invalid-request', prepared.problems.join(' '), '', warnings); return; }

    await this.forget();
    const controller = new AbortController();
    this.running = { id, controller };
    this.post({ type: 'sending', id });
    try {
      const response = await send(prepared.built.wire, {
        ...prepared.options, signal: controller.signal, spill: this.env.spill(), proxy: this.env.proxy(),
        ...(prepared.effective.settings.cookies ? { cookies: this.env.jar } : {})
      });
      const bytes = await readPrefix(response.body, VIEW_READ_BYTES);
      // The tests are judged first, with the variables as they were when the request went out; then the captures save what they read.
      const resolve = (text: string): { text: string; unresolved: readonly string[] } => { const resolved = resolveText(text, prepared.scopes, { clock: realClock }); return { text: resolved.text, unresolved: resolved.unresolved }; };
      const subject = testSubject(response, bytes);
      const tests = runTests(prepared.effective.tests.slice(0, MAX_TESTS), subject, resolve);
      const captures = runCaptures(request.captures.filter(item => item.enabled && item.expr.trim() !== '').slice(0, MAX_CAPTURES).map(item => ({ expr: item.expr, from: 'request' })), subject, resolve);
      const context = this.env.contextOf(prepared.collection.path);
      for (const capture of captures) this.env.runtime.apply(capture, context);
      if (captures.some(capture => capture.ok)) this.env.announceVariables();
      const view = buildResponseView({ response, bytes, redactions: prepared.built.redactions, warnings, tests, captures });
      this.last = { response, view };
      this.post({ type: 'response', id, response: view });
    } catch (error) {
      if (error instanceof EngineError && error.code === 'aborted') this.post({ type: 'cancelled', id });
      else if (error instanceof EngineError) this.fail(id, error.code, error.message, error.hint, warnings);
      else this.fail(id, 'network', error instanceof Error ? error.message : 'The request failed.', '', warnings);
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
