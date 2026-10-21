import type { ImpEnvironment } from '../model/ir';
import type { OutputFile } from '../pipeline';
import type { FindingSink } from '../normalize/sink';
import { compareCodePoints, displayLabel } from '../util/chars';
import { uniqueNames } from './names';

/**
 * The environment files (spec 6.5, 8.3): `http-client.env.json` for what may be shared and `http-client.private.env.json` for
 * what may not, both of the form `{ "<environment>": { "<variable>": "<value>" } }`, keys in code point order.
 *
 * No `$shared` key: the variables shared by all environments are copied into each named one, which works in every tool. With no
 * named environment there is one called `default`. What is private (the environments of this machine, the secrets the importer
 * moved, the variables marked secret, the encrypted ones with no value) goes to the private file under every environment.
 */
export const PUBLIC_ENV_FILE = 'http-client.env.json';
export const PRIVATE_ENV_FILE = 'http-client.private.env.json';

/**
 * REST Client does not read the files above: its variables come from the setting `rest-client.environmentVariables` of VS Code.
 * For that tool the same variables are also written as the content of that setting, in two files with the same split as above:
 * the shareable one to paste into `.vscode/settings.json`, the private one (kept out of Git) for the user's own settings.
 */
export const REST_CLIENT_SETTINGS_FILE = 'rest-client.settings.json';
export const REST_CLIENT_PRIVATE_SETTINGS_FILE = 'rest-client.private.settings.json';
const REST_CLIENT_SETTING = 'rest-client.environmentVariables';

export interface EnvironmentFiles {
  files: OutputFile[];
  /** The environments in the output, for the report. */
  keys: { name: string; isDefault: boolean; variables: number; privateVariables: number }[];
}

const byName = ([a]: [string, string], [b]: [string, string]): number => compareCodePoints(a, b);
const sortedObject = (environments: Map<string, Map<string, string>>): Record<string, Record<string, string>> =>
  Object.fromEntries([...environments].sort(([a], [b]) => compareCodePoints(a, b)).map(([key, variables]) => [key, Object.fromEntries([...variables].sort(byName))]));
const toJson = (environments: Map<string, Map<string, string>>): string => `${JSON.stringify(sortedObject(environments), null, 2)}\n`;

/** `$shared` is the key REST Client keeps for the variables of every environment; an environment of that name must not take it. */
const restClientKey = (key: string): string => (key === '$shared' ? '$shared-2' : key);

const toSettings = (environments: Map<string, Map<string, string>>): string => {
  const renamed = new Map([...environments].map(([key, variables]) => [restClientKey(key), variables] as const));
  // The same object that toJson writes, nested one level: no text is parsed back (that copied the whole content again).
  return `${JSON.stringify({ [REST_CLIENT_SETTING]: sortedObject(renamed) }, null, 2)}\n`;
};

/** About how many bytes a list of variables takes in a JSON file: name, value, quotes, colon, comma, indent. */
const variableBytes = (variables: readonly { name: string; value: string }[]): number => variables.reduce((sum, variable) => sum + variable.name.length + variable.value.length + 10, 0);

export function renderEnvironments(environments: readonly ImpEnvironment[], sink: FindingSink, options: { restClient?: boolean; maxBytes?: number } = {}): EnvironmentFiles {
  const named = environments.filter(environment => environment.kind === 'named');
  const shared = environments.filter(environment => environment.kind === 'shared');
  const privates = environments.filter(environment => environment.kind === 'private');
  if (named.length === 0 && shared.length === 0 && privates.length === 0) return { files: [], keys: [] };

  const sources: { key: string; environment: ImpEnvironment | undefined }[] = [];
  if (named.length === 0) sources.push({ key: 'default', environment: undefined });
  else {
    const keys = uniqueNames(named.map(environment => environment.name));
    named.forEach((environment, index) => {
      const unique = keys[index];
      if (unique === undefined) return;
      if (unique.collided) sink.add('Environments', 'TC-NAME-COLLISION', `Environment ${displayLabel(environment.name)}`, 'Two environments have the same name; this one was renamed.');
      sources.push({ key: unique.name, environment });
    });
  }

  // The shared variables are copied into every named environment, so a small input can ask for a huge output (800 environments and one list
  // of 10,000 shared variables: 1 MB in, 160 MB out and 3 GB of memory). The size is estimated before anything is built, not after.
  if (options.maxBytes !== undefined) {
    const common = shared.reduce((sum, environment) => sum + variableBytes(environment.variables), 0) + privates.reduce((sum, environment) => sum + variableBytes(environment.variables), 0);
    const own = named.reduce((sum, environment) => sum + variableBytes(environment.variables), 0);
    const estimate = (common * sources.length + own) * (options.restClient === true ? 2 : 1);
    if (estimate > options.maxBytes) {
      sink.add('Output', 'TC-TOO-LARGE', 'Output', `The environment files were not written: with the shared variables copied into each of ${sources.length} environments they would go over the output limit.`);
      return { files: [], keys: [] };
    }
  }

  const publicFile = new Map<string, Map<string, string>>();
  const privateFile = new Map<string, Map<string, string>>();
  const keys: EnvironmentFiles['keys'] = [];
  for (const { key, environment } of sources) {
    const open = new Map<string, string>();
    const closed = new Map<string, string>();
    const put = (variable: { name: string; value: string; secret: boolean }): void => {
      if (variable.secret) { closed.set(variable.name, variable.value); open.delete(variable.name); }
      else { open.set(variable.name, variable.value); closed.delete(variable.name); }
    };
    for (const env of shared) for (const variable of env.variables) put(variable);
    for (const env of privates) for (const variable of env.variables) closed.set(variable.name, variable.value);
    if (environment !== undefined) for (const variable of environment.variables) put(variable);
    publicFile.set(key, open);
    if (closed.size > 0) privateFile.set(key, closed);
    keys.push({ name: key, isDefault: environment?.isDefault ?? false, variables: open.size, privateVariables: closed.size });
  }

  const files: OutputFile[] = [{ path: PUBLIC_ENV_FILE, content: toJson(publicFile) }];
  if (privateFile.size > 0) files.push({ path: PRIVATE_ENV_FILE, content: toJson(privateFile), mode: 0o600 });
  if (options.restClient === true) {
    files.push({ path: REST_CLIENT_SETTINGS_FILE, content: toSettings(publicFile) });
    if (privateFile.size > 0) files.push({ path: REST_CLIENT_PRIVATE_SETTINGS_FILE, content: toSettings(privateFile), mode: 0o600 });
  }
  return { files, keys };
}
