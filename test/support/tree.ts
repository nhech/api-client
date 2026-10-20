import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A file of a test tree: text, raw bytes, or a value written as JSON. */
export type FileContent = string | Buffer | object;

export interface Tree {
  readonly root: string;
  write(rel: string, content: FileContent): void;
  /** A path inside the tree, for tests that hand a file to the reader. */
  path(rel: string): string;
  cleanup(): void;
}

/** A disposable folder with the given files; `rel` uses forward slashes. */
export function makeTree(files: Readonly<Record<string, FileContent>> = {}): Tree {
  const root = mkdtempSync(join(tmpdir(), 'api-client-importer-'));
  const write = (rel: string, content: FileContent) => {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, write, path: rel => join(root, ...rel.split('/')), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A line per file with its size and modification time, to prove that a reader changed nothing. */
export function snapshot(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) { lines.push(`${prefix}${name}/`); walk(full, `${prefix}${name}/`); } else lines.push(`${prefix}${name} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(root, '');
  return lines.join('\n');
}

/** Creates a link, or returns false when the system does not allow it (Windows without the privilege): the test then skips. */
export function tryLink(target: string, link: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

export const collection = (name: string, requests: object[] = []) => ({ _id: `c-${name}`, colName: name, folders: [], requests });
export const environment = (name: string) => ({ _id: `e-${name}`, name, data: [] });
export const request = (colId: string, name: string) => ({ _id: `r-${name}`, colId, containerId: '', name, url: 'https://example.invalid/', method: 'GET' });
