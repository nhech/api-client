'use strict';
/*
 * Takes pictures of the importer panel in a real VS Code, with a throw-away profile and made-up Thunder Client data
 * (samples/make-sample.cjs). The extension host side (shots-suite.cjs) moves the panel through its steps and asks for a picture at
 * each one; this side takes the picture through the browser debugging port of the editor and writes a PNG.
 *
 *   node extension/test/screenshots.cjs [out-folder]            default: docs/images
 *   SHOTS_SCENARIO=request node ...                              the request editor (four themes) instead of the importer panel
 *   API_CLIENT_TEST_EXECUTABLE=<Code.exe> node ...               uses this VS Code
 *
 * Needs `npm run ext:build` first. Nothing of the person's own VS Code is read or changed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');

const repo = path.resolve(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(repo, 'docs', 'images'));
const PORT = Number(process.env.API_CLIENT_SHOT_PORT || 9339);
const SCENARIO = process.env.SHOTS_SCENARIO === 'request' ? 'request' : 'importer';
const THEMES = SCENARIO === 'request' ? ['dark', 'light', 'hc-dark', 'hc-light'] : ['dark', 'light'];
const THEME_NAMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'hc-dark': 'Default High Contrast', 'hc-light': 'Default High Contrast Light' };

function findExecutable() {
  const given = process.env.API_CLIENT_TEST_EXECUTABLE;
  if (given) return given;
  return [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'), '/usr/share/code/code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'].find(candidate => candidate && fs.existsSync(candidate));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const getJson = url => new Promise((resolve, reject) => {
  http.get(url, response => { let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } }); }).on('error', reject);
});

/** A minimal Chrome DevTools Protocol client over the WebSocket that Node provides. */
async function connect(match = target => target.type === 'page' && /workbench/.test(target.url), attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = targets.find(match);
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let next = 0;
        const waiting = new Map();
        socket.onmessage = event => { const message = JSON.parse(event.data); const done = waiting.get(message.id); if (done) { waiting.delete(message.id); done(message); } };
        return { send: (method, params = {}) => new Promise(resolve => { const id = ++next; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); }), close: () => socket.close() };
      }
    } catch { /* the editor is not up yet */ }
    await sleep(500);
  }
  throw new Error('The editor did not open its debugging port.');
}

/**
 * Runs a function (given as text, taking the document) in every webview of the editor, so that a picture can be taken of a tab that is not the first one. The
 * script is ours, from the test suite; nothing from a page or a file is run.
 */
async function inWebviews(script) {
  const targets = (await getJson(`http://127.0.0.1:${PORT}/json`)).filter(target => /vscode-webview/.test(target.url));
  const wrapped = `(() => { const docs = [document]; const inner = document.getElementById('active-frame'); if (inner && inner.contentDocument) docs.push(inner.contentDocument); return JSON.stringify(docs.map(d => { try { return (${script})(d); } catch (e) { return String(e); } })); })()`;
  const outcomes = [];
  for (const target of targets) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    const answer = await new Promise(resolve => { socket.onmessage = event => resolve(JSON.parse(event.data)); socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: wrapped, returnByValue: true } })); });
    socket.close();
    outcomes.push(answer.result && answer.result.result ? answer.result.result.value : answer.error);
  }
  return outcomes;
}

async function takeShots(exchange, theme) {
  const cdp = await connect();
  const taken = [];
  try {
    for (;;) {
      const requests = fs.readdirSync(exchange).filter(name => name.endsWith('.request'));
      if (fs.existsSync(path.join(exchange, 'finished'))) break;
      for (const file of requests) {
        const request = JSON.parse(fs.readFileSync(path.join(exchange, file), 'utf8'));
        fs.rmSync(path.join(exchange, file));
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false });
        await sleep(request.settle || 900);
        if (request.script) { await inWebviews(request.script); await sleep(500); }
        // The top 30 pixels are the title bar of the window (the name of the window, which says it is a development host); the picture starts below it.
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 30, width: request.width, height: request.height - 30, scale: 1 } });
        const name = `${request.name}${theme === 'dark' ? '' : `-${theme}`}.png`;
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, name), Buffer.from(shot.result.data, 'base64'));
        taken.push(name);
        fs.writeFileSync(path.join(exchange, `${request.name}.done`), 'ok');
      }
      await sleep(150);
    }
  } finally { cdp.close(); }
  return taken;
}

async function session(theme, executable) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-client-shots-')));
  const workspace = path.join(root, 'storefront');
  const home = path.join(root, 'home');
  const profile = path.join(home, 'AppData', 'Roaming', 'Code');
  const exchange = path.join(root, 'exchange');
  for (const dir of [workspace, exchange, path.join(profile, 'User')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# storefront\n');
  const made = spawnSync(process.execPath, [path.join(repo, 'samples', 'make-sample.cjs'), path.join(profile, 'User', 'globalStorage', 'rangav.vscode-thunder-client')], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`make-sample failed: ${made.stderr}`);
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.colorTheme': THEME_NAMES[theme], 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'workbench.startupEditor': 'none', 'window.commandCenter': false, 'workbench.tips.enabled': false, 'chat.commandCenter.enabled': false, 'workbench.secondarySideBar.defaultVisibility': 'hidden'
  }, null, 2));
  const shots = takeShots(exchange, theme);
  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, SCENARIO === 'request' ? 'shots-request.cjs' : 'shots-suite.cjs'),
      extensionTestsEnv: { HTTP_FILES_IMPORTER_TEST: '1', SHOTS_EXCHANGE: exchange, SHOTS_THEME: theme, APPDATA: path.join(root, 'appdata'), HOME: home, USERPROFILE: home },
      launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--user-data-dir', profile, '--extensions-dir', path.join(root, 'extensions'), `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*']
    });
  } finally {
    fs.writeFileSync(path.join(exchange, 'finished'), 'ok');
  }
  const taken = await shots;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  return taken;
}

(async () => {
  const executable = findExecutable();
  if (!executable) { console.error('No VS Code found. Set API_CLIENT_TEST_EXECUTABLE.'); process.exitCode = 2; return; }
  for (const theme of THEMES) console.log(`${theme}: ${(await session(theme, executable)).join(', ')}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
