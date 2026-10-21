import * as path from 'node:path';
import { REPORT_FILE } from '../emit';
import { importMessages } from '../host';
import type { RestClientSettingsOutcome } from '../host';
import type { Candidate } from '../discover';
import { DEFAULT_IMPORT_OPTIONS } from '../pipeline';
import type { ImportResult } from '../pipeline';
import { SourceError } from '../reader/fs-reader';
import { restClientSettingsFrom } from '../settings-merge';
import type { RestClientSettings } from '../settings-merge';
import { compareCodePoints } from '../util/chars';
import { shortenHome } from '../util/display-path';
import { WriteError, planWrite, writeFiles } from '../write/writer';
import type { WritePlan } from '../write/writer';
import { importFromPath } from '../run';
import { MAX_FILES_SHOWN, MAX_FINDINGS_SHOWN } from './types';
import type { WizardBusy, WizardMessage, WizardOptions, WizardPlanView, WizardResultView, WizardStep, WizardView } from './types';

/**
 * The state behind the importer panel (spec 9): which step the person is at, what was read, what would be written, and what
 * happened. It owns every rule; the panel only draws `view()` and forwards the person's choices. Nothing is written until
 * `write()`, which the panel calls only for the Import button, and `write()` writes only what the person was shown: it plans again
 * first and stops if the plan is not the one on screen (the folder changed, another window opened a different workspace).
 */
export interface SessionDependencies {
  /** The folder the person has open, or undefined when none is open (the import needs one). */
  workspaceRoot(): string | undefined;
  workspaceName(): string;
  /** The home folder, shortened to "~" in the paths that are shown. */
  home: string;
  /** Where Thunder Client's data may be, already checked to exist. */
  candidates: readonly Candidate[];
  restClientInstalled(): boolean;
  /** Adds the variables to the REST Client settings (the VS Code side of spec 6.5). */
  applyRestClientSettings(settings: RestClientSettings): Promise<RestClientSettingsOutcome>;
  /** The state changed while an operation was still running (it started, or it ended). */
  changed(): void;
}

const messageOf = (error: unknown): string => {
  if (error instanceof SourceError || error instanceof WriteError) return error.message;
  return 'The import stopped because of an unexpected problem. Nothing was written.';
};

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

/** What a reading was made with: the two choices that change the files. */
type ReadingOptions = Pick<WizardOptions, 'target' | 'moveSecrets'>;

export class WizardSession {
  options: WizardOptions = { target: DEFAULT_IMPORT_OPTIONS.target, policy: DEFAULT_IMPORT_OPTIONS.conflictPolicy, moveSecrets: DEFAULT_IMPORT_OPTIONS.moveSecrets, applyRestClientSettings: true, targetDir: DEFAULT_IMPORT_OPTIONS.targetDir };
  private step: WizardStep = 'source';
  private busy: WizardBusy | undefined;
  private input: string | string[] | undefined;
  private source: { title: string; detail: string } | undefined;
  private result: ImportResult | undefined;
  /** The choices the current result was read with; the options on screen always equal them once a reading has finished. */
  private readWith: ReadingOptions | undefined;
  private plan: WritePlan | undefined;
  private optionsError: string | undefined;
  private message: WizardMessage | undefined;
  private done: WizardResultView | undefined;
  private controller: AbortController | undefined;
  private run = 0;
  /** Counts every plan, so that a plan that finishes late never replaces a newer one. */
  private planSeq = 0;
  private wrote = false;

  constructor(private readonly deps: SessionDependencies) {}

  /** Files were written by the last import (the panel then must not say that nothing was). */
  get hasWritten(): boolean { return this.wrote; }

  private shorten(fsPath: string): string {
    return shortenHome(fsPath, this.deps.home);
  }

  /** Reads a suggestion of the list by its number. */
  async useCandidate(id: number): Promise<void> {
    const candidate = this.deps.candidates[id];
    if (candidate === undefined) return;
    await this.useSource(candidate.path, 'Thunder Client data on this computer', this.shorten(candidate.path));
  }

  /** Reads a folder or a list of export files; `detail` says which, for the person. Not while files are being written. */
  async useSource(input: string | string[], title: string, detail: string): Promise<void> {
    if (this.busy === 'writing') return;
    this.input = input;
    this.source = { title, detail };
    this.result = undefined;
    this.readWith = undefined;
    this.plan = undefined;
    this.optionsError = undefined;
    this.done = undefined;
    this.wrote = false;
    await this.scan();
  }

