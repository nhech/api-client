import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponseView, describeBody, describeSent, formatDuration, formatJson, formatSize, formatXml, hexDump, mediaTypeOf, VIEW_TEXT_LIMIT, type ResponseViewInput } from '../../src/view/response';
import type { WireRequest, WireResponse } from '../../src/engine/types';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const body = (text: string, contentType: string, warnings: string[] = []) => describeBody(bytes(text), bytes(text).length, contentType, warnings);

test('JSON is laid out with every string and number exactly as written', () => {
  assert.equal(formatJson('{"a":1,"b":[true,false,null],"c":{"d":"x"},"e":[],"f":{}}'), '{\n  "a": 1,\n  "b": [\n    true,\n    false,\n    null\n  ],\n  "c": {\n    "d": "x"\n  },\n  "e": [],\n  "f": {}\n}');
  assert.equal(formatJson(' \n [1E+2, -0, 1.0, 12345678901234567890, 0.1e-7] '), '[\n  1E+2,\n  -0,\n  1.0,\n  12345678901234567890,\n  0.1e-7\n]', 'numbers are not rounded or rewritten');
  assert.equal(formatJson('["a\\u00e9\\n\\"\\/", "\u00e9"]'), '[\n  "a\\u00e9\\n\\"\\/",\n  "\u00e9"\n]', 'escapes stay escapes');
  assert.equal(formatJson('"just a string"'), '"just a string"');
  assert.equal(formatJson('42'), '42');
  assert.equal(formatJson('{"a":1}', '\t'), '{\n\t"a": 1\n}');
  assert.equal(formatJson('{"__proto__":1,"constructor":{"x":[]}}'), '{\n  "__proto__": 1,\n  "constructor": {\n    "x": []\n  }\n}', 'keys are text, not properties');
});

