import type { TcEnvironment, TcExportEnvironment } from '../model/source';
import type { TcSource } from '../pipeline';
import { canonicalJson } from '../util/canonical';
import { compareCodePoints } from '../util/chars';
import { asArray, isRecord, str } from './guards';
import { compareOrderFields } from './order';
import type { TreeEnvironment } from './tree';

/**
 * N5 for environments: the environments of a source in order, whichever kind of file they came from. What is inside an
 * environment (N13, N14) is for a later rule.
 */
export function arrangeEnvironments(source: TcSource): TreeEnvironment[] {
  const environments: TreeEnvironment[] = [];
  for (const file of source.files) {
    if (file.kind === 'v4-environment' && isRecord(file.json)) {
      environments.push({ origin: file.origin, kind: 'v4', name: str(file.json['name']), source: file.json as TcEnvironment });
    } else if (file.kind === 'export-environment' && isRecord(file.json)) {
      environments.push({ origin: file.origin, kind: 'export', name: str(file.json['environmentName']), source: file.json as TcExportEnvironment });
    } else if (file.kind === 'v3-environments') {
      for (const item of asArray(file.json)) {
        if (isRecord(item)) environments.push({ origin: file.origin, kind: 'v3', name: str(item['name']), source: item as TcEnvironment });
      }
    }
  }
  const keys = (environment: TreeEnvironment) => {
    const raw = environment.source as Record<string, unknown>;
    return { sortNum: raw['sortNum'], created: raw['created'], name: environment.name, id: raw['_id'] };
  };
  return environments.sort((a, b) => compareOrderFields(keys(a), keys(b))
    || compareCodePoints(a.origin, b.origin)
    || compareCodePoints(canonicalJson(a.source), canonicalJson(b.source)));
}
