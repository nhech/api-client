import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Level } from '../../src/core/inherit';
import { newContainer, newRequest, type KV, type Request } from '../../src/core/model';
import { parseHttp } from '../../src/format/http/parse';
import { mirrorOf } from '../../src/mirror/generate';
import { applyEdits } from '../../src/mirror/import';

/** What a person changes in the `.http` file is taken back into the request, and only that: the rest of the request, its secrets included, stays as it is. */

const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: '' });
const shop = { ...newContainer('C1', 'Shop'), baseUrl: 'https://api.example.com/v1', headers: [kv('Accept', 'application/json'), kv('X-Team', 'shop')], tests: [{ expr: 'status < 400', enabled: true }] };
const LEVELS: Level[] = [{ kind: 'collection', name: 'Shop', container: shop }];
const make = (change: Partial<Request> = {}): Request => ({
  ...newRequest('R1', 'Create order'), method: 'POST', url: '/orders', query: [kv('limit', '10'), kv('key', 'secretvalue1')],
  headers: [kv('X-Trace', '{{trace}}'), kv('X-Token', 'headersecret1')], body: { kind: 'json', text: '{\n  "sku": "A1",\n  "password": "hunter2hunter2"\n}' },
  tests: [{ expr: 'status == 201', enabled: true }], captures: [{ expr: 'id = json $.id', enabled: true }], ...change
});
const mirrorFor = (request: Request) => mirrorOf({ request, levels: LEVELS, workspaceSettings: {}, file: 'create-order.req.yml', collection: 'Shop', depth: 0 });
const edit = (request: Request, change: (block: string) => string) => {
  const before = mirrorFor(request);
  const edited = change(before.block);
  return { before, edited, ...applyEdits({ request, levels: LEVELS, before, edited }) };
};
/** What a file says, without the order of its headers and of the pairs of its query. */
function semantic(block: string): unknown {
  const parsed = parseHttp(block).requests[0];
  const [path = '', query = ''] = (parsed?.url ?? '').split('?');
  return {
    method: parsed?.method, path, query: query.split('&').sort(), headers: (parsed?.headers ?? []).map(([name, value]) => `${name.toLowerCase()}: ${value}`).sort(),
    body: parsed?.body, asserts: [...(parsed?.asserts ?? [])].sort(), captures: [...(parsed?.captures ?? [])].sort()
  };
}

/** The edits were all taken when the request that comes out gives back the file that was edited. */
const roundTrips = (request: Request, change: (block: string) => string): ReturnType<typeof edit> => {
  const done = edit(request, change);
  assert.deepEqual(done.lost, [], 'nothing was lost');
  assert.deepEqual(semantic(mirrorFor(done.request).block), semantic(done.edited), 'the request gives the edited file back');
  return done;
};

test('Nothing changed, nothing taken', () => {
  const done = edit(make(), block => block);
  assert.deepEqual([done.changes, done.lost], [[], []]);
  assert.deepEqual(done.request, make());
});

test('A new method is taken', () => {
  const done = roundTrips(make(), block => block.replace('\nPOST ', '\nPUT '));
  assert.equal(done.request.method, 'PUT');
  assert.deepEqual(done.changes, ['Method: POST to PUT']);
  assert.deepEqual(edit(make(), block => block.replace('\nPOST ', '\nlower ')).request.method, 'LOWER', 'a method is kept in capitals');
  assert.match(edit(make(), block => block.replace('\nPOST ', '\nNOT-A-METHOD ')).lost[0] ?? '', /is not one/);
});

