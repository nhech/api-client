import { emptyResult, makeRoute, methodOf, type FileResult } from './internal';
import { braceParams, groupFromFile, joinPaths } from './paths';
import { argRanges, identAt, indexWithin, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type RouteMethod, type SourceFile } from './types';

/**
 * Laravel: `Route::get('/users/{id}', [UserController::class, 'show'])`, the groups (`Route::prefix('api')->group(function () { ... })`,
 * `Route::group(['prefix' => 'api'], ...)`), and the routes that `Route::resource` and `Route::apiResource` make. The file `routes/api.php` has the prefix
 * `/api` that Laravel gives it by itself.
 */
interface Call {
  name: string;
  openAt: number;
  closeAt: number;
}

interface Scope {
  start: number;
  end: number;
  prefix: string;
  controller: string | undefined;
}

const TERMINALS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match', 'view', 'resource', 'apiResource', 'group']);
const RESOURCE_ACTIONS: readonly { action: string; method: RouteMethod; suffix: string; member: boolean }[] = [
  { action: 'index', method: 'GET', suffix: '', member: false },
  { action: 'create', method: 'GET', suffix: '/create', member: false },
  { action: 'store', method: 'POST', suffix: '', member: false },
  { action: 'show', method: 'GET', suffix: '', member: true },
  { action: 'edit', method: 'GET', suffix: '/edit', member: true },
  { action: 'update', method: 'PUT', suffix: '', member: true },
  { action: 'destroy', method: 'DELETE', suffix: '', member: true }
];

/** `Route::name(...)->name(...)`: the calls, in order. */
function chainFrom(prepared: Prepared, firstName: string, firstOpen: number): Call[] {
  const calls: Call[] = [];
  let name = firstName;
  let openAt = firstOpen;
  for (let step = 0; step < 14; step++) {
    const closeAt = prepared.close[openAt] ?? -1;
    if (closeAt < 0) break;
    calls.push({ name, openAt, closeAt });
    let at = skipSpace(prepared.masked, closeAt + 1);
    if (prepared.masked[at] === '?') at++;
    if (prepared.masked[at] !== '-' || prepared.masked[at + 1] !== '>') break;
    at = skipSpace(prepared.masked, at + 2);
    name = identAt(prepared.masked, at);
    const paren = skipSpace(prepared.masked, at + name.length);
    if (name === '' || prepared.masked[paren] !== '(') break;
    openAt = paren;
  }
  return calls;
}

