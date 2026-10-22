/**
 * Finding the routes of the controllers of a project by reading its source files as text. Nothing is run and nothing is resolved: a route that is
 * built from a constant, a prefix that is added by a file this code does not see, or a router that a framework adds by itself can be missing or can
 * lack a prefix. The module says so in its notes, and the person reads the requests it made before sending any.
 */
export interface SourceFile {
  /** Relative to the folder of the workspace, with forward slashes. */
  path: string;
  text: string;
}

export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const ROUTE_METHODS: readonly RouteMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface DetectedRoute {
  method: RouteMethod;
  /** Starts with `/`, the parameters are written `{name}`, no trailing slash except for `/` itself. */
  path: string;
  /** The framework the route was found in: `Express`, `NestJS`, `Spring`... */
  framework: string;
  /** The controller class, the router or the file that holds the route: it becomes a folder. */
  group: string;
  file: string;
  /** From 1. */
  line: number;
  handler?: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  /** Only when a parameter of the handler makes it plain (`@Body()`, `@RequestBody`, `[FromBody]`). */
  body?: 'json' | 'form' | 'unknown';
}

export interface RoutesResult {
  routes: DetectedRoute[];
  /** The names of the frameworks that were found, in alphabetical order. */
  frameworks: string[];
  /** How many source files were read. */
  filesRead: number;
  notes: string[];
  /** `http://localhost:<port>` from the configuration or the code, or the default of the framework; undefined when no route was found. */
  baseUrl: string | undefined;
}

/** The limits of what is read from a project: more than this is not a controller somebody wrote by hand. */
export const ROUTE_LIMITS = { files: 5000, fileChars: 1_000_000, lineChars: 2000, routes: 20_000, notes: 100, edges: 2000, totalChars: 32 * 1024 * 1024 } as const;

/** The source files that can hold a route. */
export const ROUTE_EXTENSIONS: readonly string[] = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.java', '.kt', '.cs', '.py', '.php', '.go', '.rs'];

/** The files that are read for the port and the base path, besides the sources (by their name, in any folder). */
export const ROUTE_CONFIG_FILES: readonly string[] = ['application.properties', 'application.yml', 'application.yaml', 'launchSettings.json', '.env', 'appsettings.json'];
