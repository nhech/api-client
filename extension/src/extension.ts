import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { candidatePaths, inspectCandidates } from '../../src/discover';
import { runImportFlow } from '../../src/host';
import type { FlowResult } from '../../src/host';
import { REPORT_SCHEME, ReportDocuments, VscodeHost } from './vscodeHost';

export const IMPORT_COMMAND = 'apiClient.importThunder';

const platform = (): 'win32' | 'darwin' | 'linux' => (process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux');

/**
 * The extension only wires: one command, one read-only document for the report. It starts nothing by itself, shows no
 * notification of its own accord, and uses no network. Everything it does is in src/ (tested without VS Code).
 */
export function activate(context: vscode.ExtensionContext): void {
  const reports = new ReportDocuments();
  context.subscriptions.push(
    reports,
    vscode.workspace.registerTextDocumentContentProvider(REPORT_SCHEME, reports),
    vscode.commands.registerCommand(IMPORT_COMMAND, async (): Promise<FlowResult> => {
      // The folders worth suggesting: the one of this editor first, then the other usual places. Only names are looked at.
      const candidates = await inspectCandidates(candidatePaths({
        platform: platform(), home: os.homedir(), appData: process.env['APPDATA'], globalStorageRoot: path.dirname(context.globalStorageUri.fsPath)
      }));
      return runImportFlow(new VscodeHost(reports), { candidates });
    })
  );
}

export function deactivate(): void { /* nothing is kept running */ }
