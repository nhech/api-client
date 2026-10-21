import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Candidate } from '../../src/discover';
import type { RestClientSettingsOutcome } from '../../src/host';
import type { RestClientSettings } from '../../src/settings-merge';
import { parseToHost } from '../../src/wizard/protocol';
import { WizardSession } from '../../src/wizard/session';
import type { SessionDependencies } from '../../src/wizard/session';
import { makeTree } from '../support/tree';

const SECRET_TOKEN = 'CANARY-wizard-token-1111';
const SECRET_VARIABLE = 'CANARY-wizard-variable-2222';

const thunder = () => makeTree({
  'collections/tc_col_shop.json': {
    _id: 'c1', colName: 'Shop', folders: [{ _id: 'f1', name: 'Orders', containerId: '' }],
    requests: [
      { _id: 'r1', colId: 'c1', containerId: '', name: 'list', url: 'https://example.invalid/{{#guid}}', method: 'GET', auth: { type: 'bearer', bearer: SECRET_TOKEN } },
      { _id: 'r2', colId: 'c1', containerId: 'f1', name: 'get', url: 'https://example.invalid/x', method: 'GET' },
      { _id: 'r3', colId: 'c1', containerId: '', name: 'socket', url: 'wss://example.invalid/', method: 'GET', reqType: 'ws' }
    ]
  },
  'environments/tc_env_dev.json': { _id: 'e1', name: 'dev', data: [{ name: 'api_token', value: SECRET_VARIABLE }, { name: 'base', value: 'https://dev.example.invalid' }] }
});

interface Harness { session: WizardSession; changes: number; applied: RestClientSettings[]; root: string | undefined }

function harness(workspaceRoot: string | undefined, options: { candidates?: Candidate[]; restClient?: RestClientSettingsOutcome } = {}): Harness {
  const state: Harness = { session: undefined as unknown as WizardSession, changes: 0, applied: [], root: workspaceRoot };
  const deps: SessionDependencies = {
    workspaceRoot: () => state.root,
    workspaceName: () => 'project',
    home: '/home/me',
    candidates: options.candidates ?? [],
    restClientInstalled: () => true,
    applyRestClientSettings: async settings => { state.applied.push(settings); return options.restClient ?? { status: 'rest-client-missing' }; },
    changed: () => { state.changes++; }
  };
  state.session = new WizardSession(deps);
  return state;
}

test('The panel messages: only the known shapes are accepted, extra fields are ignored', () => {
  for (const type of ['ready', 'chooseFolder', 'chooseFiles', 'cancelScan', 'import', 'startOver', 'openReportPreview', 'openFolder', 'openWrittenReport', 'openWorkspace']) {
    assert.deepEqual(parseToHost({ type, path: '/etc/passwd', extra: 1 }), { type });
  }
  assert.deepEqual(parseToHost({ type: 'useCandidate', id: 2 }), { type: 'useCandidate', id: 2 });
  for (const bad of [undefined, null, 5, 'ready', [], {}, { type: 5 }, { type: 'unknown' }, { type: 'useCandidate' }, { type: 'useCandidate', id: -1 }, { type: 'useCandidate', id: 1.5 }, { type: 'useCandidate', id: 1000 }, { type: 'useCandidate', id: '1' }, { type: 'setOptions' }, { type: 'setOptions', options: 3 }, { type: 'setOptions', options: {} }]) {
    assert.equal(parseToHost(bad), undefined, JSON.stringify(bad));
  }
});

test('The panel messages: an option of the wrong type is dropped and a good one next to it is kept', () => {
  assert.deepEqual(parseToHost({ type: 'setOptions', options: { target: 'jetbrains', policy: 'overwrite', moveSecrets: false, applyRestClientSettings: true, targetDir: 'requests', other: 'x' } }),
    { type: 'setOptions', options: { target: 'jetbrains', policy: 'overwrite', moveSecrets: false, applyRestClientSettings: true, targetDir: 'requests' } });
  assert.deepEqual(parseToHost({ type: 'setOptions', options: { target: 'postman', policy: 'delete', moveSecrets: 'yes', targetDir: 7, applyRestClientSettings: false } }), { type: 'setOptions', options: { applyRestClientSettings: false } });
  assert.equal(parseToHost({ type: 'setOptions', options: { targetDir: 'x'.repeat(201) } }), undefined);
  assert.ok(parseToHost({ type: 'setOptions', options: { targetDir: 'x'.repeat(200) } }));
});

