import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../../src/core/clock';
import { newContainer, newRequest, type Container, type Environment, type Request, type Var } from '../../src/core/model';
import { confinedFile } from '../../src/engine/files';
import { locate, prepareSend, type PrepareInput } from '../../src/engine/prepare';
import type { ContainerNode, Loaded, RequestNode } from '../../src/storage/store';

const clock: Clock = { now: () => 1_700_000_000_000, random: () => 0.5 };
const variable = (name: string, value: string, secret = false): Var => ({ name, value, secret, enabled: true });

const requestNode = (path: string, request: Request): RequestNode => ({ kind: 'request', path, slug: path.split('/').pop() ?? path, request, extra: new Map(), findings: [] });
const containerNode = (kind: 'collection' | 'folder', path: string, container: Container, children: (ContainerNode | RequestNode)[]): ContainerNode => ({ kind, path, slug: path.split('/').pop() ?? path, container, extra: new Map(), findings: [], children, implicit: false });

/** shop (base URL, a header, bearer auth, variable host) > orders (a variable of its own, a header, and the variable host when asked) > get-order. */
function fixture(over: { folderHost?: boolean; workspaceVars?: Var[]; workspaceSettings?: Loaded['workspace']['file']['settings']; environments?: Environment[]; request?: Partial<Request> } = {}) {
  const request: Request = { ...newRequest('R1', 'Get order'), url: '/orders/1', ...over.request };
  const node = requestNode('api-client/collections/shop/orders/get-order.req.yml', request);
  const orders = containerNode('folder', 'api-client/collections/shop/orders', { ...newContainer('F1', 'Orders'), vars: [...(over.folderHost === true ? [variable('host', 'folder-host')] : []), variable('only-folder', 'f')], headers: [{ name: 'X-Folder', value: 'f', enabled: true, description: '' }] }, [node]);
  const shop = containerNode('collection', 'api-client/collections/shop', {
    ...newContainer('C1', 'Shop'), baseUrl: 'https://{{host}}', vars: [variable('host', 'collection-host')], auth: { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' },
    headers: [{ name: 'X-Shop', value: 's', enabled: true, description: '' }]
  }, [orders]);
  const loaded: Loaded = {
    workspace: { path: 'api-client/workspace.yml', file: { settings: over.workspaceSettings ?? {}, vars: over.workspaceVars ?? [variable('host', 'workspace-host'), variable('token', 'workspace-token', true)], collections: [] }, extra: new Map(), findings: [] },
    collections: [shop],
    environments: (over.environments ?? [{ id: 'E1', name: 'dev', vars: [variable('host', 'env-host'), variable('token', 'env-token-1', true)] }]).map(environment => ({ kind: 'environment' as const, path: `api-client/environments/${environment.name}.env.yml`, slug: environment.name, environment, extra: new Map(), findings: [] })),
    broken: [], notes: [], truncated: false
  };
  return { loaded, request, node, path: node.path };
}

const prepare = (setup: ReturnType<typeof fixture>, over: Partial<PrepareInput> = {}) => prepareSend({
  loaded: setup.loaded, path: setup.path, request: setup.request, environmentId: 'E1', clock, resolveFile: (base, relative) => `/abs/${base}/${relative}`, ...over
});

test('A request is found by its file in the tree, with the folders above it, and a file that is not in the tree is not found', () => {
  const setup = fixture();
  const found = locate(setup.loaded, setup.path);
  assert.deepEqual([found?.node.request.id, found?.collection.container.name, found?.chain.map(container => container.container.name)], ['R1', 'Shop', ['Shop', 'Orders']]);
  assert.equal(locate(setup.loaded, 'api-client/collections/shop/nope.req.yml'), undefined);
  assert.equal(prepareSend({ loaded: setup.loaded, path: 'nope', request: setup.request, environmentId: undefined, clock, resolveFile: () => undefined }), undefined);
});

test('The request goes out with what it inherits: the base URL, the headers and the authentication of the folders above it', () => {
  const prepared = prepare(fixture());
  assert.equal(prepared?.built.wire.url, 'https://collection-host/orders/1');
  assert.deepEqual(prepared?.built.wire.headers.filter(([name]) => name.startsWith('X-')), [['X-Shop', 's'], ['X-Folder', 'f']]);
  assert.deepEqual(prepared?.built.wire.headers.find(([name]) => name === 'Authorization'), ['Authorization', 'Bearer env-token-1']);
  assert.deepEqual(prepared?.built.secrets, ['token']);
  assert.ok(prepared?.built.redactions.includes('env-token-1'));
  assert.deepEqual(prepared?.problems, []);
  assert.equal(prepared?.effective.authFrom, 'Shop');
});

test('Variables: the folder beats the collection, the collection beats the environment, the environment beats the workspace, and what a run has set beats all', () => {
  const setup = fixture({ request: { url: 'http://x.test/{{host}}/{{token}}' } });
  assert.equal(prepare(setup)?.built.wire.url, 'http://x.test/collection-host/env-token-1', 'the collection beats the environment, which beats the workspace');
  assert.equal(prepare(setup, { environmentId: undefined })?.built.wire.url, 'http://x.test/collection-host/workspace-token', 'with no environment the workspace is what is left');
  const withFolder = fixture({ folderHost: true, request: { url: '{{host}}/{{only-folder}}' } });
  assert.equal(prepare(withFolder)?.built.wire.url, 'http://folder-host/f', 'the folder beats the collection and the environment');
  const withRuntime = prepare(withFolder, { runtime: new Map([['host', { value: 'runtime-host', secret: false }]]) });
  assert.equal(withRuntime?.built.wire.url, 'http://runtime-host/f');
  assert.equal(prepare(setup, { environmentId: 'unknown' })?.environment, undefined, 'an environment that does not exist is not used');
  assert.equal(prepare(setup, { environmentId: 'unknown' })?.built.wire.url, 'http://x.test/collection-host/workspace-token');
});

test('The settings of the workspace, the collection and the request are put together, the nearest winning', () => {
  const setup = fixture({ workspaceSettings: { timeoutMs: 5000, followRedirects: false, maxRedirects: 3 }, request: { settings: { followRedirects: true } } });
  const prepared = prepare(setup);
  assert.deepEqual([prepared?.options.timeoutMs, prepared?.options.followRedirects, prepared?.options.maxRedirects, prepared?.options.tls.rejectUnauthorized], [5000, true, 3, true]);
});

test('A request that cannot be sent says why in words: no address, no host, a cycle, a variable with no value in the address, a file that is not allowed', () => {
  const bare = fixture({ request: { url: '' } });
  bare.loaded.collections[0]!.container.baseUrl = '';
  assert.deepEqual(prepare(bare)?.problems, ['The request has no address.']);
  const noHost = fixture({ request: { url: '/orders' } });
  noHost.loaded.collections[0]!.container.baseUrl = '';
  assert.match(prepare(noHost)?.problems[0] ?? '', /no host.*base URL/);
  const cycle = fixture({ request: { url: 'http://x.test/{{a}}' }, workspaceVars: [variable('a', '{{b}}'), variable('b', '{{a}}')] });
  assert.match(prepare(cycle)?.problems.join(' ') ?? '', /refer to themselves: (?:a|b)/);
  const missing = fixture({ request: { url: '{{nowhere}}/x' } });
  assert.deepEqual(prepare(missing)?.problems, ['The address uses variables that have no value: nowhere.']);
  assert.equal(prepare(missing)?.built.wire.url, '{{nowhere}}/x', 'nothing is guessed');
  const file = fixture({ request: { url: 'http://x.test/', body: { kind: 'binary', file: '../secret.key' } } });
  assert.match(prepare(file, { resolveFile: () => undefined })?.problems[0] ?? '', /not allowed or does not exist/);
});

test('An address without a scheme gets http:// and a warning; one with a scheme is left alone, and the folder of the collection is what files are looked for in', () => {
  const bare = fixture({ request: { url: 'localhost:3000/health' } });
  bare.loaded.collections[0]!.container.baseUrl = '';
  const prepared = prepare(bare);
  assert.equal(prepared?.built.wire.url, 'http://localhost:3000/health');
  assert.deepEqual(prepared?.built.warnings, ['The address had no scheme, so http:// was used.']);
  const spaced = fixture({ request: { url: '  https://x.test/a  ' } });
  assert.equal(prepare(spaced)?.built.wire.url, 'https://x.test/a');
  const upload = fixture({ request: { url: 'http://x.test/', body: { kind: 'binary', file: 'data/in.bin' } } });
  let asked: string[] = [];
  prepare(upload, { resolveFile: (base, relative) => { asked = [base, relative]; return undefined; } });
  assert.deepEqual(asked, ['api-client/collections/shop', 'data/in.bin']);
});

// ---- confinedFile ----

/** `base` is a folder with a file `../secret.txt` next to it: the file outside a collection that a path with .. would reach. */
function withFolder(run: (base: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), 'api-client-files-'));
  const base = join(parent, 'collection');
  mkdirSync(base);
  writeFileSync(join(parent, 'secret.txt'), 'outside');
  try { run(base); } finally { rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('A file of the collection is allowed; a path that leaves the collection, or is not a plain file, is not', () => {
  withFolder(base => {
    mkdirSync(join(base, 'data', 'deep'), { recursive: true });
    writeFileSync(join(base, 'data', 'a.json'), '{}');
    writeFileSync(join(base, 'data', 'deep', 'b.bin'), 'x');
    assert.equal(confinedFile(base, 'data/a.json'), join(base, 'data', 'a.json'));
    assert.equal(confinedFile(base, 'data\\deep\\b.bin'), join(base, 'data', 'deep', 'b.bin'), 'either slash');
    assert.equal(confinedFile(base, './data//a.json'), join(base, 'data', 'a.json'), 'a dot and a double slash mean nothing');
    assert.equal(confinedFile(base, './'.repeat(600) + 'data/a.json'), undefined, 'a name that is far too long is refused though it ends in a file');
    assert.equal(confinedFile(base, '/data/a.json'), undefined, 'a path from the root is not read as one from the collection');
    assert.equal(confinedFile(base, '\data\a.json'), undefined, 'nor one from the root with the other slash');
    assert.equal(confinedFile(base, '../secret.txt'), undefined, 'a file next to the collection is outside it');
    assert.equal(confinedFile(base, 'data/../../secret.txt'), undefined);
    assert.equal(confinedFile(base, 'data\..\..\secret.txt'), undefined, 'with either slash');
    for (const bad of ['', '.', '..', '../x', 'data/../../x', 'data/../a.json', '/etc/passwd', '\\windows\\win.ini', 'C:\\x', 'c:/x', '\\\\server\\share\\f', 'data', 'data/deep', 'missing.json', 'data/missing', 'a\0b', 'x'.repeat(2000)]) {
      assert.equal(confinedFile(base, bad), undefined, JSON.stringify(bad.slice(0, 30)));
    }
  });
});

test('A link on the way to a file is refused, whether the link is the file or a folder above it', () => {
  withFolder(base => {
    const outside = mkdtempSync(join(tmpdir(), 'api-client-outside-'));
    try {
      writeFileSync(join(outside, 'key.pem'), 'secret');
      mkdirSync(join(base, 'data'));
      writeFileSync(join(base, 'data', 'a.json'), '{}');
      try {
        symlinkSync(join(outside, 'key.pem'), join(base, 'key-link'), 'file');
        symlinkSync(outside, join(base, 'dir-link'), process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return; // no right to make links here: nothing to test
        throw error;
      }
      assert.equal(confinedFile(base, 'key-link'), undefined, 'the file is a link');
      assert.equal(confinedFile(base, 'dir-link/key.pem'), undefined, 'a folder above it is a link');
      assert.equal(confinedFile(base, 'data/a.json'), join(base, 'data', 'a.json'), 'a plain file next to them is fine');
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
