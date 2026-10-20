import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { candidatePaths, inspectCandidates } from '../../src/discover';
import type { Candidate } from '../../src/discover';
import { runImportFlow } from '../../src/host';
import type { ImportHost, ImportSettings, RestClientSettingsOutcome, SourceChoice } from '../../src/host';
import { mergeEnvironments } from '../../src/settings-merge';
import type { RestClientSettings } from '../../src/settings-merge';
import { runCli } from '../../src/cli';
import { importFromPath } from '../../src/run';
import { SourceError } from '../../src/reader/fs-reader';
import { makeTree, snapshot } from '../support/tree';
import { collection, request } from '../support/tree';

const SECRET = 'CANARY-flow-secret-5555';

const data = (): Record<string, object> => ({
  'collections/tc_col_a.json': { ...collection('Shop', [{ ...request('c-Shop', 'list'), auth: { type: 'bearer', bearer: SECRET } }]), colId: 'c-Shop' },
  'environments/tc_env_dev.json': { _id: 'e1', name: 'dev', data: [{ name: 'base', value: 'https://dev.example' }] }
});

interface Script {
  choice?: SourceChoice | undefined;
  settings?: ImportSettings | undefined;
  confirm?: boolean;
  cancelProgress?: boolean;
  workspace?: string | undefined;
  folder?: string | undefined;
  /** What the host answers when asked to fill in the REST Client settings. */
  restClient?: 'applied' | 'missing' | 'throws';
}

function fakeHost(script: Script) {
  const calls: string[] = [];
  /** The REST Client setting as the fake host keeps it: one per scope, merged with the same function the real host uses. */
  const stores: { workspace: unknown; user: unknown } = { workspace: undefined, user: undefined };
  const seen: { settings?: RestClientSettings | undefined; outcome?: RestClientSettingsOutcome | undefined } = {};
  const reports: string[] = [];
  const errors: string[] = [];
  const host: ImportHost = {
    workspaceRoot: () => script.workspace,
    pickSource: async candidates => { calls.push(`pickSource(${candidates.length})`); return script.choice; },
    chooseFolder: async () => { calls.push('chooseFolder'); return script.folder; },
    chooseFiles: async () => { calls.push('chooseFiles'); return undefined; },
    withProgress: async (title, task) => {
      calls.push(`progress(${title})`);
      if (script.cancelProgress === true) { const controller = new AbortController(); controller.abort(); try { await task(controller.signal); } catch { /* cancelled */ } return undefined; }
      return task(new AbortController().signal);
    },
    showReport: async markdown => { calls.push('showReport'); reports.push(markdown); },
    pickSettings: async defaults => { calls.push('pickSettings'); return script.settings ?? defaults; },
    confirm: async plan => { calls.push(`confirm(${plan.files.length} files into ${plan.targetDir})`); return script.confirm ?? true; },
    applyRestClientSettings: async found => {
      calls.push('applyRestClientSettings');
      seen.settings = found;
      if (script.restClient === 'missing') return { status: 'rest-client-missing' };
      if (script.restClient === 'throws') throw new Error('boom');
      const workspace = mergeEnvironments(stores.workspace, found.shareable);
      stores.workspace = workspace.merged;
      const user = found.secrets === undefined ? undefined : mergeEnvironments(stores.user, found.secrets);
      if (user !== undefined) stores.user = user.merged;
      return { status: 'applied', workspace: { environments: workspace.addedEnvironments, variables: workspace.addedVariables, kept: workspace.kept }, ...(user === undefined ? {} : { user: { environments: user.addedEnvironments, variables: user.addedVariables, kept: user.kept } }), syncExcluded: user !== undefined };
    },
    done: async (_outcome, _summary, restClient) => { calls.push('done'); seen.outcome = restClient; return 'open-report'; },
    openFolder: async dir => { calls.push(`openFolder(${dir})`); },
    openReport: async file => { calls.push(`openReport(${file})`); },
    error: async message => { calls.push('error'); errors.push(message); }
  };
  return { host, calls, reports, errors, stores, seen };
}