test('The panel messages: inherited and prototype properties do not count', () => {
  assert.equal(parseToHost(JSON.parse('{"__proto__":{"type":"import"}}')), undefined);
  assert.equal(parseToHost(Object.create({ type: 'import' })), undefined);
  assert.equal(parseToHost(JSON.parse('{"type":"setOptions","options":{"__proto__":{"target":"jetbrains"}}}')), undefined);
  assert.equal(parseToHost(JSON.parse('{"type":"setOptions","options":{"constructor":{"target":"jetbrains"}}}')), undefined);
});

test('The panel starts at the source step, with the suggestions and the workspace, and nothing else', () => {
  const { session } = harness('/work', { candidates: [{ path: '/home/me/.config/Code/User/globalStorage/rangav.vscode-thunder-client', collections: 4, environments: 1, v3: false }] });
  const view = session.view();
  assert.equal(view.step, 'source');
  assert.equal(view.busy, undefined);
  assert.deepEqual(view.workspace, { open: true, name: 'project' });
  assert.deepEqual(view.candidates, [{ id: 0, title: 'Thunder Client data on this computer', detail: '~/.config/Code/User/globalStorage/rangav.vscode-thunder-client', counts: '4 collections, 1 environment' }]);
  assert.equal(view.summary, undefined);
  assert.equal(view.plan, undefined);
  assert.deepEqual(view.options, { target: 'rest-client', policy: 'new-folder', moveSecrets: true, applyRestClientSettings: true, targetDir: 'api' });
});

test('Choosing a source reads it and shows what would be written; nothing is written and no value is in the view', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    const view = h.session.view();
    assert.equal(view.step, 'review');
    assert.equal(view.busy, undefined);
    assert.deepEqual({ collections: view.summary?.collections, requests: view.summary?.requests, skipped: view.summary?.skippedRequests, environments: view.summary?.environments }, { collections: 1, requests: 2, skipped: 1, environments: 1 });
    assert.ok(view.plan !== undefined && view.plan.targetDir === 'api' && view.plan.writes === view.plan.fileTotal && view.plan.writes > 3);
    assert.ok(view.plan.files.some(file => file.path.endsWith('IMPORT_REPORT.md') && file.action === 'create'));
    assert.deepEqual(readdirSync(workspace.root), [], 'nothing was written');
    const text = JSON.stringify(view);
    assert.ok(!text.includes('CANARY'), 'no value reached the view');
    const severities = view.findings.map(finding => finding.severity);
    assert.deepEqual([...severities].sort((a, b) => ['error', 'warn', 'info'].indexOf(a) - ['error', 'warn', 'info'].indexOf(b)), severities, 'the findings are ordered, worst first');
    assert.ok(h.changes >= 2, 'the panel was told when the reading started and when it ended');
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('A folder with nothing to import shows what was found and cannot be imported; a path that cannot be read goes back to the source step', async () => {
  const empty = makeTree();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(empty.root, 'Thunder Client data', 'a folder');
    const view = h.session.view();
    assert.equal(view.step, 'review');
    assert.equal(view.message?.kind, 'error');
    assert.equal(view.plan, undefined);
    assert.equal(view.summary?.requests, 0);
    await h.session.write();
    assert.deepEqual(readdirSync(workspace.root), [], 'there is nothing to write');
    await h.session.useSource(join(empty.root, 'missing'), 'x', 'y');
    const missing = h.session.view();
    assert.equal(missing.step, 'source');
    assert.equal(missing.message?.kind, 'error');
    assert.equal(missing.summary, undefined);
  } finally { empty.cleanup(); workspace.cleanup(); }
});

test('Starting over while a source is being read leaves the source step, whatever the reading finds', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    const reading = h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    h.session.startOver();
    await reading;
    const view = h.session.view();
    assert.equal(view.step, 'source');
    assert.equal(view.summary, undefined);
    assert.equal(view.busy, undefined);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Changing the tool reads the data again and writes for the new tool; changing the policy only plans again', async () => {
  const source = thunder();
  const workspace = makeTree({ 'api/old.txt': 'something' });
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    assert.match(h.session.reportMarkdown(), /Written for REST Client/);
    assert.equal(h.session.view().plan?.targetDir, 'api-2', 'a folder that has files is not used');
    assert.equal(h.session.view().plan?.renamed, true);

    await h.session.setOptions({ target: 'jetbrains' });
    assert.match(h.session.reportMarkdown(), /Written for JetBrains/);
    assert.equal(h.session.view().options.target, 'jetbrains');

    await h.session.setOptions({ policy: 'overwrite' });
    const plan = h.session.view().plan;
    assert.equal(plan?.targetDir, 'api');
    assert.equal(plan?.renamed, false);
    assert.equal(h.session.view().step, 'review');
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('A target folder that cannot be used is a message beside the field, and the plan comes back when it is fixed', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    for (const bad of ['../outside', '/etc', 'C:/Windows', '', 'a/../../b']) {
      await h.session.setOptions({ targetDir: bad });
      const view = h.session.view();
      assert.equal(view.plan, undefined, bad);
      assert.ok(typeof view.optionsError === 'string' && view.optionsError.length > 0, bad);
      await h.session.write();
      assert.equal(h.session.view().step, 'review', 'nothing is written while the folder is not valid');
      assert.deepEqual(readdirSync(workspace.root), [], bad);
    }
    await h.session.setOptions({ targetDir: 'requests/thunder' });
    assert.equal(h.session.view().optionsError, undefined);
    assert.equal(h.session.view().plan?.targetDir, 'requests/thunder');
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Without an open folder the files can be read but not written, and the person is told', async () => {
  const source = thunder();
  try {
    const h = harness(undefined);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    const view = h.session.view();
    assert.equal(view.workspace.open, false);
    assert.equal(view.step, 'review');
    assert.equal(view.plan, undefined);
    await h.session.write();
    assert.equal(h.session.view().step, 'review');
    assert.equal(h.session.view().message?.kind, 'error');
    assert.match(h.session.view().message?.text ?? '', /Open a folder first/);
  } finally { source.cleanup(); }
});

