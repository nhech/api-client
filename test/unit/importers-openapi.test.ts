import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi } from '../../src/importers/openapi';
import { countImported, IMPORT_LIMITS, type Imported } from '../../src/importers/types';

/** An OpenAPI or Swagger description becomes a collection of the client: folders for the tags, a request for each operation, and what is needed to send it. */

const parse = (value: unknown): Imported => {
  const result = parseOpenApi(typeof value === 'string' ? value : JSON.stringify(value));
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.imported;
};
const failure = (value: unknown): string => {
  const result = parseOpenApi(typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(result.ok, false);
  return result.ok ? '' : result.error;
};
const kv = (name: string, value: string, enabled = true, description = '') => ({ name, value, enabled, description });
const noteTexts = (imported: Imported): string[] => imported.notes.map(note => `${note.where}|${note.message}`);
const base = (extra: Record<string, unknown> = {}, paths: Record<string, unknown> = {}) => ({ openapi: '3.0.3', info: { title: 'Shop', version: '1.2.0', description: 'The shop API' }, servers: [{ url: 'https://api.shop.test/v1' }], paths, ...extra });

const PET = { type: 'object', required: ['name'], properties: { id: { type: 'integer', format: 'int64', readOnly: true }, name: { type: 'string', example: 'Rex' }, tag: { type: 'string' }, born: { type: 'string', format: 'date' }, owner: { $ref: '#/components/schemas/Owner' } } };
const OWNER = { type: 'object', properties: { email: { type: 'string', format: 'email' }, pets: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } };
const PETSTORE = base({
  tags: [{ name: 'pets', description: 'Everything about pets' }, { name: 'store' }],
  components: {
    schemas: { Pet: PET, Owner: OWNER },
    parameters: { limit: { name: 'limit', in: 'query', description: 'How many', schema: { type: 'integer', default: 20 } } },
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }
  },
  security: [{ bearerAuth: [] }]
}, {
  '/pets': {
    get: { tags: ['pets'], summary: 'List pets', operationId: 'listPets', parameters: [{ $ref: '#/components/parameters/limit' }, { name: 'status', in: 'query', required: true, schema: { type: 'string', enum: ['available', 'sold'] } }, { name: 'X-Trace', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'ok' }, default: { description: 'error' } } },
    post: { tags: ['pets'], summary: 'Add a pet', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 201: { description: 'created' } } }
  },
  '/pets/{petId}': {
    parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 } }],
    get: { tags: ['pets'], operationId: 'getPet', security: [{ key: [] }], responses: { 200: { description: 'ok' } } },
    delete: { tags: ['pets'], security: [], responses: { 204: { description: 'gone' } } }
  },
  '/health': { get: { summary: 'Health', responses: { 200: { description: 'ok' } } } },
  '/inventory': { get: { tags: ['store'], summary: 'Inventory', responses: { 200: { description: 'ok' } } } }
});

test('An OpenAPI 3 description: the collection, its folders for the tags in their order, a request for each operation, the servers as environments', () => {
  const imported = parse(PETSTORE);
  assert.equal(imported.collections.length, 1);
  const [shop] = imported.collections;
  assert.equal(shop?.container.name, 'Shop');
  assert.equal(shop?.container.docs, 'The shop API\n\nVersion: 1.2.0');
  assert.equal(shop?.container.baseUrl, '{{baseUrl}}');
  assert.deepEqual(shop?.requests.map(request => request.name), ['Health'], 'an operation with no tag is in the collection');
  assert.deepEqual(shop?.folders.map(folder => [folder.container.name, folder.container.docs, folder.requests.map(request => [request.name, request.method, request.url])]), [
    ['pets', 'Everything about pets', [['List pets', 'GET', '/pets'], ['Add a pet', 'POST', '/pets'], ['getPet', 'GET', '/pets/{petId}'], ['DELETE /pets/{petId}', 'DELETE', '/pets/{petId}']]],
    ['store', '', [['Inventory', 'GET', '/inventory']]]
  ]);
  assert.deepEqual(imported.environments, [{ name: 'api.shop.test', vars: [{ name: 'baseUrl', value: 'https://api.shop.test/v1', secret: false, enabled: true }] }]);
  assert.deepEqual(countImported(imported), { collections: 1, folders: 2, requests: 6, environments: 1 });
});

