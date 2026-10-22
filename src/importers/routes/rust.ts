import { emptyResult, makeRoute, methodOf, type FileResult } from './internal';
import { angleParams, braceParams, groupFromFile, joinPaths } from './paths';
import { argRanges, identAt, lineOf, prepare, skipSpace, stringArg, type Prepared } from './scan';
import { ROUTE_LIMITS, type SourceFile } from './types';

/**
 * Rust: Actix Web (`#[get("/users/{id}")]` on an `async fn`) and Rocket (`#[get("/users/<id>")]`, mounted with `.mount("/api", routes![list, show])`). A scope of
 * Actix (`web::scope("/api")`) is not followed.
 */
function handlerAfter(prepared: Prepared, from: number): { name: string; openAt: number } | undefined {
  const masked = prepared.masked;
  let at = from;
  for (let step = 0; step < 12; step++) {
    at = skipSpace(masked, at);
    if (masked.startsWith('#[', at)) {
      const closeAt = prepared.close[at + 1] ?? -1;
      if (closeAt < 0) return undefined;
      at = closeAt + 1;
      continue;
    }
    for (const word of ['pub', 'async', 'unsafe']) {
      if (masked.startsWith(word, at) && /\s/.test(masked[at + word.length] ?? '')) at = skipSpace(masked, at + word.length);
    }
    if (masked.startsWith('async', at) && /\s/.test(masked[at + 5] ?? '')) at = skipSpace(masked, at + 5);
    if (masked.startsWith('fn', at) && /\s/.test(masked[at + 2] ?? '')) {
      const nameAt = skipSpace(masked, at + 2);
      const name = identAt(masked, nameAt);
      const paren = skipSpace(masked, nameAt + name.length);
      return name !== '' && masked[paren] === '(' ? { name, openAt: paren } : undefined;
    }
    return undefined;
  }
  return undefined;
}

export function scanRust(file: SourceFile): FileResult {
  const result = emptyResult();
  const prepared = prepare(file.text, 'rust');
  result.longLines = prepared.longLines;
  const { masked, clean } = prepared;
  const rocket = /\brocket\s*::|\bextern\s+crate\s+rocket\b/.test(clean);
  const actix = /\bactix_web\b/.test(clean);
  if (!rocket && !actix) return result;
  const framework = rocket ? 'Rocket' : 'Actix';
  const group = groupFromFile(file.path);
  const mounts = new Map<string, string>();
  if (rocket) {
    for (const match of masked.matchAll(/\.\s*mount\s*\(/g)) {
      const openAt = (match.index ?? 0) + match[0].length - 1;
      const ranges = argRanges(prepared, openAt, { max: 2, scan: 600 });
      const base = ranges[0] === undefined ? undefined : stringArg(prepared, ranges[0]);
      const list = ranges[1] === undefined ? '' : clean.slice(ranges[1][0], ranges[1][1]);
      if (base === undefined) continue;
      for (const name of list.matchAll(/\b([A-Za-z_]\w*)\b(?!\s*!)/g)) if (name[1] !== 'routes') mounts.set(name[1] as string, base);
    }
  }
  for (const match of masked.matchAll(/#\[\s*(get|post|put|patch|delete|head|options)\s*\(/g)) {
    if (result.routes.length > ROUTE_LIMITS.routes) break;
    const at = match.index ?? 0;
    const openAt = at + match[0].length - 1;
    const closeAt = prepared.close[openAt] ?? -1;
    if (closeAt < 0) continue;
    const first = argRanges(prepared, openAt, { max: 1, scan: 300 })[0];
    const path = first === undefined ? undefined : stringArg(prepared, first);
    if (path === undefined) { result.computed++; continue; }
    const signature = handlerAfter(prepared, closeAt + 2);
    const text = signature === undefined ? '' : clean.slice(signature.openAt, prepared.close[signature.openAt] ?? signature.openAt);
    const body = /\b(?:web\s*::\s*)?Json\s*</.test(text) ? 'json' : /\b(?:web\s*::\s*)?Form\s*</.test(text) ? 'form' : undefined;
    const method = methodOf(match[1] as string);
    if (method === undefined) continue;
    const prefix = signature === undefined ? '' : (mounts.get(signature.name) ?? '');
    result.routes.push(makeRoute({
      method: method.method, path: braceParams(angleParams(joinPaths(prefix, path))), framework, group, file: file.path, line: lineOf(prepared, at), handler: signature?.name, body
    }));
  }
  const port = /\.bind\s*\(\s*(?:\(\s*"[^"\n]{0,60}"\s*,\s*(\d{2,5})|"[^"\n:]{0,60}:(\d{2,5})")/.exec(clean);
  if (port !== null) result.port = Number(port[1] ?? port[2]);
  return result;
}
