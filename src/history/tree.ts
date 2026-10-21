import { isoTime } from '../core/vars';
import type { HistoryEntry } from './entries';

/**
 * The history as the side bar shows it: one folder for each day (today and yesterday by name), and under it what was sent that day, newest first.
 * Pure: the extension turns the nodes into tree items, and says what the offset of the time zone was (the clock of the person decides which day a
 * send belongs to; this code does not read a clock).
 */
export type HistoryIcon = 'day' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'failed' | 'info';

export interface HistoryNode {
  id: string;
  kind: 'day' | 'entry';
  label: string;
  description: string;
  tooltip: string;
  icon: HistoryIcon;
  children: HistoryNode[];
}

const DAY_MS = 86_400_000;
const two = (value: number): string => String(value).padStart(2, '0');

/** The day an entry belongs to, as `YYYY-MM-DD`, for a clock that is `offsetMinutes` east of UTC. */
export const dayOf = (at: number, offsetMinutes = 0): string => isoTime(at + offsetMinutes * 60_000).slice(0, 10);

/** The time of day as `HH:MM`, for a clock that is `offsetMinutes` east of UTC. */
export function clockOf(at: number, offsetMinutes = 0): string {
  const local = at + offsetMinutes * 60_000;
  const inDay = ((local % DAY_MS) + DAY_MS) % DAY_MS;
  return `${two(Math.floor(inDay / 3_600_000))}:${two(Math.floor((inDay % 3_600_000) / 60_000))}`;
}

const iconOf = (entry: HistoryEntry): HistoryIcon => {
  if (entry.status === undefined) return 'failed';
  if (entry.status >= 500) return 'server-error';
  if (entry.status >= 400) return 'client-error';
  if (entry.status >= 300) return 'redirect';
  return entry.status >= 200 ? 'success' : 'info';
};

/** The address without its scheme and without the query, which is what fits in a line of the side bar. */
export function shortUrl(url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const query = withoutScheme.indexOf('?');
  const shown = query < 0 ? withoutScheme : withoutScheme.slice(0, query);
  return shown.length > 80 ? `${shown.slice(0, 77)}...` : shown;
}

export function entryNode(entry: HistoryEntry, offsetMinutes = 0): HistoryNode {
  const outcome = entry.status === undefined ? 'failed' : String(entry.status);
  const tip = [`${entry.method} ${entry.url}`, entry.error !== undefined ? `Failed: ${entry.error}` : `${entry.status ?? ''} ${entry.statusText ?? ''}`.trim(), `${entry.ms} ms`, entry.name === '' ? '' : `Request: ${entry.name}`, entry.environment === '' ? '' : `Environment: ${entry.environment}`];
  return {
    id: `entry:${entry.id}`, kind: 'entry', label: `${entry.method} ${shortUrl(entry.url)}`, description: `${outcome} - ${entry.ms} ms - ${clockOf(entry.at, offsetMinutes)}`,
    tooltip: tip.filter(line => line !== '').join('\n'), icon: iconOf(entry), children: []
  };
}

/** The nodes: the days, newest first, the first one open. `offsetOf` gives the offset of the clock for the moment of an entry, so that a change of summer time does not move a send to another day. */
export function historyTree(entries: readonly HistoryEntry[], now: number, offsetOf: (at: number) => number = () => 0): HistoryNode[] {
  const today = dayOf(now, offsetOf(now));
  const yesterday = dayOf(now - DAY_MS, offsetOf(now - DAY_MS));
  const days = new Map<string, HistoryNode>();
  for (const entry of [...entries].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))) {
    const offset = offsetOf(entry.at);
    const day = dayOf(entry.at, offset);
    let node = days.get(day);
    if (node === undefined) {
      node = { id: `day:${day}`, kind: 'day', label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : day, description: '', tooltip: day, icon: 'day', children: [] };
      days.set(day, node);
    }
    node.children.push(entryNode(entry, offset));
  }
  const nodes = [...days.values()];
  for (const node of nodes) node.description = `${node.children.length}`;
  return nodes;
}
