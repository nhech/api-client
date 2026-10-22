import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_LIMITS } from '../../src/importers/routes/types';
import { angleParams, braceParams, colonParams, finalizePath, groupFromFile, joinPaths, pathParamNames, stemOf } from '../../src/importers/routes/paths';
import { argRanges, identAt, identBefore, lineOf, literalAt, prepare, skipSpace, stringArg } from '../../src/importers/routes/scan';
import { isRouteSource } from '../../src/importers/routes';

/** The reading of a source file as text: comments, strings, brackets, lines, paths. A route is only as good as the text it was read from. */

const timed = (run: () => void): number => {
  const start = Date.now();
  run();
  return Date.now() - start;
};

test('The comments are blanked and the strings are kept; the text keeps its length and its line breaks', () => {
  const text = 'const a = "// not a comment"; // real\n/* block\n over lines */ call("x");\n';
  const { clean, masked } = prepare(text, 'js');
  assert.equal(clean.length, text.length);
  assert.equal(masked.length, text.length);
  assert.ok(clean.includes('"// not a comment"'), 'a // inside a string is text');
  assert.ok(!clean.includes('real') && !clean.includes('block') && !clean.includes('over lines'));
  assert.ok(clean.includes('call("x")'));
  assert.deepEqual([...clean].map(char => char === '\n').join(), [...text].map(char => char === '\n').join(), 'the line breaks are where they were');
  assert.ok(!masked.includes('not a comment') && masked.includes('call("')); // the inside of a string is blanked in the second view
});

test('A bracket in a string is not structure, and the partner of every bracket is found in one pass', () => {
  const { masked, close, open } = prepare('f("(", [1, {a: ")"}], \')\')', 'js');
  assert.equal(masked.length, 'f("(", [1, {a: ")"}], \')\')'.length);
  assert.equal(close[1], masked.length - 1, 'the first ( closes at the last )');
  assert.equal(open[masked.length - 1], 1);
  const inner = masked.indexOf('[');
  assert.equal(masked[close[inner] as number], ']');
  assert.equal(close[0], -1, 'a letter has no partner');
});

test('A bracket that does not match is left alone and does not take the others with it', () => {
  const { close } = prepare('a( ] b ) { ( }', 'js');
  assert.equal(close[1], 7, 'the ] does not close the (');
  assert.equal(close[9], 13, 'the { closes at its own }');
  assert.equal(close[11], -1, 'the ( inside it has no partner');
});

test('A template literal with another one in a hole of it does not turn the rest of the file into a string', () => {
  const text = 'const a = `x ${ b ? `y ${ c }` : \'z\' } w`;\napp.get(\'/after\', h);\nconst d = `t`;\napp.get(\'/late\', h);\n';
  const { clean, masked } = prepare(text, 'js');
  assert.ok(masked.includes('app.get('), 'code after the template is code');
  assert.equal(masked.split('app.get(').length, 3);
  assert.ok(clean.includes("'/after'") && clean.includes("'/late'"));
  assert.ok(!masked.includes('x ') && masked.includes('b ?'), 'the text of the template is blanked, the hole is code');
});

test('A slash that is escaped is not a comment: a regular expression does not blank the rest of the line', () => {
  const { clean } = prepare("s.replace(/https?:\\/\\//, ''); app.get('/ok', h);", 'js');
  assert.ok(clean.includes("app.get('/ok', h)"));
  const block = prepare("x = /a\\/*b/; app.get('/after', h);", 'js').clean;
  assert.ok(block.includes("app.get('/after', h)"), 'and neither does a /* that is escaped');
});

test('A block comment that never ends is not a comment, and a file full of them is read in a moment', () => {
  const { clean } = prepare("app.get('/a', h); /* never closed\napp.get('/b', h);", 'js');
  assert.ok(clean.includes("'/b'"), 'the rest of the file is still code');
  assert.ok(timed(() => prepare('/* x\n'.repeat(150_000), 'js')) < 1000, 'a hundred and fifty thousand openers, none of which has an end to look for');
  assert.ok(timed(() => prepare('""" x\n'.repeat(150_001), 'python')) < 1000, 'and as many triple quotes, one of which has no end');
});