  describeFiles(files: readonly string[]): { title: string; detail: string } {
    const names = files.map(file => path.basename(file));
    const shown = names.slice(0, 3).join(', ');
    return { title: files.length === 1 ? 'Export file' : `${files.length} export files`, detail: names.length > 3 ? `${shown} and ${names.length - 3} more` : shown };
  }

  /** Changes what is asked for. A change that alters the files (the tool, or moving secrets) reads the data again; the rest only plans again. */
  async setOptions(partial: Partial<WizardOptions>): Promise<void> {
    if (this.step === 'done' || this.busy === 'writing') return;
    const before = this.options;
    this.options = { ...before, ...partial };
    if (this.input !== undefined && (this.options.moveSecrets !== before.moveSecrets || this.options.target !== before.target)) await this.scan();
    else { await this.replan(); this.deps.changed(); }
  }

  /** The workspace the files go into changed: what would be written is planned again for the new one. */
  async workspaceChanged(): Promise<void> {
    if (this.step === 'review' && this.busy === undefined) await this.replan();
    this.deps.changed();
  }

  cancelScan(): void {
    if (this.busy !== 'scanning') return;
    this.controller?.abort();
  }

  /** Back to the first step. Not while files are being written: that import finishes first. */
  startOver(): void {
    if (this.busy === 'writing') return;
    this.reset();
    this.deps.changed();
  }

  /** The panel was closed: stop reading. A write that is running is not interrupted. */
  close(): void {
    this.run++;
    this.controller?.abort();
  }

  private reset(): void {
    this.run++;
    this.planSeq++;
    this.controller?.abort();
    this.step = 'source';
    this.busy = undefined;
    this.input = undefined;
    this.source = undefined;
    this.result = undefined;
    this.readWith = undefined;
    this.plan = undefined;
    this.optionsError = undefined;
    this.message = undefined;
    this.done = undefined;
    this.wrote = false;
  }

  /** The conversion report as text, for the read-only preview. Empty before anything was read. */
  reportMarkdown(): string {
    return this.result?.files.find(file => file.path === REPORT_FILE)?.content ?? '';
  }

  /** The folder and the report of the last import, relative to the workspace. */
  writtenFolder(): string | undefined { return this.done?.targetDir; }
  writtenReport(): string | undefined { return this.done === undefined ? undefined : `${this.done.targetDir}/${REPORT_FILE}`; }

  async write(): Promise<void> {
    const root = this.deps.workspaceRoot();
    if (this.result === undefined || this.busy !== undefined || this.step !== 'review') return;
    if (root === undefined) { this.message = { kind: 'error', text: 'Open a folder first: the imported files are written inside it.' }; this.deps.changed(); return; }
    const shown = this.plan;
    if (shown === undefined) return;
    // The files were made with the tool and the secrets choice of the last reading; they must be the ones on screen.
    if (this.readWith === undefined || this.readWith.target !== this.options.target || this.readWith.moveSecrets !== this.options.moveSecrets) return;
    const result = this.result;
    const options = this.options;
    this.busy = 'writing';
    this.message = undefined;
    this.deps.changed();
    try {
      // The plan on screen is the promise. Plan again now, and write only if nothing changed since the person saw it.
      const request = { workspaceRoot: root, targetDir: options.targetDir, policy: options.policy, files: result.files } as const;
      const fresh = await planWrite(request);
      if (JSON.stringify(fresh) !== JSON.stringify(shown)) {
        this.plan = fresh;
        this.message = { kind: 'info', text: 'The folder changed after the plan was shown, so nothing was written. Read the plan again, then press Import.' };
        return;
      }
      const outcome = await writeFiles(request);
      this.wrote = true;
      let restClient: RestClientSettingsOutcome | undefined;
      // Secrets reach the workspace settings only when they were moved out of the shared files: with moving off, a literal secret would be written there too.
      if (options.target === 'rest-client' && options.applyRestClientSettings && options.moveSecrets) {
        const written = new Set(outcome.plan.files.filter(file => file.action !== 'skip').map(file => file.path));
        const found = restClientSettingsFrom(result.files.filter(file => written.has(file.path)));
        // The files are already written: a problem with the settings must not look like a failed import.
        if (found !== undefined) restClient = await this.deps.applyRestClientSettings(found).catch((): RestClientSettingsOutcome => ({ status: 'failed', message: 'The REST Client settings could not be changed.' }));
      }
      this.done = {
        targetDir: outcome.plan.targetDir, requests: result.summary.requests, written: outcome.written.length, skipped: outcome.skipped.length, overwritten: outcome.overwritten.length,
        notes: importMessages(outcome, result.summary, restClient).slice(1)
      };
      this.step = 'done';
    } catch (error) {
      this.message = { kind: 'error', text: this.wrote ? 'The files were written, but something went wrong afterwards. Look in the folder.' : messageOf(error) };
    } finally {
      this.busy = undefined;
      this.deps.changed();
    }
  }

