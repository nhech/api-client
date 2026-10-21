import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRequest, type Request } from '../../src/core/model';
import { writeRequest } from '../../src/format/schema';
import { applyEditOps, applyLineEdit, minimalEdit, toRangeEdit } from '../../src/view/edit';
import { appContentSecurityPolicy, buildAppHtml } from '../../src/view/page';
import { MAX_OPS, parseToHost } from '../../src/view/request-protocol';

const NONCE = 'q3Vf8mZ0aG1xT9bL2cYh7w==';
const CSP_SOURCE = "https://*.vscode-cdn.net 'self'";

test('The page runs one script with a nonce and nothing inline, may add only styles that carry the nonce, and may open no connection', () => {
  const html = buildAppHtml({ cspSource: CSP_SOURCE, nonce: NONCE, scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/app.js', styleUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/media/app.css', screen: 'request' });
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
  assert.ok(policy);
  assert.equal(policy, appContentSecurityPolicy(CSP_SOURCE, NONCE));
  assert.match(policy, /^default-src 'none';/);
  assert.ok(policy.includes(`script-src 'nonce-${NONCE}'`) && policy.includes(`style-src ${CSP_SOURCE} 'nonce-${NONCE}'`));
  assert.ok(!/unsafe-inline|unsafe-eval|wasm-unsafe-eval/.test(policy), 'no unsafe source');
  assert.ok(!/connect-src|frame-src|object-src|worker-src/.test(policy), 'no network, frame, plugin or worker source');
  assert.ok(policy.includes("base-uri 'none'") && policy.includes("form-action 'none'"));
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.match(html, new RegExp(`<script nonce="${NONCE.replace(/[+/=]/g, '\\$&')}" src="[^"]+app\\.js"></script>`));
  assert.ok(!/<script\b(?![^>]*\bsrc=)/.test(html) && !/\sstyle\s*=/.test(html) && !/<style\b/.test(html) && !/\son[a-z]+\s*=/.test(html));
  assert.match(html, /<meta name="csp-nonce" content="q3Vf8mZ0aG1xT9bL2cYh7w==">/);
  assert.match(html, /<body data-screen="request">/);
});

test('A nonce or a source list that could change the policy is refused, and the file addresses are escaped', () => {
  const good = { cspSource: CSP_SOURCE, nonce: NONCE, scriptUri: 'https://x/app.js', styleUri: 'https://x/app.css', screen: 'request' as const };
  for (const nonce of ['', 'short', "abcdefghijklmnop'; script-src *", 'abcdefghijklmnop"><script>']) assert.throws(() => buildAppHtml({ ...good, nonce }), /nonce/, nonce);
  for (const cspSource of ["'unsafe-inline'; script-src *", 'a; b', 'a, b', 'a"b', '']) assert.throws(() => buildAppHtml({ ...good, cspSource }), /source list/, JSON.stringify(cspSource));
  const html = buildAppHtml({ ...good, scriptUri: 'https://x/a"><img src=x onerror=alert(1)>.js' });
  assert.ok(!html.includes('<img'));
});

