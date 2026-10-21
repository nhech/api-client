import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from '../../src/core/assert';
import type { WireRequest, WireResponse } from '../../src/engine/types';
import { buildResponseView, testSubject } from '../../src/view/response';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const sent: WireRequest = { method: 'GET', url: 'https://api.test/x', headers: [] };
const response = (over: Partial<WireResponse> = {}): WireResponse => ({
  status: 200, statusText: 'OK', httpVersion: '1.1', headers: [['Content-Type', 'application/json']], body: { kind: 'memory', bytes: bytes('{"a":1}') }, wireBytes: 7, size: 7, truncated: false,
  timings: { dnsMs: 1, connectMs: 2, tlsMs: 0, ttfbMs: 5, downloadMs: 1, totalMs: 9 }, redirects: [], finalUrl: sent.url, sent, warnings: [], ...over
});

test('What the tests of a request see: the status, the time, the headers, and the body as text when it is one', () => {
  const subjectOf = (over: Partial<WireResponse>, given = bytes('{"a":1}')) => testSubject(response(over), given);
  const base = subjectOf({});
  assert.deepEqual([base.status, base.durationMs, base.body, base.headers.length], [200, 9, '{"a":1}', 1]);
  assert.equal(subjectOf({ headers: [['Content-Type', 'text/plain; charset=iso-8859-1']], size: 4 }, Uint8Array.from([0x63, 0x61, 0x66, 0xe9])).body, `caf${String.fromCodePoint(0xe9)}`, 'in the character set the response names');
  assert.deepEqual([subjectOf({ size: 0 }, new Uint8Array(0)).body, subjectOf({ size: 0 }, new Uint8Array(0)).bodyNote], ['', undefined]);
  const picture = subjectOf({ headers: [['Content-Type', 'image/png']], size: 4 }, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([picture.body, picture.bodyNote], [undefined, 'The body is not text.']);
  assert.equal(subjectOf({ headers: [['Content-Type', 'application/pdf']], size: 5 }, bytes('%PDF-')).bodyNote, 'The body is not text.');
  assert.equal(subjectOf({ headers: [], size: 3 }, Uint8Array.from([0x41, 0, 0x42])).bodyNote, 'The body is not text.', 'a zero byte');
  assert.equal(subjectOf({ timings: { dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, downloadMs: 0, totalMs: 14.006000000000313 } }).durationMs, 14, 'the time is whole milliseconds, as it is written in a test');
  const partial = subjectOf({ size: 10_000_000 });
  assert.deepEqual([partial.body, partial.bodyNote], [undefined, 'The body (9.5 MB) is too large to be tested.']);
});

test('What a capture saved is listed with its value, except for a secret, which is only said to be there', () => {
  const capture = (variable: string, value: string, over: Partial<CaptureResult> = {}): CaptureResult => ({ expr: `${variable} = json $.x`, from: 'request', ok: true, variable, scope: 'active', action: 'set', value, message: '', ...over });
  const result = buildResponseView({
    response: response(), bytes: bytes('{"a":1}'), redactions: [], warnings: [],
    captures: [capture('page', '2'), capture('access_token', 'abc12345'), capture('long', 'y'.repeat(300)), capture('gone', '', { action: 'delete' }), capture('bad', '', { ok: false, message: 'nothing at $.x' })],
    tests: [{ expr: 'status == 200', from: 'request', ok: true, message: '' }]
  });
  assert.deepEqual(result.saved.map(item => [item.variable, item.value.length, item.secret, item.action, item.ok]), [['page', 1, false, 'set', true], ['access_token', 0, true, 'set', true], ['long', 200, false, 'set', true], ['gone', 0, false, 'delete', true], ['bad', 0, false, 'set', false]]);
  assert.equal(result.saved[0]?.value, '2');
  assert.ok(result.saved[2]?.value.endsWith('...'));
  assert.ok(!JSON.stringify(result).includes('abc12345'), 'the value of a secret is nowhere in the view');
  assert.equal(result.saved[4]?.message, 'nothing at $.x');
  assert.deepEqual(result.tests, [{ expr: 'status == 200', from: 'request', ok: true, message: '' }]);
  assert.deepEqual(buildResponseView({ response: response(), bytes: bytes('{}'), redactions: [], warnings: [] }).tests, []);
});
