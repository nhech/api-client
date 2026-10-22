import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePostman } from '../../src/importers/postman';
import { countImported } from '../../src/importers/types';

/** A Postman export becomes collections and environments of the client, with a note for what could not be carried over. */

const parse = (value: unknown) => {
  const result = parsePostman(typeof value === 'string' ? value : JSON.stringify(value));
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.imported;
};
const failure = (value: unknown): string => {
  const result = parsePostman(typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
};
const kv = (name: string, value: string, enabled = true, description = '') => ({ name, value, enabled, description });

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const wrap = (item: unknown[], extra: Record<string, unknown> = {}) => ({ info: { name: 'Shop', description: 'The shop API', schema: SCHEMA }, item, ...extra });
const req = (name: string, request: unknown, extra: Record<string, unknown> = {}) => ({ name, request, ...extra });

test('A collection keeps its folders, its requests and their order', () => {
  const imported = parse(wrap([
    req('Root request', { method: 'GET', url: 'https://api.test/root' }),
    { name: 'Users', description: 'About users', item: [
      req('List', { method: 'GET', url: { raw: 'https://api.test/users?page=1&q=a%20b', query: [{ key: 'page', value: '1' }, { key: 'q', value: 'a b' }, { key: 'old', value: 'x', disabled: true }] } }),
      { name: 'Admin', item: [req('Create', { method: 'post', url: 'https://api.test/users' })] }
    ] },
    req('Last', { method: 'DELETE', url: 'https://api.test/last' })
  ]));
  assert.equal(imported.collections.length, 1);
  const [shop] = imported.collections;
  assert.equal(shop?.container.name, 'Shop');
  assert.equal(shop?.container.docs, 'The shop API');
  assert.deepEqual(shop?.requests.map(request => [request.name, request.method]), [['Root request', 'GET'], ['Last', 'DELETE']]);
  assert.deepEqual(shop?.folders.map(folder => [folder.container.name, folder.container.docs, folder.requests.map(request => request.name)]), [['Users', 'About users', ['List']]]);
  const users = shop?.folders[0];
  assert.deepEqual(users?.folders.map(folder => [folder.container.name, folder.requests.map(request => [request.name, request.method])]), [['Admin', [['Create', 'POST']]]]);
  const list = users?.requests[0];
  assert.equal(list?.url, 'https://api.test/users');
  assert.deepEqual(list?.query, [kv('page', '1'), kv('q', 'a b'), kv('old', 'x', false)], 'the query list says which are switched off');
  assert.deepEqual(countImported(imported), { collections: 1, folders: 2, requests: 4, environments: 0 });
  assert.deepEqual(imported.notes, []);
});

test('The lines of a body, a script, a description and a GraphQL query stay lines; hidden characters in them are made visible', () => {
  const rlo = String.fromCodePoint(0x202e);
  const imported = parse(wrap([
    { name: 'Docs', description: 'Line one\nLine two', item: [
      req('Raw', { method: 'POST', url: 'https://api.test/a', description: { content: 'First\r\nSecond', type: 'text/markdown' }, body: { mode: 'raw', raw: `{\n  "a": 1,\n  "b": "x${rlo}y"\n}`, options: { raw: { language: 'json' } } } },
        { event: [{ listen: 'prerequest', script: { exec: 'const a = 1;\nconst b = 2;' } }, { listen: 'test', script: { exec: ['pm.test("ok", () => {', '  pm.response.to.be.ok;', '});'] } }] }),
      req('Graph', { method: 'POST', url: 'https://api.test/g', body: { mode: 'graphql', graphql: { query: '{\n  me {\n    id\n  }\n}', variables: '{\n  "a": 1\n}' } } })
    ] }
  ]));
  const folder = imported.collections[0]?.folders[0];
  assert.equal(folder?.container.docs, 'Line one\nLine two');
  const [raw, graph] = folder?.requests ?? [];
  assert.equal(raw?.docs, 'First\nSecond');
  assert.deepEqual(raw?.body, { kind: 'json', text: '{\n  "a": 1,\n  "b": "x?y"\n}' });
  assert.deepEqual(raw?.scripts, { pre: 'const a = 1;\nconst b = 2;', post: 'pm.test("ok", () => {\n  pm.response.to.be.ok;\n});' });
  assert.deepEqual(graph?.body, { kind: 'graphql', query: '{\n  me {\n    id\n  }\n}', variables: '{\n  "a": 1\n}' });
});

test('The address is read from a string, from its raw text, or from its parts', () => {
  const imported = parse(wrap([
    req('String', 'https://api.test/s?a=1'),
    req('Parts', { url: { protocol: 'https', host: ['api', 'test'], port: '8443', path: ['v1', 'items'], query: [{ key: 'k', value: 'v' }] } }),
    req('Variables', { url: { raw: '{{base}}/items/:id', variable: [{ key: 'id', value: '42' }] } }),
    req('Nothing', {})
  ]));
  const [string, parts, variables, nothing] = imported.collections[0]?.requests ?? [];
  assert.deepEqual([string?.method, string?.url, string?.query], ['GET', 'https://api.test/s', [kv('a', '1')]]);
  assert.deepEqual([parts?.url, parts?.query], ['https://api.test:8443/v1/items', [kv('k', 'v')]]);
  assert.deepEqual([variables?.url, variables?.pathParams], ['{{base}}/items/:id', [kv('id', '42')]]);
  assert.deepEqual([nothing?.url, nothing?.method], ['', 'GET']);
});

test('Headers keep their switches and descriptions', () => {
  const imported = parse(wrap([req('H', { url: 'https://a.test', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true, description: 'not now' }, { key: '', value: 'x' }, 'X-Old: legacy value'] })]));
  assert.deepEqual(imported.collections[0]?.requests[0]?.headers, [kv('Accept', 'application/json'), kv('X-Off', '1', false, 'not now'), kv('X-Old', 'legacy value')]);
});

