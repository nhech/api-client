import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImpBody, ImpRequest } from '../../src';
import { renderBody, disabledBodyLines, needsExternalBody, encodeForm, filePathRef } from '../../src/emit/body';
import { renderRequest } from '../../src/emit/http';
import { identifier, uniqueIdentifiers, uniqueSlugs } from '../../src/emit/names';

const base = (extra: Partial<ImpRequest> = {}): ImpRequest => ({
  sourceId: 'r1', name: 'Get user', method: 'GET', url: 'https://api.example/users/1', query: [], headers: [], assertions: [], captures: [], notes: [], skippedScripts: [], ...extra
});
const render = (extra: Partial<ImpRequest> = {}, save: (text: string) => string = () => './_bodies/x.txt') => renderRequest(base(extra), 'get_user', save);

test('A plain request is the title, the name, the request line and the headers', () => {
  const { text, externalBody } = render({ headers: [{ name: 'Accept', value: 'application/json', enabled: true, secret: false }] });
  assert.equal(text, ['### Get user', '# @name get_user', 'GET https://api.example/users/1', 'Accept: application/json'].join('\n'));
  assert.equal(externalBody, false);
});

test('The lines of a block are in the order of the spec: title, name, docs, captures, assertions, disabled, notes, scripts, request', () => {
  const { text } = render({
    docs: 'First line\nSecond line',
    captures: [{ variable: 'token', scope: 'active', source: 'json $.access_token' }, { variable: 'id', scope: 'global', source: 'header X-Id' }],
    assertions: [{ target: 'status', op: '==', expected: '200' }, { target: 'json', name: '$.items', op: 'count', expected: '3' }, { target: 'header', name: 'Content-Type', op: 'includes', expected: 'json' }],
    headers: [{ name: 'X-Debug', value: '1', enabled: false, secret: false }, { name: 'Accept', value: '*/*', enabled: true, secret: false }],
    query: [{ name: 'page', value: '2', enabled: false }],
    notes: ['[auth oauth2 not imported]'],
    skippedScripts: [{ phase: 'pre', lines: ['console.log(1)', 'x()'] }]
  });
  assert.deepEqual(text.split('\n'), [
    '### Get user', '# @name get_user',
    '# First line', '# Second line',
    '# @capture token = json $.access_token', '# @capture global:id = header X-Id',
    '# @assert status == 200', '# @assert json $.items count 3', '# @assert header Content-Type includes json',
    '# [disabled] X-Debug: 1', '# [disabled query] page=2',
    '# [auth oauth2 not imported]',
    '# [script not imported: pre]', '# | console.log(1)', '# | x()',
    'GET https://api.example/users/1', 'Accept: */*'
  ]);
});

test('Authorization is written from the authentication, and a secret stays the variable that stands for it', () => {
  assert.match(render({ auth: { kind: 'bearer', token: { value: '{{secret_a_token}}', secret: true } } }).text, /\nAuthorization: Bearer \{\{secret_a_token\}\}$/);
  assert.match(render({ auth: { kind: 'basic', username: { value: '{{u}}', secret: false }, password: { value: '{{secret_a_password}}', secret: true } } }).text, /\nAuthorization: Basic \{\{u\}\} \{\{secret_a_password\}\}$/);
  // A user name with a space cannot be told from the password in the space form, so that one keeps the colon.
  assert.match(render({ auth: { kind: 'basic', username: { value: 'john smith', secret: false }, password: { value: '{{p}}', secret: false } } }).text, /\nAuthorization: Basic john smith:\{\{p\}\}$/);
  assert.doesNotMatch(render({ auth: { kind: 'unsupported', type: 'oauth2' } }).text, /Authorization/);
});

test('A body goes after one blank line; a request without a body has none', () => {
  const text = render({ method: 'POST', body: { kind: 'text', contentType: 'application/json', text: '{"a":1}\n\n' } }).text;
  assert.ok(text.endsWith('POST https://api.example/users/1\n\n{"a":1}'), text);
  assert.doesNotMatch(render({ body: { kind: 'text', contentType: 'text/plain', text: '' } }).text, /\n\n/);
});

