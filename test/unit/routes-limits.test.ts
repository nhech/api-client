import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRoutes, mayHaveRoutes, ROUTE_LIMITS, ROUTE_SKIPPED_FOLDERS, routesToImported, type SourceFile } from '../../src/importers/routes';

/** What a source file can do to the machine of whoever imports its routes, and to the requests that are made from them. */

const file = (path: string, text: string): SourceFile => ({ path, text });
const EXPRESS = "import express from 'express';\nconst app = express();\n";
const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = Date.now();
  const value = run();
  return { value, ms: Date.now() - start };
};
/** A file just under the limit of the size of a file. */
const FITS = ROUTE_LIMITS.fileChars - 1000;
const LIMIT_MS = 4000;

test('A raw string of Rust that is opened and never closed is searched for once, not at every quote', () => {
  const line = `${'r#"'.repeat(333)}\n`;
  const text = `use actix_web::get;\n${line.repeat(Math.floor(FITS / line.length))}`;
  const { ms, value } = timed(() => detectRoutes([file('src/main.rs', text)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  assert.deepEqual(value.routes, []);
  // A raw string that is closed still hides the routes in it, and one with hashes is closed by its own number of them.
  const closed = detectRoutes([file('src/main.rs', 'use actix_web::get;\nconst DOC: &str = r##"#[get("/in-string")]"##;\n#[get("/real")]\nasync fn real() {}\n')]);
  assert.deepEqual(closed.routes.map(route => route.path), ['/real']);
});

test('Controllers inside the class of another controller are read as part of it, once, and it is said', () => {
  const open = "@Controller('a') class A {\n";
  const text = `import { Controller } from '@nestjs/common';\n${open.repeat(Math.floor(FITS / (open.length + 2)))}`;
  const { ms } = timed(() => detectRoutes([file('src/a.ts', text)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  const nested = detectRoutes([file('src/a.controller.ts', "import { Controller, Get } from '@nestjs/common';\n@Controller('outer')\nclass Outer {\n  @Get('one') one() {}\n  make() { @Controller('inner') class Inner { @Get('two') two() {} } return Inner; }\n}\n")]);
  assert.deepEqual(nested.routes.map(route => route.path).sort(), ['/outer/one', '/outer/two']);
  assert.ok(nested.notes.some(note => /declared inside another class was read as part of it/.test(note)), nested.notes.join('\n'));
});

test('Mounts are resolved once for each router: thousands of them are fast, a chain of mounts and a loop of mounts still give their prefixes', () => {
  let text = `${EXPRESS}import r from './a';\n`;
  for (let index = 0; text.length < FITS - 100; index++) text += `app.use('/p${index}', r);\nconst q${index} = express.Router();\nq${index}.get('/x', h);\n`;
  const { ms, value } = timed(() => detectRoutes([file('src/a.ts', text)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  assert.ok(value.notes.some(note => new RegExp(`More than ${ROUTE_LIMITS.edges} routers are mounted below others`).test(note)), value.notes.join('\n'));
  const chain = detectRoutes([
    file('src/app.ts', `${EXPRESS}import api from './api';\napp.use('/api', api);\n`),
    file('src/api.ts', "import express from 'express';\nimport users from './users';\nconst api = express.Router();\napi.use('/v1', users);\nexport default api;\n"),
    file('src/users.ts', "import express from 'express';\nconst users = express.Router();\nusers.get('/list', h);\nexport default users;\n")
  ]);
  assert.deepEqual(chain.routes.map(route => route.path), ['/api/v1/list']);
  const loop = detectRoutes([file('src/a.ts', `${EXPRESS}const a = express.Router();\nconst b = express.Router();\na.use('/b', b);\nb.use('/a', a);\na.get('/x', h);\nb.get('/y', h);\n`)]);
  assert.deepEqual(loop.routes.map(route => route.path), ['/b/a/x', '/a/b/y'], 'a loop of mounts is cut where it comes back to the router it started from');
});

test('Decorators of Python are read in time linear in the file, and Flask is told from FastAPI once for the file', () => {
  let body = '';
  for (let index = 0; body.length < FITS - 100_000; index++) body += `@app.get("/r${index}")\ndef h${index}(): pass\n`;
  const text = `${body}${' \n'.repeat(40_000)}from flask import Flask\n`;
  const { ms, value } = timed(() => detectRoutes([file('src/views.py', text)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  assert.ok(value.routes.length > 1000);
  assert.ok(value.routes.every(route => route.framework === 'Flask'));
  const fast = detectRoutes([file('src/views.py', 'from fastapi import FastAPI\nfrom flask import Flask\napp = FastAPI()\n@app.get("/a")\ndef a(): pass\n')]);
  assert.equal(fast.routes[0]?.framework, 'FastAPI');
});

test('Spring: a method with many mappings and a parameter with many annotations is read once', () => {
  const parameter = `${'@A\n'.repeat(1200)}@RequestParam String q`;
  let body = '';
  for (let group = 0; body.length < FITS - 10_000; group++) body += `${'@GetMapping("/a")\n'.repeat(30)}void m${group}(${parameter}) {}\n`;
  const { ms, value } = timed(() => detectRoutes([file('src/C.java', `@RestController\nclass C {\n${body}}\n`)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  assert.deepEqual(value.routes[0]?.queryParams, ['q']);
});

test('Go: the groups of routes that are followed are limited, and it is said', () => {
  let text = 'package main\nimport "github.com/go-chi/chi/v5"\nfunc main() {\n';
  for (let index = 0; text.length < FITS / 2; index++) text += `r.Route("/a${index}", func(r chi.Router) {})\n`;
  for (let index = 0; text.length < FITS - 100; index++) text += `r.Get("/x${index}", h)\n`;
  const { ms, value } = timed(() => detectRoutes([file('cmd/api/routes.go', `${text}}\n`)]));
  assert.ok(ms < LIMIT_MS, `took ${ms} ms`);
  assert.ok(value.notes.some(note => /More than 200 groups of routes \(Route, Group\)/.test(note)), value.notes.join('\n'));
});

test('Files that together give more routes than can be kept are not all held: the first ones are', () => {
  const files: SourceFile[] = [];
  for (let index = 0; index < 60; index++) {
    let text = EXPRESS;
    for (let route = 0; route < 1000; route++) text += `app.get('/r${index}-${route}', h);\n`;
    files.push(file(`src/f${String(index).padStart(2, '0')}.ts`, text));
  }
  const result = detectRoutes(files);
  assert.equal(result.routes.length, ROUTE_LIMITS.routes);
  assert.equal(result.routes[0]?.path, '/r0-0', 'the files are taken in the order of their names');
  assert.ok(result.notes.some(note => new RegExp(`More than ${ROUTE_LIMITS.routes} routes`).test(note)));
});

test('ASP.NET Core: the host in the configuration is not taken, only the port; this machine is', () => {
  const controller = file('Controllers/AController.cs', '[ApiController][Route("a")] public class AController : ControllerBase { [HttpGet] public int G() { } }');
  const launch = (url: string) => detectRoutes([controller, file('Properties/launchSettings.json', JSON.stringify({ profiles: { web: { applicationUrl: url } } }))]);
  const other = launch('http://attacker.example:5000');
  assert.equal(other.baseUrl, 'http://localhost:5000');
  assert.ok(other.notes.some(note => /names the host attacker\.example: only its port is used, on localhost/.test(note)), other.notes.join('\n'));
  assert.equal(launch('https://attacker.example').baseUrl, 'https://localhost');
  assert.equal(launch('http://127.0.0.1:5000').baseUrl, 'http://127.0.0.1:5000');
  assert.equal(launch('http://[::1]:5000').baseUrl, 'http://[::1]:5000');
  assert.equal(launch('http://localhost:5123').baseUrl, 'http://localhost:5123');
  for (const wildcard of ['http://*:6000', 'http://+:6000', 'http://0.0.0.0:6000', 'http://[::]:6000']) {
    const result = launch(wildcard);
    assert.equal(result.baseUrl, 'http://localhost:6000', wildcard);
    assert.ok(!result.notes.some(note => /names the host/.test(note)), `${wildcard} means this machine`);
  }
});

test('The braces of a variable are not carried into a route: a path, a name or a context path with {{ is not the address of a program', () => {
  const express = detectRoutes([file('src/app.ts', `${EXPRESS}app.get('/users/{{token}}', h);\napp.get('/ok/:id', h);\napp.get('/{{$guid}}/x', h);\n`)]);
  assert.deepEqual(express.routes.map(route => route.path), ['/ok/{id}']);
  assert.ok(express.notes.some(note => /2 routes were left out because the path is not a plain string/.test(note)), express.notes.join('\n'));
  const spring = file('src/C.java', '@RestController\nclass C {\n@GetMapping("/q")\nString q(@RequestParam("{{secret}}") String a, @RequestParam("page") String b) { return ""; }\n}\n');
  const params = detectRoutes([spring]).routes[0];
  assert.deepEqual(params?.queryParams, ['page'], 'a name with the braces of a variable is not a parameter');
  const context = (text: string) => detectRoutes([spring, file('application.properties', text)]).baseUrl;
  assert.equal(context('server.port=8081\nserver.servlet.context-path=/{{token}}\n'), 'http://localhost:8081');
  assert.equal(context('server.port=8081\nserver.servlet.context-path=/svc/v1\n'), 'http://localhost:8081/svc/v1');
  assert.equal(context('server.port=8081\nserver.servlet.context-path=/../x\n'), 'http://localhost:8081');
  const imported = routesToImported(detectRoutes([file('src/app.ts', `${EXPRESS}app.get('/ok/:id', h);\n`)]), 'App');
  assert.equal(JSON.stringify(imported).includes('{{token}}'), false);
});

test('Which files are worth reading is decided by the words of a framework, and the folders that are never read are named', () => {
  assert.equal(mayHaveRoutes('src/a.ts', "import express from 'express';"), true);
  assert.equal(mayHaveRoutes('src/a.ts', 'export const a = 1;'), false);
  assert.equal(mayHaveRoutes('src/V.java', '@RestController class V {}'), true);
  assert.equal(mayHaveRoutes('src/v.py', 'from FastAPI import x'), true, 'case does not matter for Python');
  assert.equal(mayHaveRoutes('README.md', 'express fastify'), false);
  for (const folder of ['node_modules', 'site-packages', 'env', 'test', 'tests', '.mvn', '.vs']) assert.ok(ROUTE_SKIPPED_FOLDERS.includes(folder), folder);
});
