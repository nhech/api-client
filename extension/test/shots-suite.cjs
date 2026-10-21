'use strict';
/*
 * Runs inside the VS Code extension host for extension/test/screenshots.cjs: moves the importer panel through its steps and asks the
 * other side for a picture at each one (a request file, answered by a done file).
 */
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exchange = process.env.SHOTS_EXCHANGE;
const theme = process.env.SHOTS_THEME;

async function shot(name, width, height, settle) {
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('notifications.hideToasts');
  fs.writeFileSync(path.join(exchange, `${name}.request`), JSON.stringify({ name, width, height, settle }));
  const done = path.join(exchange, `${name}.done`);
  for (let waited = 0; !fs.existsSync(done) && waited < 60000; waited += 100) await sleep(100);
  if (!fs.existsSync(done)) throw new Error(`The picture ${name} was not taken.`);
}

exports.run = async function run() {
  await sleep(3000);
  const extension = vscode.extensions.getExtension('longtd.api-client');
  // The Explorer view: its welcome text, with the button that opens the panel.
  if (theme === 'dark') {
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('apiClient.start.focus');
    await sleep(1500);
    await shot('explorer-view', 1280, 720);
  }
  await vscode.commands.executeCommand('workbench.action.closeSidebar');

  await vscode.commands.executeCommand('apiClient.importThunder');
  const test = await extension.activate();
  const panel = test.panel();
  for (let waited = 0; !panel.isReady && waited < 15000; waited += 100) await sleep(100);
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await sleep(800);
  if (theme === 'dark') await shot('panel-source', 1280, 760);

  await panel.receive({ type: 'useCandidate', id: 0 });
  await sleep(1200);
  await shot('panel-review', 1280, 1040);

  if (theme === 'dark') {
    await panel.receive({ type: 'setOptions', options: { targetDir: 'api' } });
    await panel.receive({ type: 'import' });
    await sleep(1500);
    await shot('panel-done', 1280, 760);
  }
};