test('Python: a comment, a docstring and the strings that have a # in them', () => {
  const text = '# a comment\nx = "a # b"  # another\n"""docstring @app.get("/x")"""\n@app.get("/real")\ndef f(): pass\n';
  const { clean } = prepare(text, 'python');
  assert.ok(clean.includes('"a # b"'), 'a # in a string is text');
  assert.ok(!clean.includes('another') && !clean.includes('a comment'));
  assert.ok(!clean.includes('docstring') && !clean.includes('"/x"'), 'a route in a docstring is not a route');
  assert.ok(clean.includes('@app.get("/real")'));
});

test('PHP: // and # are comments, #[ is an attribute, strings are kept', () => {
  const { clean } = prepare("<?php\n// one\n# two\n#[Route('/x')]\n$a = 'http://x'; /* three */ Route::get('/y');", 'php');
  assert.ok(!clean.includes('one') && !clean.includes('two') && !clean.includes('three'));
  assert.ok(clean.includes("#[Route('/x')]") && clean.includes("'http://x'") && clean.includes("Route::get('/y')"));
});

test('C#: a verbatim string, a raw string and an interpolated string are strings', () => {
  const text = 'var a = @"C:\\x ""q"" // not"; var b = """\n// raw\n"""; var c = $"x {y}"; // real\nvar d = @"C:\\dir\\"; // after the backslash\nMapGet("/z");';
  const { clean, masked } = prepare(text, 'csharp');
  assert.ok(clean.includes('// not') && clean.includes('// raw'), 'no comment inside them');
  assert.ok(!clean.includes('real') && !clean.includes('after the backslash'), 'a backslash at the end of a verbatim string does not take the quote');
  assert.ok(!masked.includes('// not') && !masked.includes('raw'), 'and the inside of them is blanked');
  assert.ok(masked.includes('MapGet("'));
});

test('Go and Rust: raw strings, runes, characters and lifetimes', () => {
  const go = prepare('s := `a "b" // c`\nr.GET("/x", h) // real', 'go');
  assert.ok(go.clean.includes('// c') && !go.clean.includes('real'));
  assert.ok(!go.masked.includes('// c'));
  const rust = prepare('let a = r#"raw "quoted" // x"#; fn f<\'a>(x: &\'a str) { let c = \'x\'; let d = \'\\n\'; } // tail\n#[get("/u")]', 'rust');
  assert.ok(rust.clean.includes('// x') && !rust.clean.includes('tail'));
  assert.ok(rust.masked.includes("&'a str") && rust.masked.includes('#[get("'), 'a lifetime does not start a string');
});

test('Java and Kotlin: a text block is a string', () => {
  const { clean, masked } = prepare('String s = """\n  // inside @GetMapping("/x")\n  """;\n@GetMapping("/y")', 'java');
  assert.ok(clean.includes('// inside'), 'no comment inside it');
  assert.ok(!masked.includes('@GetMapping("/x")') && masked.includes('@GetMapping("'));
});

test('A line longer than the limit is skipped and counted: a minified file is not read', () => {
  const long = `app.get('/x', h);${'a'.repeat(ROUTE_LIMITS.lineChars)}`;
  const prepared = prepare(`${long}\napp.get('/y', h);\n`, 'js');
  assert.equal(prepared.longLines, 1);
  assert.ok(!prepared.clean.includes("'/x'") && prepared.clean.includes("'/y'"));
});

test('A byte order mark in front of a file is not part of its first line, and the text keeps its length', () => {
  const mark = String.fromCodePoint(0xfeff);
  const text = `${mark}from fastapi import FastAPI\napp = FastAPI()\n`;
  const prepared = prepare(text, 'python');
  assert.equal(prepared.clean.length, text.length);
  assert.ok(prepared.clean.startsWith(' from fastapi'));
});