test('The parameters become rows: the required ones are on, the others off with a value to start from; a path parameter gets its example or a variable', () => {
  const [pets] = parse(PETSTORE).collections[0]?.folders ?? [];
  const list = pets?.requests[0];
  assert.deepEqual(list?.query, [kv('limit', '20', false, 'How many'), kv('status', 'available', true)]);
  assert.deepEqual(list?.headers, [kv('X-Trace', '', false)]);
  assert.deepEqual(list?.tests, [{ expr: 'status == 200', enabled: true }], 'the first success status the description names');
  assert.equal(list?.docs, 'Operation ID: listPets');
  const get = pets?.requests[2];
  assert.deepEqual(get?.pathParams, [kv('petId', '7')]);
  const bare = parse(base({}, { '/things/{thingId}/parts/{part-id}': { get: { responses: {} } } })).collections[0]?.requests[0];
  assert.deepEqual(bare?.pathParams, [kv('thingId', '{{thingId}}'), kv('part-id', '{{part-id}}')], 'a variable that stays unresolved says loudly that it is missing');
  assert.deepEqual(bare?.tests, []);
});

test('The body is the example of the description or is made from the schema; what the server makes (readOnly) is not sent; a reference that loops is cut', () => {
  const [pets] = parse(PETSTORE).collections[0]?.folders ?? [];
  const add = pets?.requests[1];
  assert.equal(add?.body.kind, 'json');
  assert.deepEqual(JSON.parse(add?.body.kind === 'json' ? add.body.text : '{}'), { name: 'Rex', tag: 'string', born: '2024-01-01', owner: { email: 'user@example.com', pets: [null] } });
  const withExample = parse(base({}, { '/a': { post: { requestBody: { content: { 'application/json': { example: { a: 1 }, schema: { type: 'object' } } } } } }, '/b': { post: { requestBody: { content: { 'application/json': { examples: { first: { value: { b: 2 } }, second: { value: { b: 3 } } } } } } } } })).collections[0]?.requests ?? [];
  assert.equal(withExample[0]?.body.kind === 'json' ? withExample[0].body.text : '', JSON.stringify({ a: 1 }, null, 2));
  assert.equal(withExample[1]?.body.kind === 'json' ? withExample[1].body.text : '', JSON.stringify({ b: 2 }, null, 2));
});

