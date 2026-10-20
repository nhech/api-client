import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputFile } from '../../src';
import { ensureIgnored } from '../../src/write/gitignore';
import { relativePathProblem, segmentProblem, targetSegments } from '../../src/write/paths';
import { WriteError, planWrite, writeFiles } from '../../src/write/writer';
import type { WriteRequest } from '../../src/write/writer';
import { makeTree, snapshot, tryLink } from '../support/tree';

const files = (): OutputFile[] => [
  { path: 'Shop/index.http', content: '### a\nGET /\n' },
  { path: 'Shop/Orders/Admin.http', content: '### b\nGET /b\n' },
  { path: 'http-client.env.json', content: '{}\n' },
  { path: 'http-client.private.env.json', content: '{\n  "dev": {}\n}\n', mode: 0o600 },
  { path: 'IMPORT_REPORT.md', content: '# Report\n' }
];
const request = (root: string, extra: Partial<WriteRequest> = {}): WriteRequest => ({ workspaceRoot: root, targetDir: 'api', policy: 'new-folder', files: files(), ...extra });
const fail = async (promise: Promise<unknown>, expected: WriteError['code']): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => error instanceof WriteError && error.code === expected, expected);
};

test('A new folder gets every file, with the contents given', async () => {
  const tree = makeTree();
  try {
    const outcome = await writeFiles(request(tree.root));
    assert.equal(outcome.plan.targetDir, 'api');
    assert.deepEqual(outcome.written.sort(), files().map(f => `api/${f.path}`).sort());
    for (const f of files()) assert.equal(readFileSync(tree.path(`api/${f.path}`), 'utf8'), f.content);
    assert.deepEqual(readdirSync(tree.root).sort(), ['.gitignore', 'api'], 'no staging folder is left');
  } finally { tree.cleanup(); }
});

test('The private file is protected: 0600 where the system has modes, and .gitignore names it before it exists', async () => {
  const tree = makeTree();
  try {
    await writeFiles(request(tree.root));
    if (process.platform !== 'win32') assert.equal(statSync(tree.path('api/http-client.private.env.json')).mode & 0o777, 0o600);
    assert.equal(readFileSync(tree.path('.gitignore'), 'utf8'), 'http-client.private.env.json\n');
  } finally { tree.cleanup(); }
});

test('.gitignore: a missing file is created, a line is added once, the line ending is kept, a present line is left alone', () => {
  assert.deepEqual(ensureIgnored(undefined), { text: 'http-client.private.env.json\n', change: 'created' });
  assert.deepEqual(ensureIgnored('node_modules\n'), { text: 'node_modules\nhttp-client.private.env.json\n', change: 'updated' });
  assert.deepEqual(ensureIgnored('node_modules'), { text: 'node_modules\nhttp-client.private.env.json\n', change: 'updated' });
  assert.deepEqual(ensureIgnored('a\r\nb\r\n'), { text: 'a\r\nb\r\nhttp-client.private.env.json\r\n', change: 'updated' });
  assert.equal(ensureIgnored('a\n  http-client.private.env.json  \n').change, 'present');
  assert.equal(ensureIgnored('**/http-client.private.env.json\n').change, 'present');
  assert.equal(ensureIgnored('').text, 'http-client.private.env.json\n');
});

test('.gitignore of the workspace is appended to, and not written when there is no private file', async () => {
  const tree = makeTree({ '.gitignore': 'dist\n' });
  try {
    await writeFiles(request(tree.root));
    assert.equal(readFileSync(tree.path('.gitignore'), 'utf8'), 'dist\nhttp-client.private.env.json\n');
    await writeFiles(request(tree.root, { files: files().filter(f => !f.path.includes('private')) }));
    assert.equal(readFileSync(tree.path('.gitignore'), 'utf8'), 'dist\nhttp-client.private.env.json\n', 'unchanged');
  } finally { tree.cleanup(); }
  const clean = makeTree();
  try {
    await writeFiles(request(clean.root, { files: files().filter(f => !f.path.includes('private')) }));
    assert.ok(!existsSync(clean.path('.gitignore')));
  } finally { clean.cleanup(); }
});

