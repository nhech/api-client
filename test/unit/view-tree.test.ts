import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import { newContainer, newRequest } from '../../src/core/model';
import { writeContainer, writeRequest } from '../../src/format/schema';
import { Store, type Loaded } from '../../src/storage/store';
import { collectionsTree, environmentsTree, findNode, methodColor, pathTo, type TreeNode } from '../../src/view/tree';
import { MemoryFs } from '../support/memory-fs';

const clock = (): Clock => { let tick = 1_700_000_000_000; let draw = 0; return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } }; };

async function sample(): Promise<{ loaded: Loaded; store: Store; fs: MemoryFs }> {
  const fs = new MemoryFs();
  const store = new Store(fs, clock());
  const shop = await store.createCollection('Pet Shop');
  const orders = await store.createFolder(shop.path, 'Orders');
  await store.createRequest(orders.path, 'List orders', { method: 'GET', url: '{{baseUrl}}/orders' });
  await store.createRequest(orders.path, 'Create order', { method: 'POST', url: '{{baseUrl}}/orders' });
  await store.createRequest(shop.path, 'Health', { method: 'get', url: 'https://x.test/health' });
  await store.createCollection('Billing');
  const dev = await store.createEnvironment('Dev');
  await store.saveEnvironment(dev, { ...dev.environment, vars: [{ name: 'a', value: '1', secret: false, enabled: true }, { name: 'b', value: '2', secret: false, enabled: true }] });
  await store.createEnvironment('Prod');
  return { loaded: await store.load(), store, fs };
}
const shape = (nodes: TreeNode[]): unknown[] => nodes.map(node => [node.kind, node.label, node.description, node.children.length > 0 ? shape(node.children) : undefined].filter(part => part !== undefined));

test('Collections, folders and requests are shown in the order they were loaded, with their method and count', async () => {
  const { loaded } = await sample();
  const tree = collectionsTree(loaded);
  assert.deepEqual(shape(tree), [
    ['collection', 'Billing', '0 requests'],
    ['collection', 'Pet Shop', '3 requests', [
      ['folder', 'Orders', '2 requests', [['request', 'Create order', 'POST'], ['request', 'List orders', 'GET']]],
      ['request', 'Health', 'GET']
    ]]
  ]);
  const shop = tree[1] as TreeNode;
  assert.deepEqual([shop.contextValue, shop.icon, shop.collapse, shop.path], ['collection', 'library', 'collapsed', 'api-client/collections/pet-shop']);
  assert.deepEqual([tree[0]?.collapse], ['none']);
  const request = findNode(tree, 'api-client/collections/pet-shop/orders/create-order.req.yml') as TreeNode;
  assert.deepEqual([request.contextValue, request.icon, request.color, request.tooltip, request.collapse], ['request', 'request', 'charts.orange', 'POST {{baseUrl}}/orders', 'none']);
  assert.equal((findNode(tree, 'api-client/collections/pet-shop/health.req.yml') as TreeNode).description, 'GET', 'the method is written in capitals');
});

test('Method colours: one per common method, grey for the rest', () => {
  assert.deepEqual(['get', 'POST', 'Put', 'patch', 'DELETE', 'head', 'OPTIONS', 'PURGE', ''].map(methodColor), ['charts.green', 'charts.orange', 'charts.blue', 'charts.purple', 'charts.red', 'charts.yellow', 'charts.yellow', 'descriptionForeground', 'descriptionForeground']);
});

test('A filter keeps what matches and the folders above it, opened; a folder that matches shows all of its content', async () => {
  const { loaded } = await sample();
  assert.deepEqual(shape(collectionsTree(loaded, 'create')), [['collection', 'Pet Shop', '3 requests', [['folder', 'Orders', '2 requests', [['request', 'Create order', 'POST']]]]]]);
  assert.deepEqual(collectionsTree(loaded, 'create').map(node => node.collapse), ['expanded']);
  assert.deepEqual(shape(collectionsTree(loaded, 'ORDERS')), [['collection', 'Pet Shop', '3 requests', [['folder', 'Orders', '2 requests', [['request', 'Create order', 'POST'], ['request', 'List orders', 'GET']]]]]], 'the folder name matches, so its requests all show');
  assert.deepEqual(shape(collectionsTree(loaded, 'x.test/health')), [['collection', 'Pet Shop', '3 requests', [['request', 'Health', 'GET']]]], 'the URL is searched');
  assert.deepEqual(shape(collectionsTree(loaded, 'post')).length, 1, 'and the method');
  assert.deepEqual(collectionsTree(loaded, 'nothing like this'), []);
  assert.deepEqual(shape(collectionsTree(loaded, 'pet shop')), shape(collectionsTree(loaded)).slice(1), 'a collection that matches by its own name shows everything in it');
  assert.deepEqual(shape(collectionsTree(loaded, 'billing')), [['collection', 'Billing', '0 requests']], 'a collection by its own name');
  assert.equal(collectionsTree(loaded, '   ').length, 2, 'blank is no filter');
});

