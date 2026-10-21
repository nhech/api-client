import { createHash } from 'node:crypto';
import { printable } from '../util/chars';

/**
 * Consent to run the scripts of a collection. A collection that arrives from somebody else (a clone, a pull, a branch, an import) can hold
 * scripts, and a script can read every variable and send it anywhere, so nothing runs until the person has said yes to the code that
 * will run. What was agreed to is kept by the extension, never in the repository: for each script its place (the id of the collection,
 * folder or request and the stage) and the SHA-256 of its text, and the text itself when it is small enough to show what changed.
 *
 * A script is allowed when a script with exactly that text was agreed to in this collection. A script that is not is new (nothing was
 * agreed to in its place) or changed (something else was); either way the person is asked before it runs, and shown the difference.
 */

export interface ScriptToRun {
  /** Where the script is and when it runs; see `scriptKey`. */
  key: string;
  phase: 'pre' | 'post';
  /** For people: "request", or the name of the folder or the collection. */
  from: string;
  code: string;
}

export interface ApprovedScript {
  key: string;
  hash: string;
  /** The text that was agreed to, when it is not large; it is what a change is shown against. */
  code?: string;
}

export interface PendingScript extends ScriptToRun {
  hash: string;
  status: 'new' | 'changed';
  /** The text that was agreed to in this place before. */
  previous?: string;
}

export const MAX_APPROVED = 500;
export const MAX_SNAPSHOT_CHARS = 64 * 1024;

export const digest = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');

/** The place of a script: the stage and the id of the collection, folder or request it is written in (an id survives a rename). */
export const scriptKey = (phase: 'pre' | 'post', id: string): string => `${phase}|${id}`;

/** The scripts that may not run yet. */
export function pendingScripts(scripts: readonly ScriptToRun[], approved: readonly ApprovedScript[]): PendingScript[] {
  const agreed = new Set(approved.map(entry => entry.hash));
  const pending: PendingScript[] = [];
  for (const script of scripts) {
    const hash = digest(script.code);
    if (agreed.has(hash)) continue;
    const before = approved.find(entry => entry.key === script.key);
    pending.push({ ...script, hash, status: before === undefined ? 'new' : 'changed', ...(before?.code === undefined ? {} : { previous: before.code }) });
  }
  return pending;
}

/** What is agreed to after the person said yes to these: they replace what was agreed to in their places; the oldest go when there are too many. */
export function approve(approved: readonly ApprovedScript[], pending: readonly PendingScript[]): ApprovedScript[] {
  const places = new Set(pending.map(script => script.key));
  const added = pending.map((script): ApprovedScript => ({ key: script.key, hash: script.hash, ...(script.code.length <= MAX_SNAPSHOT_CHARS ? { code: script.code } : {}) }));
  return [...approved.filter(entry => !places.has(entry.key)), ...added].slice(-MAX_APPROVED);
}

const ownValue = (item: object, name: string): unknown => (Object.hasOwn(item, name) ? Reflect.get(item, name) : undefined);

/** Reads what was kept: anything that is not an entry of the right shape is dropped, so a damaged store asks again instead of allowing. */
export function readApproved(value: unknown): ApprovedScript[] {
  if (!Array.isArray(value)) return [];
  const entries: ApprovedScript[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const key = ownValue(item, 'key');
    const hash = ownValue(item, 'hash');
    const code = ownValue(item, 'code');
    if (typeof key !== 'string' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || entries.length >= MAX_APPROVED) continue;
    entries.push({ key, hash, ...(typeof code === 'string' && code.length <= MAX_SNAPSHOT_CHARS && digest(code) === hash ? { code } : {}) });
  }
  return entries;
}

/** Every way a line can end in a text that is read as lines: CR LF, CR, LF, NEL and the separators of Unicode. */
const LINE_ENDS = new RegExp('\\r\\n|[\\r\\n' + String.fromCodePoint(0x85, 0x2028, 0x2029) + ']');

/** One line for each script that is waiting, for the question to the person. */
export function describePending(pending: readonly PendingScript[]): string[] {
  return pending.map(script => {
    const lines = script.code.split(LINE_ENDS).length;
    return `${script.status === 'new' ? 'New' : 'Changed'}: the script ${script.phase === 'pre' ? 'before the request' : 'after the answer'} of ${printable(script.from).slice(0, 80)} (${lines} ${lines === 1 ? 'line' : 'lines'})`;
  });
}

/** The most that one line of a script shows in the question: the rest of a long line is said to be there, so that the lines below it are not pushed out of sight. */
const ROW_CHARS = 160;

/**
 * The beginning of a script as the question shows it: the lines as they are (a script is read by its lines, so a line break is kept, and a tab is two spaces),
 * each made printable so that nothing hidden or reversing the text is in it and cut when it is long, a run of empty lines shown as one, then cut to a number of
 * lines and of characters, with `...` when there is more.
 */
export function previewOf(code: string, maxLines: number, maxChars: number): string {
  const rows: string[] = [];
  for (const row of code.split(LINE_ENDS)) {
    const clean = printable(row.replace(/\t/g, '  '));
    if (clean.trim() === '' && rows.length > 0 && rows[rows.length - 1] === '') continue;
    rows.push(clean.trim() === '' ? '' : clean.length > ROW_CHARS ? `${clean.slice(0, ROW_CHARS)} [... ${clean.length - ROW_CHARS} more characters on this line]` : clean);
  }
  const shown = rows.slice(0, maxLines).join('\n');
  const cut = shown.length > maxChars ? `${shown.slice(0, maxChars)}...` : shown;
  return `${cut}${rows.length > maxLines || shown.length > maxChars ? '\n...' : ''}`;
}
