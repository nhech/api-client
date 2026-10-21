import { DEFAULT_SETTINGS, type Auth, type Container, type KV, type Request, type Settings, type SettingsOverride } from './model';

/**
 * What a request inherits from the folders above it and from its collection. The levels are given outermost first (the
 * collection, then each folder down to the request's own); the nearest level wins, and every inherited value says where it
 * came from so that the editor can show "from folder Orders". Nothing here runs a script or reads the machine.
 *
 * The walk is bounded: only the nearest MAX_LEVELS levels count, so a chain of nested folders from a hostile repository
 * cannot make a request expensive to resolve.
 */
export const MAX_LEVELS = 1024;

export interface Level {
  kind: 'collection' | 'folder';
  /** Shown as the origin of what the level contributes. */
  name: string;
  container: Container;
}

export interface EffectiveHeader {
  name: string;
  value: string;
  from: string;
}

export interface ScriptSource {
  code: string;
  from: string;
  /** The id of the collection, folder or request the script is in: what a person's consent to run it is kept under. */
  id: string;
}

export interface EffectiveRequest {
  /** The URL with the base URL applied when the request's own is not absolute. */
  url: string;
  baseUrlFrom: string | undefined;
  /** The headers that are sent, outermost level first; a nearer header of the same name replaces the inherited one. */
  headers: EffectiveHeader[];
  /** Never "inherit": the authentication that applies, and where it was chosen ("request", a level name, or "none"). */
  auth: Auth;
  authFrom: string;
  /** Pre-request and post-response scripts in the order they run: outermost level first, the request last. */
  preScripts: ScriptSource[];
  postScripts: ScriptSource[];
  /** The enabled assertions of every level, outermost first, without exact duplicates. */
  tests: { expr: string; from: string }[];
  settings: Settings;
  /** More levels than MAX_LEVELS were above the request; only the nearest ones were used. */
  truncated: boolean;
}

/** A URL that is not absolute and does not start with a variable is prefixed with the base URL. */
export function applyBaseUrl(url: string, baseUrl: string): string {
  if (url === '' || baseUrl === '') return url;
  // Spaces before the address (a paste) do not make it relative.
  const start = url.trimStart();
  const lower = start.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || start.startsWith('{{') ? url : baseUrl + url;
}

function mergeSettings(...layers: SettingsOverride[]): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  for (const layer of layers) {
    if (layer.timeoutMs !== undefined) settings.timeoutMs = layer.timeoutMs;
    if (layer.followRedirects !== undefined) settings.followRedirects = layer.followRedirects;
    if (layer.maxRedirects !== undefined) settings.maxRedirects = layer.maxRedirects;
    if (layer.rejectUnauthorized !== undefined) settings.rejectUnauthorized = layer.rejectUnauthorized;
    if (layer.httpVersion !== undefined) settings.httpVersion = layer.httpVersion;
    if (layer.responseLimitBytes !== undefined) settings.responseLimitBytes = layer.responseLimitBytes;
    if (layer.encodeUrl !== undefined) settings.encodeUrl = layer.encodeUrl;
    if (layer.cookies !== undefined) settings.cookies = layer.cookies;
  }
  return settings;
}

/**
 * Headers level by level from the outside in. A level that names a header (enabled or not) removes what the outer levels sent
 * under that name, compared without regard to case; its own enabled rows are then added, so two rows of the same name on one
 * level both stay.
 */
function mergeHeaders(layers: { rows: readonly KV[]; from: string }[]): EffectiveHeader[] {
  let sent: EffectiveHeader[] = [];
  for (const { rows, from } of layers) {
    const named = new Set(rows.map(row => row.name.toLowerCase()));
    if (named.size > 0) sent = sent.filter(header => !named.has(header.name.toLowerCase()));
    for (const row of rows) if (row.enabled && row.name !== '') sent.push({ name: row.name, value: row.value, from });
  }
  return sent;
}

export function effectiveRequest(request: Request, chain: readonly Level[], workspace: SettingsOverride = {}): EffectiveRequest {
  const truncated = chain.length > MAX_LEVELS;
  const levels = truncated ? chain.slice(chain.length - MAX_LEVELS) : chain;

  let baseUrl = '';
  let baseUrlFrom: string | undefined;
  for (let index = levels.length - 1; index >= 0; index--) {
    const level = levels[index] as Level;
    if (level.container.baseUrl !== '') { baseUrl = level.container.baseUrl; baseUrlFrom = level.name; break; }
  }

  let auth: Auth = { kind: 'none' };
  let authFrom = 'none';
  if (request.auth.kind !== 'inherit') {
    auth = request.auth;
    authFrom = 'request';
  } else {
    for (let index = levels.length - 1; index >= 0; index--) {
      const level = levels[index] as Level;
      if (level.container.auth.kind !== 'inherit') { auth = level.container.auth; authFrom = level.name; break; }
    }
  }

  const preScripts: ScriptSource[] = [];
  const postScripts: ScriptSource[] = [];
  const tests: { expr: string; from: string }[] = [];
  const seen = new Set<string>();
  const take = (scripts: { pre: string; post: string }, assertions: readonly { expr: string; enabled: boolean }[], from: string, id: string): void => {
    if (scripts.pre.trim() !== '') preScripts.push({ code: scripts.pre, from, id });
    if (scripts.post.trim() !== '') postScripts.push({ code: scripts.post, from, id });
    for (const line of assertions) {
      if (!line.enabled || line.expr.trim() === '' || seen.has(line.expr)) continue;
      seen.add(line.expr);
      tests.push({ expr: line.expr, from });
    }
  };
  for (const level of levels) take(level.container.scripts, level.container.tests, level.name, level.container.id);
  take(request.scripts, request.tests, 'request', request.id);

  return {
    url: applyBaseUrl(request.url, baseUrl),
    baseUrlFrom: baseUrl === '' || request.url === '' || /^(?:https?:\/\/|\{\{)/i.test(request.url) ? undefined : baseUrlFrom,
    headers: mergeHeaders([...levels.map(level => ({ rows: level.container.headers, from: level.name })), { rows: request.headers, from: 'request' }]),
    auth,
    authFrom,
    preScripts,
    postScripts,
    tests,
    settings: mergeSettings(workspace, ...levels.map(level => level.container.settings), request.settings),
    truncated
  };
}
