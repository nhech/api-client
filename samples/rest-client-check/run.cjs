'use strict';
/*
 * Tries the .http files the importer wrote in REST Client, for real: an installed VS Code, a throw-away profile and extension
 * folder, REST Client installed from a VSIX you point to, and a local server on 127.0.0.1 that records what REST Client sends.
 * Nothing goes to the internet: telemetry and update checks are switched off in the throw-away profile.
 *
 *   node samples/rest-client-check/run.cjs <rest-client.vsix> [result.json]
 *
 * It needs the sample output first: node samples/make-sample.cjs, then the importer's --write into samples/workspace.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

const vsix = process.argv[2];
const resultFile = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'rest-client-check-result.json'));
if (!vsix || !fs.existsSync(vsix)) { console.error('Give the path of the REST Client .vsix.'); process.exit(2); }
const sampleApi = path.resolve(process.env.SAMPLE_API || path.join(__dirname, '..', 'workspace', 'api'));
if (!fs.existsSync(sampleApi)) { console.error('samples/workspace/api is missing; run the importer on the sample first.'); process.exit(2); }

const executable = process.env.API_CLIENT_TEST_EXECUTABLE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
if (!fs.existsSync(executable)) { console.error('No VS Code found; set API_CLIENT_TEST_EXECUTABLE.'); process.exit(2); }

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else fs.copyFileSync(source, target);
  }
}

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-check-')));
  const workspace = path.join(root, 'workspace');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const probe = path.join(root, 'probe');
  const port = await freePort();
  try {
    // The workspace: the importer's output, with the made-up hosts pointed at the local server.
    copyTree(sampleApi, path.join(workspace, 'api'));
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(workspace, 'api')).filter(f => f.endsWith('.http'))) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/https:\/\/[a-z.]*example\.invalid/g, '{{baseUrl}}'));
    }
    fs.writeFileSync(path.join(workspace, 'api', 'dynamic-probes.http'), require('../dynamic-probes.cjs').dynamicProbeFile());
    fs.writeFileSync(path.join(workspace, 'api', 'secret.txt'), 'TOPSECRET-FILE-CONTENT');
    // A probe written by hand (not by the importer): what REST Client does with a body line that starts with "< ".
    fs.writeFileSync(path.join(workspace, 'api', 'inline-probe.http'), '### inline include\nPOST {{baseUrl}}/inline-probe\nContent-Type: text/plain\n\nhello\n< ./secret.txt\nbye\n\n### probe process env\nGET {{baseUrl}}/probe-env?p={{$processEnv HY_SECRET_PROBE}}\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Weather', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Weather', 'data', 'q.csv'), 'a,b\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Internal Admin', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Internal Admin', 'data', 'quarterly.csv'), 'q1,q2\n1,2\n');

    // REST Client does not read http-client.env.json: the importer also writes the variables as the content of the setting
    // rest-client.environmentVariables. The shareable file goes to the workspace settings and the private one to the USER settings
    // (both scopes are merged by VS Code), exactly as the report tells a person to do. Only the base URL is pointed at the local server.
    const settingsOf = file => JSON.parse(fs.readFileSync(path.join(sampleApi, file), 'utf8'))['rest-client.environmentVariables'];
    const publicSettings = settingsOf('rest-client.settings.json');
    for (const name of Object.keys(publicSettings)) publicSettings[name].baseUrl = `http://127.0.0.1:${port}`;
    const privateSettings = fs.existsSync(path.join(sampleApi, 'rest-client.private.settings.json')) ? settingsOf('rest-client.private.settings.json') : {};
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'rest-client.environmentVariables': publicSettings,
      'rest-client.enableTelemetry': false, 'rest-client.timeoutinmilliseconds': 8000
    }, null, 2));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'rest-client.environmentVariables': privateSettings,
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.enableExperiments': false
    }, null, 2));
    fs.writeFileSync(path.join(workspace, 'api', 'envcheck.http'), '### envcheck\nGET {{baseUrl}}/envcheck/{{petId}}\n');
    // A probe written by hand (not by the importer): what REST Client does with a body line that starts with "< ".
    fs.writeFileSync(path.join(workspace, 'api', 'inline-probe.http'), '### inline include\nPOST {{baseUrl}}/inline-probe\nContent-Type: text/plain\n\nhello\n< ./secret.txt\nbye\n\n### probe process env\nGET {{baseUrl}}/probe-env?p={{$processEnv HY_SECRET_PROBE}}\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Weather', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Weather', 'data', 'q.csv'), 'a,b\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Internal Admin', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Internal Admin', 'data', 'quarterly.csv'), 'q1,q2\n1,2\n');

    // REST Client does not read http-client.env.json: its variables come from settings, so the same values go there.
    const publicEnv = JSON.parse(fs.readFileSync(path.join(sampleApi, 'http-client.env.json'), 'utf8'));
    const privateEnv = JSON.parse(fs.readFileSync(path.join(sampleApi, 'http-client.private.env.json'), 'utf8'));
    const variables = { ...publicEnv.dev, ...privateEnv.dev, baseUrl: `http://127.0.0.1:${port}` };
    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'rest-client.environmentVariables': { $shared: variables },
      'rest-client.enableTelemetry': false, 'rest-client.timeoutinmilliseconds': 8000
    }, null, 2));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.enableExperiments': false
    }, null, 2));

    // A do-nothing extension to hang the test run on, and REST Client installed with VS Code's own command line.
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'probe', publisher: 'probe', version: '0.0.0', engines: { vscode: '^1.100.0' }, main: './index.js' }));
    fs.writeFileSync(path.join(probe, 'index.js'), 'exports.activate = () => {};\n');
    // test-electron resolves the command line of VS Code (a .cmd file on Windows, which needs a shell); its default folders are dropped.
    const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const quote = text => `"${text}"`;
    const installed = spawnSync([quote(cli), '--install-extension', quote(path.resolve(vsix)), '--extensions-dir', quote(extensions), '--user-data-dir', quote(profile)].join(' '), { encoding: 'utf8', shell: true, timeout: 120000 });
    if (installed.status !== 0) throw new Error(`Installing REST Client failed (${installed.status}): ${installed.error || ''}${installed.stderr || ''}${installed.stdout || ''}`);
    console.log(installed.stdout.trim().split('\n').slice(-2).join('\n'));

    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: probe,
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      extensionTestsEnv: { HY_SECRET_PROBE: 'ENVIRONMENT-VALUE-FROM-PROCESS', RC_PORT: String(port), RC_WORKSPACE: workspace, RC_OUT: resultFile, APPDATA: path.join(root, 'appdata'), HOME: path.join(root, 'home') },
      launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--user-data-dir', profile, '--extensions-dir', extensions]
    });
    console.log(`Done. Result: ${resultFile}`);
  } catch (error) {
    console.error(`Failed: ${error}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
