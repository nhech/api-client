import * as vscode from 'vscode';
import { writeRequest } from '../../src/format/schema';
import { splitFile, parseHeaderLine } from '../../src/mirror/drift';
import { applyEdits } from '../../src/mirror/import';
import { inspectMirror, mirrorPathOf, syncMirrors, type Inspected, type MirrorEntry, type MirrorMode } from '../../src/storage/mirror-sync';
import { NodeFs } from '../../src/storage/node-fs';
import { printable } from '../../src/util/chars';
import type { ClientWorkspace } from './clientWorkspace';

/**
 * The `.http` file next to each request: written after the files are loaded and again whenever they change, shown with lines above its first
 * line that say where it comes from, and, when somebody changes it by hand, never written over: the person is offered to take the edits into
 * the request, to see the difference, to throw the edits away, or to keep the file as their own and let go of it.
 */
const PREVIEW_SCHEME = 'apiclient-preview';
const SYNC_DELAY_MS = 200;
const TAKE = 'Take the edits';
const DISCARD = 'Discard the edits';
const KEEP = 'Keep as my own file';

export class MirrorService implements vscode.Disposable, vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly previewsChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.previewsChanged.event;
  private readonly previews = new Map<string, string>();
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private again = false;
  private nextPreview = 1;
  /** Generated files that somebody changed, as of the last sync. */
  drifted: MirrorEntry[] = [];
  /** The paths of the files written by the last sync (for the tests). */
  lastWritten: string[] = [];
  /** Set by the tests of the extension to answer the questions without anybody there. */
  confirm: ((question: 'discard' | 'detach' | 'take') => Promise<boolean>) | undefined;

  constructor(private readonly workspace: ClientWorkspace, context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem('apiClient.mirror', vscode.StatusBarAlignment.Left, 99);
    this.status.name = 'API Client: .http files edited by hand';
    this.status.command = 'apiClient.mirror.list';
    this.disposables.push(
      this.status, this.lensesChanged, this.previewsChanged,
      workspace.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('apiClient.mirror')) this.schedule(); }),
      vscode.workspace.onDidSaveTextDocument(document => { if (document.fileName.endsWith('.http')) this.schedule(); }),
      vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/*.http' }, this),
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this)
    );
    /** A command that tells the person when it fails instead of leaving the error in the log. */
    const guarded = (handler: (...args: never[]) => unknown) => async (...args: unknown[]): Promise<unknown> => {
      try { return await (handler as (...inner: unknown[]) => unknown)(...args); } catch (error) { void vscode.window.showErrorMessage(`API Client: ${printable(error instanceof Error ? error.message : 'something went wrong')}`); return undefined; }
    };
    this.disposables.push(
      vscode.commands.registerCommand('apiClient.mirror.openRequest', guarded((uri: vscode.Uri) => this.openRequest(uri))),
      vscode.commands.registerCommand('apiClient.mirror.showDifferences', guarded((uri: vscode.Uri) => this.showDifferences(uri))),
      vscode.commands.registerCommand('apiClient.mirror.importEdits', guarded((uri: vscode.Uri) => this.takeEdits(uri))),
      vscode.commands.registerCommand('apiClient.mirror.discardEdits', guarded((uri: vscode.Uri) => this.discardEdits(uri))),
      vscode.commands.registerCommand('apiClient.mirror.detach', guarded((uri: vscode.Uri) => this.detach(uri))),
      vscode.commands.registerCommand('apiClient.mirror.syncNow', guarded(() => this.syncNow())),
      vscode.commands.registerCommand('apiClient.mirror.list', guarded(() => this.list())),
      vscode.commands.registerCommand('apiClient.openMirror', guarded((node: { path: string }) => this.openMirror(node.path)))
    );
    context.subscriptions.push(this);
  }

  // ---- when to write ----

  mode(): MirrorMode {
    const value = vscode.workspace.getConfiguration('apiClient').get<string>('mirror.mode', 'on');
    return value === 'off' || value === 'gitignored' ? value : 'on';
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, SYNC_DELAY_MS);
  }

  /** Runs a sync now (or after the one that is running); resolves when the files are in step. */
  async sync(): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        const loaded = this.workspace.loaded;
        const folder = this.workspace.folder();
        if (loaded === undefined || folder === undefined) { this.drifted = []; break; }
        const report = await syncMirrors(new NodeFs(folder.uri.fsPath), loaded, this.mode(), { skip: path => this.isOpenAndChanged(path) });
        this.drifted = report.drifted;
        this.lastWritten = report.written;
        if (report.failed.length > 0) void vscode.window.showWarningMessage(`API Client: ${report.failed.length === 1 ? 'a .http file' : `${report.failed.length} .http files`} could not be written: ${printable(report.failed[0]?.reason ?? '')}`);
      } while (this.again);
    } finally {
      this.running = false;
      this.refresh();
    }
  }

  private async syncNow(): Promise<void> {
    await this.workspace.reload();
    await this.sync();
    void vscode.window.setStatusBarMessage(`API Client: the .http files are in step (${this.drifted.length} edited by hand).`, 3000);
  }

  private refresh(): void {
    this.status.text = `$(warning) ${this.drifted.length} .http edited`;
    this.status.tooltip = 'Generated .http files that were edited by hand are not written over. Click to see them.';
    if (this.drifted.length > 0) this.status.show(); else this.status.hide();
    this.lensesChanged.fire();
  }

  private relative(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  }

  private isOpenAndChanged(path: string): boolean {
    return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && this.relative(document.uri) === path);
  }

  // ---- what is shown above the first line of a generated file ----

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const loaded = this.workspace.loaded;
    if (loaded === undefined || document.uri.scheme !== 'file') return [];
    const text = document.getText();
    const header = parseHeaderLine(text.split(/\r?\n/, 1)[0] ?? '');
    if (header === undefined) return [];
    const inspected = inspectMirror(loaded, this.relative(document.uri), text);
    const range = new vscode.Range(0, 0, 0, 0);
    const lens = (title: string, command: string): vscode.CodeLens => new vscode.CodeLens(range, { title, command, arguments: [document.uri] });
    /** A line of text that does nothing when it is clicked. */
    const info = (title: string): vscode.CodeLens => new vscode.CodeLens(range, { title, command: '' });
    if (inspected === undefined) return [lens(`Generated from ${printable(header.source)}, which is not there any more`, 'apiClient.mirror.detach')];
    switch (inspected.drift) {
      case 'edited': return [info('Edited by hand: this file is not written over'), lens(TAKE, 'apiClient.mirror.importEdits'), lens('Show the difference', 'apiClient.mirror.showDifferences'), lens(DISCARD, 'apiClient.mirror.discardEdits'), lens(KEEP, 'apiClient.mirror.detach')];
      case 'both': return [info('The request and this file both changed: this file is not written over'), lens('Show the difference', 'apiClient.mirror.showDifferences'), lens('Use the request, discard the edits', 'apiClient.mirror.discardEdits'), lens(KEEP, 'apiClient.mirror.detach')];
      default: return [lens(`Generated from ${printable(header.source)}: edit the request, not this file`, 'apiClient.mirror.openRequest')];
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previews.get(uri.toString()) ?? '';
  }

  private preview(text: string, name: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${this.nextPreview++}/${name}` });
    this.previews.set(uri.toString(), text);
    this.previewsChanged.fire(uri);
    return uri;
  }

  // ---- the commands ----

  private inspect(uri: vscode.Uri, text: string | undefined): Inspected | undefined {
    const loaded = this.workspace.loaded;
    return loaded === undefined ? undefined : inspectMirror(loaded, this.relative(uri), text);
  }

  private async openRequest(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const inspected = this.inspect(uri, document.getText());
    const target = inspected === undefined ? undefined : this.workspace.absolute(inspected.node.path);
    if (target !== undefined) await vscode.commands.executeCommand('vscode.open', target);
  }

  private async openMirror(requestPath: string): Promise<void> {
    await this.sync();
    const target = this.workspace.absolute(mirrorPathOf(requestPath));
    if (target === undefined) return;
    try { await vscode.workspace.fs.stat(target); } catch { void vscode.window.showInformationMessage('There is no .http file for this request: it is turned off in the settings of the request, or the setting apiClient.mirror.mode is off.'); return; }
    await vscode.commands.executeCommand('vscode.open', target);
  }

  private async showDifferences(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const inspected = this.inspect(uri, document.getText());
    if (inspected === undefined) return;
    await vscode.commands.executeCommand('vscode.diff', uri, this.preview(inspected.text, 'generated.http'), 'This file, and what the request gives now');
  }

  /** Replaces the whole text of a file and saves it, through the editor, so that an open tab and its undo stay right. */
  private async replaceText(uri: vscode.Uri, text: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), text);
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  private async confirmed(question: 'discard' | 'detach' | 'take', message: string, detail: string, button: string): Promise<boolean> {
    if (this.confirm !== undefined) return this.confirm(question);
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button;
  }

  private async discardEdits(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const inspected = this.inspect(uri, document.getText());
    if (inspected === undefined) return;
    if (!await this.confirmed('discard', 'Throw away the edits of this .http file?', 'The file is written again from the request. What you changed in the file is lost.', DISCARD)) return;
    await this.replaceText(uri, inspected.text);
    await this.sync();
  }

  private async detach(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (!await this.confirmed('detach', 'Keep this .http file as your own?', 'The first line that says it is generated is taken out, and the request stops writing the file. From now on nothing here is changed by the extension.', KEEP)) return;
    const inspected = this.inspect(uri, document.getText());
    const edit = new vscode.WorkspaceEdit();
    edit.delete(uri, document.validateRange(new vscode.Range(0, 0, 1, 0)));
    await vscode.workspace.applyEdit(edit);
    await document.save();
    const files = this.workspace.files;
    if (inspected !== undefined && files !== undefined) {
      await files.saveRequest(inspected.node, { ...inspected.node.request, mirror: false });
      await this.workspace.reload();
    }
    await this.sync();
  }

  private async takeEdits(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const inspected = this.inspect(uri, document.getText());
    const files = this.workspace.files;
    if (inspected === undefined || files === undefined) return;
    if (inspected.drift !== 'edited') {
      void vscode.window.showInformationMessage(inspected.drift === 'both' ? 'The request changed as well, so the edits cannot be taken safely. Look at the difference, or use the request.' : 'There is nothing to take: the file has not been edited.');
      return;
    }
    const result = applyEdits({ request: inspected.node.request, levels: inspected.chain.map(container => ({ kind: container.kind, name: container.container.name, container: container.container })), before: inspected.mirror, edited: splitFile(document.getText()).block });
    if (result.changes.length === 0 && result.lost.length === 0) { void vscode.window.showInformationMessage('Nothing in the file differs from the request.'); return; }
    const target = this.workspace.absolute(inspected.node.path);
    if (target !== undefined) await vscode.commands.executeCommand('vscode.diff', target, this.preview(writeRequest(result.request, inspected.node.extra), 'request.req.yml'), 'The request now, and with the edits of the .http file');
    const detail = [
      result.changes.length === 0 ? 'No edit can be taken.' : `Taken:\n${result.changes.map(line => `- ${printable(line)}`).join('\n')}`,
      ...(result.lost.length === 0 ? [] : [`Not taken, and lost when the file is written again:\n${result.lost.map(line => `- ${printable(line)}`).join('\n')}`])
    ].join('\n\n');
    if (!await this.confirmed('take', 'Take these edits into the request?', detail, TAKE)) return;
    await files.saveRequest(inspected.node, result.request);
    await this.workspace.reload();
    const again = this.inspect(uri, undefined);
    if (again !== undefined) await this.replaceText(uri, again.text);
    await this.sync();
  }

  private async list(): Promise<void> {
    const items = this.drifted.map(entry => ({ label: entry.path.split('/').pop() ?? entry.path, description: entry.drift === 'both' ? 'the request changed too' : 'edited by hand', path: entry.path }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Generated .http files that were edited by hand' });
    const target = picked === undefined ? undefined : this.workspace.absolute(picked.path);
    if (target !== undefined) await vscode.commands.executeCommand('vscode.open', target);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const item of this.disposables) item.dispose();
  }
}
