import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { candidatePaths, inspectCandidates } from '../../src/discover';
import { runImportFlow } from '../../src/host';
import type { FlowResult } from '../../src/host';
import type { TreeNode } from '../../src/view/tree';
import { ClientWorkspace } from './clientWorkspace';
import { registerCommands } from './commands';
import { CollectionsTree, EnvironmentsTree } from './trees';
import { REPORT_SCHEME, ReportDocuments, VscodeHost } from './vscodeHost';
import { WizardPanel } from './wizardPanel';

/** The importer panel. */
export const IMPORT_COMMAND = 'apiClient.importThunder';
/** The same import as a short series of questions in the Command Palette, for people who prefer the keyboard. */
export const STEPS_COMMAND = 'apiClient.importThunderSteps';
const START_VIEW = 'apiClient.start';

const platform = (): 'win32' | 'darwin' | 'linux' => (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux');

/** What the tests of the extension may reach. It exists only when the test runner asks for it, so no other extension can drive an import. */
export interface ImporterTestApi {
  panel(): { view(): ReturnType<WizardPanel['view']>; receive(raw: unknown): Promise<void>; readonly isReady: boolean } | undefined;
  /** The client's side bar: what the views show and the files behind it. */
  client(): { workspace: ClientWorkspace; collections: TreeNode[]; environments: TreeNode[]; setFilter(text: string): void };
}

/**
 * The extension wires the views, the commands and the panels, and does the work through src/ (tested without VS Code). It
 * starts nothing by itself and shows no notification of its own accord.
 */
export function activate(context: vscode.ExtensionContext): ImporterTestApi | undefined {
  const reports = new ReportDocuments();
  const host = new VscodeHost(reports);
  // The folders worth suggesting: the one of this editor first, then the other usual places. Only names are looked at.
  const candidates = () => inspectCandidates(candidatePaths({
    platform: platform(), home: os.homedir(), appData: process.env['APPDATA'], globalStorageRoot: path.dirname(context.globalStorageUri.fsPath)
  }));

  const workspace = new ClientWorkspace(context);
  const collections = new CollectionsTree(workspace);
  const environments = new EnvironmentsTree(workspace);
  collections.view = vscode.window.createTreeView('apiClient.collections', { treeDataProvider: collections, showCollapseAll: true, canSelectMany: true });
  const environmentsView = vscode.window.createTreeView('apiClient.environments', { treeDataProvider: environments });
  // The history is shown here when requests are sent; the view is empty until then.
  const historyView = vscode.window.createTreeView<never>('apiClient.history', { treeDataProvider: { getTreeItem: item => item, getChildren: () => [] } });

  const status = vscode.window.createStatusBarItem('apiClient.environment', vscode.StatusBarAlignment.Left, 100);
  status.name = 'API Client environment';
  status.command = 'apiClient.setEnvironment';
  const showStatus = (): void => {
    const loaded = workspace.loaded;
    if (loaded === undefined || vscode.workspace.workspaceFolders === undefined) { status.hide(); return; }
    const active = loaded.environments.find(item => item.environment.id === workspace.activeEnvironmentId);
    status.text = `$(symbol-variable) ${active === undefined ? 'No environment' : active.environment.name}`;
    status.tooltip = 'API Client: choose the environment whose variables are used';
    status.show();
  };

  context.subscriptions.push(
    reports, workspace, collections, environments, collections.view, environmentsView, historyView, status, workspace.onDidChange(showStatus),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.commands.registerCommand(IMPORT_COMMAND, async (): Promise<void> => { WizardPanel.show(context, host, await candidates()); }),
    vscode.commands.registerCommand(STEPS_COMMAND, async (): Promise<FlowResult> => runImportFlow(host, { candidates: await candidates() })),
    // The Explorer view has no items: it exists to show its welcome text, with the button that opens the panel.
    vscode.window.registerTreeDataProvider<never>(START_VIEW, { getTreeItem: item => item, getChildren: () => [] })
  );
  registerCommands(context, { workspace, collections });
  void workspace.reload();

  return process.env['HTTP_FILES_IMPORTER_TEST'] === '1'
    ? { panel: () => WizardPanel.open, client: () => ({ workspace, collections: collections.snapshot(), environments: environments.snapshot(), setFilter: text => collections.setFilter(text) }) }
    : undefined;
}

export function deactivate(): void { /* nothing is kept running */ }