test('Nothing from the data can add a line: line breaks in one-line values are replaced, and docs cannot start a directive', () => {
  const attack = base({
    name: 'evil\r\n### Another\nPOST https://attacker.invalid/',
    url: 'https://api.example/a\r\nDELETE https://attacker.invalid/',
    docs: '@name hijack\n  @assert status == 200\n### not a separator',
    headers: [{ name: 'X-A', value: 'v\nX-Injected: 1', enabled: true, secret: false }],
    captures: [{ variable: 'v\nPOST /x', scope: 'active', source: 'body' }],
    notes: ['@capture x = body'],
    skippedScripts: [{ phase: 'post', lines: ['@assert status == 500', '### x'], from: 'folder\n### y' }]
  });
  const { text } = renderRequest(attack, 'evil', () => './x');
  const lines = text.split('\n');
  assert.equal(lines.filter(line => line.startsWith('###')).length, 1, 'one separator, the title');
  assert.equal(lines.filter(line => /^(?:GET|POST|DELETE) /.test(line)).length, 1, 'one request line');
  assert.equal(lines.filter(line => /^# @(?:name|capture|assert)\b/.test(line)).length, 2 + 0, 'only the name and the one capture the model has');
  assert.ok(!lines.some(line => line.startsWith('X-Injected')));
  for (const line of lines) assert.ok(!/^\s*#\s*@(?:name hijack|assert status == (?:200|500)|capture x)/.test(line), line);
});

test('A body with a line that starts with ### is saved to a separate file and read with <', () => {
  const saved: string[] = [];
  const { text, externalBody } = renderRequest(base({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'line\n### not a request\nPOST /x' } }), 'r', body => { saved.push(body); return './_bodies/body-0001.txt'; });
  assert.equal(externalBody, true);
  assert.deepEqual(saved, ['line\n### not a request\nPOST /x']);
  assert.ok(text.endsWith('\n\n< ./_bodies/body-0001.txt'), text);
  assert.doesNotMatch(text, /not a request/);
  assert.equal(needsExternalBody('a\n###b'), true);
  assert.equal(needsExternalBody('a ### b\nc'), false, 'only a line that STARTS with ###');
  assert.equal(needsExternalBody('###'), true);
});

test('A body line that starts with # or // goes to a file too: REST Client drops such a line from an inline body', () => {
  for (const body of ['a\n# b', '# first', 'a\n// b', '//', 'text\n#!shebang-like\nmore']) assert.equal(needsExternalBody(body), true, JSON.stringify(body));
  for (const body of ['a # b', 'a // b', 'http://example.invalid/x', ' # indented is not a comment start', '{"a":"#"}']) assert.equal(needsExternalBody(body), false, JSON.stringify(body));
  const saved: string[] = [];
  const { text, externalBody } = renderRequest(base({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'first\n# heading\n// slash\nlast' } }), 'r', body => { saved.push(body); return './_bodies/body-0001.txt'; });
  assert.equal(externalBody, true);
  assert.deepEqual(saved, ['first\n# heading\n// slash\nlast']);
  assert.doesNotMatch(text, /heading|slash/);
});

test('In a multipart body only the part that cannot stand inside the file goes to a file; the framing and the attached files stay', () => {
  const body: ImpBody = { kind: 'multipart', parts: [{ name: 'note', value: 'a\n# b', enabled: true }, { name: 'plain', value: 'fine', enabled: true }, { name: 'file', filePath: 'data/in.csv', enabled: true }] };
  const saved: string[] = [];
  const { text, externalBody } = renderRequest(base({ method: 'POST', body }), 'r', value => { saved.push(value); return './_bodies/body-0001.txt'; });
  assert.equal(externalBody, true);
  assert.deepEqual(saved, ['a\n# b']);
  assert.ok(text.includes('name="note"\n\n< ./_bodies/body-0001.txt\n'), text);
  assert.ok(text.includes('name="plain"\n\nfine\n'));
  assert.ok(text.includes('< ./data/in.csv\n'), 'the attached file is still read');
  assert.ok(!text.includes('# b'), 'the dangerous line is not in the file');
});

test('A body line that would include a file or run a handler can never be written into the file: < and > lines (JetBrains, REST Client)', () => {
  for (const body of ['x\n< ../../secret.txt', '< C:\\Users\\me\\.ssh\\id_rsa', 'x\n<> response.json', 'x\n> {% client.global.set("a", 1) %}', 'x\n> handler.js', 'x\n>> out.json', 'x\n<', 'x\n>']) {
    assert.equal(needsExternalBody(body), true, JSON.stringify(body));
  }
  for (const body of ['<root>\n  <a b="1"/>\n</root>', '<?xml version="1.0"?>', 'a < b', 'a > b', '{"a":"< x"}']) assert.equal(needsExternalBody(body), false, JSON.stringify(body));
  const saved: string[] = [];
  const { text } = renderRequest(base({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'before\n< ../../secret.txt\nafter' } }), 'r', value => { saved.push(value); return './_bodies/body-0001.txt'; });
  assert.deepEqual(saved, ['before\n< ../../secret.txt\nafter']);
  assert.ok(text.endsWith('\n\n< ./_bodies/body-0001.txt'), text);
  assert.ok(!text.includes('secret.txt'));
});

