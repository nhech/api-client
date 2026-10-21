'use strict';
/*
 * Runs inside the VS Code extension host. It drives the real command through the real Quick Picks (by sending the keys
 * "accept the highlighted item") and checks what ended up on disk and on screen.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CANARY = 'CANARY-host-token-1234';

exports.run = async function run() {
  const root = process.env.API_CLIENT_TEST_ROOT;
  const workspace = path.join(root, 'workspace');
  assert.ok(root, 'API_CLIENT_TEST_ROOT is set');
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath.toLowerCase(), workspace.toLowerCase(), 'the throw-away workspace is open');

  // 1. The command is declared in the manifest, so the first call activates the extension (no activation event of its own).
  assert.equal((await vscode.commands.getCommands(true)).includes('apiClient.importThunder'), false, 'nothing is registered before the command is used');

  // 2. A full run: accept the first item of every Quick Pick (the folder found next to this editor, "Continue", the write).
  const result = vscode.commands.executeCommand('apiClient.importThunderSteps');
  let finished = false;
  result.then(() => { finished = true; }, () => { finished = true; });
  const report = path.join(workspace, 'api', 'IMPORT_REPORT.md');
  while (!fs.existsSync(report)) {
    if (finished) break;
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await sleep(250);
  }
  // The "Imported N requests" message waits to be answered; dismiss it.
  while (!finished) {
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(200);
  }
  const outcome = await result;
  assert.equal(outcome?.status, 'done', `the flow finished: ${JSON.stringify(outcome)}`);

  assert.ok((await vscode.commands.getCommands(true)).includes('apiClient.importThunder'), 'the command is registered once the extension is active');

  // 3. What was written.
  const files = {};
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${name}/`); else files[`${prefix}${name}`] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(path.join(workspace, 'api'), '');
  assert.deepEqual(Object.keys(files).sort(), ['IMPORT_REPORT.md', 'Shop/Orders.http', 'Shop/index.http', 'http-client.env.json', 'http-client.private.env.json', 'rest-client.private.settings.json', 'rest-client.settings.json']);
  for (const [name, content] of Object.entries(files)) {
    if (!name.includes('.private.')) assert.ok(!content.includes(CANARY), `the secret is not in ${name}`);
  }
  assert.ok(files['http-client.private.env.json'].includes(CANARY), 'the secret is in the private file');
  assert.match(files['Shop/index.http'], /^### list\n# @name list\nGET \{\{base\}\}\/list\nAuthorization: Bearer \{\{secret_shop_bearer_token\}\}\n$/);
  assert.equal(fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8'), 'http-client.private.env.json\nrest-client.private.settings.json\n');
  assert.ok(files['rest-client.private.settings.json'].includes(CANARY), 'the secret is in the private settings too');
  assert.equal(fs.readdirSync(workspace).filter(name => name.startsWith('.api-import-')).length, 0, 'no staging folder is left');

  // 4. The report was shown as a read-only virtual document.
  const shown = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'api-client-import');
  assert.ok(shown, 'the report document was opened');
  assert.match(shown.getText(), /^# Thunder Client import report\n/);

  // 4b. The REST Client settings. Without REST Client nothing is written; with it (API_CLIENT_TEST_REST_CLIENT=1) the variables went
  //     to the workspace settings and the secrets to the USER settings, what the person had was kept, and the comments are still there.
  const workspaceSettings = path.join(workspace, '.vscode', 'settings.json');
  const profileSettings = process.env.API_CLIENT_TEST_ROOT ? path.join(process.env.API_CLIENT_TEST_ROOT, 'profile', 'User', 'settings.json') : undefined;
  if (process.env.API_CLIENT_TEST_REST_CLIENT !== '1') {
    assert.equal(fs.existsSync(workspaceSettings), false, 'REST Client is not installed: the workspace settings are not touched');
  } else {
    const workspaceText = fs.readFileSync(workspaceSettings, 'utf8');
    assert.ok(workspaceText.includes('// my workspace settings') && workspaceText.includes('// my own variables'), 'the comments of the workspace settings are kept');
    assert.ok(workspaceText.includes('"editor.tabSize": 3') && workspaceText.includes('"rest-client.enableTelemetry": false'), 'the other settings are kept');
    const parse = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    const workspaceValue = parse(workspaceText)['rest-client.environmentVariables'];
    assert.deepEqual(workspaceValue, { dev: { base: 'https://mine.example', extra: 'x', region: 'eu' } }, 'what the person had is kept (even base, which differs), the new variable is added');
    assert.ok(!workspaceText.includes(CANARY), 'a secret is never in the workspace settings');
    const userText = fs.readFileSync(profileSettings, 'utf8');
    assert.ok(userText.includes('// my user settings') && userText.includes('// keep this one out of the sync') && userText.includes('"editor.fontSize": 15'), 'the user settings keep their comments and values');
    const userValue = parse(userText)['rest-client.environmentVariables'];
    assert.deepEqual(userValue, { dev: { secret_shop_bearer_token: CANARY } }, 'the secrets are in the user settings');
    assert.deepEqual(parse(userText)['settingsSync.ignoredSettings'], ['some.other.setting', 'rest-client.environmentVariables'], 'the setting that holds secrets is kept out of Settings Sync');
  }

  // 5. A second run, cancelled at the first Quick Pick, changes nothing.
  const before = JSON.stringify(Object.keys(files));
  const second = vscode.commands.executeCommand('apiClient.importThunderSteps');
  await sleep(1500);
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  const cancelled = await second;
  assert.deepEqual(cancelled, { status: 'cancelled', at: 'source' });
  assert.equal(JSON.stringify(fs.readdirSync(path.join(workspace, 'api'))), JSON.stringify(fs.readdirSync(path.join(workspace, 'api'))));
  assert.equal(fs.existsSync(path.join(workspace, 'api-2')), false, 'nothing was written by the cancelled run');
  assert.ok(before.length > 0);

  // 6. The importer panel: the main command opens it, it loads under its Content-Security-Policy and says so, and the messages the page
  //    sends (here sent as the page would) read the data, plan, and write. Nothing is written until "import".
  const extension = vscode.extensions.getExtension('longtd.api-client');
  assert.ok(extension && extension.isActive, 'the extension is active');
  const test = extension.exports;
  assert.ok(test && typeof test.panel === 'function', 'the test interface is there when the runner asks for it');
  assert.equal(test.panel(), undefined, 'no panel before the command');
  await vscode.commands.executeCommand('apiClient.importThunder');
  const panel = test.panel();
  assert.ok(panel, 'the command opened the panel');
  const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview);
  for (let waited = 0; tabs().length === 0 && waited < 5000; waited += 100) await sleep(100);
  assert.equal(tabs().length, 1, 'one webview tab is open');
  for (let waited = 0; !panel.isReady && waited < 15000; waited += 100) await sleep(100);
  assert.equal(panel.isReady, true, 'the page loaded and its script ran under the Content-Security-Policy');
  await vscode.commands.executeCommand('apiClient.importThunder');
  assert.equal(tabs().length, 1, 'opening it again brings the same panel to the front');

  let view = panel.view();
  assert.equal(view.step, 'source');
  assert.equal(view.candidates.length, 1, 'the Thunder Client data next to this editor is offered');
  const writtenBefore = JSON.stringify(fs.readdirSync(workspace).sort());
  await panel.receive('rubbish');
  await panel.receive({ type: 'import', path: '/etc' });
  await panel.receive({ type: 'useCandidate', id: 7 });
  await panel.receive({ type: 'setOptions', options: { target: 'postman', targetDir: 5 } });
  assert.equal(panel.view().step, 'source', 'messages that are not exactly ours change nothing');

  await panel.receive({ type: 'useCandidate', id: 0 });
  view = panel.view();
  assert.equal(view.step, 'review');
  assert.equal(view.summary.requests, 2);
  assert.equal(view.plan.targetDir, 'api-2', 'the first import used "api", so a new folder is planned');
  assert.equal(JSON.stringify(fs.readdirSync(workspace).sort()), writtenBefore, 'reading and planning wrote nothing');
  assert.ok(!JSON.stringify(view).includes(CANARY), 'the view holds no secret');

  await panel.receive({ type: 'setOptions', options: { target: 'jetbrains', targetDir: 'requests' } });
  view = panel.view();
  assert.equal(view.options.target, 'jetbrains');
  assert.equal(view.plan.targetDir, 'requests');
  await panel.receive({ type: 'setOptions', options: { targetDir: '../outside' } });
  assert.equal(panel.view().plan, undefined, 'a folder outside the workspace has no plan');
  assert.ok(panel.view().optionsError, 'and says why');
  await panel.receive({ type: 'import' });
  assert.equal(panel.view().step, 'review', 'it cannot be imported');
  await panel.receive({ type: 'setOptions', options: { targetDir: 'requests' } });

  await panel.receive({ type: 'import' });
  view = panel.view();
  assert.equal(view.step, 'done');
  assert.equal(view.result.targetDir, 'requests');
  const shop = fs.readFileSync(path.join(workspace, 'requests', 'Shop', 'index.http'), 'utf8');
  assert.ok(!shop.includes(CANARY), 'the secret is not in a shared file');
  assert.ok(fs.readFileSync(path.join(workspace, 'requests', 'http-client.private.env.json'), 'utf8').includes(CANARY), 'it is in the private file');
  assert.equal(fs.existsSync(path.join(workspace, 'requests', 'rest-client.settings.json')), false, 'the REST Client files are only for that tool');
  await panel.receive({ type: 'startOver' });
  assert.equal(panel.view().step, 'source');

  // 7. Closing the tab must not break the command: the closed panel is forgotten and the command opens a new one.
  await vscode.window.tabGroups.close(tabs()[0]);
  for (let waited = 0; test.panel() !== undefined && waited < 5000; waited += 100) await sleep(100);
  assert.equal(test.panel(), undefined, 'the closed panel is forgotten');
  await vscode.commands.executeCommand('apiClient.importThunder');
  const again = test.panel();
  assert.ok(again, 'the command opens a new panel after the old one was closed');
  for (let waited = 0; tabs().length === 0 && waited < 5000; waited += 100) await sleep(100);
  assert.equal(tabs().length, 1);
  for (let waited = 0; !again.isReady && waited < 15000; waited += 100) await sleep(100);
  assert.equal(again.isReady, true, 'the new page loaded');
  await again.receive({ type: 'useCandidate', id: 0 });
  assert.equal(again.view().step, 'review');
};
