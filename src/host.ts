import { importFromPath } from './run';
import { SourceError } from './reader/fs-reader';
import { REPORT_FILE } from './emit';
import { DEFAULT_IMPORT_OPTIONS } from './pipeline';
import type { ConflictPolicy, ImportResult, ImportSummary } from './pipeline';
import type { Target } from './model/target';
import type { Candidate } from './discover';
import { restClientSettingsFrom } from './settings-merge';
import type { RestClientSettings } from './settings-merge';
import { WriteError, planWrite, writeFiles } from './write/writer';
import type { WriteOutcome, WritePlan } from './write/writer';

/**
 * The user flow of spec 9 with every question and every message behind an interface, so that the flow is tested without
 * VS Code and the VS Code adapter (extension/) only has to answer the questions.
 *
 *   pick a source -> scan (cancellable) -> preview the report -> settings -> confirm -> write -> done
 *
 * Any step can be cancelled; until the last step nothing has been written.
 */
export type SourceChoice =
  | { kind: 'path'; path: string }
  | { kind: 'folder' }
  | { kind: 'files' };

export interface ImportSettings {
  targetDir: string;
  moveSecrets: boolean;
  policy: ConflictPolicy;
  /** The tool the files are written for. */
  target: Target;
  /** With REST Client as the target: add the environments to its settings for the person (spec 6.5). */
  applyRestClientSettings: boolean;
}

export type DoneAction = 'open-folder' | 'open-report';

/** What happened to one scope of the REST Client setting (workspace or user). Names only: never a value. */
export interface ScopeOutcome {
  environments: number;
  variables: number;
  /** `environment.variable` already set to another value, left as it was. */
  kept: string[];
}

export type RestClientSettingsOutcome =
  | { status: 'applied'; workspace: ScopeOutcome; user?: ScopeOutcome; /** The user setting was kept out of Settings Sync. */ syncExcluded: boolean }
  | { status: 'rest-client-missing' }
  | { status: 'failed'; message: string };

export interface ImportHost {
  /** The folder the person has open, or undefined when none is open (the import needs one). */
  workspaceRoot(): string | undefined;
  /** Quick Pick: the suggestions, "Choose a folder...", "Choose export files...". Undefined when cancelled. */
  pickSource(candidates: readonly Candidate[]): Promise<SourceChoice | undefined>;
  chooseFolder(): Promise<string | undefined>;
  chooseFiles(): Promise<string[] | undefined>;
  /** A cancellable progress notification; the task gets the signal and the host aborts it when the person cancels. Undefined when cancelled. */
  withProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
  /** Shows IMPORT_REPORT.md as a read-only document. */
  showReport(markdown: string): Promise<void>;
  /** Quick Pick for the three switches. Undefined when cancelled. */
  pickSettings(defaults: ImportSettings): Promise<ImportSettings | undefined>;
  /** One Quick Pick item that says what will happen ("Write N files into `dir`"). True when chosen. */
  confirm(plan: WritePlan, settings: ImportSettings): Promise<boolean>;
  /**
   * Adds the variables of the import to the REST Client setting `rest-client.environmentVariables`: the shareable ones to the
   * workspace settings, the secrets to the user settings (and keeps that setting out of Settings Sync). Nothing the person has
   * is replaced (see settings-merge.ts).
   */
  applyRestClientSettings(settings: RestClientSettings): Promise<RestClientSettingsOutcome>;
  /** After writing: "Imported X requests" with the actions to open the folder or the report. */
  done(outcome: WriteOutcome, imported: ImportResult['summary'], restClient?: RestClientSettingsOutcome): Promise<DoneAction | undefined>;
  openFolder(relativeDir: string): Promise<void>;
  openReport(relativePath: string): Promise<void>;
  error(message: string): Promise<void>;
}

export interface FlowDependencies {
  candidates: readonly Candidate[];
}

export type FlowResult =
  | { status: 'done'; outcome: WriteOutcome }
  | { status: 'cancelled'; at: 'source' | 'scan' | 'settings' | 'confirm' }
  | { status: 'no-workspace' }
  | { status: 'nothing-to-import' }
  | { status: 'error'; message: string };

const DEFAULT_SETTINGS: ImportSettings = { targetDir: DEFAULT_IMPORT_OPTIONS.targetDir, moveSecrets: DEFAULT_IMPORT_OPTIONS.moveSecrets, policy: DEFAULT_IMPORT_OPTIONS.conflictPolicy, target: DEFAULT_IMPORT_OPTIONS.target, applyRestClientSettings: true };

const messageOf = (error: unknown): string => {
  if (error instanceof SourceError || error instanceof WriteError) return error.message;
  return 'The import stopped because of an unexpected problem. Nothing was written.';
};

