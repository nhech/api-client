import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, convertTree } from '../../src';
import type { ImpContainer, ImpRequest, ImportModel } from '../../src';
import { file, folder, req, source, v4 } from '../support/source';

const C1 = 'CANARY-bearer-token-AAA';
const C2 = 'CANARY-basic-password-BBB';
const C3 = 'CANARY-header-credential-CCC';
const C4 = 'CANARY-disabled-header-DDD';
const C5 = 'CANARY-query-api-key-EEE';
const C6 = 'CANARY-form-password-FFF';
const C7 = 'CANARY-api-key-header-GGG';

const run = (collection: object, moveSecrets = true, ...more: ReturnType<typeof file>[]): ImportModel =>
  convertTree(buildTree(source(file('collections/tc_col_a.json', 'v4-collection', collection), ...more)), { moveSecrets });
const all = (container: ImpContainer): ImpRequest[] => [...container.requests, ...container.folders.flatMap(all)];
const only = (model: ImportModel): ImpRequest => all(model.collections[0]!.root)[0]!;
const findings = (model: ImportModel) => model.findings.map(f => `${f.code}@${f.where}`);

test('A request shaped like a real export converts: the query is in the URL once, Thunder\'s defaults are gone, the token is a variable', () => {
  const model = run(v4('RDP', [folder('f1', 'ESG')], [req('ESG - Basic', 'f1', {
    method: 'get',
    url: 'https://api.example/data/{{rdp_version_esg}}/views/basic?universe={{symbol}}',
    params: [{ name: 'universe', value: '{{symbol}}' }],
    headers: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'Thunder Client (https://www.thunderclient.com)' }],
    auth: { type: 'bearer', bearer: '{{access_token}}' },
    tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }, { type: 'Content-Type', custom: '', action: 'equal', value: 'application/json; charset=utf-8' }]
  })]));
  const request = only(model);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://api.example/data/{{rdp_version_esg}}/views/basic?universe={{symbol}}');
  assert.deepEqual(request.headers, []);
  assert.deepEqual(request.auth, { kind: 'bearer', token: { value: '{{access_token}}', secret: false } });
  assert.deepEqual(request.assertions, [{ target: 'status', op: '==', expected: '200' }, { target: 'header', name: 'Content-Type', op: '==', expected: 'application/json; charset=utf-8' }]);
  assert.deepEqual(findings(model), ['TC-HEADER-DEFAULT-DROPPED@RDP'], 'the only note is the default headers, counted once for the collection');
  assert.equal(model.collections[0]?.root.folders[0]?.requests.length, 1);
});

test('A form body, its Content-Type and the captures of a login request', () => {
  const request = only(run(v4('Auth', [], [req('login', '', {
    method: 'POST', url: '{{base}}/token',
    body: { type: 'formencoded', form: [{ name: 'username', value: '{{u}}' }, { name: 'grant_type', value: 'password' }] },
    tests: [{ type: 'set-env-var', custom: 'json.access_token', action: 'setto', value: '{{access_token}}' }, { type: 'set-env-var', custom: 'json.refresh_token', action: 'setto', value: '{{refresh_token}}' }]
  })])));
  assert.deepEqual(request.headers.map(h => `${h.name}: ${h.value}`), ['Content-Type: application/x-www-form-urlencoded']);
  assert.equal(request.body?.kind, 'form');
  assert.deepEqual(request.captures.map(c => `${c.variable} = ${c.source}`), ['access_token = json $.access_token', 'refresh_token = json $.refresh_token']);
});

