import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import { parsePostman } from '../../src/importers/postman';
import { parseCurl } from '../../src/importers/curl';
import { thunderToImported } from '../../src/importers/thunder';
import { buildTree } from '../../src/normalize/build';
import { writeImported, writeRequestInto } from '../../src/storage/import';
import { Store, type ContainerNode, type RequestNode } from '../../src/storage/store';
import { CANARIES, CASES } from '../fixtures/cases';
import { MemoryFs } from '../support/memory-fs';

/** What was imported is written as the files of the client, in the order it came in, with no credential in a shared file. */

function counting(): Clock {
  let tick = 1_700_000_000_000;
  let draw = 0;
  return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } };
}
const setup = () => { const fs = new MemoryFs(); return { fs, store: new Store(fs, counting()) }; };

const SHOP = {
  info: { name: 'Shop', description: 'The shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-collection-token' }] },
  variable: [{ key: 'base', value: 'https://api.test' }, { key: 'db_password', value: 'hunter22' }],
  item: [
    { name: 'Zebra request', request: { method: 'GET', url: '{{base}}/z' } },
    { name: 'Users', item: [
      { name: 'Zed', request: { method: 'GET', url: '{{base}}/users/zed' } },
      { name: 'Ann', request: { method: 'POST', url: '{{base}}/users', header: [{ key: 'X-Api-Key', value: 'key-literal-1' }], body: { mode: 'raw', raw: '{"name":"ann"}', options: { raw: { language: 'json' } } } } }
    ] },
    { name: 'Admin', item: [] },
    { name: 'Alpha request', request: { method: 'DELETE', url: '{{base}}/a' } }
  ]
};

test('A Postman collection is written with its folders and its order, not sorted', async () => {
  const { fs, store } = setup();
  const result = parsePostman(JSON.stringify(SHOP));
  assert.ok(result.ok);
  const written = await writeImported(store, result.imported);
  assert.deepEqual(written.counts, { collections: 1, folders: 2, requests: 4, environments: 0 });
  assert.deepEqual(written.collections, [{ name: 'Shop', path: 'api-client/collections/shop' }]);
  const loaded = await store.load();
  assert.deepEqual([loaded.broken, loaded.notes], [[], []]);
  const shop = loaded.collections[0] as ContainerNode;
  assert.deepEqual(shop.children.map(child => `${child.kind}:${child.slug}`), ['folder:users', 'folder:admin', 'request:zebra-request', 'request:alpha-request'], 'the order of the source: its folders, then its requests');
  const users = shop.children[0] as ContainerNode;
  assert.deepEqual(users.children.map(child => child.slug), ['zed', 'ann']);
  const ann = users.children[1] as RequestNode;
  assert.deepEqual([ann.request.method, ann.request.url, ann.request.body], ['POST', '{{base}}/users', { kind: 'json', text: '{"name":"ann"}' }]);
  assert.equal(shop.container.docs, 'The shop');
  assert.ok(fs.files.has('api-client/.gitignore'));
});

test('A credential is in the file for secret values and in no shared file', async () => {
  const { fs, store } = setup();
  const result = parsePostman(JSON.stringify(SHOP));
  assert.ok(result.ok);
  await writeImported(store, result.imported);
  for (const [path, content] of fs.files) {
    if (path.endsWith('.local.yml')) continue;
    for (const secret of ['literal-collection-token', 'key-literal-1', 'hunter22']) assert.ok(!content.includes(secret), `${path} holds ${secret}`);
  }
  const local = fs.files.get('api-client/collections/shop/collection.local.yml') ?? '';
  for (const secret of ['literal-collection-token', 'key-literal-1', 'hunter22']) assert.ok(local.includes(secret), `the file of secrets holds ${secret}`);
  assert.ok((fs.files.get('api-client/.gitignore') ?? '').includes('*.local.yml'), 'Git is told to ignore it');
  const loaded = await store.load();
  const shop = loaded.collections[0] as ContainerNode;
  assert.deepEqual(shop.container.vars.filter(variable => variable.secret).map(variable => [variable.name, variable.value]), [
    ['db_password', 'hunter22'], ['secret_shop_bearer_token', 'literal-collection-token'], ['secret_shop_header_x_api_key', 'key-literal-1']
  ], 'read back with the values, from the file next to it');
});

test('An environment is written with its secret values in the file that Git ignores', async () => {
  const { fs, store } = setup();
  const result = parsePostman(JSON.stringify({ name: 'Staging', values: [{ key: 'host', value: 'https://s.test' }, { key: 'api_token', value: 'tok-value-9', type: 'secret' }] }));
  assert.ok(result.ok);
  const written = await writeImported(store, result.imported);
  assert.deepEqual(written.counts, { collections: 0, folders: 0, requests: 0, environments: 1 });
  assert.ok(!(fs.files.get('api-client/environments/staging.env.yml') ?? '').includes('tok-value-9'));
  assert.match(fs.files.get('api-client/environments/staging.env.local.yml') ?? '', /api_token: tok-value-9/);
  const loaded = await store.load();
  assert.deepEqual(loaded.environments[0]?.environment.vars.map(variable => [variable.name, variable.value, variable.secret]), [['host', 'https://s.test', false], ['api_token', 'tok-value-9', true]]);
});