test('new-folder never touches a folder that has something in it: the files go to the next free name', async () => {
  const tree = makeTree({ 'api/mine.txt': 'keep' });
  try {
    const before = snapshot(tree.path('api'));
    const outcome = await writeFiles(request(tree.root));
    assert.equal(outcome.plan.targetDir, 'api-2');
    assert.equal(outcome.plan.renamed, true);
    assert.equal(snapshot(tree.path('api')), before);
    assert.ok(existsSync(tree.path('api-2/Shop/index.http')));
    const again = await writeFiles(request(tree.root));
    assert.equal(again.plan.targetDir, 'api-3');
  } finally { tree.cleanup(); }
});

test('new-folder uses an existing empty folder, and creates the missing parents of a nested target', async () => {
  const tree = makeTree();
  try {
    await writeFiles(request(tree.root, { targetDir: 'docs/api' }));
    assert.ok(existsSync(tree.path('docs/api/Shop/index.http')));
    const empty = makeTree();
    try {
      empty.write('api/.keep', '');
      const outcome = await writeFiles(request(empty.root));
      assert.equal(outcome.plan.targetDir, 'api-2', 'a folder with a file in it is not empty');
    } finally { empty.cleanup(); }
  } finally { tree.cleanup(); }
  const hollow = makeTree({});
  try {
    writeFileSync(join(hollow.root, 'x'), '');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(hollow.path('api'));
    const outcome = await writeFiles(request(hollow.root));
    assert.equal(outcome.plan.targetDir, 'api');
  } finally { hollow.cleanup(); }
});

test('skip-existing keeps what is there; overwrite replaces it; both add the rest', async () => {
  const tree = makeTree({ 'api/Shop/index.http': 'MINE\n', 'api/other.txt': 'other' });
  try {
    const skipped = await writeFiles(request(tree.root, { policy: 'skip-existing' }));
    assert.deepEqual(skipped.skipped, ['api/Shop/index.http']);
    assert.equal(readFileSync(tree.path('api/Shop/index.http'), 'utf8'), 'MINE\n');
    assert.ok(existsSync(tree.path('api/Shop/Orders/Admin.http')));
    assert.equal(readFileSync(tree.path('api/other.txt'), 'utf8'), 'other');

    const replaced = await writeFiles(request(tree.root, { policy: 'overwrite' }));
    assert.ok(replaced.overwritten.includes('api/Shop/index.http'));
    assert.equal(readFileSync(tree.path('api/Shop/index.http'), 'utf8'), '### a\nGET /\n');
    assert.equal(readFileSync(tree.path('api/other.txt'), 'utf8'), 'other', 'files that are not ours are left');
    assert.ok(!readdirSync(tree.root).some(name => name.startsWith('.api-import-')));
  } finally { tree.cleanup(); }
});

test('A failure half way undoes what was moved: the folder is as it was (overwrite)', async () => {
  const tree = makeTree({ 'api/Shop/index.http': 'MINE\n', 'api/IMPORT_REPORT.md': 'old report\n' });
  try {
    const before = snapshot(tree.root);
    await fail(writeFiles(request(tree.root, { policy: 'overwrite', beforeMove: index => { if (index === 3) throw new Error('disk full'); } })), 'io');
    assert.equal(snapshot(tree.root), before);
  } finally { tree.cleanup(); }
});

test('A failure half way leaves no new folder behind (new-folder)', async () => {
  const tree = makeTree({ keep: 'x' });
  try {
    const before = snapshot(tree.root);
    await fail(writeFiles(request(tree.root, { targetDir: 'a/b/c', beforeMove: () => { throw new Error('boom'); } })), 'io');
    assert.equal(snapshot(tree.root), before, 'not even the .gitignore that was made is left');
    assert.ok(!existsSync(tree.path('a')), 'the folders made for the target are removed');
    assert.deepEqual(readdirSync(tree.root).filter(name => name.startsWith('.api-import-')), []);
  } finally { tree.cleanup(); }
});

test('Cancelling before the files are moved changes nothing, not even the staging folder', async () => {
  const tree = makeTree({ keep: 'x' });
  try {
    const controller = new AbortController();
    controller.abort();
    const before = snapshot(tree.root);
    await fail(writeFiles(request(tree.root, { signal: controller.signal })), 'aborted');
    assert.equal(snapshot(tree.root), before);
  } finally { tree.cleanup(); }
});

