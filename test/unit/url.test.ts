import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertUrl } from '../../src/convert/url';
import type { ParamInput } from '../../src/convert/url';

/** Invisible and direction-changing characters are built from numbers: they must not appear in this source either. */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const p = (name: string, value: string, extra: Partial<ParamInput> = {}): ParamInput => ({ name, value, enabled: true, isPath: false, ...extra });
const path = (name: string, value: string, extra: Partial<ParamInput> = {}): ParamInput => p(name, value, { isPath: true, ...extra });

test('N2: the query that is already in the URL is kept once, and the parameters that repeat it add nothing', () => {
  const result = convertUrl('https://api.example/data/{{version}}/views/basic?universe={{symbol}}', [p('universe', '{{symbol}}')]);
  assert.equal(result.url, 'https://api.example/data/{{version}}/views/basic?universe={{symbol}}');
  assert.equal(result.appended, 0);
  assert.deepEqual(result.query, [{ name: 'universe', value: '{{symbol}}', enabled: true }]);
});

test('N2: an enabled parameter missing from the URL is appended, with a "?" or a "&", before any fragment', () => {
  assert.deepEqual([convertUrl('https://h/x', [p('page', '1')]).url, convertUrl('https://h/x', [p('page', '1')]).appended], ['https://h/x?page=1', 1]);
  assert.equal(convertUrl('https://h/x?a=1', [p('a', '1'), p('b', '2')]).url, 'https://h/x?a=1&b=2');
  assert.equal(convertUrl('https://h/x#frag', [p('b', '2')]).url, 'https://h/x?b=2#frag');
  assert.equal(convertUrl('https://h/x?a=1#frag', [p('b', '2')]).url, 'https://h/x?a=1&b=2#frag');
  assert.equal(convertUrl('', [p('a', '1')]).url, '?a=1');
});

test('N2: a query pair of the URL that no parameter mentions stays', () => {
  assert.equal(convertUrl('https://h/x?typed=in&a=1', [p('a', '1')]).url, 'https://h/x?typed=in&a=1');
  assert.equal(convertUrl('https://h/x?flag', [p('flag', '')]).url, 'https://h/x?flag');
  assert.equal(convertUrl('https://h/x?', []).url, 'https://h/x?');
});

test('N2: a disabled parameter is only listed, even when it is not in the URL', () => {
  const result = convertUrl('https://h/x?a=1', [p('a', '1'), p('sort', 'asc', { enabled: false })]);
  assert.equal(result.url, 'https://h/x?a=1');
  assert.deepEqual(result.query, [{ name: 'a', value: '1', enabled: true }, { name: 'sort', value: 'asc', enabled: false }]);
  assert.equal(result.appended, 0);
});

test('N2: equal pairs are matched one for one, and a percent-encoded pair matches its decoded parameter', () => {
  assert.equal(convertUrl('https://h/x?a=1&a=1', [p('a', '1')]).url, 'https://h/x?a=1&a=1');
  assert.equal(convertUrl('https://h/x?a=1', [p('a', '1'), p('a', '1')]).url, 'https://h/x?a=1&a=1');
  assert.equal(convertUrl('https://h/x?q=a%20b', [p('q', 'a b')]).url, 'https://h/x?q=a%20b');
  assert.equal(convertUrl('https://h/x?q=%zz', [p('q', '%zz')]).url, 'https://h/x?q=%zz', 'a broken escape is compared as it is');
});

test('N2: a parameter with no name is ignored', () => {
  assert.equal(convertUrl('https://h/x', [p('', 'v')]).url, 'https://h/x');
});

test('N2: an appended value is encoded where it would break the URL, and its variables are left alone', () => {
  assert.equal(convertUrl('https://h/x', [p('q', 'a b&c#d')]).url, 'https://h/x?q=a%20b%26c%23d');
  assert.equal(convertUrl('https://h/x', [p('q', '{{a b}}&{{c#d}}')]).url, 'https://h/x?q={{a b}}%26{{c#d}}');
});

test('N2: the ? and # of a variable are not a query or a fragment', () => {
  assert.equal(convertUrl('https://h/{{#guid}}', [p('a', '1')]).url, 'https://h/{{#guid}}?a=1');
  assert.equal(convertUrl('{{base?x}}/p', [p('a', '1')]).url, '{{base?x}}/p?a=1');
  assert.equal(convertUrl('https://h/x?id={{#number, 1, 2}}', [p('id', '{{#number, 1, 2}}')]).url, 'https://h/x?id={{#number, 1, 2}}');
});

test('N3: a path parameter that is a whole segment takes its value', () => {
  assert.equal(convertUrl('{{baseUrl}}/orders/:orderId', [path('orderId', '42')]).url, '{{baseUrl}}/orders/42');
  assert.equal(convertUrl('/orders/:id/items/:id', [path('id', '7')]).url, '/orders/7/items/7');
  assert.equal(convertUrl('orders/:id', [path('id', '7')]).url, 'orders/7');
  assert.equal(convertUrl('https://h/users/:name/{{x}}', [path('name', '{{user}}')]).url, 'https://h/users/{{user}}/{{x}}');
  assert.equal(convertUrl('https://h/a/:id?x=:id', [path('id', '7')]).url, 'https://h/a/7?x=:id', 'the query is not a path');
});

test('N3: a port, the host and part of a segment are not path parameters', () => {
  assert.equal(convertUrl('https://h:8080/a/:id', [path('id', '7')]).url, 'https://h:8080/a/7');
  assert.equal(convertUrl('https://:id/a', [path('id', '7')]).url, 'https://:id/a');
  assert.equal(convertUrl('https://h/a/:id.json', [path('id', '7')]).url, 'https://h/a/:id.json');
  assert.equal(convertUrl('https://h/a/x:id', [path('id', '7')]).url, 'https://h/a/x:id');
  assert.equal(convertUrl('https://h/a/:other', [path('id', '7')]).url, 'https://h/a/:other');
  assert.equal(convertUrl('https://h', [path('id', '7')]).url, 'https://h');
});

