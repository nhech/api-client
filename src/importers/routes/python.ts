import { emptyResult, makeRoute, methodOf, unique, type Edge, type FileResult } from './internal';
import { angleParams, braceParams, groupFromFile, joinPaths, pathParamNames } from './paths';
import { argRanges, identAt, indexWithin, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type RouteMethod, type SourceFile } from './types';

/**
 * Python: FastAPI (`@app.get("/items/{id}")`, `APIRouter(prefix="/items")`), Flask (`@app.route("/x", methods=["GET", "POST"])`, `Blueprint("n", __name__, url_prefix="/p")`)
 * and the `urls.py` of Django (`path("users/<int:id>/", view)`, `include("app.urls")`). Django does not say the method of a route: it is listed as GET.
 * A router that is added with `include_router(router, prefix="/api")` or `register_blueprint` is an edge between two names, as in JavaScript.
 */
export type ResolvePython = (from: string, dotted: string) => string | undefined;

interface Receiver {
  framework: 'FastAPI' | 'Flask';
  kind: 'app' | 'router';
  prefix: string;
}

interface Import {
  /** The module, with leading dots when it is relative. */
  module: string;
  /** The name taken from it (`from m import name`), or undefined for `import m`. */
  name: string | undefined;
}

const SIMPLE_TYPES = new Set(['str', 'int', 'float', 'bool', 'UUID', 'date', 'datetime', 'Decimal', 'time', 'bytes']);
const NOT_BODY = new Set(['Request', 'Response', 'BackgroundTasks', 'Session', 'AsyncSession', 'WebSocket', 'HTTPConnection', 'SecurityScopes', 'Depends', 'User', 'Connection']);
const CONVENTIONAL = new Set(['app', 'router', 'bp', 'blueprint', 'api']);

