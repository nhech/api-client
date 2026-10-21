/**
 * The zones of the source tree and what each may import, read by test/unit/purity.test.ts.
 *
 * Every .ts file under src/ and extension/src/ belongs to exactly one zone (the one with the longest matching path), so a new
 * directory has to be added here on purpose: adding it is the moment to decide whether it may touch the disk, the network, a
 * worker or VS Code. Widen a list in the commit that needs it and say why in the message; the other zones stay as they are.
 */
export interface Zone {
  name: string;
  /** Repository-relative paths with forward slashes: a trailing slash is a directory, anything else is one file. */
  paths: string[];
  /** The modules its files may import (Node built-ins with their node: prefix, or packages). Relative imports are governed by `uses`. */
  modules: string[];
  /** The zones whose files it may import by relative path at run time (its own zone is implied). Type-only imports are free. */
  uses: string[];
  /** The stages that decide the output: nothing in them may depend on time, randomness, the machine or the locale. */
  deterministic?: boolean;
}

export const ZONES: Zone[] = [
  { name: 'stages', paths: ['src/model/', 'src/normalize/', 'src/convert/', 'src/emit/'], modules: [], uses: ['util'], deterministic: true },
  { name: 'util', paths: ['src/util/', 'src/reader/limits.ts'], modules: [], uses: [] },
  { name: 'format', paths: ['src/format/'], modules: [], uses: ['util'], deterministic: true },
  { name: 'io', paths: ['src/reader/', 'src/write/', 'src/discover.ts'], modules: ['node:fs', 'node:fs/promises', 'node:path'], uses: ['stages', 'util'] },
  {
    name: 'app',
    paths: ['src/wizard/', 'src/host.ts', 'src/import.ts', 'src/index.ts', 'src/pipeline.ts', 'src/run.ts', 'src/settings-merge.ts', 'src/cli.ts'],
    modules: ['node:path'],
    uses: ['stages', 'util', 'io']
  },
  { name: 'ui', paths: ['extension/src/'], modules: ['vscode', 'node:crypto', 'node:fs', 'node:os', 'node:path'], uses: ['stages', 'util', 'io', 'app'] },
  { name: 'page', paths: ['extension/src/webview/'], modules: [], uses: ['util'] }
];

/** Never allowed in any zone, whatever its list says: they run code or processes the data could steer. */
export const BANNED_EVERYWHERE = ['node:vm', 'node:child_process', 'node:cluster'];
