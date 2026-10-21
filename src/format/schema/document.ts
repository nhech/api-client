import type { YMap, YValue } from '../yaml';
import { Fields, Reader, type Finding } from './read';

/** The version of the file format that this build writes. Every file starts with `schema: <version>`. */
export const SCHEMA_VERSION = 1;

/** Steps from one version to the next: `migrations[1]` turns a version 1 file into a version 2 file. */
export type Migrations = Record<number, (root: YMap) => YMap>;

/** A file read: its value and the keys the schema does not know (kept so that writing the file back loses nothing), or why it cannot be used. */
export type Decoded<T> =
  | { ok: true; value: T; extra: YMap; findings: Finding[] }
  | { ok: false; newer: boolean; findings: Finding[] };

export interface DecodeOptions {
  migrations?: Migrations;
  /** For tests: the version to migrate to. */
  current?: number;
}

/**
 * Reads the root of a file: checks the version (a newer file is refused so that an older build never rewrites it, an older one
 * is migrated), lets `decode` read the fields, and reports every key it did not read.
 */
export function decodeDocument<T>(root: YValue, decode: (fields: Fields) => T, options: DecodeOptions = {}): Decoded<T> {
  const reader = new Reader();
  const fail = (newer = false): Decoded<T> => ({ ok: false, newer, findings: reader.findings });
  if (!(root instanceof Map)) {
    reader.error('', 'a file holds a mapping of keys to values');
    return fail();
  }
  const current = options.current ?? SCHEMA_VERSION;
  const declared = root.get('schema');
  if (typeof declared !== 'string' || !/^\d{1,6}$/.test(declared)) {
    reader.error('schema', 'the file must start with "schema: <version>"');
    return fail();
  }
  let version = Number(declared);
  if (version > current) {
    reader.error('schema', `written by a newer version of the extension (schema ${version}, this one reads up to ${current}); it is not changed so that nothing is lost`);
    return fail(true);
  }
  if (version < 1) {
    reader.error('schema', 'the schema version starts at 1');
    return fail();
  }
  let map: YMap = root;
  while (version < current) {
    const step = options.migrations?.[version];
    if (step === undefined) {
      reader.error('schema', `no way to read a schema ${version} file`);
      return fail();
    }
    map = new Map(step(map));
    version++;
    map.set('schema', String(version));
  }
  const fields = new Fields(reader, map, '');
  fields.raw('schema');
  const value = decode(fields);
  const extra = fields.rest();
  return reader.failed ? fail() : { ok: true, value, extra, findings: reader.findings };
}
