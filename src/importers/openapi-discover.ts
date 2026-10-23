import { sniffOpenApi } from './openapi-find';

/**
 * Finding the description behind an address. A person pastes the address of the page that documents an API (`/docs/admin`, `/swagger-ui/index.html`, a page of
 * Redoc or Scalar), which is a web page and not the description. These functions say whether a text is a page, where the description may be (what the page and
 * its start-up script point at, the addresses that frameworks use, the description that swagger-ui-express writes into its start-up script), and nothing else:
 * they read text and return text. Whoever fetches the addresses follows only the ones on the origin that the person typed.
 */

/** The most addresses that are tried after the one that was typed. */
export const DISCOVER_ATTEMPTS = 24;
/** The most scripts of a page that are read for the address of a description. */
export const DISCOVER_SCRIPTS = 3;

const BOM = String.fromCharCode(0xfeff);

/** Whether a text is a web page: it starts with a tag (or a comment and then one) and has the tags of a page near the start. */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 4096).replace(BOM, '').trimStart();
  return head.startsWith('<') && /<(?:!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(head);
}

/** The end of the JSON value that starts at `from` (a `{`), or -1: strings and their escapes are skipped, so a brace in a text does not count. */
function endOfObject(text: string, from: number, limit: number): number {
  let depth = 0;
  let inString = false;
  const stop = Math.min(text.length, from + limit);
  for (let at = from; at < stop; at++) {
    const char = text.charCodeAt(at);
    if (inString) {
      if (char === 92) at++;
      else if (char === 34) inString = false;
    } else if (char === 34) inString = true;
    else if (char === 123 || char === 91) depth++;
    else if ((char === 125 || char === 93) && --depth === 0) return at + 1;
  }
  return -1;
}

/**
 * swagger-ui-express (the Swagger UI of Express and NestJS programs) writes the whole description into its start-up script, `swagger-ui-init.js`, as the value
 * of `"swaggerDoc"`. The text of that value, or undefined when the script has none.
 */
