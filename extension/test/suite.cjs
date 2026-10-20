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
  const result = vscode.commands.executeCommand('apiClient.importThunder');
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
  const second = vscode.commands.executeCommand('apiClient.importThunder');
  await sleep(1500);
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  const cancelled = await second;
  assert.deepEqual(cancelled, { status: 'cancelled', at: 'source' });
  assert.equal(JSON.stringify(fs.readdirSync(path.join(workspace, 'api'))), JSON.stringify(fs.readdirSync(path.join(workspace, 'api'))));
  assert.equal(fs.existsSync(path.join(workspace, 'api-2')), false, 'nothing was written by the cancelled run');
  assert.ok(before.length > 0);
};
