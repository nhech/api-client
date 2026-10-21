import { printable } from '../util/chars';
import type { ItemResult, ItemStatus, RunSummary } from '../runner/run';

/**
 * What the page of the collection runner and the extension say to each other. The page never runs anything: it asks to start or stop with a few
 * numbers, to choose a data file (the extension opens the dialog and reads the file) and to save a report; the extension tells it the results as
 * they come. Text that comes from a server or from a script is made printable here, once, before it reaches the page.
 */
export interface RunConfig {
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
}

export type RunnerToHost =
  | { type: 'ready'; violations: string[] }
  | { type: 'start'; config: RunConfig }
  | { type: 'stop' }
  | { type: 'chooseData' }
  | { type: 'clearData' }
  | { type: 'save'; format: 'json' | 'junit' }
  | { type: 'violation'; text: string };

export interface TestView { name: string; passed: boolean; message: string; source: 'request' | 'script' }

export interface ResultView {
  index: number;
  iteration: number;
  name: string;
  folder: string;
  method: string;
  status: ItemStatus;
  httpStatus: number | undefined;
  ms: number;
  size: number | undefined;
  tests: TestView[];
  error: string | undefined;
  notes: string[];
}

export interface SummaryView {
  iterations: number;
  requests: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  testsPassed: number;
  testsFailed: number;
  ms: number;
  stopped: RunSummary['stopped'];
}

export interface DataView {
  /** The name of the file, not its path. */
  name: string;
  rows: number;
  columns: string[];
  warnings: string[];
}

export type RunnerToView =
  | { type: 'init'; name: string; kind: 'collection' | 'folder'; environment: string; requests: number; data: DataView | undefined }
  | { type: 'data'; data: DataView | undefined; error?: string }
  | { type: 'started'; passes: number }
  | { type: 'result'; result: ResultView }
  | { type: 'done'; summary: SummaryView }
  | { type: 'problem'; message: string };

export const RUNNER_LIMITS = { iterations: 1000, delayMs: 60_000 } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (record: Record<string, unknown>, key: string): unknown => (Object.hasOwn(record, key) ? record[key] : undefined);

/** The message of the page, or undefined when it is not exactly one of the known shapes. The numbers are whole and inside the limits. */
export function parseRunnerToHost(raw: unknown): RunnerToHost | undefined {
  if (!isRecord(raw)) return undefined;
  const type = own(raw, 'type');
  if (type === 'stop' || type === 'chooseData' || type === 'clearData') return { type };
  if (type === 'violation') { const text = own(raw, 'text'); return typeof text === 'string' ? { type, text: text.slice(0, 200) } : undefined; }
  if (type === 'ready') {
    const given = own(raw, 'violations');
    return { type, violations: Array.isArray(given) ? given.filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 200)) : [] };
  }
  if (type === 'save') { const format = own(raw, 'format'); return format === 'json' || format === 'junit' ? { type, format } : undefined; }
  if (type === 'start') {
    const config = own(raw, 'config');
    if (!isRecord(config)) return undefined;
    const iterations = own(config, 'iterations');
    const delayMs = own(config, 'delayMs');
    if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1 || iterations > RUNNER_LIMITS.iterations) return undefined;
    if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > RUNNER_LIMITS.delayMs) return undefined;
    return { type, config: { iterations, delayMs, stopOnFailure: own(config, 'stopOnFailure') === true } };
  }
  return undefined;
}

const TEXT_LIMIT = 2000;
const cut = (text: string): string => printable(text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text);

export function resultView(result: ItemResult): ResultView {
  return {
    index: result.index, iteration: result.iteration, name: cut(result.item.name), folder: cut(result.item.folder), method: cut(result.item.method), status: result.status,
    httpStatus: result.httpStatus, ms: Math.round(result.ms), size: result.size,
    tests: result.tests.slice(0, 200).map(test => ({ name: cut(test.name), passed: test.passed, message: cut(test.message), source: test.source })),
    error: result.error === undefined ? undefined : cut(result.error), notes: result.notes.slice(0, 20).map(cut)
  };
}

export function summaryView(summary: RunSummary): SummaryView {
  return {
    iterations: summary.iterations, requests: summary.requests, passed: summary.passed, failed: summary.failed, errors: summary.errors, skipped: summary.skipped,
    testsPassed: summary.testsPassed, testsFailed: summary.testsFailed, ms: Math.round(summary.ms), stopped: summary.stopped
  };
}