test('Import writes the files, keeps the secrets in the private file, fills in the REST Client settings and says what happened', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root, { restClient: { status: 'applied', workspace: { environments: 1, variables: 2, kept: [] }, user: { environments: 1, variables: 3, kept: ['dev.token'] }, syncExcluded: true } });
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    await h.session.write();
    const view = h.session.view();
    assert.equal(view.step, 'done');
    assert.equal(view.busy, undefined);
    assert.equal(view.result?.targetDir, 'api');
    assert.equal(view.result?.requests, 2);
    assert.ok((view.result?.written ?? 0) > 3);
    assert.ok(view.result?.notes.some(note => note.startsWith('REST Client settings: 5 variables added')), JSON.stringify(view.result?.notes));
    assert.equal(h.applied.length, 1, 'the settings are filled in once');
    assert.equal(h.session.writtenFolder(), 'api');
    assert.equal(h.session.writtenReport(), 'api/IMPORT_REPORT.md');
    const shared = readFileSync(join(workspace.root, 'api', 'Shop', 'index.http'), 'utf8');
    assert.ok(!shared.includes(SECRET_TOKEN), 'the token is not in a shared file');
    const privateFile = readFileSync(join(workspace.root, 'api', 'http-client.private.env.json'), 'utf8');
    assert.ok(privateFile.includes(SECRET_TOKEN) && privateFile.includes(SECRET_VARIABLE));
    assert.match(readFileSync(join(workspace.root, '.gitignore'), 'utf8'), /http-client\.private\.env\.json/);
    assert.ok(!JSON.stringify(view).includes('CANARY'));
    // Changing a choice after the import does nothing; starting over goes back to the first step.
    await h.session.setOptions({ target: 'httpyac' });
    assert.equal(h.session.view().options.target, 'rest-client');
    h.session.startOver();
    assert.equal(h.session.view().step, 'source');
    assert.equal(h.session.view().result, undefined);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Import with another tool does not touch the REST Client settings, and a failing settings change does not undo the import', async () => {
  const source = thunder();
  const workspace = makeTree();
  const other = makeTree();
  try {
    const jetbrains = harness(workspace.root);
    await jetbrains.session.useSource(source.root, 'Thunder Client data', 'a folder');
    await jetbrains.session.setOptions({ target: 'jetbrains' });
    await jetbrains.session.write();
    assert.equal(jetbrains.session.view().step, 'done');
    assert.equal(jetbrains.applied.length, 0);
    assert.ok(!existsSync(join(workspace.root, 'api', 'rest-client.settings.json')));

    const failing = harness(other.root, { restClient: { status: 'failed', message: 'locked' } });
    await failing.session.useSource(source.root, 'Thunder Client data', 'a folder');
    await failing.session.write();
    const view = failing.session.view();
    assert.equal(view.step, 'done');
    assert.ok(view.result?.notes.some(note => note.includes('could not be changed (locked)')));
    assert.ok(existsSync(join(other.root, 'api', 'Shop', 'index.http')));
  } finally { source.cleanup(); workspace.cleanup(); other.cleanup(); }
});

test('Turning off the move of secrets leaves them in the shared files, and the view still shows no value', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    await h.session.setOptions({ moveSecrets: false });
    assert.ok(h.session.view().findings.some(finding => finding.code === 'TC-SECRET-LITERAL'));
    assert.ok(!JSON.stringify(h.session.view()).includes('CANARY'));
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Export files are described by their names', () => {
  const { session } = harness('/work');
  assert.deepEqual(session.describeFiles(['/a/b/one.json']), { title: 'Export file', detail: 'one.json' });
  assert.deepEqual(session.describeFiles(['/a/1.json', '/a/2.json', '/a/3.json', '/a/4.json', '/a/5.json']), { title: '5 export files', detail: '1.json, 2.json, 3.json and 2 more' });
});

