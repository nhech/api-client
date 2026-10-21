import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationUrl, base64Url, clientCredentialsRequest, codeRequest, endpointProblem, EXPIRY_SKEW_MS, isUsable, parseTokenResponse, passwordRequest, pkcePair, refreshRequest, type OAuthConfig } from '../../src/engine/oauth';

/** OAuth 2.0: the requests that are made, the address the person is sent to, and the reading of what the server answers. */

const config = (change: Partial<OAuthConfig> = {}): OAuthConfig => ({
  grant: 'client_credentials', pkce: true, authUrl: 'https://auth.test/authorize', tokenUrl: 'https://auth.test/token', clientId: 'my-client', clientSecret: 's3cret', scope: 'read write', audience: '',
  username: '', password: '', redirectUrl: '', clientAuth: 'header', extra: [], ...change
});
const body = (request: { body?: { kind: string; bytes?: Uint8Array } }): string => new TextDecoder().decode(request.body?.bytes);
const header = (request: { headers: [string, string][] }, name: string): string | undefined => request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

test('The code challenge of the RFC 7636 example is what the verifier gives, and a verifier is 43 characters of the alphabet that may be used', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const bytes = Buffer.from(verifier.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const pair = pkcePair(bytes);
  assert.deepEqual(pair, { verifier, challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' });
  const random = pkcePair(new Uint8Array(32).fill(255));
  assert.match(random.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(random.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(base64Url(new Uint8Array([251, 255, 254])), '-__-', 'the URL alphabet, without padding');
  assert.equal(base64Url(new Uint8Array([1])), 'AQ');
});

test('The address of the sign-in has the standard parameters, keeps the ones it had, and leaves out what is empty', () => {
  const url = new URL(authorizationUrl(config({ grant: 'authorization_code', authUrl: 'https://auth.test/authorize?prompt=login', audience: 'api://x', extra: [['login_hint', 'a b'], ['', 'nameless']] }), { redirectUri: 'http://127.0.0.1:8765/callback', state: 'st&te', challenge: 'CHALLENGE' }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://auth.test/authorize');
  assert.deepEqual([...url.searchParams], [
    ['prompt', 'login'], ['response_type', 'code'], ['client_id', 'my-client'], ['redirect_uri', 'http://127.0.0.1:8765/callback'], ['scope', 'read write'], ['state', 'st&te'], ['audience', 'api://x'],
    ['code_challenge', 'CHALLENGE'], ['code_challenge_method', 'S256'], ['login_hint', 'a b']
  ]);
  const plain = new URL(authorizationUrl(config({ scope: '', audience: '' }), { redirectUri: 'http://127.0.0.1:1/cb', state: 's' }));
  assert.deepEqual([...plain.searchParams.keys()], ['response_type', 'client_id', 'redirect_uri', 'state']);
  assert.throws(() => authorizationUrl(config({ authUrl: 'not an address' }), { redirectUri: 'x', state: 's' }));
});

test('Client credentials go in an Authorization header, form-encoded as the RFC says, or in the body', () => {
  const request = clientCredentialsRequest(config({ clientId: 'a b', clientSecret: 'p@ss:w/rd' }));
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://auth.test/token');
  assert.equal(header(request, 'content-type'), 'application/x-www-form-urlencoded');
  assert.equal(header(request, 'accept'), 'application/json');
  assert.equal(header(request, 'authorization'), `Basic ${Buffer.from('a+b:p%40ss%3Aw%2Frd').toString('base64')}`);
  assert.equal(body(request), 'grant_type=client_credentials&scope=read+write');
  const inBody = clientCredentialsRequest(config({ clientAuth: 'body', audience: 'api://x', extra: [['resource', 'r 1'], ['', 'nameless']] }));
  assert.equal(header(inBody, 'authorization'), undefined);
  assert.equal(body(inBody), 'grant_type=client_credentials&scope=read+write&audience=api%3A%2F%2Fx&resource=r+1&client_id=my-client&client_secret=s3cret');
  const noSecret = clientCredentialsRequest(config({ clientAuth: 'body', clientSecret: '', scope: '' }));
  assert.equal(body(noSecret), 'grant_type=client_credentials&client_id=my-client', 'a public client has no secret');
  const publicClient = clientCredentialsRequest(config({ clientSecret: '', scope: '' }));
  assert.equal(header(publicClient, 'authorization'), undefined, 'a client with no secret has nothing to authenticate with');
  assert.equal(body(publicClient), 'grant_type=client_credentials&client_id=my-client');
  const anonymous = clientCredentialsRequest(config({ clientId: '', clientSecret: '' }));
  assert.equal(header(anonymous, 'authorization'), undefined);
  assert.ok(!body(anonymous).includes('client_id'));
});

test('The password grant, a refresh and the exchange of a code say what they need and no more', () => {
  const password = passwordRequest(config({ grant: 'password', username: 'ann@x.test', password: 'pw 1' }));
  assert.equal(body(password), 'grant_type=password&username=ann%40x.test&password=pw+1&scope=read+write');
  const refresh = refreshRequest(config(), 'refresh-token-1');
  assert.equal(body(refresh), 'grant_type=refresh_token&refresh_token=refresh-token-1', 'a refresh does not ask for a scope again');
  const code = codeRequest(config({ grant: 'authorization_code' }), 'the-code', 'http://127.0.0.1:8765/callback', 'VERIFIER');
  assert.equal(body(code), 'grant_type=authorization_code&code=the-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&code_verifier=VERIFIER');
  assert.equal(body(codeRequest(config({ grant: 'authorization_code' }), 'c', 'http://127.0.0.1:1/cb')), 'grant_type=authorization_code&code=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb', 'no verifier without PKCE');
  for (const request of [password, refresh, code]) assert.equal(header(request, 'authorization')?.startsWith('Basic '), true);
});

test('A token is picked out of the answer field by field', () => {
  const ok = parseTokenResponse(200, JSON.stringify({ access_token: 'at-1', token_type: 'bearer', expires_in: 3600, refresh_token: 'rt-1', scope: 'read write', extra: 'ignored' }), 1_000_000);
  assert.deepEqual(ok, { ok: true, token: { accessToken: 'at-1', tokenType: 'Bearer', refreshToken: 'rt-1', expiresAt: 1_000_000 + 3_600_000, scope: 'read write' } });
  const minimal = parseTokenResponse(200, '{"access_token":"at-2"}', 5);
  assert.deepEqual(minimal, { ok: true, token: { accessToken: 'at-2', tokenType: 'Bearer' } });
  assert.deepEqual(parseTokenResponse(200, '{"access_token":"x","expires_in":"120"}', 0), { ok: true, token: { accessToken: 'x', tokenType: 'Bearer', expiresAt: 120_000 } }, 'a lifetime written as text');
  const forever = parseTokenResponse(200, '{"access_token":"x","expires_in":99999999999}', 0);
  assert.equal(forever.ok && forever.token.expiresAt, 365 * 24 * 3600 * 1000, 'a lifetime is bounded');
  for (const lifetime of [0, -5, 'soon', null]) assert.equal('expiresAt' in (parseTokenResponse(200, JSON.stringify({ access_token: 'x', expires_in: lifetime }), 0) as { token: object }).token, false, `no end for ${String(lifetime)}`);
  assert.equal((parseTokenResponse(200, '{"access_token":"x","token_type":"MAC"}', 0) as { token: { tokenType: string } }).token.tokenType, 'MAC');
  assert.equal((parseTokenResponse(200, '{"access_token":"x","token_type":"bad type!"}', 0) as { token: { tokenType: string } }).token.tokenType, 'Bearer', 'a token type that is not a word is Bearer');
  const kept = parseTokenResponse(200, '{"access_token":"new"}', 0, { accessToken: 'old', tokenType: 'Bearer', refreshToken: 'rt-keep' });
  assert.equal(kept.ok && kept.token.refreshToken, 'rt-keep', 'a refresh that gives no new refresh token keeps the old one');
  const replaced = parseTokenResponse(200, '{"access_token":"new","refresh_token":"rt-new"}', 0, { accessToken: 'old', tokenType: 'Bearer', refreshToken: 'rt-keep' });
  assert.equal(replaced.ok && replaced.token.refreshToken, 'rt-new');
});

test('A refusal is said with the error word and a short description, and nothing of the body that could hold a token', () => {
  const refused = parseTokenResponse(400, JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed', access_token: 'LEAK-1234' }), 0);
  assert.deepEqual(refused, { ok: false, error: 'The server refused the request: invalid_client (Client authentication failed).' });
  assert.ok(!JSON.stringify(refused).includes('LEAK-1234'));
  assert.deepEqual(parseTokenResponse(400, '{"error":"invalid_grant"}', 0), { ok: false, error: 'The server refused the request: invalid_grant.' });
  assert.deepEqual(parseTokenResponse(500, '{"message":"boom"}', 0), { ok: false, error: 'The server refused the request (status 500).' });
  assert.deepEqual(parseTokenResponse(200, '{"error":"slow_down","access_token":"x"}', 0), { ok: false, error: 'The server refused the request: slow_down.' }, 'an error beats a token');
  assert.deepEqual(parseTokenResponse(302, '{"access_token":"x"}', 0), { ok: false, error: 'The server refused the request (status 302).' });
  const hostile = parseTokenResponse(400, JSON.stringify({ error: `bad${String.fromCharCode(10)}error`, error_description: `line${String.fromCharCode(0)}break` }), 0);
  assert.deepEqual(hostile, { ok: false, error: 'The server refused the request: bad?error (line?break).' });
  const long = parseTokenResponse(400, JSON.stringify({ error: 'e', error_description: 'x'.repeat(500) }), 0);
  assert.deepEqual(long, { ok: false, error: 'The server refused the request: e.' }, 'a description that is too long is left out');
  assert.deepEqual(parseTokenResponse(200, '<html>login</html>', 0), { ok: false, error: 'The token endpoint did not answer with JSON (status 200).' });
  assert.deepEqual(parseTokenResponse(200, '[1,2]', 0), { ok: false, error: 'The token endpoint did not answer with an object (status 200).' });
  assert.deepEqual(parseTokenResponse(200, 'null', 0), { ok: false, error: 'The token endpoint did not answer with an object (status 200).' });
  assert.deepEqual(parseTokenResponse(200, '{"token_type":"Bearer"}', 0), { ok: false, error: 'The answer of the server has no access token.' });
  assert.deepEqual(parseTokenResponse(200, '{"access_token":""}', 0), { ok: false, error: 'The answer of the server has no access token.' });
  assert.deepEqual(parseTokenResponse(200, `{"access_token":"${'x'.repeat(20_000)}"}`, 0), { ok: false, error: 'The answer of the server has no access token.' }, 'a token that is far too long is not one');
  assert.deepEqual(parseTokenResponse(200, '{"__proto__":{"access_token":"inherited"}}', 0), { ok: false, error: 'The answer of the server has no access token.' }, 'nothing is read from the prototype');
});

test('A token can be sent until just before it runs out, and one with no end can always be sent', () => {
  const token = { accessToken: 'a', tokenType: 'Bearer', expiresAt: 1_000_000 };
  assert.equal(isUsable(token, 1_000_000 - EXPIRY_SKEW_MS - 1), true);
  assert.equal(isUsable(token, 1_000_000 - EXPIRY_SKEW_MS), false);
  assert.equal(isUsable(token, 2_000_000), false);
  assert.equal(isUsable({ accessToken: 'a', tokenType: 'Bearer' }, Number.MAX_SAFE_INTEGER), true);
});

test('Credentials are sent only over https, or to this computer', () => {
  assert.equal(endpointProblem('https://auth.test/token', 'The token URL'), undefined);
  assert.equal(endpointProblem('http://localhost:9000/token', 'The token URL'), undefined);
  assert.equal(endpointProblem('http://127.0.0.1:9000/token', 'The token URL'), undefined);
  assert.equal(endpointProblem('http://[::1]:9000/token', 'The token URL'), undefined);
  assert.equal(endpointProblem('http://auth.localhost/token', 'The token URL'), undefined);
  for (const bad of ['http://auth.test/token', 'ftp://auth.test/token', 'auth.test/token', '', 'http://localhost.evil.test/token', 'http://127.0.0.1.evil.test/']) {
    assert.match(endpointProblem(bad, 'The token URL') ?? '', /The token URL/, bad);
  }
  assert.match(endpointProblem('nonsense', 'The authorization URL') ?? '', /is not a whole address/);
  assert.match(endpointProblem('http://auth.test/', 'The authorization URL') ?? '', /has to start with https/);
});
