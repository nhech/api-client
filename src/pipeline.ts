/**
 * The contracts between the stages (spec section 4):
 *
 *   reader  ->  TcSource  ->  normalise  ->  ImportModel  ->  emitter  ->  OutputFile[]
 *
 * Only types live here. Each stage is a pure function of its input; the VS Code layer picks the source, shows the
 * report, asks for confirmation and writes the files (spec section 9).
 */
import type { Finding } from './model/findings';
import { DEFAULT_TARGET } from './model/target';
import type { Target } from './model/target';

/** What a JSON file turned out to be, by its content and never by its name (spec 2.3). */
export type ContentKind =
  | 'v4-collection' | 'v4-environment'
  | 'v3-requests' | 'v3-collections' | 'v3-environments'
  | 'export-collection' | 'export-environment'
  | 'unrecognized';

export type LayoutKind = 'v4' | 'v3' | 'none';

export interface SourceFile {
  /** Path relative to the source root with forward slashes; never absolute, so it is safe to show. */
  origin: string;
  kind: ContentKind;
  json: unknown;
}

export interface TcSource {
  layout: LayoutKind;
  files: SourceFile[];
  findings: Finding[];
}

export type ConflictPolicy = 'new-folder' | 'skip-existing' | 'overwrite';

export interface ImportOptions {
  /** Moves literal credentials and secret-looking variables to the private environment file (spec 8.3). On by default. */
  moveSecrets: boolean;
  /** Folder below the workspace that receives the files, such as "api". */
  targetDir: string;
  conflictPolicy: ConflictPolicy;
  /** The tool the files are written for: the spelling of Thunder's dynamic variables depends on it (spec 5.7). */
  target: Target;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { moveSecrets: true, targetDir: 'api', conflictPolicy: 'new-folder', target: DEFAULT_TARGET };

export interface OutputFile {
  /** Relative to the target folder, forward slashes, no "..", checked by the writer as well. */
  path: string;
  content: string;
  /** Set to 0o600 for the private environment file. */
  mode?: number;
}

export interface ImportSummary {
  collections: number;
  folders: number;
  requests: number;
  environments: number;
  skippedRequests: number;
  secretsMoved: number;
  variablesToReenter: number;
}

export interface ImportResult {
  files: OutputFile[];
  findings: Finding[];
  summary: ImportSummary;
}
