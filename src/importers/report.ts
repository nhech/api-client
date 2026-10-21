import { oneLine } from '../convert/text';
import { printable } from '../util/chars';
import { countImported, type Imported, type ImportedCounts } from './types';

/**
 * What an import says about itself, in words for the person: how much was found, and everything that could not be carried over, one line each.
 * The text comes from names and from sentences made here, never from a value of the data, and it is made printable all the same.
 */
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** "1 collection, 2 folders, 4 requests, 1 environment"; "nothing" when there is nothing. */
export function importSummary(counts: ImportedCounts): string {
  const parts: string[] = [];
  if (counts.collections > 0) parts.push(plural(counts.collections, 'collection'));
  if (counts.folders > 0) parts.push(plural(counts.folders, 'folder'));
  if (counts.requests > 0) parts.push(plural(counts.requests, 'request'));
  if (counts.environments > 0) parts.push(plural(counts.environments, 'environment'));
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}

const line = (text: string): string => printable(oneLine(text).text.trim());

/** The document that lists what an import did and did not carry over. */
export function renderNotes(source: string, imported: Imported): string {
  const lines: string[] = [`# Import from ${line(source)}`, '', `Found: ${importSummary(countImported(imported))}.`];
  if (imported.skipped > 0) lines.push(`${plural(imported.skipped, 'request was', 'requests were')} left out because ${imported.skipped === 1 ? 'it' : 'they'} cannot be sent from here (WebSocket, server-sent events, gRPC).`);
  if (imported.notes.length === 0) lines.push('', 'Everything was carried over.');
  else {
    lines.push('', `## What was not carried over, or was changed (${imported.notes.length})`, '');
    for (const note of imported.notes) lines.push(note.where === '' ? `- ${line(note.message)}` : `- **${line(note.where)}**: ${line(note.message)}`);
  }
  return `${lines.join('\n')}\n`;
}
