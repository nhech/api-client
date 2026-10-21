import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactValues, secretForms } from '../../src/core/redact';

/** The forms a secret takes once a send has put it into an address, a form or a JSON text: every one of them is covered, and covering costs little. */

test('A value that has only the characters that a form also encodes is covered in a form body', () => {
  assert.equal(redactValues('user=ann&token=Hello%21World%7E1&x=1', ['Hello!World~1']), 'user=ann&token=[redacted]&x=1');
  assert.equal(redactValues("a=it%27s%28ok%29", ["it's(ok)"]), 'a=[redacted]');
});

test('A value is covered in the form that the address of a redirect has, which keeps the slashes and writes non-ASCII characters in hex', () => {
  const address = new URL('https://x.test/p?q=ab/cd ef&r=p\u00e4ssw\u00f6rd/1').href;
  assert.equal(address, 'https://x.test/p?q=ab/cd%20ef&r=p%C3%A4ssw%C3%B6rd/1');
  assert.equal(redactValues(address, ['ab/cd ef', 'p\u00e4ssw\u00f6rd/1']), 'https://x.test/p?q=[redacted]&r=[redacted]');
});

test('A value is covered with the escapes of JSON and when it was encoded twice', () => {
  assert.equal(redactValues('{"k":"a\\"b\\\\c"}', ['a"b\\c']), '{"k":"[redacted]"}');
  assert.equal(redactValues('x=a%2520b%2520c', ['a b c']), 'x=[redacted]');
  assert.equal(redactValues('line\\nbreak', ['line\nbreak']), '[redacted]', 'a line break as a JSON text writes it');
});

test('The forms are made once for a value, are the same each time, and there are no forms of an empty or an unchanged value', () => {
  const first = secretForms('a b/c');
  assert.equal(secretForms('a b/c'), first, 'the same list');
  assert.deepEqual(secretForms('plain'), ['plain']);
  assert.ok(!first.includes(''));
  assert.ok(first.length > 3);
  for (let index = 0; index < 600; index++) secretForms(`value number ${index}`);
  assert.deepEqual(secretForms('a b/c').slice().sort(), first.slice().sort(), 'a list that was dropped from the cache is made again, the same');
});

test('A very long secret costs about what searching for it costs, and a crowd of long ones does too', () => {
  const huge = 'S3cr3t-'.repeat(230_000);
  let started = Date.now();
  for (let index = 0; index < 5; index++) assert.equal(redactValues(`prefix ${huge} suffix`, [huge]), 'prefix [redacted] suffix');
  assert.ok(Date.now() - started < 1500, `a secret of ${huge.length} characters, five times: ${Date.now() - started} ms`);
  const many = Array.from({ length: 20 }, (_, index) => `${index}`.padStart(2, '0') + 'x\u00e4y'.repeat(100_000));
  started = Date.now();
  for (let index = 0; index < 5; index++) redactValues('a text with nothing in it', many);
  assert.ok(Date.now() - started < 1500, `20 secrets of 300,000 characters, five times: ${Date.now() - started} ms`);
  assert.deepEqual(secretForms(huge), [huge], 'a value that long is searched for as it is and in no other form');
});
