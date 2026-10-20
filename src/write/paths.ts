import { isHiddenChar } from '../util/chars';

/**
 * Checks on the paths the writer is asked to create (spec 6.4, 8.2). The emitter only makes safe names, but the writer is the
 * last line: it refuses anything that could leave the folder it was given, whoever produced it.
 */
const NAME_PUNCTUATION = '<>:"/\\|?*';
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT_CHARS = 200;
const MAX_PATH_CHARS = 1000;

/** Why a single file or folder name is not allowed, or undefined when it is fine. */
export function segmentProblem(segment: string): string | undefined {
  if (segment === '' || segment === '.' || segment === '..') return 'empty or relative name';
  if (Array.from(segment).length > MAX_SEGMENT_CHARS) return 'name too long';
  for (const char of segment) {
    if (NAME_PUNCTUATION.includes(char) || isHiddenChar(char)) return 'character not allowed in a name';
  }
  if (/[. ]$/.test(segment)) return 'name ends with a dot or a space';
  const dot = segment.indexOf('.');
  if (RESERVED.test(dot === -1 ? segment : segment.slice(0, dot))) return 'name reserved by Windows';
  return undefined;
}

/** A path made of safe names joined by "/" (never absolute, never "..", no drive letter). Undefined when fine, else the reason. */
export function relativePathProblem(path: string): string | undefined {
  if (path === '') return 'empty path';
  if (Array.from(path).length > MAX_PATH_CHARS) return 'path too long';
  if (path.startsWith('/')) return 'absolute path';
  for (const segment of path.split('/')) {
    const problem = segmentProblem(segment);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** The segments of a folder the person typed (either slash), or undefined with a reason. */
export function targetSegments(target: string): { segments: string[] } | { problem: string } {
  const trimmed = target.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (trimmed === '') return { problem: 'empty path' };
  const problem = relativePathProblem(trimmed);
  return problem === undefined ? { segments: trimmed.split('/') } : { problem };
}
