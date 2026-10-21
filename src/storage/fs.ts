/**
 * What the storage needs from a file system, with paths that are relative to the workspace folder and written with `/`. The
 * logic of the store (src/storage/store.ts) knows nothing else, so it runs against a real folder, a folder VS Code exposes, or a
 * map in memory in a test.
 */
export type EntryKind = 'file' | 'dir' | 'other';

export interface DirEntry {
  name: string;
  /** A symbolic link, a junction or anything that is not a plain file or folder is `other`: the store never follows or reads it. */
  kind: EntryKind;
}

export interface StorageFs {
  /** The text of a file, or undefined when there is none. Throws for a file that is too large or is not a plain file. */
  read(path: string): Promise<string | undefined>;
  /** Writes the whole file or none of it (a temporary file next to it, then a rename), making the folders it needs. `mode` is the permission bits where the system has them. */
  write(path: string, text: string, mode?: number): Promise<void>;
  /** The entries of a folder; none when it does not exist. */
  list(path: string): Promise<DirEntry[]>;
  /** Moves a file or a folder; refuses to replace something that exists. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file, or a folder with everything in it. Nothing happens when it does not exist. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** Limits against a repository made to be slow or large; what goes past them is left out and reported. */
export const STORAGE_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxEntriesPerFolder: 5000,
  maxDepth: 32,
  maxNodes: 100_000,
  /** Files read at the same time. */
  parallelReads: 16
} as const;

export const joinPath = (...parts: string[]): string => parts.filter(part => part !== '').join('/');

export const parentPath = (path: string): string => {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
};

export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