test('Bodies of every mode', () => {
  const imported = parse(wrap([
    req('Json', { url: 'https://a.test', method: 'POST', body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } }),
    req('Json by header', { url: 'https://a.test', method: 'POST', header: [{ key: 'Content-Type', value: 'application/json; charset=utf-8' }], body: { mode: 'raw', raw: '{"b":2}' } }),
    req('Xml', { url: 'https://a.test', method: 'POST', body: { mode: 'raw', raw: '<a/>', options: { raw: { language: 'xml' } } } }),
    req('Html', { url: 'https://a.test', method: 'POST', body: { mode: 'raw', raw: '<p>x</p>', options: { raw: { language: 'html' } } } }),
    req('Plain', { url: 'https://a.test', method: 'POST', body: { mode: 'raw', raw: 'hello' } }),
    req('Empty', { url: 'https://a.test', method: 'POST', body: { mode: 'raw', raw: '  ' } }),
    req('Form', { url: 'https://a.test', method: 'POST', body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }] } }),
    req('Multipart', { url: 'https://a.test', method: 'POST', body: { mode: 'formdata', formdata: [{ key: 't', value: 'text', type: 'text', contentType: 'text/plain' }, { key: 'f', type: 'file', src: 'C:\\Users\\me\\Documents\\report.pdf' }, { key: 'g', type: 'file', src: ['/home/me/a.png'], disabled: true }] } }),
    req('File', { url: 'https://a.test', method: 'POST', body: { mode: 'file', file: { src: '/tmp/payload.bin' } } }),
    req('GraphQL', { url: 'https://a.test', method: 'POST', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a":1}' } } }),
    req('GraphQL object', { url: 'https://a.test', method: 'POST', body: { mode: 'graphql', graphql: { query: '{ me }', variables: { a: 2 } } } }),
    req('Unknown', { url: 'https://a.test', method: 'POST', body: { mode: 'hologram' } })
  ]));
  const bodies = Object.fromEntries((imported.collections[0]?.requests ?? []).map(request => [request.name, request.body]));
  assert.deepEqual(bodies['Json'], { kind: 'json', text: '{"a":1}' });
  assert.deepEqual(bodies['Json by header'], { kind: 'json', text: '{"b":2}' });
  assert.deepEqual(bodies['Xml'], { kind: 'xml', text: '<a/>' });
  assert.deepEqual(bodies['Html'], { kind: 'text', contentType: 'text/html', text: '<p>x</p>' });
  assert.deepEqual(bodies['Plain'], { kind: 'text', contentType: 'text/plain', text: 'hello' });
  assert.deepEqual(bodies['Empty'], { kind: 'none' });
  assert.deepEqual(bodies['Form'], { kind: 'form', fields: [kv('a', '1'), kv('b', '2', false)] });
  assert.deepEqual(bodies['Multipart'], { kind: 'multipart', parts: [
    { name: 't', kind: 'text', value: 'text', file: '', contentType: 'text/plain', enabled: true },
    { name: 'f', kind: 'file', value: '', file: 'report.pdf', contentType: '', enabled: true },
    { name: 'g', kind: 'file', value: '', file: 'a.png', contentType: '', enabled: false }
  ] }, 'the folders of the machine that made the file are not kept');
  assert.deepEqual(bodies['File'], { kind: 'binary', file: 'payload.bin' });
  assert.deepEqual(bodies['GraphQL'], { kind: 'graphql', query: '{ me { id } }', variables: '{"a":1}' });
  assert.deepEqual(bodies['GraphQL object'], { kind: 'graphql', query: '{ me }', variables: '{"a":2}' });
  assert.deepEqual(bodies['Unknown'], { kind: 'none' });
  assert.ok(imported.notes.some(note => /hologram is not supported/.test(note.message) && note.where === 'Shop / Unknown'));
  assert.ok(imported.notes.some(note => /put them in the folder of the collection \(report\.pdf, a\.png, payload\.bin\)/.test(note.message)), 'the files to bring are listed');
});

