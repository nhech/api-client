import type { TcSource } from '../../src';
import type { ImportPipelineOptions } from '../../src/import';
import { file, folder, req, source, v4 } from '../support/source';

/**
 * The fixtures of spec 10.1 that can be built in memory. All names and values are made up; the secrets are canary strings.
 * A fixture is a function so that every test gets its own copy it may change.
 *
 * Invisible characters and emoji are written as code points, never as characters.
 */
export const CANARY = {
  bearer: 'CANARY-bearer-AAAA',
  basicPassword: 'CANARY-basic-BBBB',
  authorizationHeader: 'CANARY-authz-CCCC',
  apiKeyHeader: 'CANARY-apikey-DDDD',
  disabledHeader: 'CANARY-disabled-EEEE',
  queryKey: 'CANARY-query-FFFF',
  formPassword: 'CANARY-form-GGGG',
  envVariable: 'CANARY-envvar-HHHH',
  localVariable: 'CANARY-local-IIII'
} as const;

export const CANARIES: readonly string[] = Object.values(CANARY);

const emoji = String.fromCodePoint(0x1f600);

export interface Case {
  id: string;
  /** Options of the import (the tool the files are written for, for one). */
  options?: ImportPipelineOptions;
  title: string;
  build: () => TcSource;
  /** The fixture has a golden folder: every output file is compared byte for byte. */
  golden: boolean;
}

const tests200 = [{ type: 'res-code', custom: '', action: 'equal', value: '200' }];

/** F1: an export shaped like the real one (spec 10.1): 7 requests, 4 folders, set-env-var, bearer, formencoded, the query in the URL. */
const f1 = (): TcSource => source(
  file('thunder-collection_RDP.json', 'export-collection', {
    client: 'Thunder Client', collectionName: 'RDP', dateExported: '2021-01-01T00:00:00.000Z', version: '1.1',
    folders: [
      { _id: 'f-auth', name: 'Auth', containerId: '', sortNum: 10000 },
      { _id: 'f-esg', name: 'ESG', containerId: '', sortNum: 20000 },
      { _id: 'f-basic', name: 'Basic', containerId: 'f-esg', sortNum: 10000 },
      { _id: 'f-misc', name: 'Misc', containerId: '', sortNum: 30000 }
    ],
    requests: [
      { _id: 'r1', colId: 'c', containerId: 'f-auth', name: 'Login', url: '{{base}}/auth/oauth2/{{ver}}/token', method: 'POST', sortNum: 10000,
        headers: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'Thunder Client (https://www.thunderclient.com)' }],
        body: { type: 'formencoded', raw: '', form: [{ name: 'username', value: '{{user}}' }, { name: 'password', value: '{{password}}' }, { name: 'grant_type', value: 'password' }] },
        tests: [...tests200, { type: 'set-env-var', custom: 'json.access_token', action: 'setto', value: '{{access_token}}' }, { type: 'set-env-var', custom: 'json.refresh_token', action: 'setto', value: '{{refresh_token}}' }] },
      { _id: 'r2', colId: 'c', containerId: 'f-basic', name: 'ESG - Basic', url: '{{base}}/data/{{ver}}/views/basic?universe={{symbol}}', method: 'GET', sortNum: 10000,
        params: [{ name: 'universe', value: '{{symbol}}' }], auth: { type: 'bearer', bearer: '{{access_token}}' },
        tests: [...tests200, { type: 'Content-Type', custom: '', action: 'equal', value: 'application/json; charset=utf-8' }] },
      { _id: 'r3', colId: 'c', containerId: 'f-basic', name: 'ESG - Scores', url: '{{base}}/data/{{ver}}/views/scores?universe={{symbol}}&start=2020', method: 'GET', sortNum: 20000,
        params: [{ name: 'universe', value: '{{symbol}}' }, { name: 'start', value: '2020' }, { name: 'end', value: '2021', isDisabled: true }], auth: { type: 'bearer', bearer: '{{access_token}}' } },
      { _id: 'r4', colId: 'c', containerId: 'f-misc', name: 'Create item', url: '{{base}}/items', method: 'post', sortNum: 10000,
        body: { type: 'json', raw: '{\n  "name": "item",\n  "tags": ["a", "b"]\n}' }, auth: { type: 'bearer', bearer: '{{access_token}}' },
        tests: [{ type: 'res-code', custom: '', action: '<', value: '300' }, { type: 'json-query', custom: 'json.id', action: 'istype', value: 'number' }] },
      { _id: 'r5', colId: 'c', containerId: 'f-misc', name: 'Delete item', url: '{{base}}/items/:id', method: 'DELETE', sortNum: 20000,
        params: [{ name: 'id', value: '{{item_id}}', isPath: true }], auth: { type: 'bearer', bearer: '{{access_token}}' } },
      { _id: 'r6', colId: 'c', containerId: '', name: 'Health', url: '{{base}}/health', method: 'head', sortNum: 10000 },
      { _id: 'r7', colId: 'c', containerId: '', name: 'Status page', url: 'https://status.example/api/v2/status.json', method: 'GET', sortNum: 20000 }
    ]
  }),
  file('thunder-environment_RDP.json', 'export-environment', {
    client: 'Thunder Client', environmentName: 'RDP', dateExported: '2021-01-01T00:00:00.000Z', version: '1.0',
    variables: [{ name: 'base', value: 'https://api.example' }, { name: 'ver', value: 'v1' }, { name: 'symbol', value: 'MSFT.O' }, { name: 'user', value: 'me@example.invalid' }]
  })
);

