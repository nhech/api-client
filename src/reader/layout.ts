import type { LayoutKind } from '../pipeline';

/**
 * Layout of a Thunder Client data folder (spec 2.2). The rule is the extension's own: v4 if `collections/` holds a file
 * whose name starts with `tc_col`, otherwise v3 if `thunderclient.json` or `thunderCollection.json` sits at the top.
 * Pure over lists of names, so it is tested without a disk.
 */
export interface LayoutInput {
  /** File names at the top of the data folder. */
  rootFiles: readonly string[];
  /** File names inside `collections/` (empty when there is none). */
  collectionsFiles: readonly string[];
}

export interface LayoutDecision {
  layout: LayoutKind;
  /** v3 files exist next to v4 ones; v4 wins and the report says so (TC-LAYOUT-BOTH). */
  bothPresent: boolean;
}

export function detectLayout(input: LayoutInput): LayoutDecision {
  // The extension compares with startsWith and exact case; keep that for v4.
  const hasV4 = input.collectionsFiles.some(name => name.startsWith('tc_col'));
  const top = new Set(input.rootFiles.map(name => name.toLowerCase()));
  const hasV3 = top.has('thunderclient.json') || top.has('thundercollection.json');
  if (hasV4) return { layout: 'v4', bothPresent: hasV3 };
  return { layout: hasV3 ? 'v3' : 'none', bothPresent: false };
}

export type EntryRole =
  | 'v4-collection' | 'v4-environment'
  | 'v3-requests' | 'v3-collections' | 'v3-environments' | 'v3-local-environment'
  | 'history' | 'responses'
  | 'skipped-folder'
  | 'other';

const TOP_LEVEL_FILES: Readonly<Record<string, EntryRole>> = {
  'thunderclient.json': 'v3-requests',
  'thundercollection.json': 'v3-collections',
  'thunderenvironment.json': 'v3-environments',
  'thunderlocalenvironment.json': 'v3-local-environment',
  'thunderactivity.json': 'history',
  'thunderresponses.json': 'responses'
};

/** Folders that are never read: attachments, stored responses and the backups of the v3 to v4 upgrade. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['files', 'res-files', '_db-backup', '_db-backupv3']);

/** The role of a file by its name and where it is: `inCollections` / `inEnvironments` for the two v4 sub-folders. */
export function entryRole(name: string, where: 'top' | 'collections' | 'environments' = 'top'): EntryRole {
  if (where === 'collections') return name.startsWith('tc_col') ? 'v4-collection' : 'other';
  if (where === 'environments') return name.startsWith('tc_env') ? 'v4-environment' : 'other';
  return Object.hasOwn(TOP_LEVEL_FILES, name.toLowerCase()) ? TOP_LEVEL_FILES[name.toLowerCase()] ?? 'other' : 'other';
}

export function isSkippedFolder(name: string): boolean {
  return SKIPPED_FOLDERS.has(name.toLowerCase());
}
