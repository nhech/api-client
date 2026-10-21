import { splitOutsideVariables, mapLiteral } from '../convert/text';
import type { Level } from '../core/inherit';
import type { KV, Request } from '../core/model';
import { parseHttp, type ParsedRequest } from '../format/http/parse';
import type { Mirror } from './generate';

/**
 * Taking the edits of a person back into the request. A `.http` file that was edited by hand is compared with what it was when it was
 * written (which is what the request gives now, because the request did not change), and only the differences are applied, so that
 * everything the person did not touch stays as it is in the request, the secrets that the file does not hold included. What a `.http`
 * file can say is the method, the address, the headers, the body, the tests and the captures; the rest of the edits (the title, the
 * comments, a body that is not text) cannot be taken and are named, so that the person knows what is lost when the file is written again.
 */
export interface EditsInput {
  request: Request;
  /** The collection and the folders above the request, for the base URL. */
  levels: readonly Level[];
  /** What the file was when it was written. */
  before: Mirror;
  /** The block of the file as it is now, without its first line. */
  edited: string;
}

export interface EditsResult {
  request: Request;
  /** What was taken, one line each, for the person to read before agreeing. */
  changes: string[];
  /** What was changed in the file and cannot be taken. */
  lost: string[];
}

const METHOD = /^[A-Za-z]{1,20}$/;

function restorer(before: Mirror): (text: string) => string {
  return text => { let out = text; for (const [name, value] of before.secrets) out = out.split(`{{${name}}}`).join(value); return out; };
}

const decode = (text: string): string => mapLiteral(text, literal => { try { return decodeURIComponent(literal); } catch { return literal; } });
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The pairs of `a` that are not in `b`, each pair counted as many times as it is there. */
function minus(a: readonly string[], b: readonly string[]): string[] {
  const left = [...b];
  const rest: string[] = [];
  for (const item of a) {
    const at = left.indexOf(item);
    if (at < 0) rest.push(item); else left.splice(at, 1);
  }
  return rest;
}

function baseUrlOf(levels: readonly Level[]): string {
  for (let index = levels.length - 1; index >= 0; index--) {
    const base = (levels[index] as Level).container.baseUrl;
    if (base !== '') return base;
  }
  return '';
}