/** F3: a v4 collection with a path parameter, formencoded, basic, formdata with a file, and an attachment outside the folder. */
const f3 = (): TcSource => source(
  file('collections/tc_col_orders.json', 'v4-collection', v4('Orders', [folder('f1', 'Items')], [
    req('Get item', 'f1', { url: '{{base}}/orders/:orderId/items/:itemId', params: [{ name: 'orderId', value: '{{order}}', isPath: true }, { name: 'itemId', value: '', isPath: true }] }),
    req('Pay', '', { method: 'POST', url: '{{base}}/pay', auth: { type: 'basic', basic: { username: 'merchant', password: CANARY.basicPassword } },
      body: { type: 'formencoded', form: [{ name: 'amount', value: '12.50' }, { name: 'note', value: 'a & b = c' }, { name: 'coupon', value: 'X', isDisabled: true }] } }),
    req('Upload', '', { method: 'POST', url: '{{base}}/upload', body: { type: 'formdata', form: [{ name: 'title', value: 'Quarterly' }], files: [{ name: 'report', value: 'data/report.csv' }, { name: 'other', value: 'C:\\Users\\me\\secret.csv' }] } }),
    req('Search', '', { url: '{{base}}/search', params: [{ name: 'q', value: 'a b' }, { name: 'page', value: '2' }] })
  ]))
);

/** F4: environments with encrypted, shared, local, default and envFile. */
const f4 = (): TcSource => source(
  file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e1', name: 'dev', default: true, sortNum: 10000, envFile: '.env.dev',
    data: [{ name: 'base', value: 'https://dev.example' }, { name: 'api_token', value: CANARY.envVariable }, { name: 'legacy_key', value: '', encrypted: true }, { name: 'base', value: 'https://dev2.example' }, { name: 'off', value: 'x', isDisabled: true }] }),
  file('environments/tc_env_prod.json', 'v4-environment', { _id: 'e2', name: 'prod', sortNum: 20000, data: [{ name: 'base', value: 'https://prod.example' }, { name: 'client_secret', value: '{{from_vault}}' }] }),
  file('environments/tc_env_shared.json', 'v4-environment', { _id: 'e3', name: 'Shared', global: true, sortNum: 30000, data: [{ name: 'region', value: 'eu' }, { name: 'timeout', value: '5' }] }),
  file('environments/tc_env_local.json', 'v4-environment', { _id: 'e4', name: 'My machine', global: true, local: true, sortNum: 40000, data: [{ name: 'proxy', value: 'http://localhost:8888' }, { name: 'password', value: CANARY.localVariable }] })
);

/** F7: names that are bad file names. */
const f7 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('../x', [
    folder('f1', 'CON'), folder('f2', 'aux.txt'), folder('f3', 'trailing.'), folder('f4', `${emoji} Folder`), folder('f5', 'x'.repeat(500)),
    folder('f6', 'Same'), folder('f7', 'same'), folder('f8', 'a/b\\c:d*e?f"g<h>i|j'), folder('f9', '   '), folder('f10', 'index')
  ], [
    req('Get', 'f1'), req('Get', 'f2'), req('Get', 'f3'), req('Get', 'f4'), req('Get', 'f5'), req('one', 'f6'), req('two', 'f7'), req('Get', 'f8'), req('Get', 'f9'), req('Get', 'f10'), req('Get', '')
  ])),
  file('collections/tc_col_b.json', 'v4-collection', v4('CON', [], [req('Get')])),
  file('collections/tc_col_c.json', 'v4-collection', v4('con', [], [req('Get'), req('GET'), req('get ')]))
);

