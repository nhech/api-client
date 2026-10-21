import * as vscode from 'vscode';
import type { ClientWorkspace } from './clientWorkspace';

/**
 * The files that hold the values of secret variables (`*.local.yml`) must be ignored by Git, and the extension keeps the `.gitignore` of its own folder that
 * way. A `.gitignore` of someone else's repository can take that back (a later line, or a deeper file, with `!*.local.yml` or `!*.yml`), and a file that was
 * committed once stays tracked. So the question is put to Git itself, through the Git extension of VS Code (`git check-ignore` does not report a file that is
 * tracked, so that case is found too), and the person is told, once for each file, when one of those files would be committed.
 */
export interface GitRepository {
  checkIgnore?(paths: string[]): Promise<Set<string>>;
}

type GitApi = { getRepository(uri: vscode.Uri): GitRepository | null };
type GitExtension = { getAPI(version: 1): GitApi };

const SETTLE_MS = 1500;
const MOST_FILES = 200;

export class SecretFilesGuard implements vscode.Disposable {
  /** The repository that holds a file; replaced by the tests of the extension. */
  repositoryOf: (uri: vscode.Uri) => Promise<GitRepository | undefined> = async uri => {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension === undefined) return undefined;
    try { return (await extension.activate()).getAPI(1).getRepository(uri) ?? undefined; } catch { return undefined; }
  };
  /** Tells the person; replaced by the tests of the extension. */
  warn: (message: string, folder: vscode.Uri) => Promise<void> = async (message, folder) => {
    const open = 'Open the .gitignore';
    const answer = await vscode.window.showWarningMessage(message, open);
    if (answer === open) await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(folder, '.gitignore'));
  };
  private readonly told = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly workspace: ClientWorkspace) {
    this.subscription = workspace.onDidChange(() => this.schedule());
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.check(); }, SETTLE_MS);
  }

  /** Looks at the files with secret values now, and warns about the ones that Git would commit and that the person has not been told about. */
  async check(): Promise<void> {
    const folder = this.workspace.folder();
    if (folder === undefined) return;
    const root = vscode.Uri.joinPath(folder.uri, ...this.workspace.root().split('/'));
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.local.yml'), null, MOST_FILES);
    if (found.length === 0) return;
    const repository = await this.repositoryOf(found[0] as vscode.Uri);
    if (repository?.checkIgnore === undefined) return;
    const paths = found.map(uri => uri.fsPath);
    let ignored: Set<string>;
    try { ignored = await repository.checkIgnore(paths); } catch { return; }
    const exposed = paths.filter(path => !ignored.has(path) && !this.told.has(path));
    if (exposed.length === 0) return;
    for (const path of exposed) this.told.add(path);
    const names = exposed.slice(0, 3).map(path => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)).join(', ');
    await this.warn(`API Client: ${exposed.length === 1 ? 'a file with secret values is' : `${exposed.length} files with secret values are`} not ignored by Git and would be committed (${names}${exposed.length > 3 ? ', ...' : ''}). A .gitignore may take the rule back, or the file was committed before.`, root);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.subscription.dispose();
  }
}