test('Inheritance is applied: base URL, headers, authentication and tests of the levels above reach the request', () => {
  const model = run(v4('Shop',
    [folder('f1', 'Orders', '', { settings: { headers: [{ name: 'X-Tenant', value: 'acme' }], auth: { type: 'bearer', bearer: '{{token}}' }, options: { baseUrl: 'https://orders.example' } } }), folder('f2', 'Admin', 'f1')],
    [req('list', 'f2', { url: '/orders', auth: { type: 'inherit' } }), req('open', 'f2', { url: 'https://open.example/x', auth: { type: 'none' } })],
    { settings: { headers: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Tenant', value: 'default' }], tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }] } }
  ));
  const [list, open] = all(model.collections[0]!.root);
  assert.equal(list?.url, 'https://orders.example/orders');
  assert.deepEqual(list?.headers.map(h => `${h.name}: ${h.value}`), ['X-Tenant: acme', 'Accept: application/json']);
  assert.deepEqual(list?.auth, { kind: 'bearer', token: { value: '{{token}}', secret: false } });
  assert.deepEqual(list?.assertions, [{ target: 'status', op: '==', expected: '200' }]);
  assert.equal(open?.url, 'https://open.example/x', 'an absolute URL is not prefixed');
  assert.equal(open?.auth, undefined, 'its own "none" is kept');
  assert.deepEqual(findings(model).sort(), ['TC-INHERIT-AUTH@Shop', 'TC-INHERIT-BASEURL@Shop', 'TC-INHERIT-HEADERS@Shop', 'TC-INHERIT-TESTS@Shop']);
  assert.match(model.findings.find(f => f.code === 'TC-INHERIT-HEADERS')?.message ?? '', /^2 requests received headers/);
});

test('An explicit Authorization header wins over authentication, and says so', () => {
  const model = run(v4('A', [], [req('r', '', { auth: { type: 'bearer', bearer: '{{t}}' }, headers: [{ name: 'authorization', value: 'Bearer {{other}}' }] })]));
  assert.equal(only(model).auth, undefined);
  assert.deepEqual(findings(model), ['TC-AUTH-HEADER-CONFLICT@A / r']);
});

test('A request that is not HTTP is skipped, listed for the report, and a request with an invalid method gets GET', () => {
  const model = run(v4('Live', [], [req('socket', '', { reqType: 'ws' }), req('events', '', { reqType: 'sse' }), req('rpc', '', { reqType: 'grpc' }), req('what', '', { reqType: 'odd kind' }), req('gql', '', { reqType: 'graphql' }), req('bad', '', { method: 'GET /x' })]));
  assert.deepEqual(all(model.collections[0]!.root).map(r => `${r.name}:${r.method}`), ['bad:GET', 'gql:GET']);
  assert.deepEqual(model.skipped, [{ collection: 'Live', request: 'events', reason: 'sse request' }, { collection: 'Live', request: 'rpc', reason: 'grpc request' }, { collection: 'Live', request: 'socket', reason: 'ws request' }, { collection: 'Live', request: 'what', reason: '<other> request' }]);
  assert.deepEqual(findings(model).filter(f => f.startsWith('TC-REQTYPE')).length, 4);
  assert.ok(findings(model).includes('TC-METHOD-INVALID@Live / bad'));
});

test('Unsupported authentication, bodies and tests are named in the notes and findings, never with their values', () => {
  const model = run(v4('U', [], [req('r', '', {
    auth: { type: 'oauth2', oauth2: { clientSecret: 'OAUTH-SECRET-CANARY', grantType: 'x' } },
    body: { type: 'binary', raw: 'BINARY-CANARY' },
    tests: [{ type: 'res-body', action: 'schema', value: '{"SCHEMA-CANARY":1}' }]
  })]));
  const request = only(model);
  assert.deepEqual(request.notes, ['[auth oauth2 not imported; settings: clientSecret, grantType]', '[body not imported: binary]']);
  assert.deepEqual(findings(model).sort(), ['TC-AUTH-OAUTH2@U / r', 'TC-BODY-UNSUPPORTED@U / r', 'TC-TEST-UNSUPPORTED@U / r']);
  assert.ok(!JSON.stringify(model).includes('CANARY'), 'no value reached the model');
});

test('Scripts are kept as blocks to be written as comments, and "run first" and "only scripts" are reported', () => {
  const model = run(v4('S', [folder('f', 'F', '', { settings: { preReq: { inlineScripts: [{ script: ['folder pre'] }], runRequests: ['x'], options: { skipRequest: true } } } })], [req('r', 'f', { preReq: { inlineScripts: [{ script: ['own pre'] }] }, postReq: { inlineScripts: [{ script: ['own post'] }] } })]));
  const request = only(model);
  assert.deepEqual(request.skippedScripts, [{ phase: 'pre', lines: ['folder pre'], from: 'F' }, { phase: 'pre', lines: ['own pre'] }, { phase: 'post', lines: ['own post'] }]);
  assert.deepEqual(findings(model).sort(), ['TC-PREREQ-RUN@S / r', 'TC-SCRIPT-SKIPPED@S / r']);
  assert.match(model.findings.find(f => f.code === 'TC-SCRIPT-SKIPPED')?.message ?? '', /3 scripts were not imported.*only runs scripts/);
});

test('Dynamic variables are rewritten where they can be and listed where they cannot, per collection', () => {
  const model = run(v4('D', [], [req('r', '', { url: 'https://h/{{#guid}}/{{#date}}', headers: [{ name: 'X-Id', value: '{{#number, 1, 9}}' }], body: { type: 'json', raw: '{"e":"{{#email}}","d":"{{#date}}"}' } })]));
  const request = only(model);
  assert.equal(request.url, 'https://h/{{$guid}}/{{#date}}');
  assert.equal(request.headers.find(h => h.name === 'X-Id')?.value, '{{$randomInt 1 10}}');
  assert.deepEqual(findings(model), ['TC-SYSVAR-UNMAPPED@D']);
  assert.match(model.findings[0]?.message ?? '', /date, email/);
});

test('A value with a line break cannot start a new line of the file', () => {
  const model = run(v4('L', [], [req('r', '', { url: 'https://h/a\nPOST /evil', headers: [{ name: 'X-A', value: 'x\r\nX-Injected: 1' }, { name: 'Bad\nName', value: 'v' }] })]));
  const request = only(model);
  assert.ok(!request.url.includes('\n') && !request.url.includes('\r'));
  for (const header of request.headers) assert.ok(!/[\r\n]/.test(header.name + header.value), header.name);
  assert.deepEqual(findings(model), ['TC-LINEBREAK-REPLACED@L / r']);
});

test('Secrets: with moving on, no literal credential is left anywhere in the model but the private environment', () => {
  const model = run(v4('Shop', [], [req('r', '', {
    url: `https://h/x?api_key=${C5}&page=1`, params: [{ name: 'api_key', value: C5 }, { name: 'page', value: '1' }, { name: 'secret_off', value: 'off-value-canary', isDisabled: true }],
    headers: [{ name: 'Authorization', value: `Bearer ${C3}` }, { name: 'X-Api-Key', value: C7 }, { name: 'Authorization', value: `Bearer ${C4}`, isDisabled: true }, { name: 'Accept', value: 'application/json' }],
    body: { type: 'formencoded', form: [{ name: 'user', value: 'ok' }, { name: 'password', value: C6 }] }
  }), req('bearer', '', { auth: { type: 'bearer', bearer: C1 } }), req('basic', '', { auth: { type: 'basic', basic: { username: 'user-name', password: C2 } } })]));
  const text = JSON.stringify({ collections: model.collections, skipped: model.skipped, findings: model.findings });
  for (const canary of [C1, C2, C3, C4, C5, C6, C7, 'off-value-canary']) assert.ok(!text.includes(canary), `${canary} leaked into the model`);
  const privateEnv = model.environments.find(e => e.kind === 'private');
  assert.ok(privateEnv, 'the private environment exists');
  const values = privateEnv.variables.map(v => v.value);
  for (const canary of [C1, C2, C3, C4, C5, C6, C7, 'off-value-canary']) assert.ok(values.includes(canary), `${canary} is in the private file`);
  assert.ok(privateEnv.variables.every(v => v.secret && v.name.startsWith('secret_shop_')));
  assert.equal(model.stats.secretsMoved, 8);
  const r = all(model.collections[0]!.root).find(x => x.name === 'r')!;
  assert.match(r.url, /^https:\/\/h\/x\?api_key=\{\{secret_shop_query_api_key\}\}&page=1$/);
  assert.deepEqual(r.headers.map(h => `${h.enabled ? '' : '#'}${h.name}: ${h.value}`), [
    'Authorization: Bearer {{secret_shop_header_authorization}}', 'X-Api-Key: {{secret_shop_header_x_api_key}}', '#Authorization: Bearer {{secret_shop_header_authorization_2}}', 'Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'
  ]);
  assert.deepEqual(r.query.map(q => `${q.enabled ? '' : '#'}${q.name}=${q.value}`), ['api_key={{secret_shop_query_api_key}}', 'page=1', '#secret_off={{secret_shop_query_secret_off}}']);
  assert.deepEqual(r.body?.kind === 'form' ? r.body.fields.map(f => f.value) : [], ['ok', '{{secret_shop_form_password}}']);
  const bearer = all(model.collections[0]!.root).find(x => x.name === 'bearer')!;
  assert.deepEqual(bearer.auth, { kind: 'bearer', token: { value: '{{secret_shop_bearer_token}}', secret: false } });
  const basic = all(model.collections[0]!.root).find(x => x.name === 'basic')!;
  assert.deepEqual(basic.auth, { kind: 'basic', username: { value: 'user-name', secret: false }, password: { value: '{{secret_shop_basic_password}}', secret: false } });
  assert.ok(findings(model).includes('TC-SECRET-MOVED@Shop'));
});

test('Secrets: with moving off, the literals stay and every one is reported by name', () => {
  const model = run(v4('Shop', [], [req('r', '', { headers: [{ name: 'Authorization', value: `Bearer ${C3}` }], auth: { type: 'bearer', bearer: C1 } }), req('b', '', { auth: { type: 'basic', basic: { username: 'u', password: C2 } } })]), false);
  assert.equal(model.environments.some(e => e.kind === 'private'), false);
  assert.equal(model.stats.secretsMoved, 0);
  assert.deepEqual(findings(model).sort(), ['TC-AUTH-HEADER-CONFLICT@Shop / r', 'TC-SECRET-LITERAL@Shop / b', 'TC-SECRET-LITERAL@Shop / r']);
  const messages = model.findings.map(f => f.message).join(' ');
  assert.ok(!messages.includes(C1) && !messages.includes(C2) && !messages.includes(C3), 'the findings name the place, not the value');
  assert.match(messages, /Authorization/);
  assert.ok(all(model.collections[0]!.root).some(r => r.headers.some(h => h.value === `Bearer ${C3}` && h.secret)), 'marked as a secret that stays');
});

test('Findings of a collection are counted once, with how many requests were concerned', () => {
  const requests = Array.from({ length: 30 }, (_, i) => req(`r${i}`, '', { headers: [{ name: 'Accept', value: '*/*' }] }));
  const model = run(v4('Many', [], requests));
  assert.deepEqual(findings(model), ['TC-HEADER-DEFAULT-DROPPED@Many']);
  assert.match(model.findings[0]?.message ?? '', /from 30 requests\.$/);
});

test('Environments are converted with the requests, and the private secrets become one more environment', () => {
  const model = run(v4('A', [], [req('r', '', { auth: { type: 'bearer', bearer: C1 } })]), true, file('environments/tc_env_dev.json', 'v4-environment', { name: 'dev', data: [{ name: 'baseUrl', value: 'https://dev' }] }));
  assert.deepEqual(model.environments.map(e => `${e.name}:${e.kind}`), ['dev:named', 'Imported secrets:private']);
});

test('The model does not change the tree it was made from', () => {
  const tree = buildTree(source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [folder('f', 'F', '', { settings: { headers: [{ name: 'X', value: '1' }] } })], [req('r', 'f', { headers: [{ name: 'Accept', value: '*/*' }] })]))));
  const before = JSON.stringify(tree);
  convertTree(tree, { moveSecrets: true });
  assert.equal(JSON.stringify(tree), before);
});
