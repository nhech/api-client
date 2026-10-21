import type { Finding } from '../model/findings';
import type { ImpContainer, ImportModel } from '../model/ir';
import { DEFAULT_TARGET } from '../model/target';
import type { Target } from '../model/target';
import { FindingSink } from '../normalize/sink';
import type { OutputFile } from '../pipeline';
import { LIMITS } from '../reader/limits';
import { displayLabel } from '../util/chars';
import { utf8Length } from '../util/size';
import { PRIVATE_ENV_FILE, PUBLIC_ENV_FILE, renderEnvironments } from './env';
import type { EnvironmentFiles } from './env';
import { comment, lines, renderRequest } from './http';
import { uniqueIdentifiers, uniqueSlugs } from './names';

/**
 * From the intermediate model to the files (spec 6): one folder per collection, one `.http` file per folder that has requests,
 * the environment files, and the bodies that cannot stay inside a `.http` file. Pure: it returns the files, the caller writes them.
 */
export const REPORT_FILE = 'IMPORT_REPORT.md';
export const BODIES_DIR = '_bodies';
export const INDEX_FILE = 'index.http';

/** Names in the output folder that no collection may take. */
const ROOT_RESERVED = [PUBLIC_ENV_FILE, PRIVATE_ENV_FILE, REPORT_FILE];
/** Names in a collection folder that no sub-folder may take. */
const COLLECTION_RESERVED = [INDEX_FILE, BODIES_DIR];

export interface EmitOptions {
  /** The tool the files are written for; REST Client also gets its environment as settings (see env.ts). Default REST Client. */
  target?: Target;
  /** Everything the emitter produces, in bytes. Defaults to the limit of spec 8.1. */
  maxOutputBytes?: number;
}

export interface EmitCollection { name: string; dir: string; requests: number; folders: number }

export interface EmitResult {
  files: OutputFile[];
  findings: Finding[];
  collections: EmitCollection[];
  environments: EnvironmentFiles['keys'];
  requests: number;
  folders: number;
  externalBodies: number;
  /** The output limit was reached and part of the requests were not written. */
  truncated: boolean;
}

/** Counts bytes against the limit. Once something does not fit, nothing more is accepted, so the output is a clean prefix. */
class OutputBudget {
  used = 0;
  full = false;
  constructor(private readonly max: number) {}

  take(bytes: number): boolean {
    if (this.full || this.used + bytes > this.max) { this.full = true; return false; }
    this.used += bytes;
    return true;
  }
}

interface CollectionWork {
  name: string;
  label: string;
  dir: string;
  bodies: number;
  requests: number;
  folders: number;
}

interface Work {
  container: ImpContainer;
  /** Display names from the collection down to this container, for findings. */
  labels: string[];
  filePath: string;
  /** The folder that holds this container's sub-folders. */
  childDir: string;
  /** Folder levels between the collection folder and the folder of the .http file. */
  depth: number;
  isRoot: boolean;
  collection: CollectionWork;
}

const countRequests = (model: ImportModel): number => {
  let total = 0;
  const stack: ImpContainer[] = model.collections.map(collection => collection.root);
  for (let container = stack.pop(); container !== undefined; container = stack.pop()) {
    total += container.requests.length;
    for (const folder of container.folders) stack.push(folder);
  }
  return total;
};

