import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, formatEntry, HISTORY_LIMITS, prune, readHistory, type HistoryEntry } from '../../src/history/entries';
import { buildEntry, hideSecrets, hideUrl, readMode, type HistoryInput } from '../../src/history/record';
import { clockOf, dayOf, entryNode, historyTree, shortUrl } from '../../src/history/tree';

/** The history: what is kept about a send, how it is made safe, how it is read back from a file, and how the side bar lists it. */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Overrides may say `undefined`: the key is then left out, as an entry that has no such field. */
const without = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
type Override<T> = { [K in keyof T]?: T[K] | undefined };

const entry = (id: string, at: number, extra: Override<HistoryEntry> = {}): HistoryEntry => without({ id, at, name: 'List users', path: 'api-client/collections/shop/list.req.yml', environment: 'Local', method: 'GET', url: 'https://api.example.com/users', status: 200, statusText: 'OK', ms: 42, size: 10, ...extra }) as HistoryEntry;

const input = (extra: Override<HistoryInput> = {}): HistoryInput => without({
  id: 'a1', at: NOW, ms: 41.6, name: 'List users', path: 'api-client/collections/shop/list.req.yml', environment: 'Local', method: 'GET', url: 'https://api.example.com/users', redactions: [],
  sent: { headers: [['Accept', 'application/json']], body: '' },
  answer: { status: 200, statusText: 'OK', size: 15, headers: [['Content-Type', 'application/json']], body: '{"ok":true}' },
  ...extra
}) as HistoryInput;

test('The mode of the setting is one of three, and anything else is the middle one', () => {
  assert.equal(readMode('off'), 'off');
  assert.equal(readMode('full'), 'full');
  assert.equal(readMode('metadata'), 'metadata');
  assert.equal(readMode(undefined), 'metadata');
  assert.equal(readMode('everything'), 'metadata');
  assert.equal(readMode(true), 'metadata');
});

test('With the mode "off" nothing is kept, with "metadata" only the line, with "full" the headers and the bodies too', () => {
  assert.equal(buildEntry(input(), 'off'), undefined);
  const line = buildEntry(input(), 'metadata');
  assert.ok(line);
  assert.equal(line.detail, undefined, 'no headers and no bodies');
  assert.deepEqual({ id: line.id, at: line.at, method: line.method, url: line.url, status: line.status, statusText: line.statusText, ms: line.ms, size: line.size, name: line.name, environment: line.environment }, { id: 'a1', at: NOW, method: 'GET', url: 'https://api.example.com/users', status: 200, statusText: 'OK', ms: 42, size: 15, name: 'List users', environment: 'Local' }, 'the time is rounded');
  const full = buildEntry(input(), 'full');
  assert.deepEqual(full?.detail, { requestHeaders: [['Accept', 'application/json']], requestBody: '', responseHeaders: [['Content-Type', 'application/json']], responseBody: '{"ok":true}', cut: false });
});

test('A send that got no answer is kept with the reason', () => {
  const failed = buildEntry(input({ answer: undefined, error: 'The server did not answer in time.' }), 'metadata');
  assert.equal(failed?.status, undefined);
  assert.equal(failed?.error, 'The server did not answer in time.');
  assert.equal(buildEntry(input({ answer: undefined }), 'metadata')?.error, undefined, 'no reason, no error');
});

test('The address has no user, no password and no secret in it', () => {
  assert.equal(hideUrl('https://user:pw@api.example.com/x', []), 'https://[redacted]@api.example.com/x');
  assert.equal(hideUrl('https://api.example.com/x?api_key=abc123&page=2', []), 'https://api.example.com/x?api_key=[redacted]&page=2');
  assert.equal(hideUrl('https://api.example.com/x?page=2&access_token=abc', []), 'https://api.example.com/x?page=2&access_token=[redacted]');
  assert.equal(hideUrl('https://api.example.com/x?accessToken=abc&q=1', []), 'https://api.example.com/x?accessToken=[redacted]&q=1', 'a name in camel case');
  assert.equal(hideUrl('https://api.example.com/x?%61pi_key=abc', []), 'https://api.example.com/x?%61pi_key=[redacted]', 'a name written with percent signs');
  assert.equal(hideUrl('https://api.example.com/x?monkey=abc&keyboard=1', []), 'https://api.example.com/x?monkey=abc&keyboard=1', 'names that only contain a word are not secret');
  assert.equal(hideUrl('https://api.example.com/p/s3cr3t-value/x', ['s3cr3t-value']), 'https://api.example.com/p/[redacted]/x', 'a secret value in the path');
  assert.equal(hideUrl('https://api.example.com/x#access_token=abc', []), 'https://api.example.com/x#', 'a fragment is not kept');
  assert.equal(hideUrl('https://api.example.com/x?flag&a=1', []), 'https://api.example.com/x?flag&a=1', 'a parameter with no value');
  assert.equal(hideUrl('https://api.example.com/\u202ex', []), 'https://api.example.com/?x', 'what cannot be shown is not kept');
});

