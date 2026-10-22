import { emptyResult, makeRoute, methodOf, unique, type FileResult } from './internal';
import { braceParams, joinPaths } from './paths';
import { argRanges, identAt, identBefore, lineOf, literalAt, prepare, skipSpace, type Prepared } from './scan';
import { ROUTE_LIMITS, type RouteMethod, type SourceFile } from './types';

/**
 * Spring, in Java and in Kotlin: a class with `@RestController` (or `@Controller`) and, as a rule, `@RequestMapping("/api/users")`, whose methods have
 * `@GetMapping("/{id}")`, `@PostMapping`... The parameters say what the handler takes: `@RequestParam`, `@RequestHeader`, `@RequestBody`. A path that is
 * a constant (`@GetMapping(Paths.USERS)`) is not known to this code and the route is left out.
 */
const CONTROLLER = /@(?:RestController|Controller)\b/g;
const MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g;
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'open', 'override', 'suspend', 'internal', 'default']);

interface Mapping {
  paths: string[] | 'computed';
  methods: string[];
}

/** What an annotation of a mapping says: the paths (`"/x"`, `{"/x", "/y"}`, `value = "/x"`, `path = ["/x"]`) and the methods (`method = RequestMethod.GET`). */
function mappingOf(prepared: Prepared, at: number): Mapping {
  const paren = skipSpace(prepared.masked, at);
  if (prepared.masked[paren] !== '(') return { paths: [''], methods: [] };
  const found: Mapping = { paths: [''], methods: [] };
  for (const range of argRanges(prepared, paren, { max: 12, scan: 600 })) {
    const text = prepared.clean.slice(range[0], range[1]);
    const named = /^(value|path|method|[A-Za-z]+)\s*=\s*([\s\S]*)$/.exec(text);
    const key = named === null ? 'value' : (named[1] as string);
    const rest = named === null ? text : (named[2] as string);
    if (key === 'method') {
      for (const item of rest.matchAll(/RequestMethod\s*\.\s*([A-Z]{3,7})/g)) found.methods.push((item[1] as string).toUpperCase());
    } else if (key === 'value' || key === 'path') {
      const listed = /^[{[]/.test(rest.trim());
      const literal = literalAt(rest.trim().replace(/^[{[]\s*/, ''), 0);
      if (literal !== undefined && (listed || /^(?:"[^"]*"|'[^']*')$/.test(rest.trim()))) found.paths = [literal.value];
      else if (!(rest.trim() === '' || /^[{[]\s*[}\]]$/.test(rest.trim()))) found.paths = 'computed';
    }
  }
  return found;
}

/** The text without annotations, to read the name of a parameter. */
function declarationName(text: string): string {
  // One pass: the pieces between the annotations are kept, so that a parameter with thousands of annotations is not copied once for each.
  const pieces: string[] = [];
  let last = 0;
  for (;;) {
    const at = text.indexOf('@', last);
    if (at < 0) break;
    const ident = identAt(text, at + 1);
    let end = at + 1 + ident.length;
    const after = skipSpace(text, end);
    if (text[after] === '(') {
      let depth = 0;
      let index = after;
      for (; index < text.length; index++) {
        if (text[index] === '(') depth++;
        else if (text[index] === ')' && --depth === 0) break;
      }
      end = index + 1;
    }
    pieces.push(text.slice(last, at), ' ');
    last = end;
  }
  pieces.push(text.slice(last));
  let rest = pieces.join('');
  const equals = rest.indexOf('=');
  if (equals >= 0) rest = rest.slice(0, equals);
  const colon = rest.indexOf(':');
  if (colon >= 0) rest = rest.slice(0, colon);
  return identBefore(rest, rest.length)?.name ?? '';
}

/** The name given to a parameter in its annotation: `@RequestParam("page")`, `@RequestParam(name = "page")`, or none. */
function annotationName(text: string, annotation: string): string | undefined {
  const at = text.search(new RegExp(`@${annotation}\\b`));
  if (at < 0) return undefined;
  const after = /^\s*\(([^)]{0,200})\)/.exec(text.slice(at + annotation.length + 1));
  if (after === null) return undefined;
  const named = /\b(?:value|name)\s*=\s*"([^"\n]{0,100})"/.exec(after[1] as string) ?? /^\s*"([^"\n]{0,100})"/.exec(after[1] as string);
  return named === null ? undefined : (named[1] as string);
}

function parametersOf(prepared: Prepared, openAt: number): { query: string[]; header: string[]; body: 'json' | 'form' | undefined } {
  const query: string[] = [];
  const header: string[] = [];
  let body: 'json' | 'form' | undefined;
  for (const range of argRanges(prepared, openAt, { max: 25, scan: 4000, angles: true })) {
    const text = prepared.clean.slice(range[0], range[1]);
    if (/@RequestBody\b/.test(text)) body = body ?? 'json';
    else if (/@RequestPart\b/.test(text)) body = 'form';
    if (/@RequestParam\b/.test(text) && !/\bMap\s*</.test(text)) {
      const name = annotationName(text, 'RequestParam') ?? declarationName(text);
      if (name !== '') query.push(name);
    }
    if (/@RequestHeader\b/.test(text) && !/\bMap\s*</.test(text)) {
      const name = annotationName(text, 'RequestHeader') ?? declarationName(text);
      if (name !== '') header.push(name);
    }
  }
  return { query: unique(query), header: unique(header), body };
}

/** The name of the method that a mapping is on and the `(` of its parameters; the annotations and the modifiers before are skipped. */
function methodAfter(prepared: Prepared, from: number): { name: string; openAt: number } | undefined {
  const masked = prepared.masked;
  let at = from;
  const limit = Math.min(masked.length, from + 600);
  while (at < limit) {
    at = skipSpace(masked, at);
    const c = masked[at];
    if (c === '@') {
      at++;
      at += identAt(masked, at).length;
      const after = skipSpace(masked, at);
      if (masked[after] === '(') {
        const closeAt = prepared.close[after] ?? -1;
        if (closeAt < 0) return undefined;
        at = closeAt + 1;
      }
      continue;
    }
    if (c === '(') {
      const name = identBefore(masked, at);
      return name === undefined || MODIFIERS.has(name.name) ? undefined : { name: name.name, openAt: at };
    }
    if (c === '{' || c === ';' || c === '=' || c === '}' || c === undefined) return undefined;
    at++;
  }
  return undefined;
}

export function scanJvm(file: SourceFile): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'java');
  result.longLines = prepared.longLines;
  const { masked } = prepared;
  let lastEnd = 0;
  /** The parameters of a method, by where they start: a method with many mappings on it is read once. */
  const parameters = new Map<number, ReturnType<typeof parametersOf>>();
  CONTROLLER.lastIndex = 0;
  for (let controller = CONTROLLER.exec(masked); controller !== null; controller = CONTROLLER.exec(masked)) {
    const at = controller.index;
    const named = /\b(?:class|interface|object)\s+([A-Za-z_]\w*)/.exec(masked.slice(at, at + 1500));
    if (named === null) continue;
    const classAt = at + (named.index ?? 0);
    // The annotations of the class are the ones since the end of the class before.
    const windowStart = Math.max(lastEnd, at - 1500);
    let classPath: string[] | 'computed' = [''];
    const requestMapping = /@RequestMapping\b/.exec(masked.slice(windowStart, classAt));
    if (requestMapping !== null) classPath = mappingOf(prepared, windowStart + requestMapping.index + requestMapping[0].length).paths;
    // The body: after the name, skipping the parentheses of a Kotlin constructor.
    let brace = -1;
    let cursor = classAt + named[0].length;
    for (; cursor < classAt + 900; cursor++) {
      const c = masked[cursor];
      if (c === '(') { const closeAt = prepared.close[cursor] ?? -1; if (closeAt < 0) break; cursor = closeAt; continue; }
      if (c === '{') { brace = cursor; break; }
      if (c === ';' || c === undefined) break;
    }
    const end = brace < 0 ? -1 : (prepared.close[brace] ?? -1);
    if (end < 0) continue;
    lastEnd = end;
    CONTROLLER.lastIndex = end;
    if (classPath === 'computed') { result.computed++; continue; }
    // Only the body of the class is looked at, so that a file of many classes is read once.
    for (const mapping of masked.slice(brace, end).matchAll(MAPPING)) {
      if (result.routes.length > ROUTE_LIMITS.routes) return result;
      const mappingAt = brace + (mapping.index ?? 0);
      const kind = mapping[1] as string;
      const found = mappingOf(prepared, mappingAt + mapping[0].length);
      if (found.paths === 'computed') { result.computed++; continue; }
      const afterName = skipSpace(masked, mappingAt + mapping[0].length);
      const signature = methodAfter(prepared, masked[afterName] === '(' ? (prepared.close[afterName] ?? afterName) + 1 : afterName);
      if (signature === undefined) continue;
      let params = parameters.get(signature.openAt);
      if (params === undefined) { params = parametersOf(prepared, signature.openAt); parameters.set(signature.openAt, params); }
      let methods: RouteMethod[];
      let any = false;
      if (kind === 'Request') {
        methods = unique(found.methods).map(word => methodOf(word)?.method).filter((method): method is RouteMethod => method !== undefined);
        if (methods.length === 0) { methods = ['GET']; any = true; }
      } else methods = [(methodOf(kind)?.method ?? 'GET')];
      for (const method of methods) {
        if (any) result.anyRoutes++;
        result.routes.push(makeRoute({
          method, path: braceParams(joinPaths(...classPath, ...found.paths)), framework: 'Spring', group: named[1] as string, file: file.path, line: lineOf(prepared, mappingAt),
          handler: signature.name, queryParams: params.query, headerParams: params.header, body: params.body
        }));
      }
    }
  }
  return result;
}