export async function runImportFlow(host: ImportHost, dependencies: FlowDependencies): Promise<FlowResult> {
  const root = host.workspaceRoot();
  if (root === undefined) {
    await host.error('Open a folder first: the imported files are written inside it.');
    return { status: 'no-workspace' };
  }
  try {
    const choice = await host.pickSource(dependencies.candidates);
    if (choice === undefined) return { status: 'cancelled', at: 'source' };
    const input = choice.kind === 'path' ? choice.path : choice.kind === 'folder' ? await host.chooseFolder() : await host.chooseFiles();
    if (input === undefined || (Array.isArray(input) && input.length === 0)) return { status: 'cancelled', at: 'source' };

    const scan = (settings: ImportSettings) => host.withProgress('Reading Thunder Client data', signal => importFromPath(input, { signal, moveSecrets: settings.moveSecrets, targetDir: settings.targetDir, conflictPolicy: settings.policy, target: settings.target }));
    let settings = DEFAULT_SETTINGS;
    let result = await scan(settings);
    if (result === undefined) return { status: 'cancelled', at: 'scan' };
    if (result.summary.requests === 0 && result.summary.environments === 0) {
      await host.showReport(reportOf(result));
      await host.error('Nothing could be imported from there. The report says what was found.');
      return { status: 'nothing-to-import' };
    }

    await host.showReport(reportOf(result));
    const chosen = await host.pickSettings(settings);
    if (chosen === undefined) return { status: 'cancelled', at: 'settings' };
    if (chosen.moveSecrets !== settings.moveSecrets || chosen.target !== settings.target) {
      const again = await scan(chosen);
      if (again === undefined) return { status: 'cancelled', at: 'scan' };
      result = again;
      await host.showReport(reportOf(result));
    }
    settings = chosen;

    const request = { workspaceRoot: root, targetDir: settings.targetDir, policy: settings.policy, files: result.files } as const;
    const plan = await planWrite(request);
    if (!(await host.confirm(plan, settings))) return { status: 'cancelled', at: 'confirm' };

    const outcome = await writeFiles(request);
    let restClient: RestClientSettingsOutcome | undefined;
    // Only when the secrets were moved out of the shared files: with moving off, a literal secret would go to the workspace settings too.
    if (settings.target === 'rest-client' && settings.applyRestClientSettings && settings.moveSecrets) {
      const written = new Set(outcome.plan.files.filter(file => file.action !== 'skip').map(file => file.path));
      const found = restClientSettingsFrom(result.files.filter(file => written.has(file.path)));
      // The files are already written: a problem with the settings must not look like a failed import.
      if (found !== undefined) restClient = await host.applyRestClientSettings(found).catch((): RestClientSettingsOutcome => ({ status: 'failed', message: 'The REST Client settings could not be changed.' }));
    }
    const action = await host.done(outcome, result.summary, restClient);
    if (action === 'open-folder') await host.openFolder(outcome.plan.targetDir);
    if (action === 'open-report') await host.openReport(`${outcome.plan.targetDir}/${REPORT_FILE}`);
    return { status: 'done', outcome };
  } catch (error) {
    const message = messageOf(error);
    await host.error(message);
    return { status: 'error', message };
  }
}

/** The sentences that tell the person what an import did, the same on every screen that shows them. Names and counts only. */
export function importMessages(outcome: WriteOutcome, imported: ImportSummary, restClient?: RestClientSettingsOutcome): string[] {
  const parts = [`Imported ${imported.requests} request${imported.requests === 1 ? '' : 's'} into ${outcome.plan.targetDir}.`];
  if (restClient?.status === 'applied') {
    const added = restClient.workspace.variables + (restClient.user?.variables ?? 0);
    parts.push(`REST Client settings: ${added} variable${added === 1 ? '' : 's'} added${restClient.user === undefined ? '' : ' (secrets in your user settings)'}. Choose an environment with "Rest Client: Switch Environment".`);
    const kept = [...restClient.workspace.kept, ...(restClient.user?.kept ?? [])];
    if (kept.length > 0) parts.push(`${kept.length} already had another value and was kept: ${kept.slice(0, 5).join(', ')}${kept.length > 5 ? ', ...' : ''}.`);
  } else if (restClient?.status === 'rest-client-missing') {
    parts.push('REST Client is not installed (humao.rest-client), so its settings were not filled in; paste rest-client.settings.json and rest-client.private.settings.json after installing it.');
  } else if (restClient?.status === 'failed') {
    parts.push(`The REST Client settings could not be changed (${restClient.message}); paste rest-client.settings.json and rest-client.private.settings.json by hand.`);
  }
  return parts;
}

const reportOf = (result: ImportResult): string => result.files.find(file => file.path === REPORT_FILE)?.content ?? '';
