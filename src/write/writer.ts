import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import type { ConflictPolicy, OutputFile } from '../pipeline';
import { PRIVATE_PATTERNS, ensureIgnored } from './gitignore';
import type { GitignoreChange } from './gitignore';
import { relativePathProblem, targetSegments } from './paths';

/**
 * The only code that writes to disk (spec 6.4). The rules:
 *
 *  - nothing is written outside the workspace folder it is given, and no part of a path may be a link;
 *  - by default into a new folder: an existing folder that is not empty is never touched, the files go to `name-2`, `name-3`...;
 *  - the files are first written in a staging folder next to the target and moved into place at the end, so that a failure or a
 *    cancel leaves the target as it was (a merge undoes what it already moved);
 *  - the private environment file gets mode 0600 where the system has modes, and `.gitignore` is made to ignore it BEFORE the
 *    file appears.
 */
export class WriteError extends Error {
  constructor(readonly code: 'invalid-target' | 'invalid-file' | 'unsafe-path' | 'exists' | 'no-space' | 'io' | 'aborted', message: string) {
    super(message);
    this.name = 'WriteError';
  }
}

export interface WriteRequest {
  /** The folder the person opened in VS Code. It must exist. */
  workspaceRoot: string;
  /** Folder inside the workspace that receives the files, such as "api". */
  targetDir: string;
  policy: ConflictPolicy;
  files: readonly OutputFile[];
  signal?: AbortSignal;
  /** Test seam: called before each file is moved into place; throwing simulates a failure half way. */
  beforeMove?: (index: number, path: string) => void | Promise<void>;
}

export type FileAction = 'create' | 'overwrite' | 'skip';

export interface PlannedFile { path: string; action: FileAction; bytes: number }

export interface WritePlan {
  /** The folder that will receive the files, relative to the workspace with "/" (it differs from the request when "new-folder" had to pick another). */
  targetDir: string;
  renamed: boolean;
  files: PlannedFile[];
  /** What happens to the workspace `.gitignore`: nothing is written when the private file is not written. */
  gitignore: GitignoreChange | 'not-needed';
}

export interface WriteOutcome {
  plan: WritePlan;
  /** Paths relative to the workspace root. */
  written: string[];
  skipped: string[];
  overwritten: string[];
}

const code = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
const lstat = async (target: string): Promise<Stats | undefined> => {
  try { return await fs.lstat(target); } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return undefined;
    throw error;
  }
};
const io = (error: unknown): WriteError => error instanceof WriteError ? error : new WriteError('io', `Could not write the files (${code(error) ?? 'error'}).`);

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WriteError('aborted', 'The import was cancelled; nothing was changed.');
}

/** Walks down from `root` along `segments`; throws if an existing part is a link or is not a folder. Returns whether the whole path exists. */
async function inspectPath(root: string, segments: readonly string[], what: string): Promise<'missing' | 'directory' | 'file'> {
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats === undefined) return 'missing';
    if (stats.isSymbolicLink()) throw new WriteError('unsafe-path', `${what} goes through a link, which is not followed.`);
    const last = index === segments.length - 1;
    if (!stats.isDirectory()) {
      if (last && stats.isFile()) return 'file';
      throw new WriteError('exists', `${what} is blocked by something that is not a folder.`);
    }
  }
  return 'directory';
}

const isEmptyDirectory = async (dir: string): Promise<boolean> => (await fs.readdir(dir)).length === 0;

function validate(request: WriteRequest): string[] {
  const target = targetSegments(request.targetDir);
  if ('problem' in target) throw new WriteError('invalid-target', `The target folder is not valid: ${target.problem}.`);
  const seen = new Set<string>();
  for (const file of request.files) {
    const problem = relativePathProblem(file.path);
    if (problem !== undefined) throw new WriteError('invalid-file', `A file path is not valid: ${problem}.`);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new WriteError('invalid-file', 'Two files would have the same path.');
    seen.add(key);
  }
  return target.segments;
}

const slash = (segments: readonly string[]): string => segments.join('/');

