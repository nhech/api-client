import { isAbsolute, relative } from 'node:path';
import * as vscode from 'vscode';
import type { Container, Environment } from '../../src/core/model';
import { readContainer, readEnvironment, writeContainer, writeEnvironment, type Finding } from '../../src/format/schema';
import type { YMap } from '../../src/format/yaml';
import { mergeSecrets, splitSecrets } from '../../src/storage/secrets';
import { applyOps, containerCodec, ENVIRONMENT_CODEC, minimalEdit, toRangeEdit, type OpsResult } from '../../src/view/edit';
import { parseToHost, type DocumentState, type EditOp, type ToHost, type ToView } from '../../src/view/request-protocol';
import { configureAppPanel } from './appPanel';
import type { ClientWorkspace } from './clientWorkspace';

/** The editors of an environment (`*.env.yml`) and of a collection or folder (`collection.yml`, `folder.yml`): the page over the text document. */
export const ENVIRONMENT_VIEW_TYPE = 'apiClient.environment';
export const CONTAINER_VIEW_TYPE = 'apiClient.container';

/** What the tests of the extension may see of an open editor of this kind. */
export interface DocumentEditorTestView {
  readonly isReady: boolean;
  readonly violations: string[];
  lastMessage(): ToView | undefined;
  messages(): readonly ToView[];
  state(): Promise<DocumentState>;
  receive(raw: unknown): Promise<void>;
}

/** What an edit comes to: the new text of the file, and what else has to be written first (the file of the secret values). */
type Edited = { ok: true; text: string; before?: () => Promise<void> } | { ok: false; reason: string };

/**
 * The shared part of the editors of an environment and of a collection or folder. As with a request, the text document is the truth:
 * an edit of the page is checked, turned into the new text of the file and applied to the document as the smallest change of lines, so
 * VS Code keeps the dirty mark, the undo stack and the saving. What differs is the file of the secret values next to the document: the
 * page is given the secrets put back into the variables, and an edit that touches them is written there and never into the document.
 */
abstract class DocumentSession implements vscode.Disposable, DocumentEditorTestView {
  protected rev = 1;
  protected ready = false;
  protected extra: YMap = new Map();
  private selfChanges = 0;
  private last: ToView | undefined;
  private readonly recent: ToView[] = [];
  private chain: Promise<void> = Promise.resolve();
  readonly violations: string[] = [];
  protected readonly subscriptions: vscode.Disposable[] = [];

