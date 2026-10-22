import { emptyResult, makeRoute, methodOf, type FileResult } from './internal';
import { braceParams, colonParams, groupFromFile, joinPaths } from './paths';
import { argRanges, identAt, indexWithin, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type RouteMethod, type SourceFile } from './types';

/**
 * Go: gin and echo (`r.GET("/users/:id", h)`), fiber and chi (`r.Get("/users/{id}", h)`), gorilla/mux (`r.HandleFunc("/users", h).Methods("GET")`), httprouter and
 * `net/http` (`mux.HandleFunc("GET /users/{id}", h)`, with the method in the pattern since Go 1.22). A group is a variable (`v1 := r.Group("/v1")`) or the
 * function of a chi `Route`, whose parameter is the router inside it.
 */
const MODULES: readonly [RegExp, string][] = [
  [/"github\.com\/gin-gonic\/gin"/, 'Gin'],
  [/"github\.com\/labstack\/echo(?:\/v\d+)?"/, 'Echo'],
  [/"github\.com\/gofiber\/fiber(?:\/v\d+)?"/, 'Fiber'],
  [/"github\.com\/go-chi\/chi(?:\/v\d+)?"/, 'chi'],
  [/"github\.com\/gorilla\/mux"/, 'gorilla/mux'],
  [/"github\.com\/julienschmidt\/httprouter"/, 'httprouter'],
  [/"net\/http"/, 'net/http']
];
const CALL = /(?<![\w.])([A-Za-z_]\w{0,60})\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|Any|All|Handle|HandleFunc|Route|Mount|Group)\s*\(/g;
const BIND = /\b([A-Za-z_]\w{0,60})\s*:?=\s*([A-Za-z_]\w{0,60})\s*\.\s*(Group|PathPrefix)\s*\(/g;
const PATTERN = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?:[^\s/]*)(\/.*)$/;
const MEMBER = /^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*){0,3}$/;
const CLIENT_NAMES = new Set(['client', 'resp', 'req', 'res', 'ctx', 'c', 'cache', 'm', 'cfg', 'config', 'viper', 'os', 'env', 'strings']);

const MAX_SCOPES = 200;

interface Scope {
  start: number;
  end: number;
  param: string;
  prefix: string;
}

function frameworksOf(clean: string): string[] {
  return MODULES.filter(([pattern]) => pattern.test(clean)).map(([, name]) => name);
}

/** The name of the router that a function takes (`func(r chi.Router)`), between the parentheses at `openAt`. */
function parameterName(prepared: Prepared, openAt: number): string {
  const closeAt = prepared.close[openAt] ?? -1;
  if (closeAt < 0) return '';
  const found = /^\s*([A-Za-z_]\w*)\s+[\w.*]*Router\b/.exec(prepared.clean.slice(openAt + 1, closeAt));
  return found === null ? '' : (found[1] as string);
}

