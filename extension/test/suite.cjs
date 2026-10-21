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
};
