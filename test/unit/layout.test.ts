import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLayout, entryRole, isSkippedFolder } from '../../src';

test('v4 when collections/ holds a tc_col file, v3 when only the flat files exist, none otherwise', () => {
  assert.deepEqual(detectLayout({ rootFiles: [], collectionsFiles: ['tc_col_shop.json'] }), { layout: 'v4', bothPresent: false });
  assert.deepEqual(detectLayout({ rootFiles: ['thunderclient.json'], collectionsFiles: [] }), { layout: 'v3', bothPresent: false });
  assert.deepEqual(detectLayout({ rootFiles: ['thunderCollection.json'], collectionsFiles: [] }), { layout: 'v3', bothPresent: false });
  assert.deepEqual(detectLayout({ rootFiles: ['notes.txt'], collectionsFiles: ['other.json'] }), { layout: 'none', bothPresent: false });
  assert.deepEqual(detectLayout({ rootFiles: [], collectionsFiles: [] }), { layout: 'none', bothPresent: false });
});

test('Both layouts at once: v4 wins and the decision says v3 files were there too', () => {
  assert.deepEqual(detectLayout({ rootFiles: ['thunderclient.json', 'thunderCollection.json'], collectionsFiles: ['tc_col_a.json'] }), { layout: 'v4', bothPresent: true });
});

test('The v3 names are matched ignoring case (a case-insensitive disk), the v4 prefix exactly as the extension does', () => {
  assert.equal(detectLayout({ rootFiles: ['ThunderClient.JSON'], collectionsFiles: [] }).layout, 'v3');
  assert.equal(detectLayout({ rootFiles: [], collectionsFiles: ['TC_COL_a.json'] }).layout, 'none');
});

test('Every top-level file and folder of the data folder has a role', () => {
  assert.equal(entryRole('thunderclient.json'), 'v3-requests');
  assert.equal(entryRole('thunderCollection.json'), 'v3-collections');
  assert.equal(entryRole('thunderEnvironment.json'), 'v3-environments');
  assert.equal(entryRole('thunderLocalEnvironment.json'), 'v3-local-environment');
  assert.equal(entryRole('thunderActivity.json'), 'history');
  assert.equal(entryRole('thunderResponses.json'), 'responses');
  assert.equal(entryRole('anything.json'), 'other');
  assert.equal(entryRole('tc_col_a.json', 'collections'), 'v4-collection');
  assert.equal(entryRole('x.json', 'collections'), 'other');
  assert.equal(entryRole('tc_env_dev.json', 'environments'), 'v4-environment');
  assert.equal(entryRole('tc_col_a.json', 'environments'), 'other');
  assert.equal(entryRole('constructor'), 'other');
  assert.equal(entryRole('__proto__'), 'other');
});

test('Attachments, stored responses and upgrade backups are never read', () => {
  for (const name of ['files', 'res-files', '_db-backup', '_db-backupv3', 'Files', 'RES-FILES']) assert.equal(isSkippedFolder(name), true, name);
  for (const name of ['collections', 'environments', 'thunder-tests', 'toString']) assert.equal(isSkippedFolder(name), false, name);
});
