import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContainer, readRequest, writeContainer, writeRequest } from '../../src/format/schema';
import { Credentials, protectCollection } from '../../src/importers/credentials';
import { thunderToImported } from '../../src/importers/thunder';
import { blankFolder, blankRequest, countImported, type Imported, type ImportedFolder } from '../../src/importers/types';
import { splitUrl } from '../../src/importers/url';
import { buildTree } from '../../src/normalize/build';
import type { Request } from '../../src/core/model';
import { CANARIES, CASES } from '../fixtures/cases';
import { file, source, v4 } from '../support/source';

/** What the Thunder Client reader finds becomes the model of the client: folders stay folders, what they set stays on them, credentials move out of the files. */

const fixture = (id: string): Imported => {
  const found = CASES.find(item => item.id === id);
  assert.ok(found, id);
  return thunderToImported(buildTree(found.build()));
};
const everyRequest = (folder: ImportedFolder): Request[] => [...folder.requests, ...folder.folders.flatMap(everyRequest)];
const everyFolder = (folder: ImportedFolder): ImportedFolder[] => [folder, ...folder.folders.flatMap(everyFolder)];
const named = (imported: Imported, name: string): Request => {
  const found = imported.collections.flatMap(everyRequest).find(request => request.name === name);
  assert.ok(found, name);
  return found;
};
const kv = (name: string, value: string, enabled = true) => ({ name, value, enabled, description: '' });

test('Folders stay folders, and what a folder sets stays on it', () => {
  const imported = fixture('f13-inheritance');
  const [shop] = imported.collections;
  assert.equal(shop?.container.name, 'Shop');
  assert.equal(shop?.container.baseUrl, 'https://root.example');
  assert.deepEqual(shop?.container.headers, [kv('Accept', 'application/json'), kv('X-Tenant', 'default')]);
  assert.deepEqual(shop?.container.auth, { kind: 'bearer', token: '{{root_token}}', prefix: 'Bearer' });
  assert.deepEqual(shop?.container.tests, [{ expr: 'status == 200', enabled: true }]);
  assert.deepEqual(shop?.requests.map(request => request.name), ['at root']);
  const a = shop?.folders[0];
  assert.equal(a?.container.name, 'A');
  assert.equal(a?.container.baseUrl, 'https://a.example');
  assert.deepEqual(a?.container.headers, [kv('X-Tenant', 'acme'), kv('X-Off', 'no', false)], 'a header that is switched off stays switched off');
  assert.deepEqual(a?.container.auth, { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' });
  const b = a?.folders[0];
  assert.deepEqual([b?.container.name, b?.container.baseUrl, b?.container.auth], ['B', 'https://b.example/v2', { kind: 'inherit' }]);
  assert.deepEqual(b?.container.tests.map(test => test.expr), ['status == 201', 'duration < 800']);
  // The request keeps only its own: the headers, the address and the authentication of the folders are not copied into it.
  const relative = named(imported, 'relative');
  assert.deepEqual([relative.url, relative.headers, relative.auth], ['/items', [], { kind: 'inherit' }]);
  assert.deepEqual(named(imported, 'own header wins').headers, [kv('X-TENANT', 'mine')]);
  assert.deepEqual(named(imported, 'own header wins').auth, { kind: 'basic', username: 'u', password: '{{pw}}' });
  assert.deepEqual(named(imported, 'own auth none').auth, { kind: 'none' });
  assert.equal(named(imported, 'absolute').url, 'https://other.example/x');
  assert.deepEqual(countImported(imported), { collections: 1, folders: 2, requests: 7, environments: 0 });
});

test('A collection of the older layout and an environment come across', () => {
  const imported = fixture('f02-v3');
  assert.equal(imported.collections.length >= 1, true);
  const shop = imported.collections.find(collection => collection.container.name === 'Shop');
  assert.equal(shop?.container.baseUrl, 'https://v3.example');
  assert.deepEqual(shop?.folders.map(folder => [folder.container.name, folder.requests.map(request => [request.name, request.method])]), [['Admin', [['create', 'POST']]]]);
  assert.deepEqual(shop?.requests.map(request => request.name), ['list']);
  assert.deepEqual(imported.environments, [{ name: 'dev', vars: [{ name: 'host', value: 'dev.example', secret: false, enabled: true }] }]);
});

test('The parameters: the query of the address becomes rows, a missing one is added, a disabled one stays off, a path one is a path parameter', () => {
  const imported = thunderToImported(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('P', [], [
    { _id: 'r1', colId: 'c', containerId: '', name: 'Params', method: 'get', url: 'https://x.test/a/:id?page=2&q=a%20b', params: [
      { name: 'page', value: '2' }, { name: 'q', value: 'a b' }, { name: 'extra', value: 'only in the list' }, { name: 'off', value: 'x', isDisabled: true }, { name: 'id', value: '42', isPath: true }, { name: '', value: 'nameless' }
    ], headers: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'Thunder Client (https://www.thunderclient.com)' }, { name: 'X-Mine', value: '1' }, { name: 'Accept', value: '*/*', isDisabled: true }] }
  ])))));
  const [request] = imported.collections[0]?.requests ?? [];
  assert.equal(request?.method, 'GET');
  assert.equal(request?.url, 'https://x.test/a/:id');
  assert.deepEqual(request?.query, [kv('page', '2'), kv('q', 'a b'), kv('extra', 'only in the list'), kv('off', 'x', false)]);
  assert.deepEqual(request?.pathParams, [kv('id', '42')]);
  assert.deepEqual(request?.headers, [kv('X-Mine', '1'), kv('Accept', '*/*', false)], 'the headers that Thunder adds by itself are not the author\'s; a switched-off one is kept');
});

