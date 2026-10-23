import { compareCodePoints, printable } from '../util/chars';

/**
 * Finding the OpenAPI and Swagger descriptions that a project already has, to offer them in a list. The start of a file is enough to tell: the version key
 * (`openapi: 3.0.3`, `"swagger": "2.0"`) and one of the keys that a description has (`info`, `paths`, `components`, `definitions`). Nothing here reads a file or
 * runs anything; whoever searches the project gives it the first bytes of each file.
 */

/** How many bytes of the start of a file are looked at. */
export const SNIFF_BYTES = 8192;

/** The extensions of a file that can be a description. */
export const OPENAPI_EXTENSIONS: readonly string[] = ['.json', '.yaml', '.yml'];

/**
 * The folders that hold what other people made (packages, virtual environments, tools): the descriptions in them are not the project's own, and there are
 * thousands. What is built (`dist`, `build`, `target`) is not here: a description that the program writes when it is built is worth offering.
 */
export const OPENAPI_SKIPPED_FOLDERS: readonly string[] = [
  'node_modules', 'vendor', 'venv', '.venv', 'site-packages', '__pycache__', '.git', '.gradle', '.idea', '.vscode', '.vs', '.mvn', '.next', '.nuxt', 'coverage'
];

/** The folders that hold what is built: a description in one of them is listed after the ones that are written by hand. */
const BUILT_FOLDERS: ReadonlySet<string> = new Set(['dist', 'build', 'out', 'target', 'bin', 'obj']);

/** A name that says what the file is: `openapi.json`, `swagger.yaml`, `api-docs.json`, `petstore.openapi.yml`, `oas3.yaml`. */
const NAME = /(?:openapi|swagger|api[-_.]?docs?|(?:^|[-_.])oas[0-9]?(?:$|[-_.]))/i;

export interface OpenApiHit {
  kind: 'OpenAPI' | 'Swagger';
  version: string;
  /** The title of the API, when the start of the file has it; may be empty. */
  title: string;
}

const lowerExtension = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
};

/** Whether the path is a file that can be a description (by its extension) and is not in a folder that holds what other people made. */
export function isOpenApiCandidate(path: string): boolean {
  if (!OPENAPI_EXTENSIONS.includes(lowerExtension(path))) return false;
  return !path.split('/').slice(0, -1).some(folder => OPENAPI_SKIPPED_FOLDERS.includes(folder.toLowerCase()));
}

/** Whether the name of the file says that it is a description. */
export function isOpenApiName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return NAME.test(dot < 0 ? name : name.slice(0, dot));
}

/** A plain or quoted YAML value on one line: a quoted one ends at its closing quote (a `#` inside it is text), a plain one at a comment. */
const unquote = (text: string): string => {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
};

/** The first title after `info`, as the person would read it. */
function titleOf(head: string, json: boolean): string {
  if (json) {
    const info = /"info"\s*:\s*\{/.exec(head);
    const found = info === null ? null : /"title"\s*:\s*"((?:[^"\\\n]|\\.){0,120})"/.exec(head.slice(info.index));
    if (found === null) return '';
    try { return printable(JSON.parse(`"${found[1] as string}"`) as string).trim(); } catch { return printable(found[1] as string).trim(); }
  }
  const info = /^info\s*:/m.exec(head);
  const found = info === null ? null : /^[ \t]+title\s*:[ \t]*(.{1,200})$/m.exec(head.slice(info.index));
  return found === null ? '' : printable(unquote(found[1] as string)).trim().slice(0, 120);
}

/**
 * Whether the start of a file is the start of a description that this client can import (Swagger 2.0, OpenAPI 3.x). A file that the name already speaks for
 * (`byName`) needs only the version key; any other also has to have one of the keys that a description has, so that a settings file that mentions
 * "swagger" is not offered.
 */
export function sniffOpenApi(head: string, byName: boolean): OpenApiHit | undefined {
  const text = head.replace(/^\ufeff/, '');
  const json = text.trimStart().startsWith('{');
  const version = json ? /"(openapi|swagger)"\s*:\s*"?(\d+(?:\.\d+){0,2})"?/.exec(text) : /^(openapi|swagger)\s*:[ \t]*['"]?(\d+(?:\.\d+){0,2})/m.exec(text);
  if (version === null) return undefined;
  const key = version[1] as string;
  const number = version[2] as string;
  if (key === 'openapi' ? !number.startsWith('3') : !/^2(?:\.0)?$/.test(number)) return undefined;
  if (!byName && !(json ? /"(?:info|paths|components|definitions)"\s*:/ : /^(?:info|paths|components|definitions)\s*:/m).test(text)) return undefined;
  return { kind: key === 'openapi' ? 'OpenAPI' : 'Swagger', version: number, title: titleOf(text, json) };
}

export interface FoundOpenApi extends OpenApiHit {
  /** Relative to the folder of the workspace, with forward slashes. */
  path: string;
  byName: boolean;
}

/** The most that is listed. */
export const MAX_LISTED = 200;

/**
 * The files in the order that serves the person: a file whose name says it is a description first, the ones written by hand before the ones that a build makes,
 * the ones nearer the root first, then by path so that the order never depends on the order the search found them in.
 */
export function rankOpenApi(files: readonly FoundOpenApi[]): { list: FoundOpenApi[]; more: number } {
  const built = (file: FoundOpenApi): boolean => file.path.split('/').slice(0, -1).some(folder => BUILT_FOLDERS.has(folder.toLowerCase()));
  const sorted = [...files].sort((a, b) =>
    Number(b.byName) - Number(a.byName) || Number(built(a)) - Number(built(b)) || a.path.split('/').length - b.path.split('/').length || compareCodePoints(a.path, b.path));
  return { list: sorted.slice(0, MAX_LISTED), more: Math.max(0, sorted.length - MAX_LISTED) };
}

/** What the list says about one file, on one line: `OpenAPI 3.0.3 - Pet Store`. */
export const describeOpenApi = (file: OpenApiHit): string => `${file.kind} ${file.version}${file.title === '' ? '' : ` - ${file.title}`}`;
