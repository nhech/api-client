import type { ImpEnvironment, ImpVariable } from '../model/ir';
import { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import type { FindingSink } from '../normalize/sink';
import type { TreeEnvironment } from '../normalize/tree';
import { displayLabel } from '../util/chars';
import { neutralizeExpressions } from './expressions';
import { SECRET_VARIABLE } from './secrets';
import { hasLiteral } from './text';

/**
 * Environments (spec N13, N14, 6.5, 8.3, 8.4).
 *
 *  - the flags decide the kind: `global` without `local` is shared by all, `global` with `local` is private to this machine
 *    and always goes to the private file, anything else is a named environment;
 *  - a variable listed twice keeps the last value (TC-ENV-DUP); a disabled one is dropped;
 *  - an encrypted value is never decrypted: the variable is kept with no value, to be typed in again (TC-ENV-ENCRYPTED);
 *  - a variable of a shared or named environment whose name says it is a secret, and whose value is a literal, is marked a
 *    secret: with `moveSecrets` it goes to the private file (TC-SECRET-MOVED), without it it stays and is reported
 *    (TC-SECRET-LITERAL);
 *  - a dotenv file named by the environment is not read (TC-ENV-FILE).
 */
export interface EnvironmentConversion {
  environments: ImpEnvironment[];
  secretsMoved: number;
  variablesToReenter: number;
}

export function convertEnvironments(sources: readonly TreeEnvironment[], moveSecrets: boolean, sink: FindingSink): EnvironmentConversion {
  const environments: ImpEnvironment[] = [];
  let secretsMoved = 0;
  let variablesToReenter = 0;

  for (const env of sources) {
    const raw = env.source as Record<string, unknown>;
    const coerce = new Coercions();
    const label = displayLabel(env.name);
    const scope = `Environment ${label}`;
    const kind = env.kind === 'export' ? 'named' : raw['global'] === true && raw['local'] === true ? 'private' : raw['global'] === true ? 'shared' : 'named';
    const items = Array.isArray(env.kind === 'export' ? raw['variables'] : raw['data']) ? (env.kind === 'export' ? raw['variables'] : raw['data']) as unknown[] : [];

    const variables = new Map<string, ImpVariable>();
    let duplicates = 0;
    let encrypted = 0;
    let moved = 0;
    let literals = 0;
    let neutralized = 0;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const name = coerce.string(item['name']);
      if (name === '' || item['isDisabled'] === true) continue;
      const isEncrypted = item['encrypted'] === true;
      const safe = neutralizeExpressions(isEncrypted ? '' : coerce.string(item['value']));
      neutralized += safe.count;
      const value = safe.text;
      const looksSecret = SECRET_VARIABLE.test(name) && hasLiteral(value);
      let secret = isEncrypted || kind === 'private';
      if (kind !== 'private' && looksSecret) {
        if (moveSecrets) { secret = true; moved++; } else literals++;
      }
      if (isEncrypted) encrypted++;
      if (variables.has(name)) { duplicates++; variables.delete(name); }
      variables.set(name, { name, value, secret, needsReentry: isEncrypted });
    }

    if (duplicates > 0) sink.add(scope, 'TC-ENV-DUP', scope, `${duplicates} variable ${duplicates === 1 ? 'name was' : 'names were'} repeated; the last value of each was kept.`);
    if (encrypted > 0) sink.add(scope, 'TC-ENV-ENCRYPTED', scope, `${encrypted} encrypted ${encrypted === 1 ? 'variable was' : 'variables were'} not decrypted; type ${encrypted === 1 ? 'its value' : 'their values'} in again in the private file.`);
    if (moved > 0) sink.add(scope, 'TC-SECRET-MOVED', scope, `${moved} secret-looking ${moved === 1 ? 'variable was' : 'variables were'} moved to the private environment file.`);
    if (literals > 0) sink.add(scope, 'TC-SECRET-LITERAL', scope, `${literals} secret-looking ${literals === 1 ? 'variable stays' : 'variables stay'} in the shared environment file.`);
    if (typeof raw['envFile'] === 'string' && raw['envFile'] !== '') sink.add(scope, 'TC-ENV-FILE', scope, 'The environment refers to a dotenv file, which is not read.');
    if (neutralized > 0) sink.add(scope, 'TC-EXPRESSION-NEUTRALIZED', scope, `${neutralized} ${neutralized === 1 ? 'value has' : 'values have'} text between {{ }} that looked like code or a path, not a variable name; the braces were separated so that no tool runs or reads it.`);
    if (coerce.count > 0) sink.add(scope, 'TC-VALUE-COERCED', scope, `${coerce.count} values of the wrong type were converted.`);

    secretsMoved += moved;
    variablesToReenter += encrypted;
    environments.push({
      name: env.name === '' ? 'Environment' : env.name,
      kind,
      isDefault: raw['default'] === true,
      variables: [...variables.values()],
      ...(typeof raw['envFile'] === 'string' && raw['envFile'] !== '' ? { envFile: raw['envFile'] } : {})
    });
  }
  return { environments, secretsMoved, variablesToReenter };
}
