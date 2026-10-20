import type { TcAuth, TcSettings, TcTest } from '../model/source';
import type { Ancestry } from '../normalize/tree';
import { displayLabel } from '../util/chars';
import { isRecord } from '../normalize/guards';

/**
 * N15 to N19: what a request inherits from the folders above it and from its collection (spec 5.1). Thunder builds an
 * "effective request" by walking from the nearest folder up to the collection; each function here is that walk for one
 * kind of setting, as read from the extension's own code. Nothing here runs a script.
 *
 * The walk is bounded: at most MAX_INHERIT_LEVELS folders count, and a budget caps how many inherited items all requests
 * together may receive, so a hostile chain of folders cannot make the output explode.
 */
export const MAX_INHERIT_LEVELS = 1024;
export const DEFAULT_INHERIT_BUDGET = 2_000_000;

export interface Level {
  kind: 'folder' | 'collection';
  /** Shown in the report as where a value came from. */
  name: string;
  settings: TcSettings | undefined;
}

export class InheritBudget {
  exhausted = false;
  constructor(private remaining = DEFAULT_INHERIT_BUDGET) {}

  take(): boolean {
    if (this.remaining <= 0) { this.exhausted = true; return false; }
    this.remaining--;
    return true;
  }
}

const settingsOf = (value: unknown): TcSettings | undefined => (isRecord(value) ? (value as TcSettings) : undefined);

/** The levels above a request, nearest first, the collection last. `truncated` when more folders than the limit were above it. */
export function settingsLevels(ancestry: Ancestry | undefined, collection: { name: string; settings: TcSettings | undefined }, max = MAX_INHERIT_LEVELS): { levels: Level[]; truncated: boolean } {
  const levels: Level[] = [];
  let truncated = false;
  for (let link = ancestry; link !== undefined; link = link.up) {
    if (levels.length >= max) { truncated = true; break; }
    levels.push({ kind: 'folder', name: displayLabel(link.folder.name), settings: settingsOf(link.folder.settings) });
  }
  levels.push({ kind: 'collection', name: displayLabel(collection.name), settings: collection.settings });
  return { levels, truncated };
}

// ---------- N15: base URL ----------

/** The base URL of the nearest level that has one. */
export function inheritedBaseUrl(levels: readonly Level[]): { value: string; from: string } | undefined {
  for (const level of levels) {
    const options = level.settings?.options;
    const value = isRecord(options) ? options['baseUrl'] : undefined;
    if (typeof value === 'string' && value !== '') return { value, from: level.name };
  }
  return undefined;
}

/** A URL that is not absolute and does not start with a variable is prefixed with the base URL. */
export function applyBaseUrl(url: string, baseUrl: string): string {
  if (url === '') return url;
  const lower = url.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || url.startsWith('{{') ? url : baseUrl + url;
}

// ---------- N16: authentication ----------

export interface ResolvedAuth {
  /** `own`: the request has its own; `inherited`: from a level; `none`: nothing applies. */
  source: 'own' | 'inherited' | 'none';
  auth: TcAuth | undefined;
  from?: string;
}

const authType = (auth: TcAuth | undefined): string => (typeof auth?.type === 'string' && auth.type !== '' ? auth.type : 'inherit');

/**
 * A request with its own type (even "none") keeps it. Otherwise the nearest level with a type other than "inherit" decides:
 * "none" stops with no authentication, anything else is used as it is. The collection counts "inherit" as "none".
 */
export function resolveAuth(own: TcAuth | undefined, levels: readonly Level[]): ResolvedAuth {
  if (authType(own) !== 'inherit') return { source: 'own', auth: own };
  for (const level of levels) {
    const auth = isRecord(level.settings?.auth) ? (level.settings?.auth as TcAuth) : undefined;
    const type = authType(auth);
    if (type === 'none') return { source: 'none', auth: undefined };
    if (type !== 'inherit') return { source: 'inherited', auth, from: level.name };
  }
  return { source: 'none', auth: undefined };
}

// ---------- N17: headers ----------

