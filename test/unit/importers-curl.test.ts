import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURL_LIMITS, looksLikeCurl, parseCurl, splitCommand } from '../../src/importers/curl';

/** A cURL command becomes a request: it is split as a shell would, then read by what its options mean. */

const words = (text: string): string[] => {
  const result = splitCommand(text);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.words;
};
const request = (text: string) => {
  const result = parseCurl(text);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result;
};
const pairs = (list: readonly { name: string; value: string; enabled: boolean }[]): [string, string][] => list.map(item => [item.name, item.value]);

test('A command is split into words as a shell does', () => {
  assert.deepEqual(words('curl -X POST https://x.test/a'), ['curl', '-X', 'POST', 'https://x.test/a']);
  assert.deepEqual(words("curl 'a b' \"c d\" e\\ f"), ['curl', 'a b', 'c d', 'e f'], 'quotes and an escaped space');
  assert.deepEqual(words("curl -H 'X-A: it'\"'\"'s'"), ['curl', '-H', "X-A: it's"], 'a quote closed and opened again');
  assert.deepEqual(words('curl "say \\"hi\\" \\\\ \\$HOME \\n"'), ['curl', 'say "hi" \\ $HOME \\n'], 'in double quotes only four characters are escaped');
  assert.deepEqual(words("curl $'tab\\there\\nline \\x41 \\u00e9 \\'q\\''"), ['curl', "tab\there\nline A \u00e9 'q'"], 'ANSI-C quoting');
  assert.deepEqual(words('curl a \\\n  b \\\n  c'), ['curl', 'a', 'b', 'c'], 'bash line continuations');
  assert.deepEqual(words('curl a `\n b'), ['curl', 'a', 'b'], 'PowerShell line continuations');
  assert.deepEqual(words('curl a\r\n  b'), ['curl', 'a', 'b'], 'Windows line ends');
  assert.deepEqual(words("curl 'a\\\nb'"), ['curl', 'a\\\nb'], 'a continuation inside single quotes is kept as it is');
  assert.deepEqual(words('curl "a\\\nb"'), ['curl', 'ab'], 'and inside double quotes it joins');
  assert.deepEqual(words('curl https://x.test | jq .'), ['curl', 'https://x.test'], 'the command ends at a pipe');
  assert.deepEqual(words('curl https://x.test > out.json'), ['curl', 'https://x.test'], 'or a redirection');
  assert.deepEqual(words('curl a ; echo b'), ['curl', 'a'], 'or a semicolon');
  assert.deepEqual(words('curl a && curl b'), ['curl', 'a'], 'or &&');
  assert.deepEqual(words('curl "https://x.test/?a=1&b=2"'), ['curl', 'https://x.test/?a=1&b=2'], 'a & inside quotes is a character');
  assert.deepEqual(words("curl ''"), ['curl', ''], 'an empty word is a word');
});

test('The form that cmd.exe copies, with a caret before each special character, is read too', () => {
  const cmd = 'curl ^"https://x.test/a^" ^\n  -H ^"accept: */*^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"';
  assert.deepEqual(words(cmd), ['curl', 'https://x.test/a', '-H', 'accept: */*', '--data-raw', '{"a":1}']);
});

test('A quote that is not closed is an error', () => {
  for (const text of ["curl 'abc", 'curl "abc', "curl $'abc"]) {
    const result = splitCommand(text);
    assert.equal(result.ok, false, text);
    assert.match(result.ok ? '' : result.error, /not closed/);
  }
});

test('A command with too many words is refused', () => {
  const result = splitCommand(`curl ${Array.from({ length: CURL_LIMITS.words + 5 }, () => 'a').join(' ')}`);
  assert.equal(result.ok, false);
  assert.equal(parseCurl('c'.repeat(CURL_LIMITS.textChars + 1)).ok, false);
});

test('Text that starts with curl is offered as a command, other text is not', () => {
  for (const text of ['curl https://x.test', '  curl -X POST x', '$ curl x', '> curl x', 'curl.exe x', 'CURL x', 'curl']) assert.equal(looksLikeCurl(text), true, text);
  for (const text of ['', 'curly x', 'echo curl x', 'https://x.test', 'curl-x', 'currency']) assert.equal(looksLikeCurl(text), false, text);
});

test('A plain GET', () => {
  const { request: r, notes } = request('curl https://api.example.com/users?page=2&q=a%20b');
  assert.equal(r.method, 'GET');
  assert.equal(r.url, 'https://api.example.com/users');
  assert.deepEqual(pairs(r.query), [['page', '2'], ['q', 'a b']], 'the query is split into rows and decoded');
  assert.equal(r.name, 'GET /users');
  assert.deepEqual(r.body, { kind: 'none' });
  assert.deepEqual(r.auth, { kind: 'inherit' });
  assert.deepEqual(notes, []);
});

