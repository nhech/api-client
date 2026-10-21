import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../../src/core/clock';
import { STORAGE_LIMITS } from '../../src/storage/fs';
import { NodeFs } from '../../src/storage/node-fs';
import { Store, type ContainerNode, type RequestNode } from '../../src/storage/store';

/** Each test works in a folder of its own that is removed afterwards. */
function withFolder(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'api-client-storage-'));
    try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}
const clock = (): Clock => { let tick = 1_700_000_000_000; let draw = 0; return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } }; };
const allFiles = (dir: string, base = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? allFiles(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1).replaceAll('\\', '/')])).sort();
/** Makes a link to a folder (a junction on Windows, which needs no privilege), or tells the test to stop where links cannot be made. */
function folderLink(target: string, at: string): boolean {
  try { symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch { return false; }
}

test('The store works on a real folder: create, rename, move, load, remove, and no temporary file is left behind', withFolder(async root => {
  const store = new Store(new NodeFs(root), clock());
  const shop = await store.createCollection('Pet Shop');
  const folder = await store.createFolder(shop.path, 'Orders');
  const request = await store.createRequest(folder.path, 'List orders', { url: '{{baseUrl}}/orders' });
  const saved = await store.saveRequest(request, { ...request.request, name: 'All orders' });
  await store.move(saved, shop.path);
  assert.deepEqual(allFiles(root), ['api-client/.gitignore', 'api-client/collections/pet-shop/all-orders.req.yml', 'api-client/collections/pet-shop/collection.yml', 'api-client/collections/pet-shop/orders/folder.yml', 'api-client/workspace.yml']);
  const tree = (await store.load()).collections[0] as ContainerNode;
  assert.deepEqual(tree.children.map(child => child.slug), ['orders', 'all-orders']);
  assert.equal((tree.children[1] as RequestNode).request.url, '{{baseUrl}}/orders');
  assert.equal(readFileSync(join(root, 'api-client', 'collections', 'pet-shop', 'all-orders.req.yml'), 'utf8').startsWith('schema: 1\n'), true);
  await store.remove(tree);
  assert.equal(existsSync(join(root, 'api-client', 'collections', 'pet-shop')), false);
}));

test('A file that cannot be written leaves the old one whole and no temporary file', withFolder(async root => {
  const fs = new NodeFs(root);
  await fs.write('a/file.yml', 'one\n');
  mkdirSync(join(root, 'a', 'dir.yml'));
  await assert.rejects(fs.write('a/dir.yml', 'two\n'), /not replaced/);
  assert.equal(await fs.read('a/file.yml'), 'one\n');
  await fs.write('a/file.yml', 'two\n');
  assert.equal(await fs.read('a/file.yml'), 'two\n');
  assert.deepEqual(readdirSync(join(root, 'a')).sort(), ['dir.yml', 'file.yml']);
}));

test('Paths are checked name by name: nothing leaves the folder and no name that Windows reserves is used', withFolder(async root => {
  const fs = new NodeFs(root);
  for (const bad of ['../outside.yml', 'a/../../outside.yml', 'a//b.yml', 'a/./b.yml', 'aux/x.yml', 'a/nul', 'trailing./x', 'a/b ', 'has:colon/x', 'a/b\u0000c']) {
    await assert.rejects(fs.read(bad), /not allowed/, JSON.stringify(bad));
    await assert.rejects(fs.write(bad, 'x'), /not allowed/, JSON.stringify(bad));
    await assert.rejects(fs.exists(bad), /not allowed/, JSON.stringify(bad));
  }
  await assert.rejects(fs.remove(''), /root of the workspace/);
  assert.deepEqual(readdirSync(root), []);
}));

test('A missing file or folder is not an error: nothing to read, nothing to list, nothing to remove', withFolder(async root => {
  const fs = new NodeFs(root);
  assert.equal(await fs.read('nope/file.yml'), undefined);
  assert.deepEqual(await fs.list('nope'), []);
  assert.equal(await fs.exists('nope'), false);
  await fs.remove('nope/file.yml');
  writeFileSync(join(root, 'plain.txt'), 'x');
  assert.deepEqual(await fs.list('plain.txt'), [], 'a file where a folder was asked for lists as empty');
}));

test('A file larger than the limit is refused when read, and a folder is not a file', withFolder(async root => {
  const fs = new NodeFs(root);
  writeFileSync(join(root, 'big.yml'), 'x'.repeat(STORAGE_LIMITS.maxFileBytes + 1));
  await assert.rejects(fs.read('big.yml'), /larger than/);
  mkdirSync(join(root, 'folder.yml'));
  await assert.rejects(fs.read('folder.yml'), /not a plain file/);
}));

test('A rename does not replace what exists, and a remove of a folder takes everything in it', withFolder(async root => {
  const fs = new NodeFs(root);
  await fs.write('a/one.yml', '1');
  await fs.write('a/two.yml', '2');
  await assert.rejects(fs.rename('a/one.yml', 'a/two.yml'), /exists already/);
  await fs.rename('a/one.yml', 'b/deep/one.yml');
  assert.equal(await fs.read('b/deep/one.yml'), '1');
  await fs.remove('b');
  assert.equal(await fs.exists('b'), false);
  assert.equal(await fs.read('a/two.yml'), '2');
}));

test('A link in the repository is never followed: it is listed as other, not read, not written through and not loaded', withFolder(async root => {
  const outside = mkdtempSync(join(tmpdir(), 'api-client-outside-'));
  try {
    writeFileSync(join(outside, 'secret.yml'), 'schema: 1\nname: stolen\n');
    mkdirSync(join(root, 'api-client', 'collections'), { recursive: true });
    if (!folderLink(outside, join(root, 'api-client', 'collections', 'linked'))) return;
    const fs = new NodeFs(root);
    const entry = (await fs.list('api-client/collections')).find(item => item.name === 'linked');
    assert.equal(entry?.kind, 'other');
    assert.deepEqual(await fs.list('api-client/collections/linked'), [], 'what is behind a link is not listed');
    await assert.rejects(fs.read('api-client/collections/linked/secret.yml'), /link or not a folder|not a plain file/);
    await assert.rejects(fs.write('api-client/collections/linked/planted.yml', 'x'), /link or not a folder/);
    await assert.rejects(fs.remove('api-client/collections/linked/secret.yml'), /link or not a folder/);
    assert.equal(existsSync(join(outside, 'planted.yml')), false);
    assert.equal(existsSync(join(outside, 'secret.yml')), true);
    const loaded = await new Store(fs, clock()).load();
    assert.deepEqual(loaded.collections, []);
    assert.equal(loaded.notes.some(note => note.path.endsWith('linked')), true);
    // Removing the link itself removes the link and not what it points to.
    await fs.remove('api-client/collections/linked');
    assert.equal(existsSync(join(outside, 'secret.yml')), true);
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

test('A local file of secrets is private where the system has permission bits', withFolder(async root => {
  const fs = new NodeFs(root);
  await fs.write('x/secret.local.yml', 'schema: 1\n', 0o600);
  if (process.platform !== 'win32') assert.equal(statSync(join(root, 'x', 'secret.local.yml')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(root, 'x', 'secret.local.yml'), 'utf8'), 'schema: 1\n');
}));
