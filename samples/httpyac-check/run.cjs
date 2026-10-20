'use strict';
/*
 * Tries the .http files the importer wrote in httpYac, for real: an installed VS Code, a throw-away profile and extension
 * folder, the httpYac extension installed from a VSIX you point to, and a local server on 127.0.0.1 that records what httpYac
 * sends. Unlike REST Client, httpYac reads http-client.env.json itself, so the importer's environment files are used as they
 * are (only the base URL is pointed at the local server).
 *
 *   node samples/httpyac-check/run.cjs <httpyac.vsix> [result.json]
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

const vsix = process.argv[2];
const resultFile = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'httpyac-check-result.json'));
if (!vsix || !fs.existsSync(vsix)) { console.error('Give the path of the httpYac .vsix.'); process.exit(2); }
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hy-check-')));
  const workspace = path.join(root, 'workspace');
  const profile = path.join(root, 'profile');
  const extensions = path.join(root, 'extensions');
  const probe = path.join(root, 'probe');
  const port = await freePort();
  try {
    copyTree(sampleApi, path.join(workspace, 'api'));
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    // The made-up hosts of the sample become {{baseUrl}}, which the environment file below points at the local server.
    for (const file of walk(path.join(workspace, 'api')).filter(f => f.endsWith('.http'))) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/https:\/\/[a-z.]*example\.invalid/g, '{{baseUrl}}'));
    }
    const envFile = path.join(workspace, 'api', 'http-client.env.json');
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    for (const name of Object.keys(env)) env[name].baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(envFile, JSON.stringify(env, null, 2));

    // Probes written by hand (not by the importer): what httpYac does with text that could mean something to it. The "code"
    // they hold only writes an empty marker file into the throw-away workspace, which the suite then looks for.
    const markers = ['PWNED-body.txt', 'PWNED-header.txt', 'PWNED-url.txt'].map(name => path.join(workspace, name).replaceAll('\\', '/'));
    fs.writeFileSync(path.join(workspace, 'api', 'dynamic-probes.http'), require('../dynamic-probes.cjs').dynamicProbeFile());
    fs.writeFileSync(path.join(workspace, 'api', 'secret.txt'), 'TOPSECRET-FILE-CONTENT');
    fs.writeFileSync(path.join(workspace, 'api', 'probes.http'), [
      '### probe inline include', 'POST {{baseUrl}}/probe-include', 'Content-Type: text/plain', '', 'hello', '< ./secret.txt', 'bye', '',
      '### probe variable line', 'POST {{baseUrl}}/probe-variable', 'Content-Type: text/plain', '', 'before', '{{petId}}', 'after', '',
      '### probe script line', 'POST {{baseUrl}}/probe-script', 'Content-Type: text/plain', '', 'before', "{{ exports.zz = 'RAN' }}", 'x={{zz}}', 'after', '',
      '### probe expression in body', 'POST {{baseUrl}}/probe-expression-body', 'Content-Type: text/plain', '', `value={{ (require('fs').writeFileSync(${JSON.stringify(markers[0])}, 'x'), 'done') }}`, '',
      '### probe expression in header', 'GET {{baseUrl}}/probe-expression-header', `X-Probe: {{ (require('fs').writeFileSync(${JSON.stringify(markers[1])}, 'x'), 'done') }}`, '',
      '### probe expression in url', `GET {{baseUrl}}/probe-expression-url?q={{ (require('fs').writeFileSync(${JSON.stringify(markers[2])}, 'x'), 'done') }}`, '',
      '### probe process env', 'GET {{baseUrl}}/probe-env?p={{$processEnv HY_SECRET_PROBE}}', ''
    ].join('\n'));
    fs.mkdirSync(path.join(workspace, 'api', 'Weather', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Weather', 'data', 'q.csv'), 'a,b\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Internal Admin', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Internal Admin', 'data', 'quarterly.csv'), 'q1,q2\n1,2\n');

    fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ 'httpyac.environmentSelectedOnStart': ['dev'], 'httpyac.cookieJarEnabled': false }, null, 2));
    fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
      'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.enableExperiments': false
    }, null, 2));

    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'probe', publisher: 'probe', version: '0.0.0', engines: { vscode: '^1.100.0' }, main: './index.js' }));
    fs.writeFileSync(path.join(probe, 'index.js'), 'exports.activate = () => {};\n');
    const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const quote = text => `"${text}"`;
    const installed = spawnSync([quote(cli), '--install-extension', quote(path.resolve(vsix)), '--extensions-dir', quote(extensions), '--user-data-dir', quote(profile)].join(' '), { encoding: 'utf8', shell: true, timeout: 120000 });
    if (installed.status !== 0) throw new Error(`Installing httpYac failed (${installed.status}): ${installed.error || ''}${installed.stderr || ''}${installed.stdout || ''}`);
    console.log(installed.stdout.trim().split('\n').slice(-2).join('\n'));

    await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: probe,
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      extensionTestsEnv: { HY_MARKERS: JSON.stringify(markers), HY_SECRET_PROBE: 'ENVIRONMENT-VALUE-FROM-PROCESS', HY_PORT: String(port), HY_WORKSPACE: workspace, HY_OUT: resultFile, APPDATA: path.join(root, 'appdata'), HOME: path.join(root, 'home') },
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
