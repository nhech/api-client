import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicCredential, CREDENTIAL_HEADERS, isSecretName, redactedValue, redactValues, REDACTED } from '../../src/core/redact';

test('Which header and parameter names are secret', () => {
  for (const name of ['Authorization', 'authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'x-api-key', 'api_key', 'apikey', 'ApiKey', 'access_token', 'refresh-token', 'X-Auth-Token', 'client_secret', 'password', 'Passwd', 'X-Session-Id', 'session', 'token', 'x-csrf-token', 'X-Signature', 'Bearer', 'private-key', 'credentials', 'secrets']) {
    assert.equal(isSecretName(name), true, name);
  }
  for (const name of ['Accept', 'Content-Type', 'User-Agent', 'X-Request-Id', 'Host', 'If-None-Match', 'monkey', 'turkey', 'keyboard', 'tokenizer', 'X-Trace', 'Cache-Control', 'page', 'limit']) {
    assert.equal(isSecretName(name), false, name);
  }
  assert.equal(isSecretName('  Authorization  '), true);
});

test('The headers that never cross to another origin', () => {
  assert.deepEqual([...CREDENTIAL_HEADERS].sort(), ['authorization', 'cookie', 'proxy-authorization']);
});

test('The values of secrets are covered in text, the longest first, and short ones are left alone', () => {
  assert.equal(redactValues('token=abc12345 and more abc12345', ['abc12345']), `token=${REDACTED} and more ${REDACTED}`);
  assert.equal(redactValues('abcdef and abcd', ['abcd', 'abcdef']), `${REDACTED} and ${REDACTED}`, 'a value that contains another is covered whole');
  assert.equal(redactValues('a b c', ['a', 'ab', 'abc']), 'a b c', 'under four characters hides too much');
  assert.equal(redactValues('nothing here', ['secret1']), 'nothing here');
  assert.equal(redactValues('x'.repeat(100_000) + 'SECRET1', ['SECRET1']), 'x'.repeat(100_000) + REDACTED);
  assert.equal(redactValues('same same', ['same', 'same']), `${REDACTED} ${REDACTED}`);
});

test('A value to show: hidden when its name is secret, covered when it holds a secret', () => {
  assert.equal(redactedValue('Authorization', 'Bearer x', []), REDACTED);
  assert.equal(redactedValue('X-Note', 'contains hunter22 inside', ['hunter22']), `contains ${REDACTED} inside`);
  assert.equal(redactedValue('Accept', 'application/json', ['hunter22']), 'application/json');
});

test('A Basic credential is the base64 of user:password, for any characters', () => {
  assert.equal(basicCredential('aladdin', 'opensesame'), 'YWxhZGRpbjpvcGVuc2VzYW1l');
  assert.equal(basicCredential('', ''), 'Og==');
  assert.equal(basicCredential('user', 'p\u00e4ss:w\u00f6rd'), Buffer.from('user:p\u00e4ss:w\u00f6rd', 'utf8').toString('base64'));
});
