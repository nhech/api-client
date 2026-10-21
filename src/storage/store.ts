import { newId, type Clock } from '../core/clock';
import { newContainer, newEnvironment, newRequest, newWorkspaceFile, type Container, type Environment, type Request, type Var, type WorkspaceFile } from '../core/model';
import { uniqueSlugs } from '../emit/names';
import type { Finding } from '../format/schema';
import { readContainer, readEnvironment, readRequest, readWorkspace, writeContainer, writeEnvironment, writeRequest, writeWorkspace } from '../format/schema';
import type { YMap } from '../format/yaml';
import { LIMITS } from '../reader/limits';
import { compareCodePoints } from '../util/chars';
import { ensureIgnored } from '../write/gitignore';
import { baseName, joinPath, parentPath, STORAGE_LIMITS, type StorageFs } from './fs';
import { localPathOf, mergeSecrets, readLocalValues, splitSecrets, writeLocalValues } from './secrets';

/**
 * The client's files as a tree, and the operations that change them. Everything is written relative to a root folder (by
 * default `api-client`) of the workspace through a StorageFs, one file at a time and atomically, so that a crash or a full disk
 * never leaves half a file. Identifiers are stable: a rename moves the file and changes the name inside it, nothing else.
 *
 * What is read comes from a repository somebody may have cloned, so it is read with limits (entries per folder, depth, nodes,
 * file size), links and special files are never followed, and a file that cannot be used is reported next to the tree instead
 * of stopping the load.
 */
export const DEFAULT_ROOT = 'api-client';
const WORKSPACE_FILE = 'workspace.yml';
const COLLECTIONS = 'collections';
const ENVIRONMENTS = 'environments';
const COLLECTION_FILE = 'collection.yml';
const FOLDER_FILE = 'folder.yml';
const REQUEST_SUFFIX = '.req.yml';
const ENVIRONMENT_SUFFIX = '.env.yml';
const LOCAL_FILE_MODE = 0o600;
const GITIGNORE_LINES = ['*.local.yml', '.runs/'];

export interface RequestNode {
  kind: 'request';
  /** The file, relative to the workspace folder. */
  path: string;
  slug: string;
  request: Request;
  /** Keys the schema does not know, written back as they were. */
  extra: YMap;
  findings: Finding[];
}

export interface ContainerNode {
  kind: 'collection' | 'folder';
  /** The folder. */
  path: string;
  slug: string;
  container: Container;
  extra: YMap;
  findings: Finding[];
  /** Folders and requests in the order they are shown. */
  children: (ContainerNode | RequestNode)[];
  /** The folder has no `folder.yml` yet; one is written when it is first changed. */
  implicit: boolean;
}

export interface EnvironmentNode {
  kind: 'environment';
  path: string;
  slug: string;
  environment: Environment;
  extra: YMap;
  findings: Finding[];
}

export interface WorkspaceNode {
  path: string;
  file: WorkspaceFile;
  extra: YMap;
  findings: Finding[];
}

/** A file that could not be used, with the reason; `newer` means a later version of the extension wrote it. */
export interface Broken {
  path: string;
  findings: Finding[];
  newer: boolean;
}

export interface Loaded {
  workspace: WorkspaceNode;
  collections: ContainerNode[];
  environments: EnvironmentNode[];
  broken: Broken[];
  /** What was left out and why: a link, a folder that is too deep, more entries than the limit. */
  notes: { path: string; message: string }[];
  /** A limit was reached: the tree is not complete. */
  truncated: boolean;
}

export class StoreError extends Error {}

export type Child = ContainerNode | RequestNode;

const isRequestFile = (name: string): boolean => name.endsWith(REQUEST_SUFFIX) && !name.endsWith('.local.yml') && name.length > REQUEST_SUFFIX.length;
const isEnvironmentFile = (name: string): boolean => name.endsWith(ENVIRONMENT_SUFFIX) && name.length > ENVIRONMENT_SUFFIX.length;
/** The name as it is written in a file name: lower case, white space as hyphens (the unsafe characters and the names Windows reserves are dealt with by slugify). */
const kebab = (name: string): string => name.toLowerCase().replace(/\s+/g, '-');
const byName = (a: { name: string }, b: { name: string }): number => compareCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) || compareCodePoints(a.name, b.name);

