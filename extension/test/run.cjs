'use strict';
/*
 * Runs the extension in a real VS Code (an installed one; nothing is downloaded) with a throw-away profile, extension folder
 * and workspace, so that nothing of the person's own VS Code is read or changed. The data Thunder Client "has" is a fixture
 * written into the throw-away profile.
 *
 *   node extension/test/run.cjs                      uses the VS Code found next to the user's programs
 *   API_CLIENT_TEST_EXECUTABLE=<Code.exe> node ...   uses this one
 *
 * Needs `npm run build` in extension/ first.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

function findExecutable() {
  const given = process.env.API_CLIENT_TEST_EXECUTABLE;
  if (given) return given;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    '/usr/share/code/code',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

(async () => {
  const executable = findExecutable();
  if (!executable) {
    console.error('No VS Code found. Set API_CLIENT_TEST_EXECUTABLE to the path of Code.exe (or the code binary).');
    process.exitCode = 2;
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-client-host-')));
  const workspace = path.join(root, 'workspace');
  const profile = path.join(root, 'profile');
  const appData = path.join(root, 'appdata');
  const home = path.join(root, 'home');
  for (const dir of [workspace, appData, home]) fs.mkdirSync(dir, { recursive: true });

  // What the extension will find as Thunder Client's data: in the folder next to where this editor keeps extension storage.
  const thunder = path.join(profile, 'User', 'globalStorage', 'rangav.vscode-thunder-client');
  fs.mkdirSync(path.join(thunder, 'collections'), { recursive: true });
  fs.mkdirSync(path.join(thunder, 'environments'), { recursive: true });
  const request = (name, extra) => ({ _id: `r-${name}`, colId: 'c1', containerId: '', name, url: '{{base}}/' + name, method: 'GET', ...extra });
  fs.writeFileSync(path.join(thunder, 'collections', 'tc_col_shop.json'), JSON.stringify({
    _id: 'c1', colName: 'Shop', folders: [{ _id: 'f1', name: 'Orders', containerId: '' }],
    requests: [request('list', { auth: { type: 'bearer', bearer: 'CANARY-host-token-1234' } }), request('get', { containerId: 'f1' })]
  }));
  fs.writeFileSync(path.join(thunder, 'environments', 'tc_env_dev.json'), JSON.stringify({ _id: 'e1', name: 'dev', data: [{ name: 'base', value: 'https://dev.example' }, { name: 'region', value: 'eu' }] }));

  // With API_CLIENT_TEST_REST_CLIENT_VSIX=<humao.rest-client .vsix> REST Client is installed in the throw-away profile and the settings that
  // the person already has (with comments) are written first, so that the flow of filling in its settings is tried for real.
  const restClientVsix = process.env.API_CLIENT_TEST_REST_CLIENT_VSIX;
  const extensions = path.join(root, 'extensions');
  if (restClientVsix) {
    const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const quote = text => '"' + text + '"';
    const installed = spawnSync([quote(cli), '--install-extension', quote(path.resolve(restClientVsix)), '--extensions-dir', quote(extensions), '--user-data-dir', quote(profile)].join(' '), { encoding: 'utf8', shell: true, timeout: 120000 });
    if (installed.status !== 0) throw new Error('Installing REST Client failed: ' + (installed.stderr || installed.stdout));
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), [
      '// my workspace settings', '{', '  "editor.tabSize": 3,', '  // my own variables', '  "rest-client.environmentVariables": {',
      '    "dev": { "base": "https://mine.example", "extra": "x" }', '  },', '  "rest-client.enableTelemetry": false', '}', ''
    ].join('\n'));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), [
      '// my user settings', '{', '  "editor.fontSize": 15,', '  // keep this one out of the sync', '  "settingsSync.ignoredSettings": ["some.other.setting"],',
      '  "telemetry.telemetryLevel": "off",', '  "update.mode": "none"', '}', ''
    ].join('\n'));
  }

  try {
    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      extensionTestsEnv: { API_CLIENT_TEST_ROOT: root, API_CLIENT_TEST_REST_CLIENT: restClientVsix ? '1' : '0', APPDATA: appData, HOME: home },
      launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--user-data-dir', profile, '--extensions-dir', extensions]
    });
    console.log('Host run passed.');
  } catch (error) {
    console.error(`Host run failed: ${error}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
