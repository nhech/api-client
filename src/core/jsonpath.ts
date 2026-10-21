/**
 * JSONPath, the subset the tests and captures of a request use: `$` for the root, `.name` and `['name']` for a key, `[0]` and `[-1]` for
 * an element, `[*]` and `.*` for every one, `..name` and `..*` for everything below, and `['a','b']` or `[0,2]` for several at once.
 * Filters (`[?(...)]`) and slices (`[1:3]`) are refused with a message, not guessed at. It reads parsed JSON and never runs any of
 * it; a path is limited in length, a result in size and a walk in the number of nodes it visits, so a hostile response or path costs
 * a bounded amount of work.
 */
export const JSONPATH_LIMITS = { pathChars: 1000, segments: 64, matches: 10_000, visited: 1_000_000 } as const;

type Selector = { t: 'name'; name: string } | { t: 'index'; index: number } | { t: 'wildcard' };
interface Segment {
  /** `..` looks below every node, `.` and `[` only at the node itself. */
  deep: boolean;
  selectors: Selector[];
}
export interface ParsedPath {
  source: string;
  segments: Segment[];
}

export type PathResult<T> = { ok: true; value: T } | { ok: false; error: string };

const NAME_CHARS = /[^.[\]\s'"()*,:?]/;

export function parseJsonPath(source: string): PathResult<ParsedPath> {
  if (source.length > JSONPATH_LIMITS.pathChars) return { ok: false, error: `a path is limited to ${JSONPATH_LIMITS.pathChars} characters` };
  if (!source.startsWith('$')) return { ok: false, error: 'a JSON path starts with $' };
  const segments: Segment[] = [];
  let at = 1;
  const fail = (error: string): PathResult<ParsedPath> => ({ ok: false, error });
  while (at < source.length) {
    if (segments.length >= JSONPATH_LIMITS.segments) return fail(`a path is limited to ${JSONPATH_LIMITS.segments} steps`);
    const deep = source.startsWith('..', at);
    if (source[at] === '.') {
      at += deep ? 2 : 1;
      if (source[at] === '*') { segments.push({ deep, selectors: [{ t: 'wildcard' }] }); at++; continue; }
      if (deep && source[at] === '[') continue; // `..[` is read by the bracket branch with the same depth
      let end = at;
      while (end < source.length && NAME_CHARS.test(source[end] as string)) end++;
      if (end === at) return fail(`a key name was expected after the dot at position ${at}`);
      segments.push({ deep, selectors: [{ t: 'name', name: source.slice(at, end) }] });
      at = end;
      continue;
    }
    if (source[at] === '[') {
      const parsed = bracket(source, at);
      if (!parsed.ok) return fail(parsed.error);
      segments.push({ deep: at >= 2 && source[at - 1] === '.' && source[at - 2] === '.', selectors: parsed.value.selectors });
      at = parsed.value.end;
      continue;
    }
    return fail(`unexpected "${source[at]}" at position ${at}`);
  }
  return { ok: true, value: { source, segments } };
}

function bracket(source: string, open: number): PathResult<{ selectors: Selector[]; end: number }> {
  const selectors: Selector[] = [];
  let at = open + 1;
  for (;;) {
    while (source[at] === ' ') at++;
    const c = source[at];
    if (c === undefined) return { ok: false, error: 'a [ that is never closed' };
    if (c === '*') { selectors.push({ t: 'wildcard' }); at++; }
    else if (c === "'" || c === '"') {
      let name = '';
      let index = at + 1;
      for (;;) {
        const d = source[index];
        if (d === undefined) return { ok: false, error: 'a quoted key that is never closed' };
        if (d === '\\') {
          const e = source[index + 1];
          if (e === undefined) return { ok: false, error: 'a quoted key that is never closed' };
          name += e;
          index += 2;
          continue;
        }
        if (d === c) break;
        name += d;
        index++;
      }
      selectors.push({ t: 'name', name });
      at = index + 1;
    } else if (c === '?') return { ok: false, error: 'filters ([?(...)]) are not supported yet' };
    else if (/[-\d]/.test(c)) {
      const match = /^-?\d{1,9}(?!\d)/.exec(source.slice(at));
      if (match === null) return { ok: false, error: `a number was expected at position ${at}` };
      at += match[0].length;
      if (source[at] === ':') return { ok: false, error: 'slices ([a:b]) are not supported yet' };
      selectors.push({ t: 'index', index: Number(match[0]) });
    } else if (c === ':') return { ok: false, error: 'slices ([a:b]) are not supported yet' };
    else return { ok: false, error: `unexpected "${c}" in brackets at position ${at}` };
    while (source[at] === ' ') at++;
    if (source[at] === ',') { at++; continue; }
    if (source[at] === ']') return { ok: true, value: { selectors, end: at + 1 } };
    return { ok: false, error: `a , or ] was expected at position ${at}` };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The values the path selects, in the order of the document. */
export function queryJson(root: unknown, path: ParsedPath): PathResult<unknown[]> {
  let visited = 0;
  let nodes: unknown[] = [root];
  const tooBig = (): PathResult<unknown[]> => ({ ok: false, error: 'the path selects too much, or the document is too large to walk' });
  for (const segment of path.segments) {
    const next: unknown[] = [];
    const apply = (node: unknown): boolean => {
      for (const selector of segment.selectors) {
        if (selector.t === 'name') {
          if (isObject(node) && Object.hasOwn(node, selector.name)) next.push(node[selector.name]);
        } else if (selector.t === 'index') {
          if (Array.isArray(node)) {
            const index = selector.index < 0 ? node.length + selector.index : selector.index;
            if (index >= 0 && index < node.length) next.push(node[index]);
          }
        } else if (Array.isArray(node)) next.push(...node);
        else if (isObject(node)) next.push(...Object.values(node));
        if (next.length > JSONPATH_LIMITS.matches) return false;
      }
      return true;
    };
    for (const node of nodes) {
      if (!segment.deep) {
        if (++visited > JSONPATH_LIMITS.visited || !apply(node)) return tooBig();
        continue;
      }
      // Everything below the node, the node itself first, parents before children.
      const stack: unknown[] = [node];
      while (stack.length > 0) {
        const current = stack.pop();
        if (++visited > JSONPATH_LIMITS.visited || !apply(current)) return tooBig();
        if (Array.isArray(current)) for (let index = current.length - 1; index >= 0; index--) stack.push(current[index]);
        else if (isObject(current)) { const values = Object.values(current); for (let index = values.length - 1; index >= 0; index--) stack.push(values[index]); }
      }
    }
    nodes = next;
  }
  return { ok: true, value: nodes };
}

/** Parses the path and reads the document with it. */
export function evaluateJsonPath(root: unknown, source: string): PathResult<unknown[]> {
  const parsed = parseJsonPath(source);
  return parsed.ok ? queryJson(root, parsed.value) : parsed;
}
