import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRoutes, routesToImported, ROUTE_CONFIG_FILES, ROUTE_EXTENSIONS, ROUTE_LIMITS, type RoutesResult, type SourceFile } from '../../src/importers/routes';
import { countImported } from '../../src/importers/types';

/** The routes of a whole project: what is read, in which order, within which limits, what the person is told, and the collection that is made. */

const file = (path: string, text: string): SourceFile => ({ path, text });
const EXPRESS = "import express from 'express';\nconst app = express();\n";
const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = Date.now();
  const value = run();
  return { value, ms: Date.now() - start };
};

test('The module names what it reads: the extensions and the configuration files', () => {
  assert.ok(ROUTE_EXTENSIONS.includes('.ts') && ROUTE_EXTENSIONS.includes('.java') && ROUTE_EXTENSIONS.includes('.rs') && ROUTE_EXTENSIONS.includes('.cs'));
  assert.deepEqual([...ROUTE_CONFIG_FILES].sort(), ['.env', 'application.properties', 'application.yaml', 'application.yml', 'appsettings.json', 'launchSettings.json']);
  assert.deepEqual(ROUTE_LIMITS, { files: 5000, fileChars: 1_000_000, lineChars: 2000, routes: 20_000, notes: 100 });
});

test('A project with no route says so and has no address', () => {
  const result = detectRoutes([file('src/a.ts', 'export const a = 1;'), file('README.md', '# x'), file('src/b.py', 'print(1)')]);
  assert.deepEqual(result.routes, []);
  assert.equal(result.baseUrl, undefined);
  assert.deepEqual(result.frameworks, []);
  assert.equal(result.filesRead, 2, 'the sources are counted, not the readme');
  assert.match(result.notes[0] ?? '', /No routes were found/);
  assert.deepEqual(detectRoutes([]).routes, []);
});

test('Files with a byte order mark and with Windows line ends are read like the others', () => {
  const mark = String.fromCodePoint(0xfeff);
  const python = `${mark}from fastapi import FastAPI\r\napp = FastAPI()\r\n@app.get("/bom")\r\ndef f(): pass\r\n`;
  const java = `${mark}@RestController\r\nclass A {\r\n  @GetMapping("/crlf")\r\n  void a() {}\r\n}\r\n`;
  const result = detectRoutes([file('a.py', python), file('A.java', java)]);
  assert.deepEqual(result.routes.map(route => `${route.path} ${route.line}`), ['/crlf 3', '/bom 3'], 'in the order of the files: A.java is before a.py');
});

test('The files that are built, installed or tested are not read', () => {
  const route = `${EXPRESS}app.get('/x', h);`;
  const result = detectRoutes([
    file('src/app.ts', route), file('node_modules/pkg/index.js', route), file('dist/app.js', route), file('src/app.test.ts', route), file('test/app.ts', route), file('types.d.ts', route)
  ]);
  assert.deepEqual(result.routes.map(item => item.file), ['src/app.ts']);
  assert.equal(result.filesRead, 1);
});

test('The result does not depend on the order of the files: the routes are by file, line and method', () => {
  const files = [
    file('b/users.ts', `${EXPRESS}app.post('/u', h);\napp.get('/u', h);`),
    file('a/things.ts', `${EXPRESS}app.get('/t', h);`),
    file('c/Pets.java', '@RestController class P { @GetMapping("/p") void p() {} }'),
    file('d/x.py', 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/py")\ndef f(): pass')
  ];
  const expected = JSON.stringify(detectRoutes(files));
  for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) assert.equal(JSON.stringify(detectRoutes(order.map(index => files[index] as SourceFile))), expected);
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => `${route.file}:${route.line} ${route.method} ${route.path}`), ['a/things.ts:3 GET /t', 'b/users.ts:3 POST /u', 'b/users.ts:4 GET /u', 'c/Pets.java:1 GET /p', 'd/x.py:3 GET /py']);
});

test('The frameworks, the number of files and the notes of a project of several languages', () => {
  const result = detectRoutes([
    file('web/app.ts', `${EXPRESS}app.get('/e', h);`),
    file('api/P.java', '@RestController class P { @GetMapping("/p") void p() {} }'),
    file('svc/x.py', 'from flask import Flask\napp = Flask(__name__)\n@app.route("/f")\ndef f(): pass'),
    file('readme.md', 'x')
  ]);
  assert.deepEqual(result.frameworks, ['Express', 'Flask', 'Spring']);
  assert.equal(result.filesRead, 3);
  assert.match(result.notes[0] ?? '', /read from the text of the source files, not by running the program/);
  assert.match(result.notes[1] ?? '', /Found in: Express, Flask, Spring\./);
});

