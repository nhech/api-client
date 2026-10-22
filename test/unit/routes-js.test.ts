import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRoutes, type SourceFile } from '../../src/importers/routes';

/** Express, Fastify, Koa, Hono, Elysia, Restify and NestJS: the routes in the text of the files, and what is not one. */

const file = (path: string, text: string): SourceFile => ({ path, text });
const listed = (files: readonly SourceFile[]): string[] => detectRoutes(files).routes.map(route => `${route.method} ${route.path}`);
const one = (text: string, path = 'src/app.ts'): string[] => listed([file(path, text)]);
const EXPRESS = "import express from 'express';\nconst app = express();\n";

test('Express: the verbs of an application and of a router, with the handler and the line', () => {
  const result = detectRoutes([file('src/app.ts', `${EXPRESS}const router = express.Router();
app.get('/a', listA);
app.post('/b', auth, createB);
router.put('/c', (req, res) => res.send('c'));
router.patch('/d', ctl.patch);
app.delete('/e', rm);
app.head('/f', h);
app.options('/g', h);
`)]);
  assert.deepEqual(result.routes.map(route => [route.method, route.path, route.handler, route.line, route.framework]), [
    ['GET', '/a', 'listA', 4, 'Express'], ['POST', '/b', 'createB', 5, 'Express'], ['PUT', '/c', undefined, 6, 'Express'],
    ['PATCH', '/d', 'ctl.patch', 7, 'Express'], ['DELETE', '/e', 'rm', 8, 'Express'], ['HEAD', '/f', 'h', 9, 'Express'], ['OPTIONS', '/g', 'h', 10, 'Express']
  ]);
  assert.deepEqual(result.frameworks, ['Express']);
});

test('Express: the parameters of a path are written {name}', () => {
  assert.deepEqual(one(`${EXPRESS}app.get('/users/:id/posts/:postId', h);\napp.get('/opt/:id?', h);\napp.get('/num/:id(\\\\d+)', h);\napp.get('/files/*', h);`), [
    'GET /users/{id}/posts/{postId}', 'GET /opt/{id}', 'GET /num/{id}', 'GET /files/*'
  ]);
  const route = detectRoutes([file('a.ts', `${EXPRESS}app.get('/users/:id/posts/:postId', h);`)]).routes[0];
  assert.deepEqual(route?.pathParams, ['id', 'postId']);
});

test('Express: a call that is not on a router is not a route (a client, a map, a cache, a test of the application)', () => {
  assert.deepEqual(one(`${EXPRESS}
axios.get('/users');
http.get('/x');
cache.get('/k');
map.get('/m');
api.get('/api-client');
supertest(app).get('/from-test');
request(app).get('/from-test-2');
app.get('settings-key');
app.get('port');
this.server.get('/on-this');
`), [], 'none of them');
});

test('Express: a name that the file made with the framework is a router, whatever it is called', () => {
  assert.deepEqual(one(`import { Router } from 'express';
import express from 'express';
const users = Router();
const things = express.Router();
const top = express();
users.get('/u', h);
things.get('/t', h);
top.get('/o', h);
`), ['GET /u', 'GET /t', 'GET /o']);
});

test('Express: a file that does not import a framework has no routes, and neither has a comment or a string', () => {
  assert.deepEqual(one("const app = makeApp();\napp.get('/x', h);"), []);
  assert.deepEqual(one(`${EXPRESS}// app.get('/commented', h);\n/* app.get('/block', h); */\nconst s = "app.get('/in-string', h)";\nconst t = \`app.get('/in-template', h)\`;\napp.get('/real', h);`), ['GET /real']);
});

test('Express: all is listed as GET and said, a path that is not a plain string is counted and left out', () => {
  const result = detectRoutes([file('a.ts', `${EXPRESS}app.all('/any', h);\napp.get(PREFIX + '/x', h);\napp.get(\`/t/\${id}\`, h);\napp.get(\`/plain\`, h);\napp.get('/ok', h);`)]);
  assert.deepEqual(result.routes.map(route => route.path), ['/any', '/plain', '/ok']);
  assert.ok(result.notes.some(note => /1 route answers for every method/.test(note)), result.notes.join('|'));
  assert.ok(result.notes.some(note => /2 routes were left out because the path is not a plain string/.test(note)), result.notes.join('|'));
});

test('Express: an array of paths is one route for each', () => {
  assert.deepEqual(one(`${EXPRESS}app.get(['/a', '/b/:id'], h);\napp.get([x, '/c'], h);`), ['GET /a', 'GET /b/{id}', 'GET /c']);
});