test('A secret in a body is covered by its value, and by the name of its field', () => {
  assert.equal(hideSecrets('{"user":"ann","password":"hunter22","n":1}', []), '{"user":"ann","password":"[redacted]","n":1}');
  assert.equal(hideSecrets('{"access_token" : "abc.def", "expires_in": 3600}', []), '{"access_token" : "[redacted]", "expires_in": 3600}');
  assert.equal(hideSecrets('{"refreshToken":"x","idToken":"y","clientSecret":"z"}', []), '{"refreshToken":"[redacted]","idToken":"[redacted]","clientSecret":"[redacted]"}', 'camel case');
  assert.equal(hideSecrets('{"a":{"api-key":"k1","list":[{"secret":"k2"}]}}', []), '{"a":{"api-key":"[redacted]","list":[{"secret":"[redacted]"}]}}', 'nested');
  assert.equal(hideSecrets('{"note":"my password is 1234"}', []), '{"note":"my password is 1234"}', 'the name decides, not the words in a value');
  assert.equal(hideSecrets('{"password":"a\\"b","x":"y"}', []), '{"password":"[redacted]","x":"y"}', 'a value with an escaped quote is covered whole');
  assert.equal(hideSecrets('{"x":"the key is K-12345-ZZ"}', ['K-12345-ZZ']), '{"x":"the key is [redacted]"}', 'a known value anywhere');
  assert.equal(hideSecrets('grant_type=password&username=ann&password=hunter22&client_secret=abc', []), 'grant_type=password&username=ann&password=[redacted]&client_secret=[redacted]', 'a form');
  assert.equal(hideSecrets('access%5Ftoken=abc&x=1', []), 'access%5Ftoken=[redacted]&x=1', 'a form whose names are written with percent signs');
  assert.equal(hideSecrets('a=b&c', []), 'a=b&c', 'text that is not a form is left alone');
  assert.equal(hideSecrets('password=1 and more', []), 'password=1 and more', 'text with spaces is not a form');
  assert.equal(hideSecrets('', []), '');
});

test('A body is cut at the limit, never inside a character, and what is beyond the limit is not searched twice', () => {
  const limit = HISTORY_LIMITS.bodyChars;
  const long = 'x'.repeat(limit + 10);
  const cut = buildEntry(input({ answer: { status: 200, statusText: 'OK', size: long.length, headers: [], body: long } }), 'full');
  assert.equal(cut?.detail?.responseBody.length, limit);
  assert.equal(cut?.detail?.cut, true);
  const exact = buildEntry(input({ answer: { status: 200, statusText: 'OK', size: limit, headers: [], body: 'x'.repeat(limit) } }), 'full');
  assert.equal(exact?.detail?.cut, false, 'a body that fits is not cut');
  const pair = '\u{1F600}';
  const astral = `${'x'.repeat(limit - 1)}${pair}tail`;
  const kept = buildEntry(input({ answer: { status: 200, statusText: 'OK', size: astral.length, headers: [], body: astral } }), 'full');
  assert.equal(kept?.detail?.responseBody, 'x'.repeat(limit - 1), 'half of a pair is dropped');
  // A secret that starts before the limit and ends after it is covered whole, not left as a beginning.
  const secret = 'S'.repeat(40);
  const straddle = `${'x'.repeat(limit - 20)}${secret}${'y'.repeat(100)}`;
  const covered = buildEntry(input({ redactions: [secret], answer: { status: 200, statusText: 'OK', size: straddle.length, headers: [], body: straddle } }), 'full');
  assert.ok(covered?.detail?.responseBody.includes('[redacted]'), 'the secret is covered');
  const big = 'S'.repeat(2000);
  const shrunk = buildEntry(input({ redactions: [big], answer: { status: 200, statusText: 'OK', size: 0, headers: [], body: `${big}${'x'.repeat(limit - 100)}` } }), 'full');
  assert.ok((shrunk?.detail?.responseBody.length ?? limit) < limit, 'covering a long secret made the body shorter than the limit');
  assert.equal(shrunk?.detail?.cut, true, 'but there was more of it than was read');
  assert.ok(!covered?.detail?.responseBody.includes('SSSS'), 'no part of the secret is kept');
});

