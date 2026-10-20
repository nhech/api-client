import type { ImpQuery } from '../model/ir';
import { isHiddenChar } from '../util/chars';
import { indexOutsideVariables, oneLine, splitOutsideVariables, splitVariables } from './text';

/**
 * N2 and N3: the URL of a request and its parameters (spec 5.1).
 *
 * N2. In the data the URL already holds the query of the enabled parameters and `params` repeats them, so the URL is the
 * truth for the query: an enabled parameter that is in the URL (same name and value) is kept once, one that is not is
 * appended (TC-PARAM-NOT-IN-URL), a disabled one is not in the URL and is only listed, to become a comment.
 *
 * N3. A path parameter `:name` that is a whole segment of the path takes the value of the enabled parameter of that name.
 * Only the path counts: not the host, not a port, not the query. An empty value leaves the placeholder (TC-PATHPARAM-EMPTY).
 *
 * The result is safe to put on one line: spaces are encoded, and so is any control or direction-changing character; a
 * variable is opaque but may not contain a line break either.
 */
export interface ParamInput {
  name: string;
  value: string;
  enabled: boolean;
  isPath: boolean;
}

export interface UrlConversion {
  url: string;
  /** The parameters of the request: the enabled ones that are in the URL, and the disabled ones. */
  query: ImpQuery[];
  /** Enabled parameters that were missing from the URL and were appended. */
  appended: number;
  /** Path parameters with no value, whose placeholder was kept. */
  emptyPathParams: number;
  /** A line break was found in the URL and encoded. */
  lineBreak: boolean;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

const decoded = (text: string): string => {
  try { return decodeURIComponent(text); } catch { return text; }
};

interface Pair { name: string; value: string }

function splitPair(raw: string): Pair {
  const eq = indexOutsideVariables(raw, '=');
  return eq < 0 ? { name: raw, value: '' } : { name: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

/** Two pairs are the same parameter when their names and values are equal once decoded (which includes being equal as written). */
const keyOf = (name: string, value: string): string => JSON.stringify([decoded(name), decoded(value)]);

/** Only what would break the structure of a URL: a space, "&" and "#" outside variables. */
const encodePart = (text: string): string => splitVariables(text).map(piece => (piece.variable ? piece.text : piece.text.replaceAll(' ', '%20').replaceAll('&', '%26').replaceAll('#', '%23'))).join('');

function fillPathParams(base: string, values: ReadonlyMap<string, string>, onEmpty: () => void): string {
  const scheme = SCHEME.exec(base);
  let start: number;
  if (scheme !== null) start = indexOutsideVariables(base, '/', scheme[0].length);
  else if (base.startsWith('/')) start = 0;
  else start = indexOutsideVariables(base, '/');
  if (start < 0) return base;
  const segments = splitOutsideVariables(base.slice(start), '/').map(segment => {
    if (!segment.startsWith(':')) return segment;
    const value = values.get(segment.slice(1));
    if (value === undefined) return segment;
    if (value === '') { onEmpty(); return segment; }
    return value;
  });
  return base.slice(0, start) + segments.join('/');
}

function sanitize(url: string): { text: string; lineBreak: boolean } {
  let lineBreak = false;
  const text = splitVariables(url).map(piece => {
    if (piece.variable) {
      const line = oneLine(piece.text);
      lineBreak ||= line.lineBreak;
      return line.text;
    }
    return Array.from(piece.text, char => {
      if (char === ' ') return '%20';
      if (char === '\r' || char === '\n') lineBreak = true;
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0x20 && !isHiddenChar(char)) return char;
      try { return encodeURIComponent(char); } catch { return '?'; }
    }).join('');
  }).join('');
  return { text, lineBreak };
}

/** Decides what stands in a file for the value of a query parameter: the value itself, or a variable that holds it. */
export type ProtectValue = (name: string, value: string) => string;

export function convertUrl(rawUrl: string, params: readonly ParamInput[], protect?: ProtectValue): UrlConversion {
  let rest = rawUrl;
  let fragment = '';
  const hash = indexOutsideVariables(rest, '#');
  if (hash >= 0) { fragment = rest.slice(hash); rest = rest.slice(0, hash); }

  let base = rest;
  let hasQuery = false;
  let pairs: string[] = [];
  const mark = indexOutsideVariables(rest, '?');
  if (mark >= 0) {
    base = rest.slice(0, mark);
    hasQuery = true;
    const queryText = rest.slice(mark + 1);
    pairs = queryText === '' ? [] : splitOutsideVariables(queryText, '&');
  }

  // The pairs of the URL by what they are, each with a cursor, so that matching a parameter costs one lookup however many repeat.
  const available = new Map<string, { count: number; used: number }>();
  for (const pair of pairs.map(splitPair)) {
    const key = keyOf(pair.name, pair.value);
    const slot = available.get(key);
    if (slot === undefined) available.set(key, { count: 1, used: 0 });
    else slot.count++;
  }
  const query: ImpQuery[] = [];
  let appended = 0;
  for (const param of params) {
    if (!param.enabled || param.isPath || param.name === '') continue;
    const slot = available.get(keyOf(param.name, param.value));
    if (slot !== undefined && slot.used < slot.count) slot.used++;
    else { pairs.push(`${encodePart(param.name)}=${encodePart(param.value)}`); appended++; }
    query.push({ name: param.name, value: param.value, enabled: true });
  }
  for (const param of params) {
    if (!param.enabled && !param.isPath && param.name !== '') query.push({ name: param.name, value: param.value, enabled: false });
  }

  if (protect !== undefined) {
    // Once per distinct name and value, so that a value shown twice (in the URL and in the list) counts once.
    const cache = new Map<string, string>();
    const safe = (name: string, value: string): string => {
      const key = JSON.stringify([name, value]);
      let result = cache.get(key);
      if (result === undefined) { result = protect(name, value); cache.set(key, result); }
      return result;
    };
    pairs = pairs.map(raw => {
      const pair = splitPair(raw);
      const value = safe(decoded(pair.name), pair.value);
      return value === pair.value ? raw : `${pair.name}=${value}`;
    });
    for (const entry of query) entry.value = safe(entry.name, entry.value);
  }

  const pathValues = new Map<string, string>();
  for (const param of params) {
    if (param.enabled && param.isPath && param.name !== '' && !pathValues.has(param.name)) pathValues.set(param.name, param.value);
  }
  let emptyPathParams = 0;
  if (pathValues.size > 0) base = fillPathParams(base, pathValues, () => { emptyPathParams++; });

  const joined = base + (hasQuery || pairs.length > 0 ? `?${pairs.join('&')}` : '') + fragment;
  const clean = sanitize(joined);
  return { url: clean.text, query, appended, emptyPathParams, lineBreak: clean.lineBreak };
}
