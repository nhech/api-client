import { guessBaseUrl } from './config';
import { scanDotnet } from './dotnet';
import { scanGo } from './go';
import { emptyResult, type Edge, type FileResult, type RawRoute } from './internal';
import { scanJs } from './js';
import { scanJvm } from './jvm';
import { joinPaths, pathParamNames } from './paths';
import { scanPhp } from './php';
import { scanPython } from './python';
import { scanRust } from './rust';
import { compareCodePoints } from '../../util/chars';
import { ROUTE_CONFIG_FILES, ROUTE_EXTENSIONS, ROUTE_LIMITS, ROUTE_METHODS, type DetectedRoute, type RoutesResult, type SourceFile } from './types';

/** The folders that hold what is built, installed or tested, not what the person wrote: the routes in them are not the routes of the project. */
const SKIPPED_FOLDERS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'venv', '.venv', 'env', '__pycache__', '.git', 'coverage', 'test', 'tests', '__tests__', 'e2e', 'spec', 'specs',
  '.next', '.nuxt', 'site-packages', '.gradle', '.mvn', '.idea', '.vs'
]);
const TEST_FILE = /(?:\.(?:test|spec)\.[A-Za-z]+$|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$|Tests?\.(?:java|kt)$|Tests\.cs$|\.d\.ts$|\.min\.js$)/;
/** The most characters of all the sources that are read: the rest is not looked at. */
const TOTAL_CHARS = 64 * 1024 * 1024;
/** A path longer than this is not a route of a program: it is what nested groups of a hostile file add up to. */
const MAX_PATH_CHARS = 2000;

export function isRouteSource(path: string): boolean {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || !ROUTE_EXTENSIONS.includes(name.slice(dot).toLowerCase())) return false;
  return !inSkippedFolder(path) && !TEST_FILE.test(path);
}

function inSkippedFolder(path: string): boolean {
  return path.split('/').slice(0, -1).some(folder => SKIPPED_FOLDERS.has(folder.toLowerCase()));
}

// ---- what a file imports, resolved to another file of the project ----

const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.mjs', '/index.cjs'];

/** The path with `.` and `..` taken out; undefined when it goes above the root. */
function normalize(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length === 0) return undefined; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

function resolveJs(paths: ReadonlySet<string>, from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const target = normalize(`${dirname(from)}/${spec}`);
  if (target === undefined) return undefined;
  // A TypeScript file that is imported with the extension of the file it becomes: './user.js' is './user.ts'.
  const stripped = target.replace(/\.(?:m|c)?js$/, '');
  for (const candidate of [target, stripped]) for (const suffix of JS_SUFFIXES) if (paths.has(candidate + suffix)) return candidate + suffix;
  return undefined;
}

/** A module of Python, `app.routers.items` or `.items`, as a file of the project: relative to the file, or by the end of its path. */
function resolvePython(paths: readonly string[], set: ReadonlySet<string>, from: string, dotted: string): string | undefined {
  const dots = /^\.*/.exec(dotted)?.[0].length ?? 0;
  const parts = dotted.slice(dots).split('.').filter(part => part !== '');
  if (dots > 0) {
    let folder = dirname(from);
    for (let level = 1; level < dots; level++) folder = dirname(folder);
    const joined = [folder, ...parts].filter(part => part !== '').join('/');
    for (const candidate of [`${joined}.py`, `${joined}/__init__.py`]) if (set.has(candidate)) return candidate;
    return undefined;
  }
  if (parts.length === 0) return undefined;
  const tail = parts.join('/');
  let best: string | undefined;
  for (const path of paths) {
    if (!(path === `${tail}.py` || path.endsWith(`/${tail}.py`) || path === `${tail}/__init__.py` || path.endsWith(`/${tail}/__init__.py`))) continue;
    if (best === undefined || path.split('/').length < best.split('/').length) best = path;
  }
  return best;
}

// ---- the prefixes of the mounts ----

class Mounts {
  private readonly memo = new Map<string, string>();
  /** The mounts of a router of the same file, by the file and the name of the router, with their place in the list of all of them. */
  private readonly local = new Map<string, { edge: Edge; order: number }[]>();
  /** The mounts of a router of another file, by the file of the router. */
  private readonly imported = new Map<string, { edge: Edge; order: number }[]>();

  constructor(edges: readonly Edge[], private readonly results: ReadonlyMap<string, FileResult>) {
    const add = (map: Map<string, { edge: Edge; order: number }[]>, key: string, entry: { edge: Edge; order: number }): void => {
      const list = map.get(key) ?? [];
      list.push(entry);
      map.set(key, list);
    };
    edges.forEach((edge, order) => {
      if (edge.child.kind === 'local') add(this.local, `${edge.file}\u0000${edge.child.name}`, { edge, order });
      else add(this.imported, edge.child.file, { edge, order });
    });
  }