/** F9: what cannot be converted. */
const f9 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Unsupported', [], [
    req('socket', '', { reqType: 'ws', url: 'wss://x.example/' }),
    req('events', '', { reqType: 'sse', url: 'https://x.example/events' }),
    req('rpc', '', { reqType: 'grpc', url: 'x.example:443' }),
    req('digest', '', { url: 'https://x.example/d', auth: { type: 'digest', digest: { username: 'u', password: 'p' } } }),
    req('aws', '', { url: 'https://x.example/a', auth: { type: 'aws', aws: { accessKey: 'k', secretKey: 's' } } }),
    req('ntlm', '', { url: 'https://x.example/n', auth: { type: 'ntlm' } }),
    req('oauth', '', { url: 'https://x.example/o', auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientSecret: 'not shown' } } }),
    req('binary', '', { method: 'POST', url: 'https://x.example/b', body: { type: 'binary', binary: [{ name: 'f', value: 'data.bin' }] } }),
    req('script', '', { url: 'https://x.example/s', preReq: { inlineScripts: [{ script: ['tc.setVar("a", 1);'] }] }, postReq: { inlineScripts: [{ script: ['// check', 'tc.test("ok", () => {});'] }] } }),
    req('schema test', '', { url: 'https://x.example/t', tests: [{ type: 'res-body', custom: '', action: 'schema', value: '{}' }, ...tests200] })
  ]))
);

/** F10: secrets everywhere they can be. */
const f10 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Secrets', [], [
    req('bearer', '', { url: '{{base}}/a', auth: { type: 'bearer', bearer: CANARY.bearer } }),
    req('basic', '', { url: '{{base}}/b', auth: { type: 'basic', basic: { username: 'user', password: CANARY.basicPassword } } }),
    req('headers', '', { url: '{{base}}/c', headers: [{ name: 'Authorization', value: `Bearer ${CANARY.authorizationHeader}` }, { name: 'X-Api-Key', value: CANARY.apiKeyHeader }, { name: 'X-Old-Key', value: CANARY.disabledHeader, isDisabled: true }, { name: 'X-Trace', value: 'trace-1' }] }),
    req('query', '', { url: `{{base}}/d?api_key=${CANARY.queryKey}&page=1`, params: [{ name: 'api_key', value: CANARY.queryKey }, { name: 'page', value: '1' }] }),
    req('form', '', { method: 'POST', url: '{{base}}/e', body: { type: 'formencoded', form: [{ name: 'user', value: 'me' }, { name: 'password', value: CANARY.formPassword }] } })
  ])),
  file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e1', name: 'dev', data: [{ name: 'base', value: 'https://dev.example' }, { name: 'api_token', value: CANARY.envVariable }, { name: 'old_secret', value: '', encrypted: true }] })
);

/** F13: three levels of inheritance. */
const f13 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Shop',
    [
      folder('fa', 'A', '', { settings: { headers: [{ name: 'X-Tenant', value: 'acme' }, { name: 'X-Off', value: 'no', isDisabled: true }], auth: { type: 'bearer', bearer: '{{token}}' }, options: { baseUrl: 'https://a.example' }, tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }] } }),
      folder('fb', 'B', 'fa', { settings: { headers: [{ name: 'x-tenant', value: 'bee' }, { name: 'X-Level', value: 'b' }], auth: { type: 'inherit' }, options: { baseUrl: 'https://b.example/v2' }, tests: [{ type: 'res-code', custom: '', action: 'equal', value: '201' }, { type: 'res-time', custom: '', action: '<', value: '800' }] } })
    ],
    [
      req('relative', 'fb', { url: '/items' }),
      req('absolute', 'fb', { url: 'https://other.example/x' }),
      req('variable', 'fb', { url: '{{host}}/y' }),
      req('own auth none', 'fb', { url: '/z', auth: { type: 'none' } }),
      req('own header wins', 'fb', { url: '/w', headers: [{ name: 'X-TENANT', value: 'mine' }], auth: { type: 'basic', basic: { username: 'u', password: '{{pw}}' } } }),
      req('in A', 'fa', { url: '/in-a' }),
      req('at root', '', { url: '/root' })
    ],
    { settings: { headers: [{ name: 'Accept', value: 'application/json' }, { name: 'X-Tenant', value: 'default' }], options: { baseUrl: 'https://root.example' }, auth: { type: 'bearer', bearer: '{{root_token}}' }, tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }] } }
  ))
);

/** F2: the three flat files of the v3 layout, with a history entry and a request that belongs to no collection. */
const f2 = (): TcSource => source(
  file('thunderclient.json', 'v3-requests', [
    { _id: 'r1', colId: 'c1', containerId: '', name: 'list', url: '/items', method: 'GET', sortNum: 1 },
    { _id: 'r2', colId: 'c1', containerId: 'f1', name: 'create', url: '/items', method: 'POST', body: { type: 'json', raw: '{"a":1}' }, sortNum: 2 },
    { _id: 'r3', colId: 'history', name: 'old call', url: 'https://x.example/', method: 'GET' },
    { _id: 'r4', colId: 'gone', containerId: '', name: 'lost', url: 'https://x.example/lost', method: 'GET' }
  ]),
  file('thunderCollection.json', 'v3-collections', [{ _id: 'c1', colName: 'Shop', sortNum: 1, folders: [{ _id: 'f1', name: 'Admin', containerId: '' }], settings: { options: { baseUrl: 'https://v3.example' } } }]),
  file('thunderEnvironment.json', 'v3-environments', [{ _id: 'e1', name: 'dev', default: true, sortNum: 1, data: [{ name: 'host', value: 'dev.example' }] }])
);