/** What a write would do, without changing anything: the final folder, the action for each file, and the `.gitignore` change. */
export async function planWrite(request: WriteRequest): Promise<WritePlan> {
  const segments = validate(request);
  const root = path.resolve(request.workspaceRoot);
  const rootStats = await lstat(root);
  if (rootStats === undefined || !(await fs.stat(root)).isDirectory()) throw new WriteError('invalid-target', 'The workspace folder does not exist.');

  let finalSegments = segments;
  let renamed = false;
  if (request.policy === 'new-folder') {
    let candidate = segments;
    for (let n = 2; ; n++) {
      const state = await inspectPath(root, candidate, 'The target folder');
      if (state === 'missing') break;
      if (state === 'directory' && await isEmptyDirectory(path.join(root, ...candidate))) break;
      if (n > 1000) throw new WriteError('exists', 'Too many folders with that name already exist.');
      candidate = [...segments.slice(0, -1), `${segments[segments.length - 1] ?? 'api'}-${n}`];
      renamed = true;
    }
    finalSegments = candidate;
  } else if (await inspectPath(root, segments, 'The target folder') === 'file') {
    throw new WriteError('exists', 'The target folder is a file.');
  }

  const files: PlannedFile[] = [];
  for (const file of [...request.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const parts = file.path.split('/');
    const state = await inspectPath(root, [...finalSegments, ...parts], `The path ${file.path}`);
    const bytes = Buffer.byteLength(file.content);
    if (state === 'missing') files.push({ path: file.path, action: 'create', bytes });
    else if (state === 'directory') throw new WriteError('exists', `The path ${file.path} is a folder where a file should go.`);
    else if (request.policy === 'overwrite') files.push({ path: file.path, action: 'overwrite', bytes });
    else if (request.policy === 'skip-existing') files.push({ path: file.path, action: 'skip', bytes });
    else throw new WriteError('exists', `The path ${file.path} already exists.`);
  }

  const privateNames = privateFilesWritten(files);
  let gitignore: WritePlan['gitignore'] = 'not-needed';
  if (privateNames.length > 0) {
    const target = path.join(root, '.gitignore');
    const stats = await lstat(target);
    if (stats !== undefined && (stats.isSymbolicLink() || !stats.isFile())) throw new WriteError('unsafe-path', 'The .gitignore of the workspace is not a plain file, so the private file would not be protected.');
    gitignore = ensureIgnored(stats === undefined ? undefined : await fs.readFile(target, 'utf8'), privateNames).change;
  }
  return { targetDir: slash(finalSegments), renamed, files, gitignore };
}

async function replaceFile(root: string, target: string, text: string): Promise<void> {
  const temporary = path.join(root, `.gitignore.${process.pid}.tmp`);
  await fs.writeFile(temporary, text, { flag: 'w' });
  try { await fs.rename(temporary, target); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

/** The private files (the names `.gitignore` must have) among the files that are really written. */
const privateFilesWritten = (files: readonly PlannedFile[]): string[] => [...new Set(files.filter(file => file.action !== 'skip').map(file => path.posix.basename(file.path)).filter(name => PRIVATE_PATTERNS.includes(name)))];

/** Makes `.gitignore` name the private files; returns the step that puts the file back as it was. */
async function updateGitignore(root: string, names: readonly string[]): Promise<() => Promise<void>> {
  const target = path.join(root, '.gitignore');
  const stats = await lstat(target);
  const original = stats === undefined ? undefined : await fs.readFile(target, 'utf8');
  const result = ensureIgnored(original, names);
  if (result.change === 'present') return async () => undefined;
  await replaceFile(root, target, result.text);
  return original === undefined ? () => fs.rm(target, { force: true }) : () => replaceFile(root, target, original);
}

/** Plans again (the disk may have changed since a preview) and then writes. Throws a WriteError and leaves the target as it was on any failure. */
export async function writeFiles(request: WriteRequest): Promise<WriteOutcome> {
  checkSignal(request.signal);
  const plan = await planWrite(request);
  const root = path.resolve(request.workspaceRoot);
  const finalSegments = plan.targetDir.split('/');
  const finalDir = path.join(root, ...finalSegments);
  const byPath = new Map(request.files.map(file => [file.path, file]));

  let staging: string | undefined;
  const undo: (() => Promise<void>)[] = [];
  try {
    if (plan.gitignore !== 'not-needed') undo.push(await updateGitignore(root, privateFilesWritten(plan.files)));

    staging = await fs.mkdtemp(path.join(root, '.api-import-'));
    const incoming = path.join(staging, 'new');
    for (const item of plan.files) {
      if (item.action === 'skip') continue;
      checkSignal(request.signal);
      const file = byPath.get(item.path);
      if (file === undefined) continue;
      const destination = path.join(incoming, ...item.path.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.content, { flag: 'wx', mode: file.mode ?? 0o666 });
      if (file.mode !== undefined) await fs.chmod(destination, file.mode);
    }
    checkSignal(request.signal);

    if (request.policy === 'new-folder') {
      const firstNew = await fs.mkdir(path.dirname(finalDir), { recursive: true });
      if (firstNew !== undefined) undo.push(() => fs.rm(firstNew, { recursive: true, force: true }));
      if ((await lstat(finalDir)) !== undefined) await fs.rmdir(finalDir);
      await request.beforeMove?.(0, plan.targetDir);
      await fs.rename(incoming, finalDir);
      undo.length = 0;
    } else {
      let index = 0;
      for (const item of plan.files) {
        if (item.action === 'skip') continue;
        await request.beforeMove?.(index++, item.path);
        const destination = path.join(finalDir, ...item.path.split('/'));
        const firstNew = await fs.mkdir(path.dirname(destination), { recursive: true });
        if (firstNew !== undefined) undo.push(() => fs.rm(firstNew, { recursive: true, force: true }));
        let previous: string | undefined;
        if (item.action === 'overwrite') {
          previous = path.join(staging, 'previous', String(index));
          await fs.mkdir(path.dirname(previous), { recursive: true });
          await fs.rename(destination, previous);
        }
        await fs.rename(path.join(incoming, ...item.path.split('/')), destination);
        undo.push(async () => {
          await fs.rm(destination, { force: true });
          if (previous !== undefined) await fs.rename(previous, destination);
        });
      }
      undo.length = 0;
    }
  } catch (error) {
    for (const step of undo.reverse()) { try { await step(); } catch { /* best effort: the next step still runs */ } }
    throw io(error);
  } finally {
    if (staging !== undefined) await fs.rm(staging, { recursive: true, force: true });
  }

  const prefix = plan.targetDir;
  return {
    plan,
    written: plan.files.filter(file => file.action === 'create').map(file => `${prefix}/${file.path}`),
    overwritten: plan.files.filter(file => file.action === 'overwrite').map(file => `${prefix}/${file.path}`),
    skipped: plan.files.filter(file => file.action === 'skip').map(file => `${prefix}/${file.path}`)
  };
}
