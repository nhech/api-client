import type { TcSource } from '../pipeline';
import { canonicalJson } from '../util/canonical';
import { compareCodePoints, displayLabel } from '../util/chars';
import { asArray, asRecords, isRecord, str, strOr, without } from './guards';
import type { JsonRecord } from './guards';
import { compareOrderFields, sortBySourceOrder } from './order';
import type { FindingSink } from './sink';
import type { RawCollection } from './tree';

/** A request with this `colId` is an entry of the request history, not part of any collection. */
const HISTORY = 'history';
const UNSORTED_NAME = 'Unsorted';

/**
 * N7: the collections of a source, each with its folders and requests gathered, before the folders are arranged (N6).
 *
 *  - a v4 file, or an export file, is one collection and owns the requests it holds;
 *  - v3 keeps the requests apart: they are joined to the collections of thunderCollection.json by `colId`, and a request
 *    whose `colId` matches none goes to a collection called "Unsorted" (TC-ORPHAN-REQUEST);
 *  - history entries (`colId` "history") are dropped and counted, once per file (TC-HISTORY-SKIPPED);
 *  - a `colId` that two v3 collections share belongs to the first of them in N5 order;
 *  - the collections come out in N5 order, "Unsorted" last.
 */
export function groupCollections(source: TcSource, sink: FindingSink): RawCollection[] {
  const files = [...source.files].sort((a, b) => compareCodePoints(a.origin, b.origin));
  const whole: RawCollection[] = [];
  const v3: RawCollection[] = [];
  const loose: JsonRecord[] = [];
  const history = new Map<string, number>();
  const skipHistory = (origin: string): void => { history.set(origin, (history.get(origin) ?? 0) + 1); };

  for (const file of files) {
    if (file.kind === 'v4-collection' || file.kind === 'export-collection') {
      if (!isRecord(file.json)) continue;
      const exported = file.kind === 'export-collection';
      const requests = asRecords(file.json['requests']).filter(request => {
        if (request['colId'] !== HISTORY) return true;
        skipHistory(file.origin);
        return false;
      });
      whole.push({
        id: exported ? `export:${file.origin}` : strOr(file.json['_id'], file.origin),
        name: str(file.json[exported ? 'collectionName' : 'colName']),
        origin: file.origin,
        kind: exported ? 'export' : 'v4',
        header: without(file.json, ['requests', 'folders']),
        settings: file.json['settings'],
        folders: asArray(file.json['folders']),
        requests,
        ignoreContainerIds: false
      });
    } else if (file.kind === 'v3-collections') {
      asArray(file.json).forEach((item, index) => {
        if (!isRecord(item)) return;
        v3.push({
          id: strOr(item['_id'], `${file.origin}#${index}`), name: str(item['colName']), origin: file.origin, kind: 'v3',
          header: without(item, ['requests', 'folders']), settings: item['settings'], folders: asArray(item['folders']), requests: [], ignoreContainerIds: false
        });
      });
    } else if (file.kind === 'v3-requests') {
      for (const request of asRecords(file.json)) {
        if (request['colId'] === HISTORY) skipHistory(file.origin);
        else loose.push(request);
      }
    }
  }

  const sortedV3 = sortRaw(v3);
  const owner = new Map<string, RawCollection>();
  for (const collection of sortedV3) if (!owner.has(collection.id)) owner.set(collection.id, collection);
  const orphans: JsonRecord[] = [];
  for (const request of loose) {
    const colId = request['colId'];
    const target = typeof colId === 'string' && colId !== '' ? owner.get(colId) : undefined;
    if (target === undefined) orphans.push(request);
    else target.requests.push(request);
  }

  for (const [origin, count] of history) sink.add(origin, 'TC-HISTORY-SKIPPED', origin, `${count} history ${count === 1 ? 'entry was' : 'entries were'} skipped.`);

  const collections = sortRaw([...whole, ...sortedV3]);
  if (orphans.length > 0) {
    for (const request of sortBySourceOrder(orphans, 'name')) sink.add(UNSORTED_NAME, 'TC-ORPHAN-REQUEST', `${UNSORTED_NAME} / ${displayLabel(request['name'])}`, `A request belonged to no known collection and was moved to "${UNSORTED_NAME}".`);
    collections.push({ id: '', name: UNSORTED_NAME, origin: '', kind: 'unsorted', header: {}, settings: undefined, folders: [], requests: orphans, ignoreContainerIds: true });
  }
  return collections;
}

/** N5 for collections: the keys of the header, then where they came from, then the header itself. */
function sortRaw(collections: readonly RawCollection[]): RawCollection[] {
  return [...collections].sort((a, b) => compareOrderFields({ sortNum: a.header['sortNum'], created: a.header['created'], name: a.name, id: a.id }, { sortNum: b.header['sortNum'], created: b.header['created'], name: b.name, id: b.id })
    || compareCodePoints(a.origin, b.origin)
    || compareCodePoints(canonicalJson(a.header), canonicalJson(b.header)));
}