test('The base address comes from the configuration of the project of the framework that has most routes', () => {
  const web = file('a.ts', `${EXPRESS}app.get('/a', h);\napp.get('/b', h);\napp.listen(4000);`);
  assert.equal(detectRoutes([web]).baseUrl, 'http://localhost:4000', 'the code');
  assert.equal(detectRoutes([web, file('.env', 'PORT=4500\n')]).baseUrl, 'http://localhost:4500', 'the configuration wins over the code');
  assert.equal(detectRoutes([web, file('.env', 'export PORT="4600" # the port\n')]).baseUrl, 'http://localhost:4600');
  assert.equal(detectRoutes([web, file('.env', '# PORT=4500\nOTHER=1')]).baseUrl, 'http://localhost:4000');
  const spring = file('A.java', '@RestController class A { @GetMapping("/x") void x() {} }');
  assert.equal(detectRoutes([web, spring, file('.env', 'PORT=4500')]).baseUrl, 'http://localhost:4500', 'two routes against one');
  assert.equal(detectRoutes([spring, file('.env', 'PORT=4500')]).baseUrl, 'http://localhost:8080', 'a .env is not the configuration of Spring');
  assert.equal(detectRoutes([web, file('deep/.env', 'PORT=1111'), file('.env', 'PORT=2222')]).baseUrl, 'http://localhost:2222', 'the file nearest the root');
  assert.equal(detectRoutes([web, file('a/b/.env', 'PORT=1111'), file('z/.env', 'PORT=2223')]).baseUrl, 'http://localhost:2223', 'the one with the shorter path, not the first in the alphabet');
  const laravel = file('routes/web.php', "<?php\nRoute::get('/x', fn () => 1);");
  assert.equal(detectRoutes([laravel, file('.env', 'PORT=4500\nAPP_URL=http://localhost:8001')]).baseUrl, 'http://localhost:8000', 'Laravel is told its address by APP_URL');
  assert.equal(detectRoutes([web, file('node_modules/pkg/.env', 'PORT=1234')]).baseUrl, 'http://localhost:4000', 'a configuration of an installed package is not the configuration of the project');
});

test('More than the limit of source files: the first ones are read, and it is said', () => {
  const files: SourceFile[] = [];
  for (let index = 0; index < ROUTE_LIMITS.files + 3; index++) files.push(file(`f${String(index).padStart(5, '0')}.ts`, index === ROUTE_LIMITS.files + 1 ? `${EXPRESS}app.get('/late', h);` : 'export {};'));
  const result = detectRoutes(files);
  assert.equal(result.filesRead, ROUTE_LIMITS.files);
  assert.deepEqual(result.routes, [], 'the file after the limit is not read');
  assert.ok(result.notes.some(note => /More than 5000 source files/.test(note)));
});

test('A file larger than the limit is not read, and it is said', () => {
  const big = file('big.ts', `${EXPRESS}app.get('/big', h);\n${'// filler\n'.repeat(ROUTE_LIMITS.fileChars / 8)}`);
  assert.ok(big.text.length > ROUTE_LIMITS.fileChars);
  const result = detectRoutes([big, file('ok.ts', `${EXPRESS}app.get('/ok', h);`)]);
  assert.deepEqual(result.routes.map(route => route.path), ['/ok']);
  assert.equal(result.filesRead, 1);
  assert.ok(result.notes.some(note => /1 file was not read because it has more than 1000000 characters/.test(note)));
});

test('A line longer than the limit is skipped, and it is said', () => {
  const result = detectRoutes([file('min.ts', `${EXPRESS}app.get('/a', h);${' '.repeat(ROUTE_LIMITS.lineChars)}\napp.get('/b', h);`)]);
  assert.deepEqual(result.routes.map(route => route.path), ['/b']);
  assert.ok(result.notes.some(note => /1 line with more than 2000 characters was skipped/.test(note)), result.notes.join('|'));
});

test('More routes than the limit: the first ones are kept, and it is said', () => {
  const lines = Array.from({ length: ROUTE_LIMITS.routes + 500 }, (_, index) => `app.get('/r${index}', h);`);
  const text = `${EXPRESS}${lines.join('\n')}`;
  assert.ok(text.length < ROUTE_LIMITS.fileChars);
  const result = detectRoutes([file('many.ts', text)]);
  assert.equal(result.routes.length, ROUTE_LIMITS.routes);
  assert.ok(result.notes.some(note => /More than 20000 routes/.test(note)));
});

