import type { TcSource } from '../pipeline';
import { LIMITS } from '../reader/limits';
import { arrangeEnvironments } from './environments';
import { arrangeCollection } from './folders';
import { groupCollections } from './group';
import { FindingSink } from './sink';
import type { SourceTree } from './tree';
import { printable } from '../util/chars';

export interface BuildTreeOptions {
  /** Folders nested deeper than this are merged into their ancestor at this level (spec N6). */
  maxFolderDepth?: number;
}

/**
 * N5, N6 and N7 together: from what the reader found to collections with their folders and requests placed and in order,
 * and the environments in order. Pure, and the same for the same data whatever order the files and arrays came in.
 */
export function buildTree(source: TcSource, options: BuildTreeOptions = {}): SourceTree {
  const sink = new FindingSink();
  const maxFolderDepth = options.maxFolderDepth ?? LIMITS.maxFolderDepth;
  const collections = groupCollections(source, sink).map(raw => arrangeCollection(raw, sink, maxFolderDepth));
  const environments = arrangeEnvironments(source);
  noteExportVersions(source, sink);
  return { collections, environments, findings: sink.flush() };
}

/** The versions of export files seen in public files; anything else is still read by its shape and mentioned (N11). */
const KNOWN_EXPORT_VERSIONS: Readonly<Record<'export-collection' | 'export-environment', readonly string[]>> = {
  'export-collection': ['1.1'],
  'export-environment': ['1.0']
};

function noteExportVersions(source: TcSource, sink: FindingSink): void {
  for (const file of source.files) {
    if (file.kind !== 'export-collection' && file.kind !== 'export-environment') continue;
    const json = file.json as { version?: unknown } | null;
    const version = typeof json === 'object' && json !== null ? json.version : undefined;
    if (version === undefined || (typeof version === 'string' && KNOWN_EXPORT_VERSIONS[file.kind].includes(version))) continue;
    const shown = typeof version === 'string' && /^[0-9A-Za-z._-]{1,12}$/.test(version) ? `version ${version}` : 'a version that is not a short number';
    sink.add(file.origin, 'TC-VERSION-UNKNOWN', printable(file.origin), `This export file has ${shown}; it was read by its shape.`);
  }
}
