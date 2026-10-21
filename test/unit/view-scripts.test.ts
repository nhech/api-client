import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRequest, type KV, type Request } from '../../src/core/model';
import type { WireRequest, WireResponse } from '../../src/engine/types';
import type { ScriptOutput } from '../../src/script/outcome';
import { buildResponseView } from '../../src/view/response';
import { addOutput, emptyReport, hasReport, requestForScripts, responseForScripts, scriptInput, SCRIPT_BODY_LIMIT, sentForScripts, withRequestChanges, type ScriptReport } from '../../src/view/scripts';

/** What a script is given and what it can change, and what the pane shows of a run. */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: `about ${name}` });
const request = (change: Partial<Request> = {}): Request => ({ ...newRequest('R1', 'Create order'), method: 'POST', url: '{{host}}/orders', ...change });
const wire = (over: Partial<WireRequest> = {}): WireRequest => ({ method: 'POST', url: 'https://api.test/orders', headers: [['Accept', '*/*']], ...over });
const answer = (over: Partial<WireResponse> = {}): WireResponse => ({
  status: 201, statusText: 'Created', httpVersion: '1.1', headers: [['Content-Type', 'application/json'], ['Set-Cookie', 'sid=abc; Path=/; HttpOnly']], body: { kind: 'memory', bytes: bytes('{"id":7}') },
  wireBytes: 8, size: 8, truncated: false, timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 4, downloadMs: 1, totalMs: 12.4 }, redirects: [], finalUrl: 'https://api.test/orders', sent: wire(), warnings: [], ...over
});
const output = (over: Partial<ScriptOutput> = {}): ScriptOutput => ({ logs: [], logsCut: false, tests: [], variables: {}, skip: false, error: null, asyncErrors: [], ...over });

test('A script before the send is given the request as it is written: its own enabled headers, and the text of a body that is text', () => {
  const headers = [kv('Accept', 'application/json'), kv('X-Off', 'no', false), kv('', 'nameless')];
  assert.deepEqual(requestForScripts(request({ headers })), { method: 'POST', url: '{{host}}/orders', headers: [['Accept', 'application/json']], body: null });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'json', text: '{"a":1}' } })).body, { mode: 'raw', raw: '{"a":1}' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'text', contentType: 'text/plain', text: 'hi' } })).body, { mode: 'raw', raw: 'hi' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'xml', text: '<a/>' } })).body, { mode: 'raw', raw: '<a/>' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'form', fields: [kv('a', 'b')] } })).body, { mode: 'urlencoded' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'multipart', parts: [] } })).body, { mode: 'formdata' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'graphql', query: '{ a }', variables: '' } })).body, { mode: 'graphql' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'binary', file: 'x.bin' } })).body, { mode: 'file' });
  assert.deepEqual(requestForScripts(request({ body: { kind: 'json', text: 'x'.repeat(SCRIPT_BODY_LIMIT + 1) } })).body, { mode: 'raw', raw: '' }, 'a body larger than a script is given is not given');
});

test('A script after the answer is given the request as it went out, with the text of a body that is text and small', () => {
  assert.deepEqual(sentForScripts(wire()), { method: 'POST', url: 'https://api.test/orders', headers: [['Accept', '*/*']], body: null });
  assert.deepEqual(sentForScripts(wire({ body: { kind: 'bytes', bytes: bytes('{"a":1}') } })).body, { mode: 'raw', raw: '{"a":1}' });
  assert.deepEqual(sentForScripts(wire({ body: { kind: 'bytes', bytes: new Uint8Array([0xff, 0xfe, 0x00]) } })).body, { mode: 'raw' }, 'bytes that are not text are not given as text');
  assert.deepEqual(sentForScripts(wire({ body: { kind: 'bytes', bytes: new Uint8Array(SCRIPT_BODY_LIMIT + 1).fill(97) } })).body, { mode: 'raw' });
  assert.deepEqual(sentForScripts(wire({ body: { kind: 'file', path: '/secret/place/data.bin' } })).body, { mode: 'file' }, 'the path of a file is not given');
  assert.deepEqual(sentForScripts(wire({ body: { kind: 'multipart', boundary: 'b', parts: [] } })).body, { mode: 'formdata' });
  const many = Array.from({ length: 600 }, (_, index): [string, string] => [`H${index}`, 'v']);
  assert.equal(sentForScripts(wire({ headers: many })).headers.length, 500);
});

