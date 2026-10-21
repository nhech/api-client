import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortenHome } from '../../src/util/display-path';

test('shortenHome: the home folder becomes "~", ignoring letter case and only at a folder boundary', () => {
  assert.equal(shortenHome('C:\\Users\\me\\AppData\\x', 'C:\\Users\\me'), '~\\AppData\\x');
  assert.equal(shortenHome('c:\\Users\\me\\AppData\\x', 'C:\\Users\\me'), '~\\AppData\\x', 'an editor reports the drive letter in lower case');
  assert.equal(shortenHome('/home/me/.config/Code', '/home/me'), '~/.config/Code');
  assert.equal(shortenHome('/home/me', '/home/me'), '~');
  assert.equal(shortenHome('/home/media/x', '/home/me'), '/home/media/x', 'not at a folder boundary');
  assert.equal(shortenHome('/srv/data', '/home/me'), '/srv/data');
  assert.equal(shortenHome('/home/me/x', ''), '/home/me/x');
  assert.equal(shortenHome('/home/me/x', '/home/me/'), '~/x', 'a trailing separator of the home folder is ignored');
  assert.equal(shortenHome('/h', '/home/me'), '/h');
});