test('The flow: pick, scan, preview, settings, confirm, write, done', async () => {
  const source = makeTree(data());
  const workspace = makeTree();
  try {
    const { host, calls, reports } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root } });
    const before = snapshot(source.root);
    const result = await runImportFlow(host, { candidates: [] });
    assert.equal(result.status, 'done');
    assert.deepEqual(calls, ['pickSource(0)', 'progress(Reading Thunder Client data)', 'showReport', 'pickSettings', 'confirm(6 files into api)', 'applyRestClientSettings', 'done', 'openReport(api/IMPORT_REPORT.md)']);
    assert.ok(existsSync(workspace.path('api/Shop/index.http')));
    assert.equal(reports.length, 1);
    assert.equal(snapshot(source.root), before, 'P6: the source is untouched');
    assert.ok(!readFileSync(workspace.path('api/Shop/index.http'), 'utf8').includes(SECRET));
    assert.ok(readFileSync(workspace.path('api/http-client.private.env.json'), 'utf8').includes(SECRET));
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Cancelling at any step writes nothing', async () => {
  const source = makeTree(data());
  const workspace = makeTree();
  try {
    const before = snapshot(workspace.root);
    for (const [script, at] of [
      [{ choice: undefined }, 'source'],
      [{ choice: { kind: 'path', path: source.root } as const, cancelProgress: true }, 'scan'],
      [{ choice: { kind: 'path', path: source.root } as const, settings: undefined, confirm: false }, 'confirm'],
      [{ choice: { kind: 'folder' } as const, folder: undefined }, 'source']
    ] as const) {
      const { host } = fakeHost({ workspace: workspace.root, ...script });
      const result = await runImportFlow(host, { candidates: [] });
      assert.deepEqual(result, { status: 'cancelled', at });
      assert.equal(snapshot(workspace.root), before);
    }
    assert.deepEqual(readdirSync(workspace.root), []);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Turning secret moving off re-scans and shows the new report', async () => {
  const source = makeTree(data());
  const workspace = makeTree();
  try {
    const { host, calls, reports } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root }, settings: { targetDir: 'out', moveSecrets: false, policy: 'new-folder', target: 'rest-client', applyRestClientSettings: true } });
    const result = await runImportFlow(host, { candidates: [] });
    assert.equal(result.status, 'done');
    assert.equal(calls.filter(call => call.startsWith('progress')).length, 2);
    assert.equal(reports.length, 2);
    assert.ok(readFileSync(workspace.path('out/Shop/index.http'), 'utf8').includes(SECRET), 'the person asked for the secret to stay');
    assert.match(reports[1] ?? '', /TC-SECRET-LITERAL/);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Without an open folder nothing is asked; a missing source and bad settings are errors the person can read', async () => {
  const none = fakeHost({ workspace: undefined });
  assert.deepEqual(await runImportFlow(none.host, { candidates: [] }), { status: 'no-workspace' });
  assert.deepEqual(none.calls, ['error']);

  const workspace = makeTree();
  try {
    const missing = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: workspace.path('nope') } });
    const result = await runImportFlow(missing.host, { candidates: [] });
    assert.deepEqual(result, { status: 'error', message: 'The path does not exist.' });
    assert.deepEqual(missing.errors, ['The path does not exist.']);

    const source = makeTree(data());
    try {
      const bad = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root }, settings: { targetDir: '../outside', moveSecrets: true, policy: 'new-folder', target: 'rest-client', applyRestClientSettings: true } });
      const outcome = await runImportFlow(bad.host, { candidates: [] });
      assert.equal(outcome.status, 'error');
      assert.match(bad.errors[0] ?? '', /target folder is not valid/);
      assert.deepEqual(readdirSync(workspace.root), []);
    } finally { source.cleanup(); }
  } finally { workspace.cleanup(); }
});

