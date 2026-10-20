import { canonicalJson } from '../util/canonical';
import { compareCodePoints } from '../util/chars';

/**
 * N5: the order of collections, folders, requests and environments. By `sortNum` ascending (missing or not a number counts
 * as 0), then `created`, then name, all by code point and never by locale. The result does not depend on the order of the
 * input: ties beyond those three keys are broken by `_id` and finally by the canonical text of the item itself, so two
 * different items never swap places between runs, and two identical ones are interchangeable.
 */
export interface OrderFields {
  sortNum: unknown;
  created: unknown;
  name: unknown;
  id: unknown;
}

const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The N5 keys alone, for items that need their own last tie-breakers. */
export function compareOrderFields(a: OrderFields, b: OrderFields): number {
  const x = number(a.sortNum);
  const y = number(b.sortNum);
  if (x !== y) return x < y ? -1 : 1;
  return compareCodePoints(text(a.created), text(b.created))
    || compareCodePoints(text(a.name), text(b.name))
    || compareCodePoints(text(a.id), text(b.id));
}

export function orderFieldsOf(item: Record<string, unknown>, nameKey: string): OrderFields {
  return { sortNum: item['sortNum'], created: item['created'], name: item[nameKey], id: item['_id'] };
}

/** A new array in N5 order; the input is left alone. `nameKey` is `name`, or `colName` for a collection. */
export function sortBySourceOrder<T extends object>(items: readonly T[], nameKey = 'name'): T[] {
  return [...items].sort((a, b) => {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    return compareOrderFields(orderFieldsOf(x, nameKey), orderFieldsOf(y, nameKey)) || compareCodePoints(canonicalJson(x), canonicalJson(y));
  });
}
