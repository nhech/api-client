import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeOpenApi, isOpenApiCandidate, isOpenApiName, MAX_LISTED, rankOpenApi, sniffOpenApi, type FoundOpenApi } from '../../src/importers/openapi-find';

/** Finding the descriptions a project has, from the start of each file and from its name. */

test('A JSON description is told by its version key, with the title when the start of the file has it', () => {
  assert.deepEqual(sniffOpenApi('{"openapi":"3.0.3","info":{"title":"Pet Store","version":"1"},"paths":{}}', false), { kind: 'OpenAPI', version: '3.0.3', title: 'Pet Store' });
  assert.deepEqual(sniffOpenApi('{\n  "swagger": "2.0",\n  "info": {\n    "title": "Old \\"Pets\\"",\n    "version": "1"\n  }\n}', false), { kind: 'Swagger', version: '2.0', title: 'Old "Pets"' });
  assert.deepEqual(sniffOpenApi('\ufeff{"openapi": "3.1.0", "info": {"version": "1"}}', false), { kind: 'OpenAPI', version: '3.1.0', title: '' }, 'a byte order mark and no title');
  assert.equal(sniffOpenApi('{"swagger":2,"paths":{}}', false)?.kind, 'Swagger', 'a number, not text');
});

test('A YAML description is told the same way, in either order of the keys', () => {
  assert.deepEqual(sniffOpenApi('openapi: 3.0.0\ninfo:\n  title: Shop API\n  version: 1.0\npaths: {}\n', false), { kind: 'OpenAPI', version: '3.0.0', title: 'Shop API' });
  assert.deepEqual(sniffOpenApi('# a comment\ninfo:\n  version: 2\n  title: "Quoted # not a comment"\nswagger: "2.0"\n', false), { kind: 'Swagger', version: '2.0', title: 'Quoted # not a comment' });
  assert.equal(sniffOpenApi("---\nopenapi: '3.0.1'\ninfo: {}\n", false)?.version, '3.0.1');
});

test('What is not a description is not offered: other versions, a settings file, a nested key, text that only mentions it', () => {
  assert.equal(sniffOpenApi('{"openapi":"2.0","info":{}}', false), undefined, 'the key and the version must agree');
  assert.equal(sniffOpenApi('swagger: "3.0"\ninfo: {}\n', false), undefined);
  assert.equal(sniffOpenApi('{"openapi":"1.0.0","info":{}}', false), undefined, 'a version that is not supported');
  assert.equal(sniffOpenApi('{"swagger": "2.0"}', false), undefined, 'a version key alone is not enough for a file whose name says nothing');
  assert.equal(sniffOpenApi('{"name":"x","version":"1"}', false), undefined);
  assert.equal(sniffOpenApi('# notes\nWe use swagger: 2.0 here\n', false), undefined, 'only a key at the start of a line');
  assert.equal(sniffOpenApi('  openapi: 3.0.0\ninfo:\n', false), undefined, 'an indented one is nested');
  assert.equal(sniffOpenApi('', false), undefined);
});

test('A file whose name says it is a description needs only the version key', () => {
  assert.equal(sniffOpenApi('{"swagger": "2.0"}', true)?.version, '2.0');
  assert.equal(sniffOpenApi('openapi: 3.0.0\n', true)?.kind, 'OpenAPI');
  assert.equal(sniffOpenApi('{"name":"x"}', true), undefined, 'but the key it needs');
});

test('The name of a file says that it is a description: openapi, swagger, api-docs, oas', () => {
  for (const path of ['openapi.json', 'api/openapi.yaml', 'docs/swagger.yml', 'swagger.json', 'api-docs.json', 'petstore.openapi.yaml', 'v1/oas3.yaml', 'public/api_docs.json', 'my-oas.yml', 'OpenAPI.JSON']) {
    assert.equal(isOpenApiName(path), true, path);
  }
  for (const path of ['package.json', 'tsconfig.json', 'config/settings.yml', 'docs/boas.yaml', 'users.json', 'swag.json']) assert.equal(isOpenApiName(path), false, path);
});

test('Only JSON and YAML files outside the folders of other people are looked at', () => {
  for (const path of ['openapi.json', 'api/spec.yaml', 'a/b/c.yml', 'UPPER.JSON', 'build/openapi.json', 'dist/swagger.json', 'target/classes/openapi.yaml']) assert.equal(isOpenApiCandidate(path), true, path);
  for (const path of ['readme.md', 'src/app.ts', 'node_modules/swagger-ui/swagger.json', 'a/vendor/x/openapi.yaml', 'venv/lib/site-packages/x/openapi.json', '.git/x.json', '.vscode/settings.json', 'noextension']) {
    assert.equal(isOpenApiCandidate(path), false, path);
  }
  assert.equal(isOpenApiCandidate('my.node_modules.json'), true, 'a file name is not a folder');
});

const file = (path: string, byName: boolean): FoundOpenApi => ({ path, byName, kind: 'OpenAPI', version: '3.0.0', title: '' });

test('The list puts a file named for it first, then what is written by hand, then what is nearer the root, then by path', () => {
  const ranked = rankOpenApi([
    file('docs/api/spec.yaml', false), file('build/openapi.json', true), file('zeta/openapi.yaml', true), file('openapi.yaml', true), file('a.yaml', false), file('alpha/openapi.json', true), file('dist/x.json', false)
  ]);
  assert.deepEqual(ranked.list.map(item => item.path), ['openapi.yaml', 'alpha/openapi.json', 'zeta/openapi.yaml', 'build/openapi.json', 'a.yaml', 'docs/api/spec.yaml', 'dist/x.json']);
  assert.equal(ranked.more, 0);
  assert.deepEqual(rankOpenApi([file('b.yaml', false), file('a.yaml', false)]).list.map(item => item.path), ['a.yaml', 'b.yaml'], 'the same order whatever the order of the search');
});

test('The list is cut at a number a person can read, and says how many are left', () => {
  const many = Array.from({ length: MAX_LISTED + 7 }, (_, index) => file(`f${String(index).padStart(3, '0')}.yaml`, false));
  const ranked = rankOpenApi(many);
  assert.equal(ranked.list.length, MAX_LISTED);
  assert.equal(ranked.more, 7);
  assert.equal(ranked.list[0]?.path, 'f000.yaml');
});

test('What the list says about a file is its kind, its version and its title', () => {
  assert.equal(describeOpenApi({ kind: 'OpenAPI', version: '3.0.3', title: 'Pet Store' }), 'OpenAPI 3.0.3 - Pet Store');
  assert.equal(describeOpenApi({ kind: 'Swagger', version: '2.0', title: '' }), 'Swagger 2.0');
});

test('A title with control characters or a line break is shown as one safe line', () => {
  const hit = sniffOpenApi('{"openapi":"3.0.0","info":{"title":"A\\nB\\u202eC"}}', false);
  assert.ok(hit !== undefined && !/[\n\u202e]/.test(hit.title), JSON.stringify(hit));
});