test('Headers are covered by their names and by the secret values, and are bounded', () => {
  const full = buildEntry(input({
    redactions: ['tok-123456'],
    sent: { headers: [['Authorization', 'Bearer tok-123456'], ['X-Custom', 'has tok-123456 inside'], ['Cookie', 'sid=1'], ['Accept', '*/*']], body: '' },
    answer: { status: 200, statusText: 'OK', size: 0, headers: [['Set-Cookie', 'sid=abc; HttpOnly'], ['X-Amz-Security-Token', 'zzz'], ['Content-Length', '0']], body: '' }
  }), 'full');
  assert.deepEqual(full?.detail?.requestHeaders, [['Authorization', '[redacted]'], ['X-Custom', 'has [redacted] inside'], ['Cookie', '[redacted]'], ['Accept', '*/*']]);
  assert.deepEqual(full?.detail?.responseHeaders, [['Set-Cookie', '[redacted]'], ['X-Amz-Security-Token', '[redacted]'], ['Content-Length', '0']]);
  const many = Array.from({ length: 300 }, (_, index): [string, string] => [`H${index}`, 'v']);
  assert.equal(buildEntry(input({ sent: { headers: many, body: '' } }), 'full')?.detail?.requestHeaders.length, HISTORY_LIMITS.headers);
  const long = buildEntry(input({ sent: { headers: [['X-Long', 'a'.repeat(5000)]], body: '' } }), 'full');
  assert.equal(long?.detail?.requestHeaders[0]?.[1].length, HISTORY_LIMITS.textChars);
});

test('In the line, the secrets are covered too', () => {
  const line = buildEntry(input({ url: 'https://u:p@api.example.com/x?token=abc&v=tok-123456', redactions: ['tok-123456'], answer: undefined, error: 'Could not reach https://api.example.com/x?v=tok-123456' }), 'metadata');
  assert.equal(line?.url, 'https://[redacted]@api.example.com/x?token=[redacted]&v=[redacted]');
  assert.equal(line?.error, 'Could not reach https://api.example.com/x?v=[redacted]');
});

test('What is read back from the file is checked, and what is not an entry is dropped', () => {
  assert.deepEqual(readHistory(undefined, NOW), []);
  assert.deepEqual(readHistory({ entries: [] }, NOW), [], 'not a list');
  assert.deepEqual(readHistory('text', NOW), []);
  const list = readHistory([
    entry('good-1', NOW - HOUR),
    null, 3, 'x', [],
    { id: 'no time', at: NOW, method: 'GET' },
    { id: 'bad_id!', at: NOW, method: 'GET' },
    { id: 'no-method', at: NOW, method: '' },
    { id: 'neg', at: -5, method: 'GET' },
    { id: 'nan', at: Number.NaN, method: 'GET' },
    { id: 'x'.repeat(41), at: NOW, method: 'GET' },
    { id: 'status-1', at: NOW - 2 * HOUR, method: 'GET', url: 'u', status: 99, ms: 1 },
    { id: 'status-2', at: NOW - 3 * HOUR, method: 'GET', url: 'u', status: 600, ms: 1 },
    { id: 'status-3', at: NOW - 4 * HOUR, method: 'GET', url: 'u', status: 204.4, statusText: 'No Content', ms: 1 }
  ], NOW);
  assert.deepEqual(list.map(item => item.id), ['good-1', 'status-1', 'status-2', 'status-3']);
  assert.equal(list[1]?.status, undefined, 'a status under 100 is not a status');
  assert.equal(list[2]?.status, undefined, 'nor is one over 599');
  assert.equal(list[3]?.status, 204);
});

