import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newContainer, newRequest, type Body, type KV, type Request } from '../../src/core/model';
import type { Level } from '../../src/core/inherit';
import { classify, headerLine, mirrorFile, parseHeaderLine, splitFile } from '../../src/mirror/drift';
import { mirrorOf, type MirrorInput } from '../../src/mirror/generate';
import { textHash } from '../../src/util/hash';
import { parseHttp } from '../support/http-parser';

/** The `.http` file next to a request: what it says, that it holds no secret, and what to do when it and the request disagree. */

const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: '' });
const shop = { ...newContainer('C1', 'Shop'), baseUrl: 'https://api.example.com/v1', headers: [kv('Accept', 'application/json'), kv('X-Api-Key', 'abc-literal-key')], auth: { kind: 'bearer' as const, token: 'literal-token-9', prefix: 'Bearer' }, tests: [{ expr: 'status < 400', enabled: true }] };
const orders = { ...newContainer('C2', 'Orders'), headers: [kv('X-Team', 'orders')] };
const LEVELS: Level[] = [{ kind: 'collection', name: 'Shop', container: shop }, { kind: 'folder', name: 'Orders', container: orders }];
const request = (change: Partial<Request> = {}): Request => ({ ...newRequest('R1', 'Create order'), method: 'GET', url: '/orders', ...change });
const input = (change: Partial<Request> = {}, over: Partial<MirrorInput> = {}): MirrorInput => ({ request: request(change), levels: LEVELS, workspaceSettings: {}, file: 'create-order.req.yml', collection: 'Shop', depth: 0, ...over });
const block = (change: Partial<Request> = {}, over: Partial<MirrorInput> = {}): string => mirrorOf(input(change, over)).block;
const plain = (change: Partial<Request> = {}): string => block({ ...change }, { levels: [{ kind: 'collection', name: 'Shop', container: newContainer('C1', 'Shop') }] });

test('A request is written with what it inherits, its variables left as they are and its secrets replaced; the same request always gives the same text', () => {
  const full = request({
    method: 'post', url: '/orders/{orderId}/items', docs: 'Adds an item.\nSecond line.', pathParams: [kv('orderId', '{{orderId}}')],
    query: [kv('limit', '10'), kv('note', 'a b'), kv('apikey', 'qsecret123'), kv('off', 'x', false)], headers: [kv('X-Trace', '{{trace}}'), kv('X-Off', 'no', false)],
    body: { kind: 'json', text: '{\n  "sku": "A1",\n  "password": "hunter2hunter2"\n}' }, tests: [{ expr: 'status == 201', enabled: true }, { expr: 'nonsense', enabled: true }],
    captures: [{ expr: 'itemId = json $.id', enabled: true }], scripts: { pre: 'x();', post: '' }
  });
  const mirror = mirrorOf({ request: full, levels: LEVELS, workspaceSettings: {}, file: 'create-order.req.yml', collection: 'Shop', depth: 1 });
  assert.equal(mirror.block, [
    '### Create order', '# @name create_order', '# Adds an item.', '# Second line.', '# @assert status < 400', '# @assert status == 201', '# [test not written: nonsense]', '# @capture itemId = json $.id',
    '# [disabled] X-Off: no', '# [disabled query] off=x', '# [the scripts of this request are in the .req.yml: they are not written here]',
    '# [values of secrets are not written here: define secret_shop_header_x_api_key, secret_shop_bearer_token, secret_shop_query_apikey, secret_shop_body_password in your environment]',
    'POST https://api.example.com/v1/orders/{{orderId}}/items?limit=10&note=a%20b&apikey={{secret_shop_query_apikey}}',
    'Accept: application/json', 'X-Api-Key: {{secret_shop_header_x_api_key}}', 'X-Team: orders', 'X-Trace: {{trace}}', 'Content-Type: application/json', 'Authorization: Bearer {{secret_shop_bearer_token}}',
    '', '{', '  "sku": "A1",', '  "password": "{{secret_shop_body_password}}"', '}', ''
  ].join('\n'));
  assert.equal(mirror.hash, textHash(mirror.block));
  assert.deepEqual(mirrorOf({ request: full, levels: LEVELS, workspaceSettings: {}, file: 'create-order.req.yml', collection: 'Shop', depth: 1 }), mirror);
  for (const secret of ['abc-literal-key', 'literal-token-9', 'qsecret123', 'hunter2hunter2']) assert.ok(!mirrorFile('create-order.req.yml', mirror).includes(secret), `${secret} is not in the file`);

  // What the independent reader of .http files sees is the request.
  const parsed = parseHttp(mirror.block).requests[0];
  assert.equal(parsed?.method, 'POST');
  assert.equal(parsed?.url, 'https://api.example.com/v1/orders/{{orderId}}/items?limit=10&note=a%20b&apikey={{secret_shop_query_apikey}}');
  assert.deepEqual(parsed?.asserts, ['status < 400', 'status == 201']);
  assert.deepEqual(parsed?.captures, ['itemId = json $.id']);
  assert.equal(parsed?.body, '{\n  "sku": "A1",\n  "password": "{{secret_shop_body_password}}"\n}');
  assert.equal(parsed?.name, 'create_order');
  assert.deepEqual(parsed?.unknownDirectives, []);
});

