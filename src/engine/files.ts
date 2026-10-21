import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A file named in a request (the body of a binary request, a part of a form) as an absolute path, or undefined when it is not
 * allowed. The name is relative to the folder of the collection: it cannot be absolute, start with a drive or a share, or have a
 * `..` in it, and no step of the way to the file may be a link, so a collection that came from somewhere else cannot make the
 * client send a file from outside it (the key of a person's account, an environment file with secrets).
 */
export function confinedFile(baseDir: string, relative: string): string | undefined {
  if (relative === '' || relative.length > 1024 || relative.includes('\0')) return undefined;
  if (/^[\\/]|^[A-Za-z]:/.test(relative)) return undefined;
  const segments = relative.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  let current = baseDir;
  let stats;
  for (const segment of segments) {
    current = join(current, segment);
    try { stats = lstatSync(current); } catch { return undefined; }
    if (stats.isSymbolicLink()) return undefined;
  }
  return stats !== undefined && stats.isFile() ? current : undefined;
}
