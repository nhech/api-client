import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineHeaders, ensureContentType, readHeaders } from '../../src/convert/headers';
import type { InheritedHeader } from '../../src/convert/inherit';
import { Coercions } from '../../src/normalize/coerce';

const own = (name: string, value: string, enabled = true) => ({ name, value, enabled });
const inh = (name: string, value: string, from = 'F', enabled = true): InheritedHeader => ({ name, value, enabled, from });
const brief = (result: ReturnType<typeof combineHeaders>) => result.headers.map(h => `${h.enabled ? '' : '#'}${h.name}: ${h.value}`);

test('readHeaders reads names and values, skips what has no name, and counts the wrong types', () => {
  const coerce = new Coercions();
  const read = readHeaders([{ name: ' Accept ', value: 'x' }, { name: 'X-Off', value: 'y', isDisabled: true }, { value: 'no name' }, { name: '' }, null, 'text', { name: 'N', value: 5 }], coerce);
  assert.deepEqual(read, [{ name: 'Accept', value: 'x', enabled: true }, { name: 'X-Off', value: 'y', enabled: false }, { name: 'N', value: '5', enabled: true }]);
  assert.equal(coerce.count, 1);
  assert.deepEqual(readHeaders('nope', coerce), []);
});

test('N4: the defaults Thunder adds are dropped, the author\'s own choices are not', () => {
  const result = combineHeaders([own('Accept', '*/*'), own('User-Agent', 'Thunder Client (https://www.thunderclient.com)'), own('Accept', 'application/json'), own('User-Agent', 'my-app/1.0'), own('X-Keep', '1')], []);
  assert.deepEqual(brief(result), ['Accept: application/json', 'User-Agent: my-app/1.0', 'X-Keep: 1']);
  assert.equal(result.defaultsDropped, 2);
  assert.deepEqual(brief(combineHeaders([own('Accept', '*/*', false)], [])), ['#Accept: */*'], 'a disabled one is not a default in force; it stays as a comment');
});

test('N4: the defaults are dropped from inherited headers too', () => {
  const result = combineHeaders([], [inh('Accept', '*/*'), inh('X-A', '1')]);
  assert.deepEqual(brief(result), ['X-A: 1']);
  assert.equal(result.defaultsDropped, 1);
});

test('N17: inherited headers come after the request\'s own; a disabled inherited one is dropped, a disabled own one stays', () => {
  const result = combineHeaders([own('X-Own', '1'), own('X-Off', '2', false)], [inh('X-In', '3', 'Col'), inh('X-Dis', '4', 'F', false)]);
  assert.deepEqual(brief(result), ['X-Own: 1', '#X-Off: 2', 'X-In: 3']);
  assert.equal(result.inherited, 1);
});

test('Headers that differ only in letter case are one: the request\'s own wins, the last of its own, else the nearest inherited', () => {
  const ownWins = combineHeaders([own('content-type', 'a')], [inh('Content-Type', 'b')]);
  assert.deepEqual(brief(ownWins), ['content-type: a']);
  assert.equal(ownWins.caseDuplicates, 1);
  assert.deepEqual(brief(combineHeaders([own('X-A', '1'), own('x-a', '2')], [])), ['x-a: 2']);
  assert.deepEqual(brief(combineHeaders([], [inh('Accept', 'near'), inh('accept', 'far')])), ['Accept: near']);
  assert.deepEqual(brief(combineHeaders([own('x-a', 'own')], [inh('X-A', 'i1'), inh('X-a', 'i2')])), ['x-a: own']);
});

test('Two headers with exactly the same name are both kept, and a disabled one never takes part in the case rule', () => {
  assert.deepEqual(brief(combineHeaders([own('Set-X', '1'), own('Set-X', '2')], [])), ['Set-X: 1', 'Set-X: 2']);
  assert.deepEqual(brief(combineHeaders([own('Accept', 'a'), own('accept', 'b', false)], [])), ['Accept: a', '#accept: b']);
});

test('Content-Type is added when no enabled header of any case has it', () => {
  const base = combineHeaders([own('X-A', '1')], []).headers;
  assert.deepEqual(ensureContentType(base, 'application/json').map(h => `${h.name}: ${h.value}`), ['X-A: 1', 'Content-Type: application/json']);
  const has = combineHeaders([own('content-TYPE', 'text/x')], []).headers;
  assert.deepEqual(ensureContentType(has, 'application/json').map(h => h.value), ['text/x']);
  const off = combineHeaders([own('Content-Type', 'text/x', false)], []).headers;
  assert.deepEqual(ensureContentType(off, 'application/json').map(h => `${h.enabled}:${h.value}`), ['false:text/x', 'true:application/json']);
});
