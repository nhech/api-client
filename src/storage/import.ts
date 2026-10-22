import type { Container, Request } from '../core/model';
import { Credentials } from '../importers/credentials';
import { countImported, type Imported, type ImportedCounts, type ImportedFolder } from '../importers/types';
import type { ContainerNode, RequestNode, Store } from './store';

/**
 * What an importer found, written as the files of the client: one collection folder for each collection, with its folders, its requests and the
 * order they came in, and one file for each environment. Everything goes through the store, so the names of the files, the identifiers, the file of
 * secret values next to a collection and the line in `.gitignore` are the ones every other way of making them gives.
 */
export interface ImportWritten {
  counts: ImportedCounts;
  /** The folder of each collection that was written, relative to the workspace folder. */
  collections: { name: string; path: string }[];
  /** The environments that were written, by the name the store gave them and their identifier. */
  environments: { name: string; id: string }[];
}

/** The settings of a collection or a folder as they are saved: the name and the order are the ones the store gave. */
const containerFor = (node: ContainerNode, imported: Container): Container => ({ ...imported, id: node.container.id, name: node.container.name, order: [] });

async function writeFolder(store: Store, node: ContainerNode, folder: ImportedFolder, signal: AbortSignal | undefined): Promise<void> {
  const saved = await store.saveContainer(node, containerFor(node, folder.container));
  const folders: ContainerNode[] = [];
  const requests: RequestNode[] = [];
  for (const child of folder.folders) {
    signal?.throwIfAborted();
    const created = await store.createFolder(saved.path, child.container.name);
    folders.push(created);
    await writeFolder(store, created, child, signal);
  }
  for (const request of folder.requests) {
    signal?.throwIfAborted();
    requests.push(await store.createRequest(saved.path, request.name, request));
  }
  // The order of the source: its folders, then its requests, as they were listed.
  if (folders.length + requests.length > 1) await store.reorder(saved.path, [...folders.map(item => item.slug), ...requests.map(item => item.slug)]);
}

export async function writeImported(store: Store, imported: Imported, signal?: AbortSignal): Promise<ImportWritten> {
  const written: ImportWritten = { counts: countImported(imported), collections: [], environments: [] };
  for (const collection of imported.collections) {
    signal?.throwIfAborted();
    const node = await store.createCollection(collection.container.name);
    await writeFolder(store, node, collection, signal);
    written.collections.push({ name: node.container.name, path: node.path });
  }
  for (const environment of imported.environments) {
    signal?.throwIfAborted();
    const node = await store.createEnvironment(environment.name);
    await store.saveEnvironment(node, { ...node.environment, vars: environment.vars });
    written.environments.push({ name: node.environment.name, id: node.environment.id });
  }
  return written;
}

/**
 * One request, from a cURL command for example, added to a collection or a folder. A credential that is typed in becomes a secret variable of that
 * collection or folder, so that it is not written into the file of the request.
 */
export async function writeRequestInto(store: Store, parent: ContainerNode, request: Request): Promise<{ node: RequestNode; moved: number }> {
  const credentials = new Credentials(parent.container.name, parent.container.vars);
  const safe = credentials.request(request);
  const node = await store.createRequest(parent.path, safe.name, safe);
  const known = new Set(parent.container.vars.map(variable => variable.name));
  const made = credentials.vars().filter(variable => !known.has(variable.name));
  if (made.length > 0) await store.saveContainer(parent, { ...parent.container, vars: [...parent.container.vars, ...made] });
  return { node, moved: credentials.moved };
}
