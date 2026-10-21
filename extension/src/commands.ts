import * as vscode from 'vscode';
import type { TreeNode } from '../../src/view/tree';
import type { ClientWorkspace } from './clientWorkspace';
import type { RunnerManager } from './runner';
import { findChild } from '../../src/storage/organise';
import type { Organiser } from './organise';
import { CONTAINER_VIEW_TYPE, ENVIRONMENT_VIEW_TYPE } from './documentEditors';
import { REQUEST_VIEW_TYPE } from './requestEditor';
import { OPEN_ENVIRONMENT_COMMAND, OPEN_REQUEST_COMMAND, type CollectionsTree, type EnvironmentsTree } from './trees';

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

/** The name for something new: the one a caller passed as the second argument of the command (a keybinding, another extension, a test), or what the person types. */
async function nameFor(given: unknown, prompt: string, value = ''): Promise<string | undefined> {
  if (typeof given !== 'string') return askName(prompt, value);
  const problem = nameProblem(given);
  if (problem !== undefined) throw new Error(problem);
  return given.trim();
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
  runner: RunnerManager;
  workspace: ClientWorkspace;
  collections: CollectionsTree;
  environments: EnvironmentsTree;
  organiser: Organiser;
}

function fail(error: unknown): void {
  void vscode.window.showErrorMessage(`API Client: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerCommands(context: vscode.ExtensionContext, { runner, workspace, collections, environments, organiser }: CommandContext): void {
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
  register('apiClient.runCollection', async (node?: TreeNode) => {
    const picked = await target(node, 'collection or folder to run');
    if (picked !== undefined) runner.show(picked.path, picked.label);
  });
  register('apiClient.filter', async () => {
    const text = await vscode.window.showInputBox({ prompt: 'Show only the requests whose name, method or address contains', value: collections.filter });
    if (text !== undefined) collections.setFilter(text);
  });
  register('apiClient.clearFilter', () => { collections.setFilter(''); });

  register(OPEN_REQUEST_COMMAND, async (path: string) => {
    const uri = workspace.absolute(path);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, REQUEST_VIEW_TYPE, { preview: true });
  });
  register(OPEN_ENVIRONMENT_COMMAND, async (path: string) => {
    const uri = workspace.absolute(path);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, ENVIRONMENT_VIEW_TYPE, { preview: true });
  });
  register('apiClient.openSettings', async (node?: TreeNode) => {
    const [entry] = chosen(node, undefined, ['collection', 'folder']);
    const loaded = workspace.loaded;
    const files = store();
    if (entry === undefined || loaded === undefined || files === undefined) return;
    const found = findChild(loaded, entry.path);
    if (found === undefined || found.kind === 'request') return;
    await files.materialize(found);
    const uri = workspace.absolute(`${found.path}/${found.kind === 'collection' ? 'collection.yml' : 'folder.yml'}`);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, CONTAINER_VIEW_TYPE, { preview: true });
  });
  register('apiClient.openAsText', async (node: TreeNode | string) => {
    const uri = workspace.absolute(typeof node === 'string' ? node : node.path);
    if (uri !== undefined) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  });
  register('apiClient.revealInExplorer', async (node: TreeNode) => {
    const uri = workspace.absolute(node.path);
    if (uri !== undefined) await vscode.commands.executeCommand('revealInExplorer', uri);
  });

  register('apiClient.newCollection', async (_node?: TreeNode, given?: string) => {
    const name = await nameFor(given, 'Name of the collection');
    const files = store();
    if (name === undefined || files === undefined) return;
    const created = await files.createCollection(name);
    await workspace.reload();
    await collections.reveal(created.path);
  });
  register('apiClient.newFolder', async (node?: TreeNode, given?: string) => {
    const parent = await target(node, 'folder');
    const files = store();
    if (parent === undefined || files === undefined) return;
    const name = await nameFor(given, 'Name of the folder');
    if (name === undefined) return;
    const created = await files.createFolder(parent.path, name);
    await workspace.reload();
    await collections.reveal(created.path);
  });
  register('apiClient.newRequest', async (node?: TreeNode, given?: string) => {
    const parent = await target(node, 'request');
    const files = store();
    if (parent === undefined || files === undefined) return;
    const name = await nameFor(given, 'Name of the request');
    if (name === undefined) return;
    const created = await files.createRequest(parent.path, name);
    await workspace.reload();
    await collections.reveal(created.path);
    await vscode.commands.executeCommand(OPEN_REQUEST_COMMAND, created.path);
  });
  register('apiClient.newEnvironment', async (_node?: TreeNode, given?: string) => {
    const name = await nameFor(given, 'Name of the environment');
    const files = store();
    if (name === undefined || files === undefined) return;
    const created = await files.createEnvironment(name);
    await workspace.reload();
    await workspace.setActiveEnvironment(created.environment.id);
  });
  /** The entries a command of the side bar is meant for: the one it was used on (with the others selected with it), or what is selected in the view that has the focus. */
  const chosen = (node: TreeNode | undefined, selected: readonly TreeNode[] | undefined, kinds: readonly string[]): TreeNode[] => {
    const fallback = [...(collections.view?.selection ?? []), ...(environments.view?.selection ?? [])];
    const list = node === undefined ? fallback : selected !== undefined && selected.some(item => item.id === node.id) ? [...selected] : [node];
    return list.filter(item => kinds.includes(item.kind));
  };
  const ORGANISABLE = ['collection', 'folder', 'request', 'environment'] as const;

  register('apiClient.rename', async (node?: TreeNode, selected?: TreeNode[] | string) => {
    const [entry] = chosen(node, Array.isArray(selected) ? selected : undefined, ORGANISABLE);
    if (entry === undefined) return;
    const name = await nameFor(selected, `New name of the ${entry.kind}`, entry.label);
    if (name === undefined || name === entry.label) return;
    await organiser.rename(entry.path, name);
  });
  register('apiClient.duplicate', async (node?: TreeNode, selected?: TreeNode[]) => {
    for (const entry of chosen(node, selected, ORGANISABLE)) await organiser.duplicate(entry.path);
  });
  register('apiClient.delete', async (node?: TreeNode, selected?: TreeNode[]) => {
    const entries = chosen(node, selected, ORGANISABLE);
    if (entries.length === 0) return;
    const names = entries.slice(0, 8).map(entry => `${entry.label}${entry.description === '' ? '' : ` (${entry.description})`}`).join('\n') + (entries.length > 8 ? `\n... and ${entries.length - 8} more` : '');
    const answer = await vscode.window.showWarningMessage(entries.length === 1 ? `Delete "${entries[0]?.label ?? ''}"?` : `Delete ${entries.length} items?`, { modal: true, detail: `${names}\n\nThe files are deleted from the disk, with everything inside a folder or collection. Git can bring them back if they were committed.` }, 'Delete');
    if (answer !== 'Delete') return;
    await organiser.remove(entries.map(entry => entry.path));
  });
  register('apiClient.moveTo', async (node?: TreeNode, selected?: TreeNode[]) => {
    const entries = chosen(node, selected, ['folder', 'request']);
    if (entries.length === 0) return;
    const places = containers(collections.snapshot()).filter(place => !entries.some(entry => place.node.path === entry.path || place.node.path.startsWith(`${entry.path}/`)));
    const place = await vscode.window.showQuickPick(places, { placeHolder: 'Move to which folder or collection?' });
    if (place === undefined) return;
    const reason = await organiser.drop(entries.map(entry => entry.path), place.node.path);
    if (reason !== undefined) void vscode.window.showWarningMessage(`API Client: ${reason}`);
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