test('The notes are not more than the limit and say nothing twice', () => {
  const result = detectRoutes(Array.from({ length: 300 }, (_, index) => file(`c${index}.ts`, `import { Controller, Get } from '@nestjs/common';\n@Controller({ path: 'a${index}', version: '1' })\nexport class C${index} { @Get() g() {} }`)));
  assert.ok(result.notes.length <= ROUTE_LIMITS.notes);
  assert.equal(result.notes.filter(note => /versioning/.test(note)).length, 1);
  assert.equal(new Set(result.notes).size, result.notes.length);
});

test('Hostile files are read in a moment: brackets, calls that never end, long strings, deep nesting, a very long file', () => {
  const big = (text: string): string => text.slice(0, ROUTE_LIMITS.fileChars - 1000);
  const express = (body: string): string => `${EXPRESS}${body}`;
  // Every line is short: a line of more than 2000 characters is skipped before it is read, so a hostile text is made of many lines.
  const lines = (chunk: string, count: number): string => big(`${chunk}\n`.repeat(count));
  const cases: [string, SourceFile[]][] = [
    ['parentheses', [file('a.ts', express(lines('((((((((((((((((((((((((((((((((((((((((', 22_000)))]],
    ['unclosed brackets and braces', [file('a.ts', express(lines('{[({[({[({[({[({[({[({[({[({[', 30_000)))]],
    ['calls that never close', [file('a.ts', express(lines('app.get(', 100_000)))]],
    ['calls with an argument that never ends', [file('a.ts', express(lines("app.get('/a', function () { x(", 30_000)))]],
    ['unknown receivers', [file('a.ts', express(lines('x.get("/a", h);', 60_000)))]],
    ['a long template', [file('a.ts', express(`app.get(\`\n${'${\n'.repeat(250_000)}\`, h);`))]],
    ['comments that never end', [file('a.ts', express(lines('/* x', 200_000)))]],
    ['lines', [file('a.ts', express('x;\n'.repeat(300_000)))]],
    ['nest decorators', [file('a.ts', `import { Controller, Get } from '@nestjs/common';\n${lines('@Controller(', 80_000)}`)]],
    ['nest class body', [file('a.ts', `import { Controller, Get } from '@nestjs/common';\n@Controller('x') class A {\n${lines('@Get(', 100_000)}}`)]],
    ['nest controllers', [file('a.ts', `import { Controller, Get } from '@nestjs/common';\n${lines("@Controller('x') class A {", 30_000)}`)]],
    ['spring', [file('A.java', `@RestController class A {\n${lines('@GetMapping(', 80_000)}`)]],
    ['spring controllers', [file('A.java', lines('@RestController class A {', 30_000))]],
    ['spring parameters', [file('A.java', `@RestController class A {\n@GetMapping("/a") void a(${lines('@RequestParam String a,', 30_000)}`)]],
    ['asp.net', [file('A.cs', `public class AController {\n${lines('[HttpGet(', 100_000)}`)]],
    ['asp.net classes', [file('A.cs', lines('[ApiController] public class AController {', 25_000))]],
    ['python', [file('a.py', `from fastapi import FastAPI\napp = FastAPI()\n${lines('@app.get(', 100_000)}`)]],
    ['python docstrings', [file('a.py', `from fastapi import FastAPI\n${lines('""" x', 200_000)}`)]],
    ['django', [file('urls.py', `urlpatterns = [\n${lines('path(', 100_000)}`)]],
    ['laravel', [file('routes/web.php', `<?php\n${lines("Route::get('/x')->", 60_000)}`)]],
    ['laravel groups', [file('routes/web.php', `<?php\n${lines('Route::group([], function () {', 30_000)}`)]],
    ['go', [file('a.go', `import "github.com/gin-gonic/gin"\n${lines('r.GET(', 100_000)}`)]],
    ['go chi', [file('a.go', `import "github.com/go-chi/chi/v5"\n${lines('r.Route("/x", func(r chi.Router) {', 25_000)}`)]],
    ['rust', [file('a.rs', `use actix_web::get;\n${lines('#[get(', 100_000)}`)]],
    ['nest classes that close', [file('a.ts', `import { Controller, Get } from '@nestjs/common';\n${lines("@Controller('x') class A { }", 30_000)}`)]],
    ['spring classes that close', [file('A.java', lines('@RestController class A { }', 30_000))]],
    ['asp.net classes that close', [file('A.cs', lines('[ApiController] public class AController { }', 25_000))]],
    ['python decorators without parentheses', [file('a.py', `from fastapi import FastAPI\napp = FastAPI()\n${lines('@app.get("/x")\n@x', 60_000)}`)]],
    ['laravel groups with no closure', [file('routes/web.php', `<?php\n${lines('Route::group([], 1);', 50_000)}`)]],
    ['go chi routes with no function', [file('a.go', `import "github.com/go-chi/chi/v5"\n${lines('r.Route("/x", 1)', 50_000)}`)]],
    ['many routers mounted', [file('a.ts', express(Array.from({ length: 20_000 }, (_, index) => `const r${index} = express.Router();\nr${index}.get('/x', h);\napp.use('/p${index}', r${index});`).join('\n').slice(0, 900_000)))]],
    ['a long string', [file('a.ts', express(`app.get('${'a'.repeat(900_000)}', h);`))]]
  ];
  for (const [name, files] of cases) {
    const { ms } = timed(() => detectRoutes(files));
    assert.ok(ms < 2000, `${name}: ${ms} ms`);
  }
});

