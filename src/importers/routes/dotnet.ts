import { emptyResult, makeRoute, methodOf, unique, type FileResult } from './internal';
import { braceParams, joinPaths, pathParamNames } from './paths';
import { argRanges, identBefore, indexWithin, isSpace, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type SourceFile } from './types';

/**
 * ASP.NET Core: a controller (a class with `[ApiController]`, or named `...Controller`) with `[Route("api/[controller]")]` and actions with `[HttpGet("{id}")]`,
 * and the minimal APIs, `app.MapGet("/users", ...)`, also on a group (`var api = app.MapGroup("/api")`). `[controller]` is the name of the class without
 * `Controller`, as ASP.NET writes it, and `[action]` the name of the method.
 */
const SIMPLE = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'string', 'Guid', 'DateTime', 'DateTimeOffset', 'DateOnly', 'TimeOnly', 'TimeSpan']);
const IGNORED_TYPES = new Set(['CancellationToken', 'HttpContext', 'HttpRequest', 'HttpResponse', 'ClaimsPrincipal', 'object', 'dynamic']);
const HTTP = /\bHttp(Get|Post|Put|Delete|Patch|Head|Options)\b/g;

interface Attribute {
  name: string;
  /** The first argument when it is a string. */
  template: string | undefined;
  /** Whether it has an argument, and whether that is a string. */
  argument: 'none' | 'string' | 'other';
  text: string;
}

/** The attributes of the list that starts at `listAt` (`[HttpGet("x"), Authorize]`). */
function attributesOf(prepared: Prepared, listAt: number): Attribute[] {
  const found: Attribute[] = [];
  for (const range of argRanges(prepared, listAt, { max: 10, scan: 600 })) {
    const text = prepared.clean.slice(range[0], range[1]);
    const name = /^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)/.exec(text);
    if (name === null) continue;
    const paren = indexWithin(prepared.clean, '(', range[0], range[1]);
    let template: string | undefined;
    let argument: Attribute['argument'] = 'none';
    if (paren >= 0 && paren < range[1] && (prepared.close[paren] ?? -1) > 0) {
      const first = argRanges(prepared, paren, { max: 1, scan: 300 })[0];
      template = first === undefined ? undefined : stringArg(prepared, first);
      // An argument that is not a string and is not `Name = "x"` is a constant or an expression.
      if (template !== undefined) argument = 'string';
      else if (first !== undefined && first[1] > first[0] && !/^[A-Za-z_]\w*\s*=(?!=)/.test(prepared.clean.slice(first[0], first[1]))) argument = 'other';
    }
    found.push({ name: name[1] as string, template, argument, text });
  }
  return found;
}

/** The `[` of the attribute lists that stand one after the other just before `at`, nearest first. */
function listsBefore(prepared: Prepared, at: number): number[] {
  const lists: number[] = [];
  let cursor = at;
  for (let step = 0; step < 8; step++) {
    let end = cursor;
    while (end > 0 && isSpace(prepared.masked.charCodeAt(end - 1))) end--;
    if (prepared.masked[end - 1] !== ']') return lists;
    const start = prepared.open[end - 1] ?? -1;
    if (start < 0) return lists;
    lists.push(start);
    cursor = start;
  }
  return lists;
}

