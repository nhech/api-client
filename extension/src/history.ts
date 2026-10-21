import { randomBytes } from 'node:crypto';
import { promises as disk } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { addEntry, formatEntry, readHistory, type HistoryEntry } from '../../src/history/entries';
import { buildEntry, readMode, type HistoryInput, type HistoryMode } from '../../src/history/record';
import { historyTree, type HistoryIcon, type HistoryNode } from '../../src/history/tree';
import type { ResponseView } from '../../src/view/response';
import type { Execution } from './execute';
import { OPEN_REQUEST_COMMAND } from './trees';
import type { ClientWorkspace } from './clientWorkspace';

/**
 * What was sent, kept on this computer for this workspace (in the storage of VS Code for it, never in a file of the collection, so it is not committed
 * and not shared): the entries, the view that lists them by day, and the read-only document that shows one. The setting `apiClient.history.mode`
 * says how much is kept. Only a send that the person made from an editor is recorded; the exchanges of OAuth, the requests of scripts and the
 * runs of the collection runner are not.
 */
export const HISTORY_SCHEME = 'apiclient-history';
const FILE_NAME = 'history.json';
const SAVE_DELAY_MS = 400;
/** A file larger than this is not what this code wrote, and is not read. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class HistoryService implements vscode.Disposable {
  private entries: HistoryEntry[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Where the list is kept: the storage of VS Code for this workspace, which no repository ever holds. */
  readonly file: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  /** Set by the tests of the extension to answer, without anybody there, the question before the history is deleted. */
  confirmClear: ((count: number) => Promise<boolean>) | undefined;

  constructor(context: vscode.ExtensionContext) {
    const folder = context.storageUri?.fsPath;
    this.file = folder === undefined ? undefined : join(folder, FILE_NAME);
    this.loading = this.load();
  }

  get mode(): HistoryMode {
    return readMode(vscode.workspace.getConfiguration('apiClient').get<string>('history.mode', 'metadata'));
  }

  list(): readonly HistoryEntry[] {
    return this.entries;
  }

  find(id: string): HistoryEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  /** Resolves when what was kept has been read, so that a test does not look at the list before it is there. */
  ready(): Promise<void> {
    return this.loading;
  }

  private async load(): Promise<void> {
    if (this.file !== undefined) {
      try {
        const stats = await disk.stat(this.file);
        if (stats.size <= MAX_FILE_BYTES) this.entries = readHistory(JSON.parse(await disk.readFile(this.file, 'utf8')), Date.now());
      } catch { /* no file yet, or one that cannot be read: the history starts empty */ }
    }
    this.changed.fire();
  }

  /** Writes down a send, as the mode says; nothing is written for a send that was not made (a request that was refused, a script that stopped it, a cancel). */
  async recordSend(path: string, name: string, started: number, outcome: Execution, view: ResponseView | undefined): Promise<void> {
    const mode = this.mode;
    if (mode === 'off') return;
    const base = { id: `${started.toString(36)}-${randomBytes(4).toString('hex')}`, at: started, name, path };
    let input: HistoryInput;
    if (outcome.kind === 'sent' && view !== undefined) {
      const { attempt } = outcome;
      const body = view.body.kind === 'text' ? view.body.raw : `(${view.body.kind === 'empty' ? 'no' : view.body.kind} body${view.body.mediaType === '' ? '' : `, ${view.body.mediaType}`}, ${view.size} bytes)`;
      input = {
        ...base, ms: outcome.response.timings.totalMs, environment: attempt.environment, method: attempt.method, url: attempt.url, redactions: attempt.redactions,
        sent: { headers: view.sent.headers, body: view.sent.body },
        answer: { status: view.status, statusText: view.statusText, size: view.size, headers: view.headers, body }
      };
    } else if (outcome.kind === 'failed' && outcome.attempt !== undefined) {
      const { attempt } = outcome;
      input = { ...base, ms: Date.now() - started, environment: attempt.environment, method: attempt.method, url: attempt.url, redactions: attempt.redactions, error: outcome.message };
    } else return;
    const entry = buildEntry(input, mode);
    if (entry === undefined) return;
    await this.loading;
    this.entries = addEntry(this.entries, entry, Date.now());
    this.changed.fire();
    this.schedule();
  }

  remove(id: string): void {
    const kept = this.entries.filter(entry => entry.id !== id);
    if (kept.length === this.entries.length) return;
    this.entries = kept;
    this.changed.fire();
    this.schedule();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.changed.fire();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.write(); }, SAVE_DELAY_MS);
  }

  /** Writes the list now (a test, or the end of the session). The file is replaced whole, so a window that closes in the middle leaves the old one. */
  write(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const file = this.file;
    if (file === undefined) return Promise.resolve();
    const text = JSON.stringify(this.entries);
    this.writing = this.writing.then(async () => {
      try {
        await disk.mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await disk.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
        await disk.rename(temporary, file);
      } catch { /* the history is a convenience: a disk that cannot be written does not stop a send */ }
    });
    return this.writing;
  }

  dispose(): void {
    if (this.timer !== undefined) void this.write();
    this.changed.dispose();
  }
}

