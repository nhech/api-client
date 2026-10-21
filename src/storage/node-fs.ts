import { randomBytes } from 'node:crypto';
import { promises as disk } from 'node:fs';
import { join } from 'node:path';
import { segmentProblem } from '../write/paths';
import { STORAGE_LIMITS, type DirEntry, type StorageFs } from './fs';

/**
 * A StorageFs over a real folder. Paths are checked name by name (no `..`, no name Windows reserves), a link is never followed
 * (a link is reported as `other` when listed, refused when read, and removed itself, not what it points to, when removed), and
 * a write goes to a temporary file in the same folder that is renamed over the target, so a file is whole or not there.
 */
export class NodeFs implements StorageFs {
  constructor(private readonly root: string) {}

  private resolve(path: string): { absolute: string; segments: string[] } {
    const segments = path === '' ? [] : path.split('/');
    for (const segment of segments) {
      const problem = segmentProblem(segment);
      if (problem !== undefined) throw new Error(`the name "${segment}" is not allowed: ${problem}`);
    }
    return { absolute: join(this.root, ...segments), segments };
  }

  /** Every folder between the root and the target must be a real folder and not a link someone planted in the repository. */
  private async checkAncestors(segments: readonly string[]): Promise<void> {
    let current = this.root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let stats;
      try { stats = await disk.lstat(current); } catch (error) { if (isMissing(error)) return; throw error; }
      if (!stats.isDirectory()) throw new Error(`${segment} is a link or not a folder`);
    }
  }

  async read(path: string): Promise<string | undefined> {
    const { absolute, segments } = this.resolve(path);
    await this.checkAncestors(segments);
    let stats;
    try { stats = await disk.lstat(absolute); } catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (!stats.isFile()) throw new Error('not a plain file (a link or a folder)');
    if (stats.size > STORAGE_LIMITS.maxFileBytes) throw new Error(`larger than ${STORAGE_LIMITS.maxFileBytes} bytes`);
    return disk.readFile(absolute, 'utf8');
  }

  async write(path: string, text: string, mode?: number): Promise<void> {
    const { absolute, segments } = this.resolve(path);
    await this.checkAncestors(segments);
    const folder = join(absolute, '..');
    await disk.mkdir(folder, { recursive: true });
    try {
      const existing = await disk.lstat(absolute);
      if (!existing.isFile()) throw new Error('the target is a link or a folder: it is not replaced');
    } catch (error) { if (!isMissing(error)) throw error; }
    const temporary = join(folder, `.${segments[segments.length - 1] ?? 'file'}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await disk.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) });
      await disk.rename(temporary, absolute);
    } catch (error) {
      await disk.rm(temporary, { force: true });
      throw error;
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const { absolute, segments } = this.resolve(path);
    await this.checkAncestors(segments);
    try {
      // A link to a folder is not listed: it would show what is outside the workspace.
      if (segments.length > 0 && !(await disk.lstat(absolute)).isDirectory()) return [];
      const entries = await disk.readdir(absolute, { withFileTypes: true });
      return entries.map(entry => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other' }));
    } catch (error) {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.resolve(from);
    const target = this.resolve(to);
    await this.checkAncestors(source.segments);
    await this.checkAncestors(target.segments);
    if (await this.exists(to)) throw new Error(`${to} exists already`);
    await disk.mkdir(join(target.absolute, '..'), { recursive: true });
    await disk.rename(source.absolute, target.absolute);
  }

  async remove(path: string): Promise<void> {
    const { absolute, segments } = this.resolve(path);
    if (segments.length === 0) throw new Error('the root of the workspace is not removed');
    await this.checkAncestors(segments);
    let stats;
    try { stats = await disk.lstat(absolute); } catch (error) { if (isMissing(error)) return; throw error; }
    if (stats.isDirectory()) await disk.rm(absolute, { recursive: true, force: true });
    else await disk.unlink(absolute);
  }

  async exists(path: string): Promise<boolean> {
    const { absolute, segments } = this.resolve(path);
    await this.checkAncestors(segments);
    try { await disk.lstat(absolute); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
  }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