test('A folder with nothing to import says so and writes nothing', async () => {
  const source = makeTree({ 'notes.txt': 'hello' });
  const workspace = makeTree();
  try {
    const { host, errors } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root } });
    const result = await runImportFlow(host, { candidates: [] });
    assert.equal(result.status, 'nothing-to-import');
    assert.equal(errors.length, 1);
    assert.deepEqual(readdirSync(workspace.root), []);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('importFromPath rejects with a SourceError for a missing path', async () => {
  await assert.rejects(importFromPath('/definitely/not/here'), SourceError);
});

test('Candidate folders: per system, the editor first, no duplicates, nothing checked on disk', () => {
  assert.deepEqual(candidatePaths({ platform: 'win32', home: 'C:\\Users\\a', appData: 'C:\\Users\\a\\AppData\\Roaming', globalStorageRoot: 'C:\\Users\\a\\AppData\\Roaming\\Cursor\\User\\globalStorage' }), [
    'C:\\Users\\a\\AppData\\Roaming\\Cursor\\User\\globalStorage\\rangav.vscode-thunder-client',
    'C:\\Users\\a\\AppData\\Roaming\\Code\\User\\globalStorage\\rangav.vscode-thunder-client',
    'C:\\Users\\a\\AppData\\Roaming\\Code - Insiders\\User\\globalStorage\\rangav.vscode-thunder-client',
    'C:\\Users\\a\\AppData\\Roaming\\VSCodium\\User\\globalStorage\\rangav.vscode-thunder-client'
  ]);
  const mac = candidatePaths({ platform: 'darwin', home: '/Users/a' });
  assert.equal(mac[0], '/Users/a/Library/Application Support/Code/User/globalStorage/rangav.vscode-thunder-client');
  assert.ok(mac.includes('/Users/a/.vscode-server/data/User/globalStorage/rangav.vscode-thunder-client'));
  const linux = candidatePaths({ platform: 'linux', home: '/home/a', globalStorageRoot: '/home/a/.config/Code/User/globalStorage' });
  assert.equal(linux.filter(p => p.includes('/Code/User/')).length, 1, 'the editor path and the Code path are the same, listed once');
});

test('Candidates are shown only when they exist and hold Thunder Client data, counted by file name', async () => {
  const tree = makeTree({
    'with-data/collections/tc_col_a.json': {}, 'with-data/collections/tc_col_b.json': {}, 'with-data/collections/notes.txt': 'x', 'with-data/environments/tc_env_x.json': {},
    'v3only/thunderclient.json': [],
    'empty/readme.txt': 'nothing'
  });
  try {
    const found: Candidate[] = await inspectCandidates([tree.path('with-data'), tree.path('v3only'), tree.path('empty'), tree.path('missing')]);
    assert.deepEqual(found.map(c => [c.path === tree.path('with-data') ? 'with-data' : c.path === tree.path('v3only') ? 'v3only' : '?', c.collections, c.environments, c.v3]), [['with-data', 2, 1, false], ['v3only', 0, 0, true]]);
  } finally { tree.cleanup(); }
});

// ---- the command line ----

function cli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  return runCli(argv, { stdout: t => { out += t; }, stderr: t => { err += t; }, cwd: () => cwd }).then(code => ({ code, out, err }));
}

