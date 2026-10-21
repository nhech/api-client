import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_PATTERN, type Clock } from '../../src/core/clock';
import { newContainer, newRequest, type Var } from '../../src/core/model';
import { STORAGE_LIMITS } from '../../src/storage/fs';
import { Store, type ContainerNode, type RequestNode } from '../../src/storage/store';
import { writeContainer, writeEnvironment, writeRequest } from '../../src/format/schema';
import { newEnvironment } from '../../src/core/model';
import { MemoryFs } from '../support/memory-fs';

/** A clock that counts, so that every identifier is new and the same on every run. */
function counting(): Clock {
  let tick = 1_700_000_000_000;
  let draw = 0;
  return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } };
}
const setup = (fs = new MemoryFs()) => ({ fs, store: new Store(fs, counting()) });
const secretVar = (name: string, value: string): Var => ({ name, value, secret: true, enabled: true });

test('Creating a collection, a folder and requests writes the files of the layout, and a load finds them again in order', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Pet Shop');
  const orders = await store.createFolder(shop.path, 'Orders');
  const list = await store.createRequest(orders.path, 'List orders', { method: 'GET', url: '{{baseUrl}}/orders' });
  await store.createRequest(shop.path, 'Health check', { url: '{{baseUrl}}/health' });
  assert.deepEqual(fs.paths(), [
    'api-client/.gitignore', 'api-client/collections/pet-shop/collection.yml', 'api-client/collections/pet-shop/health-check.req.yml',
    'api-client/collections/pet-shop/orders/folder.yml', 'api-client/collections/pet-shop/orders/list-orders.req.yml', 'api-client/workspace.yml'
  ]);
  assert.equal(fs.files.get('api-client/.gitignore'), '*.local.yml\n.runs/\n');
  assert.match(list.request.id, ID_PATTERN);
  const loaded = await store.load();
  assert.deepEqual([loaded.broken, loaded.notes, loaded.truncated], [[], [], false]);
  assert.equal(loaded.collections.length, 1);
  const tree = loaded.collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => `${child.kind}:${child.slug}`), ['folder:orders', 'request:health-check'], 'folders first, then requests');
  const folder = tree.children[0] as ContainerNode;
  assert.equal((folder.children[0] as RequestNode).request.url, '{{baseUrl}}/orders');
});

test('Without an order, folders come first and everything is sorted by name without regard to case; the order of a folder then comes first', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  for (const name of ['beta', 'Alpha', 'gamma']) await store.createRequest(shop.path, name);
  await store.createFolder(shop.path, 'zeta folder');
  await store.createFolder(shop.path, 'Eta folder');
  let tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['eta-folder', 'zeta-folder', 'alpha', 'beta', 'gamma']);
  await store.reorder(shop.path, ['gamma', 'missing', 'zeta-folder', 'gamma']);
  tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['gamma', 'zeta-folder', 'eta-folder', 'alpha', 'beta']);
  assert.match(fs.files.get('api-client/collections/shop/collection.yml') ?? '', /order:\n  - gamma\n  - missing\n  - zeta-folder\n  - gamma\n/);
});

test('Names that give the same slug get a number, ignoring letter case, and a request and a folder never share a slug', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const first = await store.createRequest(shop.path, 'List pets');
  const second = await store.createRequest(shop.path, 'LIST PETS');
  const third = await store.createRequest(shop.path, 'list-pets');
  const folder = await store.createFolder(shop.path, 'List pets');
  assert.deepEqual([first.slug, second.slug, third.slug, folder.slug], ['list-pets', 'list-pets-2', 'list-pets-3', 'list-pets-4']);
  assert.deepEqual([first.request.name, second.request.name], ['List pets', 'LIST PETS']);
  assert.equal(fs.files.has('api-client/collections/shop/list-pets-2.req.yml'), true);
  const unsafe = await store.createRequest(shop.path, '../../etc/passwd');
  const reserved = await store.createRequest(shop.path, 'CON');
  assert.deepEqual([unsafe.slug, reserved.slug], ['etc-passwd', 'con_']);
  assert.deepEqual((await store.createRequest(shop.path, '')).slug, 'unnamed');
});

