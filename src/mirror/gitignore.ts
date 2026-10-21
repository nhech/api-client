/**
 * With `apiClient.mirror.mode` set to `gitignored`, the generated `.http` files are written but kept out of Git, so that they do not
 * double the files of a pull request. Git cannot ignore a file by what is in it (a `.http` file of the person's own must stay visible),
 * so the generated files are listed one by one in a block of the `.gitignore` of the client's folder that this program owns: it is
 * written between two marker lines, replaced as a whole, and removed when the mode is another.
 */
export const BLOCK_BEGIN = '# api-client: generated .http files (this block is written by the extension, do not edit it)';
export const BLOCK_END = '# api-client: end of generated .http files';

export interface BlockChange { text: string | undefined; change: 'none' | 'created' | 'updated' | 'removed' }

const trimEnd = (lines: readonly string[]): string[] => {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
  return copy;
};

/** The `.gitignore` with its block for these paths (relative to the folder of the `.gitignore`), or without a block when there are none. A text that has no block and needs none is left as it is. */
export function withMirrorBlock(current: string | undefined, paths: readonly string[]): BlockChange {
  const eol = current !== undefined && current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current === undefined ? [] : current.split(/\r?\n/);
  const begin = lines.indexOf(BLOCK_BEGIN);
  const end = begin < 0 ? -1 : lines.indexOf(BLOCK_END, begin + 1);
  // A block that was begun and never ended (cut by hand) goes to the end of the file: it is ours, and it is rewritten whole.
  const stop = begin < 0 ? -1 : end < 0 ? lines.length - 1 : end;
  const before = trimEnd(begin < 0 ? lines : lines.slice(0, begin));
  const after = begin < 0 ? [] : lines.slice(stop + 1);
  const unique = [...new Set(paths)].sort();
  const made = (inside: readonly string[]): string => {
    const all = trimEnd([...before, ...inside, ...after]);
    return all.length === 0 ? '' : `${all.join(eol)}${eol}`;
  };
  if (unique.length === 0) return begin < 0 ? { text: current, change: 'none' } : { text: made([]), change: 'removed' };
  const text = made([BLOCK_BEGIN, ...unique, BLOCK_END]);
  if (current === undefined) return { text, change: 'created' };
  return text === current ? { text: current, change: 'none' } : { text, change: 'updated' };
}