test('A file that cannot be read is listed with its reason, and what was left out is one line with the details', async () => {
  const fs = new MemoryFs().seed({
    'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')),
    'api-client/collections/shop/ok.req.yml': writeRequest(newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'Ok')),
    'api-client/collections/shop/bad.req.yml': 'name: [oops\n',
    'api-client/collections/shop/future.req.yml': 'schema: 9\nname: Future\n',
    'api-client/collections/empty/note.txt': 'not a collection',
    'api-client/environments/bad.env.yml': 'schema: 1\n'
  });
  const loaded = await new Store(fs, clock()).load();
  const tree = collectionsTree(loaded);
  assert.deepEqual(shape(tree.filter(node => node.kind === 'collection')), [['collection', 'Shop', '1 request', [['request', 'Ok', 'GET']]]]);
  const broken = tree.filter(node => node.kind === 'broken').map(node => [node.label, node.description, node.contextValue]);
  assert.deepEqual(broken, [['bad.req.yml', 'cannot be read', 'broken'], ['future.req.yml', 'written by a newer version', 'broken']]);
  assert.match(tree.find(node => node.label === 'bad.req.yml')?.tooltip ?? '', /line 1, column 7/);
  const note = tree.find(node => node.kind === 'note') as TreeNode;
  assert.equal(note.label, '1 thing left out');
  assert.match(note.tooltip, /no collection\.yml/);
  const environments = environmentsTree(loaded, undefined);
  assert.deepEqual(environments.map(node => [node.kind, node.label, node.description]), [['broken', 'bad.env.yml', 'cannot be read']]);
  assert.deepEqual(collectionsTree(loaded, 'ok').some(node => node.kind === 'broken' || node.kind === 'note'), false, 'with a filter only matches are shown');
});

test('Environments: the active one is marked and has its own context value; the others say how many variables they hold', async () => {
  const { loaded } = await sample();
  const dev = loaded.environments.find(item => item.environment.name === 'Dev')?.environment.id;
  const tree = environmentsTree(loaded, dev);
  assert.deepEqual(tree.map(node => [node.label, node.description, node.contextValue, node.icon]), [
    ['Dev', 'active', 'environment.active', 'environment-active'], ['Prod', '0 variables', 'environment', 'environment']
  ]);
  assert.deepEqual(environmentsTree(loaded, undefined).map(node => node.description), ['2 variables', '0 variables']);
  assert.deepEqual(environmentsTree(loaded, 'no-such-id').map(node => node.contextValue), ['environment', 'environment']);
});

test('Text from a file cannot hide anything: direction controls and line breaks are made plain, and a long name is cut', async () => {
  const fs = new MemoryFs().seed({
    'api-client/collections/shop/collection.yml': writeContainer({ ...newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop'), name: 'Sh\u202eop\nname' }),
    'api-client/collections/shop/a.req.yml': writeRequest({ ...newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'x'.repeat(500)), url: 'http://x.test/\u200bsecret\nmore' })
  });
  const tree = collectionsTree(await new Store(fs, clock()).load());
  const collection = tree[0] as TreeNode;
  assert.equal(collection.label, 'Sh?op name');
  const request = collection.children[0] as TreeNode;
  assert.equal(request.label.length, 120);
  assert.ok(request.label.endsWith('\u2026'));
  assert.equal(request.tooltip, 'GET http://x.test/?secret more');
  assert.ok(!/[\u202e\u200b\u2028\n]/.test(JSON.stringify([collection.label, request.label, request.tooltip, request.description])));
});

test('A node can be found by id and by the path of ids that leads to it', async () => {
  const { loaded } = await sample();
  const tree = collectionsTree(loaded);
  const id = 'api-client/collections/pet-shop/orders/list-orders.req.yml';
  assert.equal(findNode(tree, id)?.label, 'List orders');
  assert.deepEqual(pathTo(tree, id), ['api-client/collections/pet-shop', 'api-client/collections/pet-shop/orders', id]);
  assert.equal(findNode(tree, 'nope'), undefined);
  assert.equal(pathTo(tree, 'nope'), undefined);
});