function importsOf(clean: string): Map<string, Import> {
  const found = new Map<string, Import>();
  for (const match of clean.matchAll(/^[ \t]*from\s+(\.*[A-Za-z_][\w.]{0,100}|\.+)\s+import\s+(\([^)]{0,600}\)|[^\n;#]{1,300})/gm)) {
    const module = match[1] as string;
    const list = (match[2] as string).replace(/^\(|\)$/g, '');
    for (const item of list.split(',')) {
      const piece = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
      if (piece !== null) found.set(piece[2] ?? (piece[1] as string), { module, name: piece[1] as string });
    }
  }
  for (const match of clean.matchAll(/^[ \t]*import\s+([A-Za-z_][\w.]{0,100})(?:\s+as\s+([A-Za-z_]\w*))?/gm)) {
    found.set(match[2] ?? ((match[1] as string).split('.')[0] as string), { module: match[1] as string, name: undefined });
  }
  return found;
}

/** The path of a decorator or a call: the first argument, or `path=`. */
function pathArg(prepared: Prepared, openAt: number): { path: string | undefined; ranges: [number, number][] } {
  const ranges = argRanges(prepared, openAt, { max: 8, scan: 800 });
  const first = ranges[0];
  if (first === undefined) return { path: undefined, ranges };
  const text = prepared.clean.slice(first[0], first[1]);
  const named = /^path\s*=\s*/.exec(text);
  const direct = named === null ? stringArg(prepared, first) : stringArg(prepared, [first[0] + named[0].length, first[1]]);
  return { path: direct, ranges };
}

function keyword(prepared: Prepared, ranges: readonly (readonly [number, number])[], key: string): string | undefined {
  for (const range of ranges) {
    const text = prepared.clean.slice(range[0], range[1]);
    const match = new RegExp(`^${key}\\s*=\\s*`).exec(text);
    if (match !== null) return prepared.clean.slice(range[0] + match[0].length, range[1]);
  }
  return undefined;
}

function receiversOf(prepared: Prepared): Map<string, Receiver> {
  const found = new Map<string, Receiver>();
  for (const match of prepared.masked.matchAll(/^[ \t]*([A-Za-z_]\w{0,60})\s*(?::[^=\n]{1,60})?=\s*(FastAPI|APIRouter|Flask|Blueprint)\s*\(/gm)) {
    const kind = match[2] as string;
    const openAt = (match.index ?? 0) + match[0].length - 1;
    const ranges = argRanges(prepared, openAt, { max: 12, scan: 800 });
    const prefix = keyword(prepared, ranges, kind === 'Blueprint' ? 'url_prefix' : 'prefix');
    const literal = prefix === undefined ? undefined : /^\s*[rRbBuU]?(["'])([^"'\n]{0,200})\1\s*$/.exec(prefix);
    found.set(match[1] as string, {
      framework: kind === 'FastAPI' || kind === 'APIRouter' ? 'FastAPI' : 'Flask', kind: kind === 'FastAPI' || kind === 'Flask' ? 'app' : 'router', prefix: literal === null || literal === undefined ? '' : (literal[2] as string)
    });
  }
  return found;
}

/** What the parameters of a FastAPI function say: the query, the headers and the body. */
function fastApiParameters(prepared: Prepared, openAt: number, pathNames: readonly string[], method: RouteMethod): { query: string[]; header: string[]; body: 'json' | 'form' | undefined } {
  const query: string[] = [];
  const header: string[] = [];
  let body: 'json' | 'form' | undefined;
  for (const range of argRanges(prepared, openAt, { max: 30, scan: 3000 })) {
    const text = prepared.clean.slice(range[0], range[1]);
    const head = /^([A-Za-z_]\w*)\s*(?::\s*([\s\S]*?))?(?:=([\s\S]*))?$/.exec(text);
    if (head === null) continue;
    const name = head[1] as string;
    const annotation = (head[2] ?? '').trim();
    const fallback = (head[3] ?? '').trim();
    if (name === 'self' || name === 'cls' || pathNames.includes(name)) continue;
    if (/\bDepends\s*\(|\bSecurity\s*\(|\bPath\s*\(|\bCookie\s*\(/.test(`${annotation} ${fallback}`)) continue;
    if (/\bHeader\s*\(/.test(`${annotation} ${fallback}`)) {
      const alias = /\balias\s*=\s*(["'])([^"'\n]{0,100})\1/.exec(`${annotation} ${fallback}`);
      header.push(alias === null ? name.replace(/_/g, '-') : (alias[2] as string));
      continue;
    }
    if (/\bQuery\s*\(/.test(`${annotation} ${fallback}`)) { query.push(name); continue; }
    if (/\bForm\s*\(|\bFile\s*\(|\bUploadFile\b/.test(`${annotation} ${fallback}`)) { body = 'form'; continue; }
    if (/\bBody\s*\(/.test(`${annotation} ${fallback}`)) { body = body ?? 'json'; continue; }
    const base = /^(?:(?:Optional|Union|Annotated|List|list|Sequence|Set|set)\s*\[\s*)*([A-Za-z_][\w.]*)/.exec(annotation);
    const type = base === null ? '' : (base[1] as string);
    if (SIMPLE_TYPES.has(type) || (annotation === '' && head[3] !== undefined)) { query.push(name); continue; }
    if (/^[A-Z]/.test(type) && !NOT_BODY.has(type) && head[3] === undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH')) body = body ?? 'json';
  }
  return { query: unique(query), header: unique(header), body };
}

/** After a decorator: the `def` it is on (other decorators are skipped), as the name and the `(` of its parameters. */
function defAfter(prepared: Prepared, from: number): { name: string; openAt: number } | undefined {
  const masked = prepared.masked;
  let at = from;
  for (let step = 0; step < 20; step++) {
    at = skipSpace(masked, at);
    if (masked[at] === '@') {
      let end = masked.indexOf('\n', at);
      if (end < 0) end = masked.length;
      const paren = indexWithin(masked, '(', at, end);
      if (paren >= 0) {
        const closeAt = prepared.close[paren] ?? -1;
        if (closeAt < 0) return undefined;
        end = Math.max(end, closeAt + 1);
      }
      at = end;
      continue;
    }
    if (masked.startsWith('async', at) && /\s/.test(masked[at + 5] ?? '')) at = skipSpace(masked, at + 5);
    if (masked.startsWith('def', at) && /\s/.test(masked[at + 3] ?? '')) {
      const nameAt = skipSpace(masked, at + 3);
      const name = identAt(masked, nameAt);
      const paren = skipSpace(masked, nameAt + name.length);
      return name !== '' && masked[paren] === '(' ? { name, openAt: paren } : undefined;
    }
    return undefined;
  }
  return undefined;
}

function decoratorRoutes(file: SourceFile, prepared: Prepared, result: FileResult, receivers: Map<string, Receiver>): void {
  const group = groupFromFile(file.path);
  /** Whether the file is Flask and not FastAPI, decided once: it reads the whole text. */
  let flaskOnly: boolean | undefined;
  const DECORATOR = /^[ \t]*@([A-Za-z_]\w{0,60})\s*\.\s*(get|post|put|patch|delete|head|options|route|api_route)\s*\(/gm;
  for (const match of prepared.masked.matchAll(DECORATOR)) {
    if (result.routes.length > ROUTE_LIMITS.routes) return;
    const name = match[1] as string;
    const verb = match[2] as string;
    const receiver = receivers.get(name) ?? (CONVENTIONAL.has(name) ? { framework: 'FastAPI' as const, kind: 'router' as const, prefix: '' } : undefined);
    if (receiver === undefined) continue;
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const closeAt = prepared.close[openAt] ?? -1;
    if (closeAt < 0) continue;
    const { path, ranges } = pathArg(prepared, openAt);
    if (path === undefined) { if (ranges.length > 0) result.computed++; continue; }
    const framework = receivers.has(name) ? receiver.framework : (flaskOnly ??= /\bflask\b/i.test(prepared.clean) && !/\bfastapi\b/i.test(prepared.clean)) ? 'Flask' : receiver.framework;
    let methods: RouteMethod[];
    if (verb === 'route' || verb === 'api_route') {
      const listed = keyword(prepared, ranges, 'methods');
      methods = listed === undefined ? ['GET'] : [...listed.matchAll(/["']([A-Za-z]{3,7})["']/g)].map(item => methodOf(item[1] as string)?.method).filter((item): item is RouteMethod => item !== undefined);
      if (methods.length === 0) methods = ['GET'];
      methods = [...new Set(methods)];
    } else methods = [methodOf(verb)?.method ?? 'GET'];
    const full = framework === 'Flask' ? angleParams(path) : braceParams(path);
    const signature = defAfter(prepared, closeAt + 1);
    const final = joinPaths(receiver.prefix, full);
    const pathNames = pathParamNames(final);
    for (const method of methods) {
      const params = framework === 'FastAPI' && signature !== undefined ? fastApiParameters(prepared, signature.openAt, pathNames, method) : undefined;
      result.routes.push(makeRoute({
        method, path: final, framework, group, file: file.path, line: lineOf(prepared, at), handler: signature?.name, receiver: name, receiverKind: receiver.kind,
        queryParams: params?.query ?? [], headerParams: params?.header ?? [], body: params?.body
      }));
    }
  }
}

function mounts(file: SourceFile, prepared: Prepared, result: FileResult, receivers: Map<string, Receiver>, imports: Map<string, Import>, resolve: ResolvePython): void {
  for (const match of prepared.masked.matchAll(/(?<![\w.])([A-Za-z_]\w{0,60})\s*\.\s*(include_router|register_blueprint)\s*\(/g)) {
    const parent = match[1] as string;
    if (!receivers.has(parent) && !CONVENTIONAL.has(parent)) continue;
    const openAt = (match.index ?? 0) + match[0].length - 1;
    const ranges = argRanges(prepared, openAt, { max: 6, scan: 600 });
    const first = ranges[0];
    if (first === undefined) continue;
    const text = prepared.clean.slice(first[0], first[1]);
    const prefix = keyword(prepared, ranges, match[2] === 'include_router' ? 'prefix' : 'url_prefix');
    const literal = prefix === undefined ? undefined : /^\s*[rRbBuU]?(["'])([^"'\n]{0,200})\1\s*$/.exec(prefix);
    const own = literal === null || literal === undefined ? '' : (literal[2] as string);
    let child: Edge['child'] | undefined;
    const dotted = /^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)$/.exec(text);
    if (/^[A-Za-z_]\w*$/.test(text)) {
      const local = receivers.get(text);
      if (local !== undefined) child = { kind: 'local', name: text };
      else {
        const imported = imports.get(text);
        const target = imported === undefined ? undefined : resolve(file.path, imported.module);
        if (imported !== undefined && target !== undefined) child = { kind: 'import', file: target, name: imported.name };
      }
    } else if (dotted !== null) {
      const imported = imports.get(dotted[1] as string);
      if (imported !== undefined) {
        const asModule = imported.name === undefined ? resolve(file.path, imported.module) : resolve(file.path, `${imported.module}${imported.module.endsWith('.') ? '' : '.'}${imported.name}`);
        if (asModule !== undefined) child = { kind: 'import', file: asModule, name: dotted[2] as string };
      }
    }
    if (child !== undefined) result.edges.push({ file: file.path, parent, prefix: own, child });
  }
}

function djangoRoutes(file: SourceFile, prepared: Prepared, result: FileResult, resolve: ResolvePython): void {
  const group = groupFromFile(file.path);
  for (const match of prepared.masked.matchAll(/(?<![\w.])(path|re_path|url)\s*\(/g)) {
    if (result.routes.length > ROUTE_LIMITS.routes) return;
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const ranges = argRanges(prepared, openAt, { max: 3, scan: 800 });
    const first = ranges[0];
    const second = ranges[1];
    if (first === undefined || second === undefined) continue;
    const raw = stringArg(prepared, first);
    if (raw === undefined) { result.computed++; continue; }
    const path = match[1] === 'path' ? angleParams(raw) : angleParams(raw).replace(/[$^]/g, '').replace(/\\\./g, '.');
    const view = prepared.clean.slice(second[0], second[1]);
    const include = /^include\s*\(\s*\(?\s*(?:[rRbBuU]?(["'])([^"'\n]{0,200})\1)?/.exec(view);
    if (include !== null) {
      const module = include[2];
      const target = module === undefined ? undefined : resolve(file.path, module);
      if (target !== undefined) result.edges.push({ file: file.path, parent: 'urls', prefix: path, child: { kind: 'import', file: target, name: undefined } });
      continue;
    }
    // `admin.site.urls` and the like are other lists of routes, not a view.
    if (/\.urls\s*$/.test(view)) continue;
    const handler = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,3})(?:\.as_view\s*\()?/.exec(view);
    result.anyRoutes++;
    result.routes.push(makeRoute({
      method: 'GET', path: path === '' ? '/' : path, framework: 'Django', group, file: file.path, line: lineOf(prepared, at), handler: handler === null ? undefined : (handler[1] as string), receiver: 'urls', receiverKind: 'router'
    }));
  }
}

export function scanPython(file: SourceFile, resolve: ResolvePython): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'python');
  result.longLines = prepared.longLines;
  const clean = prepared.clean;
  const framework = /^[ \t]*(?:from\s+(?:fastapi|flask)\b|import\s+(?:fastapi|flask)\b)/m.test(clean);
  const imports = importsOf(clean);
  const receivers = framework ? receiversOf(prepared) : new Map<string, Receiver>();
  if (framework) {
    decoratorRoutes(file, prepared, result, receivers);
    mounts(file, prepared, result, receivers, imports, resolve);
    const run = /\b(?:app\.run|uvicorn\.run)\s*\(([^)]{0,200})\)/.exec(clean);
    const port = run === null ? null : /\bport\s*=\s*(\d{2,5})\b/.exec(run[1] as string);
    if (port !== null) result.port = Number(port[1]);
  }
  const base = file.path.split('/').pop() ?? '';
  if (base === 'urls.py' && /\burlpatterns\b/.test(clean)) djangoRoutes(file, prepared, result, resolve);
  return result;
}