/** Runs `work` over the items, a few at a time, and keeps the results in the order of the items. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await work(items[index] as T);
    }
  });
  await Promise.all(runners);
  return out;
}

export class Store {
  constructor(private readonly fs: StorageFs, private readonly clock: Clock, readonly root: string = DEFAULT_ROOT) {}

  private at(...parts: string[]): string {
    return joinPath(this.root, ...parts);
  }

  // ---- reading ----

  async load(): Promise<Loaded> {
    const loaded: Loaded = {
      workspace: { path: this.at(WORKSPACE_FILE), file: newWorkspaceFile(), extra: new Map(), findings: [] },
      collections: [], environments: [], broken: [], notes: [], truncated: false
    };
    const budget = { nodes: 0 };
    await this.loadWorkspaceFile(loaded);
    const collectionEntries = await this.fs.list(this.at(COLLECTIONS));
    for (const entry of this.limited(collectionEntries.sort((a, b) => compareCodePoints(a.name, b.name)), this.at(COLLECTIONS), loaded)) {
      if (entry.kind === 'dir') {
        const node = await this.loadContainer(this.at(COLLECTIONS, entry.name), 'collection', 0, loaded, budget);
        if (node !== undefined) loaded.collections.push(node);
      } else if (entry.kind === 'other') loaded.notes.push({ path: this.at(COLLECTIONS, entry.name), message: 'not a plain file or folder (a link or a special file): left out' });
    }
    loaded.collections = this.ordered(loaded.collections, loaded.workspace.file.collections);
    const environmentEntries = (await this.fs.list(this.at(ENVIRONMENTS))).filter(entry => entry.kind === 'file' && isEnvironmentFile(entry.name)).sort((a, b) => compareCodePoints(a.name, b.name));
    const environments = await mapLimit(this.limited(environmentEntries, this.at(ENVIRONMENTS), loaded), STORAGE_LIMITS.parallelReads, entry => this.loadEnvironment(entry.name));
    for (const result of environments) {
      if ('kind' in result) loaded.environments.push(result);
      else loaded.broken.push(result);
    }
    loaded.environments.sort((a, b) => byName({ name: a.environment.name }, { name: b.environment.name }));
    return loaded;
  }

  private limited<T>(entries: T[], path: string, loaded: Loaded): T[] {
    if (entries.length <= STORAGE_LIMITS.maxEntriesPerFolder) return entries;
    loaded.truncated = true;
    loaded.notes.push({ path, message: `more than ${STORAGE_LIMITS.maxEntriesPerFolder} entries: only the first ones were read` });
    return entries.slice(0, STORAGE_LIMITS.maxEntriesPerFolder);
  }

  private async readText(path: string, loaded: Loaded): Promise<string | undefined> {
    try {
      return await this.fs.read(path);
    } catch (error) {
      loaded.broken.push({ path, findings: [{ path: '', message: error instanceof Error ? error.message : 'could not be read', severity: 'error' }], newer: false });
      return undefined;
    }
  }

  /** Puts the local secret values into the variables of a file that was just read. */
  private async withSecrets(path: string, vars: Var[], findings: Finding[]): Promise<Var[]> {
    if (!vars.some(variable => variable.secret)) return vars;
    let text: string | undefined;
    try { text = await this.fs.read(localPathOf(path)); } catch { findings.push({ path: '', message: 'the file with the secret values could not be read', severity: 'warning' }); }
    const local = readLocalValues(text);
    if (local.problem !== undefined) findings.push({ path: '', message: `the file with the secret values is not usable: ${local.problem}`, severity: 'warning' });
    const merged = mergeSecrets(vars, local.values);
    for (const name of merged.leaked) findings.push({ path: `vars.${name}`, message: 'a secret value is in the shared file; it moves to the file that Git ignores when the file is saved', severity: 'warning' });
    return merged.vars;
  }

  private async loadWorkspaceFile(loaded: Loaded): Promise<void> {
    const path = loaded.workspace.path;
    const text = await this.readText(path, loaded);
    if (text === undefined) return;
    const result = readWorkspace(text);
    if (!result.ok) {
      loaded.broken.push({ path, findings: result.findings, newer: result.newer });
      return;
    }
    const findings = [...result.findings];
    loaded.workspace = { path, file: { ...result.value, vars: await this.withSecrets(path, result.value.vars, findings) }, extra: result.extra, findings };
  }

  private async loadEnvironment(name: string): Promise<EnvironmentNode | Broken> {
    const path = this.at(ENVIRONMENTS, name);
    let text: string | undefined;
    try { text = await this.fs.read(path); } catch (error) { return { path, findings: [{ path: '', message: error instanceof Error ? error.message : 'could not be read', severity: 'error' }], newer: false }; }
    if (text === undefined) return { path, findings: [{ path: '', message: 'the file is gone', severity: 'error' }], newer: false };
    const result = readEnvironment(text);
    if (!result.ok) return { path, findings: result.findings, newer: result.newer };
    const findings = [...result.findings];
    const vars = await this.withSecrets(path, result.value.vars, findings);
    return { kind: 'environment', path, slug: name.slice(0, -ENVIRONMENT_SUFFIX.length), environment: { ...result.value, vars }, extra: result.extra, findings };
  }

  /** A folder that cannot be listed or read is a note, never a reason to stop loading the rest. */
  private async loadContainer(dir: string, kind: 'collection' | 'folder', depth: number, loaded: Loaded, budget: { nodes: number }): Promise<ContainerNode | undefined> {
    try {
      return await this.readContainerTree(dir, kind, depth, loaded, budget);
    } catch (error) {
      loaded.notes.push({ path: dir, message: error instanceof Error ? error.message : 'could not be read' });
      return undefined;
    }
  }

  private async readContainerTree(dir: string, kind: 'collection' | 'folder', depth: number, loaded: Loaded, budget: { nodes: number }): Promise<ContainerNode | undefined> {
    if (depth > STORAGE_LIMITS.maxDepth) {
      loaded.truncated = true;
      loaded.notes.push({ path: dir, message: `nested more than ${STORAGE_LIMITS.maxDepth} folders deep: left out` });
      return undefined;
    }
    const slug = baseName(dir);
    const entries = this.limited((await this.fs.list(dir)).sort((a, b) => compareCodePoints(a.name, b.name)), dir, loaded);
    const metaName = kind === 'collection' ? COLLECTION_FILE : FOLDER_FILE;
    const metaPath = joinPath(dir, metaName);
    let container: Container = newContainer('', slug);
    let extra: YMap = new Map();
    let findings: Finding[] = [];
    let implicit = true;
    if (entries.some(entry => entry.kind === 'file' && entry.name === metaName)) {
      const text = await this.readText(metaPath, loaded);
      if (text === undefined) return undefined;
      const result = readContainer(text, kind);
      if (!result.ok) {
        loaded.broken.push({ path: metaPath, findings: result.findings, newer: result.newer });
        return undefined;
      }
      findings = [...result.findings];
      container = { ...result.value, vars: await this.withSecrets(metaPath, result.value.vars, findings) };
      extra = result.extra;
      implicit = false;
    } else if (kind === 'collection') {
      loaded.notes.push({ path: dir, message: `no ${COLLECTION_FILE}: not a collection, left out` });
      return undefined;
    } else findings = [{ path: '', message: `no ${FOLDER_FILE} yet: one is written when the folder is first changed`, severity: 'warning' }];

    const children: Child[] = [];
    const requestEntries = entries.filter(entry => entry.kind === 'file' && isRequestFile(entry.name));
    const requests = await mapLimit(requestEntries, STORAGE_LIMITS.parallelReads, entry => this.loadRequest(joinPath(dir, entry.name), entry.name.slice(0, -REQUEST_SUFFIX.length), loaded, budget));
    for (const node of requests) if (node !== undefined) children.push(node);
    for (const entry of entries) {
      if (entry.kind === 'dir') {
        const sub = await this.loadContainer(joinPath(dir, entry.name), 'folder', depth + 1, loaded, budget);
        if (sub !== undefined) children.push(sub);
      } else if (entry.kind === 'other') loaded.notes.push({ path: joinPath(dir, entry.name), message: 'not a plain file or folder (a link or a special file): left out' });
    }
    if (implicit && children.length === 0) return undefined;
    return { kind, path: dir, slug, container, extra, findings, children: this.ordered(children, container.order), implicit };
  }

  private async loadRequest(path: string, slug: string, loaded: Loaded, budget: { nodes: number }): Promise<RequestNode | undefined> {
    if (++budget.nodes > STORAGE_LIMITS.maxNodes) {
      if (!loaded.truncated) loaded.notes.push({ path, message: `more than ${STORAGE_LIMITS.maxNodes} requests: the rest were left out` });
      loaded.truncated = true;
      return undefined;
    }
    const text = await this.readText(path, loaded);
    if (text === undefined) return undefined;
    const result = readRequest(text);
    if (!result.ok) {
      loaded.broken.push({ path, findings: result.findings, newer: result.newer });
      return undefined;
    }
    return { kind: 'request', path, slug, request: result.value, extra: result.extra, findings: result.findings };
  }

  /** The nodes in the order of the list (names that are not there are skipped), then the rest: folders, then requests, each by name. */
  private ordered<T extends { slug: string; kind: string }>(nodes: T[], order: readonly string[]): T[] {
    const name = (node: T): string => {
      const any = node as unknown as { container?: Container; request?: Request };
      return any.container?.name ?? any.request?.name ?? node.slug;
    };
    const rest = [...nodes].sort((a, b) => (a.kind === 'request' ? 1 : 0) - (b.kind === 'request' ? 1 : 0) || byName({ name: name(a) }, { name: name(b) }));
    const bySlug = new Map(nodes.map(node => [node.slug, node]));
    const first: T[] = [];
    const placed = new Set<string>();
    for (const slug of order) {
      const node = bySlug.get(slug);
      if (node !== undefined && !placed.has(slug)) { first.push(node); placed.add(slug); }
    }
    return [...first, ...rest.filter(node => !placed.has(node.slug))];
  }

  // ---- writing ----

  private async ensureWorkspace(): Promise<void> {
    const gitignorePath = this.at('.gitignore');
    const current = await this.fs.read(gitignorePath);
    const change = ensureIgnored(current, GITIGNORE_LINES);
    if (change.change !== 'present') await this.fs.write(gitignorePath, change.text);
  }

  private async writeLocal(path: string, secrets: Record<string, string>): Promise<void> {
    const local = localPathOf(path);
    if (Object.keys(secrets).length === 0) { await this.fs.remove(local); return; }
    await this.ensureWorkspace();
    await this.fs.write(local, writeLocalValues(secrets), LOCAL_FILE_MODE);
  }

  /** A slug for `name` that no entry of the folder uses (ignoring letter case); `own` is a slug that may be reused because it is the one being replaced. */
  private async freeSlug(dir: string, name: string, own?: string): Promise<string> {
    const taken = (await this.fs.list(dir)).map(entry => entry.name);
    const mine = own === undefined ? [] : [own, `${own}${REQUEST_SUFFIX}`].map(item => item.toLowerCase());
    const reserved = taken.filter(entry => !mine.includes(entry.toLowerCase()));
    const result = uniqueSlugs([kebab(name)], LIMITS.maxSlugChars, reserved, slug => [slug, `${slug}${REQUEST_SUFFIX}`]);
    return (result[0] as { slug: string }).slug;
  }

  private async saveContainerFile(dir: string, kind: 'collection' | 'folder', container: Container, extra: YMap | undefined): Promise<void> {
    const path = joinPath(dir, kind === 'collection' ? COLLECTION_FILE : FOLDER_FILE);
    const { shared, secrets } = splitSecrets(container.vars);
    await this.fs.write(path, writeContainer({ ...container, vars: shared }, extra));
    await this.writeLocal(path, secrets);
  }

  /** The container file of a folder, read again from disk so that a change made by hand in between is not lost. */
  private async readContainerFile(dir: string, kind: 'collection' | 'folder'): Promise<{ container: Container; extra: YMap }> {
    const path = joinPath(dir, kind === 'collection' ? COLLECTION_FILE : FOLDER_FILE);
    const text = await this.fs.read(path);
    if (text === undefined) return { container: { ...newContainer(newId(this.clock), baseName(dir)) }, extra: new Map() };
    const result = readContainer(text, kind);
    if (!result.ok) throw new StoreError(`${path} cannot be used: ${result.findings[0]?.message ?? 'unreadable'}`);
    const findings: Finding[] = [];
    return { container: { ...result.value, vars: await this.withSecrets(path, result.value.vars, findings) }, extra: result.extra };
  }

  private kindOfDir(dir: string): 'collection' | 'folder' {
    return parentPath(dir) === this.at(COLLECTIONS) ? 'collection' : 'folder';
  }

  async createCollection(name: string): Promise<ContainerNode> {
    await this.ensureWorkspace();
    if (await this.fs.read(this.at(WORKSPACE_FILE)) === undefined) await this.fs.write(this.at(WORKSPACE_FILE), writeWorkspace(newWorkspaceFile()));
    const slug = await this.freeSlug(this.at(COLLECTIONS), name);
    const dir = this.at(COLLECTIONS, slug);
    const container = newContainer(newId(this.clock), name);
    await this.saveContainerFile(dir, 'collection', container, undefined);
    return { kind: 'collection', path: dir, slug, container, extra: new Map(), findings: [], children: [], implicit: false };
  }

  async createFolder(parentDir: string, name: string): Promise<ContainerNode> {
    const slug = await this.freeSlug(parentDir, name);
    const dir = joinPath(parentDir, slug);
    const container = newContainer(newId(this.clock), name);
    await this.saveContainerFile(dir, 'folder', container, undefined);
    return { kind: 'folder', path: dir, slug, container, extra: new Map(), findings: [], children: [], implicit: false };
  }

  async createRequest(parentDir: string, name: string, init: Partial<Request> = {}): Promise<RequestNode> {
    const slug = await this.freeSlug(parentDir, name);
    const path = joinPath(parentDir, `${slug}${REQUEST_SUFFIX}`);
    const request: Request = { ...newRequest(newId(this.clock), name), ...init, name };
    request.id = init.id !== undefined && init.id !== '' ? init.id : newId(this.clock);
    await this.fs.write(path, writeRequest(request));
    return { kind: 'request', path, slug, request, extra: new Map(), findings: [] };
  }

  /** Writes a request. When its name changed, the file is renamed to match (the identifier and the position in the folder stay). */
  async saveRequest(node: RequestNode, request: Request): Promise<RequestNode> {
    const next: Request = { ...request, id: request.id !== '' ? request.id : node.request.id !== '' ? node.request.id : newId(this.clock) };
    const dir = parentPath(node.path);
    const renamed = next.name !== node.request.name;
    const slug = renamed ? await this.freeSlug(dir, next.name, node.slug) : node.slug;
    const path = joinPath(dir, `${slug}${REQUEST_SUFFIX}`);
    await this.fs.write(path, writeRequest(next, node.extra));
    if (path !== node.path) {
      await this.fs.remove(node.path);
      await this.replaceInOrder(dir, node.slug, slug);
    }
    return { ...node, path, slug, request: next };
  }

  /** Renames a collection or folder: its name inside `folder.yml` or `collection.yml` and, when the slug changes, its folder. */
  async renameContainer(node: ContainerNode, name: string): Promise<ContainerNode> {
    const { container } = await this.readContainerFile(node.path, node.kind);
    return this.saveContainer(node, { ...container, name });
  }

  /** Writes a collection or folder; a new name also moves its folder to the matching slug. */
  async saveContainer(node: ContainerNode, container: Container): Promise<ContainerNode> {
    const parent = parentPath(node.path);
    const next: Container = { ...container, id: container.id !== '' ? container.id : node.container.id !== '' ? node.container.id : newId(this.clock) };
    const slug = next.name !== node.container.name || node.implicit ? await this.freeSlug(parent, next.name, node.slug) : node.slug;
    await this.saveContainerFile(node.path, node.kind, next, node.extra);
    let path = node.path;
    if (slug !== node.slug) {
      path = joinPath(parent, slug);
      await this.fs.rename(node.path, path);
      if (node.kind === 'folder') await this.replaceInOrder(parent, node.slug, slug);
    }
    return { ...node, path, slug, container: next, implicit: false, children: node.children.map(child => this.reparent(child, node.path, path)) };
  }

  private reparent<T extends Child>(child: T, from: string, to: string): T {
    const path = to + child.path.slice(from.length);
    if (child.kind === 'request') return { ...child, path };
    return { ...child, path, children: child.children.map(grandchild => this.reparent(grandchild, from, to)) };
  }

  /** Moves a request or a folder into another folder or collection, giving it a free name there. */
  async move(node: Child, targetDir: string): Promise<Child> {
    if (node.kind === 'collection') throw new StoreError('A collection cannot be moved into another one.');
    if (node.kind === 'folder' && (targetDir === node.path || targetDir.startsWith(`${node.path}/`))) throw new StoreError('A folder cannot be moved into itself.');
    const from = parentPath(node.path);
    if (from === targetDir) return node;
    const name = node.kind === 'request' ? node.request.name : node.container.name;
    const slug = await this.freeSlug(targetDir, name);
    const path = node.kind === 'request' ? joinPath(targetDir, `${slug}${REQUEST_SUFFIX}`) : joinPath(targetDir, slug);
    await this.fs.rename(node.path, path);
    await this.removeFromOrder(from, node.slug);
    return node.kind === 'request' ? { ...node, path, slug } : { ...this.reparent(node, node.path, path), path, slug };
  }

  /** A copy with new identifiers, next to the original. */
  async duplicate(node: Child): Promise<Child> {
    const parent = parentPath(node.path);
    if (node.kind === 'request') return this.createRequest(parent, `${node.request.name} copy`, { ...node.request, id: '' });
    const name = `${node.container.name} copy`;
    const copy = node.kind === 'collection' ? await this.createCollection(name) : await this.createFolder(parent, name);
    const { container } = await this.readContainerFile(node.path, node.kind);
    const written = { ...container, id: copy.container.id, name: copy.container.name };
    await this.saveContainerFile(copy.path, copy.kind, written, undefined);
    for (const child of node.children) await this.copyInto(child, copy.path);
    return { ...copy, container: written };
  }

  private async copyInto(child: Child, dir: string): Promise<void> {
    if (child.kind === 'request') {
      await this.createRequest(dir, child.request.name, { ...child.request, id: '' });
      return;
    }
    const folder = await this.createFolder(dir, child.container.name);
    const { container } = await this.readContainerFile(child.path, 'folder');
    await this.saveContainerFile(folder.path, 'folder', { ...container, id: folder.container.id }, undefined);
    for (const grandchild of child.children) await this.copyInto(grandchild, folder.path);
  }

  /** Removes a request, a folder, a collection or an environment (with the file of its secrets). */
  async remove(node: Child | EnvironmentNode): Promise<void> {
    await this.fs.remove(node.path);
    if (node.kind === 'environment') await this.fs.remove(localPathOf(node.path));
    else if (node.kind !== 'collection') await this.removeFromOrder(parentPath(node.path), node.slug);
  }

  /** Writes the order of the entries of a folder or collection. */
  async reorder(dir: string, slugs: readonly string[]): Promise<void> {
    await this.updateOrder(dir, () => [...slugs]);
  }

  private async updateOrder(dir: string, change: (order: string[]) => string[]): Promise<void> {
    const kind = this.kindOfDir(dir);
    if (kind === 'collection' || await this.fs.exists(joinPath(dir, FOLDER_FILE))) {
      const { container, extra } = await this.readContainerFile(dir, kind);
      const order = change([...container.order]);
      if (order.join('\n') !== container.order.join('\n')) await this.saveContainerFile(dir, kind, { ...container, order }, extra);
    } else {
      const order = change([]);
      if (order.length > 0) await this.saveContainerFile(dir, 'folder', { ...newContainer(newId(this.clock), baseName(dir)), order }, undefined);
    }
  }

  private async replaceInOrder(dir: string, from: string, to: string): Promise<void> {
    if (!(await this.fs.exists(joinPath(dir, this.kindOfDir(dir) === 'collection' ? COLLECTION_FILE : FOLDER_FILE)))) return;
    await this.updateOrder(dir, order => order.map(slug => (slug === from ? to : slug)));
  }

  private async removeFromOrder(dir: string, slug: string): Promise<void> {
    if (!(await this.fs.exists(joinPath(dir, this.kindOfDir(dir) === 'collection' ? COLLECTION_FILE : FOLDER_FILE)))) return;
    await this.updateOrder(dir, order => order.filter(item => item !== slug));
  }

  // ---- environments and the workspace file ----

  async createEnvironment(name: string): Promise<EnvironmentNode> {
    await this.ensureWorkspace();
    const slug = await this.freeEnvironmentSlug(name);
    const environment = newEnvironment(newId(this.clock), name);
    const path = this.at(ENVIRONMENTS, `${slug}${ENVIRONMENT_SUFFIX}`);
    await this.fs.write(path, writeEnvironment(environment));
    return { kind: 'environment', path, slug, environment, extra: new Map(), findings: [] };
  }

  private async freeEnvironmentSlug(name: string, own?: string): Promise<string> {
    const taken = (await this.fs.list(this.at(ENVIRONMENTS))).map(entry => entry.name);
    const mine = own === undefined ? [] : [`${own}${ENVIRONMENT_SUFFIX}`.toLowerCase(), `${own}.env.local.yml`.toLowerCase()];
    const reserved = taken.filter(entry => !mine.includes(entry.toLowerCase()));
    return (uniqueSlugs([kebab(name)], LIMITS.maxSlugChars, reserved, slug => [`${slug}${ENVIRONMENT_SUFFIX}`, `${slug}.env.local.yml`])[0] as { slug: string }).slug;
  }

  /** Writes an environment: the values of its secret variables go to the file that Git ignores. A new name moves the files. */
  async saveEnvironment(node: EnvironmentNode, environment: Environment): Promise<EnvironmentNode> {
    const next: Environment = { ...environment, id: environment.id !== '' ? environment.id : node.environment.id !== '' ? node.environment.id : newId(this.clock) };
    const renamed = next.name !== node.environment.name;
    const slug = renamed ? await this.freeEnvironmentSlug(next.name, node.slug) : node.slug;
    const path = this.at(ENVIRONMENTS, `${slug}${ENVIRONMENT_SUFFIX}`);
    const { shared, secrets } = splitSecrets(next.vars);
    await this.fs.write(path, writeEnvironment({ ...next, vars: shared }, node.extra));
    await this.writeLocal(path, secrets);
    if (path !== node.path) {
      await this.fs.remove(node.path);
      await this.fs.remove(localPathOf(node.path));
    }
    return { ...node, path, slug, environment: next };
  }

  async saveWorkspace(node: WorkspaceNode, file: WorkspaceFile): Promise<WorkspaceNode> {
    const { shared, secrets } = splitSecrets(file.vars);
    await this.ensureWorkspace();
    await this.fs.write(node.path, writeWorkspace({ ...file, vars: shared }, node.extra));
    await this.writeLocal(node.path, secrets);
    return { ...node, file };
  }
}

