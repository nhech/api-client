import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leavesFolder } from '../../src/convert/body';
import { newContainer, newRequest, type Body, type Request } from '../../src/core/model';
import { parseCurl } from '../../src/importers/curl';
import { mirrorOf, type MirrorInput } from '../../src/mirror/generate';

/** A path that a request names is a file of the folder of the collection: the rule is the same wherever it is used, and no spelling gets around it. */

const SPELLINGS_THAT_LEAVE = [
  '../x', '..\\x', 'a/../b', 'a\\..\\b', '/etc/passwd', '\\\\server\\share\\x', 'C:/x', 'c:\\x', '~/.ssh/id_rsa', '..',
  ' ../outside.txt', '\t../outside.txt', '\u00a0../outside.txt', '\u2003../outside.txt', '\n../outside.txt', ' /abs/outside.txt', ' C:\\abs\\outside.txt', ' ~/x',
  '.. /x', '../ /x', ' ..\\x', 'a/.. /b', '.../x', 'a/. ./x', '..  ', 'a/b/..'
];
const SPELLINGS_THAT_STAY = ['x', 'files/ok.txt', './also/ok.txt', ' files/ok.txt', 'a..b/c.txt', '..hidden/x', 'x/y..z', 'a.b', 'dir/.hidden', '.x/y', 'name with spaces.txt', 'a...b/c'];

test('The rule says that a path leaves the folder however it is spelled, and not that a name that holds two dots does', () => {
  for (const path of SPELLINGS_THAT_LEAVE) assert.equal(leavesFolder(path), true, JSON.stringify(path));
  for (const path of SPELLINGS_THAT_STAY) assert.equal(leavesFolder(path), false, JSON.stringify(path));
});

const part = (file: string) => ({ name: 'f', kind: 'file' as const, value: '', file, contentType: '', enabled: true });
const input = (body: Body, depth: number): MirrorInput => ({ request: { ...newRequest('R1', 'Hostile'), method: 'POST', url: 'https://x.example/a', body } as Request, levels: [{ kind: 'collection', name: 'Shop', container: newContainer('C1', 'Shop') }], workspaceSettings: {}, file: 'hostile.req.yml', collection: 'Shop', depth });

test('The copy of a request names no file that is outside the folder of the collection, whatever the spelling and the depth of the request', () => {
  for (const depth of [0, 1, 3]) {
    for (const path of SPELLINGS_THAT_LEAVE) {
      const text = mirrorOf(input({ kind: 'multipart', parts: [part(path)] }, depth)).block;
      assert.ok(!/\n< /.test(text), `depth ${depth} ${JSON.stringify(path)}: ${text}`);
      assert.match(text, /# \[the file part f is not written: its path leaves the folder of the collection\]/, `depth ${depth} ${JSON.stringify(path)}`);
    }
    const kept = mirrorOf(input({ kind: 'multipart', parts: SPELLINGS_THAT_STAY.map(part) }, depth)).block;
    assert.equal((kept.match(/\n< /g) ?? []).length, SPELLINGS_THAT_STAY.length, `depth ${depth}: the names that stay are written`);
  }
});

test('A path in a cURL command is kept by its name only when it leaves the folder, whatever the spelling', () => {
  const command = (path: string): string => `curl https://x.test/up -F ${JSON.stringify(`f=@${path}`)}`;
  for (const path of SPELLINGS_THAT_LEAVE.filter(item => !item.includes('\n') && !item.includes(';') && item.trim() !== '' && !/^\.+\s*$/.test(item))) {
    const result = parseCurl(command(path));
    assert.ok(result.ok, JSON.stringify(path));
    const files = result.request.body.kind === 'multipart' ? result.request.body.parts.map(item => item.file) : [];
    assert.equal(files.length, 1, JSON.stringify(path));
    assert.equal(leavesFolder(files[0] ?? ''), false, `${JSON.stringify(path)} became ${JSON.stringify(files[0])}`);
    assert.ok(result.notes.some(note => /leads out of the folder of the collection/.test(note)), JSON.stringify(path));
  }
});
