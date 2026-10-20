'use strict';
/*
 * Runs inside VS Code's extension host. For every request of every .http file in the workspace it puts the cursor on the
 * request line, runs httpYac's "Send", and records what arrived at the local server and what httpYac reported about the file.
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
  const port = Number(process.env.HY_PORT);
  const workspace = process.env.HY_WORKSPACE;
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
  const diagnostics = {};
  try {
    const extension = vscode.extensions.getExtension('anweber.vscode-httpyac');
    if (!extension) throw new Error('httpYac is not installed in this profile');
    await extension.activate();
    const files = walk(path.join(workspace, 'api')).filter(file => file.endsWith('.http')).sort();
    for (const file of files) {
      const document = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(document);
      await sleep(1200);
      const relative = path.relative(workspace, file).replaceAll('\\', '/');
      diagnostics[relative] = vscode.languages.getDiagnostics(document.uri).map(d => `${d.range.start.line + 1}: ${d.message}`);
      for (const request of requestLines(document.getText())) {
        const before = received.length;
        const active = await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn ?? vscode.ViewColumn.One, preview: false });
        const position = new vscode.Position(request.line, 0);
        active.selection = new vscode.Selection(position, position);
        await sleep(200);
        let error;
        try { await vscode.commands.executeCommand('httpyac.send'); } catch (e) { error = String(e); }
        const deadline = Date.now() + 8000;
        while (received.length === before && Date.now() < deadline) await sleep(100);
        await sleep(200);
        results.push({ file: relative, title: request.title, requestLine: request.text, languageId: document.languageId, error, got: received.length > before ? received[received.length - 1] : null });
      }
    }
    const markers = JSON.parse(process.env.HY_MARKERS || '[]').map(file => ({ file: path.basename(file), exists: fs.existsSync(file) }));
    fs.writeFileSync(process.env.HY_OUT, JSON.stringify({ httpyacVersion: extension.packageJSON.version, diagnostics, markers, results }, null, 2));
  } finally {
    server.close();
  }
};