test('Express: route("/x") with the verbs after it', () => {
  const result = detectRoutes([file('a.ts', `${EXPRESS}app.route('/books')
  .get(listBooks)
  .post(auth, createBook)
  .put(update);
app.route('/other/:id').delete(rm);
app.route(dynamic).get(h);`)]);
  assert.deepEqual(result.routes.map(route => [route.method, route.path, route.handler]), [
    ['GET', '/books', 'listBooks'], ['POST', '/books', 'createBook'], ['PUT', '/books', 'update'], ['DELETE', '/other/{id}', 'rm']
  ]);
});

test('Express: a router that is mounted below a prefix in the same file', () => {
  assert.deepEqual(one(`${EXPRESS}const users = express.Router();
const admin = express.Router();
users.get('/', list);
users.get('/:id', show);
admin.get('/stats', stats);
app.use('/api/users', users);
users.use('/me', admin);
app.use(express.json());
app.use(cors(), admin);
`), ['GET /api/users', 'GET /api/users/{id}', 'GET /api/users/me/stats'], 'a router that is mounted twice is below the first mount');
});

test('Express: a router in another file, imported in each of the ways, is below the prefix of its mount', () => {
  const files = [
    file('src/app.ts', `${EXPRESS}import users from './routes/users';
import * as posts from './routes/posts';
import { adminRouter } from './routes/admin';
const legacy = require('./routes/legacy');
const { health } = require('./routes/health.js');
app.use('/users', users);
app.use('/posts', posts.default);
app.use('/admin', adminRouter);
app.use('/legacy', legacy);
app.use('/health', health);
app.use('/inline', require('./routes/inline'));
`),
    file('src/routes/users.ts', "import { Router } from 'express';\nconst router = Router();\nrouter.get('/:id', h);\nexport default router;"),
    file('src/routes/posts.ts', "import { Router } from 'express';\nconst r = Router();\nr.get('/', h);\nexport default r;"),
    file('src/routes/admin.ts', "import { Router } from 'express';\nexport const adminRouter = Router();\nexport const otherRouter = Router();\nadminRouter.get('/a', h);\notherRouter.get('/o', h);"),
    file('src/routes/legacy.js', "const router = require('express').Router();\nconst express = require('express');\nconst r2 = express.Router();\nr2.get('/old', h);\nmodule.exports = r2;"),
    file('src/routes/health.js', "const express = require('express');\nconst health = express.Router();\nhealth.get('/', h);\nmodule.exports = { health };"),
    file('src/routes/inline.js', "const express = require('express');\nconst router = express.Router();\nrouter.get('/i', h);\nmodule.exports = router;")
  ];
  assert.deepEqual(listed(files).sort(), [
    'GET /admin/a', 'GET /health', 'GET /inline/i', 'GET /legacy/old', 'GET /o', 'GET /posts', 'GET /users/{id}'
  ].sort(), 'the router that is not mounted has no prefix');
});

test('Express: a router mounted in a router mounted in the application has both prefixes', () => {
  const files = [
    file('app.ts', `${EXPRESS}import api from './api';\napp.use('/api', api);`),
    file('api.ts', "import { Router } from 'express';\nimport users from './users';\nconst api = Router();\napi.use('/v1/users', users);\nexport default api;"),
    file('users.ts', "import { Router } from 'express';\nconst r = Router();\nr.get('/:id', h);\nexport default r;")
  ];
  assert.deepEqual(listed(files), ['GET /api/v1/users/{id}']);
});

test('Express: an import with the extension of the compiled file, or of a folder, is found', () => {
  const files = [
    file('src/app.ts', `${EXPRESS}import a from './a.js';\nimport b from './b';\napp.use('/a', a);\napp.use('/b', b);`),
    file('src/a.ts', "import { Router } from 'express';\nconst r = Router();\nr.get('/x', h);\nexport default r;"),
    file('src/b/index.ts', "import { Router } from 'express';\nconst r = Router();\nr.get('/y', h);\nexport default r;")
  ];
  assert.deepEqual(listed(files).sort(), ['GET /a/x', 'GET /b/y']);
});

test('Express: mounts that lead back to themselves are read once', () => {
  const files = [
    file('a.ts', "import express from 'express';\nimport b from './b';\nconst a = express.Router();\na.use('/b', b);\na.get('/x', h);\nexport default a;"),
    file('b.ts', "import express from 'express';\nimport a from './a';\nconst b = express.Router();\nb.use('/a', a);\nb.get('/y', h);\nexport default b;")
  ];
  const result = listed(files);
  assert.equal(result.length, 2);
  assert.ok(result.every(route => route.split('/').length <= 6), result.join(','));
});

