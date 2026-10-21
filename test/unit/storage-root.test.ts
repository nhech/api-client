import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientRoot } from '../../src/storage/root';
import { DEFAULT_ROOT } from '../../src/storage/store';

/** The folder that holds the files of the client can be set by a repository, so it is held to a plain folder of the workspace. */

test('A plain relative folder of the workspace is kept, with its separators and edges put right', () => {
  const same: [string, string][] = [['api-client', 'api-client'], ['  tools/api  ', 'tools/api'], ['/api/', 'api'], ['a\\b', 'a/b'], ['.api-client', '.api-client'], ['my.folder-1/sub_dir', 'my.folder-1/sub_dir']];
  for (const [given, expected] of same) assert.equal(clientRoot(given), expected, given);
});

test('The folder of a version control system, one of packages, a way out and anything that is not a plain name give the default', () => {
  for (const bad of ['', '   ', '.', '..', '../x', 'a/../b', 'a/./b', '...', '.git', '.GIT', 'x/.git/y', '.hg', '.svn', 'node_modules', 'Node_Modules/api', 'C:/x', 'a b', 'a:b', 'x/./.git']) {
    assert.equal(clientRoot(bad), DEFAULT_ROOT, bad);
  }
});
