import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REST_CLIENT_PRIVATE_SETTINGS_FILE, REST_CLIENT_SETTINGS_FILE, renderEnvironments } from '../../src/emit/env';
import { importSource } from '../../src/import';
import { FindingSink } from '../../src/normalize/sink';
import { ensureIgnored, PRIVATE_PATTERNS } from '../../src/write/gitignore';
import { writeFiles } from '../../src/write/writer';
import { file, req, source, v4 } from '../support/source';
import { env, variable } from '../support/ir';
import { makeTree } from '../support/tree';

const SETTING = 'rest-client.environmentVariables';
const text = (files: readonly { path: string; content: string }[], path: string): string => files.find(f => f.path === path)?.content ?? `<missing ${path}>`;

test('For REST Client the environments are also written as the setting it reads, split the same way: shareable and private', () => {
  const { files } = renderEnvironments([
    env('Shared', [variable('region', 'eu')], { kind: 'shared' }),
    env('Local', [variable('proxy', 'http://localhost')], { kind: 'private' }),
    env('dev', [variable('base', 'https://dev'), variable('token', 'T', { secret: true })]),
    env('prod', [variable('base', 'https://prod')])
  ], new FindingSink(), { restClient: true });
  assert.deepEqual(files.map(f => f.path), ['http-client.env.json', 'http-client.private.env.json', REST_CLIENT_SETTINGS_FILE, REST_CLIENT_PRIVATE_SETTINGS_FILE]);
  assert.deepEqual(JSON.parse(text(files, REST_CLIENT_SETTINGS_FILE)), { [SETTING]: { dev: { base: 'https://dev', region: 'eu' }, prod: { base: 'https://prod', region: 'eu' } } });
  assert.deepEqual(JSON.parse(text(files, REST_CLIENT_PRIVATE_SETTINGS_FILE)), { [SETTING]: { dev: { proxy: 'http://localhost', token: 'T' }, prod: { proxy: 'http://localhost' } } });
  assert.equal(files.find(f => f.path === REST_CLIENT_PRIVATE_SETTINGS_FILE)?.mode, 0o600);
  assert.equal(files.find(f => f.path === REST_CLIENT_SETTINGS_FILE)?.mode, undefined);
  assert.ok(text(files, REST_CLIENT_SETTINGS_FILE).endsWith('}\n'));
  assert.ok(!text(files, REST_CLIENT_SETTINGS_FILE).includes('"T"'), 'a secret is never in the shareable file');
});

test('No secrets, no private settings file; other tools do not get the settings at all', () => {
  const environments = [env('dev', [variable('base', 'x')])];
  assert.deepEqual(renderEnvironments(environments, new FindingSink(), { restClient: true }).files.map(f => f.path), ['http-client.env.json', REST_CLIENT_SETTINGS_FILE]);
  assert.deepEqual(renderEnvironments(environments, new FindingSink()).files.map(f => f.path), ['http-client.env.json']);
  assert.deepEqual(renderEnvironments([], new FindingSink(), { restClient: true }).files, []);
});

test('An environment called $shared cannot take the key REST Client keeps for every environment', () => {
  const { files } = renderEnvironments([env('$shared', [variable('a', '1')])], new FindingSink(), { restClient: true });
  assert.deepEqual(Object.keys((JSON.parse(text(files, REST_CLIENT_SETTINGS_FILE)) as Record<string, object>)[SETTING] ?? {}), ['$shared-2']);
});

test('Only the REST Client target writes the settings; the report gives the steps and names the private file only when there is one', () => {
  const build = (secret: boolean) => source(file('collections/tc_col_a.json', 'v4-collection', v4('A', [], [req('r')])), file('environments/tc_env_dev.json', 'v4-environment', { _id: 'e', name: 'dev', data: [{ name: 'base', value: 'x' }, ...(secret ? [{ name: 'api_token', value: 'T' }] : [])] }));
  const names = (target: 'rest-client' | 'httpyac' | 'jetbrains', secret = true) => importSource(build(secret), { target }).files.map(f => f.path).filter(p => p.startsWith('rest-client.'));
  assert.deepEqual(names('rest-client'), ['rest-client.settings.json', 'rest-client.private.settings.json']);
  assert.deepEqual(names('httpyac'), []);
  assert.deepEqual(names('jetbrains'), []);
  const withSecret = text(importSource(build(true)).files, 'IMPORT_REPORT.md');
  assert.match(withSecret, /### For REST Client/);
  assert.match(withSecret, /2\. Paste the content of `rest-client\.private\.settings\.json` into your \*\*user\*\* settings/);
  assert.match(withSecret, /3\. Choose an environment/);
  const without = text(importSource(build(false)).files, 'IMPORT_REPORT.md');
  assert.doesNotMatch(without, /private\.settings/);
  assert.match(without, /2\. Choose an environment/);
  assert.doesNotMatch(text(importSource(build(true), { target: 'jetbrains' }).files, 'IMPORT_REPORT.md'), /For REST Client/);
});

test('.gitignore names every private file the import writes, once, and keeps what the file had', () => {
  assert.deepEqual(ensureIgnored(undefined, PRIVATE_PATTERNS), { text: 'http-client.private.env.json\nrest-client.private.settings.json\n', change: 'created' });
  assert.deepEqual(ensureIgnored('dist\n', PRIVATE_PATTERNS), { text: 'dist\nhttp-client.private.env.json\nrest-client.private.settings.json\n', change: 'updated' });
  assert.deepEqual(ensureIgnored('dist\nhttp-client.private.env.json\n', PRIVATE_PATTERNS), { text: 'dist\nhttp-client.private.env.json\nrest-client.private.settings.json\n', change: 'updated' });
  assert.equal(ensureIgnored('**/http-client.private.env.json\n/rest-client.private.settings.json\n', PRIVATE_PATTERNS).change, 'present');
  assert.equal(ensureIgnored('a\r\n', PRIVATE_PATTERNS).text, 'a\r\nhttp-client.private.env.json\r\nrest-client.private.settings.json\r\n');
});

test('The writer adds to .gitignore only the private files it really writes', async () => {
  const tree = makeTree();
  try {
    const files = [
      { path: 'http-client.env.json', content: '{}\n' },
      { path: 'http-client.private.env.json', content: '{}\n', mode: 0o600 },
      { path: 'rest-client.private.settings.json', content: '{}\n', mode: 0o600 }
    ];
    await writeFiles({ workspaceRoot: tree.root, targetDir: 'api', policy: 'new-folder', files });
    assert.equal(readFileSync(tree.path('.gitignore'), 'utf8'), 'http-client.private.env.json\nrest-client.private.settings.json\n');
  } finally { tree.cleanup(); }
  const only = makeTree();
  try {
    await writeFiles({ workspaceRoot: only.root, targetDir: 'api', policy: 'new-folder', files: [{ path: 'http-client.private.env.json', content: '{}\n', mode: 0o600 }] });
    assert.equal(readFileSync(only.path('.gitignore'), 'utf8'), 'http-client.private.env.json\n');
  } finally { only.cleanup(); }
});
