import { randomBytes } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import { newRequest } from '../../src/core/model';
import { variablesOf } from '../../src/engine/prepare';
import { readRequest, writeRequest } from '../../src/format/schema';
import type { YMap } from '../../src/format/yaml';
import { applyEditOps, minimalEdit, toRangeEdit } from '../../src/view/edit';
import { buildAppHtml } from '../../src/view/page';
import { parseToHost, type RequestState, type ToHost, type ToView } from '../../src/view/request-protocol';
import { RequestRunner, type SendEnvironment } from './sender';

/** The custom editor of a request file (`*.req.yml`): the page of the client over the text document. */
export const REQUEST_VIEW_TYPE = 'apiClient.request';

/** What the tests of the extension may see of an open request editor. */
export interface RequestEditorTestView {
  readonly isReady: boolean;
  readonly violations: string[];
  /** What the page was last told about the file and the send (not the list of variables). */
  lastMessage(): ToView | undefined;
  /** The last messages the page was told, the lists of variables included, oldest first. */
  messages(): readonly ToView[];
  readonly isSending: boolean;
  state(): RequestState;
  /** Delivers a message as if the page had sent it. */
  receive(raw: unknown): Promise<void>;
}

/**
 * One open request editor. The text document is the truth: an edit of the page is checked, turned into the new text of the file
 * and applied to the document as the smallest change of lines, so that VS Code keeps the dirty mark, the undo stack, the saving
 * and the backup, and a change of the file by something else (a pull, the text editor) is read again and sent to the page.
 */