test('The answer is given with its body when that is text of a size a script can read, and with the reason when it is not', () => {
  const normal = responseForScripts(answer(), bytes('{"id":7}'));
  assert.deepEqual(normal, { code: 201, status: 'Created', headers: [['Content-Type', 'application/json'], ['Set-Cookie', 'sid=abc; Path=/; HttpOnly']], body: '{"id":7}', responseTime: 12, size: 8, cookies: [{ name: 'sid', value: 'abc' }] });
  assert.equal(responseForScripts(answer({ size: 0, headers: [] }), new Uint8Array(0)).body, '', 'an empty body is empty text');
  const image = responseForScripts(answer({ headers: [['Content-Type', 'image/png']], size: 4 }), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.deepEqual([image.body, image.bodyNote], [null, 'The body is not text, so a script cannot read it.']);
  const binary = responseForScripts(answer({ headers: [['Content-Type', 'application/zip']], size: 3 }), new Uint8Array([1, 2, 3]));
  assert.equal(binary.body, null);
  const sniffed = responseForScripts(answer({ headers: [['Content-Type', 'application/octet-stream']], size: 3 }), new Uint8Array([0, 1, 2]));
  assert.equal(sniffed.body, null, 'bytes with a zero are not text');
  const cut = responseForScripts(answer({ size: 9_000_000 }), bytes('{"id":7}'));
  assert.deepEqual([cut.body, cut.bodyNote?.startsWith('The body is larger')], [null, true], 'only the beginning was read, so it is not given as the whole');
  const long = 'a'.repeat(SCRIPT_BODY_LIMIT + 1);
  assert.equal(responseForScripts(answer({ headers: [['Content-Type', 'text/plain']], size: long.length }), bytes(long)).body, null);
  assert.equal(responseForScripts(answer({ headers: [['Content-Type', 'text/plain']], size: SCRIPT_BODY_LIMIT }), bytes('a'.repeat(SCRIPT_BODY_LIMIT))).body?.length, SCRIPT_BODY_LIMIT, 'exactly the limit is given');
  const cookies = responseForScripts(answer({ headers: [['set-cookie', 'a=1'], ['SET-COOKIE', 'b=2; Secure'], ['Set-Cookie', '=broken'], ['X', 'y']] }), bytes('{}'));
  assert.deepEqual(cookies.cookies, [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
});

test('Everything a run is given goes into one input, with the data of an iteration when there is one', () => {
  const variables = { environment: { a: '1' }, collection: {}, globals: {}, merged: { a: '1' } };
  const input = scriptInput({ phase: 'prerequest', requestId: 'R1', requestName: 'Create order', environmentName: 'dev', variables, request: { method: 'GET', url: 'u', headers: [], body: null }, response: null, cookies: [{ name: 's', value: 'v' }], scripts: [{ code: 'x();', from: 'request' }] });
  assert.deepEqual(input, {
    phase: 'prerequest', info: { requestName: 'Create order', requestId: 'R1', iteration: 0, iterationCount: 1 }, environmentName: 'dev', variables, request: { method: 'GET', url: 'u', headers: [], body: null },
    response: null, cookies: [{ name: 's', value: 'v' }], iterationData: {}, scripts: [{ code: 'x();', from: 'request' }]
  });
  const looped = scriptInput({ phase: 'test', requestId: 'R1', requestName: 'n', environmentName: '', variables, request: { method: 'GET', url: 'u', headers: [], body: null }, response: null, cookies: [], scripts: [], iteration: { index: 2, count: 5, data: { row: '3' } } });
  assert.deepEqual([looped.info.iteration, looped.info.iterationCount, looped.iterationData], [2, 5, { row: '3' }]);
});

test('What the scripts before the request changed is applied to a copy of the request, never to the request itself', () => {
  const original = request({ headers: [kv('Accept', 'application/json'), kv('X-Off', 'no', false), kv('X-Keep', 'k')], body: { kind: 'json', text: '{"a":1}' } });
  const frozen = JSON.stringify(original);
  const next = withRequestChanges(original, { method: 'PUT', url: 'https://other.test/x', headers: [['X-Keep', 'k'], ['X-New', 'n']], bodyRaw: '{"b":2}' });
  assert.equal(JSON.stringify(original), frozen, 'the request that was given is untouched');
  assert.deepEqual([next.method, next.url], ['PUT', 'https://other.test/x']);
  assert.deepEqual(next.headers.map(row => [row.name, row.value, row.enabled, row.description]), [['X-Keep', 'k', true, 'about X-Keep'], ['X-New', 'n', true, ''], ['X-Off', 'no', false, 'about X-Off']], 'a row that is unchanged is kept as it was, a disabled one stays after the new ones');
  assert.deepEqual(next.body, { kind: 'json', text: '{"b":2}' });
  assert.equal(next.id, 'R1');
  const same = withRequestChanges(original, {});
  assert.deepEqual(same, original);
  assert.notEqual(same, original, 'still a copy');
  assert.equal(withRequestChanges(original, { headers: [] }).headers.length, 1, 'all the enabled headers removed leaves the disabled one');
  assert.deepEqual(withRequestChanges(request({ headers: [kv('A', '1'), kv('A', '1')] }), { headers: [['A', '1']] }).headers.map(row => row.name), ['A'], 'a repeated header is kept as many times as the script left it');
  assert.deepEqual(withRequestChanges(request({ body: { kind: 'form', fields: [] } }), { bodyRaw: 'x' }).body, { kind: 'form', fields: [] }, 'a body that is not text is not replaced by text');
  assert.deepEqual(withRequestChanges(request(), { bodyRaw: 'x' }).body, { kind: 'none' }, 'nor is a missing one');
  assert.deepEqual(withRequestChanges(request({ body: { kind: 'text', contentType: 'text/plain', text: 'a' } }), { bodyRaw: 'b' }).body, { kind: 'text', contentType: 'text/plain', text: 'b' });
  assert.deepEqual(withRequestChanges(request({ body: { kind: 'xml', text: '<a/>' } }), { bodyRaw: '<b/>' }).body, { kind: 'xml', text: '<b/>' });
});

test('The report keeps the console, the tests, the errors and the variables of each stage; what reaches the page is printable and has the secret values taken out', () => {
  const report = emptyReport();
  assert.equal(hasReport(report), false);
  addOutput(report, 'pre', output({
    logs: [{ level: 'log', text: 'token is sekret-value-1' }, { level: 'warn', text: `line${String.fromCharCode(0)}break` }],
    tests: [{ name: 'checks sekret-value-1', passed: false, message: 'expected sekret-value-1', skipped: false }],
    variables: { active: { set: [['token', 'abc12345'], ['page', '2']], unset: ['old'] }, local: { set: [['c', 'x'.repeat(300)]], unset: [] }, global: { set: [], unset: ['g'] } },
    error: { from: 'request', name: 'TypeError', message: 'bad sekret-value-1' }, asyncErrors: ['later sekret-value-1'], skip: true, nextRequest: 'Next'
  }), ['sekret-value-1']);
  assert.deepEqual(report.logs, [{ phase: 'pre', level: 'log', text: 'token is [redacted]' }, { phase: 'pre', level: 'warn', text: 'line?break' }]);
  assert.deepEqual(report.tests, [{ phase: 'pre', name: 'checks [redacted]', passed: false, message: 'expected [redacted]', skipped: false }]);
  assert.deepEqual(report.errors, [{ phase: 'pre', from: 'request', name: 'TypeError', message: 'bad [redacted]' }, { phase: 'pre', from: 'later', name: 'Error', message: 'later [redacted]' }]);
  assert.deepEqual(report.saved.map(item => [item.variable, item.scope, item.action, item.value.length, item.secret, item.from]), [
    ['token', 'active', 'set', 0, true, 'script before the request'], ['page', 'active', 'set', 1, false, 'script before the request'], ['old', 'active', 'delete', 0, false, 'script before the request'],
    ['c', 'local', 'set', 200, false, 'script before the request'], ['g', 'global', 'delete', 0, false, 'script before the request']
  ]);
  assert.deepEqual([report.skipped, report.nextRequest, hasReport(report)], [true, 'Next', true]);
  addOutput(report, 'post', output({ nextRequest: null, variables: { active: { set: [['z', '1']], unset: [] } } }), []);
  assert.equal(report.nextRequest, null);
  assert.equal(report.saved.at(-1)?.from, 'script after the answer');
  addOutput(report, 'post', output(), []);
  assert.equal(report.nextRequest, null, 'a stage with no opinion leaves the last one');
  assert.equal(report.skipped, true, 'and the request stays skipped');
});

test('A value a script sets under the name of a secret is hidden in what it writes, even though nobody knew it before', () => {
  const report = emptyReport();
  addOutput(report, 'pre', output({ logs: [{ level: 'log', text: 'got fresh-token-value' }], variables: { active: { set: [['access_token', 'fresh-token-value'], ['page', 'plain-page-value']], unset: [] } }, tests: [{ name: 'uses plain-page-value', passed: true, message: '', skipped: false }] }), []);
  assert.equal(report.logs[0]?.text, 'got [redacted]');
  assert.equal(report.tests[0]?.name, 'uses plain-page-value', 'a value that is not under a secret name stays');
});

test('The console of the report is cut at a size, and it says so once', () => {
  const report = emptyReport();
  const line = 'y'.repeat(4000);
  addOutput(report, 'post', output({ logs: Array.from({ length: 30 }, () => ({ level: 'log' as const, text: line })) }), []);
  assert.ok(report.logs.length <= 17 && report.logs.length >= 16, String(report.logs.length));
  assert.deepEqual(report.notes, ['The console was cut: a script wrote more than is kept.']);
  addOutput(report, 'post', output({ logs: [{ level: 'log', text: 'more' }], logsCut: true }), []);
  assert.equal(report.notes.length, 1);
  const cutByScript = emptyReport();
  addOutput(cutByScript, 'post', output({ logsCut: true }), []);
  assert.deepEqual(cutByScript.notes, ['The console was cut: a script wrote more than is kept.']);
});

test('The report goes into the view of the response when there is one, and not otherwise', () => {
  const report: ScriptReport = { ...emptyReport(), notes: ['n'] };
  const base = { response: answer(), bytes: bytes('{"id":7}'), redactions: [], warnings: [] };
  assert.deepEqual(buildResponseView({ ...base, scripts: report }).scripts, report);
  assert.equal('scripts' in buildResponseView(base), false);
});