test('Text that is not strict JSON is not formatted', () => {
  for (const bad of ['', '   ', '{"a":1,}', '[1,]', "{'a':1}", '01', '1.', '.5', '+1', '"\\x"', '"a\nb"', '[1 2]', '{"a" 1}', '{"a":1}}', '{"a":1} x', 'nul', 'NaN', 'Infinity', '[1,2', '{"a"', '{"a":', '{1:2}',
    '// c\n{}', '{"a":1 /* c */}', '"\\u12G4"', '[', ']', '{', '"unterminated', '-', '1e', '--1', 'true false', '{"a":1,"b"}', '{,}', '[,]', '{"a":}']) {
    assert.equal(formatJson(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(formatJson('['.repeat(257) + ']'.repeat(257)), undefined, 'nesting is limited');
  assert.notEqual(formatJson('['.repeat(256) + ']'.repeat(256)), undefined);
});

test('Property: formatting JSON never changes what it means, and formatting twice is the same as once', () => {
  let seed = 12345;
  const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const value = (depth: number): unknown => {
    const pick = Math.floor(random() * (depth > 3 ? 5 : 7));
    switch (pick) {
      case 0: return null;
      case 1: return random() < 0.5;
      case 2: return Math.round((random() - 0.5) * 1e6) / 100;
      case 3: return String.fromCharCode(...Array.from({ length: Math.floor(random() * 6) }, () => 32 + Math.floor(random() * 200))) + (random() < 0.3 ? '"\\\n\t' : '');
      case 4: return Math.floor(random() * 1e9);
      case 5: return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      default: return Object.fromEntries(Array.from({ length: Math.floor(random() * 4) }, (_, index) => [`k${index}${random() < 0.2 ? '"' : ''}`, value(depth + 1)]));
    }
  };
  for (let round = 0; round < 300; round++) {
    const original = JSON.stringify(value(0), null, random() < 0.5 ? 0 : 3);
    const formatted = formatJson(original);
    assert.ok(formatted !== undefined, original);
    assert.deepEqual(JSON.parse(formatted), JSON.parse(original), original);
    assert.equal(formatJson(formatted), formatted);
  }
});

test('XML is laid out one element to a line, short text stays with its element, and tags that do not match are refused', () => {
  assert.equal(formatXml('<?xml version="1.0"?><a x="1"><b>text</b><c/><d></d><e><f>1</f></e><!-- note --></a>'),
    '<?xml version="1.0"?>\n<a x="1">\n  <b>text</b>\n  <c/>\n  <d></d>\n  <e>\n    <f>1</f>\n  </e>\n  <!-- note -->\n</a>');
  assert.equal(formatXml('<a>\n   <b>  spaced  </b>\n</a>'), '<a>\n  <b>spaced</b>\n</a>');
  assert.equal(formatXml('<a href="x>y">1</a>'), '<a href="x>y">1</a>', 'a > inside an attribute value does not end the tag');
  assert.equal(formatXml('<a><![CDATA[ <b> ]]></a>'), '<a>\n  <![CDATA[ <b> ]]>\n</a>');
  assert.equal(formatXml('<a>mixed<b/>content</a>'), '<a>\n  mixed\n  <b/>\n  content\n</a>');
  for (const bad of ['<a>', '<a></b>', '</a>', '<a><b></a></b>', '<a> < </a>', '<a', '<1/>']) assert.equal(formatXml(bad), undefined, bad);
});

test('A hex dump shows offsets, bytes and text, sixteen to a line', () => {
  const dump = hexDump(Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0xff, 0x0a, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49]));
  assert.equal(dump, '00000000  48 65 6c 6c 6f 00 ff 0a  41 42 43 44 45 46 47 48  |Hello...ABCDEFGH|\n00000010  49                                                |I|');
  assert.equal(hexDump(new Uint8Array(1000)).split('\n').length, 32, 'only the first 512 bytes');
  assert.equal(hexDump(new Uint8Array(0)), '');
});

test('Sizes and durations are short to read', () => {
  assert.deepEqual([0, 1, 1023, 1024, 1536, 10 * 1024, 150 * 1024, 1024 * 1024, 5.5 * 1024 * 1024, 3 * 1024 ** 3].map(formatSize), ['0 B', '1 B', '1023 B', '1 KB', '1.5 KB', '10 KB', '150 KB', '1 MB', '5.5 MB', '3 GB']);
  assert.equal(formatSize(150.5 * 1024), '151 KB', 'from 100 up there is no decimal');
  assert.equal(formatSize(99.5 * 1024), '99.5 KB');
  assert.deepEqual([0, 0.4, 12, 999, 1000, 1234, 15000].map(formatDuration), ['0 ms', '0 ms', '12 ms', '999 ms', '1 s', '1.2 s', '15 s']);
});

test('The media type and the character set come from the content type, in any case and with quotes', () => {
  assert.deepEqual(mediaTypeOf('Application/JSON; Charset="UTF-8"'), { mediaType: 'application/json', charset: 'utf-8' });
  assert.deepEqual(mediaTypeOf('text/html;charset=iso-8859-1;boundary=x'), { mediaType: 'text/html', charset: 'iso-8859-1' });
  assert.deepEqual(mediaTypeOf(''), { mediaType: '', charset: '' });
  assert.deepEqual(mediaTypeOf('text/plain; foo=charset=x'), { mediaType: 'text/plain', charset: '' });
});

test('A JSON body is shown formatted and as it came; one that is not valid is shown as it came', () => {
  const view = body('{"a":1,"b":[1,2]}', 'application/json; charset=utf-8');
  assert.deepEqual([view.kind, view.language, view.charset, view.cut, view.size], ['text', 'json', 'utf-8', false, 17]);
  assert.equal(view.raw, '{"a":1,"b":[1,2]}');
  assert.equal(view.pretty, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  const broken = body('{"a":1,', 'application/json');
  assert.deepEqual([broken.language, broken.pretty, broken.raw], ['json', undefined, '{"a":1,']);
  assert.equal(body('{\n  "a": 1\n}', 'application/json').pretty, undefined, 'already formatted: nothing to switch to');
  assert.equal(body('{"a":1}', 'application/problem+json').language, 'json');
  assert.equal(body('<a><b>1</b></a>', 'application/atom+xml').pretty, '<a>\n  <b>1</b>\n</a>');
  assert.deepEqual([body('<p>hi</p>', 'text/html').language, body('x', 'text/plain').language, body('x', 'application/javascript').language], ['html', 'text', 'javascript']);
});

test('A response that does not say what it is is looked at: JSON, HTML, XML or plain text', () => {
  assert.equal(body('  {"a":1}', '').language, 'json');
  assert.equal(body('{not json', '').language, 'text');
  assert.equal(body('<!DOCTYPE html><html></html>', '').language, 'html');
  assert.equal(body('<html lang="en">', 'application/octet-stream').language, 'html');
  assert.equal(body('<?xml version="1.0"?><a/>', '').language, 'xml');
  assert.equal(body('<feed/>', '').language, 'xml');
  assert.equal(body('hello', 'application/octet-stream').kind, 'text', 'bytes that are text are shown as text, whatever the type says');
});

test('The character set the response names is used; one that is not known is said so and the text is read as UTF-8', () => {
  assert.equal(describeBody(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 4, 'text/plain; charset=iso-8859-1', []).raw, 'caf\u00e9');
  assert.equal(describeBody(Uint8Array.from([0x63, 0x61, 0x66, 0xc3, 0xa9]), 5, 'text/plain', []).raw, 'caf\u00e9');
  assert.equal(describeBody(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), 5, 'text/plain', []).raw, 'hi', 'a byte order mark is not text');
  const utf16 = describeBody(Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), 6, 'text/plain', []);
  assert.deepEqual([utf16.kind, utf16.raw, utf16.charset], ['text', 'hi', 'utf-16le'], 'UTF-16 with a mark is text although it has zero bytes');
  const warnings: string[] = [];
  const unknown = describeBody(bytes('plain'), 5, 'text/plain; charset=klingon', warnings);
  assert.deepEqual([unknown.raw, unknown.charset], ['plain', 'utf-8']);
  assert.match(warnings[0] ?? '', /"klingon".*shown as UTF-8/);
});

