'use strict';
/*
 * Tries the .http files the importer wrote in JetBrains' own HTTP Client command line (ijhttp), for real. It runs in Docker on a
 * network that has no way out (--internal): a small recording server and the client share it, the files are mounted read-only,
 * and no port is opened on this computer. The importer's environment files are used as they are (--env-file, --private-env-file).
 *
 *   node samples/jetbrains-check/run.cjs [image] [result.json]
 *
 * The image is pulled beforehand (jetbrains/intellij-http-client:<tag>); nothing is pulled here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const image = process.argv[2] || 'jetbrains/intellij-http-client:263.7031.23';
const resultFile = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'jetbrains-check-result.json'));
const sampleApi = path.resolve(process.env.SAMPLE_API || path.join(__dirname, '..', 'workspace', 'api'));
if (!fs.existsSync(sampleApi)) { console.error('samples/workspace/api is missing; run the importer on the sample first.'); process.exit(2); }

const docker = (args, options = {}) => spawnSync('docker', args, { encoding: 'utf8', shell: false, timeout: 180000, ...options });
const run = Math.random().toString(36).slice(2, 8);
const network = `apiclient-jb-${run}`;
const mockName = `apiclient-jb-mock-${run}`;

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target); else fs.copyFileSync(source, target);
  }
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const MOCK = `
const http = require('node:http');
const fs = require('node:fs');
let seq = 0;
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    fs.appendFileSync('/log/requests.jsonl', JSON.stringify({ seq: ++seq, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') }) + '\\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":1,"main":{"temp":20}}');
  });
}).listen(8080, '0.0.0.0', () => console.log('listening'));
`;

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jb-check-')));
  const workspace = path.join(root, 'workspace');
  const log = path.join(root, 'log');
  const mock = path.join(root, 'mock');
  let created = false;
  try {
    copyTree(sampleApi, path.join(workspace, 'api'));
    for (const file of walk(path.join(workspace, 'api')).filter(f => f.endsWith('.http'))) {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/https:\/\/[a-z.]*example\.invalid/g, '{{baseUrl}}'));
    }
    const envFile = path.join(workspace, 'api', 'http-client.env.json');
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    for (const name of Object.keys(env)) env[name].baseUrl = 'http://mock:8080';
    fs.writeFileSync(envFile, JSON.stringify(env, null, 2));
    fs.writeFileSync(path.join(workspace, 'api', 'dynamic-probes.http'), require('../dynamic-probes.cjs').dynamicProbeFile());
    fs.writeFileSync(path.join(workspace, 'api', 'secret.txt'), 'TOPSECRET-FILE-CONTENT');
    fs.mkdirSync(path.join(workspace, 'api', 'Weather', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Weather', 'data', 'q.csv'), 'a,b\n');
    fs.mkdirSync(path.join(workspace, 'api', 'Internal Admin', 'data'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'api', 'Internal Admin', 'data', 'quarterly.csv'), 'q1,q2\n1,2\n');

    // Probes written by hand (not by the importer): body lines that mean something to JetBrains' client.
    fs.writeFileSync(path.join(workspace, 'api', 'probes.http'), [
      '### probe inline include', 'POST {{baseUrl}}/probe-include', 'Content-Type: text/plain', '', 'hello', '< ./secret.txt', 'bye', '',
      '### probe handler line', 'POST {{baseUrl}}/probe-handler', 'Content-Type: text/plain', '', 'before', '> {% client.test("injected", function() { client.assert(false, "HANDLER-ASSERT-RAN"); }); %}', '',
      '### probe expression', 'POST {{baseUrl}}/probe-expression', 'Content-Type: text/plain', '', "value={{ (1 + 1) }} and {{$processEnv HOME}} and {{$env.HOME}}", '',
      '### probe basic with space', 'GET {{baseUrl}}/probe-basic-space', 'Authorization: Basic admin secretpw', '',
      '### probe basic with colon', 'GET {{baseUrl}}/probe-basic-colon', 'Authorization: Basic admin:secretpw', ''
    ].join('\n'));

    fs.mkdirSync(log, { recursive: true });
    fs.mkdirSync(mock, { recursive: true });
    fs.writeFileSync(path.join(mock, 'mock.js'), MOCK);

    const net = docker(['network', 'create', '--internal', network]);
    if (net.status !== 0) throw new Error(`docker network: ${net.stderr}`);
    created = true;
    const started = docker(['run', '-d', '--rm', '--name', mockName, '--network', network, '--network-alias', 'mock', '-v', `${mock}:/mock:ro`, '-v', `${log}:/log`, 'node:22-bookworm', 'node', '/mock/mock.js']);
    if (started.status !== 0) throw new Error(`mock server: ${started.stderr}`);
    for (let i = 0; i < 50; i++) {
      if (docker(['logs', mockName]).stdout.includes('listening')) break;
      await new Promise(r => setTimeout(r, 200));
    }

    const outputs = [];
    for (const file of walk(path.join(workspace, 'api')).filter(f => f.endsWith('.http')).sort()) {
      const relative = path.relative(workspace, file).replaceAll('\\', '/');
      // The image's own entry point passes the arguments through a shell without quotes, which splits a path with a space
      // ("Pet Store"); the same command is run without a shell.
      const result = docker(['run', '--rm', '--network', network, '-v', `${workspace}:/workdir:ro`, '--entrypoint', 'java', image,
        '--add-opens=java.base/java.util=ALL-UNNAMED', '--sun-misc-unsafe-memory-access=allow', '-cp', '/intellij-http-client/*', 'com.intellij.httpClient.cli.HttpClientMain',
        '-L', 'VERBOSE', '--no-progress', '-e', 'dev', '-v', 'api/http-client.env.json', '-p', 'api/http-client.private.env.json', relative]);
      outputs.push({ file: relative, exit: result.status, output: `${result.stdout}\n${result.stderr}` });
    }
    const requestsFile = path.join(log, 'requests.jsonl');
    const received = fs.existsSync(requestsFile) ? fs.readFileSync(requestsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    fs.writeFileSync(resultFile, JSON.stringify({ image, outputs, received }, null, 2));
    console.log(`Done. Result: ${resultFile}`);
  } catch (error) {
    console.error(`Failed: ${error}`);
    process.exitCode = 1;
  } finally {
    docker(['rm', '-f', mockName]);
    if (created) docker(['network', 'rm', network]);
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