export function applyEdits(input: EditsInput): EditsResult {
  const restore = restorer(input.before);
  const was = parseHttp(input.before.block).requests[0];
  const now = parseHttp(input.edited).requests[0];
  const result: EditsResult = { request: { ...input.request }, changes: [], lost: [] };
  if (was === undefined || now === undefined) {
    result.lost.push('there is no request in the file to take edits out of');
    return result;
  }
  const request = result.request;
  const note = (line: string): void => { result.changes.push(line); };

  // ---- the method ----
  if (now.method !== was.method) {
    if (METHOD.test(now.method)) { request.method = now.method.toUpperCase(); note(`Method: ${was.method} to ${request.method}`); } else result.lost.push(`the method "${now.method.slice(0, 20)}" is not one`);
  }

  // ---- the address: the path, and the query pair by pair ----
  if (now.url !== was.url) {
    const cut = (url: string): { path: string; query: string } => { const hook = url.indexOf('?'); return hook < 0 ? { path: url, query: '' } : { path: url.slice(0, hook), query: url.slice(hook + 1) }; };
    const a = cut(was.url);
    const b = cut(now.url);
    if (a.path !== b.path) {
      const base = baseUrlOf(input.levels);
      const path = restore(b.path);
      const relative = base !== '' && path.startsWith(base) ? path.slice(base.length) : path;
      const hook = request.url.indexOf('?');
      request.url = relative + (hook < 0 ? '' : request.url.slice(hook));
      note(`Address: ${a.path} to ${b.path}`);
    }
    const pairsOf = (query: string): string[] => (query === '' ? [] : splitOutsideVariables(query, '&').filter(pair => pair !== ''));
    const removed = minus(pairsOf(a.query), pairsOf(b.query));
    const added = minus(pairsOf(b.query), pairsOf(a.query));
    const rows: KV[] = [...request.query];
    // Where a pair was removed and another of the same name is added, the new one takes the place of the old one.
    const holes: { name: string; at: number }[] = [];
    const pairRow = (pair: string): { name: string; value: string } => { const at = pair.indexOf('='); return at < 0 ? { name: decode(pair), value: '' } : { name: decode(pair.slice(0, at)), value: restore(decode(pair.slice(at + 1))) }; };
    for (const pair of removed) {
      const { name, value } = pairRow(pair);
      const at = rows.findIndex(row => row.enabled && row.name === name && row.value === value);
      if (at >= 0) { rows.splice(at, 1); holes.push({ name, at }); note(`Query parameter removed: ${name}`); } else result.lost.push(`the query parameter ${name} is not one of this request`);
    }
    for (const pair of added) {
      const { name, value } = pairRow(pair);
      const hole = holes.findIndex(item => item.name === name);
      const row: KV = { name, value, enabled: true, description: '' };
      if (hole >= 0) { rows.splice((holes[hole] as { at: number }).at, 0, row); holes.splice(hole, 1); } else rows.push(row);
      note(`Query parameter added: ${name}`);
    }
    request.query = rows;
  }

  // ---- the headers, by name ----
  const names = [...new Set([...was.headers, ...now.headers].map(([name]) => name.toLowerCase()))];
  let headers: KV[] = [...request.headers];
  for (const name of names) {
    const old = was.headers.filter(([key]) => same(key, name)).map(([, value]) => value);
    const next = now.headers.filter(([key]) => same(key, name)).map(([, value]) => value);
    if (old.length === next.length && old.every((value, index) => value === next[index])) continue;
    const shown = now.headers.find(([key]) => same(key, name))?.[0] ?? was.headers.find(([key]) => same(key, name))?.[0] ?? name;
    const own = headers.filter(row => row.enabled && same(row.name, name));
    // What the request has of its own under this name is replaced by what the file says; with nothing left, a switched-off row stands for "none", so that the one that is inherited stops applying.
    const replacement: KV[] = next.length > 0
      ? next.map((value, index) => ({ name: own[index]?.name ?? shown, value: restore(value), enabled: true, description: own[index]?.description ?? '' }))
      : own.length === 0 ? [{ name: shown, value: '', enabled: false, description: '' }] : [];
    // The new rows stand where the first of the old ones was.
    const placed: KV[] = [];
    let done = false;
    for (const row of headers) {
      if (row.enabled && same(row.name, name)) { if (!done) { placed.push(...replacement); done = true; } continue; }
      placed.push(row);
    }
    if (!done) placed.push(...replacement);
    headers = placed;
    note(next.length > 0 ? `Header ${shown}: ${old.length === 0 ? 'added' : 'changed'}` : `Header ${shown}: removed`);
  }
  request.headers = headers;

  // ---- the body ----
  if (now.body !== was.body) {
    const text = now.body === undefined ? undefined : restore(now.body);
    const kind = request.body.kind;
    if (text === undefined) { request.body = { kind: 'none' }; note('Body: removed'); }
    else if (now.bodyFile !== undefined) result.lost.push('a body that is read from a file is not taken');
    else if (kind === 'text' || kind === 'json' || kind === 'xml') { request.body = { ...request.body, text } as Request['body']; note('Body: changed'); }
    else if (kind === 'none') { request.body = bodyFromHeaders(text, now); note('Body: added'); }
    else if (kind === 'form') {
      const old = request.body.fields.filter(field => !field.enabled);
      const fields: KV[] = splitOutsideVariables(text, '&').filter(pair => pair !== '').map(pair => { const at = pair.indexOf('='); return { name: decode(at < 0 ? pair : pair.slice(0, at)), value: at < 0 ? '' : decode(pair.slice(at + 1)), enabled: true, description: '' }; });
      request.body = { kind: 'form', fields: [...fields, ...old] };
      note('Body: changed');
    } else result.lost.push(`the body of this request is ${kind === 'multipart' ? 'a multipart form' : kind === 'graphql' ? 'GraphQL' : 'a file'}: change it in the request`);
  }

  // ---- the tests and the captures ----
  const lines = (list: readonly { expr: string; enabled: boolean }[]): { expr: string; enabled: boolean }[] => [...list];
  const tests = lines(request.tests);
  for (const expr of minus(was.asserts, now.asserts)) {
    const at = tests.findIndex(test => test.expr.trim() === expr.trim());
    if (at >= 0) { tests.splice(at, 1); note(`Test removed: ${expr}`); } else result.lost.push(`the test "${expr.slice(0, 60)}" is from a collection or a folder: take it out there`);
  }
  for (const expr of minus(now.asserts, was.asserts)) { tests.push({ expr, enabled: true }); note(`Test added: ${expr}`); }
  request.tests = tests;
  const captures = lines(request.captures);
  for (const expr of minus(was.captures, now.captures)) {
    const at = captures.findIndex(capture => capture.expr.trim() === expr.trim());
    if (at >= 0) { captures.splice(at, 1); note(`Capture removed: ${expr}`); }
  }
  for (const expr of minus(now.captures, was.captures)) { captures.push({ expr, enabled: true }); note(`Capture added: ${expr}`); }
  request.captures = captures;

  // ---- what cannot be taken ----
  if (now.title !== was.title) result.lost.push('the title (rename the request in the side bar)');
  const writtenNotes = (parsed: ParsedRequest): string[] => parsed.comments.filter(line => !line.startsWith('# ['));
  if (minus(writtenNotes(was), writtenNotes(now)).length > 0 || minus(writtenNotes(now), writtenNotes(was)).length > 0) result.lost.push('changes to the comments');
  return result;
}

/** A body that the request did not have, from what the file gives: JSON or XML by the content type, else text. */
function bodyFromHeaders(text: string, parsed: ParsedRequest): Request['body'] {
  const type = parsed.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const lower = type.toLowerCase();
  if (lower.includes('json')) return { kind: 'json', text };
  if (lower.includes('xml')) return { kind: 'xml', text };
  return { kind: 'text', contentType: type === '' ? 'text/plain' : type, text };
}
