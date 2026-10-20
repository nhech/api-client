import type { ImpCollection, ImpContainer, ImpEnvironment, ImpRequest, ImpSkipped, ImportModel } from '../model/ir';
import { isRecord } from '../normalize/guards';
import { DEFAULT_TARGET } from '../model/target';
import type { Target } from '../model/target';
import { FindingSink } from '../normalize/sink';
import { readText } from '../normalize/text';
import type { SourceTree, TreeCollection, TreeContainer, TreeFolder } from '../normalize/tree';
import { displayLabel } from '../util/chars';
import { convertEnvironments } from './environments';
import { InheritBudget } from './inherit';
import { convertRequest, flushCollection, newState } from './request';
import type { ConvertState } from './request';
import { SecretStore } from './secrets';

export interface ConvertOptions {
  /** Move literal credentials to the private environment file (spec 8.3). */
  moveSecrets: boolean;
  /** The tool the files are written for; default REST Client. */
  target?: Target;
}

interface Shared {
  target: Target;
  sink: FindingSink;
  secrets: SecretStore;
  budget: InheritBudget;
  skipped: ImpSkipped[];
}

/**
 * From the arranged tree to the intermediate model: every request converted (N2 to N4, N8, N9, N15 to N19, sections 5.2 to
 * 5.9), secrets protected (8.3), environments converted (N13, N14). Pure and deterministic.
 */
export function convertTree(tree: SourceTree, options: ConvertOptions): ImportModel {
  const sink = new FindingSink();
  const secrets = new SecretStore(options.moveSecrets);
  const shared: Shared = { target: options.target ?? DEFAULT_TARGET, sink, secrets, budget: new InheritBudget(), skipped: [] };

  const collections = tree.collections.map(collection => convertCollection(collection, shared));
  const converted = convertEnvironments(tree.environments, options.moveSecrets, sink);
  const environments: ImpEnvironment[] = [...converted.environments];
  if (secrets.variables.size > 0) {
    environments.push({ name: 'Imported secrets', kind: 'private', isDefault: false, synthetic: true, variables: [...secrets.variables].map(([name, value]) => ({ name, value, secret: true, needsReentry: false })) });
  }
  return { collections, environments, skipped: shared.skipped, stats: { secretsMoved: secrets.moved + converted.secretsMoved }, findings: sink.flush() };
}

const docsOf = (value: unknown): string | undefined => {
  const text = readText(value).text;
  return text.trim() === '' ? undefined : text;
};

function convertCollection(collection: TreeCollection, shared: Shared): ImpCollection {
  const state = newState(displayLabel(collection.name), { name: collection.name, settings: collection.settings }, shared);
  const docs = docsOf(collection.settings?.docs);
  noteSettings(collection.settings, state.label, state);
  const root = convertContainer(collection, collection.name, docs, state);
  flushCollection(state);
  return { id: collection.id, name: collection.name, ...(docs === undefined ? {} : { docs }), root };
}

function convertContainer(container: TreeContainer, name: string, docs: string | undefined, state: ConvertState): ImpContainer {
  const requests: ImpRequest[] = [];
  for (const item of container.requests) {
    const converted = convertRequest(item, state);
    if (converted !== undefined) requests.push(converted);
  }
  const folders = container.folders.map((folder: TreeFolder) => {
    noteSettings(folder.source.settings, `${state.label} / ${displayLabel(folder.name)}`, state);
    return convertContainer(folder, folder.name, docsOf((folder.source.settings as { docs?: unknown } | undefined)?.docs), state);
  });
  return { name, ...(docs === undefined ? {} : { docs }), requests, folders };
}

/** Settings of a collection or folder that have no equivalent: the linked environment and the run settings (spec 5.9). Names only. */
function noteSettings(settings: unknown, where: string, state: ConvertState): void {
  if (!isRecord(settings)) return;
  const dropped: string[] = [];
  if (typeof settings['envId'] === 'string' && settings['envId'] !== '') dropped.push('envId (linked environment)');
  const run = settings['runOptions'];
  if ((Array.isArray(run) && run.length > 0) || (isRecord(run) && Object.keys(run).length > 0)) dropped.push('runOptions (run settings)');
  if (dropped.length > 0) state.sink.add(state.label, 'TC-SETTINGS-DROPPED', where, `Settings with no equivalent were dropped: ${dropped.join(', ')}.`);
}
