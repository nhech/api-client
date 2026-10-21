import * as vscode from 'vscode';
import type { TreeNode } from '../../src/view/tree';
import type { ClientWorkspace } from './clientWorkspace';
import { OPEN_REQUEST_COMMAND, type CollectionsTree } from './trees';

/**
 * The commands of the side bar: create, open, filter, refresh and choose the environment. Each one reads from the loaded
 * files and writes through the store, one file at a time, and then the tree reloads itself from the files.
 */
function nameProblem(value: string): string | undefined {
  const name = value.trim();
  if (name === '') return 'A name is needed.';
  if (name.length > 200) return 'The name is longer than 200 characters.';
  if (/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(name)) return 'The name has a character that cannot be shown.';
  return undefined;
}

async function askName(prompt: string, value = ''): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({ prompt, value, validateInput: nameProblem });
  return answer === undefined ? undefined : answer.trim();
}

/** Every collection and folder, for a list to pick from. */
function containers(nodes: readonly TreeNode[], prefix = ''): { label: string; node: TreeNode }[] {
  const out: { label: string; node: TreeNode }[] = [];
  for (const node of nodes) {
    if (node.kind !== 'collection' && node.kind !== 'folder') continue;
    const label = prefix === '' ? node.label : `${prefix} / ${node.label}`;
    out.push({ label, node }, ...containers(node.children, label));
  }
  return out;
}

export interface CommandContext {
  workspace: ClientWorkspace;
  collections: CollectionsTree;
}

function fail(error: unknown): void {
  void vscode.window.showErrorMessage(`API Client: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerCommands(context: vscode.ExtensionContext, { workspace, collections }: CommandContext): void {
  /** The folder or collection a new item goes into: the one the command was used on, or one the person picks. */
  const target = async (node: TreeNode | undefined, what: string): Promise<TreeNode | undefined> => {
    if (node !== undefined && (node.kind === 'collection' || node.kind === 'folder')) return node;
    const all = containers(collections.snapshot());
    if (all.length === 0) {
      void vscode.window.showInformationMessage('Make a collection first.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(all, { placeHolder: `Where should the ${what} go?` }))?.node;
  };
  const store = (): NonNullable<ClientWorkspace['files']> | undefined => {
    if (workspace.files === undefined) void vscode.window.showInformationMessage('Open a folder first: the client keeps its files in the folder of the workspace.');
    return workspace.files;
  };

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try { return await (handler as (...inner: unknown[]) => unknown)(...args); } catch (error) { fail(error); return undefined; }
    }));
  };

  register('apiClient.refresh', async () => { await workspace.reload(); });
  register('apiClient.filter', async () => {
    const text = await vscode.window.showInputBox({ prompt: 'Show only the requests whose name, method or address contains', value: collections.filter });
    if (text !== undefined) collections.setFilter(text);
  });
  register('apiClient.clearFilter', () => { collections.setFilter(''); });

  register(OPEN_REQUEST_COMMAND, async (path: string) => {
    const uri = workspace.absolute(path);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
  });
  register('apiClient.openAsText', async (node: TreeNode | string) => {
    const uri = workspace.absolute(typeof node === 'string' ? node : node.path);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  });
  register('apiClient.revealInExplorer', async (node: TreeNode) => {
    const uri = workspace.absolute(node.path);
    if (uri !== undefined) await vscode.commands.executeCommand('revealInExplorer', uri);
  });

  register('apiClient.newCollection', async () => {
    const name = await askName('Name of the collection');
    const files = store();
    if (name === undefined || files === undefined) return;
    const created = await files.createCollection(name);
    await workspace.reload();
    await collections.reveal(created.path);
  });
  register('apiClient.newFolder', async (node?: TreeNode) => {
    const parent = await target(node, 'folder');
    const files = store();
    if (parent === undefined || files === undefined) return;
    const name = await askName('Name of the folder');
    if (name === undefined) return;
    const created = await files.createFolder(parent.path, name);
    await workspace.reload();
    await collections.reveal(created.path);
  });
  register('apiClient.newRequest', async (node?: TreeNode) => {
    const parent = await target(node, 'request');
    const files = store();
    if (parent === undefined || files === undefined) return;
    const name = await askName('Name of the request');
    if (name === undefined) return;
    const created = await files.createRequest(parent.path, name);
    await workspace.reload();
    await collections.reveal(created.path);
    await vscode.commands.executeCommand(OPEN_REQUEST_COMMAND, created.path);
  });
  register('apiClient.newEnvironment', async () => {
    const name = await askName('Name of the environment');
    const files = store();
    if (name === undefined || files === undefined) return;
    const created = await files.createEnvironment(name);
    await workspace.reload();
    await workspace.setActiveEnvironment(created.environment.id);
  });
  register('apiClient.setEnvironment', async (node?: TreeNode) => {
    const loaded = workspace.loaded;
    if (loaded === undefined) return;
    let id: string | undefined;
    if (node !== undefined && node.kind === 'environment') id = loaded.environments.find(item => item.path === node.path)?.environment.id;
    else {
      const picks = [{ label: '$(circle-slash) No environment', id: undefined as string | undefined }, ...loaded.environments.map(item => ({ label: item.environment.name, id: item.environment.id as string | undefined }))];
      const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'The environment whose variables are used' });
      if (chosen === undefined) return;
      id = chosen.id;
    }
    await workspace.setActiveEnvironment(id);
  });
}
