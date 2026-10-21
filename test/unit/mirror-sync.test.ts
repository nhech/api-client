import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import { headerLine, splitFile } from '../../src/mirror/drift';
import { BLOCK_BEGIN, BLOCK_END, withMirrorBlock } from '../../src/mirror/gitignore';
import { inspectMirror, mirrorPathOf, requestOfMirror, syncMirrors, type MirrorMode, type SyncOptions } from '../../src/storage/mirror-sync';
import { Store, type ContainerNode, type Loaded, type RequestNode } from '../../src/storage/store';
import { textHash } from '../../src/util/hash';
import { MemoryFs } from '../support/memory-fs';

/** The `.http` files next to the requests of a store: written when missing, followed when the request changes, never written over when changed by hand. */

function counting(): Clock {
  let tick = 1_700_000_000_000;
  let draw = 0;
  return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } };
}

async function shop(): Promise<{ fs: MemoryFs; store: Store }> {
  const fs = new MemoryFs();
  const store = new Store(fs, counting());
  const collection = await store.createCollection('Shop');
  const orders = await store.createFolder(collection.path, 'Orders');
  await store.createRequest(orders.path, 'List orders', { method: 'GET', url: 'https://api.test/orders' });
  await store.createRequest(collection.path, 'Health', { url: 'https://api.test/health' });
  return { fs, store };
}

const LIST = 'api-client/collections/shop/orders/list-orders';
const HEALTH = 'api-client/collections/shop/health';

function requestAt(loaded: Loaded, path: string): RequestNode {
  const search = (container: ContainerNode): RequestNode | undefined => {
    for (const child of container.children) {
      const found = child.kind === 'request' ? (child.path === path ? child : undefined) : search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  for (const collection of loaded.collections) {
    const found = search(collection);
    if (found !== undefined) return found;
  }
  throw new Error(`no request at ${path}`);
}

const sync = (fs: MemoryFs, store: Store, mode: MirrorMode = 'on', options: SyncOptions = {}) => store.load().then(loaded => syncMirrors(fs, loaded, mode, options));
const text = (fs: MemoryFs, path: string): string => fs.files.get(path) as string;

test('A request with no .http file next to it gets one, named like the request, and a second sync changes nothing', async () => {
  const { fs, store } = await shop();
  const first = await sync(fs, store);
  assert.deepEqual(first.written, [`${HEALTH}.http`, `${LIST}.http`]);
  assert.deepEqual([first.drifted, first.removed, first.orphans, first.failed], [[], [], [], []]);
  const file = text(fs, `${LIST}.http`);
  assert.ok(file.startsWith('# api-client generated v1 src=list-orders.req.yml h='));
  assert.match(file, /\nGET https:\/\/api\.test\/orders\n$/);
  assert.equal(file.includes('\r'), false, 'written with line feeds');
  const before = fs.log.length;
  const second = await sync(fs, store);
  assert.deepEqual([second.written, second.drifted, second.removed], [[], [], []]);
  assert.deepEqual(fs.log.slice(before).filter(line => line.startsWith('write')), [], 'nothing was written');
  assert.equal(mirrorPathOf(`${LIST}.req.yml`), `${LIST}.http`);
});

test('A change of the request is followed by the file, and so is a change of what it inherits', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  const list = requestAt(await store.load(), `${LIST}.req.yml`);
  await store.saveRequest(list, { ...list.request, url: 'https://api.test/orders?all=1' });
  const changed = await sync(fs, store);
  assert.deepEqual(changed.written, [`${LIST}.http`], 'only the request that changed');
  assert.match(text(fs, `${LIST}.http`), /\nGET https:\/\/api\.test\/orders\?all=1\n/);
  const collection = (await store.load()).collections[0] as ContainerNode;
  await store.saveContainer(collection, { ...collection.container, headers: [{ name: 'X-Team', value: 'shop', enabled: true, description: '' }] });
  const inherited = await sync(fs, store);
  assert.deepEqual(inherited.written, [`${HEALTH}.http`, `${LIST}.http`], 'a header of the collection is in every request of it');
  assert.match(text(fs, `${HEALTH}.http`), /\nX-Team: shop\n/);
});

test('A file that somebody changed is never written over, whether or not the request changed, and is reported', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  const edited = text(fs, `${HEALTH}.http`).replace('GET', 'POST');
  fs.files.set(`${HEALTH}.http`, edited);
  const first = await sync(fs, store);
  assert.deepEqual(first.drifted, [{ path: `${HEALTH}.http`, request: `${HEALTH}.req.yml`, drift: 'edited' }]);
  assert.deepEqual(first.written, []);
  assert.equal(text(fs, `${HEALTH}.http`), edited);
  const health = requestAt(await store.load(), `${HEALTH}.req.yml`);
  await store.saveRequest(health, { ...health.request, url: 'https://api.test/ping' });
  const second = await sync(fs, store);
  assert.deepEqual(second.drifted.map(entry => entry.drift), ['both']);
  assert.equal(text(fs, `${HEALTH}.http`), edited, 'still the edited text');
  assert.equal(second.written.includes(`${HEALTH}.http`), false);
});