test('A dry run (planWrite) reports the plan and changes nothing', async () => {
  const tree = makeTree({ 'api/Shop/index.http': 'MINE\n' });
  try {
    const before = snapshot(tree.root);
    const plan = await planWrite(request(tree.root, { policy: 'skip-existing' }));
    assert.equal(snapshot(tree.root), before);
    assert.equal(plan.targetDir, 'api');
    assert.deepEqual(plan.files.map(f => `${f.action} ${f.path}`), [
      'create IMPORT_REPORT.md', 'create Shop/Orders/Admin.http', 'skip Shop/index.http', 'create http-client.env.json', 'create http-client.private.env.json'
    ]);
    assert.equal(plan.gitignore, 'created');
  } finally { tree.cleanup(); }
});

test('Targets and file paths that could leave the folder are refused before anything happens', async () => {
  const tree = makeTree({ keep: 'x' });
  try {
    const before = snapshot(tree.root);
    for (const targetDir of ['', '..', '../x', 'a/../../x', '/abs', 'C:\\x', 'C:/x', 'a//b'.replace('//', '/./'), 'con', 'a/aux.txt', 'x\u0000y', 'a/b.', 'a\u202eb']) {
      await fail(writeFiles(request(tree.root, { targetDir })), 'invalid-target');
    }
    for (const path of ['../evil.http', '/etc/x', 'a/../b', 'C:/x', 'a\\b', '', 'a//b', 'nul.txt', 'a/']) {
      await fail(writeFiles(request(tree.root, { files: [{ path, content: 'x' }] })), 'invalid-file');
    }
    await fail(writeFiles(request(tree.root, { files: [{ path: 'A.http', content: '' }, { path: 'a.http', content: '' }] })), 'invalid-file');
    assert.equal(snapshot(tree.root), before);
  } finally { tree.cleanup(); }
});

test('A link in the way is not followed: the target, a folder inside it, or .gitignore', async () => {
  const outside = makeTree({ 'secret.txt': 's' });
  const tree = makeTree({ keep: 'x' });
  try {
    if (!tryLink(outside.root, tree.path('linked'), 'junction')) return;
    const before = snapshot(outside.root);
    await fail(writeFiles(request(tree.root, { targetDir: 'linked' })), 'unsafe-path');
    await fail(writeFiles(request(tree.root, { targetDir: 'linked/inner' })), 'unsafe-path');
    await fail(writeFiles(request(tree.root, { targetDir: 'linked', policy: 'overwrite' })), 'unsafe-path');
    assert.equal(snapshot(outside.root), before);

    tree.write('real/Shop', 'x');
    const nested = makeTree();
    try {
      if (!tryLink(outside.root, nested.path('api/Shop'), 'junction')) return;
      await fail(writeFiles(request(nested.root, { policy: 'overwrite' })), 'unsafe-path');
      assert.equal(snapshot(outside.root), before);
    } finally { nested.cleanup(); }
  } finally { tree.cleanup(); outside.cleanup(); }
});

test('Something that is not a folder where a folder or file should go is a clear error, not a partial write', async () => {
  const tree = makeTree({ 'api/Shop': 'a file where a folder should go' });
  try {
    const before = snapshot(tree.root);
    await fail(writeFiles(request(tree.root, { policy: 'skip-existing' })), 'exists');
    assert.equal(snapshot(tree.root), before);
  } finally { tree.cleanup(); }
  const asFile = makeTree({ api: 'a file' });
  try {
    await fail(writeFiles(request(asFile.root, { policy: 'overwrite' })), 'exists');
    const outcome = await writeFiles(request(asFile.root));
    assert.equal(outcome.plan.targetDir, 'api-2', 'new-folder just picks another name');
  } finally { asFile.cleanup(); }
});

test('Name rules', () => {
  assert.equal(segmentProblem('Orders.http'), undefined);
  assert.equal(segmentProblem('body-0001.txt'), undefined);
  assert.notEqual(segmentProblem('a:b'), undefined);
  assert.notEqual(segmentProblem('com1'), undefined);
  assert.notEqual(segmentProblem('LPT9.txt'), undefined);
  assert.notEqual(segmentProblem('x '), undefined);
  assert.equal(relativePathProblem('a/b/c.http'), undefined);
  assert.notEqual(relativePathProblem('a/./b'), undefined);
  assert.deepEqual(targetSegments(' docs\\api/ '), { segments: ['docs', 'api'] });
  assert.ok('problem' in targetSegments('..'));
});
