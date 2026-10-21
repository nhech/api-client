import type { Level } from '../core/inherit';
import { classify, mirrorFile, splitFile, type Drift } from '../mirror/drift';
import { mirrorOf, type Mirror } from '../mirror/generate';
import { withMirrorBlock } from '../mirror/gitignore';
import { textHash } from '../util/hash';
import { joinPath, STORAGE_LIMITS, type StorageFs } from './fs';
import type { ContainerNode, Loaded, RequestNode } from './store';

/**
 * Keeps the `.http` file next to each request in step with the request (src/mirror/ says what is in it and when it may be rewritten).
 * This is the part that reads and writes files, for a store that was loaded: it never changes a request, and it writes only a file that
 * is missing or that is generated and that nobody has changed since it was written.
 */
export type MirrorMode = 'on' | 'off' | 'gitignored';

export interface MirrorEntry {
  /** The `.http` file, relative to the workspace folder. */
  path: string;
  /** The request it was made from. */
  request: string;
  drift: 'edited' | 'both';
}

export interface MirrorReport {
  /** Files that were written: new ones, and ones that follow a change of the request. */
  written: string[];
  /** Generated files that somebody changed by hand: never written over. */
  drifted: MirrorEntry[];
  /** Generated files that no request is behind any more and nobody changed, which were removed. */
  removed: string[];
  /** Generated files that no request is behind any more and somebody changed: kept. */
  orphans: string[];
  /** Files that were left for later because the person is changing them right now (see the `skip` option). */
  deferred: string[];
  /** Files that could not be read or written, with the reason. */
  failed: { path: string; reason: string }[];
}

export const mirrorPathOf = (requestPath: string): string => requestPath.replace(/\.req\.yml$/, '.http');
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const HTTP_SUFFIX = '.http';

export interface Found { node: RequestNode; chain: ContainerNode[] }

function collect(collections: readonly ContainerNode[]): { requests: Found[]; folders: ContainerNode[] } {
  const requests: Found[] = [];
  const folders: ContainerNode[] = [];
  const walk = (container: ContainerNode, chain: ContainerNode[]): void => {
    const here = [...chain, container];
    folders.push(container);
    for (const child of container.children) {
      if (child.kind === 'request') requests.push({ node: child, chain: here });
      else walk(child, here);
    }
  };
  for (const collection of collections) walk(collection, []);
  return { requests, folders };
}

/** The mirror that a request would have now: made from the request as it is in its collection. */
export function mirrorOfRequest(loaded: Loaded, found: Found): { mirror: Mirror; text: string } {
  const { node, chain } = found;
  const levels: Level[] = chain.map(container => ({ kind: container.kind, name: container.container.name, container: container.container }));
  const mirror = mirrorOf({ request: node.request, levels, workspaceSettings: loaded.workspace.file.settings, file: baseName(node.path), collection: (chain[0] as ContainerNode).container.name, depth: chain.length - 1 });
  return { mirror, text: mirrorFile(baseName(node.path), mirror) };
}

/** The request that a `.http` file may have been made from, by its place. */
export function requestOfMirror(loaded: Loaded, mirrorPath: string): Found | undefined {
  if (!mirrorPath.endsWith(HTTP_SUFFIX)) return undefined;
  const source = `${mirrorPath.slice(0, -HTTP_SUFFIX.length)}.req.yml`;
  return collect(loaded.collections).requests.find(found => found.node.path === source);
}

export interface Inspected extends Found { mirror: Mirror; /** What the file would be now. */ text: string; drift: Drift }

/** What a `.http` file is to the request next to it: nothing when there is no request, else the state. */
export function inspectMirror(loaded: Loaded, mirrorPath: string, current: string | undefined): Inspected | undefined {
  const found = requestOfMirror(loaded, mirrorPath);
  if (found === undefined) return undefined;
  const made = mirrorOfRequest(loaded, found);
  return { ...found, ...made, drift: classify(current, made.mirror) };
}

async function mapLimit<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(STORAGE_LIMITS.parallelReads, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index] as T);
    }
  });
  await Promise.all(runners);
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : 'the file could not be used');

export interface SyncOptions {
  /** A file that is open with changes that are not saved is not written over; it is tried again at the next sync. */
  skip?: (path: string) => boolean;
}

export async function syncMirrors(fs: StorageFs, loaded: Loaded, mode: MirrorMode, options: SyncOptions = {}): Promise<MirrorReport> {
  const report: MirrorReport = { written: [], drifted: [], removed: [], orphans: [], deferred: [], failed: [] };
  if (mode === 'off') return report;
  const { requests, folders } = collect(loaded.collections);
  const owned = new Set<string>();
  const known = new Set(requests.map(({ node }) => node.path));

  await mapLimit(requests, async ({ node, chain }) => {
    if (!node.request.mirror) return;
    const path = mirrorPathOf(node.path);
    const { mirror, text } = mirrorOfRequest(loaded, { node, chain });
    let file: string | undefined;
    try { file = await fs.read(path); } catch (error) { report.failed.push({ path, reason: reason(error) }); return; }
    const drift = classify(file, mirror);
    if (drift === 'foreign') return;
    owned.add(path);
    if (drift === 'in-sync') return;
    if (drift === 'edited' || drift === 'both') { report.drifted.push({ path, request: node.path, drift }); return; }
    if (options.skip?.(path) === true) { report.deferred.push(path); return; }
    try { await fs.write(path, text); report.written.push(path); } catch (error) { report.failed.push({ path, reason: reason(error) }); }
  });

  // A generated file whose request is not there any more (renamed, moved, deleted) goes with it, unless somebody changed it.
  await mapLimit(folders, async folder => {
    let entries;
    try { entries = await fs.list(folder.path); } catch { return; }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith(HTTP_SUFFIX)) continue;
      const path = joinPath(folder.path, entry.name);
      const source = path.slice(0, -HTTP_SUFFIX.length) + '.req.yml';
      if (known.has(source)) continue;
      let file: string | undefined;
      try { file = await fs.read(path); } catch { continue; }
      if (file === undefined) continue;
      const { header, block } = splitFile(file);
      if (header === undefined) continue;
      if (textHash(block) !== header.hash) { report.orphans.push(path); continue; }
      try { await fs.remove(path); report.removed.push(path); } catch (error) { report.failed.push({ path, reason: reason(error) }); }
    }
  });

  // The generated files are kept out of Git when the mode says so, and the block of the .gitignore goes away when it does not.
  const root = loaded.workspace.path.includes('/') ? loaded.workspace.path.slice(0, loaded.workspace.path.lastIndexOf('/')) : '';
  const ignore = joinPath(root, '.gitignore');
  try {
    const current = await fs.read(ignore);
    const relative = [...owned].filter(path => root === '' || path.startsWith(`${root}/`)).map(path => (root === '' ? path : path.slice(root.length + 1)));
    const change = withMirrorBlock(current, mode === 'gitignored' ? relative : []);
    if (change.change !== 'none' && change.text !== undefined) await fs.write(ignore, change.text);
  } catch (error) { report.failed.push({ path: ignore, reason: reason(error) }); }

  report.written.sort();
  report.deferred.sort();
  report.drifted.sort((a, b) => (a.path < b.path ? -1 : 1));
  return report;
}
