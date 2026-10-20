import { constants, promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { finding } from '../model/findings';
import type { Finding } from '../model/findings';
import type { ContentKind, SourceFile, TcSource } from '../pipeline';
import { compareCodePoints, printable } from '../util/chars';
import { classifyContent } from './classify';
import { exceedsDepth, hasOversizedString } from './json-limits';
import { detectLayout, entryRole } from './layout';
import { DEFAULT_READER_LIMITS } from './limits';
import type { ReaderLimits } from './limits';

/**
 * The disk reader (spec sections 2 and 8). It reads a Thunder Client data folder, or the export files a person picked, and
 * returns what it found as parsed JSON with a kind for each file. It decides nothing about the content: that is the job of
 * the normaliser.
 *
 * What it does, in the words of the spec:
 *  - reads only; a file is opened read-only and never written, moved or deleted;
 *  - reads only the files it knows (the v4 folders `collections/` and `environments/`, the four v3 files), never walks the tree;
 *  - never follows a link out of the folder: a symbolic link, or a folder whose real path leaves the source, is skipped;
 *  - checks every bound of section 8.1 before the file costs anything, and skips the part that is over a bound with
 *    TC-TOO-LARGE while the rest of the import goes on;
 *  - parses with plain JSON.parse (no reviver) and never runs, merges or fetches anything from the data;
 *  - returns the same result for the same data, whatever order the disk lists names in;
 *  - puts only paths relative to the source, with hidden characters made visible, in what it returns.
 */

export class SourceError extends Error {
  constructor(readonly code: 'not-found' | 'not-readable' | 'not-supported', message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export interface ReadSourceOptions {
  /** Aborts between files (the import has a progress notification that can be cancelled, spec 9). */
  signal?: AbortSignal;
  /** Lower bounds for tests, or a stricter policy. */
  limits?: Partial<ReaderLimits>;
}

// O_NOFOLLOW does not exist on Windows; where it does, a link swapped in after the check is refused by the open itself.
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** What a missing or unrecognised content is read as when the file has a known v3 name and holds an empty array. */
const EMPTY_V3_KIND: Readonly<Record<string, ContentKind>> = {
  'v3-requests': 'v3-requests',
  'v3-collections': 'v3-collections',
  'v3-environments': 'v3-environments',
  'v3-local-environment': 'v3-environments'
};

interface Context {
  limits: ReaderLimits;
  signal: AbortSignal | undefined;
  files: SourceFile[];
  findings: Finding[];
  filesRead: number;
  bytesRead: number;
  requestsSeen: number;
  reported: { files: boolean; bytes: boolean; requests: boolean };
}

/**
 * Reads a Thunder Client data folder (a path to a directory), or one or more export files (a path to a file, or a list of
 * paths to files). Rejects with a SourceError when the path does not exist, cannot be read or is not a file or folder.
 */
export async function readSource(input: string | readonly string[], options: ReadSourceOptions = {}): Promise<TcSource> {
  const ctx: Context = {
    limits: { ...DEFAULT_READER_LIMITS, ...options.limits },
    signal: options.signal,
    files: [],
    findings: [],
    filesRead: 0,
    bytesRead: 0,
    requestsSeen: 0,
    reported: { files: false, bytes: false, requests: false }
  };
  ctx.signal?.throwIfAborted();

  if (typeof input !== 'string') {
    for (const file of input) await readExplicitFile(ctx, file);
    return finish(ctx, 'none');
  }
  const target = await inspect(input);
  if (target.kind === 'file') {
    await readExplicitFile(ctx, input);
    return finish(ctx, 'none');
  }
  return readFolder(ctx, target.real);
}

function finish(ctx: Context, layout: TcSource['layout']): TcSource {
  ctx.files.sort((a, b) => compareCodePoints(a.origin, b.origin));
  return { layout, files: ctx.files, findings: ctx.findings };
}

// ---------- the path the person gave ----------

async function inspect(input: string): Promise<{ kind: 'file' | 'folder'; real: string }> {
  try {
    const real = await fs.realpath(input);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) return { kind: 'folder', real };
    if (stat.isFile()) return { kind: 'file', real };
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new SourceError('not-found', 'The path does not exist.');
    throw new SourceError('not-readable', `The path cannot be read (${code}).`);
  }
  throw new SourceError('not-supported', 'The path is neither a file nor a folder.');
}

async function readExplicitFile(ctx: Context, input: string): Promise<void> {
  const target = await inspect(input);
  if (target.kind !== 'file') throw new SourceError('not-supported', 'A list of paths must hold files only.');
  await readJson(ctx, path.basename(target.real), target.real);
}

// ---------- a data folder ----------

async function readFolder(ctx: Context, root: string): Promise<TcSource> {
  const rootEntries = await listDir(root);
  const rootFiles = rootEntries.filter(entry => entry.isFile()).map(entry => entry.name);
  for (const entry of rootEntries) {
    if (entry.isSymbolicLink() && (EMPTY_V3_KIND[entryRole(entry.name)] !== undefined || entry.name === 'collections' || entry.name === 'environments')) {
      skipped(ctx, entry.name, 'Skipped: it is a link.');
    }
  }
  const collections = await subfolder(ctx, root, rootEntries, 'collections');
  const environments = await subfolder(ctx, root, rootEntries, 'environments');
  const collectionNames = collections.filter(entry => entry.isFile()).map(entry => entry.name);

  const decision = detectLayout({ rootFiles, collectionsFiles: collectionNames });
  if (decision.layout === 'none') {
    ctx.findings.push(finding('TC-PARSE-ERROR', '.', 'No Thunder Client data was found in this folder.', 'info'));
    return finish(ctx, 'none');
  }
  if (decision.bothPresent) ctx.findings.push(finding('TC-LAYOUT-BOTH', '.'));

  const candidates: { rel: string; abs: string; emptyAs?: ContentKind }[] = [];
  if (decision.layout === 'v4') {
    for (const entry of collections) {
      if (entry.isSymbolicLink() && entry.name.startsWith('tc_col')) skipped(ctx, `collections/${entry.name}`, 'Skipped: it is a link.');
      else if (entry.isFile() && entry.name.startsWith('tc_col') && isJson(entry.name)) candidates.push({ rel: `collections/${entry.name}`, abs: path.join(root, 'collections', entry.name) });
    }
    for (const entry of environments) {
      if (entry.isSymbolicLink() && entry.name.startsWith('tc_env')) skipped(ctx, `environments/${entry.name}`, 'Skipped: it is a link.');
      else if (entry.isFile() && entry.name.startsWith('tc_env') && isJson(entry.name)) candidates.push({ rel: `environments/${entry.name}`, abs: path.join(root, 'environments', entry.name) });
    }
    // The extension loads thunderLocalEnvironment.json at start whatever the layout, so the machine's private variables may live there even with v4.
    for (const name of rootFiles) {
      if (entryRole(name) === 'v3-local-environment') candidates.push({ rel: name, abs: path.join(root, name), emptyAs: 'v3-environments' });
    }
  } else {
    for (const name of rootFiles) {
      const role = entryRole(name);
      const emptyAs = EMPTY_V3_KIND[role];
      if (emptyAs !== undefined) candidates.push({ rel: name, abs: path.join(root, name), emptyAs });
    }
  }
  candidates.sort((a, b) => compareCodePoints(a.rel, b.rel));
  for (const candidate of candidates) await readJson(ctx, candidate.rel, candidate.abs, candidate.emptyAs);
  return finish(ctx, decision.layout);
}

const isJson = (name: string): boolean => name.toLowerCase().endsWith('.json');

/** The entries of a sub-folder, or none when it is missing, is a link, or its real path is outside the source. */
async function subfolder(ctx: Context, root: string, rootEntries: Dirent[], name: string): Promise<Dirent[]> {
  const entry = rootEntries.find(candidate => candidate.name === name);
  if (entry === undefined || !entry.isDirectory()) return [];
  const abs = path.join(root, name);
  try {
    const real = await fs.realpath(abs);
    if (!isInside(root, real)) {
      skipped(ctx, name, 'Skipped: the folder points outside the source.');
      return [];
    }
    return await listDir(abs);
  } catch (error) {
    skipped(ctx, name, `Skipped: the folder could not be read (${errorCode(error)}).`);
    return [];
  }
}

async function listDir(dir: string): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.sort((a, b) => compareCodePoints(a.name, b.name));
  } catch (error) {
    const code = errorCode(error);
    throw new SourceError(code === 'ENOENT' ? 'not-found' : 'not-readable', `The folder cannot be read (${code}).`);
  }
}

