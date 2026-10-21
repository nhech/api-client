import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Candidate } from '../../src/discover';
import { importMessages } from '../../src/host';
import type { DoneAction, ImportHost, ImportSettings, RestClientSettingsOutcome, ScopeOutcome, SourceChoice } from '../../src/host';
import { REST_CLIENT_SETTING, mergeEnvironments } from '../../src/settings-merge';
import type { EnvMap, RestClientSettings } from '../../src/settings-merge';
import type { ImportSummary } from '../../src/pipeline';
import type { WriteOutcome, WritePlan } from '../../src/write/writer';
import { shortenHome } from '../../src/util/display-path';
import { targetSegments } from '../../src/write/paths';
import { TARGETS, TARGET_LABEL } from '../../src/model/target';

/**
 * The questions of the import flow (spec 9) asked with the VS Code API. This file holds no rule: what to ask and in which
 * order is in src/host.ts, which is tested without VS Code. Quick Picks only, no modal dialog.
 */
export const REPORT_SCHEME = 'api-client-import';
const REST_CLIENT_ID = 'humao.rest-client';

/** Serves the report as a read-only virtual document, so that nothing is written before the person has confirmed. */
export class ReportDocuments implements vscode.TextDocumentContentProvider {
  readonly uri = vscode.Uri.from({ scheme: REPORT_SCHEME, path: '/IMPORT_REPORT.md' });
  private text = '';
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(): string { return this.text; }

  set(markdown: string): void {
    this.text = markdown;
    this.changed.fire(this.uri);
  }

  dispose(): void { this.changed.dispose(); }
}

const shorten = (fsPath: string): string => shortenHome(fsPath, os.homedir());

const POLICY_LABEL: Readonly<Record<ImportSettings['policy'], string>> = {
  'new-folder': 'Use a new folder when the target already has files',
  'skip-existing': 'Keep files that already exist',
  overwrite: 'Replace files that already exist'
};
const POLICY_ORDER: readonly ImportSettings['policy'][] = ['new-folder', 'skip-existing', 'overwrite'];

export class VscodeHost implements ImportHost {
  constructor(private readonly reports: ReportDocuments) {}

  workspaceRoot(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder !== undefined && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
  }

  async pickSource(candidates: readonly Candidate[]): Promise<SourceChoice | undefined> {
    type Item = vscode.QuickPickItem & { choice?: SourceChoice };
    const items: Item[] = candidates.map(candidate => ({
      label: '$(folder) Thunder Client data on this computer',
      description: [candidate.collections > 0 ? `${candidate.collections} collection${candidate.collections === 1 ? '' : 's'}` : undefined, candidate.environments > 0 ? `${candidate.environments} environment${candidate.environments === 1 ? '' : 's'}` : undefined, candidate.v3 ? 'older format' : undefined].filter(Boolean).join(', '),
      detail: shorten(candidate.path),
      choice: { kind: 'path', path: candidate.path }
    }));
    if (items.length > 0) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(folder-opened) Choose a folder...', description: 'a Thunder Client data folder', choice: { kind: 'folder' } });
    items.push({ label: '$(file) Choose export files...', description: 'collection or environment files exported from Thunder Client', choice: { kind: 'files' } });
    const picked = await vscode.window.showQuickPick(items, { title: 'Import from Thunder Client', placeHolder: 'Where is the data? Nothing is changed in that folder.', ignoreFocusOut: true });
    return picked?.choice;
  }

  async chooseFolder(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Import from this folder', title: 'Thunder Client data folder' });
    return picked?.[0]?.fsPath;
  }

