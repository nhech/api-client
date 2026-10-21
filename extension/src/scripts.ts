import { join } from 'node:path';
import * as vscode from 'vscode';
import { approve, describePending, pendingScripts, readApproved, type ApprovedScript, type PendingScript, type ScriptToRun } from '../../src/script/consent';
import { ScriptSandbox } from '../../src/script/sandbox';
import { printable } from '../../src/util/chars';

/**
 * Whether the scripts of a collection may run, and the engine they run in. A script can read every variable (the secrets among them) and
 * send them anywhere, and a collection can come from somebody else, so a script runs only when the workspace is trusted, the person has
 * not turned scripts off, and the person has said yes to the very text that is about to run. What was said yes to is kept here, in the
 * state of the extension on this computer, and never in the collection: a pull cannot grant it. The text of a script that changes asks again.
 */

const STORE_KEY = 'apiClient.scriptConsent';
const ALLOW = 'Allow and run';
const SKIP = 'Send without scripts';
const SHOW = 'Show the code';
/** How much of the code the question shows by itself; the rest is one click away. */
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 1500;
const DETAIL_CHARS = 6000;

export type Permission =
  | { kind: 'run' }
  | { kind: 'skip'; note: string }
  | { kind: 'cancel' };

export type Answer = 'allow' | 'skip' | 'cancel';

export class ScriptService implements vscode.Disposable {
  private sandbox: ScriptSandbox | undefined;
  /** Set by the tests of the extension to answer the question without anybody there. */
  answer: ((pending: readonly PendingScript[]) => Promise<Answer>) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** The engine; started when a script first runs, not before. */
  get engine(): ScriptSandbox {
    this.sandbox ??= new ScriptSandbox({
      workerPath: join(this.context.extensionPath, 'dist', 'script-worker.js'),
      wasmPath: join(this.context.extensionPath, 'dist', 'quickjs.wasm')
    });
    return this.sandbox;
  }

  /** Why scripts cannot run at all, or undefined when they can. */
  unavailable(): string | undefined {
    if (!vscode.workspace.isTrusted) return 'The scripts did not run: this workspace is not trusted. Trust it to let them run.';
    if (!vscode.workspace.getConfiguration('apiClient').get<boolean>('scripts.enabled', true)) return 'The scripts did not run: they are turned off in the settings (apiClient.scripts.enabled).';
    return undefined;
  }

  private store(): Record<string, unknown> {
    const kept = this.context.globalState.get<unknown>(STORE_KEY);
    return typeof kept === 'object' && kept !== null && !Array.isArray(kept) ? (kept as Record<string, unknown>) : {};
  }

  private approvedFor(collection: string): ApprovedScript[] {
    const store = this.store();
    return Object.hasOwn(store, collection) ? readApproved(store[collection]) : [];
  }

  private async keep(collection: string, approved: ApprovedScript[]): Promise<void> {
    await this.context.globalState.update(STORE_KEY, { ...this.store(), [collection]: approved });
  }

  /** What may run for these scripts of a collection: all of them, none (and why), or the send is called off. */
  async permit(collection: string, scripts: readonly ScriptToRun[]): Promise<Permission> {
    if (scripts.length === 0) return { kind: 'run' };
    const reason = this.unavailable();
    if (reason !== undefined) return { kind: 'skip', note: reason };
    const approved = this.approvedFor(collection);
    const pending = pendingScripts(scripts, approved);
    if (pending.length === 0) return { kind: 'run' };
    const answer = await (this.answer ?? ((list: readonly PendingScript[]) => this.ask(list)))(pending);
    if (answer === 'allow') { await this.keep(collection, approve(approved, pending)); return { kind: 'run' }; }
    if (answer === 'skip') return { kind: 'skip', note: 'The scripts did not run: they have not been allowed. Send again to be asked.' };
    return { kind: 'cancel' };
  }

  /** Forgets everything that was allowed, in every collection. */
  async forgetAll(): Promise<void> {
    await this.context.globalState.update(STORE_KEY, undefined);
  }

  private detail(pending: readonly PendingScript[]): string {
    const lines = describePending(pending);
    const parts = pending.map((script, index) => {
      const code = printable(script.code);
      const rows = code.split('\n');
      const shown = rows.slice(0, PREVIEW_LINES).join('\n');
      const cut = shown.length > PREVIEW_CHARS ? `${shown.slice(0, PREVIEW_CHARS)}...` : shown;
      return `${lines[index] ?? ''}\n${cut}${rows.length > PREVIEW_LINES || shown.length > PREVIEW_CHARS ? '\n...' : ''}`;
    });
    const text = `A script can read all of your variables, secrets included, and send them anywhere. Allow it only if you trust whoever wrote it.\n\n${parts.join('\n\n')}`;
    return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS)}...` : text;
  }

  private async ask(pending: readonly PendingScript[]): Promise<Answer> {
    const what = pending.length === 1 ? 'A script of this collection' : `${pending.length} scripts of this collection`;
    const choice = await vscode.window.showWarningMessage(`${what} ${pending.length === 1 ? 'has' : 'have'} not been allowed to run.`, { modal: true, detail: this.detail(pending) }, ALLOW, SKIP, SHOW);
    if (choice === ALLOW) return 'allow';
    if (choice === SKIP) return 'skip';
    if (choice !== SHOW) return 'cancel';
    await this.show(pending);
    const again = await vscode.window.showWarningMessage('Allow these scripts to run?', ALLOW, SKIP);
    return again === ALLOW ? 'allow' : again === SKIP ? 'skip' : 'cancel';
  }

  /** Opens the code: next to what was allowed before when it changed, on its own when it is new. */
  private async show(pending: readonly PendingScript[]): Promise<void> {
    for (const script of pending) {
      const now = await vscode.workspace.openTextDocument({ language: 'javascript', content: script.code });
      if (script.previous === undefined) { await vscode.window.showTextDocument(now, { preview: false }); continue; }
      const before = await vscode.workspace.openTextDocument({ language: 'javascript', content: script.previous });
      await vscode.commands.executeCommand('vscode.diff', before.uri, now.uri, `Script of ${printable(script.from).slice(0, 40)}: allowed before, now`);
    }
  }

  dispose(): void {
    const sandbox = this.sandbox;
    this.sandbox = undefined;
    if (sandbox !== undefined) void sandbox.dispose();
  }
}