test('A literal API key, and the secrets that stand in an XML or a text body, are not written either', () => {
  const bare = { levels: [{ kind: 'collection' as const, name: 'Shop', container: newContainer('C1', 'Shop') }] };
  const header = block({ auth: { kind: 'apikey', name: 'X-Key', value: 'literalapikey1', in: 'header' } }, bare);
  assert.match(header, /\nX-Key: \{\{secret_shop_apikey_x_key\}\}\n/);
  assert.ok(!header.includes('literalapikey1'));
  const query = block({ url: 'https://h.test/p', auth: { kind: 'apikey', name: 'key', value: 'literalapikey2', in: 'query' } }, bare);
  assert.match(query, /\nGET https:\/\/h\.test\/p\?key=\{\{secret_shop_apikey_key\}\}\n/);
  assert.ok(!query.includes('literalapikey2'));
  const xml = block({ method: 'POST', body: { kind: 'xml', text: '<login><user>ann</user><password>hunter2xyz</password></login>' } }, bare);
  assert.ok(!xml.includes('hunter2xyz'));
  assert.match(xml, /<password>\{\{secret_shop_body_password\}\}<\/password>/);
  assert.match(xml, /<user>ann<\/user>/, 'what is not a secret stays');
  const text = block({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'client_secret=hunter3xyz&grant=client' } }, bare);
  assert.ok(!text.includes('hunter3xyz'));
  assert.match(text, /client_secret=\{\{secret_shop_body_client_secret\}\}&grant=client/);
});