test('A body in a file that holds {{variables}} says so, because some tools do not replace variables inside a file', () => {
  const withVariable = renderRequest(base({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: '# {{title}}\nbody' } }), 'r', () => './_bodies/body-0001.txt').text;
  assert.match(withVariable, /\n# \[part of the body is in a file; some tools do not replace \{\{variables\}\} inside a file\]\nPOST /);
  const without = renderRequest(base({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: '# title\nbody' } }), 'r', () => './_bodies/body-0001.txt').text;
  assert.doesNotMatch(without, /part of the body/);
});

test('Body text: form fields are encoded but variables are not, multipart has parts and files, GraphQL is a JSON envelope', () => {
  assert.equal(renderBody({ kind: 'form', fields: [{ name: 'user name', value: 'a&b={{v}}', enabled: true }, { name: 'off', value: '1', enabled: false }] }), 'user%20name=a%26b%3D{{v}}');
  assert.equal(renderBody({ kind: 'form', fields: [{ name: 'off', value: '1', enabled: false }] }), undefined);
  const multipart = renderBody({ kind: 'multipart', parts: [{ name: 'a', value: '1', enabled: true }, { name: 'f', filePath: 'data/in.csv', enabled: true }, { name: 'x', value: '2', enabled: false }] });
  const boundary = '------ApiClientImport';
  assert.equal(multipart, [boundary, 'Content-Disposition: form-data; name="a"', '', '1', boundary, 'Content-Disposition: form-data; name="f"; filename="in.csv"', 'Content-Type: application/octet-stream', '', '< ./data/in.csv', `${boundary}--`].join('\n'));
  const graphql = renderBody({ kind: 'graphql', query: '{ me { id } }', variables: '{"a":1}' });
  assert.deepEqual(JSON.parse(graphql ?? 'null'), { query: '{ me { id } }', variables: { a: 1 } });
  assert.equal(encodeForm('a b{{x y}}'), 'a%20b{{x y}}');
});

test('Attached files: a relative path starts with ./ and uses /, an absolute one is kept', () => {
  assert.equal(filePathRef('data/in.csv'), './data/in.csv');
  assert.equal(filePathRef('data\\in.csv'), './data/in.csv');
  assert.equal(filePathRef('./a.csv'), './a.csv');
  assert.equal(filePathRef('../a.csv'), '../a.csv');
  assert.equal(filePathRef('C:\\Users\\me\\a.csv'), 'C:\\Users\\me\\a.csv');
  assert.equal(filePathRef('/etc/a.csv'), '/etc/a.csv');
  assert.equal(filePathRef('~/a.csv'), '~/a.csv');
  assert.equal(filePathRef('a\nb'), './a b');
});

test('Fields switched off appear as comments, and never as part of the body', () => {
  const body: ImpBody = { kind: 'form', fields: [{ name: 'keep', value: '1', enabled: true }, { name: 'drop', value: '2', enabled: false }] };
  assert.deepEqual(disabledBodyLines(body), ['# [disabled form field] drop=2']);
  assert.doesNotMatch(renderBody(body) ?? '', /drop/);
});

test('A very long or empty title is made safe', () => {
  assert.match(render({ name: '' }).text, /^### \(unnamed\)\n/);
  const long = renderRequest(base({ name: 'x'.repeat(500) }), 'r', () => '').text.split('\n')[0] ?? '';
  assert.equal(Array.from(long).length, 4 + 200);
  assert.ok(long.endsWith('...'));
});

test('@name identifiers are ASCII word characters, unique ignoring case, and never empty', () => {
  assert.equal(identifier('Get user (v2)'), 'Get_user_v2');
  assert.equal(identifier(''), 'request');
  assert.equal(identifier('!!!'), 'request');
  assert.equal(identifier(`D${String.fromCodePoint(0x103)}ng nh${String.fromCodePoint(0x1ead)}p`), 'Dang_nhap');
  assert.deepEqual(uniqueIdentifiers(['a b', 'A_B', 'a-b', '']), ['a_b', 'A_B_2', 'a_b_3', 'request']);
});

test('Folder names that take up a file and a folder cannot collide: a folder called "x.http" and one called "x"', () => {
  const slugs = uniqueSlugs(['x', 'x.http', 'index'], 60, ['index.http', '_bodies'], slug => [slug, `${slug}.http`]).map(item => item.slug);
  assert.deepEqual(slugs, ['x', 'x.http-2', 'index-2']);
});