  /** The prefix that the router `receiver` of `file` is mounted below, all the way up. */
  prefixOf(file: string, receiver: string, depth = 0, visiting: ReadonlySet<string> = new Set()): string {
    const key = `${file}\u0000${receiver}`;
    const known = this.memo.get(key);
    if (known !== undefined) return known;
    if (depth > 8 || visiting.has(key)) return '';
    const candidates = [...(this.local.get(key) ?? []), ...(this.imported.get(file) ?? [])].sort((a, b) => a.order - b.order);
    const edge = candidates.find(candidate => this.matches(candidate.edge, file, receiver))?.edge;
    let prefix = '';
    if (edge !== undefined) {
      const parent = this.prefixOf(edge.file, edge.parent, depth + 1, new Set([...visiting, key]));
      prefix = joinPaths(parent, edge.prefix);
      if (prefix === '/') prefix = '';
    }
    if (depth === 0) this.memo.set(key, prefix);
    return prefix;
  }

  private matches(edge: Edge, file: string, receiver: string): boolean {
    if (edge.child.kind === 'local') return edge.file === file && edge.child.name === receiver && !(edge.parent === receiver);
    if (edge.child.file !== file) return false;
    const exported = this.results.get(file)?.exports;
    if (edge.child.name === undefined) return exported?.default === undefined ? true : exported.default === receiver;
    return (exported?.named.get(edge.child.name) ?? edge.child.name) === receiver;
  }
}

// ---- the whole project ----

function scan(file: SourceFile, paths: ReadonlySet<string>, list: readonly string[]): FileResult {
  const dot = file.path.lastIndexOf('.');
  const extension = file.path.slice(dot).toLowerCase();
  const text = file.text;
  switch (extension) {
    case '.js': case '.jsx': case '.mjs': case '.cjs': case '.ts': case '.tsx': case '.mts': case '.cts':
      return /express|fastify|koa|hono|elysia|restify|@nestjs/.test(text) ? scanJs(file, (from, spec) => resolveJs(paths, from, spec)) : emptyResult();
    case '.java': case '.kt':
      return /@(?:Rest)?Controller\b/.test(text) ? scanJvm(file) : emptyResult();
    case '.cs':
      return /Controller|Map(?:Get|Post|Put|Delete|Patch)/.test(text) ? scanDotnet(file) : emptyResult();
    case '.py':
      return /fastapi|flask|urlpatterns/i.test(text) ? scanPython(file, (from, dotted) => resolvePython(list, paths, from, dotted)) : emptyResult();
    case '.php':
      return /Route\s*::/.test(text) ? scanPhp(file) : emptyResult();
    case '.go':
      return /net\/http|gin-gonic|labstack|gofiber|go-chi|gorilla|httprouter/.test(text) ? scanGo(file) : emptyResult();
    case '.rs':
      return /actix|rocket/.test(text) ? scanRust(file) : emptyResult();
    default:
      return emptyResult();
  }
}

const baseName = (path: string): string => path.split('/').pop() ?? path;