test('A route with a receiver that the file made is found a hundred thousand times in a moment', () => {
  const text = `${EXPRESS}${'app.get("/a", h);\n'.repeat(55_000)}`;
  const { value, ms } = timed(() => detectRoutes([file('a.ts', text)]));
  assert.ok(ms < 3000, `${ms} ms`);
  assert.equal(value.routes.length, 1, 'one route: the same one is not listed again');
});

// ---- the collection ----

const sample = (): RoutesResult => detectRoutes([
  file('src/users.controller.ts', `import { Controller, Get, Post, Body, Query, Headers } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get() list(@Query('page') page: number, @Headers('x-token') token: string) {}
  @Get(':id') one() {}
  @Post() add(@Body() body: Dto) {}
}`),
  file('src/app.ts', `${EXPRESS}app.get('/health', h);\napp.post('/form/:kind', h);\napp.listen(3400);`),
  file('src/Pets.java', '@RestController class Pets { @PostMapping("/pets") void p(@RequestPart MultipartFile f) {} }')
]);

test('The routes become one collection with a folder for each group, a request for each route and an environment', () => {
  const imported = routesToImported(sample(), 'Detected routes');
  assert.equal(imported.collections.length, 1);
  const collection = imported.collections[0];
  assert.equal(collection?.container.name, 'Detected routes');
  assert.equal(collection?.container.baseUrl, '{{baseUrl}}');
  assert.deepEqual(collection?.folders.map(folder => folder.container.name), ['Pets', 'app', 'UsersController'], 'in the order of the files');
  const users = collection?.folders.find(folder => folder.container.name === 'UsersController');
  assert.deepEqual(users?.requests.map(request => `${request.name}`), ['GET /users', 'GET /users/{id}', 'POST /users']);
  const list = users?.requests[0];
  assert.equal(list?.method, 'GET');
  assert.equal(list?.url, '/users');
  assert.deepEqual(list?.query.map(row => [row.name, row.value, row.enabled]), [['page', '', false]]);
  assert.deepEqual(list?.headers.map(row => [row.name, row.value, row.enabled]), [['x-token', '', false]]);
  assert.match(list?.docs ?? '', /^Found in src\/users\.controller\.ts:4 \(NestJS\), list$/);
  const one = users?.requests[1];
  assert.deepEqual(one?.pathParams.map(row => [row.name, row.value, row.enabled]), [['id', '{{id}}', true]], 'a variable that is not defined, to be filled in');
  assert.deepEqual(users?.requests[2]?.body, { kind: 'json', text: '{}' });
  const form = collection?.folders.find(folder => folder.container.name === 'Pets')?.requests[0];
  assert.deepEqual(form?.body, { kind: 'form', fields: [] });
  const app = collection?.folders.find(folder => folder.container.name === 'app');
  assert.deepEqual(app?.requests.map(request => request.name), ['GET /health', 'POST /form/{kind}']);
  assert.deepEqual(imported.environments, [{ name: 'Local', vars: [{ name: 'baseUrl', value: 'http://localhost:3400', secret: false, enabled: true }] }]);
  assert.equal(imported.skipped, 0);
  assert.deepEqual(countImported(imported), { collections: 1, folders: 3, requests: 6, environments: 1 });
});

