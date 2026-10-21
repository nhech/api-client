import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_LIMITS, parseCsv, parseDataFile, parseJsonData } from '../../src/runner/data';
import { toJson, toJUnit, xmlText, type ReportContext } from '../../src/runner/report';
import { RUN_LIMITS, runItems, type Executed, type IterationInfo, type RunDeps, type RunItem, type RunOptions } from '../../src/runner/run';

/** The runner: the data of a run, the order of the requests and what changes it, and what a run is written down as. */

const rows = (result: ReturnType<typeof parseCsv>): Record<string, string>[] => (result.ok ? result.rows.map(row => ({ ...row })) : []);
const error = (result: ReturnType<typeof parseCsv>): string => (result.ok ? '' : result.error);

test('A CSV file gives a row for each line, with the names of the first line', () => {
  assert.deepEqual(rows(parseCsv('id,name\n1,Ann\n2,Bob\n')), [{ id: '1', name: 'Ann' }, { id: '2', name: 'Bob' }]);
  assert.deepEqual(rows(parseCsv('id,name\r\n1,Ann\r\n2,Bob')), [{ id: '1', name: 'Ann' }, { id: '2', name: 'Bob' }], 'Windows line ends, and no line end at the end');
  assert.deepEqual(rows(parseCsv(`${String.fromCharCode(0xfeff)}id,name\n1,Ann\n`)), [{ id: '1', name: 'Ann' }], 'a byte order mark is not part of the first name');
  assert.deepEqual(rows(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n')), [{ a: 'x, y', b: 'say "hi"' }, { a: 'two\nlines', b: 'z' }], 'quoted fields');
  assert.deepEqual(rows(parseCsv('a,b\nsay "hi",2\n')), [{ a: 'say "hi"', b: '2' }], 'a quote inside a field that is not quoted is a quote');
  assert.deepEqual(rows(parseCsv('a;b\n1;2\n')), [{ a: '1', b: '2' }], 'semicolons');
  assert.deepEqual(rows(parseCsv('a\tb\n1\t2\n')), [{ a: '1', b: '2' }], 'tabs');
  assert.deepEqual(rows(parseCsv('a,b,c\n1,2\n1,2,3,4\n,,\n')), [{ a: '1', b: '2', c: '' }, { a: '1', b: '2', c: '3' }, { a: '', b: '', c: '' }], 'a short row is padded, a long one cut');
  assert.deepEqual(rows(parseCsv('a,b\n\n1,2\n\n\n3,4\n')), [{ a: '1', b: '2' }, { a: '3', b: '4' }], 'blank lines are skipped');
  assert.deepEqual(rows(parseCsv('a,b\n1,')), [{ a: '1', b: '' }], 'a last field that is empty');
  assert.deepEqual(rows(parseCsv(' a , b \n1,2\n')), [{ a: '1', b: '2' }], 'names are trimmed');
  assert.deepEqual(rows(parseCsv('a,b\n"unclosed,2\n')), [{ a: 'unclosed,2\n', b: '' }], 'a quote that never closes ends at the end of the text');
  const done = parseCsv('a,b\n1,2\n');
  assert.deepEqual(done.ok && done.columns, ['a', 'b']);
  assert.equal(Object.getPrototypeOf(done.ok ? done.rows[0] : {}), null, 'a row has no prototype: a column called __proto__ is only a name');
});

test('A CSV file that cannot be used says why', () => {
  assert.equal(error(parseCsv('')), 'The file has no rows.');
  assert.equal(error(parseCsv('a,b\n')), 'The file has a row of names and no data.');
  assert.match(error(parseCsv('a,,c\n1,2,3\n')), /"" in the first row is not a name/);
  assert.match(error(parseCsv('a,1b\n1,2\n')), /"1b" in the first row is not a name/);
  assert.match(error(parseCsv('a,b c\n1,2\n')), /"b c" in the first row is not a name/);
  assert.equal(error(parseCsv('a,b,a\n1,2,3\n')), 'Two columns have the same name.');
  assert.match(error(parseCsv(`${Array.from({ length: DATA_LIMITS.columns + 1 }, (_, index) => `c${index}`).join(',')}\n1\n`)), /more than 200 columns/);
  assert.match(error(parseCsv(`${'a'.repeat(DATA_LIMITS.nameChars + 1)},b\n1,2\n`)), /is not a name/);
});

test('The size of a data file is bounded: rows, and the size of a cell', () => {
  const many = parseCsv(`a\n${Array.from({ length: DATA_LIMITS.rows + 50 }, (_, index) => String(index)).join('\n')}\n`);
  assert.equal(many.ok && many.rows.length, DATA_LIMITS.rows);
  assert.deepEqual(many.ok && many.warnings, [`Only the first ${DATA_LIMITS.rows} rows are used.`]);
  const exact = parseCsv(`a\n${Array.from({ length: DATA_LIMITS.rows }, (_, index) => String(index)).join('\n')}\n`);
  assert.deepEqual(exact.ok && exact.warnings, [], 'exactly the limit is not too many');
  const wide = parseCsv(`a\n${'x'.repeat(DATA_LIMITS.cellChars + 10)}\n`);
  assert.equal(wide.ok && wide.rows[0]?.['a']?.length, DATA_LIMITS.cellChars);
  const started = Date.now();
  parseCsv(`a,b\n${'"x,'.repeat(300_000)}`);
  parseCsv(`${'a,'.repeat(100_000)}\n${',\n'.repeat(100_000)}`);
  assert.ok(Date.now() - started < 3000, 'hostile text is read in time proportional to its size');
});

test('A JSON file is a list of objects, and every value becomes text', () => {
  const ok = parseJsonData('[{"id":1,"name":"Ann","ok":true,"none":null,"tags":["a"],"nested":{"x":1.5}},{"id":2,"extra":"e"}]');
  assert.deepEqual(ok.ok && ok.rows.map(row => ({ ...row })), [{ id: '1', name: 'Ann', ok: 'true', none: '', tags: '["a"]', nested: '{"x":1.5}' }, { id: '2', extra: 'e' }]);
  assert.deepEqual(ok.ok && ok.columns, ['id', 'name', 'ok', 'none', 'tags', 'nested', 'extra']);
  const odd = parseJsonData('[{"good":"1","bad name":"2","1x":"3","__proto__":"4"}]');
  assert.equal(odd.ok && odd.warnings[0]?.startsWith('These names are not names a variable can have'), true);
  assert.deepEqual(odd.ok && Object.keys(odd.rows[0] ?? {}), ['good', '__proto__'], 'a name like __proto__ is a name like any other, and the others are left out');
  assert.match((odd.ok && odd.warnings[0]) || '', /bad name, 1x/);
  assert.equal(parseJsonData('{"a":1}').ok, false);
  assert.equal(parseJsonData('nope').ok, false);
  assert.equal(error(parseJsonData('[]') as never), 'The list is empty.');
  assert.equal(error(parseJsonData('[1,2]') as never), 'Every item of the list has to be an object.');
  assert.equal(error(parseJsonData('[{"a":1},[2]]') as never), 'Every item of the list has to be an object.');
  assert.equal(error(parseJsonData('[{"bad name":1}]') as never), 'No object has a name that a variable can have.');
  assert.equal(parseJsonData(`${String.fromCharCode(0xfeff)}[{"a":1}]`).ok, true, 'a byte order mark');
});

test('The kind of a data file is told by its name, and by its first character when the name does not say', () => {
  assert.equal(parseDataFile('[{"a":1}]', 'rows.json').ok, true);
  assert.equal(parseDataFile('a,b\n1,2\n', 'rows.csv').ok, true);
  assert.equal(parseDataFile('a\tb\n1\t2\n', 'rows.tsv').ok, true);
  assert.equal(parseDataFile('a,b\n1,2\n', 'rows.txt').ok, true);
  assert.equal(parseDataFile('[{"a":1}]', 'rows').ok, true, 'a name with no extension: JSON by its first character');
  assert.equal(parseDataFile('  \n[{"a":1}]', 'rows').ok, true);
  assert.equal(parseDataFile('a,b\n1,2\n', 'rows').ok, true, 'and CSV otherwise');
  assert.equal(parseDataFile('a,b\n1,2\n', 'ROWS.JSON').ok, false, 'the extension decides, whatever its case');
});

// ---- the order of a run ----

const item = (name: string, folder = ''): RunItem => ({ path: `api-client/collections/shop/${name.toLowerCase()}.req.yml`, name, method: 'GET', url: `https://api.test/${name}`, folder });
const ITEMS = [item('A'), item('B'), item('C')];
const done = (change: Partial<Extract<Executed, { kind: 'done' }>> = {}): Executed => ({ kind: 'done', httpStatus: 200, statusText: 'OK', ms: 10, size: 5, tests: [], errors: [], notes: [], ...change });
const options = (change: Partial<RunOptions> = {}): RunOptions => ({ iterations: 1, delayMs: 0, stopOnFailure: false, ...change });

function harness(script: (name: string, iteration: IterationInfo, call: number) => Executed | Promise<Executed>): { deps: RunDeps; calls: string[]; sleeps: number[]; seen: IterationInfo[]; streamed: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const seen: IterationInfo[] = [];
  const streamed: number[] = [];
  let clock = 1_700_000_000_000;
  return {
    calls, sleeps, seen, streamed,
    deps: {
      execute: async (target, iteration) => { calls.push(`${iteration.index}:${target.name}`); seen.push(iteration); return script(target.name, iteration, calls.length); },
      sleep: async ms => { sleeps.push(ms); },
      now: () => (clock += 25),
      onResult: result => { streamed.push(result.index); }
    }
  };
}
const run = (items: readonly RunItem[], change: Partial<RunOptions>, deps: RunDeps, signal = new AbortController().signal) => runItems(items, options(change), deps, signal);

test('The requests run in order, once for each pass, with the data of the pass, and each result is told as it comes', async () => {
  const h = harness(() => done());
  const summary = await run(ITEMS, { iterations: 2 }, h.deps);
  assert.deepEqual(h.calls, ['0:A', '0:B', '0:C', '1:A', '1:B', '1:C']);
  assert.deepEqual(h.streamed, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([summary.iterations, summary.requests, summary.passed, summary.stopped], [2, 6, 6, 'finished']);
  assert.deepEqual(summary.results.map(result => [result.index, result.iteration, result.item.name, result.status]).slice(2, 4), [[2, 0, 'C', 'passed'], [3, 1, 'A', 'passed']]);
  assert.ok(summary.ms > 0 && summary.startedAt > 0);
  const withData = harness(() => done());
  const data = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const bySheet = await run(ITEMS, { iterations: 99, data }, withData.deps);
  assert.equal(bySheet.iterations, 3, 'the rows of the data file decide how many passes');
  assert.deepEqual(withData.seen.map(info => [info.index, info.count, info.data['id']]).filter((_, at) => at % 3 === 0), [[0, 3, '1'], [1, 3, '2'], [2, 3, '3']]);
  assert.equal(withData.calls.length, 9);
  const empty = await run([], { iterations: 3 }, harness(() => done()).deps);
  assert.deepEqual([empty.requests, empty.iterations, empty.stopped], [0, 3, 'finished'], 'nothing to run is not an error');
});

test('A pause goes between requests, not after the last, and a number of passes or a pause that is too large is cut', async () => {
  const h = harness(() => done());
  await run(ITEMS, { delayMs: 200 }, h.deps);
  assert.deepEqual(h.sleeps, [200, 200]);
  const twice = harness(() => done());
  await run(ITEMS, { delayMs: 50, iterations: 2 }, twice.deps);
  assert.deepEqual(twice.sleeps, [50, 50, 50, 50, 50], 'and between the passes');
  const none = harness(() => done());
  await run(ITEMS, { delayMs: 0 }, none.deps);
  assert.deepEqual(none.sleeps, []);
  const negative = harness(() => done());
  await run(ITEMS, { delayMs: -5 }, negative.deps);
  assert.deepEqual(negative.sleeps, []);
  const long = harness(() => done());
  await run([item('A'), item('B')], { delayMs: 10_000_000 }, long.deps);
  assert.deepEqual(long.sleeps, [RUN_LIMITS.delayMs]);
  const zero = await run(ITEMS, { iterations: 0 }, harness(() => done()).deps);
  assert.equal(zero.iterations, 1, 'at least one pass');
  const huge = await run([item('A')], { iterations: 1_000_000, maxExecutions: 10_000_000 }, harness(() => done()).deps);
  assert.equal(huge.iterations, RUN_LIMITS.iterations, 'at most a thousand passes');
});

test('A request fails when a test fails, is an error when it could not be sent or a script failed, and is skipped when a script skipped it', async () => {
  const test = (name: string, passed: boolean) => ({ name, passed, message: passed ? '' : 'expected 1 to equal 2', source: 'script' as const });
  const h = harness(name => (name === 'A' ? done({ tests: [test('ok', true), test('bad', false)] })
    : name === 'B' ? { kind: 'error', message: 'connect ECONNREFUSED', ms: 3, notes: ['n'] }
    : done({ errors: ['TypeError: x'], tests: [test('fine', true)] })));
  const summary = await run(ITEMS, {}, h.deps);
  assert.deepEqual(summary.results.map(result => result.status), ['failed', 'error', 'error']);
  assert.deepEqual([summary.failed, summary.errors, summary.passed, summary.testsPassed, summary.testsFailed], [1, 2, 0, 2, 1]);
  assert.equal(summary.results[1]?.error, 'connect ECONNREFUSED');
  assert.equal(summary.results[2]?.error, 'TypeError: x');
  assert.equal(summary.results[0]?.httpStatus, 200);
  assert.equal(summary.results[1]?.httpStatus, undefined);
  const skipped = await run(ITEMS, {}, harness(name => (name === 'B' ? { kind: 'skipped', notes: ['skipped by a script'] } : done())).deps);
  assert.deepEqual(skipped.results.map(result => result.status), ['passed', 'skipped', 'passed']);
  assert.deepEqual([skipped.skipped, skipped.passed], [1, 2]);
});

test('The run can stop at the first failure, and a pass that has none goes on', async () => {
  const h = harness(name => (name === 'B' ? done({ tests: [{ name: 't', passed: false, message: 'no', source: 'request' }] }) : done()));
  const summary = await run(ITEMS, { stopOnFailure: true, iterations: 3 }, h.deps);
  assert.deepEqual(h.calls, ['0:A', '0:B']);
  assert.deepEqual([summary.stopped, summary.requests], ['failure', 2]);
  const errors = await run(ITEMS, { stopOnFailure: true }, harness(name => (name === 'A' ? { kind: 'error', message: 'x', ms: 1, notes: [] } : done())).deps);
  assert.equal(errors.stopped, 'failure', 'an error stops it too');
  const goes = await run(ITEMS, { stopOnFailure: false, iterations: 2 }, harness(name => (name === 'B' ? done({ tests: [{ name: 't', passed: false, message: 'no', source: 'request' }] }) : done())).deps);
  assert.deepEqual([goes.stopped, goes.requests, goes.failed], ['finished', 6, 2]);
  const skippedStops = await run(ITEMS, { stopOnFailure: true }, harness(name => (name === 'A' ? { kind: 'skipped', notes: [] } : done())).deps);
  assert.equal(skippedStops.stopped, 'finished', 'a request that was skipped is not a failure');
});

test('A script can send the run to a request by its name, end the pass, or be told that there is no such request; a skipped request cannot', async () => {
  const jump = harness(name => (name === 'A' ? done({ nextRequest: 'C' }) : done()));
  await run(ITEMS, {}, jump.deps);
  assert.deepEqual(jump.calls, ['0:A', '0:C'], 'B was passed over');
  const back = harness((name, _iteration, call) => (name === 'C' && call < 6 ? done({ nextRequest: 'A' }) : done()));
  await run(ITEMS, {}, back.deps);
  assert.deepEqual(back.calls, ['0:A', '0:B', '0:C', '0:A', '0:B', '0:C', '0:A', '0:B', '0:C'].slice(0, back.calls.length));
  assert.ok(back.calls.length >= 6);
  const stop = harness(name => (name === 'B' ? done({ nextRequest: null }) : done()));
  const ended = await run(ITEMS, { iterations: 2 }, stop.deps);
  assert.deepEqual(stop.calls, ['0:A', '0:B', '1:A', '1:B'], 'null ends the pass, and the next pass begins');
  assert.equal(ended.stopped, 'finished');
  const unknown = harness(name => (name === 'A' ? done({ nextRequest: 'Nothing' }) : done()));
  const told = await run(ITEMS, {}, unknown.deps);
  assert.deepEqual(unknown.calls, ['0:A', '0:B', '0:C'], 'the next one follows');
  assert.match(told.results[0]?.notes[0] ?? '', /asked for the request "Nothing", which is not in this run/);
  const skippedNext = harness(name => (name === 'A' ? { kind: 'skipped', notes: [] } : done()));
  await run(ITEMS, {}, skippedNext.deps);
  assert.deepEqual(skippedNext.calls, ['0:A', '0:B', '0:C']);
  const errorNext = harness(name => (name === 'A' ? { kind: 'error', message: 'x', ms: 1, notes: [], nextRequest: 'C' } : done()));
  await run(ITEMS, {}, errorNext.deps);
  assert.deepEqual(errorNext.calls, ['0:A', '0:C'], 'a script that failed after naming a request still names it');
});

test('A run is bounded: a script that always goes back ends it, and so does a limit that is given', async () => {
  const loop = harness(() => done({ nextRequest: 'A' }));
  const summary = await run(ITEMS, { maxExecutions: 25 }, loop.deps);
  assert.deepEqual([summary.stopped, summary.requests, loop.calls.length], ['limit', 25, 25]);
  const hard = harness(() => done({ nextRequest: 'A' }));
  const capped = await run(ITEMS, { maxExecutions: 1_000_000 }, hard.deps);
  assert.deepEqual([capped.stopped, capped.requests], ['limit', RUN_LIMITS.executions]);
});

test('A run can be cancelled before it starts, between requests, or by the request that is running', async () => {
  const before = new AbortController();
  before.abort();
  const none = harness(() => done());
  assert.equal((await run(ITEMS, {}, none.deps, before.signal)).stopped, 'cancelled');
  assert.deepEqual(none.calls, []);
  const between = new AbortController();
  const second = harness(name => { if (name === 'A') between.abort(); return done(); });
  const cut = await run(ITEMS, {}, second.deps, between.signal);
  assert.deepEqual([cut.stopped, cut.requests, second.calls], ['cancelled', 1, ['0:A']]);
  const inside = harness(name => (name === 'B' ? { kind: 'cancelled' } : done()));
  const within = await run(ITEMS, {}, inside.deps);
  assert.deepEqual([within.stopped, within.requests], ['cancelled', 1], 'what was cancelled is not a result');
});

// ---- what a run is written down as ----

const SUMMARY = (() => {
  const base = { ms: 12.4, size: 5 };
  return {
    results: [
      { index: 0, iteration: 0, item: { path: 'p/a.req.yml', name: 'List <pets>', method: 'GET', url: 'u', folder: 'Pets' }, status: 'passed' as const, httpStatus: 200, statusText: 'OK', ...base, tests: [{ name: 'is "ok"', passed: true, message: '', source: 'request' as const }], notes: [] },
      { index: 1, iteration: 0, item: { path: 'p/b.req.yml', name: 'Create', method: 'POST', url: 'u', folder: 'Pets' }, status: 'failed' as const, httpStatus: 201, statusText: 'Created', ms: 40, size: 9, tests: [{ name: 'has id', passed: false, message: 'expected {} to have "id" & more', source: 'script' as const }, { name: 'status', passed: true, message: '', source: 'request' as const }], notes: ['a note'] },
      { index: 2, iteration: 1, item: { path: 'p/c.req.yml', name: 'Broken', method: 'GET', url: 'u', folder: '' }, status: 'error' as const, ms: 3, tests: [], error: 'connect ECONNREFUSED', notes: [] },
      { index: 3, iteration: 1, item: { path: 'p/d.req.yml', name: 'Skipped', method: 'GET', url: 'u', folder: '' }, status: 'skipped' as const, ms: 0, tests: [], notes: [] },
      { index: 4, iteration: 1, item: { path: 'p/e.req.yml', name: 'Plain', method: 'GET', url: 'u', folder: '' }, status: 'passed' as const, httpStatus: 204, statusText: 'No Content', ms: 7, size: 0, tests: [], notes: [] }
    ],
    iterations: 2, requests: 5, passed: 2, failed: 1, errors: 1, skipped: 1, testsPassed: 2, testsFailed: 1, startedAt: Date.UTC(2026, 9, 22, 8, 30, 15), ms: 1234.6, stopped: 'finished' as const
  };
})();
const CONTEXT: ReportContext = { name: 'Pet Store', environment: 'Local', tool: 'api-client 0.2.0' };

test('The JSON report has the totals and every result, nothing of what a server answered, and is the same text every time', () => {
  const text = toJson(SUMMARY, CONTEXT);
  const parsed = JSON.parse(text) as { totals: Record<string, number>; results: { name: string; status: string; httpStatus: number | null; error: string | null }[]; startedAt: string; durationMs: number };
  assert.equal(parsed.startedAt, '2026-10-22T08:30:15.000Z');
  assert.equal(parsed.durationMs, 1235);
  assert.deepEqual(parsed.totals, { iterations: 2, requests: 5, passed: 2, failed: 1, errors: 1, skipped: 1, tests: 3, testsPassed: 2, testsFailed: 1 });
  assert.deepEqual(parsed.results.map(result => [result.name, result.status, result.httpStatus, result.error]), [['List <pets>', 'passed', 200, null], ['Create', 'failed', 201, null], ['Broken', 'error', null, 'connect ECONNREFUSED'], ['Skipped', 'skipped', null, null], ['Plain', 'passed', 204, null]]);
  assert.equal(toJson(SUMMARY, CONTEXT), text);
  assert.ok(text.endsWith('}\n'));
  assert.ok(!text.includes('"url"') && !text.includes('statusText'), 'what a request was sent to is not in the file');
});

test('The JUnit report has a suite for each request, a test case for each test, and failures, errors and skips where they belong', () => {
  assert.equal(toJUnit(SUMMARY, CONTEXT), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="Pet Store" tests="6" failures="1" errors="1" skipped="1" time="1.235">',
    '  <testsuite name="List &lt;pets&gt;" tests="1" failures="0" errors="0" skipped="0" time="0.012" timestamp="2026-10-22T08:30:15.000Z">',
    '    <testcase classname="Pet Store.Pets" name="is &quot;ok&quot;" time="0.000"/>',
    '  </testsuite>',
    '  <testsuite name="Create" tests="2" failures="1" errors="0" skipped="0" time="0.040" timestamp="2026-10-22T08:30:15.000Z">',
    '    <testcase classname="Pet Store.Pets" name="has id" time="0.000">',
    '      <failure message="expected {} to have &quot;id&quot; &amp; more" type="AssertionError">expected {} to have &quot;id&quot; &amp; more</failure>',
    '    </testcase>',
    '    <testcase classname="Pet Store.Pets" name="status" time="0.000"/>',
    '  </testsuite>',
    '  <testsuite name="Broken (iteration 2)" tests="1" failures="0" errors="1" skipped="0" time="0.003" timestamp="2026-10-22T08:30:15.000Z">',
    '    <testcase classname="Pet Store" name="request" time="0.000">',
    '      <error message="connect ECONNREFUSED" type="Error">connect ECONNREFUSED</error>',
    '    </testcase>',
    '  </testsuite>',
    '  <testsuite name="Skipped (iteration 2)" tests="1" failures="0" errors="0" skipped="1" time="0.000" timestamp="2026-10-22T08:30:15.000Z">',
    '    <testcase classname="Pet Store" name="request" time="0.000">',
    '      <skipped/>',
    '    </testcase>',
    '  </testsuite>',
    '  <testsuite name="Plain (iteration 2)" tests="1" failures="0" errors="0" skipped="0" time="0.007" timestamp="2026-10-22T08:30:15.000Z">',
    '    <testcase classname="Pet Store" name="request" time="0.007"/>',
    '  </testsuite>',
    '</testsuites>',
    ''
  ].join('\n'));
});

test('Text in an XML report holds nothing that XML cannot, and nothing that means something', () => {
  assert.equal(xmlText(`a<b>&"c'd`), 'a&lt;b&gt;&amp;&quot;c&apos;d');
  assert.equal(xmlText(`x${String.fromCharCode(0)}y${String.fromCharCode(27)}z`), 'x?y?z');
  const hostile = toJUnit({ ...SUMMARY, results: [{ ...(SUMMARY.results[0] as (typeof SUMMARY.results)[0]), item: { ...(SUMMARY.results[0] as (typeof SUMMARY.results)[0]).item, name: '"><injected/>' } }] }, { ...CONTEXT, name: '</testsuites><x/>' });
  assert.ok(!hostile.includes('<injected/>') && !hostile.includes('<x/>'));
  assert.equal(hostile.match(/<testsuites /g)?.length, 1);
});