export function emitHttp(model: ImportModel, options: EmitOptions = {}): EmitResult {
  const sink = new FindingSink();
  const budget = new OutputBudget(options.maxOutputBytes ?? LIMITS.maxOutputBytes);
  const files: OutputFile[] = [];
  const collections: EmitCollection[] = [];
  let written = 0;
  let folders = 0;
  let externalBodies = 0;

  // The environment files come first in the budget: they are small and the requests need them.
  const environments = renderEnvironments(model.environments, sink, { restClient: (options.target ?? DEFAULT_TARGET) === 'rest-client', maxBytes: options.maxOutputBytes ?? LIMITS.maxOutputBytes });
  const environmentFiles: OutputFile[] = [];
  for (const file of environments.files) {
    if (budget.take(utf8Length(file.content) + utf8Length(file.path))) environmentFiles.push(file);
    else sink.add('Output', 'TC-TOO-LARGE', 'Output', `The environment file ${file.path} was not written because the output limit was reached.`);
  }

  const collectionSlugs = uniqueSlugs(model.collections.map(collection => collection.name), LIMITS.maxSlugChars, ROOT_RESERVED);
  const work: CollectionWork[] = [];
  const stacks: Work[][] = [];
  model.collections.forEach((collection, index) => {
    const unique = collectionSlugs[index];
    if (unique === undefined) return;
    const label = displayLabel(collection.name);
    noteName(sink, 'Collection', label, unique);
    const state: CollectionWork = { name: collection.name, label, dir: unique.slug, bodies: 0, requests: 0, folders: 0 };
    work.push(state);
    stacks.push([{ container: collection.root, labels: [label], filePath: `${unique.slug}/${INDEX_FILE}`, childDir: unique.slug, depth: 0, isRoot: true, collection: state }]);
  });

  for (const stack of stacks) {
    for (let current = stack.pop(); current !== undefined && !budget.full; current = stack.pop()) {
      const { container, collection } = current;
      const children = planChildren(current, sink);
      for (let i = children.length - 1; i >= 0; i--) { const child = children[i]; if (child !== undefined) stack.push(child); }
      if (!current.isRoot) { folders++; collection.folders++; }

      const parts: string[] = [];
      if (container.docs !== undefined) parts.push(lines(container.docs).map(comment).join('\n'));
      const identifiers = uniqueIdentifiers(container.requests.map(request => request.name));
      const prefix = current.depth === 0 ? './' : '../'.repeat(current.depth);
      let wroteAny = parts.length > 0;
      for (const [index, request] of container.requests.entries()) {
        const bodies: OutputFile[] = [];
        const rendered = renderRequest(request, identifiers[index] ?? 'request', text => {
          const path = `${collection.dir}/${BODIES_DIR}/body-${String(collection.bodies + bodies.length + 1).padStart(4, '0')}.txt`;
          bodies.push({ path, content: text });
          return `${prefix}${path.slice(collection.dir.length + 1)}`;
        });
        const cost = utf8Length(rendered.text) + 2 + bodies.reduce((sum, body) => sum + utf8Length(body.content) + utf8Length(body.path), 0);
        if (!budget.take(cost)) break;
        parts.push(rendered.text);
        wroteAny = true;
        collection.bodies += bodies.length;
        externalBodies += bodies.length;
        files.push(...bodies);
        written++;
        collection.requests++;
        if (rendered.externalBody) sink.add(collection.label, 'TC-BODY-EXTERNAL', [...current.labels, displayLabel(request.name)].join(' / '));
      }
      if (wroteAny) {
        const content = `${parts.join('\n\n')}\n`;
        files.push({ path: current.filePath, content });
        // The file itself was charged request by request; its path and the separators are small.
        budget.take(utf8Length(current.filePath));
      }
    }
  }

  const total = countRequests(model);
  const truncated = budget.full;
  if (truncated) sink.add('Output', 'TC-TOO-LARGE', 'Output', `The output limit was reached: ${total - written} of ${total} requests were not written.`);

  for (const state of work) collections.push({ name: state.name, dir: state.dir, requests: state.requests, folders: state.folders });
  return { files: [...files, ...environmentFiles], findings: sink.flush(), collections, environments: environments.keys, requests: written, folders, externalBodies, truncated };
}

/** The folders of one container with their file names; reports the names that had to change. */
function planChildren(current: Work, sink: FindingSink): Work[] {
  const children = current.container.folders;
  if (children.length === 0) return [];
  const slugs = uniqueSlugs(children.map(child => child.name), LIMITS.maxSlugChars, current.isRoot ? COLLECTION_RESERVED : [], slug => [slug, `${slug}.http`]);
  const planned: Work[] = [];
  children.forEach((child, index) => {
    const unique = slugs[index];
    if (unique === undefined) return;
    const labels = [...current.labels, displayLabel(child.name)];
    noteName(sink, current.collection.label, labels.join(' / '), unique);
    planned.push({
      container: child,
      labels,
      filePath: `${current.childDir}/${unique.slug}.http`,
      childDir: `${current.childDir}/${unique.slug}`,
      depth: current.isRoot ? 0 : current.depth + 1,
      isRoot: false,
      collection: current.collection
    });
  });
  return planned;
}

function noteName(sink: FindingSink, scope: string, where: string, unique: { slug: string; changed: boolean; collided: boolean }): void {
  if (unique.collided) sink.add(scope, 'TC-NAME-COLLISION', where, `Another name is the same ignoring letter case, so this one is written as "${unique.slug}".`);
  else if (unique.changed) sink.add(scope, 'TC-NAME-SANITIZED', where, `The name is not valid in a file name, so it is written as "${unique.slug}".`);
}
