import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { approve, describePending, digest, MAX_APPROVED, MAX_SNAPSHOT_CHARS, pendingScripts, readApproved, scriptKey, type ApprovedScript, type ScriptToRun } from '../../src/script/consent';

/** The consent to run the scripts of a collection: what is agreed to is a script with exactly that text, and anything else is asked about. */

const script = (id: string, code: string, phase: 'pre' | 'post' = 'pre', from = 'request'): ScriptToRun => ({ key: scriptKey(phase, id), phase, from, code });

test('The place of a script is its stage and the id of whoever holds it, and its digest is the SHA-256 of the text', () => {
  assert.equal(scriptKey('pre', 'R1'), 'pre|R1');
  assert.notEqual(scriptKey('pre', 'R1'), scriptKey('post', 'R1'));
  assert.equal(digest('pm.test("a", () => {});'), createHash('sha256').update('pm.test("a", () => {});').digest('hex'));
  assert.notEqual(digest('a'), digest('a '));
  assert.equal(digest(String.fromCodePoint(0xe9)), createHash('sha256').update(Buffer.from([0xc3, 0xa9])).digest('hex'), 'the text is hashed as UTF-8');
});

test('Nothing is agreed to at first; once agreed to, only a script with exactly that text runs', () => {
  const first = script('R1', 'one();');
  const pending = pendingScripts([first], []);
  assert.deepEqual(pending.map(item => [item.key, item.status, item.hash, item.previous]), [['pre|R1', 'new', digest('one();'), undefined]]);
  const agreed = approve([], pending);
  assert.deepEqual(pendingScripts([first], agreed), []);
  assert.equal(pendingScripts([script('R1', 'one(); ')], agreed).length, 1, 'a space is a change');
  const changed = pendingScripts([script('R1', 'one(); steal();')], agreed);
  assert.deepEqual(changed.map(item => [item.status, item.previous]), [['changed', 'one();']]);
  assert.deepEqual(pendingScripts([script('R2', 'one();')], agreed), [], 'the same text in another place was agreed to as well');
  assert.deepEqual(pendingScripts([script('R1', 'one();', 'post')], agreed), [], 'and in another stage: it is the text that is agreed to');
  assert.deepEqual(pendingScripts([], agreed), []);
});

test('Agreeing to a changed script replaces what was agreed to in its place, so the old text no longer runs', () => {
  const v1 = approve([], pendingScripts([script('R1', 'v1();'), script('R2', 'other();')], []));
  const v2 = approve(v1, pendingScripts([script('R1', 'v2();')], v1));
  assert.deepEqual(v2.map(entry => [entry.key, entry.code]).sort(), [['pre|R1', 'v2();'], ['pre|R2', 'other();']]);
  assert.equal(pendingScripts([script('R1', 'v1();')], v2).length, 1, 'the old version asks again');
  assert.equal(pendingScripts([script('R2', 'other();')], v2).length, 0);
});

test('A large script is agreed to by its digest only, and the oldest entries go when there are too many', () => {
  const big = 'x'.repeat(MAX_SNAPSHOT_CHARS + 1);
  const agreed = approve([], pendingScripts([script('R1', big), script('R2', 'small();')], []));
  assert.equal(agreed.find(entry => entry.key === 'pre|R1')?.code, undefined);
  assert.equal(agreed.find(entry => entry.key === 'pre|R2')?.code, 'small();');
  assert.equal(pendingScripts([script('R1', big)], agreed).length, 0);
  assert.equal(pendingScripts([script('R1', `${big}y`)], agreed)[0]?.previous, undefined, 'there is nothing to show a change against');
  let many: ApprovedScript[] = [];
  for (let index = 0; index < MAX_APPROVED + 20; index++) many = approve(many, pendingScripts([script(`R${index}`, `s${index}();`)], many));
  assert.equal(many.length, MAX_APPROVED);
  assert.equal(many[0]?.key, 'pre|R20', 'the first twenty were let go');
  assert.equal(many.at(-1)?.key, `pre|R${MAX_APPROVED + 19}`);
});

test('What was kept is read with care: a damaged entry is dropped, so the person is asked again', () => {
  const good = { key: 'pre|R1', hash: digest('a();'), code: 'a();' };
  assert.deepEqual(readApproved([good]), [good]);
  assert.deepEqual(readApproved(undefined), []);
  assert.deepEqual(readApproved('x'), []);
  assert.deepEqual(readApproved({ length: 1, 0: good }), [], 'only a list');
  const dropped = readApproved([null, 7, 'x', [], { key: 1, hash: good.hash }, { key: 'k' }, { key: 'k', hash: 'not-a-hash' }, { key: 'k', hash: good.hash.toUpperCase() }, { key: 'k', hash: `${good.hash}0` }]);
  assert.deepEqual(dropped, []);
  assert.deepEqual(readApproved([{ ...good, code: 'tampered();' }]), [{ key: 'pre|R1', hash: good.hash }], 'a text that does not match its digest is not believed');
  assert.deepEqual(readApproved([{ ...good, code: 5 }]), [{ key: 'pre|R1', hash: good.hash }]);
  assert.deepEqual(readApproved([{ key: 'pre|R1', hash: good.hash }]), [{ key: 'pre|R1', hash: good.hash }]);
  const many = Array.from({ length: MAX_APPROVED + 5 }, (_, index) => ({ key: `k${index}`, hash: good.hash }));
  assert.equal(readApproved(many).length, MAX_APPROVED);
  const inherited = Object.create({ key: 'pre|R1', hash: good.hash }) as object;
  assert.deepEqual(readApproved([inherited]), [], 'a value that is only inherited is not an entry');
});

test('The question names each script, in words, with its size and a name that cannot break the line', () => {
  const lines = describePending(pendingScripts([script('R1', 'a();\nb();\nc();', 'post', 'Orders'), script('R2', 'one();', 'pre', `bad${String.fromCharCode(10)}name${String.fromCharCode(0)}`)], []));
  assert.deepEqual(lines, ['New: the script after the answer of Orders (3 lines)', 'New: the script before the request of bad?name? (1 line)']);
  const previous = approve([], pendingScripts([script('R1', 'a();')], []));
  assert.deepEqual(describePending(pendingScripts([script('R1', 'a();\nb();', 'pre', 'request')], previous)), ['Changed: the script before the request of request (2 lines)']);
  assert.equal(describePending(pendingScripts([script('R1', 'a();', 'pre', 'n'.repeat(500))], []))[0]?.length, 'New: the script before the request of  (1 line)'.length + 80);
});