test('Authentication is set where it was, and inherited below it', () => {
  const imported = parse(wrap([
    { name: 'Folder', auth: { type: 'noauth' }, item: [req('Open', { url: 'https://a.test' })] },
    req('Own bearer', { url: 'https://a.test', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] } }),
    req('Basic', { url: 'https://a.test', auth: { type: 'basic', basic: [{ key: 'username', value: 'ann' }, { key: 'password', value: 'pw' }] } }),
    req('Key in query', { url: 'https://a.test', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'api_key' }, { key: 'value', value: 'k-1' }, { key: 'in', value: 'query' }] } }),
    req('Key in header', { url: 'https://a.test', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Key' }, { key: 'value', value: 'k-2' }] } }),
    req('Plain', { url: 'https://a.test' }),
    req('Digest', { url: 'https://a.test', auth: { type: 'digest', digest: [] } })
  ], { auth: { type: 'bearer', bearer: [{ key: 'token', value: 'collection-token' }] } }));
  const [shop] = imported.collections;
  assert.deepEqual(shop?.container.auth, { kind: 'bearer', token: '{{secret_shop_bearer_token}}', prefix: 'Bearer' }, 'the collection sets it for everything below, and the token is a secret variable');
  assert.deepEqual(shop?.container.vars.map(variable => [variable.name, variable.value, variable.secret]), [['secret_shop_bearer_token', 'collection-token', true], ['secret_shop_basic_password', 'pw', true], ['secret_shop_apikey_api_key', 'k-1', true], ['secret_shop_apikey_x_key', 'k-2', true]]);
  assert.deepEqual(shop?.folders[0]?.container.auth, { kind: 'none' }, 'a folder can switch it off');
  const auth = Object.fromEntries((shop?.requests ?? []).map(request => [request.name, request.auth]));
  assert.deepEqual(auth['Own bearer'], { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' });
  assert.deepEqual(auth['Basic'], { kind: 'basic', username: 'ann', password: '{{secret_shop_basic_password}}' });
  assert.deepEqual(auth['Key in query'], { kind: 'apikey', name: 'api_key', value: '{{secret_shop_apikey_api_key}}', in: 'query' });
  assert.deepEqual(auth['Key in header'], { kind: 'apikey', name: 'X-Key', value: '{{secret_shop_apikey_x_key}}', in: 'header' });
  assert.deepEqual(auth['Plain'], { kind: 'inherit' });
  assert.deepEqual(auth['Digest'], { kind: 'inherit' }, 'what is not supported is inherited, not guessed');
  assert.ok(imported.notes.some(note => note.where === 'Shop / Digest' && /digest authentication is not supported/.test(note.message)));
});