test('A new address is taken without its base URL, and the query pair by pair, so that a secret that the file does not hold stays', () => {
  const path = roundTrips(make(), block => block.replace('/v1/orders?', '/v1/orders/all?'));
  assert.equal(path.request.url, '/orders/all');
  assert.deepEqual(path.request.query, make().query, 'the query was not touched');
  assert.equal(path.request.query[1]?.value, 'secretvalue1', 'the secret is still in the request');
  const host = roundTrips(make(), block => block.replace('https://api.example.com/v1/orders?', 'https://other.test/x?'));
  assert.equal(host.request.url, 'https://other.test/x');
  const removed = roundTrips(make(), block => block.replace('?limit=10&', '?'));
  assert.deepEqual(removed.request.query.map(row => row.name), ['key']);
  assert.deepEqual(removed.changes, ['Query parameter removed: limit']);
  const added = roundTrips(make(), block => block.replace('?limit=10&', '?limit=10&sort=a%20b&'));
  assert.deepEqual(added.request.query.map(row => [row.name, row.value]), [['limit', '10'], ['key', 'secretvalue1'], ['sort', 'a b']]);
  const changed = roundTrips(make(), block => block.replace('limit=10', 'limit=25'));
  assert.deepEqual(changed.request.query.map(row => [row.name, row.value]), [['limit', '25'], ['key', 'secretvalue1']], 'the new value stands where the old one was');
  assert.deepEqual(changed.changes, ['Query parameter removed: limit', 'Query parameter added: limit']);
  const own = edit(make({ url: 'https://h.test/p?z=1' }), block => block.replace('/p?z=1', '/q?z=1'));
  assert.equal(own.request.url, 'https://h.test/q?z=1', 'a query written in the address stays with it');
});

test('A header is taken by name: a new one is added, one of its own is changed or removed, and an inherited one is overridden or switched off', () => {
  const added = roundTrips(make(), block => block.replace('\nContent-Type:', '\nX-New: 1\nContent-Type:'));
  assert.deepEqual(added.request.headers.map(row => [row.name, row.value, row.enabled]), [['X-Trace', '{{trace}}', true], ['X-Token', 'headersecret1', true], ['X-New', '1', true]]);
  const inPlace = roundTrips(make(), block => block.replace('X-Trace: {{trace}}', 'X-Trace: other'));
  assert.deepEqual(inPlace.request.headers.map(row => row.name), ['X-Trace', 'X-Token'], 'a changed header keeps its place');
  const changedOwn = roundTrips(make(), block => block.replace('X-Trace: {{trace}}', 'X-Trace: other'));
  assert.equal(changedOwn.request.headers.find(row => row.name === 'X-Trace')?.value, 'other');
  assert.equal(changedOwn.request.headers.find(row => row.name === 'X-Token')?.value, 'headersecret1', 'the secret header was not touched');
  const removedOwn = roundTrips(make(), block => block.replace('X-Trace: {{trace}}\n', ''));
  assert.deepEqual(removedOwn.request.headers.map(row => row.name), ['X-Token']);
  const overridden = roundTrips(make(), block => block.replace('X-Team: shop', 'X-Team: orders'));
  assert.deepEqual(overridden.request.headers.filter(row => row.name === 'X-Team').map(row => [row.value, row.enabled]), [['orders', true]], 'the request now has its own, which beats the inherited one');
  const switchedOff = roundTrips(make(), block => block.replace('X-Team: shop\n', ''));
  assert.deepEqual(switchedOff.request.headers.filter(row => row.name === 'X-Team').map(row => [row.value, row.enabled]), [['', false]], 'a switched-off row stops the inherited header');
  assert.deepEqual(switchedOff.changes, ['Header X-Team: removed']);
  const caseChange = edit(make(), block => block.replace('X-Trace: {{trace}}', 'x-trace: {{trace}}'));
  assert.deepEqual(caseChange.changes, [], 'the case of a name is not a change');
});

