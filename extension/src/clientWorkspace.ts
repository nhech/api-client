import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Clock } from '../../src/core/clock';
import { NodeFs } from '../../src/storage/node-fs';
import { DEFAULT_ROOT, Store, type Loaded } from '../../src/storage/store';

/**
 * The client's files of the workspace: the folder they live in, the tree that was last loaded from them, the active
 * environment, and a watcher that reloads the tree when a file changes on disk (a pull, a checkout, an edit by hand). The
 * views read from here and never touch the disk themselves.
 */
const ACTIVE_ENVIRONMENT_KEY = 'apiClient.activeEnvironment';
const RELOAD_DELAY_MS = 250;

export const realClock: Clock = { now: () => Date.now(), random: () => Math.random() };

export class ClientWorkspace implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private store: Store | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private current: Loaded | undefined;
  private loading: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.reload(); }), vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('apiClient.root')) void this.reload();
    }));
  }

  /** The workspace folder the client's files are in: the first one that already has them, else the first one. */
  folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  /** The folder of the client's files inside the workspace folder, `api-client` unless the setting says another. */
  root(): string {
    const configured = vscode.workspace.getConfiguration('apiClient').get<string>('root', DEFAULT_ROOT).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return /^[\w.-]+(?:\/[\w.-]+)*$/.test(configured) && !configured.split('/').includes('..') ? configured : DEFAULT_ROOT;
  }

  get loaded(): Loaded | undefined {
    return this.current;
  }

  /** The store for writing; undefined when no folder is open. */
  get files(): Store | undefined {
    return this.store;
  }

  /** The absolute path of a path relative to the workspace folder. */
  absolute(relative: string): vscode.Uri | undefined {
    const folder = this.folder();
    return folder === undefined ? undefined : vscode.Uri.file(join(folder.uri.fsPath, ...relative.split('/')));
  }

  get activeEnvironmentId(): string | undefined {
    return this.context.workspaceState.get<string>(ACTIVE_ENVIRONMENT_KEY);
  }

  async setActiveEnvironment(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_ENVIRONMENT_KEY, id);
    this.changed.fire();
  }

  /** Reads the files again. Calls that arrive while a read is running share it. */
  reload(): Promise<void> {
    this.loading ??= this.read().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async read(): Promise<void> {
    const folder = this.folder();
    if (folder === undefined) {
      this.store = undefined;
      this.current = undefined;
      this.watcher?.dispose();
      this.watcher = undefined;
      this.changed.fire();
      return;
    }
    this.store = new Store(new NodeFs(folder.uri.fsPath), realClock, this.root());
    this.current = await this.store.load();
    this.watch(folder);
    this.changed.fire();
  }

  private watch(folder: vscode.WorkspaceFolder): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${this.root()}/**`));
    const schedule = (): void => {
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; void this.reload(); }, RELOAD_DELAY_MS);
    };
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.watcher?.dispose();
    this.changed.dispose();
  }
}
