import type { Finding } from '../model/findings';
import type { TcEnvironment, TcExportEnvironment, TcFolder, TcRequest, TcSettings } from '../model/source';
import type { JsonRecord } from './guards';

/**
 * The tree the normaliser builds from a TcSource (spec N5, N6, N7): collections with their folders and requests in order,
 * every request placed, every broken link repaired. The requests are still the data as read; the later rules (N2 to N4,
 * N8 to N19) turn them into the intermediate model.
 */

/** A link in the chain of folders above a request, nearest first. Requests share the links, so a hostile chain of 100,000 folders costs memory for the folders only. */
export interface Ancestry {
  readonly folder: TcFolder;
  readonly up: Ancestry | undefined;
}

export interface TreeRequest {
  request: TcRequest;
  /**
   * The folders the request sits in, nearest first, as they are in the data. This is not where it is placed: a request in a
   * folder merged because of the depth limit (TC-DEPTH) keeps the whole chain, so inheritance (N15 to N19) stays right.
   */
  ancestry: Ancestry | undefined;
}

export interface TreeContainer {
  folders: TreeFolder[];
  requests: TreeRequest[];
}

export interface TreeFolder extends TreeContainer {
  /** `_id` as read, or "" when the folder has none (nothing can point to it then). */
  id: string;
  name: string;
  source: TcFolder;
  /** 1 for a folder at the top of the collection. */
  depth: number;
}

/** Where a collection came from: a v4 file, a v3 collection with its requests joined from thunderclient.json, an export file, or the requests that belonged to no collection. */
export type CollectionKind = 'v4' | 'v3' | 'export' | 'unsorted';

export interface TreeCollection extends TreeContainer {
  id: string;
  name: string;
  origin: string;
  kind: CollectionKind;
  settings: TcSettings | undefined;
}

export interface TreeEnvironment {
  origin: string;
  kind: 'v4' | 'v3' | 'export';
  name: string;
  source: TcEnvironment | TcExportEnvironment;
}

export interface SourceTree {
  collections: TreeCollection[];
  environments: TreeEnvironment[];
  /** What normalisation found. The reader's own findings stay in the TcSource. */
  findings: Finding[];
}

/** A collection before its folders are arranged: the pieces N7 gathered, in no particular order. */
export interface RawCollection {
  id: string;
  name: string;
  origin: string;
  kind: CollectionKind;
  /** The collection object without its requests and folders, for ordering ties. */
  header: JsonRecord;
  settings: unknown;
  folders: unknown[];
  requests: JsonRecord[];
  /** The requests belong to no real collection, so their `containerId` points nowhere and is not an error. */
  ignoreContainerIds: boolean;
}

/** The folders above a request as a list, nearest first. */
export function ancestorFolders(ancestry: Ancestry | undefined): TcFolder[] {
  const folders: TcFolder[] = [];
  for (let link = ancestry; link !== undefined; link = link.up) folders.push(link.folder);
  return folders;
}

/** Every request below a container: its own first, then those of its folders in order, depth first. */
export function flattenRequests(container: TreeContainer): TreeRequest[] {
  const all: TreeRequest[] = [];
  const visit = (current: TreeContainer): void => {
    for (const request of current.requests) all.push(request);
    for (const folder of current.folders) visit(folder);
  };
  visit(container); // the tree is no deeper than the depth limit (spec N6)
  return all;
}
