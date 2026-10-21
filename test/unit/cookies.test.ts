import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, JAR_LIMITS, parseCookieDate, parseSetCookie } from '../../src/core/cookies';

/** A jar with a clock the test moves. */
function jarAt(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  const clock = { time: start };
  const jar = new CookieJar(() => clock.time);
  return { jar, clock };
}
const url = (text: string): URL => new URL(text);
const header = (jar: CookieJar, text: string): string | undefined => jar.header(url(text));

test('The cookie date is read in the formats servers send, and a text with no date gives nothing', () => {
  const expected = Date.UTC(1994, 10, 6, 8, 49, 37);
  for (const text of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994', '6 nov 1994 8:49:37', 'Sun, 06-Nov-1994 08:49:37 GMT']) assert.equal(parseCookieDate(text), expected, text);
  assert.equal(parseCookieDate('Wed, 01 Jan 2070 00:00:00 GMT'), Date.UTC(2070, 0, 1));
  assert.equal(parseCookieDate('Mon, 01 Jan 69 00:00:00 GMT'), Date.UTC(2069, 0, 1), 'two digits below 70 are 20xx');
  assert.equal(parseCookieDate('Mon, 01 Jan 70 00:00:00 GMT'), Date.UTC(1970, 0, 1), 'and from 70 are 19xx');
  for (const bad of ['', 'tomorrow', 'Sun, 32 Nov 1994 08:49:37 GMT', 'Sun, 06 Nov 1994 25:49:37 GMT', 'Sun, 06 Nov 1600 08:49:37 GMT', '06 Nov 1994', 'Sun, 06 Foo 1994 08:49:37 GMT']) assert.equal(parseCookieDate(bad), undefined, bad);
});

test('A cookie goes back to the host that set it, on the paths under its own, and to nobody else', () => {
  const { jar } = jarAt();
  jar.store(url('https://api.example.com/v1/items'), ['a=1']);
  assert.equal(header(jar, 'https://api.example.com/v1/other'), 'a=1', 'the default path is the directory of the request');
  assert.equal(header(jar, 'https://api.example.com/v1/'), 'a=1');
  assert.equal(header(jar, 'https://api.example.com/v1'), 'a=1', 'the path /v1 matches itself');
  assert.equal(header(jar, 'https://api.example.com/'), undefined);
  assert.equal(header(jar, 'https://other.example.com/v1/x'), undefined, 'a host-only cookie does not go to a sibling');
  assert.equal(header(jar, 'https://sub.api.example.com/v1/x'), undefined, 'nor to a subdomain');
  jar.store(url('https://api.example.com/'), ['root=1; Path=/', 'deep=2; Path=/v1/items']);
  assert.equal(header(jar, 'https://api.example.com/v1/items/9'), 'deep=2; a=1; root=1', 'longest path first, then oldest');
  assert.equal(header(jar, 'https://api.example.com/v10'), 'root=1', 'the path must end at a slash boundary');
});

test('A Domain attribute makes the cookie go to the domain and its subdomains, and only a host of that domain can set it', () => {
  const { jar } = jarAt();
  jar.store(url('https://api.example.com/'), ['wide=1; Domain=example.com', 'dot=2; Domain=.example.com', 'narrow=3; Domain=api.example.com']);
  assert.equal(header(jar, 'https://www.example.com/'), 'wide=1; dot=2');
  assert.equal(header(jar, 'https://example.com/'), 'wide=1; dot=2');
  assert.equal(header(jar, 'https://api.example.com/'), 'wide=1; dot=2; narrow=3');
  assert.equal(header(jar, 'https://badexample.com/'), undefined);
  jar.clear();
  jar.store(url('https://api.example.com/'), ['x=1; Domain=other.com', 'y=1; Domain=com', 'z=1; Domain=co.uk', 'w=1; Domain=sub.api.example.com', 'v=1; Domain=github.io']);
  assert.deepEqual(jar.list(), [], 'a domain of somebody else, a public suffix, or a child of the host is refused');
  jar.store(url('https://me.github.io/'), ['mine=1; Domain=github.io', 'ok=1']);
  assert.deepEqual(jar.list().map(c => c.name), ['ok']);
});

test('A single-label host and an address take host-only cookies; a Domain attribute on them is refused unless it is the host', () => {
  const { jar } = jarAt();
  jar.store(url('http://localhost:3000/'), ['a=1', 'b=2; Domain=localhost']);
  assert.equal(header(jar, 'http://localhost:4000/anything'), 'a=1; b=2', 'the port is not part of a cookie');
  jar.store(url('http://127.0.0.1/'), ['c=3', 'd=4; Domain=127.0.0.1', 'e=5; Domain=0.0.1']);
  assert.equal(header(jar, 'http://127.0.0.1/'), 'c=3; d=4');
  assert.equal(header(jar, 'http://10.127.0.1/'), undefined);
  jar.store(url('http://[::1]:8080/'), ['v6=1']);
  assert.equal(header(jar, 'http://[::1]:9/'), 'v6=1');
});

test('A Secure cookie is not accepted over http (except on this machine) and is not sent over http', () => {
  const { jar } = jarAt();
  jar.store(url('http://example.com/'), ['plain=1', 'sec=2; Secure']);
  assert.deepEqual(jar.list().map(c => c.name), ['plain']);
  jar.store(url('https://example.com/'), ['sec=2; Secure']);
  assert.equal(header(jar, 'https://example.com/'), 'plain=1; sec=2');
  assert.equal(header(jar, 'http://example.com/'), 'plain=1');
  jar.store(url('http://localhost/'), ['dev=1; Secure']);
  assert.equal(header(jar, 'http://localhost/'), 'dev=1');
});

test('The prefixes __Secure- and __Host- keep their promises', () => {
  const { jar } = jarAt();
  jar.store(url('https://example.com/'), ['__Secure-a=1', '__Secure-b=1; Secure', '__Host-c=1; Secure; Path=/', '__Host-d=1; Secure; Path=/x', '__Host-e=1; Secure; Path=/; Domain=example.com', '__Host-f=1']);
  assert.deepEqual(jar.list().map(c => c.name).sort(), ['__Host-c', '__Secure-b']);
});

test('Expires and Max-Age: a cookie lives until then, Max-Age wins, zero or a past date removes it, and without either it is a session cookie', () => {
  const { jar, clock } = jarAt();
  jar.store(url('https://x.test/'), ['session=1', 'age=2; Max-Age=60', 'date=3; Expires=Thu, 01 Jan 2026 12:05:00 GMT', 'both=4; Expires=Thu, 01 Jan 2026 12:00:10 GMT; Max-Age=3600']);
  assert.equal(header(jar, 'https://x.test/'), 'session=1; age=2; date=3; both=4');
  assert.deepEqual(jar.persistent().map(c => c.name), ['age', 'date', 'both']);
  clock.time += 30_000;
  assert.equal(header(jar, 'https://x.test/'), 'session=1; age=2; date=3; both=4', 'Max-Age wins over the earlier Expires');
  clock.time += 31_000;
  assert.equal(header(jar, 'https://x.test/'), 'session=1; date=3; both=4');
  clock.time += 300_000;
  assert.equal(header(jar, 'https://x.test/'), 'session=1; both=4');
  jar.store(url('https://x.test/'), ['both=gone; Max-Age=0', 'session=2; Expires=Wed, 01 Jan 2020 00:00:00 GMT']);
  assert.equal(header(jar, 'https://x.test/'), undefined, 'a cookie with a past date or no time left removes the cookie it replaces');
  jar.store(url('https://x.test/'), ['neg=1; Max-Age=-5', 'junk=1; Max-Age=abc']);
  assert.deepEqual(jar.list().map(c => c.name), ['junk'], 'a Max-Age that is not a number is ignored');
});

test('A cookie with the same name, domain and path replaces the old one and keeps its place in the order', () => {
  const { jar, clock } = jarAt();
  jar.store(url('https://x.test/'), ['a=1; Path=/', 'b=1; Path=/']);
  clock.time += 1000;
  jar.store(url('https://x.test/'), ['a=2; Path=/']);
  assert.equal(header(jar, 'https://x.test/'), 'a=2; b=1', 'a keeps its creation time');
  jar.store(url('https://x.test/'), ['a=other; Path=/elsewhere']);
  assert.equal(jar.list().length, 3, 'another path is another cookie');
  assert.equal(jar.remove('a', 'x.test', '/elsewhere'), true);
  assert.equal(jar.remove('a', 'x.test', '/elsewhere'), false);
});

test('Things that are not cookies are ignored: no equals sign, no name, control characters, a size over the limit', () => {
  const { jar } = jarAt();
  jar.store(url('https://x.test/'), ['novalue', '=1', 'a\u0001=1', 'b=\u0007', `big=${'x'.repeat(JAR_LIMITS.cookieBytes)}`, `${'n'.repeat(JAR_LIMITS.headerBytes)}=1`, 'good=1', 'spaced = padded value ; Path=/']);
  assert.deepEqual(jar.list().map(c => [c.name, c.value]), [['good', '1'], ['spaced', 'padded value']]);
});

test('The jar holds no more than its limits: per domain and in total, the oldest go first', () => {
  const { jar, clock } = jarAt();
  for (let index = 0; index < JAR_LIMITS.cookiesPerDomain + 20; index++) { clock.time += 1; jar.store(url('https://x.test/'), [`c${index}=1`]); }
  const kept = jar.list().map(c => c.name);
  assert.equal(kept.length, JAR_LIMITS.cookiesPerDomain);
  assert.equal(kept.includes('c0'), false);
  assert.equal(kept.includes(`c${JAR_LIMITS.cookiesPerDomain + 19}`), true);
  const wide = jarAt();
  for (let index = 0; index < JAR_LIMITS.totalCookies / JAR_LIMITS.cookiesPerDomain + 5; index++) {
    for (let cookie = 0; cookie < JAR_LIMITS.cookiesPerDomain; cookie++) { wide.clock.time += 1; wide.jar.store(url(`https://h${index}.test/`), [`k${cookie}=1`]); }
  }
  assert.equal(wide.jar.list().length, JAR_LIMITS.totalCookies);
});

test('The cookies that outlive the session are saved and come back; a session cookie and an expired one do not', () => {
  const { jar, clock } = jarAt();
  jar.store(url('https://x.test/'), ['session=1', 'kept=2; Max-Age=3600; Secure; HttpOnly; SameSite=Lax', 'soon=3; Max-Age=10']);
  const saved = JSON.parse(JSON.stringify(jar.persistent())) as unknown;
  clock.time += 60_000;
  const other = new CookieJar(() => clock.time);
  other.load(saved);
  other.load('not a list');
  other.load([null, 5, { name: 'x' }, { name: 'n', value: 'v', domain: 'd.test', path: '/' }]);
  assert.deepEqual(other.list().map(c => [c.name, c.domain, c.secure, c.httpOnly, c.sameSite]), [['kept', 'x.test', true, true, 'Lax'], ['n', 'd.test', false, false, '']]);
  assert.equal(header(other, 'https://x.test/'), 'kept=2');
});

test('Clearing removes one domain or all', () => {
  const { jar } = jarAt();
  jar.store(url('https://a.test/'), ['a=1']);
  jar.store(url('https://b.test/'), ['b=1']);
  jar.clear('a.test');
  assert.deepEqual(jar.list().map(c => c.name), ['b']);
  jar.clear();
  assert.deepEqual(jar.list(), []);
});

test('A hostile Set-Cookie header costs time proportional to its size', () => {
  const { jar } = jarAt();
  const started = performance.now();
  jar.store(url('https://x.test/'), [`a=${'x'.repeat(8000)}`, `${';'.repeat(8000)}`, `a=1${'; Domain=x.test'.repeat(500)}`, `a=1; Expires=${'Mon '.repeat(2000)}`]);
  for (let index = 0; index < 2000; index++) jar.store(url('https://x.test/'), [`k${index % 100}=${index}`]);
  assert.ok(performance.now() - started < 1500);
});

test('A Set-Cookie header is read into its name, value and attributes, and one that is too long, nameless or holds a control character is not a cookie', () => {
  assert.deepEqual(parseSetCookie('id=a=b; Domain=.Example.COM; Path=/x; Max-Age=60; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure; HttpOnly; SameSite=Strict'), {
    name: 'id', value: 'a=b', domain: 'example.com', path: '/x', maxAge: 60, expires: Date.UTC(2026, 9, 21, 7, 28, 0), secure: true, httpOnly: true, sameSite: 'Strict'
  });
  assert.deepEqual(parseSetCookie('a=1'), { name: 'a', value: '1', domain: '', path: '', maxAge: undefined, expires: undefined, secure: false, httpOnly: false, sameSite: '' });
  assert.equal(parseSetCookie('a=1; Max-Age=abc')?.maxAge, undefined, 'a Max-Age that is not a number is ignored');
  assert.equal(parseSetCookie('a=1; Max-Age=-1')?.maxAge, -1);
  for (const bad of ['', 'novalue', '=nameless', 'a=b\u0001c', 'a\u007f=1', 'a=' + 'x'.repeat(JAR_LIMITS.cookieBytes), 'a=1; Path=/' + 'x'.repeat(JAR_LIMITS.headerBytes)]) assert.equal(parseSetCookie(bad), undefined, JSON.stringify(bad.slice(0, 30)));
});