test('Plans that overlap end with the plan of the last choice, whichever finishes last', async () => {
  const source = thunder();
  const workspace = makeTree({ 'api/old.txt': 'x' });
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    const first = h.session.setOptions({ policy: 'overwrite' });
    const second = h.session.setOptions({ policy: 'new-folder' });
    const third = h.session.setOptions({ policy: 'skip-existing' });
    await Promise.all([first, second, third]);
    const view = h.session.view();
    assert.equal(view.options.policy, 'skip-existing');
    assert.equal(view.plan?.targetDir, 'api', 'the plan is the one of the last choice');
    assert.equal(view.plan?.renamed, false);
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Import writes only the plan that was shown: when the folder changed since, it plans again and writes nothing', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    assert.equal(h.session.view().plan?.targetDir, 'api');
    // Something else makes the folder in the meantime.
    const other = makeTree({ 'api/mine.txt': 'keep me' });
    h.root = other.root;
    try {
      await h.session.write();
      let view = h.session.view();
      assert.equal(view.step, 'review', 'nothing was imported');
      assert.equal(view.message?.kind, 'info');
      assert.match(view.message?.text ?? '', /nothing was written/);
      assert.equal(view.plan?.targetDir, 'api-2', 'the plan on screen is the new one');
      assert.deepEqual(readdirSync(join(other.root, 'api')), ['mine.txt']);
      await h.session.write();
      view = h.session.view();
      assert.equal(view.step, 'done', 'the second press writes the plan that was shown');
      assert.equal(view.result?.targetDir, 'api-2');
      assert.equal(readFileSync(join(other.root, 'api', 'mine.txt'), 'utf8'), 'keep me');
    } finally { other.cleanup(); }
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('When the workspace changes the plan is made again for the new one', async () => {
  const source = thunder();
  const first = makeTree();
  const second = makeTree({ 'api/mine.txt': 'x' });
  try {
    const h = harness(first.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    assert.equal(h.session.view().plan?.targetDir, 'api');
    h.root = second.root;
    await h.session.workspaceChanged();
    assert.equal(h.session.view().plan?.targetDir, 'api-2');
    h.root = undefined;
    await h.session.workspaceChanged();
    assert.equal(h.session.view().plan, undefined);
    assert.equal(h.session.view().workspace.open, false);
  } finally { source.cleanup(); first.cleanup(); second.cleanup(); }
});

test('While the files are being written nothing can start over, read another source or change a choice; afterwards it can', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    const writing = h.session.write();
    assert.equal(h.session.view().busy, 'writing');
    h.session.startOver();
    await h.session.useSource(source.root, 'again', 'again');
    await h.session.setOptions({ target: 'httpyac' });
    await h.session.write();
    await writing;
    const view = h.session.view();
    assert.equal(view.step, 'done');
    assert.equal(view.options.target, 'rest-client');
    assert.equal(view.message, undefined, 'there was no second write to fail');
    assert.equal(h.session.hasWritten, true);
    h.session.startOver();
    assert.equal(h.session.hasWritten, false);
    assert.equal(h.session.view().step, 'source');
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('When reading again fails, the choices go back to the ones the screen was read with', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    source.cleanup();
    await h.session.setOptions({ moveSecrets: false });
    const view = h.session.view();
    assert.equal(view.message?.kind, 'error');
    assert.equal(view.options.moveSecrets, true, 'the box shows what the files on screen were made with');
    assert.ok(view.plan !== undefined && view.step === 'review');
  } finally { workspace.cleanup(); }
});

test('The REST Client settings are filled in only when the secrets were moved, so that no literal secret reaches the workspace settings', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    await h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    await h.session.setOptions({ moveSecrets: false });
    await h.session.write();
    assert.equal(h.session.view().step, 'done');
    assert.equal(h.applied.length, 0, 'not applied with the secrets left in the files');
  } finally { source.cleanup(); workspace.cleanup(); }
});

test('Closing the panel stops a reading and leaves the session quiet', async () => {
  const source = thunder();
  const workspace = makeTree();
  try {
    const h = harness(workspace.root);
    const reading = h.session.useSource(source.root, 'Thunder Client data', 'a folder');
    h.session.close();
    await reading;
    assert.equal(h.session.view().step, 'source');
    assert.equal(h.session.view().summary, undefined);
  } finally { source.cleanup(); workspace.cleanup(); }
});
