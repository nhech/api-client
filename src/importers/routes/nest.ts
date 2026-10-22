import { makeRoute, methodOf, unique, type FileResult } from './internal';
import { colonParams, joinPaths } from './paths';
import { argRanges, identAt, indexWithin, lineOf, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type SourceFile } from './types';

/**
 * NestJS: a class with `@Controller('users')` and methods with `@Get(':id')`, `@Post()`... The decorators of the parameters say what the handler takes:
 * `@Query('page')`, `@Headers('x-token')`, `@Body()`. `app.setGlobalPrefix('api')` adds a prefix to every route, wherever it is written.
 */
const METHOD = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/g;
const MODIFIERS = new Set(['async', 'public', 'private', 'protected', 'static', 'readonly', 'override', 'abstract']);

/** The path in the arguments of a decorator: `'users'`, `{ path: 'users', version: '1' }`, `['users', 'people']` or nothing. */
function decoratorPath(prepared: Prepared, openAt: number): { path: string; versioned: boolean } | 'computed' {
  const first = argRanges(prepared, openAt, { max: 1, scan: 400 })[0];
  if (first === undefined) return { path: '', versioned: false };
  const text = prepared.clean.slice(first[0], first[1]);
  const direct = stringArg(prepared, first);
  if (direct !== undefined) return { path: direct, versioned: false };
  if (text.startsWith('{')) {
    const path = /\bpath\s*:\s*(['"`])([^'"`\n]{0,200})\1/.exec(text);
    const versioned = /\bversion\s*:/.test(text);
    if (path !== null) return { path: path[2] as string, versioned };
    return /\bpath\s*:/.test(text) ? 'computed' : { path: '', versioned };
  }
  if (text.startsWith('[')) {
    const item = /(['"`])([^'"`\n]{0,200})\1/.exec(text);
    return item === null ? 'computed' : { path: item[2] as string, versioned: false };
  }
  return 'computed';
}

function parametersOf(prepared: Prepared, openAt: number): { query: string[]; header: string[]; body: 'json' | 'form' | undefined } {
  const query: string[] = [];
  const header: string[] = [];
  let body: 'json' | 'form' | undefined;
  for (const range of argRanges(prepared, openAt, { max: 24, scan: 3000 })) {
    const text = prepared.clean.slice(range[0], range[1]);
    for (const match of text.matchAll(/@(Body|Query|Headers|UploadedFile|UploadedFiles)\s*\(\s*(?:(['"`])([^'"`\n]{0,100})\2)?[^)]{0,100}\)/g)) {
      const kind = match[1];
      const name = match[3];
      if (kind === 'Body') body = body ?? 'json';
      else if (kind === 'UploadedFile' || kind === 'UploadedFiles') body = 'form';
      else if (kind === 'Query' && name !== undefined) query.push(name);
      else if (kind === 'Headers' && name !== undefined) header.push(name);
    }
  }
  return { query: unique(query), header: unique(header), body };
}

/** The name of the method that a decorator is on, and the `(` of its parameters: the decorators and the modifiers between are skipped. */
function methodAfter(prepared: Prepared, from: number): { name: string; openAt: number } | undefined {
  const masked = prepared.masked;
  let at = from;
  for (let step = 0; step < 30; step++) {
    at = skipSpace(masked, at);
    if (masked[at] === '@') {
      at++;
      at += identAt(masked, at).length;
      while (masked[at] === '.') { at++; at += identAt(masked, at).length; }
      const afterName = skipSpace(masked, at);
      if (masked[afterName] === '(') {
        const closeAt = prepared.close[afterName] ?? -1;
        if (closeAt < 0) return undefined;
        at = closeAt + 1;
      }
      continue;
    }
    const word = identAt(masked, at);
    if (word === '') return undefined;
    if (MODIFIERS.has(word)) { at += word.length; continue; }
    const paren = skipSpace(masked, at + word.length);
    return masked[paren] === '(' ? { name: word, openAt: paren } : undefined;
  }
  return undefined;
}

export function scanNest(file: SourceFile, prepared: Prepared, result: FileResult): void {
  const masked = prepared.masked;
  const clean = prepared.clean;
  const prefix = /\bsetGlobalPrefix\s*\(\s*(['"`])([^'"`\n]{0,200})\1/.exec(clean);
  if (prefix !== null) result.globalPrefix = prefix[2] as string;
  // The end of the class that was read last: a controller inside it is part of it, so that no text is read more than once.
  let readTo = 0;
  let nested = 0;
  for (const controller of masked.matchAll(/@Controller\s*\(/g)) {
    if ((controller.index ?? 0) < readTo) { nested++; continue; }
    const decorator = (controller.index ?? 0) + controller[0].length - 1;
    const closeAt = prepared.close[decorator] ?? -1;
    if (closeAt < 0) continue;
    const base = decoratorPath(prepared, decorator);
    if (base === 'computed') { result.computed++; continue; }
    if (base.versioned) result.notes.push('NestJS versioning (`version`) was seen: the routes are listed without the prefix that URI versioning adds, such as /v1.');
    const named = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(masked.slice(closeAt + 1, closeAt + 700));
    if (named === null) continue;
    const nameEnd = closeAt + 1 + (named.index ?? 0) + named[0].length;
    const brace = indexWithin(masked, '{', nameEnd, nameEnd + 500);
    if (brace < 0) continue;
    const end = prepared.close[brace] ?? -1;
    if (end < 0) continue;
    readTo = end;
    // Only the body of the class is looked at, so that a file of many classes is read once.
    for (const match of masked.slice(brace, end).matchAll(METHOD)) {
      if (result.routes.length > ROUTE_LIMITS.routes) return;
      const verb = match[1] as string;
      const matchAt = brace + (match.index ?? 0);
      const openAt = matchAt + match[0].length - 1;
      const own = decoratorPath(prepared, openAt);
      if (own === 'computed') { result.computed++; continue; }
      const signature = methodAfter(prepared, (prepared.close[openAt] ?? openAt) + 1);
      const params = signature === undefined ? undefined : parametersOf(prepared, signature.openAt);
      const method = methodOf(verb);
      if (method === undefined) continue;
      if (method.any) result.anyRoutes++;
      result.routes.push(makeRoute({
        method: method.method, path: colonParams(joinPaths(base.path, own.path)), framework: 'NestJS', group: named[1] as string, file: file.path, line: lineOf(prepared, matchAt),
        handler: signature?.name, receiverKind: 'router', queryParams: params?.query ?? [], headerParams: params?.header ?? [], body: params?.body
      }));
    }
  }
  if (nested > 0) result.notes.push(`${nested === 1 ? 'A NestJS controller declared' : `${nested} NestJS controllers declared`} inside another class ${nested === 1 ? 'was' : 'were'} read as part of it.`);
}
