import type { Request } from '../core/model';
import type { Container, Environment } from '../core/model';
import type { VariableInfo } from '../core/vars';
import type { Finding } from '../format/schema';
import type { ResponseView } from './response';

/**
 * The messages between the request editor page and the extension. The page is our code, but what it shows comes from a
 * collection somebody else may have made, so what it sends is read as untrusted: a message that is not exactly one of the
 * known shapes is dropped, and an edit is checked against the model before it is applied (src/view/edit.ts).
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Path = (string | number)[];

export type EditOp =
  | { op: 'set'; path: Path; value: JsonValue }
  /** Removes a key of an object (an optional setting goes back to what it inherits). */
  | { op: 'unset'; path: Path }
  | { op: 'insert'; path: Path; index: number; value: JsonValue }
  | { op: 'remove'; path: Path; index: number }
  | { op: 'move'; path: Path; from: number; to: number };

export type ToHost =
  /** The page is drawn; `violations` lists what the Content-Security-Policy refused (it should be empty). */
  | { type: 'ready'; violations: string[] }
  | { type: 'edit'; rev: number; ops: EditOp[] }
  | { type: 'send' }
  | { type: 'cancel' }
  /** Save the body of the last response to a file the person chooses. */
  | { type: 'saveResponse' }
  /** Open the body of the last response in an editor tab. */
  | { type: 'openResponse' }
  /** The Content-Security-Policy refused something after the first drawing. */
  | { type: 'violation'; text: string }
  /** Copy the body of the last response to the clipboard, formatted or as it came. */
  | { type: 'copyResponse'; pretty: boolean }
  /** Make this environment the active one. */
  | { type: 'activate' }
  /** Show the file in the text editor (when the page cannot edit it). */
  | { type: 'openAsText' };

export interface RequestState {
  rev: number;
  request: Request;
  findings: Finding[];
  /** Why the file cannot be edited (it cannot be read, or a newer version wrote it), or undefined when it can. */
  readOnly: string | undefined;
}

/** The pages of the app: the request editor, the editor of an environment, and the editor of a collection or a folder. */
export type AppScreen = 'request' | 'environment' | 'container';

/** What the pages of an environment and of a collection or folder are given: the file as the format reads it (the secret values of an environment put back in), and whether it can be edited. */
export type DocumentState = { rev: number; findings: Finding[]; readOnly: string | undefined } & (
  | { screen: 'environment'; environment: Environment; active: boolean }
  | { screen: 'container'; container: Container; kind: 'collection' | 'folder' }
);

export type ToView =
  | ({ type: 'init' } & RequestState)
  /** The file of an environment or a collection or folder: the first time, and after every change (`meta`: the file did not change, something about it did, such as which environment is the active one). */
  | ({ type: 'document'; cause: 'init' | 'self' | 'disk' | 'undo' | 'meta' } & DocumentState)
  /** The file changed: by an edit of the page (`self`), on disk, or by an undo in the text editor. */
  | ({ type: 'doc'; cause: 'self' | 'disk' | 'undo' } & RequestState)
  | { type: 'rejected'; rev: number; reason: string }
  /** The variables the request can use (from its folders, the active environment and the workspace), so that the page can mark a name as known or not; `complete` is false when they cannot be known. */
  | { type: 'vars'; vars: VariableInfo[]; complete: boolean }
  /** A send began; `id` says which one the answers below belong to. */
  | { type: 'sending'; id: number }
  | { type: 'response'; id: number; response: ResponseView }
  /** The request could not be sent or got no answer: `code` is what the engine calls it, `hint` says what to try. */
  | { type: 'failed'; id: number; code: string; message: string; hint: string; warnings: string[] }
  | { type: 'cancelled'; id: number };

export const MAX_OPS = 200;
export const MAX_PATH_LENGTH = 8;
export const MAX_ROWS = 10_000;
/** A value of an edit, as JSON. */
export const MAX_VALUE_CHARS = 8 * 1024 * 1024;
const MAX_VIOLATIONS = 20;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ROWS;

function parsePath(value: unknown): Path | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATH_LENGTH) return undefined;
  const path: Path = [];
  for (const part of value) {
    if (typeof part === 'string' && part.length > 0 && part.length <= 64 && !FORBIDDEN_KEYS.has(part)) path.push(part);
    else if (isIndex(part)) path.push(part);
    else return undefined;
  }
  return path;
}

/** Whether a value is JSON and not larger than the limit; anything else (a function, an undefined, a cycle) is refused. */
function parseValue(value: unknown): JsonValue | undefined {
  let size = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (depth > 12 || ++size > 100_000) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') { size += item.length; return size <= MAX_VALUE_CHARS; }
    if (Array.isArray(item)) return item.every(entry => walk(entry, depth + 1));
    if (isRecord(item)) return Object.keys(item).every(key => !FORBIDDEN_KEYS.has(key) && walk(item[key], depth + 1));
    return false;
  };
  return walk(value, 0) ? (value as JsonValue) : undefined;
}

function parseOp(raw: unknown): EditOp | undefined {
  if (!isRecord(raw)) return undefined;
  const op = own(raw, 'op');
  const path = parsePath(own(raw, 'path'));
  if (path === undefined) return undefined;
  if (op === 'set') {
    const value = parseValue(own(raw, 'value'));
    return value === undefined ? undefined : { op, path, value };
  }
  if (op === 'insert') {
    const index = own(raw, 'index');
    const value = parseValue(own(raw, 'value'));
    return isIndex(index) && value !== undefined ? { op, path, index, value } : undefined;
  }
  if (op === 'unset') return { op, path };
  if (op === 'remove') {
    const index = own(raw, 'index');
    return isIndex(index) ? { op, path, index } : undefined;
  }
  if (op === 'move') {
    const from = own(raw, 'from');
    const to = own(raw, 'to');
    return isIndex(from) && isIndex(to) ? { op, path, from, to } : undefined;
  }
  return undefined;
}

/** The message of the page, or undefined when it is not exactly one of the known shapes. */
export function parseToHost(raw: unknown): ToHost | undefined {
  if (!isRecord(raw)) return undefined;
  const type = own(raw, 'type');
  if (type === 'send' || type === 'cancel' || type === 'openAsText' || type === 'saveResponse' || type === 'openResponse' || type === 'activate') return { type };
  if (type === 'violation') { const text = own(raw, 'text'); return typeof text === 'string' ? { type, text: text.slice(0, 200) } : undefined; }
  if (type === 'copyResponse') return { type, pretty: own(raw, 'pretty') === true };
  if (type === 'ready') {
    const given = own(raw, 'violations');
    const violations = Array.isArray(given) ? given.filter((item): item is string => typeof item === 'string').slice(0, MAX_VIOLATIONS).map(item => item.slice(0, 200)) : [];
    return { type, violations };
  }
  if (type === 'edit') {
    const rev = own(raw, 'rev');
    const ops = own(raw, 'ops');
    if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > 2_000_000_000) return undefined;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) return undefined;
    const parsed: EditOp[] = [];
    for (const item of ops) {
      const op = parseOp(item);
      if (op === undefined) return undefined;
      parsed.push(op);
    }
    return { type, rev, ops: parsed };
  }
  return undefined;
}