test('The address gets a scheme when it has none, and a variable is left alone', () => {
  assert.equal(request('curl example.com/a').request.url, 'http://example.com/a');
  assert.equal(request('curl localhost:3000').request.url, 'http://localhost:3000');
  assert.equal(request('curl {{base}}/a').request.url, '{{base}}/a');
  assert.equal(request('curl --url https://x.test/a').request.url, 'https://x.test/a');
  assert.equal(request('curl -XGET https://x.test/').request.name, 'GET x.test');
  const several = request('curl https://a.test https://b.test');
  assert.equal(several.request.url, 'https://a.test');
  assert.match(several.notes.join(' '), /first one is used and 1 more was left out/);
  assert.equal(parseCurl('curl -s').ok, false);
  assert.equal(parseCurl('echo hi').ok, false);
  assert.match((parseCurl('echo hi') as { error: string }).error, /does not start with curl/);
});

test('The method comes from -X, or from what the command has', () => {
  assert.equal(request('curl -X DELETE https://x.test/a').request.method, 'DELETE');
  assert.equal(request('curl -XPATCH https://x.test/a').request.method, 'PATCH');
  assert.equal(request('curl --request put https://x.test/a').request.method, 'PUT');
  assert.equal(request('curl -I https://x.test/a').request.method, 'HEAD');
  assert.equal(request('curl --head https://x.test/a').request.method, 'HEAD');
  assert.equal(request('curl -d a=1 https://x.test/a').request.method, 'POST');
  assert.equal(request('curl -F a=1 https://x.test/a').request.method, 'POST');
  assert.equal(request('curl -T file.bin https://x.test/a').request.method, 'PUT');
  assert.equal(request('curl -X GET -d a=1 https://x.test/a').request.method, 'GET', '-X wins');
});

test('Headers, the user agent, the referer and the cookies', () => {
  const { request: r, notes } = request("curl https://x.test -H 'Accept: application/json' -H 'X-Empty;' -A 'Agent/1' -e https://ref.test -b 'a=1; b=2' --header 'X-Spaced:   v  '");
  assert.deepEqual(pairs(r.headers), [['Accept', 'application/json'], ['X-Empty', ''], ['User-Agent', 'Agent/1'], ['Referer', 'https://ref.test'], ['Cookie', 'a=1; b=2'], ['X-Spaced', 'v']]);
  assert.deepEqual(notes, []);
  const removal = request("curl https://x.test -H 'Accept:'");
  assert.deepEqual(removal.request.headers, [], 'a header with no value removes cURL\'s own, which the client does not add');
  assert.match(removal.notes.join(' '), /Accept is given with no value/);
  assert.match(request('curl https://x.test -b cookies.txt').notes.join(' '), /cookie file is not read/);
  assert.deepEqual(request("curl https://x.test -H 'no colon here'").request.headers, [], 'a line that is not a header is left out');
});

test('A JSON body, with and without the header that says so', () => {
  const typed = request(`curl -X POST https://x.test/a -H 'Content-Type: application/json' -d '{"a":1}'`);
  assert.deepEqual(typed.request.body, { kind: 'json', text: '{"a":1}' });
  assert.deepEqual(pairs(typed.request.headers), [['Content-Type', 'application/json']], 'the header stays as it was typed');
  const untyped = request(`curl https://x.test/a -d '{"a":1}'`);
  assert.deepEqual(untyped.request.body, { kind: 'json', text: '{"a":1}' });
  assert.match(untyped.notes.join(' '), /would send this body as a form/);
  const json = request(`curl https://x.test/a --json '{"a":1}'`);
  assert.equal(json.request.method, 'POST');
  assert.deepEqual(json.request.body, { kind: 'json', text: '{"a":1}' });
  assert.deepEqual(pairs(json.request.headers), [['Content-Type', 'application/json'], ['Accept', 'application/json']]);
  assert.deepEqual(request(`curl https://x.test/a --json '{"a":1}' -H 'accept: text/plain'`).request.headers.map(header => header.name.toLowerCase()), ['accept', 'content-type'], '--json does not add an Accept that is there');
  assert.deepEqual(request(`curl https://x.test/a --data-raw '{"a":"@x"}' -H 'Content-Type: application/json'`).request.body, { kind: 'json', text: '{"a":"@x"}' }, '--data-raw does not read a file');
});