test('Saving a request under a new name renames its file, keeps its identifier and its place in the order, and keeps keys it does not know', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const a = await store.createRequest(shop.path, 'Alpha');
  await store.createRequest(shop.path, 'Beta');
  await store.reorder(shop.path, ['beta', 'alpha']);
  fs.files.set(a.path, `${fs.files.get(a.path) as string}futureKey: kept\n`);
  const loadedA = ((await store.load()).collections[0] as ContainerNode).children.find(child => child.slug === 'alpha') as RequestNode;
  const saved = await store.saveRequest(loadedA, { ...loadedA.request, name: 'Alpha prime', url: 'https://x.test' });
  assert.equal(saved.slug, 'alpha-prime');
  assert.equal(saved.request.id, a.request.id);
  assert.equal(fs.files.has(a.path), false);
  assert.match(fs.files.get(saved.path) as string, /name: Alpha prime[\s\S]*futureKey: kept/);
  const tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['beta', 'alpha-prime']);
  assert.match(fs.files.get('api-client/collections/shop/collection.yml') as string, /order:\n {2}- beta\n {2}- alpha-prime\n/);
  const sameName = await store.saveRequest(saved, { ...saved.request, method: 'POST' });
  assert.equal(sameName.path, saved.path, 'a save that keeps the name keeps the file');
});

test('A save that fails changes nothing: the old file is still there and whole', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const node = await store.createRequest(shop.path, 'Alpha', { url: 'one' });
  const before = [...fs.files.entries()];
  fs.failWrites = ['alpha-two.req.yml'];
  await assert.rejects(store.saveRequest(node, { ...node.request, name: 'Alpha two', url: 'two' }), /disk full/);
  assert.deepEqual([...fs.files.entries()], before);
});

test('Renaming a folder moves it with everything in it and fixes its entry in the parent order and the paths of its children', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const folder = await store.createFolder(shop.path, 'Old');
  await store.createRequest(folder.path, 'Inside');
  await store.createFolder(shop.path, 'Other');
  await store.reorder(shop.path, ['other', 'old']);
  const loaded = ((await store.load()).collections[0] as ContainerNode).children.find(child => child.slug === 'old') as ContainerNode;
  const renamed = await store.renameContainer(loaded, 'New name');
  assert.equal(renamed.path, 'api-client/collections/shop/new-name');
  assert.equal((renamed.children[0] as RequestNode).path, 'api-client/collections/shop/new-name/inside.req.yml');
  assert.equal(fs.files.has('api-client/collections/shop/old/folder.yml'), false);
  assert.match(fs.files.get('api-client/collections/shop/new-name/folder.yml') as string, /name: New name/);
  assert.equal(renamed.container.id, folder.container.id);
  const tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['other', 'new-name']);
});

test('Renaming a collection moves its folder; the other collections and the workspace file are not touched', async () => {
  const { fs, store } = setup();
  const one = await store.createCollection('One');
  await store.createCollection('Two');
  await store.createRequest(one.path, 'R');
  const renamed = await store.renameContainer(one, 'Uno');
  assert.equal(renamed.path, 'api-client/collections/uno');
  assert.deepEqual(fs.paths().filter(path => path.startsWith('api-client/collections/')), ['api-client/collections/two/collection.yml', 'api-client/collections/uno/collection.yml', 'api-client/collections/uno/r.req.yml']);
});

test('A request or a folder can be moved into another folder under a free name, but a folder not into itself and a collection nowhere', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const a = await store.createFolder(shop.path, 'A');
  const b = await store.createFolder(shop.path, 'B');
  const inA = await store.createRequest(a.path, 'Same');
  await store.createRequest(b.path, 'Same');
  const moved = await store.move(inA, b.path) as RequestNode;
  assert.equal(moved.path, 'api-client/collections/shop/b/same-2.req.yml');
  assert.equal(fs.files.has(inA.path), false);
  const folderMoved = await store.move({ ...b, children: [] }, a.path) as ContainerNode;
  assert.equal(folderMoved.path, 'api-client/collections/shop/a/b');
  await assert.rejects(store.move(a, `${a.path}/b`), /into itself/);
  await assert.rejects(store.move(shop, a.path), /collection cannot be moved/);
  assert.equal(await store.move(a, shop.path), a, 'moving to where it is does nothing');
});

