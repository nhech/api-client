import type { ImpHeader } from '../model/ir';
import type { Coercions } from '../normalize/coerce';
import { isRecord } from '../normalize/guards';
import type { HeaderIn, InheritedHeader } from './inherit';

/**
 * Headers of a request (spec 5.1 N4 and N17, 5.3).
 *
 *  - the headers inherited from the levels above are added after the request's own (N17, done in inherit.ts); an inherited
 *    header that is disabled does nothing, so it is dropped rather than copied as a comment into every request;
 *  - Thunder's own defaults, an `Accept` header with the any-type wildcard and a `User-Agent` that names Thunder Client, are
 *    not the author's: dropped (N4);
 *  - two enabled headers that differ only in letter case are one header in HTTP: the request's own wins (the last of its own
 *    if several), else the nearest inherited one; the rest are dropped and counted (TC-HEADER-DUP). Two with exactly the same
 *    name are left, since sending a header twice can be intended.
 */
export interface HeaderResult {
  headers: ImpHeader[];
  defaultsDropped: number;
  caseDuplicates: number;
  /** Inherited headers that are in the result. */
  inherited: number;
}

/** The headers of the request itself, as read; entries without a name are skipped. */
export function readHeaders(list: unknown, coerce: Coercions): HeaderIn[] {
  const headers: HeaderIn[] = [];
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const name = coerce.string(item['name']).trim();
    if (name === '') continue;
    headers.push({ name, value: coerce.string(item['value']), enabled: !coerce.flag(item['isDisabled']) });
  }
  return headers;
}

interface Entry { header: HeaderIn; inherited: boolean }

const isThunderDefault = (header: HeaderIn): boolean => {
  const name = header.name.toLowerCase();
  return header.enabled && ((name === 'accept' && header.value === '*/*') || (name === 'user-agent' && /thunderclient/i.test(header.value)));
};

export function combineHeaders(own: readonly HeaderIn[], inherited: readonly InheritedHeader[]): HeaderResult {
  let entries: Entry[] = [
    ...own.map(header => ({ header, inherited: false })),
    ...inherited.filter(header => header.enabled).map(header => ({ header: { name: header.name, value: header.value, enabled: true }, inherited: true }))
  ];

  const before = entries.length;
  entries = entries.filter(entry => !isThunderDefault(entry.header));
  const defaultsDropped = before - entries.length;

  // Case-insensitive groups of enabled headers with more than one spelling.
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (!entry.header.enabled) return;
    const key = entry.header.name.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [index]); else group.push(index);
  });
  const dropped = new Set<number>();
  for (const indexes of groups.values()) {
    const spellings = new Set(indexes.map(index => entries[index]?.header.name));
    if (spellings.size < 2) continue;
    const ownIndexes = indexes.filter(index => entries[index]?.inherited === false);
    const winner = ownIndexes.length > 0 ? (ownIndexes[ownIndexes.length - 1] as number) : (indexes[0] as number);
    for (const index of indexes) if (index !== winner) dropped.add(index);
  }
  entries = entries.filter((_, index) => !dropped.has(index));

  return {
    headers: entries.map(entry => ({ name: entry.header.name, value: entry.header.value, enabled: entry.header.enabled, secret: false })),
    defaultsDropped,
    caseDuplicates: dropped.size,
    inherited: entries.filter(entry => entry.inherited).length
  };
}

/** Adds `Content-Type` unless an enabled header of that name is already there (any letter case). */
export function ensureContentType(headers: readonly ImpHeader[], contentType: string): ImpHeader[] {
  if (headers.some(header => header.enabled && header.name.toLowerCase() === 'content-type')) return [...headers];
  return [...headers, { name: 'Content-Type', value: contentType, enabled: true, secret: false }];
}
