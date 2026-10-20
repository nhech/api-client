'use strict';
/*
 * Writes a made-up Thunder Client v4 data folder (the layout the importer reads) so the importer can be tried without Thunder
 * Client installed. Everything here is invented: the hosts are .invalid or example domains, and the "secrets" are obvious
 * placeholders. It is modelled on the facts in docs/SPEC.vi.md, so it shows what the importer does, not what a real file holds.
 *
 *   node samples/make-sample.cjs [target]      default: samples/thunder-data
 */
const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(process.argv[2] || path.join(__dirname, 'thunder-data'));
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`${target} is not empty; remove it first.`);
  process.exit(1);
}
fs.mkdirSync(path.join(target, 'collections'), { recursive: true });
fs.mkdirSync(path.join(target, 'environments'), { recursive: true });
const write = (rel, value) => fs.writeFileSync(path.join(target, rel), JSON.stringify(value, null, 2));

let n = 0;
const stamp = () => `2026-09-${String(10 + (n++ % 18)).padStart(2, '0')}T09:00:00.000Z`;
const request = (colId, containerId, sortNum, name, extra) => ({
  _id: `req-${colId}-${sortNum}`, colId, containerId, name, url: '', method: 'GET', sortNum, created: stamp(), modified: stamp(),
  headers: [], params: [], tests: [], ...extra
});

// ---- 1. Pet Store: inheritance (base URL, header, bearer, test) over two folder levels ----
const pets = 'col-pets';
write('collections/tc_col_pet-store.json', {
  _id: pets, colName: 'Pet Store', created: stamp(), sortNum: 10000,
  settings: {
    headers: [{ name: 'Accept', value: 'application/json' }],
    auth: { type: 'bearer', bearer: '{{petstore_token}}' },
    options: { baseUrl: '{{baseUrl}}' },
    tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }],
    docs: ['The sample pet store API.', 'Made up for trying the importer.']
  },
  folders: [
    { _id: 'f-pets', name: 'Pets', containerId: '', created: stamp(), sortNum: 10000 },
    { _id: 'f-admin', name: 'Admin', containerId: 'f-pets', created: stamp(), sortNum: 20000, settings: { headers: [{ name: 'X-Admin-Key', value: 'demo-admin-key-0001' }], auth: { type: 'bearer', bearer: 'demo-admin-token-abc123' } } },
    { _id: 'f-store', name: 'Store', containerId: '', created: stamp(), sortNum: 20000 }
  ],
  requests: [
    request(pets, 'f-pets', 10000, 'List pets', {
      url: '/pets?limit=10', params: [{ name: 'limit', value: '10' }, { name: 'status', value: 'sold', isDisabled: true }],
      headers: [{ name: 'Accept', value: '*/*' }, { name: 'User-Agent', value: 'Thunder Client (https://www.thunderclient.com)' }]
    }),
    request(pets, 'f-pets', 20000, 'Get pet', { url: '/pets/:petId', params: [{ name: 'petId', value: '{{petId}}', isPath: true }] }),
    request(pets, 'f-pets', 30000, 'Create pet', {
      method: 'POST', url: '/pets', body: { type: 'json', raw: ['{', '  "name": "Rex",', '  "tag": "dog"', '}'] },
      tests: [
        { type: 'res-code', custom: '', action: 'equal', value: '201' },
        { type: 'json-query', custom: 'json.id', action: 'istype', value: 'number' },
        { type: 'set-env-var', custom: 'json.id', action: 'setto', value: '{{petId}}' }
      ]
    }),
    request(pets, 'f-pets', 40000, 'Update pet', { method: 'PUT', url: '/pets/:petId', params: [{ name: 'petId', value: '{{petId}}', isPath: true }], body: { type: 'json', raw: '{"tag":"cat"}' } }),
    request(pets, 'f-pets', 50000, 'Delete pet', { method: 'DELETE', url: '/pets/:petId', params: [{ name: 'petId', value: '{{petId}}', isPath: true }], auth: { type: 'none' } }),
    request(pets, 'f-admin', 10000, 'Purge cache', { method: 'POST', url: '/admin/cache/purge', docs: 'Needs the admin token.' }),
    request(pets, 'f-store', 10000, 'Place order', {
      method: 'POST', url: '/store/orders',
      body: { type: 'formencoded', form: [{ name: 'petId', value: '{{petId}}' }, { name: 'quantity', value: '1' }, { name: 'coupon', value: 'SPRING', isDisabled: true }] }
    }),
    request(pets, '', 10000, 'Health', { url: 'https://status.example.invalid/health', auth: { type: 'none' } }),
    { ...request(pets, '', 99000, 'old call', { url: 'https://old.example.invalid/' }), colId: 'history' }
  ]
});

