/**
 * Reading values from parsed JSON that nobody has checked: every field may be missing or of another type, so each
 * read says what it expects and falls back to a safe value.
 */
export type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asRecords = (value: unknown): JsonRecord[] => asArray(value).filter(isRecord);
export const str = (value: unknown): string => (typeof value === 'string' ? value : '');
/** The string, or `fallback` when it is missing or empty. */
export const strOr = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? value : fallback);

/** A copy of a record without some keys. Keys named like prototype members stay plain own keys. */
export function without(record: JsonRecord, keys: readonly string[]): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}