test('The authentication kinds', () => {
  const imported = thunderToImported(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [], [
    { _id: 'r1', colId: 'c', containerId: '', name: 'bearer', url: '/', auth: { type: 'bearer', bearer: 'Bearer {{t}}' } },
    { _id: 'r2', colId: 'c', containerId: '', name: 'basic', url: '/', auth: { type: 'basic', basic: { username: '{{u}}', password: '{{p}}' } } },
    { _id: 'r3', colId: 'c', containerId: '', name: 'none', url: '/', auth: { type: 'none' } },
    { _id: 'r4', colId: 'c', containerId: '', name: 'inherit', url: '/', auth: { type: 'inherit' } },
    { _id: 'r5', colId: 'c', containerId: '', name: 'absent', url: '/' },
    { _id: 'r6', colId: 'c', containerId: '', name: 'empty bearer', url: '/', auth: { type: 'bearer', bearer: '' } },
    { _id: 'r7', colId: 'c', containerId: '', name: 'oauth', url: '/', auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials' } } }
  ])))));
  const auth = Object.fromEntries((imported.collections[0]?.requests ?? []).map(request => [request.name, request.auth]));
  assert.deepEqual(auth['bearer'], { kind: 'bearer', token: '{{t}}', prefix: 'Bearer' });
  assert.deepEqual(auth['basic'], { kind: 'basic', username: '{{u}}', password: '{{p}}' });
  assert.deepEqual(auth['none'], { kind: 'none' });
  for (const name of ['inherit', 'absent', 'empty bearer', 'oauth']) assert.deepEqual(auth[name], { kind: 'inherit' }, name);
  assert.ok(imported.notes.some(note => note.where === 'A / oauth' && /oauth2 not imported; settings: grantType: it was left to be inherited/.test(note.message)));
});

test('Tests and captures are lines of the grammar of the client', () => {
  const imported = thunderToImported(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('T', [], [
    { _id: 'r1', colId: 'c', containerId: '', name: 'Tests', url: '/', tests: [
      { type: 'res-code', custom: '', action: 'equal', value: '200' },
      { type: 'res-time', custom: '', action: '<', value: '500' },
      { type: 'res-body', custom: '', action: 'contains', value: 'ok' },
      { type: 'Content-Type', custom: '', action: 'contains', value: 'json' },
      { type: 'json-query', custom: 'json.data.id', action: 'equal', value: '{{id}}' },
      { type: 'json-query', custom: 'json.items', action: 'count', value: '3' },
      { type: 'set-env-var', custom: 'json.token', action: 'setto', value: '{{access}}' },
      { type: 'set-env-var', custom: 'header.x-id', action: 'setto', value: '{{rid, local}}' },
      { type: 'res-body', custom: '', action: 'schema', value: '{}' }
    ] }
  ])))));
  const [request] = imported.collections[0]?.requests ?? [];
  assert.deepEqual(request?.tests.map(test => test.expr), ['status == 200', 'duration < 500', 'body includes ok', 'header Content-Type includes json', 'json $.data.id == {{id}}', 'json $.items count == 3']);
  assert.deepEqual(request?.captures.map(capture => capture.expr), ['access = json $.token', 'local:rid = header x-id']);
  assert.ok(imported.notes.some(note => /res-body \| schema test has no equivalent/.test(note.message)));
});

