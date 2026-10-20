import type { ContentKind } from '../pipeline';

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Own keys only: a parsed "__proto__" or "constructor" key must never make a file look like something it is not. */
const has = (object: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/**
 * What a parsed JSON file is, by its content (spec 2.3). Names are never trusted.
 * An array is judged by its first element that is an object; for an element that fits several kinds the order is
 * collections, requests, environments.
 */
export function classifyContent(json: unknown): ContentKind {
  if (Array.isArray(json)) {
    const first = json.find(isObject);
    if (!first) return 'unrecognized';
    if (has(first, 'colName')) return 'v3-collections';
    if (has(first, 'colId') && has(first, 'url')) return 'v3-requests';
    if (has(first, 'name') && has(first, 'data')) return 'v3-environments';
    return 'unrecognized';
  }
  if (isObject(json)) {
    if (has(json, 'colName') && Array.isArray(json['requests'])) return 'v4-collection';
    if (has(json, 'name') && Array.isArray(json['data'])) return 'v4-environment';
    if (has(json, 'collectionName') && Array.isArray(json['requests'])) return 'export-collection';
    if (has(json, 'environmentName') && Array.isArray(json['variables'])) return 'export-environment';
  }
  return 'unrecognized';
}
