import type { Severity } from '../model/findings';
import type { Target } from '../model/target';
import type { ConflictPolicy, ImportSummary } from '../pipeline';

/**
 * What the importer panel shows and what it can ask for. The panel (a webview) is only a picture of `WizardView`: every rule
 * is in `WizardSession`, which is tested without VS Code. Everything here is plain data made of names, counts and messages the
 * importer itself wrote, never a value read from a collection.
 */
export interface WizardOptions {
  /** The tool the files are written for. */
  target: Target;
  policy: ConflictPolicy;
  moveSecrets: boolean;
  /** With REST Client as the target: add its variables to its settings for the person. */
  applyRestClientSettings: boolean;
  /** Folder inside the workspace that receives the files. */
  targetDir: string;
}

export type WizardStep = 'source' | 'review' | 'done';
export type WizardBusy = 'scanning' | 'writing';

export interface WizardCandidateView {
  id: number;
  title: string;
  /** The folder, with the home folder shortened to "~". */
  detail: string;
  /** "4 collections, 2 environments". */
  counts: string;
}

export interface WizardFindingView {
  code: string;
  severity: Severity;
  where: string;
  message: string;
}

export interface WizardFileView {
  path: string;
  action: 'create' | 'overwrite' | 'skip';
}

export interface WizardPlanView {
  targetDir: string;
  /** The folder the person chose already has files, so another one is used. */
  renamed: boolean;
  /** `.gitignore` gets a line for the private file. */
  gitignore: 'created' | 'updated' | 'present' | 'not-needed';
  files: WizardFileView[];
  /** The number of files, which may be more than the list. */
  fileTotal: number;
  writes: number;
  kept: number;
  replaced: number;
}

export interface WizardResultView {
  targetDir: string;
  requests: number;
  written: number;
  skipped: number;
  overwritten: number;
  /** What the person should know now, one sentence each (the REST Client settings, what was kept). */
  notes: string[];
}

export interface WizardMessage {
  kind: 'error' | 'info';
  text: string;
}

export interface WizardView {
  step: WizardStep;
  busy?: WizardBusy;
  workspace: { open: boolean; name: string };
  restClientInstalled: boolean;
  candidates: WizardCandidateView[];
  source?: { title: string; detail: string };
  options: WizardOptions;
  /** Why the target folder cannot be used, when it cannot. */
  optionsError?: string;
  summary?: ImportSummary;
  findings: WizardFindingView[];
  /** The number of findings, which may be more than the list. */
  findingsTotal: number;
  plan?: WizardPlanView;
  message?: WizardMessage;
  result?: WizardResultView;
}

/** Messages from the panel to the extension. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'useCandidate'; id: number }
  | { type: 'chooseFolder' }
  | { type: 'chooseFiles' }
  | { type: 'cancelScan' }
  | { type: 'setOptions'; options: Partial<WizardOptions> }
  | { type: 'import' }
  | { type: 'startOver' }
  | { type: 'openReportPreview' }
  | { type: 'openFolder' }
  | { type: 'openWrittenReport' }
  | { type: 'openWorkspace' };

/** Messages from the extension to the panel. */
export type ToView = { type: 'state'; view: WizardView };

export const MAX_FINDINGS_SHOWN = 300;
export const MAX_FILES_SHOWN = 500;
export const MAX_TARGET_DIR_LENGTH = 200;
