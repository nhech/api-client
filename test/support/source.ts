import type { ContentKind, SourceFile, SourceTree, TcSource, TreeContainer } from '../../src';

export const file = (origin: string, kind: ContentKind, json: unknown): SourceFile => ({ origin, kind, json });
export const source = (...files: SourceFile[]): TcSource => ({ layout: 'none', files, findings: [] });

export const folder = (id: string, name: string, containerId = '', extra: object = {}) => ({ _id: id, name, containerId, ...extra });
export const req = (name: string, containerId = '', extra: object = {}) => ({ _id: `r-${name}`, colId: 'c1', containerId, name, url: '/', method: 'GET', ...extra });
export const v4 = (colName: string, folders: object[] = [], requests: object[] = [], extra: object = {}) => ({ _id: `col-${colName}`, colName, folders, requests, ...extra });

export interface Shape {
  requests: string[];
  folders: { name: string; requests: string[]; folders: Shape['folders'] }[];
}

/** A container as plain names, to compare trees at a glance (the real nodes carry the whole data). */
export function shape(container: TreeContainer): Shape {
  const names = (c: TreeContainer) => c.requests.map(r => String(r.request.name));
  const folders = (c: TreeContainer): Shape['folders'] => c.folders.map(f => ({ name: f.name, requests: names(f), folders: folders(f) }));
  return { requests: names(container), folders: folders(container) };
}

/** Everything about a tree a person would compare, as plain data. */
export function project(tree: SourceTree) {
  return {
    collections: tree.collections.map(c => ({ id: c.id, name: c.name, kind: c.kind, origin: c.origin, ...shape(c) })),
    environments: tree.environments.map(e => `${e.kind}:${e.origin}:${e.name}`),
    findings: tree.findings.map(f => `${f.code}/${f.severity}@${f.where}: ${f.message}`)
  };
}

/** A small seeded generator, so a shuffle in a test is the same on every run. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const next = random(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}