/** `candidate` is strictly inside `root`; paths are compared as the platform compares them. */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// ---------- one JSON file ----------

type Raw = { kind: 'ok'; buffer: Buffer } | { kind: 'too-large' } | { kind: 'error'; code: string };

/** Reads the whole file only if it fits `maxBytes`; the size is taken from the open handle, so the file cannot change between check and read. */
async function readLimited(abs: string, maxBytes: number): Promise<Raw> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: 'error', code: 'ENOTFILE' };
    if (stat.size > maxBytes) return { kind: 'too-large' };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { kind: 'ok', buffer: buffer.subarray(0, offset) };
  } catch (error) {
    return { kind: 'error', code: errorCode(error) };
  } finally {
    await handle?.close();
  }
}

async function readJson(ctx: Context, rel: string, abs: string, emptyAs?: ContentKind): Promise<void> {
  ctx.signal?.throwIfAborted();
  const where = printable(rel);
  const { limits } = ctx;

  if (ctx.filesRead >= limits.maxFiles) {
    if (!ctx.reported.files) ctx.findings.push(finding('TC-TOO-LARGE', where, 'Too many files; the rest were skipped.'));
    ctx.reported.files = true;
    return;
  }
  ctx.filesRead++;

  const raw = await readLimited(abs, limits.maxFileBytes);
  ctx.signal?.throwIfAborted();
  if (raw.kind === 'error') { ctx.findings.push(finding('TC-PARSE-ERROR', where, `The file could not be read (${raw.code}).`)); return; }
  if (raw.kind === 'too-large') { ctx.findings.push(finding('TC-TOO-LARGE', where, 'The file is larger than the size limit and was skipped.')); return; }

  // The global bounds stop the reading for good: once one is crossed, every file after it is skipped, so what was imported never depends on a lucky small file.
  if (ctx.reported.bytes || ctx.bytesRead + raw.buffer.length > limits.maxTotalBytes) {
    if (!ctx.reported.bytes) ctx.findings.push(finding('TC-TOO-LARGE', where, 'The total size limit was reached; this file and the rest were skipped.'));
    ctx.reported.bytes = true;
    return;
  }
  ctx.bytesRead += raw.buffer.length;

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw.buffer); // also drops a leading byte order mark
  } catch {
    ctx.findings.push(finding('TC-PARSE-ERROR', where, 'The file is not valid UTF-8.'));
    return;
  }
  if (exceedsDepth(text, limits.maxJsonDepth)) { ctx.findings.push(finding('TC-TOO-LARGE', where, 'The file nests deeper than the limit and was skipped.')); return; }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    ctx.findings.push(finding('TC-PARSE-ERROR', where, 'The file is not valid JSON.'));
    return;
  }
  if (hasOversizedString(json, limits.maxStringBytes)) { ctx.findings.push(finding('TC-TOO-LARGE', where, 'A text value is larger than the limit; the file was skipped.')); return; }

  let kind = classifyContent(json);
  // A known v3 file may legitimately be an empty list.
  if (kind === 'unrecognized' && emptyAs !== undefined && Array.isArray(json) && json.length === 0) kind = emptyAs;
  if (kind === 'unrecognized') { ctx.findings.push(finding('TC-PARSE-ERROR', where, 'The file is not recognised as Thunder Client data.', 'info')); return; }

  const requests = countRequests(kind, json);
  if (ctx.reported.requests || ctx.requestsSeen + requests > limits.maxRequests) {
    if (!ctx.reported.requests) ctx.findings.push(finding('TC-TOO-LARGE', where, 'The request limit was reached; this file and the rest were skipped.'));
    ctx.reported.requests = true;
    return;
  }
  ctx.requestsSeen += requests;
  ctx.files.push({ origin: where, kind, json });
}

function countRequests(kind: ContentKind, json: unknown): number {
  if (kind === 'v3-requests' && Array.isArray(json)) return json.length;
  if ((kind === 'v4-collection' || kind === 'export-collection') && typeof json === 'object' && json !== null) {
    const requests = (json as { requests?: unknown }).requests;
    return Array.isArray(requests) ? requests.length : 0;
  }
  return 0;
}

// ---------- reporting ----------

function skipped(ctx: Context, rel: string, message: string): void {
  ctx.findings.push(finding('TC-PARSE-ERROR', printable(rel), message, 'info'));
}

/** The error code of a failed disk call, only when it looks like one, so a message never carries a path from the system. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? code : 'ERROR';
}
