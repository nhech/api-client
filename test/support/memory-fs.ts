import { STORAGE_LIMITS, type DirEntry, type StorageFs } from '../../src/storage/fs';

/** A StorageFs in memory for tests: files are strings, folders exist while a file is under them, and a link is an entry the store must not follow. */
export class MemoryFs implements StorageFs {
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, number | undefined>();
  private readonly folders = new Set<string>(['']);
  private readonly links = new Set<string>();
  /** Calls of write() that should fail, by path suffix, once each. */
  failWrites: string[] = [];
  readonly log: string[] = [];

  seed(files: Record<string, string>): this {
    for (const [path, text] of Object.entries(files)) this.put(path, text);
    return this;
  }

  private put(path: string, text: string, mode?: number): void {
    this.files.set(path, text);
    this.modes.set(path, mode);
    let folder = path;
    while (folder.includes('/')) { folder = folder.slice(0, folder.lastIndexOf('/')); this.folders.add(folder); }
  }

  /** A symbolic link or special file at `path`. */
  link(path: string): this {
    this.links.add(path);
    return this;
  }

  async read(path: string): Promise<string | undefined> {
    if (this.links.has(path)) throw new Error('not a plain file (a link or a folder)');
    const text = this.files.get(path);
    if (text !== undefined && text.length > STORAGE_LIMITS.maxFileBytes) throw new Error('too large');
    return text;
  }

  async write(path: string, text: string, mode?: number): Promise<void> {
    const failing = this.failWrites.findIndex(suffix => path.endsWith(suffix));
    if (failing >= 0) { this.failWrites.splice(failing, 1); throw new Error(`disk full while writing ${path}`); }
    this.log.push(`write ${path}`);
    this.put(path, text, mode);
  }

  async list(path: string): Promise<DirEntry[]> {
    const prefix = path === '' ? '' : `${path}/`;
    const entries = new Map<string, DirEntry>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, { name: rest, kind: 'file' });
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'dir' });
    }
    for (const link of this.links) if (link.startsWith(prefix) && !link.slice(prefix.length).includes('/')) entries.set(link.slice(prefix.length), { name: link.slice(prefix.length), kind: 'other' });
    return [...entries.values()];
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`${to} exists already`);
    this.log.push(`rename ${from} -> ${to}`);
    const moved: [string, string][] = [];
    for (const file of this.files.keys()) {
      if (file === from) moved.push([file, to]);
      else if (file.startsWith(`${from}/`)) moved.push([file, to + file.slice(from.length)]);
    }
    if (moved.length === 0) throw new Error(`${from} does not exist`);
    for (const [old, next] of moved) {
      const text = this.files.get(old) as string;
      const mode = this.modes.get(old);
      this.files.delete(old);
      this.modes.delete(old);
      this.put(next, text, mode);
    }
  }

  async remove(path: string): Promise<void> {
    this.log.push(`remove ${path}`);
    for (const file of [...this.files.keys()]) if (file === path || file.startsWith(`${path}/`)) { this.files.delete(file); this.modes.delete(file); }
    this.links.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    if (this.files.has(path) || this.links.has(path)) return true;
    for (const file of this.files.keys()) if (file.startsWith(`${path}/`)) return true;
    return false;
  }

  /** Every file path, sorted, for assertions. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