/** The name of the class in `UserController::class`, `'App\\Http\\Controllers\\UserController'` or `'UserController@index'`. */
function classOf(text: string): { controller: string | undefined; action: string | undefined } {
  const named = /([A-Za-z_]\w*)\s*::\s*class/.exec(text);
  if (named !== null) return { controller: named[1], action: undefined };
  const literal = /^\s*(["'])([^"'\n]{0,200})\1\s*$/.exec(text);
  if (literal === null) return { controller: undefined, action: undefined };
  const value = (literal[2] as string).replace(/\\\\/g, '\\');
  const at = value.indexOf('@');
  const classPart = at < 0 ? value : value.slice(0, at);
  const last = classPart.split('\\').pop() ?? classPart;
  return /^[A-Z]\w*$/.test(last) ? { controller: last, action: at < 0 ? undefined : value.slice(at + 1) } : { controller: undefined, action: value };
}

/** The name of the parameter of a resource: `categories` is `{category}`, `addresses` is `{address}`, as Laravel writes it. */
function singular(word: string): string {
  if (word === 'news') return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(word)) return word;
  if (/(?:sses|uses|ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  return word.replace(/s$/, '');
}

/** The names a call lists: `->only(['index', 'show'])`. */
function listedNames(prepared: Prepared, call: Call): string[] {
  return [...prepared.clean.slice(call.openAt, call.closeAt).matchAll(/(["'])([A-Za-z]{2,20})\1/g)].map(item => item[2] as string);
}

const MAX_SCOPES = 200;

export function scanPhp(file: SourceFile): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'php');
  result.longLines = prepared.longLines;
  const { masked, clean } = prepared;
  if (!/\bRoute\s*::/.test(masked)) return result;
  const scopes: Scope[] = [];
  const pending: { calls: Call[]; at: number; own: string[]; controller: string | undefined }[] = [];
  for (const match of masked.matchAll(/\bRoute\s*::\s*([A-Za-z_]\w*)\s*\(/g)) {
    const at = match.index ?? 0;
    const calls = chainFrom(prepared, match[1] as string, at + match[0].length - 1);
    if (calls.length === 0) continue;
    const terminalIndex = calls.findIndex(call => TERMINALS.has(call.name));
    const terminal = terminalIndex < 0 ? undefined : (calls[terminalIndex] as Call);
    const own: string[] = [];
    let controller: string | undefined;
    for (const call of calls.slice(0, terminalIndex < 0 ? calls.length : terminalIndex)) {
      const first = argRanges(prepared, call.openAt, { max: 1, scan: 300 })[0];
      if (call.name === 'prefix' && first !== undefined) own.push(stringArg(prepared, first) ?? '');
      else if (call.name === 'controller' && first !== undefined) controller = classOf(clean.slice(first[0], first[1])).controller;
    }
    if (terminal === undefined) continue;
    if (terminal.name === 'group') {
      // `Route::group(['prefix' => 'api'], function () {...})`: the prefix is in the array.
      const ranges = argRanges(prepared, terminal.openAt, { max: 3, scan: 600 });
      const array = ranges[0] === undefined ? undefined : /^\[/.test(clean.slice(ranges[0][0], ranges[0][1])) ? clean.slice(ranges[0][0], ranges[0][1]) : undefined;
      if (array !== undefined) {
        const prefix = /(["'])prefix\1\s*=>\s*(["'])([^"'\n]{0,200})\2/.exec(array);
        if (prefix !== null) own.push(prefix[3] as string);
        const named = /(["'])controller\1\s*=>\s*([^,\]]{0,100})/.exec(array);
        if (named !== null) controller = classOf(named[2] as string).controller ?? controller;
      }
      const brace = indexWithin(masked, '{', terminal.openAt, Math.min(terminal.closeAt, terminal.openAt + 2000));
      const end = brace < 0 ? -1 : (prepared.close[brace] ?? -1);
      // The groups that are looked at are limited: every route is placed among them, and a hostile file could make that a square.
      if (end >= 0 && scopes.length < MAX_SCOPES) scopes.push({ start: brace, end, prefix: joinPaths(...own), controller });
      else if (end >= 0 && !result.notes.some(note => note.startsWith('More than'))) result.notes.push(`More than ${MAX_SCOPES} groups of routes (Route::group) in a file: the later ones were not followed, so their routes can lack a prefix.`);
      continue;
    }
    // What `prefix` and `controller` said before the verb belongs to this route only.
    pending.push({ calls: calls.slice(terminalIndex), at, own, controller });
  }
  const fromApi = /(?:^|\/)routes\/api\.php$/.test(file.path);
  if (fromApi) result.notes.push('Laravel gives the routes of routes/api.php the prefix /api by itself: it is added to them here.');
  const group = groupFromFile(file.path);
  for (const item of pending) {
    if (result.routes.length > ROUTE_LIMITS.routes) break;
    const [terminal, ...rest] = item.calls as [Call, ...Call[]];
    const enclosing = scopes.filter(scope => scope.start < item.at && item.at < scope.end).sort((a, b) => a.start - b.start);
    const prefix = joinPaths(...(fromApi ? ['api'] : []), ...enclosing.map(scope => scope.prefix), ...item.own);
    const controller = item.controller ?? [...enclosing].reverse().find(scope => scope.controller !== undefined)?.controller;
    const ranges = argRanges(prepared, terminal.openAt, { max: 4, scan: 800 });
    const line = lineOf(prepared, item.at);
    const push = (method: RouteMethod, path: string, handler: string | undefined, name: string | undefined, any = false): void => {
      if (any) result.anyRoutes++;
      result.routes.push(makeRoute({ method, path: braceParams(joinPaths(prefix, path)), framework: 'Laravel', group: name ?? controller ?? group, file: file.path, line, handler }));
    };
    const action = (range: readonly [number, number] | undefined): { controller: string | undefined; handler: string | undefined } => {
      if (range === undefined) return { controller: undefined, handler: undefined };
      const text = clean.slice(range[0], range[1]);
      if (text.startsWith('[')) {
        const pair = classOf(text);
        const second = /,\s*(["'])([A-Za-z_]\w*)\1/.exec(text);
        return { controller: pair.controller, handler: second === null ? undefined : (second[2] as string) };
      }
      const pair = classOf(text);
      return { controller: pair.controller, handler: pair.action };
    };
    if (terminal.name === 'resource' || terminal.name === 'apiResource') {
      const nameText = ranges[0] === undefined ? undefined : stringArg(prepared, ranges[0]);
      if (nameText === undefined) { result.computed++; continue; }
      const target = action(ranges[1]);
      const parts = nameText.split('.').filter(part => part !== '');
      const base = parts.map((part, index) => (index < parts.length - 1 ? `${part}/{${singular(part)}}` : part)).join('/');
      const last = parts[parts.length - 1] ?? nameText;
      const only = rest.find(call => call.name === 'only');
      const except = rest.find(call => call.name === 'except');
      for (const entry of RESOURCE_ACTIONS) {
        if (terminal.name === 'apiResource' && (entry.action === 'create' || entry.action === 'edit')) continue;
        if (only !== undefined && !listedNames(prepared, only).includes(entry.action)) continue;
        if (except !== undefined && listedNames(prepared, except).includes(entry.action)) continue;
        push(entry.method, `${base}${entry.member ? `/{${singular(last)}}` : ''}${entry.suffix}`, entry.action, target.controller ?? controller);
      }
      continue;
    }
    if (terminal.name === 'match') {
      const methods = ranges[0] === undefined ? [] : [...clean.slice(ranges[0][0], ranges[0][1]).matchAll(/(["'])([A-Za-z]{3,7})\1/g)].map(entry => methodOf(entry[2] as string)?.method).filter((entry): entry is RouteMethod => entry !== undefined);
      const path = ranges[1] === undefined ? undefined : stringArg(prepared, ranges[1]);
      if (path === undefined) { result.computed++; continue; }
      const target = action(ranges[2]);
      for (const method of methods) push(method, path, target.handler, target.controller);
      continue;
    }
    const path = ranges[0] === undefined ? undefined : stringArg(prepared, ranges[0]);
    if (path === undefined) { if (ranges.length > 0) result.computed++; continue; }
    if (terminal.name === 'view') { push('GET', path, undefined, undefined); continue; }
    const target = action(ranges[1]);
    const method = methodOf(terminal.name);
    if (method === undefined) continue;
    push(method.method, path, target.handler, target.controller, method.any);
  }
  return result;
}