  constructor(protected readonly document: vscode.TextDocument, private readonly panel: vscode.WebviewPanel, protected readonly workspace: ClientWorkspace) {
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => { this.receive(raw).catch(() => undefined); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || event.contentChanges.length === 0) return;
        if (this.selfChanges > 0) { this.selfChanges--; return; }
        this.rev++;
        const cause = event.reason === vscode.TextDocumentChangeReason.Undo || event.reason === vscode.TextDocumentChangeReason.Redo ? 'undo' : 'disk';
        void this.state().then(state => this.post({ type: 'document', cause, ...state }));
      })
    );
  }

  /** The file as the page is given it. */
  abstract state(): Promise<DocumentState>;
  /** What the edits come to, or why they are refused. */
  protected abstract edited(state: DocumentState, ops: EditOp[]): Edited;
  /** A message that only this kind of editor has; true when it was handled. */
  protected async extraMessage(message: ToHost): Promise<boolean> {
    void message;
    return false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  lastMessage(): ToView | undefined {
    return this.last;
  }

  messages(): readonly ToView[] {
    return this.recent;
  }

  protected post(message: ToView): void {
    this.last = message;
    this.recent.push(message);
    if (this.recent.length > 50) this.recent.shift();
    void this.panel.webview.postMessage(message);
  }

  /** The file of the document relative to the workspace folder. */
  protected relativePath(): string | undefined {
    const folder = this.workspace.folder();
    if (folder === undefined) return undefined;
    const path = relative(folder.uri.fsPath, this.document.uri.fsPath).replaceAll('\\', '/');
    return path.startsWith('..') || isAbsolute(path) ? undefined : path;
  }

  protected readOnlyReason(result: { newer: boolean; findings: Finding[] }, what: string): string {
    return result.newer
      ? 'This file was written by a newer version of the extension, so it is shown but not changed here, to keep everything in it.'
      : `This file cannot be read as ${what}: ${result.findings.find(finding => finding.severity === 'error')?.message ?? 'it is not in the format'}`;
  }

  receive(raw: unknown): Promise<void> {
    const message = parseToHost(raw);
    if (message === undefined) return Promise.resolve();
    const run = this.chain.then(() => this.handle(message));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async handle(message: ToHost): Promise<void> {
    if (message.type === 'ready') {
      this.ready = true;
      this.violations.splice(0, this.violations.length, ...message.violations);
      this.post({ type: 'document', cause: 'init', ...(await this.state()) });
    } else if (message.type === 'openAsText') {
      await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
    } else if (message.type === 'violation') {
      if (this.violations.length < 20) this.violations.push(message.text);
    } else if (message.type === 'edit') {
      await this.edit(message.rev, message.ops);
    } else {
      await this.extraMessage(message);
    }
  }

  private async edit(rev: number, ops: EditOp[]): Promise<void> {
    const current = await this.state();
    if (current.readOnly !== undefined) { this.post({ type: 'rejected', rev: this.rev, reason: 'this file cannot be edited here' }); return; }
    if (rev !== this.rev) {
      this.post({ type: 'rejected', rev: this.rev, reason: 'the file changed in the meantime' });
      this.post({ type: 'document', cause: 'disk', ...current });
      return;
    }
    const result = this.edited(current, ops);
    if (!result.ok) { this.post({ type: 'rejected', rev: this.rev, reason: result.reason }); return; }
    const before = this.document.getText();
    const change = minimalEdit(before, result.text);
    try {
      await result.before?.();
    } catch (error) {
      this.post({ type: 'rejected', rev: this.rev, reason: error instanceof Error ? error.message : 'the secret values could not be written' });
      return;
    }
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
    this.post({ type: 'document', cause: 'self', ...(await this.state()) });
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

const failed = (result: Extract<OpsResult<unknown>, { ok: false }>): Edited => ({ ok: false, reason: result.reason });

/** The editor of an environment: its name and its variables, with the values of the secret ones kept in the file that Git ignores. */
class EnvironmentSession extends DocumentSession {
  constructor(document: vscode.TextDocument, panel: vscode.WebviewPanel, workspace: ClientWorkspace) {
    super(document, panel, workspace);
    // Another place made this environment the active one, or the files were loaded again.
    this.subscriptions.push(workspace.onDidChange(() => {
      if (this.ready) void this.state().then(state => { if (state.screen === 'environment') this.post({ type: 'document', cause: 'meta', ...state }); });
    }));
  }

  async state(): Promise<DocumentState> {
    const result = readEnvironment(this.document.getText());
    if (!result.ok) return { screen: 'environment', environment: { id: '', name: '', vars: [] }, active: false, rev: this.rev, findings: result.findings, readOnly: this.readOnlyReason(result, 'an environment') };
    this.extra = result.extra;
    const path = this.relativePath();
    const local = path === undefined ? undefined : await this.workspace.files?.readSecrets(path);
    const merged = mergeSecrets(result.value.vars, local?.values ?? {});
    const findings = [...result.findings, ...(local?.problem === undefined ? [] : [{ path: '', message: `the file with the secret values is not usable: ${local.problem}`, severity: 'warning' as const }])];
    return {
      screen: 'environment', environment: { ...result.value, vars: merged.vars }, active: this.workspace.activeEnvironmentId === result.value.id && result.value.id !== '',
      rev: this.rev, findings, readOnly: undefined
    };
  }

  protected edited(state: DocumentState, ops: EditOp[]): Edited {
    if (state.screen !== 'environment') return { ok: false, reason: 'this is not an environment' };
    const result = applyOps<Environment>(state.environment, ops, ENVIRONMENT_CODEC);
    if (!result.ok) return failed(result);
    const { shared, secrets } = splitSecrets(result.value.vars);
    const path = this.relativePath();
    const files = this.workspace.files;
    return {
      ok: true, text: writeEnvironment({ ...result.value, vars: shared }, this.extra),
      ...(path === undefined || files === undefined ? {} : { before: () => files.writeSecrets(path, secrets) })
    };
  }

  protected override async extraMessage(message: ToHost): Promise<boolean> {
    if (message.type !== 'activate') return false;
    const state = await this.state();
    if (state.screen === 'environment' && state.environment.id !== '') await this.workspace.setActiveEnvironment(state.environment.id);
    return true;
  }
}

/** The editor of a collection or a folder: what its requests inherit (base URL, headers, authentication, variables, settings). */
class ContainerSession extends DocumentSession {
  private get kind(): 'collection' | 'folder' {
    return this.document.uri.path.endsWith('/collection.yml') ? 'collection' : 'folder';
  }

  async state(): Promise<DocumentState> {
    const kind = this.kind;
    const result = readContainer(this.document.getText(), kind);
    if (!result.ok) return { screen: 'container', kind, container: { id: '', name: '', docs: '', baseUrl: '', headers: [], auth: { kind: 'inherit' }, vars: [], scripts: { pre: '', post: '' }, tests: [], settings: {}, order: [] }, rev: this.rev, findings: result.findings, readOnly: this.readOnlyReason(result, `a ${kind}`) };
    this.extra = result.extra;
    const path = this.relativePath();
    const local = path === undefined ? undefined : await this.workspace.files?.readSecrets(path);
    const merged = mergeSecrets(result.value.vars, local?.values ?? {});
    const findings = [...result.findings, ...(local?.problem === undefined ? [] : [{ path: '', message: `the file with the secret values is not usable: ${local.problem}`, severity: 'warning' as const }])];
    return { screen: 'container', kind, container: { ...result.value, vars: merged.vars }, rev: this.rev, findings, readOnly: undefined };
  }

  protected edited(state: DocumentState, ops: EditOp[]): Edited {
    if (state.screen !== 'container') return { ok: false, reason: 'this is not a collection or a folder' };
    const result = applyOps<Container>(state.container, ops, containerCodec(state.kind));
    if (!result.ok) return failed(result);
    const { shared, secrets } = splitSecrets(result.value.vars);
    const path = this.relativePath();
    const files = this.workspace.files;
    return {
      ok: true, text: writeContainer({ ...result.value, vars: shared }, this.extra),
      ...(path === undefined || files === undefined ? {} : { before: () => files.writeSecrets(path, secrets) })
    };
  }
}

abstract class DocumentEditorProvider implements vscode.CustomTextEditorProvider {
  /** The open editors by the address of their file, for the tests of the extension. */
  readonly open = new Map<string, DocumentSession>();

  constructor(protected readonly context: vscode.ExtensionContext, protected readonly workspace: ClientWorkspace, private readonly screen: 'environment' | 'container') {}

  protected abstract session(document: vscode.TextDocument, panel: vscode.WebviewPanel): DocumentSession;

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    configureAppPanel(this.context, panel, this.screen);
    const session = this.session(document, panel);
    const key = document.uri.toString();
    this.open.set(key, session);
    panel.onDidDispose(() => { session.dispose(); if (this.open.get(key) === session) this.open.delete(key); });
  }
}

export class EnvironmentEditorProvider extends DocumentEditorProvider {
  constructor(context: vscode.ExtensionContext, workspace: ClientWorkspace) {
    super(context, workspace, 'environment');
  }

  protected session(document: vscode.TextDocument, panel: vscode.WebviewPanel): DocumentSession {
    return new EnvironmentSession(document, panel, this.workspace);
  }
}

export class ContainerEditorProvider extends DocumentEditorProvider {
  constructor(context: vscode.ExtensionContext, workspace: ClientWorkspace) {
    super(context, workspace, 'container');
  }

  protected session(document: vscode.TextDocument, panel: vscode.WebviewPanel): DocumentSession {
    return new ContainerSession(document, panel, this.workspace);
  }
}
