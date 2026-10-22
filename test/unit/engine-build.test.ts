import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../../src/core/clock';
import { effectiveRequest, type Level } from '../../src/core/inherit';
import { newContainer, newRequest, type Auth, type Body, type KV, type Request } from '../../src/core/model';
import { basicCredential } from '../../src/core/redact';
import type { Scope } from '../../src/core/vars';
import { buildWire, formEncode, type Built } from '../../src/engine/build';

const clock: Clock = { now: () => 1_700_000_000_000, random: () => 0.5 };
const kv = (name: string, value: string, enabled = true): KV => ({ name, value, enabled, description: '' });
const scope = (values: Record<string, string>, secret = false): Scope => new Map(Object.entries(values).map(([name, value]) => [name, { value, secret }]));
const allowAll = (relative: string): string | undefined => (relative.includes('..') || relative.startsWith('/') ? undefined : `/work/${relative}`);

function build(change: Partial<Request>, scopes: Scope[] = [], levels: Level[] = [], resolveFile = allowAll, oauthToken?: { accessToken: string; tokenType: string }): Built {
  const request: Request = { ...newRequest('r1', 'R'), ...change };
  return buildWire({ request, effective: effectiveRequest(request, levels), scopes, clock, resolveFile, ...(oauthToken === undefined ? {} : { oauthToken }) });
}
const bodyText = (built: Built): string => (built.wire.body?.kind === 'bytes' ? Buffer.from(built.wire.body.bytes).toString('utf8') : '<not bytes>');
const header = (built: Built, name: string): string[] => built.wire.headers.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);

test('The address: variables replaced, the base URL used, the fragment dropped, query rows added with their own encoding', () => {
  const level: Level = { kind: 'collection', name: 'Shop', container: { ...newContainer('c', 'Shop'), baseUrl: '{{host}}' } };
  const built = build({ url: '/pets?existing=1#frag', query: [kv('limit', '10'), kv('q', 'a b&c=d'), kv('off', 'x', false), kv('', 'nameless')] }, [scope({ host: 'https://api.example.com' })], [level]);
  assert.equal(built.wire.url, 'https://api.example.com/pets?existing=1&limit=10&q=a%20b%26c%3Dd');
  assert.deepEqual([built.wire.method, built.unresolved], ['GET', []]);
  assert.equal(build({ url: 'http://x.test/', query: [kv('a', '1')] }).wire.url, 'http://x.test/?a=1');
  assert.equal(build({ url: 'http://x.test/?', query: [kv('a', '1')] }).wire.url, 'http://x.test/?a=1');
  assert.equal(build({ url: 'http://x.test/?z=9&', query: [kv('a', '1')] }).wire.url, 'http://x.test/?z=9&a=1');
  assert.equal(build({ url: 'http://x.test/', query: [kv('a b', 'c d')] }).wire.url, 'http://x.test/?a%20b=c%20d');
  assert.equal(build({ url: 'http://x.test/', query: [kv('a b', 'c d')] }, [], [{ kind: 'collection', name: 'C', container: { ...newContainer('c', 'C'), settings: { encodeUrl: false } } }]).wire.url, 'http://x.test/?a b=c d', 'raw when the setting says so');
});

test('Path parameters fill {name} in the path only, encoded, and an unknown {name} stays', () => {
  const built = build({ url: 'https://x.test/pets/{petId}/photos/{photo}?next={petId}', pathParams: [kv('petId', 'a/b c'), kv('photo', '7')] });
  assert.equal(built.wire.url, 'https://x.test/pets/a%2Fb%20c/photos/7?next={petId}');
  assert.equal(build({ url: 'https://x.test/{missing}', pathParams: [kv('other', '1')] }).wire.url, 'https://x.test/{missing}');
  assert.equal(build({ url: 'https://x.test/{{host}}/{id}', pathParams: [kv('id', '{{n}}')] }, [scope({ host: 'h', n: '42' })]).wire.url, 'https://x.test/h/42');
});

test('A path parameter that is "." or ".." is warned about: the URL standard removes it from the path', () => {
  for (const value of ['..', '.', '%2e%2E', ' .. ']) {
    const built = build({ url: 'https://x.test/a/{id}/b', pathParams: [kv('id', value)] });
    assert.ok(built.warnings.some(warning => /path parameter id is/.test(warning) && /another path/.test(warning)), `${value}: ${built.warnings.join('|')}`);
  }
  for (const value of ['...', '.hidden', 'a.b', '']) {
    assert.deepEqual(build({ url: 'https://x.test/a/{id}/b', pathParams: [kv('id', value)] }).warnings, [], value);
  }
});

test('Variables without a value are reported and left as they are; so are cycles', () => {
  const built = build({ url: '{{host}}/{{path}}', headers: [kv('X-A', '{{a}}')] }, [scope({ a: '{{a}}', host: 'https://h.test' })]);
  assert.equal(built.wire.url, 'https://h.test/{{path}}');
  assert.deepEqual([built.unresolved, built.cycles], [['path'], ['a']]);
});