const ICONS: Record<HistoryIcon, [string, string | undefined]> = {
  day: ['calendar', undefined], success: ['pass', 'testing.iconPassed'], redirect: ['arrow-right', 'charts.blue'], 'client-error': ['warning', 'list.warningForeground'],
  'server-error': ['error', 'list.errorForeground'], failed: ['circle-slash', 'list.errorForeground'], info: ['info', undefined]
};

/** The view of the history: one folder for each day. */
export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: HistoryNode[] = [];
  private readonly subscription: vscode.Disposable;

  constructor(private readonly history: HistoryService) {
    this.rebuild();
    this.subscription = history.onDidChange(() => { this.rebuild(); this.changed.fire(); });
  }

  private rebuild(): void {
    this.nodes = historyTree(this.history.list(), Date.now(), at => -new Date(at).getTimezoneOffset());
  }

  /** What the view shows now, for the tests of the extension. */
  snapshot(): HistoryNode[] {
    return this.nodes;
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const first = this.nodes[0]?.id === node.id;
    const item = new vscode.TreeItem(node.label, node.kind === 'day' ? (first ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.kind === 'day' ? 'historyDay' : 'historyEntry';
    const [icon, color] = ICONS[node.icon];
    item.iconPath = new vscode.ThemeIcon(icon, color === undefined ? undefined : new vscode.ThemeColor(color));
    if (node.kind === 'entry') item.command = { command: 'apiClient.history.open', title: 'Open', arguments: [node] };
    return item;
  }

  getChildren(node?: HistoryNode): HistoryNode[] {
    return node === undefined ? this.nodes : node.children;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

/** Shows an entry as a document that cannot be edited. */
class HistoryDocuments implements vscode.TextDocumentContentProvider {
  constructor(private readonly history: HistoryService) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const entry = this.history.find(uri.path.replace(/^\//, '').replace(/\.txt$/, ''));
    return entry === undefined ? 'This entry is not in the history any more.\n' : formatEntry(entry);
  }
}

const idOf = (given: unknown): string | undefined => {
  if (typeof given === 'string') return given;
  const id = typeof given === 'object' && given !== null && 'id' in given ? (given as { id: unknown }).id : undefined;
  return typeof id === 'string' && id.startsWith('entry:') ? id.slice('entry:'.length) : undefined;
};

/** The commands of the history view, and the provider of the documents. */
export function registerHistory(context: vscode.ExtensionContext, history: HistoryService, workspace: ClientWorkspace): void {
  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try { return await (handler as (...inner: unknown[]) => unknown)(...args); } catch (error) { void vscode.window.showErrorMessage(`API Client: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
    }));
  };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, new HistoryDocuments(history)));
  register('apiClient.history.open', async (given?: unknown) => {
    const id = idOf(given);
    if (id === undefined || history.find(id) === undefined) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: HISTORY_SCHEME, path: `/${id}.txt` }));
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('apiClient.history.openRequest', async (given?: unknown) => {
    const id = idOf(given);
    const entry = id === undefined ? undefined : history.find(id);
    const uri = entry === undefined || entry.path === '' ? undefined : workspace.absolute(entry.path);
    if (uri === undefined) return;
    try { await vscode.workspace.fs.stat(uri); } catch { void vscode.window.showInformationMessage('The file of this request is not there any more: it was moved or deleted.'); return; }
    await vscode.commands.executeCommand(OPEN_REQUEST_COMMAND, entry?.path);
  });
  register('apiClient.history.remove', (given?: unknown) => {
    const id = idOf(given);
    if (id !== undefined) history.remove(id);
  });
  register('apiClient.history.clear', async () => {
    const count = history.list().length;
    if (count === 0) return;
    const yes = history.confirmClear !== undefined
      ? await history.confirmClear(count)
      : (await vscode.window.showWarningMessage(`Delete all ${count} ${count === 1 ? 'entry' : 'entries'} of the history?`, { modal: true, detail: 'This cannot be undone. The requests themselves are not touched.' }, 'Delete')) === 'Delete';
    if (yes) history.clear();
  });
}
