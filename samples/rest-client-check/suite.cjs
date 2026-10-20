'use strict';
/*
 * Runs inside VS Code's extension host. For every request of every .http file in the workspace it puts the cursor on the
 * request line, runs REST Client's "Send Request", and records what arrived at the local server.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requestLines(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  let title;
  let waiting = false;
  lines.forEach((line, index) => {
    if (line.startsWith('###')) { title = line.slice(3).trim(); waiting = true; return; }
    if (waiting && line.trim() !== '' && !line.startsWith('#') && !line.startsWith('//')) { found.push({ title, line: index, text: line }); waiting = false; }
  });
  return found;
}

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

exports.run = async function run() {
  const port = Number(process.env.RC_PORT);
  const workspace = process.env.RC_WORKSPACE;
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":1,"main":{"temp":20}}');
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

  const results = [];
  try {
    const extension = vscode.extensions.getExtension('humao.rest-client');
    if (!extension) throw new Error('REST Client is not installed in this profile');
    const languages = await vscode.languages.getLanguages();
    await extension.activate();
    // The generated settings define the environments dev and prod. REST Client starts with none chosen: pick "dev" with its own
    // command the way a person does (down arrows, Enter), and prove which one is active with a request that uses {{petId}}
    // (1 in dev, 42 in prod; nothing is sent while no environment is chosen).
    const probeDocument = await vscode.workspace.openTextDocument(path.join(workspace, 'api', 'envcheck.http'));
    const attempts = [];
    let selected = false;
    for (let down = 0; down <= 5 && !selected; down++) {
      await vscode.window.showTextDocument(probeDocument, { preview: false });
      const picking = vscode.commands.executeCommand('rest-client.switch-environment');
      await sleep(800);
      for (let i = 0; i < down; i++) { await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext'); await sleep(150); }
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await Promise.race([picking, sleep(2000)]);
      const before = received.length;
      const shown = await vscode.window.showTextDocument(probeDocument, { preview: false });
      shown.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
      await sleep(200);
      try { await vscode.commands.executeCommand('rest-client.request'); } catch { /* the attempt is recorded below */ }
      const until = Date.now() + 6000;
      while (received.length === before && Date.now() < until) await sleep(100);
      const url = received.length > before ? received[received.length - 1].url : null;
      attempts.push({ down, url });
      selected = url === '/envcheck/1';
    }
    if (!selected) throw new Error(`could not select the dev environment: ${JSON.stringify(attempts)}`);

    const files = walk(path.join(workspace, 'api')).filter(file => file.endsWith('.http')).sort();
    for (const file of files) {
      const document = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(document);
      await extension.activate();
      await sleep(500);
      for (const request of requestLines(document.getText())) {
        const before = received.length;
        // The first response opens a panel and takes the focus; REST Client sends the request under the cursor of the ACTIVE
        // editor, so the document is brought back to the front before each request.
        const active = await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn ?? vscode.ViewColumn.One, preview: false });
        const position = new vscode.Position(request.line, 0);
        active.selection = new vscode.Selection(position, position);
        await sleep(200);
        let error;
        try { await vscode.commands.executeCommand('rest-client.request'); } catch (e) { error = String(e); }
        const deadline = Date.now() + 8000;
        while (received.length === before && Date.now() < deadline) await sleep(100);
        await sleep(150);
        results.push({ file: path.relative(workspace, file).replaceAll('\\', '/'), title: request.title, requestLine: request.text, languageId: document.languageId, error, got: received.length > before ? received[received.length - 1] : null });
      }
    }
    fs.writeFileSync(process.env.RC_OUT, JSON.stringify({ restClientVersion: extension.packageJSON.version, languages: languages.includes('http'), environmentAttempts: attempts, results }, null, 2));
  } finally {
    server.close();
  }
};
