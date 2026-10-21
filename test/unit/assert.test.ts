import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSERT_LIMITS, parseAssertion, parseCapture, runCaptures, runTests, type Resolver, type TestSubject } from '../../src/core/assert';

const BODY = JSON.stringify({ id: 7, name: 'Rex', tags: ['a', 'b'], nested: { ok: true }, n: null, items: [{ p: 1 }, { p: 2 }], big: 12345678901234567890 });
const subject = (over: Partial<TestSubject> = {}): TestSubject => ({
  status: 200, durationMs: 120,
  headers: [['Content-Type', 'application/json'], ['X-Id', '42'], ['Set-Cookie', 'sid=abc123; Path=/; HttpOnly'], ['Set-Cookie', 'theme=dark'], ['X-Dup', 'a'], ['X-Dup', 'b']],
  body: BODY, ...over
});
const plain: Resolver = text => ({ text, unresolved: [] });
const withVariables = (values: Record<string, string>): Resolver => text => {
  const unresolved: string[] = [];
  return { text: text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => { if (Object.hasOwn(values, name)) return values[name] as string; unresolved.push(name); return whole; }), unresolved };
};
const run = (expr: string, over: Partial<TestSubject> = {}, resolve: Resolver = plain) => runTests([{ expr, from: 'request' }], subject(over), resolve)[0] as ReturnType<typeof runTests>[number];
const passes = (expr: string, over: Partial<TestSubject> = {}, resolve: Resolver = plain): void => { const result = run(expr, over, resolve); assert.equal(result.ok, true, `${expr}: ${result.message}`); };
const fails = (expr: string, message: RegExp | string, over: Partial<TestSubject> = {}, resolve: Resolver = plain): void => {
  const result = run(expr, over, resolve);
  assert.equal(result.ok, false, `${expr} passed`);
  if (typeof message === 'string') assert.equal(result.message, message, expr); else assert.match(result.message, message, expr);
};

test('A test is read as a subject, an operator and what follows; what is not in the grammar says why', () => {
  const parsed = parseAssertion('  json $.items[*].p   count >= {{n}}  ');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok ? [parsed.value.source, parsed.value.subject.kind, parsed.value.op, parsed.value.compare, parsed.value.expected] : undefined, ['json $.items[*].p   count >= {{n}}', 'json', 'count', '>=', '{{n}}']);
  const spaced = parseAssertion("json $['a b'] == one two");
  assert.ok(spaced.ok && spaced.value.expected === 'one two' && spaced.value.subject.kind === 'json', 'a path with a space inside quotes, and a value of several words');
  const error = (expr: string): string => { const result = parseAssertion(expr); assert.equal(result.ok, false, expr); return result.ok ? '' : result.error; };
  assert.match(error(''), /cannot be empty/);
  assert.match(error('   '), /cannot be empty/);
  assert.match(error('nonsense == 1'), /"nonsense" is not something to test: use status/);
  assert.match(error('status'), /what should status be\? .*status == 200/);
  assert.match(error('json $.id'), /json \$\.id exists/);
  assert.match(error('body'), /body includes ok/);
  assert.match(error('status includes 2'), /status cannot be tested with "includes": use ==, !=/);
  assert.match(error('body > 5'), /body cannot be tested with ">"/);
  assert.match(error('header'), /needs the name of a header/);
  assert.match(error('json'), /needs a path/);
  assert.match(error('json x == 5'), /json path: a JSON path starts with \$/);
  assert.match(error('json $.a[?(@.b)] exists'), /json path: filters/);
  assert.match(error('status =='), /needs a value/);
  assert.match(error('json $.a count'), /count needs a comparison/);
  assert.match(error('json $.a count ~ 3'), /count needs a comparison/);
  assert.match(error('json $.a count =='), /count == needs a value/);
  assert.match(error('json $.a exists now'), /exists takes no value/);
  assert.match(error('body isJson yes'), /isJson takes no value/);
  assert.match(error('body matches /(a/'), /never closed/);
  assert.match(error('body matches (?=a)b'), /look-around/);
  assert.match(error('body matches /a/g'), /flag "g"/);
  assert.match(error('status == ' + '1'.repeat(ASSERT_LIMITS.expressionChars)), /limited to 2000/);
  assert.ok(parseAssertion('body matches {{pattern}}').ok, 'a pattern with a variable is checked when it is run');
});

test('Status and duration are compared as numbers', () => {
  passes('status == 200');
  passes('status != 404');
  passes('status >= 200');
  passes('status < 300');
  passes('duration < 500');
  passes('duration <= 120');
  fails('status == 404', 'got 200');
  fails('duration > 500', 'got 120');
  fails('status == abc', /"abc" is not a number/);
  fails('status == 200 junk', /is not a number/);
  passes('status == 200.0');
  passes('status == {{code}}', {}, withVariables({ code: '200' }));
  fails('status == {{code}}', 'the variable code has no value', {}, withVariables({}));
  fails('duration < {{a}}', 'the variable a has no value', {}, withVariables({ b: '1' }));
});

