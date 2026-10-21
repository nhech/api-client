import type { Var } from '../core/model';
import { Out } from '../format/schema/read';
import { emitYaml, parseYaml, type YMap } from '../format/yaml';

/**
 * The values of secret variables live next to the shared file in a file that Git ignores: `dev.env.yml` has `dev.env.local.yml`,
 * `collection.yml` has `collection.local.yml`. The shared file keeps the name of the variable and an empty value, so a pull
 * shows who has to type theirs in, and a secret never travels with the repository.
 */
export const LOCAL_SUFFIX = '.local.yml';

/** `environments/dev.env.yml` is paired with `environments/dev.env.local.yml`. */
export const localPathOf = (path: string): string => path.replace(/\.yml$/, LOCAL_SUFFIX);

export interface LocalValues {
  values: Record<string, string>;
  /** Why the file could not be read, when it could not. */
  problem?: string;
}

export function readLocalValues(text: string | undefined): LocalValues {
  if (text === undefined) return { values: {} };
  const parsed = parseYaml(text);
  if (!parsed.ok) return { values: {}, problem: `line ${parsed.error.line}: ${parsed.error.message}` };
  const root = parsed.value;
  if (!(root instanceof Map)) return { values: {}, problem: 'expected a mapping' };
  const values = root.get('values');
  if (values === undefined) return { values: {} };
  if (!(values instanceof Map)) return { values: {}, problem: 'values must be a mapping of names to text' };
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of values) if (typeof value === 'string') out[name] = value;
  return { values: out };
}

export function writeLocalValues(values: Record<string, string>): string {
  const map: YMap = new Map();
  for (const name of Object.keys(values).sort()) map.set(name, values[name] ?? '');
  return emitYaml(new Out().put('schema', '1').put('values', map).map);
}

export interface SplitVars {
  /** The variables as they go into the shared file: a secret has no value. */
  shared: Var[];
  /** What goes into the local file. */
  secrets: Record<string, string>;
}

/** Takes the values of the secret variables out of a list, leaving their names. */
export function splitSecrets(vars: readonly Var[]): SplitVars {
  const secrets: Record<string, string> = Object.create(null) as Record<string, string>;
  const shared = vars.map(variable => {
    if (!variable.secret) return variable;
    if (variable.value !== '') secrets[variable.name] = variable.value;
    return { ...variable, value: '' };
  });
  return { shared, secrets };
}

export interface MergedVars {
  vars: Var[];
  /** Secret variables whose value was found in the shared file itself: it is used, and moves out at the next save. */
  leaked: string[];
}

/** Puts the local values back into the secret variables of a file that was just read. */
export function mergeSecrets(vars: readonly Var[], local: Record<string, string>): MergedVars {
  const leaked: string[] = [];
  const merged = vars.map(variable => {
    if (!variable.secret) return variable;
    const own = Object.hasOwn(local, variable.name) ? local[variable.name] : undefined;
    if (own !== undefined) return { ...variable, value: own };
    if (variable.value !== '') leaked.push(variable.name);
    return variable;
  });
  return { vars: merged, leaked };
}