test('A file with no header is the own file of the person: not written, not reported, not ignored by Git', async () => {
  const { fs, store } = await shop();
  fs.seed({ [`${HEALTH}.http`]: '### mine\nGET http://mine.test\n' });
  const report = await sync(fs, store, 'gitignored');
  assert.equal(text(fs, `${HEALTH}.http`), '### mine\nGET http://mine.test\n');
  assert.deepEqual([report.drifted, report.written.includes(`${HEALTH}.http`)], [[], false]);
  assert.ok(!text(fs, 'api-client/.gitignore').includes('health.http'));
  assert.ok(text(fs, 'api-client/.gitignore').includes('collections/shop/orders/list-orders.http'));
});

test('A file that is open with changes that are not saved is left for later, and the sync that follows writes it', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  const list = requestAt(await store.load(), `${LIST}.req.yml`);
  await store.saveRequest(list, { ...list.request, url: 'https://api.test/orders?later=1' });
  const busy = await sync(fs, store, 'on', { skip: path => path === `${LIST}.http` });
  assert.deepEqual([busy.written, busy.deferred], [[], [`${LIST}.http`]]);
  assert.ok(!text(fs, `${LIST}.http`).includes('later=1'));
  const later = await sync(fs, store);
  assert.deepEqual(later.written, [`${LIST}.http`]);
  assert.ok(text(fs, `${LIST}.http`).includes('later=1'));
});

test('A .http file is traced back to its request by its place, and what it is to that request is told', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  const loaded = await store.load();
  assert.equal(requestOfMirror(loaded, `${LIST}.http`)?.node.path, `${LIST}.req.yml`);
  assert.equal(requestOfMirror(loaded, 'api-client/collections/shop/nothing.http'), undefined);
  assert.equal(requestOfMirror(loaded, `${LIST}.txt`), undefined);
  assert.equal(inspectMirror(loaded, `${LIST}.http`, text(fs, `${LIST}.http`))?.drift, 'in-sync');
  assert.equal(inspectMirror(loaded, `${LIST}.http`, text(fs, `${LIST}.http`).replace('GET', 'POST'))?.drift, 'edited');
  assert.equal(inspectMirror(loaded, `${LIST}.http`, undefined)?.drift, 'missing');
  assert.equal(inspectMirror(loaded, `${LIST}.http`, '### mine\nGET /\n')?.drift, 'foreign');
  assert.equal(inspectMirror(loaded, 'api-client/collections/shop/nothing.http', ''), undefined);
  assert.equal(inspectMirror(loaded, `${LIST}.http`, '')?.chain.length, 2, 'the collection and the folder above the request');
});

test('A line-ending change by a checkout is not an edit, and a header that is old is renewed', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  fs.files.set(`${HEALTH}.http`, text(fs, `${HEALTH}.http`).replace(/\n/g, '\r\n'));
  const crlf = await sync(fs, store);
  assert.deepEqual([crlf.drifted, crlf.written], [[], []]);
  const file = text(fs, `${LIST}.http`);
  fs.files.set(`${LIST}.http`, `${headerLine('list-orders.req.yml', textHash('something older'))}\n${splitFile(file).block}`);
  const renewed = await sync(fs, store);
  assert.deepEqual(renewed.written, [`${LIST}.http`]);
  assert.equal(text(fs, `${LIST}.http`), file);
});

test('A request that turns its mirror off gets none; the mode off writes nothing at all; and an unreadable file is reported while the rest goes on', async () => {
  const { fs, store } = await shop();
  const health = requestAt(await store.load(), `${HEALTH}.req.yml`);
  await store.saveRequest(health, { ...health.request, mirror: false });
  const off = await sync(fs, store, 'off');
  assert.deepEqual(off, { written: [], drifted: [], removed: [], orphans: [], deferred: [], failed: [] });
  assert.ok(![...fs.files.keys()].some(path => path.endsWith('.http')));
  const report = await sync(fs, store);
  assert.deepEqual(report.written, [`${LIST}.http`], 'no file for the request with its mirror turned off');
  fs.link(`${LIST}.http`);
  const broken = await sync(fs, store);
  assert.deepEqual(broken.failed.map(entry => entry.path), [`${LIST}.http`]);
  const failing = await shop();
  failing.fs.failWrites = [`${HEALTH}.http`];
  const partial = await sync(failing.fs, failing.store);
  assert.deepEqual(partial.written, [`${LIST}.http`]);
  assert.deepEqual(partial.failed.map(entry => entry.path), [`${HEALTH}.http`]);
});