test('The address gets the base URL, the path parameters and the query exactly as a send would build them, without replacing a variable', () => {
  assert.match(plain({ url: '/a/b' }), /\nGET https:\/\/api\.example\.com\/a\/b\n|\nGET \/a\/b\n/);
  const withBase = block({ url: '/a', query: [kv('q', '{{term}}'), kv('x y', `${String.fromCodePoint(0xe9)}&=`)] });
  assert.match(withBase, /\nGET https:\/\/api\.example\.com\/v1\/a\?q=\{\{term\}\}&x%20y=%C3%A9%26%3D\n/);
  assert.match(block({ url: 'https://other.test/p?z=1', query: [kv('q', '2')] }), /\nGET https:\/\/other\.test\/p\?z=1&q=2\n/, 'an address that has a query gets the rest after it');
  assert.match(block({ url: '/users/{id}/files/{name}?v=1', pathParams: [kv('id', '12/3'), kv('name', '{{file}}')] }), /\nGET https:\/\/api\.example\.com\/v1\/users\/12%2F3\/files\/\{\{file\}\}\?v=1\n/);
  assert.match(block({ url: '/users/{id}', pathParams: [kv('other', '1')] }), /\/users\/\{id\}\n/, 'a name that is not given stays');
  assert.match(block({ url: 'https://h.test/a#frag' }), /\nGET https:\/\/h\.test\/a\n/, 'the fragment is not sent, so it is not written');
  assert.match(block({ url: 'https://h.test/a?p=%20&q=', query: [kv('r', '1')] }), /\?p=%20&q=&r=1\n/);
  assert.match(block({ url: '{{base}}/x' }), /\nGET \{\{base\}\}\/x\n/, 'a variable at the start is not given a base URL');
  assert.match(block({ url: '/a', query: [kv('', 'nameless'), kv('k', 'v', false)] }), /\nGET https:\/\/api\.example\.com\/v1\/a\n/, 'switched-off and nameless rows are not in the address');
  assert.match(block({ url: '/a', query: [kv('k', 'v', false)] }), /\n# \[disabled query\] k=v\n/);
});

test('A query is written without encoding when the settings say so, and the note names at most twenty secrets', () => {
  assert.match(plain({ url: '/a', query: [kv('x y', 'a b&c')], settings: { encodeUrl: false } }), /\nGET \/a\?x y=a b&c\n/);
  assert.match(plain({ url: '/a', query: [kv('x y', 'a b&c')], settings: { encodeUrl: true } }), /\nGET \/a\?x%20y=a%20b%26c\n/);
  const many = plain({ headers: Array.from({ length: 25 }, (_, index) => kv(`X-Key-${index}`, `literal-value-${index}`)) });
  assert.match(many, /# \[values of secrets are not written here: define secret_shop_header_x_key_0, [^\]]*secret_shop_header_x_key_19 and more in your environment\]/);
  assert.ok(!(many.split(String.fromCharCode(10)).find(line => line.startsWith('# [values of secrets')) ?? '').includes('secret_shop_header_x_key_20'), 'the twenty-first is not named in the note');
  for (let index = 0; index < 25; index++) assert.ok(!many.includes(`literal-value-${index}`));
});

test('A secret that is typed into a request or a collection is never written: it becomes a variable that a note names', () => {
  const text = plain({
    url: 'https://h.test/p?token=querysecret99&page=2', headers: [kv('Authorization', 'Bearer typedbearer77'), kv('Cookie', 'sid=cookievalue55'), kv('X-Plain', 'visible'), kv('X-Off-Key', 'offsecret88', false)],
    body: { kind: 'form', fields: [kv('client_secret', 'formsecret66'), kv('grant', 'client'), kv('password', 'offfield', false)] }
  });
  for (const secret of ['querysecret99', 'typedbearer77', 'cookievalue55', 'offsecret88', 'formsecret66', 'offfield']) assert.ok(!text.includes(secret), `${secret} is not written`);
  assert.match(text, /token=\{\{secret_shop_query_token\}\}&page=2/);
  assert.match(text, /\nAuthorization: Bearer \{\{secret_shop_header_authorization\}\}\n/);
  assert.match(text, /\nX-Plain: visible\n/);
  assert.match(text, /# \[values of secrets are not written here: define secret_shop_header_authorization, /);
  assert.match(text, /client_secret=%7B%7Bsecret_shop_form_client_secret%7D%7D|client_secret=\{\{secret_shop_form_client_secret\}\}/);
  assert.match(text, /\n# \[disabled\] X-Off-Key: \{\{secret_shop_header_x_off_key\}\}\n/);
  const names = plain({ headers: [kv('Authorization', '{{token}}')] });
  assert.ok(!names.includes('values of secrets'), 'a variable is not a secret value: nothing to say');
  assert.match(names, /\nAuthorization: \{\{token\}\}\n/);
  assert.match(block({ headers: [kv('Authorization', 'Bearer abc12345')] }), /Authorization: Bearer \{\{secret_shop_header_authorization\}\}\n(?!Authorization)/, 'with its own Authorization header the authentication is not added a second time');
});

test('The authentication is written the way the tools read it, and what a .http file cannot say is one line', () => {
  const bare = { levels: [{ kind: 'collection' as const, name: 'Shop', container: newContainer('C1', 'Shop') }] };
  assert.match(block({ auth: { kind: 'bearer', token: '{{t}}', prefix: 'Bearer' } }, bare), /\nAuthorization: Bearer \{\{t\}\}\n/);
  assert.match(block({ auth: { kind: 'bearer', token: '{{t}}', prefix: 'Token' } }, bare), /\nAuthorization: Token \{\{t\}\}\n/);
  assert.match(block({ auth: { kind: 'basic', username: '{{u}}', password: '{{p}}' } }, bare), /\nAuthorization: Basic \{\{u\}\} \{\{p\}\}\n/);
  assert.match(block({ auth: { kind: 'basic', username: 'ann', password: 'literalpass1' } }, bare), /\nAuthorization: Basic ann \{\{secret_shop_basic_password\}\}\n/);
  assert.match(block({ auth: { kind: 'apikey', name: 'X-Key', value: '{{k}}', in: 'header' } }, bare), /\nX-Key: \{\{k\}\}\n/);
  assert.match(block({ url: 'https://h.test/p', auth: { kind: 'apikey', name: 'api key', value: '{{k}}', in: 'query' } }, bare), /\nGET https:\/\/h\.test\/p\?api%20key=\{\{k\}\}\n/);
  assert.match(block({ auth: { kind: 'apikey', name: '', value: 'x', in: 'header' } }, bare), /\nGET \/orders\n\n?$/, 'an API key with no name is nothing');
  assert.match(block({ auth: { kind: 'oauth2', grant: 'client_credentials', pkce: false, authUrl: '', tokenUrl: 'https://auth.test/t', clientId: 'c', clientSecret: 'topsecret1', scope: '', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [] } }, bare), /\n# \[auth OAuth 2\.0 is in the \.req\.yml/);
  assert.ok(!block({ auth: { kind: 'oauth2', grant: 'client_credentials', pkce: false, authUrl: '', tokenUrl: '', clientId: 'c', clientSecret: 'topsecret1', scope: '', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [] } }, bare).includes('topsecret1'));
  assert.ok(!block({ auth: { kind: 'none' } }, { levels: LEVELS }).includes('Authorization'), 'none stops what the collection gives');
  assert.ok(!plain({ auth: { kind: 'inherit' } }).includes('Authorization'));
});

test('Each kind of body is written as the tools read it, with the content type that a send would add', () => {
  const bodyOf = (body: Body, over: Partial<MirrorInput> = {}): string => plain({ method: 'POST', body, ...over.request });
  assert.match(bodyOf({ kind: 'json', text: '{"a":1}' }), /\nContent-Type: application\/json\n\n\{"a":1\}\n$/);
  assert.match(bodyOf({ kind: 'xml', text: '<a/>' }), /\nContent-Type: application\/xml\n\n<a\/>\n$/);
  assert.match(bodyOf({ kind: 'text', contentType: 'text/csv', text: 'a,b' }), /\nContent-Type: text\/csv\n\na,b\n$/);
  assert.match(bodyOf({ kind: 'text', contentType: '', text: 'plain' }), /\nContent-Type: text\/plain\n/);
  assert.match(bodyOf({ kind: 'form', fields: [kv('a', '1 2'), kv('b', '{{v}}'), kv('c', 'x', false)] }), /\nContent-Type: application\/x-www-form-urlencoded\n\na=1%202&b=\{\{v\}\}\n/);
  assert.match(bodyOf({ kind: 'form', fields: [kv('c', 'x', false)] }), /# \[disabled form field\] c=x\n/);
  assert.match(bodyOf({ kind: 'graphql', query: '{ pets { id } }', variables: '{"n":1}' }), /\nContent-Type: application\/json\n\n\{\n  "query": "\{ pets \{ id \} \}",\n  "variables": \{\n    "n": 1\n  \}\n\}\n$/);
  assert.match(bodyOf({ kind: 'binary', file: 'data/x.bin' }), /\n# \[the body is the file data\/x\.bin: it is not written here\]\n/);
  assert.ok(!bodyOf({ kind: 'none' }).includes('Content-Type'));
  const custom = block({ method: 'POST', headers: [kv('content-type', 'application/vnd.api+json')], body: { kind: 'json', text: '{}' } }, { levels: [{ kind: 'collection', name: 'Shop', container: newContainer('C1', 'Shop') }] });
  assert.equal(custom.match(/Content-Type/gi)?.length, 1, 'a content type the request has is kept, and not repeated');
  assert.match(custom, /\ncontent-type: application\/vnd\.api\+json\n/);
});

test('A multipart body names its files from the folder of the mirror, and the boundary is the one of the importer', () => {
  const body: Body = { kind: 'multipart', parts: [{ name: 'note', kind: 'text', value: 'hi', file: '', contentType: '', enabled: true }, { name: 'doc', kind: 'file', value: '', file: 'files/a.pdf', contentType: '', enabled: true }, { name: 'off', kind: 'text', value: 'x', file: '', contentType: '', enabled: false }] };
  const deep = block({ method: 'POST', body }, { depth: 2, levels: [{ kind: 'collection', name: 'Shop', container: newContainer('C1', 'Shop') }] });
  assert.match(deep, /\nContent-Type: multipart\/form-data; boundary=----ApiClientImport\n/);
  assert.match(deep, /filename="a\.pdf"\nContent-Type: application\/octet-stream\n\n< \.\.\/\.\.\/files\/a\.pdf\n/);
  assert.match(deep, /name="note"\n\nhi\n/);
  assert.match(deep, /# \[disabled form field\] off=x\n/);
  assert.match(block({ method: 'POST', body }, { depth: 0 }), /\n< \.\/files\/a\.pdf\n/);
  const absolute: Body = { kind: 'multipart', parts: [{ name: 'doc', kind: 'file', value: '', file: '/abs/a.pdf', contentType: '', enabled: true }] };
  assert.match(block({ method: 'POST', body: absolute }, { depth: 3 }), /\n< \/abs\/a\.pdf\n/);
  const existing = block({ method: 'POST', headers: [kv('Content-Type', 'multipart/form-data')], body }, { depth: 0 });
  assert.equal(existing.match(/Content-Type: multipart/g)?.length, 1, 'the content type of a multipart body is the one with the boundary');
});

test('A body that a .http tool would read as something else is left out, with a note, instead of being written', () => {
  const text = plain({ method: 'POST', body: { kind: 'text', contentType: 'text/plain', text: 'line\n### not a new request\n< /etc/passwd' } });
  assert.ok(!text.includes('/etc/passwd') && !text.includes('### not a new request'));
  assert.match(text, /# \[the body is not written here: a line of it would be read as something else/);
  assert.equal(parseHttp(text).requests.length, 1, 'still one request');
  assert.ok(!/\nContent-Type: text\/plain\n/.test(text), 'and no content type for a body that is not there');
});

test('The tests and captures are written in the grammar, a line that is not in it is said not to be written, and a name cannot add a line to the file', () => {
  const text = plain({ tests: [{ expr: 'json $.items count >= 1', enabled: true }, { expr: 'status == 200\n# @assert injected', enabled: true }, { expr: 'bad line', enabled: true }, { expr: 'status == 500', enabled: false }], captures: [{ expr: 'global: rate = header x-rate', enabled: true }, { expr: 'broken', enabled: true }, { expr: 'x = body', enabled: false }, { expr: '   ', enabled: true }] });
  assert.match(text, /\n# @assert json \$\.items count >= 1\n/);
  assert.ok(!text.includes('\n# @assert injected'), 'a line break cannot start a directive');
  assert.match(text, /\n# \[test not written: bad line\]\n/);
  assert.ok(!text.includes('status == 500'));
  assert.match(text, /\n# @capture global: rate = header x-rate\n/);
  assert.match(text, /\n# \[capture not written: broken\]\n/);
  assert.ok(!text.includes('x = body'));
  const hostile = plain({ name: 'Evil\n### second request\nGET http://evil.test', docs: '@name injected\n###\nGET http://evil.test/docs' });
  const parsed = parseHttp(hostile);
  assert.equal(parsed.requests.length, 1, 'a name or a note cannot start another request');
  assert.equal(parsed.requests[0]?.method, 'GET');
  assert.ok(!hostile.includes('\nGET http://evil'), 'and cannot put a request line in the file');
  assert.equal(parsed.requests[0]?.name, 'create_order', 'nor a directive');
});

test('The name of the request in the file is a plain identifier made from the file name', () => {
  assert.match(block({}, { file: 'Create Order!.req.yml' }), /\n# @name Create_Order\n/);
  assert.match(block({}, { file: `${String.fromCodePoint(0xfc)}n${String.fromCodePoint(0xef)}code-name.req.yaml` }), /\n# @name unicode_name\n/);
  assert.match(block({}, { file: '.req.yml' }), /\n# @name request\n/);
});

// ---- the header, and what to do when the file and the request disagree ----

test('The first line says what the file is and carries the fingerprint of the rest, and only that exact line is read back', () => {
  const mirror = mirrorOf(input());
  const file = mirrorFile('create-order.req.yml', mirror);
  assert.equal(file.split('\n')[0], `# api-client generated v1 src=create-order.req.yml h=${mirror.hash} -- edit the .req.yml, not this file`);
  assert.deepEqual(parseHeaderLine(file.split('\n')[0] as string), { source: 'create-order.req.yml', hash: mirror.hash });
  assert.equal(headerLine('a b.req.yml', '0123456789abcd'), '# api-client generated v1 src=a_b.req.yml h=0123456789abcd -- edit the .req.yml, not this file');
  for (const bad of ['', '# api-client generated v1', '#api-client generated v1 src=a h=0123456789abcd -- edit the .req.yml, not this file', '# api-client generated v1 src=a h=0123456789abc -- edit the .req.yml, not this file', '# api-client generated v1 src=a h=0123456789ABCD -- edit the .req.yml, not this file',
    '# api-client generated v1 src=a h=0123456789abcd -- edit the .req.yml, not this file ', ' # api-client generated v1 src=a h=0123456789abcd -- edit the .req.yml, not this file', '# api-client generated v2 src=a h=0123456789abcd -- edit the .req.yml, not this file', '### Request']) {
    assert.equal(parseHeaderLine(bad), undefined, JSON.stringify(bad));
  }
  const split = splitFile(file);
  assert.deepEqual([split.header?.hash, split.block], [mirror.hash, mirror.block]);
  assert.deepEqual(splitFile('### x\nGET /\n'), { header: undefined, block: '### x\nGET /\n' });
  assert.deepEqual(splitFile(headerLine('a.req.yml', mirror.hash)), { header: { source: 'a.req.yml', hash: mirror.hash }, block: '' });
  assert.equal(splitFile(file.replace(/\n/g, '\r\n')).block, mirror.block, 'a checkout with Windows line ends is not a change');
});

test('The fingerprint depends on every character and on nothing else', () => {
  assert.equal(textHash('abc'), textHash('abc'));
  assert.match(textHash(''), /^[0-9a-f]{14}$/);
  const seen = new Set<string>();
  for (const text of ['a', 'b', 'ab', 'ba', 'a ', ' a', 'a\n', 'A', String.fromCodePoint(0xe9), `e${String.fromCodePoint(0x301)}`, '', 'aa', 'aaa']) seen.add(textHash(text));
  assert.equal(seen.size, 13, 'no two of these texts share a fingerprint');
  assert.notEqual(textHash('x'.repeat(1000)), textHash(`${'x'.repeat(999)}y`));
  assert.notEqual(textHash(`${'x'.repeat(500)}y${'x'.repeat(499)}`), textHash(`${'x'.repeat(499)}y${'x'.repeat(500)}`));
});

test('Six cases, and a file that somebody changed is never the one that is written over', () => {
  const now = mirrorOf(input());
  const older = mirrorOf(input({ url: '/orders/old' }));
  const file = (mirror: typeof now, edit?: (block: string) => string): string => `${headerLine('create-order.req.yml', mirror.hash)}\n${edit === undefined ? mirror.block : edit(mirror.block)}`;
  assert.equal(classify(undefined, now), 'missing');
  assert.equal(classify('### mine\nGET http://x\n', now), 'foreign', 'a file with no header is the own file of the person');
  assert.equal(classify('', now), 'foreign');
  assert.equal(classify(file(now), now), 'in-sync');
  assert.equal(classify(file(older), now), 'regenerate', 'the request changed and nobody touched the file');
  assert.equal(classify(file(now, block => block.replace('GET', 'POST')), now), 'edited', 'somebody changed the file, the request did not');
  assert.equal(classify(file(older, block => block.replace('GET', 'POST')), now), 'both');
  const stale = `${headerLine('create-order.req.yml', older.hash)}\n${now.block}`;
  assert.equal(classify(stale, now), 'stale-header', 'the block is what the request gives now: only the header is old');
  assert.equal(classify(file(now).replace(/\n/g, '\r\n'), now), 'in-sync');
  assert.equal(classify(file(older).replace(/\n/g, '\r\n'), now), 'regenerate');
  assert.equal(classify(file(now, block => `${block}# my note\n`), now), 'edited');
  assert.equal(classify(file(now, block => block.trimEnd()), now), 'edited', 'even a removed final line break is an edit');
  // A header that says it is generated but is for text that is not the block below it counts as a change by hand.
  assert.equal(classify(`${headerLine('create-order.req.yml', '0123456789abcd')}\n${now.block}`, now), 'stale-header');
  assert.equal(classify(`${headerLine('create-order.req.yml', '0123456789abcd')}\nGET http://other\n`, now), 'both');
});