// ---- 2. Weather: a key in the query, GraphQL, a script, a request that only runs a script ----
const weather = 'col-weather';
write('collections/tc_col_weather.json', {
  _id: weather, colName: 'Weather', created: stamp(), sortNum: 20000, settings: {}, folders: [],
  requests: [
    request(weather, '', 10000, 'Current weather', {
      url: 'https://weather.example.invalid/v1/current?city=Hanoi&api_key=demo-weather-key-777',
      params: [{ name: 'city', value: 'Hanoi' }, { name: 'api_key', value: 'demo-weather-key-777' }],
      tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }, { type: 'json-query', custom: 'json.main.temp', action: '>', value: '-100' }]
    }),
    request(weather, '', 20000, 'Forecast (GraphQL)', {
      method: 'POST', url: 'https://weather.example.invalid/graphql',
      body: { type: 'graphql', graphql: { query: ['query Forecast($city: String!) {', '  forecast(city: $city) { day high low }', '}'], variables: '{"city":"Hanoi"}' } }
    }),
    request(weather, '', 25000, 'Markers in a text body', { method: 'POST', url: 'https://weather.example.invalid/v1/notes', body: { type: 'text', raw: ['first line', '# looks like a comment', '// looks like a comment too', 'last line'] } }),
    request(weather, '', 26000, 'Separator in a text body', { method: 'POST', url: 'https://weather.example.invalid/v1/notes2', body: { type: 'text', raw: ['first line', '### looks like the next request', 'last line'] } }),
    request(weather, '', 27000, 'A file include in a text body', { method: 'POST', url: 'https://weather.example.invalid/v1/notes3', body: { type: 'text', raw: ['hello', '< ../secret.txt', 'bye'] } }),
    request(weather, '', 28000, 'Multipart with a hash line', { method: 'POST', url: 'https://weather.example.invalid/v1/upload', body: { type: 'formdata', form: [{ name: 'note', value: 'line one\n# line two' }], files: [{ name: 'file', value: 'data/q.csv' }] } }),
    request(weather, '', 28500, 'Dynamic variables', { url: 'https://weather.example.invalid/v1/dyn/{{#guid}}/{{#number, 1, 9}}/{{#number}}' }),
    // Text that httpYac would run, or that would read the environment of whoever presses Send (the importer must make it harmless).
    request(weather, '', 29000, 'Expression in a text body', { method: 'POST', url: 'https://weather.example.invalid/v1/e1', body: { type: 'text', raw: 'value={{ process.env.HY_SECRET_PROBE }}' } }),
    request(weather, '', 29100, 'Process env in a URL', { url: 'https://weather.example.invalid/v1/e2?p={{$processEnv HY_SECRET_PROBE}}' }),
    request(weather, '', 29200, 'Expression in a header', { url: 'https://weather.example.invalid/v1/e3', headers: [{ name: 'X-Probe', value: "{{ (global.__ran = 1, process.env.HY_SECRET_PROBE) }}" }] }),
    request(weather, '', 30000, 'With a script', {
      url: 'https://weather.example.invalid/v1/ping',
      preReq: { inlineScripts: [{ script: ['tc.setVar("started", Date.now());'] }] },
      postReq: { inlineScripts: [{ script: ['tc.test("fast", () => tc.response.time < 500);'] }] }
    })
  ]
});

// ---- 3. Internal Admin: basic auth, multipart with a file, and things that cannot be converted ----
const admin = 'col-admin';
write('collections/tc_col_internal-admin.json', {
  _id: admin, colName: 'Internal Admin', created: stamp(), sortNum: 30000, settings: {}, folders: [],
  requests: [
    request(admin, '', 10000, 'Report (basic auth)', { url: 'https://admin.example.invalid/report', auth: { type: 'basic', basic: { username: 'admin', password: 'demo-basic-password-xyz' } } }),
    request(admin, '', 20000, 'Upload CSV', {
      method: 'POST', url: 'https://admin.example.invalid/import',
      body: { type: 'formdata', form: [{ name: 'title', value: 'Quarterly' }], files: [{ name: 'file', value: 'data/quarterly.csv' }] }
    }),
    request(admin, '', 30000, 'Live feed', { reqType: 'ws', url: 'wss://admin.example.invalid/live' }),
    request(admin, '', 40000, 'OAuth call', { url: 'https://admin.example.invalid/me', auth: { type: 'oauth2', oauth2: { grantType: 'client_credentials', clientId: 'demo', clientSecret: 'demo-oauth-secret' } } })
  ]
});

// ---- 4. Dice: the same dynamic number 24 times, to see from the tools that the whole range is used, ends included ----
const dice = 'col-dice';
write('collections/tc_col_dice.json', {
  _id: dice, colName: 'Dice', created: stamp(), sortNum: 40000, settings: {}, folders: [],
  requests: [
    request(dice, '', 1000, 'Time', { url: 'https://dice.example.invalid/time/{{#dateISO}}' }),
    ...Array.from({ length: 24 }, (_, i) => request(dice, '', 2000 + i, `Roll ${String(i + 1).padStart(2, '0')}`, { url: `https://dice.example.invalid/roll/{{#number, 1, 3}}?n=${i + 1}` }))
  ]
});

// ---- environments: named, default, shared, local, encrypted ----
write('environments/tc_env_dev.json', {
  _id: 'env-dev', name: 'dev', default: true, sortNum: 10000, created: stamp(),
  data: [
    { name: 'baseUrl', value: 'https://dev.pets.example.invalid' },
    { name: 'petId', value: '1' },
    { name: 'petstore_token', value: 'demo-dev-token-111' },
    { name: 'legacy_secret', value: '', encrypted: true }
  ]
});
write('environments/tc_env_prod.json', {
  _id: 'env-prod', name: 'prod', sortNum: 20000, created: stamp(),
  data: [{ name: 'baseUrl', value: 'https://pets.example.invalid' }, { name: 'petId', value: '42' }, { name: 'petstore_token', value: '{{from_vault}}' }]
});
write('environments/tc_env_shared.json', { _id: 'env-shared', name: 'Shared', global: true, sortNum: 30000, created: stamp(), data: [{ name: 'region', value: 'ap-southeast-1' }] });
write('environments/tc_env_local.json', { _id: 'env-local', name: 'My machine', global: true, local: true, sortNum: 40000, created: stamp(), data: [{ name: 'proxy', value: 'http://localhost:8888' }] });

console.log(`Sample Thunder Client data written to ${target}`);
