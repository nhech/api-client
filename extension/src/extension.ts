import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { candidatePaths, inspectCandidates } from '../../src/discover';
import { runImportFlow } from '../../src/host';
import type { FlowResult } from '../../src/host';
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
}

/**
 * The extension only wires: two commands, one panel, one read-only document for the report. It starts nothing by itself, shows no
 * notification of its own accord, and uses no network. Everything it does is in src/ (tested without VS Code).
 */
export function activate(context: vscode.ExtensionContext): ImporterTestApi | undefined {
  const reports = new ReportDocuments();
  const host = new VscodeHost(reports);
  // The folders worth suggesting: the one of this editor first, then the other usual places. Only names are looked at.
  const candidates = () => inspectCandidates(candidatePaths({
    platform: platform(), home: os.homedir(), appData: process.env['APPDATA'], globalStorageRoot: path.dirname(context.globalStorageUri.fsPath)
  }));
  context.subscriptions.push(
    reports,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.commands.registerCommand(IMPORT_COMMAND, async (): Promise<void> => { WizardPanel.show(context, host, await candidates()); }),
    vscode.commands.registerCommand(STEPS_COMMAND, async (): Promise<FlowResult> => runImportFlow(host, { candidates: await candidates() })),
    // The Explorer view has no items: it exists to show its welcome text, with the button that opens the panel.
    vscode.window.registerTreeDataProvider<never>(START_VIEW, { getTreeItem: item => item, getChildren: () => [] })
  );
  return process.env['HTTP_FILES_IMPORTER_TEST'] === '1' ? { panel: () => WizardPanel.open } : undefined;
}

export function deactivate(): void { /* nothing is kept running */ }