test('Express: the port that the code listens on is the base address', () => {
  const base = (text: string): string | undefined => detectRoutes([file('a.ts', `${EXPRESS}app.get('/x', h);\n${text}`)]).baseUrl;
  assert.equal(base('app.listen(4000);'), 'http://localhost:4000');
  assert.equal(base('app.listen(4001, () => console.log("up"));'), 'http://localhost:4001');
  assert.equal(base('app.listen(Number(process.env.PORT) || 4002);'), 'http://localhost:4002');
  assert.equal(base('const PORT = process.env.PORT || 4003;\napp.listen(PORT);'), 'http://localhost:4003');
  assert.equal(base('const port = 4004;\napp.listen(port, "0.0.0.0");'), 'http://localhost:4004');
  assert.equal(base('app.listen({ port: 4005 });'), 'http://localhost:4005');
  assert.equal(base(''), 'http://localhost:3000', 'the default of the framework');
  assert.equal(base('app.listen(0);'), 'http://localhost:3000', 'a port that is not one');
  assert.equal(base('app.listen(00);'), 'http://localhost:3000', 'neither is 00');
  assert.equal(base('app.listen(70000);'), 'http://localhost:3000', 'nor a number above 65535');
  assert.equal(base('app.listen(65535);'), 'http://localhost:65535');
});

test('Fastify: the verbs, a route with options, the generics of TypeScript, route({...}) and a plugin with a prefix', () => {
  const files = [
    file('src/server.ts', `import Fastify from 'fastify';
import routes from './routes';
const fastify = Fastify({ logger: true });
fastify.get('/ping', async () => 'pong');
fastify.post('/items', { schema: {} }, createItem);
fastify.get<{ Params: { id: string } }>('/items/:id', getItem);
fastify.route({ method: 'GET', url: '/r1', handler: h });
fastify.route({ method: ['PUT', 'DELETE'], url: '/r2/:id', handler: h });
fastify.register(routes, { prefix: '/api' });
fastify.listen({ port: 3100 });
`),
    file('src/routes.ts', "import { FastifyInstance } from 'fastify';\nexport default async function routes(fastify: FastifyInstance) {\n  fastify.get('/users', h);\n  fastify.post('/users', h);\n}")
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => `${route.method} ${route.path}`).sort(), [
    'DELETE /r2/{id}', 'GET /api/users', 'GET /items/{id}', 'GET /ping', 'GET /r1', 'POST /api/users', 'POST /items', 'PUT /r2/{id}'
  ].sort());
  assert.equal(result.baseUrl, 'http://localhost:3100');
  assert.deepEqual(result.frameworks, ['Fastify']);
});

test('Koa: a router with a prefix of its own, router.prefix and a route with a name', () => {
  assert.deepEqual(one(`import Router from '@koa/router';
const router = new Router({ prefix: '/api' });
const other = new Router();
router.get('/users', h);
router.get('user', '/users/:id', h);
other.prefix('/v2');
other.post('/things', h);
`), ['GET /api/users', 'GET /api/users/{id}', 'POST /v2/things']);
});

test('Hono: new Hono(), basePath, sub applications that are mounted with route, and a chain', () => {
  assert.deepEqual(one(`import { Hono } from 'hono';
const app = new Hono();
const books = new Hono();
const api = app.basePath('/api');
books.get('/', list);
books.post('/', create);
app.route('/books', books);
api.get('/ping', h);
new Hono().get('/chain', h).post('/chain2', h);
`), ['GET /books', 'POST /books', 'GET /api/ping', 'GET /chain', 'POST /chain2']);
});

test('Hono: basePath on the constructor, and on a chain', () => {
  assert.deepEqual(one(`import { Hono } from 'hono';
const api = new Hono().basePath('/api');
const v2 = new Hono<Env>().basePath('/v2');
api.get('/a', h);
v2.get('/b', h);
`), ['GET /api/a', 'GET /v2/b']);
});

test('Elysia: a chain of verbs, a prefix in the constructor', () => {
  assert.deepEqual(one(`import { Elysia } from 'elysia';
const app = new Elysia({ prefix: '/api' })
  .get('/', () => 'hi')
  .post('/users/:id', h)
  .listen(3200);
const other = new Elysia().get('/o', h);
`), ['GET /api', 'POST /api/users/{id}', 'GET /o']);
});

