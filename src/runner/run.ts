/**
 * The collection runner: the requests of a collection or a folder, one after the other, once for each row of a data file or as many times as asked,
 * with a pause between them. It does not send anything itself: `execute` is given, so that the same code runs against the real engine and against a
 * fake in a test. Flow follows what scripts say: `setNextRequest("name")` goes to that request, `setNextRequest(null)` ends the pass, a request that a
 * script skipped is skipped. A run is bounded (a script that always jumps back cannot run for ever) and ends when it is cancelled.
 */
export interface RunItem {
  /** The file of the request, relative to the workspace folder. */
  path: string;
  name: string;
  method: string;
  /** The address as it is written (unresolved), for the list. */
  url: string;
  /** The folders between the collection and the request, as text: "Orders/Archive". */
  folder: string;
}

export interface TestOutcome {
  name: string;
  passed: boolean;
  message: string;
  source: 'request' | 'script';
}

export type ItemStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface ItemResult {
  /** The place of this execution in the run, from 0. */
  index: number;
  /** The pass, from 0. */
  iteration: number;
  item: RunItem;
  status: ItemStatus;
  httpStatus?: number;
  statusText?: string;
  /** How long the request took, in milliseconds. */
  ms: number;
  size?: number;
  tests: TestOutcome[];
  /** Why there was no answer, or what a script said when it failed. */
  error?: string;
  notes: string[];
}

export interface IterationInfo {
  index: number;
  count: number;
  data: Readonly<Record<string, string>>;
}

/** What one execution of a request comes to, as the runner needs it. */
export type Executed =
  | { kind: 'done'; httpStatus: number; statusText: string; ms: number; size: number; tests: TestOutcome[]; errors: string[]; notes: string[]; nextRequest?: string | null }
  | { kind: 'skipped'; notes: string[] }
  | { kind: 'error'; message: string; ms: number; notes: string[]; nextRequest?: string | null }
  | { kind: 'cancelled' };

export interface RunDeps {
  execute(item: RunItem, iteration: IterationInfo, signal: AbortSignal): Promise<Executed>;
  /** Waits; resolves early (never rejects) when the signal ends. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
  onResult?(result: ItemResult): void;
}

export interface RunOptions {
  /** How many passes when there is no data file. */
  iterations: number;
  delayMs: number;
  stopOnFailure: boolean;
  /** The rows of the data file: one pass for each. */
  data?: readonly Readonly<Record<string, string>>[];
  /** The most executions in all, so that a script that always jumps back ends. */
  maxExecutions?: number;
}

export const RUN_LIMITS = { iterations: 1000, delayMs: 60_000, executions: 10_000 } as const;

export interface RunSummary {
  results: ItemResult[];
  /** The passes that were begun. */
  iterations: number;
  requests: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  testsPassed: number;
  testsFailed: number;
  startedAt: number;
  ms: number;
  stopped: 'finished' | 'cancelled' | 'failure' | 'limit';
}

const failures = (tests: readonly TestOutcome[]): number => tests.filter(test => !test.passed).length;

function resultOf(index: number, iteration: number, item: RunItem, executed: Exclude<Executed, { kind: 'cancelled' }>): ItemResult {
  if (executed.kind === 'skipped') return { index, iteration, item, status: 'skipped', ms: 0, tests: [], notes: executed.notes };
  if (executed.kind === 'error') return { index, iteration, item, status: 'error', ms: executed.ms, tests: [], error: executed.message, notes: executed.notes };
  const bad = failures(executed.tests);
  const status: ItemStatus = executed.errors.length > 0 ? 'error' : bad > 0 ? 'failed' : 'passed';
  return {
    index, iteration, item, status, httpStatus: executed.httpStatus, statusText: executed.statusText, ms: executed.ms, size: executed.size, tests: executed.tests,
    ...(executed.errors.length === 0 ? {} : { error: executed.errors.join(' ') }), notes: executed.notes
  };
}

export async function runItems(items: readonly RunItem[], options: RunOptions, deps: RunDeps, signal: AbortSignal): Promise<RunSummary> {
  const startedAt = deps.now();
  const passes = options.data !== undefined ? options.data.length : Math.max(1, Math.min(options.iterations, RUN_LIMITS.iterations));
  const maxExecutions = Math.min(options.maxExecutions ?? RUN_LIMITS.executions, RUN_LIMITS.executions);
  const delay = Math.max(0, Math.min(options.delayMs, RUN_LIMITS.delayMs));
  const summary: RunSummary = { results: [], iterations: 0, requests: 0, passed: 0, failed: 0, errors: 0, skipped: 0, testsPassed: 0, testsFailed: 0, startedAt, ms: 0, stopped: 'finished' };
  let executions = 0;
  const done = (stopped: RunSummary['stopped']): RunSummary => { summary.stopped = stopped; summary.ms = Math.max(0, deps.now() - startedAt); return summary; };

  for (let pass = 0; pass < passes; pass++) {
    summary.iterations++;
    const info: IterationInfo = { index: pass, count: passes, data: options.data?.[pass] ?? {} };
    let cursor = 0;
    while (cursor < items.length) {
      if (signal.aborted) return done('cancelled');
      if (executions >= maxExecutions) return done('limit');
      const item = items[cursor] as RunItem;
      const executed = await deps.execute(item, info, signal);
      if (executed.kind === 'cancelled') return done('cancelled');
      const result = resultOf(executions, pass, item, executed);
      executions++;
      summary.results.push(result);
      summary.requests++;
      if (result.status === 'passed') summary.passed++; else if (result.status === 'failed') summary.failed++; else if (result.status === 'error') summary.errors++; else summary.skipped++;
      summary.testsPassed += result.tests.filter(test => test.passed).length;
      summary.testsFailed += failures(result.tests);
      deps.onResult?.(result);
      if (options.stopOnFailure && (result.status === 'failed' || result.status === 'error')) return done('failure');

      // Where to go next: a script can name a request, or end the pass.
      const next = executed.kind === 'skipped' ? undefined : executed.nextRequest;
      if (next === null) break;
      if (typeof next === 'string') {
        const target = items.findIndex(candidate => candidate.name === next);
        if (target >= 0) cursor = target; else { result.notes.push(`A script asked for the request "${next.slice(0, 60)}", which is not in this run: the next one follows.`); cursor++; }
      } else cursor++;
      if ((cursor < items.length || pass < passes - 1) && delay > 0) await deps.sleep(delay, signal);
    }
  }
  return done('finished');
}