test('A body is taken: the text of a text body, a new one, none, and a form; the secrets that the file does not hold stay', () => {
  const text = roundTrips(make(), block => block.replace('"sku": "A1"', '"sku": "B2"'));
  assert.equal(text.request.body.kind === 'json' ? text.request.body.text : '', '{\n  "sku": "B2",\n  "password": "hunter2hunter2"\n}', 'the password was put back');
  const none = edit(make(), block => block.slice(0, block.indexOf('\n\n{')).replace('Content-Type: application/json\n', '') + '\n');
  assert.deepEqual(none.request.body, { kind: 'none' });
  const fresh = edit(make({ body: { kind: 'none' }, method: 'POST' }), block => `${block.trimEnd()}\nContent-Type: application/vnd.api+json\n\n{"a":1}\n`);
  assert.deepEqual(fresh.request.body, { kind: 'json', text: '{"a":1}' });
  const xml = edit(make({ body: { kind: 'none' } }), block => `${block.trimEnd()}\nContent-Type: text/xml\n\n<a/>\n`);
  assert.deepEqual(xml.request.body, { kind: 'xml', text: '<a/>' });
  const plain = edit(make({ body: { kind: 'none' } }), block => `${block.trimEnd()}\n\nhello\n`);
  assert.deepEqual(plain.request.body, { kind: 'text', contentType: 'text/plain', text: 'hello' });
  const form = roundTrips(make({ body: { kind: 'form', fields: [kv('a', '1'), kv('off', 'x', false)] } }), block => block.replace('a=1', 'a=2&b=x%20y'));
  assert.deepEqual(form.request.body.kind === 'form' ? form.request.body.fields.map(field => [field.name, field.value, field.enabled]) : [], [['a', '2', true], ['b', 'x y', true], ['off', 'x', false]]);
  const multipart = edit(make({ body: { kind: 'multipart', parts: [{ name: 'p', kind: 'text', value: 'v', file: '', contentType: '', enabled: true }] } }), block => block.replace('\nv\n', '\nchanged\n'));
  assert.deepEqual([multipart.request.body.kind, multipart.lost.length], ['multipart', 1], 'the body of a multipart request is not rewritten from text');
  assert.match(multipart.lost[0] ?? '', /multipart form: change it in the request/);
  const file = edit(make(), block => block.replace(/\n\n\{[\s\S]*$/, '\n\n< ./data.json\n'));
  assert.deepEqual(file.request.body, make().body);
  assert.match(file.lost[0] ?? '', /read from a file/);
});

test('A test or a capture is taken when it is added or removed; one that comes from the collection cannot be removed here', () => {
  const added = roundTrips(make(), block => block.replace('# @capture', '# @assert duration < 500\n# @capture'));
  assert.deepEqual(added.request.tests.map(test => test.expr), ['status == 201', 'duration < 500']);
  const removed = roundTrips(make(), block => block.replace('# @assert status == 201\n', ''));
  assert.deepEqual(removed.request.tests, []);
  const inherited = edit(make(), block => block.replace('# @assert status < 400\n', ''));
  assert.deepEqual(inherited.request.tests, make().tests, 'the request keeps what it has');
  assert.match(inherited.lost[0] ?? '', /from a collection or a folder/);
  const capture = roundTrips(make(), block => block.replace('# @capture id = json $.id', '# @capture id = json $.id\n# @capture total = json $.total'));
  assert.deepEqual(capture.request.captures.map(item => item.expr), ['id = json $.id', 'total = json $.total']);
  const captureRemoved = roundTrips(make(), block => block.replace('# @capture id = json $.id\n', ''));
  assert.deepEqual(captureRemoved.request.captures, []);
});

test('What a file cannot say is named instead of being taken, and a file with no request says so', () => {
  const title = edit(make(), block => block.replace('### Create order', '### Renamed'));
  assert.deepEqual(title.request, make());
  assert.deepEqual(title.lost, ['the title (rename the request in the side bar)']);
  const comments = edit(make({ docs: 'About it.' }), block => block.replace('# About it.', '# About it, changed.'));
  assert.deepEqual(comments.lost, ['changes to the comments']);
  const notNote = edit(make({ docs: 'About it.' }), block => block.replace(/# \[values of secrets[^\n]*\n/, ''));
  assert.ok(mirrorFor(make({ docs: 'About it.' })).block.includes('# [values of secrets'), 'the line that is taken out is there to begin with');
  assert.deepEqual(notNote.lost, [], 'a line that the program wrote about itself is not a comment of the person');
  const empty = edit(make(), () => '# nothing here\n');
  assert.deepEqual(empty.lost, ['there is no request in the file to take edits out of']);
  assert.deepEqual(empty.request, make());
});

test('Several edits at once are taken together, and what is taken is what the file says', () => {
  const done = roundTrips(make(), block => block.replace('\nPOST ', '\nPATCH ').replace('/v1/orders?', '/v1/orders/7?').replace('X-Trace: {{trace}}', 'X-Trace: 9').replace('"sku": "A1"', '"sku": "C3"').replace('# @assert status == 201', '# @assert status == 200'));
  assert.equal(done.request.method, 'PATCH');
  assert.equal(done.request.url, '/orders/7');
  assert.deepEqual(done.request.tests.map(test => test.expr), ['status == 200']);
  assert.equal(done.changes.length, 6);
  const parsed = parseHttp(done.edited).requests[0];
  assert.equal(parsed?.method, 'PATCH');
});