test('CLI: a dry run prints the report and the list and writes nothing; --write writes', async () => {
  const source = makeTree(data());
  const workspace = makeTree();
  try {
    const dry = await cli([source.root], workspace.root);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /^# Thunder Client import report/);
    assert.match(dry.out, /Dry run\. 6 files would be written to api\//);
    assert.ok(!dry.out.includes(SECRET));
    assert.deepEqual(readdirSync(workspace.root), []);

    const written = await cli([source.root, '--write'], workspace.root);
    assert.equal(written.code, 0);
    assert.match(written.out, /Wrote 6 files to api\//);
    assert.ok(existsSync(workspace.path('api/http-client.private.env.json')));
    const second = await cli([source.root, '--write', '--out', 'api'], workspace.root);
    assert.match(second.out, /to api-2\//);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('CLI: usage errors are 2, failures are 1, help is 0, and no message carries the data', async () => {
  const workspace = makeTree();
  try {
    assert.equal((await cli([], workspace.root)).code, 2);
    assert.equal((await cli(['--bogus'], workspace.root)).code, 2);
    assert.equal((await cli(['x', '--policy', 'merge'], workspace.root)).code, 2);
    assert.equal((await cli(['x', '--out'], workspace.root)).code, 2);
    assert.equal((await cli(['--help'], workspace.root)).code, 0);
    const missing = await cli([workspace.path('nope')], workspace.root);
    assert.equal(missing.code, 1);
    assert.equal(missing.err, 'The path does not exist.\n');
  } finally { workspace.cleanup(); }
});

// ---- the REST Client settings are filled in for the person ----

const SECRET_KEY = 'secret_shop_bearer_token';

test('With REST Client as the target the flow fills in the settings after the write: variables for the workspace, secrets for the user', async () => {
  const source = makeTree(data());
  const workspace = makeTree();
  try {
    const { host, calls, stores, seen } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root } });
    const result = await runImportFlow(host, { candidates: [] });
    assert.equal(result.status, 'done');
    assert.ok(calls.indexOf('applyRestClientSettings') > calls.indexOf('confirm(6 files into api)') && calls.indexOf('applyRestClientSettings') < calls.indexOf('done'), 'after the write, before the message');
    assert.deepEqual(stores.workspace, { dev: { base: 'https://dev.example' } });
    assert.deepEqual(stores.user, { dev: { [SECRET_KEY]: SECRET } });
    assert.ok(!JSON.stringify(stores.workspace).includes(SECRET), 'a secret never goes to the workspace settings');
    assert.equal(seen.outcome?.status, 'applied');
    assert.deepEqual(seen.outcome?.status === 'applied' ? [seen.outcome.workspace.variables, seen.outcome.user?.variables, seen.outcome.syncExcluded] : [], [1, 1, true]);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('It is not done when the person switched it off, when the target is another tool, or when the settings files were not written', async () => {
  const source = makeTree(data());
  try {
    for (const settings of [
      { targetDir: 'api', moveSecrets: true, policy: 'new-folder', target: 'rest-client', applyRestClientSettings: false },
      { targetDir: 'api', moveSecrets: true, policy: 'new-folder', target: 'httpyac', applyRestClientSettings: true },
      { targetDir: 'api', moveSecrets: true, policy: 'new-folder', target: 'jetbrains', applyRestClientSettings: true }
    ] as const) {
      const workspace = makeTree();
      try {
        const { host, calls } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root }, settings });
        assert.equal((await runImportFlow(host, { candidates: [] })).status, 'done');
        assert.ok(!calls.includes('applyRestClientSettings'), JSON.stringify(settings));
      } finally { workspace.cleanup(); }
    }
    // The private file already exists and is kept (skip-existing): its secrets are not put into the user settings.
    const workspace = makeTree({ 'api/rest-client.private.settings.json': '{}\n' });
    try {
      const { host, seen } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root }, settings: { targetDir: 'api', moveSecrets: true, policy: 'skip-existing', target: 'rest-client', applyRestClientSettings: true } });
      assert.equal((await runImportFlow(host, { candidates: [] })).status, 'done');
      assert.ok(seen.settings !== undefined && seen.settings.secrets === undefined && Object.keys(seen.settings.shareable).length > 0);
    } finally { workspace.cleanup(); }
  } finally { source.cleanup(); }
});

test('A problem with the settings does not turn a finished import into a failure: the files stay and the message says what to do', async () => {
  const source = makeTree(data());
  try {
    for (const restClient of ['missing', 'throws'] as const) {
      const workspace = makeTree();
      try {
        const { host, seen, errors } = fakeHost({ workspace: workspace.root, choice: { kind: 'path', path: source.root }, restClient });
        const result = await runImportFlow(host, { candidates: [] });
        assert.equal(result.status, 'done', restClient);
        assert.ok(existsSync(workspace.path('api/rest-client.settings.json')));
        assert.equal(seen.outcome?.status, restClient === 'missing' ? 'rest-client-missing' : 'failed');
        assert.deepEqual(errors, []);
      } finally { workspace.cleanup(); }
    }
  } finally { source.cleanup(); }
});