test('A form body, in pieces or all at once', () => {
  assert.deepEqual(request("curl https://x.test/a -d 'a=1&b=two%20words'").request.body, { kind: 'form', fields: [{ name: 'a', value: '1', enabled: true, description: '' }, { name: 'b', value: 'two words', enabled: true, description: '' }] });
  assert.deepEqual(request('curl https://x.test/a -d a=1 -d b=2').request.body, { kind: 'form', fields: [{ name: 'a', value: '1', enabled: true, description: '' }, { name: 'b', value: '2', enabled: true, description: '' }] }, 'pieces are joined with &');
  const encoded = request("curl https://x.test/a --data-urlencode 'q=a b&c' --data-urlencode 'plain text'");
  assert.deepEqual(encoded.request.body, { kind: 'form', fields: [{ name: 'q', value: 'a b&c', enabled: true, description: '' }, { name: 'plain text', value: '', enabled: true, description: '' }] }, 'the value is encoded, and the row holds it as it is');
  const text = request("curl https://x.test/a -H 'Content-Type: text/plain' -d 'hello world'");
  assert.deepEqual(text.request.body, { kind: 'text', contentType: 'text/plain', text: 'hello world' });
  assert.deepEqual(request("curl https://x.test/a -d 'hello world'").request.body, { kind: 'text', contentType: 'application/x-www-form-urlencoded', text: 'hello world' }, 'what is not pairs stays text');
  assert.deepEqual(request("curl https://x.test/a -H 'content-type: application/xml' -d '<a/>'").request.body, { kind: 'xml', text: '<a/>' });
});

test('-G puts the data in the query', () => {
  const { request: r } = request("curl -G https://x.test/search -d 'q=cats' --data-urlencode 'tag=a b'");
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.body, { kind: 'none' });
  assert.deepEqual(pairs(r.query), [['q', 'cats'], ['tag', 'a b']]);
});

test('A multipart form, with files and types', () => {
  const { request: r, notes } = request("curl https://x.test/up -H 'Content-Type: multipart/form-data' -F 'a=1' -F 'doc=@report.pdf;type=application/pdf' -F 'n=@;x' --form-string 'raw=@not-a-file' -F 'big=<big.txt'");
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, [], 'the type with no boundary is dropped: the boundary is made when the request is sent');
  assert.deepEqual(r.body, { kind: 'multipart', parts: [
    { name: 'a', kind: 'text', value: '1', file: '', contentType: '', enabled: true },
    { name: 'doc', kind: 'file', value: '', file: 'report.pdf', contentType: 'application/pdf', enabled: true },
    { name: 'n', kind: 'file', value: '', file: '', contentType: '', enabled: true },
    { name: 'raw', kind: 'text', value: '@not-a-file', file: '', contentType: '', enabled: true },
    { name: 'big', kind: 'text', value: '', file: '', contentType: '', enabled: true }
  ] });
  assert.match(notes.join(' '), /file report\.pdf of the form field doc is read from the folder of the collection/);
  assert.match(notes.join(' '), /field big takes its value from a file/);
  assert.equal(parseCurl("curl https://x.test -F '=x'").ok && request("curl https://x.test -F '=x'").notes.join(' ').includes('without a name'), true);
});

test('A body from a file is a file of the collection', () => {
  const { request: r, notes } = request('curl https://x.test/a --data-binary @payload.json -H "Content-Type: application/json"');
  assert.deepEqual(r.body, { kind: 'binary', file: 'payload.json' });
  assert.match(notes.join(' '), /read from the file payload\.json/);
  assert.deepEqual(request('curl -T up.bin https://x.test/a').request.body, { kind: 'binary', file: 'up.bin' });
});

test('Authentication: basic, bearer, and what is not supported', () => {
  assert.deepEqual(request('curl -u ann:s3cr3t:with:colons https://x.test').request.auth, { kind: 'basic', username: 'ann', password: 's3cr3t:with:colons' });
  const noPassword = request('curl -u ann https://x.test');
  assert.deepEqual(noPassword.request.auth, { kind: 'basic', username: 'ann', password: '' });
  assert.match(noPassword.notes.join(' '), /no password/);
  assert.deepEqual(request('curl --oauth2-bearer tok123 https://x.test').request.auth, { kind: 'bearer', token: 'tok123', prefix: 'Bearer' });
  const digest = request('curl --digest -u ann:pw https://x.test');
  assert.match(digest.notes.join(' '), /digest authentication, which is not supported yet/);
});

