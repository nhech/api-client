import type { Request } from '../core/model';
import { decodeRequest, encodeRequest } from '../format/schema';
import { MAX_ROWS, MAX_VALUE_CHARS, type EditOp, type JsonValue, type Path } from './request-protocol';

/**
 * Applying the edits of the page to a request. An edit says where (a path into the request) and what; nothing the page sends is
 * trusted, so the edits are applied to a copy and the result is written as a file and read back with the same rules a file from
 * disk gets: a value of the wrong type, a method that is not a method or a number out of range is refused, and the request
 * that comes back is the normalised one. The identifier of a request is never changed by an edit.
 */
const EDITABLE: ReadonlySet<string> = new Set(['name', 'docs', 'method', 'url', 'query', 'pathParams', 'headers', 'auth', 'body', 'scripts', 'tests', 'captures', 'settings', 'mirror']);

type Container = Record<string, unknown> | unknown[];
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const describe = (path: Path): string => path.map(part => String(part)).join('.');

class Refused extends Error {}

/** The array or object that holds the last step of the path. */
function parentOf(root: Record<string, unknown>, path: Path): { parent: Container; key: string | number } {
  const first = path[0];
  if (typeof first !== 'string' || !EDITABLE.has(first)) throw new Refused(`${describe(path)} is not something that can be edited`);
  let current: unknown = root;
  for (const step of path.slice(0, -1)) {
    if (typeof step === 'number') {
      if (!isArray(current) || step >= current.length) throw new Refused(`there is no row ${step} at ${describe(path)}`);
      current = current[step];
    } else {
      if (!isObject(current) || !Object.hasOwn(current, step)) throw new Refused(`there is no ${step} at ${describe(path)}`);
      current = current[step];
    }
  }
  if (!isObject(current) && !isArray(current)) throw new Refused(`${describe(path)} is not inside something that can be edited`);
  return { parent: current, key: path[path.length - 1] as string | number };
}

function listAt(root: Record<string, unknown>, path: Path): unknown[] {
  const { parent, key } = parentOf(root, path);
  const list = typeof key === 'string' && isObject(parent) ? parent[key] : isArray(parent) && typeof key === 'number' ? parent[key] : undefined;
  if (!isArray(list)) throw new Refused(`${describe(path)} is not a list`);
  return list;
}

function apply(root: Record<string, unknown>, op: EditOp): void {
  if (op.op === 'set') {
    const { parent, key } = parentOf(root, op.path);
    if (isArray(parent)) {
      if (typeof key !== 'number' || key >= parent.length) throw new Refused(`there is no row ${String(key)} at ${describe(op.path)}`);
      parent[key] = op.value;
    } else {
      if (typeof key !== 'string') throw new Refused(`${describe(op.path)} is not a place in an object`);
      parent[key] = op.value;
    }
    return;
  }
  const list = listAt(root, op.path);
  if (op.op === 'insert') {
    if (op.index > list.length || list.length >= MAX_ROWS) throw new Refused(`a row cannot be added at ${op.index} of ${describe(op.path)}`);
    list.splice(op.index, 0, op.value);
  } else if (op.op === 'remove') {
    if (op.index >= list.length) throw new Refused(`there is no row ${op.index} to remove at ${describe(op.path)}`);
    list.splice(op.index, 1);
  } else {
    if (op.from >= list.length || op.to >= list.length) throw new Refused(`rows cannot be moved from ${op.from} to ${op.to} in ${describe(op.path)}`);
    const [row] = list.splice(op.from, 1);
    list.splice(op.to, 0, row);
  }
}

export type EditResult = { ok: true; request: Request } | { ok: false; reason: string };

export function applyEditOps(request: Request, ops: readonly EditOp[]): EditResult {
  const draft = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  try {
    for (const op of ops) apply(draft, op);
    if (JSON.stringify(draft).length > MAX_VALUE_CHARS) throw new Refused('the request is too large');
    const decoded = decodeRequest(encodeRequest(draft as unknown as Request));
    if (!decoded.ok) {
      const finding = decoded.findings.find(item => item.severity === 'error');
      throw new Refused(finding === undefined ? 'the request does not fit the format' : `${finding.path === '' ? '' : `${finding.path}: `}${finding.message}`);
    }
    return { ok: true, request: decoded.value };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.message };
    if (error instanceof TypeError && /^\w+ must be true or false$/.test(error.message)) return { ok: false, reason: error.message };
    // A value of the wrong shape can make the writer fail before the reader gets to say why.
    return { ok: false, reason: 'the change does not fit the request' };
  }
}

/** A change to the lines of a document: lines [startLine, endLine) are replaced by `lines`. */
export interface LineEdit {
  startLine: number;
  /** Exclusive. */
  endLine: number;
  lines: string[];
}

/**
 * The smallest change of lines that turns one text into another, so that an edit of one field replaces a few lines and not the
 * whole file (a cursor elsewhere in the same file stays where it is). Undefined when the texts are the same, whatever their line
 * endings.
 */
export function minimalEdit(before: string, after: string): LineEdit | undefined {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  if (prefix === oldLines.length && prefix === newLines.length) return undefined;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  return { startLine: prefix, endLine: oldLines.length - suffix, lines: newLines.slice(prefix, newLines.length - suffix) };
}

/** What the edit does, as text: the same text the editor ends up with. Used by the tests as the reference. */
export function applyLineEdit(before: string, edit: LineEdit, eol: string): string {
  const lines = before.split(/\r?\n/);
  const kept = [...lines.slice(0, edit.startLine), ...edit.lines, ...lines.slice(edit.endLine)];
  return kept.join(eol);
}

/** A replacement of a range of a document, in line and column positions, as the editor wants it. */
export interface RangeEdit {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  text: string;
}

/**
 * The range and the text for an edit of lines. The line breaks inside the range are the document's own (`eol`); the line break
 * that separates the replaced lines from the ones around them is added or removed with them, so that the result is the new text exactly.
 */
export function toRangeEdit(before: string, edit: LineEdit, eol: string): RangeEdit {
  const old = before.split(/\r?\n/);
  const last = old.length - 1;
  const lastLength = (old[last] as string).length;
  const { startLine, endLine, lines } = edit;
  if (endLine <= last) {
    // A line follows the replaced ones, so the range runs to its start and takes the line break with it.
    return { startLine, startChar: 0, endLine, endChar: 0, text: lines.length === 0 ? '' : lines.join(eol) + eol };
  }
  if (startLine > last) return { startLine: last, startChar: lastLength, endLine: last, endChar: lastLength, text: lines.length === 0 ? '' : eol + lines.join(eol) };
  if (lines.length === 0 && startLine > 0) return { startLine: startLine - 1, startChar: (old[startLine - 1] as string).length, endLine: last, endChar: lastLength, text: '' };
  return { startLine, startChar: 0, endLine: last, endChar: lastLength, text: lines.join(eol) };
}

export type { JsonValue };