class RequestSession implements vscode.Disposable, RequestEditorTestView {
  private rev = 1;
  private ready = false;
  private extra: YMap = new Map();
  private selfChanges = 0;
  private last: ToView | undefined;
  private readonly recent: ToView[] = [];
  /** Messages of the page are handled one after the other, so a send never reads the file before the edit that came before it has been applied. */
  private chain: Promise<void> = Promise.resolve();
  private readonly runner: RequestRunner;
  readonly violations: string[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly document: vscode.TextDocument, private readonly panel: vscode.WebviewPanel, env: SendEnvironment) {
    this.runner = new RequestRunner(env, message => this.post(message));
    this.env = env;
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => { this.receive(raw).catch(() => undefined); }),
      env.workspace.onDidChange(() => { if (this.ready) this.postVariables(); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || event.contentChanges.length === 0) return;
        if (this.selfChanges > 0) { this.selfChanges--; return; }
        this.rev++;
        this.post({ type: 'doc', cause: event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo ? 'undo' : 'disk', ...this.state() });
      })
    );
  }

  private readonly env: SendEnvironment;

  get isReady(): boolean {
    return this.ready;
  }

  get isSending(): boolean {
    return this.runner.isRunning;
  }

  lastMessage(): ToView | undefined {
    return this.last;
  }

  messages(): readonly ToView[] {
    return this.recent;
  }

  /** The request as the document holds it now, or why it cannot be edited. */
  state(): RequestState {
    const result = readRequest(this.document.getText());
    if (result.ok) {
      this.extra = result.extra;
      return { rev: this.rev, request: result.value, findings: result.findings, readOnly: undefined };
    }
    const file = this.document.uri.path.slice(this.document.uri.path.lastIndexOf('/') + 1);
    const readOnly = result.newer
      ? 'This file was written by a newer version of the extension, so it is shown but not changed here, to keep everything in it.'
      : `This file cannot be read as a request: ${result.findings.find(finding => finding.severity === 'error')?.message ?? 'it is not in the format'}`;
    return { rev: this.rev, request: newRequest('', file.replace(/\.req\.yml$/, '')), findings: result.findings, readOnly };
  }

  private post(message: ToView): void {
    // The list of variables comes whenever the files change; "what the page was last told" is about the file and the send, so it is left out.
    if (message.type !== 'vars') this.last = message;
    this.recent.push(message);
    if (this.recent.length > 50) this.recent.shift();
    void this.panel.webview.postMessage(message);
  }

  receive(raw: unknown): Promise<void> {
    const message = parseToHost(raw);
    if (message === undefined) return Promise.resolve();
    // Cancelling does not wait for what came before it.
    if (message.type === 'cancel') { this.runner.cancel(); return Promise.resolve(); }
    const run = this.chain.then(() => this.handle(message));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The file of the request relative to the workspace folder, which is how the collections name their requests. */
  private relativePath(): string | undefined {
    const folder = this.env.workspace.folder();
    if (folder === undefined) return undefined;
    const path = relative(folder.uri.fsPath, this.document.uri.fsPath).replaceAll('\\', '/');
    return path.startsWith('..') || isAbsolute(path) ? undefined : path;
  }

  /** Tells the page which variables are defined for this request, as the files and the active environment say now. */
  private postVariables(): void {
    const loaded = this.env.workspace.loaded;
    const path = this.relativePath();
    this.post({ type: 'vars', ...(loaded === undefined || path === undefined ? { vars: [], complete: false } : variablesOf(loaded, path, this.env.workspace.activeEnvironmentId)) });
  }

  private async handle(message: ToHost): Promise<void> {
    if (message.type === 'ready') {
      this.ready = true;
      this.violations.splice(0, this.violations.length, ...message.violations);
      this.post({ type: 'init', ...this.state() });
      this.postVariables();
    } else if (message.type === 'openAsText') {
      await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
    } else if (message.type === 'edit') {
      await this.edit(message.rev, message.ops);
    } else if (message.type === 'send') {
      this.send();
    } else if (message.type === 'saveResponse') {
      await this.runner.save();
    } else if (message.type === 'openResponse') {
      await this.runner.open();
    } else if (message.type === 'violation') {
      if (this.violations.length < 20) this.violations.push(message.text);
    } else if (message.type === 'copyResponse') {
      await this.runner.copy(message.pretty);
    }
  }

  private send(): void {
    const state = this.state();
    const path = this.relativePath();
    if (state.readOnly !== undefined || path === undefined) {
      this.post({ type: 'failed', id: 0, code: 'invalid-request', message: state.readOnly !== undefined ? 'This file cannot be read as a request, so it cannot be sent.' : 'This file is outside the folder that is open, so it cannot be sent from here.', hint: '', warnings: [] });
      return;
    }
    // The send runs on its own; messages that come while it runs (an edit, a cancel) are handled as they arrive.
    void this.runner.start(path, state.request);
  }

  private async edit(rev: number, ops: Parameters<typeof applyEditOps>[1]): Promise<void> {
    const current = this.state();
    if (current.readOnly !== undefined) { this.post({ type: 'rejected', rev: this.rev, reason: 'this file cannot be edited here' }); return; }
    if (rev !== this.rev) {
      this.post({ type: 'rejected', rev: this.rev, reason: 'the file changed in the meantime' });
      this.post({ type: 'doc', cause: 'disk', ...current });
      return;
    }
    const result = applyEditOps(current.request, ops);
    if (!result.ok) { this.post({ type: 'rejected', rev: this.rev, reason: result.reason }); return; }
    const before = this.document.getText();
    const after = writeRequest(result.request, this.extra);
    const change = minimalEdit(before, after);
    if (change !== undefined) {
      const range = toRangeEdit(before, change, this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.replace(this.document.uri, new vscode.Range(range.startLine, range.startChar, range.endLine, range.endChar), range.text);
      this.selfChanges++;
      if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
        this.selfChanges--;
        this.post({ type: 'rejected', rev: this.rev, reason: 'the file could not be changed' });
        return;
      }
    }
    this.rev++;
    this.post({ type: 'doc', cause: 'self', ...this.state() });
  }

  dispose(): void {
    this.runner.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

export class RequestEditorProvider implements vscode.CustomTextEditorProvider {
  /** The open editors by the address of their file, for the tests of the extension. */
  readonly open = new Map<string, RequestSession>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly env: SendEnvironment) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const root = this.context.extensionUri;
    const dist = vscode.Uri.joinPath(root, 'dist');
    const media = vscode.Uri.joinPath(root, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist, media] };
    panel.webview.html = buildAppHtml({
      cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString('base64'), screen: 'request',
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'app.js')).toString(), styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'app.css')).toString()
    });
    const session = new RequestSession(document, panel, this.env);
    const key = document.uri.toString();
    this.open.set(key, session);
    panel.onDidDispose(() => { session.dispose(); if (this.open.get(key) === session) this.open.delete(key); });
  }
}