  async chooseFiles(): Promise<string[] | undefined> {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true, filters: { JSON: ['json'] }, openLabel: 'Import these files', title: 'Thunder Client export files' });
    return picked?.map(uri => uri.fsPath);
  }

  async withProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        return await task(controller.signal);
      } catch (error) {
        if (token.isCancellationRequested || controller.signal.aborted) return undefined;
        throw error;
      } finally {
        subscription.dispose();
      }
    });
  }

  async showReport(markdown: string): Promise<void> {
    this.reports.set(markdown);
    const document = await vscode.workspace.openTextDocument(this.reports.uri);
    await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
  }

  async pickSettings(defaults: ImportSettings): Promise<ImportSettings | undefined> {
    type Item = vscode.QuickPickItem & { id: 'target' | 'tool' | 'secrets' | 'policy' | 'rest' | 'go' };
    let settings = { ...defaults };
    for (;;) {
      const items: Item[] = [
        { id: 'go', label: '$(check) Continue', description: 'see what will be written' },
        { id: 'target', label: `$(folder) Target folder: ${settings.targetDir}`, description: 'inside this workspace' },
        { id: 'tool', label: `$(tools) Written for: ${TARGET_LABEL[settings.target]}`, description: 'dynamic variables such as {{$guid}} are spelled the way this tool reads them; select to change' },
        { id: 'secrets', label: `$(shield) Move secrets to the private file: ${settings.moveSecrets ? 'yes' : 'no'}`, description: settings.moveSecrets ? 'recommended; the private file is kept out of Git' : 'literal secrets stay in the shared files' },
        { id: 'policy', label: `$(files) ${POLICY_LABEL[settings.policy]}`, description: 'select to change' }
      ];
      if (settings.target === 'rest-client') {
        items.push({ id: 'rest', label: `$(settings-gear) Fill in the REST Client settings for me: ${settings.applyRestClientSettings && settings.moveSecrets ? 'yes' : 'no'}`, description: !settings.moveSecrets ? 'only when secrets are moved to the private file, or a literal secret would reach the workspace settings' : settings.applyRestClientSettings ? 'variables go to the workspace settings, secrets to your user settings (kept out of Settings Sync); nothing you have is replaced' : 'you paste rest-client.settings.json yourself' });
      }
      const picked = await vscode.window.showQuickPick(items, { title: 'Import from Thunder Client: settings', placeHolder: 'Review the settings, then choose Continue', ignoreFocusOut: true });
      if (picked === undefined) return undefined;
      if (picked.id === 'go') return settings;
      if (picked.id === 'secrets') settings = { ...settings, moveSecrets: !settings.moveSecrets };
      else if (picked.id === 'rest') settings = { ...settings, applyRestClientSettings: !settings.applyRestClientSettings };
      else if (picked.id === 'tool') settings = { ...settings, target: TARGETS[(TARGETS.indexOf(settings.target) + 1) % TARGETS.length] ?? settings.target };
      else if (picked.id === 'policy') settings = { ...settings, policy: POLICY_ORDER[(POLICY_ORDER.indexOf(settings.policy) + 1) % POLICY_ORDER.length] ?? 'new-folder' };
      else {
        const value = await vscode.window.showInputBox({
          title: 'Target folder', prompt: 'Folder inside the workspace that receives the files', value: settings.targetDir, ignoreFocusOut: true,
          validateInput: text => { const result = targetSegments(text); return 'problem' in result ? `Not a valid folder: ${result.problem}.` : undefined; }
        });
        if (value !== undefined) settings = { ...settings, targetDir: value.trim() };
      }
    }
  }

  async confirm(plan: WritePlan, settings: ImportSettings): Promise<boolean> {
    const writes = plan.files.filter(file => file.action !== 'skip').length;
    const notes: string[] = [];
    if (plan.renamed) notes.push(`the folder you chose already has files, so ${plan.targetDir} is used`);
    const kept = plan.files.length - writes;
    if (kept > 0) notes.push(`${kept} existing file${kept === 1 ? '' : 's'} kept`);
    const replaced = plan.files.filter(file => file.action === 'overwrite').length;
    if (replaced > 0) notes.push(`${replaced} file${replaced === 1 ? '' : 's'} replaced`);
    if (plan.gitignore === 'created' || plan.gitignore === 'updated') notes.push(`.gitignore ${plan.gitignore === 'created' ? 'is created' : 'gets a line'} for the private file`);
    if (settings.target === 'rest-client' && settings.applyRestClientSettings && settings.moveSecrets) notes.push('the REST Client settings are filled in: variables in the workspace settings, secrets in your user settings (kept out of Settings Sync)');
    const picked = await vscode.window.showQuickPick([{ label: `$(check) Write ${writes} file${writes === 1 ? '' : 's'} into ${plan.targetDir}`, description: notes.join('; ') }], { title: 'Import from Thunder Client: confirm', placeHolder: 'Press Enter to write, Escape to cancel', ignoreFocusOut: true });
    return picked !== undefined;
  }

  /**
   * Adds the variables to `rest-client.environmentVariables` through the configuration API, which edits settings.json in place
   * and keeps its comments. REST Client must be installed: its setting does not exist otherwise and VS Code refuses to write it.
   */
  async applyRestClientSettings(settings: RestClientSettings): Promise<RestClientSettingsOutcome> {
    if (vscode.extensions.getExtension(REST_CLIENT_ID) === undefined) return { status: 'rest-client-missing' };
    try {
      const config = vscode.workspace.getConfiguration('rest-client');
      const apply = async (scope: 'workspace' | 'user', incoming: EnvMap): Promise<ScopeOutcome> => {
        const inspected = config.inspect<unknown>('environmentVariables');
        const merge = mergeEnvironments(scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue, incoming);
        await config.update('environmentVariables', merge.merged, scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        return { environments: merge.addedEnvironments, variables: merge.addedVariables, kept: merge.kept };
      };
      const workspace = await apply('workspace', settings.shareable);
      if (settings.secrets === undefined) return { status: 'applied', workspace, syncExcluded: false };
      const user = await apply('user', settings.secrets);
      // The user settings may be synced to the person's account; they now hold secrets, so this setting is left out of the sync.
      const sync = vscode.workspace.getConfiguration('settingsSync');
      const ignored = sync.inspect<string[]>('ignoredSettings')?.globalValue ?? [];
      if (!ignored.includes(REST_CLIENT_SETTING)) await sync.update('ignoredSettings', [...ignored, REST_CLIENT_SETTING], vscode.ConfigurationTarget.Global);
      return { status: 'applied', workspace, user, syncExcluded: true };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message.split('\n')[0] ?? 'The settings could not be changed.' : 'The settings could not be changed.' };
    }
  }

  async done(outcome: WriteOutcome, imported: ImportSummary, restClient?: RestClientSettingsOutcome): Promise<DoneAction | undefined> {
    const parts = importMessages(outcome, imported, restClient);
    const choice = await vscode.window.showInformationMessage(parts.join(' '), 'Open folder', 'Open report');
    return choice === 'Open folder' ? 'open-folder' : choice === 'Open report' ? 'open-report' : undefined;
  }

  async openFolder(relativeDir: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root !== undefined) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.joinPath(root, ...relativeDir.split('/')));
  }

  async openReport(relativePath: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (root === undefined) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ...relativePath.split('/')));
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async error(message: string): Promise<void> {
    await vscode.window.showErrorMessage(message);
  }
}
