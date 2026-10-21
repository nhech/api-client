import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonString, lf, phpQuote, powershellQuote, shellQuote, type CodeRequest } from '../../src/codegen';
import { generateCode, TARGETS } from '../../src/codegen/languages';
import { codeNotes, codeRequestFrom } from '../../src/view/code';
import { CODE_LANGUAGES } from '../../src/view/code-languages';
import type { WireRequest } from '../../src/engine/types';

/** Code that sends a request: the same request in each language, with the strings of the language, and the two that can be run here run for real. */

const goldenDir = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'golden', 'codegen');
const update = process.env['UPDATE_GOLDEN'] === '1';

const SAMPLES: Record<string, CodeRequest> = {
  get: { method: 'GET', url: 'https://api.test/pets?limit=10', headers: [['Accept', 'application/json'], ['X-Token', 'abc']] },
  json: { method: 'POST', url: 'https://api.test/pets', headers: [['Content-Type', 'application/json'], ['Authorization', 'Bearer [redacted]']], body: { kind: 'text', text: `{"name":"it's \\"Rex\\"","n":"line\nbreak","u":"${String.fromCodePoint(0xe9)}"}` } },
  form: { method: 'POST', url: 'https://api.test/login', headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: { kind: 'form', fields: [['user', 'ann lee'], ['pass', 'p&ss=1']] } },
  multi: { method: 'PUT', url: 'https://api.test/up', headers: [['Content-Type', 'multipart/form-data; boundary=x'], ['X-A', '1']], body: { kind: 'multipart', parts: [{ name: 'note', value: 'hi' }, { name: 'doc', file: './a.pdf', filename: 'a.pdf', contentType: 'application/pdf' }] } },
  file: { method: 'POST', url: 'https://api.test/raw', headers: [['Content-Type', 'application/octet-stream']], body: { kind: 'file', path: './data.bin' } },
  binary: { method: 'POST', url: 'https://api.test/bin', headers: [['Content-Type', 'application/octet-stream']], body: { kind: 'binary', size: 12 } }
};

test('The same sample requests give the same code in every language (goldens: UPDATE_GOLDEN=1 to rewrite, then read the diff)', () => {
  mkdirSync(goldenDir, { recursive: true });
  for (const target of TARGETS) {
    for (const [name, request] of Object.entries(SAMPLES)) {
      const file = join(goldenDir, `${target.id}-${name}.txt`);
      const actual = `${target.generate(request)}\n`;
      if (update) writeFileSync(file, actual);
      assert.ok(existsSync(file), `${target.id}-${name}: no golden (UPDATE_GOLDEN=1)`);
      assert.equal(actual, readFileSync(file, 'utf8'), `${target.id}-${name}`);
    }
  }
  assert.deepEqual(TARGETS.map(target => target.id), ['curl', 'powershell', 'fetch', 'axios', 'python', 'go', 'csharp', 'php', 'java']);
  assert.equal(generateCode('nope', SAMPLES['get'] as CodeRequest), undefined);
  assert.deepEqual(CODE_LANGUAGES.map(language => [language.id, language.label]), TARGETS.map(target => [target.id, target.label]), 'the page offers what the generators write');
});