test('A generated file whose request is gone is removed with it, unless somebody changed it, and the own files of the person are left', async () => {
  const { fs, store } = await shop();
  await sync(fs, store);
  fs.seed({ 'api-client/collections/shop/notes.http': '### mine\nGET http://mine.test\n' });
  const tree = await store.load();
  await store.remove(requestAt(tree, `${LIST}.req.yml`));
  fs.files.set(`${HEALTH}.http`, `${text(fs, `${HEALTH}.http`)}# edited\n`);
  await store.remove(requestAt(tree, `${HEALTH}.req.yml`));
  const report = await sync(fs, store);
  assert.deepEqual(report.removed, [`${LIST}.http`]);
  assert.deepEqual(report.orphans, [`${HEALTH}.http`], 'a changed file is kept and named');
  assert.ok(fs.files.has('api-client/collections/shop/notes.http'));
  assert.ok(!fs.files.has(`${LIST}.http`));
});

test('With the mode gitignored the generated files are listed in a block of the .gitignore, and the block goes when the mode is another', async () => {
  const { fs, store } = await shop();
  await sync(fs, store, 'gitignored');
  const ignore = text(fs, 'api-client/.gitignore');
  assert.ok(ignore.startsWith('*.local.yml\n.runs/\n'), 'what was there is kept');
  assert.ok(ignore.includes(`${BLOCK_BEGIN}\ncollections/shop/health.http\ncollections/shop/orders/list-orders.http\n${BLOCK_END}\n`));
  await sync(fs, store, 'on');
  assert.equal(text(fs, 'api-client/.gitignore'), '*.local.yml\n.runs/\n');
});

test('The block of the .gitignore is written, replaced and removed without touching the lines around it', () => {
  assert.deepEqual(withMirrorBlock(undefined, []), { text: undefined, change: 'none' });
  assert.deepEqual(withMirrorBlock('a\n', []), { text: 'a\n', change: 'none' });
  const made = withMirrorBlock('a\nb\n', ['z/2.http', 'y/1.http', 'y/1.http']);
  assert.deepEqual(made, { text: `a\nb\n${BLOCK_BEGIN}\ny/1.http\nz/2.http\n${BLOCK_END}\n`, change: 'updated' });
  assert.equal(withMirrorBlock(made.text, ['z/2.http', 'y/1.http']).change, 'none');
  const replaced = withMirrorBlock(`before\n${BLOCK_BEGIN}\nold.http\n${BLOCK_END}\nafter\n`, ['new.http']);
  assert.equal(replaced.text, `before\n${BLOCK_BEGIN}\nnew.http\n${BLOCK_END}\nafter\n`);
  assert.deepEqual(withMirrorBlock(replaced.text, []), { text: 'before\nafter\n', change: 'removed' });
  assert.deepEqual(withMirrorBlock(`${BLOCK_BEGIN}\nx.http\n${BLOCK_END}\n`, []), { text: '', change: 'removed' });
  assert.deepEqual(withMirrorBlock(undefined, ['a.http']), { text: `${BLOCK_BEGIN}\na.http\n${BLOCK_END}\n`, change: 'created' });
  const cut = withMirrorBlock(`keep\n${BLOCK_BEGIN}\nold.http\n`, ['new.http']);
  assert.equal(cut.text, `keep\n${BLOCK_BEGIN}\nnew.http\n${BLOCK_END}\n`, 'a block that lost its end is rewritten whole');
  assert.equal(withMirrorBlock('a\r\nb\r\n', ['x.http']).text, `a\r\nb\r\n${BLOCK_BEGIN}\r\nx.http\r\n${BLOCK_END}\r\n`, 'the line ends of the file are kept');
});

test('Syncing hundreds of requests reads each file once and finishes quickly', async () => {
  const fs = new MemoryFs();
  const store = new Store(fs, counting());
  const collection = await store.createCollection('Big');
  for (let index = 0; index < 600; index++) await store.createRequest(collection.path, `Request ${index}`, { url: `https://api.test/${index}` });
  const loaded = await store.load();
  const started = Date.now();
  const report = await syncMirrors(fs, loaded, 'on');
  assert.equal(report.written.length, 600);
  assert.ok(Date.now() - started < 5000, 'under five seconds');
  const again = await syncMirrors(fs, loaded, 'on');
  assert.deepEqual([again.written.length, again.drifted.length], [0, 0]);
});
