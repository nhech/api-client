import type { TcFolder, TcRequest, TcSettings } from '../model/source';
import { displayLabel } from '../util/chars';
import { isRecord } from './guards';
import { sortBySourceOrder } from './order';
import type { FindingSink } from './sink';
import type { Ancestry, RawCollection, TreeCollection, TreeFolder, TreeRequest } from './tree';

/**
 * N6: the folder tree of one collection, from the `containerId` links (spec N5 order throughout).
 *
 *  - a folder whose parent does not exist moves to the top (TC-ORPHAN-FOLDER);
 *  - a cycle is cut at the folder that comes first in N5 order, which then sits at the top (TC-CYCLE): the choice does not
 *    depend on where the walk started, so the result does not depend on the order of the input;
 *  - folders deeper than `maxDepth` are merged into their ancestor at that level (TC-DEPTH): their requests move there and
 *    they disappear from the tree, but each request keeps its whole chain of ancestors for inheritance;
 *  - a request whose folder does not exist moves to the top of the collection (TC-ORPHAN-REQUEST).
 *
 * A folder id that appears twice belongs to the first of them in N5 order; the children pointing at that id go there.
 * Every walk is iterative and linear, so a hostile file cannot make it deep or quadratic.
 */
export function arrangeCollection(raw: RawCollection, sink: FindingSink, maxFolderDepth: number): TreeCollection {
  const scope = displayLabel(raw.name);
  const max = Math.max(1, maxFolderDepth);
  const folders = sortBySourceOrder(raw.folders.filter(isRecord), 'name') as TcFolder[];
  const count = folders.length;

  const idOf = (folder: TcFolder): string => (typeof folder._id === 'string' ? folder._id : '');
  const firstById = new Map<string, number>();
  folders.forEach((folder, index) => {
    const id = idOf(folder);
    if (id !== '' && !firstById.has(id)) firstById.set(id, index);
  });

  // The parent of each folder, -1 for the top of the collection.
  const parent: number[] = new Array<number>(count).fill(-1);
  folders.forEach((folder, index) => {
    const wanted = typeof folder.containerId === 'string' ? folder.containerId : '';
    if (wanted === '') return;
    const found = firstById.get(wanted);
    if (found === undefined) sink.add(scope, 'TC-ORPHAN-FOLDER', `${scope} / ${displayLabel(folder.name)}`, 'A folder pointed to a missing parent and was moved to the top of the collection.');
    else parent[index] = found;
  });

  cutCycles(folders, parent, scope, sink);

  // Depth, the folder where a deep one is merged, and the chain above each folder: ancestors are visited before descendants.
  const depth: number[] = new Array<number>(count).fill(0);
  const anchor: number[] = new Array<number>(count).fill(-1);
  const ancestryOf: (Ancestry | undefined)[] = new Array<Ancestry | undefined>(count).fill(undefined);
  for (let start = 0; start < count; start++) {
    if ((depth[start] ?? 0) !== 0) continue;
    const pending: number[] = [];
    let current = start;
    while (current !== -1 && (depth[current] ?? 0) === 0) {
      pending.push(current);
      current = parent[current] ?? -1;
    }
    let level = current === -1 ? 0 : (depth[current] ?? 0);
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      level += 1;
      depth[node] = level;
      const up = parent[node] ?? -1;
      ancestryOf[node] = { folder: folders[node] as TcFolder, up: up === -1 ? undefined : ancestryOf[up] };
      anchor[node] = level <= max ? node : (anchor[up] ?? node);
    }
  }

  const nodes: TreeFolder[] = folders.map((folder, index) => ({
    id: idOf(folder), name: typeof folder.name === 'string' ? folder.name : '', source: folder, depth: depth[index] ?? 1, folders: [], requests: []
  }));
  const topFolders: TreeFolder[] = [];
  let merged = 0;
  nodes.forEach((node, index) => {
    if (node.depth > max) { merged++; return; }
    const up = parent[index] ?? -1;
    const siblings = up === -1 ? topFolders : (nodes[up] as TreeFolder).folders;
    siblings.push(node);
  });
  if (merged > 0) sink.add(scope, 'TC-DEPTH', scope, `${merged} folders nested deeper than ${max} levels were merged into their ancestor at level ${max}.`);

  const topRequests: TreeRequest[] = [];
  for (const request of sortBySourceOrder(raw.requests, 'name') as TcRequest[]) {
    const wanted = !raw.ignoreContainerIds && typeof request.containerId === 'string' ? request.containerId : '';
    let target = topRequests;
    let ancestry: Ancestry | undefined;
    if (wanted !== '') {
      const index = firstById.get(wanted);
      if (index === undefined) {
        sink.add(scope, 'TC-ORPHAN-REQUEST', `${scope} / ${displayLabel(request.name)}`, 'A request pointed to a missing folder and was moved to the top of the collection.');
      } else {
        target = nodes[anchor[index] ?? index]?.requests ?? topRequests;
        ancestry = ancestryOf[index];
      }
    }
    target.push({ request, ancestry });
  }

  return { id: raw.id, name: raw.name, origin: raw.origin, kind: raw.kind, settings: asSettings(raw.settings), folders: topFolders, requests: topRequests };
}

/** Breaks every cycle of the parent links, once, at its first folder in N5 order. */
function cutCycles(folders: readonly TcFolder[], parent: number[], scope: string, sink: FindingSink): void {
  const state = new Uint8Array(folders.length); // 0 not seen, 1 on the current walk, 2 finished
  for (let start = 0; start < folders.length; start++) {
    if ((state[start] ?? 0) !== 0) continue;
    const walk: number[] = [];
    let current = start;
    while (current !== -1 && (state[current] ?? 0) === 0) {
      state[current] = 1;
      walk.push(current);
      current = parent[current] ?? -1;
    }
    if (current !== -1 && state[current] === 1) {
      const cycle = walk.slice(walk.indexOf(current));
      let cut = cycle[0] ?? 0;
      for (const node of cycle) if (node < cut) cut = node;
      parent[cut] = -1;
      sink.add(scope, 'TC-CYCLE', `${scope} / ${displayLabel(folders[cut]?.name)}`, 'A folder cycle was cut at this folder, which now sits at the top of the collection.');
    }
    for (const node of walk) state[node] = 2;
  }
}

function asSettings(value: unknown): TcSettings | undefined {
  return isRecord(value) ? (value as TcSettings) : undefined;
}
