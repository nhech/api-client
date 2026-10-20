import { compareCodePoints } from './chars';

/**
 * JSON text of a value with the keys of every object in code point order, so two values that mean the same give the same
 * text whatever order their keys were in. Used as the last tie-breaker of an ordering (spec N5), never for output.
 *
 * Values come from JSON.parse, so they are trees; the reader bounds their depth.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