test('Two imports of the same collection do not overwrite each other', async () => {
  const { store } = setup();
  const result = parsePostman(JSON.stringify(SHOP));
  assert.ok(result.ok);
  const first = await writeImported(store, result.imported);
  const second = await writeImported(store, result.imported);
  assert.deepEqual([first.collections[0]?.path, second.collections[0]?.path], ['api-client/collections/shop', 'api-client/collections/shop-2']);
  assert.equal((await store.load()).collections.length, 2);
});

test('Every fixture of Thunder Client is written and loads again without a problem', async () => {
  for (const found of CASES) {
    const { fs, store } = setup();
    const imported = thunderToImported(buildTree(found.build()));
    const written = await writeImported(store, imported);
    const loaded = await store.load();
    assert.deepEqual(loaded.broken, [], found.id);
    assert.equal(loaded.collections.length, imported.collections.length, found.id);
    assert.equal(loaded.environments.length, imported.environments.length, found.id);
    const requests = (node: ContainerNode): number => node.children.reduce((sum, child) => sum + (child.kind === 'request' ? 1 : requests(child)), 0);
    assert.equal(loaded.collections.reduce((sum, collection) => sum + requests(collection), 0), written.counts.requests, found.id);
    for (const [path, content] of fs.files) {
      if (path.endsWith('.local.yml')) continue;
      for (const canary of CANARIES) {
        // A canary that is the value of an environment variable that is not secret by its name stays in the shared file: that is what the data said.
        if (path.includes('/environments/') && found.id !== 'f10-secrets') continue;
        assert.ok(!content.includes(canary), `${found.id}: ${path} holds ${canary}`);
      }
    }
  }
});

test('A request from a cURL command is added to a collection, and its credential goes to a secret variable of it', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const parsed = parseCurl("curl -X POST https://api.test/items -H 'Authorization: Bearer abc.def.ghi' -H 'Accept: application/json' -d '{\"a\":1}' -H 'Content-Type: application/json'");
  assert.ok(parsed.ok);
  const { node, moved } = await writeRequestInto(store, shop, parsed.request);
  assert.equal(moved, 1);
  assert.equal(node.path, 'api-client/collections/shop/post-items.req.yml');
  const text = fs.files.get(node.path) ?? '';
  assert.ok(!text.includes('abc.def.ghi'));
  assert.match(text, /Bearer \{\{secret_shop_header_authorization\}\}/);
  assert.match(fs.files.get('api-client/collections/shop/collection.local.yml') ?? '', /secret_shop_header_authorization: abc\.def\.ghi/);
  const loaded = await store.load();
  const reloaded = loaded.collections[0] as ContainerNode;
  assert.deepEqual(reloaded.container.vars.map(variable => [variable.name, variable.secret, variable.value]), [['secret_shop_header_authorization', true, 'abc.def.ghi']]);
  // A second command with the same credential makes no second variable.
  const again = await writeRequestInto(store, reloaded, parsed.request);
  assert.equal(again.moved, 1);
  assert.equal(((await store.load()).collections[0] as ContainerNode).container.vars.length, 1);
});

test('A command with nothing secret in it changes nothing but the new file', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const before = fs.files.get('api-client/collections/shop/collection.yml');
  const parsed = parseCurl('curl https://api.test/health');
  assert.ok(parsed.ok);
  const { moved } = await writeRequestInto(store, shop, parsed.request);
  assert.equal(moved, 0);
  assert.equal(fs.files.get('api-client/collections/shop/collection.yml'), before);
  assert.ok(!fs.files.has('api-client/collections/shop/collection.local.yml'));
});

test('A write that is cancelled stops between two files', async () => {
  const { store } = setup();
  const result = parsePostman(JSON.stringify(SHOP));
  assert.ok(result.ok);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeImported(store, result.imported, controller.signal));
  assert.deepEqual((await store.load()).collections, []);
});

test('A credential never takes the name of a variable the collection already has, and a value that one holds is used again', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const withOld = await store.saveContainer(shop, { ...shop.container, vars: [{ name: 'secret_shop_header_authorization', value: 'old-token', secret: true, enabled: true }] });
  const fresh = parseCurl("curl https://api.test/a -H 'Authorization: Bearer new-token'");
  assert.ok(fresh.ok);
  const first = await writeRequestInto(store, withOld, fresh.request);
  assert.match(fs.files.get(first.node.path) ?? '', /Bearer \{\{secret_shop_header_authorization_2\}\}/, 'the new value is a new variable');
  const loaded = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(loaded.container.vars.map(variable => [variable.name, variable.value]), [['secret_shop_header_authorization', 'old-token'], ['secret_shop_header_authorization_2', 'new-token']]);
  const same = parseCurl("curl https://api.test/b -H 'Authorization: Bearer old-token'");
  assert.ok(same.ok);
  const second = await writeRequestInto(store, loaded, same.request);
  assert.match(fs.files.get(second.node.path) ?? '', /Bearer \{\{secret_shop_header_authorization\}\}/, 'the value that is already held is used as it is');
  assert.equal(((await store.load()).collections[0] as ContainerNode).container.vars.length, 2, 'and no variable was made for it');
});