function parametersOf(prepared: Prepared, openAt: number, pathNames: readonly string[], inferBody: boolean): { query: string[]; header: string[]; body: 'json' | 'form' | undefined } {
  const query: string[] = [];
  const header: string[] = [];
  let body: 'json' | 'form' | undefined;
  for (const range of argRanges(prepared, openAt, { max: 25, scan: 4000, angles: true })) {
    const text = prepared.clean.slice(range[0], range[1]);
    const attributes = [...text.matchAll(/\[([^\]]{0,300})\]/g)].flatMap(item => [...(item[1] as string).matchAll(/([A-Za-z_]\w*)\s*(?:\(([^)]{0,200})\))?/g)]);
    const bare = text.replace(/\[[^\]]{0,300}\]/g, ' ').replace(/=[\s\S]*$/, '').trim().replace(/\b(?:this|ref|out|in|params)\s+/g, '');
    const name = identBefore(bare, bare.length)?.name ?? '';
    const type = bare.slice(0, bare.length - name.length).trim().replace(/\?$/, '').replace(/<[\s\S]*$/, '');
    const from = (kind: string): { name: string | undefined } | undefined => {
      const hit = attributes.find(item => item[1] === kind);
      if (hit === undefined) return undefined;
      const named = /\bName\s*=\s*"([^"\n]{0,100})"/.exec(hit[2] ?? '') ?? /^\s*"([^"\n]{0,100})"/.exec(hit[2] ?? '');
      return { name: named === null ? undefined : (named[1] as string) };
    };
    if (from('FromBody') !== undefined) { body = body ?? 'json'; continue; }
    if (from('FromForm') !== undefined) { body = 'form'; continue; }
    const fromQuery = from('FromQuery');
    if (fromQuery !== undefined) { const queryName = fromQuery.name ?? name; if (queryName !== '') query.push(queryName); continue; }
    const fromHeader = from('FromHeader');
    if (fromHeader !== undefined) { const headerName = fromHeader.name ?? name; if (headerName !== '') header.push(headerName); continue; }
    if (from('FromRoute') !== undefined || from('FromServices') !== undefined || from('FromKeyedServices') !== undefined) continue;
    if (name === '' || type === '' || pathNames.includes(name) || IGNORED_TYPES.has(type)) continue;
    if (type === 'IFormFile' || type === 'IFormFileCollection') { body = 'form'; continue; }
    if (SIMPLE.has(type)) query.push(name);
    else if (inferBody && /^[A-Z]/.test(type) && !/^I[A-Z]/.test(type)) body = body ?? 'json';
  }
  return { query: unique(query), header: unique(header), body };
}

function controllerRoutes(file: SourceFile, prepared: Prepared, result: FileResult): void {
  const masked = prepared.masked;
  const clean = prepared.clean;
  let lastEnd = 0;
  const classes = [...masked.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)];
  for (const found of classes) {
    const classAt = found.index ?? 0;
    if (classAt < lastEnd) continue;
    const className = found[1] as string;
    const window = clean.slice(Math.max(lastEnd, classAt - 1500), classAt);
    const apiController = /\[\s*(?:[A-Za-z.]+\s*,\s*)*ApiController\b/.test(window);
    if (!apiController && !className.endsWith('Controller')) continue;
    // A base class that is not made to be used (`public abstract class BaseController`) has no routes of its own.
    if (/\babstract\b/.test(window.slice(window.lastIndexOf(']') + 1))) continue;
    let brace = -1;
    for (let cursor = classAt + found[0].length; cursor < classAt + 700; cursor++) {
      const c = masked[cursor];
      if (c === '{') { brace = cursor; break; }
      if (c === ';' || c === undefined) break;
    }
    const end = brace < 0 ? -1 : (prepared.close[brace] ?? -1);
    if (end < 0) continue;
    lastEnd = end;
    const classRoute = /\[\s*(?:[A-Za-z.]+\s*(?:\([^)]{0,100}\))?\s*,\s*)*Route\s*\(\s*"([^"\n]{0,200})"/.exec(window);
    const controllerName = className.endsWith('Controller') && className !== 'Controller' ? className.slice(0, -'Controller'.length) : className;
    // Only the body of the class is looked at, so that a file of many classes is read once.
    for (const match of masked.slice(brace, end).matchAll(HTTP)) {
      if (result.routes.length > ROUTE_LIMITS.routes) return;
      const matchAt = brace + (match.index ?? 0);
      // The attribute list that holds it.
      let listAt = -1;
      for (let back = matchAt - 1; back >= Math.max(brace, matchAt - 300); back--) {
        const c = masked[back];
        if (c === '[') { listAt = back; break; }
        if (c === ']' || c === ';' || c === '{' || c === '}') break;
      }
      const listEnd = listAt < 0 ? -1 : (prepared.close[listAt] ?? -1);
      if (listEnd < 0) continue;
      const own = attributesOf(prepared, listAt);
      const verbWord = match[1] as string;
      const verb = own.find(item => item.name === `Http${verbWord}`);
      if (verb === undefined) continue;
      const lists = [listAt, ...listsBefore(prepared, listAt)];
      // The lists after it, down to the method.
      let after = listEnd + 1;
      for (let step = 0; step < 8; step++) {
        after = skipSpace(masked, after);
        if (masked[after] !== '[') break;
        const next = prepared.close[after] ?? -1;
        if (next < 0) break;
        lists.push(after);
        after = next + 1;
      }
      let methodName: string | undefined;
      let paramsAt = -1;
      for (let cursor = after; cursor < after + 400; cursor++) {
        const c = masked[cursor];
        if (c === '(') { const name = identBefore(masked, cursor); if (name !== undefined) { methodName = name.name; paramsAt = cursor; } break; }
        if (c === '{' || c === ';' || c === '}' || c === '=' || c === undefined) break;
      }
      if (methodName === undefined) continue;
      const route = lists.flatMap(list => attributesOf(prepared, list)).find(item => item.name === 'Route');
      // A template that is a constant (`[HttpGet(Routes.Users)]`) is not known here.
      if (verb.argument === 'other' || (verb.argument === 'none' && route?.argument === 'other')) { result.computed++; continue; }
      const template = (verb.template ?? route?.template ?? '').replace(/\[controller\]/gi, controllerName).replace(/\[action\]/gi, methodName);
      let path: string;
      if (template.startsWith('~/')) path = template.slice(2);
      else if (template.startsWith('/')) path = template;
      else path = joinPaths((classRoute?.[1] ?? '').replace(/\[controller\]/gi, controllerName).replace(/\[action\]/gi, methodName), template);
      path = braceParams(path.replace(/\[area\]/gi, ''));
      const names = pathParamNames(path.startsWith('/') ? path : `/${path}`);
      const params = parametersOf(prepared, paramsAt, names, apiController);
      const method = methodOf(verbWord);
      if (method === undefined) continue;
      result.routes.push(makeRoute({
        method: method.method, path: joinPaths(path), framework: 'ASP.NET Core', group: className, file: file.path, line: lineOf(prepared, matchAt),
        handler: methodName, queryParams: params.query, headerParams: params.header, body: params.body
      }));
    }
  }
}