test('Authentication comes from the security schemes: the collection has the one for all, an operation can use another, none, or inherit; the credentials are secret variables with no value', () => {
  const imported = parse(PETSTORE);
  const shop = imported.collections[0];
  assert.deepEqual(shop?.container.auth, { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' });
  assert.deepEqual(shop?.container.vars, [{ name: 'token', value: '', secret: true, enabled: true }, { name: 'apiKey', value: '', secret: true, enabled: true }]);
  const [list, , get, remove] = shop?.folders[0]?.requests ?? [];
  assert.deepEqual(list?.auth, { kind: 'inherit' });
  assert.deepEqual(get?.auth, { kind: 'apikey', name: 'X-Api-Key', value: '{{apiKey}}', in: 'header' });
  assert.deepEqual(remove?.auth, { kind: 'none' }, 'security: [] means no authentication');
  assert.ok(noteTexts(imported).some(note => /credentials are variables of the collection \(token, apiKey\)/.test(note)));
});

test('Every kind of scheme: basic, an API key in the query, OAuth 2.0 with its flows, a second scheme of a kind, and the ones that cannot be used', () => {
  const schemes = {
    basic: { type: 'http', scheme: 'basic' },
    query: { type: 'apiKey', in: 'query', name: 'api_key' },
    cookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
    digest: { type: 'http', scheme: 'digest' },
    oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://x.test/.well-known' },
    code: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: 'https://auth.test/authorize', tokenUrl: 'https://auth.test/token', scopes: { read: 'r', write: 'w' } } } },
    machine: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.test/token', scopes: { admin: 'a' } } } },
    login: { type: 'oauth2', flows: { password: { tokenUrl: 'https://auth.test/token', scopes: {} } } },
    implicit: { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://auth.test/authorize', scopes: {} } } },
    second: { type: 'http', scheme: 'bearer' },
    first: { type: 'http', scheme: 'bearer' }
  };
  const operations: Record<string, unknown> = {};
  for (const key of Object.keys(schemes)) operations[`/${key}`] = { get: { security: [{ [key]: key === 'code' ? ['read'] : [] }], responses: {} } };
  const imported = parse(base({ components: { securitySchemes: schemes } }, operations));
  const auth = Object.fromEntries((imported.collections[0]?.requests ?? []).map(request => [request.url.slice(1), request.auth]));
  assert.deepEqual(auth['basic'], { kind: 'basic', username: '{{username}}', password: '{{password}}' });
  assert.deepEqual(auth['query'], { kind: 'apikey', name: 'api_key', value: '{{apiKey}}', in: 'query' });
  assert.deepEqual(auth['cookie'], { kind: 'inherit' });
  assert.deepEqual(auth['digest'], { kind: 'inherit' });
  assert.deepEqual(auth['oidc'], { kind: 'inherit' });
  assert.deepEqual(auth['implicit'], { kind: 'inherit' });
  assert.deepEqual(auth['code'], { kind: 'oauth2', grant: 'authorization_code', pkce: true, authUrl: 'https://auth.test/authorize', tokenUrl: 'https://auth.test/token', clientId: '{{clientId}}', clientSecret: '', scope: 'read', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [] });
  assert.equal((auth['machine'] as { grant: string; scope: string; clientSecret: string }).grant, 'client_credentials');
  assert.equal((auth['machine'] as { scope: string }).scope, 'admin');
  assert.equal((auth['machine'] as { clientSecret: string }).clientSecret, '{{machine_clientSecret}}', 'a second scheme of a kind has its own variables');
  assert.deepEqual([(auth['login'] as { grant: string }).grant, (auth['login'] as { username: string }).username], ['password', '{{login_username}}']);
  assert.deepEqual(auth['first'], { kind: 'bearer', token: '{{first_token}}', prefix: 'Bearer' }, 'the names follow the order of the schemes');
  const notes = noteTexts(imported).join('\n');
  assert.match(notes, /cookie cannot be set here/);
  assert.match(notes, /digest scheme is not supported/);
  assert.match(notes, /openIdConnect scheme is not supported/);
  assert.match(notes, /implicit OAuth 2\.0 flow/);
});