test('The notes of the import are the notes of the detection', () => {
  const result = sample();
  const imported = routesToImported(result, 'X');
  assert.deepEqual(imported.notes.map(note => note.message), result.notes);
  assert.ok(imported.notes.every(note => note.where === ''));
});

test('A group that two files have is told apart by the name of the file; the same file keeps one folder', () => {
  const result = detectRoutes([
    file('a/UserController.java', '@RestController class UserController { @GetMapping("/a") void a() {} @GetMapping("/a2") void a2() {} }'),
    file('b/UserController.java', '@RestController class UserController { @GetMapping("/b") void b() {} }')
  ]);
  const imported = routesToImported(result, 'X');
  assert.deepEqual(imported.collections[0]?.folders.map(folder => [folder.container.name, folder.requests.length]), [['UserController (UserController)', 2], ['UserController (UserController) 2', 1]]);
});

test('Nothing found: no collection, no environment, and the note says why', () => {
  const imported = routesToImported(detectRoutes([file('a.ts', 'export {};')]), 'X');
  assert.deepEqual([imported.collections, imported.environments, imported.skipped], [[], [], 0]);
  assert.match(imported.notes[0]?.message ?? '', /No routes were found/);
});

test('The names that come from the files are made safe; nothing in the collection is a credential', () => {
  const hidden = String.fromCodePoint(0x202e);
  const result = detectRoutes([file(`src/evil${hidden}.ts`, `${EXPRESS}app.get('/x${hidden}y', h);`)]);
  const imported = routesToImported(result, `  Name${hidden}  `);
  const text = JSON.stringify(imported);
  assert.ok(!text.includes(hidden), 'no direction control');
  assert.equal(imported.collections[0]?.container.name, 'Name?');
  assert.deepEqual(imported.environments.map(environment => environment.vars.map(variable => [variable.name, variable.secret])), [[['baseUrl', false]]], 'the environment has an address only');
  assert.equal(imported.collections[0]?.container.auth.kind, 'inherit');
  assert.ok(imported.collections[0]?.folders.every(folder => folder.requests.every(request => request.scripts.pre === '' && request.scripts.post === '' && request.auth.kind === 'inherit')));
});

test('A long name is cut and an empty one has a name', () => {
  const imported = routesToImported(detectRoutes([file('a.ts', `${EXPRESS}app.get('/x', h);`)]), 'n'.repeat(500));
  assert.equal(imported.collections[0]?.container.name.length, 200);
  assert.equal(routesToImported(detectRoutes([file('a.ts', `${EXPRESS}app.get('/x', h);`)]), '   ').collections[0]?.container.name, 'Routes');
});

test('Nested groups that a hostile file stacks up are limited: the time stays short, and a path that grows beyond reason is not a route', () => {
  const nested = `<?php\n${"Route::prefix('a')->group(function () {\n".repeat(5000)}${"Route::get('/x', 'C@i');\n".repeat(8000)}${'});\n'.repeat(5000)}`;
  const slow = timed(() => detectRoutes([file('routes/web.php', nested)]));
  assert.ok(slow.ms < 4000, `took ${slow.ms} ms`);
  const prefix = 'p'.repeat(150);
  const stacked = `<?php\n${`Route::prefix('${prefix}')->group(function () {\n`.repeat(40)}Route::get('/x', 'C@i');\n${'});\n'.repeat(40)}`;
  const result = detectRoutes([file('routes/web.php', stacked)]);
  assert.deepEqual(result.routes, [], 'a path of 6000 characters is not a route');
  assert.ok(result.notes.some(note => /1 route was left out because the path is longer than 2000 characters/.test(note)), result.notes.join(' | '));
});

test('Files that together give more routes than can be kept do not all stay in memory: the first ones are kept, and it is said', () => {
  const files: SourceFile[] = [];
  for (let index = 0; index < 5; index++) {
    const lines = Array.from({ length: 12_000 }, (_, count) => `app.get('/f${index}/r${count}', h);`);
    files.push(file(`src/f${index}.js`, `${EXPRESS}${lines.join('\n')}`));
  }
  const timedResult = timed(() => detectRoutes(files));
  assert.equal(timedResult.value.routes.length, ROUTE_LIMITS.routes);
  assert.ok(timedResult.value.notes.some(note => new RegExp(`More than ${ROUTE_LIMITS.routes} routes`).test(note)));
  assert.ok(timedResult.ms < 5000, `took ${timedResult.ms} ms`);
  assert.deepEqual(timedResult.value.routes.slice(0, 2).map(route => route.path), ['/f0/r0', '/f0/r1'], 'the first files come first');
});