test('A duplicate has new identifiers and the same content; a folder is copied with everything in it', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const folder = await store.createFolder(shop.path, 'Orders');
  await store.createRequest(folder.path, 'List', { url: '/orders' });
  const sub = await store.createFolder(folder.path, 'Deep');
  await store.createRequest(sub.path, 'Leaf');
  const tree = (await store.load()).collections[0] as ContainerNode;
  const copy = await store.duplicate(tree.children[0] as ContainerNode) as ContainerNode;
  assert.equal(copy.path, 'api-client/collections/shop/orders-copy');
  assert.deepEqual(fs.paths().filter(path => path.includes('orders-copy')), [
    'api-client/collections/shop/orders-copy/deep/folder.yml', 'api-client/collections/shop/orders-copy/deep/leaf.req.yml',
    'api-client/collections/shop/orders-copy/folder.yml', 'api-client/collections/shop/orders-copy/list.req.yml'
  ]);
  const loaded = await store.load();
  const ids = new Set<string>();
  const collect = (node: ContainerNode | RequestNode): void => {
    if (node.kind === 'request') { ids.add(node.request.id); return; }
    ids.add(node.container.id);
    node.children.forEach(collect);
  };
  loaded.collections.forEach(collect);
  assert.equal(ids.size, 9, 'collection, two folders and two requests, and the copy of the folders and requests: every id differs');
  const request = (tree.children[0] as ContainerNode).children[1] as RequestNode;
  const requestCopy = await store.duplicate(request) as RequestNode;
  assert.deepEqual([requestCopy.request.name, requestCopy.request.url, requestCopy.request.id === request.request.id], ['List copy', '/orders', false]);
});

test('Removing takes the entry out of the order and leaves the rest', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  const a = await store.createRequest(shop.path, 'A');
  await store.createRequest(shop.path, 'B');
  await store.reorder(shop.path, ['a', 'b']);
  await store.remove(a);
  assert.equal(fs.files.has(a.path), false);
  assert.match(fs.files.get('api-client/collections/shop/collection.yml') as string, /order:\n {2}- b\n/);
  assert.equal(((await store.load()).collections[0] as ContainerNode).children.length, 1);
  await store.remove(shop);
  assert.deepEqual((await store.load()).collections, []);
});

test('The values of secret variables go to a file that Git ignores; the shared file keeps the name and an empty value', async () => {
  const { fs, store } = setup();
  const environment = await store.createEnvironment('Dev');
  const saved = await store.saveEnvironment(environment, { ...environment.environment, vars: [{ name: 'baseUrl', value: 'https://dev.test', secret: false, enabled: true }, secretVar('token', 's3cret')] });
  assert.equal(saved.path, 'api-client/environments/dev.env.yml');
  assert.equal(fs.files.get('api-client/environments/dev.env.local.yml'), 'schema: 1\nvalues:\n  token: s3cret\n');
  assert.equal(fs.modes.get('api-client/environments/dev.env.local.yml'), 0o600);
  assert.doesNotMatch(fs.files.get(saved.path) as string, /s3cret/);
  assert.match(fs.files.get(saved.path) as string, /name: token\n {4}value: ''\n {4}secret: true/);
  assert.match(fs.files.get('api-client/.gitignore') as string, /^\*\.local\.yml$/m);
  const loaded = await store.load();
  assert.equal(loaded.environments[0]?.environment.vars.find(v => v.name === 'token')?.value, 's3cret');
  // With no secret left the file of values is removed.
  await store.saveEnvironment(loaded.environments[0] as never, { ...saved.environment, vars: [] });
  assert.equal(fs.files.has('api-client/environments/dev.env.local.yml'), false);
});

