import { signal } from '@preact/signals';
import type { DataView, ResultView, RunnerToHost, RunnerToView, SummaryView } from '../../../../src/view/runner-protocol';

/** What the page of the collection runner knows: what the extension last said about the run. The page decides nothing. */
export interface RunnerPort {
  post(message: RunnerToHost): void;
}

/** The most results the page keeps; the earlier ones are counted, not listed (the report has them all). */
export const KEPT_RESULTS = 2000;

export const info = signal<{ name: string; kind: 'collection' | 'folder'; environment: string; requests: number } | undefined>(undefined);
export const data = signal<DataView | undefined>(undefined);
export const dataError = signal<string | undefined>(undefined);
export const running = signal(false);
export const passes = signal(0);
export const results = signal<ResultView[]>([]);
export const dropped = signal(0);
export const summary = signal<SummaryView | undefined>(undefined);
export const problem = signal<string | undefined>(undefined);

export function receive(message: RunnerToView): void {
  if (message.type === 'init') {
    info.value = { name: message.name, kind: message.kind, environment: message.environment, requests: message.requests };
    data.value = message.data;
    problem.value = undefined;
  } else if (message.type === 'data') {
    data.value = message.data;
    dataError.value = message.error;
  } else if (message.type === 'started') {
    running.value = true;
    passes.value = message.passes;
    results.value = [];
    dropped.value = 0;
    summary.value = undefined;
    problem.value = undefined;
  } else if (message.type === 'result') {
    const next = [...results.value, message.result];
    if (next.length > KEPT_RESULTS) { dropped.value += next.length - KEPT_RESULTS; next.splice(0, next.length - KEPT_RESULTS); }
    results.value = next;
  } else if (message.type === 'done') {
    running.value = false;
    summary.value = message.summary;
  } else {
    problem.value = message.message;
    running.value = false;
  }
}
