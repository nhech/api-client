import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import { mayActivateEnvironment } from '../../src/importers/activation';
import { FOLDER_ENTRIES, splitLargeFolders } from '../../src/importers/split';
import { blankFolder, blankRequest, countImported, emptyImported, IMPORT_LIMITS, type Imported, type ImportedFolder } from '../../src/importers/types';
import { writeImported } from '../../src/storage/import';
import { STORAGE_LIMITS } from '../../src/storage/fs';
import { Store } from '../../src/storage/store';
import { hasUserinfo, withoutUserinfo } from '../../src/util/address';
import { MemoryFs } from '../support/memory-fs';

/** A folder is split before it is written, the first environment of an import takes over only when it harms nothing, and a folder can be named like a file of secrets. */

function counting(): Clock {
  let tick = 1_700_000_000_000;
  let draw = 0;
  return { now: () => tick++, random: () => { draw = (draw * 7 + 3) % 101; return draw / 101; } };
}
const collectionOf = (requests: number, folders = 0): Imported => {
  const collection = blankFolder('Big');
  for (let index = 0; index < folders; index++) collection.folders.push(blankFolder(`Folder ${index}`));
  for (let index = 0; index < requests; index++) collection.requests.push(blankRequest(`Request ${index}`));
  return { ...emptyImported(), collections: [collection] };
};
const requestNames = (folder: ImportedFolder): string[] => [...folder.requests.map(request => request.name), ...folder.folders.flatMap(requestNames)];

test('A folder with more than the limit is split into parts that keep the order, and a folder under the limit is left as it is', () => {
  const small = collectionOf(FOLDER_ENTRIES);
  assert.equal(splitLargeFolders(small), small, 'nothing to split: the same object');
  const big = splitLargeFolders(collectionOf(2500));
  const collection = big.collections[0] as ImportedFolder;
  assert.equal(collection.requests.length, FOLDER_ENTRIES);
  assert.deepEqual(collection.folders.map(folder => [folder.container.name, folder.requests.length]), [['Big (2)', FOLDER_ENTRIES], ['Big (3)', 500]]);
  assert.deepEqual(requestNames(collection), Array.from({ length: 2500 }, (_, index) => `Request ${index}`), 'every request is there, in order');
  assert.equal(countImported(big).requests, 2500);
  assert.ok(big.notes.some(note => note.where === 'Big' && /more than 1000/.test(note.message)), JSON.stringify(big.notes));
  // Folders count as entries too, and a folder inside a folder is split on its own.
  const many = splitLargeFolders(collectionOf(10, 1500)).collections[0] as ImportedFolder;
  assert.ok(many.folders.length + many.requests.length < 1000 + 2, 'the collection no longer holds 1510 entries');
  assert.equal(countImported({ ...emptyImported(), collections: [many] }).requests, 10);
  const nested = collectionOf(0);
  const inner = blankFolder('Inner');
  for (let index = 0; index < 1200; index++) inner.requests.push(blankRequest(`R${index}`));
  (nested.collections[0] as ImportedFolder).folders.push(inner);
  const cut = splitLargeFolders(nested).collections[0] as ImportedFolder;
  assert.deepEqual(cut.folders[0]?.folders.map(folder => folder.container.name), ['Inner (2)']);
});

test('A part keeps the name short enough for the limit of names', () => {
  const long = collectionOf(1001);
  (long.collections[0] as ImportedFolder).container.name = 'n'.repeat(IMPORT_LIMITS.nameChars);
  const part = (splitLargeFolders(long).collections[0] as ImportedFolder).folders[0];
  assert.ok((part?.container.name.length ?? 0) <= IMPORT_LIMITS.nameChars);
  assert.ok(part?.container.name.endsWith(' (2)'));
});

test('What was split is written and read back whole: the client reads at most 5000 entries of a folder', async () => {
  const total = 2600;
  assert.ok(total < STORAGE_LIMITS.maxEntriesPerFolder);
  const fs = new MemoryFs();
  const store = new Store(fs, counting());
  await writeImported(store, splitLargeFolders(collectionOf(total)));
  const loaded = await store.load();
  assert.equal(loaded.truncated, false);
  const collection = loaded.collections[0];
  const count = (node: NonNullable<typeof collection>): number => node.children.reduce((sum, child) => sum + (child.kind === 'request' ? 1 : count(child)), 0);
  assert.equal(collection === undefined ? 0 : count(collection), total);
});

test('A folder called like the file of secret values is not ignored by Git as a whole', async () => {
  const fs = new MemoryFs();
  const store = new Store(fs, counting());
  const collection = blankFolder('Shop');
  const tagged = blankFolder('Billing.local.yml');
  tagged.requests.push(blankRequest('List invoices'));
  collection.folders.push(tagged);
  await writeImported(store, { ...emptyImported(), collections: [collection] });
  const paths = [...fs.files.keys()];
  assert.ok(paths.some(path => path.endsWith('/billing-local-yml/folder.yml')), paths.join('\n'));
  assert.ok(!paths.some(path => /\.local\.yml\/(?!$)/.test(path)), 'no folder ends in .local.yml');
});

test('The first environment of an import becomes the active one only when nothing else can be sent to its address', () => {
  const facts = { hasActive: false, collectionsBefore: 0, workspaceVariables: [] as string[], environmentVariables: ['baseUrl'] };
  assert.equal(mayActivateEnvironment(facts), true);
  assert.equal(mayActivateEnvironment({ ...facts, hasActive: true }), false, 'an active environment stays');
  assert.equal(mayActivateEnvironment({ ...facts, collectionsBefore: 1 }), false, 'the other collections would be sent to it');
  assert.equal(mayActivateEnvironment({ ...facts, workspaceVariables: ['token', 'baseUrl'] }), false, 'it would hide a variable of the workspace');
  assert.equal(mayActivateEnvironment({ ...facts, workspaceVariables: ['token'] }), true);
});

test('An address is shown without its user name and password', () => {
  assert.equal(hasUserinfo('https://ann:secret@host/x'), true);
  assert.equal(hasUserinfo('https://host/x?a=b@c'), false);
  assert.equal(hasUserinfo('https://host/x#@'), false);
  assert.equal(withoutUserinfo('https://ann:secret@host/x'), 'https://***@host/x');
  assert.equal(withoutUserinfo('http://token@host'), 'http://***@host');
  assert.equal(withoutUserinfo('https://host/x?a=b@c'), 'https://host/x?a=b@c');
  assert.equal(withoutUserinfo('not an address'), 'not an address');
});