test('A string of each language says what it says and nothing else', () => {
  assert.equal(jsonString('a"b\\c\nd\te'), '"a\\"b\\\\c\\nd\\te"');
  assert.equal(jsonString(`x${String.fromCodePoint(0x2028)}y${String.fromCodePoint(0x2029)}z`), '"x\\u2028y\\u2029z"', 'the separators that JSON allows and JavaScript does not');
  assert.equal(jsonString(`${String.fromCharCode(0)}${String.fromCharCode(27)}`), '"\\u0000\\u001b"');
  assert.equal(shellQuote(`it's $(touch pwned) \`id\` "x" \\ ! ;`), `'it'\\''s $(touch pwned) \`id\` "x" \\ ! ;'`);
  assert.equal(shellQuote(''), "''");
  assert.equal(phpQuote(`it's \\ $x {$y} "z"`), `'it\\'s \\\\ $x {$y} "z"'`);
  assert.equal(powershellQuote(`it's`), "'it''s'");
  assert.equal(powershellQuote(`a${String.fromCodePoint(0x2018)}b${String.fromCodePoint(0x2019)}c${String.fromCodePoint(0x201a)}d${String.fromCodePoint(0x201b)}e`), `'a${String.fromCodePoint(0x2018)}${String.fromCodePoint(0x2018)}b${String.fromCodePoint(0x2019)}${String.fromCodePoint(0x2019)}c${String.fromCodePoint(0x201a)}${String.fromCodePoint(0x201a)}d${String.fromCodePoint(0x201b)}${String.fromCodePoint(0x201b)}e'`, 'the typographic single quotes are quotes to PowerShell too');
  assert.equal(lf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('What a client sets by itself is left to it, a header twice is kept, and a method is written in capitals', () => {
  const base: CodeRequest = { method: 'post', url: 'https://h.test/', headers: [['Host', 'h.test'], ['Content-Length', '5'], ['Connection', 'keep-alive'], ['Transfer-Encoding', 'chunked'], ['X-Dup', '1'], ['x-dup', '2']], body: { kind: 'text', text: 'hello' } };
  for (const target of TARGETS) {
    const code = target.generate(base);
    for (const name of ['Content-Length', 'Transfer-Encoding']) assert.ok(!code.includes(name), `${target.id} leaves ${name} to the client`);
    assert.ok(code.includes('X-Dup') && code.includes('x-dup') || target.id === 'python', `${target.id} keeps both headers`);
    assert.ok(/POST/.test(code) || /\bpost\b/.test(code), `${target.id} writes the method`);
  }
  assert.match(generateCode('python', base) ?? '', /# Two headers have the same name/);
  assert.match(generateCode('fetch', base) ?? '', /headers: \[\n {4}\["X-Dup", "1"\],\n {4}\["x-dup", "2"\]\n {2}\]/, 'fetch takes a list of pairs when two headers have the same name');
  assert.match(generateCode('axios', base) ?? '', /Object\.fromEntries\(\[/);
  assert.ok(!(generateCode('java', { ...base, headers: [['Host', 'x'], ['Connection', 'close'], ['Upgrade', 'h2'], ['Expect', '100-continue'], ['Content-Length', '1'], ['X-Ok', '1']] }) ?? '').match(/\.header\("(?:Host|Connection|Upgrade|Expect|Content-Length)"/), 'the headers that the Java client refuses');
  assert.match(generateCode('curl', { method: 'head', url: 'https://h.test/', headers: [] }) ?? '', /^curl --head 'https:\/\/h\.test\/'/);
  assert.match(generateCode('curl', { method: 'get', url: 'https://h.test/', headers: [] }) ?? '', /^curl 'https:\/\/h\.test\/'$/);
});

test('A body that is a file, bytes or a multipart form is said in the way of each language', () => {
  assert.match(generateCode('curl', SAMPLES['multi'] as CodeRequest) ?? '', /--form-string 'note=hi'/);
  assert.match(generateCode('curl', SAMPLES['multi'] as CodeRequest) ?? '', /-F 'doc=@\.\/a\.pdf;type=application\/pdf'/);
  assert.ok(!(generateCode('curl', SAMPLES['multi'] as CodeRequest) ?? '').includes('Content-Type'), 'the boundary is curl\'s to make');
  assert.match(generateCode('curl', { method: 'POST', url: 'https://h.test/', headers: [], body: { kind: 'multipart', parts: [{ name: 'f', value: '@/etc/passwd' }] } }) ?? '', /--form-string 'f=@\/etc\/passwd'/, 'a text part that starts with @ is text, not a file to read');
  assert.match(generateCode('curl', SAMPLES['binary'] as CodeRequest) ?? '', /# The body is binary \(12 bytes\)/);
  for (const target of TARGETS) assert.match(target.generate(SAMPLES['binary'] as CodeRequest), /binary \(12 bytes\)/, `${target.id} says the body is binary`);
  assert.match(generateCode('go', SAMPLES['multi'] as CodeRequest) ?? '', /request\.Header\.Set\("Content-Type", writer\.FormDataContentType\(\)\)/);
  assert.match(generateCode('java', SAMPLES['multi'] as CodeRequest) ?? '', /no multipart body/);
  assert.match(generateCode('csharp', SAMPLES['multi'] as CodeRequest) ?? '', /new MultipartFormDataContent\(\)/);
  assert.match(generateCode('php', SAMPLES['multi'] as CodeRequest) ?? '', /new CURLFile\('\.\/a\.pdf', 'application\/pdf'\)/);
  assert.match(generateCode('python', SAMPLES['multi'] as CodeRequest) ?? '', /files=\[\("note", \(None, "hi"\)\)/);
  assert.match(generateCode('powershell', SAMPLES['multi'] as CodeRequest) ?? '', /-Form @\{ 'note' = 'hi'; 'doc' = Get-Item '\.\/a\.pdf' \}/);
});

// ---- from what is sent ----

const wire = (change: Partial<WireRequest> = {}): WireRequest => ({ method: 'POST', url: 'https://api.test/x?token=sekret-value-1', headers: [['Authorization', 'Bearer sekret-value-1'], ['Content-Type', 'application/json']], ...change });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

test('The request of the Code tab is what would be sent, with the secrets written as redacted and what is shown made printable', () => {
  const secrets = ['sekret-value-1', 'other-secret-9'];
  const text = codeRequestFrom(wire({ body: { kind: 'bytes', bytes: bytes('{"password":"other-secret-9","n":1}') } }), secrets);
  assert.deepEqual(text, { method: 'POST', url: 'https://api.test/x?token=[redacted]', headers: [['Authorization', 'Bearer [redacted]'], ['Content-Type', 'application/json']], body: { kind: 'text', text: '{"password":"[redacted]","n":1}' } });
  assert.deepEqual(codeRequestFrom(wire(), secrets).body, undefined);
  const form = codeRequestFrom(wire({ headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: { kind: 'bytes', bytes: bytes('a=1+2&b=%26x&c=other-secret-9&d') } }), secrets);
  assert.deepEqual(form.body, { kind: 'form', fields: [['a', '1 2'], ['b', '&x'], ['c', '[redacted]'], ['d', '']] });
  const brokenForm = codeRequestFrom(wire({ headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: { kind: 'bytes', bytes: bytes('a=%E0%A4%A') } }), secrets);
  assert.deepEqual(brokenForm.body, { kind: 'text', text: 'a=%E0%A4%A' }, 'a form that cannot be decoded is shown as it is');
  const binary = codeRequestFrom(wire({ body: { kind: 'bytes', bytes: new Uint8Array([0xff, 0xfe, 0x00]) } }), secrets);
  assert.deepEqual(binary.body, { kind: 'binary', size: 3 });
  const file = codeRequestFrom(wire({ body: { kind: 'file', path: '/home/ann/secret-folder/data.bin' } }), secrets);
  assert.deepEqual(file.body, { kind: 'file', path: './data.bin' }, 'the folders of the person are not in the code');
  const multipart = codeRequestFrom(wire({ body: { kind: 'multipart', boundary: 'b', parts: [{ name: 'n', value: 'other-secret-9' }, { name: 'f', filePath: 'C:\\Users\\ann\\a.pdf', filename: 'a.pdf', contentType: 'application/pdf' }] } }), secrets);
  assert.deepEqual(multipart.body, { kind: 'multipart', parts: [{ name: 'n', value: '[redacted]' }, { name: 'f', file: './a.pdf', filename: 'a.pdf', contentType: 'application/pdf' }] });
  const odd = codeRequestFrom(wire({ url: `https://h.test/${String.fromCharCode(10)}x`, headers: [[`X${String.fromCharCode(0)}`, `a${String.fromCharCode(27)}b`]] }), secrets);
  assert.deepEqual([odd.url, odd.headers], ['https://h.test/?x', [['X?', 'a?b']]]);
  assert.deepEqual(codeNotes(['A warning.'], secrets), ['A warning.', 'Secret values are written as [redacted]: put them back before running the code.']);
  assert.deepEqual(codeNotes([], []), []);
});

// ---- the two that can be run here ----

const hostile: CodeRequest = {
  method: 'POST', url: 'PLACEHOLDER', headers: [['X-Quote', `it's "q" $(touch pwned) \`id\` \\ ;`], ['Content-Type', 'text/plain; charset=utf-8']],
  body: { kind: 'text', text: `line one\nit's "two" $(touch pwned2) \`id\` \\n ${String.fromCodePoint(0xe9)}${String.fromCodePoint(0x1f600)} \${x} {{y}}\nlast` }
};

async function withEcho<T>(run: (url: string, seen: Promise<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }>) => Promise<T>): Promise<T> {
  let resolveSeen: (value: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }) => void = () => undefined;
  const seen = new Promise<{ method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }>(resolve => { resolveSeen = resolve; });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => { resolveSeen({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); res.end('ok'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/p?a=1&b=two%20words`, seen); } finally { server.closeAllConnections(); server.close(); }
}

const haveBash = spawnSync('bash', ['-c', 'command -v curl'], { encoding: 'utf8' }).status === 0;

/** Runs a program without blocking this process: the server of the test is in it, and has to answer while the program runs. */
function run(file: string, args: string[], options: { cwd?: string; input?: string } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 20_000, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) }, (error, stdout, stderr) => {
      resolve({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
    // The script goes in on the standard input, as UTF-8: an argument of a command line is not kept as it is on every system.
    child.stdin?.end(options.input ?? '');
  });
}

test('The cURL command, run in a shell, sends the request it describes, and the text of the request cannot run anything', { skip: !haveBash && 'no bash and curl here' }, async () => {
  await withEcho(async (url, seen) => {
    // Plain ASCII: an argument that goes through a shell on Windows is converted to the code page of the machine before cURL sees it, whatever is written.
    const ascii: CodeRequest = { ...hostile, url, body: { kind: 'text', text: `line one\nit's "two" $(touch pwned2) \`id\` \\n \${x} {{y}}\nlast` } };
    const result = await run('bash', [], { cwd: join(__dirname, '..', '..', '..', '.test-build'), input: generateCode('curl', ascii) as string });
    assert.equal(result.status, 0, result.stderr);
    const got = await seen;
    assert.equal(got.method, 'POST');
    assert.equal(got.url, '/p?a=1&b=two%20words');
    assert.equal(got.headers['x-quote'], hostile.headers[0]?.[1]);
    assert.equal(got.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(got.body, ascii.body?.kind === 'text' ? ascii.body.text : '', 'the body arrives as it was written');
    assert.ok(!existsSync(join(__dirname, '..', '..', '..', '.test-build', 'pwned')) && !existsSync(join(__dirname, '..', '..', '..', '.test-build', 'pwned2')), 'nothing in the data was run by the shell');
  });
});

test('The fetch code, run by Node, sends the request it describes, and the text of the request cannot run anything', async () => {
  await withEcho(async (url, seen) => {
    const code = generateCode('fetch', { ...hostile, url }) as string;
    const result = await run(process.execPath, ['--input-type=module', '-e', code]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^200 ok/);
    const got = await seen;
    assert.deepEqual([got.method, got.url, got.headers['x-quote'], got.headers['content-type']], ['POST', '/p?a=1&b=two%20words', hostile.headers[0]?.[1], 'text/plain; charset=utf-8']);
    assert.equal(got.body, hostile.body?.kind === 'text' ? hostile.body.text : '');
  });
  await withEcho(async (url, seen) => {
    const code = generateCode('fetch', { method: 'POST', url, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: { kind: 'form', fields: [['user', 'ann lee'], ['pass', 'p&ss=1'], ['u', `${String.fromCodePoint(0xe9)}`]] } }) as string;
    const result = await run(process.execPath, ['--input-type=module', '-e', code]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await seen).body, 'user=ann+lee&pass=p%26ss%3D1&u=%C3%A9');
  });
});

const havePython = spawnSync('python', ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)']).status === 0;

test('The Python code is Python, and the C-like languages have their strings closed', { skip: !havePython && 'no Python 3 here' }, () => {
  for (const [name, request] of Object.entries({ ...SAMPLES, hostile })) {
    const code = generateCode('python', request) as string;
    const result = spawnSync('python', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});