test('Restify: server.get and server.del', () => {
  assert.deepEqual(one("const restify = require('restify');\nconst server = restify.createServer();\nserver.get('/r/:id', h);\nserver.del('/r/:id', h);\nserver.post('/r', h);"), ['GET /r/{id}', 'DELETE /r/{id}', 'POST /r']);
});

test('NestJS: the controller, the methods, the parameters and the global prefix', () => {
  const files = [
    file('src/users.controller.ts', `import { Controller, Get, Post, Put, Delete, Patch, Head, Options, All, Body, Query, Param, Headers, UploadedFile } from '@nestjs/common';
@Controller('users')
export class UsersController {
  @Get()
  findAll(@Query('page') page: number, @Query('limit') limit: number, @Query() all: Dto) {}

  @Get(':id')
  @UseGuards(AuthGuard)
  async findOne(@Param('id') id: string, @Headers('x-token') token: string) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateUserDto) {}

  @Put(':id') update(@Param('id') id: string, @Body() dto: UpdateUserDto) {}
  @Patch(':id/avatar')
  avatar(@UploadedFile() file: Express.Multer.File) {}
  @Delete(':id') remove() {}
  @Head() h() {}
  @Options() o() {}
  @All('any') any() {}
}
`),
    file('src/main.ts', "import { NestFactory } from '@nestjs/core';\nasync function bootstrap() { const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api/v1'); await app.listen(3300); }")
  ];
  const result = detectRoutes(files);
  assert.deepEqual(result.routes.map(route => [route.method, route.path, route.handler, route.queryParams, route.headerParams, route.body]), [
    ['GET', '/api/v1/users', 'findAll', ['page', 'limit'], [], undefined],
    ['GET', '/api/v1/users/{id}', 'findOne', [], ['x-token'], undefined],
    ['POST', '/api/v1/users', 'create', [], [], 'json'],
    ['PUT', '/api/v1/users/{id}', 'update', [], [], 'json'],
    ['PATCH', '/api/v1/users/{id}/avatar', 'avatar', [], [], 'form'],
    ['DELETE', '/api/v1/users/{id}', 'remove', [], [], undefined],
    ['HEAD', '/api/v1/users', 'h', [], [], undefined],
    ['OPTIONS', '/api/v1/users', 'o', [], [], undefined],
    ['GET', '/api/v1/users/any', 'any', [], [], undefined]
  ]);
  assert.ok(result.routes.every(route => route.group === 'UsersController' && route.framework === 'NestJS'));
  assert.ok(result.notes.some(note => /setGlobalPrefix\('api\/v1'\)/.test(note)));
  assert.equal(result.baseUrl, 'http://localhost:3000', 'the port of the code is not read from a call that is not on the application');
});

test('NestJS: the forms of @Controller and a path that is not known', () => {
  const result = detectRoutes([file('src/a.controller.ts', `import { Controller, Get } from '@nestjs/common';
@Controller({ path: 'cats', version: '1' })
export class CatsController { @Get('list') l() {} @Get(Paths.ONE) c() {} }
@Controller()
export class RootController { @Get() root() {} @Get('/slash') s() {} }
@Controller(['a', 'b'])
export class ManyController { @Get() m() {} }
@Controller(BASE)
export class ConstController { @Get() k() {} }
@ApiTags('x')
@Controller('x')
@UseGuards(G)
export class DecoratedController { @Get('y') y() {} }
`)]);
  assert.deepEqual(result.routes.map(route => `${route.group} ${route.method} ${route.path}`), [
    'CatsController GET /cats/list', 'RootController GET /', 'RootController GET /slash', 'ManyController GET /a', 'DecoratedController GET /x/y'
  ]);
  assert.ok(result.notes.some(note => /versioning/.test(note)));
  assert.ok(result.notes.some(note => /2 routes were left out/.test(note)), result.notes.join('|'));
});

test('The same route twice in a file is one route', () => {
  assert.deepEqual(one(`${EXPRESS}app.get('/same', a);\napp.get('/same', b);`), ['GET /same']);
});

test('A file with a framework that is imported twice, or with two frameworks, is read for each', () => {
  assert.deepEqual(one(`import express from 'express';\nimport { Hono } from 'hono';\nconst app = express();\nconst h = new Hono();\napp.get('/e', x);\nh.get('/h', x);`), ['GET /e', 'GET /h']);
});
