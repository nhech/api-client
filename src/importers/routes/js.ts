import { emptyResult, makeRoute, methodOf, type Edge, type Exports, type FileResult } from './internal';
import { groupFromFile, joinPaths, colonParams } from './paths';
import { argRanges, identAt, identBefore, isSpace, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { scanNest } from './nest';
import { ROUTE_LIMITS, type SourceFile } from './types';

/**
 * Express, Fastify, Koa, Hono, Elysia and Restify: `app.get('/users/:id', handler)`, in a file that imports one of them. The word `get` is on a lot of things
 * (`axios.get('/users')` is a request, not a route), so a call counts only on a name that was made by the framework in this file (`const app = express()`),
 * or on the names every project gives its router when it gets it from outside (`app`, `router`...). A mount (`app.use('/api', router)`) is kept as an edge
 * between two names, and `detectRoutes` puts the prefix on the routes of the router, also when it is in another file.
 */
export type Resolve = (from: string, spec: string) => string | undefined;

interface Receiver {
  name: string;
  framework: string;
  kind: 'app' | 'router';
  prefix: string;
}

const MODULES = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)(['"])(express|fastify|koa-router|@koa\/router|hono|elysia|restify|@fastify\/[\w-]{1,40}|@hono\/[\w-]{1,40}|hono\/[\w-]{1,40})\1/g;
const FRAMEWORK_ORDER = ['Express', 'Fastify', 'Koa', 'Hono', 'Elysia', 'Restify'];
const CONVENTIONAL = new Set(['app', 'router', 'route', 'routes', 'server', 'fastify']);

function frameworkOfModule(name: string): string {
  if (name === 'express') return 'Express';
  if (name === 'fastify' || name.startsWith('@fastify/')) return 'Fastify';
  if (name === 'koa-router' || name === '@koa/router') return 'Koa';
  if (name === 'hono' || name.startsWith('@hono/') || name.startsWith('hono/')) return 'Hono';
  if (name === 'elysia') return 'Elysia';
  return 'Restify';
}

/** The frameworks a file imports, in a fixed order. */
export function frameworksOf(clean: string): string[] {
  const found = new Set<string>();
  for (const match of clean.matchAll(MODULES)) found.add(frameworkOfModule(match[2] as string));
  return FRAMEWORK_ORDER.filter(name => found.has(name));
}

// ---- what the file imports and exports ----

interface ImportedName {
  spec: string;
  /** The name it has in the other file; undefined for the default export, or for the whole module. */
  name: string | undefined;
}

function importsOf(clean: string): Map<string, ImportedName> {
  const found = new Map<string, ImportedName>();
  for (const match of clean.matchAll(/\bimport\s+(?:type\s+)?([^'";]{1,300}?)\s+from\s*(['"])([^'"\n]{1,200})\2/g)) {
    const clause = match[1] as string;
    const spec = match[3] as string;
    const braces = /\{([^}]{0,300})\}/.exec(clause);
    const head = (braces === null ? clause : clause.slice(0, braces.index)).replace(/,\s*$/, '').trim();
    const star = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(head);
    if (star !== null) found.set(star[1] as string, { spec, name: undefined });
    else if (/^[A-Za-z_$][\w$]*$/.test(head)) found.set(head, { spec, name: undefined });
    if (braces !== null) {
      for (const item of (braces[1] as string).split(',')) {
        const piece = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item);
        if (piece === null) continue;
        const original = piece[1] as string;
        found.set(piece[2] ?? original, { spec, name: original === 'default' ? undefined : original });
      }
    }
  }
  for (const match of clean.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]{0,300}\})\s*=\s*(?:await\s+)?require\s*\(\s*(['"])([^'"\n]{1,200})\2\s*\)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const target = match[1] as string;
    const spec = match[3] as string;
    if (target.startsWith('{')) {
      for (const item of target.slice(1, -1).split(',')) {
        const piece = /^\s*([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*$/.exec(item);
        if (piece !== null) found.set(piece[2] ?? (piece[1] as string), { spec, name: piece[1] as string });
      }
    } else found.set(target, { spec, name: match[4] === undefined || match[4] === 'default' ? undefined : match[4] });
  }
  return found;
}

function exportsOf(clean: string): Exports {
  const named = new Map<string, string>();
  let main: string | undefined;
  const direct = /\bmodule\s*\.\s*exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/.exec(clean);
  if (direct !== null) main = direct[1];
  const standard = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(clean);
  if (standard !== null && standard[1] !== 'function' && standard[1] !== 'class' && standard[1] !== 'async') main = standard[1];
  for (const match of clean.matchAll(/\bexport\s*\{([^}]{0,400})\}/g)) {
    for (const item of (match[1] as string).split(',')) {
      const piece = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(item);
      if (piece === null) continue;
      if (piece[2] === 'default') main = piece[1];
      else named.set(piece[2] ?? (piece[1] as string), piece[1] as string);
    }
  }
  for (const match of clean.matchAll(/\bexports\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)/g)) named.set(match[1] as string, match[2] as string);
  const object = /\bmodule\s*\.\s*exports\s*=\s*\{([^}]{0,400})\}/.exec(clean);
  if (object !== null) {
    for (const item of (object[1] as string).split(',')) {
      const piece = /^\s*([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*$/.exec(item);
      if (piece !== null) named.set(piece[1] as string, piece[2] ?? (piece[1] as string));
    }
  }
  for (const match of clean.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) named.set(match[1] as string, match[1] as string);
  return { default: main, named };
}

// ---- the names that are routers or applications ----

const R_EXPRESS_ROUTER = /\s*express\s*\.\s*Router\s*\(/y;
const R_EXPRESS = /\s*express\s*\(/y;
const R_ROUTER = /\s*(new\s+)?Router\s*\(/y;
const R_FASTIFY = /\s*(?:new\s+)?(?:fastify|Fastify)\s*\(/y;
const R_HONO = /\s*new\s+Hono\s*(?:<[^<>()]{0,200}>)?\s*\(/y;
const R_ELYSIA = /\s*new\s+Elysia\s*(?:<[^<>()]{0,200}>)?\s*\(/y;
const R_RESTIFY = /\s*restify\s*\.\s*createServer\s*\(/y;
const R_BASE = /\s*([A-Za-z_$][\w$]*)\s*\.\s*basePath\s*\(/y;

function sticky(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** The prefix a constructor is given as an option (`new Router({ prefix: '/api' })`). */
function optionPrefix(prepared: Prepared, openAt: number): string {
  const closeAt = prepared.close[openAt] ?? -1;
  if (closeAt < 0 || closeAt - openAt > 400) return '';
  const found = /\bprefix\s*:\s*(['"`])([^'"`\n]{0,200})\1/.exec(prepared.clean.slice(openAt, closeAt));
  return found === null ? '' : (found[2] as string);
}

/** A string that is the whole of the argument that starts at `openAt` of a call: `.basePath('/api')`. */
function firstString(prepared: Prepared, openAt: number): string | undefined {
  const first = argRanges(prepared, openAt, { max: 1, scan: 300 })[0];
  return first === undefined ? undefined : stringArg(prepared, first);
}

function receiversOf(prepared: Prepared, primary: string, frameworks: readonly string[]): Map<string, Receiver> {
  const found = new Map<string, Receiver>();
  const clean = prepared.clean;
  const koa = frameworks.includes('Koa');
  for (const match of clean.matchAll(/(?:\b(?:const|let|var)\s+|\bthis\s*\.\s*)([A-Za-z_$][\w$]{0,60})\s*(?::[^=;\n]{1,100})?=(?![=>])/g)) {
    const name = match[1] as string;
    const at = (match.index ?? 0) + match[0].length;
    let hit: RegExpExecArray | null;
    if ((hit = sticky(R_EXPRESS_ROUTER, clean, at)) !== null) found.set(name, { name, framework: 'Express', kind: 'router', prefix: '' });
    else if ((hit = sticky(R_EXPRESS, clean, at)) !== null) found.set(name, { name, framework: 'Express', kind: 'app', prefix: '' });
    else if ((hit = sticky(R_ROUTER, clean, at)) !== null) {
      const framework = hit[1] !== undefined && koa ? 'Koa' : frameworks.includes('Express') ? 'Express' : koa ? 'Koa' : primary;
      found.set(name, { name, framework, kind: 'router', prefix: hit[1] === undefined ? '' : optionPrefix(prepared, at + hit[0].length - 1) });
    } else if ((hit = sticky(R_FASTIFY, clean, at)) !== null) found.set(name, { name, framework: 'Fastify', kind: 'app', prefix: '' });
    else if ((hit = sticky(R_HONO, clean, at)) !== null) {
      const openAt = at + hit[0].length - 1;
      const closeAt = prepared.close[openAt] ?? -1;
      let prefix = '';
      if (closeAt >= 0) {
        const base = /^\s*\.\s*basePath\s*\(/.exec(clean.slice(closeAt + 1, closeAt + 40));
        if (base !== null) prefix = firstString(prepared, closeAt + 1 + base[0].length - 1) ?? '';
      }
      found.set(name, { name, framework: 'Hono', kind: 'router', prefix });
    } else if ((hit = sticky(R_ELYSIA, clean, at)) !== null) found.set(name, { name, framework: 'Elysia', kind: 'router', prefix: optionPrefix(prepared, at + hit[0].length - 1) });
    else if ((hit = sticky(R_RESTIFY, clean, at)) !== null) found.set(name, { name, framework: 'Restify', kind: 'app', prefix: '' });
    else if ((hit = sticky(R_BASE, clean, at)) !== null) {
      const parent = found.get(hit[1] as string);
      if (parent !== undefined) found.set(name, { name, framework: parent.framework, kind: 'router', prefix: joinPaths(parent.prefix, firstString(prepared, at + hit[0].length - 1) ?? '') });
    }
  }
  // Koa: `router.prefix('/api')`.
  for (const match of prepared.masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]{0,60})\s*\.\s*prefix\s*\(/g)) {
    const receiver = found.get(match[1] as string);
    const text = receiver === undefined ? undefined : firstString(prepared, (match.index ?? 0) + match[0].length - 1);
    if (receiver !== undefined && text !== undefined) receiver.prefix = joinPaths(receiver.prefix, text);
  }
  return found;
}

// ---- the calls ----

const VERBS = 'get|post|put|patch|delete|del|head|options|all';
const CALL = new RegExp(`(?<![\\w$.])(?:this\\s*\\.\\s*)?([A-Za-z_$][\\w$]{0,60})\\s*\\.\\s*(${VERBS}|route|use|register)\\s*(?:<[^<>()]{0,200}>)?\\s*\\(`, 'g');
const CHAIN = new RegExp(`\\)\\s*\\.\\s*(${VERBS})\\s*(?:<[^<>()]{0,200}>)?\\s*\\(`, 'g');
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MEMBER = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*){0,3}$/;

/** The strings of an array written in an argument: `['/a', '/b']`. */
function stringsIn(text: string): string[] {
  const list: string[] = [];
  for (const match of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n]){0,200})\1/g)) {
    if (!(match[2] as string).includes('${')) list.push(match[2] as string);
    if (list.length >= 5) break;
  }
  return list;
}

/** Where a chain of calls (`new Elysia().get('/a', h).get('/b', h)`) starts: the name of a receiver, or the framework that makes one. */
function chainRoot(prepared: Prepared, closeAt: number): { kind: 'var'; name: string } | { kind: 'new'; name: string; openAt: number } | undefined {
  const masked = prepared.masked;
  let close = closeAt;
  for (let hop = 0; hop < 80; hop++) {
    const openAt = prepared.open[close] ?? -1;
    if (openAt < 0) return undefined;
    const method = identBefore(masked, openAt);
    if (method === undefined) return undefined;
    let at = method.start;
    while (at > 0 && isSpace(masked.charCodeAt(at - 1))) at--;
    if (masked[at - 1] === '.') {
      at--;
      while (at > 0 && isSpace(masked.charCodeAt(at - 1))) at--;
      if (masked[at - 1] === ')') { close = at - 1; continue; }
      const object = identBefore(masked, at);
      return object === undefined ? undefined : { kind: 'var', name: object.name };
    }
    if (/\bnew\s*$/.test(masked.slice(Math.max(0, method.start - 8), method.start))) return { kind: 'new', name: method.name, openAt };
    return undefined;
  }
  return undefined;
}

export function scanJs(file: SourceFile, resolve: Resolve): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'js');
  result.longLines = prepared.longLines;
  const clean = prepared.clean;
  const frameworks = frameworksOf(clean);
  if (/@nestjs\//.test(clean)) scanNest(file, prepared, result);
  if (frameworks.length === 0) return result;
  const primary = frameworks[0] as string;
  const receivers = receiversOf(prepared, primary, frameworks);
  const imports = importsOf(clean);
  result.exports = exportsOf(clean);
  const group = groupFromFile(file.path);
  const seenMounts = new Set<string>();

  const receiverFor = (name: string): Receiver | undefined => {
    const bound = receivers.get(name);
    if (bound !== undefined) return bound;
    return CONVENTIONAL.has(name) ? { name, framework: primary, kind: 'router', prefix: '' } : undefined;
  };

  const lastHandler = (openAt: number, ranges: readonly (readonly [number, number])[]): string | undefined => {
    const last = ranges[ranges.length - 1];
    const closeAt = prepared.close[openAt] ?? -1;
    if (last === undefined || closeAt < 0 || ranges.length < 2 || clean.slice(last[1], closeAt).trim() !== '') return undefined;
    const text = clean.slice(last[0], last[1]);
    return MEMBER.test(text) ? text.replace(/\s+/g, '') : undefined;
  };

  const add = (receiver: Receiver, name: string, verb: string, paths: readonly string[], at: number, handler: string | undefined): void => {
    const method = methodOf(verb);
    if (method === undefined) return;
    for (const path of paths) {
      if (result.routes.length > ROUTE_LIMITS.routes) return;
      if (method.any) result.anyRoutes++;
      result.routes.push(makeRoute({
        method: method.method, path: joinPaths(receiver.prefix, colonParams(path)), framework: receiver.framework, group, file: file.path, line: lineOf(prepared, at),
        handler, receiver: name, receiverKind: receiver.kind
      }));
    }
  };

  /** `get('/users/:id', handler)` on a receiver: the arguments start at `openAt`. */
  const verbCall = (receiver: Receiver, name: string, verb: string, openAt: number, at: number): void => {
    const ranges = argRanges(prepared, openAt, { max: 8, scan: 600 });
    const first = ranges[0];
    if (first === undefined) return;
    let paths: string[] | undefined;
    const direct = stringArg(prepared, first);
    if (direct !== undefined) {
      if (direct.startsWith('/')) paths = [direct];
      else {
        // The name of a route first (Koa): `router.get('users', '/users', handler)`.
        const second = ranges[1] === undefined ? undefined : stringArg(prepared, ranges[1]);
        if (second !== undefined && second.startsWith('/')) paths = [second];
      }
    } else if (clean[first[0]] === '[') {
      paths = stringsIn(clean.slice(first[0], first[1])).filter(item => item.startsWith('/'));
    } else if (ranges.length >= 2) result.computed++;
    if (paths === undefined || paths.length === 0) return;
    add(receiver, name, verb, paths, at, lastHandler(openAt, ranges));
  };

  /** `route('/x').get(h).post(h)` on an Express receiver: the verbs that follow. */
  const routeChain = (receiver: Receiver, name: string, openAt: number): void => {
    const path = firstString(prepared, openAt);
    const closeAt = prepared.close[openAt] ?? -1;
    if (path === undefined || !path.startsWith('/') || closeAt < 0) return;
    let cursor = closeAt + 1;
    for (let step = 0; step < 12; step++) {
      cursor = skipSpace(clean, cursor);
      if (clean[cursor] !== '.') return;
      cursor = skipSpace(clean, cursor + 1);
      const verb = identAt(clean, cursor);
      if (methodOf(verb) === undefined) return;
      const parenAt = skipSpace(clean, cursor + verb.length);
      if (clean[parenAt] !== '(') return;
      const ranges = argRanges(prepared, parenAt, { max: 8, scan: 400 });
      const last = ranges[ranges.length - 1];
      const text = last === undefined ? '' : clean.slice(last[0], last[1]);
      add(receiver, name, verb, [path], cursor, MEMBER.test(text) ? text.replace(/\s+/g, '') : undefined);
      const next = prepared.close[parenAt] ?? -1;
      if (next < 0) return;
      cursor = next + 1;
    }
  };

  /** `fastify.route({ method: 'GET', url: '/x' })`. */
  const routeObject = (receiver: Receiver, name: string, openAt: number, at: number): void => {
    const first = argRanges(prepared, openAt, { max: 1, scan: 1500 })[0];
    if (first === undefined || clean[first[0]] !== '{') return;
    const body = clean.slice(first[0], Math.min(first[1], first[0] + 1500));
    const url = /\b(?:url|path)\s*:\s*(['"`])([^'"`\n]{0,200})\1/.exec(body);
    const methods = /\bmethod\s*:\s*(\[[^\]]{0,120}\]|(['"`])\w{3,7}\2)/.exec(body);
    if (url === null || methods === null || !(url[2] as string).startsWith('/')) return;
    const verbs = [...(methods[1] as string).matchAll(/\b[A-Za-z]{3,7}\b/g)].map(item => item[0]);
    for (const verb of verbs.slice(0, 7)) add(receiver, name, verb, [url[2] as string], at, undefined);
  };

  const importEdge = (name: string): Edge['child'] | undefined => {
    const local = receivers.get(name);
    if (local !== undefined && local.kind === 'router') return { kind: 'local', name };
    const imported = imports.get(name);
    if (imported === undefined) return undefined;
    const target = resolve(file.path, imported.spec);
    return target === undefined ? undefined : { kind: 'import', file: target, name: imported.name };
  };

  const childOf = (text: string): Edge['child'] | undefined => {
    if (IDENTIFIER.test(text)) return importEdge(text);
    // `routes.default` or `routes.users` of a namespace import.
    const member = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(text);
    if (member !== null) {
      const imported = imports.get(member[1] as string);
      const target = imported === undefined ? undefined : resolve(file.path, imported.spec);
      if (imported !== undefined && target !== undefined && imported.name === undefined) return { kind: 'import', file: target, name: member[2] === 'default' ? undefined : member[2] };
    }
    const required = /^(?:await\s+)?require\s*\(\s*(['"])([^'"\n]{1,200})\1\s*\)(?:\s*\.\s*([A-Za-z_$][\w$]*))?$/.exec(text);
    if (required !== null) {
      const target = resolve(file.path, required[2] as string);
      return target === undefined ? undefined : { kind: 'import', file: target, name: required[3] === undefined || required[3] === 'default' ? undefined : required[3] };
    }
    const dynamic = /^(?:await\s+)?import\s*\(\s*(['"])([^'"\n]{1,200})\1\s*\)$/.exec(text);
    if (dynamic !== null) {
      const target = resolve(file.path, dynamic[2] as string);
      return target === undefined ? undefined : { kind: 'import', file: target, name: undefined };
    }
    return undefined;
  };

  const mount = (parent: string, prefix: string, child: Edge['child'] | undefined): void => {
    if (child === undefined) return;
    const key = `${parent}|${prefix}|${JSON.stringify(child)}`;
    if (seenMounts.has(key)) return;
    seenMounts.add(key);
    result.edges.push({ file: file.path, parent, prefix, child });
  };

  /** `app.use('/api', router)`, `app.use(router)`. */
  const useCall = (name: string, openAt: number): void => {
    const ranges = argRanges(prepared, openAt, { max: 8, scan: 600 });
    const first = ranges[0];
    if (first === undefined) return;
    const path = stringArg(prepared, first);
    const prefix = path !== undefined && path.startsWith('/') ? colonParams(path) : '';
    for (const range of path !== undefined && path.startsWith('/') ? ranges.slice(1) : ranges) mount(name, prefix, childOf(clean.slice(range[0], range[1])));
  };

  for (const match of prepared.masked.matchAll(CALL)) {
    if (result.routes.length > ROUTE_LIMITS.routes) break;
    const name = match[1] as string;
    const verb = match[2] as string;
    // `this.server.get(...)` is a route only on a name that the file made: a field of a class with a conventional name is as likely a client.
    const receiver = match[0].startsWith('this') && name !== 'this' ? receivers.get(name) : receiverFor(name);
    if (receiver === undefined) continue;
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    if (verb === 'use') useCall(name, openAt);
    else if (verb === 'register') {
      const ranges = argRanges(prepared, openAt, { max: 2, scan: 500 });
      const child = ranges[0] === undefined ? undefined : childOf(clean.slice(ranges[0][0], ranges[0][1]));
      const options = ranges[1] === undefined ? '' : clean.slice(ranges[1][0], ranges[1][1]);
      const prefix = /\bprefix\s*:\s*(['"`])([^'"`\n]{0,200})\1/.exec(options);
      mount(name, prefix === null ? '' : colonParams(prefix[2] as string), child);
    } else if (verb === 'route') {
      const ranges = argRanges(prepared, openAt, { max: 3, scan: 600 });
      if (ranges.length === 1) {
        if (clean[(ranges[0] as [number, number])[0]] === '{') routeObject(receiver, name, openAt, at);
        else routeChain(receiver, name, openAt);
      } else if (ranges.length >= 2 && receiver.framework === 'Hono') {
        const path = stringArg(prepared, ranges[0] as [number, number]);
        const sub = clean.slice((ranges[1] as [number, number])[0], (ranges[1] as [number, number])[1]);
        if (path !== undefined && path.startsWith('/')) mount(name, path, childOf(sub));
      }
    } else verbCall(receiver, name, verb, openAt, at);
  }

  if (frameworks.includes('Elysia') || frameworks.includes('Hono') || frameworks.includes('Fastify')) {
    for (const match of prepared.masked.matchAll(CHAIN)) {
      if (result.routes.length > ROUTE_LIMITS.routes) break;
      const root = chainRoot(prepared, match.index ?? 0);
      if (root === undefined) continue;
      let receiver: Receiver | undefined;
      let name = '';
      if (root.kind === 'var') { name = root.name; receiver = receiverFor(name); }
      else if (root.name === 'Elysia' || root.name === 'Hono') receiver = { name: '', framework: root.name, kind: 'router', prefix: root.name === 'Elysia' ? optionPrefix(prepared, root.openAt) : '' };
      if (receiver === undefined) continue;
      verbCall(receiver, name, match[1] as string, (match.index ?? 0) + match[0].length - 1, match.index ?? 0);
    }
  }

  const listen = /\.\s*listen\s*\(/.exec(prepared.masked);
  if (listen !== null) {
    const openAt = listen.index + listen[0].length - 1;
    const closeAt = prepared.close[openAt] ?? -1;
    if (closeAt > openAt) result.port = portIn(clean, clean.slice(openAt + 1, Math.min(closeAt, openAt + 300)));
  }
  return result;
}

/** The port a `listen(...)` is given: a number, an option, a name that is a number above, or the number that follows `||`. */
export function portIn(clean: string, args: string): number | undefined {
  const check = (text: string | undefined): number | undefined => {
    const port = text === undefined ? NaN : Number(text);
    return port >= 1 && port <= 65535 ? port : undefined;
  };
  const direct = /^\s*(?:\{[^}]{0,100}?\bport\s*:\s*)?(\d{2,5})\b/.exec(args);
  if (direct !== null) return check(direct[1]);
  const fallback = /(?:\|\||\?\?)\s*(\d{2,5})\b/.exec(args);
  if (fallback !== null) return check(fallback[1]);
  const name = /^\s*(?:\{[^}]{0,100}?\bport\s*:\s*)?([A-Za-z_$][\w$]*)/.exec(args);
  if (name === null) return undefined;
  const declared = new RegExp(`\\b(?:const|let|var)\\s+${(name[1] as string).replace(/\$/g, '\\$')}\\s*(?::\\s*\\w+\\s*)?=\\s*(?:[^;\\n]{0,80}?(?:\\|\\||\\?\\?)\\s*)?(\\d{2,5})\\b`).exec(clean);
  return declared === null ? undefined : check(declared[1]);
}