export function embeddedDescription(script: string, limit: number): string | undefined {
  const found = /"swaggerDoc"\s*:\s*\{/.exec(script);
  if (found === null) return undefined;
  const from = found.index + found[0].length - 1;
  const end = endOfObject(script, from, limit);
  return end < 0 ? undefined : script.slice(from, end);
}

/** What a string that is the address of a description looks like: the extension of a file, or the names that frameworks give. */
const SPEC_LIKE = /(?:\.json|\.ya?ml|api-docs|openapi|swagger|-json|-yaml)(?:[?#].*)?$/i;
/** The start-up scripts of a page, not its bundle: the bundle is a megabyte of the library. */
const INIT_SCRIPT = /(?:init|initializer|config|settings)[^/]*\.js(?:[?#].*)?$/i;

function resolveOnOrigin(reference: string, pageUrl: string): string | undefined {
  try {
    const page = new URL(pageUrl);
    const target = new URL(reference.trim(), page);
    if ((target.protocol !== 'http:' && target.protocol !== 'https:') || target.origin !== page.origin) return undefined;
    target.hash = '';
    return target.href;
  } catch {
    return undefined;
  }
}

const unique = (list: readonly string[]): string[] => [...new Set(list)];

/**
 * What a page or a script says about where the description is, as addresses on the origin of the page: `specs` are addresses that look like a description (a
 * `url` of Swagger UI, a `spec-url` of Redoc, a `data-url` of Scalar, a link to a `.json` or a `.yaml`), `scripts` are the start-up scripts that may hold one
 * (or the description itself).
 */
export function referencesInPage(text: string, pageUrl: string): { specs: string[]; scripts: string[] } {
  const specs: string[] = [];
  const scripts: string[] = [];
  const take = (reference: string | undefined, into: string[], test: RegExp): void => {
    if (reference === undefined || !test.test(reference)) return;
    const resolved = resolveOnOrigin(reference, pageUrl);
    if (resolved !== undefined) into.push(resolved);
  };
  for (const match of text.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']{1,300})["']/gi)) take(match[1], scripts, INIT_SCRIPT);
  for (const match of text.matchAll(/\b(?:spec-url|data-url|data-spec-url)\s*=\s*["']([^"']{1,300})["']/gi)) take(match[1], specs, /./);
  for (const match of text.matchAll(/(?:\burl|"url")\s*:\s*["']([^"'\s]{1,300})["']/g)) take(match[1], specs, SPEC_LIKE);
  for (const match of text.matchAll(/\bhref\s*=\s*["']([^"']{1,300})["']/gi)) take(match[1], specs, /\.(?:json|ya?ml)(?:[?#].*)?$/i);
  return { specs: unique(specs).slice(0, DISCOVER_ATTEMPTS), scripts: unique(scripts).slice(0, DISCOVER_SCRIPTS) };
}

/** The addresses at which programs usually serve their description, after the path of a documentation page and at the root. */
const ROOT_PATHS: readonly string[] = [
  '/v3/api-docs', '/v2/api-docs', '/openapi.json', '/swagger.json', '/api-docs', '/api-docs.json', '/openapi.yaml', '/swagger/v1/swagger.json', '/docs-json', '/api-json',
  '/swagger-json', '/openapi', '/api/openapi.json', '/api/swagger.json', '/api/v1/openapi.json'
];

/**
 * The addresses to try for an address that is not the description, the nearest to what was typed first: NestJS writes it beside the page (`/docs/admin` and
 * `/docs/admin-json`), Spring and FastAPI at the root (`/v3/api-docs`, `/openapi.json`). The YAML of NestJS is last: it is written with anchors, which the
 * reader does not take.
 */
export function guessAddresses(address: string): string[] {
  let page: URL;
  try { page = new URL(address); } catch { return []; }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return [];
  const path = page.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '');
  const nearby: string[] = [];
  if (path !== '') {
    nearby.push(`${path}-json`, `${path}.json`, `${path}/swagger.json`, `${path}/openapi.json`, `${path}/json`);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent !== '') nearby.push(`${parent}/swagger.json`, `${parent}/openapi.json`, `${parent}/api-docs`);
  }
  const yaml = path === '' ? [] : [`${path}-yaml`, `${path}.yaml`];
  const all = [...nearby, ...ROOT_PATHS, ...yaml].map(path_ => `${page.origin}${path_}`).filter(candidate => candidate !== page.origin + path);
  return unique(all).slice(0, DISCOVER_ATTEMPTS);
}

// ---- looking for it ----

/** Fetches the text at an address; refuses (throws) when it cannot. */
export type FetchText = (url: string, signal: AbortSignal) => Promise<string>;

export interface DiscoveryResult {
  /** The text of the description and the address (or script) that it came from; undefined when there was none. */
  found?: { text: string; from: string };
  /** The addresses that were asked for, the first being the one that was typed. */
  tried: string[];
  /** The answer to the address that was typed is a web page. */
  page: boolean;
}

const isDescription = (text: string): boolean => !looksLikeHtml(text) && sniffOpenApi(text, true) !== undefined;

/**
 * The description behind an address. `first` is the answer to the address that was typed: when it is a description, that is it. When it is a web page, the page
 * and its start-up scripts are read for the description (swagger-ui-express writes it into `swagger-ui-init.js`) or for its address; then the addresses that
 * programs usually serve it at are tried, beside the page and at the root. Only addresses on the origin of the one that was typed are asked for, however many
 * the page names, and no more than a few dozen: what a page says is data, not an instruction.
 */
export async function discoverDescription(address: string, first: string, get: FetchText, signal: AbortSignal, report: (message: string) => void = () => undefined, limit = 32 * 1024 * 1024): Promise<DiscoveryResult> {
  const tried = [address];
  if (isDescription(first)) return { found: { text: first, from: address }, tried, page: false };
  const page = looksLikeHtml(first);
  const attempt = async (url: string): Promise<string | undefined> => {
    if (tried.includes(url) || tried.length > DISCOVER_ATTEMPTS + DISCOVER_SCRIPTS) return undefined;
    tried.push(url);
    signal.throwIfAborted();
    report(url);
    try { return await get(url, signal); } catch (error) { if (signal.aborted) throw error; return undefined; }
  };
  /** What a page or a script holds: the description itself, or the address of one. */
  const read = async (text: string, base: string): Promise<{ text: string; from: string } | undefined> => {
    const embedded = embeddedDescription(text, limit);
    if (embedded !== undefined && isDescription(embedded)) return { text: embedded, from: base };
    for (const spec of referencesInPage(text, base).specs) {
      const answer = await attempt(spec);
      if (answer !== undefined && isDescription(answer)) return { text: answer, from: spec };
    }
    return undefined;
  };
  if (page) {
    const here = await read(first, address);
    if (here !== undefined) return { found: here, tried, page };
    for (const script of referencesInPage(first, address).scripts) {
      const text = await attempt(script);
      const found = text === undefined ? undefined : await read(text, script);
      if (found !== undefined) return { found, tried, page };
    }
  }
  for (const guess of guessAddresses(address)) {
    const answer = await attempt(guess);
    if (answer !== undefined && isDescription(answer)) return { found: { text: answer, from: guess }, tried, page };
  }
  return { tried, page };
}