export function detectRoutes(files: readonly SourceFile[]): RoutesResult {
  const notes: string[] = [];
  const note = (message: string): void => { if (notes.length < ROUTE_LIMITS.notes && !notes.includes(message)) notes.push(message); };
  const ordered = [...files].sort((a, b) => compareCodePoints(a.path, b.path));
  const configs = ordered.filter(file => ROUTE_CONFIG_FILES.includes(baseName(file.path)) && !inSkippedFolder(file.path) && file.text.length <= ROUTE_LIMITS.fileChars);
  const eligible = ordered.filter(file => isRouteSource(file.path));
  const sources = eligible.slice(0, ROUTE_LIMITS.files);
  if (eligible.length > sources.length) note(`More than ${ROUTE_LIMITS.files} source files: the first ${ROUTE_LIMITS.files} were read.`);
  const paths = new Set(ordered.map(file => file.path));
  const list = ordered.map(file => file.path).filter(path => path.endsWith('.py'));
  const results = new Map<string, FileResult>();
  let filesRead = 0;
  let total = 0;
  let tooLarge = 0;
  let overBudget = 0;
  for (const file of sources) {
    if (file.text.length > ROUTE_LIMITS.fileChars) { tooLarge++; continue; }
    if (total + file.text.length > TOTAL_CHARS) { overBudget++; continue; }
    total += file.text.length;
    filesRead++;
    const result = scan(file, paths, list);
    if (result.routes.length > 0 || result.edges.length > 0 || result.port !== undefined || result.globalPrefix !== undefined || result.notes.length > 0 || result.longLines > 0) results.set(file.path, result);
  }

  const raw: RawRoute[] = [];
  const edges: Edge[] = [];
  let computed = 0;
  let longPaths = 0;
  let anyRoutes = 0;
  let longLines = 0;
  let codePort: number | undefined;
  let globalPrefix: string | undefined;
  for (const path of [...results.keys()].sort(compareCodePoints)) {
    const result = results.get(path) as FileResult;
    // Files that together give more routes than can be kept are not all held in memory.
    if (raw.length < ROUTE_LIMITS.routes * 2) raw.push(...result.routes.slice(0, ROUTE_LIMITS.routes * 2 - raw.length));
    edges.push(...result.edges);
    computed += result.computed;
    anyRoutes += result.anyRoutes;
    longLines += result.longLines;
    for (const message of result.notes) note(message);
    if (codePort === undefined && result.port !== undefined && result.routes.length > 0) codePort = result.port;
    if (globalPrefix === undefined && result.globalPrefix !== undefined) globalPrefix = result.globalPrefix;
  }

  const mounts = new Mounts(edges, results);
  const seen = new Set<string>();
  const routes: DetectedRoute[] = [];
  for (const route of raw) {
    let path = route.path;
    if (route.receiver !== '') {
      const prefix = mounts.prefixOf(route.file, route.receiver);
      if (prefix !== '') path = joinPaths(prefix, path);
    }
    if (route.framework === 'NestJS' && globalPrefix !== undefined) path = joinPaths(globalPrefix, path);
    if (path.length > MAX_PATH_CHARS) { longPaths++; continue; }
    const key = `${route.file}\u0000${route.method}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { receiver: _receiver, receiverKind: _kind, ...rest } = route;
    void _receiver; void _kind;
    routes.push({ ...rest, path, pathParams: pathParamNames(path) });
  }
  routes.sort((a, b) => compareCodePoints(a.file, b.file) || a.line - b.line || ROUTE_METHODS.indexOf(a.method) - ROUTE_METHODS.indexOf(b.method) || compareCodePoints(a.path, b.path));
  if (routes.length > ROUTE_LIMITS.routes) { routes.length = ROUTE_LIMITS.routes; note(`More than ${ROUTE_LIMITS.routes} routes: the first ones were kept.`); }

  const frameworks = [...new Set(routes.map(route => route.framework))].sort(compareCodePoints);
  const messages: string[] = [];
  if (routes.length === 0) messages.push('No routes were found in the source files that were read. The frameworks that are looked for: Express, Fastify, Koa, Hono, Elysia, NestJS, Spring, ASP.NET Core, FastAPI, Flask, Django, Laravel, Go (gin, echo, fiber, chi, gorilla, net/http) and Rust (Actix, Rocket).');
  else {
    messages.push('The routes were read from the text of the source files, not by running the program: a prefix that another file adds, a router that a framework registers by itself, or a path made from a constant can be missing or wrong. Read the requests before you send them.');
    messages.push(`Found in: ${frameworks.join(', ')}.`);
  }
  if (globalPrefix !== undefined && frameworks.includes('NestJS')) messages.push(`setGlobalPrefix('${globalPrefix}') was found: the prefix is added to the NestJS routes.`);
  if (computed > 0) messages.push(`${computed} ${computed === 1 ? 'route was' : 'routes were'} left out because the path is not a plain string (a constant, a concatenation).`);
  if (longPaths > 0) messages.push(`${longPaths} ${longPaths === 1 ? 'route was' : 'routes were'} left out because the path is longer than ${MAX_PATH_CHARS} characters.`);
  if (anyRoutes > 0) messages.push(`${anyRoutes} ${anyRoutes === 1 ? 'route answers' : 'routes answer'} for every method (all, any, a Django path) and ${anyRoutes === 1 ? 'is' : 'are'} listed as GET.`);
  if (tooLarge > 0) messages.push(`${tooLarge} ${tooLarge === 1 ? 'file was' : 'files were'} not read because ${tooLarge === 1 ? 'it has' : 'they have'} more than ${ROUTE_LIMITS.fileChars} characters.`);
  if (overBudget > 0) messages.push(`${overBudget} ${overBudget === 1 ? 'file was' : 'files were'} not read because the sources together are too large.`);
  if (longLines > 0) messages.push(`${longLines} ${longLines === 1 ? 'line' : 'lines'} with more than ${ROUTE_LIMITS.lineChars} characters ${longLines === 1 ? 'was' : 'were'} skipped (a minified file?).`);
  const merged = [...messages, ...notes].slice(0, ROUTE_LIMITS.notes);

  let baseUrl: string | undefined;
  if (routes.length > 0) {
    const counts = new Map<string, number>();
    for (const route of routes) counts.set(route.framework, (counts.get(route.framework) ?? 0) + 1);
    const primary = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]))[0]?.[0] ?? 'Express';
    baseUrl = guessBaseUrl(primary, configs, codePort);
  }
  return { routes, frameworks, filesRead, notes: unique(merged), baseUrl };
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}