/** F8: a broken tree: a cycle, a folder pointing nowhere, a folder that is its own parent, requests in folders that do not exist, a history entry. */
const f8 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Broken', [
    folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('lost', 'Lost', 'nowhere'), folder('self', 'Self', 'self')
  ], [req('in a', 'a'), req('in lost', 'lost'), req('nowhere', 'ghost'), { ...req('hist', ''), colId: 'history' }]))
);

/** F14: text between {{ }} that httpYac would run as JavaScript or REST Client would use to read the environment. Nothing here is run by the tests. */
const f14 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Expressions', [], [
    req('url', '', { url: "{{base}}/q?x={{ require('fs').readFileSync('/etc/passwd') }}&y={{$processEnv SECRET}}&ok={{token}}", params: [{ name: 'ok', value: '{{token}}' }] }),
    req('header', '', { url: '{{base}}/h', headers: [{ name: 'X-Evil', value: '{{ process.env.SECRET }}' }, { name: '{{ evil() }}', value: 'v' }, { name: 'X-Fine', value: '{{token}} and {{ spaced }} and {{my var}}' }] }),
    req('body', '', { method: 'POST', url: '{{base}}/b', body: { type: 'text', raw: ['first', '{{ exports.x = 1 }}', 'last {{ unclosed'] } }),
    req('form', '', { method: 'POST', url: '{{base}}/f', body: { type: 'formencoded', form: [{ name: '{{ a() }}', value: '{{ 1 + 1 }}' }, { name: 'dotted', value: '{{user.name}}' }] } }),
    req('dynamic', '', { url: '{{base}}/d/{{#guid}}/{{#number, 1, 9}}/{{#date, {year: -1}}}' }),
    req('nested', '', { url: "{{base}}/n/{{ a {{ b() }} }}/{{{ c() }}}" })
  ])),
  file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e1', name: 'dev', data: [
    { name: 'base', value: 'https://dev.example' }, { name: 'host', value: "{{ require('os').hostname() }}" }, { name: 'from_vault', value: '{{vault_value}}' }
  ] })
);

/** F15: Thunder's dynamic variables, written for each of the three tools. */
const f15 = (): TcSource => source(
  file('collections/tc_col_a.json', 'v4-collection', v4('Dynamic', [], [
    req('ids', '', { url: '{{base}}/ids/{{#guid}}' }),
    req('numbers', '', { url: '{{base}}/n/{{#number}}/{{#number, 1, 6}}/{{#number, 5}}/{{#number, 990000, 2000000}}' }),
    req('time', '', { url: '{{base}}/t/{{#dateISO}}/{{#date}}' }),
    req('left alone', '', { url: '{{base}}/x/{{#email}}/{{#bool}}/{{#date, X}}/{{#dateISO, {year: -1}}}' })
  ]))
);

export const CASES: readonly Case[] = [
  { id: 'f01-export', title: 'F1: export of a collection and an environment', build: f1, golden: true },
  { id: 'f02-v3', title: 'F2: v3 flat files', build: f2, golden: true },
  { id: 'f03-v4', title: 'F3: v4 with path parameter, basic, formdata', build: f3, golden: true },
  { id: 'f04-environments', title: 'F4: environments', build: f4, golden: true },
  { id: 'f07-names', title: 'F7: names that are bad file names', build: f7, golden: true },
  { id: 'f08-broken', title: 'F8: a broken tree', build: f8, golden: true },
  { id: 'f09-unsupported', title: 'F9: what cannot be converted', build: f9, golden: true },
  { id: 'f10-secrets', title: 'F10: secrets', build: f10, golden: true },
  { id: 'f13-inheritance', title: 'F13: inheritance over three levels', build: f13, golden: true },
  { id: 'f14-expressions', title: 'F14: code-looking text between {{ }}', build: f14, golden: true },
  { id: 'f15-dynamic-rest-client', title: 'F15: dynamic variables for REST Client', build: f15, golden: true, options: { target: 'rest-client' } },
  { id: 'f15-dynamic-httpyac', title: 'F15: dynamic variables for httpYac', build: f15, golden: true, options: { target: 'httpyac' } },
  { id: 'f15-dynamic-jetbrains', title: 'F15: dynamic variables for JetBrains', build: f15, golden: true, options: { target: 'jetbrains' } }
];