test('A secret value found in the shared file is used and reported, and moves out the next time the file is saved', async () => {
  const fs = new MemoryFs().seed({ 'api-client/environments/dev.env.yml': writeEnvironment({ ...newEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC', 'Dev'), vars: [secretVar('token', 'leaked')] }) });
  const store = new Store(fs, counting());
  const loaded = await store.load();
  const node = loaded.environments[0];
  assert.equal(node?.environment.vars[0]?.value, 'leaked');
  assert.deepEqual(node?.findings.map(f => f.path), ['vars.token']);
  await store.saveEnvironment(node as never, node?.environment as never);
  assert.doesNotMatch(fs.files.get('api-client/environments/dev.env.yml') as string, /leaked/);
  assert.match(fs.files.get('api-client/environments/dev.env.local.yml') as string, /token: leaked/);
});

test('Renaming an environment moves both of its files; the secrets are not lost', async () => {
  const { fs, store } = setup();
  const environment = await store.createEnvironment('Dev');
  const saved = await store.saveEnvironment(environment, { ...environment.environment, vars: [secretVar('token', 'abc')] });
  const renamed = await store.saveEnvironment(saved, { ...saved.environment, name: 'Staging' });
  assert.deepEqual(fs.paths().filter(path => path.includes('environments')), ['api-client/environments/staging.env.local.yml', 'api-client/environments/staging.env.yml']);
  assert.equal(renamed.slug, 'staging');
  assert.equal((await store.load()).environments[0]?.environment.vars[0]?.value, 'abc');
});

test('Secret variables of a collection, a folder and the workspace are kept out of their shared files too', async () => {
  const { fs, store } = setup();
  const shop = await store.createCollection('Shop');
  await store.saveContainer(shop, { ...shop.container, vars: [secretVar('apiKey', 'k1')] });
  const workspace = (await store.load()).workspace;
  await store.saveWorkspace(workspace, { ...workspace.file, vars: [secretVar('team', 'k2')] });
  assert.equal(fs.files.get('api-client/collections/shop/collection.local.yml'), 'schema: 1\nvalues:\n  apiKey: k1\n');
  assert.equal(fs.files.get('api-client/workspace.local.yml'), 'schema: 1\nvalues:\n  team: k2\n');
  for (const file of ['api-client/collections/shop/collection.yml', 'api-client/workspace.yml']) assert.doesNotMatch(fs.files.get(file) as string, /k1|k2/);
  const loaded = await store.load();
  assert.equal((loaded.collections[0] as ContainerNode).container.vars[0]?.value, 'k1');
  assert.equal(loaded.workspace.file.vars[0]?.value, 'k2');
});

test('Files that cannot be used are reported next to the tree and never stop the load', async () => {
  const fs = new MemoryFs().seed({
    'api-client/workspace.yml': 'schema: 1\ncollections:\n  - shop\n',
    'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')),
    'api-client/collections/shop/good.req.yml': writeRequest(newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'Good')),
    'api-client/collections/shop/bad-yaml.req.yml': 'name: [unclosed\n',
    'api-client/collections/shop/no-name.req.yml': 'schema: 1\n',
    'api-client/collections/shop/future.req.yml': 'schema: 99\nname: Future\n',
    'api-client/collections/shop/notes.txt': 'ignored',
    'api-client/collections/shop/good.http': '# a mirror, ignored',
    'api-client/collections/broken/collection.yml': 'schema: 1\nname: ""\n',
    'api-client/collections/empty/readme.md': 'not a collection',
    'api-client/environments/bad.env.yml': 'schema: 1\n',
    'api-client/environments/dev.env.local.yml': 'schema: 1\nvalues: {}\n'
  });
  fs.link('api-client/collections/shop/escape');
  const loaded = await new Store(fs, counting()).load();
  assert.deepEqual((loaded.collections[0] as ContainerNode).children.map(child => child.slug), ['good']);
  assert.deepEqual(loaded.broken.map(item => [item.path.replace('api-client/', ''), item.newer]).sort(), [
    ['collections/broken/collection.yml', false], ['collections/shop/bad-yaml.req.yml', false], ['collections/shop/future.req.yml', true],
    ['collections/shop/no-name.req.yml', false], ['environments/bad.env.yml', false]
  ]);
  assert.match(loaded.broken.find(item => item.path.endsWith('bad-yaml.req.yml'))?.findings[0]?.message ?? '', /line 1, column 7/);
  assert.deepEqual(loaded.notes.map(note => note.path.replace('api-client/', '')).sort(), ['collections/empty', 'collections/shop/escape']);
  assert.deepEqual(loaded.environments, []);
});

test('A folder without folder.yml is shown when it holds requests and gets its file when it is first changed', async () => {
  const fs = new MemoryFs().seed({
    'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')),
    'api-client/collections/shop/by hand/one.req.yml': writeRequest(newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'One')),
    'api-client/collections/shop/files/photo.png': 'binary'
  });
  const store = new Store(fs, counting());
  const tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['by hand'], 'a folder of attachments is not a folder of requests');
  const folder = tree.children[0] as ContainerNode;
  assert.equal(folder.implicit, true);
  assert.equal(folder.container.name, 'by hand');
  const renamed = await store.renameContainer(folder, 'By hand');
  assert.equal(fs.files.has('api-client/collections/shop/by-hand/folder.yml'), true);
  assert.equal(renamed.implicit, false);
});

