import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectBodyText, protectGraphqlQuery, protectJson, protectPairs, protectXml } from '../../src/convert/body-secrets';

/** A stand-in for the secret store: the value is replaced by a variable named after what it was found under. */
const named = (name: string, value: string): string => (value.length === 0 ? value : `{{secret_${name.toLowerCase()}}}`);

test('JSON: a string under a secret name is replaced where it stands, and nothing else changes', () => {
  const text = '{\n  "user": "me",\n  "apiKey": "LITERAL-1",\n  "nested": { "client_secret" : "LITERAL-2", "note": "keep" },\n  "list": [{ "Password":\t"LITERAL-3" }]\n}';
  assert.equal(protectJson(text, named), '{\n  "user": "me",\n  "apiKey": "{{secret_apikey}}",\n  "nested": { "client_secret" : "{{secret_client_secret}}", "note": "keep" },\n  "list": [{ "Password":\t"{{secret_password}}" }]\n}');
});

test('JSON: only a literal string is a secret: numbers, variables, empty strings and names that do not say secret are left alone', () => {
  const text = '{"token": 12345, "password": "{{pw}}", "key": "", "auth": {"id": 1}, "monkeyName": "kept?", "plain": "value"}';
  // "monkeyName" contains "key" like any name does, and costs a variable: that is the same rule as for a query parameter or a form field.
  assert.equal(protectJson(text, named), '{"token": 12345, "password": "{{pw}}", "key": "", "auth": {"id": 1}, "monkeyName": "{{secret_monkeyname}}", "plain": "value"}');
});

test('JSON: escapes in a key are read, escapes in a value are kept as written, and a string that looks like a pair is not one', () => {
  assert.equal(protectJson('{"api\\u004bey": "a\\"b"}', named), '{"api\\u004bey": "{{secret_apikey}}"}');
  const seen: string[] = [];
  protectJson('{"password": "a\\"b\\\\"}', (name, value) => { seen.push(value); return value; });
  assert.deepEqual(seen, ['a\\"b\\\\'], 'the value is passed as it is written, so that the variable can stand for the same text');
  const inside = '{"note": "he said \\"password\\": \\"x\\"", "after": 1}';
  assert.equal(protectJson(inside, named), inside, 'a pair inside a string value is text');
});

test('JSON: broken or half-written text is returned as far as it was read, never thrown on', () => {
  assert.equal(protectJson('{"password": "abc', named), '{"password": "abc');
  assert.equal(protectJson('{"a": {{b}}, "token": "x"', named), '{"a": {{b}}, "token": "{{secret_token}}"');
  assert.equal(protectJson('no quotes at all', named), 'no quotes at all');
  assert.equal(protectJson('"password"', named), '"password"');
  assert.equal(protectJson('"password":', named), '"password":');
});

test('GraphQL: the string arguments of a query with a secret name are replaced; variables, comments and block strings are not arguments', () => {
  const query = 'mutation Login($password: String!) {\n  login(user: "me", password: "LITERAL-1", token : "LITERAL-2") { ok }\n  # password: "LITERAL-3"\n  note(text: """ password: "x" """, secret: "LITERAL-4")\n}';
  assert.equal(protectGraphqlQuery(query, named), 'mutation Login($password: String!) {\n  login(user: "me", password: "{{secret_password}}", token : "{{secret_token}}") { ok }\n  # password: "LITERAL-3"\n  note(text: """ password: "x" """, secret: "{{secret_secret}}")\n}');
  assert.equal(protectGraphqlQuery('{ a(password: $pw, token: 5) }', named), '{ a(password: $pw, token: 5) }');
});

test('GraphQL: a value is protected the way JSON will write it, because the query becomes one JSON string', () => {
  const seen: string[] = [];
  protectGraphqlQuery('{ login(password: "a\\"b") }', (name, value) => { seen.push(value); return value; });
  assert.deepEqual(seen, ['a\\\\\\"b']);
});