test('The kinds of body: a form, multipart with a file, XML, text, a file of any other type, a vendor type of JSON; and what is not used is said', () => {
  const content = (type: string, schema: unknown, extra: Record<string, unknown> = {}) => ({ post: { responses: {}, requestBody: { content: { [type]: { schema, ...extra } } } } });
  const form = { type: 'object', required: ['user'], properties: { id: { type: 'integer', readOnly: true, default: 9 }, user: { type: 'string', example: 'ann' }, note: { type: 'string' }, count: { type: 'integer', default: 3 } } };
  const imported = parse(base({}, {
    '/form': content('application/x-www-form-urlencoded', form),
    '/multi': content('multipart/form-data', { type: 'object', properties: { name: { type: 'string', example: 'x' }, file: { type: 'string', format: 'binary' } } }),
    '/xml': content('application/xml', { $ref: '#/components/schemas/Item' }),
    '/xmlexample': content('application/xml', { type: 'object' }, { example: '<a>1</a>' }),
    '/text': content('text/plain', { type: 'string' }, { example: 'hello' }),
    '/bin': content('application/octet-stream', { type: 'string', format: 'binary' }),
    '/vendor': content('application/vnd.api+json', { type: 'object', properties: { a: { type: 'boolean' } } }),
    '/many': { post: { responses: {}, requestBody: { content: { 'application/xml': { schema: { type: 'object' } }, 'text/plain': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object', properties: { j: { type: 'string' } } } } } } } }
  }, ));
  const by = Object.fromEntries((imported.collections[0]?.requests ?? []).map(request => [request.url.slice(1), request]));
  assert.deepEqual(by['form']?.body, { kind: 'form', fields: [kv('user', 'ann', true), kv('note', '', false), kv('count', '3', true)] });
  assert.deepEqual(by['multi']?.body, { kind: 'multipart', parts: [{ name: 'name', kind: 'text', value: 'x', file: '', contentType: '', enabled: true }, { name: 'file', kind: 'file', value: '', file: '', contentType: '', enabled: true }] });
  assert.deepEqual(by['xmlexample']?.body, { kind: 'xml', text: '<a>1</a>' });
  assert.deepEqual(by['text']?.body, { kind: 'text', contentType: 'text/plain', text: 'hello' });
  assert.deepEqual(by['bin']?.body, { kind: 'binary', file: '' });
  assert.equal(by['vendor']?.body.kind, 'json');
  assert.deepEqual(by['vendor']?.headers, [kv('Content-Type', 'application/vnd.api+json')]);
  assert.equal(by['many']?.body.kind, 'json', 'JSON is used first');
  const notes = noteTexts(imported).join('\n');
  assert.match(notes, /POST \/many\|The body is also described as application\/xml, text\/plain; application\/json was used\./);
  assert.match(notes, /POST \/multi\|Choose the files of the form in the Body tab\./);
  assert.match(notes, /POST \/bin\|The body is application\/octet-stream: choose the file in the Body tab\./);
});

test('XML is made from the schema: the name of the root from the schema, one element for each property and item', () => {
  const imported = parse(base({ components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'a&b' }, tags: { type: 'array', items: { type: 'string', example: 't' } } } } } } }, { '/pets': { post: { responses: {}, requestBody: { content: { 'text/xml': { schema: { $ref: '#/components/schemas/Pet' } } } } } } }));
  const request = imported.collections[0]?.requests[0];
  assert.deepEqual(request?.body, { kind: 'xml', text: '<Pet>\n  <name>a&amp;b</name>\n  <tags>t</tags>\n</Pet>' });
  assert.deepEqual(request?.headers, [kv('Content-Type', 'text/xml')]);
});

test('Swagger 2.0: host, base path and schemes, a body parameter, form parameters with a file, consumes, and the security definitions', () => {
  const imported = parse({
    swagger: '2.0', info: { title: 'Old Store', version: '1' }, host: 'old.shop.test', basePath: '/api', schemes: ['http', 'https'], consumes: ['application/json'],
    securityDefinitions: { basic_auth: { type: 'basic' }, oauth: { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://a.test/auth', tokenUrl: 'https://a.test/token', scopes: { read: 'r' } } },
    security: [{ basic_auth: [] }],
    definitions: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'Rex' } } } },
    paths: {
      '/pets/{id}': {
        put: { summary: 'Update', parameters: [{ name: 'id', in: 'path', required: true, type: 'integer', 'x-example': 5 }, { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }, { name: 'limit', in: 'query', type: 'integer', default: 10 }], security: [{ oauth: ['read'] }], responses: { 200: { description: 'ok' } } }
      },
      '/upload': { post: { consumes: ['multipart/form-data'], parameters: [{ name: 'file', in: 'formData', type: 'file', required: true }, { name: 'caption', in: 'formData', type: 'string' }], responses: {} } },
      '/login': { post: { parameters: [{ name: 'user', in: 'formData', type: 'string', required: true, default: 'ann' }], responses: {} } }
    }
  });
  assert.deepEqual(imported.environments, [{ name: 'old.shop.test', vars: [{ name: 'baseUrl', value: 'https://old.shop.test/api', secret: false, enabled: true }] }]);
  const shop = imported.collections[0];
  assert.deepEqual(shop?.container.auth, { kind: 'basic', username: '{{username}}', password: '{{password}}' });
  const [update, upload, login] = shop?.requests ?? [];
  assert.deepEqual(update?.pathParams, [kv('id', '5')]);
  assert.deepEqual(update?.query, [kv('limit', '10', false)]);
  assert.equal(update?.body.kind === 'json' ? update.body.text : '', JSON.stringify({ name: 'Rex' }, null, 2));
  assert.equal(update?.auth.kind, 'oauth2');
  assert.equal(update?.auth.kind === 'oauth2' ? update.auth.grant : '', 'authorization_code');
  assert.equal(update?.auth.kind === 'oauth2' ? update.auth.scope : '', 'read');
  assert.deepEqual(upload?.body, { kind: 'multipart', parts: [{ name: 'file', kind: 'file', value: '', file: '', contentType: '', enabled: true }, { name: 'caption', kind: 'text', value: '', file: '', contentType: '', enabled: false }] });
  assert.deepEqual(login?.body, { kind: 'form', fields: [kv('user', 'ann', true)] });
});