test('OAuth 2.0 keeps its grant and its settings', () => {
  const oauth = (extra: Record<string, string>) => ({ type: 'oauth2', oauth2: Object.entries({ accessTokenUrl: 'https://auth.test/token', clientId: 'cid', clientSecret: 'csecret', scope: 'read write', ...extra }).map(([key, value]) => ({ key, value, type: 'string' })) });
  const imported = parse(wrap([
    req('CC', { url: 'https://a.test', auth: oauth({ grant_type: 'client_credentials', client_authentication: 'body' }) }),
    req('Code', { url: 'https://a.test', auth: oauth({ grant_type: 'authorization_code', authUrl: 'https://auth.test/authorize', redirect_uri: 'http://127.0.0.1/cb' }) }),
    req('Pkce', { url: 'https://a.test', auth: oauth({ grant_type: 'authorization_code_with_pkce', authUrl: 'https://auth.test/authorize' }) }),
    req('Password', { url: 'https://a.test', auth: oauth({ grant_type: 'password_credentials', username: 'u', password: 'p', audience: 'api' }) }),
    req('Implicit', { url: 'https://a.test', auth: oauth({ grant_type: 'implicit' }) }),
    req('Query token', { url: 'https://a.test', auth: oauth({ grant_type: 'client_credentials', addTokenTo: 'queryParams' }) })
  ]));
  const byName = Object.fromEntries((imported.collections[0]?.requests ?? []).map(request => [request.name, request.auth]));
  assert.deepEqual(byName['CC'], { kind: 'oauth2', grant: 'client_credentials', pkce: false, authUrl: '', tokenUrl: 'https://auth.test/token', clientId: 'cid', clientSecret: '{{secret_shop_oauth_client_secret}}', scope: 'read write', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'body', extra: [] });
  assert.deepEqual([byName['Code'], byName['Pkce']].map(auth => auth?.kind === 'oauth2' ? [auth.grant, auth.pkce, auth.authUrl, auth.redirectUrl] : []), [['authorization_code', false, 'https://auth.test/authorize', 'http://127.0.0.1/cb'], ['authorization_code', true, 'https://auth.test/authorize', '']]);
  assert.deepEqual(byName['Password'] && byName['Password'].kind === 'oauth2' ? [byName['Password'].grant, byName['Password'].username, byName['Password'].password, byName['Password'].audience, byName['Password'].clientAuth] : [], ['password', 'u', '{{secret_shop_oauth_password}}', 'api', 'header']);
  assert.deepEqual(byName['Implicit'], { kind: 'inherit' });
  assert.ok(imported.notes.some(note => /implicit grant is not supported/.test(note.message)));
  assert.ok(imported.notes.some(note => note.where === 'Shop / Query token' && /sent in a header here/.test(note.message)));
});

