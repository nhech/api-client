import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemResult, RunSummary } from '../../src/runner/run';
import { parseRunnerToHost, resultView, RUNNER_LIMITS, summaryView } from '../../src/view/runner-protocol';

/** What the page of the runner may ask, and what it is told: the numbers are whole and inside the limits, and the text from a server or a script is printable. */

const start = (config: unknown): unknown => ({ type: 'start', config });

test('The page can ask for the few things it may, with nothing else in them', () => {
  assert.deepEqual(parseRunnerToHost({ type: 'stop', extra: 1 }), { type: 'stop' });
  assert.deepEqual(parseRunnerToHost({ type: 'chooseData', path: '/etc/passwd' }), { type: 'chooseData' }, 'the page cannot say which file');
  assert.deepEqual(parseRunnerToHost({ type: 'clearData' }), { type: 'clearData' });
  assert.deepEqual(parseRunnerToHost({ type: 'save', format: 'json', path: '/x' }), { type: 'save', format: 'json' }, 'nor where to save');
  assert.deepEqual(parseRunnerToHost({ type: 'save', format: 'junit' }), { type: 'save', format: 'junit' });
  for (const format of [undefined, 'xml', 'JSON', 5, ['json']]) assert.equal(parseRunnerToHost({ type: 'save', format }), undefined, String(format));
  assert.deepEqual(parseRunnerToHost({ type: 'ready', violations: ['a', 5, 'b'.repeat(500)] }), { type: 'ready', violations: ['a', 'b'.repeat(200)] });
  assert.deepEqual(parseRunnerToHost({ type: 'ready' }), { type: 'ready', violations: [] });
  assert.deepEqual(parseRunnerToHost({ type: 'violation', text: 'x'.repeat(300) }), { type: 'violation', text: 'x'.repeat(200) });
  assert.equal(parseRunnerToHost({ type: 'violation', text: 5 }), undefined);
  for (const bad of [null, undefined, 'stop', 5, [], {}, { type: 'unknown' }, { type: 'edit' }, { type: 'send' }, { type: ['stop'] }]) assert.equal(parseRunnerToHost(bad), undefined, JSON.stringify(bad));
});

test('The numbers of a run are whole and within the limits, and only true is true', () => {
  assert.deepEqual(parseRunnerToHost(start({ iterations: 3, delayMs: 250, stopOnFailure: true })), { type: 'start', config: { iterations: 3, delayMs: 250, stopOnFailure: true } });
  assert.deepEqual(parseRunnerToHost(start({ iterations: 1, delayMs: 0, stopOnFailure: 'yes' })), { type: 'start', config: { iterations: 1, delayMs: 0, stopOnFailure: false } });
  assert.deepEqual(parseRunnerToHost(start({ iterations: RUNNER_LIMITS.iterations, delayMs: RUNNER_LIMITS.delayMs })), { type: 'start', config: { iterations: 1000, delayMs: 60_000, stopOnFailure: false } });
  for (const iterations of [0, -1, 1001, 1.5, NaN, Infinity, '3', null, undefined, [3]]) assert.equal(parseRunnerToHost(start({ iterations, delayMs: 0 })), undefined, `iterations ${String(iterations)}`);
  for (const delayMs of [-1, 60_001, 0.5, NaN, '5', null, undefined]) assert.equal(parseRunnerToHost(start({ iterations: 1, delayMs })), undefined, `delay ${String(delayMs)}`);
  for (const config of [undefined, null, 5, [], 'x']) assert.equal(parseRunnerToHost(start(config)), undefined);
  const inherited = Object.create({ iterations: 2, delayMs: 0 }) as object;
  assert.equal(parseRunnerToHost(start(inherited)), undefined, 'a value that is only inherited is not there');
});

const RESULT: ItemResult = {
  index: 3, iteration: 1, item: { path: 'p', name: `A${String.fromCharCode(0)}B`, method: 'GET', url: 'u', folder: 'F' }, status: 'failed', httpStatus: 500, statusText: 'x', ms: 12.6, size: 40,
  tests: [{ name: 'n'.repeat(5000), passed: false, message: `bad${String.fromCharCode(10)}line`, source: 'script' }], error: `e${String.fromCharCode(27)}`, notes: ['note']
};

test('A result is told with printable text, a number of milliseconds without fractions, and nothing but what the page shows', () => {
  const view = resultView(RESULT);
  assert.deepEqual([view.index, view.iteration, view.name, view.folder, view.method, view.status, view.httpStatus, view.ms, view.size], [3, 1, 'A?B', 'F', 'GET', 'failed', 500, 13, 40]);
  assert.deepEqual(view.tests.map(test => [test.passed, test.message, test.source, test.name.length]), [[false, 'bad?line', 'script', 2003]], 'a name that is far too long is cut');
  assert.equal(view.error, 'e?');
  assert.deepEqual(view.notes, ['note']);
  assert.ok(!('item' in view) && !('url' in view), 'the address of the request is not sent along');
  const plain = resultView({ index: 0, iteration: 0, item: RESULT.item, status: 'passed', ms: 1, tests: [], notes: [] });
  assert.deepEqual([plain.error, plain.httpStatus, plain.size, plain.tests, plain.notes], [undefined, undefined, undefined, [], []]);
  const many = resultView({ ...RESULT, tests: Array.from({ length: 300 }, (_, index) => ({ name: `t${index}`, passed: true, message: '', source: 'request' as const })), notes: Array.from({ length: 40 }, (_, index) => `n${index}`) });
  assert.deepEqual([many.tests.length, many.notes.length], [200, 20], 'the number of tests and of notes is bounded');
});

test('The summary is told as numbers', () => {
  const summary: RunSummary = { results: [RESULT], iterations: 2, requests: 5, passed: 2, failed: 1, errors: 1, skipped: 1, testsPassed: 4, testsFailed: 1, startedAt: 5, ms: 99.4, stopped: 'failure' };
  assert.deepEqual(summaryView(summary), { iterations: 2, requests: 5, passed: 2, failed: 1, errors: 1, skipped: 1, testsPassed: 4, testsFailed: 1, ms: 99, stopped: 'failure' });
});