const MINIMAL = /(?<![\w.])([A-Za-z_]\w{0,60})\s*\.\s*Map(Get|Post|Put|Delete|Patch)\s*\(/g;
const GROUP = /\b([A-Za-z_]\w{0,60})\s*=\s*([A-Za-z_]\w{0,60})\s*\.\s*MapGroup\s*\(/g;

function minimalRoutes(file: SourceFile, prepared: Prepared, result: FileResult): void {
  const masked = prepared.masked;
  const groups = new Map<string, string>();
  for (const match of masked.matchAll(GROUP)) {
    const openAt = (match.index ?? 0) + match[0].length - 1;
    const first = argRanges(prepared, openAt, { max: 1, scan: 300 })[0];
    const prefix = first === undefined ? undefined : stringArg(prepared, first);
    if (prefix === undefined) { result.computed++; continue; }
    groups.set(match[1] as string, joinPaths(groups.get(match[2] as string) ?? '', prefix));
  }
  const group = file.path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? file.path;
  for (const match of masked.matchAll(MINIMAL)) {
    if (result.routes.length > ROUTE_LIMITS.routes) return;
    const openAt = (match.index ?? 0) + match[0].length - 1;
    const ranges = argRanges(prepared, openAt, { max: 4, scan: 500 });
    const first = ranges[0];
    if (first === undefined) continue;
    const path = stringArg(prepared, first);
    if (path === undefined) { if (ranges.length >= 2) result.computed++; continue; }
    const handlerText = ranges[1] === undefined ? '' : prepared.clean.slice(ranges[1][0], ranges[1][1]);
    const handler = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*){0,3}$/.test(handlerText) ? handlerText : undefined;
    const full = braceParams(joinPaths(groups.get(match[1] as string) ?? '', path));
    const method = methodOf(match[2] as string);
    if (method === undefined) continue;
    result.routes.push(makeRoute({ method: method.method, path: full, framework: 'ASP.NET Core', group, file: file.path, line: lineOf(prepared, match.index ?? 0), handler }));
  }
}

export function scanDotnet(file: SourceFile): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'csharp');
  result.longLines = prepared.longLines;
  controllerRoutes(file, prepared, result);
  if (/\.\s*Map(?:Get|Post|Put|Delete|Patch)\s*\(/.test(prepared.masked)) minimalRoutes(file, prepared, result);
  return result;
}