test('Scripts are kept as written, before and after, at every level', () => {
  const imported = parse(wrap([
    { name: 'Folder', event: [{ listen: 'prerequest', script: { exec: ['console.log("folder");'] } }], item: [
      req('Scripted', { url: 'https://a.test' }, { event: [
        { listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.variables.set("a", 1);', 'pm.variables.set("b", 2);'] } },
        { listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } },
        { listen: 'test', script: { exec: ['console.log("second");'] } },
        { listen: 'test', disabled: true, script: { exec: ['console.log("off");'] } },
        { listen: 'test', script: { exec: [''] } },
        { listen: 'other', script: { exec: ['x();'] } }
      ] })
    ] }
  ], { event: [{ listen: 'test', script: { exec: 'pm.test("collection", () => {});' } }] }));
  const [shop] = imported.collections;
  assert.deepEqual(shop?.container.scripts, { pre: '', post: 'pm.test("collection", () => {});' }, 'a script may be one string');
  assert.deepEqual(shop?.folders[0]?.container.scripts, { pre: 'console.log("folder");', post: '' });
  const scripted = shop?.folders[0]?.requests[0];
  assert.deepEqual(scripted?.scripts, { pre: 'pm.variables.set("a", 1);\npm.variables.set("b", 2);', post: 'pm.test("ok", () => pm.response.to.have.status(200));\n\nconsole.log("second");' });
  assert.ok(imported.notes.some(note => /5 scripts were imported as written/.test(note.message) && /only after you allow them/.test(note.message)));
});

test('Variables of the collection become variables, with the secret ones marked', () => {
  const imported = parse(wrap([], { variable: [{ key: 'base', value: 'https://api.test' }, { key: 'api_token', value: 'abc123' }, { key: 'pw', value: 'x', type: 'secret' }, { key: 'off', value: '1', disabled: true }, { key: 'base', value: 'dup' }, { key: '', value: 'x' }, { key: 'token_ref', value: '{{other}}' }] }));
  assert.deepEqual(imported.collections[0]?.container.vars, [
    { name: 'base', value: 'https://api.test', secret: false, enabled: true },
    { name: 'api_token', value: 'abc123', secret: true, enabled: true },
    { name: 'pw', value: 'x', secret: true, enabled: true },
    { name: 'off', value: '1', secret: false, enabled: false },
    { name: 'token_ref', value: '{{other}}', secret: false, enabled: true }
  ]);
});

test('Dynamic variables are the same where they exist here, and listed where they do not', () => {
  const imported = parse(wrap([req('D', { method: 'POST', url: 'https://a.test/{{$guid}}/{{$randomUUID}}?t={{$timestamp}}&n={{$randomFirstName}}', header: [{ key: 'X-Id', value: '{{$randomInt}}' }], body: { mode: 'raw', raw: '{"e":"{{$randomEmail}}","w":"{{$randomWord}}"}', options: { raw: { language: 'json' } } } })]));
  const [request] = imported.collections[0]?.requests ?? [];
  assert.equal(request?.url, 'https://a.test/{{$guid}}/{{$uuid}}');
  assert.deepEqual(request?.query, [kv('t', '{{$timestamp}}'), kv('n', '{{$randomFirstName}}')]);
  assert.deepEqual(request?.headers, [kv('X-Id', '{{$randomInt}}')]);
  assert.ok(imported.notes.some(note => /no equivalent were left as they are: \$randomFirstName, \$randomWord\./.test(note.message)));
});

test('The settings of a request that Postman has are kept', () => {
  const imported = parse(wrap([req('P', { url: 'https://a.test' }, { protocolProfileBehavior: { followRedirects: false, strictSSL: false, disableCookies: true, maxRedirects: 3, disableBodyPruning: true } }), req('Q', { url: 'https://a.test' }, { protocolProfileBehavior: { maxRedirects: 'many', followRedirects: true } })]));
  assert.deepEqual(imported.collections[0]?.requests[0]?.settings, { followRedirects: false, rejectUnauthorized: false, cookies: false, maxRedirects: 3 });
  assert.deepEqual(imported.collections[0]?.requests[1]?.settings, {});
});