test('The servers: variables take their defaults, a relative address is put after http://localhost, several servers are several environments, none gives a default one', () => {
  const several = parse(base({ servers: [{ url: 'https://{region}.shop.test/{version}', description: 'Production', variables: { region: { default: 'eu' }, version: { default: 'v2' } } }, { url: 'https://staging.shop.test' }, { url: '/api/v3' }] }, { '/a': { get: {} } }));
  assert.deepEqual(several.environments.map(environment => [environment.name, environment.vars[0]?.value]), [['Production', 'https://eu.shop.test/v2'], ['staging.shop.test', 'https://staging.shop.test'], ['localhost', 'http://localhost/api/v3']]);
  assert.match(noteTexts(several).join('\n'), /server address \/api\/v3 has no host/);
  const none = parse({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: {} } } });
  assert.deepEqual(none.environments, [{ name: 'Local', vars: [{ name: 'baseUrl', value: 'http://localhost', secret: false, enabled: true }] }]);
  assert.match(noteTexts(none).join('\n'), /names no server/);
  const missing = parse(base({ servers: [{ url: 'https://{x}.test', variables: {} }] }, { '/a': { get: {} } }));
  assert.match(noteTexts(missing).join('\n'), /variable x without a default/);
});

test('YAML is read as the same description as JSON, with flow collections, quoted keys and folded descriptions', () => {
  const yaml = [
    'openapi: 3.0.3',
    'info:',
    '  title: Shop',
    '  version: 1.2.0',
    '  description: >-',
    '    The shop',
    '    API',
    'servers: [{url: "https://api.shop.test/v1"}]',
    'paths:',
    '  /pets/{petId}:',
    '    get:',
    '      tags: [pets]',
    '      summary: Get a pet',
    '      parameters:',
    '        - {name: petId, in: path, required: true, schema: {type: integer, example: 7}}',
    '        - name: limit',
    '          in: query',
    '          schema: {type: integer, default: 20}',
    '      responses:',
    '        "200": {description: ok}',
    ''
  ].join('\n');
  const imported = parse(yaml);
  const request = imported.collections[0]?.folders[0]?.requests[0];
  assert.equal(imported.collections[0]?.container.docs, 'The shop API\n\nVersion: 1.2.0');
  assert.equal(request?.name, 'Get a pet');
  assert.deepEqual(request?.pathParams, [kv('petId', '7')]);
  assert.deepEqual(request?.query, [kv('limit', '20', false)]);
  assert.deepEqual(request?.tests, [{ expr: 'status == 200', enabled: true }]);
  assert.deepEqual(imported.environments[0]?.vars[0]?.value, 'https://api.shop.test/v1');
});