test('A body that is not text is a picture, or a hex dump; the type of a picture comes from a fixed list, not from the response', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const picture = describeBody(png, png.length, 'image/png', []);
  assert.deepEqual([picture.kind, picture.image?.startsWith('data:image/png;base64,iVBORw0KGgo')], ['image', true]);
  assert.equal(describeBody(png, png.length, 'image/jpg', []).image?.slice(0, 22), 'data:image/jpeg;base64');
  const svg = describeBody(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 41, 'image/svg+xml', []);
  assert.deepEqual([svg.kind, svg.language], ['text', 'xml'], 'an SVG is read as text, never drawn');
  const evil = describeBody(png, png.length, 'image/png;base64,AAAA"><script>', []);
  assert.match(evil.image ?? '', /^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'whatever follows the type in the header never gets into the address');
  const partial = describeBody(png, png.length + 10, 'image/png', []);
  assert.deepEqual([partial.kind, partial.image], ['binary', undefined], 'half of a picture is not a picture');
  const binary = describeBody(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1]), 8, 'application/zip', []);
  assert.deepEqual([binary.kind, binary.raw, binary.hex?.slice(0, 21)], ['binary', '', '00000000  50 4b 03 04']);
  assert.equal(describeBody(Uint8Array.from([0x41, 0, 0x42]), 3, '', []).kind, 'binary', 'a zero byte makes it binary');
  assert.equal(describeBody(bytes('%PDF-1.7 hello'), 14, 'application/pdf', []).kind, 'binary', 'a PDF is never text');
  assert.equal(describeBody(new Uint8Array(0), 0, 'application/json', []).kind, 'empty');
});

test('A body that is cut for the view is not formatted, and is never cut in the middle of a character', () => {
  const partial = describeBody(bytes('{"a":1}'), 100, 'application/json', []);
  assert.deepEqual([partial.cut, partial.pretty, partial.size], [true, undefined, 100], 'only the beginning of the body was read');
  const long = `${'a'.repeat(VIEW_TEXT_LIMIT - 1)}\ud83d\ude00tail`;
  const cut = describeBody(bytes(long), bytes(long).length, 'text/plain', []);
  assert.equal(cut.cut, true);
  assert.equal(cut.raw.length, VIEW_TEXT_LIMIT - 1, 'the first half of the pair is dropped with the second');
  const fits = describeBody(bytes('a'.repeat(VIEW_TEXT_LIMIT)), VIEW_TEXT_LIMIT, 'text/plain', []);
  assert.deepEqual([fits.cut, fits.raw.length], [false, VIEW_TEXT_LIMIT]);
});

const wire = (over: Partial<WireRequest> = {}): WireRequest => ({ method: 'POST', url: 'https://api.test/v1/items?token=sekret-value-1', headers: [['Authorization', 'Bearer sekret-value-1'], ['X-Trace', 'abc'], ['Cookie', 'sid=1234567'], ['Content-Type', 'application/json']], ...over });

test('The request is shown as it went out with credentials and secret values hidden', () => {
  const sent = describeSent(wire({ body: { kind: 'bytes', bytes: bytes('{"password":"sekret-value-1","name":"x"}') } }), ['sekret-value-1']);
  assert.equal(sent.url, 'https://api.test/v1/items?token=[redacted]');
  assert.deepEqual(sent.headers, [['Authorization', '[redacted]'], ['X-Trace', 'abc'], ['Cookie', '[redacted]'], ['Content-Type', 'application/json']]);
  assert.equal(sent.body, '{"password":"[redacted]","name":"x"}');
  assert.equal(sent.method, 'POST');
});

