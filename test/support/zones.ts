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

/** The packages the request editor page is built from; the bundle audit of the page checks that nothing else went into dist/app.js. */
export const APP_PAGE_PACKAGES = [
  'preact', 'preact/hooks', '@preact/signals',
  '@codemirror/autocomplete', '@codemirror/commands', '@codemirror/lang-javascript', '@codemirror/lang-json', '@codemirror/lang-xml', '@codemirror/language',
  '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view', '@lezer/highlight'
] as const;

export const ZONES: Zone[] = [
  { name: 'stages', paths: ['src/model/', 'src/normalize/', 'src/convert/', 'src/emit/'], modules: [], uses: ['util'], deterministic: true },
  { name: 'util', paths: ['src/util/', 'src/reader/limits.ts', 'src/write/gitignore.ts'], modules: [], uses: [] },
  { name: 'core', paths: ['src/core/'], modules: [], uses: ['util'], deterministic: true },
  { name: 'format', paths: ['src/format/'], modules: [], uses: ['util', 'core'], deterministic: true },
  {
    name: 'net',
    paths: ['src/engine/'],
    modules: ['node:http', 'node:https', 'node:tls', 'node:net', 'node:zlib', 'node:stream', 'node:stream/promises', 'node:fs', 'node:crypto', 'node:path'],
    uses: ['core', 'util']
  },
  { name: 'view', paths: ['src/view/'], modules: [], uses: ['util', 'core', 'format'], deterministic: true },
  { name: 'storage', paths: ['src/storage/'], modules: [], uses: ['stages', 'util', 'core', 'format'] },
  { name: 'storage-node', paths: ['src/storage/node-fs.ts'], modules: ['node:crypto', 'node:fs', 'node:path'], uses: ['io', 'util', 'storage'] },
  { name: 'io', paths: ['src/reader/', 'src/write/', 'src/discover.ts'], modules: ['node:fs', 'node:fs/promises', 'node:path'], uses: ['stages', 'util'] },
  {
    name: 'app',
    paths: ['src/wizard/', 'src/host.ts', 'src/import.ts', 'src/index.ts', 'src/pipeline.ts', 'src/run.ts', 'src/settings-merge.ts', 'src/cli.ts'],
    modules: ['node:path'],
    uses: ['stages', 'util', 'io']
  },
  { name: 'ui', paths: ['extension/src/'], modules: ['vscode', 'node:crypto', 'node:fs', 'node:os', 'node:path'], uses: ['stages', 'util', 'io', 'app', 'core', 'format', 'storage', 'storage-node', 'view', 'net'] },
  // The sandbox of the scripts: the messages and the code of the API are pure; the manager starts and watches the worker; the worker is the one place that holds the engine.
  { name: 'script-pure', paths: ['src/script/protocol.ts'], modules: [], uses: ['util', 'core'] },
  { name: 'script', paths: ['src/script/'], modules: ['node:fs', 'node:worker_threads'], uses: ['script-pure', 'util', 'core'] },
  { name: 'script-worker', paths: ['src/script/worker.ts'], modules: ['node:worker_threads', 'quickjs-emscripten-core', '@jitl/quickjs-wasmfile-release-sync'], uses: ['script-pure'] },
  { name: 'page', paths: ['extension/src/webview/'], modules: [], uses: ['util'] },
  // The request editor in the page: Preact and CodeMirror are the only packages that go into it (dist/app.meta.json is checked against the same list), and it
  // applies the edits it sends with the same code the extension checks them with, so it may use the view zone.
  { name: 'app-page', paths: ['extension/src/webview/app/'], modules: [...APP_PAGE_PACKAGES], uses: ['util', 'core', 'view'] }
];

/** Never allowed in any zone, whatever its list says: they run code or processes the data could steer. */
export const BANNED_EVERYWHERE = ['node:vm', 'node:child_process', 'node:cluster'];