  private async scan(): Promise<void> {
    const input = this.input;
    if (input === undefined) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const run = ++this.run;
    this.planSeq++;
    this.busy = 'scanning';
    this.message = undefined;
    this.deps.changed();
    const reading: ReadingOptions = { target: this.options.target, moveSecrets: this.options.moveSecrets };
    let result: ImportResult;
    try {
      result = await importFromPath(input, { signal: controller.signal, moveSecrets: reading.moveSecrets, targetDir: this.options.targetDir, conflictPolicy: this.options.policy, target: reading.target });
    } catch (error) {
      if (run !== this.run) return;
      this.busy = undefined;
      this.message = controller.signal.aborted ? { kind: 'info', text: 'Cancelled. Nothing was changed.' } : { kind: 'error', text: messageOf(error) };
      if (this.result === undefined || this.readWith === undefined) { this.step = 'source'; this.input = undefined; this.source = undefined; }
      // What stays on screen is the earlier reading, so the choices go back to the ones it was made with.
      else this.options = { ...this.options, ...this.readWith };
      this.deps.changed();
      return;
    }
    if (run !== this.run) return;
    this.result = result;
    this.readWith = reading;
    this.busy = undefined;
    this.step = 'review';
    if (result.summary.requests === 0 && result.summary.environments === 0) {
      this.plan = undefined;
      this.message = { kind: 'error', text: 'Nothing could be imported from there. The findings say what was found.' };
      this.deps.changed();
      return;
    }
    await this.replan();
    this.deps.changed();
  }

  /** What would be written, for the current choices. A target folder that cannot be used is a message, not an error. */
  private async replan(): Promise<void> {
    const seq = ++this.planSeq;
    this.plan = undefined;
    this.optionsError = undefined;
    const root = this.deps.workspaceRoot();
    if (this.result === undefined || root === undefined) return;
    try {
      const plan = await planWrite({ workspaceRoot: root, targetDir: this.options.targetDir, policy: this.options.policy, files: this.result.files });
      if (seq === this.planSeq) this.plan = plan;
    } catch (error) {
      if (seq === this.planSeq) this.optionsError = messageOf(error);
    }
  }

  view(): WizardView {
    const root = this.deps.workspaceRoot();
    const findings = [...(this.result?.findings ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || compareCodePoints(a.code, b.code));
    const plan: WizardPlanView | undefined = this.plan === undefined ? undefined : {
      targetDir: this.plan.targetDir,
      renamed: this.plan.renamed,
      gitignore: this.plan.gitignore,
      files: this.plan.files.slice(0, MAX_FILES_SHOWN).map(file => ({ path: file.path, action: file.action })),
      fileTotal: this.plan.files.length,
      writes: this.plan.files.filter(file => file.action !== 'skip').length,
      kept: this.plan.files.filter(file => file.action === 'skip').length,
      replaced: this.plan.files.filter(file => file.action === 'overwrite').length
    };
    return {
      step: this.step,
      ...(this.busy === undefined ? {} : { busy: this.busy }),
      workspace: { open: root !== undefined, name: this.deps.workspaceName() },
      restClientInstalled: this.deps.restClientInstalled(),
      candidates: this.deps.candidates.map((candidate, id) => ({
        id,
        title: 'Thunder Client data on this computer',
        detail: this.shorten(candidate.path),
        counts: [candidate.collections > 0 ? `${candidate.collections} collection${candidate.collections === 1 ? '' : 's'}` : undefined, candidate.environments > 0 ? `${candidate.environments} environment${candidate.environments === 1 ? '' : 's'}` : undefined, candidate.v3 ? 'older format' : undefined].filter(Boolean).join(', ')
      })),
      ...(this.source === undefined ? {} : { source: this.source }),
      options: this.options,
      ...(this.optionsError === undefined ? {} : { optionsError: this.optionsError }),
      ...(this.result === undefined ? {} : { summary: this.result.summary }),
      findings: findings.slice(0, MAX_FINDINGS_SHOWN).map(finding => ({ code: finding.code, severity: finding.severity, where: finding.where, message: finding.message })),
      findingsTotal: findings.length,
      ...(plan === undefined ? {} : { plan }),
      ...(this.message === undefined ? {} : { message: this.message }),
      ...(this.done === undefined ? {} : { result: this.done })
    };
  }
}
