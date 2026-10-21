import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { candidatePaths, inspectCandidates } from '../../src/discover';
import { runImportFlow } from '../../src/host';
import type { FlowResult } from '../../src/host';
import type { TreeNode } from '../../src/view/tree';
import { ClientWorkspace } from './clientWorkspace';
import { ContainerEditorProvider, ENVIRONMENT_VIEW_TYPE, CONTAINER_VIEW_TYPE, EnvironmentEditorProvider, type DocumentEditorTestView } from './documentEditors';
import { Organiser } from './organise';
import { registerCommands } from './commands';
import { RequestEditorProvider, REQUEST_VIEW_TYPE, type RequestEditorTestView } from './requestEditor';
import { CookieManager } from './cookies';
import { MirrorService } from './mirror';
import { RunnerManager, type RunnerTestView } from './runner';
import { SendEnvironment } from './sender';
import type { OAuthService } from './oauth';
import type { ScriptService } from './scripts';
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
  /** The consent to run scripts: the tests answer the question for the person. */
  scripts: ScriptService;
  /** The .http files next to the requests. */
  mirror: MirrorService;
  /** The access tokens of OAuth 2.0: the tests answer the questions and stand for the browser. */
  oauth: OAuthService;
  /** The open collection runners, by the path of the collection or folder they run. */
  runner(path: string): RunnerTestView | undefined;
  /** The cookies that requests received. */
  cookies: CookieManager;
  panel(): { view(): ReturnType<WizardPanel['view']>; receive(raw: unknown): Promise<void>; readonly isReady: boolean } | undefined;
  /** The client's side bar: what the views show and the files behind it. */
  client(): { workspace: ClientWorkspace; collections: TreeNode[]; environments: TreeNode[]; setFilter(text: string): void; organiser: Organiser };
  /** The open editor of a request file, by the address of the file. */
  requestEditor(uri: string): RequestEditorTestView | undefined;
  /** The open editors of an environment file and of a collection or folder file. */
  environmentEditor(uri: string): DocumentEditorTestView | undefined;
  containerEditor(uri: string): DocumentEditorTestView | undefined;
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
  const organiser = new Organiser(workspace);
  const collections = new CollectionsTree(workspace, organiser);
  const environments = new EnvironmentsTree(workspace);
  collections.view = vscode.window.createTreeView('apiClient.collections', { treeDataProvider: collections, showCollapseAll: true, canSelectMany: true, dragAndDropController: collections });
  const environmentsView = vscode.window.createTreeView('apiClient.environments', { treeDataProvider: environments, canSelectMany: true });
  environments.view = environmentsView;
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

  const cookies = new CookieManager(context);
  const sending = new SendEnvironment(context, workspace, cookies.jar);
  const mirror = new MirrorService(workspace, context);
  const runner = new RunnerManager(context, sending, workspace);
  const requests = new RequestEditorProvider(context, sending);
  const environmentEditors = new EnvironmentEditorProvider(context, workspace);
  const containerEditors = new ContainerEditorProvider(context, workspace);
  const editorOptions = { webviewOptions: { retainContextWhenHidden: false }, supportsMultipleEditorsPerDocument: false };
  context.subscriptions.push(
    sending, runner, cookies,
    vscode.commands.registerCommand('apiClient.cookies', () => cookies.show()),
    vscode.commands.registerCommand('apiClient.clearCookies', () => { cookies.clearAll(); }),
    vscode.window.registerCustomEditorProvider(REQUEST_VIEW_TYPE, requests, editorOptions),
    vscode.window.registerCustomEditorProvider(ENVIRONMENT_VIEW_TYPE, environmentEditors, editorOptions),
    vscode.window.registerCustomEditorProvider(CONTAINER_VIEW_TYPE, containerEditors, editorOptions),
    vscode.commands.registerCommand('apiClient.clearVariables', () => { sending.clearVariables(); }),
    vscode.commands.registerCommand('apiClient.forgetTokens', async () => { await sending.oauth.forgetAll(); void vscode.window.showInformationMessage('API Client: the access tokens and the servers that were allowed are forgotten. You are asked again before credentials are sent.'); }),
    vscode.commands.registerCommand('apiClient.forgetScripts', async () => { await sending.scripts.forgetAll(); void vscode.window.showInformationMessage('API Client: no script is allowed to run any more. You are asked again before the next one runs.'); }),
    reports, workspace, collections, environments, collections.view, environmentsView, historyView, status, workspace.onDidChange(showStatus),
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.commands.registerCommand(IMPORT_COMMAND, async (): Promise<void> => { WizardPanel.show(context, host, await candidates()); }),
    vscode.commands.registerCommand(STEPS_COMMAND, async (): Promise<FlowResult> => runImportFlow(host, { candidates: await candidates() })),
    // The Explorer view has no items: it exists to show its welcome text, with the button that opens the panel.
    vscode.window.registerTreeDataProvider<never>(START_VIEW, { getTreeItem: item => item, getChildren: () => [] })
  );
  registerCommands(context, { runner, workspace, collections, environments, organiser });
  void workspace.reload();

  return process.env['HTTP_FILES_IMPORTER_TEST'] === '1'
    ? { scripts: sending.scripts, mirror, oauth: sending.oauth, runner: path => runner.open.get(path), cookies, panel: () => WizardPanel.open, client: () => ({ workspace, collections: collections.snapshot(), environments: environments.snapshot(), setFilter: text => collections.setFilter(text), organiser }), requestEditor: uri => requests.open.get(uri), environmentEditor: uri => environmentEditors.open.get(uri), containerEditor: uri => containerEditors.open.get(uri) }
    : undefined;
}

export function deactivate(): void { /* nothing is kept running */ }