test('Headers are found by name in any case, a repeated one is joined, and numbers in them compare as numbers', () => {
  passes('header content-type includes json');
  passes('header CONTENT-TYPE == application/json');
  passes('header x-dup == a, b');
  passes('header x-id == 42');
  passes('header x-id > 40');
  passes('header x-id < 100');
  passes('header content-type startsWith application');
  passes('header content-type endsWith json');
  passes('header content-type matches /^application\\/(json|xml)$/');
  passes('header x-id exists');
  passes('header x-missing notExists');
  fails('header x-missing exists', 'no header named x-missing');
  fails('header x-missing == 1', 'no header named x-missing');
  fails('header x-id notExists', 'the header x-id is there');
  fails('header content-type includes xml', 'got "application/json"');
  fails('header content-type > 5', /cannot compare "application\/json" with "5"|got/);
});

test('The body is tested as text', () => {
  passes('body includes Rex');
  passes('body excludes Felix');
  passes('body startsWith {"id"');
  passes('body endsWith }');
  passes('body matches /"id":\\d+/');
  passes('body matches /"NAME":"rex"/i');
  passes('body isJson');
  passes('body != nothing');
  fails('body includes Felix', /^got "\{\\"id\\":7/);
  fails('body == nothing', /^got /);
  fails('body isJson', 'the body is not valid JSON', { body: 'not json' });
  fails('body includes x', 'The body is not text.', { body: undefined, bodyNote: 'The body is not text.' });
  fails('body includes x', 'the response has no body to read', { body: undefined });
  fails('body matches /(/', /never closed/);
});

test('A value in the JSON of the body is found by its path and compared as what it is', () => {
  passes('json $.id == 7');
  passes('json $.id == 7.0');
  passes('json $.id != 8');
  passes('json $.id < 10');
  passes('json $.id >= 7');
  passes('json $.name == Rex');
  passes('json $.name startsWith Re');
  passes('json $.name endsWith ex');
  passes('json $.name matches ^R');
  passes('json $.name includes e');
  passes('json $.tags includes a');
  passes('json $.tags excludes z');
  passes('json $.tags count == 2');
  passes('json $.tags[*] count == 2');
  passes('json $.items count >= 2');
  passes('json $.items[*].p isNumber');
  passes('json $.tags isArray');
  passes('json $.name isString');
  passes('json $.nested.ok isBoolean');
  passes('json $.nested.ok == true');
  passes('json $.nested == {"ok":true}');
  fails('json $.nested == {"ok":true,"extra":1}', /^got {"ok":true}/);
  fails('json $.nested == {}', /^got /);
  passes('json $.tags == ["a","b"]');
  passes('json $.n == null');
  passes('json $.n exists');
  passes('json $.missing notExists');
  passes('json $.nested includes ok');
  passes('json $.id == {{id}}', {}, withVariables({ id: '7' }));
  fails('json $.id == 8', 'got 7');
  fails('json $.name == rex', 'got "Rex"');
  fails('json $.name == 7', 'got "Rex"');
  fails('json $.tags == ["a"]', 'got ["a","b"]');
  fails('json $.items[*].p == 1', 'got 2');
  fails('json $.missing exists', 'nothing at $.missing');
  fails('json $.missing == 1', 'nothing at $.missing');
  fails('json $.id isString', 'got 7');
  fails('json $.tags isNumber', 'got ["a","b"]');
  fails('json $.name < 5', /cannot compare|got/);
  fails('json $.id < abc', /cannot compare 7 with "abc"/);
  fails('json $.tags count == 3', 'got 2');
  fails('json $.id notExists', '$.id is there');
  fails('json $.id == {{nope}}', 'the variable nope has no value', {}, withVariables({}));
  fails('json $..[?] exists', /json path|filters|unexpected/);
  fails('json $.id == 7', 'the body is not valid JSON', { body: 'x' });
  fails('json $.id == 7', 'The body is not text.', { body: undefined, bodyNote: 'The body is not text.' });
  fails('json $.id == 7', 'the body is too large to read as JSON', { body: ' '.repeat(ASSERT_LIMITS.bodyChars + 1) });
});

test('A very long value is cut in the message, and a test that cannot be read fails with the reason instead of being skipped', () => {
  const long = JSON.stringify({ text: 'x'.repeat(500) });
  const result = run('json $.text == y', { body: long });
  assert.equal(result.ok, false);
  assert.ok(result.message.length < 100 && result.message.endsWith('..."') === false && result.message.endsWith('...'), result.message);
  const unreadable = run('nonsense');
  assert.deepEqual([unreadable.ok, unreadable.expr, unreadable.from], [false, 'nonsense', 'request']);
  assert.match(unreadable.message, /not something to test/);
  const many = runTests([{ expr: 'status == 200', from: 'Shop' }, { expr: 'status == 500', from: 'request' }, { expr: 'body isJson', from: 'Orders' }], subject(), plain);
  assert.deepEqual(many.map(item => [item.from, item.ok]), [['Shop', true], ['request', false], ['Orders', true]], 'every test is judged, in order, with where it came from');
});

test('A pattern that would freeze a backtracking engine is answered at once', () => {
  const started = Date.now();
  passes('body matches /^(a+)+$/', { body: 'a'.repeat(30_000) });
  fails('body matches /^(a+)+$/', /^got /, { body: `${'a'.repeat(30_000)}b` });
  passes('body matches {{pattern}}', { body: 'abc' }, withVariables({ pattern: '/^a.c$/' }));
  fails('body matches {{pattern}}', /never closed/, { body: 'abc' }, withVariables({ pattern: '/(/' }));
  assert.ok(Date.now() - started < 10_000);
});

test('A capture is read as [scope:]name = source', () => {
  const ok = (expr: string) => { const result = parseCapture(expr); assert.ok(result.ok, expr + (result.ok ? '' : `: ${result.error}`)); return result.ok ? result.value : undefined; };
  assert.deepEqual([ok('token = json $.access_token')?.scope, ok('token = json $.access_token')?.variable, ok('token = json $.access_token')?.from.kind], ['active', 'token', 'json']);
  assert.equal(ok('local: x = header X-Id')?.scope, 'local');
  assert.equal(ok('global:y = cookie sid')?.scope, 'global');
  assert.equal(ok('active : z=body')?.from.kind, 'body');
  assert.deepEqual(ok('k = value hello  world'), { source: 'k = value hello  world', scope: 'active', variable: 'k', from: { kind: 'value', text: 'hello  world' } });
  assert.equal(ok('n = null')?.from.kind, 'null');
  assert.equal(ok('d = delete')?.from.kind, 'delete');
  assert.equal(ok("t = json $['a b'].c")?.from.kind, 'json');
  const error = (expr: string): string => { const result = parseCapture(expr); assert.equal(result.ok, false, expr); return result.ok ? '' : result.error; };
  assert.match(error(''), /cannot be empty/);
  assert.match(error('noequals'), /written name = source/);
  assert.match(error('a b = body'), /written name = source/);
  assert.match(error('1x = body'), /not a name a variable can have/);
  assert.match(error('x = json'), /json needs one path/);
  assert.match(error('x = json $.a $.b'), /json needs one path/);
  assert.match(error('x = json a'), /json path: a JSON path starts with \$/);
  assert.match(error('x = header'), /header needs one name/);
  assert.match(error('x = cookie a b'), /cookie needs one name/);
  assert.match(error('x = body extra'), /body takes nothing/);
  assert.match(error('x = null 1'), /null takes nothing/);
  assert.match(error('x = delete 1'), /delete takes nothing/);
  assert.match(error('x = nonsense'), /the source is json PATH/);
  assert.match(error('bad scope: x = body'), /written name = source/);
});

test('A capture reads a value of the response; one that is not there fails and changes nothing', () => {
  const capture = (expr: string, resolve: Resolver = plain, over: Partial<TestSubject> = {}) => runCaptures([{ expr, from: 'request' }], subject(over), resolve)[0] as ReturnType<typeof runCaptures>[number];
  assert.deepEqual([capture('id = json $.id').ok, capture('id = json $.id').value, capture('id = json $.id').action], [true, '7', 'set']);
  assert.equal(capture('n = json $.name').value, 'Rex');
  assert.equal(capture('n = json $.nested').value, '{"ok":true}');
  assert.equal(capture('n = json $.tags').value, '["a","b"]');
  assert.equal(capture('n = json $.n').value, 'null');
  assert.equal(capture('n = json $.nested.ok').value, 'true');
  assert.equal(capture('n = json $.items[*].p').value, '1', 'the first of several');
  assert.equal(capture('h = header x-id').value, '42');
  assert.equal(capture('h = header x-dup').value, 'a, b');
  assert.equal(capture('c = cookie sid').value, 'abc123');
  assert.equal(capture('c = cookie theme').value, 'dark');
  assert.equal(capture('b = body').value, BODY);
  assert.equal(capture('v = value fixed text').value, 'fixed text');
  assert.equal(capture('v = value {{who}} said hi', withVariables({ who: 'Ann' })).value, 'Ann said hi');
  assert.equal(capture('n = null').value, '');
  assert.equal(capture('n = null').action, 'set');
  assert.equal(capture('d = delete').action, 'delete');
  const missing = capture('id = json $.nothing');
  assert.deepEqual([missing.ok, missing.message, missing.value], [false, 'nothing at $.nothing', '']);
  assert.equal(capture('h = header x-missing').message, 'no header named x-missing');
  assert.equal(capture('c = cookie nope').message, 'the response sets no cookie named nope');
  assert.equal(capture('v = value {{nope}}', withVariables({})).message, 'the variable nope has no value');
  assert.equal(capture('b = body', plain, { body: undefined, bodyNote: 'The body is not text.' }).message, 'The body is not text.');
  assert.equal(capture('id = json $.id', plain, { body: 'x' }).message, 'the body is not valid JSON');
  const unreadable = capture('nonsense');
  assert.deepEqual([unreadable.ok, unreadable.variable, unreadable.message.length > 0], [false, '', true]);
  assert.equal(capture('global:g = json $.id').scope, 'global');
});
