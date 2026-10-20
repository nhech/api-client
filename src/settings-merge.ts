import type { OutputFile } from './pipeline';
import { REST_CLIENT_PRIVATE_SETTINGS_FILE, REST_CLIENT_SETTINGS_FILE } from './emit/env';

/**
 * Adding the environments of the import to the REST Client setting `rest-client.environmentVariables` that a person already has
 * (spec 6.5). Pure: the VS Code adapter reads the current value of a scope, asks for the merge, and writes the result back through
 * the configuration API (which keeps the comments of settings.json).
 *
 * Nothing the person has is changed: an environment or a variable that is not there is added; one that is there with the same
 * value stays; one that is there with ANOTHER value is kept as it is and named in the result, so that a second import cannot
 * quietly replace what was edited by hand (and two projects cannot overwrite each other in the user settings).
 */
export type EnvMap = Record<string, Record<string, string>>;

export const REST_CLIENT_SETTING = 'rest-client.environmentVariables';

export interface MergeResult {
  merged: EnvMap;
  addedEnvironments: number;
  addedVariables: number;
  /** `environment.variable` of the values that were already set to something else and were kept. Names only, never values. */
  kept: string[];
}

/** Sets an own property, also for a key such as `__proto__` from the data (a plain assignment would change the prototype instead). */
/** Reads an own property only: `merged['__proto__']` would be the prototype of the object, not a key of the data. */
const own = <T>(source: Record<string, T>, key: string): T | undefined => (Object.hasOwn(source, key) ? source[key] : undefined);
const put = <T>(target: Record<string, T>, key: string, value: T): void => { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function mergeEnvironments(existing: unknown, incoming: EnvMap): MergeResult {
  const merged: Record<string, Record<string, string>> = {};
  const current = isObject(existing) ? existing : {};
  // What is there stays exactly as it is (other environments, `$shared`, values of any type), copied so that the input is not changed.
  for (const key of Object.keys(current)) put(merged, key, structuredClone(own(current, key)) as Record<string, string>);
  let addedEnvironments = 0;
  let addedVariables = 0;
  const kept: string[] = [];
  for (const environment of Object.keys(incoming)) {
    const variables = own(incoming, environment) ?? {};
    const present = own(merged, environment);
    if (present === undefined) {
      const copy: Record<string, string> = {};
      for (const name of Object.keys(variables)) put(copy, name, own(variables, name) ?? '');
      put(merged, environment, copy);
      addedEnvironments++;
      addedVariables += Object.keys(variables).length;
      continue;
    }
    if (!isObject(present)) { kept.push(environment); continue; }
    for (const name of Object.keys(variables)) {
      const value = own(variables, name) ?? '';
      if (!Object.hasOwn(present, name)) { put(present, name, value); addedVariables++; }
      else if (own(present, name) !== value) kept.push(`${environment}.${name}`);
    }
  }
  return { merged, addedEnvironments, addedVariables, kept };
}

/** What the import wrote for REST Client, read back from the files (undefined if they are not there or not in the expected form). */
export interface RestClientSettings {
  shareable: EnvMap;
  /** Secrets and the variables of this machine; absent when there are none. */
  secrets: EnvMap | undefined;
}

function parseSettingsFile(content: string): EnvMap | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!isObject(parsed)) return undefined;
  const value = own(parsed, REST_CLIENT_SETTING);
  if (!isObject(value)) return undefined;
  const result: Record<string, Record<string, string>> = {};
  for (const environment of Object.keys(value)) {
    const variables = own(value, environment);
    if (!isObject(variables)) return undefined;
    const copy: Record<string, string> = {};
    for (const name of Object.keys(variables)) {
      const item = own(variables, name);
      if (typeof item !== 'string') return undefined;
      put(copy, name, item);
    }
    put(result, environment, copy);
  }
  return result;
}

export function restClientSettingsFrom(files: readonly OutputFile[]): RestClientSettings | undefined {
  const shareableFile = files.find(file => file.path === REST_CLIENT_SETTINGS_FILE);
  if (shareableFile === undefined) return undefined;
  const shareable = parseSettingsFile(shareableFile.content);
  if (shareable === undefined) return undefined;
  const privateFile = files.find(file => file.path === REST_CLIENT_PRIVATE_SETTINGS_FILE);
  const secrets = privateFile === undefined ? undefined : parseSettingsFile(privateFile.content);
  return { shareable, secrets };
}