export function scanGo(file: SourceFile): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'go');
  result.longLines = prepared.longLines;
  const { masked, clean } = prepared;
  const frameworks = frameworksOf(clean);
  if (frameworks.length === 0) return result;
  const routers = frameworks.filter(name => name !== 'net/http');
  const group = groupFromFile(file.path);
  const groups = new Map<string, string>();
  const scopes: Scope[] = [];
  let cappedScopes = false;
  const prefixFor = (receiver: string, at: number): string => {
    let inner: Scope | undefined;
    for (const scope of scopes) if (scope.param === receiver && scope.start < at && at < scope.end && (inner === undefined || scope.start > inner.start)) inner = scope;
    return inner === undefined ? (groups.get(receiver) ?? '') : inner.prefix;
  };
  const frameworkFor = (verb: string): string => {
    const upper = verb === verb.toUpperCase();
    const named = routers.find(name => (upper ? name === 'Gin' || name === 'Echo' || name === 'httprouter' : name === 'chi' || name === 'Fiber' || name === 'gorilla/mux'));
    return named ?? routers[0] ?? 'net/http';
  };

  // `v1 := r.Group("/v1")` and `api := r.PathPrefix("/api").Subrouter()`.
  for (const match of masked.matchAll(BIND)) {
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const first = argRanges(prepared, openAt, { max: 1, scan: 300 })[0];
    const prefix = first === undefined ? undefined : stringArg(prepared, first);
    if (prefix !== undefined) groups.set(match[1] as string, joinPaths(prefixFor(match[2] as string, at), prefix));
  }
  // The functions of chi: `r.Route("/users", func(r chi.Router) {...})`.
  for (const match of masked.matchAll(/(?<![\w.])([A-Za-z_]\w{0,60})\s*\.\s*(Route|Group)\s*\(/g)) {
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const closeAt = prepared.close[openAt] ?? -1;
    if (closeAt < 0) continue;
    const ranges = argRanges(prepared, openAt, { max: 2, scan: 300 });
    const path = ranges[0] === undefined ? undefined : stringArg(prepared, ranges[0]);
    const funcAt = indexWithin(masked, 'func', openAt, Math.min(closeAt, openAt + 400));
    if (funcAt < 0) continue;
    const paramsAt = indexWithin(masked, '(', funcAt, Math.min(closeAt, funcAt + 20));
    if (paramsAt < 0) continue;
    const param = parameterName(prepared, paramsAt);
    const afterParams = prepared.close[paramsAt] ?? paramsAt;
    const brace = indexWithin(masked, '{', afterParams, Math.min(closeAt, afterParams + 100));
    const end = brace < 0 ? -1 : (prepared.close[brace] ?? -1);
    if (param === '' || end < 0) continue;
    if (match[2] === 'Route' && path === undefined) continue;
    // The groups that are looked at are limited: every route is placed among them, and a hostile file could make that a square.
    if (scopes.length >= MAX_SCOPES) { cappedScopes = true; break; }
    scopes.push({ start: brace, end, param, prefix: joinPaths(prefixFor(match[1] as string, at), path ?? '') });
  }
  if (cappedScopes) result.notes.push(`More than ${MAX_SCOPES} groups of routes (Route, Group) in a file: the later ones were not followed, so their routes can lack a prefix.`);

  for (const match of masked.matchAll(CALL)) {
    if (result.routes.length > ROUTE_LIMITS.routes) break;
    const receiver = match[1] as string;
    const verb = match[2] as string;
    if (verb === 'Route' || verb === 'Group' || verb === 'Mount') continue;
    if (CLIENT_NAMES.has(receiver)) continue;
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const handlerStyle = verb === 'Handle' || verb === 'HandleFunc';
    if (receiver === 'http' && !handlerStyle) continue;
    if (receiver !== 'http' && routers.length === 0 && !handlerStyle) continue;
    const ranges = argRanges(prepared, openAt, { max: 4, scan: 600 });
    const first = ranges[0];
    if (first === undefined) continue;
    const raw = stringArg(prepared, first);
    if (raw === undefined) { if (ranges.length >= 2 && (handlerStyle || verb === verb.toUpperCase() || routers.length > 0)) result.computed++; continue; }
    let method: RouteMethod | undefined;
    let any = false;
    let path = raw;
    if (handlerStyle) {
      const pattern = PATTERN.exec(raw);
      if (pattern !== null) { method = pattern[1] as RouteMethod; path = pattern[2] as string; } else { method = 'GET'; any = true; }
    } else {
      const known = methodOf(verb);
      if (known === undefined) continue;
      method = known.method;
      any = known.any;
    }
    if (!path.startsWith('/')) continue;
    // gorilla/mux: the methods come after the call, `.Methods("GET", "POST")`.
    let methods: RouteMethod[] = [method];
    if (handlerStyle && any) {
      let cursor = (prepared.close[openAt] ?? -1) + 1;
      for (let step = 0; step < 6 && cursor > 0; step++) {
        cursor = skipSpace(masked, cursor);
        if (masked[cursor] !== '.') break;
        cursor = skipSpace(masked, cursor + 1);
        const word = identAt(masked, cursor);
        const paren = skipSpace(masked, cursor + word.length);
        if (word === '' || masked[paren] !== '(') break;
        if (word === 'Methods') {
          const listed = argRanges(prepared, paren, { max: 7, scan: 300 }).map(range => stringArg(prepared, range)).map(item => (item === undefined ? undefined : methodOf(item)?.method));
          const known = listed.filter((item): item is RouteMethod => item !== undefined);
          if (known.length > 0) { methods = known; any = false; }
          break;
        }
        cursor = (prepared.close[paren] ?? -2) + 1;
      }
    }
    const last = ranges.length >= 2 ? ranges[ranges.length - 1] : undefined;
    const lastText = last === undefined ? '' : clean.slice(last[0], last[1]);
    const handler = MEMBER.test(lastText) ? lastText.replace(/\s+/g, '') : undefined;
    const closeAt = prepared.close[openAt] ?? -1;
    const handlerIsLast = last !== undefined && closeAt >= 0 && clean.slice(last[1], closeAt).trim() === '';
    for (const each of methods) {
      if (any) result.anyRoutes++;
      result.routes.push(makeRoute({
        method: each, path: colonParams(braceParams(joinPaths(prefixFor(receiver, at), path))), framework: handlerStyle && routers.length === 0 ? 'net/http' : frameworkFor(verb), group, file: file.path, line: lineOf(prepared, at),
        handler: handlerIsLast ? handler : undefined, receiver
      }));
    }
  }
  const port = /\b(?:Run|Start|Listen|ListenAndServe)\s*\(\s*"[^":\n]{0,60}:(\d{2,5})"/.exec(clean);
  if (port !== null) result.port = Number(port[1]);
  return result;
}
