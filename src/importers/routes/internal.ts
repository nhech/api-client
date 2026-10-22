import { finalizePath, pathParamNames } from './paths';
import type { DetectedRoute, RouteMethod } from './types';

/**
 * What the readers of the languages hand to `detectRoutes`: the routes of one file as they are written there, and the mounts (`app.use('/api', router)`)
 * that put the routes of one router below a prefix, so that the prefix can be added when the file of the router is another file.
 */
export interface RawRoute extends DetectedRoute {
  /** The name of the router or the application the route was registered on, in its file. */
  receiver: string;
  /** An application (the root) or a router (something that is mounted): where the receiver was not seen being made, a router. */
  receiverKind: 'app' | 'router';
}

export type EdgeChild = { kind: 'local'; name: string } | { kind: 'import'; file: string; name: string | undefined };

/** `parent.use(prefix, child)` in `file`: the routes of `child` are below `prefix` of the routes of `parent`. */
export interface Edge {
  file: string;
  parent: string;
  prefix: string;
  child: EdgeChild;
}

export interface Exports {
  default: string | undefined;
  named: Map<string, string>;
}

export interface FileResult {
  routes: RawRoute[];
  edges: Edge[];
  exports: Exports | undefined;
  /** Routes that were left out because their path is not a plain string. */
  computed: number;
  /** Routes registered for every method (`all`, `any`) and listed as GET. */
  anyRoutes: number;
  /** A port that the code says (`listen(3000)`). */
  port: number | undefined;
  /** The prefix that every route of NestJS has (`setGlobalPrefix`). */
  globalPrefix: string | undefined;
  /** A path that a framework adds by itself and that is not in the code (`/api` of `routes/api.php`): said once in the notes. */
  notes: string[];
  longLines: number;
}

export const emptyResult = (): FileResult => ({ routes: [], edges: [], exports: undefined, computed: 0, anyRoutes: 0, port: undefined, globalPrefix: undefined, notes: [], longLines: 0 });

export interface RouteInit {
  method: RouteMethod;
  path: string;
  framework: string;
  group: string;
  file: string;
  line: number;
  handler?: string | undefined;
  receiver?: string;
  receiverKind?: 'app' | 'router';
  queryParams?: string[];
  headerParams?: string[];
  body?: 'json' | 'form' | 'unknown' | undefined;
}

export function makeRoute(init: RouteInit): RawRoute {
  const path = finalizePath(init.path);
  const route: RawRoute = {
    method: init.method, path, framework: init.framework, group: init.group, file: init.file, line: init.line,
    pathParams: pathParamNames(path), queryParams: init.queryParams ?? [], headerParams: init.headerParams ?? [],
    receiver: init.receiver ?? '', receiverKind: init.receiverKind ?? 'router'
  };
  if (init.handler !== undefined && init.handler !== '') route.handler = init.handler;
  if (init.body !== undefined) route.body = init.body;
  return route;
}

/** The HTTP methods a framework names in lower case or upper case; `all` and `any` are not a method. */
export function methodOf(word: string): { method: RouteMethod; any: boolean } | undefined {
  switch (word.toLowerCase()) {
    case 'get': return { method: 'GET', any: false };
    case 'post': return { method: 'POST', any: false };
    case 'put': return { method: 'PUT', any: false };
    case 'patch': return { method: 'PATCH', any: false };
    case 'delete': case 'del': return { method: 'DELETE', any: false };
    case 'head': return { method: 'HEAD', any: false };
    case 'options': return { method: 'OPTIONS', any: false };
    case 'all': case 'any': return { method: 'GET', any: true };
    default: return undefined;
  }
}

/** A list without the names that repeat, in order. */
export function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}
