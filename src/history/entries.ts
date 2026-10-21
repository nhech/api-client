import { isoTime } from '../core/vars';
import { printable } from '../util/chars';

/**
 * The history of what was sent: a list of entries, newest first, kept on this computer by the extension (never in a file of the collection). An entry
 * says what was sent and what came back; with the mode "full" it also holds the headers and the beginning of the two bodies. Everything in it was made
 * safe before it got here (secret values taken out, text made printable), and everything that is read back is checked again, because the file is a
 * file on disk. The list is bounded in number, in age and in size.
 */
export const HISTORY_LIMITS = { entries: 200, ageMs: 30 * 24 * 3600 * 1000, bodyChars: 64 * 1024, headers: 100, totalBytes: 20 * 1024 * 1024, textChars: 2000 } as const;

export interface HistoryDetail {
  requestHeaders: [string, string][];
  requestBody: string;
  responseHeaders: [string, string][];
  responseBody: string;
  /** A body was cut at the limit. */
  cut: boolean;
}

export interface HistoryEntry {
  id: string;
  /** When it was sent, in milliseconds since 1970. */
  at: number;
  /** The name of the request, and its file (relative to the workspace folder). */
  name: string;
  path: string;
  environment: string;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  ms: number;
  size?: number;
  /** Why there was no answer. */
  error?: string;
  detail?: HistoryDetail;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const text = (value: unknown, limit: number): string => (typeof value === 'string' ? printable(value.length > limit ? value.slice(0, limit) : value) : '');
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

function pairs(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return [];
  const list: [string, string][] = [];
  for (const item of value) {
    if (list.length >= HISTORY_LIMITS.headers) break;
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') list.push([text(item[0], 200), text(item[1], HISTORY_LIMITS.textChars)]);
  }
  return list;
}

function readDetail(value: unknown): HistoryDetail | undefined {
  if (!isRecord(value)) return undefined;
  return {
    requestHeaders: pairs(own(value, 'requestHeaders')), requestBody: text(own(value, 'requestBody'), HISTORY_LIMITS.bodyChars),
    responseHeaders: pairs(own(value, 'responseHeaders')), responseBody: text(own(value, 'responseBody'), HISTORY_LIMITS.bodyChars), cut: own(value, 'cut') === true
  };
}

/** Reads what was kept: every entry is checked, one that is not an entry is dropped, and the list is cut to its limits. */
export function readHistory(raw: unknown, now: number): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: HistoryEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = own(item, 'id');
    const at = whole(own(item, 'at'));
    const method = text(own(item, 'method'), 20);
    if (typeof id !== 'string' || !/^[0-9a-z-]{1,40}$/.test(id) || at === undefined || method === '') continue;
    const entry: HistoryEntry = { id, at, name: text(own(item, 'name'), 200), path: text(own(item, 'path'), 500), environment: text(own(item, 'environment'), 100), method, url: text(own(item, 'url'), 4000), ms: whole(own(item, 'ms')) ?? 0 };
    const status = whole(own(item, 'status'));
    if (status !== undefined && status >= 100 && status <= 599) { entry.status = status; entry.statusText = text(own(item, 'statusText'), 100); }
    const size = whole(own(item, 'size'));
    if (size !== undefined) entry.size = size;
    const error = text(own(item, 'error'), 500);
    if (error !== '') entry.error = error;
    const detail = readDetail(own(item, 'detail'));
    if (detail !== undefined) entry.detail = detail;
    entries.push(entry);
  }
  return prune(entries, now);
}

/** Newest first, nothing older than the age limit, and no more than the number limit; the bodies of the oldest go first when the whole is too large. */
export function prune(entries: readonly HistoryEntry[], now: number): HistoryEntry[] {
  const kept = [...entries].filter(entry => now - entry.at <= HISTORY_LIMITS.ageMs).sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, HISTORY_LIMITS.entries);
  let bytes = 0;
  const size = (entry: HistoryEntry): number => (entry.detail === undefined ? 0 : entry.detail.requestBody.length + entry.detail.responseBody.length);
  for (const entry of kept) bytes += size(entry);
  for (let index = kept.length - 1; index >= 0 && bytes > HISTORY_LIMITS.totalBytes; index--) {
    const entry = kept[index] as HistoryEntry;
    bytes -= size(entry);
    const { detail: _dropped, ...rest } = entry;
    void _dropped;
    kept[index] = rest;
  }
  return kept;
}

/** The list with a new entry first. */
export const addEntry = (entries: readonly HistoryEntry[], entry: HistoryEntry, now: number): HistoryEntry[] => prune([entry, ...entries], now);

const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** An entry as a document to read: the request line, how it ended, and, when they were kept, the headers and the bodies. */
export function formatEntry(entry: HistoryEntry): string {
  const lines: string[] = [`${entry.method} ${entry.url}`];
  lines.push(entry.error !== undefined ? `Failed: ${entry.error}` : `Status: ${entry.status ?? ''} ${entry.statusText ?? ''}`.trimEnd());
  lines.push(`Time: ${isoTime(entry.at).replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}, ${Math.round(entry.ms)} ms${entry.size === undefined ? '' : `, ${size(entry.size)}`}`);
  lines.push(`Request: ${entry.name === '' ? '(unnamed)' : entry.name}${entry.path === '' ? '' : ` (${entry.path})`}`);
  if (entry.environment !== '') lines.push(`Environment: ${entry.environment}`);
  const detail = entry.detail;
  if (detail === undefined) {
    lines.push('', 'The headers and the bodies were not kept. They are kept when the setting apiClient.history.mode is "full".');
    return `${lines.join('\n')}\n`;
  }
  const headers = (title: string, list: readonly (readonly [string, string])[]): void => { lines.push('', `--- ${title} ---`, ...(list.length === 0 ? ['(none)'] : list.map(([name, value]) => `${name}: ${value}`))); };
  const body = (title: string, content: string): void => { lines.push('', `--- ${title} ---`, content === '' ? '(empty)' : content); };
  headers('Request headers', detail.requestHeaders);
  body('Request body', detail.requestBody);
  headers('Response headers', detail.responseHeaders);
  body('Response body', detail.responseBody);
  if (detail.cut) lines.push('', 'A body was cut here: the history keeps the first 64 KB.');
  return `${lines.join('\n')}\n`;
}