test('XML: the text of an element and the value of an attribute with a secret name, prefixes ignored, namespace declarations left alone', () => {
  const text = '<s:Envelope xmlns:auth="urn:auth"><wsse:UsernameToken><wsse:Username>me</wsse:Username>\n  <wsse:Password Type="x">  LITERAL-1  </wsse:Password></wsse:UsernameToken><Config apiKey=\'LITERAL-2\' name="n"/></s:Envelope>';
  assert.equal(protectXml(text, named), '<s:Envelope xmlns:auth="urn:auth"><wsse:UsernameToken><wsse:Username>me</wsse:Username>\n  <wsse:Password Type="x">  {{secret_password}}  </wsse:Password></wsse:UsernameToken><Config apiKey=\'{{secret_apikey}}\' name="n"/></s:Envelope>');
});

test('XML: an element with children is not a leaf, comments and CDATA are skipped, and a tag that never closes ends the reading', () => {
  const text = '<token><inner>x</inner></token><!-- <Password>LITERAL</Password> --><![CDATA[<Password>LITERAL</Password>]]><Secret>{{s}}</Secret>';
  assert.equal(protectXml(text, named), text);
  assert.equal(protectXml('<Password>LITERAL</Password', named), '<Password>{{secret_password}}</Password', 'a closing tag that is cut short still closes the element');
  assert.equal(protectXml('<a b="c', named), '<a b="c');
  assert.equal(protectXml('plain text', named), 'plain text');
});

test('A query string as a body: a pair with a secret name is replaced, and only when every part is a pair', () => {
  assert.equal(protectPairs('grant_type=password&client_secret=LITERAL-1&scope=a%20b', named), 'grant_type=password&client_secret={{secret_client_secret}}&scope=a%20b');
  assert.equal(protectPairs('\n pass%77ord=LITERAL-2 \n', named), '\n pass%77ord={{secret_password}} \n');
  assert.equal(protectPairs('a free text with password=LITERAL in it', named), 'a free text with password=LITERAL in it');
  assert.equal(protectPairs('no pairs here', named), 'no pairs here');
  assert.equal(protectPairs('password={{pw}}', named), 'password={{pw}}');
});

test('A raw body is read by what it looks like', () => {
  assert.equal(protectBodyText('  {"token": "LITERAL"}', named), '  {"token": "{{secret_token}}"}');
  assert.equal(protectBodyText('[{"token": "LITERAL"}]', named), '[{"token": "{{secret_token}}"}]');
  assert.equal(protectBodyText('<Token>LITERAL</Token>', named), '<Token>{{secret_token}}</Token>');
  assert.equal(protectBodyText('token=LITERAL', named), 'token={{secret_token}}');
  assert.equal(protectBodyText('just some text', named), 'just some text');
});

test('Every scanner makes one pass: a megabyte of hostile input takes a moment, not minutes', () => {
  const MiB = 1024 * 1024;
  const inputs: [string, (text: string) => string, string][] = [
    ['json quotes', text => protectJson(text, named), '"'.repeat(MiB)],
    ['json pairs', text => protectJson(text, named), '{"a":'.repeat(MiB / 5)],
    ['json keys', text => protectJson(text, named), '"password":'.repeat(MiB / 11)],
    ['json whitespace', text => protectJson(text, named), `"a"${' '.repeat(MiB)}`],
    ['graphql names', text => protectGraphqlQuery(text, named), 'a:"'.repeat(MiB / 3)],
    ['graphql blocks', text => protectGraphqlQuery(text, named), '"""'.repeat(MiB / 3)],
    ['xml tags', text => protectXml(text, named), '<a '.repeat(MiB / 3)],
    ['xml attributes', text => protectXml(text, named), `<a ${'b="c" '.repeat(MiB / 7)}`],
    ['xml secret elements', text => protectXml(text, named), '<Token>x'.repeat(MiB / 8)],
    ['pairs', text => protectPairs(text, named), 'a=&'.repeat(MiB / 3)],
    ['pairs equals', text => protectPairs(text, named), '='.repeat(MiB)]
  ];
  for (const [label, scan, text] of inputs) {
    const started = Date.now();
    scan(text);
    const took = Date.now() - started;
    assert.ok(took < 3000, `${label}: ${took} ms`);
  }
});
