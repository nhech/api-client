import { promises as disk } from 'node:fs';
import * as vscode from 'vscode';
import { findChild } from '../../src/storage/organise';
import type { ContainerNode, RequestNode } from '../../src/storage/store';
import { printable } from '../../src/util/chars';
import { parseDataFile, type DataRow } from '../../src/runner/data';
import { toJson, toJUnit, type ReportContext } from '../../src/runner/report';
import { runItems, type Executed, type RunItem, type RunSummary, type TestOutcome } from '../../src/runner/run';
import { parseRunnerToHost, resultView, summaryView, type DataView, type RunConfig, type RunnerToView } from '../../src/view/runner-protocol';
import { configureAppPanel } from './appPanel';
import type { ClientWorkspace } from './clientWorkspace';
import { executeRequest, type Execution } from './execute';
import type { SendEnvironment } from './sender';

/**
 * The collection runner: a panel that runs the requests of a collection or a folder one after the other (src/runner/ decides the order, the passes
 * and the pauses; extension/src/execute.ts sends each request exactly as the editor does), shows each result as it comes, and saves a JSON or a
 * JUnit report. The panel is only a window: the run belongs to this session, so a panel that is shown again is told everything that happened.
 */
export const RUNNER_VIEW_TYPE = 'apiClient.runner';
const MAX_ITEMS = 10_000;
const MAX_DATA_BYTES = 10 * 1024 * 1024;

/** What the tests of the extension may see of an open runner. */
export interface RunnerTestView {
  readonly isReady: boolean;
  readonly violations: string[];
  messages(): readonly RunnerToView[];
  readonly isRunning: boolean;
  /** Delivers a message as if the page had sent it. */
  receive(raw: unknown): Promise<void>;
  /** Stands for the dialog that chooses a data file. */
  pickData: (() => Promise<{ name: string; text: string } | undefined>) | undefined;
  /** Stands for the dialog that chooses where a report goes: it is given the text that would have been written. */
  reportTo: ((format: 'json' | 'junit', text: string) => void) | undefined;
}

interface Flattened { items: RunItem[]; requests: Map<string, RequestNode>; truncated: boolean }

/** The requests of a collection or folder in the order the side bar shows them, folders opened in place. */
function flatten(root: ContainerNode): Flattened {
  const items: RunItem[] = [];
  const requests = new Map<string, RequestNode>();
  let truncated = false;
  const walk = (container: ContainerNode, trail: string[]): void => {
    for (const child of container.children) {
      if (items.length >= MAX_ITEMS) { truncated = true; return; }
      if (child.kind === 'request') {
        items.push({ path: child.path, name: child.request.name || child.slug, method: child.request.method, url: child.request.url, folder: trail.join('/') });
        requests.set(child.path, child);
      } else walk(child, [...trail, child.container.name]);
    }
  };
  walk(root, []);
  return { items, requests, truncated };
}

const messageOf = (error: unknown): string => printable(error instanceof Error ? error.message : 'something went wrong');

/** What the runner keeps of an execution. */
function summarize(execution: Execution, elapsed: number): Executed {
  if (execution.kind === 'cancelled') return { kind: 'cancelled' };
  if (execution.kind === 'failed') {
    const next = execution.report?.nextRequest;
    if (execution.code === 'skipped') return { kind: 'skipped', notes: [execution.message] };
    return { kind: 'error', message: execution.message, ms: elapsed, notes: [...execution.warnings, ...(execution.report?.notes ?? [])], ...(next === undefined ? {} : { nextRequest: next }) };
  }
  const tests: TestOutcome[] = [
    ...execution.tests.map((test): TestOutcome => ({ name: test.expr, passed: test.ok, message: test.message, source: 'request' })),
    ...execution.report.tests.filter(test => !test.skipped).map((test): TestOutcome => ({ name: test.name, passed: test.passed, message: test.message, source: 'script' }))
  ];
  const errors = execution.report.errors.map(error => `${error.name} in the script ${error.phase === 'pre' ? 'before the request' : 'after the answer'}: ${error.message}`);
  const next = execution.report.nextRequest;
  return {
    kind: 'done', httpStatus: execution.response.status, statusText: execution.response.statusText, ms: execution.response.timings.totalMs, size: execution.response.size, tests, errors,
    notes: [...execution.warnings, ...execution.report.notes], ...(next === undefined ? {} : { nextRequest: next })
  };
}