test('A message of the page is read only when it is exactly one of the known shapes', () => {
  assert.deepEqual(parseToHost({ type: 'send' }), { type: 'send' });
  assert.deepEqual(parseToHost({ type: 'cancel', extra: 1 }), { type: 'cancel' });
  assert.deepEqual(parseToHost({ type: 'ready', violations: ['a', 5, 'b'.repeat(500)] }), { type: 'ready', violations: ['a', 'b'.repeat(200)] });
  assert.deepEqual(parseToHost({ type: 'ready' }), { type: 'ready', violations: [] });
  assert.deepEqual(parseToHost({ type: 'edit', rev: 3, ops: [{ op: 'set', path: ['url'], value: 'x' }, { op: 'insert', path: ['headers'], index: 0, value: { name: 'A' } }, { op: 'remove', path: ['headers'], index: 1 }, { op: 'move', path: ['headers'], from: 0, to: 2 }] }),
    { type: 'edit', rev: 3, ops: [{ op: 'set', path: ['url'], value: 'x' }, { op: 'insert', path: ['headers'], index: 0, value: { name: 'A' } }, { op: 'remove', path: ['headers'], index: 1 }, { op: 'move', path: ['headers'], from: 0, to: 2 }] });
  for (const bad of [undefined, null, 5, 'send', [], {}, { type: 'unknown' }, { type: 5 }, { type: 'edit' }, { type: 'edit', rev: -1, ops: [{ op: 'set', path: ['a'], value: 1 }] }, { type: 'edit', rev: 1.5, ops: [{ op: 'set', path: ['a'], value: 1 }] },
    { type: 'edit', rev: 1, ops: [] }, { type: 'edit', rev: 1, ops: 'x' }, { type: 'edit', rev: 1, ops: [{ op: 'nope', path: ['a'] }] }, { type: 'edit', rev: 1, ops: [{ op: 'set', path: [], value: 1 }] },
    { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['a'] }] }, { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['a'], value: () => 1 }] }, { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['a'], value: Number.NaN }] },
    { type: 'edit', rev: 1, ops: [{ op: 'insert', path: ['a'], index: -1, value: 'x' }] }, { type: 'edit', rev: 1, ops: [{ op: 'remove', path: ['a'], index: 1.5 }] }, { type: 'edit', rev: 1, ops: [{ op: 'move', path: ['a'], from: 0 }] },
    { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['__proto__', 'x'], value: 1 }] }, { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['a', 'constructor'], value: 1 }] },
    { type: 'edit', rev: 1, ops: [{ op: 'set', path: ['a'], value: { __proto__: null, constructor: 1 } }] }, { type: 'edit', rev: 1, ops: [{ op: 'set', path: Array(9).fill('a'), value: 1 }] },
    { type: 'edit', rev: 1, ops: Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'set', path: ['a'], value: 1 })) }]) {
    assert.equal(parseToHost(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(parseToHost(JSON.parse('{"type":"edit","rev":1,"ops":[{"op":"set","path":["a"],"value":{"__proto__":{"x":1}}}]}')), undefined, 'a __proto__ key from JSON is refused too');
  assert.equal(parseToHost(Object.create({ type: 'send' })), undefined, 'inherited properties do not count');
});

const base = (): Request => ({ ...newRequest('01J9Z4V0N2XK7Q3M8T5R6Y1ABC', 'List'), url: 'http://x.test/a', headers: [{ name: 'A', value: '1', enabled: true, description: '' }] });
const ok = (request: Request, ops: Parameters<typeof applyEditOps>[1]): Request => {
  const result = applyEditOps(request, ops);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.ok ? result.request : request;
};
const refused = (request: Request, ops: Parameters<typeof applyEditOps>[1]): string => {
  const result = applyEditOps(request, ops);
  assert.equal(result.ok, false);
  return result.ok ? '' : result.reason;
};

test('An edit sets a field, adds, removes and moves rows, and the result is the request the file format would read back', () => {
  const r = base();
  const edited = ok(r, [
    { op: 'set', path: ['name'], value: 'Renamed' }, { op: 'set', path: ['method'], value: 'POST' }, { op: 'set', path: ['url'], value: '{{base}}/x' },
    { op: 'insert', path: ['headers'], index: 1, value: { name: 'B', value: '2', enabled: false, description: '' } },
    { op: 'set', path: ['headers', 0, 'value'], value: 'changed' }, { op: 'move', path: ['headers'], from: 1, to: 0 },
    { op: 'set', path: ['auth'], value: { kind: 'bearer', token: 't', prefix: 'Bearer' } }, { op: 'set', path: ['body'], value: { kind: 'json', text: '{}' } },
    { op: 'set', path: ['settings', 'timeoutMs'], value: 5000 }
  ]);
  assert.deepEqual([edited.name, edited.method, edited.url], ['Renamed', 'POST', '{{base}}/x']);
  assert.deepEqual(edited.headers.map(h => [h.name, h.value, h.enabled]), [['B', '2', false], ['A', 'changed', true]]);
  assert.deepEqual([edited.auth.kind, edited.body.kind, edited.settings], ['bearer', 'json', { timeoutMs: 5000 }]);
  assert.equal(edited.id, r.id);
  assert.equal(r.name, 'List', 'the request that was given is not changed');
  const removed = ok(edited, [{ op: 'remove', path: ['headers'], index: 0 }]);
  assert.deepEqual(removed.headers.map(h => h.name), ['A']);
});

test('An edit cannot change the identifier, reach what it does not own, or put something of the wrong shape into the request', () => {
  const r = base();
  assert.match(refused(r, [{ op: 'set', path: ['id'], value: 'other' }]), /not something that can be edited/);
  assert.match(refused(r, [{ op: 'set', path: ['mirror2'], value: 'x' }]), /not something that can be edited/);
  assert.match(refused(r, [{ op: 'set', path: ['headers', 5, 'value'], value: 'x' }]), /no row 5/);
  assert.match(refused(r, [{ op: 'set', path: ['auth', 'kind', 'x'], value: 'x' }]), /there is no kind|not inside something/);
  assert.match(refused(r, [{ op: 'insert', path: ['name'], index: 0, value: 'x' }]), /not a list/);
  assert.match(refused(r, [{ op: 'insert', path: ['headers'], index: 9, value: {} }]), /cannot be added at 9/);
  assert.match(refused(r, [{ op: 'remove', path: ['headers'], index: 3 }]), /no row 3 to remove/);
  assert.match(refused(r, [{ op: 'remove', path: ['headers'], index: 1 }]), /no row 1 to remove/, 'the first place after the last row is not a row');
  assert.match(refused(r, [{ op: 'set', path: ['headers', 1], value: { name: 'B', value: '', enabled: true, description: '' } }]), /no row 1/, 'a row is replaced, not added, by setting it');
  assert.match(refused(r, [{ op: 'move', path: ['headers'], from: 0, to: 4 }]), /cannot be moved/);
  assert.match(refused(r, [{ op: 'set', path: ['name'], value: 5 }]), /name: expected text/);
  assert.match(refused(r, [{ op: 'set', path: ['name'], value: '   ' }]), /needs a name/);
  assert.match(refused(r, [{ op: 'set', path: ['method'], value: 'GE T' }]), /method: not a valid HTTP method/);
  assert.match(refused(r, [{ op: 'set', path: ['mirror'], value: 'maybe' }]), /mirror must be true or false/);
  assert.match(refused(r, [{ op: 'set', path: ['settings', 'timeoutMs'], value: 0 }]), /expected a number from 1 to 3600000/);
  assert.match(refused(r, [{ op: 'set', path: ['auth'], value: { kind: 'kerberos' } }]), /auth\.kind: expected one of/);
  assert.match(refused(r, [{ op: 'set', path: ['headers'], value: 'not a list' }]), /does not fit|expected a list|not a list/);
  assert.match(refused(r, [{ op: 'set', path: ['query'], value: { a: 1 } }]), /does not fit|expected a list/);
  assert.match(refused(r, [{ op: 'set', path: ['url'], value: 'x'.repeat(9 * 1024 * 1024) }]), /too large/);
  assert.equal(r.name, 'List');
  // The prototype is not reachable from a path, even when it is not stopped earlier by the parser.
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('A list holds a limited number of rows, and the identifier stays what it was even when it is not one the format would keep', () => {
  const row = { name: 'H', value: '', enabled: true, description: '' };
  const full = { ...base(), headers: Array.from({ length: 10_000 }, () => row) };
  assert.match(refused(full, [{ op: 'insert', path: ['headers'], index: 0, value: row }]), /cannot be added at 0/);
  const almost = { ...base(), headers: Array.from({ length: 9_999 }, () => row) };
  assert.equal(ok(almost, [{ op: 'insert', path: ['headers'], index: 0, value: row }]).headers.length, 10_000);
  for (const id of ['', 'legacy-id', 'x'.repeat(40)]) assert.equal(ok({ ...base(), id }, [{ op: 'set', path: ['name'], value: 'Other' }]).id, id, JSON.stringify(id));
});

test('Setting a key an object does not have yet is fine for optional parts, and a key that is not part of the format is dropped by the reader', () => {
  const edited = ok(base(), [{ op: 'set', path: ['settings', 'followRedirects'], value: false }, { op: 'set', path: ['settings', 'bogus'], value: 1 }]);
  assert.deepEqual(edited.settings, { followRedirects: false });
});

test('Several edits in one message are applied in order and all or none', () => {
  const r = base();
  assert.equal(refused(r, [{ op: 'set', path: ['name'], value: 'Changed' }, { op: 'set', path: ['method'], value: 'GE T' }]).startsWith('method'), true);
  assert.equal(r.name, 'List');
  const edited = ok(r, [{ op: 'insert', path: ['query'], index: 0, value: { name: 'a', value: '1', enabled: true, description: '' } }, { op: 'set', path: ['query', 0, 'value'], value: '2' }]);
  assert.equal(edited.query[0]?.value, '2');
});

test('The smallest change of lines turns one text into another, whatever the line endings', () => {
  const texts = ['', 'a', 'a\n', 'a\nb', 'a\nb\n', 'a\nb\nc\n', 'a\nx\nc\n', 'b\n', 'a\nb\nc\nd\n', 'x\n\ny\n', '\n', '\n\n', 'same\nsame\nsame\n', 'same\nsame\n', 'a\nb\nb\nb\nc'];
  for (const before of texts) for (const after of texts) {
    for (const eol of ['\n', '\r\n']) {
      const document = before.replace(/\n/g, eol);
      const edit = minimalEdit(document, after);
      if (edit === undefined) { assert.equal(before, after); continue; }
      const range = toRangeEdit(document, edit, eol);
      const offsetOf = (line: number, char: number): number => document.split(/\r?\n/).slice(0, line).reduce((total, text) => total + text.length + eol.length, 0) + char;
      const result = document.slice(0, offsetOf(range.startLine, range.startChar)) + range.text + document.slice(offsetOf(range.endLine, range.endChar));
      assert.equal(result, after.replace(/\n/g, eol), `${JSON.stringify(before)} -> ${JSON.stringify(after)} with ${JSON.stringify(eol)}`);
      assert.equal(applyLineEdit(document, edit, eol), after.replace(/\n/g, eol));
    }
  }
  assert.equal(minimalEdit('a\r\nb\r\n', 'a\nb\n'), undefined, 'the same lines with other line endings are no change');
});

test('One field changed in a file replaces one line, not the file', () => {
  const r = base();
  const before = writeRequest(r);
  const after = writeRequest({ ...r, url: 'http://x.test/changed' });
  const edit = minimalEdit(before, after);
  assert.deepEqual(edit && [edit.endLine - edit.startLine, edit.lines.length], [1, 1]);
  const added = writeRequest({ ...r, query: [{ name: 'q', value: '1', enabled: true, description: '' }] });
  const insertion = minimalEdit(before, added);
  assert.equal((insertion?.lines.length ?? 0) > 1 && (insertion?.endLine ?? 0) - (insertion?.startLine ?? 0) <= 1, true);
});

test('Property: random edits of a text give the exact new text (1000 pairs, both line endings)', () => {
  let state = 4242;
  const random = (n: number): number => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 16) % n; };
  const piece = (): string => ['a', 'b', 'c', '', 'same', 'x y'][random(6)] as string;
  const text = (): string => Array.from({ length: random(7) }, piece).join('\n');
  for (let run = 0; run < 1000; run++) {
    const before = text();
    const after = random(3) === 0 ? before.split('\n').reverse().join('\n') : text();
    const eol = random(2) === 0 ? '\n' : '\r\n';
    const document = before.replace(/\n/g, eol);
    const edit = minimalEdit(document, after);
    if (edit === undefined) { assert.equal(before.split('\n').join('\n'), after); continue; }
    const range = toRangeEdit(document, edit, eol);
    const lines = document.split(/\r?\n/);
    const offsetOf = (line: number, char: number): number => lines.slice(0, line).reduce((total, item) => total + item.length + eol.length, 0) + char;
    assert.equal(document.slice(0, offsetOf(range.startLine, range.startChar)) + range.text + document.slice(offsetOf(range.endLine, range.endChar)), after.replace(/\n/g, eol), `run ${run}`);
  }
});
