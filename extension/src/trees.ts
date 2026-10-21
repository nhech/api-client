import * as vscode from 'vscode';
import { collectionsTree, environmentsTree, findNode, type Collapse, type IconName, type TreeNode } from '../../src/view/tree';
import type { ClientWorkspace } from './clientWorkspace';

/** Opens a request in its editor; registered in extension.ts. */
export const OPEN_REQUEST_COMMAND = 'apiClient.openRequest';

const ICONS: Record<IconName, string> = {
  library: 'library', folder: 'folder', request: 'circle-filled', environment: 'symbol-variable', 'environment-active': 'check', warning: 'warning', info: 'info'
};
const COLLAPSE: Record<Collapse, vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None, collapsed: vscode.TreeItemCollapsibleState.Collapsed, expanded: vscode.TreeItemCollapsibleState.Expanded
};

function itemFor(node: TreeNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, COLLAPSE[node.collapse]);
  item.id = node.id;
  item.description = node.description;
  item.tooltip = node.tooltip === '' ? undefined : node.tooltip;
  item.contextValue = node.contextValue;
  item.iconPath = new vscode.ThemeIcon(ICONS[node.icon], node.color === undefined ? undefined : new vscode.ThemeColor(node.color));
  if (node.kind === 'request') item.command = { command: OPEN_REQUEST_COMMAND, title: 'Open', arguments: [node.path] };
  else if (node.kind === 'broken') item.command = { command: 'apiClient.openAsText', title: 'Open as text', arguments: [node] };
  return item;
}

/** A tree whose content comes from a function of the loaded files, rebuilt when they change. */
abstract class FilesTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  protected readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  protected nodes: TreeNode[] = [];
  /** The view that shows this tree, once it exists, so that a new item can be revealed. */
  view: vscode.TreeView<TreeNode> | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(protected readonly workspace: ClientWorkspace) {
    this.subscription = workspace.onDidChange(() => { this.rebuild(); this.changed.fire(); });
    this.rebuild();
  }

  protected abstract build(): TreeNode[];

  protected rebuild(): void {
    this.nodes = this.build();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return itemFor(node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node === undefined ? this.nodes : node.children;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    const walk = (list: readonly TreeNode[], parent: TreeNode | undefined): TreeNode | undefined => {
      for (const candidate of list) {
        if (candidate.id === node.id) return parent;
        const found = walk(candidate.children, candidate);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(this.nodes, undefined);
  }

  find(id: string): TreeNode | undefined {
    return findNode(this.nodes, id);
  }

  /** Selects and shows a node, opening the folders above it; nothing happens when it is not in the tree (a filter hides it). */
  async reveal(id: string): Promise<void> {
    const node = this.find(id);
    if (node !== undefined && this.view !== undefined) await this.view.reveal(node, { select: true, focus: false, expand: true });
  }

  /** What the view shows, for the tests of the extension. */
  snapshot(): TreeNode[] {
    return this.nodes;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

export class CollectionsTree extends FilesTree {
  private text = '';

  get filter(): string {
    return this.text;
  }

  setFilter(text: string): void {
    this.text = text.trim();
    this.rebuild();
    this.changed.fire();
    void vscode.commands.executeCommand('setContext', 'apiClient.filtering', this.text !== '');
  }

  protected build(): TreeNode[] {
    const loaded = this.workspace.loaded;
    return loaded === undefined ? [] : collectionsTree(loaded, this.text);
  }
}

export class EnvironmentsTree extends FilesTree {
  protected build(): TreeNode[] {
    const loaded = this.workspace.loaded;
    return loaded === undefined ? [] : environmentsTree(loaded, this.workspace.activeEnvironmentId);
  }
}