class RunnerSession implements vscode.Disposable, RunnerTestView {
  private ready = false;
  private readonly sent: RunnerToView[] = [];
  private controller: AbortController | undefined;
  private data: { view: DataView; rows: DataRow[] } | undefined;
  private summary: RunSummary | undefined;
  private readonly results: RunnerToView[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly violations: string[] = [];
  pickData: RunnerTestView['pickData'];
  reportTo: RunnerTestView['reportTo'];

  constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly env: SendEnvironment, private readonly workspace: ClientWorkspace, private readonly target: string) {
    this.subscriptions.push(panel.webview.onDidReceiveMessage((raw: unknown) => { this.receive(raw).catch(() => undefined); }));
  }

  get isReady(): boolean { return this.ready; }
  get isRunning(): boolean { return this.controller !== undefined; }
  messages(): readonly RunnerToView[] { return this.sent; }

  private post(message: RunnerToView, remember = false): void {
    if (remember) this.results.push(message);
    this.sent.push(message);
    if (this.sent.length > 5000) this.sent.shift();
    void this.panel.webview.postMessage(message);
  }

  private container(): ContainerNode | undefined {
    const loaded = this.workspace.loaded;
    const found = loaded === undefined ? undefined : findChild(loaded, this.target);
    return found !== undefined && found.kind !== 'request' ? found : undefined;
  }

  private environmentName(): string {
    const loaded = this.workspace.loaded;
    return loaded?.environments.find(item => item.environment.id === this.workspace.activeEnvironmentId)?.environment.name ?? '';
  }

  async receive(raw: unknown): Promise<void> {
    const message = parseRunnerToHost(raw);
    if (message === undefined) return;
    if (message.type === 'ready') {
      this.ready = true;
      this.violations.splice(0, this.violations.length, ...message.violations);
      const root = this.container();
      if (root === undefined) { this.post({ type: 'problem', message: 'The collection or folder is not there any more.' }); return; }
      this.post({ type: 'init', name: printable(root.container.name), kind: root.kind, environment: printable(this.environmentName()), requests: flatten(root).items.length, data: this.data?.view });
      // A panel that is shown again is told what has happened so far.
      for (const old of this.results) void this.panel.webview.postMessage(old);
    } else if (message.type === 'violation') {
      if (this.violations.length < 20) this.violations.push(message.text);
    } else if (message.type === 'start') {
      // The run goes on by itself: the page can still ask to stop it.
      void this.start(message.config).catch((error: unknown) => { this.post({ type: 'problem', message: messageOf(error) }); });
    } else if (message.type === 'stop') {
      this.controller?.abort();
    } else if (message.type === 'chooseData') {
      await this.chooseData();
    } else if (message.type === 'clearData') {
      this.data = undefined;
      this.post({ type: 'data', data: undefined });
    } else if (message.type === 'save') {
      await this.save(message.format);
    }
  }

