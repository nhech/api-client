import { relative } from 'node:path';
import * as vscode from 'vscode';
import type { ContainerNode, Child, EnvironmentNode, Loaded } from '../../src/storage/store';
import { childSlugs, findChild, findEnvironment, orderAfter, planDrop } from '../../src/storage/organise';
import type { ClientWorkspace } from './clientWorkspace';

/** What an open editor was showing, so that it can be shown again where the file has gone. */
interface OpenTab {
  path: string;
  viewType: string | undefined;
  column: vscode.ViewColumn;
}

const isInside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/**
 * Renaming, copying, moving and deleting what the side bar shows. Every one of them works through the store, on the files as they
 * are on disk now (the tree is loaded again first), and looks after the editors that have the files open: a file with unsaved
 * changes is never touched, and an editor of a file that moves is shown again at its new place.
 */
export class Organiser {
  constructor(private readonly workspace: ClientWorkspace) {}

  private store() {
    const files = this.workspace.files;
    if (files === undefined) throw new Error('Open a folder first: the client keeps its files in the folder of the workspace.');
    return files;
  }

  /** The path of a file relative to the workspace folder, or undefined when it is not inside it. */
  private relativePath(uri: vscode.Uri): string | undefined {
    const folder = this.workspace.folder();
    if (folder === undefined || uri.scheme !== 'file') return undefined;
    const path = relative(folder.uri.fsPath, uri.fsPath).replaceAll('\\', '/');
    return path.startsWith('..') || path === '' ? undefined : path;
  }

  /** The editors that have a file inside one of `paths` open. */
  private openTabs(paths: readonly string[]): { tab: vscode.Tab; open: OpenTab }[] {
    const found: { tab: vscode.Tab; open: OpenTab }[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
        const path = uri === undefined ? undefined : this.relativePath(uri);
        if (path === undefined || !paths.some(folder => isInside(path, folder))) continue;
        found.push({ tab, open: { path, viewType: input instanceof vscode.TabInputCustom ? input.viewType : undefined, column: group.viewColumn } });
      }
    }
    return found;
  }

  /**
   * Runs `change` with the editors of the files closed, and shows them again at the place `moved` gives (nothing for a file that is
   * gone). A file with unsaved changes stops the whole thing before anything is done.
   */
  private async guarded<T>(paths: readonly string[], change: () => Promise<T>, moved: (old: string, result: T) => string | undefined): Promise<T> {
    for (const document of vscode.workspace.textDocuments) {
      const path = this.relativePath(document.uri);
      if (document.isDirty && path !== undefined && paths.some(folder => isInside(path, folder))) throw new Error(`${path.split('/').pop()} has changes that are not saved. Save or close it first.`);
    }
    const tabs = this.openTabs(paths);
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs.map(item => item.tab));
    let result: T;
    try {
      result = await change();
    } finally {
      await this.workspace.reload();
    }
    for (const { open } of tabs) {
      const path = moved(open.path, result);
      const uri = path === undefined ? undefined : this.workspace.absolute(path);
      if (uri === undefined) continue;
      try {
        if (open.viewType === undefined) await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: open.column, preview: false });
        else await vscode.commands.executeCommand('vscode.openWith', uri, open.viewType, { viewColumn: open.column, preview: false });
      } catch { /* the file is not there any more: nothing to show */ }
    }
    return result;
  }

  private async fresh(): Promise<Loaded> {
    await this.workspace.reload();
    const loaded = this.workspace.loaded;
    if (loaded === undefined) throw new Error('Open a folder first: the client keeps its files in the folder of the workspace.');
    return loaded;
  }

  private entry(loaded: Loaded, path: string): Child | EnvironmentNode {
    const found = findChild(loaded, path) ?? findEnvironment(loaded, path);
    if (found === undefined) throw new Error('That is not in the collections any more. Refresh the view.');
    return found;
  }

  async rename(path: string, name: string): Promise<string> {
    const loaded = await this.fresh();
    const files = this.store();
    const node = this.entry(loaded, path);
    if (node.kind === 'environment') return (await files.saveEnvironment(node, { ...node.environment, name })).path;
    if (node.kind === 'request') return this.guarded([node.path], () => files.saveRequest(node, { ...node.request, name }), (_old, result) => result.path).then(result => result.path);
    const renamed = await this.guarded([node.path], () => files.renameContainer(node, name), (old, result) => result.path + old.slice(node.path.length));
    return renamed.path;
  }

  /** A copy next to the original; the path of the copy. */
  async duplicate(path: string): Promise<string> {
    const loaded = await this.fresh();
    const files = this.store();
    const node = this.entry(loaded, path);
    let copy: string;
    if (node.kind === 'environment') {
      const created = await files.createEnvironment(`${node.environment.name} copy`);
      copy = (await files.saveEnvironment(created, { ...node.environment, id: created.environment.id, name: created.environment.name })).path;
    } else copy = (await files.duplicate(node)).path;
    await this.workspace.reload();
    return copy;
  }

  /** Deletes the entries and everything inside them. A folder that is chosen together with something inside it is deleted once. */
  async remove(paths: readonly string[]): Promise<void> {
    const loaded = await this.fresh();
    const files = this.store();
    const nodes = paths.filter((path, index) => paths.indexOf(path) === index && !paths.some(other => other !== path && path.startsWith(`${other}/`))).map(path => this.entry(loaded, path));
    await this.guarded(nodes.map(node => node.path), async () => { for (const node of nodes) await files.remove(node); }, () => undefined);
    if (nodes.some(node => node.kind === 'environment' && node.environment.id === this.workspace.activeEnvironmentId)) await this.workspace.setActiveEnvironment(undefined);
  }

  /**
   * Moves requests and folders into a folder or collection (dropped on it, at the end) or next to a request (dropped on it, before it).
   * Returns a sentence when the move is refused, or undefined when it was done or there was nothing to do.
   */
  async drop(sourcePaths: readonly string[], targetPath: string | undefined): Promise<string | undefined> {
    const loaded = await this.fresh();
    const files = this.store();
    const result = planDrop(loaded, sourcePaths, targetPath);
    if (!result.ok) return result.reason === '' ? undefined : result.reason;
    const { plan } = result;
    const target = findChild(loaded, plan.toDir) as ContainerNode;
    const existing = childSlugs(target);
    await this.guarded(plan.nodes.map(node => node.path), async () => {
      const moved: Child[] = [];
      for (const node of plan.nodes) moved.push(await files.move(node, plan.toDir));
      await files.reorder(plan.toDir, orderAfter(existing, moved.map(node => node.slug), plan.beforeSlug));
      return moved;
    }, (old, moved) => {
      const index = plan.nodes.findIndex(node => isInside(old, node.path));
      const to = moved[index];
      const from = plan.nodes[index];
      return to === undefined || from === undefined ? undefined : to.path + old.slice(from.path.length);
    });
    return undefined;
  }
}