test('The line of an offset is counted from 1', () => {
  const prepared = prepare('a\nbb\n\nc', 'js');
  assert.deepEqual([0, 1, 2, 4, 5, 6].map(offset => lineOf(prepared, offset)), [1, 1, 2, 2, 3, 4]);
});

test('A literal is a plain string on one line; an interpolation, a prefix of formatting or an end that is missing make it not one', () => {
  const read = (text: string) => literalAt(text, 0)?.value;
  assert.equal(read("'/users/:id'"), '/users/:id');
  assert.equal(read('"a\\"b"'), 'a"b');
  assert.equal(read('`/plain`'), '/plain');
  assert.equal(read('`/with/${id}`'), undefined, 'an interpolation is not a plain string');
  assert.equal(read('f"/x/{id}"'), undefined, 'an f-string is not');
  assert.equal(read('$"/x/{id}"'), undefined, 'neither is a string of C# with $');
  assert.equal(read('r"/raw"'), '/raw');
  assert.equal(read('@"/a""b"'), '/a"b', 'a verbatim string of C#');
  assert.equal(read('"open'), undefined);
  assert.equal(read('"a\nb"'), undefined, 'a string does not go over the end of a line');
  assert.equal(read('name'), undefined);
  assert.equal(read(`"${'x'.repeat(2000)}"`), undefined, 'and not over the limit');
  assert.deepEqual(literalAt("'a' + b", 0), { value: 'a', end: 3 });
});

test('The arguments of a call are split at the commas that are not inside another bracket', () => {
  const prepared = prepare("f('/a,b', g(1, 2), [3, 4], { k: 5 }, `t,u`)", 'js');
  const ranges = argRanges(prepared, 1);
  assert.deepEqual(ranges.map(([from, to]) => prepared.clean.slice(from, to)), ["'/a,b'", 'g(1, 2)', '[3, 4]', '{ k: 5 }', '`t,u`']);
  assert.equal(stringArg(prepared, ranges[0] as [number, number]), '/a,b');
  assert.equal(stringArg(prepared, ranges[1] as [number, number]), undefined, 'a call is not a string');
  assert.deepEqual(argRanges(prepared, 1, { max: 2 }).length, 2);
  assert.deepEqual(argRanges(prepared, 0), [], 'a letter is not a bracket');
  assert.deepEqual(argRanges(prepare('f()', 'js'), 1), [], 'no arguments');
});

test('Angle brackets count only when asked: the generics of a parameter list, and not an arrow', () => {
  const prepared = prepare('m(Map<String, Integer> a, List<List<Long>> b, x => y)', 'java');
  assert.equal(argRanges(prepared, 1, { angles: true }).length, 3);
  assert.equal(argRanges(prepared, 1).length, 4, 'without them the comma inside <> splits');
  const arrow = prepare('m(a => b, c)', 'java');
  assert.equal(argRanges(arrow, 1, { angles: true }).length, 2, '=> is not a bracket');
});

test('Only so much of a very long list is read', () => {
  const prepared = prepare(`f(${Array.from({ length: 5000 }, (_, index) => `a${index}`).join(',\n')})`, 'js');
  const ranges = argRanges(prepared, 1, { max: 100, scan: 200 });
  assert.ok(ranges.length > 10 && ranges.length < 100, String(ranges.length));
  assert.ok(timed(() => { for (let index = 0; index < 2000; index++) argRanges(prepared, 1, { scan: 300 }); }) < 1000);
});

test('Names, white space and the identifier before a point', () => {
  assert.equal(identAt('abc$_9 x', 0), 'abc$_9');
  assert.equal(identAt('9abc', 0), '');
  assert.deepEqual(identBefore('  foo.bar  ', 11), { name: 'bar', start: 6 });
  assert.equal(identBefore('(  ', 3), undefined);
  assert.equal(skipSpace('  \t\n x', 0), 5);
});