test('Settings: a certificate that is not checked, a time limit, the version of HTTP', () => {
  const { request: r, notes } = request('curl -k --max-time 2.5 --http2 https://x.test');
  assert.deepEqual(r.settings, { rejectUnauthorized: false, timeoutMs: 2500, httpVersion: '2' });
  assert.match(notes.join(' '), /certificate of the server is not checked/);
  assert.deepEqual(request('curl --insecure --http1.1 https://x.test').request.settings, { rejectUnauthorized: false, httpVersion: '1.1' });
  assert.deepEqual(request('curl -m 0 https://x.test').request.settings, {}, 'a limit that is not a positive number is not one');
  assert.deepEqual(request('curl -m abc https://x.test').request.settings, {});
});

test('What cURL does with the answer, and flags that change nothing, do not get in the way', () => {
  const quiet = request('curl -sSLk --compressed -v -i -f https://x.test/a');
  assert.equal(quiet.request.url, 'https://x.test/a');
  assert.deepEqual(quiet.notes.length, 1, 'only -k is worth a word');
  const loud = request('curl -o out.json --proxy http://p.test:8080 --retry 3 --unknown-flag https://x.test/a');
  assert.equal(loud.request.url, 'https://x.test/a', 'the values of options that take one are not taken for the address');
  assert.match(loud.notes.join('\n'), /--output has no place/);
  assert.match(loud.notes.join('\n'), /--proxy has no place/);
  assert.match(loud.notes.join('\n'), /--retry has no place/);
  assert.match(loud.notes.join('\n'), /--unknown-flag has no place/);
  assert.equal(request('curl https://x.test/a -x p -x q').notes.filter(note => /--proxy has no place/.test(note)).length, 1, 'each option is named once');
  assert.equal(request('curl -- https://x.test/-a').request.url, 'https://x.test/-a', 'after -- everything is an address');
});

test('A command pasted from a browser', () => {
  const chrome = `curl 'https://api.example.com/v1/items?limit=10' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'authorization: Bearer abc.def.ghi' \\
  -H 'content-type: application/json' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64)' \\
  --data-raw '{"name":"it'"'"'s","tags":["a","b"]}' \\
  --compressed`;
  const { request: r } = request(chrome);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/v1/items');
  assert.deepEqual(pairs(r.query), [['limit', '10']]);
  assert.equal(r.headers.length, 4);
  assert.deepEqual(r.body, { kind: 'json', text: '{"name":"it\'s","tags":["a","b"]}' });
});

test('The name of the request is made of what is safe to show', () => {
  assert.equal(request('curl https://x.test/').request.name, 'GET x.test');
  assert.equal(request('curl https://x.test').request.name, 'GET x.test');
  assert.equal(request(`curl https://x.test/${'p'.repeat(300)}`).request.name.length, 100);
  assert.equal(request('curl "https://x.test/a\u202eb"').request.name, 'GET /a?b');
});

test('--data-raw never reads a file, and -d with an @ does', () => {
  const raw = request("curl https://x.test/a --data-raw '@literal'");
  assert.notEqual(raw.request.body.kind, 'binary');
  assert.deepEqual(raw.notes, []);
  const file = request("curl https://x.test/a -d '@payload.txt'");
  assert.deepEqual(file.request.body, { kind: 'binary', file: 'payload.txt' });
});

test('A file that leads out of the folder of the collection is kept by its name only, with a note', () => {
  const form = request("curl https://x.test/up -F 'a=@/etc/passwd' -F 'b=@C:\\Users\\me\\key.pem;type=text/plain' -F 'c=@../../secret.txt' -F 'd=@~/id_rsa' -F 'e=@docs/ok.txt'");
  assert.deepEqual(form.request.body.kind === 'multipart' ? form.request.body.parts.map(part => part.file) : [], ['passwd', 'key.pem', 'secret.txt', 'id_rsa', 'docs/ok.txt'], 'a path inside the folder is left as it is');
  assert.equal(form.notes.filter(note => /leads out of the folder of the collection/.test(note)).length, 4);
  assert.match(form.notes.join('\n'), /The path \/etc\/passwd leads out of the folder of the collection: only the name of the file, passwd, was kept/);
  assert.deepEqual(request('curl -T /home/me/up.bin https://x.test/a').request.body, { kind: 'binary', file: 'up.bin' });
  assert.deepEqual(request('curl --data-binary @../x/payload.json https://x.test/a').request.body, { kind: 'binary', file: 'payload.json' });
  assert.equal(request("curl --data-urlencode 'v@/etc/hosts' https://x.test/a").request.body.kind, 'none', 'a value read from a file is not read, and is no body');
});
