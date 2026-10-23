import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { OPENAPI_LIMITS } from '../../src/importers/openapi';
import { isOpenApiName, OPENAPI_EXTENSIONS, OPENAPI_SKIPPED_FOLDERS, rankOpenApi, SNIFF_BYTES, sniffOpenApi, type FoundOpenApi, type OpenApiHit } from '../../src/importers/openapi-find';

/**
 * The OpenAPI and Swagger descriptions that the folders of the workspace already hold, found by reading the first bytes of each JSON and YAML file (nothing
 * is parsed or run). It is quick on purpose: the files whose names say what they are come first and are listed at once, the others are looked at after, and
 * the search can be cut short.
 */
export interface OpenApiFile extends FoundOpenApi {
  uri: vscode.Uri;
}

export interface OpenApiSearch {
  files: OpenApiFile[];
  /** How many were found beyond the ones listed. */
  more: number;
  /** The search stopped at its limit of files: there may be more. */
  stopped: boolean;
}

/** The files the search looks at, and of those the ones whose names say nothing. */
const SEARCH_LIMIT = 5000;
const CONTENT_LIMIT = 3000;
/** The files that are read at the same time. */
const PARALLEL = 24;
/** A file that the name speaks for is read whole when the start does not show the version key (a description that sorts its keys), up to this size. */
const WHOLE_LIMIT = 4 * 1024 * 1024;

/** The start of a file and its size; undefined for what is not a plain file (a link is not followed) or cannot be read. */
async function readHead(path: string): Promise<{ text: string; size: number } | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    if ((await fs.lstat(path)).isSymbolicLink()) return undefined;
    handle = await fs.open(path, 'r');
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, stats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, bytesRead), size: stats.size };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function examine(uri: vscode.Uri, byName: boolean): Promise<OpenApiHit | undefined> {
  if (uri.scheme !== 'file') return undefined;
  const head = await readHead(uri.fsPath);
  if (head === undefined || head.size > OPENAPI_LIMITS.fileChars) return undefined;
  const hit = sniffOpenApi(head.text, byName);
  if (hit !== undefined || !byName || head.size <= SNIFF_BYTES || head.size > WHOLE_LIMIT) return hit;
  try { return sniffOpenApi(await fs.readFile(uri.fsPath, 'utf8'), true); } catch { return undefined; }
}

/** Runs `work` over the items a few at a time and stops between two groups when the signal says so. */
async function inGroups<T>(items: readonly T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  for (let from = 0; from < items.length && !signal.aborted; from += PARALLEL) await Promise.all(items.slice(from, from + PARALLEL).map(work));
}

/**
 * Looks for the descriptions. `onList` gets the list after the files named for it were read, so that the person can pick one at once; the result is the
 * list after all the others were looked at too.
 */
export async function findOpenApiFiles(root: string, signal: AbortSignal, onList?: (found: OpenApiSearch) => void): Promise<OpenApiSearch> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return { files: [], more: 0, stopped: false };
  const exclude = `**/{${[...OPENAPI_SKIPPED_FOLDERS, root].join(',')}}/**`;
  const pattern = `**/*.{${OPENAPI_EXTENSIONS.map(extension => extension.slice(1)).join(',')}}`;
  const uris = await vscode.workspace.findFiles(pattern, exclude, SEARCH_LIMIT);
  const several = folders.length > 1;
  const relative = (uri: vscode.Uri): string => vscode.workspace.asRelativePath(uri, several);
  const named = uris.filter(uri => isOpenApiName(relative(uri)));
  const others = uris.filter(uri => !isOpenApiName(relative(uri))).slice(0, CONTENT_LIMIT);
  const found: OpenApiFile[] = [];
  const result = (): OpenApiSearch => {
    const ranked = rankOpenApi(found);
    return { files: ranked.list as OpenApiFile[], more: ranked.more, stopped: uris.length >= SEARCH_LIMIT };
  };
  const look = (byName: boolean) => async (uri: vscode.Uri): Promise<void> => {
    const hit = await examine(uri, byName);
    if (hit !== undefined) found.push({ ...hit, path: relative(uri), byName, uri });
  };
  await inGroups(named, signal, look(true));
  onList?.(result());
  await inGroups(others, signal, look(false));
  return result();
}
