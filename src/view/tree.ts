import type { Loaded, ContainerNode, RequestNode, EnvironmentNode } from '../storage/store';
import { printable } from '../util/chars';

/**
 * What the side bar shows, as plain data: a tree of nodes with a label, a description, an icon and a context value, from the
 * files that were loaded. The extension turns these into VS Code tree items; everything that decides what is shown, in what
 * order and under which filter is here, and is tested without VS Code. Every piece of text that comes from a file goes
 * through printable(), so a name cannot hide text or change its order.
 */
export type NodeKind = 'collection' | 'folder' | 'request' | 'environment' | 'broken' | 'note';
export type IconName = 'library' | 'folder' | 'request' | 'environment' | 'environment-active' | 'warning' | 'info';
export type Collapse = 'none' | 'collapsed' | 'expanded';

export interface TreeNode {
  /** The file or folder, relative to the workspace folder, with a prefix for what has none of its own. Stable between loads. */
  id: string;
  kind: NodeKind;
  label: string;
  description: string;
  tooltip: string;
  /** The value that `when` clauses of the menus in package.json test: collection, folder, request, environment, environment.active, broken. */
  contextValue: string;
  /** The same as id for files and folders. */
  path: string;
  /** The theme colour of the icon, for a request by its method. */
  color?: string;
  icon: IconName;
  collapse: Collapse;
  children: TreeNode[];
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'charts.green', POST: 'charts.orange', PUT: 'charts.blue', PATCH: 'charts.purple', DELETE: 'charts.red', HEAD: 'charts.yellow', OPTIONS: 'charts.yellow'
};

/** The colour of a method's icon: one per common method, grey for the rest. */
export const methodColor = (method: string): string => METHOD_COLORS[method.toUpperCase()] ?? 'descriptionForeground';

const text = (value: string, max = 120): string => {
  const clean = printable(value.replace(/\s+/g, ' ').trim());
  return clean.length > max ? `${clean.slice(0, max - 1)}\u2026` : clean;
};

function countRequests(node: ContainerNode): number {
  let count = 0;
  for (const child of node.children) count += child.kind === 'request' ? 1 : countRequests(child);
  return count;
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

function requestNode(node: RequestNode): TreeNode {
  const method = text(node.request.method.toUpperCase(), 16);
  const url = text(node.request.url, 200);
  return {
    id: node.path, kind: 'request', label: text(node.request.name) || node.slug, description: method, tooltip: `${method} ${url}`.trim(), contextValue: 'request', path: node.path,
    color: methodColor(node.request.method), icon: 'request', collapse: 'none', children: []
  };
}

/** Whether a request matches a filter: the name, the method and the URL, ignoring case. */
const matches = (node: RequestNode, filter: string): boolean =>
  [node.request.name, node.request.method, node.request.url].some(value => value.toLowerCase().includes(filter));

function containerNode(node: ContainerNode, filter: string): TreeNode | undefined {
  const own = node.container.name.toLowerCase().includes(filter);
  const children: TreeNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'request') {
      if (filter === '' || own || matches(child, filter)) children.push(requestNode(child));
    } else {
      // A folder that matches by its own name shows everything in it.
      const sub = containerNode(child, own ? '' : filter);
      if (sub !== undefined) children.push(sub);
    }
  }
  if (filter !== '' && !own && children.length === 0) return undefined;
  const requests = countRequests(node);
  return {
    id: node.path, kind: node.kind, label: text(node.container.name) || node.slug, description: plural(requests, 'request'),
    tooltip: node.findings.length > 0 ? text(node.findings.map(f => f.message).join('; '), 300) : text(node.container.docs.split('\n')[0] ?? '', 300),
    contextValue: node.kind, path: node.path, icon: node.kind === 'collection' ? 'library' : 'folder',
    collapse: filter !== '' ? 'expanded' : children.length > 0 ? 'collapsed' : 'none', children
  };
}

/** The collections, folders and requests, the files that could not be read, and a line about what was left out. */
export function collectionsTree(loaded: Loaded, filter = ''): TreeNode[] {
  const wanted = filter.trim().toLowerCase();
  const nodes: TreeNode[] = [];
  for (const collection of loaded.collections) {
    const node = containerNode(collection, wanted);
    if (node !== undefined) nodes.push(node);
  }
  if (wanted === '') {
    for (const broken of loaded.broken.filter(item => !item.path.includes('/environments/'))) {
      const name = broken.path.slice(broken.path.lastIndexOf('/') + 1);
      const reason = broken.newer ? 'written by a newer version' : 'cannot be read';
      nodes.push({
        id: `broken:${broken.path}`, kind: 'broken', label: text(name), description: reason, tooltip: text(broken.findings.map(f => `${f.path === '' ? '' : `${f.path}: `}${f.message}`).join('\n'), 600),
        contextValue: 'broken', path: broken.path, icon: 'warning', collapse: 'none', children: []
      });
    }
    if (loaded.notes.length > 0 || loaded.truncated) {
      nodes.push({
        id: 'note:left-out', kind: 'note', label: `${plural(loaded.notes.length, 'thing')} left out`, description: '', tooltip: text(loaded.notes.map(n => `${n.path}: ${n.message}`).join('\n'), 1000),
        contextValue: 'note', path: '', icon: 'info', collapse: 'none', children: []
      });
    }
  }
  return nodes;
}

/** The environments, the active one marked. */
export function environmentsTree(loaded: Loaded, activeId: string | undefined): TreeNode[] {
  const nodes: TreeNode[] = [];
  const environmentNode = (node: EnvironmentNode): TreeNode => {
    const active = activeId !== undefined && node.environment.id === activeId;
    return {
      id: node.path, kind: 'environment', label: text(node.environment.name) || node.slug, description: active ? 'active' : plural(node.environment.vars.length, 'variable'),
      tooltip: active ? 'The active environment: its variables are used when a request is sent.' : 'Not active', contextValue: active ? 'environment.active' : 'environment', path: node.path,
      icon: active ? 'environment-active' : 'environment', collapse: 'none', children: []
    };
  };
  for (const environment of loaded.environments) nodes.push(environmentNode(environment));
  for (const broken of loaded.broken.filter(item => item.path.includes('/environments/'))) {
    nodes.push({
      id: `broken:${broken.path}`, kind: 'broken', label: text(broken.path.slice(broken.path.lastIndexOf('/') + 1)), description: broken.newer ? 'written by a newer version' : 'cannot be read',
      tooltip: text(broken.findings.map(f => f.message).join('\n'), 600), contextValue: 'broken', path: broken.path, icon: 'warning', collapse: 'none', children: []
    });
  }
  return nodes;
}

/** Finds a node by id in a tree, depth first. */
export function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const inside = findNode(node.children, id);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/** The ids from the root to a node, for revealing it. */
export function pathTo(nodes: readonly TreeNode[], id: string): string[] | undefined {
  for (const node of nodes) {
    if (node.id === id) return [node.id];
    const below = pathTo(node.children, id);
    if (below !== undefined) return [node.id, ...below];
  }
  return undefined;
}
