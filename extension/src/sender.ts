import { promises as disk } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { CookieJar } from '../../src/core/cookies';
import type { Request } from '../../src/core/model';
import { RuntimeVariables, type RuntimeContext } from '../../src/core/runtime';
import { confinedFile } from '../../src/engine/files';
import { locate, prepareSend, type Prepared } from '../../src/engine/prepare';
import { proxyConfigFromEnv, type ProxyConfig } from '../../src/engine/proxy';
import type { WireResponse } from '../../src/engine/types';
import type { ToView } from '../../src/view/request-protocol';
import { buildResponseView, decodeBodyText, formatJson, formatXml, type ResponseView } from '../../src/view/response';
import { hasReport } from '../../src/view/scripts';
import { realClock, type ClientWorkspace } from './clientWorkspace';
import { executeRequest } from './execute';
import { OAuthService, type TokenRequestInput } from './oauth';
import type { HistoryService } from './history';
import { ScriptService } from './scripts';

/** A response whose body goes to a file when it is larger than the memory limit of the settings is kept up to this size. */
const SPILL_LIMIT_BYTES = 256 * 1024 * 1024;
/** The most of a body that is opened in an editor tab; a larger one can be saved. */
const OPEN_LIMIT_BYTES = 32 * 1024 * 1024;

/** What every request editor shares when it sends: the files, the cookie jar, the variables that requests have set, and where large responses are put. */
export class SendEnvironment implements vscode.Disposable {
  readonly jar: CookieJar;
  /** What the captures of the responses saved; the editors are told when it changes. */
  readonly runtime = new RuntimeVariables();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeVariables = this.changed.event;
  /** Whether scripts may run, and the engine they run in. */
  readonly scripts: ScriptService;
  /** The access tokens of the requests that use OAuth 2.0. */
  readonly oauth: OAuthService;
  private readonly spillDir: string;

  constructor(context: vscode.ExtensionContext, readonly workspace: ClientWorkspace, jar: CookieJar, readonly history: HistoryService) {
    this.jar = jar;
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

  /** The request as it would be sent now, built but not sent: the scripts are not run and no access token is asked for. */
  describe(path: string, request: Request): Prepared | undefined {
    const loaded = this.workspace.loaded;
    if (loaded === undefined) return undefined;
    const collection = locate(loaded, path)?.collection.path ?? '';
    return prepareSend({
      loaded, path, request, environmentId: this.workspace.activeEnvironmentId, clock: realClock, runtime: this.runtime.scope(this.contextOf(collection)),
      resolveFile: (collectionPath, relative) => {
        const folder = this.workspace.folder();
        return folder === undefined ? undefined : confinedFile(join(folder.uri.fsPath, ...collectionPath.split('/')), relative);
      }
    });
  }

  /** What the OAuth service needs to know about a request: its collection, the authentication that applies to it (its own or inherited), the variables, and how to connect. */
  oauthInput(path: string, request: Request): Omit<TokenRequestInput, 'signal'> | undefined {
    const prepared = this.describe(path, request);
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

  /** Prepares and sends; resolves when the answer, the failure or the cancellation has been posted. */
  async start(path: string, request: Request): Promise<void> {
    if (this.running !== undefined) return;
    const id = this.nextId++;
    await this.forget();
    const controller = new AbortController();
    this.running = { id, controller };
    this.post({ type: 'sending', id });
    const started = Date.now();
    try {
      const outcome = await executeRequest(this.env, path, request, { signal: controller.signal });
      if (outcome.kind === 'cancelled') { this.post({ type: 'cancelled', id }); return; }
      if (outcome.kind === 'failed') {
        void this.env.history.recordSend(path, request.name, started, outcome, undefined);
        this.post({ type: 'failed', id, code: outcome.code, message: outcome.message, hint: outcome.hint, warnings: outcome.warnings, ...(outcome.report === undefined ? {} : { scripts: outcome.report }) });
        return;
      }
      const view = buildResponseView({
        response: outcome.response, bytes: outcome.bytes, redactions: outcome.redactions, warnings: outcome.warnings, tests: outcome.tests, captures: outcome.captures,
        ...(hasReport(outcome.report) ? { scripts: outcome.report } : {})
      });
      this.last = { response: outcome.response, view };
      void this.env.history.recordSend(path, request.name, started, outcome, view);
      this.post({ type: 'response', id, response: view });
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