test('Headers come from the inheritance in order, with their variables replaced, and a body gets a content type only when the request has none', () => {
  const level: Level = { kind: 'collection', name: 'Shop', container: { ...newContainer('c', 'Shop'), headers: [kv('Accept', 'application/json'), kv('X-Team', '{{team}}')] } };
  const built = build({ method: 'post', headers: [kv('X-Id', '1'), kv('X-Id', '2')], body: { kind: 'json', text: '{"a":"{{team}}"}' } }, [scope({ team: 'pets' })], [level]);
  assert.deepEqual(built.wire.headers, [['Accept', 'application/json'], ['X-Team', 'pets'], ['X-Id', '1'], ['X-Id', '2'], ['Content-Type', 'application/json']]);
  assert.equal(built.wire.method, 'POST');
  assert.equal(bodyText(built), '{"a":"pets"}');
  const own = build({ headers: [kv('content-type', 'application/vnd.api+json')], body: { kind: 'json', text: '{}' } });
  assert.deepEqual(header(own, 'content-type'), ['application/vnd.api+json']);
});

test('Authentication: bearer, basic and API key as a header or a query parameter, with what was typed in hidden afterwards', () => {
  const bearer = build({ auth: { kind: 'bearer', token: '{{token}}', prefix: 'Bearer' } }, [scope({ token: 'abc12345' }, true)]);
  assert.deepEqual(header(bearer, 'authorization'), ['Bearer abc12345']);
  assert.deepEqual([bearer.secrets, bearer.redactions.includes('abc12345')], [['token'], true]);
  assert.deepEqual(header(build({ auth: { kind: 'bearer', token: 'tok-en-1', prefix: 'Token' } }), 'authorization'), ['Token tok-en-1']);
  assert.deepEqual(header(build({ auth: { kind: 'bearer', token: 'x', prefix: '' } }), 'authorization'), ['Bearer x']);
  assert.deepEqual(header(build({ auth: { kind: 'bearer', token: '', prefix: 'Bearer' } }), 'authorization'), [], 'no token, no header');
  const basic = build({ auth: { kind: 'basic', username: '{{user}}', password: 'p\u00e4ss word' } }, [scope({ user: 'aladdin' })]);
  assert.deepEqual(header(basic, 'authorization'), [`Basic ${basicCredential('aladdin', 'p\u00e4ss word')}`]);
  assert.ok(basic.redactions.includes(basicCredential('aladdin', 'p\u00e4ss word')) && basic.redactions.includes('p\u00e4ss word'));
  const inHeader = build({ auth: { kind: 'apikey', name: 'X-Api-Key', value: 'key-12345', in: 'header' } });
  assert.deepEqual(header(inHeader, 'x-api-key'), ['key-12345']);
  const inQuery = build({ url: 'http://x.test/p', auth: { kind: 'apikey', name: 'api key', value: 'k&v-99', in: 'query' }, query: [kv('a', '1')] });
  assert.equal(inQuery.wire.url, 'http://x.test/p?a=1&api%20key=k%26v-99');
  assert.deepEqual(inQuery.redactions, ['k&v-99']);
  assert.deepEqual(header(build({ auth: { kind: 'none' } }), 'authorization'), []);
});

test('An Authorization header the person wrote wins over the authentication, with a warning', () => {
  const built = build({ headers: [kv('authorization', 'Custom 1')], auth: { kind: 'bearer', token: 'tok-en-1', prefix: 'Bearer' } });
  assert.deepEqual(header(built, 'authorization'), ['Custom 1']);
  assert.match(built.warnings.join(' '), /own Authorization header/);
});

test('Authentication is inherited from the folders and OAuth 2.0 uses the token that was obtained', () => {
  const bearer: Auth = { kind: 'bearer', token: 'from-folder', prefix: 'Bearer' };
  const level: Level = { kind: 'folder', name: 'Orders', container: { ...newContainer('f', 'Orders'), auth: bearer } };
  assert.deepEqual(header(build({}, [], [level]), 'authorization'), ['Bearer from-folder']);
  const oauth: Auth = { kind: 'oauth2', grant: 'client_credentials', pkce: false, authUrl: '', tokenUrl: 'https://t.test', clientId: 'c', clientSecret: 's', scope: '', audience: '', username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [] };
  const without = build({ auth: oauth });
  assert.deepEqual(header(without, 'authorization'), []);
  assert.match(without.warnings.join(' '), /no access token has been obtained/);
  const withToken = build({ auth: oauth }, [], [], allowAll, { accessToken: 'access-1234', tokenType: 'Bearer' });
  assert.deepEqual([header(withToken, 'authorization'), withToken.redactions], [['Bearer access-1234'], ['access-1234']]);
  assert.deepEqual(header(build({ auth: oauth }, [], [], allowAll, { accessToken: 'a-b-c-d', tokenType: '' }), 'authorization'), ['Bearer a-b-c-d']);
});