test('Bodies that are not text are described, and a file shows its name and nothing of where it is', () => {
  assert.equal(describeSent(wire({ body: { kind: 'bytes', bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0x80]) } }), []).body, '(binary data, 4 B)');
  const file = describeSent(wire({ body: { kind: 'file', path: 'C:\\Users\\someone\\project\\api\\data.bin' } }), []).body;
  assert.equal(file, '(the file data.bin is sent as it is)');
  const posix = describeSent(wire({ body: { kind: 'file', path: '/home/someone/data.bin' } }), []).body;
  assert.ok(!posix.includes('someone'));
  const multipart = describeSent(wire({ body: { kind: 'multipart', boundary: 'b', parts: [{ name: 'a', value: 'one' }, { name: 'token', value: 'abcdefgh' }, { name: 'doc', filePath: '/x/y/report.pdf', filename: 'report.pdf' }] } }), []);
  assert.equal(multipart.body, 'a: one\ntoken: [redacted]\ndoc: (file report.pdf)', 'the value of a part is hidden when its name is secret');
  const big = describeSent(wire({ body: { kind: 'bytes', bytes: bytes('x'.repeat(70_000)) } }), []).body;
  assert.ok(big.length < 66_000 && big.endsWith('more not shown)'), big.slice(-40));
  assert.equal(describeSent(wire({ headers: [['X', 'a\u202eb']] }), []).headers[0]?.[1], 'a?b', 'a character that changes the direction of text is made visible');
});

const response = (over: Partial<WireResponse> = {}): WireResponse => ({
  status: 200, statusText: 'OK', httpVersion: '1.1', headers: [['Content-Type', 'application/json']], body: { kind: 'memory', bytes: bytes('{"ok":true}') }, wireBytes: 11, size: 11, truncated: false,
  timings: { dnsMs: 1, connectMs: 2, tlsMs: 0, ttfbMs: 5, downloadMs: 1, totalMs: 9 }, redirects: [], finalUrl: 'https://api.test/v1/items?token=sekret-value-1', sent: wire(), warnings: [], ...over
});
const view = (over: Partial<WireResponse> = {}, input: Partial<ResponseViewInput> = {}) => buildResponseView({ response: response(over), bytes: bytes('{"ok":true}'), redactions: ['sekret-value-1'], warnings: [], ...input });

test('The view of a response has the status, the headers as received, the body and what was sent', () => {
  const result = view({ headers: [['Content-Type', 'application/json'], ['X-Dup', 'a'], ['X-Dup', 'b'], ['X-Weird', 'a\u200bb']] });
  assert.deepEqual([result.status, result.statusText, result.httpVersion, result.size, result.wireBytes, result.truncated, result.onDisk], [200, 'OK', '1.1', 11, 11, false, false]);
  assert.deepEqual(result.headers, [['Content-Type', 'application/json'], ['X-Dup', 'a'], ['X-Dup', 'b'], ['X-Weird', 'a?b']]);
  assert.equal(result.body.pretty, '{\n  "ok": true\n}');
  assert.equal(result.finalUrl, 'https://api.test/v1/items?token=[redacted]');
  assert.equal(result.sent.headers[0]?.[1], '[redacted]');
  assert.equal(result.timings.totalMs, 9);
});

test('A response that went to a file is said to, and the warnings of the engine and of the request are both there', () => {
  const result = view({ body: { kind: 'file', path: '/tmp/x.body' }, truncated: true, warnings: ['The certificate was not checked.'] }, { warnings: ['No value for {{token}}.'] });
  assert.deepEqual([result.onDisk, result.truncated], [true, true]);
  assert.deepEqual(result.warnings, ['No value for {{token}}.', 'The certificate was not checked.']);
});

test('The cookies a response sets are listed with their attributes; a header that is not a cookie is left out', () => {
  const result = view({ headers: [
    ['Set-Cookie', 'sid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600'],
    ['set-cookie', 'pref=dark; Domain=.Example.COM; Expires=Wed, 21 Oct 2026 07:28:00 GMT'],
    ['Set-Cookie', 'temp=1'],
    ['Set-Cookie', 'broken'],
    ['Set-Cookie', '=nameless'],
    ['Set-Cookie-Not', 'a=b']
  ] });
  assert.deepEqual(result.cookies, [
    { name: 'sid', value: 'abc123', domain: '', path: '/', expires: 'Max-Age 3600 s', secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'pref', value: 'dark', domain: 'example.com', path: '', expires: '2026-10-21T07:28:00.000Z', secure: false, httpOnly: false, sameSite: '' },
    { name: 'temp', value: '1', domain: '', path: '', expires: 'Session', secure: false, httpOnly: false, sameSite: '' }
  ]);
});