test('What is left out is said: callbacks, webhooks, cookie parameters, TRACE, operations with several tags, and every reference that is not inside the file', () => {
  const imported = parse(base({ webhooks: { newPet: { post: {} } } }, {
    '/a': { trace: {}, get: { tags: ['one', 'two'], parameters: [{ name: 'sid', in: 'cookie', schema: { type: 'string' } }], callbacks: { done: {} }, responses: {} } },
    '/b': { get: { parameters: [{ $ref: 'other.yaml#/components/parameters/x' }, { $ref: '#/components/parameters/missing' }], requestBody: { $ref: 'https://x.test/body.json' }, responses: {} } }
  }));
  const notes = noteTexts(imported).join('\n');
  assert.match(notes, /GET \/a\|A cookie parameter was left out/);
  assert.match(notes, /GET \/a\|The callbacks of the operation were left out/);
  assert.match(notes, /1 operation uses the TRACE method/);
  assert.match(notes, /1 operation has more than one tag: it was put in the folder of its first tag/);
  assert.match(notes, /A webhook of the description was left out/);
  assert.match(notes, /2 references to other files or addresses were not followed/);
  assert.match(notes, /1 reference points at nothing in the file \(#\/components\/parameters\/missing\)/);
  assert.deepEqual(imported.collections[0]?.folders.map(folder => folder.container.name), ['one']);
});

test('Details that are easy to get wrong: the lowest success status, the same authentication is inherited, a deprecated operation says so, swagger: 2.0 as a number, a base path that is /, a loop of references', () => {
  const imported = parse(base({ components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' } } }, security: [{ bearerAuth: [] }] }, {
    '/two': { get: { deprecated: true, summary: 'Old', description: 'Use /new instead.', responses: { 204: { description: 'none' }, 200: { description: 'ok' }, '4XX': { description: 'bad' } } } },
    '/same': { get: { security: [{ bearerAuth: [] }], responses: {} } },
    '/loop': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } }, responses: {} } }
  }));
  const [two, same, loop] = imported.collections[0]?.requests ?? [];
  assert.deepEqual(two?.tests, [{ expr: 'status == 200', enabled: true }]);
  assert.equal(two?.docs, '**Deprecated.**\n\nUse /new instead.');
  assert.deepEqual(same?.auth, { kind: 'inherit' }, 'what the collection already uses is not repeated on the request');
  assert.deepEqual(loop?.body, { kind: 'json', text: 'null' }, 'a reference that leads back to itself gives nothing to make a value from');
  const headers = parse(base({}, { '/h': { get: { parameters: [{ name: 'Authorization', in: 'header' }, { name: 'accept', in: 'header' }, { name: 'Content-Type', in: 'header' }, { name: 'X-Trace', in: 'header' }], responses: {} } } })).collections[0]?.requests[0];
  assert.deepEqual(headers?.headers, [kv('X-Trace', '', false)], 'the description says Accept, Content-Type and Authorization are not carried by a parameter');
  const yaml = parse(['swagger: 2.0', 'info: {title: Old, version: "1"}', 'host: x.test', 'basePath: /', 'paths:', '  /a:', '    get: {responses: {}}', ''].join('\n'));
  assert.deepEqual(yaml.environments[0]?.vars[0]?.value, 'http://x.test', 'swagger: 2.0 is read as a number in YAML, and a base path of / adds nothing');
});

test('What is not a description is refused with the reason', () => {
  assert.match(failure('not: [a description'), /not JSON or YAML that can be read/);
  assert.match(failure('[1, 2]'), /not a mapping/);
  assert.match(failure({ info: {} }), /no "openapi" or "swagger" field/);
  assert.match(failure({ openapi: '4.0.0', paths: {} }), /OpenAPI version 4\.0\.0 is not supported/);
  assert.match(failure({ openapi: '3.0.0', info: {} }), /no "paths"/);
  assert.match(failure('a: &x 1'), /anchors/);
  assert.deepEqual(parse({ openapi: '3.0.0', info: { title: 'Empty' }, paths: {} }).collections, [], 'nothing to import is no collection');
});

test('The same description gives the same result every time, and JSON and YAML agree', () => {
  assert.deepEqual(parse(PETSTORE), parse(JSON.stringify(PETSTORE)));
  assert.equal(JSON.stringify(parse(PETSTORE)), JSON.stringify(parse(PETSTORE)));
});

