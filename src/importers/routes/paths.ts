import { printable } from '../../util/chars';

/**
 * The paths of routes, written the way the client writes a path: `/users/{id}`. Each framework has its own way to name a parameter (`:id`, `<int:id>`,
 * `{id:int}`, `(?P<id>...)`); they are all turned into `{id}`. Every pattern here is bounded, so that no file makes one of them run for long.
 */
/** The path without a query or a fragment: a `?` inside braces (`{id?}`) is an optional parameter, not a query. */
function withoutQuery(path: string): string {
  let depth = 0;
  for (let at = 0; at < path.length; at++) {
    const char = path[at];
    if (char === '{' || char === '(') depth++;
    else if (char === '}' || char === ')') depth = Math.max(0, depth - 1);
    else if ((char === '?' || char === '#') && depth === 0) return path.slice(0, at);
  }
  return path;
}

export function finalizePath(raw: string): string {
  let path = withoutQuery(printable(raw).trim());
  path = path.replace(/\/{2,}/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** The paths one after the other, as one path. */
export function joinPaths(...parts: readonly string[]): string {
  return finalizePath(parts.filter(part => part !== '').join('/'));
}

/** `:id`, `:id?`, `:id(\d+)` and a catch-all `*name`. */
export function colonParams(path: string): string {
  return path
    .replace(/(?<!\w):([A-Za-z_]\w{0,60})(?:\([^()\n]{0,100}\))?\??/g, '{$1}')
    .replace(/\*([A-Za-z_]\w{0,60})/g, '{$1}');
}

/** `<id>`, `<int:id>`, `<path:rest>`, `<id..>` and the named groups of a regular expression, `(?P<id>...)`. */
export function angleParams(path: string): string {
  return path
    .replace(/\(\?P<([A-Za-z_]\w{0,60})>[^()\n]{0,100}\)/g, '{$1}')
    .replace(/<(?:[A-Za-z_]\w{0,30}:)?([A-Za-z_]\w{0,60})(?:\.\.)?>/g, '{$1}')
    .replace(/^\^/, '')
    .replace(/\$$/, '');
}

/** `{id}`, `{id:int}`, `{id?}`, `{id=5}`, `{*rest}`, `{**rest}` and `{id:\d{3}}`. */
export function braceParams(path: string): string {
  return path.replace(/\{\s*\*{0,2}([A-Za-z_][\w.-]{0,60})\s*(?:\?|[:=](?:[^{}]|\{[^{}]{0,40}\}){0,100})?\s*\}/g, '{$1}');
}

/** The names of the parameters of a path that has been written with `{name}`. */
export function pathParamNames(path: string): string[] {
  const names: string[] = [];
  for (const match of path.matchAll(/\{([^{}/]{1,60})\}/g)) {
    const name = match[1] as string;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const GENERIC_STEMS = new Set(['index', 'app', 'main', 'server', 'urls', 'program', 'startup', '__init__', 'mod']);
/** A folder that every project has: its name says nothing about the routes in it. */
const GENERIC_FOLDERS = new Set(['src', 'lib', 'app', 'main', 'server', 'source', 'java', 'kotlin', 'cs', 'python', 'go', 'internal', 'cmd', 'pkg']);

/** The name of the folder for the routes of a file: the name of the file, or of its folder when the file is called what every project calls its entry. */
export function groupFromFile(path: string): string {
  const parts = path.split('/').filter(part => part !== '');
  const base = parts.pop() ?? path;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (GENERIC_STEMS.has(stem.toLowerCase())) {
    const folder = parts[parts.length - 1];
    if (folder !== undefined && !GENERIC_FOLDERS.has(folder.toLowerCase())) return printable(folder);
  }
  return printable(stem);
}

/** The name of a file without its folder and its extension. */
export function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return printable(dot > 0 ? base.slice(0, dot) : base);
}