test('What is read back is made printable and bounded, and the file cannot set what is not a field', () => {
  const hostile = {
    id: 'h1', at: NOW, method: 'GET\u202e', url: `https://a/${'p'.repeat(9000)}`, name: 'n\u0000ame', path: 'a/b', environment: 'e', ms: 1.4, size: -1, status: 200, statusText: 's',
    error: 'x'.repeat(900), detail: { requestHeaders: [['a', 'b'], ['bad'], [1, 2], 'x'], requestBody: 'q', responseHeaders: 'nope', responseBody: 5, cut: 'yes' }, __proto__: { polluted: true }, extra: 'ignored'
  };
  const [read] = readHistory([hostile], NOW);
  assert.ok(read);
  assert.equal(read.method, 'GET?');
  assert.equal(read.name, 'n?ame');
  assert.equal(read.url.length, 4000, 'an address is cut to what a field may hold');
  assert.equal(read.error?.length, 500);
  assert.equal(read.size, undefined, 'a negative size is not a size');
  assert.equal(read.ms, 1);
  assert.deepEqual(read.detail, { requestHeaders: [['a', 'b']], requestBody: 'q', responseHeaders: [], responseBody: '', cut: false });
  assert.equal(Object.hasOwn(read, 'extra'), false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  assert.deepEqual(readHistory([Object.create({ id: 'proto-1', at: NOW, method: 'GET' })], NOW), [], 'what only the prototype has is not a field');
  const withDetail = readHistory([{ ...entry('d-1', NOW), detail: Object.create({ requestBody: 'from the prototype', cut: true }) }], NOW)[0]?.detail;
  assert.deepEqual(withDetail, { requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '', cut: false }, 'nor is a field of the detail');
  const crowded = Array.from({ length: 150 }, (_, index) => [`H${index}`, 'v']);
  assert.equal(readHistory([{ ...entry('d-2', NOW), detail: { requestHeaders: crowded, requestBody: '', responseHeaders: [], responseBody: '', cut: false } }], NOW)[0]?.detail?.requestHeaders.length, HISTORY_LIMITS.headers, 'the headers are bounded when they are read');
});

test('The list is newest first, and is cut by age, by number and by size', () => {
  const old = entry('old', NOW - HISTORY_LIMITS.ageMs - 1);
  const edge = entry('edge', NOW - HISTORY_LIMITS.ageMs);
  assert.deepEqual(prune([old, edge, entry('new', NOW)], NOW).map(item => item.id), ['new', 'edge'], 'thirty days to the millisecond stays, a millisecond more goes');
  assert.deepEqual(prune([entry('a', NOW - 2), entry('b', NOW - 1), entry('c', NOW - 3)], NOW).map(item => item.id), ['b', 'a', 'c']);
  assert.deepEqual(prune([entry('a', NOW), entry('b', NOW)], NOW).map(item => item.id), ['b', 'a'], 'the same moment: a fixed order');
  const many = Array.from({ length: HISTORY_LIMITS.entries + 30 }, (_, index) => entry(`e${index}`, NOW - index));
  const kept = prune(many, NOW);
  assert.equal(kept.length, HISTORY_LIMITS.entries);
  assert.equal(kept[0]?.id, 'e0');
  assert.equal(kept.at(-1)?.id, `e${HISTORY_LIMITS.entries - 1}`, 'the oldest go');
  assert.deepEqual(addEntry([entry('a', NOW - HOUR)], entry('b', NOW), NOW).map(item => item.id), ['b', 'a']);
  assert.equal(addEntry(many, entry('fresh', NOW + 1), NOW).length, HISTORY_LIMITS.entries);
  // When the bodies are too much, the oldest lose theirs first; the lines stay.
  const body = 'b'.repeat(HISTORY_LIMITS.bodyChars);
  const heavy = (id: string, at: number): HistoryEntry => entry(id, at, { detail: { requestHeaders: [], requestBody: body, responseHeaders: [], responseBody: body, cut: false } });
  const count = Math.floor(HISTORY_LIMITS.totalBytes / (2 * body.length)) + 3;
  const big = Array.from({ length: count }, (_, index) => heavy(`h${index}`, NOW - index));
  const shrunk = prune(big, NOW);
  assert.equal(shrunk.length, count, 'no line is lost');
  assert.ok(shrunk[0]?.detail !== undefined, 'the newest keeps its bodies');
  assert.equal(shrunk.at(-1)?.detail, undefined, 'the oldest does not');
  const total = shrunk.reduce((sum, item) => sum + (item.detail === undefined ? 0 : item.detail.requestBody.length + item.detail.responseBody.length), 0);
  assert.ok(total <= HISTORY_LIMITS.totalBytes);
});

test('An entry reads as a document', () => {
  const line = formatEntry(entry('a', NOW, { environment: '' }));
  assert.match(line, /^GET https:\/\/api\.example\.com\/users\nStatus: 200 OK\nTime: 2026-10-22 12:00:00 UTC, 42 ms, 10 B\nRequest: List users \(api-client\/collections\/shop\/list\.req\.yml\)\n/);
  assert.ok(!line.includes('Environment:'), 'no environment, no line');
  assert.match(line, /not kept\. They are kept when the setting apiClient\.history\.mode is "full"\.\n$/);
  const failed = formatEntry(entry('b', NOW, { status: undefined, statusText: undefined, size: undefined, error: 'Timed out', name: '', path: '' }));
  assert.match(failed, /^GET [^\n]+\nFailed: Timed out\nTime: [^\n]+, 42 ms\nRequest: \(unnamed\)\n/);
  const full = formatEntry(entry('c', NOW, { size: 2048, detail: { requestHeaders: [['Accept', '*/*']], requestBody: '', responseHeaders: [['A', 'b']], responseBody: '{"ok":true}', cut: true } }));
  assert.match(full, /, 2\.0 KB\n/);
  assert.match(full, /--- Request headers ---\nAccept: \*\/\*\n\n--- Request body ---\n\(empty\)\n\n--- Response headers ---\nA: b\n\n--- Response body ---\n\{"ok":true\}\n\nA body was cut here: the history keeps the first 64 KB\.\n$/);
  assert.match(formatEntry(entry('d', NOW, { size: 3 * 1024 * 1024 })), /, 3\.0 MB\n/);
  assert.match(formatEntry(entry('e', NOW, { detail: { requestHeaders: [], requestBody: '', responseHeaders: [], responseBody: '', cut: false } })), /--- Request headers ---\n\(none\)/);
});

test('The side bar groups the sends by day, newest first, with today and yesterday by name', () => {
  const tree = historyTree([entry('a', NOW - 3 * HOUR), entry('b', NOW - DAY), entry('c', NOW), entry('d', NOW - 5 * DAY)], NOW);
  assert.deepEqual(tree.map(node => [node.label, node.description, node.children.map(child => child.id)]), [
    ['Today', '2', ['entry:c', 'entry:a']], ['Yesterday', '1', ['entry:b']], ['2026-10-17', '1', ['entry:d']]
  ]);
  assert.deepEqual(historyTree([], NOW), []);
});

test('The day is the day of the clock of the person, not of UTC', () => {
  const lateEvening = Date.UTC(2026, 9, 21, 23, 30, 0);
  assert.equal(dayOf(lateEvening, 0), '2026-10-21');
  assert.equal(dayOf(lateEvening, 60), '2026-10-22', 'one hour east, the next day has begun');
  assert.equal(dayOf(lateEvening, -24 * 60 + 1), '2026-10-20', 'a long way west');
  assert.equal(clockOf(lateEvening, 0), '23:30');
  assert.equal(clockOf(lateEvening, 60), '00:30');
  assert.equal(clockOf(Date.UTC(2026, 9, 21, 0, 5, 0), -30), '23:35');
  assert.equal(clockOf(Date.UTC(1969, 11, 31, 23, 59, 0), 0), '23:59', 'before 1970');
  const tree = historyTree([entry('a', lateEvening)], lateEvening + 2 * HOUR, () => 120);
  assert.equal(tree[0]?.label, 'Today', 'the entry and now are both in the clock of the person');
  assert.equal(tree[0]?.children[0]?.description, '200 - 42 ms - 01:30');
});

test('A line of the side bar says what was sent and how it ended', () => {
  const ok = entryNode(entry('a', NOW));
  assert.equal(ok.label, 'GET api.example.com/users');
  assert.equal(ok.description, '200 - 42 ms - 12:00');
  assert.equal(ok.icon, 'success');
  assert.equal(ok.tooltip, 'GET https://api.example.com/users\n200 OK\n42 ms\nRequest: List users\nEnvironment: Local');
  const icons = [[100, 'info'], [199, 'info'], [200, 'success'], [299, 'success'], [300, 'redirect'], [301, 'redirect'], [399, 'redirect'], [400, 'client-error'], [404, 'client-error'], [499, 'client-error'], [500, 'server-error'], [503, 'server-error']] as const;
  for (const [status, icon] of icons) assert.equal(entryNode(entry('x', NOW, { status })).icon, icon, String(status));
  const failed = entryNode(entry('f', NOW, { status: undefined, statusText: undefined, error: 'Timed out', name: '', environment: '' }));
  assert.equal(failed.icon, 'failed');
  assert.equal(failed.description, 'failed - 42 ms - 12:00');
  assert.equal(failed.tooltip, 'GET https://api.example.com/users\nFailed: Timed out\n42 ms');
  assert.equal(shortUrl('https://api.example.com/users?page=2&x=1'), 'api.example.com/users');
  assert.equal(shortUrl('http://localhost:3000'), 'localhost:3000');
  assert.equal(shortUrl(`https://${'a'.repeat(80)}`), 'a'.repeat(80), 'what fits is not cut');
  assert.equal(shortUrl(`https://${'a'.repeat(81)}`), `${'a'.repeat(77)}...`, 'one more is');
  assert.equal(shortUrl(`https://a.example/${'p'.repeat(100)}`).length, 80);
  assert.ok(shortUrl(`https://a.example/${'p'.repeat(100)}`).endsWith('...'));
});