test('Scripts are kept as written, with a note', () => {
  const imported = fixture('f09-unsupported');
  assert.deepEqual(named(imported, 'script').scripts, { pre: 'tc.setVar("a", 1);', post: '// check\ntc.test("ok", () => {});' });
  assert.ok(imported.notes.some(note => /2 scripts were imported as written\. They use Thunder's tc API/.test(note.message)));
});

test('What cannot be sent from here is skipped and counted; what cannot be carried over is a note', () => {
  const imported = fixture('f09-unsupported');
  assert.equal(imported.skipped, 3, 'a WebSocket, a server-sent events and a gRPC request');
  assert.deepEqual(imported.collections[0]?.requests.map(request => request.name), ['aws', 'binary', 'digest', 'ntlm', 'oauth', 'schema test', 'script']);
  const messages = imported.notes.map(note => `${note.where}: ${note.message}`);
  assert.ok(messages.some(message => /Unsupported \/ events: A sse request cannot be sent from here and was skipped/.test(message)));
  assert.ok(messages.some(message => /Unsupported \/ aws: auth aws not imported/.test(message)));
  assert.equal(messages.filter(message => /binary/.test(message)).length, 1, 'a body that is not converted is said once');
  assert.deepEqual(named(imported, 'binary').body, { kind: 'none' });
});

test('Thunder\'s dynamic variables become the dynamic variables of the client where there is one', () => {
  const imported = fixture('f15-dynamic-rest-client');
  assert.equal(named(imported, 'ids').url, '{{base}}/ids/{{$guid}}');
  assert.equal(named(imported, 'numbers').url, '{{base}}/n/{{$randomInt 1 1000000}}/{{$randomInt 1 6}}/{{$randomInt 5 1000000}}/{{$randomInt 1 1000000}}', 'the range of Thunder, with its own limits');
  assert.equal(named(imported, 'time').url, '{{base}}/t/{{$isoTimestamp}}/{{#date}}', 'the time in milliseconds has no equivalent: the client counts seconds');
  assert.equal(named(imported, 'left alone').url, '{{base}}/x/{{#email}}/{{#bool}}/{{#date, X}}/{{#dateISO, {year: -1}}}');
  assert.ok(imported.notes.some(note => /no equivalent were left as they are: bool, date, dateISO, email\./.test(note.message)));
});

test('Text between braces is text: it is carried over as it is and never run', () => {
  const imported = fixture('f14-expressions');
  assert.equal(named(imported, 'header').headers[0]?.value, '{{ process.env.SECRET }}');
  assert.equal(named(imported, 'url').query[0]?.value, "{{ require('fs').readFileSync('/etc/passwd') }}");
  assert.equal(named(imported, 'body').body.kind, 'text');
  assert.equal(imported.environments[0]?.vars.find(variable => variable.name === 'host')?.value, "{ { require('os').hostname() } }", 'an environment value that looks like code is made harmless by the reader');
});

test('Environments: secrets by name, encrypted values to type again', () => {
  const imported = fixture('f10-secrets');
  assert.deepEqual(imported.environments, [{ name: 'dev', vars: [
    { name: 'base', value: 'https://dev.example', secret: false, enabled: true },
    { name: 'api_token', value: 'CANARY-envvar-HHHH', secret: true, enabled: true },
    { name: 'old_secret', value: '', secret: true, enabled: true }
  ] }]);
  assert.ok(imported.notes.some(note => /1 encrypted variable was not decrypted/.test(note.message)));
});

test('A credential that is typed in is a secret variable of the collection, and nothing that is shared holds it', () => {
  const imported = fixture('f10-secrets');
  const [collection] = imported.collections;
  assert.ok(collection);
  const secretVars = collection.container.vars;
  assert.ok(secretVars.length >= 14);
  assert.ok(secretVars.every(variable => variable.secret && variable.enabled && /^secret_secrets_/.test(variable.name)));
  assert.deepEqual(named(imported, 'bearer').auth, { kind: 'bearer', token: '{{secret_secrets_bearer_token}}', prefix: 'Bearer' });
  assert.equal(named(imported, 'headers').headers[0]?.value, 'Bearer {{secret_secrets_header_authorization}}', 'the scheme stays, the credential moves');
  assert.equal(named(imported, 'url fragment').url, '{{base}}/l#access_token={{secret_secrets_fragment_access_token}}&state=1', 'a fragment that carries a token');
  // Nothing but the values of the secret variables holds a canary.
  const everything = JSON.stringify({ collections: imported.collections.map(folder => stripSecretValues(folder)), notes: imported.notes });
  for (const canary of CANARIES) {
    if (!JSON.stringify(secretVars.concat(imported.environments.flatMap(environment => environment.vars))).includes(canary)) continue;
    assert.ok(!everything.includes(canary), `shared: ${canary}`);
  }
  assert.equal(CANARIES.filter(canary => everything.includes(canary)).length, 0);
  assert.ok(imported.notes.some(note => /16 credentials that were typed into requests were moved to secret variables of the collection/.test(note.message)));
});

function stripSecretValues(folder: ImportedFolder): ImportedFolder {
  return { container: { ...folder.container, vars: folder.container.vars.map(variable => (variable.secret ? { ...variable, value: '' } : variable)) }, requests: folder.requests, folders: folder.folders.map(stripSecretValues) };
}

test('Every request and every folder of every fixture can be written as a file and read back the same', () => {
  for (const found of CASES) {
    const imported = thunderToImported(buildTree(found.build()));
    for (const collection of imported.collections) {
      for (const folder of everyFolder(collection)) {
        for (const request of folder.requests) {
          const read = readRequest(writeRequest(request));
          assert.ok(read.ok, `${found.id}: ${request.name}`);
          assert.deepEqual(read.value, request, `${found.id}: ${request.name}`);
        }
        const kind = folder === collection ? 'collection' : 'folder';
        const container = readContainer(writeContainer(folder.container), kind);
        assert.ok(container.ok, `${found.id}: ${folder.container.name}`);
        assert.deepEqual(container.value, folder.container, `${found.id}: ${folder.container.name}`);
      }
    }
  }
});

test('The fixtures with names that are bad file names, and a broken tree, give folders and requests all the same', () => {
  const names = fixture('f07-names');
  assert.ok(countImported(names).requests >= 10);
  assert.ok(names.collections.flatMap(everyFolder).every(folder => folder.container.name.length > 0 && folder.container.name.length <= 200));
  const broken = fixture('f08-broken');
  assert.equal(broken.collections.length, 1);
  assert.ok(countImported(broken).requests >= 3);
  assert.ok(broken.notes.length > 0, 'what was repaired is told');
});

test('A collection without credentials gets no variables, and one credential used twice is one variable', () => {
  const plain = blankFolder('Plain');
  plain.requests.push({ ...blankRequest('A'), url: 'https://x.test', headers: [kv('Accept', '*/*')] });
  const result = protectCollection(plain);
  assert.equal(result.moved, 0);
  assert.deepEqual(result.collection.container.vars, []);
  const twice = blankFolder('Twice');
  twice.requests.push({ ...blankRequest('A'), headers: [kv('Authorization', 'Bearer abc123')] }, { ...blankRequest('B'), headers: [kv('Authorization', 'Bearer abc123')] });
  const shared = protectCollection(twice);
  assert.deepEqual(shared.collection.container.vars, [{ name: 'secret_twice_header_authorization', value: 'abc123', secret: true, enabled: true }]);
  assert.deepEqual(shared.collection.requests.map(request => request.headers[0]?.value), ['Bearer {{secret_twice_header_authorization}}', 'Bearer {{secret_twice_header_authorization}}']);
  assert.equal(shared.moved, 2);
  assert.equal(twice.requests[0]?.headers[0]?.value, 'Bearer abc123', 'what was given is not changed');
});

test('Credentials: what is already a variable, and what is not secret by its name, is left as it is', () => {
  const credentials = new Credentials('Shop');
  const request: Request = { ...blankRequest('R'), url: 'https://user:{{pw}}@x.test/p', query: [kv('page', '2'), kv('token', '{{t}}'), kv('api_key', 'literal-key')], headers: [kv('X-Trace', 'abc'), kv('X-Api-Key', '{{key}}')], auth: { kind: 'apikey', name: 'X-K', value: 'key-9', in: 'header' } };
  const protectedRequest = credentials.request(request);
  assert.equal(protectedRequest.url, 'https://user:{{pw}}@x.test/p');
  assert.deepEqual(protectedRequest.query, [kv('page', '2'), kv('token', '{{t}}'), kv('api_key', '{{secret_shop_query_api_key}}')]);
  assert.deepEqual(protectedRequest.headers, [kv('X-Trace', 'abc'), kv('X-Api-Key', '{{key}}')]);
  assert.deepEqual(protectedRequest.auth, { kind: 'apikey', name: 'X-K', value: '{{secret_shop_apikey_x_k}}', in: 'header' });
  assert.deepEqual(credentials.vars().map(variable => variable.value), ['literal-key', 'key-9']);
});

test('A query in an address is split by what is outside the variables', () => {
  assert.deepEqual(splitUrl('https://x.test/a?x={{q?r&s}}&y=1#frag'), { url: 'https://x.test/a#frag', query: [kv('x', '{{q?r&s}}'), kv('y', '1')] });
  assert.deepEqual(splitUrl('https://x.test/a'), { url: 'https://x.test/a', query: [] });
  assert.deepEqual(splitUrl('https://x.test/a?'), { url: 'https://x.test/a', query: [] });
  assert.deepEqual(splitUrl('https://x.test/a?flag&&b=%ZZ&c=%E2%9C%93'), { url: 'https://x.test/a', query: [kv('flag', ''), kv('b', '%ZZ'), kv('c', '\u2713')] }, 'a name with no value, a piece that is not encoded right, an encoded character');
  assert.deepEqual(splitUrl('{{base}}/a?x=1'), { url: '{{base}}/a', query: [kv('x', '1')] });
  assert.deepEqual(splitUrl('https://x.test/a#frag?not=query'), { url: 'https://x.test/a#frag?not=query', query: [] }, 'a ? after the # belongs to the fragment');
});
