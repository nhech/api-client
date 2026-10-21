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

  // 8. The side bar of the client: it reads the files of the workspace, follows changes on disk (a pull, an edit by hand), filters, and
  //    every command of the manifest is registered.
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const registered = await vscode.commands.getCommands(true);
  for (const entry of manifest.contributes.commands) assert.ok(registered.includes(entry.command), 'registered: ' + entry.command);
  const put = (relative, content) => {
    const target = path.join(workspace, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  assert.deepEqual(test.client().collections, [], 'no collection before there are files');
  put('api-client/collections/shop/collection.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAA\nname: Shop\n');
  put('api-client/collections/shop/list.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABC\nname: List things\nmethod: GET\nurl: http://x.test/things\n');
  put('api-client/environments/dev.env.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAC\nname: Dev\nvars:\n  - name: a\n    value: 1\n');
  const until = async (check, what) => { for (let waited = 0; !check() && waited < 8000; waited += 100) await sleep(100); assert.ok(check(), what); };
  await until(() => test.client().collections.length === 1, 'the watcher loads the new files without a refresh');
  let collections = test.client().collections;
  assert.deepEqual([collections[0].kind, collections[0].label, collections[0].description], ['collection', 'Shop', '1 request']);
  assert.deepEqual(collections[0].children.map(child => [child.label, child.description, child.contextValue]), [['List things', 'GET', 'request']]);
  assert.deepEqual(test.client().environments.map(node => [node.label, node.description]), [['Dev', '1 variable']]);

  put('api-client/collections/shop/second.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ABD\nname: Second\nmethod: POST\nurl: http://x.test/second\n');
  await until(() => test.client().collections[0].children.length === 2, 'a file added on disk shows up');
  test.client().setFilter('second');
  collections = test.client().collections;
  assert.deepEqual(collections[0].children.map(child => child.label), ['Second'], 'the filter keeps what matches');
  test.client().setFilter('');
  assert.equal(test.client().collections[0].children.length, 2, 'clearing the filter shows everything again');

  put('api-client/collections/shop/broken.req.yml', 'name: [oops\n');
  await until(() => test.client().collections.some(node => node.kind === 'broken'), 'a file that cannot be read is listed, not hidden');
  assert.match(test.client().collections.find(node => node.kind === 'broken').tooltip, /line 1, column 7/);
  fs.rmSync(path.join(workspace, 'api-client', 'collections', 'shop', 'second.req.yml'));
  await until(() => test.client().collections[0].children.length === 1, 'a file removed on disk goes away');
  // 9. The request editor: the command opens the page over the file, the page loads under its policy, an edit of the page becomes a small change of the
  //    document, a change of the document reaches the page, a stale or invalid edit changes nothing, and a file that cannot be read is shown read-only.
  const requestPath = path.join(workspace, 'api-client', 'collections', 'shop', 'list.req.yml');
  const requestUri = vscode.Uri.file(requestPath);
  await vscode.commands.executeCommand('apiClient.openRequest', 'api-client/collections/shop/list.req.yml');
  const editor = () => test.requestEditor(requestUri.toString());
  await until(() => editor() !== undefined && editor().isReady, 'the page loaded under its Content-Security-Policy and says it is ready');
  assert.deepEqual(editor().violations, [], 'nothing was refused by the policy');
  await until(() => editor().lastMessage()?.type === 'init', 'the page was told what the file holds');
  const init = editor().lastMessage();
  assert.deepEqual([init.request.name, init.request.method, init.request.url, init.readOnly], ['List things', 'GET', 'http://x.test/things', undefined]);
  const document = await vscode.workspace.openTextDocument(requestUri);
  const original = document.getText();

  await editor().receive({ type: 'edit', rev: init.rev, ops: [{ op: 'set', path: ['url'], value: 'http://x.test/changed' }, { op: 'insert', path: ['headers'], index: 0, value: { name: 'X-Test', value: '1', enabled: true, description: '' } }] });
  assert.match(document.getText(), /url: http:\/\/x\.test\/changed\n/);
  assert.match(document.getText(), /headers:\n {2}- name: X-Test\n {4}value: 1\n/);
  assert.equal(document.isDirty, true, 'the document is dirty, so VS Code saves, backs up and undoes it');
  const after = editor().lastMessage();
  assert.deepEqual([after.type, after.cause, after.rev, after.request.url], ['doc', 'self', init.rev + 1, 'http://x.test/changed']);

  await editor().receive({ type: 'edit', rev: init.rev, ops: [{ op: 'set', path: ['name'], value: 'Stale' }] });
  assert.ok(!document.getText().includes('Stale'), 'an edit made on an old version changes nothing');
  assert.equal(editor().lastMessage().type, 'doc', 'and the page is given the current file');
  await editor().receive({ type: 'edit', rev: editor().lastMessage().rev, ops: [{ op: 'set', path: ['method'], value: 'GE T' }] });
  assert.equal(editor().lastMessage().type, 'rejected');
  assert.match(editor().lastMessage().reason, /method: not a valid HTTP method/);
  assert.ok(!document.getText().includes('GE T'));
  await editor().receive({ type: 'edit', rev: 1, ops: [{ op: 'set', path: ['id'], value: 'x' }] });
  await editor().receive('rubbish');
  await editor().receive({ type: 'edit', ops: [] });

  const typed = new vscode.WorkspaceEdit();
  typed.replace(requestUri, new vscode.Range(document.positionAt(document.getText().indexOf('changed')), document.positionAt(document.getText().indexOf('changed') + 'changed'.length)), 'typed');
  await vscode.workspace.applyEdit(typed);
  await until(() => editor().lastMessage()?.cause === 'disk' && editor().lastMessage().request.url === 'http://x.test/typed', 'a change made in the text editor reaches the page');
  assert.ok(document.getText().startsWith('schema: 1\n'));
  await document.save();
  assert.match(fs.readFileSync(requestPath, 'utf8'), /url: http:\/\/x\.test\/typed\n/);
  assert.notEqual(fs.readFileSync(requestPath, 'utf8'), original);

  put('api-client/collections/shop/unreadable.req.yml', 'schema: 1\nname: [oops\n');
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'shop', 'unreadable.req.yml')), 'apiClient.request');
  const unreadableKey = vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'shop', 'unreadable.req.yml')).toString();
  await until(() => test.requestEditor(unreadableKey)?.lastMessage()?.type === 'init', 'a file that cannot be read still opens');
  const unreadable = test.requestEditor(unreadableKey);
  assert.match(unreadable.lastMessage().readOnly, /cannot be read as a request: line 2, column 7/);
  await unreadable.receive({ type: 'edit', rev: unreadable.lastMessage().rev, ops: [{ op: 'set', path: ['url'], value: 'x' }] });
  assert.equal(unreadable.lastMessage().type, 'rejected', 'nothing can be edited in it');
  const newerKey = vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'shop', 'newer.req.yml'));
  put('api-client/collections/shop/newer.req.yml', 'schema: 9\nname: Future\nthing: 1\n');
  await vscode.commands.executeCommand('vscode.openWith', newerKey, 'apiClient.request');
  await until(() => test.requestEditor(newerKey.toString())?.lastMessage()?.type === 'init', 'a file of a newer version opens');
  assert.match(test.requestEditor(newerKey.toString()).lastMessage().readOnly, /newer version/);

  // 10. Sending: a request of a collection goes to a server in this process with the variables of the active environment, its folders'
  //     authentication and its own headers; the answer comes back as the page shows it, a failure is explained, a send can be cancelled, and
  //     the secrets are hidden in what is shown of the request.
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith('/json')) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Set-Cookie', ['sid=abc12345; Path=/; HttpOnly', 'theme=dark']);
        res.end('{"ok":true,"big":12345678901234567890,"echo":"super-secret-value-9"}');
      } else if (req.url.startsWith('/slow')) {
        setTimeout(() => { res.end('late'); }, 20000).unref();
      } else if (req.url.startsWith('/png')) {
        res.setHeader('Content-Type', 'image/png');
        res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
      } else {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('nothing here');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    put('api-client/environments/dev.env.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAC\nname: Dev\nvars:\n  - name: base\n    value: ' + base + '\n  - name: token\n    value: ""\n    secret: true\n');
    put('api-client/environments/dev.env.local.yml', 'schema: 1\nvalues:\n  token: super-secret-value-9\n');
    put('api-client/collections/shop/collection.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAA\nname: Shop\nauth:\n  kind: bearer\n  token: "{{token}}"\nheaders:\n  - name: X-Shop\n    value: s\n');
    const sendPath = 'api-client/collections/shop/send.req.yml';
    put(sendPath, 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASE\nname: Send\nmethod: POST\nurl: "{{base}}/json?x=1"\nheaders:\n  - name: X-Own\n    value: mine\nbody:\n  kind: json\n  text: |-\n    {"a":1,"t":"{{token}}"}\n');
    put('api-client/collections/shop/missing.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASF\nname: Missing\nurl: "{{base}}/nothing"\n');
    put('api-client/collections/shop/slow.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASG\nname: Slow\nurl: "{{base}}/slow"\n');
    put('api-client/collections/shop/picture.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASH\nname: Picture\nurl: "{{base}}/png"\n');
    put('api-client/collections/shop/novar.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASI\nname: No variable\nurl: "{{nowhere}}/x"\n');
    put('api-client/collections/shop/closed.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASJ\nname: Closed\nurl: http://127.0.0.1:1/\n');
    await until(() => test.client().collections[0].children.filter(child => child.kind === 'request').length >= 7, 'the watcher loads the requests');
    await until(() => test.client().environments.length === 1 && test.client().workspace.loaded?.environments[0]?.environment.vars[0]?.value === base, 'and the environment');
    await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC');

    const open = async name => {
      const uri = vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'shop', name));
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, name + ' is open');
      return test.requestEditor(uri.toString());
    };
    const answer = async (view, type) => { await until(() => view.messages().some(message => message.type === type), 'the page was told: ' + type); return view.messages().filter(message => message.type === type).at(-1); };

    // 10a. The request goes out as written, and the answer is what the page shows.
    const sendView = await open('send.req.yml');
    await sendView.receive({ type: 'send' });
    const done = await answer(sendView, 'response');
    assert.deepEqual(sendView.messages().map(message => message.type).filter(type => type === 'sending' || type === 'response'), ['sending', 'response']);
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0].method, seen[0].url, seen[0].headers['x-own'], seen[0].headers['x-shop'], seen[0].headers.authorization, seen[0].headers['content-type']], ['POST', '/json?x=1', 'mine', 's', 'Bearer super-secret-value-9', 'application/json']);
    assert.equal(seen[0].body, '{"a":1,"t":"super-secret-value-9"}', 'variables are replaced in the body');
    const view = done.response;
    assert.deepEqual([view.status, view.statusText, view.body.kind, view.body.language, view.body.mediaType], [200, 'OK', 'text', 'json', 'application/json']);
    assert.match(view.body.pretty, /"big": 12345678901234567890,/, 'numbers are not rounded');
    assert.deepEqual(view.cookies.map(cookie => [cookie.name, cookie.httpOnly]), [['sid', true], ['theme', false]]);
    assert.deepEqual(view.sent.headers.find(([name]) => name === 'Authorization'), ['Authorization', '[redacted]'], 'the credential is hidden in what was sent');
    assert.ok(!view.sent.body.includes('super-secret-value-9') && view.sent.body.includes('[redacted]'), 'and the value of the secret in the body');
    assert.ok(!view.sent.url.includes('super-secret'), 'nor in the address');
    assert.ok(view.timings.totalMs >= 0 && view.size > 0);
    assert.deepEqual(sendView.violations, [], 'drawing the answer broke no rule of the policy');
    // The page is told which variables the request can use, so that it can mark a name as known or not; the value of a secret is not among them.
    const told = sendView.messages().filter(message => message.type === 'vars').at(-1);
    assert.equal(told.complete, true);
    assert.deepEqual(told.vars.filter(item => ['base', 'token'].includes(item.name)).map(item => [item.name, item.secret, item.value === '' ? 'empty' : 'value', item.source]), [['base', false, 'value', 'environment Dev'], ['token', true, 'empty', 'environment Dev']]);
    assert.ok(!JSON.stringify(told).includes('super-secret-value-9'), 'the secret never reaches the page');
    const countBefore = sendView.messages().filter(message => message.type === 'vars').length;
    await test.client().workspace.setActiveEnvironment(undefined);
    await until(() => sendView.messages().filter(message => message.type === 'vars').length > countBefore, 'a change of environment is told to the page');
    assert.equal(sendView.messages().filter(message => message.type === 'vars').at(-1).vars.some(item => item.name === 'base'), false, 'without the environment its variables are gone');
    await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC');

    // 10b. The same request again: the cookie of the server goes with it (the jar), and the first answer is replaced.
    await sendView.receive({ type: 'send' });
    await until(() => sendView.messages().filter(message => message.type === 'response').length === 2, 'the second answer');
    assert.equal(seen[1].headers.cookie, 'sid=abc12345; theme=dark', 'what the server set comes back');

    // 10c. A status that is not 2xx is an answer, not a failure; a variable with no value is sent as written and said so; an unreachable port is explained.
    const missing = await open('missing.req.yml');
    await missing.receive({ type: 'send' });
    const notFound = (await answer(missing, 'response')).response;
    assert.deepEqual([notFound.status, notFound.body.raw], [404, 'nothing here']);
    const novar = await open('novar.req.yml');
    await novar.receive({ type: 'send' });
    const unresolved = await answer(novar, 'failed');
    assert.equal(unresolved.code, 'invalid-request');
    assert.match(unresolved.message, /variables that have no value: nowhere/);
    const closed = await open('closed.req.yml');
    await closed.receive({ type: 'send' });
    const refused = await answer(closed, 'failed');
    assert.equal(refused.code, 'refused');
    assert.ok(refused.message.length > 10 && refused.hint.length > 10, 'a sentence that says what happened and what to try');

    // 10d. A picture arrives as a data address of a type from the list.
    const picture = await open('picture.req.yml');
    await picture.receive({ type: 'send' });
    const image = (await answer(picture, 'response')).response;
    assert.deepEqual([image.body.kind, image.body.image.startsWith('data:image/png;base64,')], ['image', true]);
    await until(() => picture.violations.length === 0, 'the policy had nothing to refuse');

    // 10e. A send can be cancelled, and the page is told; a second cancel changes nothing; another send then works.
    const slow = await open('slow.req.yml');
    await slow.receive({ type: 'send' });
    await until(() => slow.isSending, 'the send is on its way');
    await slow.receive({ type: 'cancel' });
    await answer(slow, 'cancelled');
    assert.equal(slow.isSending, false);
    await slow.receive({ type: 'cancel' });
    assert.equal(slow.lastMessage().type, 'cancelled');

    // 10f. A send reads the file as it is now, edits that came just before it included, even when they have not been saved.
    const edited = await open('send.req.yml');
    const before = edited.messages().length;
    await edited.receive({ type: 'edit', rev: edited.state().rev, ops: [{ op: 'set', path: ['url'], value: base + '/json?edited=1' }] });
    await edited.receive({ type: 'send' });
    await until(() => edited.messages().slice(before).some(message => message.type === 'response'), 'the answer to the edited request');
    assert.equal(seen.at(-1).url, '/json?edited=1');

    // 10g. A file outside a collection, or a request that cannot be read, is not sent, and says why.
    put('api-client/loose.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1ASK\nname: Loose\nurl: ' + base + '/json\n');
    const loose = vscode.Uri.file(path.join(workspace, 'api-client', 'loose.req.yml'));
    await vscode.commands.executeCommand('vscode.openWith', loose, 'apiClient.request');
    await until(() => test.requestEditor(loose.toString())?.isReady === true, 'the loose file is open');
    await test.requestEditor(loose.toString()).receive({ type: 'send' });
    assert.match((await answer(test.requestEditor(loose.toString()), 'failed')).message, /not in a collection/);
    assert.deepEqual(test.requestEditor(loose.toString()).messages().filter(message => message.type === 'vars').at(-1).complete, false, 'a file outside a collection has no list of variables to be judged by');
    const unreadableView = test.requestEditor(vscode.Uri.file(path.join(workspace, 'api-client', 'collections', 'shop', 'unreadable.req.yml')).toString());
    if (unreadableView) {
      await unreadableView.receive({ type: 'send' });
      assert.match((await answer(unreadableView, 'failed')).message, /cannot be read as a request/);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }

  // 11. Organising what the side bar shows: rename, copy, move (with the order), refuse what makes no sense, and delete; the editors that
  //     have the files open are shown again at the new place or closed, and a file with unsaved changes is never touched.
  const organiser = test.client().organiser;
  const org = 'api-client/collections/org';
  const onDisk = relative => path.join(workspace, ...relative.split('/'));
  const uriOf = relative => vscode.Uri.file(onDisk(relative));
  const readFile = relative => fs.readFileSync(onDisk(relative), 'utf8');
  put(org + '/collection.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B01\nname: Org\n');
  put(org + '/a/folder.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B02\nname: A\n');
  put(org + '/one.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B03\nname: One\nurl: http://x.test/1\n');
  put(org + '/a/two.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B04\nname: Two\nurl: http://x.test/2\n');
  const orgNode = () => test.client().collections.find(node => node.label === 'Org');
  await until(() => orgNode()?.children.length === 2, 'the new collection is loaded');
  const openEditor = async relative => {
    await vscode.commands.executeCommand('vscode.openWith', uriOf(relative), 'apiClient.request');
    await until(() => test.requestEditor(uriOf(relative).toString())?.isReady === true, relative + ' is open');
  };

  // 11a. Renaming a request renames its file, keeps its identifier, and shows the editor again at the new place.
  await openEditor(org + '/one.req.yml');
  assert.equal(await organiser.rename(org + '/one.req.yml', 'Uno'), org + '/uno.req.yml');
  assert.ok(!fs.existsSync(onDisk(org + '/one.req.yml')), 'the old file is gone');
  assert.match(readFile(org + '/uno.req.yml'), /^schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B03\nname: Uno\n/);
  await until(() => test.requestEditor(uriOf(org + '/uno.req.yml').toString())?.isReady === true, 'the editor is shown again at the new place');
  assert.equal(test.requestEditor(uriOf(org + '/one.req.yml').toString()), undefined, 'and not at the old one');
  await until(() => orgNode().children.some(child => child.label === 'Uno'), 'the tree shows the new name');

  // 11b. A file with unsaved changes is not touched, and nothing is done.
  await openEditor(org + '/a/two.req.yml');
  const twoDocument = await vscode.workspace.openTextDocument(uriOf(org + '/a/two.req.yml'));
  const comment = new vscode.WorkspaceEdit();
  comment.insert(twoDocument.uri, new vscode.Position(0, 0), '# unsaved\n');
  await vscode.workspace.applyEdit(comment);
  assert.equal(twoDocument.isDirty, true);
  await assert.rejects(organiser.rename(org + '/a/two.req.yml', 'Zwei'), /two\.req\.yml has changes that are not saved/);
  await assert.rejects(organiser.remove([org + '/a']), /not saved/, 'neither is a folder with a file like that deleted');
  assert.ok(fs.existsSync(onDisk(org + '/a/two.req.yml')) && !readFile(org + '/a/two.req.yml').includes('Zwei'), 'nothing was changed');
  await twoDocument.save();

  // 11c. A copy is next to the original, with another identifier.
  const copied = await organiser.duplicate(org + '/uno.req.yml');
  assert.equal(copied, org + '/uno-copy.req.yml');
  assert.match(readFile(copied), /\nname: Uno copy\n/);
  assert.ok(!readFile(copied).includes('01J9Z4V0N2XK7Q3M8T5R6Y1B03'), 'with a new identifier');

  // 11d. Moving a request next to another one puts it there, writes the order, and the open editor follows.
  assert.equal(await organiser.drop([org + '/uno.req.yml'], org + '/a/two.req.yml'), undefined);
  assert.ok(fs.existsSync(onDisk(org + '/a/uno.req.yml')) && !fs.existsSync(onDisk(org + '/uno.req.yml')));
  assert.match(readFile(org + '/a/folder.yml'), /\norder:\n {2}- uno\n {2}- two\n/);
  await until(() => test.requestEditor(uriOf(org + '/a/uno.req.yml').toString())?.isReady === true, 'the editor follows the file into the folder');
  await until(() => orgNode().children.find(child => child.label === 'A')?.children.map(child => child.label).join() === 'Uno,Two', 'the tree shows the order');

  // 11e. What makes no sense is refused with a sentence; a drop on itself does nothing.
  assert.match(await organiser.drop([org + '/a'], org + '/a/two.req.yml'), /into itself/);
  assert.match(await organiser.drop([org], org + '/a'), /collection cannot be moved/);
  assert.equal(await organiser.drop([org + '/a/uno.req.yml'], org + '/a/uno.req.yml'), undefined);
  assert.ok(fs.existsSync(onDisk(org + '/a/uno.req.yml')));

  // 11f. Deleting a folder deletes what is inside it and closes its editors.
  await organiser.remove([org + '/a', org + '/a/two.req.yml']);
  assert.ok(!fs.existsSync(onDisk(org + '/a')), 'the folder is gone');
  await until(() => test.requestEditor(uriOf(org + '/a/uno.req.yml').toString()) === undefined, 'its editors are closed');
  await until(() => orgNode().children.map(child => child.label).join() === 'Uno copy', 'the tree shows what is left');

  // 11g. Environments: rename moves the file (and the one of its secrets), copy, and deleting the active one leaves none active.
  put('api-client/environments/org.env.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B05\nname: Org env\nvars:\n  - name: token\n    value: ""\n    secret: true\n');
  put('api-client/environments/org.env.local.yml', 'schema: 1\nvalues:\n  token: keep-this-secret\n');
  await until(() => test.client().environments.some(node => node.label === 'Org env'), 'the environment is loaded');
  const renamedEnvironment = await organiser.rename('api-client/environments/org.env.yml', 'Staging');
  assert.equal(renamedEnvironment, 'api-client/environments/staging.env.yml');
  assert.ok(!fs.existsSync(onDisk('api-client/environments/org.env.yml')) && !fs.existsSync(onDisk('api-client/environments/org.env.local.yml')), 'both old files are gone');
  assert.match(readFile('api-client/environments/staging.env.local.yml'), /token: keep-this-secret/, 'the secret came along');
  const environmentCopy = await organiser.duplicate(renamedEnvironment);
  assert.equal(environmentCopy, 'api-client/environments/staging-copy.env.yml');
  assert.match(readFile('api-client/environments/staging-copy.env.local.yml'), /token: keep-this-secret/);
  await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1B05');
  await organiser.remove([renamedEnvironment]);
  assert.ok(!fs.existsSync(onDisk(renamedEnvironment)) && !fs.existsSync(onDisk('api-client/environments/staging.env.local.yml')), 'the secrets go with it');
  assert.equal(test.client().workspace.activeEnvironmentId, undefined, 'and it is no longer the active one');

  // 12. The editors of an environment and of a collection or folder: the page is given the file with the secret values put back; an edit
  //     of the page becomes a small change of the document, except the value of a secret, which goes to the file that Git ignores.
  const environmentPath = 'api-client/environments/dev.env.yml';
  const environmentUri = uriOf(environmentPath);
  await vscode.commands.executeCommand('vscode.openWith', environmentUri, 'apiClient.environment');
  const environmentView = () => test.environmentEditor(environmentUri.toString());
  await until(() => environmentView()?.isReady === true && environmentView().lastMessage()?.type === 'document', 'the environment is open and the page is told what it holds');
  assert.deepEqual(environmentView().violations, [], 'under the policy of the page');
  const initial = environmentView().messages().find(message => message.type === 'document' && message.cause === 'init');
  assert.deepEqual([initial.cause, initial.screen, initial.environment.name, initial.active, initial.readOnly], ['init', 'environment', 'Dev', false, undefined]);
  assert.deepEqual(initial.environment.vars.map(item => [item.name, item.secret, item.value]), [['base', false, base], ['token', true, 'super-secret-value-9']], 'the secret value is put back from the private file');

  // 12a. The environment is made the active one from the page.
  await environmentView().receive({ type: 'activate' });
  assert.equal(test.client().workspace.activeEnvironmentId, '01J9Z4V0N2XK7Q3M8T5R6Y1AAC');
  await until(() => environmentView().lastMessage()?.cause === 'meta' && environmentView().lastMessage().active === true, 'and the page is told');

  // 12b. An edit of a variable changes the document by a line; the value of a secret changes the private file and not the document.
  const environmentDocument = await vscode.workspace.openTextDocument(environmentUri);
  const envRev = () => environmentView().lastMessage().rev;
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'set', path: ['vars', 0, 'value'], value: 'http://changed.test' }] });
  assert.match(environmentDocument.getText(), /\n {4}value: http:\/\/changed\.test\n/);
  assert.equal(environmentView().lastMessage().cause, 'self');
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'set', path: ['vars', 1, 'value'], value: 'a-new-secret-value' }] });
  assert.ok(!environmentDocument.getText().includes('a-new-secret-value'), 'a secret is never written into the document');
  assert.match(readFile('api-client/environments/dev.env.local.yml'), /token: a-new-secret-value/);
  assert.equal(environmentView().lastMessage().environment.vars[1].value, 'a-new-secret-value', 'but the page has it');
  assert.ok(readFile('api-client/.gitignore').includes('*.local.yml'), 'and Git is told to ignore the file');

  // 12c. A new variable that is secret from the start, and one that is taken away.
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'insert', path: ['vars'], index: 2, value: { name: 'apiKey', value: 'key-value-123', secret: true, enabled: true } }] });
  assert.match(environmentDocument.getText(), /- name: apiKey\n {4}value: ''\n {4}secret: true/);
  assert.match(readFile('api-client/environments/dev.env.local.yml'), /apiKey: key-value-123/);
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'remove', path: ['vars'], index: 2 }] });
  assert.ok(!readFile('api-client/environments/dev.env.local.yml').includes('apiKey'), 'a variable that is gone leaves no secret behind');
  // A variable that stops being secret keeps its value in the document, and the private file loses it.
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'set', path: ['vars', 1, 'secret'], value: false }] });
  assert.match(environmentDocument.getText(), /- name: token\n {4}value: a-new-secret-value\n/);
  assert.ok(!fs.existsSync(onDisk('api-client/environments/dev.env.local.yml')), 'with no secret left the file is removed');

  // 12d. What is refused changes nothing.
  const environmentText = environmentDocument.getText();
  await environmentView().receive({ type: 'edit', rev: envRev() - 1, ops: [{ op: 'set', path: ['name'], value: 'Stale' }] });
  assert.equal(environmentDocument.getText(), environmentText, 'an edit of an old version');
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'set', path: ['name'], value: '' }] });
  assert.equal(environmentView().lastMessage().type, 'rejected');
  await environmentView().receive({ type: 'edit', rev: envRev(), ops: [{ op: 'set', path: ['id'], value: 'x' }] });
  assert.equal(environmentView().lastMessage().type, 'rejected');
  assert.equal(environmentDocument.getText(), environmentText);
  // A change made in the text editor reaches the page.
  const typedInEnvironment = new vscode.WorkspaceEdit();
  typedInEnvironment.replace(environmentUri, new vscode.Range(environmentDocument.positionAt(environmentDocument.getText().indexOf('name: Dev')), environmentDocument.positionAt(environmentDocument.getText().indexOf('name: Dev') + 'name: Dev'.length)), 'name: Typed');
  await vscode.workspace.applyEdit(typedInEnvironment);
  await until(() => environmentView().messages().some(message => message.type === 'document' && message.cause === 'disk' && message.environment.name === 'Typed'), 'a change in the text editor reaches the page');
  await environmentDocument.save();

  // 12e. A file that cannot be read opens read-only.
  put('api-client/environments/bad.env.yml', 'schema: 1\nname: [oops\n');
  const badUri = uriOf('api-client/environments/bad.env.yml');
  await vscode.commands.executeCommand('vscode.openWith', badUri, 'apiClient.environment');
  await until(() => test.environmentEditor(badUri.toString())?.lastMessage()?.type === 'document', 'a file that cannot be read still opens');
  const bad = test.environmentEditor(badUri.toString());
  assert.match(bad.lastMessage().readOnly, /cannot be read as an environment: line 2, column 7/);
  await bad.receive({ type: 'edit', rev: bad.lastMessage().rev, ops: [{ op: 'set', path: ['name'], value: 'x' }] });
  assert.equal(bad.lastMessage().type, 'rejected');

  // 12f. A collection: its settings are edited, its secret variables go to the file next to it.
  const collectionUri = uriOf('api-client/collections/shop/collection.yml');
  await vscode.commands.executeCommand('vscode.openWith', collectionUri, 'apiClient.container');
  const collectionView = () => test.containerEditor(collectionUri.toString());
  await until(() => collectionView()?.isReady === true && collectionView().lastMessage()?.type === 'document', 'the collection is open');
  const collectionState = collectionView().lastMessage();
  assert.deepEqual([collectionState.screen, collectionState.kind, collectionState.container.name, collectionState.container.auth.kind, collectionState.container.headers.map(row => row.name)], ['container', 'collection', 'Shop', 'bearer', ['X-Shop']]);
  const collectionDocument = await vscode.workspace.openTextDocument(collectionUri);
  const collectionRev = () => collectionView().lastMessage().rev;
  await collectionView().receive({ type: 'edit', rev: collectionRev(), ops: [{ op: 'set', path: ['baseUrl'], value: 'https://{{host}}' }, { op: 'set', path: ['settings', 'timeoutMs'], value: 5000 }, { op: 'insert', path: ['vars'], index: 0, value: { name: 'key', value: 'collection-secret-1', secret: true, enabled: true } }] });
  assert.match(collectionDocument.getText(), /\nbaseUrl: ['"]?https:\/\/\{\{host\}\}['"]?\n/);
  assert.match(collectionDocument.getText(), /\nsettings:\n {2}timeoutMs: 5000\n/);
  assert.ok(!collectionDocument.getText().includes('collection-secret-1'));
  assert.match(readFile('api-client/collections/shop/collection.local.yml'), /key: collection-secret-1/);
  await collectionView().receive({ type: 'edit', rev: collectionRev(), ops: [{ op: 'unset', path: ['settings', 'timeoutMs'] }] });
  assert.ok(!collectionDocument.getText().includes('timeoutMs'), 'a setting goes back to what it inherits');
  await collectionView().receive({ type: 'edit', rev: collectionRev(), ops: [{ op: 'set', path: ['order'], value: [] }] });
  assert.equal(collectionView().lastMessage().type, 'rejected', 'the order of a collection is not for the page to change');
  await collectionDocument.save();

  // 12g. A folder that has no file of its own gets one when its settings are opened, and nothing else is changed.
  put('api-client/collections/shop/implicit/inside.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B09\nname: Inside\nurl: http://x.test/\n');
  await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'implicit'), 'the folder is listed');
  const implicit = test.client().collections.find(node => node.label === 'Shop').children.find(child => child.label === 'implicit');
  assert.ok(!fs.existsSync(onDisk('api-client/collections/shop/implicit/folder.yml')));
  await vscode.commands.executeCommand('apiClient.openSettings', implicit);
  const folderFile = readFile('api-client/collections/shop/implicit/folder.yml');
  assert.ok(/^schema: 1\nid: [0-9A-Z]{26}\nname: implicit\n/.test(folderFile), 'the file is written with the name the folder had: ' + JSON.stringify(folderFile));
  assert.ok(fs.existsSync(onDisk('api-client/collections/shop/implicit/inside.req.yml')) && !fs.existsSync(onDisk('api-client/collections/shop/implicit-2')), 'nothing was renamed');
  const folderUri = uriOf('api-client/collections/shop/implicit/folder.yml');
  await until(() => test.containerEditor(folderUri.toString())?.lastMessage()?.screen === 'container', 'and its settings open');
  assert.equal(test.containerEditor(folderUri.toString()).lastMessage().kind, 'folder');

  // 12h. Clicking an environment in the side bar opens it in its editor.
  await vscode.commands.executeCommand('apiClient.openEnvironment', environmentPath);
  await until(() => environmentView()?.isReady === true, 'the command opens the environment');

  // 13. Making something new from scratch, editing it in its page, saving, and finding it again after the editor is closed and opened.
  await vscode.commands.executeCommand('apiClient.newCollection', undefined, 'Created');
  await until(() => test.client().collections.some(node => node.label === 'Created'), 'the new collection is listed');
  const createdNode = () => test.client().collections.find(node => node.label === 'Created');
  assert.match(readFile('api-client/collections/created/collection.yml'), /^schema: 1\nid: [0-9A-Z]{26}\nname: Created\n/);
  await vscode.commands.executeCommand('apiClient.newFolder', createdNode(), 'Sub folder');
  await until(() => createdNode().children.some(child => child.label === 'Sub folder'), 'and the new folder');
  await vscode.commands.executeCommand('apiClient.newRequest', createdNode().children.find(child => child.label === 'Sub folder'), 'First call');
  const firstPath = 'api-client/collections/created/sub-folder/first-call.req.yml';
  assert.ok(fs.existsSync(onDisk(firstPath)), 'the request file is there');
  const firstUri = uriOf(firstPath);
  await until(() => test.requestEditor(firstUri.toString())?.isReady === true, 'and it is open in its editor');
  const firstView = () => test.requestEditor(firstUri.toString());
  await until(() => firstView().lastMessage()?.type === 'init', 'with what it holds');
  assert.deepEqual([firstView().lastMessage().request.name, firstView().lastMessage().request.method, firstView().lastMessage().request.url], ['First call', 'GET', '']);
  await firstView().receive({ type: 'edit', rev: firstView().lastMessage().rev, ops: [{ op: 'set', path: ['method'], value: 'POST' }, { op: 'set', path: ['url'], value: '{{base}}/created' }, { op: 'set', path: ['body'], value: { kind: 'json', text: '{"made":true}' } }] });
  const firstDocument = await vscode.workspace.openTextDocument(firstUri);
  assert.equal(firstDocument.isDirty, true);
  await firstDocument.save();
  assert.match(readFile(firstPath), /\nmethod: POST\nurl: '\{\{base\}\}\/created'\nbody:\n {2}kind: json\n {2}text: '\{"made":true\}'\n/);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await until(() => test.requestEditor(firstUri.toString()) === undefined, 'the editor is closed');
  await vscode.commands.executeCommand('apiClient.openRequest', firstPath);
  await until(() => firstView()?.lastMessage()?.type === 'init', 'and opened again');
  assert.deepEqual([firstView().lastMessage().request.method, firstView().lastMessage().request.url, firstView().lastMessage().request.body], ['POST', '{{base}}/created', { kind: 'json', text: '{"made":true}' }], 'what was saved is what is there');
  await vscode.commands.executeCommand('apiClient.newEnvironment', undefined, 'Fresh');
  await until(() => test.client().environments.some(node => node.label === 'Fresh'), 'a new environment is listed');
  assert.equal(test.client().workspace.activeEnvironmentId, test.client().workspace.loaded.environments.find(item => item.environment.name === 'Fresh').environment.id, 'and it is the active one');
  await vscode.commands.executeCommand('apiClient.rename', test.client().collections.find(node => node.label === 'Created'), 'Renamed by command');
  await until(() => test.client().collections.some(node => node.label === 'Renamed by command'), 'the rename command works with a name given to it');
  assert.ok(fs.existsSync(onDisk('api-client/collections/renamed-by-command/collection.yml')));

  // 14. Tests and captures: the tests of the request and of its collection are judged against the response, what the captures read is
  //     saved for the next requests (a secret name is hidden), and nothing is written into the files.
  const http2 = require('node:http');
  const seenTests = [];
  const testServer = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seenTests.push(req.url);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Rate', '7');
      res.end('{"ok":true,"token":"captured-token-1","id":42,"items":[1,2,3]}');
    });
  });
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const testBase = 'http://127.0.0.1:' + testServer.address().port;
  try {
    put('api-client/environments/dev.env.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1AAC\nname: Dev\nvars:\n  - name: base\n    value: ' + testBase + '\n');
    await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC');
    await until(() => test.client().workspace.loaded?.environments.find(item => item.environment.name === 'Dev')?.environment.vars[0]?.value === testBase, 'the environment points at the server');
    await vscode.commands.executeCommand('vscode.openWith', collectionUri, 'apiClient.container');
    await until(() => collectionView()?.isReady === true && collectionView().lastMessage()?.type === 'document', 'the settings of the collection are open again');
    await collectionView().receive({ type: 'edit', rev: collectionRev(), ops: [{ op: 'insert', path: ['tests'], index: 0, value: { expr: 'duration < 60000', enabled: true } }] });
    const reopened = await vscode.workspace.openTextDocument(collectionUri);
    assert.ok(/\ntests:\n {2}- expr: duration < 60000\n/.test(reopened.getText()), 'the test is in the file of the collection');
    await reopened.save();
    put('api-client/collections/shop/tested.req.yml', [
      'schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B11', 'name: Tested', 'url: "{{base}}/json"',
      'tests:', '  - expr: status == 200', '  - expr: json $.ok == true', '  - expr: json $.items count == 3', '  - expr: header x-rate > 5', '  - expr: json $.id == 41', '  - expr: bogus line', '  - expr: status == 500', '    enabled: false',
      'captures:', '  - expr: page = json $.id', '  - expr: access_token = json $.token', '  - expr: missing = json $.nothing', '  - expr: "global: rate = header x-rate"', ''
    ].join('\n'));
    put('api-client/collections/shop/uses-saved.req.yml', 'schema: 1\nid: 01J9Z4V0N2XK7Q3M8T5R6Y1B12\nname: Uses saved\nurl: "{{base}}/json?page={{page}}&token={{access_token}}&rate={{rate}}"\n');
    await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Uses saved') && test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Tested'), 'the requests are loaded');
    const openAndWait = async name => {
      const uri = uriOf('api-client/collections/shop/' + name);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, name + ' is open');
      return test.requestEditor(uri.toString());
    };
    const lastResponse = view => view.messages().filter(message => message.type === 'response').at(-1);

    // 14a. The tests are judged, the invalid one fails with a reason, the switched-off one is not run, and the collection's test is there.
    const tested = await openAndWait('tested.req.yml');
    await tested.receive({ type: 'send' });
    await until(() => lastResponse(tested) !== undefined, 'the answer to the tested request');
    const judged = lastResponse(tested).response;
    assert.deepEqual(judged.tests.map(item => [item.expr, item.from, item.ok]), [
      ['duration < 60000', 'Shop', true], ['status == 200', 'request', true], ['json $.ok == true', 'request', true], ['json $.items count == 3', 'request', true], ['header x-rate > 5', 'request', true], ['json $.id == 41', 'request', false], ['bogus line', 'request', false]
    ]);
    assert.equal(judged.tests[5].message, 'got 42');
    assert.match(judged.tests[6].message, /not something to test/);

    // 14b. What the captures read is saved; a secret name is hidden in the view, and a failed capture changes nothing.
    assert.deepEqual(judged.saved.map(item => [item.variable, item.ok, item.scope, item.secret, item.value]), [['page', true, 'active', false, '42'], ['access_token', true, 'active', true, ''], ['missing', false, 'active', false, ''], ['rate', true, 'global', false, '7']]);
    assert.equal(judged.saved[2].message, 'nothing at $.nothing');
    assert.ok(!JSON.stringify([judged.saved, judged.tests, judged.sent, judged.headers]).includes('captured-token-1'), 'the value of the secret is not in what is said about the captures (the body of the response is the response itself)');
    for (const name of fs.readdirSync(path.join(workspace, 'api-client', 'collections', 'shop'))) {
      const full = path.join(workspace, 'api-client', 'collections', 'shop', name);
      if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'utf8').includes('captured-token-1'), name + ' holds no saved value');
    }

    // 14c. The next request uses them; the secret is hidden in what is shown of the request; the page is told the variables exist.
    const usesSaved = await openAndWait('uses-saved.req.yml');
    await usesSaved.receive({ type: 'send' });
    await until(() => lastResponse(usesSaved) !== undefined, 'the answer to the second request');
    assert.equal(seenTests.at(-1), '/json?page=42&token=captured-token-1&rate=7', 'the saved values went out');
    const second = lastResponse(usesSaved).response;
    assert.equal(second.sent.url, testBase + '/json?page=42&token=[redacted]&rate=7', 'the secret value is hidden in what was sent');
    assert.ok(!second.warnings.some(warning => /page|access_token|rate/.test(warning)), 'none of the saved variables is missing (the one the collection asks for in its authentication is)');
    const knownVariables = usesSaved.messages().filter(message => message.type === 'vars').at(-1).vars;
    assert.deepEqual(knownVariables.filter(item => ['page', 'access_token', 'rate'].includes(item.name)).map(item => [item.name, item.source, item.secret, item.value === '' ? 'empty' : 'value']), [['access_token', 'this run', true, 'empty'], ['page', 'this run', false, 'value'], ['rate', 'this run', false, 'value']]);

    // 14d. Another environment does not see an environment value, and clearing forgets them.
    await test.client().workspace.setActiveEnvironment(undefined);
    await usesSaved.receive({ type: 'send' });
    await until(() => usesSaved.messages().filter(message => message.type === 'failed' || message.type === 'response').length >= 2, 'the answer without an environment');
    await test.client().workspace.setActiveEnvironment('01J9Z4V0N2XK7Q3M8T5R6Y1AAC');
    await vscode.commands.executeCommand('apiClient.clearVariables');
    await until(() => usesSaved.messages().filter(message => message.type === 'vars').at(-1).vars.every(item => item.source !== 'this run'), 'after clearing nothing is from a run');
    const countBefore = usesSaved.messages().filter(message => message.type === 'response').length;
    await usesSaved.receive({ type: 'send' });
    await until(() => usesSaved.messages().filter(message => message.type === 'response').length > countBefore, 'the answer after clearing');
    assert.equal(seenTests.at(-1), '/json?page={{page}}&token={{access_token}}&rate={{rate}}', 'sent as written once the values are gone');
    assert.ok(lastResponse(usesSaved).response.warnings.some(warning => /page.*access_token.*rate|These variables have no value.*page/.test(warning)), 'and said so');
  } finally {
    testServer.closeAllConnections();
    testServer.close();
  }

  // 15. Scripts: nothing runs until the person has allowed the very text that will run; then a script before the request sets a variable and a header,
  //     a script after the answer tests and saves, a changed script is asked about again, and what was set is never written into the files.
  const seenScripts = [];
  const scriptServer = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seenScripts.push({ url: req.url, stamp: req.headers['x-stamp'] });
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true,"token":"script-token-1"}');
    });
  });
  await new Promise(resolve => scriptServer.listen(0, '127.0.0.1', resolve));
  const scriptBase = 'http://127.0.0.1:' + scriptServer.address().port;
  const questions = [];
  let nextAnswer = 'allow';
  test.scripts.answer = async pending => { questions.push(pending.map(item => item.status + ':' + item.phase)); return nextAnswer; };
  const scriptedFile = version => [
    'schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B21', 'name: Scripted', 'url: "' + scriptBase + '/scripted"',
    'scripts:',
    '  pre: |',
    "    pm.environment.set('stamp', 'from-script-" + version + "');",
    "    pm.request.headers.add({ key: 'X-Stamp', value: pm.environment.get('stamp') });",
    "    console.log('before', pm.info.requestName);",
    '  post: |',
    "    pm.test('status is 200', () => pm.expect(pm.response.code).to.equal(200));",
    "    pm.environment.set('access_token', pm.response.json().token);",
    "    console.log('after', pm.response.code);",
    ''
  ].join('\n');
  const scriptedPath = path.join(workspace, 'api-client', 'collections', 'shop', 'scripted.req.yml');
  try {
    put('api-client/collections/shop/scripted.req.yml', scriptedFile('one'));
    await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Scripted'), 'the scripted request is in the tree');
    await vscode.commands.executeCommand('apiClient.clearVariables');
    const scripted = await (async () => {
      const uri = uriOf('api-client/collections/shop/scripted.req.yml');
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, 'the scripted request is open');
      return test.requestEditor(uri.toString());
    })();
    const answers = () => scripted.messages().filter(message => message.type === 'response' || message.type === 'failed' || message.type === 'cancelled');
    const sendAndWait = async () => {
      const before = answers().length;
      await scripted.receive({ type: 'send' });
      await until(() => answers().length > before, 'the answer to the scripted request');
      return answers().at(-1);
    };

    // 15a. Not allowed yet: the question names both scripts, and a "send without scripts" sends the request as it is written.
    nextAnswer = 'skip';
    const skipped = await sendAndWait();
    assert.equal(skipped.type, 'response');
    assert.deepEqual(questions, [['new:pre', 'new:post']], 'both scripts were asked about, as new');
    assert.equal(seenScripts.at(-1).stamp, undefined, 'the script before the request did not run');
    assert.ok(skipped.response.scripts.notes.some(note => /did not run.*not been allowed/.test(note)), 'and the pane says so');
    assert.deepEqual(skipped.response.scripts.logs, []);

    // 15b. Allowed: the script before the request set a header and a variable, the script after the answer tested and saved, and the console has both.
    nextAnswer = 'allow';
    const ran = await sendAndWait();
    assert.equal(ran.type, 'response');
    assert.equal(questions.length, 2, 'asked once more');
    assert.equal(seenScripts.at(-1).stamp, 'from-script-one', 'the header the script added went out');
    const report = ran.response.scripts;
    assert.deepEqual(report.logs.map(item => [item.phase, item.level, item.text]), [['pre', 'log', 'before Scripted'], ['post', 'log', 'after 200']]);
    assert.deepEqual(report.tests.map(item => [item.phase, item.name, item.passed]), [['post', 'status is 200', true]]);
    assert.deepEqual(report.saved.map(item => [item.variable, item.scope, item.secret, item.value]), [['stamp', 'active', false, 'from-script-one'], ['access_token', 'active', true, '']]);
    assert.deepEqual(report.errors, []);
    assert.ok(!JSON.stringify(report).includes('script-token-1'), 'the value of the secret is not in what is said about the run');

    // 15c. The same text is not asked about again; what the scripts set is in the variables of the next request, and in no file.
    const again = await sendAndWait();
    assert.equal(again.type, 'response');
    assert.equal(questions.length, 2, 'not asked again');
    for (const name of fs.readdirSync(path.join(workspace, 'api-client', 'collections', 'shop'))) {
      const full = path.join(workspace, 'api-client', 'collections', 'shop', name);
      if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'utf8').includes('script-token-1'), name + ' holds no value that a script set');
    }
    assert.ok(scripted.messages().filter(message => message.type === 'vars').at(-1).vars.some(item => item.name === 'stamp' && item.source === 'this run'), 'the page knows the variable a script set');

    // 15d. A change of the text asks again, naming it as changed; refusing it calls the send off; allowing it runs the new text.
    put('api-client/collections/shop/scripted.req.yml', scriptedFile('two'));
    await until(() => scripted.messages().some(message => message.type === 'doc' && message.request?.scripts?.pre.includes('from-script-two')), 'the editor has the changed script');
    nextAnswer = 'cancel';
    const sentBefore = seenScripts.length;
    const refused = await sendAndWait();
    assert.equal(refused.type, 'cancelled', 'the send was called off');
    assert.equal(seenScripts.length, sentBefore, 'and nothing was sent');
    assert.deepEqual(questions.at(-1), ['changed:pre'], 'only the script that changed was asked about: the other has the text that was allowed');
    nextAnswer = 'allow';
    const second = await sendAndWait();
    assert.equal(second.type, 'response');
    assert.equal(seenScripts.at(-1).stamp, 'from-script-two');

    // 15e. A script that throws before the request stops it: nothing is sent, and the failure says which script and what it said.
    put('api-client/collections/shop/scripted.req.yml', scriptedFile('three').replace("pm.environment.set('stamp'", "null.nothing; pm.environment.set('stamp'"));
    await until(() => scripted.messages().some(message => message.type === 'doc' && message.request?.scripts?.pre.includes('null.nothing')), 'the editor has the script that throws');
    const sentThen = seenScripts.length;
    const failed = await sendAndWait();
    assert.equal(failed.type, 'failed');
    assert.equal(failed.code, 'script-error');
    assert.equal(failed.message, 'A script failed before the request was sent.');
    assert.match(failed.scripts.errors[0].message, /null|nothing/, 'what the script said is in the report');
    assert.equal(seenScripts.length, sentThen, 'the request was not sent');
    assert.ok(failed.scripts.errors.length === 1 && failed.scripts.errors[0].phase === 'pre');

    // 15f. Forgetting what was allowed asks again for the same text; turning scripts off in the settings sends without asking.
    put('api-client/collections/shop/scripted.req.yml', scriptedFile('one'));
    await until(() => scripted.messages().some(message => message.type === 'doc' && message.request?.scripts?.pre.includes('from-script-one') && !message.request.scripts.pre.includes('null.nothing')), 'the editor has the first script again');
    await vscode.commands.executeCommand('apiClient.forgetScripts');
    const asked = questions.length;
    await sendAndWait();
    assert.equal(questions.length, asked + 1, 'asked again after forgetting');
    const settings = vscode.workspace.getConfiguration('apiClient');
    await settings.update('scripts.enabled', false, vscode.ConfigurationTarget.Global);
    try {
      const off = await sendAndWait();
      assert.equal(off.type, 'response');
      assert.equal(questions.length, asked + 1, 'not asked when scripts are off');
      assert.ok(off.response.scripts.notes.some(note => /turned off/.test(note)));
      assert.equal(seenScripts.at(-1).stamp, undefined);
    } finally {
      await settings.update('scripts.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(fs.readFileSync(scriptedPath, 'utf8'), scriptedFile('one'), 'the file of the request is as it was written');
  } finally {
    test.scripts.answer = undefined;
    scriptServer.closeAllConnections();
    scriptServer.close();
  }

  // 16. The .http file next to a request: written after the files are loaded, followed when the request changes, never written over when somebody
  //     edited it by hand; the lines above its first line offer to take the edits into the request, to show the difference, to discard them, or to
  //     keep the file; a file with no header is left alone; the mode off writes nothing.
  const mirrorDir = path.join(workspace, 'api-client', 'collections', 'shop');
  const mirrorFile = name => path.join(mirrorDir, name);
  const mirrorText = name => fs.readFileSync(mirrorFile(name), 'utf8');
  const mirrorUri = name => vscode.Uri.file(mirrorFile(name));
  // The command fails with "Illegal argument" for a file that no document has been opened on.
  const mirrorTitles = async name => {
    await vscode.workspace.openTextDocument(mirrorUri(name));
    return (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', mirrorUri(name), 10)).map(lens => lens.command?.title ?? '');
  };
  put('api-client/collections/shop/mirrored.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B31', 'name: Mirrored', 'method: GET', 'url: https://example.test/m', 'headers:', '  - name: X-One', '    value: "1"', ''].join('\n'));
  await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Mirrored'), 'the mirrored request is in the tree');

  // 16a. It is written, with the first line that says where it comes from, and what a .http tool reads is the request.
  await until(() => fs.existsSync(mirrorFile('mirrored.http')), 'the .http file is written');
  const written = mirrorText('mirrored.http');
  assert.match(written.split('\n')[0], /^# api-client generated v1 src=mirrored\.req\.yml h=[0-9a-f]{14} -- edit the \.req\.yml, not this file$/);
  assert.match(written, /\n### Mirrored\n# @name mirrored\n/);
  assert.match(written, /\nGET https:\/\/example\.test\/m\n/);
  assert.match(written, /\nX-One: 1\n/);
  assert.match(written, /\nX-Shop: s\n/, 'with what the collection gives every request');
  assert.match(written, /\n# @assert duration < 60000\n/, 'and its tests');
  assert.ok(!written.includes('\r'), 'written with line feeds');
  assert.match((await mirrorTitles('mirrored.http')).join(' | '), /Generated from mirrored\.req\.yml: edit the request, not this file/);

  // 16b. A change of the request is followed by the file.
  put('api-client/collections/shop/mirrored.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B31', 'name: Mirrored', 'method: GET', 'url: https://example.test/m2', 'headers:', '  - name: X-One', '    value: "1"', ''].join('\n'));
  await until(() => mirrorText('mirrored.http').includes('https://example.test/m2'), 'the .http file follows the request');

  // 16c. A file that somebody edited is never written over, not even when the request changes; the lines offer what to do.
  const edited = mirrorText('mirrored.http').replace('GET https://example.test/m2', 'POST https://example.test/m2?by=hand\nX-Hand: yes').replace('X-One: 1\n', '');
  fs.writeFileSync(mirrorFile('mirrored.http'), edited);
  await until(() => test.mirror.drifted.some(entry => entry.path.endsWith('mirrored.http') && entry.drift === 'edited'), 'the edit is noticed');
  assert.match((await mirrorTitles('mirrored.http')).join(' | '), /Edited by hand: this file is not written over \| Take the edits \| Show the difference \| Discard the edits \| Keep as my own file/);
  put('api-client/collections/shop/mirrored.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B31', 'name: Mirrored', 'method: GET', 'url: https://example.test/m3', 'headers:', '  - name: X-One', '    value: "1"', ''].join('\n'));
  await until(() => test.mirror.drifted.some(entry => entry.drift === 'both'), 'both changed is noticed');
  assert.equal(mirrorText('mirrored.http'), edited, 'the edited file was not written over');
  assert.match((await mirrorTitles('mirrored.http')).join(' | '), /The request and this file both changed/);
  // Go back to the request the edit was made from, so that the edits can be taken.
  put('api-client/collections/shop/mirrored.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B31', 'name: Mirrored', 'method: GET', 'url: https://example.test/m2', 'headers:', '  - name: X-One', '    value: "1"', ''].join('\n'));
  await until(() => test.mirror.drifted.some(entry => entry.drift === 'edited'), 'edited again once the request is as it was');

  // 16d. Taking the edits changes the request (the method, the query, the headers) and writes the file again from it.
  const answered = [];
  test.mirror.confirm = async question => { answered.push(question); return true; };
  await vscode.commands.executeCommand('apiClient.mirror.importEdits', mirrorUri('mirrored.http'));
  await until(() => /method: POST/.test(fs.readFileSync(mirrorFile('mirrored.req.yml'), 'utf8')), 'the request has the method of the edit');
  const taken = fs.readFileSync(mirrorFile('mirrored.req.yml'), 'utf8');
  assert.deepEqual(answered, ['take']);
  assert.match(taken, /X-Hand/);
  assert.match(taken, /name: by\n\s+value: hand/);
  assert.ok(!/name: X-One/.test(taken), 'the header the edit removed is gone from the request');
  await until(() => test.mirror.drifted.length === 0 && mirrorText('mirrored.http').includes('X-Hand: yes'), 'the file is written again from the request');
  assert.match(mirrorText('mirrored.http'), /\nPOST https:\/\/example\.test\/m2\?by=hand\n/);

  // 16e. Discarding the edits writes the file again from the request.
  const afterTake = mirrorText('mirrored.http');
  fs.writeFileSync(mirrorFile('mirrored.http'), afterTake.replace('POST', 'DELETE'));
  await until(() => test.mirror.drifted.length === 1, 'the second edit is noticed');
  answered.length = 0;
  await vscode.commands.executeCommand('apiClient.mirror.discardEdits', mirrorUri('mirrored.http'));
  await until(() => mirrorText('mirrored.http') === afterTake && test.mirror.drifted.length === 0, 'the file is as the request gives it');
  assert.deepEqual(answered, ['discard']);

  // 16f. Keeping the file as the person's own takes the first line out and stops the request from writing it.
  fs.writeFileSync(mirrorFile('mirrored.http'), afterTake.replace('POST', 'PATCH'));
  await until(() => test.mirror.drifted.length === 1, 'the third edit is noticed');
  answered.length = 0;
  await vscode.commands.executeCommand('apiClient.mirror.detach', mirrorUri('mirrored.http'));
  await until(() => !mirrorText('mirrored.http').startsWith('# api-client generated') && /mirror: false/.test(fs.readFileSync(mirrorFile('mirrored.req.yml'), 'utf8')), 'the file is the own file of the person and the request writes none');
  assert.deepEqual(answered, ['detach']);
  assert.match(mirrorText('mirrored.http'), /^### Mirrored\n/);
  assert.match(mirrorText('mirrored.http'), /\nPATCH https:\/\/example\.test\/m2\?by=hand\n/, 'with the edit that was made');
  const own = mirrorText('mirrored.http');
  put('api-client/collections/shop/mirrored.req.yml', fs.readFileSync(mirrorFile('mirrored.req.yml'), 'utf8').replace('/m2', '/m4'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  await test.mirror.sync();
  assert.equal(mirrorText('mirrored.http'), own, 'a file with no first line is never written');
  assert.deepEqual(await mirrorTitles('mirrored.http'), [], 'and has no lines above it');

  // 16g. A .http file that is not generated is left alone, and the mode off writes nothing at all.
  put('api-client/collections/shop/foreign.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B32', 'name: Foreign', 'url: https://example.test/f', ''].join('\n'));
  put('api-client/collections/shop/foreign.http', '### mine\nGET https://mine.test/\n');
  await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Foreign'), 'the foreign request is in the tree');
  await test.mirror.sync();
  assert.equal(mirrorText('foreign.http'), '### mine\nGET https://mine.test/\n');
  const settingsOfMirror = vscode.workspace.getConfiguration('apiClient');
  await settingsOfMirror.update('mirror.mode', 'off', vscode.ConfigurationTarget.Workspace);
  try {
    put('api-client/collections/shop/quiet.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B33', 'name: Quiet', 'url: https://example.test/q', ''].join('\n'));
    await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Quiet'), 'the quiet request is in the tree');
    await test.mirror.sync();
    assert.ok(!fs.existsSync(mirrorFile('quiet.http')), 'no file in the mode off');
  } finally {
    await settingsOfMirror.update('mirror.mode', undefined, vscode.ConfigurationTarget.Workspace);
    test.mirror.confirm = undefined;
  }
  await until(() => fs.existsSync(mirrorFile('quiet.http')), 'with the mode on again the file is written');

  // 17. OAuth 2.0: a request whose authentication is OAuth gets an access token before it is sent: client credentials, a refresh when the token runs
  //     out, a password, or the authorization code with PKCE (the browser is stood in for by the test); the server is asked about once, a refusal sends
  //     nothing, a wrong secret is explained, and no token is written into a file.
  const fetchText = url => new Promise((resolve, reject) => {
    http2.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  const grants = [];
  const apiCalls = [];
  const challenges = new Map();
  const oauthServer = http2.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const send = (status, json) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(json)); };
      if (req.url === '/api') { apiCalls.push(req.headers.authorization); send(200, { ok: true }); return; }
      if (req.url !== '/token') { send(404, {}); return; }
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const grant = form.get('grant_type');
      const basic = req.headers.authorization ?? '';
      grants.push({ grant, basic, form: Object.fromEntries(form) });
      if (grant === 'client_credentials') {
        if (basic !== 'Basic ' + Buffer.from('cid:csecret').toString('base64')) { send(401, { error: 'invalid_client', error_description: 'bad secret', access_token: 'must-not-be-shown' }); return; }
        send(200, { access_token: 'cc-token-1', token_type: 'bearer', expires_in: 20, refresh_token: 'rt-1' });
      } else if (grant === 'refresh_token') {
        send(form.get('refresh_token') === 'rt-1' ? 200 : 400, form.get('refresh_token') === 'rt-1' ? { access_token: 'cc-token-2', token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_grant' });
      } else if (grant === 'password') {
        send(200, { access_token: 'pw-token-1', token_type: 'Bearer', expires_in: 3600 });
      } else if (grant === 'authorization_code') {
        const challenge = challenges.get(form.get('code'));
        const verifier = form.get('code_verifier') ?? '';
        const expected = require('node:crypto').createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        send(form.get('code') === 'good-code' && challenge === expected && form.get('client_id') === 'public-client' ? 200 : 400, form.get('code') === 'good-code' && challenge === expected ? { access_token: 'code-token-1', token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_grant', error_description: 'verifier does not match' });
      } else send(400, { error: 'unsupported_grant_type' });
    });
  });
  await new Promise(resolve => oauthServer.listen(0, '127.0.0.1', resolve));
  const oauthBase = 'http://127.0.0.1:' + oauthServer.address().port;
  const oauthRequest = (name, id, auth) => ['schema: 1', 'id: ' + id, 'name: ' + name, 'url: ' + oauthBase + '/api', 'auth:', ...auth.map(line => '  ' + line), ''].join('\n');
  const asked = [];
  let hostAnswer = 'allow';
  test.oauth.answer = async question => { asked.push(question); return hostAnswer; };
  try {
    put('api-client/collections/shop/oauth-cc.req.yml', oauthRequest('OAuth cc', '01J9Z4V0N2XK7Q3M8T5R6Y1B41', ['kind: oauth2', 'grant: client_credentials', 'pkce: false', 'tokenUrl: ' + oauthBase + '/token', 'clientId: cid', 'clientSecret: csecret', 'scope: read']));
    put('api-client/collections/shop/oauth-bad.req.yml', oauthRequest('OAuth bad', '01J9Z4V0N2XK7Q3M8T5R6Y1B42', ['kind: oauth2', 'grant: client_credentials', 'pkce: false', 'tokenUrl: ' + oauthBase + '/token', 'clientId: cid', 'clientSecret: wrong']));
    put('api-client/collections/shop/oauth-pw.req.yml', oauthRequest('OAuth pw', '01J9Z4V0N2XK7Q3M8T5R6Y1B43', ['kind: oauth2', 'grant: password', 'pkce: false', 'tokenUrl: ' + oauthBase + '/token', 'clientId: cid', 'clientSecret: csecret', 'username: ann', 'password: pw']));
    put('api-client/collections/shop/oauth-code.req.yml', oauthRequest('OAuth code', '01J9Z4V0N2XK7Q3M8T5R6Y1B44', ['kind: oauth2', 'grant: authorization_code', 'pkce: true', 'authUrl: ' + oauthBase + '/authorize', 'tokenUrl: ' + oauthBase + '/token', 'clientId: public-client', 'scope: openid']));
    put('api-client/collections/shop/oauth-other.req.yml', oauthRequest('OAuth other', '01J9Z4V0N2XK7Q3M8T5R6Y1B45', ['kind: oauth2', 'grant: client_credentials', 'pkce: false', 'tokenUrl: ' + oauthBase.replace('127.0.0.1', 'localhost') + '/token', 'clientId: cid', 'clientSecret: csecret']));
    put('api-client/collections/shop/oauth-insecure.req.yml', oauthRequest('OAuth insecure', '01J9Z4V0N2XK7Q3M8T5R6Y1B46', ['kind: oauth2', 'grant: client_credentials', 'pkce: false', 'tokenUrl: http://auth.example.test/token', 'clientId: cid', 'clientSecret: csecret']));
    await until(() => ['OAuth cc', 'OAuth bad', 'OAuth pw', 'OAuth code', 'OAuth other', 'OAuth insecure'].every(label => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === label)), 'the OAuth requests are in the tree');
    const openFor = async name => {
      const uri = uriOf('api-client/collections/shop/' + name);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, name + ' is open');
      return test.requestEditor(uri.toString());
    };
    const answerOf = async (view, run) => {
      const count = () => view.messages().filter(message => message.type === 'response' || message.type === 'failed' || message.type === 'cancelled').length;
      const before = count();
      await run();
      await until(() => count() > before, 'an answer');
      return view.messages().filter(message => message.type === 'response' || message.type === 'failed' || message.type === 'cancelled').at(-1);
    };

    // 17a. Client credentials: the server is asked about once, the token is fetched, sent as a bearer token, and hidden in what is shown of the request.
    const cc = await openFor('oauth-cc.req.yml');
    const first = await answerOf(cc, () => cc.receive({ type: 'send' }));
    assert.equal(first.type, 'response');
    assert.deepEqual(asked.map(question => question.what), ['send its credentials to']);
    assert.deepEqual(grants.map(item => item.grant), ['client_credentials']);
    assert.equal(grants[0].form.scope, 'read');
    assert.equal(apiCalls.at(-1), 'Bearer cc-token-1');
    assert.equal(first.response.sent.headers.find(([name]) => name === 'Authorization')[1], '[redacted]');
    assert.ok(!JSON.stringify(first.response).includes('cc-token-1'));

    // 17b. The token ran out (it lasted 20 seconds, less than the 30 that are kept in hand): a refresh gives the next one; then it is kept.
    const second = await answerOf(cc, () => cc.receive({ type: 'send' }));
    assert.equal(second.type, 'response');
    assert.deepEqual(grants.map(item => item.grant), ['client_credentials', 'refresh_token']);
    assert.equal(apiCalls.at(-1), 'Bearer cc-token-2');
    await answerOf(cc, () => cc.receive({ type: 'send' }));
    assert.deepEqual(grants.map(item => item.grant), ['client_credentials', 'refresh_token'], 'a token that is good is not asked for again');
    assert.equal(apiCalls.at(-1), 'Bearer cc-token-2');
    assert.equal(asked.length, 1, 'the server was asked about once');

    // 17c. A wrong secret is explained with what the server said, and nothing is sent to the API.
    const callsBefore = apiCalls.length;
    const bad = await openFor('oauth-bad.req.yml');
    const refused = await answerOf(bad, () => bad.receive({ type: 'send' }));
    assert.equal(refused.type, 'failed');
    assert.equal(refused.code, 'oauth');
    assert.match(refused.message, /^The server refused the request: invalid_client \(bad secret\)\.$/);
    assert.ok(!JSON.stringify(refused).includes('must-not-be-shown'));
    assert.equal(apiCalls.length, callsBefore);

    // 17d. The password grant, with the username and password of the settings.
    const pw = await openFor('oauth-pw.req.yml');
    assert.equal((await answerOf(pw, () => pw.receive({ type: 'send' }))).type, 'response');
    assert.equal(grants.at(-1).form.username, 'ann');
    assert.equal(apiCalls.at(-1), 'Bearer pw-token-1');

    // 17e. The authorization code with PKCE: the browser is told where to go, the answer comes back to this computer, the code is exchanged with the verifier.
    const code = await openFor('oauth-code.req.yml');
    let browsed;
    test.oauth.openBrowser = async address => {
      browsed = new URL(address);
      assert.equal(browsed.origin + browsed.pathname, oauthBase + '/authorize');
      assert.equal(browsed.searchParams.get('response_type'), 'code');
      assert.equal(browsed.searchParams.get('client_id'), 'public-client');
      assert.equal(browsed.searchParams.get('code_challenge_method'), 'S256');
      challenges.set('good-code', browsed.searchParams.get('code_challenge'));
      const target = new URL(browsed.searchParams.get('redirect_uri'));
      assert.equal(target.hostname, '127.0.0.1');
      const wrong = await fetchText(target.origin + target.pathname + '?code=evil&state=not-the-state');
      assert.equal(wrong.status, 400, 'an answer with another state is not accepted');
      const right = await fetchText(target.origin + target.pathname + '?code=good-code&state=' + encodeURIComponent(browsed.searchParams.get('state')));
      assert.equal(right.status, 200);
    };
    const signedIn = await answerOf(code, () => code.receive({ type: 'send' }));
    assert.equal(signedIn.type, 'response', JSON.stringify(signedIn));
    assert.equal(apiCalls.at(-1), 'Bearer code-token-1');
    assert.equal(grants.at(-1).grant, 'authorization_code');
    assert.equal(grants.at(-1).basic, '', 'a public client sends no secret');
    assert.match(grants.at(-1).form.code_verifier, /^[A-Za-z0-9_-]{43}$/);
    test.oauth.openBrowser = undefined;

    // 17f. A server that was not allowed gets nothing; an address that is not https is refused before anything is sent.
    hostAnswer = 'refuse';
    const grantsBefore = grants.length;
    const other = await openFor('oauth-other.req.yml');
    const notAllowed = await answerOf(other, () => other.receive({ type: 'send' }));
    assert.equal(notAllowed.type, 'failed');
    assert.match(notAllowed.message, /was not allowed/);
    assert.equal(grants.length, grantsBefore);
    assert.deepEqual(asked.at(-1), { host: 'localhost:' + oauthServer.address().port, what: 'send its credentials to' });
    hostAnswer = 'allow';
    const insecure = await openFor('oauth-insecure.req.yml');
    const clear = await answerOf(insecure, () => insecure.receive({ type: 'send' }));
    assert.equal(clear.type, 'failed');
    assert.match(clear.message, /The token URL has to start with https/);
    assert.equal(grants.length, grantsBefore);

    // 17g. Forgetting makes the server be asked about again and a new token be fetched; no file holds a token.
    const askedBefore = asked.length;
    await vscode.commands.executeCommand('apiClient.forgetTokens');
    await answerOf(cc, () => cc.receive({ type: 'send' }));
    assert.equal(asked.length, askedBefore + 1);
    assert.equal(grants.at(-1).grant, 'client_credentials');
    for (const name of fs.readdirSync(mirrorDir)) {
      const full = path.join(mirrorDir, name);
      if (fs.statSync(full).isFile()) assert.ok(!/cc-token|pw-token|code-token|rt-1/.test(fs.readFileSync(full, 'utf8')), name + ' holds no token');
    }
    // 17h. The page is told whether the request has a token, and can get one or forget it without sending.
    const statuses = () => cc.messages().filter(message => message.type === 'oauth').map(message => message.status);
    await until(() => statuses().length > 0, 'the page was told about the token');
    assert.deepEqual(statuses().at(-1).applies, true);
    await cc.receive({ type: 'oauth', action: 'clear' });
    await until(() => statuses().at(-1).state === 'none', 'forgotten');
    const grantsBeforeGet = grants.length;
    await cc.receive({ type: 'oauth', action: 'get' });
    await until(() => statuses().at(-1).state === 'valid' || statuses().at(-1).state === 'expired', 'a token was fetched without sending the request');
    assert.equal(grants.length, grantsBeforeGet + 1);
    assert.equal(grants.at(-1).grant, 'client_credentials');
    assert.ok(!JSON.stringify(cc.messages()).includes('cc-token'), 'the token is not in anything the page was told');
    assert.equal(statuses().some(status => status.state === 'busy'), true, 'and it was told that the token was being fetched');
    const bad2 = await openFor('oauth-bad.req.yml');
    await bad2.receive({ type: 'oauth', action: 'get' });
    await until(() => bad2.messages().filter(message => message.type === 'oauth').at(-1)?.status.message !== undefined, 'the reason is told');
    assert.match(bad2.messages().filter(message => message.type === 'oauth').at(-1).status.message, /invalid_client/);
    const plainView = await (async () => {
      const uri = uriOf('api-client/collections/shop/tested.req.yml');
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, 'a request without OAuth is open');
      return test.requestEditor(uri.toString());
    })();
    await until(() => plainView.messages().some(message => message.type === 'oauth'), 'told too');
    assert.equal(plainView.messages().filter(message => message.type === 'oauth').at(-1).status.applies, false, 'a request that does not use OAuth has nothing to show');
  } finally {
    test.oauth.answer = undefined;
    test.oauth.openBrowser = undefined;
    oauthServer.closeAllConnections();
    oauthServer.close();
  }

  // 18. The collection runner: the requests of a collection run in order, the results come one by one, a failure is a failure, a data file makes a pass
  //     for each row, a script can send the run elsewhere, the run can be stopped, and the report says what ran.
  const seenRuns = [];
  let slowResolve;
  const runServer = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seenRuns.push(req.method + ' ' + decodeURI(req.url));
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/slow') { slowResolve = () => { res.end('{"slow":true}'); }; return; }
      if (req.url === '/missing') { res.statusCode = 404; res.end('{"error":"not found","secret":"body-must-not-be-in-the-report"}'); return; }
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolve => runServer.listen(0, '127.0.0.1', resolve));
  const runBase = 'http://127.0.0.1:' + runServer.address().port;
  const runDir = 'api-client/collections/runs';
  const requestFile = (id, name, url, extra = []) => ['schema: 1', 'id: ' + id, 'name: ' + name, 'url: ' + url, ...extra, ''].join('\n');
  test.scripts.answer = async () => 'allow';
  try {
    put(runDir + '/collection.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B51', 'name: Runs', 'baseUrl: ' + runBase, ''].join('\n'));
    put(runDir + '/a-ok.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B52', 'A ok', '/ok', ['tests:', '  - expr: status == 200']));
    put(runDir + '/b-echo.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B53', 'B echo', '/echo/{{id}}', ['tests:', '  - expr: status == 200']));
    put(runDir + '/c-missing.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B54', 'C missing', '/missing', ['tests:', '  - expr: status == 200', '  - expr: status == 404']));
    put(runDir + '/d-last.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B55', 'D last', '/last', ['tests:', '  - expr: status == 200']));
    await until(() => test.client().collections.some(node => node.label === 'Runs' && node.children.length === 4), 'the collection to run is in the tree');
    await vscode.commands.executeCommand('apiClient.runCollection', { kind: 'collection', path: runDir, label: 'Runs' });
    await until(() => test.runner(runDir)?.isReady === true, 'the runner is open');
    const runner = test.runner(runDir);
    const loadedRequest = name => {
      const walk = list => { for (const child of list) { if (child.kind === 'request' && child.request.name === name) return child.request; if (child.children) { const found = walk(child.children); if (found) return found; } } return undefined; };
      return walk(test.client().workspace.loaded.collections);
    };
    const messagesOf = type => runner.messages().filter(message => message.type === type);
    const finished = async run => {
      const before = messagesOf('done').length;
      await run();
      await until(() => messagesOf('done').length > before, 'the run is done');
      return messagesOf('done').at(-1).summary;
    };

    // 18a. The page is told what is to be run.
    assert.deepEqual(messagesOf('init').at(-1), { type: 'init', name: 'Runs', kind: 'collection', environment: 'Dev', requests: 4, data: undefined });

    // 18b. A run: in the order of the side bar, a failing test is a failed request, and each result comes as it happens.
    seenRuns.length = 0;
    const first = await finished(() => runner.receive({ type: 'start', config: { iterations: 1, delayMs: 0, stopOnFailure: false } }));
    assert.deepEqual(seenRuns, ['GET /ok', 'GET /echo/{{id}}', 'GET /missing', 'GET /last']);
    assert.deepEqual(messagesOf('result').map(message => [message.result.name, message.result.status, message.result.httpStatus]), [['A ok', 'passed', 200], ['B echo', 'passed', 200], ['C missing', 'failed', 404], ['D last', 'passed', 200]]);
    assert.deepEqual([first.requests, first.passed, first.failed, first.testsPassed, first.testsFailed, first.stopped], [4, 3, 1, 4, 1, 'finished']);
    assert.ok(messagesOf('started').length >= 1 && runner.isRunning === false);

    // 18c. A data file: a pass for each row, the columns are variables of the pass.
    runner.pickData = async () => ({ name: 'rows.csv', text: 'id,name\n1,Ann\n2,Bob\n' });
    await runner.receive({ type: 'chooseData' });
    await until(() => messagesOf('data').some(message => message.data?.rows === 2), 'the data file is read');
    assert.deepEqual(messagesOf('data').at(-1).data, { name: 'rows.csv', rows: 2, columns: ['id', 'name'], warnings: [] });
    seenRuns.length = 0;
    const second = await finished(() => runner.receive({ type: 'start', config: { iterations: 5, delayMs: 0, stopOnFailure: false } }));
    assert.deepEqual(seenRuns.filter(line => line.includes('echo')), ['GET /echo/1', 'GET /echo/2']);
    assert.deepEqual([second.iterations, second.requests], [2, 8], 'the rows decide the passes, whatever the number says');
    runner.pickData = async () => ({ name: 'bad.csv', text: 'a,b,a\n1,2,3\n' });
    await runner.receive({ type: 'chooseData' });
    await until(() => messagesOf('data').at(-1).error !== undefined, 'a data file that is no good is refused');
    assert.match(messagesOf('data').at(-1).error, /Two columns have the same name/);
    assert.equal(messagesOf('data').at(-1).data.rows, 2, 'and the one that was chosen before is kept');

    // 18d. Stopping at the first failure.
    seenRuns.length = 0;
    const third = await finished(() => runner.receive({ type: 'start', config: { iterations: 1, delayMs: 0, stopOnFailure: true } }));
    assert.deepEqual([third.stopped, seenRuns.some(line => line.includes('/last'))], ['failure', false]);
    await runner.receive({ type: 'clearData' });
    await until(() => messagesOf('data').at(-1).data === undefined, 'the data file is removed');

    // 18e. A script sends the run to another request by its name.
    put(runDir + '/a-ok.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B52', 'A ok', '/ok', ['scripts:', '  post: |', "    postman.setNextRequest('D last');"]));
    await until(() => loadedRequest('A ok')?.scripts.post.includes('setNextRequest'), 'the request has its script');
    seenRuns.length = 0;
    const fourth = await finished(() => runner.receive({ type: 'start', config: { iterations: 1, delayMs: 0, stopOnFailure: false } }));
    assert.deepEqual(seenRuns, ['GET /ok', 'GET /last'], 'B and C were passed over');
    assert.deepEqual([fourth.requests, fourth.failed], [2, 0]);

    // 18f. The report: the totals and every request, and nothing that a server answered.
    const reports = [];
    runner.reportTo = (format, text) => reports.push({ format, text });
    await runner.receive({ type: 'save', format: 'json' });
    await runner.receive({ type: 'save', format: 'junit' });
    assert.deepEqual(reports.map(report => report.format), ['json', 'junit']);
    const json = JSON.parse(reports[0].text);
    assert.deepEqual([json.name, json.environment, json.totals.requests, json.results.map(result => result.name)], ['Runs', 'Dev', 2, ['A ok', 'D last']]);
    assert.match(json.tool, /^api-client /);
    assert.match(reports[1].text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="Runs" /);
    assert.equal((reports[1].text.match(/<testsuite /g) ?? []).length, 2);
    for (const report of reports) assert.ok(!report.text.includes('body-must-not-be-in-the-report') && !report.text.includes(runBase), 'nothing of what was answered, and no address');

    // 18g. A run can be stopped while a request is waiting.
    put(runDir + '/a-ok.req.yml', requestFile('01J9Z4V0N2XK7Q3M8T5R6Y1B52', 'A ok', '/slow'));
    await until(() => loadedRequest('A ok')?.url === '/slow', 'the request waits');
    seenRuns.length = 0;
    const doneBefore = messagesOf('done').length;
    await runner.receive({ type: 'start', config: { iterations: 1, delayMs: 0, stopOnFailure: false } });
    await until(() => seenRuns.includes('GET /slow'), 'the slow request is waiting');
    assert.equal(runner.isRunning, true);
    await runner.receive({ type: 'stop' });
    await until(() => messagesOf('done').length > doneBefore, 'the run ended');
    assert.equal(messagesOf('done').at(-1).summary.stopped, 'cancelled');
    assert.equal(runner.isRunning, false);
    assert.ok(!seenRuns.some(line => line.includes('/last')), 'nothing after the one that was stopped');
  } finally {
    test.scripts.answer = undefined;
    if (slowResolve !== undefined) slowResolve();
    runServer.closeAllConnections();
    runServer.close();
  }

  // 19. The Code tab: the request written as code that sends it, in a language, with the variables replaced and the secrets left out; the language can be
  //     changed, the code can be copied, and nothing is sent.
  put('api-client/collections/shop/coded.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B61', 'name: Coded', 'method: POST', 'url: "{{base}}/code?id=7"', 'auth:', '  kind: bearer', '  token: bearer-literal-1', '  prefix: Bearer', 'headers:', '  - name: X-Plain', '    value: visible', 'body:', '  kind: json', '  text: \'{"a":1}\'', ''].join('\n'));
  await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Coded'), 'the coded request is in the tree');
  const codedUri = uriOf('api-client/collections/shop/coded.req.yml');
  await vscode.commands.executeCommand('vscode.openWith', codedUri, 'apiClient.request');
  await until(() => test.requestEditor(codedUri.toString())?.isReady === true, 'the coded request is open');
  const coded = test.requestEditor(codedUri.toString());
  const codes = () => coded.messages().filter(message => message.type === 'code');
  const sentBefore = seenTests.length;
  await coded.receive({ type: 'code', language: 'curl' });
  await until(() => codes().some(message => message.language === 'curl'), 'the code in cURL');
  const curl = codes().filter(message => message.language === 'curl').at(-1);
  assert.match(curl.text, /^curl -X POST 'http:\/\/127\.0\.0\.1:\d+\/code\?id=7' \\\n/);
  assert.match(curl.text, /-H 'X-Plain: visible'/);
  assert.match(curl.text, /-H 'Authorization: Bearer \[redacted\]'/);
  assert.match(curl.text, /--data-raw '\{"a":1\}'/);
  assert.ok(!JSON.stringify(curl).includes('bearer-literal-1'), 'the secret is not in the code');
  assert.ok(curl.notes.some(note => /Secret values are written as \[redacted\]/.test(note)));
  await coded.receive({ type: 'code', language: 'python' });
  await until(() => codes().some(message => message.language === 'python'), 'the code in Python');
  assert.match(codes().filter(message => message.language === 'python').at(-1).text, /^import requests\n\nresponse = requests\.request\(\n {4}"POST",/);
  const countBefore = codes().length;
  await coded.receive({ type: 'code', language: 'cobol' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(codes().length, countBefore, 'a language that is not offered is not answered');
  await coded.receive({ type: 'copyCode' });
  assert.equal(await vscode.env.clipboard.readText(), codes().filter(message => message.language === 'python').at(-1).text, 'what was written last is copied');
  assert.equal(seenTests.length, sentBefore, 'nothing was sent');
  put('api-client/collections/shop/uncoded.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B62', 'name: Uncoded', 'url: ""', ''].join('\n'));
  await until(() => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === 'Uncoded'), 'the empty request is in the tree');
  const emptyUri = uriOf('api-client/collections/shop/uncoded.req.yml');
  await vscode.commands.executeCommand('vscode.openWith', emptyUri, 'apiClient.request');
  await until(() => test.requestEditor(emptyUri.toString())?.isReady === true, 'the empty request is open');
  const empty = test.requestEditor(emptyUri.toString());
  await empty.receive({ type: 'code', language: 'curl' });
  await until(() => empty.messages().some(message => message.type === 'code'), 'told why there is no code');
  const none = empty.messages().filter(message => message.type === 'code').at(-1);
  assert.equal(none.text, '');
  assert.match(none.notes.join(' '), /The request has no address/);

  // 20. Cookies: what a server sets is kept and sent back, the list shows no value, the person can delete some or all, and only the ones that outlive the
  //     session are kept for the next one.
  const cookieSeen = [];
  const cookieServer = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      cookieSeen.push({ url: req.url, cookie: req.headers.cookie });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/set') res.setHeader('Set-Cookie', ['sid=abc123-secret; Path=/; Max-Age=3600; HttpOnly', 'theme=dark; Path=/']);
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolve => cookieServer.listen(0, '127.0.0.1', resolve));
  const cookieBase = 'http://127.0.0.1:' + cookieServer.address().port;
  try {
    test.cookies.jar.clear();
    put('api-client/collections/shop/cookie-set.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B71', 'name: Cookie set', 'url: ' + cookieBase + '/set', ''].join('\n'));
    put('api-client/collections/shop/cookie-echo.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B72', 'name: Cookie echo', 'url: ' + cookieBase + '/echo', ''].join('\n'));
    await until(() => ['Cookie set', 'Cookie echo'].every(label => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === label)), 'the cookie requests are in the tree');
    const openCookie = async name => {
      const uri = uriOf('api-client/collections/shop/' + name);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, name + ' is open');
      return test.requestEditor(uri.toString());
    };
    const sendCookie = async view => {
      const count = () => view.messages().filter(message => message.type === 'response' || message.type === 'failed').length;
      const before = count();
      await view.receive({ type: 'send' });
      await until(() => count() > before, 'an answer');
    };
    const setter = await openCookie('cookie-set.req.yml');
    const echo = await openCookie('cookie-echo.req.yml');

    // 20a. A server sets two cookies; the next request carries them.
    await sendCookie(setter);
    assert.deepEqual(test.cookies.jar.list().map(cookie => cookie.name).sort(), ['sid', 'theme']);
    await sendCookie(echo);
    assert.equal(cookieSeen.at(-1).url, '/echo');
    assert.match(cookieSeen.at(-1).cookie, /^sid=abc123-secret; theme=dark$|^theme=dark; sid=abc123-secret$/);

    // 20b. The list shows no value; deleting the picked ones leaves the others.
    let listed = [];
    test.cookies.pick = async items => { listed = items.map(item => ({ label: item.label, description: item.description, detail: item.detail })); return items.filter(item => item.label === 'theme'); };
    await vscode.commands.executeCommand('apiClient.cookies');
    assert.deepEqual(listed.map(item => item.label), ['sid', 'theme']);
    assert.ok(!JSON.stringify(listed).includes('abc123-secret'), 'the value of a cookie is not shown');
    assert.match(listed[0].detail, /^\/ - until \d{4}-\d{2}-\d{2} \d{2}:\d{2} - HttpOnly$/);
    assert.match(listed[1].detail, /^\/ - session$/);
    assert.equal(listed[0].description, '127.0.0.1');
    assert.deepEqual(test.cookies.jar.list().map(cookie => cookie.name), ['sid']);
    await sendCookie(echo);
    assert.equal(cookieSeen.at(-1).cookie, 'sid=abc123-secret');

    // 20c. Only what has an end date outlives the session.
    assert.deepEqual(test.cookies.jar.persistent().map(cookie => cookie.name), ['sid']);
    await test.cookies.save();

    // 20d. All of them can be deleted, and the list says so when there are none.
    await vscode.commands.executeCommand('apiClient.clearCookies');
    assert.equal(test.cookies.jar.list().length, 0);
    await sendCookie(echo);
    assert.equal(cookieSeen.at(-1).cookie, undefined, 'nothing is sent that was deleted');
    listed = undefined;
    await vscode.commands.executeCommand('apiClient.cookies');
    assert.equal(listed, undefined, 'there is nothing to pick from');
  } finally {
    test.cookies.pick = undefined;
    cookieServer.closeAllConnections();
    cookieServer.close();
  }

  // 21. History: what a send from an editor leaves behind. Only the line by default, nothing when it is turned off, the headers and the bodies when the
  //     person chooses so, with the secrets covered; an entry opens as a document, goes to its request, can be removed, and all of them can be deleted;
  //     what OAuth and the scripts send is not recorded, and the file on disk holds no secret.
  const historyServer = http2.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Set-Cookie', 'hist=cookie-secret-77; Path=/');
      res.setHeader('X-Request-Id', 'rid-1');
      res.end('{"ok":true,"access_token":"tok-from-server-55","name":"fine"}');
    });
  });
  await new Promise(resolve => historyServer.listen(0, '127.0.0.1', resolve));
  const historyBase = 'http://127.0.0.1:' + historyServer.address().port;
  const historySettings = vscode.workspace.getConfiguration('apiClient');
  try {
    // 21a. The sends of the sections above were recorded as lines, the token requests of OAuth were not, and nothing is deleted unless the person says yes.
    await test.history.ready();
    assert.ok(test.history.list().length > 0, 'the sends of the earlier sections are in the history');
    assert.ok(!test.history.list().some(entry => entry.url.endsWith('/token')), 'the exchange of an access token is not a send of the person');
    assert.ok(test.history.list().every(entry => entry.detail === undefined), 'the default keeps only the line');
    test.history.confirmClear = async () => false;
    await vscode.commands.executeCommand('apiClient.history.clear');
    assert.ok(test.history.list().length > 0, 'a no keeps them');
    test.history.confirmClear = async () => true;
    await vscode.commands.executeCommand('apiClient.history.clear');
    assert.equal(test.history.list().length, 0);
    assert.deepEqual(test.historyView(), [], 'the view is empty');

    put('api-client/collections/shop/hist-get.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B81', 'name: History get', 'url: ' + historyBase + '/items?api_key=key-in-url-1&page=2', ''].join('\n'));
    put('api-client/collections/shop/hist-post.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B82', 'name: History post', 'method: POST', 'url: ' + historyBase + '/login', 'headers:', '  - name: Authorization', '    value: Bearer lit-token-9', '  - name: X-Own', '    value: mine', 'body:', '  kind: json', '  text: \'{"user":"ann","password":"hunter22"}\'', ''].join('\n'));
    put('api-client/collections/shop/hist-down.req.yml', ['schema: 1', 'id: 01J9Z4V0N2XK7Q3M8T5R6Y1B83', 'name: History down', 'url: http://127.0.0.1:1/down', ''].join('\n'));
    await until(() => ['History get', 'History post', 'History down'].every(label => test.client().collections.find(node => node.label === 'Shop').children.some(child => child.label === label)), 'the history requests are in the tree');
    const openHistory = async name => {
      const uri = uriOf('api-client/collections/shop/' + name);
      await vscode.commands.executeCommand('vscode.openWith', uri, 'apiClient.request');
      await until(() => test.requestEditor(uri.toString())?.isReady === true, name + ' is open');
      return test.requestEditor(uri.toString());
    };
    const sendHistory = async view => {
      const count = () => view.messages().filter(message => message.type === 'response' || message.type === 'failed').length;
      const before = count();
      await view.receive({ type: 'send' });
      await until(() => count() > before, 'an answer');
      await sleep(150);
    };
    const getter = await openHistory('hist-get.req.yml');
    const poster = await openHistory('hist-post.req.yml');
    const downer = await openHistory('hist-down.req.yml');

    // 21b. By default a send leaves a line: the secret in the address is covered, nothing else is kept.
    assert.equal(historySettings.get('history.mode'), 'metadata');
    await sendHistory(getter);
    assert.equal(test.history.list().length, 1);
    const line = test.history.list()[0];
    assert.equal(line.url, historyBase + '/items?api_key=[redacted]&page=2');
    assert.deepEqual([line.method, line.status, line.name, line.detail], ['GET', 200, 'History get', undefined]);
    assert.ok(!JSON.stringify(test.history.list()).includes('key-in-url-1'));
    const [today] = test.historyView();
    assert.equal(today.label, 'Today');
    assert.equal(today.children.length, 1);
    assert.equal(today.children[0].label, 'GET ' + historyBase.replace('http://', '') + '/items');
    assert.match(today.children[0].description, /^200 - \d+ ms - \d\d:\d\d$/);
    assert.equal(today.children[0].icon, 'success');

    // 21c. A send that gets no answer is a line too, with the reason.
    await sendHistory(downer);
    assert.equal(test.history.list().length, 2);
    const down = test.history.list()[0];
    assert.equal(down.name, 'History down', 'the newest is first');
    assert.equal(down.status, undefined);
    assert.ok(typeof down.error === 'string' && down.error.length > 0, 'the reason is kept');
    assert.equal(test.historyView()[0].children[0].icon, 'failed');

    // 21d. An entry opens as a document that is read, not edited.
    await vscode.commands.executeCommand('apiClient.history.open', test.historyView()[0].children[0]);
    const shown = vscode.window.activeTextEditor.document;
    assert.equal(shown.uri.scheme, 'apiclient-history');
    assert.match(shown.getText(), /^GET http:\/\/127\.0\.0\.1:1\/down\nFailed: .+\nTime: .+\nRequest: History down \(api-client\/collections\/shop\/hist-down\.req\.yml\)\n/);
    assert.match(shown.getText(), /The headers and the bodies were not kept/);

    // 21e. With "full" the headers and the bodies are kept, with the secrets covered: by the name of a header, of a field, and of a parameter.
    await historySettings.update('history.mode', 'full', vscode.ConfigurationTarget.Global);
    await sendHistory(poster);
    const full = test.history.list()[0];
    assert.equal(full.name, 'History post');
    assert.ok(full.detail, 'the detail is kept');
    assert.deepEqual(full.detail.requestHeaders.find(([name]) => name === 'Authorization'), ['Authorization', '[redacted]']);
    assert.deepEqual(full.detail.requestHeaders.find(([name]) => name === 'X-Own'), ['X-Own', 'mine']);
    assert.equal(full.detail.requestBody, '{"user":"ann","password":"[redacted]"}');
    assert.equal(full.detail.responseBody, '{"ok":true,"access_token":"[redacted]","name":"fine"}');
    assert.deepEqual(full.detail.responseHeaders.find(([name]) => name.toLowerCase() === 'set-cookie')?.[1], '[redacted]');
    assert.deepEqual(full.detail.responseHeaders.find(([name]) => name.toLowerCase() === 'x-request-id')?.[1], 'rid-1');
    for (const secret of ['hunter22', 'tok-from-server-55', 'cookie-secret-77', 'lit-token-9']) assert.ok(!JSON.stringify(test.history.list()).includes(secret), 'not kept: ' + secret);
    await vscode.commands.executeCommand('apiClient.history.open', test.historyView()[0].children[0]);
    const fullText = vscode.window.activeTextEditor.document.getText();
    assert.match(fullText, /--- Request headers ---\n(.*\n)*Authorization: \[redacted\]\n/);
    assert.match(fullText, /--- Request body ---\n\{"user":"ann","password":"\[redacted\]"\}\n/);
    assert.match(fullText, /--- Response body ---\n\{"ok":true,"access_token":"\[redacted\]","name":"fine"\}\n/);
    assert.ok(!fullText.includes('hunter22') && !fullText.includes('tok-from-server-55'));

    // 21f. The file on disk is the list, and holds no secret.
    await test.history.write();
    assert.ok(test.history.file && fs.existsSync(test.history.file), 'the history is written to the storage of the workspace');
    const onDiskText = fs.readFileSync(test.history.file, 'utf8');
    assert.equal(JSON.parse(onDiskText).length, test.history.list().length);
    for (const secret of ['hunter22', 'tok-from-server-55', 'cookie-secret-77', 'lit-token-9', 'key-in-url-1']) assert.ok(!onDiskText.includes(secret), 'not on disk: ' + secret);
    if (process.platform !== 'win32') assert.equal(fs.statSync(test.history.file).mode & 0o777, 0o600, 'only the person can read it');
    assert.ok(!test.history.file.startsWith(workspace), 'it is not in the folder of the workspace, so it is not committed');

    // 21g. With "off" nothing is written down.
    await historySettings.update('history.mode', 'off', vscode.ConfigurationTarget.Global);
    const countOff = test.history.list().length;
    await sendHistory(getter);
    assert.equal(test.history.list().length, countOff, 'nothing was added');
    await historySettings.update('history.mode', undefined, vscode.ConfigurationTarget.Global);

    // 21h. An entry goes back to its request, and can be removed.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const getterUri = uriOf('api-client/collections/shop/hist-get.req.yml');
    await until(() => test.requestEditor(getterUri.toString()) === undefined, 'the editors are closed');
    const getNode = test.historyView()[0].children.find(node => node.label.endsWith('/items'));
    assert.ok(getNode, 'the entry of the first send is listed');
    await vscode.commands.executeCommand('apiClient.history.openRequest', getNode);
    await until(() => test.requestEditor(getterUri.toString())?.isReady === true, 'the request of the entry is open');
    const before = test.history.list().length;
    await vscode.commands.executeCommand('apiClient.history.remove', getNode);
    assert.equal(test.history.list().length, before - 1);
    assert.ok(!test.historyView()[0].children.some(node => node.id === getNode.id), 'the view follows');
    await vscode.commands.executeCommand('apiClient.history.remove', 'entry:no-such-entry');
    assert.equal(test.history.list().length, before - 1, 'an entry that is not there is not an error');
  } finally {
    test.history.confirmClear = undefined;
    await historySettings.update('history.mode', undefined, vscode.ConfigurationTarget.Global);
    historyServer.closeAllConnections();
    historyServer.close();
  }
};