export interface HeaderIn {
  name: string;
  value: string;
  enabled: boolean;
}
export interface InheritedHeader extends HeaderIn { from: string }

const headerValue = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');

/**
 * From the nearest level to the farthest, a header is added when the request has no enabled header of the same name, spelled
 * exactly the same (as Thunder compares). The nearest wins. A header keeps its own `isDisabled`.
 */
export function inheritHeaders(own: readonly HeaderIn[], levels: readonly Level[], budget: InheritBudget): InheritedHeader[] {
  const enabled = new Set(own.filter(header => header.enabled).map(header => header.name));
  const added: InheritedHeader[] = [];
  for (const level of levels) {
    const list = level.settings?.headers;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'] === '') continue;
      const name = item['name'];
      if (enabled.has(name)) continue;
      if (!budget.take()) return added;
      const isEnabled = item['isDisabled'] !== true;
      added.push({ name, value: headerValue(item['value']), enabled: isEnabled, from: level.name });
      if (isEnabled) enabled.add(name);
    }
  }
  return added;
}

// ---------- N18: tests ----------

/** For these actions a level's test is not added when the request already has one of the same type, custom and action. */
const DEDUPED_ACTIONS: ReadonlySet<string> = new Set(['equal', '<', '<=', '>', '>=', 'schema', 'istype', 'count', 'isjson']);

export interface InheritedTest { test: TcTest; from: string }

export function inheritTests(own: readonly TcTest[], levels: readonly Level[], budget: InheritBudget): InheritedTest[] {
  const present: TcTest[] = [...own];
  const added: InheritedTest[] = [];
  for (const level of levels) {
    const list = level.settings?.tests;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const test = item as TcTest;
      const action = test.action;
      const exists = typeof action === 'string' && DEDUPED_ACTIONS.has(action)
        && present.some(other => other.type === test.type && other.custom === test.custom && other.action === action);
      if (exists) continue;
      if (!budget.take()) return added;
      present.push(test);
      added.push({ test, from: level.name });
    }
  }
  return added;
}

// ---------- N19: scripts and "run first" ----------

export interface ScriptBlock { lines: string[]; /** The level it came from; none for the request's own. */ from?: string }

export interface CollectedScripts {
  pre: ScriptBlock[];
  post: ScriptBlock[];
  /** Some level, or the request, asks to run other requests first. */
  runRequests: boolean;
  /** Some level, or the request, only runs scripts and skips the request itself. */
  skipRequest: boolean;
}

function blocksOf(scripts: unknown, from: string | undefined): ScriptBlock[] {
  const inline = isRecord(scripts) ? scripts['inlineScripts'] : undefined;
  const blocks: ScriptBlock[] = [];
  if (!Array.isArray(inline)) return blocks;
  for (const item of inline) {
    const script = isRecord(item) ? item['script'] : undefined;
    if (!Array.isArray(script)) continue;
    const lines = script.filter((line): line is string => typeof line === 'string');
    if (lines.some(line => line.trim() !== '')) blocks.push(from === undefined ? { lines } : { lines, from });
  }
  return blocks;
}

/** Scripts from the farthest level to the nearest, then the request's own, as Thunder runs them. */
export function collectScripts(own: { preReq?: unknown; postReq?: unknown }, levels: readonly Level[]): CollectedScripts {
  const collected: CollectedScripts = { pre: [], post: [], runRequests: false, skipRequest: false };
  const note = (preReq: unknown): void => {
    if (!isRecord(preReq)) return;
    if (Array.isArray(preReq['runRequests']) && preReq['runRequests'].length > 0) collected.runRequests = true;
    const options = preReq['options'];
    if (isRecord(options) && options['skipRequest'] === true) collected.skipRequest = true;
  };
  for (const level of [...levels].reverse()) {
    collected.pre.push(...blocksOf(level.settings?.preReq, level.name));
    collected.post.push(...blocksOf(level.settings?.postReq, level.name));
    note(level.settings?.preReq);
  }
  collected.pre.push(...blocksOf(own.preReq, undefined));
  collected.post.push(...blocksOf(own.postReq, undefined));
  note(own.preReq);
  return collected;
}
