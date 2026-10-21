import type { Child, ContainerNode, EnvironmentNode, Loaded } from './store';

/**
 * Finding things in the loaded tree by their path, and deciding what a drop of requests and folders onto the tree means. Nothing
 * here touches the disk: the extension carries out the plan through the store, one move at a time.
 */
export function findChild(loaded: Loaded, path: string): Child | undefined {
  const walk = (list: readonly Child[]): Child | undefined => {
    for (const child of list) {
      if (child.path === path) return child;
      if (child.kind !== 'request') {
        const found = walk(child.children);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(loaded.collections);
}

/** The collection or folder that holds the entry at `path`. */
export function findParent(loaded: Loaded, path: string): ContainerNode | undefined {
  const walk = (container: ContainerNode): ContainerNode | undefined => {
    for (const child of container.children) {
      if (child.path === path) return container;
      if (child.kind !== 'request') {
        const found = walk(child);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  for (const collection of loaded.collections) {
    const found = walk(collection);
    if (found !== undefined) return found;
  }
  return undefined;
}

export const findEnvironment = (loaded: Loaded, path: string): EnvironmentNode | undefined => loaded.environments.find(node => node.path === path);

/** The names of the entries of a folder as they are written in its `order` list. */
export const childSlugs = (container: ContainerNode): string[] => container.children.map(child => child.slug);

export interface DropPlan {
  /** What to move, in the order it was dragged, without anything that is inside another thing that moves. */
  nodes: Child[];
  /** The folder or collection they end up in. */
  toDir: string;
  /** The entry they are put before; undefined puts them at the end. */
  beforeSlug: string | undefined;
}

/** `reason` is empty when there is nothing to do and nothing to say (a drop on itself). */
export type DropResult = { ok: true; plan: DropPlan } | { ok: false; reason: string };

/** What dropping `sourcePaths` on `targetPath` means: onto a folder or collection, into it at the end; onto a request, next to it, before it. */
export function planDrop(loaded: Loaded, sourcePaths: readonly string[], targetPath: string | undefined): DropResult {
  if (targetPath === undefined) return { ok: false, reason: 'Drop on a folder, a collection or a request.' };
  const target = findChild(loaded, targetPath);
  if (target === undefined) return { ok: false, reason: 'That is not a place in a collection.' };
  const found: Child[] = [];
  for (const path of new Set(sourcePaths)) {
    const node = findChild(loaded, path);
    if (node !== undefined) found.push(node);
  }
  if (found.length === 0) return { ok: false, reason: '' };
  if (found.some(node => node.kind === 'collection')) return { ok: false, reason: 'A collection cannot be moved into another one.' };
  // A folder that is dragged along with something inside it carries that with it.
  const nodes = found.filter(node => !found.some(other => other !== node && other.kind !== 'request' && node.path.startsWith(`${other.path}/`)));
  const toDir = target.kind === 'request' ? (findParent(loaded, target.path) as ContainerNode).path : target.path;
  for (const node of nodes) {
    if (node.kind !== 'request' && (toDir === node.path || toDir.startsWith(`${node.path}/`))) return { ok: false, reason: 'A folder cannot be moved into itself.' };
  }
  const beforeSlug = target.kind === 'request' ? target.slug : undefined;
  // Dropped on one of the things that are being moved: nothing changes.
  if (target.kind === 'request' && nodes.some(node => node.path === target.path)) return { ok: false, reason: '' };
  return { ok: true, plan: { nodes, toDir, beforeSlug } };
}

/** The new `order` of a folder: its entries without the moved ones, which are put before `beforeSlug` (or at the end when it is not among them). */
export function orderAfter(existing: readonly string[], moved: readonly string[], beforeSlug: string | undefined): string[] {
  const rest = existing.filter(slug => !moved.includes(slug));
  const at = beforeSlug === undefined ? -1 : rest.indexOf(beforeSlug);
  const index = at < 0 ? rest.length : at;
  return [...rest.slice(0, index), ...moved, ...rest.slice(index)];
}