test('An environment file becomes an environment; a globals file too', () => {
  const environment = parse({ id: 'x', name: 'Staging', values: [{ key: 'host', value: 'https://staging.test', enabled: true }, { key: 'secret_key', value: 'abc', type: 'secret' }, { key: 'api_token', value: 'tok' }, { key: 'off', value: '1', enabled: false }, { key: 'host', value: 'dup' }, { key: 'dyn', value: '{{$randomUUID}}' }], _postman_variable_scope: 'environment' });
  assert.deepEqual(environment.environments, [{ name: 'Staging', vars: [
    { name: 'host', value: 'https://staging.test', secret: false, enabled: true },
    { name: 'secret_key', value: 'abc', secret: true, enabled: true },
    { name: 'api_token', value: 'tok', secret: true, enabled: true },
    { name: 'off', value: '1', secret: false, enabled: false },
    { name: 'dyn', value: '{{$uuid}}', secret: false, enabled: true }
  ] }]);
  assert.equal(environment.collections.length, 0);
  assert.equal(parse({ name: '', values: [], _postman_variable_scope: 'globals' }).environments[0]?.name, 'Postman globals');
  assert.equal(parse({ values: [] }).environments[0]?.name, 'Postman environment');
});

test('What is not a Postman file is said so', () => {
  assert.match(failure('not json {'), /not JSON/);
  assert.match(failure('[]'), /one JSON object/);
  assert.match(failure('"text"'), /one JSON object/);
  assert.match(failure({ hello: 'world' }), /no "info" and "item", and no "values"/);
  assert.match(failure({ requests: [], folders: [] }), /first version \(v1\)/);
  assert.match(failure({ info: { name: 'x' } }), /not a Postman collection/);
  assert.equal(parsePostman(`${String.fromCharCode(0xfeff)}${JSON.stringify(wrap([]))}`).ok, true, 'a byte order mark is not part of the JSON');
});

test('Names and text from the file are made safe, and what is wrong is left out with a note', () => {
  const imported = parse(wrap([
    req('A\u202eB\u0000C', { url: 'https://a.test' }),
    req('', { url: 'https://a.test' }),
    { name: 'No request and no items' },
    null, 7, 'text',
    req('x'.repeat(500), { url: 'https://a.test' }),
    { name: 'Bad method', request: { method: 'ge t', url: 'https://a.test' } }
  ]));
  const requests = imported.collections[0]?.requests ?? [];
  assert.deepEqual(requests.map(request => request.name.length > 40 ? 'long' : request.name), ['A?B?C', 'Request', 'long', 'Bad method']);
  assert.equal(requests[2]?.name.length, 200);
  assert.equal(requests[3]?.method, 'GET', 'a method that is not one is GET');
  assert.ok(imported.notes.some(note => /neither requests nor folders \(No request and no items\)/.test(note.message)));
});

test('Keys that are not data are not read as data', () => {
  const imported = parse(JSON.parse('{"info":{"name":"P"},"item":[{"name":"r","__proto__":{"request":{"method":"DELETE","url":"https://evil.test"}}}],"__proto__":{"auth":{"type":"basic"}}}'));
  assert.equal(imported.collections[0]?.requests.length, 0, 'a request that only the prototype has is not a request');
  assert.deepEqual(imported.collections[0]?.container.auth, { kind: 'inherit' });
  const nested = parse(wrap([req('R', { url: 'https://a.test', auth: JSON.parse('{"type":"bearer","__proto__":{"bearer":[{"key":"token","value":"from-prototype"}]}}') })]));
  assert.deepEqual(nested.collections[0]?.requests[0]?.auth, { kind: 'bearer', token: '', prefix: 'Bearer' });
});

test('Folders nested too deep and collections with too many requests are cut, with a note', () => {
  let deep: Record<string, unknown> = { name: 'leaf', item: [req('Leaf request', { url: 'https://a.test' })] };
  for (let level = 0; level < 40; level++) deep = { name: `L${level}`, item: [deep] };
  const imported = parse(wrap([deep]));
  assert.ok(imported.notes.some(note => /nested more than 32 deep/.test(note.message)));
  assert.equal(countImported(imported).folders, 32);
  const many = parse(wrap(Array.from({ length: 20_005 }, (_, index) => req(`R${index}`, { url: 'https://a.test' }))));
  assert.equal(countImported(many).requests, 20_000);
  assert.ok(many.notes.some(note => /more than 20000 requests is cut/.test(note.message)));
});
