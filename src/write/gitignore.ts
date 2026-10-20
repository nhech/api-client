/**
 * The `.gitignore` lines that keep the private files out of Git (spec 6.4). Pure: it takes the text of the file (or undefined
 * when there is none) and returns the new text. The line ending of the file is kept, and a line that is already there, in the
 * forms that mean the same, is not added a second time.
 */
export const PRIVATE_PATTERN = 'http-client.private.env.json';

/** Every file the importer writes that holds a secret. */
export const PRIVATE_PATTERNS: readonly string[] = [PRIVATE_PATTERN, 'rest-client.private.settings.json'];

export type GitignoreChange = 'created' | 'updated' | 'present';

export function ensureIgnored(current: string | undefined, patterns: string | readonly string[] = PRIVATE_PATTERN): { text: string; change: GitignoreChange } {
  const wanted = typeof patterns === 'string' ? [patterns] : patterns;
  if (current === undefined) return { text: wanted.map(pattern => `${pattern}\n`).join(''), change: 'created' };
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const missing = wanted.filter(pattern => !present.has(pattern) && !present.has(`/${pattern}`) && !present.has(`**/${pattern}`));
  if (missing.length === 0) return { text: current, change: 'present' };
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const needsBreak = current !== '' && !current.endsWith('\n');
  return { text: `${current}${needsBreak ? eol : ''}${missing.map(pattern => `${pattern}${eol}`).join('')}`, change: 'updated' };
}