  private async chooseData(): Promise<void> {
    if (this.isRunning) return;
    let picked: { name: string; text: string } | undefined;
    if (this.pickData !== undefined) picked = await this.pickData();
    else {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as data', filters: { 'Data files': ['csv', 'tsv', 'txt', 'json'] } });
      const uri = chosen?.[0];
      if (uri === undefined) return;
      const info = await vscode.workspace.fs.stat(uri);
      if (info.size > MAX_DATA_BYTES) { this.post({ type: 'data', data: this.data?.view, error: 'The file is larger than 10 MB.' }); return; }
      picked = { name: uri.path.split('/').pop() ?? 'data', text: new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)) };
    }
    if (picked === undefined) return;
    const parsed = parseDataFile(picked.text, picked.name);
    if (!parsed.ok) { this.post({ type: 'data', data: this.data?.view, error: printable(parsed.error) }); return; }
    this.data = { view: { name: printable(picked.name), rows: parsed.rows.length, columns: parsed.columns, warnings: parsed.warnings.map(printable) }, rows: parsed.rows };
    this.post({ type: 'data', data: this.data.view });
  }

  private async start(config: RunConfig): Promise<void> {
    if (this.controller !== undefined) return;
    const root = this.container();
    if (root === undefined) { this.post({ type: 'problem', message: 'The collection or folder is not there any more.' }); return; }
    const flat = flatten(root);
    if (flat.items.length === 0) { this.post({ type: 'problem', message: 'There is no request to run here.' }); return; }
    this.results.length = 0;
    this.summary = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const passes = this.data === undefined ? config.iterations : this.data.rows.length;
    this.post({ type: 'started', passes }, true);
    try {
      const summary = await runItems(flat.items, { iterations: config.iterations, delayMs: config.delayMs, stopOnFailure: config.stopOnFailure, ...(this.data === undefined ? {} : { data: this.data.rows }) }, {
        execute: async (item, iteration, signal) => {
          const node = flat.requests.get(item.path);
          if (node === undefined) return { kind: 'error', message: 'The request is not there any more.', ms: 0, notes: [] };
          const began = Date.now();
          try {
            const execution = await executeRequest(this.env, item.path, node.request, { signal, iteration });
            // A body that went to a file is not kept: a run holds on to what it needs of each answer, not the answers.
            if (execution.kind === 'sent' && execution.response.body.kind === 'file') await disk.rm(execution.response.body.path, { force: true }).catch(() => undefined);
            return summarize(execution, Date.now() - began);
          } catch (error) {
            return signal.aborted ? { kind: 'cancelled' } : { kind: 'error', message: messageOf(error), ms: Date.now() - began, notes: [] };
          }
        },
        sleep: (ms, signal) => new Promise<void>(resolve => {
          if (signal.aborted) { resolve(); return; }
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
          const onAbort = (): void => { clearTimeout(timer); resolve(); };
          signal.addEventListener('abort', onAbort, { once: true });
        }),
        now: () => Date.now(),
        onResult: result => this.post({ type: 'result', result: resultView(result) }, true)
      }, controller.signal);
      this.summary = summary;
      this.post({ type: 'done', summary: summaryView(summary) }, true);
    } finally {
      this.controller = undefined;
    }
  }

  private async save(format: 'json' | 'junit'): Promise<void> {
    const summary = this.summary;
    const root = this.container();
    if (summary === undefined || root === undefined) return;
    const context: ReportContext = { name: root.container.name, environment: this.environmentName(), tool: `api-client ${String((this.context.extension.packageJSON as { version?: string }).version ?? '')}`.trim() };
    const text = format === 'json' ? toJson(summary, context) : toJUnit(summary, context);
    if (this.reportTo !== undefined) { this.reportTo(format, text); return; }
    const folder = this.workspace.folder();
    const name = `${root.slug}-run.${format === 'json' ? 'json' : 'xml'}`;
    const target = await vscode.window.showSaveDialog({ title: 'Save the report of the run', ...(folder === undefined ? {} : { defaultUri: vscode.Uri.joinPath(folder.uri, name) }), filters: format === 'json' ? { JSON: ['json'] } : { XML: ['xml'] } });
    if (target === undefined) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    void vscode.window.setStatusBarMessage(`API Client: the report is saved (${target.path.split('/').pop() ?? ''}).`, 3000);
  }

  dispose(): void {
    this.controller?.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

/** Opens a runner on a collection or a folder, one panel for each. */
export class RunnerManager implements vscode.Disposable {
  /** The open runners by the path of what they run, for the tests of the extension. */
  readonly open = new Map<string, RunnerTestView & vscode.Disposable>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly env: SendEnvironment, private readonly workspace: ClientWorkspace) {}

  show(path: string, title: string): RunnerTestView {
    const existing = this.open.get(path);
    if (existing !== undefined) { return existing; }
    const panel = vscode.window.createWebviewPanel(RUNNER_VIEW_TYPE, `Run: ${printable(title)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
    configureAppPanel(this.context, panel, 'runner');
    const session = new RunnerSession(panel, this.context, this.env, this.workspace, path);
    this.open.set(path, session);
    panel.onDidDispose(() => { this.open.delete(path); session.dispose(); });
    return session;
  }

  dispose(): void {
    for (const session of this.open.values()) session.dispose();
    this.open.clear();
  }
}