test('A path is written the way the client writes it, whatever the framework wrote', () => {
  assert.equal(finalizePath('users//:id/'), '/users/:id');
  assert.equal(finalizePath('/'), '/');
  assert.equal(finalizePath(''), '/');
  assert.equal(finalizePath('/a?x=1#h'), '/a');
  assert.equal(joinPaths('/api', 'users', '/{id}'), '/api/users/{id}');
  assert.equal(joinPaths('', ''), '/');
  assert.equal(colonParams('/users/:id/posts/:post_id?'), '/users/{id}/posts/{post_id}');
  assert.equal(colonParams('/items/:id(\\d+)'), '/items/{id}');
  assert.equal(colonParams('/files/*path'), '/files/{path}');
  assert.equal(colonParams('/files/*'), '/files/*', 'a star with no name stays');
  assert.equal(colonParams('/a:b'), '/a:b', 'a colon after a letter is not a parameter');
  assert.equal(angleParams('/u/<int:id>/<name>/<path:rest>'), '/u/{id}/{name}/{rest}');
  assert.equal(angleParams('^users/(?P<pk>[0-9]+)/$'), 'users/{pk}/');
  assert.equal(angleParams('/u/<id..>'), '/u/{id}');
  assert.equal(braceParams('/u/{id:int}/{slug?}/{*rest}/{**all}/{n=5}/{x:\\d{3}}'), '/u/{id}/{slug}/{rest}/{all}/{n}/{x}');
  assert.deepEqual(pathParamNames('/a/{id}/b/{id}/{name}'), ['id', 'name']);
});

test('The patterns of the paths are bounded: a hostile path is read in a moment', () => {
  const hostile = `/${':a('.repeat(50_000)}${'{x:'.repeat(50_000)}${'<'.repeat(50_000)}`;
  assert.ok(timed(() => { colonParams(hostile); braceParams(hostile); angleParams(hostile); pathParamNames(hostile); finalizePath(hostile); }) < 1000);
});

test('The folder of the routes of a file is named after the file, or after its folder when the file is called what every project calls it', () => {
  assert.equal(groupFromFile('src/routes/users.ts'), 'users');
  assert.equal(groupFromFile('api/index.js'), 'api');
  assert.equal(groupFromFile('shop/urls.py'), 'shop');
  assert.equal(groupFromFile('src/app.ts'), 'app', 'a folder that every project has says nothing');
  assert.equal(groupFromFile('main.go'), 'main');
  assert.equal(stemOf('a/b/c.test.ts'), 'c.test');
  assert.equal(stemOf('Makefile'), 'Makefile');
});

test('The files that can hold a route: sources, outside the folders of what is built, installed or tested', () => {
  for (const path of ['src/app.ts', 'a/b/UserController.java', 'x.py', 'routes/web.php', 'main.go', 'src/main.rs', 'Controllers/PetsController.cs', 'index.mjs', 'App.KT']) assert.equal(isRouteSource(path), true, path);
  for (const path of [
    'node_modules/express/index.js', 'dist/app.js', 'build/x.ts', 'target/classes/A.java', 'bin/Debug/x.cs', 'obj/x.cs', 'vendor/a.php', 'venv/lib/x.py', '.venv/x.py', '__pycache__/x.py',
    'coverage/x.js', 'src/test/java/A.java', 'tests/app.test.ts', '__tests__/a.js', 'e2e/a.ts', 'spec/a.rb', 'src/Tests/A.cs', '.git/hooks/x.py',
    'a.test.ts', 'a.spec.js', 'x_test.go', 'UserTest.java', 'UserTests.kt', 'PetsTests.cs', 'test_app.py', 'app_test.py', 'types.d.ts', 'a.min.js', 'README.md', 'package.json', 'Makefile'
  ]) assert.equal(isRouteSource(path), false, path);
});