test('Bodies: text, JSON, XML, form and GraphQL become bytes with the right content type', () => {
  const cases: [Body, string, string][] = [
    [{ kind: 'text', contentType: 'text/csv', text: 'a,{{v}}' }, 'a,1', 'text/csv'],
    [{ kind: 'text', contentType: '', text: 'plain' }, 'plain', 'text/plain'],
    [{ kind: 'json', text: '{"v":"{{v}}"}' }, '{"v":"1"}', 'application/json'],
    [{ kind: 'xml', text: '<a>{{v}}</a>' }, '<a>1</a>', 'application/xml'],
    [{ kind: 'form', fields: [kv('a b', 'c&d'), kv('e', "it's (ok)!"), kv('off', 'x', false), kv('u', '\u00e9')] }, 'a+b=c%26d&e=it%27s+%28ok%29%21&u=%C3%A9', 'application/x-www-form-urlencoded'],
    [{ kind: 'graphql', query: '{ pet(id: "{{v}}") { name } }', variables: '{"id": "{{v}}"}' }, '{"query":"{ pet(id: \\"1\\") { name } }","variables":{"id":"1"}}', 'application/json'],
    [{ kind: 'graphql', query: '{ a }', variables: '' }, '{"query":"{ a }"}', 'application/json']
  ];
  for (const [body, expected, type] of cases) {
    const built = build({ method: 'POST', body }, [scope({ v: '1' })]);
    assert.equal(bodyText(built), expected, JSON.stringify(body));
    assert.deepEqual(header(built, 'content-type'), [type]);
  }
  assert.equal(build({ body: { kind: 'none' } }).wire.body, undefined);
  const bad = build({ method: 'POST', body: { kind: 'graphql', query: '{ a }', variables: '{not json' } });
  assert.deepEqual(bad.problems, ['The GraphQL variables are not valid JSON.']);
});

test('The form encoding follows the standard: spaces are plus signs and the reserved characters are escaped', () => {
  assert.equal(formEncode("a b*-._~!'()"), 'a+b*-._%7E%21%27%28%29');
  assert.equal(formEncode(''), '');
});

test('Multipart: a boundary from the clock, text and file parts in order, the content type always matching, and files only through the allowed paths', () => {
  const body: Body = { kind: 'multipart', parts: [
    { name: 'caption', kind: 'text', value: 'Rex {{v}}', file: '', contentType: '', enabled: true },
    { name: 'off', kind: 'text', value: 'x', file: '', contentType: '', enabled: false },
    { name: 'photo', kind: 'file', value: '', file: 'files/rex.png', contentType: 'image/png', enabled: true },
    { name: '', kind: 'text', value: 'nameless', file: '', contentType: '', enabled: true }
  ] };
  const built = build({ method: 'POST', body, headers: [kv('Content-Type', 'multipart/form-data; boundary=wrong')] }, [scope({ v: '1' })]);
  assert.equal(built.wire.body?.kind, 'multipart');
  if (built.wire.body?.kind !== 'multipart') return;
  assert.match(built.wire.body.boundary, /^----api-client-[0-9a-f]{24}$/);
  assert.deepEqual(built.wire.body.parts, [{ name: 'caption', value: 'Rex 1' }, { name: 'photo', filePath: '/work/files/rex.png', filename: 'rex.png', contentType: 'image/png' }]);
  assert.deepEqual(header(built, 'content-type'), [`multipart/form-data; boundary=${built.wire.body.boundary}`], 'the boundary in the header is the one used');
  const blocked = build({ method: 'POST', body: { kind: 'multipart', parts: [{ name: 'f', kind: 'file', value: '', file: '../../etc/passwd', contentType: '', enabled: true }] } });
  assert.deepEqual(blocked.problems, ['The file ../../etc/passwd is not allowed or does not exist.']);
});

test('A binary body is a file through the allowed paths, and a path that is not allowed is a problem and no body', () => {
  const ok = build({ method: 'PUT', body: { kind: 'binary', file: 'data/{{name}}.bin' } }, [scope({ name: 'x' })]);
  assert.deepEqual([ok.wire.body, header(ok, 'content-type')], [{ kind: 'file', path: '/work/data/x.bin' }, ['application/octet-stream']]);
  const bad = build({ method: 'PUT', body: { kind: 'binary', file: '/etc/passwd' } });
  assert.deepEqual([bad.wire.body, bad.problems], [undefined, ['The file /etc/passwd is not allowed or does not exist.']]);
});

test('Every secret value that went in is listed for hiding, once, and a short one is left out', () => {
  const built = build({ url: 'http://x.test/{{a}}/{{b}}', headers: [kv('X', '{{a}} {{c}}')] }, [scope({ a: 'secret-a' }, true), scope({ b: 'plain' }), scope({ c: 'xy' }, true)]);
  assert.deepEqual(built.secrets, ['a', 'c']);
  assert.deepEqual(built.redactions, ['secret-a']);
});