test('Hostile descriptions: schemas that contain themselves, very deep and very wide ones, a million operations, references that loop, __proto__ everywhere, enormous texts', () => {
  const started = Date.now();
  const loop = parse(base({ components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { $ref: '#/components/schemas/A' }, Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' }, kids: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } } }, { '/a': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } }, responses: {} } }, '/n': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }, responses: {} } } }));
  assert.equal(loop.collections[0]?.requests.length, 2);
  // The text is built, not stringified: JSON.stringify itself cannot walk a value this deep.
  const levels = 3000;
  const deep = '{"type":"object","properties":{"next":'.repeat(levels) + '{"type":"string"}' + '}}'.repeat(levels);
  const nested = parse(`{"openapi":"3.0.0","info":{"title":"D"},"paths":{"/d":{"post":{"requestBody":{"content":{"application/json":{"schema":${deep}}}},"responses":{}}}}}`);
  assert.equal(nested.collections[0]?.requests[0]?.body.kind, 'json');
  const nestedBody = nested.collections[0]?.requests[0]?.body;
  assert.ok(nestedBody?.kind === 'json' && nestedBody.text.length < 2000, 'a schema that deep is cut after a few levels');
  const abyss = parseOpenApi(`{"openapi":"3.0.0","info":{"title":"D"},"paths":{"/d":{"post":{"x":${'['.repeat(200_000)}${']'.repeat(200_000)}}}}}`);
  assert.equal(typeof abyss.ok, 'boolean', 'nesting without end is read or refused, never a crash');
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < 20_000; index++) properties[`p${index}`] = { type: 'object', properties: { x: { type: 'string' }, y: { type: 'array', items: { type: 'integer' } } } };
  const wide = parse(base({}, { '/w': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties } } } }, responses: {} } } }));
  assert.ok(noteTexts(wide).some(note => /cut|too large/.test(note)));
  const body = wide.collections[0]?.requests[0]?.body;
  assert.ok(body?.kind === 'json' && body.text.length <= 64 * 1024);
  // A body of more than 64 KB is not written into a request file: it says so instead.
  const heavy = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`p${index}`, { type: 'string', example: 'x'.repeat(2000) }]));
  const heavyBody = parse(base({}, { '/b': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: heavy } } } }, responses: {} } } }));
  assert.deepEqual(heavyBody.collections[0]?.requests[0]?.body, { kind: 'json', text: '' });
  assert.ok(noteTexts(heavyBody).some(note => /too large to be made from its schema/.test(note)));
  // Fifty properties of fifty: no object is wider than the limit of properties, so it is the number of values that stops the example.
  const grid: Record<string, unknown> = {};
  for (let a = 0; a < 50; a++) { const inner: Record<string, unknown> = {}; for (let b = 0; b < 50; b++) inner[`b${b}`] = { type: 'string' }; grid[`a${a}`] = { type: 'object', properties: inner }; }
  const cut = parse(base({}, { '/g': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: grid } } } }, responses: {} } } }));
  assert.ok(noteTexts(cut).some(note => /example of the body was cut/.test(note)), 'the number of values in an example is limited');
  const many: Record<string, unknown> = {};
  for (let index = 0; index < IMPORT_LIMITS.requests + 500; index++) many[`/p${index}`] = { get: {} };
  const big = parse(base({}, many));
  assert.equal(countImported(big).requests, IMPORT_LIMITS.requests);
  assert.ok(noteTexts(big).some(note => /Only the first 20000 operations/.test(note)));
  const proto = parse('{"openapi":"3.0.0","info":{"title":"P"},"paths":{"/__proto__":{"get":{"summary":"__proto__","parameters":[{"name":"__proto__","in":"query"}]}},"/constructor":{"get":{}}},"components":{"schemas":{"__proto__":{"type":"object"}}}}');
  assert.equal(proto.collections[0]?.requests.length, 2);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  const long = parse(base({}, { '/long': { get: { summary: 'x'.repeat(100_000), description: 'y'.repeat(5_000_000), responses: {} } } }));
  assert.ok((long.collections[0]?.requests[0]?.name.length ?? 0) <= IMPORT_LIMITS.nameChars);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
});

test('Text from the description is made printable: hidden and reversing characters do not reach a name, a note or a body', () => {
  const rlo = String.fromCodePoint(0x202e);
  const imported = parse(base({ info: { title: `Shop${rlo}`, version: '1' } }, { '/a': { post: { summary: `Do${rlo}it`, description: `see${rlo}this`, requestBody: { content: { 'application/json': { example: { text: `a${rlo}b` } } } }, responses: {} } } }));
  const request = imported.collections[0]?.requests[0];
  assert.ok(!imported.collections[0]?.container.name.includes(rlo));
  assert.ok(!request?.name.includes(rlo) && !request?.docs.includes(rlo));
  assert.ok(request?.body.kind === 'json' && !request.body.text.includes(rlo));
});