test('Limits: too deep, too many entries and too many requests are left out and said so', async () => {
  const files: Record<string, string> = { 'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')) };
  let path = 'api-client/collections/shop';
  for (let depth = 0; depth < STORAGE_LIMITS.maxDepth + 2; depth++) {
    path += `/d${depth}`;
    files[`${path}/folder.yml`] = writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAB', `d${depth}`));
  }
  const deep = await new Store(new MemoryFs().seed(files), counting()).load();
  assert.equal(deep.truncated, true);
  assert.match(deep.notes[0]?.message ?? '', /nested more than 32 folders/);

  const many: Record<string, string> = { 'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')) };
  for (let index = 0; index < STORAGE_LIMITS.maxEntriesPerFolder + 50; index++) many[`api-client/collections/shop/r${String(index).padStart(5, '0')}.req.yml`] = writeRequest(newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', `R${index}`));
  const wide = await new Store(new MemoryFs().seed(many), counting()).load();
  assert.equal(wide.truncated, true);
  // The first entries of the folder are read, and collection.yml is one of them.
  assert.equal(((wide.collections[0] as ContainerNode).children).length, STORAGE_LIMITS.maxEntriesPerFolder - 1);
  assert.match(wide.notes[0]?.message ?? '', /more than 5000 entries/);
});

test('A collection of 10,000 requests loads in a moment and in a stable order', async () => {
  const files: Record<string, string> = { 'api-client/collections/shop/collection.yml': writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAA', 'Shop')) };
  for (let folder = 0; folder < 20; folder++) {
    files[`api-client/collections/shop/f${folder}/folder.yml`] = writeContainer(newContainer('01J9Z4V0N2XK7Q3M8T5R6Y1AAB', `Folder ${folder}`));
    for (let index = 0; index < 500; index++) files[`api-client/collections/shop/f${folder}/r${index}.req.yml`] = writeRequest({ ...newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', `Request ${index}`), url: `https://x.test/${folder}/${index}`, headers: [{ name: 'A', value: 'b', enabled: true, description: '' }] });
  }
  const started = performance.now();
  const loaded = await new Store(new MemoryFs().seed(files), counting()).load();
  assert.ok(performance.now() - started < 3000, `${(performance.now() - started).toFixed(0)} ms`);
  const tree = loaded.collections[0] as ContainerNode;
  assert.equal(tree.children.length, 20);
  assert.deepEqual((tree.children[3] as ContainerNode).children.slice(0, 3).map(child => child.slug), ['r0', 'r1', 'r10'], 'by name, as text');
});
