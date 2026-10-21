import { textHash } from '../util/hash';
import type { Mirror } from './generate';

/**
 * What a generated `.http` file is, and what to do when it and the request that it was made from do not agree any more. The first line of a
 * generated file says that it is generated, from which file, and carries the fingerprint of everything below it as it was written:
 *
 *   # api-client generated v1 src=list-pets.req.yml h=0123456789abcd -- edit the .req.yml, not this file
 *
 * From that line, the text below it and the text that the request would give now, there are six cases (see `classify`). The one rule
 * above the others: a file that a person has changed is never overwritten, and a file that is not generated (no such first line) is
 * never touched.
 */

const PREFIX = '# api-client generated v1 ';
const SUFFIX = ' -- edit the .req.yml, not this file';
const HEADER = /^# api-client generated v1 src=(\S+) h=([0-9a-f]{14}) -- edit the \.req\.yml, not this file$/;

export interface MirrorHeader { source: string; hash: string }

/** The first line of a generated file. */
export function headerLine(source: string, hash: string): string {
  return `${PREFIX}src=${source.replace(/\s+/g, '_')} h=${hash}${SUFFIX}`;
}

export function parseHeaderLine(line: string): MirrorHeader | undefined {
  const found = HEADER.exec(line);
  return found === null ? undefined : { source: found[1] as string, hash: found[2] as string };
}

/** A file as the program writes it: the header, then the block. */
export const mirrorFile = (source: string, mirror: Mirror): string => `${headerLine(source, mirror.hash)}\n${mirror.block}`;

/** Text with `\n` line ends: a checkout that turned them into `\r\n` is not a change by hand. */
const lf = (text: string): string => text.replace(/\r\n?/g, '\n');

export interface Split { header: MirrorHeader | undefined; block: string }

export function splitFile(text: string): Split {
  const clean = lf(text);
  const end = clean.indexOf('\n');
  const first = end < 0 ? clean : clean.slice(0, end);
  const header = parseHeaderLine(first);
  return header === undefined ? { header, block: clean } : { header, block: end < 0 ? '' : clean.slice(end + 1) };
}

/**
 * - `missing`: there is no file; write it.
 * - `foreign`: there is a file with no header: the person's own, leave it alone.
 * - `in-sync`: nothing to do.
 * - `stale-header`: the block is what the request gives now, but the header is not: write the file again (nothing is lost).
 * - `regenerate`: the request changed and nobody touched the file: write it again.
 * - `edited`: somebody changed the file and the request did not: offer to take the edits into the request, to throw them away, or to let go of the file.
 * - `both`: both changed: say so and show the difference; write nothing.
 */
export type Drift = 'missing' | 'foreign' | 'in-sync' | 'stale-header' | 'regenerate' | 'edited' | 'both';

export function classify(file: string | undefined, mirror: Mirror): Drift {
  if (file === undefined) return 'missing';
  const { header, block } = splitFile(file);
  if (header === undefined) return 'foreign';
  if (block === mirror.block) return header.hash === mirror.hash ? 'in-sync' : 'stale-header';
  const edited = textHash(block) !== header.hash;
  const changed = mirror.hash !== header.hash;
  if (!edited) return 'regenerate';
  return changed ? 'both' : 'edited';
}
