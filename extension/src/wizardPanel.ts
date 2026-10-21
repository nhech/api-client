import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Candidate } from '../../src/discover';
import { shortenHome } from '../../src/util/display-path';
import { buildWizardHtml } from '../../src/wizard/html';
import { parseToHost } from '../../src/wizard/protocol';
import { WizardSession } from '../../src/wizard/session';
import type { ToHost, ToView, WizardView } from '../../src/wizard/types';
import { VscodeHost } from './vscodeHost';

/**
 * The importer panel: one webview that shows the state of a `WizardSession` and passes the person's choices to it. The page is
 * ours and runs only our script (see src/wizard/html.ts), but what it shows comes from a collection somebody else made, so every
 * message it sends is parsed as untrusted (src/wizard/protocol.ts). Folders and files are asked for with VS Code's own
 * dialogs: no path ever comes from the page. Nothing is written until the Import message, which only the Import button sends.
 */
const VIEW_TYPE = 'httpFilesImporter.panel';
const REST_CLIENT_ID = 'humao.rest-client';

const shorten = (fsPath: string): string => shortenHome(fsPath, os.homedir());

export class WizardPanel {
  private static current: WizardPanel | undefined;

  private readonly session: WizardSession;
  private readonly disposables: vscode.Disposable[] = [];
  /** Kept from the start: once the panel is disposed, VS Code throws when `panel.webview` is read. */
  private readonly webview: vscode.Webview;
  private ready = false;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext, private readonly host: VscodeHost, candidates: readonly Candidate[]) {
    this.webview = panel.webview;
    this.session = new WizardSession({
      workspaceRoot: () => host.workspaceRoot(),
      workspaceName: () => vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      home: os.homedir(),
      candidates,
      restClientInstalled: () => vscode.extensions.getExtension(REST_CLIENT_ID) !== undefined,
      applyRestClientSettings: settings => host.applyRestClientSettings(settings),
      changed: () => this.post()
    });
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.png');
    panel.webview.html = buildWizardHtml({
      cspSource: panel.webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'wizard.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'wizard.css')).toString()
    });
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }),
      panel.onDidDispose(() => this.dispose()),
      // What would be written depends on the workspace: plan again when it changes.
      vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.session.workspaceChanged(); })
    );
  }

  /** Opens the panel, or brings the one that is open to the front. `candidates` are the places Thunder Client's data was found. */
  static show(context: vscode.ExtensionContext, host: VscodeHost, candidates: readonly Candidate[]): WizardPanel {
    if (WizardPanel.current !== undefined) {
      WizardPanel.current.panel.reveal(undefined, false);
      return WizardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'HTTP Files Importer', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    WizardPanel.current = new WizardPanel(panel, context, host, candidates);
    return WizardPanel.current;
  }

  /** For the tests of the extension: the state the panel shows now, and a way to send it a message as the page would. */
  static get open(): WizardPanel | undefined { return WizardPanel.current; }
  view(): WizardView { return this.session.view(); }
  /** The page has loaded and its script has run (it says so with its first message). */
  get isReady(): boolean { return this.ready; }
  async receive(raw: unknown): Promise<void> {
    const message = parseToHost(raw);
    if (message === undefined) return;
    try {
      await this.handle(message);
    } catch {
      // A message from the page must never take the extension down, and an error text could hold a path; say only that it failed,
      // and do not say that nothing was written when the files had been written already.
      await this.host.error(this.session.hasWritten ? 'The files were written, but the panel could not show the result. Look in the folder.' : 'The importer could not do that. Nothing was written.');
    }
  }

  private post(): void {
    if (!this.ready || this.disposed) return;
    const message: ToView = { type: 'state', view: this.session.view() };
    // A page that has gone away is not an error: the message is simply not delivered.
    void this.webview.postMessage(message).then(undefined, () => undefined);
  }

  private async handle(message: ToHost): Promise<void> {
    switch (message.type) {
      case 'ready': this.ready = true; this.post(); return;
      case 'useCandidate': await this.session.useCandidate(message.id); return;
      case 'chooseFolder': {
        const folder = await this.host.chooseFolder();
        if (folder !== undefined) await this.session.useSource(folder, 'Thunder Client data folder', shorten(folder));
        return;
      }
      case 'chooseFiles': {
        const files = await this.host.chooseFiles();
        if (files !== undefined && files.length > 0) { const described = this.session.describeFiles(files); await this.session.useSource(files, described.title, described.detail); }
        return;
      }
      case 'cancelScan': this.session.cancelScan(); return;
      case 'setOptions': await this.session.setOptions(message.options); return;
      case 'import': await this.session.write(); return;
      case 'startOver': this.session.startOver(); return;
      case 'openReportPreview': await this.host.showReport(this.session.reportMarkdown()); return;
      case 'openFolder': { const folder = this.session.writtenFolder(); if (folder !== undefined) await this.host.openFolder(folder); return; }
      case 'openWrittenReport': { const report = this.session.writtenReport(); if (report !== undefined) await this.host.openReport(report); return; }
      case 'openWorkspace': await vscode.commands.executeCommand('workbench.action.files.openFolder'); return;
    }
  }

  /** Runs when the panel is closed (it is already disposed then): forget it first, so that the command can open a new one whatever else fails. */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (WizardPanel.current === this) WizardPanel.current = undefined;
    this.session.close();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