test('N3: an empty value keeps the placeholder and is counted; a disabled path parameter does nothing', () => {
  const empty = convertUrl('https://h/a/:id/:name', [path('id', ''), path('name', 'x')]);
  assert.equal(empty.url, 'https://h/a/:id/x');
  assert.equal(empty.emptyPathParams, 1);
  assert.equal(convertUrl('https://h/a/:id', [path('id', '7', { enabled: false })]).url, 'https://h/a/:id');
  assert.equal(convertUrl('https://h/a/:id', [path('id', '1'), path('id', '2')]).url, 'https://h/a/1', 'the first parameter of a name wins');
});

test('The URL fits on one line: spaces are encoded, and so are line breaks and hidden characters', () => {
  assert.equal(convertUrl('https://h/a b/{{x y}}', []).url, 'https://h/a%20b/{{x y}}');
  const broken = convertUrl('https://h/a\r\nb\nc', []);
  assert.equal(broken.url, 'https://h/a%0D%0Ab%0Ac');
  assert.equal(broken.lineBreak, true);
  assert.equal(convertUrl('https://h/' + cp(0x202e) + 'x' + cp(0x00), []).url, 'https://h/%E2%80%AEx%00');
  const inVariable = convertUrl('https://h/{{a\nb}}', []);
  assert.equal(inVariable.url, 'https://h/{{a b}}');
  assert.equal(inVariable.lineBreak, true);
  assert.equal(convertUrl('https://h/' + cp(0xd800) + 'x', []).url, 'https://h/' + cp(0xd800) + 'x', 'a lone surrogate is not a control character');
});

test('A URL with nothing special passes through unchanged', () => {
  for (const url of ['https://example.com', 'http://localhost:3000/a/b?c=d#e', '{{baseUrl}}', '/relative/path', 'ftp://h/', '']) assert.equal(convertUrl(url, []).url, url);
});

test('Matching parameters to the query stays linear when the same pair repeats tens of thousands of times', () => {
  const count = 50_000;
  const url = 'https://h/x?' + 'a=1&'.repeat(count) + 'z=9';
  const params = Array.from({ length: count + 10 }, () => p('a', '1'));
  const started = Date.now();
  const result = convertUrl(url, params);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(result.appended, 10, 'the 50,000 pairs match 50,000 parameters, the last 10 are appended');
  assert.ok(result.url.endsWith('&a=1&a=1&a=1&a=1&a=1&a=1&a=1&a=1&a=1&a=1'));
});

test('A very long URL is handled in linear time', () => {
  const url = 'https://h/' + 'a/'.repeat(200_000) + '?' + 'k=v&'.repeat(50_000) + 'end';
  const started = Date.now();
  const result = convertUrl(url, [p('end', ''), path('x', '1')]);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(result.url, url);
});

/** A stand-in for the secret store that says which part of the URL a value came from. */
const parted = (name: string, value: string, part: 'query' | 'userinfo' | 'pathparam' | 'fragment' = 'query'): string => (/secret|token|password|key/i.test(name) ? `{{${part}:${name}}}` : value);

test('8.3: the password before the "@" is protected, the user name is not, and a lone userinfo is taken for a token', () => {
  assert.equal(convertUrl('https://me:PW@example.com/a?x=1', [], parted).url, 'https://me:{{userinfo:password}}@example.com/a?x=1');
  assert.equal(convertUrl('https://TOKEN@example.com/a', [], parted).url, 'https://{{userinfo:token}}@example.com/a');
  assert.equal(convertUrl('https://me:p@ss@example.com', [], parted).url, 'https://me:{{userinfo:password}}@example.com', 'the last "@" ends the userinfo');
  assert.equal(convertUrl('https://me:{{pw}}@example.com', [], (name, value) => value).url, 'https://me:{{pw}}@example.com');
  assert.equal(convertUrl('https://example.com/a@b', [], parted).url, 'https://example.com/a@b', 'an "@" in the path is not a userinfo');
  assert.equal(convertUrl('{{base}}/a', [], parted).url, '{{base}}/a');
  assert.equal(convertUrl('https://example.com:8080/a', [], parted).url, 'https://example.com:8080/a');
});

test('8.3: a path parameter with a secret name is protected before it takes its place, one with another name is not', () => {
  assert.equal(convertUrl('https://h/keys/:apikey/items/:id', [path('apikey', 'LITERAL'), path('id', '7')], parted).url, 'https://h/keys/{{pathparam:apikey}}/items/7');
  assert.equal(convertUrl('https://h/:apikey', [path('apikey', '{{k}}')], (name, value) => value).url, 'https://h/{{k}}');
});

test('8.3: the pairs of a fragment are protected like a query, a fragment that is not pairs is left alone', () => {
  assert.equal(convertUrl('https://h/cb#access_token=LITERAL&state=1', [], parted).url, 'https://h/cb#access_token={{fragment:access_token}}&state=1');
  assert.equal(convertUrl('https://h/cb#section-2', [], parted).url, 'https://h/cb#section-2');
  assert.equal(convertUrl('https://h/cb#', [], parted).url, 'https://h/cb#');
  assert.equal(convertUrl('https://h/cb?token=A#token=B', [], parted).url, 'https://h/cb?token={{query:token}}#token={{fragment:token}}');
});

test('8.3: without a protect function nothing in the URL changes', () => {
  assert.equal(convertUrl('https://me:PW@h/:apikey?token=1#token=2', [path('apikey', 'K')]).url, 'https://me:PW@h/K?token=1#token=2');
});
