import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newContainer, newRequest, type Body, type KV, type Request } from '../../src/core/model';
import { mirrorOf, type MirrorInput } from '../../src/mirror/generate';
import { httpSafe } from '../../src/mirror/safe';

/** The mirror is read by tools that run what is between braces and read the files that a body names: a request from a cloned repository must not use that. */

const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: '' });
const request = (change: Partial<Request>): Request => ({ ...newRequest('R1', 'Hostile'), method: 'POST', url: 'https://x.example/a', ...change });
const input = (change: Partial<Request>, over: Partial<MirrorInput> = {}): MirrorInput => ({ request: request(change), levels: [{ kind: 'collection', name: 'Shop', container: newContainer('C1', 'Shop') }], workspaceSettings: {}, file: 'hostile.req.yml', collection: 'Shop', depth: 0, ...over });
const block = (change: Partial<Request>, over: Partial<MirrorInput> = {}): string => mirrorOf(input(change, over)).block;

test('Text between braces is written as it is only when it is a plain name or a dynamic word of the client', () => {
  for (const same of ['{{base}}/a', '{{ base }}', '{{a_b-c1}}', '{{$guid}}', '{{$uuid}}', '{{$timestamp}}', '{{$timestamp -1 d}}', '{{$isoTimestamp}}', '{{$randomInt 1 6}}', '{{$randomBoolean}}', '{{$randomString 8}}', '{{$randomEmail}}', 'no braces', '{ {already separated} }', '{one}', '']) {
    assert.equal(httpSafe(same), same, same);
  }
  assert.equal(httpSafe("{{ require('child_process').execSync('calc') }}"), "{ { require('child_process').execSync('calc') } }", 'httpYac would run it');
  assert.equal(httpSafe('{{$processEnv AWS_SECRET_ACCESS_KEY}}'), '{ {$processEnv AWS_SECRET_ACCESS_KEY} }', 'REST Client and httpYac would put an environment variable into the request');
  assert.equal(httpSafe('{{$dotenv TOKEN}}{{$env.HOME}}{{$aadV2Token}}'), '{ {$dotenv TOKEN} }{ {$env.HOME} }{ {$aadV2Token} }');
  assert.equal(httpSafe('{{process.env.SECRET}}'), '{ {process.env.SECRET} }', 'a dot makes it a path that is read, not a name');
  assert.equal(httpSafe('{{$randomInt 1}}'), '{ {$randomInt 1} }', 'a dynamic word with arguments that the client does not accept');
  assert.equal(httpSafe('{{$nonsense}}'), '{ {$nonsense} }');
  assert.equal(httpSafe('{{ 1 + 1 }}{{a()}}{{x;y}}'), '{ { 1 + 1 } }{ {a()} }{ {x;y} }');
  assert.equal(httpSafe('a {{ unclosed\nrequire("fs")'), 'a { { unclosed\nrequire("fs")', 'httpYac starts a script at a {{ that is never closed');
  assert.equal(httpSafe('{{ a {{ b() }} }}'), '{ { a { { b() } } } }', 'nested');
  assert.ok(!httpSafe('{{{{{{{{{{x()}}}}}}}}}}').includes('{{'), 'deeply nested');
  assert.equal(httpSafe('{"a":{"b":1}} and {{ok}}'), '{"a":{"b":1}} and {{ok}}', 'braces of a JSON body are not spans');
});

test('A hostile request has no expression and no environment variable in the file the tools read', () => {
  const text = block({
    url: "https://x.example/{{ require('child_process').execSync('calc') }}?k={{$processEnv KEY}}",
    headers: [kv('X-Env', '{{$processEnv AWS_SECRET_ACCESS_KEY}}'), kv('{{ evil() }}', 'v'), kv('X-Off', '{{ process.env.X }}', false)],
    query: [kv('q', '{{ (() => 1)() }}')],
    body: { kind: 'text', contentType: 'text/plain', text: 'a\n{{ exports.x = 1 }}\nb {{ unclosed' },
    docs: 'about {{ docs.expression() }}',
    captures: [{ expr: 'token = json $.a', enabled: true }]
  });
  assert.ok(!/\{\{[^}]*(?:require|processEnv|evil|process\.env|=>|exports|unclosed|docs\.expression)/.test(text), text);
  assert.ok(text.includes('{ { require('), 'the expression is still there, as text');
  assert.ok(!/\{\{\s*[^$A-Za-z_]/.test(text), 'every {{ that is left starts a name or a dynamic word');
});

test('The variables and the secrets that a mirror is made of stay as they are, and the same request gives the same text', () => {
  const text = block({ url: '{{base}}/items/{{$guid}}', headers: [kv('Authorization', 'Bearer literal-secret-token-9'), kv('X-Id', '{{$randomInt 1 9}}')] });
  assert.match(text, /POST \{\{base\}\}\/items\/\{\{\$guid\}\}\n/);
  assert.match(text, /Authorization: Bearer \{\{secret_shop_header_authorization\}\}\n/);
  assert.match(text, /X-Id: \{\{\$randomInt 1 9\}\}\n/);
  assert.ok(!text.includes('literal-secret-token-9'));
  assert.equal(block({ url: '{{base}}/items/{{$guid}}' }), block({ url: '{{base}}/items/{{$guid}}' }));
});

test('A file part whose path leaves the folder of the collection is not written, whatever the way it is said', () => {
  const part = (file: string, enabled = true) => ({ name: 'f', kind: 'file' as const, value: '', file, contentType: '', enabled });
  for (const path of ['/etc/passwd', 'C:/Users/victim/.aws/credentials', 'C:\\Users\\victim\\.aws\\credentials', '~/.ssh/id_rsa', '../../../../.git-credentials', 'a/../../b', '..\\..\\x', '\\\\server\\share\\x']) {
    const body: Body = { kind: 'multipart', parts: [part(path)] };
    const text = block({ body }, { depth: 1 });
    assert.ok(!/\n< /.test(text), `${path}: ${text}`);
    assert.match(text, /# \[the file part f is not written: its path leaves the folder of the collection\]/, path);
  }
  const inside: Body = { kind: 'multipart', parts: [part('files/ok.pdf'), part('./also/ok.txt')] };
  const text = block({ body: inside }, { depth: 2 });
  assert.match(text, /\n< \.\.\/\.\.\/files\/ok\.pdf\n/);
  assert.match(text, /\n< \.\.\/\.\.\/also\/ok\.txt\n/, 'a path inside the folder keeps working, said from the folder of the mirror');
});

test('A body that is a file is not written either, and the secrets of a form stay replaced', () => {
  assert.match(block({ body: { kind: 'binary', file: '../../etc/passwd' } }), /# \[the body is the file \.\.\/\.\.\/etc\/passwd: it is not written here\]/);
  assert.ok(!/\n< /.test(block({ body: { kind: 'binary', file: '../../etc/passwd' } })));
});
