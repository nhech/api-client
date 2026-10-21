import { isTarget } from '../model/target';
import type { ConflictPolicy } from '../pipeline';
import { MAX_TARGET_DIR_LENGTH } from './types';
import type { ToHost, WizardOptions } from './types';

/**
 * The messages of the panel are read as untrusted: the panel is our code, but what it shows comes from a collection somebody
 * else made, so nothing it sends is taken on trust. A message that is not exactly one of the known shapes is dropped; an option
 * of the wrong type is ignored; no path or file name is ever read from a message (the panel names a suggestion by number, and
 * the extension asks for folders and files with its own dialogs).
 */
const SIMPLE: ReadonlySet<string> = new Set(['ready', 'chooseFolder', 'chooseFiles', 'cancelScan', 'import', 'startOver', 'openReportPreview', 'openFolder', 'openWrittenReport', 'openWorkspace']);
const POLICIES: readonly ConflictPolicy[] = ['new-folder', 'skip-existing', 'overwrite'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

export function parseToHost(raw: unknown): ToHost | undefined {
  if (!isRecord(raw)) return undefined;
  const type = own(raw, 'type');
  if (typeof type !== 'string') return undefined;
  if (SIMPLE.has(type)) return { type } as ToHost;
  if (type === 'useCandidate') {
    const id = own(raw, 'id');
    return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < 1000 ? { type, id } : undefined;
  }
  if (type === 'setOptions') {
    const given = own(raw, 'options');
    if (!isRecord(given)) return undefined;
    const options: Partial<WizardOptions> = {};
    const target = own(given, 'target');
    if (isTarget(target)) options.target = target;
    const policy = own(given, 'policy');
    if (typeof policy === 'string' && (POLICIES as readonly string[]).includes(policy)) options.policy = policy as ConflictPolicy;
    const moveSecrets = own(given, 'moveSecrets');
    if (typeof moveSecrets === 'boolean') options.moveSecrets = moveSecrets;
    const apply = own(given, 'applyRestClientSettings');
    if (typeof apply === 'boolean') options.applyRestClientSettings = apply;
    const targetDir = own(given, 'targetDir');
    if (typeof targetDir === 'string' && targetDir.length <= MAX_TARGET_DIR_LENGTH) options.targetDir = targetDir;
    return Object.keys(options).length === 0 ? undefined : { type, options };
  }
  return undefined;
}
